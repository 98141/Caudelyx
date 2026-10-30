import { hash } from '../lending/contract.js';
import { domainCollection } from '../lending/evidence-v2.js';
import { cents, money, storedCents } from '../finance/money.js';
import { activeDelivery, fail } from './engine.js';
export async function deliveries(database, org, s) {
    const rows = await domainCollection(database, 'cash_deliveries').find({ organizationId: org }, { session: s }).toArray(), allocations = await domainCollection(database, 'cash_delivery_allocations').find({ organizationId: org }, { session: s }).toArray();
    for (const d of rows) {
        const expected = d.portions.map(p => [p.sourcePaymentId, p.amount, d.kind]).sort(), actual = allocations.filter(a => a['deliveryId'] === d._id).map(a => [String(a['sourcePaymentId']), String(a['amount']), String(a['kind'])]).sort();
        if (hash(actual) !== hash(expected))
            fail('INTEGRITY_MISMATCH', 503);
    }
    if (allocations.some(a => !rows.some(d => d._id === a['deliveryId'])))
        fail('INTEGRITY_MISMATCH', 503);
    return rows;
}
export async function effectiveReserves(database, org, s, cut, known, includeWealth = true) {
    const all = await deliveries(database, org, s), held = await domainCollection(database, 'held_funds_reservations').find({ organizationId: org }, { session: s }).toArray(), custody = await domainCollection(database, 'cash_custody').find({ organizationId: org, state: 'CONFIRMED_HELD' }, { session: s }).toArray();
    const reserves = held.filter(h => !cut || String(h['effectiveDate']) <= cut).map(h => ({ paymentId: String(h['paymentId']), accountId: String(h['accountId']), amount: String(h['amount']), effectiveDate: String(h['effectiveDate']) }));
    for (const c of custody) {
        if (held.some(h => h['paymentId'] === c['paymentId']) || cut && String(c['effectiveDate']) > cut)
            continue;
        let retained = cents(String(c['amountHeld']));
        for (const d of all)
            if (d.state === 'CONFIRMED' && (!cut || d.effectiveDate <= cut)) {
                const part = d.portions.find(p => p.sourcePaymentId === c['paymentId']);
                if (part)
                    retained += (d.kind === 'FORWARD' ? -1n : 1n) * cents(part.amount);
            }
        if (retained < 0n || retained > cents(String(c['amountHeld'])))
            fail('INTEGRITY_MISMATCH', 503);
        if (retained)
            reserves.push({ paymentId: String(c['paymentId']), accountId: String(c['accountId']), amount: money(retained), effectiveDate: String(c['effectiveDate']) });
    }
    for (const d of all)
        if (d.kind === 'COMPENSATION' && activeDelivery(d) && (!cut || d.requestDate <= cut))
            reserves.push({ paymentId: d._id, accountId: d.sourceAccountId, amount: d.amount, effectiveDate: d.requestDate });
    if (includeWealth && database.wealthReserves)
        reserves.push(...await database.wealthReserves(org, s, cut, known));
    return reserves;
}
export async function accountBalance(database, org, accountId, s) {
    let total = 0n;
    for await (const j of database.db.collection('financial_journals').find({ organizationId: org }, { session: s }))
        for (const line of j.lines)
            if (line.accountId === accountId)
                total += storedCents(line.debit) - storedCents(line.credit);
    if (total < 0n)
        fail('INTEGRITY_MISMATCH', 503);
    return total;
}
export async function available(database, org, accountId, s) {
    const balance = await accountBalance(database, org, accountId, s), required = (await effectiveReserves(database, org, s)).filter(r => r.accountId === accountId).reduce((n, r) => n + cents(r.amount), 0n);
    if (balance < required)
        fail('INTEGRITY_MISMATCH', 503);
    return balance - required;
}
export async function cashLot(database, org, id, s) {
    const c = await domainCollection(database, 'cash_custody').findOne({ _id: id, organizationId: org }, { session: s });
    if (!c)
        fail('RESOURCE_NOT_FOUND', 404);
    const all = await deliveries(database, org, s);
    let delivered = 0n, committed = 0n;
    for (const d of all) {
        const portion = d.portions.find(p => p.sourcePaymentId === id);
        if (!portion)
            continue;
        if (d.state === 'CONFIRMED')
            delivered += (d.kind === 'FORWARD' ? 1n : -1n) * cents(portion.amount);
        else if (d.kind === 'FORWARD' && activeDelivery(d))
            committed += cents(portion.amount);
    }
    const original = cents(String(c['amountHeld'])), confirmed = c['state'] === 'CONFIRMED_HELD' ? original : 0n, retained = confirmed - delivered;
    if (delivered < 0n || retained < 0n || committed > retained)
        fail('INTEGRITY_MISMATCH', 503);
    return { row: c, original, retained, delivered, committed, uncommitted: retained - committed };
}
export async function assertReceiptReversible(database, org, paymentId, s) {
    const lot = await cashLot(database, org, paymentId, s);
    if (lot.delivered || lot.committed)
        fail('REVERSAL_DEPENDENCY');
}
//# sourceMappingURL=funds.js.map