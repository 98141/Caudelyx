/* eslint-disable security/detect-object-injection -- Pure closed component/metric fields from validated input and authenticated DTOs, never executable properties. */
import { createHash } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { day, validDate } from '../obligations/calendar.js';
import { cents, money, portion, fraction, positive, checkMoney } from './money.js';
import { checkedSchedule, resolveTerms } from './terms.js';
import { scenarioKinds, alternativeKinds, limits } from './models.js';
export const metric = (value, reasons = [], partial = null) => ({ value: value === null ? null : money(value), status: value === null ? 'INCOMPLETE' : 'COMPLETE', reasons: value === null ? [...new Set(reasons)] : [], knownPartial: partial === null ? null : money(partial) });
const id = (seed) => { const h = createHash('sha256').update(seed).digest('hex'); return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-8' + h.slice(17, 20) + '-' + h.slice(20, 32); };
function error(code = 'INPUT_INVALID') { throw new AppError(code === 'DOUBLE_ALLOCATION' ? 409 : 422, code); }
const amount = (v) => { const n = cents(v); if (n < 0n)
    error(); return n; };
export function validateVersion(value, asOf) {
    if (!validDate(asOf) || !Number.isInteger(value.horizonDays) || value.horizonDays < 1 || value.horizonDays > limits.days)
        error();
    if (value.assumptions.length !== 3 || scenarioKinds.some(k => value.assumptions.filter(a => a.kind === k).length !== 1) || value.alternatives.length !== 4 || alternativeKinds.some(k => value.alternatives.filter(a => a.kind === k).length !== 1))
        error();
    const budgets = value.alternatives.map(a => amount(a.budget));
    if (budgets.some(b => b !== budgets[0]))
        error();
    let count = 0;
    for (const a of value.assumptions) {
        fraction(a.collectionFraction);
        fraction(a.recoveryFraction);
        if (!Number.isInteger(a.delayDays) || a.delayDays < 0 || a.delayDays > 366 || !Number.isInteger(a.recoveryDelayDays) || a.recoveryDelayDays < 0 || a.recoveryDelayDays > 366)
            error();
        const keys = new Set();
        for (const d of a.dateOverrides) {
            if (keys.has(d.sourceKey))
                error('DOUBLE_ALLOCATION');
            keys.add(d.sourceKey);
            if (!validDate(d.collectionDate) || d.collectionDate <= asOf || d.recoveryDate !== null && (!validDate(d.recoveryDate) || d.recoveryDate < d.collectionDate))
                error();
            count++;
        }
        const capitalIds = new Set(), reinvestedSources = new Set();
        for (const c of a.capitalEvents) {
            if (capitalIds.has(c.id))
                error('DOUBLE_ALLOCATION');
            capitalIds.add(c.id);
            if (!validDate(c.date) || c.date <= asOf)
                error();
            positive(c.amount);
            if (c.kind === 'REINVESTMENT') {
                if (!c.cashSourceFlowId)
                    error();
                if (reinvestedSources.has(c.cashSourceFlowId))
                    error('DOUBLE_ALLOCATION');
                reinvestedSources.add(c.cashSourceFlowId);
                const loan = value.alternatives.find(v => v.kind === 'NEW_LOAN');
                if (!loan?.configured || loan.cashSourceFlowId !== c.cashSourceFlowId || loan.date !== c.date || cents(loan.principal) !== cents(c.amount))
                    error();
            }
            count++;
        }
    }
    for (const a of value.alternatives) {
        if (!a.configured)
            continue;
        const funds = new Set();
        for (const r of a.reserveReleases ?? []) {
            if (funds.has(r.fundId))
                error('DOUBLE_ALLOCATION');
            funds.add(r.fundId);
            if (!validDate(r.date) || r.date <= asOf)
                error();
            positive(r.amount);
            count++;
        }
        if (a.kind !== 'HOLD_CASH' && (!a.date || !validDate(a.date) || a.date <= asOf))
            error();
        if (a.kind === 'DEBT_PREPAYMENT')
            positive(a.budget);
        if (a.kind === 'NEW_LOAN' && (!a.terms || positive(a.principal) > amount(a.budget)))
            error();
        if (a.kind === 'ASSET_PURCHASE') {
            if (a.grossCost === undefined || a.ownCash === undefined || a.ownDebt === undefined || a.ownershipFraction === undefined || a.vacancyFraction === undefined)
                error();
            const own = portion(positive(a.grossCost), a.ownershipFraction);
            if (amount(a.ownCash) + amount(a.ownDebt) !== own || amount(a.ownCash) > amount(a.budget))
                error();
            fraction(a.vacancyFraction);
            if (a.estimatedGrossValue !== null && a.estimatedGrossValue !== undefined)
                amount(a.estimatedGrossValue);
            const scheduleIds = new Set();
            for (const f of [...a.rentSchedule ?? [], ...a.costSchedule ?? []]) {
                if (scheduleIds.has(f.id))
                    error('DOUBLE_ALLOCATION');
                scheduleIds.add(f.id);
                if (!validDate(f.date) || f.date < a.date)
                    error();
                amount(f.amount);
                count++;
            }
        }
        if (a.terms?.kind === 'DECLARED_HYPOTHESIS') {
            checkedSchedule(a.terms.installments, a.terms.principalOpening);
            count += a.terms.installments.length;
        }
    }
    if (count > 1000)
        throw new AppError(413, 'SIMULATION_SCOPE_TOO_LARGE');
}
/** References are checked at save time without assuming any collection percentage. */
export function validateReferences(value, base) {
    const target = base.books.find(b => b.bookId === base.targetBookId);
    if (!target)
        error();
    const flowKeys = new Set(base.books.flatMap(b => b.flows.flatMap(f => [f.id, f.sourceKey])));
    for (const a of value.assumptions)
        for (const override of a.dateOverrides)
            if (!flowKeys.has(override.sourceKey))
                error();
    for (const alt of value.alternatives) {
        if (!alt.configured)
            continue;
        for (const release of alt.reserveReleases ?? [])
            if (!target.funds.some(f => f.id === release.fundId))
                error();
        if (alt.cashSourceFlowId && !target.flows.some(f => f.direction === 'IN' && (f.id === alt.cashSourceFlowId || f.sourceKey === alt.cashSourceFlowId)))
            error();
        if (alt.terms?.kind === 'NATIVE_VERSION') {
            const source = alt.terms;
            if (!target.terms.some(t => t.id === source.sourceId && t.version === source.sourceVersion))
                error();
        }
        if (alt.kind === 'DEBT_PREPAYMENT' && !target.terms.some(t => t.kind === 'LIABILITY' && t.id === alt.liabilityId))
            error();
    }
}
const initial = (b) => ({ book: b, cash: cents(b.cashBook), available: cents(b.available), reserved: cents(b.reserved), held: cents(b.held), principal: b.principalOutstanding === null ? null : cents(b.principalOutstanding), recognized: b.recognizedInterest === null ? null : cents(b.recognizedInterest), debt: cents(b.ownDebt), nw: cents(b.netWorthBook), estimated: b.estimatedOwnValue === null ? null : cents(b.estimatedOwnValue), indicative: b.netWorthIndicative === null ? null : cents(b.netWorthIndicative), cost: b.assetCost === null ? null : cents(b.assetCost), unknown: new Set(b.coverage === 'COMPLETE' ? [] : b.reasons), minimum: cents(b.available), cashMinimum: cents(b.cashBook), first: null, interest: 0n, flowBalances: new Map() });
function buildFlows(base, a, budget) {
    const result = [], missing = new Map(), seen = new Set();
    for (const b of base.books)
        for (const f of b.flows) {
            budget();
            if (seen.has(f.id))
                error('DOUBLE_ALLOCATION');
            seen.add(f.id);
            const reasons = missing.get(b.bookId) ?? new Set();
            missing.set(b.bookId, reasons);
            if (f.amount === null) {
                reasons.add('MISSING_AMOUNT');
                continue;
            }
            const original = amount(f.amount);
            if (original === 0n)
                continue;
            if (a.interestProjection === 'SUPPORTED_SOURCE_TERMS' && f.classification === 'INTEREST_UNRECOGNIZED' && !b.terms.some(t => t.id === f.entityId && t.kind === 'LOAN' && t.supported))
                reasons.add('MISSING_TERMS');
            const override = a.dateOverrides.find(v => v.sourceKey === f.sourceKey);
            if (f.date <= base.asOf && !override) {
                reasons.add('MISSING_DATE');
                continue;
            }
            const date = override?.collectionDate ?? (f.direction === 'IN' ? day(f.date, a.delayDays) : f.date);
            if (!validDate(date) || date <= base.asOf) {
                reasons.add('MISSING_DATE');
                continue;
            }
            if (f.direction === 'OUT') {
                result.push({ ...f, date });
                continue;
            }
            const collected = portion(original, a.collectionFraction), remaining = original - collected, recovered = portion(remaining, a.recoveryFraction), recoveryDate = override?.recoveryDate ?? day(date, a.recoveryDelayDays);
            if (collected > 0n)
                result.push({ ...f, id: id(f.id + ':collection:' + a.kind), sourceKey: f.sourceKey, date, amount: money(collected) });
            if (recovered > 0n)
                result.push({ ...f, id: id(f.id + ':recovery:' + a.kind), sourceKey: f.sourceKey, date: recoveryDate, amount: money(recovered) });
        }
    return { flows: result, missing };
}
function hypothetical(bookId, key, date, direction, classification, value, extra = {}) { return { id: id(key), sourceKey: key, bookId, date, direction, classification, amount: money(value), sourceRefs: [], entityId: key, installment: null, ...extra }; }
function addAlternative(book, alt, flows, a) {
    const additions = [];
    let notSimulable = false;
    const reason = [];
    if (!alt.configured)
        return { notSimulable: true, reasons: ['NOT_CONFIGURED'], additions };
    if (alt.kind === 'NEW_LOAN') {
        const terms = alt.terms ? resolveTerms(alt.terms, book, 'LOAN') : null;
        if (!terms || terms.effectiveDate !== undefined && terms.effectiveDate !== alt.date || cents(terms.principalOpening) !== cents(alt.principal) || terms.installments.some(r => r.dueDate <= alt.date))
            notSimulable = true;
        else {
            additions.push(hypothetical(book.bookId, 'new-loan-out', alt.date, 'OUT', 'PRINCIPAL', cents(alt.principal), { loanDisbursement: true, sourceKey: alt.cashSourceFlowId ?? 'new-loan-out' }));
            for (const q of terms.installments)
                for (const [key, kind] of [['principal', 'PRINCIPAL'], ['interest', 'INTEREST_UNRECOGNIZED'], ['insurance', 'INSURANCE'], ['fees', 'FEES']]) {
                    const n = cents(q[key]), c = portion(n, a.collectionFraction), r = portion(n - c, a.recoveryFraction), date = day(q.dueDate, a.delayDays);
                    if (c)
                        additions.push(hypothetical(book.bookId, 'new-loan:' + q.number + ':' + key, date, 'IN', kind, c));
                    if (r)
                        additions.push(hypothetical(book.bookId, 'new-loan-recovery:' + q.number + ':' + key, day(date, a.recoveryDelayDays), 'IN', kind, r));
                }
        }
    }
    else if (alt.kind === 'DEBT_PREPAYMENT') {
        const original = book.terms.find(t => t.id === alt.liabilityId && t.kind === 'LIABILITY'), replacement = alt.terms ? resolveTerms(alt.terms, book, 'LIABILITY') : null, prepay = amount(alt.budget);
        if (!original || !replacement || !(original.permissionsByDate?.filter(p => p.validFrom <= alt.date).at(-1)?.permissions ?? original.prepaymentPermissions).includes(alt.prepaymentMode) || replacement.entityId !== undefined && replacement.entityId !== alt.liabilityId || replacement.validFrom !== undefined && replacement.validFrom > alt.date || prepay > cents(original.principalOpening) || cents(replacement.principalOpening) !== cents(original.principalOpening) - prepay)
            notSimulable = true;
        else {
            const oldRows = original.installments.filter(q => q.dueDate >= alt.date), nextRows = replacement.installments;
            if (nextRows.some(q => q.dueDate < alt.date) || alt.prepaymentMode === 'REDUCE_INSTALLMENT' && (oldRows.length !== nextRows.length || oldRows.at(-1)?.dueDate !== nextRows.at(-1)?.dueDate) || alt.prepaymentMode === 'REDUCE_TERM' && (nextRows.length > oldRows.length || nextRows.at(-1).dueDate > oldRows.at(-1).dueDate))
                notSimulable = true;
            else {
                for (let i = flows.length - 1; i >= 0; i--)
                    if (flows[i].bookId === book.bookId && flows[i].entityId === alt.liabilityId && flows[i].date >= alt.date)
                        flows.splice(i, 1);
                additions.push(hypothetical(book.bookId, 'debt-prepay', alt.date, 'OUT', 'DEBT_PRINCIPAL', prepay));
                for (const q of nextRows)
                    for (const [key, kind] of [['principal', 'DEBT_PRINCIPAL'], ['interest', 'EXPENSE'], ['insurance', 'INSURANCE'], ['fees', 'FEES']])
                        if (cents(q[key]))
                            additions.push(hypothetical(book.bookId, 'debt-new:' + q.number + ':' + key, q.dueDate, 'OUT', kind, cents(q[key])));
            }
        }
    }
    else if (alt.kind === 'ASSET_PURCHASE') {
        additions.push(hypothetical(book.bookId, 'asset-own-cash', alt.date, 'OUT', 'CAPITAL', amount(alt.ownCash), { assetCash: true }));
        if (!alt.directCreditor && amount(alt.ownDebt) > 0n) {
            additions.push(hypothetical(book.bookId, 'asset-credit-cash', alt.date, 'IN', 'CAPITAL', amount(alt.ownDebt), { debtCash: true, linkedTranche: id(book.bookId + ':' + alt.date + ':asset-financing') }));
            additions.push(hypothetical(book.bookId, 'asset-credit-use', alt.date, 'OUT', 'CAPITAL', amount(alt.ownDebt), { assetCash: true, linkedTranche: id(book.bookId + ':' + alt.date + ':asset-financing') }));
        }
        for (const f of alt.rentSchedule ?? [])
            additions.push(hypothetical(book.bookId, 'rent:' + f.id, f.date, 'IN', 'RENT', portion(cents(f.amount), moneyFractionComplement(alt.vacancyFraction))));
        for (const f of alt.costSchedule ?? [])
            additions.push(hypothetical(book.bookId, 'cost:' + f.id, f.date, 'OUT', 'EXPENSE', cents(f.amount)));
    }
    if (notSimulable) {
        const source = alt.terms?.kind === 'NATIVE_VERSION' ? book.terms.find(t => t.id === alt.terms.sourceId && t.version === alt.terms.sourceVersion) : null;
        reason.push(source?.reason ?? 'MISSING_TERMS');
    }
    return { notSimulable, reasons: reason, additions };
}
const moneyFractionComplement = (value) => { const n = 1000000n - fraction(value); return (n / 1000000n) + '.' + (n % 1000000n).toString().padStart(6, '0'); };
function applyFlow(s, f, date) {
    const n = cents(f.amount);
    if (n === 0n)
        return;
    if (f.direction === 'OUT') {
        if (f.loanDisbursement) {
            if (s.principal !== null)
                s.principal += n;
        }
        else if (f.classification === 'DEBT_PRINCIPAL' || f.recognized) {
            s.debt -= n;
        }
        else if (!f.assetCash) {
            s.nw -= n;
            if (s.indicative !== null)
                s.indicative -= n;
        }
        s.cash -= n;
        s.available -= n;
    }
    else {
        s.cash += n;
        s.available += n;
        if (f.classification === 'PRINCIPAL') {
            if (s.principal !== null)
                s.principal -= n;
        }
        else if (f.classification === 'INTEREST_RECOGNIZED') {
            if (s.recognized !== null)
                s.recognized -= n;
            s.interest += n;
        }
        else if (f.capitalClass === 'EXTERNAL_BORROWING') {
            s.debt += n;
        }
        else if (f.capitalClass === 'PRINCIPAL_RECOVERY') {
            if (s.principal !== null)
                s.principal -= n;
        }
        else if (!f.debtCash) {
            s.nw += n;
            if (s.indicative !== null)
                s.indicative += n;
            if (f.classification === 'INTEREST_UNRECOGNIZED')
                s.interest += n;
        }
        s.flowBalances.set(f.id, { date, amount: n });
        s.flowBalances.set(f.sourceKey, { date, amount: (s.flowBalances.get(f.sourceKey)?.amount ?? 0n) + n });
    }
    if (s.principal !== null && s.principal < 0n || s.recognized !== null && s.recognized < 0n || s.debt < 0n)
        throw new AppError(503, 'INTEGRITY_MISMATCH');
    s.minimum = s.available < s.minimum ? s.available : s.minimum;
    s.cashMinimum = s.cash < s.cashMinimum ? s.cash : s.cashMinimum;
    if (s.available < 0n && s.first === null)
        s.first = date;
    for (const v of [s.cash, s.available, s.debt, s.nw])
        checkMoney(v);
}
function unavailableMetrics(reasons) { return Object.fromEntries(['cashFinal', 'cashMinimum', 'availableFinal', 'availableMinimum', 'peakDeficit', 'principalOutstanding', 'expectedInterest', 'recognizedInterest', 'cost', 'reserved', 'ownDebt', 'estimatedOwnValue', 'netWorthBook', 'netWorthIndicative'].map(k => [k, metric(null, reasons)])); }
export function evaluate(base, definition, options) {
    const started = performance.now(), budget = options.budget ?? (() => { });
    validateVersion(definition, base.asOf);
    if (!base.books.length || base.books.length > 2 || !base.books.some(b => b.bookId === base.targetBookId))
        error();
    const outcomes = [], days = [], bookDays = [], reserveShortfalls = [], allFlows = [];
    let expanded = 0;
    const runs = [];
    if (options.sensitivity) {
        const sample = options.sensitivity, values = sample['values'];
        if (!Array.isArray(values) || !values.length || values.length > 9)
            error();
        for (const [v, index] of values.map((v, i) => [v, i])) {
            const a = structuredClone(definition.assumptions.find(a => a.kind === sample['scenarioKind'])), alt = structuredClone(definition.alternatives.find(a => a.kind === sample['alternativeKind']));
            if (!a || !alt)
                error();
            if (sample['parameter'] === 'COLLECTION_FRACTION') {
                fraction(v);
                a.collectionFraction = String(v);
            }
            else if (sample['parameter'] === 'DELAY_DAYS') {
                if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 366)
                    error();
                a.delayDays = v;
            }
            else if (sample['parameter'] === 'VACANCY_FRACTION') {
                fraction(v);
                alt.vacancyFraction = String(v);
            }
            else if (sample['parameter'] === 'ESTIMATED_GROSS_VALUE') {
                amount(String(v));
                alt.estimatedGrossValue = String(v);
            }
            else
                error();
            runs.push({ a, alt, suffix: String(index) });
        }
    }
    else
        for (const a of definition.assumptions)
            for (const alt of definition.alternatives)
                runs.push({ a, alt, suffix: '' });
    for (const { a, alt, suffix } of runs) {
        budget();
        const outcomeId = id(options.seed + ':' + a.kind + ':' + alt.kind + ':' + suffix), built = buildFlows(base, a, budget), target = base.books.find(b => b.bookId === base.targetBookId), end = day(base.asOf, definition.horizonDays), outside = alt.configured && (alt.date !== undefined && alt.date > end || (alt.reserveReleases ?? []).some(r => r.date > end)), branch = outside ? { notSimulable: true, reasons: ['OUT_OF_HORIZON'], additions: [] } : addAlternative(target, alt, built.flows, a);
        if (branch.notSimulable) {
            outcomes.push({ id: outcomeId, scenarioKind: a.kind, alternativeKind: alt.kind, coverage: 'UNAVAILABLE', simulability: 'NOT_SIMULABLE', reasons: branch.reasons, firstDeficitDate: null, metrics: unavailableMetrics(branch.reasons) });
            continue;
        }
        const flows = [...built.flows, ...branch.additions];
        const used = new Set();
        for (const c of a.capitalEvents) {
            if (c.kind === 'REINVESTMENT') {
                if (alt.kind !== 'NEW_LOAN')
                    continue;
                if (c.cashSourceFlowId !== alt.cashSourceFlowId || c.date !== alt.date || cents(c.amount) !== cents(alt.principal))
                    error();
                continue;
            }
            if (c.kind === 'DECLARED_CAPITAL_IN' && c.economicClass === 'WITHDRAWAL' || c.kind === 'DECLARED_CAPITAL_OUT' && c.economicClass !== 'WITHDRAWAL')
                error();
            flows.push(hypothetical(target.bookId, 'capital:' + c.id, c.date, c.kind === 'DECLARED_CAPITAL_IN' ? 'IN' : 'OUT', 'CAPITAL', cents(c.amount), { capitalClass: c.economicClass }));
        }
        if (alt.cashSourceFlowId) {
            if (used.has(alt.cashSourceFlowId))
                error('DOUBLE_ALLOCATION');
            used.add(alt.cashSourceFlowId);
            const canonicalSource = target.flows.find(f => f.id === alt.cashSourceFlowId || f.sourceKey === alt.cashSourceFlowId)?.sourceKey ?? alt.cashSourceFlowId;
            const funding = flows.filter(f => f.direction === 'IN' && f.bookId === target.bookId && (f.id === alt.cashSourceFlowId || f.sourceKey === canonicalSource) && f.date < alt.date).reduce((n, f) => n + cents(f.amount), 0n);
            if (funding < cents(alt.principal)) {
                const reasons = ['INSUFFICIENT_SOURCE'];
                outcomes.push({ id: outcomeId, scenarioKind: a.kind, alternativeKind: alt.kind, coverage: 'UNAVAILABLE', simulability: 'NOT_SIMULABLE', reasons, firstDeficitDate: null, metrics: unavailableMetrics(reasons) });
                continue;
            }
        }
        expanded += flows.length;
        if (expanded > limits.expandedFlows)
            throw new AppError(413, 'SIMULATION_SCOPE_TOO_LARGE');
        allFlows.push(...flows);
        const states = base.books.map(initial);
        for (const s of states)
            for (const r of built.missing.get(s.book.bookId) ?? [])
                s.unknown.add(r);
        const byDate = new Map();
        for (const f of flows) {
            if (f.date <= base.asOf || f.date > end)
                continue;
            const list = byDate.get(f.date) ?? [];
            list.push(f);
            byDate.set(f.date, list);
        }
        let aggregateCashMin = states.reduce((n, s) => n + s.cash, 0n), aggregateAvailableMin = states.reduce((n, s) => n + s.available, 0n), peak = 0n, first = null;
        for (let date = day(base.asOf, 1); date <= end; date = day(date, 1)) {
            budget();
            const openingCash = states.reduce((n, s) => n + s.cash, 0n), openingAvailable = states.reduce((n, s) => n + s.available, 0n);
            let cashIn = 0n, cashOut = 0n, releaseTotal = 0n, minimum = openingAvailable;
            const today = (byDate.get(date) ?? []).sort((x, y) => x.direction === y.direction ? x.id.localeCompare(y.id) : x.direction === 'OUT' ? -1 : 1);
            for (const s of states) {
                const startAvailable = s.available;
                let localMinimum = startAvailable;
                if (s.book.bookId === target.bookId) {
                    for (const release of alt.reserveReleases ?? [])
                        if (release.date === date) {
                            const fund = target.funds.find(f => f.id === release.fundId), requested = cents(release.amount);
                            if (!fund)
                                error();
                            const available = cents(fund.reserved), n = requested < available ? requested : available;
                            if (requested > n) {
                                reserveShortfalls.push({ outcomeId, fundId: release.fundId, date, amount: money(requested - n) });
                                s.unknown.add('PARTIAL_COVERAGE');
                            }
                            s.reserved -= n;
                            s.available += n;
                            releaseTotal += n;
                        }
                    if (alt.kind === 'ASSET_PURCHASE' && alt.date === date) {
                        const cost = portion(cents(alt.grossCost), alt.ownershipFraction), debt = cents(alt.ownDebt);
                        if (s.cost !== null)
                            s.cost += cost;
                        s.debt += debt;
                        s.nw += cost - debt;
                        s.nw -= cents(alt.ownCash);
                        if (s.estimated !== null && alt.estimatedGrossValue !== null && alt.estimatedGrossValue !== undefined)
                            s.estimated += portion(cents(alt.estimatedGrossValue), alt.ownershipFraction);
                        else
                            s.estimated = null;
                        if (s.indicative !== null && alt.estimatedGrossValue !== null && alt.estimatedGrossValue !== undefined)
                            s.indicative += portion(cents(alt.estimatedGrossValue), alt.ownershipFraction) - debt - cents(alt.ownCash);
                        else
                            s.indicative = null;
                    }
                }
                const consumedTranches = new Set();
                for (const f of today.filter(f => f.bookId === s.book.bookId)) {
                    if (f.linkedTranche) {
                        if (consumedTranches.has(f.linkedTranche))
                            continue;
                        const pair = today.filter(v => v.linkedTranche === f.linkedTranche), incoming = pair.find(v => v.direction === 'IN'), outgoing = pair.find(v => v.direction === 'OUT');
                        if (alt.kind !== 'ASSET_PURCHASE' || alt.directCreditor || pair.length !== 2 || !incoming?.debtCash || !outgoing?.assetCash || incoming.entityId !== 'asset-credit-cash' || outgoing.entityId !== 'asset-credit-use' || incoming.bookId !== target.bookId || outgoing.bookId !== target.bookId || incoming.date !== alt.date || outgoing.date !== alt.date || cents(incoming.amount) !== cents(alt.ownDebt) || cents(outgoing.amount) !== cents(alt.ownDebt))
                            error();
                        // One indivisible matched tranche: no other flow can consume its temporary cash.
                        applyFlow(s, incoming, date);
                        applyFlow(s, outgoing, date);
                        cashIn += cents(incoming.amount);
                        cashOut += cents(outgoing.amount);
                        consumedTranches.add(f.linkedTranche);
                    }
                    else {
                        applyFlow(s, f, date);
                        if (f.direction === 'IN')
                            cashIn += cents(f.amount);
                        else
                            cashOut += cents(f.amount);
                    }
                    localMinimum = s.available < localMinimum ? s.available : localMinimum;
                }
                localMinimum = localMinimum < s.available ? localMinimum : s.available;
                s.minimum = localMinimum < s.minimum ? localMinimum : s.minimum;
                if (localMinimum < 0n) {
                    peak = -localMinimum > peak ? -localMinimum : peak;
                    if (first === null)
                        first = date;
                }
                bookDays.push({ outcomeId, bookId: s.book.bookId, date, minimum: s.unknown.size ? null : money(localMinimum), closing: s.unknown.size ? null : money(s.available) });
            }
            // Aggregation is analytical only. A negative legal book remains a deficit even
            // if cash in the other book would make a combined number positive.
            const closingCash = states.reduce((n, s) => n + s.cash, 0n), closingAvailable = states.reduce((n, s) => n + s.available, 0n), linkedOut = today.filter(f => f.direction === 'OUT' && f.linkedTranche).reduce((n, f) => n + cents(f.amount), 0n), outAmount = today.filter(f => f.direction === 'OUT' && !f.linkedTranche).reduce((n, f) => n + cents(f.amount), 0n);
            minimum = openingAvailable + releaseTotal - outAmount;
            if (openingAvailable < minimum)
                minimum = openingAvailable;
            if (minimum < aggregateAvailableMin)
                aggregateAvailableMin = minimum;
            if (closingAvailable < aggregateAvailableMin)
                aggregateAvailableMin = closingAvailable;
            if (openingCash - cashOut + linkedOut < aggregateCashMin)
                aggregateCashMin = openingCash - cashOut + linkedOut;
            if (closingCash < aggregateCashMin)
                aggregateCashMin = closingCash;
            const unknown = [...new Set(states.flatMap(s => [...s.unknown]))], m = (n) => unknown.length ? metric(null, unknown, n) : metric(n);
            days.push({ outcomeId, date, cashOpening: m(openingCash), cashClosing: m(closingCash), availableOpening: m(openingAvailable), availableClosing: m(closingAvailable), minimumIntraday: m(minimum < closingAvailable ? minimum : closingAvailable), cashIn: m(cashIn), cashOut: m(cashOut), reserved: m(states.reduce((n, s) => n + s.reserved, 0n)), held: m(states.reduce((n, s) => n + s.held, 0n)) });
        }
        const unknown = [...new Set(states.flatMap(s => [...s.unknown]))], sum = (field) => states.reduce((n, s) => n + s[field], 0n), m = (n) => unknown.length ? metric(null, unknown, n) : metric(n), nullable = (field) => states.some(s => s[field] === null) ? metric(null, [field === 'estimated' || field === 'indicative' ? 'MISSING_ESTIMATE' : 'PARTIAL_COVERAGE']) : m(states.reduce((n, s) => n + s[field], 0n));
        outcomes.push({ id: outcomeId, scenarioKind: a.kind, alternativeKind: alt.kind, coverage: unknown.length ? 'INCOMPLETE' : 'COMPLETE', simulability: unknown.length ? 'PARTIALLY_SIMULABLE' : 'SIMULABLE', reasons: unknown, firstDeficitDate: first, metrics: { cashFinal: m(sum('cash')), cashMinimum: m(aggregateCashMin), availableFinal: m(sum('available')), availableMinimum: m(aggregateAvailableMin), peakDeficit: m(peak), principalOutstanding: nullable('principal'), expectedInterest: m(sum('interest')), recognizedInterest: nullable('recognized'), cost: nullable('cost'), reserved: m(sum('reserved')), ownDebt: m(sum('debt')), estimatedOwnValue: nullable('estimated'), netWorthBook: m(sum('nw')), netWorthIndicative: nullable('indicative') } });
    }
    return { outcomes, days, bookDays, reserveShortfalls, flows: allFlows, metrics: { expandedFlows: expanded, durationMs: performance.now() - started } };
}
//# sourceMappingURL=engine.js.map