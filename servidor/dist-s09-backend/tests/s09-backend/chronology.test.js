import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, rate, official, code } from './fixture.js';
import { s09Profile } from './profile.js';
test('S09 rejects outgoing effects before origin/accrual despite sufficient earlier cash', { timeout: 180000 }, async () => {
    const group = await s09Profile();
    try {
        const f = await world(group), params = { bookId: f.book.id }, bank = await f.personal('DATE_BANK', 'ASSET', 'BANK'), debt = await f.personal('DATE_DEBT', 'LIABILITY'), expense = await f.personal('DATE_EXPENSE', 'EXPENSE'), payable = await f.personal('DATE_PAY', 'LIABILITY'), asset = await f.personal('DATE_ASSET', 'ASSET');
        const create = async (kind, date, interest = '0.00') => { const result = await f.mutate('personalCreateLiability', { kind, label: 'Deuda de fechas', counterpartyReference: 'SYN-DATE', principal: '1000.00', rate, schedule: { ...official('1000.00', date, interest), validFrom: '2026-10-25', referenceDate: '2026-10-24' }, prepaymentPermissions: ['REDUCE_TERM'], supportReference: 'SYN-DATE' }, params), id = String(result.data['id']); await f.mutate('personalActivateLiability', { effectiveDate: date, recognitionKind: 'CASH_RECEIPT', principalAccountId: debt.id, destinationAccountId: bank.id, legalOwnerReference: 'SYN-OWNER', funding: [{ kind: 'DIRECT_CREDIT', amount: '1000.00' }], supportReference: 'SYN-DATE-ACT' }, { ...params, liabilityId: id }, result.etag); const view = await f.read('getPersonalLiabilityEnvelope', { ...params, liabilityId: id }); return { id, view, schedule: view.data['schedule'] }; };
        await create('PRIVATE_DEBT', '2026-10-25');
        const later = await create('PRIVATE_DEBT', '2026-10-28'), p = { ...params, liabilityId: later.id };
        let count = await f.database.db.collection('s09_personal_journals').countDocuments();
        await assert.rejects(() => f.mutate('personalPayLiability', { scheduleVersionId: later.schedule['id'], effectiveDate: '2026-10-27', amount: '1.00', cashAccountId: bank.id, allocations: [{ installmentNumber: 1, component: 'PRINCIPAL', amount: '1.00', accountId: debt.id }], supportReference: 'SYN-BEFORE-ORIGIN' }, p, later.view.etag), code('INPUT_INVALID'));
        await assert.rejects(() => f.mutate('personalPrepayLiability', { effectiveDate: '2026-10-27', amount: '1.00', cashAccountId: bank.id, mode: 'REDUCE_TERM', previousScheduleVersionId: later.schedule['id'], resultSchedule: official('999.00', '2026-10-28'), supportReference: 'SYN-BEFORE-ORIGIN' }, p, later.view.etag), code('INPUT_INVALID'));
        assert.equal(await f.database.db.collection('s09_personal_journals').countDocuments(), count);
        const accrued = await create('PRIVATE_DEBT', '2026-10-26', '10.00');
        await f.mutate('personalRecognizeLiabilityComponent', { scheduleVersionId: accrued.schedule['id'], effectiveDate: '2026-10-28', components: [{ installmentNumber: 1, component: 'INTEREST', amount: '10.00', expenseAccountId: expense.id, payableAccountId: payable.id }], supportReference: 'SYN-ACCRUAL' }, { ...params, liabilityId: accrued.id }, accrued.view.etag);
        const fresh = await f.read('getPersonalLiabilityEnvelope', { ...params, liabilityId: accrued.id });
        count = await f.database.db.collection('s09_personal_journals').countDocuments();
        await assert.rejects(() => f.mutate('personalPayLiability', { scheduleVersionId: accrued.schedule['id'], effectiveDate: '2026-10-27', amount: '10.00', cashAccountId: bank.id, allocations: [{ installmentNumber: 1, component: 'INTEREST', amount: '10.00', accountId: payable.id }], supportReference: 'SYN-PAY-BEFORE-ACCRUAL' }, { ...params, liabilityId: accrued.id }, fresh.etag), code('COMPONENT_MISMATCH'));
        assert.equal(await f.database.db.collection('s09_personal_journals').countDocuments(), count);
        const history = await create('PRIVATE_DEBT', '2026-10-25');
        const activationEvent = history.view.data['events'].find(e => e['kind'] === 'LIABILITY_ACTIVATE');
        await f.mutate('personalReverseLiabilityEvent', { effectiveDate: '2026-10-28', supportReference: 'SYN-REVERSE-LATER', reason: 'Corrección sintética' }, { ...params, liabilityId: history.id, eventId: String(activationEvent['id']) }, history.view.etag);
        const past = await f.read('getPersonalLiabilityEnvelope', { ...params, liabilityId: history.id }, { asOf: '2026-10-26' });
        assert.equal(past.data['status'], 'ACTIVE');
        assert.equal(past.data['principalOutstanding'], '1000.00');
        const reused = await create('PRIVATE_DEBT', '2026-10-28'), reusedEvent = reused.view.data['events'].find(e => e['kind'] === 'LIABILITY_ACTIVATE'), journal = (await f.database.db.collection('s09_events_personal').findOne({ _id: String(reusedEvent['id']) })).journalIds[0];
        const duplicate = await f.mutate('personalCreateLiability', { kind: 'PRIVATE_DEBT', label: 'Duplicado prohibido', counterpartyReference: 'SYN-EXTERNAL', principal: '1000.00', rate, schedule: official('1000.00'), prepaymentPermissions: [], supportReference: 'SYN-DUPLICATE' }, params);
        await assert.rejects(() => f.mutate('personalActivateLiability', { effectiveDate: '2026-10-28', recognitionKind: 'EXISTING_JOURNAL_LINK', existingJournalId: journal, principalAccountId: debt.id, destinationAccountId: bank.id, legalOwnerReference: 'SYN-OWNER', funding: [{ kind: 'DIRECT_CREDIT', amount: '1000.00' }], supportReference: 'SYN-DUPLICATE' }, { ...params, liabilityId: String(duplicate.data['id']) }, duplicate.etag), code('SOURCE_CONFLICT'));
        const card = await create('CARD', '2026-10-26');
        await assert.rejects(() => f.mutate('personalPostCardPurchase', { effectiveDate: '2026-10-25', amount: '50.00', classification: 'ASSET', destinationAccountId: asset.id, cardLiabilityAccountId: debt.id, legalOwnerReference: 'SYN-OWNER', cycleStart: '2026-10-01', cycleEnd: '2026-10-31', paymentDue: '2026-11-15', supportReference: 'SYN-CARD-BEFORE-ORIGIN' }, { ...params, liabilityId: card.id }, card.view.etag), code('INPUT_INVALID'));
        const businessDebt = await f.account('DATE_B_DEBT', 'LIABILITY'), posting = { currency: 'COP', effectiveDate: '2026-10-25', sourceId: randomUUID(), supportReference: 'SYN-EXISTING', description: 'Deuda ya contabilizada', lines: [{ accountId: f.bank.id, debit: '1000.00', credit: '0.00' }, { accountId: businessDebt.id, debit: '0.00', credit: '1000.00' }] }, postingKey = randomUUID();
        await f.proof(f.a, 'FINANCE_JOURNAL_POST', { organizationId: f.org, idempotencyKey: postingKey, payload: posting });
        const original = await f.runtime.finance.mutate(f.a.issued.context, 'postJournal', f.org, posting, postingKey), originalId = String(original.data['id']), bparams = { organizationId: f.org }, linked = await f.mutate('businessCreateLiability', { kind: 'PRIVATE_DEBT', label: 'Fuente existente', counterpartyReference: 'SYN-EXISTING', principal: '1000.00', rate, schedule: official('1000.00'), prepaymentPermissions: [], supportReference: 'SYN-EXISTING' }, bparams), journalCount = await f.database.db.collection('financial_journals').countDocuments();
        await f.mutate('businessActivateLiability', { effectiveDate: '2026-10-25', recognitionKind: 'EXISTING_JOURNAL_LINK', existingJournalId: originalId, principalAccountId: businessDebt.id, destinationAccountId: f.bank.id, legalOwnerReference: 'SYN-OWNER', funding: [{ kind: 'DIRECT_CREDIT', amount: '1000.00' }], supportReference: 'SYN-LINK' }, { ...bparams, liabilityId: String(linked.data['id']) }, linked.etag);
        assert.equal(await f.database.db.collection('financial_journals').countDocuments(), journalCount);
        await assert.rejects(() => f.runtime.finance.mutate(f.a.issued.context, 'reverseJournal', f.org, { effectiveDate: '2026-10-28', sourceId: randomUUID(), supportReference: 'SYN-GENERIC-REVERSE', reason: 'No puede romper vínculo' }, randomUUID(), originalId, original.etag), code('DOMAIN_REVERSAL_FORBIDDEN'));
        assert.equal(await f.database.db.collection('financial_journals').countDocuments(), journalCount);
        console.log('S09_CHRONOLOGY_PASS origin / accrual / card; earlier cash available; rejected effects create no journal');
    }
    finally {
        await group.dispose();
    }
});
//# sourceMappingURL=chronology.test.js.map