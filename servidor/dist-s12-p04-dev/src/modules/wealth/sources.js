import { randomUUID } from 'node:crypto';
import { loadReportingFinance } from '../finance/scoped-integrity.js';
import { cents, storedCents } from '../finance/money.js';
import { privateAccounts, privateJournals, table } from '../obligations/models.js';
import { liabilityCommand, liabilityPosition } from '../obligations/liabilities.js';
import { wealthTable, fields, body } from './models.js';
import { fail, positive, effective } from './funds.js';
export async function ledgerSources(w, scope, s) {
    return scope.kind === 'BUSINESS' ? await loadReportingFinance(w.identity.database, scope.bookId, null, s, () => { }) : { accounts: await w.management.store.all(privateAccounts, scope, s), journals: await w.management.store.all(privateJournals, scope, s) };
}
export async function claim(c, input) {
    const source = await ledgerSources(c.system, c.scope, c.s), journal = source.journals.find(j => j._id === input['journalId']);
    if (!journal || journal.reversalOfId || source.journals.some(j => j.reversalOfId === journal._id) || journal.effectiveDate > effective(c))
        fail(409, 'SOURCE_INCONSISTENT');
    const index = Number(input['lineIndex']), line = journal.lines.at(index);
    if (!line || line.accountId !== c.details['assetAccountId'])
        fail(422, 'COMPONENT_MISMATCH');
    const capacity = storedCents(line.debit) - storedCents(line.credit), all = await c.system.management.store.all(wealthTable(c.scope.kind, 'source_claims'), c.scope, c.s), used = all.filter(r => r.journalId === journal._id && r.lineIndex === index && r.status === 'CLAIMED').reduce((n, r) => n + cents(r.amount), 0n);
    if (used + positive(input['amount']) > capacity)
        fail(409, 'SOURCE_CAPACITY_EXCEEDED');
    const kind = String(input['sourceKind']), id = String(input['sourceId']);
    if (kind === 'EXISTING_S09') {
        const stub = await c.system.management.store.get(table(c.scope.kind, 'asset_stubs'), id, c.scope, c.s);
        const sourceEvent = await c.system.management.store.get(table(c.scope.kind, 'events'), String(stub['sourceEventId']), c.scope, c.s);
        if (stub['accountId'] !== line.accountId || !sourceEvent.journalIds.includes(journal._id) || sourceEvent.entityId !== stub['liabilityId'])
            fail(409, 'SOURCE_INCONSISTENT');
    }
    else if (kind === 'OPENING_S03') {
        if (c.scope.kind !== 'BUSINESS' || !('source' in journal) || journal.source.type !== 'OPENING' || !('opening' in source))
            fail(409, 'SOURCE_INCONSISTENT');
        const opening = source.opening.find(r => r._id === journal.source.id), component = opening?.snapshot.components.find(x => x.id === input['componentId']), map = opening?.commit?.ledgerLineMap.find(x => x.lineIndex === index);
        if (!opening || opening.status !== 'POSTED' || opening.commit?.journalId !== journal._id || !component || !['BASIC_ASSET', 'BASIC_INVESTMENT'].includes(component.category) || component.accountId !== line.accountId || !map?.componentIds.includes(component.id) || ![opening._id, component.id, component.referenceId].includes(id))
            fail(409, 'SOURCE_INCONSISTENT');
        const usedComponent = all.filter(r => r.journalId === journal._id && r['componentId'] === component.id && r.status === 'CLAIMED').reduce((n, r) => n + cents(r.amount), 0n);
        if (usedComponent + positive(input['amount']) > cents(component.amount))
            fail(409, 'SOURCE_CAPACITY_EXCEEDED');
    }
    else if (kind !== 'SELF' && id !== journal._id)
        fail(409, 'SOURCE_INCONSISTENT');
    await c.system.management.store.put(wealthTable(c.scope.kind, 'source_claims'), { _id: randomUUID(), ...fields(c), version: 1, assetId: c.entityId, sourceKind: kind, sourceId: id, componentId: input['componentId'] ?? null, journalId: journal._id, lineIndex: index, amount: String(input['amount']), status: 'CLAIMED', sourceEventId: c.unitId }, c.s);
}
export async function sourceRow(c, p, kind) { return await c.system.management.store.put(wealthTable(c.scope.kind, 'asset_funding'), { _id: randomUUID(), ...fields(c), version: 1, assetId: c.eventKind === 'EXTERNAL_FUNDS' ? null : c.entityId, amount: p['amount'], provenanceKind: p['provenanceKind'] ?? 'SUPPORTED_REFERENCE', reference: p['reference'] ?? p['supportReference'], sourceKind: kind, sourceEventId: c.unitId, details: p }, c.s); }
export async function createDebt(c, definition, account, amount) {
    if (definition['principal'] !== amount)
        fail(422, 'COMPONENT_MISMATCH');
    await c.system.management.ledger.account(c.scope, account, c.s, { accountClass: 'LIABILITY', kind: ['GENERAL'] });
    const debt = await liabilityCommand({ ...c.base, payload: definition }, 'createLiability');
    if (debt.schedule.kind !== 'OFFICIAL_DECLARED')
        fail(422, 'INPUT_INVALID');
    return { debt, account };
}
export async function activateDebt(c, debt, account, journalId, recognitionKind) {
    const source = await ledgerSources(c.system, c.scope, c.s), journal = source.journals.find(j => j._id === journalId);
    if (!journal)
        fail(503, 'SOURCE_INCONSISTENT');
    const event = await c.base.post(debt._id, 'LIABILITY_ACTIVATE', effective(c), debt.principal, [], [], { principalAdded: debt.principal, recognitionKind, existingLink: true, wealthInternal: true, wealthRootId: c.unitId }, null, { id: journalId, recordedAt: journal.recordedAt });
    await c.system.management.store.put(table(c.scope.kind, 'liabilities'), { ...body(debt), version: debt.version + 1, status: 'ACTIVE', principalAccountId: account, recognitionKind, activationEventId: event._id }, c.s, false);
}
export async function existingDebt(c, p) {
    const debt = await c.system.management.store.get(table(c.scope.kind, 'liabilities'), String(p['liabilityId']), c.scope, c.s), events = await c.system.management.store.all(table(c.scope.kind, 'events'), c.scope, c.s), activation = events.find(e => e._id === debt.activationEventId);
    const source = await ledgerSources(c.system, c.scope, c.s), j = source.journals.find(x => x._id === p['sourceJournalId']);
    if (!activation || activation.effectiveDate > effective(c) || activation.components['recognitionKind'] !== 'CASH_RECEIPT' || !activation.journalIds.includes(String(p['sourceJournalId'])) || !j || j.reversalOfId || source.journals.some(x => x.reversalOfId === j._id) || !j.lines.some(l => l.accountId === p['accountId'] && storedCents(l.debit) >= positive(p['amount'])) || liabilityPosition(events.filter(e => e.entityId === debt._id)).principal < positive(p['amount']))
        fail(409, 'SOURCE_INCONSISTENT');
    const assets = await c.system.management.store.all(wealthTable(c.scope.kind, 'assets'), c.scope, c.s);
    if (assets.some(a => a._id !== c.entityId && a.status === 'ACTIVE' && a.liabilityIds.includes(debt._id)))
        fail(409, 'SOURCE_CONFLICT');
    return debt;
}
export async function principal(c, ids, date, known) {
    const events = await c.system.management.store.all(table(c.scope.kind, 'events'), c.scope, c.s);
    let total = 0n;
    for (const id of ids) {
        await c.system.management.store.get(table(c.scope.kind, 'liabilities'), id, c.scope, c.s);
        total += liabilityPosition(events.filter(e => e.entityId === id && e.effectiveDate <= date && e.unitKnownAt <= known)).principal;
    }
    return total;
}
export async function externalCommand(c) {
    const p = c.payload, mode = String(p['nature']);
    c.eventKind = 'EXTERNAL_FUNDS';
    c.entityId = c.unitId;
    c.amount = String(p['amount']);
    effective(c);
    if (mode === 'PENDING_CLASSIFICATION') {
        await sourceRow(c, p, 'PENDING');
        return;
    }
    if (mode === 'EXISTING_JOURNAL_LINK') {
        const source = await ledgerSources(c.system, c.scope, c.s), j = source.journals.find(j => j._id === p['journalId']), cashIds = new Set(source.accounts.filter(a => ['CASH', 'BANK'].includes(a.kind)).map(a => a._id));
        if (!j || j.reversalOfId || j.effectiveDate > effective(c) || source.journals.some(x => x.reversalOfId === j._id) || j.lines.filter(l => cashIds.has(l.accountId)).reduce((n, l) => n + storedCents(l.debit) - storedCents(l.credit), 0n) < positive(p['amount']))
            fail(409, 'SOURCE_INCONSISTENT');
        await sourceRow(c, p, 'EXTERNAL');
        return;
    }
    const cash = String(p['cashAccountId']);
    await c.system.management.ledger.account(c.scope, cash, c.s, { accountClass: 'ASSET', kind: ['CASH', 'BANK'] });
    let account, debt;
    if (p['nature'] === 'RECEIVED_LOAN') {
        debt = await createDebt(c, p['liabilityDefinition'], String(p['principalAccountId']), c.amount);
        account = debt.account;
    }
    else {
        account = String(p['equityAccountId'] ?? p['incomeAccountId']);
        await c.system.management.ledger.account(c.scope, account, c.s, { accountClass: p['nature'] === 'OWNER_CAPITAL_CONTRIBUTION' ? 'EQUITY' : 'INCOME', kind: ['GENERAL'] });
    }
    const id = await c.post('EXTERNAL_FUNDS', c.amount, [{ accountId: cash, debit: c.amount, credit: '0.00' }, { accountId: account, debit: '0.00', credit: c.amount }]);
    if (debt)
        await activateDebt(c, debt.debt, debt.account, id, 'CASH_RECEIPT');
    await sourceRow(c, p, 'EXTERNAL');
}
//# sourceMappingURL=sources.js.map