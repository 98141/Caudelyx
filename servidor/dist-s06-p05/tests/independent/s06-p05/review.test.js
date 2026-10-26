/* eslint-disable security/detect-object-injection -- Own fixed account/label maps of this review, never request input. */
// S06-P05 independent runtime review (Claude) of S06-P04-v1-INTEGRADO on ONE own group (88801d49cd294def47b9edeb).
// Each subtest starts a fresh world in the same group (databases dropped/recreated by the cloned profile), so no case
// creates its own database. Money expectations come only from the own oracle; the service is driven for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { s06Profile } from './review-profile.js';
import { world, mm, toC, S5, S6, LEDGER, EVIDENCE, AUDIT } from './review-fixtures.js';
import { S6Book, c, m, terms as oracleTerms } from './oracle.js';
const evidence = (name, d) => console.log(JSON.stringify({ evidence: name, ...d }));
const only = (name) => !process.env['P05_ONLY'] || process.env['P05_ONLY'].split(',').some(x => name.startsWith(x));
const FUND = 'FUND';
/** Journal lines of one journal, netted per account and labelled with the oracle symbols. */
async function journalOf(w, journalId, label) {
    const j = await w.db.collection('financial_journals').findOne({ _id: journalId, organizationId: w.org });
    const t = new Map();
    for (const l of (j?.['lines'] ?? []))
        t.set(l.accountId, (t.get(l.accountId) ?? 0n) + toC(l.debit) - toC(l.credit));
    return [...t].filter(([, v]) => v !== 0n).map(([a, v]) => ({ account: label.get(a) ?? 'UNKNOWN:' + a, debit: v > 0n ? mm(v) : '0.00', credit: v < 0n ? mm(-v) : '0.00' })).sort((a, b) => a.account.localeCompare(b.account));
}
const oracleRows = (p) => p.map(x => ({ account: x.account, debit: m(x.debit), credit: m(x.credit) })).sort((a, b) => a.account.localeCompare(b.account));
test('P06-S6 runtime review on one own group', { timeout: 3600000 }, async (t) => {
    const group = await s06Profile();
    try {
        await t.test('E1 economics: supervised/direct, custody, reserves and complete compensations == own oracle (AT02–AT05, RC01–RC13, NC02–NC04/NC17)', { skip: !only('E1') }, async (st) => {
            const w = await world(group), f = w.f, T = f.a, o = {};
            st.after(() => evidence('P06-' + st.name.slice(0, 2), { observed: o }));
            const book = new S6Book('HELD');
            // Accounts (S6 bank/cash/held) and members with approved roles only (O, P, C invited through the real flow).
            const bank = (await f.accountS06('BANK_R', 'ASSET', 'BANK')).id, bankN = (await f.accountS06('BANK_N', 'ASSET', 'BANK')).id, cashO = (await f.accountS06('CASH_O', 'ASSET', 'CASH')).id, held = await f.heldProfile();
            const O = await f.member('O'), P = await f.member('P');
            assert.equal((await f.bind(O, cashO, held)).status, 201);
            const label = new Map([[f.profile.principalAccountId, 'PRINCIPAL'], [f.profile.interestReceivableAccountId, 'INTEREST_RECEIVABLE'], [f.profile.interestIncomeAccountId, 'INTEREST_INCOME'], [f.profile.borrowerCreditAccountId, 'BORROWER_CREDIT'], [held, 'HELD'], [bank, 'BANK'], [bankN, 'BANK_N'], [cashO, 'CASH_O'], [f.account, FUND]]);
            const T0 = w.today();
            book.fund(FUND, c('20000000.00'));
            // CASH_O already holds 50k of free money from another operation (detects wrong sums of reserves).
            assert.equal((await w.transfer(f.account, cashO, '50000.00')).status, 201);
            book.spend(FUND, c('50000.00'), 'CASH_O');
            const loan = async (principal, rate = '0.030000000000', extra = {}) => {
                const l = await f.loan({ principal, rate: { type: 'EFFECTIVE', unit: 'MONTH', value: rate }, ...extra });
                const r = await f.disburse(l);
                assert.equal(r.result.status, 201);
                book.addLoan(l.id, l.borrowerId, oracleTerms({ principal, rate: { type: 'EFFECTIVE', unit: 'MONTH', value: rate }, ...extra }));
                book.disburse(l.id, FUND);
                return l;
            };
            // ---- RC01/RC02/AT02: O registers supervised CASH 300k on an already accrued installment; pending touches nothing.
            const L1 = await loan('2000000.00');
            assert.equal((await w.accrue(L1.id)).status, 201);
            book.accrueEvent(L1.id, T0, T0);
            const beforePending = { journals: await w.journals(), position: await w.position(L1.id), ledger: [...await w.ledger()].map(([k, v]) => [label.get(k), mm(v)]) };
            const r1 = await w.register(await f.intent(L1, cashO, '300000.00', O, 'CASH'), 'SUPERVISED', O);
            assert.equal(r1.status, 201, w.st(r1));
            const p1 = r1.id;
            book.register(p1, { method: 'CASH', mode: 'SUPERVISED', borrower: L1.borrowerId, amount: c('300000.00'), account: 'CASH_O', targets: [{ loan: L1.id, amount: c('300000.00'), mode: 'REGULAR' }], excess: 'CREDIT', registrar: 'O', custodian: 'O' }, T0);
            const pend = await w.readPay(p1), cu1 = await w.custody(p1);
            o['RC02 pending'] = { status: pend.status, custody: pend.custodyState, amountHeld: cu1?.['amountHeld'], journalsUnchanged: await w.journals() === beforePending.journals, positionUnchanged: (await w.position(L1.id))['principalOutstanding'] === beforePending.position['principalOutstanding'] && (await w.position(L1.id))['version'] === beforePending.position['version'] };
            assert.deepEqual(o['RC02 pending'], { status: 'PENDING', custody: 'PROVISIONAL', amountHeld: '300000.00', journalsUnchanged: true, positionUnchanged: true });
            o['NC01 O approves own'] = w.st(await w.approve(p1, O));
            const a1 = await w.approve(p1, P);
            assert.equal(a1.status, 201, w.st(a1));
            const s1 = book.approve(p1, 'P', T0);
            const pay1 = await w.readPay(p1), j1 = await w.db.collection('loan_events').findOne({ _id: pay1.eventId });
            o['RC01 approve by P'] = { server: await journalOf(w, String(j1['journalId']), label), oracle: oracleRows(s1.postings), custody: pay1.custodyState, status: pay1.status, principal: (await w.position(L1.id))['principalOutstanding'] };
            assert.deepEqual(o['RC01 approve by P'].server, oracleRows(s1.postings));
            assert.equal(pay1.custodyState, 'CONFIRMED_HELD');
            assert.equal((await w.position(L1.id))['principalOutstanding'], m(book.loans.get(L1.id).pOut));
            const i1 = (await w.installments(L1.id)).find(x => x['number'] === 1);
            assert.deepEqual([i1['interestPaid'], i1['principalPaid']], ['60000.00', '240000.00']);
            // AP6-02 A: confirmed CASH reserved; the 50k of free money in the same account still moves; 0.01 more does not.
            o['AP6-02A reserve'] = { over: w.st(await w.transfer(cashO, f.account, '50000.01')), free: w.st(await w.transfer(cashO, f.account, '50000.00')), then: w.st(await w.transfer(cashO, f.account, '0.01')) };
            book.spend('CASH_O', c('50000.00'), FUND);
            assert.deepEqual(o['AP6-02A reserve'], { over: '409 ACCOUNT_OVERDRAFT', free: '201', then: '409 ACCOUNT_OVERDRAFT' });
            // NC18: memo return after the approval won.
            o['NC18 return after confirm'] = w.st(await w.returnCash(p1, O, '300000.00'));
            // ---- RC04: T DIRECT BANK 100k on 100k already accrued (5% monthly): no second income.
            const L2 = await loan('2000000.00', '0.050000000000');
            assert.equal((await w.accrue(L2.id)).status, 201);
            book.accrueEvent(L2.id, T0, T0);
            const y2 = (await w.ledger()).get(f.profile.interestIncomeAccountId);
            const r4 = await w.register(await f.intent(L2, bank, '100000.00'), 'DIRECT');
            assert.equal(r4.status, 201, w.st(r4));
            const s4 = book.register(r4.id, { method: 'BANK', mode: 'DIRECT', borrower: L2.borrowerId, amount: c('100000.00'), account: 'BANK', targets: [{ loan: L2.id, amount: c('100000.00'), mode: 'REGULAR' }], excess: 'CREDIT', registrar: 'T', custodian: null }, T0);
            const p4 = await w.readPay(r4.id), e4 = await w.db.collection('loan_events').findOne({ _id: p4.eventId });
            o['RC04'] = { server: await journalOf(w, String(e4['journalId']), label), oracle: oracleRows(s4.postings), incomeUnchanged: (await w.ledger()).get(f.profile.interestIncomeAccountId) === y2, custody: p4.custodyState, reconciliation: p4.reconciliationState };
            assert.deepEqual(o['RC04'].server, oracleRows(s4.postings));
            assert.equal(o['RC04'].incomeUnchanged, true);
            // ---- RC10: zero-interest principal fully due, recovered without income.
            let r10 = 'not run';
            try {
                const L3 = await loan('2000000.00', '0.000000000000', { installmentCount: 1 });
                const r = await w.register(await f.intent(L3, bank, '2000000.00'), 'DIRECT');
                const s = book.register(r.id, { method: 'BANK', mode: 'DIRECT', borrower: L3.borrowerId, amount: c('2000000.00'), account: 'BANK', targets: [{ loan: L3.id, amount: c('2000000.00'), mode: 'REGULAR' }], excess: 'CREDIT', registrar: 'T', custodian: null }, T0);
                const p = await w.readPay(r.id), e = await w.db.collection('loan_events').findOne({ _id: p.eventId });
                r10 = { status: w.st(r), server: await journalOf(w, String(e['journalId']), label), oracle: oracleRows(s.postings), position: (await w.position(L3.id))['status'] };
            }
            catch (e) {
                r10 = 'quote/setup refused: ' + String(e.code ?? e);
            }
            o['RC10 zero-interest 2M'] = r10;
            // ---- RC06/RC08: BANK 400k (budget 300k, excess to C) then complete compensation; auto-accrual kept.
            const L4 = await loan('2000000.00');
            const r6 = await w.register({ ...await f.intent(L4, bank, '400000.00'), targets: [{ loanId: L4.id, positionETag: (await f.position(L4.id)).etag, amount: '300000.00', mode: 'REGULAR' }] }, 'DIRECT');
            assert.equal(r6.status, 201, w.st(r6));
            const s6o = book.register(r6.id, { method: 'BANK', mode: 'DIRECT', borrower: L4.borrowerId, amount: c('400000.00'), account: 'BANK', targets: [{ loan: L4.id, amount: c('300000.00'), mode: 'REGULAR' }], excess: 'CREDIT', registrar: 'T', custodian: null }, T0);
            const p6 = await w.readPay(r6.id), e6 = await w.db.collection('loan_events').findOne({ _id: p6.eventId });
            const original6 = await journalOf(w, String(e6['journalId']), label), y6 = (await w.ledger()).get(f.profile.interestIncomeAccountId);
            assert.deepEqual(original6, oracleRows(s6o.postings));
            const rev6 = await w.reverseAll(p6.eventId, r6.id);
            assert.equal(rev6.execute?.status, 201, JSON.stringify(rev6));
            const so6 = book.reverse(book.payments.get(r6.id).eventSeq, T0), comp6 = await w.db.collection('loan_compensations').findOne({ originalEventId: p6.eventId });
            const after6 = await w.readPay(r6.id), i6 = (await w.installments(L4.id)).find(x => x['number'] === 1);
            o['RC06/RC08 reversal'] = { server: await journalOf(w, String(comp6['journalId']), label), oracle: oracleRows(so6.postings), originalJournalIntact: JSON.stringify(await journalOf(w, String(e6['journalId']), label)) === JSON.stringify(original6),
                incomeKept: (await w.ledger()).get(f.profile.interestIncomeAccountId) === y6, principal: (await w.position(L4.id))['principalOutstanding'], credit: await w.credit(L4.borrowerId), inst1: [i6['interestPaid'], i6['principalPaid']], payment: [after6.status, after6.reconciliationState, after6['heldFundsState']], held: (await w.held()).map(h => h['amount']) };
            assert.deepEqual(o['RC06/RC08 reversal'].server, oracleRows(so6.postings));
            assert.deepEqual([o['RC06/RC08 reversal']['principal'], o['RC06/RC08 reversal']['credit']], [m(book.loans.get(L4.id).pOut), m(book.credit.get(L4.borrowerId) ?? 0n)]);
            // Double reversal and exact replay.
            o['double reversal'] = { secondRequest: w.st(await w.requestReversal(p6.eventId)), replayExecute: w.st(await w.settle(rev6.execute.prepared.execute)) };
            // ---- RC11: CASH reversal of p1: custody HELD_UNALLOCATED, reserve converted (not doubled).
            const ledgerBefore11 = await w.ledger();
            const rev11 = await w.reverseAll(pay1.eventId, p1);
            assert.equal(rev11.execute?.status, 201, JSON.stringify(rev11));
            const so11 = book.reverse(book.payments.get(p1).eventSeq, T0);
            const comp11 = await w.db.collection('loan_compensations').findOne({ originalEventId: pay1.eventId }), after11 = await w.readPay(p1);
            o['RC11 CASH reversal'] = { server: await journalOf(w, String(comp11['journalId']), label), oracle: oracleRows(so11.postings), custody: after11.custodyState, cashUnchanged: (await w.ledger()).get(cashO) === ledgerBefore11.get(cashO),
                cashBalance: mm((await w.ledger()).get(cashO) ?? 0n), oracleAvailable: m(book.available('CASH_O')), transfer001: w.st(await w.transfer(cashO, f.account, '0.01')) };
            assert.deepEqual(o['RC11 CASH reversal'].server, oracleRows(so11.postings));
            assert.equal(after11.custodyState, 'HELD_UNALLOCATED');
            // ---- RC05/NC02: receipt 400 (C100) + APPLY_CREDIT 50 → receipt reversal blocked; credit reversal; then receipt reversal.
            const L5 = await loan('2000000.00');
            const r5 = await w.register({ ...await f.intent(L5, bank, '400000.00'), targets: [{ loanId: L5.id, positionETag: (await f.position(L5.id)).etag, amount: '300000.00', mode: 'REGULAR' }] }, 'DIRECT');
            assert.equal(r5.status, 201, w.st(r5));
            book.register(r5.id, { method: 'BANK', mode: 'DIRECT', borrower: L5.borrowerId, amount: c('400000.00'), account: 'BANK', targets: [{ loan: L5.id, amount: c('300000.00'), mode: 'REGULAR' }], excess: 'CREDIT', registrar: 'T', custodian: null }, T0);
            const ac = await w.applyCredit(L5.borrowerId, L5.id, '50000.00');
            assert.equal(ac.status, 201, w.st(ac));
            book.applyCredit(L5.borrowerId, c('50000.00'), [{ loan: L5.id, amount: c('50000.00'), mode: 'REGULAR' }], T0);
            const acEvent = await w.db.collection('loan_events').find({ organizationId: w.org, kind: 'APPLY_CREDIT', borrowerId: L5.borrowerId }).toArray(), p5 = await w.readPay(r5.id);
            const econ = [...S5, ...LEDGER, 'loan_compensations', 'held_funds_reservations'], d0 = await w.digest(econ);
            const blocked = await w.reverseAll(p5.eventId, r5.id);
            // A pending request is allowed (it changes nothing economic); the execution must fail with no economic effect.
            o['NC02 receipt reversal with later APPLY_CREDIT'] = { request: w.st(blocked.request), execute: blocked.execute ? w.st(blocked.execute) : null, noEconomicEffect: await w.digest(econ) === d0 };
            const revAC = await w.reverseAll(String(acEvent[0]['_id']), null);
            const soAC = book.reverse(book.events.length, T0);
            const compAC = await w.db.collection('loan_compensations').findOne({ originalEventId: String(acEvent[0]['_id']) });
            o['RC05 APPLY_CREDIT reversal'] = { status: revAC.execute ? w.st(revAC.execute) : w.st(revAC.request), server: compAC ? await journalOf(w, String(compAC['journalId']), label) : null, oracle: oracleRows(soAC.postings), credit: await w.credit(L5.borrowerId) };
            const thenReceipt = await w.executeReversal(p5.eventId, r5.id);
            const so5 = book.reverse(book.payments.get(r5.id).eventSeq, T0);
            const comp5 = await w.db.collection('loan_compensations').findOne({ originalEventId: p5.eventId });
            o['receipt reversal after compensating APPLY_CREDIT'] = { status: w.st(thenReceipt), server: comp5 ? await journalOf(w, String(comp5['journalId']), label) : null, oracle: oracleRows(so5.postings) };
            // ---- RC09: EXTRA on the due date, reversal restores the original future rows in a new version.
            const L6 = await loan('1000.00', '0.010000000000');
            const r9 = await w.register({ ...await f.intent(L6, bank, '360.00'), targets: [{ loanId: L6.id, positionETag: (await f.position(L6.id)).etag, amount: '360.00', mode: 'EXTRA_PRINCIPAL' }] }, 'DIRECT');
            assert.equal(r9.status, 201, w.st(r9));
            book.register(r9.id, { method: 'BANK', mode: 'DIRECT', borrower: L6.borrowerId, amount: c('360.00'), account: 'BANK', targets: [{ loan: L6.id, amount: c('360.00'), mode: 'EXTRA_PRINCIPAL' }], excess: 'CREDIT', registrar: 'T', custodian: null }, T0);
            const rows = async (id) => (await w.installments(id)).filter(x => String(x['dueDate']) > T0).map(x => ({ dueDate: x['dueDate'], principal: x['principal'], interest: x['interest'] }));
            const own = (id) => book.installments(id).filter(x => x.dueDate > T0).map(x => ({ dueDate: x.dueDate, principal: x.principal, interest: x.interest }));
            const v2 = { server: await rows(L6.id), oracle: own(L6.id) };
            const p9 = await w.readPay(r9.id), rev9 = await w.reverseAll(p9.eventId, r9.id);
            const so9 = book.reverse(book.payments.get(r9.id).eventSeq, T0);
            const comp9 = await w.db.collection('loan_compensations').findOne({ originalEventId: p9.eventId });
            o['RC09 EXTRA reversal'] = { v2, status: rev9.execute ? w.st(rev9.execute) : w.st(rev9.request), server: comp9 ? await journalOf(w, String(comp9['journalId']), label) : null, oracle: oracleRows(so9.postings), v3: { server: await rows(L6.id), oracle: own(L6.id), scheduleVersion: (await w.position(L6.id))['scheduleVersion'] } };
            // ---- NC03: BANK funds partly spent (confirmed BANK is free) → reversal FUNDS_NOT_HELD with no effect.
            const L7 = await loan('2000000.00');
            const r3 = await w.register(await f.intent(L7, bankN, '300000.00'), 'DIRECT');
            assert.equal(r3.status, 201, w.st(r3));
            book.register(r3.id, { method: 'BANK', mode: 'DIRECT', borrower: L7.borrowerId, amount: c('300000.00'), account: 'BANK_N', targets: [{ loan: L7.id, amount: c('300000.00'), mode: 'REGULAR' }], excess: 'CREDIT', registrar: 'T', custodian: null }, T0);
            o['BANK confirmed is free (transfer 100k out)'] = w.st(await w.transfer(bankN, f.account, '100000.00'));
            book.spend('BANK_N', c('100000.00'), FUND);
            const p3 = await w.readPay(r3.id), req3 = await w.requestReversal(p3.eventId), d3 = await w.digest([...S5, ...LEDGER, 'loan_compensations', 'held_funds_reservations']);
            o['NC03 FUNDS_NOT_HELD'] = { request: w.st(req3), execute: w.st(await w.executeReversal(p3.eventId, r3.id)), noEconomicEffect: await w.digest([...S5, ...LEDGER, 'loan_compensations', 'held_funds_reservations']) === d3 };
            // ---- NC04/NC17 and protected sources.
            const disb = await w.db.collection('loan_events').findOne({ organizationId: w.org, kind: 'DISBURSE', loanIds: L7.id }), accr = await w.db.collection('loan_events').findOne({ organizationId: w.org, kind: 'ACCRUE' });
            const compJ = await w.db.collection('financial_journals').findOne({ organizationId: w.org, 'source.type': 'LOAN_COMPENSATION' });
            o['NC04 unsupported kinds'] = { disburse: w.st(await w.requestReversal(String(disb['_id']))), accrue: w.st(await w.requestReversal(String(accr['_id']))) };
            o['manual reverse of LOAN_COMPENSATION journal'] = w.st(await w.s2('reverseJournal', { reason: 'Intento sintético', sourceId: randomUUID(), effectiveDate: T0, supportReference: 'SYN-MAN' }, String(compJ['_id']), `"${String(compJ['_id'])}:${String(compJ['version'] ?? 1)}"`));
            o['manual journal touching HELD'] = w.st(await w.s2('postJournal', { currency: 'COP', effectiveDate: T0, sourceId: randomUUID(), supportReference: 'SYN-MAN-H', description: 'Intento', lines: [{ accountId: held, debit: '1.00', credit: '0.00' }, { accountId: f.account, debit: '0.00', credit: '1.00' }] }));
            o['NC17 legacy S5 RECEIPT'] = w.st(await w.s5({ kind: 'RECEIPT', borrowerId: L7.borrowerId, destinationAccountId: bank, destinationAccountETag: (await f.runtime.finance.read(T.issued.context, 'readAccount', w.org, bank)).etag, receivedAmount: '1.00', targets: [{ loanId: L7.id, positionETag: (await f.position(L7.id)).etag, amount: '1.00', mode: 'REGULAR' }], excessDisposition: 'CREDIT', receiptReference: 'SYN-LEGACY-' + randomUUID().slice(0, 6), effectiveDate: T0, supportReference: 'SYN' }));
            // ---- Whole-ledger reconciliation of every account touched against the oracle (sums across operations).
            const lg = await w.ledger(), whole = {};
            for (const [id, name] of label)
                whole[name] = { server: mm(lg.get(id) ?? 0n), oracle: m(book.balances.get(name) ?? 0n) };
            o['whole ledger vs oracle'] = whole;
            for (const [name, v] of Object.entries(whole))
                assert.equal(v.server, v.oracle, 'ledger ' + name);
            assert.equal(o['NC01 O approves own'], '403 preview ACCESS_DENIED');
            assert.equal(o['NC18 return after confirm'], '409 PAYMENT_STATE_CONFLICT');
            assert.deepEqual(o['double reversal'], { secondRequest: '409 ALREADY_REVERSED', replayExecute: '200' });
            assert.equal(o['NC03 FUNDS_NOT_HELD'].execute, '409 preview FUNDS_NOT_HELD');
            assert.equal(o['NC03 FUNDS_NOT_HELD'].noEconomicEffect, true);
            assert.deepEqual(o['NC04 unsupported kinds'], { disburse: '422 UNSUPPORTED_REVERSAL_KIND', accrue: '422 UNSUPPORTED_REVERSAL_KIND' });
            assert.equal(o['NC17 legacy S5 RECEIPT'], '409 PAYMENT_FLOW_REQUIRED');
            assert.deepEqual(o['NC02 receipt reversal with later APPLY_CREDIT'], { request: '201', execute: '409 preview REVERSAL_DEPENDENCY', noEconomicEffect: true });
        });
        await t.test('E2 segregation, roles, C scope and provisional cash (AT01–AT03, NC01/NC21/NC22, RC03/RC12/RC13)', { skip: !only('E2') }, async (st) => {
            const w = await world(group), f = w.f, T = f.a, o = {};
            st.after(() => evidence('P06-' + st.name.slice(0, 2), { observed: o }));
            const bank = (await f.accountS06('BANK_S', 'ASSET', 'BANK')).id, cashO = (await f.accountS06('CASH_O2', 'ASSET', 'CASH')).id, cashC = (await f.accountS06('CASH_C2', 'ASSET', 'CASH')).id, held = await f.heldProfile();
            const L1 = await f.loan({ principal: '2000000.00' });
            await f.disburse(L1);
            const L2 = await f.loan({ principal: '2000000.00' });
            await f.disburse(L2);
            // Single-user organization: T may only use DIRECT; SUPERVISED without an eligible third party is blocked.
            o['single T SUPERVISED'] = w.st(await w.register(await f.intent(L1, bank, '1000.00'), 'SUPERVISED'));
            o['single T DIRECT'] = w.st(await w.register(await f.intent(L1, bank, '1000.00'), 'DIRECT'));
            const O = await f.member('O'), P = await f.member('P'), C = await f.member('C'), A = await f.member('A'), Lm = await f.member('L');
            const id = (x) => x.issued.context.subjectId;
            assert.equal((await f.bind(O, cashO, held)).status, 201);
            assert.equal((await f.bind(C, cashC, held)).status, 201);
            // NC01: T registers SUPERVISED (P exists) and tries to approve itself; P may decide it.
            const t1 = await w.register(await f.intent(L1, bank, '1000.00'), 'SUPERVISED');
            o['T SUPERVISED with P present'] = w.st(t1);
            o['NC01 T approves own'] = w.st(await w.approve(t1.id, T));
            o['P approves T supervised'] = w.st(await w.approve(t1.id, P));
            // Role matrix on registration and reads (no invented roles; A/L get nothing).
            o['O DIRECT'] = w.st(await w.register(await f.intent(L1, cashO, '1000.00', O, 'CASH'), 'DIRECT', O));
            o['P registers'] = w.st(await w.register(await f.intent(L1, bank, '1000.00'), 'SUPERVISED', P));
            for (const [n, x] of [['A', A], ['L', Lm]]) {
                o[n + ' reads policy'] = w.st(await w.settle(() => w.pay.read(x.issued.context, 'getPaymentsPolicy', w.org)));
                o[n + ' registers'] = w.st(await w.register(await f.intent(L1, bank, '1000.00'), 'SUPERVISED', x));
            }
            // NC21: C without scope; RC12: scope granted by T (SECURITY_ONE_SHOT) then C registers CASH 300k on that loan only.
            o['NC21 C without scope'] = w.st(await w.register(await f.intent(L1, cashC, '300000.00', C, 'CASH'), 'SUPERVISED', C));
            const sc = await w.scope(id(C), L1.id, true);
            o['scope grant'] = w.st(sc);
            o['C contexts'] = (await w.pay.read(C.issued.context, 'listPaymentContexts', w.org)).data.items.map(x => ({ loan: x['loanId'] === L1.id ? 'L1' : x['loanId'] === L2.id ? 'L2' : 'other', method: x['permittedMethod'], destination: x['permittedDestinationId'] === cashC ? 'CASH_C2 (own binding)' : x['permittedDestinationId'] === bank ? 'BANK_S' : String(x['permittedDestinationId']), label: x['permittedDestinationLabel'] }));
            o['C on unscoped L2'] = w.st(await w.register(await f.intent(L2, cashC, '1000.00', C, 'CASH'), 'SUPERVISED', C));
            const j0 = await w.journals(), rc = await w.register(await f.intent(L1, cashC, '300000.00', C, 'CASH'), 'SUPERVISED', C);
            o['RC12 C registers'] = w.st(rc);
            o['C approves own'] = w.st(await w.approve(rc.id, C));
            o['O sees C payment'] = w.st(await w.settle(() => w.pay.read(O.issued.context, 'getPayment', w.org, rc.id)));
            // NC22: scope revoked before commit → the approval fails, the cash stays visible as PROVISIONAL, nothing posted.
            o['scope revoke'] = w.st(await w.scope(id(C), L1.id, false, sc.scopeId));
            o['NC22 P approves after revoke'] = w.st(await w.approve(rc.id, P));
            const afterRevoke = await w.readPay(rc.id);
            o['NC22 state'] = { status: afterRevoke.status, custody: afterRevoke.custodyState, journalsUnchanged: await w.journals() === j0 };
            // RC03: P rejects → RETURN_REQUIRED (physical cash not lost); explicit total return by C → RETURNED; no ledger at any step.
            o['RC03 P rejects'] = w.st(await w.decide('rejectPayment', rc.id, P));
            o['RC03 custody after reject'] = (await w.readPay(rc.id)).custodyState;
            o['return wrong amount'] = w.st(await w.returnCash(rc.id, C, '299999.99'));
            o['return by O (not custodian)'] = w.st(await w.returnCash(rc.id, O, '300000.00'));
            o['return by C'] = w.st(await w.returnCash(rc.id, C, '300000.00'));
            o['custody after return'] = { state: (await w.readPay(rc.id)).custodyState, amountHeld: (await w.custody(rc.id))?.['amountHeld'], journalsUnchanged: await w.journals() === j0 };
            // RC13: new scope, C registers, distinct P confirms: CASH of C bound account; central cash untouched.
            o['scope reactivate'] = w.st(await w.scope(id(C), L1.id, true, sc.scopeId));
            const central0 = (await w.ledger()).get(f.account);
            const rc13 = await w.register(await f.intent(L1, cashC, '300000.00', C, 'CASH'), 'SUPERVISED', C);
            const ap13 = await w.approve(rc13.id, P);
            o['RC13'] = { register: w.st(rc13), approve: w.st(ap13), custody: (await w.readPay(rc13.id)).custodyState, cashC: mm((await w.ledger()).get(cashC) ?? 0n), centralDelta: mm(((await w.ledger()).get(f.account) ?? 0n) - (central0 ?? 0n)) };
            // O cancels its own pending cash → RETURN_REQUIRED → O returns; T may cancel others'.
            const ro = await w.register(await f.intent(L1, cashO, '5000.00', O, 'CASH'), 'SUPERVISED', O);
            o['O cancels own'] = w.st(await w.decide('cancelPayment', ro.id, O));
            o['O returns own'] = w.st(await w.returnCash(ro.id, O, '5000.00'));
            const ro2 = await w.register(await f.intent(L1, bank, '5000.00', O), 'SUPERVISED', O);
            o['P cancels O payment'] = w.st(await w.decide('cancelPayment', ro2.id, P));
            o['T cancels O payment'] = w.st(await w.decide('cancelPayment', ro2.id, T));
            // A supervised pending payment after ANOTHER economic event on the same loan (contract P2: approval receives the current plan).
            const pe = await w.register(await f.intent(L2, bank, '9000.00', O), 'SUPERVISED', O);
            o['pending on L2'] = w.st(pe);
            o['other DIRECT on L2 meanwhile'] = w.st(await w.register(await f.intent(L2, bank, '1000.00'), 'DIRECT'));
            o['approve pending after other event on same loan'] = w.st(await w.approve(pe.id, P));
            o['state of that pending'] = (await w.readPay(pe.id)).status;
            const pe2 = await w.register(await f.intent(L2, bank, '9100.00', O), 'SUPERVISED', O);
            o['explicit accrual meanwhile'] = w.st(await w.accrue(L2.id));
            o['approve pending after explicit accrual'] = w.st(await w.approve(pe2.id, P));
            // Visibility: P only sees PENDING SUPERVISED; confirmed payment hidden from P (404).
            const ro3 = await w.register(await f.intent(L1, bank, '7000.00', O), 'SUPERVISED', O);
            const pList = (await w.pay.read(P.issued.context, 'listPayments', w.org, undefined, { limit: 100 })).data.items;
            o['P list'] = { onlyPending: pList.every(x => x.status === 'PENDING'), containsPending: pList.some(x => x.id === ro3.id), confirmedHidden: w.st(await w.settle(() => w.pay.read(P.issued.context, 'getPayment', w.org, rc13.id))) };
            // Races on one pending payment: approve(P) vs reject(T); then two approvals with different keys.
            const events0 = await w.db.collection('loan_events').countDocuments({ organizationId: w.org, kind: 'RECEIPT' });
            const prA = await w.readPay(ro3.id), vA = await f.state(), apA = await f.preparePayment({ kind: 'APPROVE', paymentId: ro3.id, resourceETag: prA.etag, effectiveDate: w.today(), expectedOperationsETag: vA.operationsBookETag }, P);
            const race = await Promise.allSettled([apA.execute(), f.mutatePayment('rejectPayment', { resourceETag: prA.etag, reason: 'Rechazo concurrente', supportReference: 'SYN-RACE' }, ro3.id, T)]);
            o['approve vs reject'] = { outcomes: race.map(x => x.status === 'fulfilled' ? String(x.value.status) : String(x.reason.code)), final: (await w.readPay(ro3.id)).status, receiptsAdded: await w.db.collection('loan_events').countDocuments({ organizationId: w.org, kind: 'RECEIPT' }) - events0 };
            const ro4 = await w.register(await f.intent(L1, bank, '8000.00', O), 'SUPERVISED', O), e1 = await w.db.collection('loan_events').countDocuments({ organizationId: w.org, kind: 'RECEIPT' }), j1 = await w.journals();
            const prB = await w.readPay(ro4.id), vB = await f.state(), x1 = await f.preparePayment({ kind: 'APPROVE', paymentId: ro4.id, resourceETag: prB.etag, effectiveDate: w.today(), expectedOperationsETag: vB.operationsBookETag }, P), x2 = await f.preparePayment({ kind: 'APPROVE', paymentId: ro4.id, resourceETag: prB.etag, effectiveDate: w.today(), expectedOperationsETag: vB.operationsBookETag }, T);
            const dbl = await Promise.allSettled([x1.execute(), x2.execute()]);
            o['double approval'] = { outcomes: dbl.map(x => x.status === 'fulfilled' ? String(x.value.status) : String(x.reason.code)), receiptsAdded: await w.db.collection('loan_events').countDocuments({ organizationId: w.org, kind: 'RECEIPT' }) - e1, journalsAdded: await w.journals() - j1 };
            assert.deepEqual([o['single T SUPERVISED'], o['single T DIRECT']], ['409 preview SEGREGATION_REQUIRED', '201']);
            assert.deepEqual([o['NC01 T approves own'], o['P approves T supervised']], ['409 preview SEGREGATION_REQUIRED', '201']);
            for (const k of ['O DIRECT', 'P registers', 'A reads policy', 'A registers', 'L reads policy', 'L registers'])
                assert.match(String(o[k]), /^403 /, k);
            assert.match(String(o['NC21 C without scope']), /^404 /);
            assert.equal(o['RC12 C registers'], '201');
            assert.match(String(o['C on unscoped L2']), /^404 /);
            assert.match(String(o['NC22 P approves after revoke']), /^403 /);
            assert.deepEqual(o['NC22 state'], { status: 'PENDING', custody: 'PROVISIONAL', journalsUnchanged: true });
            assert.equal(o['RC03 custody after reject'], 'RETURN_REQUIRED');
            assert.equal(o['return by C'], '201');
            assert.deepEqual(o['custody after return'], { state: 'RETURNED', amountHeld: '0.00', journalsUnchanged: true });
            assert.deepEqual(o['RC13'], { register: '201', approve: '201', custody: 'CONFIRMED_HELD', cashC: '300000.00', centralDelta: '0.00' });
            const ar = o['approve vs reject'];
            assert.equal(ar.outcomes.filter(x => x === '201').length, 1);
            assert.equal(ar.receiptsAdded, ar.final === 'CONFIRMED' ? 1 : 0);
            const da = o['double approval'];
            assert.equal(da.outcomes.filter(x => x === '201').length, 1);
            assert.deepEqual([da.receiptsAdded, da.journalsAdded], [1, 1]);
        });
        await t.test('E3 atomicity and idempotency: injected faults at each boundary, lost response, key conflict, stale versions, revocation/dependency between preview and commit, two processes (AT07, NC08–NC10, NC16)', { skip: !only('E3') }, async (st) => {
            const w = await world(group), f = w.f, T = f.a, o = {};
            st.after(() => evidence('P06-' + st.name.slice(0, 2), { observed: o }));
            const bank = (await f.accountS06('BANK_A', 'ASSET', 'BANK')).id, cashO = (await f.accountS06('CASH_O3', 'ASSET', 'CASH')).id, held = await f.heldProfile();
            const O = await f.member('O'), P = await f.member('P');
            await f.bind(O, cashO, held);
            const L1 = await f.loan({ principal: '2000000.00' });
            await f.disburse(L1);
            const ALL = [...S5, ...S6, ...LEDGER, ...EVIDENCE, ...AUDIT];
            const pending = async (amount = '1000.00') => { const r = await w.register(await f.intent(L1, cashO, amount, O, 'CASH'), 'SUPERVISED', O); assert.equal(r.status, 201, w.st(r)); return r.id; };
            const inject = async (name, on) => { await w.db.command({ collMod: name, validator: on ? { __s06_p05_fault: { $exists: true } } : {}, validationLevel: on ? 'strict' : 'off', validationAction: 'error' }); };
            // NC16: a fault in any collection written by the approval aborts EVERYTHING; the same prepared command then succeeds once.
            const faults = {};
            for (const name of ['payments', 'payment_books', 'payment_transitions', 'payment_commands', 'payment_approvals', 'cash_custody', 'custody_movements', 'payment_event_snapshots', 'loan_events', 'loan_applications', 'loan_positions', 'financial_journals', 'lending_merkle_nodes', 'audit_events', 'identities']) {
                const pid = await pending(), pr = await w.readPay(pid), v = await f.state(), prepared = await f.preparePayment({ kind: 'APPROVE', paymentId: pid, resourceETag: pr.etag, effectiveDate: w.today(), expectedOperationsETag: v.operationsBookETag }, P);
                await f.proof(P, prepared.purpose, prepared.proofCommand, pid);
                const before = await w.digest(ALL);
                await inject(name, true);
                let failed;
                try {
                    failed = await w.settle(() => f.pay.mutate(P.issued.context, prepared.operation, w.org, prepared.payload, prepared.key, prepared.etag, pid));
                }
                finally {
                    await inject(name, false);
                }
                const unchanged = await w.digest(ALL) === before, retry = await w.settle(prepared.execute), replay = await w.settle(prepared.execute);
                faults[name] = { failed: w.st(failed), noPartialWrite: unchanged, retry: w.st(retry), replay: w.st(replay), status: (await w.readPay(pid)).status };
            }
            o['NC16 injected faults (approval)'] = faults;
            // Lost response: commit happened, client retries the exact command (200, same result), command lookup, other body with same key.
            const pid = await pending('2000.00'), pr = await w.readPay(pid), v = await f.state(), prep = await f.preparePayment({ kind: 'APPROVE', paymentId: pid, resourceETag: pr.etag, effectiveDate: w.today(), expectedOperationsETag: v.operationsBookETag }, P);
            const first = await w.settle(prep.execute), again = await w.settle(prep.execute), lookup = await w.settle(() => f.pay.read(P.issued.context, 'getPaymentCommand', w.org, prep.key)), other = await pending('3000.00');
            const conflict = await w.prepare({ kind: 'APPROVE', paymentId: other, resourceETag: (await w.readPay(other)).etag, effectiveDate: w.today(), expectedOperationsETag: (await f.state()).operationsBookETag }, P, prep.key);
            o['lost response'] = { first: w.st(first), replay: w.st(again), sameResult: JSON.stringify({ ...first.data, replayed: undefined }) === JSON.stringify({ ...again.data, replayed: undefined }), replayedFlag: again.data?.['replayed'], lookup: w.st(lookup), sameKeyOtherBody: conflict.failed ? w.st(conflict.failed) : w.st(await w.settle(conflict.prepared.execute)), receipts: await w.db.collection('loan_events').countDocuments({ organizationId: w.org, kind: 'RECEIPT', receiptReference: (await w.readPay(pid))['intent'].receiptReference }) };
            // NC08: stale resource ETag after another decision won.
            const p8 = await pending('4000.00'), pr8 = await w.readPay(p8), v8 = await f.state(), stale = await f.preparePayment({ kind: 'APPROVE', paymentId: p8, resourceETag: pr8.etag, effectiveDate: w.today(), expectedOperationsETag: v8.operationsBookETag }, P);
            o['cancel wins'] = w.st(await w.decide('cancelPayment', p8, O));
            o['NC08 stale approval'] = w.st(await w.settle(stale.execute));
            o['NC08 state'] = (await w.readPay(p8)).status;
            // NC10: approver suspended between preview and commit.
            const p10 = await pending('5000.00'), pr10 = await w.readPay(p10), v10 = await f.state(), late = await f.preparePayment({ kind: 'APPROVE', paymentId: p10, resourceETag: pr10.etag, effectiveDate: w.today(), expectedOperationsETag: v10.operationsBookETag }, P);
            const pIdentity = await f.identity.identities.findOne({ _id: P.issued.context.subjectId });
            await f.proof(T, 'MEMBER_SUSPEND', undefined, pIdentity._id);
            o['suspend P'] = w.st(await w.settle(() => f.runtime.organizations.memberCommand(T.issued.context, pIdentity._id, 'SUSPEND', pIdentity.version)));
            o['NC10 suspended approver commits'] = w.st(await w.settle(late.execute));
            o['NC10 state'] = (await w.readPay(p10)).status;
            // Dependency appearing between reversal preview and commit (APPLY_CREDIT on the same loan) must not commit the old plan.
            const L2 = await f.loan({ principal: '2000000.00' });
            await f.disburse(L2);
            const rr = await w.register({ ...await f.intent(L2, bank, '400000.00'), targets: [{ loanId: L2.id, positionETag: (await f.position(L2.id)).etag, amount: '300000.00', mode: 'REGULAR' }] }, 'DIRECT');
            const prr = await w.readPay(rr.id);
            await w.requestReversal(prr.eventId);
            const req = await f.pay.read(T.issued.context, 'getLoanEventReversalRequest', w.org, prr.eventId), vr = await f.state();
            const revPrep = await f.preparePayment({ kind: 'EXECUTE_REVERSAL', paymentId: rr.id, originalEventId: prr.eventId, resourceETag: req.etag, reversalRequestId: prr.eventId, effectiveDate: w.today(), expectedOperationsETag: vr.operationsBookETag, supportReference: 'SYN' });
            o['later APPLY_CREDIT'] = w.st(await w.applyCredit(L2.borrowerId, L2.id, '50000.00'));
            const comp0 = await w.db.collection('loan_compensations').countDocuments({});
            o['reversal with stale preview'] = w.st(await w.settle(revPrep.execute));
            o['compensations added'] = await w.db.collection('loan_compensations').countDocuments({}) - comp0;
            // Two processes: an own peer worker and this process submit the SAME approval; one 201, one 200 replay, one receipt.
            const p2 = await pending('6000.00'), pr2 = await w.readPay(p2), v2 = await f.state(), both = await f.preparePayment({ kind: 'APPROVE', paymentId: p2, resourceETag: pr2.etag, effectiveDate: w.today(), expectedOperationsETag: v2.operationsBookETag }, T);
            await f.proof(T, both.purpose, both.proofCommand, p2);
            await f.restore.flush();
            const peer = await group.peer({ keys: Object.fromEntries(Object.entries(f.keys).filter(([, x]) => Buffer.isBuffer(x)).map(([k, x]) => [k, x.toString('base64')])), now: f.now(), config: f.config });
            try {
                const out = await Promise.all([w.settle(() => f.pay.mutate(T.issued.context, both.operation, w.org, both.payload, both.key, both.etag, p2)), peer.execute({ operation: both.operation, organizationId: w.org, token: T.issued.token, payload: both.payload, key: both.key, etag: both.etag, resourceId: p2 })]);
                o['two processes'] = { statuses: [out[0].status, Number(out[1]['status'])].sort(), receipts: await w.db.collection('loan_events').countDocuments({ organizationId: w.org, kind: 'RECEIPT', receiptReference: pr2['intent'].receiptReference }), peerPid: out[1]['pid'] };
            }
            finally {
                await peer.close();
            }
            for (const [name, v] of Object.entries(faults)) {
                const x = v;
                assert.ok(!x.failed.startsWith('2'), name + ' must fail');
                assert.equal(x.noPartialWrite, true, name);
                assert.deepEqual([x.retry, x.replay, x.status], ['201', '200', 'CONFIRMED'], name);
            }
            const lr = o['lost response'];
            assert.deepEqual([lr['first'], lr['replay'], lr['sameResult'], lr['lookup'], lr['receipts']], ['201', '200', true, '200', 1]);
            assert.match(String(lr['sameKeyOtherBody']), /409 .*IDEMPOTENCY_CONFLICT|IDEMPOTENCY_CONFLICT/);
            assert.match(String(o['NC08 stale approval']), /^(409|412) /);
            assert.equal(o['NC08 state'], 'CANCELLED');
            assert.match(String(o['NC10 suspended approver commits']), /^(401|403) /);
            assert.equal(o['NC10 state'], 'PENDING');
            assert.notEqual(o['reversal with stale preview'], '201');
            assert.equal(o['compensations added'], 0);
            assert.deepEqual(o['two processes'].statuses, [200, 201]);
            assert.equal(o['two processes'].receipts, 1);
        });
        await t.test('E4 reconciliation: declared 1:1, mismatches, duplicates, link conflicts, unlink, void, reversal of reconciled (AT06, RC07, NC05/NC06/NC19/NC20)', { skip: !only('E4') }, async (st) => {
            const w = await world(group), f = w.f, o = {};
            st.after(() => evidence('P06-' + st.name.slice(0, 2), { observed: o }));
            const bank = (await f.accountS06('BANK_C', 'ASSET', 'BANK')).id, bank2 = (await f.accountS06('BANK_D', 'ASSET', 'BANK')).id, cashT = (await f.accountS06('CASH_T4', 'ASSET', 'CASH')).id, held = await f.heldProfile();
            await f.bind(f.a, cashT, held);
            const L1 = await f.loan({ principal: '2000000.00' });
            await f.disburse(L1);
            const r1 = await w.register(await f.intent(L1, bank, '100000.00'), 'DIRECT'), p1 = await w.readPay(r1.id), ref = String(p1['intent'].receiptReference), date = String(p1['intent'].observedDate);
            const money0 = await w.digest([...S5, ...LEDGER, 'cash_custody', 'held_funds_reservations']);
            const dOk = await w.declare(bank, '100000.00', date, ref, 'LINE-1');
            o['declare'] = w.st(dOk);
            const dId = String(dOk.data['entityId']);
            o['NC19 same line other key'] = w.st(await w.declare(bank, '100000.00', date, ref, 'LINE-1'));
            o['NC19 same content other line'] = w.st(await w.declare(bank, '100000.00', date, ref, 'LINE-1B'));
            const dAmt = await w.declare(bank, '100000.01', date, ref, 'LINE-2'), dAcc = await w.declare(bank2, '100000.00', date, ref, 'LINE-3'), dRef = await w.declare(bank, '100000.00', date, ref + 'X', 'LINE-4');
            o['NC05 amount'] = w.st(await w.link(r1.id, String(dAmt.data['entityId'])));
            o['NC05 account'] = w.st(await w.link(r1.id, String(dAcc.data['entityId'])));
            o['NC05 reference'] = w.st(await w.link(r1.id, String(dRef.data['entityId'])));
            o['RC07 link'] = w.st(await w.link(r1.id, dId));
            const linked = await w.readPay(r1.id);
            o['RC07 state'] = { reconciliation: linked.reconciliationState, status: linked.status, linkId: Boolean(linked['currentReconciliationLinkId']), declaration: (await w.declaration(dId))['state'] ?? (await w.declaration(dId))['status'], noMoneyChange: await w.digest([...S5, ...LEDGER, 'cash_custody', 'held_funds_reservations']) === money0 };
            // NC06: second payment competing for the same line; same payment linked twice.
            const L2 = await f.loan({ principal: '2000000.00' });
            await f.disburse(L2);
            const r2 = await w.register(await f.intent(L2, bank, '100000.00'), 'DIRECT');
            o['NC06 other payment same line'] = w.st(await w.link(r2.id, dId));
            o['NC06 relink same payment'] = w.st(await w.link(r1.id, String(dRef.data['entityId'])));
            o['void linked'] = w.st(await w.voidDecl(dId));
            // NC20: reversal of a reconciled payment requires unlink first.
            const req = await w.requestReversal(p1.eventId);
            o['NC20 request'] = w.st(req);
            o['NC20 execute while linked'] = w.st(await w.executeReversal(p1.eventId, r1.id));
            o['unlink'] = w.st(await w.unlink(r1.id, dId));
            const un = await w.readPay(r1.id);
            o['after unlink'] = { reconciliation: un.reconciliationState, declaration: (await w.declaration(dId))['state'] ?? (await w.declaration(dId))['status'] };
            o['reversal after unlink'] = w.st(await w.executeReversal(p1.eventId, r1.id));
            o['link to REVERSED'] = w.st(await w.link(r1.id, dId));
            // CASH and PENDING payments are not eligible.
            const rc = await w.register(await f.intent(L1, cashT, '1000.00', f.a, 'CASH'), 'DIRECT');
            o['link CASH'] = w.st(await w.link(rc.id, String(dAmt.data['entityId'])));
            // Dispositions: DISCREPANCY → INVESTIGATION → PENDING; link straight from DISCREPANCY (contract: link needs reconciliation PENDING).
            const r3 = await w.register(await f.intent(L1, bank, '55555.00'), 'DIRECT'), p3 = await w.readPay(r3.id), d3 = await w.declare(bank, '55555.00', String(p3['intent'].observedDate), String(p3['intent'].receiptReference), 'LINE-5');
            o['dispose DISCREPANCY'] = w.st(await w.dispose(r3.id, 'DISCREPANCY'));
            o['link from DISCREPANCY'] = w.st(await w.link(r3.id, String(d3.data['entityId'])));
            o['state after link from DISCREPANCY'] = (await w.readPay(r3.id)).reconciliationState;
            o['void unlinked'] = w.st(await w.voidDecl(String(dAcc.data['entityId'])));
            o['link VOID declaration'] = w.st(await w.link(r2.id, String(dAcc.data['entityId'])));
            o['journals: links/declarations add none'] = { compensationJournals: await w.journals({ 'source.type': 'LOAN_COMPENSATION' }) };
            assert.equal(o['declare'], '201');
            assert.equal(o['NC19 same line other key'], '409 BANK_DECLARATION_DUPLICATE');
            assert.equal(o['NC19 same content other line'], '409 BANK_DECLARATION_DUPLICATE');
            for (const k of ['NC05 amount', 'NC05 account', 'NC05 reference'])
                assert.equal(o[k], '409 RECONCILIATION_MISMATCH', k);
            assert.equal(o['RC07 link'], '201');
            assert.deepEqual(o['RC07 state'], { reconciliation: 'RECONCILED', status: 'CONFIRMED', linkId: true, declaration: 'LINKED', noMoneyChange: true });
            assert.equal(o['NC06 other payment same line'], '409 LINK_CONFLICT');
            assert.equal(o['NC06 relink same payment'], '409 LINK_CONFLICT');
            assert.match(String(o['void linked']), /^409 /);
            assert.match(String(o['NC20 execute while linked']), /409 .*STATE_CONFLICT/);
            assert.equal(o['unlink'], '201');
            assert.deepEqual(o['after unlink'], { reconciliation: 'PENDING', declaration: 'AVAILABLE' });
            assert.equal(o['reversal after unlink'], '201');
            assert.match(String(o['link to REVERSED']), /^409 /);
            assert.match(String(o['link CASH']), /^409 /);
            assert.match(String(o['link VOID declaration']), /^409 /);
        });
        await t.test('E5 tenants, roles, B/PLATFORM, W classes (WORK_ONLY / BALANCE_60M 60 min / SECURITY_ONE_SHOT), HTTP transport (AT08/AT09, NC07, NC12)', { skip: !only('E5') }, async (st) => {
            const w = await world(group), f = w.f, T = f.a, o = {};
            st.after(() => evidence('P06-' + st.name.slice(0, 2), { observed: o }));
            const bank = (await f.accountS06('BANK_T', 'ASSET', 'BANK')).id, cashT = (await f.accountS06('CASH_T5', 'ASSET', 'CASH')).id, held = await f.heldProfile();
            await f.bind(T, cashT, held);
            const O = await f.member('O');
            const L1 = await f.loan({ principal: '2000000.00' });
            await f.disburse(L1);
            const r1 = await w.register(await f.intent(L1, bank, '100000.00'), 'DIRECT'), p1 = await w.readPay(r1.id), dA = await w.declare(bank, '100000.00', String(p1['intent'].observedDate), 'X-' + randomUUID().slice(0, 6), 'L-A');
            const rc = await w.register(await f.intent(L1, cashT, '1000.00', T, 'CASH'), 'DIRECT');
            // Second tenant in the same database (B with its own org/account) probes A's resources by id.
            const B = await f.tenant(await f.newActor()), bctx = B.actor.issued.context, cross = {};
            for (const [n, op, id] of [['payment', 'getPayment', r1.id], ['custody', 'getCashCustody', rc.id], ['declaration', 'getBankDeclaration', String(dA.data['entityId'])], ['reversal request', 'getLoanEventReversalRequest', p1.eventId], ['command', 'getPaymentCommand', String(r1.data['commandKey'])], ['binding', 'getCustodyBinding', T.issued.context.subjectId]])
                cross['B own org, A ' + n] = w.st(await w.settle(() => w.pay.read(bctx, op, B.org, id)));
            cross['B reads A org policy'] = w.st(await w.settle(() => w.pay.read(bctx, 'getPaymentsPolicy', w.org)));
            cross['B lists in own org'] = String((await w.pay.read(bctx, 'listPayments', B.org)).data.items.length);
            cross['B preview with A loan/account'] = w.st(await w.settle(async () => { const st = (await w.pay.read(bctx, 'getPaymentsState', B.org)).data; return await w.pay.preview(bctx, B.org, { executionKey: randomUUID(), expectedPaymentsETag: st.paymentsBookETag, command: { kind: 'REGISTER', mode: 'DIRECT', effectiveDate: w.today(), intent: await f.intent(L1, bank, '1000.00') } }); }));
            o['NC07 cross-tenant'] = cross;
            // B (email not confirmed) and PLATFORM sessions.
            const basic = await f.signup();
            o['B session'] = w.st(await w.settle(() => w.pay.read(basic.issued.context, 'getPaymentsPolicy', w.org)));
            const platform = await f.sessions.issue('PLATFORM', 'P', null);
            o['PLATFORM session'] = w.st(await w.settle(() => w.pay.read(platform.context, 'getPaymentsPolicy', w.org)));
            // WORK_ONLY: supervised registration by O needs no factor at all (direct service call without any proof).
            const intentO = await f.intent(L1, bank, '2000.00', O), st0 = await f.state(), kO = randomUUID(), pvO = await w.pay.preview(O.issued.context, w.org, { executionKey: kO, expectedPaymentsETag: st0.paymentsBookETag, command: { kind: 'REGISTER', mode: 'SUPERVISED', effectiveDate: w.today(), intent: intentO } });
            o['WORK_ONLY register without factor'] = w.st(await w.settle(() => w.pay.mutate(O.issued.context, 'registerPayment', w.org, { command: { kind: 'REGISTER', mode: 'SUPERVISED', effectiveDate: w.today(), intent: intentO }, previewToken: pvO.data.token }, kO, st0.paymentsBookETag)));
            // BALANCE_60M: fresh login without grant → R_REQUIRED; after one grant: OK at +59 min, R_REQUIRED after 60 min (reads keep the session alive, grant does not extend).
            const login = await f.identity.login('TENANT', randomUUID(), T.email, (await import('./review-profile.js')).password);
            const fresh = { ...T, issued: login.issued };
            const hb = await f.https();
            const heartbeat = async (actor) => { const cl = new (await import('../../helpers/client.js')).ApiClient(hb.port, hb.cert); cl.cookies.set('__Host-caudelyx-session', actor.issued.token); await cl.refreshCsrf(); const r = await cl.call('POST', '/api/v1/auth/session/activity', {}); return r.status; };
            const direct = async (actor, amount) => { const pr = await w.prepare({ kind: 'REGISTER', mode: 'DIRECT', effectiveDate: w.today(), intent: await f.intent(L1, bank, amount) }, actor, randomUUID()); if (pr.failed)
                return pr.failed; return await w.settle(() => f.pay.mutate(actor.issued.context, pr.prepared.operation, w.org, pr.prepared.payload, pr.prepared.key, pr.prepared.etag)); };
            o['DIRECT fresh session without grant'] = w.st(await direct(fresh, '1001.00'));
            const grantPrep = await w.prepare({ kind: 'REGISTER', mode: 'DIRECT', effectiveDate: w.today(), intent: await f.intent(L1, bank, '1002.00') }, fresh, randomUUID());
            await f.proof(fresh, grantPrep.prepared.purpose, grantPrep.prepared.proofCommand);
            o['DIRECT with grant'] = w.st(await w.settle(() => f.pay.mutate(fresh.issued.context, grantPrep.prepared.operation, w.org, grantPrep.prepared.payload, grantPrep.prepared.key, grantPrep.prepared.etag)));
            const grant = (await f.sessions.contexts.findOne({ _id: fresh.issued.context._id }))?.['balanceGrant'];
            o['grant window'] = grant ? Math.round((grant.expiresAt - f.now()) / 60000) : 'no grant field';
            const beats = [];
            const touch = async () => { beats.push(await heartbeat(fresh), await heartbeat(T)); };
            f.clock.value += 30 * 60000;
            await touch();
            f.clock.value += 29 * 60000;
            await touch();
            o['DIRECT at +59 min'] = w.st(await direct(fresh, '1003.00'));
            f.clock.value += 60000 + 1000;
            await touch();
            o['activity heartbeats'] = beats;
            o['DIRECT at +60 min 1 s'] = w.st(await direct(fresh, '1004.00'));
            o['session still valid for reads'] = w.st(await w.settle(() => w.pay.read(fresh.issued.context, 'getPaymentsState', w.org)));
            // SECURITY_ONE_SHOT: one proof → one binding change; a second change or another operation needs a new proof.
            const O2 = await f.member('O'), cashX = (await f.accountS06('CASH_X', 'ASSET', 'CASH')).id, cashRead = await f.runtime.finance.read(T.issued.context, 'readAccount', w.org, cashX), heldRead = await f.runtime.finance.read(T.issued.context, 'readAccount', w.org, held);
            const bindPayload = { custodianId: O2.issued.context.subjectId, accountId: cashX, accountETag: cashRead.etag, heldLiabilityAccountId: held, heldLiabilityAccountETag: heldRead.etag, resourceETag: `"${O2.issued.context.subjectId}:binding:0"`, supportReference: 'SYN-ONE' };
            const sv = await f.state(), k1 = randomUUID(), cmd = { organizationId: w.org, idempotencyKey: k1, expectedETag: sv.paymentsBookETag, operationId: 'setCustodyBinding', resourceId: null, payload: bindPayload };
            await f.proof(T, 'CUSTODY_BINDING_SET', cmd);
            o['one-shot first use'] = w.st(await w.settle(() => f.pay.mutate(T.issued.context, 'setCustodyBinding', w.org, bindPayload, k1, sv.paymentsBookETag)));
            const sv2 = await f.state(), b2 = await w.pay.read(T.issued.context, 'getCustodyBinding', w.org, O2.issued.context.subjectId);
            o['one-shot reuse for another change'] = w.st(await w.settle(() => f.pay.mutate(T.issued.context, 'setCustodyBinding', w.org, { ...bindPayload, resourceETag: b2.etag, supportReference: 'SYN-TWO' }, randomUUID(), sv2.paymentsBookETag)));
            // Proof bound to the payload: a proof for scope X does not authorize scope Y.
            const C = await f.member('C'), sv3 = await f.state(), sx = randomUUID(), sy = randomUUID(), scopeX = { scopeId: sx, registrarId: C.issued.context.subjectId, loanId: L1.id, scope: 'PAYMENT_REGISTER_ONLY', active: true, resourceETag: `"${sx}:0"`, supportReference: 'SYN-X' }, kx = randomUUID();
            await f.proof(T, 'PAYMENT_REGISTRATION_SCOPE_SET', { organizationId: w.org, idempotencyKey: kx, expectedETag: sv3.paymentsBookETag, operationId: 'setPaymentRegistrationScope', resourceId: null, payload: scopeX });
            o['proof for scope X used on scope Y'] = w.st(await w.settle(() => f.pay.mutate(T.issued.context, 'setPaymentRegistrationScope', w.org, { ...scopeX, scopeId: sy, resourceETag: `"${sy}:0"` }, kx, sv3.paymentsBookETag)));
            // HTTP transport on the real app: CSRF, Origin, If-Match, GET with body; responses only through the S6 layer.
            const client = new (await import('../../helpers/client.js')).ApiClient(hb.port, hb.cert);
            client.cookies.set('__Host-caudelyx-session', T.issued.token);
            const base = `/api/v1/organizations/${w.org}`;
            const raw = async (method, path, body, headers = {}) => { const r = await client.call(method, base + path, body, headers); return `${r.status}${r.body?.error?.code ? ' ' + r.body.error.code : ''}`; };
            o['HTTP GET payment'] = await raw('GET', '/payments/' + r1.id);
            o['HTTP POST without CSRF'] = await raw('POST', '/payments/' + r1.id + '/reject', { resourceETag: p1.etag, reason: 'x', supportReference: 'y' }, { 'X-CSRF-Token': 'invalid', 'Idempotency-Key': randomUUID(), 'If-Match': (await f.state()).paymentsBookETag });
            for (const [k, v] of Object.entries(cross))
                if (k !== 'B lists in own org')
                    assert.match(v, /^(403|404) /, k);
            assert.equal(cross['B lists in own org'], '0');
            assert.match(String(o['B session']), /^(401|403) /);
            assert.match(String(o['PLATFORM session']), /^(401|403) /);
            assert.equal(o['WORK_ONLY register without factor'], '201');
            assert.equal(o['DIRECT fresh session without grant'], '403 R_REQUIRED');
            assert.equal(o['DIRECT with grant'], '201');
            assert.equal(o['DIRECT at +59 min'], '201');
            assert.equal(o['DIRECT at +60 min 1 s'], '403 R_REQUIRED');
            assert.equal(o['session still valid for reads'], '200');
            assert.equal(o['one-shot first use'], '201');
            assert.equal(o['one-shot reuse for another change'], '403 R_REQUIRED');
            assert.match(String(o['proof for scope X used on scope Y']), /^403 /);
        });
        await t.test('E6 integrity and restore of S6 sources: online tampering fails closed, offline tampering closes restart, exact revert reopens, old cut refused (AT10, NC15)', { skip: !only('E6') }, async (st) => {
            const w = await world(group), f = w.f, o = {};
            st.after(() => evidence('P06-' + st.name.slice(0, 2), { observed: o }));
            const bank = (await f.accountS06('BANK_E', 'ASSET', 'BANK')).id, cashO = (await f.accountS06('CASH_O6', 'ASSET', 'CASH')).id, held = await f.heldProfile();
            const O = await f.member('O'), P = await f.member('P');
            await f.bind(O, cashO, held);
            const L1 = await f.loan({ principal: '2000000.00' });
            await f.disburse(L1);
            const earlier = await f.restore.snapshot();
            const L3 = await f.loan({ principal: '2000000.00' });
            await f.disburse(L3);
            const pend = await w.register(await f.intent(L3, cashO, '300000.00', O, 'CASH'), 'SUPERVISED', O);
            const r1 = await w.register(await f.intent(L1, bank, '100000.00'), 'DIRECT'), p1 = await w.readPay(r1.id), d1 = await w.declare(bank, '100000.00', String(p1['intent'].observedDate), String(p1['intent'].receiptReference), 'L-E6');
            assert.equal((await w.link(r1.id, String(d1.data['entityId']))).status, 201);
            const L2 = await f.loan({ principal: '2000000.00' });
            await f.disburse(L2);
            const r2 = await w.register(await f.intent(L2, bank, '300000.00'), 'DIRECT'), p2 = await w.readPay(r2.id);
            assert.equal((await w.reverseAll(p2.eventId, r2.id)).execute?.status, 201);
            // Online: tamper a pending payment amount / custody amount / held reservation; the next command or read fails closed; exact revert recovers.
            const online = {};
            for (const [label, coll, filter, change, probe] of [
                ['pending payment amount', 'payments', { _id: pend.id }, { 'intent.amount': '1.00' }, async () => w.st(await w.approve(pend.id, P))],
                ['custody amountHeld', 'cash_custody', { paymentId: pend.id }, { amountHeld: '1.00' }, async () => w.st(await w.settle(() => w.pay.read(O.issued.context, 'getCashCustody', w.org, pend.id)))],
                ['held reservation amount', 'held_funds_reservations', {}, { amount: '1.00' }, async () => w.st(await w.transfer(bank, f.account, '1.00'))],
                ['compensation creditDelta', 'loan_compensations', {}, { creditDelta: '9.99' }, async () => w.st(await w.settle(() => f.position(L2.id)))],
            ]) {
                const row = await w.db.collection(coll).findOne({ organizationId: w.org, ...filter });
                assert.ok(row, label);
                const safe = async () => { try {
                    return await probe();
                }
                catch (e) {
                    return `${String(e.status ?? 'throw')} ${String(e.code ?? e.message)}`;
                } };
                await w.db.collection(coll).updateOne({ _id: row['_id'] }, { $set: change });
                const tampered = await safe();
                await w.db.collection(coll).replaceOne({ _id: row['_id'] }, row);
                online[label] = { tampered, afterExactRevert: await safe() };
            }
            o['NC15 online tampering'] = online;
            // Offline: each S6 source edited at rest closes the realm on restart; the exact revert reopens.
            await f.restore.flush();
            const { RestoreController } = await import('../../../src/shared/restore.js');
            const controller = async () => { const c2 = new RestoreController(f.database, f.restore.gatePath, f.keys.journal, f.keys.priority); await c2.initialize(); return c2; };
            const restart = async () => (await controller()).isOpen();
            const offline = { baseline: await restart() };
            for (const [coll, field, value] of [['payments', 'status', 'REJECTED'], ['payment_transitions', 'operation', 'x'], ['cash_custody', 'amountHeld', '0.00'], ['custody_bindings', 'accountId', randomUUID()], ['payment_event_snapshots', 'creditBefore', '1.00'], ['loan_compensations', 'creditDelta', '1.00'], ['held_funds_reservations', 'amount', '1.00'], ['bank_declarations', 'amount', '1.00'], ['reconciliation_events', 'operation', 'x'], ['payment_reversal_requests', 'state', 'REJECTED'], ['payment_registration_scopes', 'active', false], ['held_funds_profiles', 'accountId', randomUUID()]]) {
                const row = await w.db.collection(coll).findOne({ organizationId: w.org });
                if (!row) {
                    offline[coll] = 'no row in this world';
                    continue;
                }
                await w.db.collection(coll).updateOne({ _id: row['_id'] }, { $set: { [field]: value } });
                const c1 = await controller(), closed = c1.isOpen();
                let rec = 'reconciled';
                try {
                    await c1.reconcile({ approved: true, reviewId: 'S06_P05_TAMPERED' });
                }
                catch (e) {
                    rec = String(e.code ?? 'refused');
                }
                await w.db.collection(coll).replaceOne({ _id: row['_id'] }, row);
                const c2 = await controller();
                if (!c2.isOpen())
                    await c2.reconcile({ approved: true, reviewId: 'S06_P05_EXACT_REVERT' });
                offline[coll] = { openWhileTampered: closed, reconcileWhileTampered: rec, openAfterExactRevert: c2.isOpen() };
            }
            o['offline tampering'] = offline;
            // Restore to an older cut (before the S6 events) is refused; the realm stays closed.
            await f.restore.beginRestore(earlier);
            o['old cut reconcile'] = w.st(await w.settle(async () => { await f.restore.reconcile({ approved: true, reviewId: 'S06_P05_OLD_CUT_NEGATIVE' }); return { status: 200 }; }));
            o['old cut open'] = f.restore.isOpen();
            for (const [k, v] of Object.entries(online)) {
                const x = v;
                assert.match(x.tampered, /^503 /, k);
                assert.match(x.afterExactRevert, /^(200|201)/, k);
            }
            assert.equal(offline['baseline'], true);
            for (const [k, v] of Object.entries(offline))
                if (k !== 'baseline' && typeof v === 'object')
                    assert.deepEqual(v, { openWhileTampered: false, reconcileWhileTampered: 'SERVICE_UNAVAILABLE', openAfterExactRevert: true }, k);
            assert.match(String(o['old cut reconcile']), /^503 /);
            assert.equal(o['old cut open'], false);
        });
    }
    finally {
        await group.dispose();
    }
});
//# sourceMappingURL=review.test.js.map