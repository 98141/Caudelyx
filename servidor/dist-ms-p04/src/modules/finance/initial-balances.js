import { randomUUID, createHash } from 'node:crypto';
import { canonical } from './contract.js';
import { today, etag } from './service.js';
import { money, cents } from './money.js';
import { recordFinancialEvidence } from './integrity.js';
import { workContract } from '../sessions/work-policy.js';
import { AppError } from '../../shared/errors.js';
export async function initialBalances(finance, context, orgValue, body, keyValue) {
    const identity = finance.identity, contract = workContract();
    contract.validate('InitialBalanceInput', body);
    const org = orgValue.toLowerCase(), key = keyValue?.toLowerCase();
    if (!key || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key))
        throw new AppError(422, 'INPUT_INVALID');
    const input = canonical(body), fingerprint = createHash('sha256').update(JSON.stringify({ org, input, key })).digest('hex');
    if (input.effectiveDate > today(identity.now()) || new Set(input.items.map(x => x.accountId)).size !== input.items.length)
        throw new AppError(422, 'INPUT_INVALID');
    return identity.database.transaction(async (session) => {
        const actor = await finance.actor(context, org, session);
        const previous = await finance.idempotency.findOne({ organizationId: org, actorId: actor._id, operation: 'initialBalances', key }, { session });
        if (previous) {
            if (previous.hash !== fingerprint)
                throw new AppError(409, 'IDEMPOTENCY_CONFLICT');
            return { ...previous.result, status: 200 };
        }
        if (await finance.journals.findOne({ organizationId: org, 'source.type': 'INITIAL_BALANCE', 'source.id': input.sourceId }, { session }))
            throw new AppError(409, 'SOURCE_CONFLICT');
        const books = identity.database.db.collection('financial_books');
        await books.updateOne({ _id: org }, { $inc: { value: 1 }, $setOnInsert: { recordedAt: 0 } }, { upsert: true, session });
        const book = await books.findOne({ _id: org }, { session });
        if (book?.initialBalanceJournalId || book?.openingId || await finance.journals.findOne({ organizationId: org }, { session }))
            throw new AppError(409, 'INITIAL_BALANCE_UNAVAILABLE');
        if (await identity.database.db.collection('opening_files').findOne({ organizationId: org, status: { $in: ['DRAFT', 'VALIDATED', 'APPROVED'] } }, { session }))
            throw new AppError(409, 'INITIAL_BALANCE_CONFLICT');
        let total = 0n;
        for (const item of input.items) {
            const account = await finance.accounts.findOne({ _id: item.accountId, organizationId: org, bookId: org, ownerId: org, financialScope: 'BUSINESS' }, { session });
            if (!account)
                throw new AppError(404, 'RESOURCE_NOT_FOUND');
            if (account.status !== 'ACTIVE' || account.accountClass !== 'ASSET' || !['CASH', 'BANK'].includes(account.kind) || account.currency !== 'COP')
                throw new AppError(422, 'INPUT_INVALID');
            total += cents(item.amount);
            money(total);
        }
        const candidates = (await finance.accounts.find({ organizationId: org }, { session }).toArray()).filter(a => a.name.normalize('NFC').trim().toLocaleLowerCase('es-CO') === 'capital inicial');
        if (candidates.length > 1 || candidates.some(a => a.accountClass !== 'EQUITY' || a.kind !== 'GENERAL' || a.currency !== 'COP' || a.bookId !== org || a.ownerId !== org || a.financialScope !== 'BUSINESS' || a.status !== 'ACTIVE'))
            throw new AppError(409, 'INITIAL_BALANCE_CONFLICT');
        let capital = candidates[0];
        if (!capital) {
            if (await finance.accounts.findOne({ organizationId: org, code: 'MEJ_CAPITAL_INICIAL' }, { session }))
                throw new AppError(409, 'INITIAL_BALANCE_CONFLICT');
            capital = { _id: randomUUID(), organizationId: org, bookId: org, ownerId: org, financialScope: 'BUSINESS', currency: 'COP', createdAt: new Date(identity.now()).toISOString(), code: 'MEJ_CAPITAL_INICIAL', name: 'Capital inicial', accountClass: 'EQUITY', kind: 'GENERAL', status: 'ACTIVE', version: 1, initialBalancePurpose: 'INITIAL_CAPITAL' };
            await finance.accounts.insertOne(capital, { session });
        }
        const journal = await finance.writeJournal(org, input.effectiveDate, [...input.items.map(x => ({ accountId: x.accountId, debit: x.amount, credit: '0.00' })), { accountId: capital._id, debit: '0.00', credit: money(total) }], { type: 'INITIAL_BALANCE', id: input.sourceId }, null, input.description, input.supportReference, session);
        await books.updateOne({ _id: org }, { $set: { initialBalanceJournalId: journal._id } }, { session });
        const result = { status: 201, data: { journal: finance.journal(journal), capitalAccountId: capital._id, initialBalanceRecorded: true }, etag: etag(journal) };
        contract.validate('InitialBalanceResult', { data: result.data, requestId: journal._id }, true);
        await finance.idempotency.insertOne({ _id: randomUUID(), organizationId: org, actorId: actor._id, operation: 'initialBalances', key, hash: fingerprint, result }, { session });
        await recordFinancialEvidence(identity.database, session);
        await identity.audit.append({ realm: 'TENANT', action: 'INITIAL_BALANCE_RECORDED', actorId: actor._id, subjectId: actor._id, outcome: 'SUCCESS' }, session);
        await identity.messaging.notify('TENANT', actor._id, 'INITIAL_BALANCE_RECORDED', {}, session);
        return result;
    });
}
//# sourceMappingURL=initial-balances.js.map