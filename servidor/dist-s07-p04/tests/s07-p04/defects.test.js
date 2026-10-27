import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { s07Profile } from './profile.js';
import { setup, code } from './fixture.js';
import { fundedSetup } from '../operations/fixture.js';
import { Database } from '../../src/shared/database.js';
import { RestoreController } from '../../src/shared/restore.js';
import { head } from '../../src/modules/lending/integrity.js';
import { today } from '../../src/modules/finance/service.js';
test('P04 integrated S07 reproductions of the three inherited S06 defects', { timeout: 300000 }, async (t) => {
    const group = await s07Profile();
    try {
        await t.test('H01 current plan approves two pending intents after another receipt', async () => {
            const f = await setup(group), o = await f.member('O'), l = await f.loan({ principal: '2000000.00' });
            await f.disburse(l);
            const bank = await f.accountS06('BANK_H01', 'ASSET', 'BANK');
            const register = async (actor = o, amount = '100000.00', mode = 'SUPERVISED') => (await (await f.preparePayment({ kind: 'REGISTER', mode, effectiveDate: today(f.now()), intent: await f.intent(l, bank.id, amount, actor) }, actor)).execute()).data;
            const first = await register(), second = await register();
            await register(f.a, '50000.00', 'DIRECT');
            for (const id of [first.entityId, second.entityId]) {
                const p = await f.readPayment(id), v = await f.state(), intentBefore = JSON.stringify(p.data.intent);
                const planned = await f.preparePayment({ kind: 'APPROVE', paymentId: id, resourceETag: p.etag, effectiveDate: today(f.now()), expectedOperationsETag: v.operationsBookETag });
                assert.equal((await planned.execute()).status, 201);
                assert.equal(JSON.stringify((await f.readPayment(id)).data.intent), intentBefore);
            }
            // This fixture has 60k initially due. Total receipts250k pay60I+190P.
            assert.equal((await f.position(l.id)).data.principalOutstanding, '1810000.00');
            const pending = await register(), captured = JSON.stringify((await f.readPayment(pending.entityId)).data);
            const settlement = await f.intent(l, bank.id, '1810000.00', f.a);
            settlement.targets[0].mode = 'EXTRA_PRINCIPAL';
            await (await f.preparePayment({ kind: 'REGISTER', mode: 'DIRECT', effectiveDate: today(f.now()), intent: settlement }, f.a)).execute();
            assert.equal((await f.position(l.id)).data.status, 'SETTLED');
            const current = await f.readPayment(pending.entityId), versions = await f.state(), journalCount = await f.runtime.finance.journals.countDocuments({ organizationId: f.org });
            await assert.rejects(f.preparePayment({ kind: 'APPROVE', paymentId: pending.entityId, resourceETag: current.etag, effectiveDate: today(f.now()), expectedOperationsETag: versions.operationsBookETag }), e => e instanceof Error && 'code' in e && ['PAYMENT_STATE_CONFLICT', 'EXCESS_NOT_ALLOWED'].includes(String(e.code)));
            assert.equal(JSON.stringify((await f.readPayment(pending.entityId)).data), captured);
            assert.equal(await f.runtime.finance.journals.countDocuments({ organizationId: f.org }), journalCount);
        });
        await t.test('H03 discrepancy and investigation cannot link before disposition to pending', async () => {
            const f = await setup(group), l = await f.loan();
            await f.disburse(l);
            const bank = await f.accountS06('BANK_H03', 'ASSET', 'BANK'), intent = await f.intent(l, bank.id);
            const payment = (await (await f.preparePayment({ kind: 'REGISTER', mode: 'DIRECT', effectiveDate: today(f.now()), intent })).execute()).data;
            const account = await f.runtime.finance.read(f.a.issued.context, 'readAccount', f.org, bank.id);
            const declaration = (await f.mutatePayment('createBankDeclaration', { accountId: bank.id, accountETag: account.etag, currency: 'COP', direction: 'INCOMING', amount: intent.amount, valueDate: intent.observedDate, reference: intent.receiptReference, source: 'MANUAL_DECLARATION', declaredBankName: 'Banco sintético', statementReference: 'SYN-H03', lineReference: '1', supportReference: 'SYN' })).data;
            const dispose = async (state) => { const p = await f.readPayment(payment.entityId); await f.mutatePayment('disposeReconciliation', { paymentId: payment.entityId, resourceETag: p.etag, state, reason: 'Revisión sintética', supportReference: 'SYN' }); };
            const link = async () => { const p = await f.readPayment(payment.entityId); return await f.mutatePayment('linkReconciliation', { paymentId: payment.entityId, paymentETag: p.etag, bankDeclarationId: declaration.entityId, bankDeclarationETag: declaration.entityETag, supportReference: 'SYN' }); };
            await dispose('DISCREPANCY');
            await assert.rejects(link(), code('STATE_CONFLICT'));
            await assert.rejects(dispose('PENDING'), code('STATE_CONFLICT'));
            await dispose('INVESTIGATION');
            await assert.rejects(link(), code('STATE_CONFLICT'));
            await dispose('PENDING');
            assert.equal((await link()).status, 201);
        });
        await t.test('H02 reviewed reopen after interrupted migration must already use HMAC', async () => {
            const f = await fundedSetup({ ...group, fixture: () => group.fixture({ legacy: true }) }), l = await f.loan();
            await f.disburse(l);
            await f.restore.flush();
            const peer = new Database(group.uri, f.database.db.databaseName);
            await peer.connect();
            try {
                const priority = randomBytes(32), original = peer.db.collection.bind(peer.db);
                let injected = false;
                peer.db.collection = ((name, ...options) => {
                    const collection = Reflect.apply(original, peer.db, [name, ...options]);
                    return new Proxy(collection, { get(target, property) {
                            const value = Reflect.get(target, property);
                            if (name === 'lending_merkle_nodes' && property === 'bulkWrite')
                                return async () => { injected = true; throw Error('S07 injected interrupted migration'); };
                            return typeof value === 'function' ? value.bind(target) : value;
                        } });
                });
                const attempted = new RestoreController(peer, join(group.folder, 'gate.json'), f.keys.journal, priority);
                await assert.rejects(attempted.initialize());
                assert.equal(injected, true);
                assert.equal(attempted.isOpen(), false);
                peer.db.collection = original;
                const reviewed = new RestoreController(peer, join(group.folder, 'gate.json'), f.keys.journal, priority);
                await reviewed.initialize();
                assert.equal(reviewed.isOpen(), false);
                await reviewed.reconcile({ approved: true, reviewId: 'SYN-H02' });
                assert.equal(reviewed.isOpen(), true);
                const current = await head(peer);
                assert.equal(current?.format, 'lending-v2');
                assert.equal(current?.priorityPolicy, 'HMAC-SHA256-v1');
            }
            finally {
                await peer.close();
            }
        });
    }
    finally {
        await group.dispose();
    }
});
//# sourceMappingURL=defects.test.js.map