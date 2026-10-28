export const cents = (v) => {
    if (v && typeof v === 'object' && 'toString' in v)
        v = String(v);
    const t = String(v ?? '0'), neg = t.startsWith('-'), [w = '0', f = ''] = t.replace('-', '').split('.');
    const n = BigInt(w) * 100n + BigInt((f + '00').slice(0, 2));
    return neg ? -n : n;
};
export const money = (v) => { const neg = v < 0n, a = neg ? -v : v; return (neg ? '-' : '') + (a / 100n).toString() + '.' + (a % 100n).toString().padStart(2, '0'); };
export const pct = (n, d) => d === 0n ? null : money((n * 10000n * 2n + d) / (2n * d));
const S = (xs) => xs.reduce((a, b) => a + b, 0n);
/** Bogotá civil date of a UTC instant (UTC−5, no DST in Colombia): own arithmetic, no Intl. */
export const bogota = (iso) => new Date(Date.parse(iso) - 5 * 3600000).toISOString().slice(0, 10);
export const days = (a, b) => (Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10)) - Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))) / 86400000;
const str = (x) => String(x);
const plan = (e) => e['plan'];
/** `current`: cut at today's date with full knowledge. For older cuts the dictionary makes reserves/custody UNAVAILABLE (no reconstructed reserve history). */
export function oracle(d, c, scope, current = true) {
    const inCut = (date, at) => str(date) <= c.asOf && str(at) <= c.recordedThrough;
    const inPeriod = (date) => str(date) >= c.from && str(date) <= c.to;
    const events = d.events.filter(e => inCut(e['effectiveDate'], e['recordedAt']));
    const comps = d.compensations.filter(x => inCut(x['effectiveDate'], x['createdAt']));
    const compensated = new Set(comps.map(x => str(x['originalEventId'])));
    const live = events.filter(e => !compensated.has(e._id));
    const pay = new Map(d.payments.filter(p => p['eventId']).map(p => [str(p['eventId']), p]));
    const prof = (d.profile?.['profile'] ?? {});
    // Authority (current): T whole org; C assigned loans via ACTIVE scope; own activity via registrar/custodian/party.
    const assigned = new Set(d.scopes.filter(s => s['registrarId'] === scope.actor && s['active'] === true).map(s => str(s['loanId'])));
    const loanVisible = (id) => scope.kind === 'T' || scope.kind === 'C' && assigned.has(id);
    const ownEvent = (e) => scope.kind === 'T' || (scope.kind === 'C' || scope.kind === 'O') && pay.get(e._id)?.['registrarId'] === scope.actor;
    // ---- stocks per loan
    const stocks = new Map();
    for (const loan of d.loans) {
        const id = loan._id;
        if (!loanVisible(id))
            continue;
        if (!events.some(e => e['kind'] === 'DISBURSE' && e['loanIds'].includes(id)))
            continue;
        const allocs = live.flatMap(e => plan(e).allocations).filter(a => a['loanId'] === id);
        const principal = cents(loan['terms']['principal']) - S(allocs.filter(a => a['component'] !== 'INTEREST').map(a => cents(a['amount'])));
        const validV = new Set(d.schedules.filter(v => v['loanId'] === id && str(v['createdAt']) <= c.recordedThrough && (v['eventId'] === null || events.some(e => e._id === v['eventId']) || comps.some(x => x._id === v['eventId']))).map(v => Number(v['version'])));
        const rows = d.installments.filter(r => r['loanId'] === id && validV.has(Number(r['scheduleVersion'])) && (r['supersededByVersion'] === null || !validV.has(Number(r['supersededByVersion']))));
        let due = 0n, overdue = 0n, interestOverdue = 0n, futureInterest = 0n, unaccrued = 0n, pendingI = 0n, oldest = null, cohortDue = 0n, cohortPaid = 0n;
        let next = null;
        const accrued = new Set(events.flatMap(e => plan(e).accruals).filter(a => a['loanId'] === id).map(a => `${a['scheduleVersion']}:${a['installmentNumber']}`));
        const inst = [];
        for (const r of [...rows].sort((a, b) => str(a['dueDate']) < str(b['dueDate']) ? -1 : 1)) {
            const mine = allocs.filter(a => a['scheduleVersion'] === r['scheduleVersion'] && a['installmentNumber'] === r['number']);
            const pP = S(mine.filter(a => a['component'] === 'DUE_PRINCIPAL').map(a => cents(a['amount']))), pI = S(mine.filter(a => a['component'] === 'INTEREST').map(a => cents(a['amount'])));
            const leftP = cents(r['principal']) - pP, leftI = cents(r['interest']) - pI, dueDate = str(r['dueDate']), unpaid = leftP + leftI > 0n;
            pendingI += leftI;
            if (dueDate <= c.asOf)
                due += leftP;
            if (dueDate < c.asOf) {
                overdue += leftP;
                interestOverdue += leftI;
            }
            if (unpaid && dueDate <= c.asOf && (!oldest || dueDate < oldest))
                oldest = dueDate;
            if (dueDate > c.asOf)
                futureInterest += leftI;
            if (dueDate <= c.asOf && !accrued.has(`${r['scheduleVersion']}:${r['number']}`))
                unaccrued += leftI;
            if (inPeriod(dueDate)) {
                cohortDue += cents(r['principal']) + cents(r['interest']);
                cohortPaid += pP + pI;
            }
            if (!next && unpaid && dueDate >= c.asOf)
                next = { dueDate, number: Number(r['number']), principalLeft: money(leftP), interestLeft: money(leftI) };
            inst.push({ id: r._id, dueDate, number: Number(r['number']), version: Number(r['scheduleVersion']), principalPaid: money(pP), interestPaid: money(pI), state: unpaid ? (pP + pI > 0n ? 'PARTIAL' : 'UNPAID') : 'PAID', dpd: unpaid ? Math.max(0, days(c.asOf, dueDate)) : 0 });
        }
        const dpd = oldest ? Math.max(0, days(c.asOf, oldest)) : 0;
        stocks.set(id, { loanId: id, borrowerId: str(loan['borrowerId']), principal, due, overdue, interestOverdue, futureInterest, unaccrued, dpd, exposed: dpd > 0 ? principal : 0n, par30: principal > 0n && dpd > 30, settled: principal === 0n && pendingI === 0n, cohortDue, cohortPaid, next, installments: inst });
    }
    const all = [...stocks.values()], P = S(all.map(s => s.principal));
    // ---- ledger at cut and bridge
    const ledger = new Map();
    for (const j of d.journals.filter(j => inCut(j['effectiveDate'], j['recordedAt'])))
        for (const l of j['lines'])
            ledger.set(str(l['accountId']), (ledger.get(str(l['accountId'])) ?? 0n) + cents(l['debit']) - cents(l['credit']));
    const bal = (a) => ledger.get(str(a)) ?? 0n;
    const openingPrincipal = new Set();
    for (const o of d.openings)
        if (o['status'] === 'POSTED')
            for (const x of o['snapshot']['components'])
                if (x['category'] === 'PRINCIPAL_RECEIVABLE')
                    openingPrincipal.add(str(x['accountId']));
    const ledgerPrincipal = S([...new Set([prof['principalAccountId'], ...openingPrincipal])].filter(Boolean).map(bal));
    const unclassified = scope.kind === 'T' ? ledgerPrincipal - P : 0n, incomplete = unclassified !== 0n;
    // ---- flows (own events only for non-T), compensation by its own effective date
    const comp = { receipt: 0n, interest: 0n, creditI: 0n, principal: 0n }, gross = { ...comp, disbursed: 0n, accrued: 0n };
    const receiptAmount = (e) => { const p = pay.get(e._id); if (p)
        return cents(p['intent']['amount']); const loanAcc = new Set(Object.values(prof)); return S(plan(e).postings.filter(l => !loanAcc.has(str(l['accountId']))).map(l => cents(l['debit']))); };
    const add = (e, t) => {
        const a = plan(e).allocations;
        if (e['kind'] === 'RECEIPT') {
            t.receipt += receiptAmount(e);
            t.interest += S(a.filter(x => x['component'] === 'INTEREST').map(x => cents(x['amount'])));
        }
        if (e['kind'] === 'APPLY_CREDIT')
            t.creditI += S(a.filter(x => x['component'] === 'INTEREST').map(x => cents(x['amount'])));
        if (e['kind'] === 'RECEIPT' || e['kind'] === 'APPLY_CREDIT')
            t.principal += S(a.filter(x => x['component'] !== 'INTEREST').map(x => cents(x['amount'])));
    };
    for (const e of events)
        if (ownEvent(e) && inPeriod(e['effectiveDate'])) {
            add(e, gross);
            gross.accrued += S(plan(e).accruals.map(x => cents(x['interest'])));
            if (e['kind'] === 'DISBURSE')
                for (const id of e['loanIds'])
                    gross.disbursed += cents(d.loans.find(l => l._id === id)['terms']['principal']);
        }
    for (const x of comps)
        if (inPeriod(x['effectiveDate'])) {
            const e = d.events.find(e => e._id === x['originalEventId']);
            if (e && ownEvent(e))
                add(e, comp);
        }
    const registeredBy = (p) => scope.kind === 'T' || (scope.kind === 'C' || scope.kind === 'O') && p['registrarId'] === scope.actor || scope.kind === 'P' && p['approvalMode'] === 'SUPERVISED' && p['status'] === 'PENDING';
    const registered = S(d.payments.filter(p => registeredBy(p) && str(p['recordedAt']) <= c.recordedThrough && inPeriod(bogota(str(p['recordedAt'])))).map(p => cents(p['intent']['amount'])));
    // ---- credit, cash, custody
    const credit = S(live.map(e => plan(e).creditChange).filter(Boolean).map(ch => cents(ch['added']) - cents(ch['applied'])));
    const party = (x) => scope.kind === 'T' || x['senderId'] === scope.actor || x['receiverId'] === scope.actor;
    const posted = d.deliveries.filter(x => x['state'] === 'CONFIRMED' && d.journals.some(j => j._id === x['journalId'] && inCut(j['effectiveDate'], j['recordedAt'])));
    const delivered = S(posted.filter(x => party(x) && inPeriod(x['effectiveDate']) && x['kind'] === 'FORWARD').map(x => cents(x['amount']))), undelivered = S(posted.filter(x => party(x) && inPeriod(x['effectiveDate']) && x['kind'] === 'COMPENSATION').map(x => cents(x['amount'])));
    const mineCustody = (x) => scope.kind === 'T' || x['responsibleId'] === scope.actor;
    const held = d.held.filter(h => inCut(h['effectiveDate'], h['createdAt']) && (scope.kind === 'T' || d.custody.some(x => x['paymentId'] === h['paymentId'] && x['responsibleId'] === scope.actor)));
    let provisional = 0n, retained = 0n;
    const reserve = new Map();
    const r = (a, n) => reserve.set(str(a), (reserve.get(str(a)) ?? 0n) + n);
    for (const h of held)
        r(h['accountId'], cents(h['amount']));
    for (const x of d.custody.filter(mineCustody)) {
        if (['PROVISIONAL', 'RETURN_REQUIRED'].includes(str(x['state'])))
            provisional += cents(x['amountHeld']);
        if (x['state'] !== 'CONFIRMED_HELD' || held.some(h => h['paymentId'] === x['paymentId']))
            continue;
        let n = cents(x['amountHeld']);
        for (const dl of posted)
            for (const p of dl['portions'])
                if (p['sourcePaymentId'] === x['paymentId'])
                    n += (dl['kind'] === 'FORWARD' ? -1n : 1n) * cents(p['amount']);
        retained += n;
        r(x['accountId'], n);
    }
    const active = d.deliveries.filter(x => !['CONFIRMED', 'CANCELLED'].includes(str(x['state'])));
    const committed = S(active.filter(x => x['kind'] === 'FORWARD' && party(x)).map(x => cents(x['amount'])));
    const compensationActive = S(active.filter(x => x['kind'] === 'COMPENSATION' && party(x)).map(x => cents(x['amount'])));
    for (const x of active.filter(x => x['kind'] === 'COMPENSATION'))
        r(x['sourceAccountId'], cents(x['amount']));
    const liquid = d.accounts.filter(a => ['CASH', 'BANK'].includes(str(a['kind'])) && str(a['createdAt']) <= c.recordedThrough), book = S(liquid.map(a => bal(a._id))), reserved = S([...reserve.values()]);
    const flow = (g, k) => money(g - k);
    const metrics = {
        PRINCIPAL_OUTSTANDING: incomplete ? null : money(P), PRINCIPAL_LEDGER: money(ledgerPrincipal),
        PRINCIPAL_DUE_TODAY_OR_EARLIER: incomplete ? null : money(S(all.map(s => s.due))), PRINCIPAL_OVERDUE: incomplete ? null : money(S(all.map(s => s.overdue))), INTEREST_OVERDUE: incomplete ? null : money(S(all.map(s => s.interestOverdue))),
        PRINCIPAL_EXPOSED_OVERDUE: incomplete ? null : money(S(all.map(s => s.exposed))), PAR30: incomplete ? null : pct(S(all.filter(s => s.par30).map(s => s.principal)), P),
        INTEREST_EXPECTED_FUTURE: incomplete ? null : money(S(all.map(s => s.futureInterest))), INTEREST_DUE_UNACCRUED: incomplete ? null : money(S(all.map(s => s.unaccrued))),
        INSTALLMENT_FULFILMENT: incomplete ? null : pct(S(all.map(s => s.cohortPaid)), S(all.map(s => s.cohortDue))),
        PRINCIPAL_DISBURSED: money(gross.disbursed), INTEREST_ACCRUED: money(gross.accrued), RECEIPTS_CONFIRMED: flow(gross.receipt, comp.receipt), INTEREST_RECEIVED: flow(gross.interest, comp.interest),
        INTEREST_SATISFIED_BY_CREDIT: flow(gross.creditI, comp.creditI), PRINCIPAL_RECOVERED: flow(gross.principal, comp.principal), RECEIPTS_REGISTERED: money(registered),
        BORROWER_CREDIT: money(credit), INTEREST_RECEIVABLE: money(S([prof['interestReceivableAccountId']].filter(Boolean).map(bal))), HELD_FUNDS: money(S(held.map(h => cents(h['amount'])))),
        CUSTODY_PROVISIONAL: money(provisional), CUSTODY_CONFIRMED: money(retained), CUSTODY_COMMITTED: money(committed), DELIVERED_NET: money(delivered - undelivered),
        LIQUIDITY_BOOK: money(book), LIQUIDITY_RESERVED: money(reserved), LIQUIDITY_AVAILABLE: money(book - reserved),
        RETURN_ON_AVERAGE_CAPITAL: null, OBLIGATIONS_COVERAGE: null, INTEGRAL_NET_WORTH: null,
    };
    if (!current)
        for (const k of ['CUSTODY_PROVISIONAL', 'CUSTODY_CONFIRMED', 'CUSTODY_COMMITTED', 'LIQUIDITY_RESERVED', 'LIQUIDITY_AVAILABLE'])
            metrics[k] = null;
    const status = { PAR30: incomplete ? 'INCOMPLETE' : P === 0n ? 'NO_DENOMINATOR' : 'COMPLETE', RETURN_ON_AVERAGE_CAPITAL: 'UNAVAILABLE', OBLIGATIONS_COVERAGE: 'UNAVAILABLE', INTEGRAL_NET_WORTH: 'UNAVAILABLE', ...(current ? {} : Object.fromEntries(['CUSTODY_PROVISIONAL', 'CUSTODY_CONFIRMED', 'CUSTODY_COMMITTED', 'LIQUIDITY_RESERVED', 'LIQUIDITY_AVAILABLE'].map(k => [k, 'UNAVAILABLE']))) };
    const parts = { RECEIPTS_CONFIRMED: { gross: money(gross.receipt), compensations: money(comp.receipt) }, PRINCIPAL_RECOVERED: { gross: money(gross.principal), compensations: money(comp.principal) }, INTEREST_RECEIVED: { gross: money(gross.interest), compensations: money(comp.interest) }, DELIVERED_NET: { gross: money(delivered), compensations: money(undelivered) }, PAR30: { numerator: money(S(all.filter(s => s.par30).map(s => s.principal))), denominator: money(P) }, CUSTODY_COMMITTED_WITH_COMPENSATION: { forward: money(committed), compensation: money(compensationActive) } };
    return { stocks, metrics, parts, status, coverage: { status: incomplete ? 'INCOMPLETE' : 'COMPLETE', unclassifiablePrincipal: scope.kind === 'T' ? money(unclassified) : '0.00' } };
}
//# sourceMappingURL=indicators.js.map