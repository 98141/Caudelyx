import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { s10Profile } from './profile.js';
import { world, code } from './fixture.js';
import { today } from '../../src/modules/obligations/calendar.js';
import { RestoreController } from '../../src/shared/restore.js';
import { ProjectionRuntime } from '../../src/modules/reporting/projection/service.js';
import { managementEvidenceMatches, managementHead } from '../../src/modules/obligations/evidence.js';
import { ApiClient } from '../helpers/client.js';
const data = (r) => r.data;
test('S10 current authority, genuine invited roles, two processes, HTTPS lost response and restore fail closed', { timeout: 300000 }, async (t) => {
    const group = await s10Profile();
    try {
        const f = await world(group), date = today(f.now()), pp = { bookId: f.book.id }, wallet = await f.personal('SEC_BANK', 'ASSET', 'BANK'), equity = await f.personal('SEC_EQUITY', 'EQUITY'), read = (op, p = pp, q = { asOf: date }, actor = f.a) => f.wealthRead('personal' + op, p, q, actor), tag = async () => String((await read('GetWealthBook')).etag);
        const fund = await f.wealthMutate('personalCreateFund', { mode: 'ACCOUNT_LINKED', label: 'PRIVATE-S10-DO-NOT-EXPOSE', purpose: 'SAVINGS', backingAccountId: wallet.id, supportReference: 'SYN' }, pp), fp = { ...pp, fundId: String(data(fund)['id']) };
        await f.wealthMutate('personalRecordExternalFunds', { bookETag: await tag(), effectiveDate: date, amount: '1000.00', cashAccountId: wallet.id, provenanceKind: 'DECLARED', supportReference: 'SYN', nature: 'OWNER_CAPITAL_CONTRIBUTION', equityAccountId: equity.id, contributorReference: 'SYN' }, pp);
        const snapshot = await read('ListFunds');
        await t.test('actual C/O/P/A and foreign T cannot read private rows/aggregates/cursor or BUSINESS wealth', async () => {
            for (const role of ['C', 'O', 'P', 'A']) {
                const actor = await f.actor(), payload = { email: actor.email, roleIds: [role] };
                await f.proof(f.a, 'MEMBER_INVITE', payload, f.org);
                await f.runtime.organizations.invite(f.a.issued.context, payload);
                await f.identity.dispatchMail();
                const invitation = [...f.messages.notificationInbox.values()].find(m => m.kind === 'INVITATION' && m.payload['email'] === actor.email);
                assert.ok(invitation);
                await f.runtime.organizations.accept(actor.issued.context, { mode: 'CONFIRM', token: invitation.payload['token'] }, randomUUID());
                for (const op of ['ListFunds', 'ListAssets', 'GetWealthPositions'])
                    await assert.rejects(() => read(op, pp, { asOf: date, snapshotToken: snapshot.meta['snapshotToken'] }, actor), code('RESOURCE_NOT_FOUND'));
                await assert.rejects(() => f.wealthRead('getPrivateWealth', {}, { asOf: date }, actor), code('RESOURCE_NOT_FOUND'));
                await assert.rejects(() => f.wealthRead('businessListFunds', { organizationId: f.org }, { asOf: date }, actor), code('ACCESS_DENIED'));
            }
            const foreign = await f.actor();
            await f.runtime.organizations.create(foreign.issued.context, { name: 'Otra organización sintética S10', currency: 'COP', timezone: 'America/Bogota' }, randomUUID());
            await assert.rejects(() => read('ListFunds', pp, { asOf: date }, foreign), code('RESOURCE_NOT_FOUND'));
            const subject = f.a.issued.context.subjectId, original = await f.identity.identities.findOne({ _id: subject });
            assert.ok(original);
            for (const roles of [['SA'], ['T', 'SA']]) {
                await f.identity.identities.updateOne({ _id: subject }, { $set: { roles: roles } });
                await assert.rejects(() => read('ListFunds'), code('ACCESS_DENIED'));
            }
            await f.identity.identities.updateOne({ _id: subject }, { $set: { roles: original.roles } });
            const org = await f.database.db.collection('organizations').findOne({ _id: f.org });
            await f.database.db.collection('organizations').updateOne({ _id: f.org }, { $set: { status: 'SUSPENDED' } });
            assert.equal((await read('ListFunds')).status, 200);
            await assert.rejects(() => f.wealthRead('businessListFunds', { organizationId: f.org }, { asOf: date }), code('ACCESS_DENIED'));
            await f.database.db.collection('organizations').updateOne({ _id: f.org }, { $set: { status: org.status } });
            await f.identity.identities.updateOne({ _id: subject }, { $set: { roles: ['C'], organizationId: null } });
            assert.equal((await read('ListFunds')).status, 200);
            await f.identity.identities.updateOne({ _id: subject }, { $set: { roles: original.roles, organizationId: original.organizationId } });
            const old = await f.sessions.contexts.findOne({ _id: f.a.issued.context._id });
            assert.ok(old);
            await f.sessions.contexts.updateOne({ _id: old._id }, { $set: { 'balanceGrant.expiresAt': f.now() } });
            await assert.rejects(async () => f.wealthMutate('personalAllocateFund', { bookETag: await tag(), effectiveDate: date, amount: '1.00', supportReference: 'SYN' }, fp, (await read('GetFund', fp)).etag, randomUUID(), f.a, false), code('R_REQUIRED'));
            await f.sessions.contexts.updateOne({ _id: old._id }, { $set: { balanceGrant: old.balanceGrant } });
        });
        await t.test('two real processes: same key one event; different keys with same CAS one winner', async () => {
            await f.restore.flush();
            const peer = await group.peer({ now: f.now(), keys: f.keys });
            try {
                const payload = { bookETag: await tag(), effectiveDate: date, amount: '100.00', supportReference: 'SYN' }, expected = (await read('GetFund', fp)).etag, key = randomUUID(), command = { token: f.a.issued.token, operation: 'personalAllocateFund', params: fp, payload, key, expected }, results = await Promise.all([peer.execute(command), f.wealthMutate('personalAllocateFund', payload, fp, expected, key)]);
                assert.deepEqual(results.map(r => r['status']).sort(), [200, 201]);
                assert.equal(data(await read('GetFund', fp))['reserved'], '100.00');
                const next = { ...payload, bookETag: await tag() }, etag = (await read('GetFund', fp)).etag, collision = await Promise.allSettled([peer.execute({ ...command, payload: next, expected: etag, key: randomUUID() }), f.wealthMutate('personalAllocateFund', next, fp, etag, randomUUID())]), answers = collision.map(r => r.status === 'fulfilled' ? r.value : r.reason);
                assert.equal(answers.filter(r => r.status === 201).length, 1);
                assert.equal(answers.filter(r => r.code === 'PRECONDITION_FAILED').length, 1);
            }
            finally {
                await peer.close();
            }
        });
        await t.test('HTTPS response lost after commit replays once; closed query/origin and opaque cursor binding', async () => {
            if (Number(data(await read('GetFund', fp))['reserved']) < 2)
                await f.wealthMutate('personalAllocateFund', { bookETag: await tag(), effectiveDate: date, amount: '10.00', supportReference: 'SYN-INDEPENDENT-HTTP' }, fp, (await read('GetFund', fp)).etag);
            const https = await f.https(), http = https.client;
            http.cookies.set('__Host-caudelyx-session', f.a.issued.token);
            await http.refreshCsrf();
            const path = '/api/v1/me/personal/books/' + f.book.id + '/wealth-s10/funds/' + fp.fundId + '/releases', proxy = await f.proxy(https, path), lost = new ApiClient(proxy.port, proxy.cert);
            lost.cookies.set('__Host-caudelyx-session', f.a.issued.token);
            lost.csrf = http.csrf;
            const key = randomUUID(), headers = { 'Idempotency-Key': key, 'If-Match': (await read('GetFund', fp)).etag, 'Origin': f.config.tenantOrigin }, payload = { bookETag: await tag(), effectiveDate: date, amount: '1.00', supportReference: 'SYN' }, count = await f.database.db.collection('s10_fund_events_personal').countDocuments();
            await assert.rejects(() => lost.call('POST', path, payload, headers));
            const replay = await http.call('POST', path, payload, headers);
            assert.equal(replay.status, 200);
            assert.equal(await f.database.db.collection('s10_fund_events_personal').countDocuments(), count + 1);
            assert.equal((await http.call('POST', path, payload, { ...headers, 'Origin': 'https://invalid.example.test' })).status, 400);
            assert.equal((await http.call('GET', '/api/v1/me/personal/books/' + f.book.id + '/wealth-s10/funds?asOf=' + date + '&ownerId=' + randomUUID())).status, 422);
            const current = await read('ListFunds');
            await assert.rejects(() => read('ListAssets', pp, { asOf: date, snapshotToken: current.meta['snapshotToken'] }), code('REPORT_TOKEN_INVALID'));
            await assert.rejects(() => read('ListFunds', pp, { asOf: date, snapshotToken: 'invalid' }), code('REPORT_TOKEN_INVALID'));
        });
        await t.test('restore old cut rejected; intact restores revoke W; hot tamper+undo latches; missing new original closes restart', async () => {
            const before = await f.restore.snapshot();
            await f.wealthMutate('personalAllocateFund', { bookETag: await tag(), effectiveDate: date, amount: '1.00', supportReference: 'SYN' }, fp, (await read('GetFund', fp)).etag);
            const after = await f.restore.snapshot();
            await f.restore.beginRestore(before);
            await assert.rejects(() => f.restore.reconcile({ approved: true, reviewId: 'SYN-S10-OLD-CUT' }), code('SERVICE_UNAVAILABLE'));
            assert.equal(f.restore.isOpen(), false);
            await f.restore.beginRestore(after);
            await f.restore.reconcile({ approved: true, reviewId: 'SYN-S10-INTACT' });
            assert.equal(f.restore.isOpen(), true);
            assert.equal(await f.sessions.findPersonal(f.a.issued.token), null);
            assert.equal(await managementEvidenceMatches(f.database, (await managementHead(f.database))), true);
            await f.service.prepareOwned(f.owner);
            await f.service.activateOwned(f.owner);
            const projection = await ProjectionRuntime.createOwned(f.identity, f.keys.cursor, f.owner);
            f.identity.reporting.projection = projection;
            const raw = f.database.client.db(f.database.db.databaseName), event = await raw.collection('s10_fund_events_personal').findOne({ kind: 'FUND_ALLOCATE' });
            assert.ok(event);
            const priorHead = await managementHead(f.database);
            await raw.collection('s10_fund_events_personal').updateOne({ _id: event._id }, { $set: { amount: '999.00' } });
            await assert.rejects(() => f.database.transaction(async (s) => { f.service.store.tracking.begin(s); try {
                const scope = { kind: 'PERSONAL', bookId: f.book.id, ownerId: f.a.issued.context.subjectId }, row = await f.service.store.get('s10_funds_personal', fp.fundId, scope, s);
                await f.service.store.put('s10_funds_personal', { ...row, label: 'No bendecir fuente corrupta', version: row.version + 1 }, s);
                await f.service.store.touch(scope, s);
                await f.service.store.finish(s);
            }
            finally {
                f.service.store.tracking.end(s);
            } }));
            assert.deepEqual(await managementHead(f.database), priorHead);
            await raw.collection('s10_fund_events_personal').replaceOne({ _id: event._id }, event);
            await assert.rejects(() => f.service.enter());
            assert.equal(await managementEvidenceMatches(f.database, (await managementHead(f.database))), true);
            await f.service.stop();
            await projection.stop();
            await raw.collection('s10_fund_events_personal').deleteOne({ _id: event._id });
            const controller = new RestoreController(f.database, join(group.folder, 'gate.json'), f.keys.journal, f.keys.priority, f.keys.cursor);
            await controller.initialize();
            assert.equal(controller.isOpen(), false);
        });
        await t.test('signed S10 catalogue requires even an empty physical original at restart; drop latches the hot observer', async () => {
            const g = await world(group), raw = g.database.client.db(g.database.db.databaseName);
            assert.equal(await raw.collection('s10_asset_valuations_personal').countDocuments(), 0);
            await g.restore.flush();
            await raw.collection('s10_asset_valuations_personal').drop();
            await assert.rejects(() => g.service.enter());
            await g.service.stop();
            await g.projection.stop();
            const controller = new RestoreController(g.database, join(group.folder, 'gate.json'), g.keys.journal, g.keys.priority, g.keys.cursor);
            await controller.initialize();
            assert.equal(controller.isOpen(), false);
        });
    }
    finally {
        await group.dispose();
    }
});
//# sourceMappingURL=restore.test.js.map