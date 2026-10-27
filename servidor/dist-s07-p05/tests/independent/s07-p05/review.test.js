/* eslint-disable security/detect-object-injection -- Own fixed account/label maps of this review, never request input. */
// S07-P05 independent runtime review (Claude) of S07-P04-v1-INTEGRADO on ONE own group (c7418e494256ed8508afd19e).
// Each subtest starts a fresh world in the same group; money expectations come only from the own oracle.
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { s07Profile } from './review-profile.js';
import { world, mm, toC, S5, S6, S7, LEDGER, EVIDENCE, AUDIT } from './review-fixtures.js';
import { S7Book, c, m, terms } from './oracle.js';
const evidence = (name, d) => console.log(JSON.stringify({ evidence: name, ...d }));
const only = (name) => !process.env['P05_ONLY'] || process.env['P05_ONLY'].split(',').some(x => name.startsWith(x));
async function journalOf(w, journalId, label) {
    const j = await w.db.collection('financial_journals').findOne({ _id: journalId, organizationId: w.org });
    const t = new Map();
    for (const l of (j?.['lines'] ?? []))
        t.set(l.accountId, (t.get(l.accountId) ?? 0n) + toC(l.debit) - toC(l.credit));
    return [...t].filter(([, v]) => v !== 0n).map(([a, v]) => ({ account: label.get(a) ?? 'UNKNOWN', debit: v > 0n ? mm(v) : '0.00', credit: v < 0n ? mm(-v) : '0.00' })).sort((a, b) => a.account.localeCompare(b.account));
}
const rows = (p) => p.map(x => ({ account: x.account, debit: m(x.debit), credit: m(x.credit) })).sort((a, b) => a.account.localeCompare(b.account));
/** World + oracle replicating the canonical cashSetup (C 300k confirmed by T on loan l, CASH_S07 bound to C, CENTRAL_S07 station of O). */
async function scenario(group) {
    const w = await world(group), f = w.f, T0 = w.today(), book = new S7Book('HELD');
    book.fund('FUND', c('20000000.00'));
    book.addLoan(f.l.id, f.l.borrowerId, terms());
    book.disburse(f.l.id, 'FUND');
    book.register(f.paymentId, { method: 'CASH', mode: 'SUPERVISED', borrower: f.l.borrowerId, amount: c('300000.00'), account: 'CASH_C', targets: [{ loan: f.l.id, amount: c('300000.00'), mode: 'REGULAR' }], excess: 'CREDIT', registrar: 'C', custodian: 'C' }, T0);
    book.approve(f.paymentId, 'T', T0);
    book.lot(f.paymentId, 'CASH_C', c('300000.00'));
    const label = new Map([[f.profile.principalAccountId, 'PRINCIPAL'], [f.profile.interestReceivableAccountId, 'INTEREST_RECEIVABLE'], [f.profile.interestIncomeAccountId, 'INTEREST_INCOME'], [f.profile.borrowerCreditAccountId, 'BORROWER_CREDIT'], [f.held, 'HELD'], [f.cash.id, 'CASH_C'], [f.central.id, 'CENTRAL'], [f.account, 'FUND']]);
    const C = f.c.issued.context.subjectId, O = f.o.issued.context.subjectId;
    const pos = async (who) => await w.position(who === 'C' ? C : O, who === 'C' ? f.cash.id : f.central.id, f.a);
    const exp = (who) => book.position(who === 'C' ? 'CASH_C' : 'CENTRAL');
    const wholeLedger = async () => { const lg = await w.ledger(), out = {}; for (const [id, n] of label)
        out[n] = { server: mm(lg.get(id) ?? 0n), oracle: m(book.balances.get(n) ?? 0n) }; return out; };
    return { w, f, book, label, T0, C, O, pos, exp, wholeLedger };
}
test('P07-S7 runtime review on one own group', { timeout: 3600000 }, async (t) => {
    const group = await s07Profile();
    try {
        await t.test('G1 money chain 300→250+50, reserves/location, compensation and FUNDS_NOT_HELD, BANK no custody, S6 reversal dependency == own oracle (AT03/AT04/AT07)', { skip: !only('G1') }, async (st) => {
            const { w, f, book, label, pos, exp, wholeLedger } = await scenario(group), o = {};
            st.after(() => evidence('P07-G1', { observed: o }));
            const cmp = async (step) => { o[step] = { C: { server: await pos('C'), oracle: exp('C') }, O: { server: await pos('O'), oracle: exp('O') } }; };
            // Free money from other operations on both cash accounts (detects double counting of reserves).
            assert.equal((await w.transfer(f.account, f.cash.id, '40000.00')).status, 201);
            book.spend('FUND', c('40000.00'), 'CASH_C');
            assert.equal((await w.transfer(f.account, f.central.id, '10000.00')).status, 201);
            book.spend('FUND', c('10000.00'), 'CENTRAL');
            await cmp('0 after cobro + free money');
            const r = await w.request('250000.00');
            assert.equal(r.status, 201, w.st(r));
            const did = r.id;
            book.request(did, 'CASH_C', 'CENTRAL', [{ lot: f.paymentId, amount: c('250000.00') }]);
            await cmp('1 REQUESTED 250');
            o['1 C spends 40000.01 of own free money'] = w.st(await w.transfer(f.cash.id, f.account, '40000.01'));
            o['1 C spends 40000.00 free'] = w.st(await w.transfer(f.cash.id, f.account, '40000.00'));
            book.spend('CASH_C', c('40000.00'), 'FUND');
            o['1 second request of the remaining 50.01 (over uncommitted)'] = w.st(await w.request('50000.01'));
            assert.equal((await w.act('dispatchCashDelivery', did, f.c)).status, 201);
            book.dispatch(did);
            await cmp('2 IN_TRANSIT');
            assert.equal((await w.act('receiveCashDelivery', did, f.o)).status, 201);
            book.receive(did);
            await cmp('3 RECEIVED');
            assert.equal((await w.count(did, '250000.00')).status, 201);
            book.count(did, c('250000.00'));
            await cmp('4 COUNTED exact');
            const j0 = await w.journals(), led0 = await wholeLedger();
            const cf = await w.confirm(did);
            assert.equal(cf.status, 201, w.st(cf));
            const post = book.confirmDelivery(did);
            const d1 = await w.delivery(did);
            o['5 confirm journal'] = { server: await journalOf(w, String(d1.journalId), label), oracle: rows(post.map(x => ({ ...x, account: x.account === 'CASH_C' ? 'CASH_C' : x.account }))), journalsAdded: await w.journals() - j0 };
            await cmp('5 CONFIRMED');
            const led1 = await wholeLedger();
            o['5 untouched accounts'] = Object.fromEntries(['PRINCIPAL', 'INTEREST_RECEIVABLE', 'INTEREST_INCOME', 'BORROWER_CREDIT', 'HELD'].map(n => [n, led0[n].server === led1[n].server]));
            // S6 reversal of the source CASH receipt is blocked while delivered net > 0.
            const pay = (await f.readPayment(f.paymentId)).data;
            const rev1 = await w.settle(async () => (await f.reverse(pay.eventId, f.paymentId)).execute());
            o['6 S6 reversal with confirmed delivery'] = w.st(rev1);
            // Compensation with only 200k free on CENTRAL → FUNDS_NOT_HELD, nothing created.
            assert.equal((await w.transfer(f.central.id, f.account, '60000.00')).status, 201);
            book.spend('CENTRAL', c('60000.00'), 'FUND');
            const dd = await w.digest([...S7, ...LEDGER]);
            const nf = await w.compensate(did);
            o['7 compensation with 200k free'] = { status: w.st(nf), noEffect: await w.digest([...S7, ...LEDGER]) === dd };
            try {
                book.compensate('x', did);
                o['7 oracle'] = 'accepted?';
            }
            catch (e) {
                o['7 oracle'] = e.code;
            }
            assert.equal((await w.transfer(f.account, f.central.id, '60000.00')).status, 201);
            book.spend('FUND', c('60000.00'), 'CENTRAL');
            const cr = await w.compensate(did);
            assert.equal(cr.status, 201, w.st(cr));
            const cid = cr.id;
            book.compensate(cid, did);
            await cmp('8 COMPENSATION REQUESTED');
            o['8 CENTRAL spends 10000.01 (only 10000 free besides Rcomp)'] = w.st(await w.transfer(f.central.id, f.account, '10000.01'));
            o['8 second compensation of the same delivery'] = w.st(await w.compensate(did));
            assert.equal((await w.act('dispatchCashDelivery', cid, f.o)).status, 201);
            book.dispatch(cid);
            assert.equal((await w.act('receiveCashDelivery', cid, f.c)).status, 201);
            book.receive(cid);
            assert.equal((await w.count(cid, '250000.00', f.c)).status, 201);
            book.count(cid, c('250000.00'));
            const cc = await w.confirm(cid, true);
            assert.equal(cc.status, 201, w.st(cc));
            const post2 = book.confirmDelivery(cid);
            const d2 = await w.delivery(cid);
            o['9 compensation journal'] = { server: await journalOf(w, String(d2.journalId), label), oracle: rows(post2), originalJournalIntact: (await w.db.collection('financial_journals').countDocuments({ _id: d1.journalId })) === 1 };
            await cmp('9 COMPENSATED');
            // After complete compensation the S6 reversal is allowed and converts Rconf into HELD once.
            const rev2 = await w.settle(async () => (await f.reverse(pay.eventId, f.paymentId)).execute());
            o['10 S6 reversal after compensation'] = w.st(rev2);
            if (rev2.status === 201) {
                book.reverse(book.payments.get(f.paymentId).eventSeq, w.today());
                book.lots.delete(f.paymentId);
            }
            await cmp('10 after S6 reversal (HELD)');
            // BANK direct: no custody lot, no position change on cash accounts.
            const L2 = await f.loan({ principal: '2000000.00' });
            await f.disburse(L2);
            book.addLoan(L2.id, L2.borrowerId, terms());
            book.disburse(L2.id, 'FUND');
            const bank = (await f.accountS06('BANK_S7', 'ASSET', 'BANK')).id;
            label.set(bank, 'BANK');
            const rb = await w.settle(async () => (await f.preparePayment({ kind: 'REGISTER', mode: 'DIRECT', effectiveDate: w.today(), intent: await f.intent(L2, bank, '100000.00') })).execute());
            book.register('pb', { method: 'BANK', mode: 'DIRECT', borrower: L2.borrowerId, amount: c('100000.00'), account: 'BANK', targets: [{ loan: L2.id, amount: c('100000.00'), mode: 'REGULAR' }], excess: 'CREDIT', registrar: 'T', custodian: null }, w.today());
            o['11 BANK direct'] = { status: w.st(rb), custodyRows: await w.db.collection('cash_custody').countDocuments({ organizationId: w.org, paymentId: rb.data?.['entityId'] }) };
            o['12 whole ledger vs oracle'] = await wholeLedger();
            for (const k of Object.keys(o).filter(k => /^\d+ [A-Z0-9 ]/.test(k) && typeof o[k] === 'object' && o[k] && 'C' in o[k])) {
                const v = o[k];
                assert.deepEqual(v.C.server, v.C.oracle, k + ' C');
                assert.deepEqual(v.O.server, v.O.oracle, k + ' O');
            }
            assert.deepEqual(o['5 confirm journal'].server, o['5 confirm journal'].oracle);
            assert.deepEqual(o['9 compensation journal'].server, o['9 compensation journal'].oracle);
            for (const [n, v] of Object.entries(o['12 whole ledger vs oracle']))
                assert.equal(v.server, v.oracle, n);
            assert.equal(o['1 C spends 40000.01 of own free money'], '409 ACCOUNT_OVERDRAFT');
            assert.match(String(o['6 S6 reversal with confirmed delivery']), /REVERSAL_DEPENDENCY/);
            assert.deepEqual(o['7 compensation with 200k free'], { status: '409 preview FUNDS_NOT_HELD', noEffect: true });
        });
        await t.test('G2 discrepancy 230/270, investigation→recount→ack→correction→confirm, returns (received / non-receipt), cancel, oracle positions (AT05)', { skip: !only('G2') }, async (st) => {
            const s = await scenario(group), { w, f, book, label } = s, o = {};
            st.after(() => evidence('P07-G2', { observed: o }));
            const cmp = async (step) => { o[step] = { C: { server: await s.pos('C'), oracle: s.exp('C') }, O: { server: await s.pos('O'), oracle: s.exp('O') } }; };
            const raw = async (op, id, actor, payload) => { const d = await f.readCollections('getCashDelivery', id); return await w.settle(() => f.mutateCollections(op, { resourceETag: d.etag, ...payload }, id, actor)); };
            const r = await w.request('250000.00'), id = r.id;
            book.request(id, 'CASH_C', 'CENTRAL', [{ lot: f.paymentId, amount: c('250000.00') }]);
            await w.act('dispatchCashDelivery', id, f.c);
            book.dispatch(id);
            await w.act('receiveCashDelivery', id, f.o);
            book.receive(id);
            o['count 230'] = w.st(await w.count(id, '230000.00'));
            book.count(id, c('230000.00'));
            o['state after 230'] = (await w.delivery(id)).state;
            await cmp('A DISCREPANCY 230');
            const j0 = await w.journals();
            o['confirm with 230'] = w.st(await w.confirm(id));
            o['return request in DISCREPANCY (contract D2 allows DISCREPANCY→RETURN_REQUIRED)'] = w.st(await w.act('requestCashDeliveryReturn', id, f.o));
            o['investigate by O (T only)'] = w.st(await w.act('investigateCashDelivery', id, f.o));
            o['investigate by T'] = w.st(await w.act('investigateCashDelivery', id, f.a));
            o['recount 250 by T (receiver only)'] = w.st(await w.count(id, '250000.00', f.a));
            o['recount 250 by O'] = w.st(await w.count(id, '250000.00'));
            book.count(id, c('250000.00'));
            const d1 = await w.delivery(id);
            o['state after recount'] = d1.state;
            o['correct before sender ack'] = w.st(await raw('correctCashDelivery', id, f.a, { countId: d1.countId, countETag: `"${d1.countId}:1"`, reason: 'Revisión', supportReference: 'SYN' }));
            o['ack by O (sender only)'] = w.st(await raw('acknowledgeCashDeliveryCount', id, f.o, { countId: d1.countId, countETag: `"${d1.countId}:1"`, reason: 'Ratifico', supportReference: 'SYN' }));
            o['ack by C'] = w.st(await raw('acknowledgeCashDeliveryCount', id, f.c, { countId: d1.countId, countETag: `"${d1.countId}:1"`, reason: 'Ratifico', supportReference: 'SYN' }));
            o['correct by T'] = w.st(await raw('correctCashDelivery', id, f.a, { countId: d1.countId, countETag: `"${d1.countId}:1"`, reason: 'Revisión', supportReference: 'SYN' }));
            o['state after correction'] = (await w.delivery(id)).state;
            o['journals during discrepancy'] = await w.journals() - j0;
            const cf = await w.confirm(id);
            o['confirm after correction'] = w.st(cf);
            book.confirmDelivery(id);
            await cmp('B CONFIRMED after correction');
            // Surplus 70 over 50, then exact recount and return of a received delivery (two real facts + source count + T).
            const r2 = await w.request('50000.00'), id2 = r2.id;
            book.request(id2, 'CASH_C', 'CENTRAL', [{ lot: f.paymentId, amount: c('50000.00') }]);
            await w.act('dispatchCashDelivery', id2, f.c);
            book.dispatch(id2);
            await w.act('receiveCashDelivery', id2, f.o);
            book.receive(id2);
            await w.count(id2, '70000.00');
            book.count(id2, c('70000.00'));
            await cmp('C SURPLUS 70 over 50');
            await w.count(id2, '50000.00');
            book.count(id2, c('50000.00'));
            o['return request (received)'] = w.st(await w.act('requestCashDeliveryReturn', id2, f.o));
            o['SOURCE_RECEIVED before receiver dispatch'] = w.st(await w.act('recordCashDeliveryReturnFact', id2, f.c, { kind: 'SOURCE_RECEIVED', amount: '50000.00' }));
            o['RECEIVER_RETURN_DISPATCHED by C (receiver only)'] = w.st(await w.act('recordCashDeliveryReturnFact', id2, f.c, { kind: 'RECEIVER_RETURN_DISPATCHED', amount: '50000.00' }));
            o['RECEIVER_RETURN_DISPATCHED'] = w.st(await w.act('recordCashDeliveryReturnFact', id2, f.o, { kind: 'RECEIVER_RETURN_DISPATCHED', amount: '50000.00' }));
            o['SOURCE_RECEIVED'] = w.st(await w.act('recordCashDeliveryReturnFact', id2, f.c, { kind: 'SOURCE_RECEIVED', amount: '50000.00' }));
            o['SOURCE_COUNT 49999.99'] = w.st(await w.act('recordCashDeliveryReturnFact', id2, f.c, { kind: 'SOURCE_COUNT', amount: '49999.99' }));
            o['confirm return with short count'] = w.st(await w.act('confirmCashDeliveryReturn', id2, f.a));
            o['SOURCE_COUNT exact'] = w.st(await w.act('recordCashDeliveryReturnFact', id2, f.c, { kind: 'SOURCE_COUNT', amount: '50000.00' }));
            o['confirm return by O (T only)'] = w.st(await w.act('confirmCashDeliveryReturn', id2, f.o));
            o['confirm return by T'] = w.st(await w.act('confirmCashDeliveryReturn', id2, f.a));
            book.returned(id2);
            await cmp('D RETURNED (received)');
            o['journals for returns'] = await w.journals() - j0 - 1;
            // Fresh world: cancel before dispatch; non-receipt return chain.
            const s2 = await scenario(group), w2 = s2.w, f2 = s2.f, b2 = s2.book;
            const cmp2 = async (step) => { o[step] = { C: { server: await s2.pos('C'), oracle: s2.exp('C') }, O: { server: await s2.pos('O'), oracle: s2.exp('O') } }; };
            const q = await w2.request('100000.00');
            b2.request(q.id, 'CASH_C', 'CENTRAL', [{ lot: f2.paymentId, amount: c('100000.00') }]);
            o['cancel by O (sender/T only)'] = w2.st(await w2.act('cancelCashDelivery', q.id, f2.o));
            o['cancel by C'] = w2.st(await w2.act('cancelCashDelivery', q.id, f2.c));
            b2.cancelRequested(q.id);
            await cmp2('E CANCELLED pre-dispatch');
            const q2 = await w2.request('100000.00');
            b2.request(q2.id, 'CASH_C', 'CENTRAL', [{ lot: f2.paymentId, amount: c('100000.00') }]);
            await w2.act('dispatchCashDelivery', q2.id, f2.c);
            b2.dispatch(q2.id);
            o['cancel after dispatch'] = w2.st(await w2.act('cancelCashDelivery', q2.id, f2.c));
            o['non-receipt: return request'] = w2.st(await w2.act('requestCashDeliveryReturn', q2.id, f2.c));
            o['non-receipt: RECEIVER_NON_RECEIPT'] = w2.st(await w2.act('recordCashDeliveryReturnFact', q2.id, f2.o, { kind: 'RECEIVER_NON_RECEIPT', amount: '100000.00' }));
            o['non-receipt: SOURCE_RECALLED'] = w2.st(await w2.act('recordCashDeliveryReturnFact', q2.id, f2.c, { kind: 'SOURCE_RECALLED', amount: '100000.00' }));
            o['non-receipt: SOURCE_COUNT'] = w2.st(await w2.act('recordCashDeliveryReturnFact', q2.id, f2.c, { kind: 'SOURCE_COUNT', amount: '100000.00' }));
            o['non-receipt: confirm by T'] = w2.st(await w2.act('confirmCashDeliveryReturn', q2.id, f2.a));
            b2.returned(q2.id);
            await cmp2('F RETURNED (non-receipt)');
            o['non-receipt journals'] = await w2.journals({ 'source.type': { $in: ['CASH_DELIVERY', 'CASH_DELIVERY_COMPENSATION'] } });
            void label;
            for (const k of Object.keys(o).filter(k => /^[A-F] /.test(k))) {
                const v = o[k];
                assert.deepEqual(v.C.server, v.C.oracle, k + ' C');
                assert.deepEqual(v.O.server, v.O.oracle, k + ' O');
            }
            assert.equal(o['state after 230'], 'DISCREPANCY');
            assert.match(String(o['confirm with 230']), /^409 .*(DELIVERY_COUNT_MISMATCH|STATE_CONFLICT)/);
            assert.equal(o['journals during discrepancy'], 0);
            assert.equal(o['confirm after correction'], '201');
            assert.equal(o['confirm return by T'], '201');
            assert.equal(o['journals for returns'], 0);
            assert.equal(o['non-receipt: confirm by T'], '201');
            assert.equal(o['non-receipt journals'], 0);
        });
        await t.test('G3 atomicity: injected faults on every new boundary of confirm/request, replay/conflict, stale versions, concurrent requests on one lot, suspension between plan and commit (AT07)', { skip: !only('G3') }, async (st) => {
            const s = await scenario(group), { w, f } = s, o = {};
            st.after(() => evidence('P07-G3', { observed: o }));
            const ALL = [...S5, ...S6, ...S7, ...LEDGER, ...EVIDENCE, ...AUDIT];
            const inject = async (name, on) => { await w.db.command({ collMod: name, validator: on ? { __s07_p05_fault: { $exists: true } } : {}, validationLevel: on ? 'strict' : 'off', validationAction: 'error' }); };
            const counted = async (amount) => { const r = await w.request(amount); assert.equal(r.status, 201, w.st(r)); await w.act('dispatchCashDelivery', r.id, f.c); await w.act('receiveCashDelivery', r.id, f.o); await w.count(r.id, amount); return r.id; };
            const faults = {};
            for (const name of ['cash_deliveries', 'collection_commands', 'collection_transitions', 'collection_books', 'financial_journals', 'financial_books', 'audit_events', 'lending_merkle_nodes', 'identities']) {
                const id = await counted('10000.00'), p = await f.confirm(id);
                await f.proof(f.a, p.purpose, p.proofCommand, id);
                const before = await w.digest(ALL);
                await inject(name, true);
                let failed;
                try {
                    failed = await w.settle(() => f.collections.mutate(f.a.issued.context, p.operation, w.org, p.payload, p.key, p.etag, id));
                }
                finally {
                    await inject(name, false);
                }
                faults[name] = { failed: w.st(failed), noPartialWrite: await w.digest(ALL) === before, retry: w.st(await w.settle(p.execute)), replay: w.st(await w.settle(p.execute)), state: (await w.delivery(id)).state };
            }
            o['faults on confirm'] = faults;
            const cfaults = {};
            for (const name of ['cash_delivery_facts', 'collection_transitions', 'cash_deliveries']) {
                const r0 = await w.request('1000.00');
                await w.act('dispatchCashDelivery', r0.id, f.c);
                await w.act('receiveCashDelivery', r0.id, f.o);
                const before = await w.digest(ALL);
                await inject(name, true);
                let failed;
                try {
                    failed = await w.count(r0.id, '1000.00');
                }
                finally {
                    await inject(name, false);
                }
                cfaults[name] = { failed: w.st(failed), noPartialWrite: await w.digest(ALL) === before, retry: w.st(await w.count(r0.id, '1000.00')), state: (await w.delivery(r0.id)).state };
            }
            o['faults on count (fact)'] = cfaults;
            const rfaults = {};
            for (const name of ['cash_delivery_allocations', 'cash_deliveries', 'collection_commands']) {
                const p = (await w.prepared(() => f.request('1000.00'))).p;
                const before = await w.digest(ALL);
                await inject(name, true);
                let failed;
                try {
                    failed = await w.settle(() => f.collections.mutate(f.c.issued.context, p.operation, w.org, p.payload, p.key, p.etag));
                }
                finally {
                    await inject(name, false);
                }
                rfaults[name] = { failed: w.st(failed), noPartialWrite: await w.digest(ALL) === before, retry: w.st(await w.settle(p.execute)) };
            }
            o['faults on request'] = rfaults;
            // Lost response replay and same key with another body.
            const id = await counted('20000.00'), p = await f.confirm(id), first = await w.settle(p.execute), again = await w.settle(p.execute);
            const other = await counted('5000.00'), d = await w.delivery(other);
            const conflict = await w.prepared(() => f.prepareCollections({ kind: 'CONFIRM', deliveryId: other, resourceETag: `"${other}:${d.version}"`, countId: d.countId, countETag: `"${d.countId}:1"`, effectiveDate: w.today(), supportReference: 'SYN' }, f.a, p.key));
            o['lost response'] = { first: w.st(first), replay: w.st(again), replayedFlag: again.data?.['replayed'], sameJournal: first.data?.['journalId'] === again.data?.['journalId'], sameKeyOtherBody: conflict.failed ? w.st(conflict.failed) : w.st(await w.settle(conflict.p.execute)) };
            // Stale delivery ETag: plan prepared, then another fact changes the delivery (return request) → commit refused.
            const id3 = await counted('3000.00'), p3 = await f.confirm(id3);
            await w.act('requestCashDeliveryReturn', id3, f.o);
            o['stale plan after another fact'] = w.st(await w.settle(p3.execute));
            o['stale state'] = (await w.delivery(id3)).state;
            // Two concurrent requests over the same uncommitted remainder.
            const lot = await w.position(s.C, f.cash.id);
            const remaining = String(lot.uncommitted);
            const a1 = (await w.prepared(() => f.request(remaining))).p, a2 = (await w.prepared(() => f.request(remaining))).p;
            const race = await Promise.allSettled([a1.execute(), a2.execute()]);
            o['two requests same money'] = { remaining, outcomes: race.map(x => x.status === 'fulfilled' ? String(x.value.status) : String(x.reason.code)), committedAfter: (await w.position(s.C, f.cash.id)).committed };
            // Receiver suspended between plan and commit of a confirmation.
            const s2 = await scenario(group), w2 = s2.w, f2 = s2.f, r = await w2.request('250000.00');
            await w2.act('dispatchCashDelivery', r.id, f2.c);
            await w2.act('receiveCashDelivery', r.id, f2.o);
            await w2.count(r.id, '250000.00');
            const p4 = await f2.confirm(r.id), oid = f2.o.issued.context.subjectId, oIdentity = await f2.identity.identities.findOne({ _id: oid });
            await f2.proof(f2.a, 'MEMBER_SUSPEND', undefined, oid);
            await w2.settle(() => f2.runtime.organizations.memberCommand(f2.a.issued.context, oid, 'SUSPEND', oIdentity.version));
            const jb = await w2.journals();
            o['confirm after receiver suspended'] = w2.st(await w2.settle(p4.execute));
            o['journals added'] = await w2.journals() - jb;
            for (const [k, v] of Object.entries(faults)) {
                const x = v;
                assert.ok(!x.failed.startsWith('2'), k);
                assert.equal(x.noPartialWrite, true, k);
                assert.deepEqual([x.retry, x.replay, x.state], ['201', '200', 'CONFIRMED'], k);
            }
            for (const [k, v] of Object.entries(cfaults)) {
                const x = v;
                assert.ok(!x.failed.startsWith('2'), k);
                assert.equal(x.noPartialWrite, true, k);
                assert.equal(x.retry, '201', k);
            }
            for (const [k, v] of Object.entries(rfaults)) {
                const x = v;
                assert.ok(!x.failed.startsWith('2'), k);
                assert.equal(x.noPartialWrite, true, k);
                assert.equal(x.retry, '201', k);
            }
            const lr = o['lost response'];
            assert.deepEqual([lr['first'], lr['replay'], lr['sameJournal']], ['201', '200', true]);
            assert.match(String(lr['sameKeyOtherBody']), /IDEMPOTENCY_CONFLICT/);
            assert.notEqual(o['stale plan after another fact'], '201');
            const tw = o['two requests same money'];
            assert.equal(tw.outcomes.filter(x => x === '201').length, 1);
            assert.notEqual(o['confirm after receiver suspended'], '201');
            assert.equal(o['journals added'], 0);
        });
        await t.test('G4 H-S6-P05-01 revalidation: two pendings + intervening direct receipt approve with the CURRENT plan bound to the original intent; SETTLED target refused without fictitious return (AT08)', { skip: !only('G4') }, async (st) => {
            const o = {};
            st.after(() => evidence('P07-G4', { observed: o }));
            const w = await world(group, false), f = w.f, T0 = w.today(), book = new S7Book('HELD'), P = await f.member('P'), bank = (await f.accountS06('BANK_H1', 'ASSET', 'BANK')).id;
            const label = new Map([[f.profile.principalAccountId, 'PRINCIPAL'], [f.profile.interestReceivableAccountId, 'INTEREST_RECEIVABLE'], [f.profile.interestIncomeAccountId, 'INTEREST_INCOME'], [f.profile.borrowerCreditAccountId, 'BORROWER_CREDIT'], [bank, 'BANK']]);
            book.fund('FUND', c('20000000.00'));
            book.addLoan(f.l.id, f.l.borrowerId, terms());
            book.disburse(f.l.id, 'FUND');
            const reg = async (amount, mode, actor = f.o) => { const r = await w.settle(async () => (await f.preparePayment({ kind: 'REGISTER', mode, effectiveDate: T0, intent: await f.intent(f.l, bank, amount, actor) }, actor)).execute()); return { ...r, id: r.data?.['entityId'] }; };
            const approve = async (id) => { const p = await w.prepared(async () => { const pay = await f.readPayment(id), v = await f.state(); return await f.preparePayment({ kind: 'APPROVE', paymentId: id, resourceETag: pay.etag, effectiveDate: T0, expectedOperationsETag: v.operationsBookETag }, P); }); if (p.failed)
                return { r: p.failed, plan: null }; return { r: await w.settle(p.p.execute), plan: p.p.preview.plan }; };
            const intentHash = async (id) => JSON.stringify((await w.db.collection('payments').findOne({ _id: id }))?.['intent']);
            const p1 = await reg('100000.00', 'SUPERVISED'), p2 = await reg('100000.00', 'SUPERVISED');
            const h1 = await intentHash(p1.id), h2 = await intentHash(p2.id);
            for (const x of [p1, p2])
                book.register(x.id, { method: 'BANK', mode: 'SUPERVISED', borrower: f.l.borrowerId, amount: c('100000.00'), account: 'BANK', targets: [{ loan: f.l.id, amount: c('100000.00'), mode: 'REGULAR' }], excess: 'CREDIT', registrar: 'O', custodian: null }, T0);
            const d = await reg('50000.00', 'DIRECT', f.a);
            o['intervening DIRECT 50k'] = w.st(d);
            book.register(d.id, { method: 'BANK', mode: 'DIRECT', borrower: f.l.borrowerId, amount: c('50000.00'), account: 'BANK', targets: [{ loan: f.l.id, amount: c('50000.00'), mode: 'REGULAR' }], excess: 'CREDIT', registrar: 'T', custodian: null }, T0);
            const y0 = (await w.ledger()).get(f.profile.interestIncomeAccountId);
            for (const [n, x, h] of [['first', p1, h1], ['second', p2, h2]]) {
                const a = await approve(x.id);
                const s = a.r.status === 201 ? book.approve(x.id, 'P', T0) : null;
                const pay = (await f.readPayment(x.id)).data;
                const ev = pay.eventId ? await w.db.collection('loan_events').findOne({ _id: pay.eventId }) : null;
                o[n + ' approval'] = { status: w.st(a.r), paymentStatus: pay.status, intentUnchanged: await intentHash(x.id) === h, planKeys: a.plan ? Object.keys(a.plan).filter(k => /intent|precondition|current/i.test(k)) : null, server: ev ? await journalOf(w, String(ev['journalId']), label) : null, oracle: s ? rows(s.postings) : null, principal: (await f.position(f.l.id)).data.principalOutstanding, oraclePrincipal: m(book.loans.get(f.l.id).pOut) };
            }
            o['interest income: no second recognition'] = { incomeDeltaAfterApprovals: mm(((await w.ledger()).get(f.profile.interestIncomeAccountId) ?? 0n) - (y0 ?? 0n)), oracle: '0.00' };
            // SETTLED target: one-installment zero-interest loan; pending, then a direct receipt settles it; approval refused, pending intact.
            const L = await f.loan({ principal: '100000.00', installmentCount: 1, rate: { type: 'EFFECTIVE', unit: 'MONTH', value: '0.000000000000' } });
            await f.disburse(L);
            const pend = await w.settle(async () => (await f.preparePayment({ kind: 'REGISTER', mode: 'SUPERVISED', effectiveDate: T0, intent: await f.intent(L, bank, '100000.00', f.o) }, f.o)).execute()), pid = pend.data?.['entityId'];
            const settle2 = await w.settle(async () => (await f.preparePayment({ kind: 'REGISTER', mode: 'DIRECT', effectiveDate: T0, intent: await f.intent(L, bank, '100000.00') })).execute());
            const a3 = await approve(pid);
            o['SETTLED target'] = { settlingDirect: w.st(settle2), loanStatus: (await f.position(L.id)).data.status, approval: w.st(a3.r), pendingStatus: (await f.readPayment(pid)).data.status };
            for (const n of ['first', 'second']) {
                const v = o[n + ' approval'];
                assert.equal(v['status'], '201', n);
                assert.equal(v['intentUnchanged'], true, n);
                assert.deepEqual(v['server'], v['oracle'], n);
                assert.equal(v['principal'], v['oraclePrincipal'], n);
            }
            assert.equal(o['interest income: no second recognition'].incomeDeltaAfterApprovals, '0.00');
            assert.match(String(o['SETTLED target'].approval), /^409 .*(PAYMENT_STATE_CONFLICT|EXCESS_NOT_ALLOWED)/);
            assert.equal(o['SETTLED target'].pendingStatus, 'PENDING');
        });
        await t.test('G5 H-S6-P05-03 revalidation: link only from PENDING; C2 sequence enforced; exact link once; 0 journals (AT08)', { skip: !only('G5') }, async (st) => {
            const o = {};
            st.after(() => evidence('P07-G5', { observed: o }));
            const w = await world(group, false), f = w.f, bank = (await f.accountS06('BANK_H3', 'ASSET', 'BANK')).id;
            const r = await w.settle(async () => (await f.preparePayment({ kind: 'REGISTER', mode: 'DIRECT', effectiveDate: w.today(), intent: await f.intent(f.l, bank, '100000.00') })).execute()), pid = r.data?.['entityId'];
            const pay = async () => { const p = await f.readPayment(pid); return { etag: p.etag, ...p.data }; };
            const p0 = await pay(), intent = p0['intent'], a = await f.runtime.finance.read(f.a.issued.context, 'readAccount', w.org, bank);
            const decl = await w.settle(() => f.mutatePayment('createBankDeclaration', { accountId: bank, accountETag: a.etag, currency: 'COP', direction: 'INCOMING', amount: '100000.00', valueDate: intent.observedDate, reference: intent.receiptReference, source: 'MANUAL_DECLARATION', declaredBankName: 'Banco sintético', statementReference: 'EXT-H3', lineReference: 'L1', supportReference: 'SYN' })), did = decl.data?.['entityId'];
            const declETag = async () => { const dr = await f.pay.read(f.a.issued.context, 'getBankDeclaration', w.org, did); const items = dr.data.items, row = items ? items[0] : dr.data; return `"${did}:${String(row['version'])}"`; };
            const link = async () => w.st(await w.settle(async () => f.mutatePayment('linkReconciliation', { paymentId: pid, paymentETag: (await pay()).etag, bankDeclarationId: did, bankDeclarationETag: await declETag(), supportReference: 'SYN' })));
            const dispose = async (state) => w.st(await w.settle(async () => f.mutatePayment('disposeReconciliation', { paymentId: pid, resourceETag: (await pay()).etag, state, reason: 'Revisión T', supportReference: 'SYN' })));
            const j0 = await w.journals();
            o['DISCREPANCY'] = await dispose('DISCREPANCY');
            o['link from DISCREPANCY'] = await link();
            o['DISCREPANCY→PENDING shortcut'] = await dispose('PENDING');
            o['INVESTIGATION'] = await dispose('INVESTIGATION');
            o['link from INVESTIGATION'] = await link();
            o['INVESTIGATION→DISCREPANCY back'] = await dispose('DISCREPANCY');
            o['PENDING'] = await dispose('PENDING');
            o['link from PENDING'] = await link();
            o['second link'] = await link();
            o['state'] = (await pay()).reconciliationState;
            o['journals added'] = await w.journals() - j0;
            o['disposition facts recorded'] = await w.db.collection('reconciliation_events').countDocuments({ organizationId: w.org, paymentId: pid, operation: 'disposeReconciliation' });
            assert.deepEqual([o['DISCREPANCY'], o['INVESTIGATION'], o['PENDING'], o['link from PENDING']], ['201', '201', '201', '201']);
            for (const k of ['link from DISCREPANCY', 'link from INVESTIGATION', 'DISCREPANCY→PENDING shortcut', 'INVESTIGATION→DISCREPANCY back', 'second link'])
                assert.match(String(o[k]), /^409 /, k);
            assert.equal(o['state'], 'RECONCILED');
            assert.equal(o['journals added'], 0);
        });
        await t.test('G6 security: tenant B, roles per command, P/A/L, revoked scope keeps own money, suspended sender, W classes with fixture clock (60 min / one-shot 5 min) (AT09/AT10)', { skip: !only('G6') }, async (st) => {
            const s = await scenario(group), { w, f } = s, o = {};
            st.after(() => evidence('P07-G6', { observed: o }));
            const r = await w.request('100000.00'), did = r.id;
            const B = await f.tenant(await f.newActor()), bctx = B.actor.issued.context, cross = {};
            for (const [n, op, id] of [['delivery', 'getCashDelivery', did], ['station', 'getCashStation', f.stationId], ['position', 'getCashPosition', s.C], ['facts', 'listCashDeliveryFacts', did]])
                cross['B own org, A ' + n] = w.st(await w.settle(() => f.collections.read(bctx, op, B.org, id)));
            cross['B reads A org state'] = w.st(await w.settle(() => f.collections.read(bctx, 'getCollectionsState', w.org)));
            o['cross-tenant'] = cross;
            const P = await f.member('P'), A = await f.member('A');
            o['P reads collections state'] = w.st(await w.settle(() => f.collections.read(P.issued.context, 'getCollectionsState', w.org)));
            o['A reads collections state'] = w.st(await w.settle(() => f.collections.read(A.issued.context, 'getCollectionsState', w.org)));
            o['C reads O position'] = w.st(await w.settle(() => f.collections.read(f.c.issued.context, 'getCashPosition', w.org, s.O)));
            o['O dispatches C delivery'] = w.st(await w.act('dispatchCashDelivery', did, f.o));
            o['C investigates'] = w.st(await w.act('investigateCashDelivery', did, f.c));
            // Revoked scope: C keeps reading and delivering ITS money (adenda 1.0.1) but cannot register new receipts on that loan.
            o['revoke C scope'] = w.st(await w.settle(() => f.mutatePayment('setPaymentRegistrationScope', { scopeId: f.scopeId, registrarId: s.C, loanId: f.l.id, scope: 'PAYMENT_REGISTER_ONLY', active: false, resourceETag: `"${f.scopeId}:1"`, supportReference: 'SYN' })));
            const posC = await w.settle(() => f.readCollections('getCashPosition', s.C, f.c));
            o['C position after revoke'] = { status: w.st(posC), hasETags: Boolean((posC.data.items[0] ?? {})['accountETag']) };
            o['C new delivery after revoke'] = w.st(await w.request('50000.00'));
            o['C new receipt after revoke'] = w.st(await w.settle(async () => (await f.preparePayment({ kind: 'REGISTER', mode: 'SUPERVISED', effectiveDate: w.today(), intent: await f.intent(f.l, f.cash.id, '1000.00', f.c, 'CASH') }, f.c)).execute()));
            // Suspended sender cannot declare facts; T still sees the delivery.
            const cIdentity = await f.identity.identities.findOne({ _id: s.C });
            await f.proof(f.a, 'MEMBER_SUSPEND', undefined, s.C);
            await w.settle(() => f.runtime.organizations.memberCommand(f.a.issued.context, s.C, 'SUSPEND', cIdentity.version));
            o['suspended C dispatches'] = w.st(await w.act('dispatchCashDelivery', did, f.c));
            o['T reads delivery'] = w.st(await w.settle(() => f.readCollections('getCashDelivery', did)));
            // SECURITY_ONE_SHOT station change: proof valid at 4:59, expired at 5:00; never reused.
            const central = await f.runtime.finance.read(f.a.issued.context, 'readAccount', w.org, f.central.id), recv = await f.identity.identities.findOne({ _id: s.O });
            const station = async (sid, at) => {
                const v = await f.collectionsState(), key = randomUUID(), payload = { stationId: sid, resourceETag: `"${sid}:0"`, accountId: (await f.accountS06('CASH_ST' + at, 'ASSET', 'CASH')).id, accountETag: '', receiverId: s.O, receiverETag: recv.version, active: true, supportReference: 'SYN' };
                payload.accountETag = (await f.runtime.finance.read(f.a.issued.context, 'readAccount', w.org, payload.accountId)).etag;
                const cmd = { organizationId: w.org, idempotencyKey: key, expectedETag: v.collectionsBookETag, operationId: 'setCashStation', resourceId: null, payload };
                await f.proof(f.a, 'CASH_STATION_SET', cmd);
                f.clock.value += at;
                return await w.settle(() => f.collections.mutate(f.a.issued.context, 'setCashStation', w.org, payload, key, v.collectionsBookETag));
            };
            void central;
            o['one-shot used at 4:59 after prepare'] = w.st(await station(randomUUID(), 4 * 60000 + 59000 - 30000));
            o['one-shot used at 5:00 after prepare'] = w.st(await station(randomUUID(), 5 * 60000 - 30000));
            // BALANCE_60M fixed 60 min and absolute 12 h with a fresh T login kept alive only by the real activity route.
            const s2 = await scenario(group), w2 = s2.w, f2 = s2.f, { password } = await import('./review-profile.js'), { ApiClient } = await import('../../helpers/client.js');
            const login = await f2.identity.login('TENANT', randomUUID(), f2.a.email, password), T2 = { ...f2.a, issued: login.issued }, t0 = f2.now();
            const https = await f2.https(false), cl = new ApiClient(https.port, https.cert);
            cl.cookies.set('__Host-caudelyx-session', T2.issued.token);
            await cl.refreshCsrf();
            const beat = async () => (await cl.call('POST', '/api/v1/auth/session/activity', {})).status;
            const counted = async (amount) => { const r0 = await w2.request(amount); await w2.act('dispatchCashDelivery', r0.id, f2.c); await w2.act('receiveCashDelivery', r0.id, f2.o); await w2.count(r0.id, amount); return r0.id; };
            const ids = [await counted('1000.00'), await counted('1001.00'), await counted('1002.00')];
            const confirmAs = async (id, withProof) => { const d = (await f2.collections.read(T2.issued.context, 'getCashDelivery', w2.org, id)).data; const p = await w2.prepared(() => f2.prepareCollections({ kind: 'CONFIRM', deliveryId: id, resourceETag: `"${id}:${d.version}"`, countId: d.countId, countETag: `"${d.countId}:1"`, effectiveDate: w2.today(), supportReference: 'SYN' }, T2)); if (p.failed)
                return p.failed; if (withProof)
                await f2.proof(T2, p.p.purpose, p.p.proofCommand, id); return await w2.settle(() => f2.collections.mutate(T2.issued.context, p.p.operation, w2.org, p.p.payload, p.p.key, p.p.etag, id)); };
            o['T2 confirm without grant'] = w2.st(await confirmAs(ids[0], false));
            o['T2 confirm with grant'] = w2.st(await confirmAs(ids[0], true));
            const grantAt = f2.now();
            cl.cookies.set('__Host-caudelyx-session', T2.issued.token);
            await cl.refreshCsrf();
            o['session rotated by verification'] = T2.issued.token !== login.issued.token;
            const beats = [];
            f2.clock.value = grantAt + 30 * 60000;
            beats.push(await beat());
            f2.clock.value = grantAt + 59 * 60000;
            beats.push(await beat());
            o['T2 confirm at +59 min (no new proof)'] = w2.st(await confirmAs(ids[1], false));
            f2.clock.value = grantAt + 60 * 60000 + 1000;
            beats.push(await beat());
            o['T2 confirm at +60 min 1 s'] = w2.st(await confirmAs(ids[2], false));
            for (let tt = grantAt + 110 * 60000; tt < t0 + 12 * 3600000 - 1000; tt += 50 * 60000) {
                f2.clock.value = tt;
                beats.push(await beat());
            }
            f2.clock.value = t0 + 12 * 3600000 - 1000;
            beats.push(await beat());
            o['T2 read at 11:59:59'] = w2.st(await w2.settle(() => f2.collections.read(T2.issued.context, 'getCollectionsState', w2.org)));
            f2.clock.value = t0 + 12 * 3600000;
            o['T2 read at 12:00:00'] = w2.st(await w2.settle(() => f2.collections.read(T2.issued.context, 'getCollectionsState', w2.org)));
            o['heartbeats'] = beats;
            evidence('P07-G6-partial', { cross });
            for (const [k, v] of Object.entries(cross))
                assert.match(v, /^(403|404) /, k);
            assert.match(String(o['P reads collections state']), /^403 /);
            assert.match(String(o['A reads collections state']), /^403 /);
            assert.match(String(o['C reads O position']), /^(403|404) /);
            assert.match(String(o['O dispatches C delivery']), /^403 /);
            assert.match(String(o['C investigates']), /^403 /);
            assert.equal(o['C position after revoke'].status, '200');
            assert.equal(o['C new delivery after revoke'], '201');
            assert.match(String(o['C new receipt after revoke']), /^(403|404)/);
            assert.match(String(o['suspended C dispatches']), /^(401|403)/);
            assert.match(String(o['T2 confirm without grant']), /^403 /);
            assert.equal(o['T2 confirm with grant'], '201');
            assert.equal(o['T2 confirm at +59 min (no new proof)'], '201');
            assert.match(String(o['T2 confirm at +60 min 1 s']), /^403 /);
            assert.equal(o['T2 read at 11:59:59'], '200');
            assert.match(String(o['T2 read at 12:00:00']), /^401 /);
            assert.equal(o['one-shot used at 4:59 after prepare'], '201');
            assert.match(String(o['one-shot used at 5:00 after prepare']), /^403 (R_REQUIRED|REAUTH_REQUIRED)/);
        });
        await t.test('G7 journeys, actions/promises and cash close: no money moves, pendings explicit, midnight crossing (AT02/AT06)', { skip: !only('G7') }, async (st) => {
            const s = await scenario(group), { w, f } = s, o = {};
            st.after(() => evidence('P07-G7', { observed: o }));
            const j0 = await w.journals(), money0 = await w.digest([...S5, ...LEDGER, 'cash_custody', 'held_funds_reservations']);
            const open = await w.settle(() => f.mutateCollections('openCollectionJourney', { supportReference: 'SYN' }, undefined, f.c)), jid = open.data?.['entityId'];
            o['open journey'] = w.st(open);
            o['second open'] = w.st(await w.settle(() => f.mutateCollections('openCollectionJourney', { supportReference: 'SYN' }, undefined, f.c)));
            const jetag = async () => (await f.readCollections('getCollectionJourney', jid, f.c)).etag;
            const act = async (kind, extra = {}) => await w.settle(async () => f.mutateCollections('recordCollectionAction', { resourceETag: await jetag(), loanId: f.l.id, kind, occurredAt: new Date(f.now()).toISOString(), note: 'Gestión sintética', supportReference: 'SYN', promisedAmount: null, promisedDate: null, ...extra }, jid, f.c));
            const pr = await act('PROMISE', { promisedAmount: '50000.00', promisedDate: w.today() });
            o['PROMISE'] = w.st(pr);
            o['NOTE with amount'] = w.st(await act('NOTE', { promisedAmount: '1.00', promisedDate: w.today() }));
            o['PROMISE without amount'] = w.st(await act('PROMISE'));
            const aid = pr.data?.['entityId'];
            o['correction'] = w.st(await w.settle(async () => f.mutateCollections('correctCollectionAction', { resourceETag: (await f.readCollections('getCollectionAction', aid, f.c)).etag, occurredAt: new Date(f.now()).toISOString(), note: 'Corrección', promisedAmount: '40000.00', promisedDate: w.today(), reason: 'Ajuste', supportReference: 'SYN' }, aid, f.c)));
            o['actions stored'] = await w.db.collection('collection_actions').countDocuments({ organizationId: w.org });
            // Cross midnight Bogota (fixture 12:00 -> next day 00:05): old sessions expire (idle/absolute); C and T log in again and the journey is still OPEN.
            const { password } = await import('./review-profile.js');
            f.clock.value += 12 * 3600000 + 5 * 60000;
            o['old C session after midnight'] = w.st(await w.settle(() => f.readCollections('getCollectionJourney', jid, f.c)));
            for (const a of [f.c, f.a]) {
                const l = await f.identity.login('TENANT', randomUUID(), a.email, password);
                a.issued = l.issued;
            }
            o['journey after midnight'] = (await f.readCollections('getCollectionJourney', jid, f.c)).data.status;
            o['action after midnight'] = w.st(await act('VISIT'));
            // A pending delivery makes exact closes impossible; T documents an administrative close with COUNT_MISSING.
            const rq = await w.request('100000.00');
            o['pending delivery'] = w.st(rq);
            const acc = await f.runtime.finance.read(f.a.issued.context, 'readAccount', w.org, f.cash.id);
            const close = async (actor, status, counted) => await w.settle(() => f.mutateCollections('createCashClose', { accountId: f.cash.id, accountETag: acc.etag, subjectId: s.C, journeyId: jid, observedAt: new Date(f.now()).toISOString(), counted, countStatus: status, denominations: [], supersedesCloseId: null, reason: 'Arqueo sintético', supportReference: 'SYN' }, undefined, actor));
            const buckets = { confirmedOnSite: '300000.00', provisionalOnSite: '0.00', returnRequiredOnSite: '0.00', heldOnSite: '0.00', inTransit: '0.00', receivedUnposted: '0.00', unlocatedDisputed: '0.00', unidentifiedSurplus: '0.00' };
            o['T DECLARED for C'] = w.st(await close(f.a, 'DECLARED', buckets));
            o['T MISSING with counted'] = w.st(await close(f.a, 'MISSING', buckets));
            const cc = await close(f.a, 'MISSING', null);
            o['T administrative MISSING'] = w.st(cc);
            const cid = cc.data?.['entityId'];
            const fin = async (mode) => await w.settle(async () => f.mutateCollections('finalizeCashClose', { resourceETag: (await f.readCollections('getCashClose', cid)).etag, mode, reason: 'Cierre', supportReference: 'SYN' }, cid));
            o['finalize EXACT with missing count'] = w.st(await fin('EXACT'));
            o['finalize WITH_PENDING'] = w.st(await fin('WITH_PENDING'));
            const closeRow = await w.db.collection('cash_close_records').findOne({ _id: cid });
            o['close record'] = { state: closeRow?.['state'], pending: closeRow?.['pendingRefs']?.length };
            o['journey close EXACT'] = w.st(await w.settle(async () => f.mutateCollections('closeCollectionJourney', { resourceETag: await jetag(), cashCloseId: cid, cashCloseETag: (await f.readCollections('getCashClose', cid)).etag, mode: 'EXACT', reason: 'Fin', supportReference: 'SYN' }, jid, f.c)));
            o['journey close WITH_PENDING'] = w.st(await w.settle(async () => f.mutateCollections('closeCollectionJourney', { resourceETag: await jetag(), cashCloseId: cid, cashCloseETag: (await f.readCollections('getCashClose', cid)).etag, mode: 'WITH_PENDING', reason: 'Fin con pendientes', supportReference: 'SYN' }, jid, f.c)));
            o['money unchanged by journeys/actions/closes'] = { journals: await w.journals() - j0, economic: await w.digest([...S5, ...LEDGER, 'cash_custody', 'held_funds_reservations']) === money0 };
            o['commitment still reserved after closes'] = (await w.position(s.C, f.cash.id)).committed;
            assert.equal(o['open journey'], '201');
            assert.match(String(o['second open']), /^409 /);
            assert.equal(o['PROMISE'], '201');
            assert.match(String(o['NOTE with amount']), /^422 /);
            assert.match(String(o['PROMISE without amount']), /^422 /);
            assert.equal(o['journey after midnight'], 'OPEN');
            assert.match(String(o['T DECLARED for C']), /^403 /);
            assert.equal(o['T administrative MISSING'], '201');
            assert.match(String(o['finalize EXACT with missing count']), /^409 CASH_CLOSE_PENDING/);
            assert.equal(o['finalize WITH_PENDING'], '201');
            assert.match(String(o['journey close EXACT']), /^409 /);
            assert.deepEqual(o['money unchanged by journeys/actions/closes'], { journals: 0, economic: true });
            assert.equal(o['commitment still reserved after closes'], '100000.00');
        });
        await t.test('G8 integrity/restore of S7 sources: online tampering 503 + exact revert; offline tampering closes, review refused, revert+review reopens (AT10)', { skip: !only('G8') }, async (st) => {
            const s = await scenario(group), { w, f } = s, o = {};
            st.after(() => evidence('P07-G8', { observed: o }));
            const r = await w.request('250000.00'), id = r.id;
            await w.act('dispatchCashDelivery', id, f.c);
            await w.act('receiveCashDelivery', id, f.o);
            await w.count(id, '250000.00');
            assert.equal((await w.confirm(id)).status, 201);
            const r2 = await w.request('10000.00');
            void r2;
            await w.settle(() => f.mutateCollections('openCollectionJourney', { supportReference: 'SYN' }, undefined, f.c));
            const online = {};
            for (const [coll, field, value, probe] of [['cash_deliveries', 'amount', '1.00', async () => w.st(await w.settle(() => f.readCollections('getCashDelivery', id)))], ['cash_delivery_allocations', 'amount', '1.00', async () => w.st(await w.settle(() => f.readCollections('getCashPosition', s.C, f.c)))],
                ['cash_delivery_facts', 'amount', '1.00', async () => w.st(await w.settle(() => f.readCollections('listCashDeliveryFacts', id)))], ['cash_stations', 'receiverId', randomUUID(), async () => w.st(await w.settle(() => f.readCollections('getCashStation', f.stationId)))]]) {
                const row = await w.db.collection(coll).findOne(coll === 'cash_deliveries' ? { _id: id } : coll === 'cash_stations' ? { _id: f.stationId } : { organizationId: w.org, deliveryId: id });
                if (!row) {
                    online[coll] = 'no row';
                    continue;
                }
                await w.db.collection(coll).updateOne({ _id: row['_id'] }, { $set: { [field]: value } });
                const tampered = await probe();
                await w.db.collection(coll).replaceOne({ _id: row['_id'] }, row);
                online[coll] = { tampered, afterExactRevert: await probe() };
            }
            o['online'] = online;
            await f.restore.flush();
            const { RestoreController } = await import('../../../src/shared/restore.js');
            const controller = async () => { const c2 = new RestoreController(f.database, f.restore.gatePath, f.keys.journal, f.keys.priority); await c2.initialize(); return c2; };
            const offline = { baseline: (await controller()).isOpen() };
            for (const coll of S7) {
                const row = await w.db.collection(coll).findOne({ organizationId: w.org });
                if (!row) {
                    offline[coll] = 'no row in this world';
                    continue;
                }
                await w.db.collection(coll).updateOne({ _id: row['_id'] }, { $set: { version: Number(row['version'] ?? 1) + 7 } });
                const c1 = await controller();
                let rec = 'reconciled';
                try {
                    await c1.reconcile({ approved: true, reviewId: 'S07_P05_TAMPERED' });
                }
                catch (e) {
                    rec = String(e.code ?? e);
                }
                await w.db.collection(coll).replaceOne({ _id: row['_id'] }, row);
                const c2 = await controller();
                if (!c2.isOpen())
                    await c2.reconcile({ approved: true, reviewId: 'S07_P05_REVERT' });
                offline[coll] = { openWhileTampered: c1.isOpen(), reconcileWhileTampered: rec, openAfterExactRevert: c2.isOpen() };
            }
            o['offline'] = offline;
            for (const [k, v] of Object.entries(online))
                if (typeof v === 'object') {
                    const x = v;
                    assert.match(x.tampered, /^503 /, k);
                    assert.match(x.afterExactRevert, /^200/, k);
                }
            assert.equal(offline['baseline'], true);
            for (const [k, v] of Object.entries(offline))
                if (k !== 'baseline' && typeof v === 'object')
                    assert.deepEqual(v, { openWhileTampered: false, reconcileWhileTampered: 'SERVICE_UNAVAILABLE', openAfterExactRevert: true }, k);
        });
        await t.test('G9 GET and preview purity of S7 readers by T/O/C (domain/ledger/evidence/audit/outbox unchanged) (AT07/AT08)', { skip: !only('G9') }, async (st) => {
            const s = await scenario(group), { w, f } = s, o = {};
            st.after(() => evidence('P07-G9', { observed: o }));
            const r = await w.request('100000.00');
            await w.act('dispatchCashDelivery', r.id, f.c);
            const j = await w.settle(() => f.mutateCollections('openCollectionJourney', { supportReference: 'SYN' }, undefined, f.c)), jid = j.data?.['entityId'];
            const all = async () => { const out = {}; for (const c of (await w.db.listCollections({}, { nameOnly: true }).toArray()).map(x => x.name).sort())
                out[c] = await w.digest([c]); return out; };
            const before = await all(), res = {};
            const reads = [['T', f.a, 'getCollectionsPolicy', undefined], ['T', f.a, 'getCollectionsState', undefined], ['T', f.a, 'listCollectionPortfolio', undefined], ['T', f.a, 'listCollectionJourneys', undefined], ['T', f.a, 'getCollectionJourney', jid],
                ['T', f.a, 'listCollectionActions', undefined], ['T', f.a, 'listCashStations', undefined], ['T', f.a, 'getCashStation', f.stationId], ['T', f.a, 'listCashPositions', undefined], ['T', f.a, 'getCashPosition', s.C], ['T', f.a, 'listCashDeliveries', undefined], ['T', f.a, 'getCashDelivery', r.id], ['T', f.a, 'listCashDeliveryFacts', r.id], ['T', f.a, 'listCashCloses', undefined],
                ['C', f.c, 'listCollectionPortfolio', undefined], ['C', f.c, 'getCashPosition', s.C], ['C', f.c, 'listCashDeliveries', undefined], ['C', f.c, 'getCashDelivery', r.id], ['O', f.o, 'getCashPosition', s.O], ['O', f.o, 'getCashDelivery', r.id], ['O', f.o, 'listCashStations', undefined]];
            for (const [n, a, op, id] of reads)
                res[`${n} ${op}`] = w.st(await w.settle(() => f.collections.read(a.issued.context, op, w.org, id, {})));
            const pv = await w.prepared(() => f.request('1000.00'));
            res['C previewCashDelivery REQUEST'] = pv.failed ? w.st(pv.failed) : '200';
            const after = await all(), changed = Object.keys(after).filter(c => before[c] !== after[c]), protectedSet = new Set([...S5, ...S6, ...S7, ...LEDGER, ...EVIDENCE, ...AUDIT]);
            o['results'] = res;
            o['collections changed'] = changed;
            o['protected changed'] = changed.filter(c => protectedSet.has(c));
            assert.deepEqual(o['protected changed'], []);
            for (const [k, v] of Object.entries(res))
                assert.match(v, /^200/, k);
        });
    }
    finally {
        await group.dispose();
    }
});
//# sourceMappingURL=review.test.js.map