import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { s10Profile } from './profile.js';
import { world, rate, official, code } from './fixture.js';
import { today } from '../../src/modules/obligations/calendar.js';
import { hash } from '../../src/modules/obligations/codec.js';
import { originals } from '../../src/modules/obligations/catalog.js';
import { wealthContract } from '../../src/modules/wealth/contract.js';
import { ProjectionRuntime } from '../../src/modules/reporting/projection/service.js';
import { purposes as openingPurposes } from '../../src/modules/opening/contract.js';
import { paymentContract } from '../../src/modules/payments/contract.js';
const info = (r) => r.data;
const id = (r) => String(info(r)['id'] ?? info(r)['resourceId']);
test('S10 financial candidate: shared reserves, 200M mixed funding, estimates, rent, sale and atomic rollback', { timeout: 300000 }, async (t) => {
    const group = await s10Profile();
    try {
        const f = await world(group), date = today(f.now()), params = { organizationId: f.org }, wealth = f.wealth;
        const read = (op, p = params, q = { asOf: date }) => f.wealthRead('business' + op, p, q);
        const mutate = (op, p, ps = params, expected, key) => f.wealthMutate('business' + op, p, ps, expected, key);
        const tag = async () => String((await read('GetWealthBook')).etag), getFund = (fundId) => read('GetFund', { ...params, fundId }), getAsset = (assetId) => read('GetAsset', { ...params, assetId });
        const expense = await f.account('EXP_S10', 'EXPENSE'), assetAccount = await f.account('ASSET_S10'), debtAccount = await f.account('DEBT_S10', 'LIABILITY'), income = await f.account('RENT_S10', 'INCOME'), gain = await f.account('GAIN_S10', 'INCOME');
        const fund = await mutate('CreateFund', { mode: 'VIRTUAL', label: 'Ahorro protegido', purpose: 'ASSET_PURCHASE', backingAccountId: f.bank.id, supportReference: 'SYN' }), fp = { ...params, fundId: id(fund) };
        wealthContract().result('businessCreateFund', 201, { data: fund.data, meta: fund.meta, requestId: 'SYN' });
        await t.test('20M reserve protects existing writers; release changes free money without journal', async () => {
            const before = await f.runtime.finance.journals.countDocuments();
            await mutate('AllocateFund', { bookETag: await tag(), effectiveDate: date, amount: '20000000.00', supportReference: 'SYN' }, fp, (await getFund(fp.fundId)).etag);
            const availability = info(await read('GetWealthAvailability', params, { asOf: date, accountId: f.bank.id, fundId: fp.fundId }));
            assert.equal(availability['confirmedCash'], '20000000.00');
            assert.equal(availability['free'], '0.00');
            assert.equal(availability['fundReserved'], '20000000.00');
            assert.equal(await f.runtime.finance.journals.countDocuments(), before);
            const dashboard = await f.runtime.reporting.read(f.a.issued.context, 'getReportingDashboard', f.org, undefined, { asOf: date, from: '2026-10-01', to: date }), metrics = dashboard.data['organizationMetrics'];
            assert.equal(metrics.find(m => m['id'] === 'LIQUIDITY_RESERVED')?.['value'], '20000000.00');
            assert.equal(metrics.find(m => m['id'] === 'LIQUIDITY_AVAILABLE')?.['value'], '0.00');
            const spend = { currency: 'COP', effectiveDate: date, sourceId: randomUUID(), supportReference: 'SYN', description: 'Debe rechazar', lines: [{ accountId: expense.id, debit: '1.00', credit: '0.00' }, { accountId: f.bank.id, debit: '0.00', credit: '1.00' }] };
            await assert.rejects(() => f.runtime.finance.mutate(f.a.issued.context, 'postJournal', f.org, spend, randomUUID()), code('ACCOUNT_OVERDRAFT'));
            await assert.rejects(() => f.database.transaction(s => f.runtime.finance.postOperation(f.org, randomUUID(), date, spend.lines, 'SYN-SHARED-S5-DEBIT', s)), code('ACCOUNT_OVERDRAFT'));
            const eligible = await f.mutate('declareOwnEligibility', { right: 'FULL_OWNERSHIP', percentage: '100.00', validFrom: date, supportReference: 'SYN' }, { organizationId: f.org }), personalBank = await f.personal('PROTECTED_RECIPIENT', 'ASSET', 'BANK'), personalDue = await f.personal('PROTECTED_DUE', 'LIABILITY'), businessDue = await f.account('PROTECTED_DUE'), personalBook = await f.read('getOwnPersonalBook'), businessBook = await f.read('getBusinessBook', params);
            await assert.rejects(() => f.mutate('postInterbookRelationship', { kind: 'INTERBOOK_LOAN', businessOrganizationId: f.org, businessBookETag: businessBook.etag, personalBookETag: personalBook.etag, eligibilityVersionId: id(eligible), effectiveDate: date, amount: '1.00', fromScope: 'BUSINESS', personalCashAccountId: personalBank.id, businessCashAccountId: f.bank.id, personalContraAccountId: personalDue.id, businessContraAccountId: businessDue.id, supportReference: 'SYN' }), code('ACCOUNT_OVERDRAFT'));
            assert.equal(await f.database.db.collection('s09_relationships').countDocuments(), 0);
            const borrower = await f.runtime.lending.mutate(f.a.issued.context, 'createBorrower', f.org, { borrowerCode: 'SYN_' + randomUUID().slice(0, 8).toUpperCase(), profile: { displayName: 'Persona sintética S10', schemaVersion: 1, extras: {} } }, randomUUID()), terms = { borrowerId: id(borrower), plannedFundingAccountId: f.bank.id, principal: '10000000.00', effectiveDate: date, firstDueDate: '2026-11-28', installmentCount: 4, method: 'CONSTANT_PRINCIPAL', frequency: 'MONTH', rate: { type: 'EFFECTIVE', unit: 'MONTH', value: '0.030000000000' }, calendarConvention: 'PERIODIC_FIXED', holidayAdjustment: 'NO_SHIFT', policyVersion: 'S04-LOCAL-CO-0.1', jurisdiction: 'CO', usage: 'LOCAL_SYNTHETIC' }, quote = await f.runtime.lending.mutate(f.a.issued.context, 'createLoanQuote', f.org, { terms }, randomUUID()), binding = { quoteId: id(quote), quoteFingerprint: info(quote)['fingerprint'] }, loanDraft = await f.runtime.lending.mutate(f.a.issued.context, 'createLoanDraft', f.org, binding, randomUUID()), loan = await f.runtime.lending.mutate(f.a.issued.context, 'confirmLoanTerms', f.org, { ...binding, termsVersion: 1 }, randomUUID(), id(loanDraft), loanDraft.etag);
            const principal = await f.account('S5_PRINCIPAL'), interest = await f.account('S5_INTEREST'), revenue = await f.account('S5_REVENUE', 'INCOME'), credit = await f.account('S5_CREDIT', 'LIABILITY'), profile = { principalAccountId: principal.id, interestReceivableAccountId: interest.id, interestIncomeAccountId: revenue.id, borrowerCreditAccountId: credit.id };
            // eslint-disable-next-line security/detect-object-injection -- Four fixed account profile keys in this synthetic setup, never request fields.
            const disburse = async () => { const versions = {}; for (const k of Object.keys(profile))
                versions[k] = (await f.runtime.finance.read(f.a.issued.context, 'readAccount', f.org, profile[k])).etag; const request = { kind: 'DISBURSE', loanId: id(loan), loanETag: loan.etag, fundingAccountETag: (await f.runtime.finance.read(f.a.issued.context, 'readAccount', f.org, f.bank.id)).etag, accountProfile: profile, accountVersions: versions, effectiveDate: date, supportReference: 'SYN-S10-LOAN' }, book = await f.runtime.operations.read(f.a.issued.context, 'getLoanOperationsBook', f.org), key = randomUUID(), preview = await f.runtime.operations.preview(f.a.issued.context, f.org, { executionKey: key, expectedBookETag: book.etag, request }); return await f.runtime.operations.mutate(f.a.issued.context, 'disburseLoan', f.org, { previewToken: info(preview)['previewToken'], request }, key, book.etag); };
            await assert.rejects(disburse, code('ACCOUNT_OVERDRAFT'));
            assert.equal(await f.runtime.finance.journals.countDocuments(), before);
            await mutate('ReleaseFund', { bookETag: await tag(), effectiveDate: date, amount: '20000000.00', supportReference: 'SYN' }, fp, (await getFund(fp.fundId)).etag);
            assert.equal(info(await read('GetWealthAvailability', params, { asOf: date, accountId: f.bank.id }))['free'], '20000000.00');
            assert.equal(await f.runtime.finance.journals.countDocuments(), before);
            assert.equal((await disburse()).status, 201);
            assert.equal(info(await read('GetWealthAvailability', params, { asOf: date, accountId: f.bank.id }))['free'], '10000000.00');
            await f.runtime.finance.mutate(f.a.issued.context, 'postJournal', f.org, { ...spend, sourceId: randomUUID(), description: 'Capital sintético tras desembolso', lines: [{ accountId: f.bank.id, debit: '10000000.00', credit: '0.00' }, { accountId: f.equity.id, debit: '0.00', credit: '10000000.00' }] }, randomUUID());
            await mutate('AllocateFund', { bookETag: await tag(), effectiveDate: date, amount: '20000000.00', supportReference: 'SYN' }, fp, (await getFund(fp.fundId)).etag);
            const bank2 = await f.account('REAL_BANK_2', 'ASSET', 'BANK'), transfer = await mutate('TransferFund', { bookETag: await tag(), effectiveDate: date, amount: '20000000.00', destinationAccountId: bank2.id, destinationFundId: null, supportReference: 'SYN' }, fp, (await getFund(fp.fundId)).etag);
            assert.equal(info(await read('GetWealthAvailability', params, { asOf: date, accountId: bank2.id }))['confirmedCash'], '20000000.00');
            await mutate('ReverseFundEvent', { bookETag: await tag(), effectiveDate: date, reason: 'Restituir traslado real', supportReference: 'SYN' }, { ...fp, fundEventId: String(info(transfer)['eventId']) }, (await getFund(fp.fundId)).etag);
            assert.equal(info(await getFund(fp.fundId))['reserved'], '20000000.00');
            const cash = await f.account('S6_CUSTODY_CASH', 'ASSET', 'CASH'), held = await f.account('S6_HELD', 'LIABILITY'), payments = f.runtime.payments, state = async () => info(await payments.read(f.a.issued.context, 'getPaymentsState', f.org)), configure = async (operation, payload) => { const key = randomUUID(), versions = await state(), purpose = paymentContract().purpose(operation, payload); await f.proof(f.a, purpose, { organizationId: f.org, idempotencyKey: key, expectedETag: versions['paymentsBookETag'], operationId: operation, resourceId: null, payload }); return await payments.mutate(f.a.issued.context, operation, f.org, payload, key, String(versions['paymentsBookETag'])); };
            const cashRead = await f.runtime.finance.read(f.a.issued.context, 'readAccount', f.org, cash.id), heldRead = await f.runtime.finance.read(f.a.issued.context, 'readAccount', f.org, held.id), custodian = f.a.issued.context.subjectId;
            await configure('setHeldFundsProfile', { configurationKind: 'HELD_FUNDS_PROFILE', heldLiabilityAccountId: held.id, heldLiabilityAccountETag: heldRead.etag, resourceETag: '"' + f.org + ':held-profile:0"', supportReference: 'SYN' });
            await configure('setCustodyBinding', { custodianId: custodian, accountId: cash.id, accountETag: cashRead.etag, heldLiabilityAccountId: held.id, heldLiabilityAccountETag: heldRead.etag, resourceETag: '"' + custodian + ':binding:0"', supportReference: 'SYN' });
            const custodyBinding = await payments.read(f.a.issued.context, 'getCustodyBinding', f.org, custodian), position = await f.runtime.operations.read(f.a.issued.context, 'getLoanPosition', f.org, id(loan)), intent = { method: 'CASH', borrowerId: id(borrower), amount: '50000.00', currency: 'COP', destinationAccountId: cash.id, destinationAccountETag: cashRead.etag, custodianId: custodian, bindingETag: custodyBinding.etag, observedDate: date, observedAt: new Date(f.now()).toISOString(), receiptReference: 'SYN-' + randomUUID(), supportReference: 'SYN', targets: [{ loanId: id(loan), positionETag: position.etag, amount: '50000.00', mode: 'REGULAR' }], excessDisposition: 'CREDIT' }, command = { kind: 'REGISTER', mode: 'DIRECT', effectiveDate: date, intent }, versions = await state(), key = randomUUID(), preview = await payments.preview(f.a.issued.context, f.org, { executionKey: key, expectedPaymentsETag: versions['paymentsBookETag'], command }), payload = { command, previewToken: info(preview)['token'] };
            await f.proof(f.a, paymentContract().purpose('registerPayment', payload), { organizationId: f.org, idempotencyKey: key, expectedETag: versions['paymentsBookETag'], operationId: 'registerPayment', resourceId: null, payload });
            assert.equal((await payments.mutate(f.a.issued.context, 'registerPayment', f.org, payload, key, String(versions['paymentsBookETag']))).status, 201);
            const cashFund = await mutate('CreateFund', { mode: 'VIRTUAL', label: 'No reclamar custodia ajena', purpose: 'SAVINGS', backingAccountId: cash.id, supportReference: 'SYN' }), cp = { ...params, fundId: id(cashFund) }, cashAvailability = info(await read('GetWealthAvailability', params, { asOf: date, accountId: cash.id }));
            assert.equal(cashAvailability['confirmedCash'], '50000.00');
            assert.equal(cashAvailability['legacyProtected'], '50000.00');
            assert.equal(cashAvailability['free'], '0.00');
            await assert.rejects(async () => mutate('AllocateFund', { bookETag: await tag(), effectiveDate: date, amount: '1.00', supportReference: 'SYN' }, cp, (await getFund(cp.fundId)).etag), code('INSUFFICIENT_AVAILABLE_FUNDS'));
            await mutate('CloseFund', { supportReference: 'SYN' }, cp, (await getFund(cp.fundId)).etag);
            assert.equal(info(await read('GetWealthAvailability', params, { asOf: date, accountId: cash.id }))['legacyProtected'], '50000.00');
        });
        const capital = { currency: 'COP', effectiveDate: date, sourceId: randomUUID(), supportReference: 'SYN', description: 'Capital sintético adicional', lines: [{ accountId: f.bank.id, debit: '60000000.00', credit: '0.00' }, { accountId: f.equity.id, debit: '0.00', credit: '60000000.00' }] };
        await f.runtime.finance.mutate(f.a.issued.context, 'postJournal', f.org, capital, randomUUID());
        const draft = await mutate('CreateAssetDraft', { assetClass: 'APARTMENT', otherClassDescription: null, label: 'Apartamento sintético', origin: 'PURCHASE', legalOwnerReference: 'SYN-OWNER', ownershipPercentage: '100.00', grossCostDeclared: '200000000.00', assetAccountId: assetAccount.id, supportReferences: ['SYN'], locationGeneral: null }), ap = { ...params, assetId: id(draft) };
        const definition = { kind: 'BANK_LOAN', label: 'Crédito directo sintético', counterpartyReference: 'SYN-LENDER', principal: '120000000.00', rate, schedule: official('120000000.00'), prepaymentPermissions: [], supportReference: 'SYN' };
        let acquisition;
        await t.test('200M = 20M savings + 60M existing cash + 120M direct lender-to-seller; no fake cash', async () => {
            const before = await f.runtime.finance.journals.countDocuments();
            acquisition = await mutate('AcquireAsset', { bookETag: await tag(), effectiveDate: date, ownedConsideration: '200000000.00', capitalizedCosts: [], funding: [{ nature: 'RELEASED_SAVINGS', settlementMode: 'CONSUME_RESERVATION', fundId: fp.fundId, accountId: f.bank.id, amount: '20000000.00', provenanceKind: 'DECLARED', reference: 'SYN' }, { nature: 'EXISTING_CASH', settlementMode: 'FROM_ACCOUNT', accountId: f.bank.id, sourceJournalId: null, amount: '60000000.00', provenanceKind: 'UNKNOWN', reference: 'SYN-UNKNOWN' }, { nature: 'DIRECT_NEW_DEBT', settlementMode: 'DIRECT_SELLER', principalAccountId: debtAccount.id, liabilityDefinition: definition, amount: '120000000.00', provenanceKind: 'SUPPORTED_REFERENCE', reference: 'SYN' }], supportReference: 'SYN' }, ap, (await getAsset(ap.assetId)).etag);
            assert.equal(await f.runtime.finance.journals.countDocuments(), before + 1);
            const view = info(await getAsset(ap.assetId));
            assert.equal(view['recognizedCost'], '200000000.00');
            assert.equal(view['linkedPrincipal'], '120000000.00');
            assert.equal(info(await read('GetWealthAvailability', params, { asOf: date, accountId: f.bank.id }))['confirmedCash'], '0.00');
            assert.equal(info(await getFund(fp.fundId))['reserved'], '0.00');
            assert.equal(view['sourceCompleteness'], 'INCOMPLETE');
            assert.equal(await f.database.db.collection('s09_liabilities_business').countDocuments({ status: 'ACTIVE' }), 1);
            wealthContract().result('businessAcquireAsset', 201, { data: acquisition.data, requestId: 'SYN' });
        });
        await t.test('220M estimate is separate from cost and cash; full own debt reduces indicative equity', async () => {
            const before = await f.runtime.finance.journals.countDocuments();
            await mutate('RecordAssetValuation', { valuationDate: date, grossEstimatedValue: '220000000.00', method: 'OWNER_ESTIMATE', sourceReference: 'SYN', supportReference: 'SYN' }, ap, (await getAsset(ap.assetId)).etag);
            const view = await getAsset(ap.assetId);
            assert.equal(info(view)['ownedEstimatedValue'], '220000000.00');
            assert.equal(info(view)['indicativeEquity'], '100000000.00');
            assert.equal(info(view)['recognizedCost'], '200000000.00');
            assert.equal(await f.runtime.finance.journals.countDocuments(), before);
            wealthContract().result('businessGetAsset', 200, { data: view.data, meta: view.meta, requestId: 'SYN' });
        });
        await t.test('rent received posts once; CAS, authorized replay and stale snapshots', async () => {
            const oldTag = await tag(), oldETag = (await getAsset(ap.assetId)).etag, key = randomUUID(), payload = { bookETag: oldTag, effectiveDate: date, amount: '1000000.00', cashAccountId: f.bank.id, incomeAccountId: income.id, supportReference: 'SYN' }, before = await f.runtime.finance.journals.countDocuments(), snap = await read('ListAssets');
            const first = await mutate('ReceiveAssetRent', payload, ap, oldETag, key), replay = await mutate('ReceiveAssetRent', payload, ap, oldETag, key);
            assert.equal(replay.status, 200);
            assert.deepEqual(first.data, replay.data);
            assert.equal(await f.runtime.finance.journals.countDocuments(), before + 1);
            await assert.rejects(() => mutate('ReceiveAssetRent', payload, ap, oldETag), code('PRECONDITION_FAILED'));
            await assert.rejects(() => mutate('ReceiveAssetRent', { ...payload, amount: '2.00' }, ap, oldETag, key), code('IDEMPOTENCY_CONFLICT'));
            await assert.rejects(() => read('ListAssets', params, { asOf: date, snapshotToken: snap.meta['snapshotToken'] }), code('REPORT_SNAPSHOT_STALE'));
            assert.equal(info(await read('GetWealthPositions'))['rentCashReceived'], '1000000.00');
        });
        await t.test('sale with outstanding debt is denied, accounting and all new boundaries roll back atomically', async () => {
            await assert.rejects(async () => mutate('DisposeAsset', { bookETag: await tag(), effectiveDate: date, ownedSalePrice: '220000000.00', saleCosts: '5000000.00', cashAccountId: f.bank.id, gainAccountId: gain.id, lossAccountId: expense.id, costsExpenseAccountId: expense.id, supportReference: 'SYN' }, ap, (await getAsset(ap.assetId)).etag), code('REVERSAL_DEPENDENCY'));
            const digest = async () => hash(await Promise.all([...originals, 'financial_journals', 'audit_events', 'outbox', 'financial_books', 'financial_evidence_head'].map(async (name) => [name, await f.database.db.collection(name).find({}).sort({ _id: 1 }).toArray()])));
            const hook = f.service.store.validateBook, priorHook = await digest();
            f.service.store.validateBook = undefined;
            try {
                await assert.rejects(async () => mutate('UpdateFund', { label: 'No publicar sin guarda', purpose: 'SAVINGS', supportReference: 'SYN' }, fp, (await getFund(fp.fundId)).etag), code('SERVICE_UNAVAILABLE'));
            }
            finally {
                f.service.store.validateBook = hook;
            }
            assert.equal(await digest(), priorHook);
            const original = f.service.store.put.bind(f.service.store), finish = f.service.store.finish.bind(f.service.store);
            for (const boundary of ['s09_personal_journals', 's10_asset_events_business', 's09_commands', 'FINISH']) {
                // BUSINESS journal failure injected immediately after the master ledger post through the signed event boundary.
                const target = boundary === 's09_personal_journals' ? 's09_events_business' : boundary, before = await digest();
                f.service.store.put = async (name, input, s, archive) => { const value = await original(name, input, s, archive); if (name === target)
                    throw Error('SYN_BOUNDARY_' + boundary); return value; };
                f.service.store.finish = async (s) => { await finish(s); if (boundary === 'FINISH')
                    throw Error('SYN_BOUNDARY_FINISH'); };
                try {
                    await assert.rejects(async () => mutate('ReceiveAssetRent', { bookETag: await tag(), effectiveDate: date, amount: '1.00', cashAccountId: f.bank.id, incomeAccountId: income.id, supportReference: 'SYN' }, ap, (await getAsset(ap.assetId)).etag), /SYN_BOUNDARY_/);
                }
                finally {
                    f.service.store.put = original;
                    f.service.store.finish = finish;
                }
                assert.equal(await digest(), before);
            }
        });
        await t.test('private assignment has no BUSINESS/SA/other-owner read authority and GET never writes', async () => {
            const stranger = await f.actor();
            await assert.rejects(() => f.wealthRead('businessListAssets', params, { asOf: date }, stranger), code('RESOURCE_NOT_FOUND'));
            const names = [...originals, 'financial_journals', 'audit_events', 'outbox'], digest = async () => hash(await Promise.all(names.map(async (n) => [n, await f.database.db.collection(n).find({}).sort({ _id: 1 }).toArray()]))), before = await digest();
            await read('GetWealthPositions');
            await read('ListAssetSources', ap);
            assert.equal(await digest(), before);
            const scope = { kind: 'BUSINESS', bookId: f.org, ownerId: f.org, organizationId: f.org }, book = await f.database.client.withSession(s => wealth.bookTag(scope, s));
            assert.match(book, /^"s10-book:/);
            const row = await f.database.db.collection('s10_assets_business').findOne({ _id: ap.assetId });
            assert.ok(row);
            assert.ok(row.mac);
        });
        const g = await world(group), pp = { bookId: g.book.id }, pd = today(g.now()), wallet = await g.personal('WALLET', 'ASSET', 'BANK'), capitalAccount = await g.personal('CAPITAL', 'EQUITY'), personalAsset = await g.personal('PROPERTY'), personalDebt = await g.personal('DEBT', 'LIABILITY'), personalIncome = await g.personal('RENT', 'INCOME'), personalExpense = await g.personal('COSTS', 'EXPENSE'), personalPayable = await g.personal('PAYABLE', 'LIABILITY');
        const pr = (op, p = pp, q = { asOf: pd }) => g.wealthRead('personal' + op, p, q), pm = (op, p, ps = pp, expected, key) => g.wealthMutate('personal' + op, p, ps, expected, key), ptag = async () => String((await pr('GetWealthBook')).etag), pa = (assetId) => pr('GetAsset', { ...pp, assetId });
        const contribute = async (amount) => pm('RecordExternalFunds', { bookETag: await ptag(), effectiveDate: pd, amount, cashAccountId: wallet.id, provenanceKind: 'DECLARED', supportReference: 'SYN', nature: 'OWNER_CAPITAL_CONTRIBUTION', equityAccountId: capitalAccount.id, contributorReference: 'SYN-OWNER' });
        const personalDraft = async (percentage = '100.00', gross = '200000000.00') => pm('CreateAssetDraft', { assetClass: 'HOUSE', otherClassDescription: null, label: 'Activo personal sintético', origin: 'PURCHASE', legalOwnerReference: 'SYN-OWNER', ownershipPercentage: percentage, grossCostDeclared: gross, assetAccountId: personalAsset.id, supportReferences: ['SYN'], locationGeneral: null });
        let partialId = '', partialAcquisition = {};
        await t.test('PERSONAL 40%: own cost80M, estimate88M and full own debt30M gives equity58M', async () => {
            await contribute('50000000.00');
            const received = await pm('RecordExternalFunds', { bookETag: await ptag(), effectiveDate: pd, amount: '30000000.00', cashAccountId: wallet.id, provenanceKind: 'SUPPORTED_REFERENCE', supportReference: 'SYN', nature: 'RECEIVED_LOAN', principalAccountId: personalDebt.id, liabilityDefinition: { ...definition, principal: '30000000.00', schedule: official('30000000.00') } }), debt = await g.database.db.collection('s09_liabilities_personal').findOne({ status: 'ACTIVE' });
            assert.ok(debt);
            const draft = await personalDraft('40.00'), ps = { ...pp, assetId: id(draft) };
            partialId = ps.assetId;
            const count = await g.database.db.collection('s09_personal_journals').countDocuments();
            const acquired = await pm('AcquireAsset', { bookETag: await ptag(), effectiveDate: pd, ownedConsideration: '80000000.00', capitalizedCosts: [], funding: [{ nature: 'EXISTING_CASH', settlementMode: 'FROM_ACCOUNT', amount: '50000000.00', accountId: wallet.id, sourceJournalId: null, provenanceKind: 'DECLARED', reference: 'SYN' }, { nature: 'EXISTING_DEBT_LINK', settlementMode: 'FROM_ACCOUNT', amount: '30000000.00', accountId: wallet.id, liabilityId: debt._id, sourceJournalId: info(received)['journalIds'][0], provenanceKind: 'SUPPORTED_REFERENCE', reference: 'SYN' }], supportReference: 'SYN' }, ps, (await pa(ps.assetId)).etag);
            partialAcquisition = info(acquired);
            assert.equal(await g.database.db.collection('s09_personal_journals').countDocuments(), count + 1);
            assert.equal(await g.database.db.collection('s09_liabilities_personal').countDocuments({ status: 'ACTIVE' }), 1);
            await pm('RecordAssetValuation', { valuationDate: pd, grossEstimatedValue: '220000000.00', method: 'OWNER_ESTIMATE', sourceReference: 'SYN', supportReference: 'SYN' }, ps, (await pa(ps.assetId)).etag);
            const view = info(await pa(ps.assetId));
            assert.equal(view['recognizedCost'], '80000000.00');
            assert.equal(view['ownedEstimatedValue'], '88000000.00');
            assert.equal(view['linkedPrincipal'], '30000000.00');
            assert.equal(view['indicativeEquity'], '58000000.00');
            const beforeK = new Date(Date.parse(String(partialAcquisition['unitKnownAt'])) - 1).toISOString(), prior = info(await pr('GetAsset', ps, { asOf: pd, recordedThrough: beforeK })), at = info(await pr('GetAsset', ps, { asOf: pd, recordedThrough: partialAcquisition['unitKnownAt'] }));
            assert.equal(prior['status'], 'DRAFT');
            assert.equal(prior['recognizedCost'], '0.00');
            assert.equal(at['recognizedCost'], '80000000.00');
            const cashBefore = info(await pr('GetWealthAvailability', pp, { asOf: pd, recordedThrough: beforeK, accountId: wallet.id })), cashAt = info(await pr('GetWealthAvailability', pp, { asOf: pd, recordedThrough: partialAcquisition['unitKnownAt'], accountId: wallet.id }));
            assert.equal(cashBefore['confirmedCash'], '80000000.00');
            assert.equal(cashAt['confirmedCash'], '0.00');
        });
        await t.test('rent2M and S9 operating expense0.3M link once; principal is separate', async () => {
            const ps = { ...pp, assetId: partialId };
            await pm('ReceiveAssetRent', { bookETag: await ptag(), effectiveDate: pd, amount: '2000000.00', cashAccountId: wallet.id, incomeAccountId: personalIncome.id, supportReference: 'SYN' }, ps, (await pa(partialId)).etag);
            const due = await g.mutate('personalCreateExpense', { nominalDate: pd, dueDate: pd, description: 'Mantenimiento sintético', category: 'SERVICES', amountMode: 'FIXED', amount: '300000.00', supportReference: 'SYN' }, pp), paid = await g.mutate('personalRecognizeAndPayExpense', { effectiveDate: pd, amount: '300000.00', cashAccountId: wallet.id, expenseAccountId: personalExpense.id, payableAccountId: personalPayable.id, supportReference: 'SYN' }, { ...pp, expenseId: id(due) }, due.etag), events = await g.database.db.collection('s09_events_personal').find({ entityId: id(due), kind: 'EXPENSE_PAY' }).toArray();
            assert.equal(events.length, 1);
            assert.ok(paid);
            const count = await g.database.db.collection('s09_personal_journals').countDocuments(), link = { expenseId: id(due), sourceEventId: events[0]._id, amount: '300000.00', effectiveDate: pd, supportReference: 'SYN' };
            await pm('LinkAssetExpense', link, ps, (await pa(partialId)).etag);
            assert.equal(await g.database.db.collection('s09_personal_journals').countDocuments(), count);
            await assert.rejects(async () => pm('LinkAssetExpense', link, ps, (await pa(partialId)).etag), code('SOURCE_CONFLICT'));
            assert.equal(info(await pr('GetWealthPositions'))['operatingNetCash'], '1700000.00');
        });
        await t.test('basic total sale220M-cost200M-fees5M yields15M; sale150M yields loss55M; compensation preserves originals', async () => {
            const totals = () => g.database.client.withSession(s => g.service.ledger.totals({ kind: 'PERSONAL', bookId: g.book.id, ownerId: g.a.issued.context.subjectId }, s, pd, '9999-12-31T23:59:59.999Z'));
            for (const price of ['220000000.00', '150000000.00']) {
                await contribute('200000000.00');
                const draft = await personalDraft(), ps = { ...pp, assetId: id(draft) };
                await pm('AcquireAsset', { bookETag: await ptag(), effectiveDate: pd, ownedConsideration: '200000000.00', capitalizedCosts: [], funding: [{ nature: 'EXISTING_CASH', settlementMode: 'FROM_ACCOUNT', amount: '200000000.00', accountId: wallet.id, sourceJournalId: null, provenanceKind: 'DECLARED', reference: 'SYN' }], supportReference: 'SYN' }, ps, (await pa(ps.assetId)).etag);
                const before = await totals();
                const sold = await pm('DisposeAsset', { bookETag: await ptag(), effectiveDate: pd, ownedSalePrice: price, saleCosts: '5000000.00', cashAccountId: wallet.id, gainAccountId: personalIncome.id, lossAccountId: personalExpense.id, costsExpenseAccountId: personalExpense.id, supportReference: 'SYN' }, ps, (await pa(ps.assetId)).etag), after = await totals();
                assert.equal((after.income - before.income) - (after.expense - before.expense), price === '220000000.00' ? 1500000000n : -5500000000n);
                assert.equal(info(await pa(ps.assetId))['status'], 'DISPOSED');
                await pm('ReverseAssetEvent', { bookETag: await ptag(), effectiveDate: pd, reason: 'Compensación sintética', supportReference: 'SYN' }, { ...ps, assetEventId: String(info(sold)['eventId']) }, (await pa(ps.assetId)).etag);
                assert.equal(info(await pa(ps.assetId))['recognizedCost'], '200000000.00');
                assert.equal((await totals()).cashAvailable, before.cashAvailable);
            }
        });
        await t.test('read-only external links and unresolved sources never mint cash; future and incomplete acquisitions fail', async () => {
            const count = await g.database.db.collection('s09_personal_journals').countDocuments();
            await pm('RecordExternalFunds', { bookETag: await ptag(), effectiveDate: pd, amount: '123.00', nature: 'PENDING_CLASSIFICATION', provenanceKind: 'UNKNOWN', description: 'Contrapartida por aclarar', supportReference: 'SYN' });
            assert.equal(await g.database.db.collection('s09_personal_journals').countDocuments(), count);
            const draft = await personalDraft(), ps = { ...pp, assetId: id(draft) };
            await assert.rejects(async () => pm('AcquireAsset', { bookETag: await ptag(), effectiveDate: pd, ownedConsideration: '1.00', capitalizedCosts: [], funding: [{ nature: 'EXISTING_CASH', settlementMode: 'FROM_ACCOUNT', amount: '2.00', accountId: wallet.id, sourceJournalId: null, provenanceKind: 'UNKNOWN', reference: 'SYN' }], supportReference: 'SYN' }, ps, (await pa(ps.assetId)).etag), code('COMPONENT_MISMATCH'));
        });
        await t.test('two direct creditors and savings: every new source/debt/claim/version/audit boundary rolls back; whole acquisition reverses', async () => {
            const fund = await pm('CreateFund', { mode: 'VIRTUAL', label: 'Compra sintética', purpose: 'ASSET_PURCHASE', backingAccountId: wallet.id, supportReference: 'SYN' }), fp = { ...pp, fundId: id(fund) };
            await pm('AllocateFund', { bookETag: await ptag(), effectiveDate: pd, amount: '200.00', supportReference: 'SYN' }, fp, fund.etag);
            const draft = await personalDraft(), ps = { ...pp, assetId: id(draft) }, definition = { kind: 'PRIVATE_DEBT', label: 'Crédito sintético', counterpartyReference: 'SYN', principal: '300.00', rate, schedule: official('300.00'), prepaymentPermissions: [], supportReference: 'SYN' }, funding = [{ nature: 'RELEASED_SAVINGS', settlementMode: 'CONSUME_RESERVATION', fundId: fp.fundId, accountId: wallet.id, amount: '200.00', provenanceKind: 'DECLARED', reference: 'SYN' }, { nature: 'EXISTING_CASH', settlementMode: 'FROM_ACCOUNT', accountId: wallet.id, sourceJournalId: null, amount: '200.00', provenanceKind: 'UNKNOWN', reference: 'SYN' }, ...Array.from({ length: 2 }, () => ({ nature: 'DIRECT_NEW_DEBT', settlementMode: 'DIRECT_SELLER', principalAccountId: personalDebt.id, liabilityDefinition: definition, amount: '300.00', provenanceKind: 'SUPPORTED_REFERENCE', reference: 'SYN' }))];
            const payload = async () => ({ bookETag: await ptag(), effectiveDate: pd, ownedConsideration: '1000.00', capitalizedCosts: [], funding, supportReference: 'SYN' }), digest = async () => hash(await Promise.all([...originals, 'audit_events', 'outbox'].map(async (name) => [name, await g.database.db.collection(name).find({}).sort({ _id: 1 }).toArray()]))), put = g.service.store.put.bind(g.service.store), audit = g.identity.audit.append.bind(g.identity.audit);
            for (const boundary of ['s10_asset_funding_personal', 's09_liability_versions_personal', 's09_liabilities_personal', 's10_source_claims_personal', 's09_asset_stubs_personal', 's10_asset_versions_personal', 'AUDIT']) {
                const before = await digest();
                g.service.store.put = async (...args) => { const row = await put(...args); if (args[0] === boundary)
                    throw Error('SYN_NEW_BOUNDARY_' + boundary); return row; };
                g.identity.audit.append = async (...args) => { await audit(...args); if (boundary === 'AUDIT')
                    throw Error('SYN_NEW_BOUNDARY_AUDIT'); };
                try {
                    await assert.rejects(async () => pm('AcquireAsset', await payload(), ps, (await pa(ps.assetId)).etag), /SYN_NEW_BOUNDARY_/);
                }
                finally {
                    g.service.store.put = put;
                    g.identity.audit.append = audit;
                }
                assert.equal(await digest(), before);
            }
            const count = await g.database.db.collection('s09_personal_journals').countDocuments(), align = g.service.store.alignPending.bind(g.service.store);
            g.service.store.alignPending = async (...args) => { g.clock.value += 5; return await align(...args); };
            let acquired;
            try {
                acquired = await pm('AcquireAsset', await payload(), ps, (await pa(ps.assetId)).etag);
            }
            finally {
                g.service.store.alignPending = align;
            }
            const unit = String(info(acquired)['unitKnownAt']), eventId = String(info(acquired)['eventId']), newDebts = info(await pa(ps.assetId))['liabilityIds'];
            for (const name of ['s10_asset_events_personal', 's10_source_claims_personal', 's10_asset_funding_personal'])
                for (const row of await g.database.db.collection(name).find(name === 's10_asset_events_personal' ? { _id: eventId } : { sourceEventId: eventId }).toArray())
                    assert.equal(row.recordedAt, unit);
            assert.equal(await g.database.db.collection('s09_history_personal').countDocuments({ entityTable: 's09_liabilities_personal', entityId: { $in: newDebts } }), 0);
            const beforeUnit = info(await g.read('listPersonalLiabilities', pp, { asOf: pd, recordedThrough: new Date(Date.parse(unit) - 1).toISOString() }));
            assert.ok(!beforeUnit['items'].some(d => newDebts.includes(String(d['id']))));
            assert.equal(await g.database.db.collection('s10_fund_events_personal').countDocuments({ kind: 'FUND_CONSUME', 'details.sourceEventId': eventId }), 1);
            assert.equal(await g.database.db.collection('s09_asset_stubs_personal').countDocuments({ wealthRootId: eventId }), 1);
            assert.equal(await g.database.db.collection('s09_personal_journals').countDocuments(), count + 1);
            assert.equal(info(await pa(ps.assetId))['liabilityIds'].length, 2);
            assert.equal(info(await pa(ps.assetId))['linkedPrincipal'], '600.00');
            assert.equal(info(await pr('GetFund', fp))['reserved'], '0.00');
            await pm('ReverseAssetEvent', { bookETag: await ptag(), effectiveDate: pd, reason: 'Compensar compra completa', supportReference: 'SYN' }, { ...ps, assetEventId: String(info(acquired)['eventId']) }, (await pa(ps.assetId)).etag);
            assert.equal(info(await pa(ps.assetId))['status'], 'DRAFT');
            assert.equal(info(await pr('GetFund', fp))['reserved'], '200.00');
        });
        await t.test('real fund transfer and compensation preserve total cash; future reservation and stale close fail', async () => {
            const bank2 = await g.personal('SECOND_BANK', 'ASSET', 'BANK'), fund = await pm('CreateFund', { mode: 'ACCOUNT_LINKED', label: 'Cuenta real', purpose: 'SAVINGS', backingAccountId: wallet.id, supportReference: 'SYN' }), fp = { ...pp, fundId: id(fund) }, destination = await pm('CreateFund', { mode: 'ACCOUNT_LINKED', label: 'Destino real', purpose: 'SAVINGS', backingAccountId: bank2.id, supportReference: 'SYN' });
            await pm('AllocateFund', { bookETag: await ptag(), effectiveDate: pd, amount: '100.00', supportReference: 'SYN' }, fp, fund.etag);
            const transferred = await pm('TransferFund', { bookETag: await ptag(), effectiveDate: pd, amount: '100.00', destinationAccountId: bank2.id, destinationFundId: id(destination), supportReference: 'SYN' }, fp, (await pr('GetFund', fp)).etag);
            assert.equal(info(await pr('GetFund', { ...pp, fundId: id(destination) }))['reserved'], '100.00');
            await pm('ReverseFundEvent', { bookETag: await ptag(), effectiveDate: pd, reason: 'Deshacer traslado sintético', supportReference: 'SYN' }, { ...fp, fundEventId: String(info(transferred)['eventId']) }, (await pr('GetFund', fp)).etag);
            assert.equal(info(await pr('GetFund', fp))['reserved'], '100.00');
            assert.equal(info(await pr('GetFund', { ...pp, fundId: id(destination) }))['reserved'], '0.00');
            await assert.rejects(async () => pm('CloseFund', { supportReference: 'SYN' }, fp, (await pr('GetFund', fp)).etag), code('FUND_NOT_EMPTY'));
            await assert.rejects(async () => pm('AllocateFund', { bookETag: await ptag(), effectiveDate: '2026-12-01', amount: '1.00', supportReference: 'SYN' }, fp, (await pr('GetFund', fp)).etag), code('INPUT_INVALID'));
        });
        await t.test('existing S9 stub links the same asset/debt without reposting and cannot be claimed twice', async () => {
            const debt = await g.mutate('personalCreateLiability', { kind: 'PRIVATE_DEBT', label: 'Activo S9 existente', counterpartyReference: 'SYN', principal: '500.00', rate, schedule: official('500.00'), prepaymentPermissions: [], supportReference: 'SYN' }, pp);
            await g.mutate('personalActivateLiability', { effectiveDate: pd, recognitionKind: 'ASSET_PURCHASE', principalAccountId: personalDebt.id, destinationAccountId: personalAsset.id, legalOwnerReference: 'SYN', funding: [{ kind: 'DIRECT_CREDIT', amount: '500.00' }], supportReference: 'SYN' }, { ...pp, liabilityId: id(debt) }, debt.etag);
            const stub = await g.database.db.collection('s09_asset_stubs_personal').findOne({ liabilityId: id(debt) });
            assert.ok(stub);
            const event = await g.database.db.collection('s09_events_personal').findOne({ _id: String(stub['sourceEventId']) });
            assert.ok(event);
            const journalId = event['journalIds'][0], link = { effectiveDate: pd, sourceClaims: [{ sourceKind: 'EXISTING_S09', sourceId: stub._id, journalId, lineIndex: 0, componentId: null, amount: '500.00', supportReference: 'SYN' }], liabilityIds: [id(debt)], supportReference: 'SYN' }, count = await g.database.db.collection('s09_personal_journals').countDocuments(), draft = await personalDraft(), ps = { ...pp, assetId: id(draft) };
            await pm('LinkExistingAsset', link, ps, draft.etag);
            assert.equal(await g.database.db.collection('s09_personal_journals').countDocuments(), count);
            assert.equal(info(await pa(ps.assetId))['linkedPrincipal'], '500.00');
            const duplicate = await personalDraft();
            await assert.rejects(() => pm('LinkExistingAsset', link, { ...pp, assetId: id(duplicate) }, duplicate.etag), code('SOURCE_CAPACITY_EXCEEDED'));
        });
        await t.test('PERSONAL S9 expense writer cannot spend S10 savings; both expense legs roll back', async () => {
            const availability = info(await pr('GetWealthAvailability', pp, { asOf: pd, accountId: wallet.id })), amount = String(availability['confirmedCash']);
            assert.notEqual(availability['fundReserved'], '0.00');
            const due = await g.mutate('personalCreateExpense', { nominalDate: pd, dueDate: pd, description: 'Debe respetar ahorro', category: 'SERVICES', amountMode: 'FIXED', amount, supportReference: 'SYN' }, pp), count = await g.database.db.collection('s09_personal_journals').countDocuments();
            await assert.rejects(() => g.mutate('personalRecognizeAndPayExpense', { effectiveDate: pd, amount, cashAccountId: wallet.id, expenseAccountId: personalExpense.id, payableAccountId: personalPayable.id, supportReference: 'SYN' }, { ...pp, expenseId: id(due) }, due.etag), code('INSUFFICIENT_AVAILABLE_FUNDS'));
            assert.equal(await g.database.db.collection('s09_personal_journals').countDocuments(), count);
        });
        await t.test('private consolidation counts ledger once, respects 40% vs full eligibility, backed elimination and S8 privacy', async () => {
            await g.mutate('declareOwnEligibility', { right: 'PARTICIPATION', percentage: '40.00', validFrom: pd, supportReference: 'SYN' }, { organizationId: g.org });
            g.clock.value += 100;
            assert.equal(info(await g.wealthRead('getPrivateWealth', {}, { asOf: pd }))['business'], null);
            const eligible = await g.mutate('declareOwnEligibility', { right: 'FULL_OWNERSHIP', percentage: '100.00', validFrom: pd, supportReference: 'SYN' }, { organizationId: g.org }), investment = await g.personal('INVESTMENT');
            for (const row of await g.database.db.collection('s10_assets_personal').find({ status: 'ACTIVE' }).toArray())
                if (row._id !== partialId)
                    await pm('RecordAssetValuation', { valuationDate: pd, grossEstimatedValue: row['recognizedCost'], method: 'OWNER_ESTIMATE', sourceReference: 'SYN', supportReference: 'SYN' }, { ...pp, assetId: row._id }, (await pa(row._id)).etag);
            const pb = await g.read('getOwnPersonalBook'), bb = await g.read('getBusinessBook', { organizationId: g.org });
            const relationship = await g.mutate('postInterbookRelationship', { kind: 'CONTRIBUTION', businessOrganizationId: g.org, businessBookETag: bb.etag, personalBookETag: pb.etag, eligibilityVersionId: id(eligible), effectiveDate: pd, amount: '50000.00', fromScope: 'PERSONAL', personalCashAccountId: wallet.id, businessCashAccountId: g.bank.id, personalContraAccountId: investment.id, businessContraAccountId: g.equity.id, supportReference: 'SYN' });
            g.clock.value += 100;
            const prior = info(await g.wealthRead('getPrivateWealth', {}, { asOf: pd })), relation = await g.database.db.collection('s09_relationships').findOne({ _id: id(relationship) });
            assert.ok(relation);
            const reporting = await g.runtime.reporting.read(g.a.issued.context, 'getReportingDashboard', g.org, undefined, { asOf: pd, from: '2026-10-01', to: pd }), token = reporting.data['meta']['snapshotToken'];
            const draft = await pm('CreateAssetDraft', { assetClass: 'BUSINESS_INTEREST', otherClassDescription: null, label: 'PRIVATE-S10-INVESTMENT', origin: 'CONTRIBUTION', legalOwnerReference: 'SYN', ownershipPercentage: '100.00', grossCostDeclared: null, assetAccountId: investment.id, supportReferences: ['SYN'], locationGeneral: null }), ps = { ...pp, assetId: id(draft) }, journal = String(relation['personalJournalId']);
            await pm('LinkExistingAsset', { effectiveDate: pd, sourceClaims: [{ sourceKind: 'EXISTING_JOURNAL', sourceId: journal, journalId: journal, lineIndex: 0, componentId: null, amount: '50000.00', supportReference: 'SYN' }], liabilityIds: [], supportReference: 'SYN' }, ps, draft.etag);
            await pm('RecordAssetValuation', { valuationDate: pd, grossEstimatedValue: '60000.00', method: 'OWNER_ESTIMATE', sourceReference: 'SYN', supportReference: 'SYN' }, ps, (await pa(ps.assetId)).etag);
            g.clock.value += 100;
            const current = await g.wealthRead('getPrivateWealth', {}, { asOf: pd }), value = info(current), s9 = info(await g.read('getPrivateConsolidation'));
            assert.equal(value['ledgerGrossAssets'], s9['gross']['assets']);
            assert.equal(value['ledgerGrossAssets'], prior['ledgerGrossAssets']);
            assert.equal(value['indicativeOwnedAssets'], prior['indicativeOwnedAssets']);
            assert.equal(value['eliminations'][0]?.['amount'], '50000.00');
            wealthContract().result('getPrivateWealth', 200, { data: value, meta: current.meta, requestId: 'SYN' });
            const rows = await g.runtime.reporting.read(g.a.issued.context, 'listReportingRows', g.org, 'MOVEMENTS', { snapshotToken: token, limit: 100 });
            assert.equal(rows.status, 200);
            assert.ok(!JSON.stringify(rows.data).includes('PRIVATE-S10-INVESTMENT'));
        });
        await t.test('S3 POSTED opening uses authenticated ledgerLineMap/component budgets: 80M+120M, third claim rejected', async () => {
            const h = await group.fixture(), actor = await h.actor(), org = (await h.runtime.organizations.create(actor.issued.context, { name: 'Apertura sintética S10', currency: 'COP', timezone: 'America/Bogota' }, randomUUID())).data.organization.id, date = today(h.now()), accounts = new Map();
            for (const [code, accountClass] of [['ASSET', 'ASSET'], ['EQUITY', 'EQUITY']]) {
                const result = await h.runtime.finance.mutate(actor.issued.context, 'createAccount', org, { code, name: code, accountClass, kind: 'GENERAL', currency: 'COP' }, randomUUID());
                accounts.set(code, id(result));
            }
            const support = randomUUID(), reference = randomUUID(), component = randomUUID(), snapshot = { cutoffDate: date, supports: [{ id: support, reference: 'SYN', asOfDate: date, declaration: 'OWNER_CHECKED' }], references: [{ id: reference, type: 'BASIC_ASSET', externalReference: 'SYN-ASSET', category: 'HOUSE', acquisitionDate: date, fundingReference: 'SYN', supportIds: [support] }], components: [{ id: component, category: 'BASIC_ASSET', accountId: accounts.get('ASSET'), amount: '200000000.00', referenceId: reference, supportIds: [support] }, { id: randomUUID(), category: 'EQUITY', accountId: accounts.get('EQUITY'), amount: '200000000.00', equityKind: 'CONTRIBUTED', supportIds: [support] }], historicalInterest: [], informationalHistory: [] };
            let opening;
            const mutate = async (operation, payload) => { const key = randomUUID(), resource = opening?.id, expected = opening ? '"' + opening.id + ':' + opening.version + '"' : undefined; await h.proof(actor, openingPurposes.get(operation), { organizationId: org, idempotencyKey: key, payload, ...(resource ? { expectedETag: expected } : {}) }, resource); const result = await h.runtime.opening.mutate(actor.issued.context, operation, org, payload, key, resource, expected); opening = (operation === 'validateOpening' ? (info(result)['opening']) : result.data); return result; };
            await mutate('createOpening', { snapshot });
            await mutate('validateOpening', { policyVersion: 'S03-OPENING-0.1' });
            assert.ok(opening?.validation);
            const binding = { validationId: opening.validation.id, validationFingerprint: opening.validation.fingerprint };
            await mutate('approveOpening', binding);
            await mutate('commitOpening', binding);
            assert.equal(opening?.status, 'POSTED');
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- Registered own group marker, PID/runId/database verified before owned activation.
            const owner = async () => { const marker = JSON.parse(await readFile(join(group.folder, 'owner.json'), 'utf8')); return marker.pid === process.pid && marker.runId === group.runId && JSON.stringify(marker.names) === JSON.stringify(group.names) && marker.names[0] === h.database.db.databaseName; };
            await h.runtime.obligations.prepareOwned(owner);
            await h.runtime.wealth.prepareOwned(owner);
            h.identity.reporting.projection = await ProjectionRuntime.createOwned(h.identity, h.keys.cursor, owner);
            await h.runtime.obligations.activateOwned(owner);
            const params = { organizationId: org }, journal = opening.commit.journalId, line = opening.commit.ledgerLineMap.find(x => x.componentIds.includes(component));
            assert.ok(line);
            const count = await h.runtime.finance.journals.countDocuments();
            for (const amount of ['80000000.00', '120000000.00', '1000000.00']) {
                const draft = await h.runtime.wealth.mutate(actor.issued.context, 'businessCreateAssetDraft', { assetClass: 'HOUSE', otherClassDescription: null, label: 'Parte sintética de apertura', origin: 'OPENING', legalOwnerReference: 'SYN', ownershipPercentage: '100.00', grossCostDeclared: null, assetAccountId: accounts.get('ASSET'), supportReferences: ['SYN'], locationGeneral: null }, params, randomUUID()), input = { effectiveDate: date, sourceClaims: [{ sourceKind: 'OPENING_S03', sourceId: component, journalId: journal, lineIndex: line.lineIndex, componentId: component, amount, supportReference: 'SYN' }], liabilityIds: [], supportReference: 'SYN' }, work = () => h.runtime.wealth.mutate(actor.issued.context, 'businessLinkExistingAsset', input, { ...params, assetId: id(draft) }, randomUUID(), draft.etag);
                if (amount === '1000000.00')
                    await assert.rejects(work, code('SOURCE_CAPACITY_EXCEEDED'));
                else
                    await work();
            }
            assert.equal(await h.runtime.finance.journals.countDocuments(), count);
        });
    }
    finally {
        await group.dispose();
    }
});
//# sourceMappingURL=integration.test.js.map