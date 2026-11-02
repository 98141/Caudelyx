/* eslint-disable security/detect-object-injection -- Native authenticated readers, closed source fields and signed per-book scopes. */
import { randomUUID, createHash } from 'node:crypto';
import { table, booksTable } from '../obligations/models.js';
import { today, day, occurrences, schedule as approvedSchedule } from '../obligations/calendar.js';
import { calculate } from '../lending/calculator.js';
import { beginEvidence } from '../lending/evidence-v2.js';
import { expensePosition } from '../obligations/expenses.js';
import { liabilityPosition } from '../obligations/liabilities.js';
import { consolidated } from '../obligations/queries.js';
import { View } from '../wealth/queries.js';
import { ledgerSources } from '../wealth/sources.js';
import { wealthTable } from '../wealth/models.js';
import { authorize, loadSources } from '../reporting/sources.js';
import { reconstruct } from '../reporting/engine.js';
import { storedCents } from '../finance/money.js';
import { AppError } from '../../shared/errors.js';
import { hash } from './codec.js';
import { cents, money } from './money.js';
import { metric } from './engine.js';
const uuid = (s) => { const h = createHash('sha256').update(s).digest('hex'); return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-8' + h.slice(17, 20) + '-' + h.slice(20, 32); };
export async function capture(identity, a, s, baseId = randomUUID(), cut) {
    const started = performance.now(), asOf = today(identity.now()), knownAt = cut?.knownAt ?? new Date(identity.now()).toISOString(), m = identity.obligations, w = identity.wealth;
    const recapture = async (knownAt) => { if ((cut?.attempt ?? 0) >= 4)
        throw new AppError(503, 'INTEGRITY_MISMATCH'); return await capture(identity, a, s, baseId, { knownAt, attempt: (cut?.attempt ?? 0) + 1 }); };
    const budget = () => { if (performance.now() - started > 10000)
        throw new AppError(503, 'SIMULATION_BUDGET_EXCEEDED'); };
    const books = [], facts = [], digestParts = [];
    let rows = 0;
    const scopes = [a.scope];
    if (a.consolidated) {
        const current = await identity.sessions.requirePersonalOperational(a.context, s), org = current.identity.organizationId;
        if (!org)
            throw new AppError(403, 'ACCESS_DENIED');
        scopes.push({ kind: 'BUSINESS', bookId: org, ownerId: org, organizationId: org });
    }
    for (const scope of scopes) {
        budget();
        const refs = [], seenRefs = new Map(), reasons = [], flows = [], terms = [];
        const addRefs = (name, xs) => { for (const value of xs) {
            const row = value;
            budget();
            const refKey = name + ':' + String(row['_id']), digest = hash(row), prior = seenRefs.get(refKey);
            if (prior !== undefined) {
                if (prior !== digest)
                    throw new AppError(503, 'INTEGRITY_MISMATCH');
                continue;
            }
            seenRefs.set(refKey, digest);
            if (++rows > 10000)
                throw new AppError(413, 'SIMULATION_SCOPE_TOO_LARGE');
            refs.push({ collection: name, id: String(row['_id']), version: Number(row['version'] ?? 1), digest: hash(row), effectiveDate: typeof row['effectiveDate'] === 'string' ? row['effectiveDate'] : asOf, knownAt: typeof row['recordedAt'] === 'string' ? row['recordedAt'] : typeof row['createdAt'] === 'string' ? row['createdAt'] : knownAt });
        } };
        const events = (await m.store.all(table(scope.kind, 'events'), scope, s)).filter(e => e.unitKnownAt <= knownAt && e.effectiveDate <= asOf), expenses = await m.store.all(table(scope.kind, 'expenses'), scope, s), liabilities = await m.store.all(table(scope.kind, 'liabilities'), scope, s), versions = await m.store.all(table(scope.kind, 'liability_versions'), scope, s), rules = await m.store.all(table(scope.kind, 'expense_rules'), scope, s);
        addRefs(table(scope.kind, 'events'), events);
        addRefs(table(scope.kind, 'expenses'), expenses);
        addRefs(table(scope.kind, 'liabilities'), liabilities);
        addRefs(table(scope.kind, 'liability_versions'), versions);
        addRefs(table(scope.kind, 'expense_rules'), rules);
        const source = await ledgerSources(w, scope, s);
        addRefs(scope.kind === 'BUSINESS' ? 'financial_accounts' : 's09_personal_accounts', source.accounts);
        addRefs(scope.kind === 'BUSINESS' ? 'financial_journals' : 's09_personal_journals', source.journals);
        const totals = await m.ledger.totals(scope, s, asOf, knownAt), book = await identity.database.db.collection(booksTable).findOne({ _id: scope.bookId, ownerId: scope.ownerId, domainKind: scope.kind }, { session: s });
        if (book && book.recordedAt > knownAt)
            return await recapture(book.recordedAt);
        const view = book ? await new View(w, scope, s, asOf, knownAt).load() : null, positions = view ? await view.positions() : { recognizedAssetCost: '0.00', ownedEstimatedValue: '0.00', cashAvailable: money(totals.cashAvailable) };
        const fundEvents = view ? await w.fundEvents(scope, s) : [], fundIds = new Set(fundEvents.map(e => e._id));
        addRefs(wealthTable(scope.kind, 'assets'), view?.assets ?? []);
        addRefs(wealthTable(scope.kind, 'funds'), view?.funds ?? []);
        addRefs(wealthTable(scope.kind, 'asset_events'), (view?.events ?? []).filter(e => !fundIds.has(e._id)));
        addRefs(wealthTable(scope.kind, 'fund_events'), fundEvents);
        let cash = 0n;
        for (const account of source.accounts.filter(x => ['CASH', 'BANK'].includes(x.kind))) {
            if (view) {
                const value = await view.availability(account._id);
                cash += cents(value.confirmedCash);
            }
            else
                for (const journal of source.journals)
                    if (journal.effectiveDate <= asOf && journal.recordedAt <= knownAt)
                        for (const line of journal.lines)
                            if (line.accountId === account._id) {
                                cash += storedCents(line.debit) - storedCents(line.credit);
                            }
        }
        const fundReserved = [...(view?.reserves.values() ?? [])].reduce((n, v) => n + v, 0n), available = cents(String(positions['cashAvailable']));
        const makeFlow = (key, entityId, date, direction, classification, amount, extra = {}) => { const f = { id: uuid(scope.bookId + ':' + key), sourceKey: key, bookId: scope.bookId, date, direction, classification, amount, entityId, installment: null, sourceRefs: refs.filter(r => r.id === entityId), ...extra }; flows.push(f); return f; };
        let payableDebt = 0n;
        for (const e of expenses.filter(e => e.planningStatus !== 'CANCELLED' && e.recordedAt <= knownAt)) {
            const position = expensePosition(events.filter(x => x.entityId === e._id)), recognized = position.recognized > 0n, n = recognized ? money(position.outstanding) : e.amount ?? null;
            if (n === '0.00')
                continue;
            if (recognized)
                payableDebt += position.outstanding;
            makeFlow('expense:' + e._id, e._id, e.dueDate, 'OUT', 'EXPENSE', n, { recognized });
            facts.push({ type: 'EXPENSE_DUE', entityKey: e._id, date: e.dueDate, amount: n, complete: n !== null, sourceRefs: refs.filter(r => r.id === e._id) });
        }
        // Expand the approved calendar in memory, retaining already generated/cancelled occurrences.
        const history = rules.length ? await m.store.all(table(scope.kind, 'history'), scope, s) : [];
        for (const rule of rules) {
            const vs = [...history.filter(r => r['entityTable'] === table(scope.kind, 'expense_rules') && r['entityId'] === rule._id).map(r => r['payload']), rule].filter(r => r.recordedAt <= knownAt).sort((x, y) => x.effectiveFrom.localeCompare(y.effectiveFrom));
            for (let i = 0; i < vs.length; i++) {
                const r = vs[i], from = [day(asOf, 1), r.effectiveFrom].sort().at(-1), through = [day(asOf, 366), vs[i + 1] ? day(vs[i + 1].effectiveFrom, -1) : day(asOf, 366)].sort()[0];
                if (from > through)
                    continue;
                for (const d of occurrences(r, from, through)) {
                    budget();
                    if (expenses.some(e => e.seriesId === rule._id && e.nominalDate === d))
                        continue;
                    makeFlow('rule:' + rule._id + ':' + d, rule._id, d, 'OUT', 'EXPENSE', r.amount ?? null);
                    facts.push({ type: 'EXPENSE_DUE', entityKey: rule._id + ':' + d, date: d, amount: r.amount ?? null, complete: r.amount !== undefined, sourceRefs: refs.filter(x => x.id === rule._id) });
                }
            }
        }
        let ownDebt = payableDebt;
        for (const l of liabilities.filter(l => l.recordedAt <= knownAt && l.status !== 'DRAFT' && l.status !== 'CANCELLED')) {
            const ev = events.filter(e => e.entityId === l._id), position = liabilityPosition(ev);
            if (!position.activated)
                continue;
            ownDebt += position.principal + position.components;
            const official = versions.filter(v => v['liabilityId'] === l._id && v.recordedAt <= knownAt && v['schedule'].kind === 'OFFICIAL_DECLARED').sort((x, y) => String(x['validFrom']).localeCompare(String(y['validFrom'])) || x.version - y.version);
            const current = official.filter(v => String(v['validFrom']) <= asOf).at(-1), schedule = (current?.['schedule'] ?? l.schedule), permissions = (current?.['prepaymentPermissions'] ?? l.prepaymentPermissions);
            const calendars = official.length ? official.map(v => ({ validFrom: String(v['validFrom']), schedule: v['schedule'], permissions: v['prepaymentPermissions'] })) : [{ validFrom: schedule.validFrom, schedule, permissions }];
            const selected = [];
            for (let ix = 0; ix < calendars.length; ix++) {
                const version = calendars[ix], next = calendars[ix + 1], active = version.schedule;
                for (const q of active.installments) {
                    if (next && q.dueDate >= next.validFrom)
                        continue;
                    const uncertain = ix > 0 && q.dueDate < version.validFrom;
                    if (uncertain)
                        reasons.push('MISSING_DATE');
                    const component = (k, n) => { const paid = position.paid.get(active.id + ':' + q.number + ':' + k) ?? 0n, v = cents(n) - paid; if (v < 0n)
                        throw new AppError(503, 'INTEGRITY_MISMATCH'); return money(v); };
                    const principal = component('PRINCIPAL', q.principal), interest = component('INTEREST', q.interest), insurance = component('INSURANCE', q.insurance), fees = component('FEES', q.fees), pending = { ...q, principal, interest, insurance, fees, total: money(cents(principal) + cents(interest) + cents(insurance) + cents(fees)) };
                    selected.push(pending);
                    for (const [k, classification] of [['principal', 'DEBT_PRINCIPAL'], ['interest', 'EXPENSE'], ['insurance', 'INSURANCE'], ['fees', 'FEES']])
                        if (cents(pending[k]) > 0n) {
                            const recognized = k !== 'principal' && (position.recognized.get(active.id + ':' + q.number + ':' + k.toUpperCase()) ?? 0n) > 0n;
                            makeFlow('liability:' + l._id + ':' + active.id + ':' + q.number + ':' + k, l._id, q.dueDate, 'OUT', classification, pending[k], { installment: q.number, recognized });
                        }
                    if (cents(pending.total) > 0n)
                        facts.push({ type: 'LIABILITY_DUE', entityKey: l._id + ':' + active.id + ':' + q.number, date: q.dueDate, amount: pending.total, complete: !uncertain, sourceRefs: refs.filter(r => r.id === l._id || r.id === active.id) });
                }
            }
            terms.push({ id: l._id, entityId: l._id, version: current?.version ?? schedule.version, bookId: scope.bookId, principalOpening: money(position.principal), installments: selected, prepaymentPermissions: permissions, permissionsByDate: calendars.map(c => ({ validFrom: c.validFrom, permissions: c.permissions })), supported: schedule.kind === 'OFFICIAL_DECLARED', reason: schedule.kind === 'OFFICIAL_DECLARED' ? null : 'MISSING_TERMS', kind: 'LIABILITY' });
            if (schedule.kind !== 'OFFICIAL_DECLARED')
                reasons.push('MISSING_TERMS');
        }
        for (const v of versions.filter(v => v.recordedAt <= knownAt)) {
            const original = liabilities.find(l => l._id === v['liabilityId']);
            if (!original)
                throw new AppError(503, 'INTEGRITY_MISMATCH');
            const raw = v['schedule'], rate = v['rate'];
            let prepared = raw, supported = true, reason = null;
            try {
                prepared = approvedSchedule(raw, rate, raw.principalOpening);
            }
            catch {
                supported = false;
                reason = rate.kind === 'VARIABLE' ? 'VARIABLE_RATE_FUTURE_UNKNOWN' : 'UNSUPPORTED_CONVENTION';
            }
            terms.push({ id: v._id, entityId: original._id, validFrom: String(v['validFrom']), version: v.version, bookId: scope.bookId, principalOpening: prepared.principalOpening, installments: prepared.installments, prepaymentPermissions: (v['prepaymentPermissions'] ?? []), supported, reason, kind: 'LIABILITY' });
        }
        let principal = '0.00', recognizedInterest = '0.00', held = '0.00', provisional = '0.00', confirmed = '0.00', committed = '0.00';
        if (scope.kind === 'BUSINESS') {
            const auth = await authorize(identity, a.context, scope.bookId, s, started);
            if (!auth.isT)
                throw new AppError(403, 'ACCESS_DENIED');
            const unit = await beginEvidence(identity.database, s, scope.bookId), drafts = await unit.query('lending_loans', { organizationId: scope.bookId }, {}, 10001);
            addRefs('lending_loans', drafts);
            for (const source of drafts) {
                budget();
                if (source.status !== 'TERMS_CONFIRMED')
                    continue;
                let supported = true, reason = null, installments = [];
                try {
                    installments = calculate(source.terms).schedule.map(q => ({ number: q.k, dueDate: q.date, principal: q.principal, interest: q.interest, insurance: '0.00', fees: '0.00', total: q.payment }));
                }
                catch {
                    supported = false;
                    reason = 'UNSUPPORTED_CONVENTION';
                }
                terms.push({ id: source._id, entityId: source._id, effectiveDate: source.terms.effectiveDate, version: source.termsVersion, bookId: scope.bookId, principalOpening: source.terms.principal, installments, prepaymentPermissions: [], supported, reason, kind: 'LOAN' });
            }
            const src = await loadSources(identity, scope.bookId, auth, s, started);
            if (src.dataThrough && src.dataThrough > knownAt)
                return await recapture(src.dataThrough);
            const report = reconstruct(src, { asOf, recordedThrough: knownAt, from: asOf, to: asOf }, auth, budget);
            const catalog = { loans: 'lending_loans', borrowers: 'lending_borrowers', positions: 'loan_positions', installments: 'loan_installments', schedules: 'loan_schedule_versions', events: 'loan_events', compensations: 'loan_compensations', snapshots: 'payment_event_snapshots', payments: 'payments', paymentTransitions: 'payment_transitions', custody: 'cash_custody', held: 'held_funds_reservations', deliveries: 'cash_deliveries', facts: 'cash_delivery_facts', actions: 'collection_actions', journeys: 'collection_journeys', stations: 'cash_stations', bindings: 'custody_bindings', reconciliation: 'reconciliation_events', accounts: 'financial_accounts', journals: 'financial_journals', opening: 'opening_files', historicalOrigins: 's11_historical_origins', managementEvents: table('BUSINESS', 'events') };
            for (const [name, xs] of Object.entries(src))
                if (Array.isArray(xs) && xs.every(x => x && typeof x === 'object' && '_id' in x)) {
                    const table = catalog[name];
                    if (!table)
                        throw new AppError(503, 'INTEGRITY_MISMATCH');
                    addRefs(table, xs);
                }
            const number = (id) => report.metrics.get(id)?.value ?? null;
            principal = number('PRINCIPAL_OUTSTANDING');
            recognizedInterest = number('INTEREST_RECEIVABLE');
            held = number('HELD_FUNDS') ?? '0.00';
            provisional = number('CUSTODY_PROVISIONAL') ?? '0.00';
            confirmed = number('CUSTODY_CONFIRMED') ?? '0.00';
            committed = number('CUSTODY_COMMITTED') ?? '0.00';
            if (principal === null)
                reasons.push('PARTIAL_COVERAGE');
            const accrued = new Set(src.events.filter(e => e.effectiveDate <= asOf && (src.unitKnownAt?.[e._id] ?? e.recordedAt) <= knownAt).flatMap(e => e.plan.accruals.map(q => q.loanId + ':' + q.scheduleVersion + ':' + q.installmentNumber)));
            for (const [id, v] of report.loans) {
                const raw = src.loans.find(l => l._id === id), qrows = v.installments;
                const qs = qrows.map(q => { const p = cents(String(q['principal'])) - cents(String(q['principalPaid'])), i = cents(String(q['interest'])) - cents(String(q['interestPaid'])); return { number: Number(q['number']), dueDate: String(q['dueDate']), principal: money(p), interest: money(i), insurance: '0.00', fees: '0.00', total: money(p + i) }; });
                if (!terms.some(t => t.id === id && t.kind === 'LOAN'))
                    terms.push({ id, version: Number(v.row['scheduleVersion']), bookId: scope.bookId, principalOpening: money(v.principal), installments: qs, prepaymentPermissions: [], supported: raw !== undefined, reason: raw ? null : 'MISSING_TERMS', kind: 'LOAN' });
                for (const q of qs) {
                    const original = src.installments.find(r => r.loanId === id && r.scheduleVersion === v.row['scheduleVersion'] && r.number === q.number), recognized = accrued.has(id + ':' + v.row['scheduleVersion'] + ':' + q.number) ? cents(q.interest) : original ? (cents(original.openingRecognizedInterest ?? '0.00') > cents(String(qrows.find(r => r['number'] === q.number)?.['interestPaid'] ?? '0.00')) ? cents(original.openingRecognizedInterest ?? '0.00') - cents(String(qrows.find(r => r['number'] === q.number)?.['interestPaid'] ?? '0.00')) : 0n) : 0n, ri = recognized < cents(q.interest) ? recognized : cents(q.interest);
                    if (cents(q.principal))
                        makeFlow('loan:' + id + ':' + v.row['scheduleVersion'] + ':' + q.number + ':P', id, q.dueDate, 'IN', 'PRINCIPAL', q.principal, { installment: q.number });
                    if (ri)
                        makeFlow('loan:' + id + ':' + v.row['scheduleVersion'] + ':' + q.number + ':IR', id, q.dueDate, 'IN', 'INTEREST_RECOGNIZED', money(ri), { installment: q.number });
                    if (cents(q.interest) > ri)
                        makeFlow('loan:' + id + ':' + v.row['scheduleVersion'] + ':' + q.number + ':IU', id, q.dueDate, 'IN', 'INTEREST_UNRECOGNIZED', money(cents(q.interest) - ri), { installment: q.number });
                    if (cents(q.total))
                        for (const type of ['LOAN_DUE', 'LOAN_OVERDUE'])
                            facts.push({ type, entityKey: id + ':' + q.number, date: q.dueDate, amount: q.total, complete: true, sourceRefs: refs.filter(r => r.id === id) });
                }
            }
            for (const c of report.concentrationAll)
                facts.push({ type: 'CONCENTRATION', entityKey: String(c['id']), date: asOf, amount: String(c['numerator']), denominator: String(c['denominator']), complete: report.coverage.status === 'COMPLETE', sourceRefs: refs.filter(r => r.id === c['id']) });
            for (const c of src.custody)
                facts.push({ type: 'CUSTODY_PENDING', entityKey: c._id, date: asOf, amount: String(c['amountHeld']), pending: ['PROVISIONAL', 'RETURN_REQUIRED', 'CONFIRMED_HELD', 'HELD_UNALLOCATED'].includes(String(c['state'])) && cents(String(c['amountHeld'])) > 0n, complete: true, sourceRefs: refs.filter(r => r.id === c._id) });
            for (const h of src.held)
                if (!src.custody.some(c => c['paymentId'] === h['paymentId']))
                    facts.push({ type: 'CUSTODY_PENDING', entityKey: h._id, date: String(h['effectiveDate']), amount: String(h['amount']), pending: cents(String(h['amount'])) > 0n, complete: true, sourceRefs: refs.filter(r => r.id === h._id) });
            for (const d of src.deliveries)
                facts.push({ type: 'DELIVERY_PENDING', entityKey: d._id, date: asOf, amount: String(d['amount']), pending: !['CANCELLED', 'CONFIRMED'].includes(String(d['state'])), complete: true, sourceRefs: refs.filter(r => r.id === d._id) });
            for (const p of src.payments.filter(p => p['intent']?.method === 'BANK' && String(p['recordedAt']) <= knownAt))
                facts.push({ type: 'RECONCILIATION_PENDING', entityKey: p._id, date: String(p['effectiveDate'] ?? p['observedDate']), amount: String(p['intent'].amount), pending: ['PENDING', 'DISCREPANCY', 'INVESTIGATION'].includes(String(p['reconciliationState'])), complete: typeof p['reconciliationState'] === 'string', sourceRefs: refs.filter(r => r.id === p._id) });
            digestParts.push(src.versions);
        }
        const cost = String(positions['recognizedAssetCost']), untracked = totals.assets > cash + (principal === null ? 0n : cents(principal)) + (recognizedInterest === null ? 0n : cents(recognizedInterest)) + cents(cost), estimate = untracked ? null : positions['ownedEstimatedValue'], nw = totals.assets - totals.liabilities, indicative = estimate === null ? null : money(nw - cents(cost) + cents(estimate));
        refs.sort((x, y) => x.collection.localeCompare(y.collection) || x.id.localeCompare(y.id));
        books.push({ bookId: scope.bookId, kind: scope.kind, cashBook: money(cash), available: money(available), reserved: money(fundReserved), held, custodyProvisional: provisional, custodyConfirmed: confirmed, committed, principalOutstanding: principal, recognizedInterest, ownDebt: money(ownDebt), netWorthBook: money(nw), estimatedOwnValue: estimate, netWorthIndicative: indicative, assetCost: untracked ? null : cost, funds: (view?.funds ?? []).map(f => ({ id: f._id, reserved: money(view.reserves.get(f._id) ?? 0n) })), terms, flows, sourceRefs: refs, coverage: reasons.length ? 'INCOMPLETE' : 'COMPLETE', reasons: [...new Set(reasons)] });
        digestParts.push({ scope, refs: refs.map(r => [r.collection, r.id, r.digest]), bookTag: book ? await w.bookTag(scope, s) : hash({ scope, nativeBook: null }), epoch: m.store.restoreEpoch });
    }
    if (a.consolidated) {
        const analytical = await consolidated(m, a.context, a.scope, s, asOf, knownAt), net = analytical.data['net'];
        if (analytical.reasons.length)
            books[0].reasons.push('PARTIAL_COVERAGE');
        const target = books[0], gross = books.reduce((n, b) => n + cents(b.netWorthBook), 0n), netWorth = cents(String(net['assets'])) - cents(String(net['liabilities'])), delta = netWorth - gross;
        target.netWorthBook = money(cents(target.netWorthBook) + delta);
        if (target.netWorthIndicative !== null)
            target.netWorthIndicative = money(cents(target.netWorthIndicative) + delta);
        digestParts.push(analytical);
    }
    const result = { base: { id: baseId, targetBookId: a.scope.bookId, asOf, knownAt, sourceDigest: hash(digestParts), books }, facts, factCoverage: books.every(b => b.coverage === 'COMPLETE') };
    if (books.reduce((n, b) => n + b.flows.length, 0) > 10000 || Buffer.byteLength(JSON.stringify(result)) > 16777216)
        throw new AppError(413, 'SIMULATION_SCOPE_TOO_LARGE');
    budget();
    return result;
}
export function factCandidates(c, thresholds) {
    const asOf = c.base.asOf, end = day(asOf, thresholds.dueWithinDays);
    return c.facts.map(f => {
        let condition = f.complete ? false : null;
        if (f.complete) {
            if (f.type === 'CONCENTRATION') {
                const d = cents(f.denominator);
                condition = d === 0n ? false : cents(f.amount) * 10000n > d * cents(thresholds.concentrationThreshold);
            }
            else if (f.type === 'LOAN_OVERDUE')
                condition = f.date < asOf;
            else if (f.pending !== undefined)
                condition = f.pending;
            else
                condition = f.date <= end && (f.type !== 'LOAN_DUE' || f.date >= asOf);
        }
        return { type: f.type, class: 'FACT', entityKey: f.entityKey, condition, amount: metric(f.amount === null ? null : cents(f.amount), ['MISSING_AMOUNT']), effectiveDate: f.date, sourceRefs: f.sourceRefs.slice(0, 1000), runId: null };
    });
}
//# sourceMappingURL=sources.js.map