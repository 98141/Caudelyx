// S07-P05 independent oracle (Claude). Extends the reviewer's own S6 oracle (no production import) with the APPROVED S7
// rules as written in CASH_CUSTODY_S07 (Rconf/Rheld/Rcomp, 300→250+50 chain) and DELIVERIES_AND_CASH_CLOSE_S07 D1–D4.
// Money is integer cents (BigInt). Physical location is tracked separately from the ledger and never creates income/expense.
import { S6Book, OracleError, c, m, terms } from '../s06-p05/oracle.js';
export { OracleError, c, m, terms };
const fail = (status, code) => { throw new OracleError(status, code); };
export class S7Book extends S6Book {
    lots = new Map();
    deliveries = new Map();
    rcomp = new Map();
    /** Physical cash per account (outside the ledger): what is actually where. */
    physical = new Map();
    phys(a) { let p = this.physical.get(a); if (!p) {
        p = { confirmedOnSite: 0n, inTransit: 0n, receivedUnposted: 0n, unlocatedDisputed: 0n, unidentifiedSurplus: 0n };
        this.physical.set(a, p);
    } return p; }
    /** Register a confirmed CASH lot (S6 approval already posted by the S6 oracle). */
    lot(payment, account, amount) { this.lots.set(payment, { payment, account, original: amount, delivered: 0n, committed: 0n }); this.phys(account).confirmedOnSite += amount; }
    /** Free money already on an account from other operations (ledger + physical). */
    freeMoney(account, amount) { this.phys(account).confirmedOnSite += amount; }
    retained(l) { return l.original - l.delivered; }
    /** Rconf for an account: confirmed lots still at origin (committed is a SUBSET, not added). */
    rconf(account) { let n = 0n; for (const l of this.lots.values())
        if (l.account === account)
            n += this.retained(l); return n; }
    available(account) { return (this.balances.get(account) ?? 0n) - this.rconf(account) - (this.held.get(account) ?? 0n) - (this.rcomp.get(account) ?? 0n); }
    spend(account, amount, to) { if (this.available(account) < amount)
        fail(409, 'ACCOUNT_OVERDRAFT'); this.balances.set(account, (this.balances.get(account) ?? 0n) - amount); this.balances.set(to, (this.balances.get(to) ?? 0n) + amount); this.phys(account).confirmedOnSite -= amount; this.phys(to).confirmedOnSite += amount; }
    request(id, source, destination, portions) {
        const amount = portions.reduce((n, p) => n + p.amount, 0n);
        for (const p of portions) {
            const l = this.lots.get(p.lot);
            if (l.account !== source)
                fail(404, 'RESOURCE_NOT_FOUND');
            if (this.retained(l) - l.committed < p.amount)
                fail(409, 'DELIVERY_FUNDS_COMMITTED');
        }
        for (const p of portions)
            this.lots.get(p.lot).committed += p.amount;
        this.deliveries.set(id, { id, kind: 'FORWARD', source, destination, amount, portions, state: 'REQUESTED', lastCount: null });
    }
    dispatch(id) { const d = this.deliveries.get(id); this.phys(d.source).confirmedOnSite -= d.amount; this.phys(d.source).inTransit += d.amount; d.state = 'IN_TRANSIT'; }
    /** Receipt declared: the amount is observed at destination (expected amount until a count says otherwise). */
    receive(id) { const d = this.deliveries.get(id); this.phys(d.source).inTransit -= d.amount; this.place(d, d.amount, 1n); d.lastCount = null; d.state = 'RECEIVED_FOR_REVIEW'; }
    /** observed = min(count, amount) at destination; shortage unlocated under sender; surplus unidentified at receiver. */
    place(d, counted, sign) { const src = this.phys(d.source), dst = this.phys(d.destination); dst.receivedUnposted += sign * (counted < d.amount ? counted : d.amount); if (counted < d.amount)
        src.unlocatedDisputed += sign * (d.amount - counted); if (counted > d.amount)
        dst.unidentifiedSurplus += sign * (counted - d.amount); }
    unCount(d) { this.place(d, d.lastCount ?? d.amount, -1n); }
    count(id, counted) { const d = this.deliveries.get(id); this.unCount(d); this.place(d, counted, 1n); d.lastCount = counted; d.state = counted === d.amount ? 'COUNTED' : 'DISCREPANCY'; }
    /** T confirmation of an exact count: Dr destination / Cr source; origin reserve drops by the delivered portions only. */
    confirmDelivery(id) {
        const d = this.deliveries.get(id);
        if (d.lastCount !== d.amount)
            fail(409, 'DELIVERY_COUNT_MISMATCH');
        this.balances.set(d.destination, (this.balances.get(d.destination) ?? 0n) + d.amount);
        this.balances.set(d.source, (this.balances.get(d.source) ?? 0n) - d.amount);
        const dst = this.phys(d.destination);
        dst.receivedUnposted -= d.amount;
        dst.confirmedOnSite += d.amount;
        this.phys(d.source).confirmedOnSite += 0n;
        if (d.kind === 'FORWARD')
            for (const p of d.portions) {
                const l = this.lots.get(p.lot);
                l.committed -= p.amount;
                l.delivered += p.amount;
            }
        else {
            for (const p of d.portions)
                this.lots.get(p.lot).delivered -= p.amount;
            this.rcomp.set(d.source, (this.rcomp.get(d.source) ?? 0n) - d.amount);
            this.deliveries.get(d.original).compensated = true;
        }
        d.state = 'CONFIRMED';
        return [{ account: d.destination, debit: d.amount, credit: 0n }, { account: d.source, debit: 0n, credit: d.amount }];
    }
    cancelRequested(id) { const d = this.deliveries.get(id); if (d.state !== 'REQUESTED')
        fail(409, 'STATE_CONFLICT'); for (const p of d.portions)
        if (d.kind === 'FORWARD')
            this.lots.get(p.lot).committed -= p.amount;
        else
            this.rcomp.set(d.source, (this.rcomp.get(d.source) ?? 0n) - d.amount); d.state = 'CANCELLED'; }
    /** Physical return completed with exact source count: money back on site, commitment released, ledger untouched. */
    returned(id) { const d = this.deliveries.get(id), src = this.phys(d.source); if (d.state === 'IN_TRANSIT')
        src.inTransit -= d.amount;
    else
        this.unCount(d); src.confirmedOnSite += d.amount; for (const p of d.portions)
        if (d.kind === 'FORWARD')
            this.lots.get(p.lot).committed -= p.amount; d.state = 'CANCELLED'; }
    /** Complete compensation of a confirmed FORWARD: reserve central free funds first (FUNDS_NOT_HELD otherwise). */
    compensate(id, originalId) {
        const o = this.deliveries.get(originalId);
        if (o.state !== 'CONFIRMED' || o.kind !== 'FORWARD' || o.compensated)
            fail(409, 'STATE_CONFLICT');
        if (this.available(o.destination) < o.amount)
            fail(409, 'FUNDS_NOT_HELD');
        this.rcomp.set(o.destination, (this.rcomp.get(o.destination) ?? 0n) + o.amount);
        this.deliveries.set(id, { id, kind: 'COMPENSATION', source: o.destination, destination: o.source, amount: o.amount, portions: o.portions, state: 'REQUESTED', lastCount: null, original: originalId });
    }
    /** Expected S07CashPosition money fields for (account, responsible) from the oracle. */
    position(account) {
        let retained = 0n, committed = 0n, delivered = 0n;
        for (const l of this.lots.values())
            if (l.account === account) {
                retained += this.retained(l);
                committed += l.committed;
                delivered += l.delivered;
            }
        const p = this.phys(account);
        return { ledgerBalance: m(this.balances.get(account) ?? 0n), retainedAtOrigin: m(retained), committed: m(committed), uncommitted: m(retained - committed), deliveredNet: m(delivered), held: m(this.held.get(account) ?? 0n), compensationReserve: m(this.rcomp.get(account) ?? 0n), available: m(this.available(account)),
            physical: { confirmedOnSite: m(p.confirmedOnSite), inTransit: m(p.inTransit), receivedUnposted: m(p.receivedUnposted), unlocatedDisputed: m(p.unlocatedDisputed), unidentifiedSurplus: m(p.unidentifiedSurplus) } };
    }
}
//# sourceMappingURL=oracle.js.map