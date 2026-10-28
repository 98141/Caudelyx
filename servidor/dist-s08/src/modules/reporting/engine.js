/* eslint-disable security/detect-object-injection -- Server-owned metric IDs and authenticated source fields, never executable client expressions. */
import { AppError } from '../../shared/errors.js';
import { money as formatMoney, cents, storedCents } from '../finance/money.js';
import { physicalMovement, zeroBuckets, addBucket } from '../collections/engine.js';
export const amount = (v) => cents(typeof v === 'string' ? v : '0.00');
const money = (value) => { try {
    return formatMoney(value);
}
catch {
    throw new AppError(422, 'MONEY_OVERFLOW');
} };
export const percent = (n, d) => d === 0n ? null : money((n * 10000n + d / 2n) / d);
export function validDate(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v; }
export function dpd(asOf, due) { return Math.max(0, Math.round((Date.parse(asOf) - Date.parse(due)) / 86400000)); }
export const atCut = (date, recorded, c) => date <= c.asOf && recorded <= c.recordedThrough;
export const inPeriod = (date, c) => date >= c.from && date <= c.to;
export const recordedDate = (v) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(v));
const sum = (xs) => xs.reduce((a, b) => a + b, 0n);
const pos = (n) => n > 0n ? n : 0n;
const reference = (type = 'AGGREGATE') => [{ type, dateBasis: 'STOCK' }];
export function coverage(principal = 0n, count = 0, unknown = 0n, reason = []) {
    const incomplete = unknown === null || unknown > 0n || reason.length > 0;
    return { status: incomplete ? 'INCOMPLETE' : 'COMPLETE', populationCount: incomplete ? null : count, evaluableCount: count, unclassifiableCount: incomplete ? null : 0, coveredPrincipal: money(principal), unclassifiablePrincipal: unknown === null ? null : money(unknown), principalCoveragePercent: unknown === null ? null : percent(principal, principal + unknown), partialNumerator: null, partialDenominator: null, partialPercent: null, reasons: reason };
}
export function stock(id, n, status = 'COMPLETE', reasons = []) { return { id, kind: 'STOCK', unit: 'COP', status, value: status === 'COMPLETE' ? money(n) : null, numerator: null, denominator: null, gross: null, compensations: null, net: null, reasons, sourceRefs: reference() }; }
export function flow(id, gross, compensations) { return { ...stock(id, gross - compensations), kind: 'FLOW', gross: money(gross), compensations: money(compensations), net: money(gross - compensations) }; }
export function ratio(id, n, d, complete = true, problems = ['OPENING_WITHOUT_SCHEDULE']) {
    const status = !complete ? 'INCOMPLETE' : d === 0n ? 'NO_DENOMINATOR' : 'COMPLETE';
    return { ...stock(id, 0n, status, status === 'NO_DENOMINATOR' ? ['NO_DENOMINATOR'] : status === 'INCOMPLETE' ? problems : []), kind: 'RATIO', unit: 'PERCENT', numerator: money(n), denominator: money(d), value: complete ? percent(n, d) : null };
}
export function reconstruct(s, c, auth, budget = () => { }) {
    budget();
    const currentCut = c.asOf === s.currentDate && (!s.dataThrough || c.recordedThrough >= s.dataThrough);
    const currentEvents = new Map(s.events.map(e => [e._id, e]));
    for (const p of s.positions)
        if (!currentEvents.has(p.fundingEventId))
            throw new AppError(503, 'SOURCE_INCONSISTENT');
    const events = s.events.filter(e => atCut(e.effectiveDate, e.recordedAt, c));
    const eventIds = new Set(events.map(e => e._id));
    const comps = s.compensations.filter(x => atCut(String(x['effectiveDate']), String(x['createdAt']), c));
    const reversed = new Set(comps.map(x => String(x['originalEventId'])));
    const live = events.filter(e => !reversed.has(e._id));
    const groupBy = (rows, key) => { const map = new Map(); for (const row of rows) {
        const k = key(row), group = map.get(k) ?? [];
        group.push(row);
        map.set(k, group);
    } return map; };
    const schedulesByLoan = groupBy(s.schedules, x => x.loanId), rowsByLoan = groupBy(s.installments, x => x.loanId), allocationsByLoan = groupBy(live.flatMap(e => e.plan.allocations), x => x.loanId);
    const fundsByLoan = new Map(events.filter(e => e.kind === 'DISBURSE').flatMap(e => e.loanIds.map(id => [id, e])));
    const accrualKeys = new Set(events.flatMap(e => e.plan.accruals.map(a => a.loanId + ':' + a.scheduleVersion + ':' + a.installmentNumber)));
    const positionByLoan = new Map(s.positions.map(p => [p.loanId, p]));
    const borrowers = new Map(s.borrowers.map(b => [b._id, b]));
    const visibleLoans = auth.isT ? s.loans : s.loans.filter(l => auth.loanIds.includes(l._id));
    const views = new Map();
    const portfolio = [], installments = [];
    for (const loan of visibleLoans) {
        budget();
        const funded = fundsByLoan.get(loan._id);
        if (!funded)
            continue;
        const scheduled = (schedulesByLoan.get(loan._id) ?? []).filter(v => (!v.eventId || eventIds.has(v.eventId) || comps.some(x => x._id === v.eventId)) && v.createdAt <= c.recordedThrough);
        const versions = new Set(scheduled.map(v => v.version));
        if (!versions.has(1))
            throw new AppError(503, 'SOURCE_INCONSISTENT');
        const active = (rowsByLoan.get(loan._id) ?? []).filter(r => versions.has(r.scheduleVersion) && (r.supersededByVersion === null || !versions.has(r.supersededByVersion)));
        const allocations = allocationsByLoan.get(loan._id) ?? [];
        const principal = amount(loan.terms.principal) - sum(allocations.filter(a => a.component !== 'INTEREST').map(a => amount(a.amount)));
        if (principal < 0n)
            throw new AppError(503, 'SOURCE_INCONSISTENT');
        const latest = positionByLoan.get(loan._id);
        if (!latest || loan.status !== 'TERMS_CONFIRMED' || latest.borrowerId !== loan.borrowerId || latest.originalPrincipal !== loan.terms.principal)
            throw new AppError(503, 'SOURCE_INCONSISTENT');
        if (currentCut && latest && amount(latest.principalOutstanding) !== principal)
            throw new AppError(503, 'SOURCE_INCONSISTENT');
        let overdue = 0n, interestOverdue = 0n, due = 0n, futureInterest = 0n, unaccrued = 0n, pendingInterest = 0n, oldest = null, cohortDue = 0n, cohortPaid = 0n;
        const ir = [];
        for (const r of active) {
            const a = allocations.filter(x => x.scheduleVersion === r.scheduleVersion && x.installmentNumber === r.number);
            const paidP = sum(a.filter(x => x.component === 'DUE_PRINCIPAL').map(x => amount(x.amount))), paidI = sum(a.filter(x => x.component === 'INTEREST').map(x => amount(x.amount)));
            if (paidP > amount(r.principal) || paidI > amount(r.interest))
                throw new AppError(503, 'SOURCE_INCONSISTENT');
            const remP = pos(amount(r.principal) - paidP), remI = pos(amount(r.interest) - paidI), unpaid = remP + remI > 0n;
            pendingInterest += remI;
            if (r.dueDate <= c.asOf)
                due += remP;
            if (r.dueDate < c.asOf) {
                overdue += remP;
                interestOverdue += remI;
            }
            if (unpaid && r.dueDate <= c.asOf && (!oldest || r.dueDate < oldest))
                oldest = r.dueDate;
            if (r.dueDate > c.asOf)
                futureInterest += remI;
            if (r.dueDate <= c.asOf && !accrualKeys.has(loan._id + ':' + r.scheduleVersion + ':' + r.number))
                unaccrued += remI;
            if (inPeriod(r.dueDate, c)) {
                cohortDue += amount(r.principal) + amount(r.interest);
                cohortPaid += paidP + paidI;
            }
            ir.push({ rowKind: 'INSTALLMENTS', id: r._id, loanId: loan._id, scheduleVersion: r.scheduleVersion, number: r.number, dueDate: r.dueDate, principal: r.principal, interest: r.interest, principalPaid: money(paidP), interestPaid: money(paidI), state: unpaid ? (paidP + paidI > 0n ? 'PARTIAL' : 'UNPAID') : 'PAID', dpd: unpaid ? dpd(c.asOf, r.dueDate) : 0, sourceRefs: [{ type: 'INSTALLMENT', id: r._id, dateBasis: 'STOCK' }] });
        }
        const b = borrowers.get(loan.borrowerId);
        if (!b)
            throw new AppError(503, 'SOURCE_INCONSISTENT');
        const age = oldest ? dpd(c.asOf, oldest) : 0, cv = coverage(principal, 1);
        const row = { rowKind: 'PORTFOLIO', id: loan._id, loanId: loan._id, reference: loan._id, borrower: { id: b._id, code: b.borrowerCode, name: b.profile.displayName }, state: principal === 0n && pendingInterest === 0n ? 'SETTLED' : 'ACTIVE', principal: money(principal), duePrincipal: money(due), overduePrincipal: money(overdue), overdueInterest: money(interestOverdue), exposedPrincipal: money(age > 0 ? principal : 0n), dpd: age, par30Eligible: principal > 0n && age > 30, scheduleVersion: Math.max(...versions), coverage: cv, sourceRefs: [{ type: 'LOAN_EVENT', id: funded._id, dateBasis: 'STOCK' }] };
        views.set(loan._id, { row, installments: ir, principal, overdue, interestOverdue, due, futureInterest, unaccrued, dpd: age, cohortDue, cohortPaid });
        portfolio.push(row);
        installments.push(...ir.filter(r => inPeriod(String(r['dueDate']), c)));
    }
    const principal = sum([...views.values()].map(v => v.principal)), risk = sum([...views.values()].filter(v => v.dpd > 30).map(v => v.principal));
    const ledger = new Map();
    for (const j of s.journals.filter(j => atCut(j.effectiveDate, j.recordedAt, c)))
        for (const l of j.lines)
            ledger.set(l.accountId, (ledger.get(l.accountId) ?? 0n) + storedCents(l.debit) - storedCents(l.credit));
    const accountBalance = (id) => ledger.get(String(id)) ?? 0n;
    const profile = s.profile, principalAccounts = new Set(profile ? [String(profile['profile']?.principalAccountId)] : []), interestAccounts = new Set(profile ? [String(profile['profile']?.interestReceivableAccountId)] : []);
    const postedOpenings = s.opening.filter(o => o['status'] === 'POSTED' && o['snapshot']?.cutoffDate <= c.asOf && o['commit']?.recordedAt <= c.recordedThrough);
    for (const o of postedOpenings) {
        for (const component of o['snapshot'].components)
            if (component['category'] === 'PRINCIPAL_RECEIVABLE')
                principalAccounts.add(String(component['accountId']));
        for (const interest of o['snapshot'].historicalInterest)
            if (interest['treatment'] === 'RECOGNIZED_OPENING' && interest['accountId'])
                interestAccounts.add(String(interest['accountId']));
    }
    const ledgerPrincipal = sum([...principalAccounts].map(id => accountBalance(id)));
    const unknown = auth.isT ? ledgerPrincipal - principal : 0n;
    if (unknown < 0n)
        throw new AppError(503, 'SOURCE_INCONSISTENT');
    const cov = coverage(principal, views.size, unknown, unknown > 0n ? [postedOpenings.length ? 'OPENING_WITHOUT_SCHEDULE' : 'UNALLOCATED_PRINCIPAL'] : []);
    cov.partialNumerator = money(risk);
    cov.partialDenominator = money(principal);
    cov.partialPercent = percent(risk, principal);
    if (unknown > 0n)
        portfolio.push({ rowKind: 'PORTFOLIO', id: auth.organizationId + ':UNCLASSIFIABLE', reference: 'Principal contable sin calendario verificable', state: 'UNCLASSIFIABLE', principal: money(unknown), duePrincipal: null, overduePrincipal: null, overdueInterest: null, exposedPrincipal: null, dpd: null, par30Eligible: null, scheduleVersion: null, coverage: cov, sourceRefs: reference() });
    const metrics = new Map(), put = (m) => metrics.set(m.id, m);
    const total = (k) => sum([...views.values()].map(v => v[k]));
    put(stock('PRINCIPAL_OUTSTANDING', principal, cov.status, cov.reasons));
    put(stock('PRINCIPAL_LEDGER', ledgerPrincipal));
    for (const [id, k] of [['PRINCIPAL_DUE_TODAY_OR_EARLIER', 'due'], ['PRINCIPAL_OVERDUE', 'overdue'], ['INTEREST_OVERDUE', 'interestOverdue'], ['INTEREST_EXPECTED_FUTURE', 'futureInterest'], ['INTEREST_DUE_UNACCRUED', 'unaccrued']])
        put(stock(id, total(k), cov.status, cov.reasons));
    put(stock('PRINCIPAL_EXPOSED_OVERDUE', sum([...views.values()].filter(v => v.dpd > 0).map(v => v.principal)), cov.status, cov.reasons));
    put(ratio('PAR30', risk, principal, cov.status === 'COMPLETE', cov.reasons));
    put(ratio('INSTALLMENT_FULFILMENT', total('cohortPaid'), total('cohortDue'), cov.status === 'COMPLETE', cov.reasons));
    const payments = new Map(s.payments.map(p => [String(p['eventId']), p]));
    const authorizedEvent = (e) => auth.isT || Boolean(payments.get(e._id) && ((auth.isC || auth.isO) && payments.get(e._id)['registrarId'] === auth.actorId));
    const g = { receipt: 0n, interest: 0n, creditInterest: 0n, principal: 0n, accrued: 0n, disbursed: 0n }, rev = { ...g };
    function accumulate(e, target) {
        if (e.kind === 'DISBURSE') {
            target.disbursed += sum(e.plan.postings.filter(l => profile && l.accountId === profile['profile']?.principalAccountId).map(l => amount(l.debit)));
            return;
        }
        if (e.kind === 'RECEIPT')
            target.receipt += sum(e.plan.postings.filter(l => !profile || ![profile['profile']?.principalAccountId, profile['profile']?.interestReceivableAccountId, profile['profile']?.borrowerCreditAccountId, profile['profile']?.interestIncomeAccountId].includes(l.accountId)).map(l => amount(l.debit)));
        target.principal += sum(e.plan.allocations.filter(a => a.component !== 'INTEREST').map(a => amount(a.amount)));
        const interest = sum(e.plan.allocations.filter(a => a.component === 'INTEREST').map(a => amount(a.amount)));
        if (e.kind === 'RECEIPT')
            target.interest += interest;
        else if (e.kind === 'APPLY_CREDIT')
            target.creditInterest += interest;
    }
    for (const e of events) {
        if (!authorizedEvent(e) || !inPeriod(e.effectiveDate, c))
            continue;
        accumulate(e, g);
        g.accrued += sum(e.plan.accruals.map(a => amount(a.interest)));
    }
    for (const x of comps) {
        if (!inPeriod(String(x['effectiveDate']), c))
            continue;
        const e = currentEvents.get(String(x['originalEventId']));
        if (!e || !authorizedEvent(e))
            continue;
        accumulate(e, rev);
    }
    for (const [id, k] of [['RECEIPTS_CONFIRMED', 'receipt'], ['INTEREST_RECEIVED', 'interest'], ['INTEREST_SATISFIED_BY_CREDIT', 'creditInterest'], ['PRINCIPAL_RECOVERED', 'principal'], ['PRINCIPAL_DISBURSED', 'disbursed'], ['INTEREST_ACCRUED', 'accrued']])
        put(flow(id, g[k], rev[k]));
    let registered = 0n;
    for (const p of s.payments) {
        if (!(auth.isT || ((auth.isC || auth.isO) ? p['registrarId'] === auth.actorId : auth.isP && p['approvalMode'] === 'SUPERVISED' && p['status'] === 'PENDING')))
            continue;
        const when = String(p['recordedAt']);
        if (when <= c.recordedThrough && inPeriod(recordedDate(when), c))
            registered += amount(p['intent']?.amount);
    }
    put(flow('RECEIPTS_REGISTERED', registered, 0n));
    let credit = 0n;
    for (const e of live) {
        const ch = e.plan.creditChange;
        if (ch)
            credit += amount(ch.added) - amount(ch.applied);
    }
    const creditComplete = !auth.isT || !profile || -accountBalance(profile['profile']?.borrowerCreditAccountId) === credit;
    put(stock('BORROWER_CREDIT', credit, creditComplete ? 'COMPLETE' : 'INCOMPLETE', creditComplete ? [] : ['HISTORY_UNAVAILABLE']));
    const outstandingInterest = sum([...interestAccounts].map(id => accountBalance(id)));
    put(stock('INTEREST_RECEIVABLE', outstandingInterest));
    const current = currentCut;
    const eligibleDelivery = s.deliveries.filter(d => d['state'] === 'CONFIRMED' && s.journals.some(j => j._id === d['journalId'] && atCut(j.effectiveDate, j.recordedAt, c)));
    let delivered = 0n, deliveredReversed = 0n;
    for (const d of eligibleDelivery)
        if (inPeriod(String(d['effectiveDate']), c) && (auth.isT || d['senderId'] === auth.actorId || d['receiverId'] === auth.actorId)) {
            if (d['kind'] === 'FORWARD')
                delivered += amount(d['amount']);
            else
                deliveredReversed += amount(d['amount']);
        }
    put(flow('DELIVERED_NET', delivered, deliveredReversed));
    const held = s.held.filter(h => atCut(String(h['effectiveDate']), String(h['createdAt']), c) && (auth.isT || s.custody.some(x => x['paymentId'] === h['paymentId'] && x['responsibleId'] === auth.actorId)));
    const heldTotal = sum(held.map(h => amount(h['amount'])));
    put(stock('HELD_FUNDS', heldTotal));
    let provisional = 0n, confirmed = 0n, committed = 0n;
    const reserveByAccount = new Map();
    for (const h of held)
        reserveByAccount.set(String(h['accountId']), (reserveByAccount.get(String(h['accountId'])) ?? 0n) + amount(h['amount']));
    for (const x of s.custody) {
        if (!auth.isT && x['responsibleId'] !== auth.actorId)
            continue;
        const p = s.payments.find(p => p._id === x['paymentId']);
        if (!p)
            throw new AppError(503, 'SOURCE_INCONSISTENT');
        const state = String(x['state']), value = amount(x['amountHeld']);
        if (['PROVISIONAL', 'RETURN_REQUIRED'].includes(state))
            provisional += value;
        if (state !== 'CONFIRMED_HELD' || held.some(h => h['paymentId'] === x['paymentId']))
            continue;
        let retained = value;
        for (const d of eligibleDelivery) {
            const portion = d['portions'].find(p => p['sourcePaymentId'] === x['paymentId']);
            if (portion)
                retained += (d['kind'] === 'FORWARD' ? -1n : 1n) * amount(portion['amount']);
        }
        if (retained < 0n)
            throw new AppError(503, 'SOURCE_INCONSISTENT');
        confirmed += retained;
        reserveByAccount.set(String(x['accountId']), (reserveByAccount.get(String(x['accountId'])) ?? 0n) + retained);
    }
    for (const d of s.deliveries.filter(d => !['CANCELLED', 'CONFIRMED'].includes(String(d['state'])))) {
        if (auth.isT || d['senderId'] === auth.actorId || d['receiverId'] === auth.actorId)
            committed += amount(d['amount']);
        if (d['kind'] === 'COMPENSATION')
            reserveByAccount.set(String(d['sourceAccountId']), (reserveByAccount.get(String(d['sourceAccountId'])) ?? 0n) + amount(d['amount']));
    }
    for (const [id, n] of [['CUSTODY_PROVISIONAL', provisional], ['CUSTODY_CONFIRMED', confirmed], ['CUSTODY_COMMITTED', committed]])
        put(stock(id, n, current ? 'COMPLETE' : 'UNAVAILABLE', current ? [] : ['RESERVE_HISTORY_UNAVAILABLE']));
    const liquid = s.accounts.filter(a => ['CASH', 'BANK'].includes(a.kind) && a.createdAt <= c.recordedThrough), liquidBook = sum(liquid.map(a => accountBalance(a._id))), reserved = sum([...reserveByAccount.values()]);
    put(stock('LIQUIDITY_BOOK', liquidBook));
    put(stock('LIQUIDITY_RESERVED', reserved, current ? 'COMPLETE' : 'UNAVAILABLE', current ? [] : ['RESERVE_HISTORY_UNAVAILABLE']));
    put(stock('LIQUIDITY_AVAILABLE', liquidBook - reserved, current ? 'COMPLETE' : 'UNAVAILABLE', current ? [] : ['RESERVE_HISTORY_UNAVAILABLE']));
    for (const [id, reason] of [['RETURN_ON_AVERAGE_CAPITAL', 'MISSING_COST_AND_AVERAGE_CAPITAL_POLICY'], ['OBLIGATIONS_COVERAGE', 'MISSING_OBLIGATIONS_S09']])
        put({ ...stock(id, 0n, 'UNAVAILABLE', [reason]), kind: 'RATIO', unit: 'PERCENT' });
    put(stock('INTEGRAL_NET_WORTH', 0n, 'UNAVAILABLE', ['MISSING_COMPONENTS_S09_S10']));
    const observed = (at) => typeof at === 'string' && Number.isFinite(Date.parse(at)) && atCut(recordedDate(at), at, c);
    const paymentState = (p) => {
        if (!s.paymentTransitions) {
            if (current)
                return p['status'];
            throw new AppError(503, 'SOURCE_INCONSISTENT');
        }
        const transitions = s.paymentTransitions.filter(t => t['paymentId'] === p._id && observed(t['createdAt'])).sort((a, b) => Number(a['version']) - Number(b['version']));
        let state;
        for (const t of transitions) {
            const op = t['operation'];
            if (op === 'registerPayment')
                state = p['approvalMode'] === 'DIRECT' ? 'CONFIRMED' : 'PENDING';
            else if (op === 'approvePayment' || op === 'rejectPaymentReversal')
                state = 'CONFIRMED';
            else if (op === 'rejectPayment')
                state = 'REJECTED';
            else if (op === 'cancelPayment')
                state = 'CANCELLED';
            else if (op === 'requestPaymentReversal')
                state = 'REVERSAL_REQUESTED';
            else if (op === 'executePaymentReversal')
                state = 'REVERSED';
        }
        if (!state)
            throw new AppError(503, 'SOURCE_INCONSISTENT');
        return state;
    };
    const movements = [];
    const movement = (e, comp) => {
        if (!authorizedEvent(e))
            return;
        const effectiveDate = comp ? String(comp['effectiveDate']) : e.effectiveDate, recordedAt = comp ? String(comp['createdAt']) : e.recordedAt;
        if (!inPeriod(effectiveDate, c))
            return;
        const p = payments.get(e._id), targets = e.plan.allocations, interest = sum(targets.filter(a => a.component === 'INTEREST').map(a => amount(a.amount))), principalApplied = sum(targets.filter(a => a.component !== 'INTEREST').map(a => amount(a.amount)));
        const r = { rowKind: 'MOVEMENTS', id: comp ? comp._id : e._id, nature: comp ? 'COMPENSATION' : e.kind, effectiveDate, recordedAt, dateBasis: 'EFFECTIVE', amount: p ? String(p['intent']?.amount) : money(principalApplied + interest), sign: comp ? -1 : 1, principal: money(principalApplied), interest: money(interest), credit: money(amount(e.plan.creditChange?.added)), method: p ? String(p['intent']?.method) : e.kind === 'RECEIPT' ? 'LEGACY_UNSPECIFIED' : 'NOT_APPLICABLE', state: comp ? 'REVERSED' : 'CONFIRMED', sourceRefs: reference('LOAN_EVENT') };
        if (comp)
            r['originalId'] = e._id;
        if (p)
            r['paymentId'] = p._id;
        if (e.loanIds.length === 1 && (auth.isT || auth.loanIds.includes(e.loanIds[0]))) {
            r['loanId'] = e.loanIds[0];
            const b = borrowers.get(e.borrowerId);
            if (b)
                r['borrower'] = { id: b._id, code: b.borrowerCode, name: b.profile.displayName };
        }
        movements.push(r);
    };
    for (const e of events)
        movement(e, null);
    for (const x of comps) {
        const e = currentEvents.get(String(x['originalEventId']));
        if (e)
            movement(e, x);
    }
    for (const d of eligibleDelivery)
        if (inPeriod(String(d['effectiveDate']), c) && (auth.isT || d['senderId'] === auth.actorId || d['receiverId'] === auth.actorId)) {
            const journal = s.journals.find(j => j._id === d['journalId']);
            movements.push({ rowKind: 'MOVEMENTS', id: d._id, nature: d['kind'] === 'FORWARD' ? 'CASH_DELIVERY' : 'CASH_DELIVERY_COMPENSATION', ...(d['originalDeliveryId'] ? { originalId: d['originalDeliveryId'] } : {}), effectiveDate: d['effectiveDate'], recordedAt: journal.recordedAt, dateBasis: 'EFFECTIVE', amount: d['amount'], sign: d['kind'] === 'FORWARD' ? 1 : -1, principal: '0.00', interest: '0.00', credit: '0.00', method: 'CASH', state: 'CONFIRMED', sourceRefs: [{ type: 'DELIVERY', id: d._id, dateBasis: 'EFFECTIVE' }] });
        }
    for (const p of s.payments)
        if ((auth.isT || (auth.isC || auth.isO) && p['registrarId'] === auth.actorId || auth.isP && p['approvalMode'] === 'SUPERVISED' && p['status'] === 'PENDING') && String(p['recordedAt']) <= c.recordedThrough && inPeriod(recordedDate(String(p['recordedAt'])), c)) {
            movements.push({ rowKind: 'MOVEMENTS', id: p._id, paymentId: p._id, nature: 'REGISTERED_PAYMENT', effectiveDate: null, recordedAt: p['recordedAt'], dateBasis: 'REGISTRATION', amount: p['intent'].amount, sign: 1, principal: '0.00', interest: '0.00', credit: '0.00', method: p['intent'].method, state: paymentState(p), sourceRefs: [{ type: 'PAYMENT', id: p._id, dateBasis: 'REGISTRATION' }] });
        }
    const grouped = new Map();
    for (const [l, v] of views) {
        const b = s.loans.find(x => x._id === l).borrowerId;
        grouped.set(b, (grouped.get(b) ?? 0n) + v.principal);
    }
    const concentrationAll = [...grouped].sort((a, b) => a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] > b[1] ? -1 : 1).map(([id, n]) => { const b = borrowers.get(id); return { rowKind: 'CONCENTRATION', id, group: 'BORROWER', borrower: { id, code: b.borrowerCode, name: b.profile.displayName }, principal: money(n), numerator: money(n), denominator: money(principal + unknown), percent: cov.status === 'COMPLETE' ? percent(n, principal) : null, coverage: { ...cov, partialNumerator: money(n), partialDenominator: money(principal), partialPercent: percent(n, principal) } }; });
    const concentration = concentrationAll.slice(0, 10);
    if (concentrationAll.length > 10) {
        const rest = sum(concentrationAll.slice(10).map(x => amount(x['principal'])));
        concentration.push({ rowKind: 'CONCENTRATION', id: 'OTHER', group: 'OTHER', principal: money(rest), numerator: money(rest), denominator: money(principal + unknown), percent: cov.status === 'COMPLETE' ? percent(rest, principal) : null, coverage: cov });
    }
    if (unknown > 0n)
        concentration.push({ rowKind: 'CONCENTRATION', id: 'UNATTRIBUTABLE', group: 'UNATTRIBUTABLE', principal: money(unknown), numerator: money(unknown), denominator: money(principal + unknown), percent: null, coverage: cov });
    const ownPayments = s.payments.filter(p => auth.isT || (auth.isC || auth.isO) && p['registrarId'] === auth.actorId || auth.isP && p['status'] === 'PENDING' && p['approvalMode'] === 'SUPERVISED');
    const reconciliation = auth.isT ? ownPayments.filter(p => p['intent']?.method === 'BANK' && eventIds.has(String(p['eventId'])) && inPeriod(String(p['effectiveDate']), c)).map(p => ({ rowKind: 'RECONCILIATION', id: p._id, paymentId: p._id, effectiveDate: p['effectiveDate'], amount: p['intent'].amount, state: current ? p['reconciliationState'] : null, coverage: current ? coverage() : coverage(0n, 0, null, ['RECONCILIATION_HISTORY_UNAVAILABLE']), sourceRefs: reference('PAYMENT') })) : [];
    const responsible = [...new Set([...(auth.isT ? [] : [auth.actorId]), ...s.journeys.filter(j => observed(j['recordedAt'])).map(j => String(j['ownerId'])), ...s.custody.map(x => String(x['responsibleId'])), ...ownPayments.filter(p => observed(p['recordedAt'])).map(p => String(p['registrarId'])), ...s.actions.filter(x => observed(x['recordedAt'])).map(x => String(x['ownerId']))])];
    const cancelled = new Set(s.facts.filter(f => ['CANCEL', 'RETURN_CONFIRMED'].includes(String(f['kind'])) && observed(f['recordedAt'])).map(f => String(f['deliveryId'])));
    const confirmedIds = new Set(eligibleDelivery.map(d => d._id));
    const collectors = responsible.filter(id => auth.isT || id === auth.actorId).map(id => {
        const own = ownPayments.filter(p => p['registrarId'] === id), originals = new Map(own.filter(p => p['eventId']).map(p => [String(p['eventId']), p]));
        const gross = sum(own.filter(p => eventIds.has(String(p['eventId'])) && inPeriod(String(p['effectiveDate']), c)).map(p => amount(p['intent']?.amount)));
        const compensated = sum(comps.filter(x => originals.has(String(x['originalEventId'])) && inPeriod(String(x['effectiveDate']), c)).map(x => amount(originals.get(String(x['originalEventId']))['intent']?.amount)));
        return { rowKind: 'COLLECTORS', id, responsibleId: id, registered: flow('RECEIPTS_REGISTERED', sum(own.filter(p => inPeriod(recordedDate(String(p['recordedAt'])), c) && String(p['recordedAt']) <= c.recordedThrough).map(p => amount(p['intent']?.amount))), 0n), confirmed: flow('RECEIPTS_CONFIRMED', gross, compensated), actionsCount: s.actions.filter(a => a['ownerId'] === id && observed(a['recordedAt']) && inPeriod(recordedDate(String(a['recordedAt'])), c)).length, openJourneys: s.journeys.filter(j => j['ownerId'] === id && observed(j['recordedAt']) && !observed(j['closedAt'])).length, pendingDeliveries: s.deliveries.filter(d => [d['senderId'], d['receiverId']].includes(id) && observed(d['recordedAt']) && !confirmedIds.has(d._id) && !cancelled.has(d._id)).length, coverage: coverage() };
    });
    const parties = new Map();
    for (const b of s.bindings)
        parties.set(String(b['accountId']) + '|' + b['custodianId'], { account: String(b['accountId']), responsible: String(b['custodianId']) });
    for (const st of s.stations)
        parties.set(String(st['accountId']) + '|' + st['receiverId'], { account: String(st['accountId']), responsible: String(st['receiverId']) });
    if (auth.isT)
        for (const a of liquid)
            if (![...parties.values()].some(p => p.account === a._id))
                parties.set(a._id, { account: a._id, responsible: null });
    const cashRows = [];
    for (const { id, account, responsible } of [...parties].map(([id, p]) => ({ id, ...p }))) {
        if (!auth.isT && responsible !== auth.actorId)
            continue;
        if (!liquid.some(a => a._id === account))
            continue;
        const accountKind = s.accounts.find(a => a._id === account)?.kind === 'BANK' ? 'BANK' : 'CASH';
        const physicalAvailable = current && accountKind === 'CASH' && responsible !== null;
        const cs = s.custody.filter(x => x['accountId'] === account && x['responsibleId'] === responsible), heldHere = sum(held.filter(h => h['accountId'] === account).map(h => amount(h['amount']))), balance = accountBalance(account), physical = zeroBuckets();
        let retained = 0n, commit = 0n, pending = 0n;
        if (physicalAvailable) {
            if (balance < heldHere)
                throw new AppError(503, 'SOURCE_INCONSISTENT');
            physical.heldOnSite = money(heldHere);
            physical.confirmedOnSite = money(balance - heldHere);
            for (const x of cs) {
                const value = amount(x['amountHeld']);
                if (x['state'] === 'PROVISIONAL') {
                    addBucket(physical, 'provisionalOnSite', value);
                    pending += value;
                }
                if (x['state'] === 'RETURN_REQUIRED') {
                    addBucket(physical, 'returnRequiredOnSite', value);
                    pending += value;
                }
                if (x['state'] === 'CONFIRMED_HELD' && !held.some(h => h['paymentId'] === x['paymentId'])) {
                    let n = value;
                    for (const d of eligibleDelivery) {
                        const p = d['portions'].find(p => p['sourcePaymentId'] === x['paymentId']);
                        if (p)
                            n += (d['kind'] === 'FORWARD' ? -1n : 1n) * amount(p['amount']);
                    }
                    retained += n;
                }
            }
            for (const d of s.deliveries) {
                if (d['senderId'] === responsible && d['sourceAccountId'] === account && !['CONFIRMED', 'CANCELLED'].includes(String(d['state'])))
                    commit += amount(d['amount']);
                if (![d['senderId'], d['receiverId']].includes(responsible))
                    continue;
                const movement = physicalMovement(d);
                if (!movement)
                    continue;
                if (movement.source === account && d['senderId'] === responsible) {
                    if (movement.at !== 'SOURCE')
                        addBucket(physical, 'confirmedOnSite', -movement.amount);
                    else if (movement.missing)
                        addBucket(physical, 'confirmedOnSite', -movement.missing);
                    if (movement.at === 'TRANSIT_SENDER')
                        addBucket(physical, 'inTransit', movement.amount);
                    if (movement.at === 'DESTINATION' && movement.missing)
                        addBucket(physical, 'unlocatedDisputed', movement.missing);
                    if (movement.at === 'SOURCE' && movement.surplus)
                        addBucket(physical, 'unidentifiedSurplus', movement.surplus);
                }
                if (movement.destination === account && d['receiverId'] === responsible) {
                    if (movement.at === 'DESTINATION') {
                        addBucket(physical, 'receivedUnposted', movement.observed);
                        addBucket(physical, 'unidentifiedSurplus', movement.surplus);
                    }
                    if (movement.at === 'TRANSIT_RECEIVER')
                        addBucket(physical, 'inTransit', movement.amount);
                    if (movement.at === 'SOURCE' && movement.missing)
                        addBucket(physical, 'unlocatedDisputed', movement.missing);
                }
            }
        }
        const required = reserveByAccount.get(account) ?? 0n;
        if (current && balance < required)
            throw new AppError(503, 'SOURCE_INCONSISTENT');
        cashRows.push({ rowKind: 'CASH', id, accountId: account, responsibleId: responsible, accountKind, physicalStatus: accountKind === 'BANK' ? 'NOT_APPLICABLE' : physicalAvailable ? 'AVAILABLE' : 'UNAVAILABLE', ...(auth.isT ? { bookBalance: money(balance), reserved: current ? money(required) : null, available: current ? money(balance - required) : null } : {}), provisional: current ? money(pending) : null, confirmed: current ? money(retained) : null, committed: current ? money(commit) : null, held: current ? money(heldHere) : null, physical: physicalAvailable ? physical : Object.fromEntries(Object.keys(physical).map(k => [k, null])), coverage: current && (physicalAvailable || accountKind === 'BANK') ? coverage() : coverage(0n, 0, null, ['PHYSICAL_HISTORY_UNAVAILABLE']), sourceRefs: reference() });
    }
    const historyStart = [...s.journals.map(j => j.effectiveDate), ...s.events.map(e => e.effectiveDate)].sort()[0];
    if (historyStart && c.asOf < historyStart) {
        cov.status = 'UNAVAILABLE';
        cov.reasons = ['HISTORY_UNAVAILABLE'];
        cov.populationCount = null;
        cov.coveredPrincipal = null;
        cov.unclassifiablePrincipal = null;
        cov.principalCoveragePercent = null;
        cov.partialNumerator = null;
        cov.partialDenominator = null;
        cov.partialPercent = null;
        for (const m of metrics.values()) {
            m.status = 'UNAVAILABLE';
            m.value = null;
            m.reasons = ['HISTORY_UNAVAILABLE'];
        }
    }
    else if (postedOpenings.some(o => c.from < String(o['snapshot'].cutoffDate)))
        for (const m of metrics.values())
            if (m.kind === 'FLOW') {
                m.status = 'INCOMPLETE';
                m.value = null;
                m.reasons = ['HISTORY_UNAVAILABLE'];
            }
    return { metrics, coverage: cov, rows: { PORTFOLIO: portfolio, INSTALLMENTS: installments, MOVEMENTS: movements, CASH: cashRows, RECONCILIATION: reconciliation, COLLECTORS: collectors, CONCENTRATION: concentration }, loans: views, concentrationAll };
}
export function ageMatches(row, band) { if (!band || band === 'ALL')
    return true; const age = Number(row['dpd']); return band === 'DUE_TODAY' ? age === 0 && amount(row['duePrincipal'] ?? row['principal']) + amount(row['interest']) > 0n : band === 'D01_30' ? age > 0 && age <= 30 : band === 'D31_60' ? age > 30 && age <= 60 : band === 'D61_90' ? age > 60 && age <= 90 : age > 90; }
export const installmentKey = (r) => r.loanId + ':' + r.scheduleVersion + ':' + r.number;
//# sourceMappingURL=engine.js.map