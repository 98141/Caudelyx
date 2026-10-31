import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { cents, money } from '../finance/money.js';
import { resolveScope } from './authority.js';
import { today } from './calendar.js';
import { entityEvents, expensePosition, live } from './expenses.js';
import { declarations, relationships, table, etag } from './models.js';
const value = (v) => { const n = cents(String(v)); if (n <= 0n)
    throw new AppError(422, 'INPUT_INVALID'); return n; };
const body = (r) => { const { mac, recordedAt, ...b } = r; void mac; void recordedAt; return b; };
export async function eligibility(c, businessId, id) {
    const business = await c.store.all(declarations, { kind: 'BUSINESS', bookId: businessId, ownerId: businessId, organizationId: businessId }, c.s), now = today(c.identity.now());
    const eligible = business.filter(e => e['subjectId'] === c.scope.ownerId && String(e['validFrom']) <= now).sort((a, b) => a.version - b.version).at(-1);
    if (!eligible || eligible._id !== id || eligible['right'] !== 'FULL_OWNERSHIP' || eligible['percentage'] !== '100.00')
        throw new AppError(403, 'ACCESS_DENIED');
    return eligible;
}
async function alignUnit(c, b, personal, business) {
    const unitKnownAt = [personal.unitKnownAt, business.unitKnownAt].sort().at(-1);
    for (const [context, event] of [[c, personal], [b, business]]) {
        await context.store.put(table(context.scope.kind, 'events'), { ...body(event), unitKnownAt, recordedAt: unitKnownAt }, context.s, false);
        await context.store.touch(context.scope, context.s, false, Date.parse(unitKnownAt));
    }
    return unitKnownAt;
}
export async function relationshipCommand(c, action, context) {
    const p = c.payload;
    if (action === 'reverseInterbookRelationship') {
        const original = await c.store.get(relationships, c.params['relationshipId'], c.scope, c.s);
        if (original.status === 'REVERSED')
            throw new AppError(409, 'ALREADY_REVERSED');
        if (original.rootRelationshipId === null && original.remaining !== original.amount)
            throw new AppError(409, 'INVALID_STATE');
        const { scope: business, book } = await resolveScope(c.identity, context, 'BUSINESS', original.businessBookId, c.s), personalBook = await c.store.get('s09_books', c.scope.bookId, c.scope, c.s);
        if (!book || p['personalBookETag'] !== etag(personalBook) || p['businessBookETag'] !== etag(book))
            throw new AppError(412, 'PRECONDITION_FAILED');
        await eligibility(c, business.bookId, original.eligibilityVersionId);
        const date = String(p['effectiveDate']);
        if (date < original.effectiveDate)
            throw new AppError(422, 'INPUT_INVALID');
        const b = c.fork(business), personalId = randomUUID(), businessId = randomUUID(), pj = await c.ledger.inverse(c.scope, original.personalJournalId, personalId, date, String(p['supportReference']), c.s), bj = await c.ledger.inverse(business, original.businessJournalId, businessId, date, String(p['supportReference']), c.s);
        const pe = await c.post(original._id, 'INTERBOOK_REVERSE', date, original.amount, [], [], { relationshipId: original._id }, null, pj), be = await b.post(original.originalExpenseId ?? original._id, original.phase === 'ON_BEHALF' ? 'EXPENSE_PAYMENT_REVERSE' : 'INTERBOOK_REVERSE', date, original.amount, [], [], { relationshipId: original._id }, original.phase === 'ON_BEHALF' ? original.sourceEventIds[1] ?? null : null, bj);
        const reversalKnownAt = await alignUnit(c, b, pe, be);
        if (original.rootRelationshipId) {
            const root = await c.store.get(relationships, original.rootRelationshipId, c.scope, c.s), remaining = cents(root.remaining) + cents(original.amount);
            if (remaining > cents(root.amount))
                throw new AppError(409, 'INVALID_STATE');
            await c.store.put(relationships, { ...body(root), remaining: money(remaining), version: root.version + 1 }, c.s);
        }
        return await c.store.put(relationships, { ...body(original), status: 'REVERSED', version: original.version + 1, reversedEffectiveDate: date, reversedKnownAt: reversalKnownAt }, c.s);
    }
    const id = randomUUID(), kind = String(p['kind']), from = String(p['fromScope']), date = String(p['effectiveDate']), amount = value(p['amount']);
    const { scope: business, book } = await resolveScope(c.identity, context, 'BUSINESS', String(p['businessOrganizationId']), c.s), personal = await c.store.get('s09_books', c.scope.bookId, c.scope, c.s);
    if (!book || p['personalBookETag'] !== etag(personal) || p['businessBookETag'] !== etag(book))
        throw new AppError(412, 'PRECONDITION_FAILED');
    const declaration = await eligibility(c, business.bookId, String(p['eligibilityVersionId']));
    if (date < String(declaration['validFrom']))
        throw new AppError(422, 'SUPPORT_REQUIRED');
    const b = c.fork(business), personalCash = String(p['personalCashAccountId']), businessCash = String(p['businessCashAccountId']), pc = String(p['personalContraAccountId']), bc = String(p['businessContraAccountId']);
    await c.ledger.account(c.scope, personalCash, c.s, { accountClass: 'ASSET', kind: ['CASH', 'BANK'] });
    if (!(kind === 'REIMBURSEMENT' && from === 'PERSONAL'))
        await c.ledger.account(business, businessCash, c.s, { accountClass: 'ASSET', kind: ['CASH', 'BANK'] });
    const originalIds = p['originalEventIds'], prior = await c.store.all(relationships, c.scope, c.s);
    const root = originalIds?.length ? prior.find(r => r.status === 'POSTED' && r.rootRelationshipId === null && r.businessBookId === business.bookId && r.sourceEventIds.length === originalIds.length && r.sourceEventIds.every(id => originalIds.includes(id))) : undefined;
    if (root && date < root.effectiveDate)
        throw new AppError(422, 'SUPPORT_REQUIRED');
    if (originalIds?.length && !root)
        throw new AppError(422, 'SUPPORT_REQUIRED');
    let phase = 'ORIGIN', pe, be;
    if (kind === 'WITHDRAWAL' || root || kind === 'REIMBURSEMENT' && from === 'BUSINESS') {
        if (!root || root.kind !== (kind === 'WITHDRAWAL' ? 'CONTRIBUTION' : kind) || root.remaining === '0.00' || amount > cents(root.remaining) || root.fromScope === from || root.personalContraAccountId !== pc || root.businessContraAccountId !== bc)
            throw new AppError(422, 'SUPPORT_REQUIRED');
        if (kind === 'WITHDRAWAL' && from !== 'BUSINESS')
            throw new AppError(422, 'INPUT_INVALID');
        phase = 'SETTLEMENT';
        await c.ledger.account(c.scope, pc, c.s, { accountClass: root.fromScope === 'PERSONAL' ? 'ASSET' : 'LIABILITY', kind: ['GENERAL'] });
        await c.ledger.account(business, bc, c.s, { accountClass: kind === 'WITHDRAWAL' ? 'EQUITY' : root.fromScope === 'PERSONAL' ? 'LIABILITY' : 'ASSET', kind: ['GENERAL'] });
        pe = await c.post(id, 'INTERBOOK_SETTLEMENT', date, money(amount), from === 'BUSINESS' ? [{ accountId: personalCash, debit: money(amount), credit: '0.00' }, { accountId: pc, debit: '0.00', credit: money(amount) }] : [{ accountId: pc, debit: money(amount), credit: '0.00' }, { accountId: personalCash, debit: '0.00', credit: money(amount) }], [], { relationshipId: id });
        be = await b.post(id, 'INTERBOOK_SETTLEMENT', date, money(amount), from === 'BUSINESS' ? [{ accountId: bc, debit: money(amount), credit: '0.00' }, { accountId: businessCash, debit: '0.00', credit: money(amount) }] : [{ accountId: businessCash, debit: money(amount), credit: '0.00' }, { accountId: bc, debit: '0.00', credit: money(amount) }], [], { relationshipId: id });
        await c.store.put(relationships, { ...body(root), version: root.version + 1, remaining: money(cents(root.remaining) - amount) }, c.s);
    }
    else if (kind === 'REIMBURSEMENT') {
        if (from !== 'PERSONAL' || !p['originalExpenseId'])
            throw new AppError(422, 'SUPPORT_REQUIRED');
        phase = 'ON_BEHALF';
        const expense = await c.store.get(table('BUSINESS', 'expenses'), String(p['originalExpenseId']), business, c.s), events = await entityEvents(b, expense._id), position = expensePosition(events), recognition = live(events).find(e => e.kind === 'EXPENSE_RECOGNIZE');
        if (!recognition || date < recognition.effectiveDate || amount > position.outstanding)
            throw new AppError(422, 'COMPONENT_MISMATCH');
        await c.ledger.account(c.scope, pc, c.s, { accountClass: 'ASSET', kind: ['GENERAL'] });
        await c.ledger.account(business, bc, c.s, { accountClass: 'LIABILITY', kind: ['GENERAL'] });
        pe = await c.post(id, 'INTERBOOK_ON_BEHALF', date, money(amount), [{ accountId: pc, debit: money(amount), credit: '0.00' }, { accountId: personalCash, debit: '0.00', credit: money(amount) }], [], { relationshipId: id });
        be = await b.post(expense._id, 'EXPENSE_PAY', date, money(amount), [{ accountId: String(recognition.components['payableAccountId']), debit: money(amount), credit: '0.00' }, { accountId: bc, debit: '0.00', credit: money(amount) }], [], { relationshipId: id });
    }
    else {
        if (kind === 'CONTRIBUTION' && from !== 'PERSONAL')
            throw new AppError(422, 'INPUT_INVALID');
        await c.ledger.account(c.scope, pc, c.s, { accountClass: kind === 'CONTRIBUTION' || from === 'PERSONAL' ? 'ASSET' : 'LIABILITY', kind: ['GENERAL'] });
        await c.ledger.account(business, bc, c.s, { accountClass: kind === 'CONTRIBUTION' ? 'EQUITY' : from === 'PERSONAL' ? 'LIABILITY' : 'ASSET', kind: ['GENERAL'] });
        pe = await c.post(id, 'INTERBOOK_POST', date, money(amount), from === 'PERSONAL' ? [{ accountId: pc, debit: money(amount), credit: '0.00' }, { accountId: personalCash, debit: '0.00', credit: money(amount) }] : [{ accountId: personalCash, debit: money(amount), credit: '0.00' }, { accountId: pc, debit: '0.00', credit: money(amount) }], [], { relationshipId: id });
        be = await b.post(id, 'INTERBOOK_POST', date, money(amount), from === 'PERSONAL' ? [{ accountId: businessCash, debit: money(amount), credit: '0.00' }, { accountId: bc, debit: '0.00', credit: money(amount) }] : [{ accountId: bc, debit: money(amount), credit: '0.00' }, { accountId: businessCash, debit: '0.00', credit: money(amount) }], [], { relationshipId: id });
    }
    const unitKnownAt = await alignUnit(c, b, pe, be);
    return await c.store.put(relationships, { _id: id, bookId: c.scope.bookId, ownerId: c.scope.ownerId, domainKind: 'PERSONAL', version: 1, kind, phase, personalBookId: c.scope.bookId, businessBookId: business.bookId, personalContraAccountId: pc, businessContraAccountId: bc, fromScope: from, eligibilityVersionId: p['eligibilityVersionId'], effectiveDate: date, unitKnownAt, amount: money(amount), remaining: money(amount), status: 'POSTED', sourceEventIds: [pe._id, be._id], personalJournalId: pe.journalIds[0], businessJournalId: be.journalIds[0], rootRelationshipId: root ? root._id : null, ...(p['originalExpenseId'] ? { originalExpenseId: p['originalExpenseId'] } : {}) }, c.s);
}
//# sourceMappingURL=relationships.js.map