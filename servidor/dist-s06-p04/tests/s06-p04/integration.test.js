import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { BSON } from 'mongodb';
import { s06Profile, password, assertOwnUri } from './profile.js';
import { setup, code } from '../s06/fixture.js';
import { fundedSetup } from '../operations/fixture.js';
import { today } from '../../src/modules/finance/service.js';
import { domainCollections } from '../../src/modules/lending/evidence-v2.js';
import { head, lendingEvidenceMatches } from '../../src/modules/lending/integrity.js';
import { Database } from '../../src/shared/database.js';
import { RestoreController } from '../../src/shared/restore.js';
import { Sessions } from '../../src/modules/sessions/service.js';
import { IdentityService } from '../../src/modules/identity/service.js';
import { SyntheticMessaging } from '../../src/modules/messaging/service.js';
import { PasswordHasher } from '../../src/modules/identity/password.js';
import { attachRuntime } from '../../src/shared/runtime.js';
import { ApiClient } from '../helpers/client.js';
const bad = (e) => e instanceof Error && 'status' in e && [401, 403].includes(Number(e.status));
async function digest(db, names = [...domainCollections, 'financial_journals', 'financial_books', 'financial_evidence_head', 'audit_events', 'outbox', 'security_evidence_outbox']) { const hash = createHash('sha256'); for (const c of names) {
    hash.update(c);
    hash.update(BSON.EJSON.stringify(await db.db.collection(c).find({}).sort({ _id: 1 }).toArray(), { relaxed: false }));
} return hash.digest('hex'); }
test('P04 integrated Mongo/HTTPS economics, scopes and restore', { timeout: 600000 }, async (t) => {
    const group = await s06Profile();
    const scenario = async (name, fn) => { if (!process.env['P04_NATIVE_FOCUS'] || name.includes(process.env['P04_NATIVE_FOCUS']))
        await t.test(name, fn); };
    try {
        await scenario('S3 opening remains compatible with native S6 receipt and protected sources', async () => {
            const f = await fundedSetup(group, '2026-10-31T12:00:00-05:00', true), p = f.identity.payments, l = await f.loan({ principal: '2000000.00' });
            await f.disburse(l);
            const pos = await f.position(l.id), a = await f.runtime.finance.read(f.a.issued.context, 'readAccount', f.org, f.account), key = randomUUID(), book = (await p.read(f.a.issued.context, 'getPaymentsState', f.org)).data;
            const heldPayload = { code: 'HELD_P04', name: 'Fondos retenidos sintéticos', currency: 'COP', accountClass: 'LIABILITY', kind: 'GENERAL' }, held = (await f.runtime.finance.mutate(f.a.issued.context, 'createAccount', f.org, heldPayload, randomUUID())).data;
            const intent = { method: 'BANK', borrowerId: l.borrowerId, amount: '300000.00', currency: 'COP', destinationAccountId: f.account, destinationAccountETag: a.etag, custodianId: null, bindingETag: null, observedDate: today(f.now()), observedAt: new Date(f.now()).toISOString(), receiptReference: 'P04-OPENING', supportReference: 'SYN-P04', targets: [{ loanId: l.id, positionETag: pos.etag, amount: '300000.00', mode: 'REGULAR' }], excessDisposition: 'REJECT' };
            // The existing opening treasury is CASH. The method/account mismatch is rejected before ledger effects.
            const before = await digest(f.database);
            await assert.rejects(p.preview(f.a.issued.context, f.org, { executionKey: key, expectedPaymentsETag: book.paymentsBookETag, command: { kind: 'REGISTER', mode: 'DIRECT', effectiveDate: today(f.now()), intent } }), code('ACCOUNT_INELIGIBLE'));
            assert.equal(await digest(f.database), before);
            const cashTag = `"${f.a.issued.context.subjectId}:binding:0"`, heldRead = await f.runtime.finance.read(f.a.issued.context, 'readAccount', f.org, held.id);
            const config = async (operation, payload) => { const state = (await p.read(f.a.issued.context, 'getPaymentsState', f.org)).data, key = randomUUID(), command = { organizationId: f.org, idempotencyKey: key, expectedETag: state.paymentsBookETag, operationId: operation, resourceId: null, payload }; await f.proof(f.a, 'CUSTODY_BINDING_SET', command); return await p.mutate(f.a.issued.context, operation, f.org, payload, key, state.paymentsBookETag); };
            await config('setHeldFundsProfile', { configurationKind: 'HELD_FUNDS_PROFILE', heldLiabilityAccountId: held.id, heldLiabilityAccountETag: heldRead.etag, resourceETag: `"${f.org}:held-profile:0"`, supportReference: 'SYN' });
            await config('setCustodyBinding', { custodianId: f.a.issued.context.subjectId, accountId: f.account, accountETag: a.etag, heldLiabilityAccountId: held.id, heldLiabilityAccountETag: heldRead.etag, resourceETag: cashTag, supportReference: 'SYN' });
            const binding = await p.read(f.a.issued.context, 'getCustodyBinding', f.org, f.a.issued.context.subjectId), state = (await p.read(f.a.issued.context, 'getPaymentsState', f.org)).data;
            intent.method = 'CASH';
            intent.custodianId = f.a.issued.context.subjectId;
            intent.bindingETag = binding.etag;
            const command = { kind: 'REGISTER', mode: 'DIRECT', effectiveDate: today(f.now()), intent }, preview = (await p.preview(f.a.issued.context, f.org, { executionKey: key, expectedPaymentsETag: state.paymentsBookETag, command })).data, payload = { command, previewToken: preview.token };
            await f.proof(f.a, 'PAYMENT_REGISTER_DIRECT', { organizationId: f.org, idempotencyKey: key, expectedETag: state.paymentsBookETag, operationId: 'registerPayment', resourceId: null, payload });
            const result = await p.mutate(f.a.issued.context, 'registerPayment', f.org, payload, key, state.paymentsBookETag);
            assert.equal(result.status, 201);
            assert.equal((await f.position(l.id)).data && (await f.position(l.id)).data.principalOutstanding, '1760000.00');
            assert.equal(await lendingEvidenceMatches(f.database, (await head(f.database))), true);
        });
        await scenario('W without enrolled factor can register supervised; GET inventory has no economic writes', async () => {
            const f = await setup(group), bank = await f.accountS06('P04_BANK', 'ASSET', 'BANK'), loan = await f.loan({ principal: '2000000.00' });
            await f.disburse(loan);
            const p = await f.member('P'), newcomer = await f.signup(), confirmed = await f.identity.confirmEmail(newcomer.issued.context, { purpose: 'ACTIVATION', token: newcomer.token });
            assert.equal(confirmed.issued.context.kind, 'W');
            const invitation = { email: newcomer.email, roleIds: ['O'] };
            await f.proof(f.a, 'MEMBER_INVITE', invitation, f.org);
            await f.runtime.organizations.invite(f.a.issued.context, invitation);
            await f.identity.dispatchMail();
            const mail = [...f.messages.notificationInbox.values()].find(x => x.kind === 'INVITATION' && x.payload['email'] === newcomer.email);
            assert.ok(mail);
            await f.runtime.organizations.accept(confirmed.issued.context, { mode: 'CONFIRM', token: mail.payload['token'] }, randomUUID());
            assert.equal(await f.database.db.collection('factors').countDocuments({ subjectId: confirmed.issued.context.subjectId }), 0);
            const intent = await f.intent(loan, bank.id, '300000.00'), versions = await f.state(), key = randomUUID(), command = { kind: 'REGISTER', mode: 'SUPERVISED', effectiveDate: today(f.now()), intent }, preview = (await f.pay.preview(confirmed.issued.context, f.org, { executionKey: key, expectedPaymentsETag: versions.paymentsBookETag, command })).data, count = await f.runtime.finance.journals.countDocuments();
            const r = await f.pay.mutate(confirmed.issued.context, 'registerPayment', f.org, { command, previewToken: preview.token }, key, versions.paymentsBookETag), id = r.data.entityId;
            assert.equal(await f.runtime.finance.journals.countDocuments(), count);
            assert.equal((await f.position(loan.id)).data.principalOutstanding, '2000000.00');
            const https = await f.https(), clients = [f.a.issued, confirmed.issued, p.issued].map(issued => { const c = new ApiClient(https.port, https.cert); c.cookies.set('__Host-caudelyx-session', issued.token); return c; });
            const requests = [{ client: 0, path: '/payments/state' }, { client: 0, path: '/payments/policy' }, { client: 0, path: '/payments?limit=100' }, { client: 0, path: `/payments/${id}` }, { client: 0, path: `/loan-operations/positions/${loan.id}` }, { client: 0, path: `/loan-operations/positions/${loan.id}/installments?limit=100` }, { client: 0, path: `/loan-operations/positions/${loan.id}/schedule-versions?limit=100` }, { client: 1, path: '/payments/registration-contexts?limit=100' }, { client: 1, path: `/payments/${id}` }, { client: 2, path: `/payments/${id}` }];
            const before = await digest(f.database);
            for (const request of requests) {
                const r = await clients[request.client].call('GET', `/api/v1/organizations/${f.org}${request.path}`);
                assert.equal(r.status, 200, request.path);
            }
            assert.equal(await digest(f.database), before);
            assert.equal((await clients[1].call('GET', `/api/v1/organizations/${f.org}/loan-operations/positions/${loan.id}`)).status, 403);
            const basic = await f.signup();
            await assert.rejects(f.pay.read(basic.issued.context, 'getPaymentsPolicy', f.org), bad);
            const platform = await f.sessions.issue('PLATFORM', 'P', null);
            await assert.rejects(f.pay.read(platform.context, 'getPaymentsPolicy', f.org), bad);
            const foreign = await f.tenant(await f.newActor());
            await assert.rejects(f.pay.read(f.a.issued.context, 'getPayment', f.org, randomUUID()), code('RESOURCE_NOT_FOUND'));
            await assert.rejects(f.pay.read(f.a.issued.context, 'getPaymentsPolicy', foreign.org), bad);
            const pending = await f.readPayment(id), v = await f.state(), approval = await f.preparePayment({ kind: 'APPROVE', paymentId: id, resourceETag: pending.etag, effectiveDate: today(f.now()), expectedOperationsETag: v.operationsBookETag }, p);
            await approval.execute();
            assert.equal((await f.position(loan.id)).data.principalOutstanding, '1760000.00');
        });
        await scenario('restart and restore retain S6 compensation custody and ledger; older cut remains closed', async () => {
            const f = await setup(group), cash = await f.accountS06('P04_RESTORE', 'ASSET', 'CASH'), held = await f.heldProfile();
            await f.bind(f.a, cash.id, held);
            const l = await f.loan({ principal: '2000000.00' });
            await f.disburse(l);
            const earlier = await f.restore.snapshot(), intent = await f.intent(l, cash.id, '300000.00', f.a, 'CASH'), r = await (await f.preparePayment({ kind: 'REGISTER', mode: 'DIRECT', effectiveDate: today(f.now()), intent })).execute(), d = r.data;
            await (await f.reverse(d.eventId, d.entityId)).execute();
            const compensation = await f.runtime.finance.journals.findOne({ organizationId: f.org, 'source.type': 'LOAN_COMPENSATION' });
            assert.ok(compensation);
            const journal = await f.runtime.finance.read(f.a.issued.context, 'readJournal', f.org, compensation._id), reversePayload = { effectiveDate: today(f.now()), sourceId: randomUUID(), reason: 'SYN manual forbidden', supportReference: 'SYN-P04' };
            await assert.rejects(f.runtime.finance.mutate(f.a.issued.context, 'reverseJournal', f.org, reversePayload, randomUUID(), compensation._id, journal.etag), code('DOMAIN_REVERSAL_FORBIDDEN'));
            const current = await f.restore.snapshot(), names = [...domainCollections, 'financial_journals'], before = await digest(f.database, names), peer = new Database(group.uri, group.names[0]);
            await peer.connect();
            try {
                const restore = new RestoreController(peer, f.restore.gatePath, f.keys.journal, f.keys.priority);
                await restore.initialize();
                assert.equal(restore.isOpen(), true);
                assert.equal(await digest(peer, names), before);
            }
            finally {
                await peer.close();
            }
            await f.restore.beginRestore(current);
            await f.restore.reconcile({ approved: true, reviewId: 'P04_SYNTHETIC_OPERATOR_RESTORE_NOT_INDEPENDENT_REVIEW' });
            assert.equal(f.restore.isOpen(), true);
            assert.equal(await digest(f.database, names), before);
            const login = await f.identity.login('TENANT', randomUUID(), f.a.email, password);
            assert.equal(login.issued.context.kind, 'W');
            const custody = (await f.pay.read(login.issued.context, 'getCashCustody', f.org, d.entityId)).data;
            assert.equal(custody.unallocated, '300000.00');
            await f.restore.beginRestore(earlier);
            await assert.rejects(f.restore.reconcile({ approved: true, reviewId: 'P04_OLD_CUT_NEGATIVE' }), code('SERVICE_UNAVAILABLE'));
            assert.equal(f.restore.isOpen(), false);
        });
        await scenario('legacy exact replay survives HMAC activation while new legacy receipts are blocked', async () => {
            const f = await setup(group, { legacy: true }), bank = await f.accountS06('LEGACY_P04', 'ASSET', 'BANK'), l = await f.loan({ principal: '2000000.00' });
            await f.disburse(l);
            const pos = await f.position(l.id), account = await f.runtime.finance.read(f.a.issued.context, 'readAccount', f.org, bank.id), request = { kind: 'RECEIPT', borrowerId: l.borrowerId, destinationAccountId: bank.id, destinationAccountETag: account.etag, receivedAmount: '300000.00', targets: [{ loanId: l.id, positionETag: pos.etag, amount: '300000.00', mode: 'REGULAR' }], excessDisposition: 'REJECT', receiptReference: 'P04-EXACT-LEGACY', effectiveDate: today(f.now()), supportReference: 'SYN-P04' }, prepared = await f.make(request), committed = await prepared.execute();
            assert.equal(committed.status, 201);
            await f.restore.flush();
            const before = await digest(f.database, ['loan_events', 'loan_applications', 'loan_positions', 'loan_installments', 'financial_journals']), count = await f.runtime.finance.journals.countDocuments(), peer = new Database(group.uri, group.names[0]);
            await peer.connect();
            try {
                const keys = { ...f.keys, version: 2, priority: randomBytes(32) }, restore = new RestoreController(peer, f.restore.gatePath, keys.journal, keys.priority);
                await restore.initialize();
                assert.equal(restore.isOpen(), true);
                const sessions = new Sessions(peer, f.now), identity = new IdentityService(peer, sessions, new SyntheticMessaging(peer, keys.mail, f.now), new PasswordHasher(), () => restore.isOpen(), f.now);
                await identity.initialize();
                const runtime = await attachRuntime(identity, keys, f.config);
                const replay = await runtime.operations.mutate(f.a.issued.context, prepared.operation, f.org, prepared.payload, prepared.key, prepared.etag);
                assert.equal(replay.status, 200);
                assert.equal(await runtime.finance.journals.countDocuments(), count);
                assert.equal(await digest(peer, ['loan_events', 'loan_applications', 'loan_positions', 'loan_installments', 'financial_journals']), before);
                const book = await runtime.operations.read(f.a.issued.context, 'getLoanOperationsBook', f.org);
                await assert.rejects(runtime.operations.preview(f.a.issued.context, f.org, { executionKey: randomUUID(), expectedBookETag: book.etag, request }), code('PAYMENT_FLOW_REQUIRED'));
                await assert.rejects(runtime.operations.mutate(f.a.issued.context, prepared.operation, f.org, prepared.payload, randomUUID(), book.etag), code('PAYMENT_FLOW_REQUIRED'));
            }
            finally {
                await peer.close();
            }
        });
        await scenario('profile partial setup and protected URI active lease guards fail closed', async () => {
            for (const uri of ['mongodb://127.0.0.1:27017/?replicaSet=caudelyx-manual', 'mongodb://127.0.0.1:27181/?replicaSet=caudelyx-manual', 'mongodb://example.test:50000/?replicaSet=caudelyx-manual'])
                assert.throws(() => assertOwnUri(uri));
            await assert.rejects(group.fixture({ failSetup: true }), /Injected own partial setup failure/);
            const release = group.hold();
            try {
                await assert.rejects(group.dispose(), /Own fixture lease is live/);
            }
            finally {
                release();
            }
            await group.dispose();
        });
    }
    finally {
        await group.dispose();
    }
});
//# sourceMappingURL=integration.test.js.map