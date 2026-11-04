import { randomUUID } from 'node:crypto';
import { today } from '../../src/modules/finance/service.js';
import { msDue } from '../../src/modules/lending/ms-engine.js';
export const data = (r) => r.data;
export async function setupMonthly(f, options = {}) {
    const ms = f.runtime.monthly, date = today(f.now()), params = { bookId: f.org }, principal = await f.account('MS_P'), interest = await f.account('MS_I'), income = await f.account('MS_Y', 'INCOME'), credit = await f.account('MS_C', 'LIABILITY'), expense = await f.account('MS_X', 'EXPENSE'), labelId = randomUUID(), profile = { principalAccountId: principal.id, interestReceivableAccountId: interest.id, interestIncomeAccountId: income.id, borrowerCreditAccountId: credit.id };
    const mapping = { effectiveFrom: date, cashAccountIds: [f.bank.id], categories: [{ labelId, label: 'Alimentación', category: 'OTHER', expenseAccountId: expense.id }], loanProfile: profile, supportReference: 'SYN-MS' }, current = await ms.read(f.a.issued.context, 'msGetMonthlyView', params, { month: date.slice(0, 7), effectiveDate: date, knownAt: new Date(f.now()).toISOString() }), r = await ms.mutate(f.a.issued.context, 'msVersionMapping', mapping, params, randomUUID(), current.etag), mappingVersion = String(data(r)['id']) + ':' + String(data(r)['version']);
    const b = data(await f.runtime.lending.mutate(f.a.issued.context, 'createBorrower', f.org, { borrowerCode: 'MS_' + randomUUID().slice(0, 8).toUpperCase(), profile: { displayName: 'Persona sintética MS', schemaVersion: 1, extras: {} }, ...(options.openingBorrowerReference ? { openingBorrowerReference: options.openingBorrowerReference } : {}) }, randomUUID())), effectiveDate = options.effectiveDate ?? date, anchor = { mode: 'DAY_OF_MONTH', day: Number(effectiveDate.slice(-2)) }, terms = { modality: 'MONTHLY_OPEN_V1', borrowerId: b['id'], principal: options.principal ?? '5000000.00', monthlyRate: '0.030000000000', effectiveDate, firstDueDate: msDue({ effectiveDate, anchor }, 1), anchor, cashAccountId: f.bank.id, mappingVersion, supportReference: 'SYN-MS', usage: 'LOCAL_SYNTHETIC' }, draft = await ms.mutate(f.a.issued.context, 'msCreateMonthlyDraft', terms, params, randomUUID());
    return { ms, params, profile, labelId, expense, mapping, mappingVersion, borrowerId: String(b['id']), terms, draft, loanId: String(data(draft)['id']), lp: { ...params, loanId: String(data(draft)['id']) } };
}
export async function seedCapital(f, date = today(f.now()), amount = '20000000.00') {
    const p = { currency: 'COP', effectiveDate: date, sourceId: randomUUID(), supportReference: 'SYN-MS-CAPITAL', description: 'Capital sintético', lines: [{ accountId: f.bank.id, debit: amount, credit: '0.00' }, { accountId: f.equity.id, debit: '0.00', credit: amount }] }, key = randomUUID();
    await f.proof(f.a, 'FINANCE_JOURNAL_POST', { organizationId: f.org, idempotencyKey: key, payload: p });
    await f.runtime.finance.mutate(f.a.issued.context, 'postJournal', f.org, p, key);
    await f.restore.flush();
}
export async function msTag(f, bookId = f.org, date = today(f.now())) { return (await f.runtime.monthly.read(f.a.issued.context, 'msGetMonthlyView', { bookId }, { month: date.slice(0, 7), effectiveDate: date, knownAt: new Date(f.now()).toISOString() })).etag; }
//# sourceMappingURL=helpers.js.map