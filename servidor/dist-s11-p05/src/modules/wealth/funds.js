import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { cents, money } from '../finance/money.js';
import { today, validDate } from '../obligations/calendar.js';
import { signedCents, wealthTable, fields, body } from './models.js';
export function fail(status, code) { throw new AppError(status, code); }
export function effective(c, date = String(c.payload['effectiveDate'])) { if (!validDate(date) || date > today(c.system.identity.now()))
    fail(422, 'INPUT_INVALID'); return date; }
export const positive = (v) => { const n = cents(String(v)); if (n <= 0n)
    fail(422, 'INPUT_INVALID'); return n; };
export async function persistEvent(c) {
    const name = wealthTable(c.scope.kind, c.eventKind.startsWith('FUND_') ? 'fund_events' : 'asset_events');
    await c.system.management.store.put(name, { _id: c.unitId, ...fields(c), version: 1, entityId: c.entityId, kind: c.eventKind, effectiveDate: String(c.payload['effectiveDate'] ?? c.payload['valuationDate'] ?? today(c.system.identity.now())), unitKnownAt: new Date(c.system.identity.now()).toISOString(), amount: c.amount, reversalOfId: c.reversalOfId, journalIds: [...new Set(c.base.journalIds)], ledgerEventIds: c.base.eventIds, deltas: c.deltas, details: c.details }, c.s, false);
}
export async function consume(c, id, account, amount) {
    const fund = await c.system.management.store.get(wealthTable(c.scope.kind, 'funds'), id, c.scope, c.s);
    if (fund.status !== 'ACTIVE' || fund.backingAccountId !== account)
        fail(409, 'RESERVATION_CONFLICT');
    const available = await c.system.reserved(c.scope, c.s, effective(c));
    if ((available.get(id) ?? 0n) < positive(amount))
        fail(409, 'INSUFFICIENT_AVAILABLE_FUNDS');
    await bumpFund(c, id);
    c.deltas.push({ fundId: id, accountId: account, delta: '-' + amount });
    await persistEvent(c);
    await stageFundEffects(c);
}
export async function stageFundEffects(c) {
    if (!c.deltas.length || c.eventKind !== 'ASSET_ACQUIRE' && !(c.eventKind === 'REVERSAL' && c.params['assetId']))
        return;
    const store = c.system.management.store, name = wealthTable(c.scope.kind, 'fund_events'), rows = await store.all(name, c.scope, c.s), totals = new Map();
    for (const d of c.deltas) {
        const previous = totals.get(d.fundId);
        if (previous && previous.accountId !== d.accountId)
            fail(503, 'SOURCE_INCONSISTENT');
        totals.set(d.fundId, { accountId: d.accountId, amount: (previous?.amount ?? 0n) + signedCents(d.delta) });
    }
    for (const [fundId, { accountId, amount }] of totals) {
        const original = c.reversalOfId ? rows.find(e => e.kind === 'FUND_CONSUME' && e.details['sourceEventId'] === c.reversalOfId && e.entityId === fundId) : undefined;
        if (c.reversalOfId && !original)
            fail(503, 'SOURCE_INCONSISTENT');
        const staged = rows.find(e => e.details['sourceEventId'] === c.unitId && e.entityId === fundId);
        await store.put(name, { _id: staged?._id ?? randomUUID(), ...fields(c), version: 1, entityId: fundId, kind: original ? 'REVERSAL' : 'FUND_CONSUME', effectiveDate: effective(c), unitKnownAt: new Date(c.system.identity.now()).toISOString(), amount: money(amount < 0n ? -amount : amount), reversalOfId: original?._id ?? null, journalIds: [...new Set(c.base.journalIds)], ledgerEventIds: c.base.eventIds, deltas: [{ fundId, accountId, delta: money(amount) }], details: { sourceEventId: c.unitId, assetId: c.entityId, compensatedByAsset: Boolean(original) } }, c.s, false);
    }
}
export async function bumpFund(c, id) { const store = c.system.management.store, name = wealthTable(c.scope.kind, 'funds'), row = await store.get(name, id, c.scope, c.s), already = store.tracking.active.get(c.s)?.mutations.some(m => m.namespace === name && String(m.key) === id); return await store.put(name, { ...body(row), version: row.version + 1 }, c.s, !already); }
export async function fundCommand(c, action) {
    const store = c.system.management.store, name = wealthTable(c.scope.kind, 'funds'), p = c.payload;
    if (action === 'CreateFund') {
        await c.system.management.ledger.account(c.scope, String(p['backingAccountId']), c.s, { accountClass: 'ASSET', kind: ['CASH', 'BANK'] });
        return await store.put(name, { _id: c.params['importRootId'] ?? randomUUID(), ...fields(c), version: 1, ...p, status: 'ACTIVE' }, c.s);
    }
    const row = await store.get(name, c.params['fundId'], c.scope, c.s);
    c.entityId = row._id;
    if (action === 'UpdateFund')
        return await store.put(name, { ...body(row), ...p, version: row.version + 1 }, c.s);
    if (row.status !== 'ACTIVE')
        fail(409, 'INVALID_STATE');
    const balances = await c.system.reserved(c.scope, c.s, action === 'CloseFund' ? today(c.system.identity.now()) : effective(c)), held = balances.get(row._id) ?? 0n;
    if (action === 'CloseFund') {
        if (held !== 0n)
            fail(409, 'FUND_NOT_EMPTY');
        const events = await c.system.events(c.scope, c.s), reversed = new Set(events.map(e => e.reversalOfId)), assets = await store.all(wealthTable(c.scope.kind, 'assets'), c.scope, c.s);
        if (events.some(e => !reversed.has(e._id) && e.deltas.some(d => d.fundId === row._id && signedCents(d.delta) < 0n) && assets.some(a => a._id === e.entityId && a.status === 'ACTIVE')))
            fail(409, 'REVERSAL_DEPENDENCY');
        return await store.put(name, { ...body(row), status: 'CLOSED', version: row.version + 1 }, c.s);
    }
    if (action === 'ReverseFundEvent') {
        const event = await store.get(wealthTable(c.scope.kind, 'fund_events'), c.params['fundEventId'], c.scope, c.s);
        if (event.kind === 'FUND_CONSUME')
            fail(409, 'DOMAIN_REVERSAL_FORBIDDEN');
        if (event.entityId !== row._id || event.reversalOfId || event.effectiveDate > effective(c))
            fail(409, 'REVERSAL_DEPENDENCY');
        const events = await c.system.events(c.scope, c.s);
        if (events.some(e => e.reversalOfId === event._id))
            fail(409, 'ALREADY_REVERSED');
        c.eventKind = 'REVERSAL';
        c.reversalOfId = event._id;
        c.amount = event.amount;
        c.deltas = event.deltas.map(d => ({ ...d, delta: money(-signedCents(d.delta)) }));
        c.details = { originalType: event.kind };
        // A fund reversal stays in its original namespace even though its public kind is REVERSAL.
        await store.put(wealthTable(c.scope.kind, 'fund_events'), { _id: c.unitId, ...fields(c), version: 1, entityId: row._id, kind: c.eventKind, effectiveDate: effective(c), unitKnownAt: new Date(c.system.identity.now()).toISOString(), amount: c.amount, reversalOfId: event._id, journalIds: [], ledgerEventIds: [], deltas: c.deltas, details: c.details }, c.s);
        for (const journal of event.journalIds) {
            const reversed = await c.system.management.ledger.inverse(c.scope, journal, randomUUID(), effective(c), String(p['supportReference']), c.s);
            if (!event.ledgerEventIds[0])
                fail(503, 'SOURCE_INCONSISTENT');
            await c.base.post(row._id, 'FUND_REVERSAL', effective(c), event.amount, [], [], { wealthRootId: c.unitId }, event.ledgerEventIds[0], reversed);
        }
    }
    else {
        const amount = positive(p['amount']);
        c.amount = money(amount);
        c.eventKind = action === 'AllocateFund' ? 'FUND_ALLOCATE' : action === 'ReleaseFund' ? 'FUND_RELEASE' : 'FUND_TRANSFER';
        if (action !== 'AllocateFund' && held < amount)
            fail(409, 'INSUFFICIENT_AVAILABLE_FUNDS');
        c.deltas = [{ fundId: row._id, accountId: row.backingAccountId, delta: action === 'AllocateFund' ? money(amount) : money(-amount) }];
        if (action === 'TransferFund') {
            const destination = String(p['destinationAccountId']);
            if (destination === row.backingAccountId)
                fail(422, 'INPUT_INVALID');
            await c.system.management.ledger.account(c.scope, destination, c.s, { accountClass: 'ASSET', kind: ['CASH', 'BANK'] });
            if (p['destinationFundId']) {
                const target = await store.get(name, String(p['destinationFundId']), c.scope, c.s);
                if (target.status !== 'ACTIVE' || target.backingAccountId !== destination)
                    fail(409, 'RESERVATION_CONFLICT');
                c.deltas.push({ fundId: target._id, accountId: destination, delta: money(amount) });
                await bumpFund(c, target._id);
            }
            await persistEvent(c);
            await c.post('FUND_TRANSFER', money(amount), [{ accountId: destination, debit: money(amount), credit: '0.00' }, { accountId: row.backingAccountId, debit: '0.00', credit: money(amount) }]);
        }
        else
            await persistEvent(c);
    }
    if (action === 'ReverseFundEvent')
        for (const id of new Set(c.deltas.map(d => d.fundId)))
            if (id !== row._id)
                await bumpFund(c, id);
    return await store.put(name, { ...body(row), version: row.version + 1 }, c.s);
}
//# sourceMappingURL=funds.js.map