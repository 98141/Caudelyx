/* eslint-disable security/detect-object-injection -- Fixed synthetic response keys. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { s08Profile, password } from './profile.js';
import { cashSetup } from '../s07/fixture.js';
import { ProjectionRuntime } from '../../src/modules/reporting/projection/service.js';
import { today } from '../../src/modules/finance/service.js';
import { originals, collections } from '../../src/modules/reporting/projection/catalog.js';
import { hash } from '../../src/modules/reporting/projection/codec.js';
const metric = (data, id, scope = 'organizationMetrics') => data[scope].find(row => row['id'] === id)?.['value'];
test('owned projected HTTPS: exact money, same token across replay, scopes, legitimate writer and tamper', { timeout: 300000 }, async () => {
    const group = await s08Profile();
    let projection;
    const release = group.hold();
    try {
        const f = await cashSetup(group), web = await f.https(), base = '/api/v1/organizations/' + f.org + '/reporting';
        web.client.cookies.set('__Host-caudelyx-session', f.a.issued.token);
        const query = '?from=2026-10-01&to=' + today(f.now()) + '&asOf=' + today(f.now());
        const before = await web.client.call('GET', base + '/dashboard' + query);
        if (before.status !== 200) {
            try {
                await f.identity.reporting.read(f.a.issued.context, 'getReportingDashboard', f.org, undefined, { from: '2026-10-01', to: today(f.now()), asOf: today(f.now()) });
            }
            catch (error) {
                process.stdout.write('PROJECTED_READ_FAILURE ' + String(error) + '\n');
            }
        }
        assert.equal(before.status, 200, JSON.stringify(before.body));
        const ownership = async () => {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- Exact live owned fixture control path, checked by the harness.
            const owner = JSON.parse(await readFile(join(group.folder, 'owner.json'), 'utf8'));
            return owner.runId === group.runId && owner.pid === process.pid && owner.names[0] === f.database.db.databaseName && group.names[0] === f.database.db.databaseName;
        };
        projection = await ProjectionRuntime.createOwned(f.identity, f.keys.cursor, ownership);
        f.identity.reporting.projection = projection;
        const current = await web.client.call('GET', base + '/dashboard' + query);
        assert.equal(current.status, 200, JSON.stringify(current.body));
        const actual = current.body.data, expected = before.body.data;
        assert.deepEqual(actual['organizationMetrics'], expected['organizationMetrics']);
        assert.deepEqual(actual['meta']['coverage'], expected['meta']['coverage']);
        assert.equal(metric(actual, 'PRINCIPAL_OUTSTANDING'), '1760000.00');
        assert.equal(metric(actual, 'INTEREST_RECEIVED'), '60000.00');
        assert.equal(metric(actual, 'PRINCIPAL_RECOVERED'), '240000.00');
        const token = encodeURIComponent(String(actual['meta']['snapshotToken']));
        for (const report of ['PORTFOLIO', 'INSTALLMENTS', 'MOVEMENTS', 'CASH', 'RECONCILIATION', 'COLLECTORS', 'CONCENTRATION']) {
            const page = await web.client.call('GET', base + '/reports/' + report + '?snapshotToken=' + token + '&limit=20');
            assert.equal(page.status, 200, report + JSON.stringify(page.body));
        }
        const domainHash = async () => {
            const rows = [];
            for (const name of [...originals, ...Object.values(collections).filter(name => name !== collections.barriers), 'audit_events', 'outbox', 'transaction_fence', 'security_sequence', 'security_evidence_outbox', 'security_evidence_projection', 'contexts', 'identities', 'organizations'])
                rows.push([name, await f.database.db.collection(name).find({}).sort({ _id: 1 }).toArray()]);
            return hash(rows);
        };
        const state = await domainHash();
        await Promise.all([1, 2].map(() => web.client.call('GET', base + '/dashboard' + query + '&snapshotToken=' + token)));
        assert.equal(await domainHash(), state, 'GET changes no original/book/audit/evidence/fence');
        web.client.cookies.set('__Host-caudelyx-session', f.c.issued.token);
        const c = await web.client.call('GET', base + '/dashboard' + query);
        assert.equal(c.status, 200, JSON.stringify(c.body));
        assert.equal(metric(c.body.data, 'PRINCIPAL_OUTSTANDING', 'assignedMetrics'), '1760000.00');
        assert.equal('organizationMetrics' in c.body.data, false);
        const p = await f.member('P'), a = await f.member('A');
        web.client.cookies.set('__Host-caudelyx-session', p.issued.token);
        const pd = await web.client.call('GET', base + '/dashboard' + query);
        assert.equal(pd.status, 200, JSON.stringify(pd.body));
        assert.equal('organizationMetrics' in pd.body.data, false);
        assert.deepEqual(pd.body.data['ownActivityMetrics'].map(row => row['id']), ['RECEIPTS_REGISTERED']);
        web.client.cookies.set('__Host-caudelyx-session', a.issued.token);
        assert.equal((await web.client.call('GET', base + '/dashboard' + query)).status, 403);
        web.client.cookies.set('__Host-caudelyx-session', f.o.issued.token);
        const od = await web.client.call('GET', base + '/dashboard' + query);
        assert.equal(od.status, 200, JSON.stringify(od.body));
        const ot = encodeURIComponent(String(od.body.data['meta']['snapshotToken']));
        assert.equal((await web.client.call('GET', base + '/reports/PORTFOLIO?snapshotToken=' + ot)).status, 403);
        assert.equal((await web.client.call('GET', base + '/reports/CASH?snapshotToken=' + ot)).status, 200);
        web.client.cookies.set('__Host-caudelyx-session', f.a.issued.token);
        const requested = await (await f.request()).execute(), id = String(requested.data['entityId']);
        await f.act('dispatchCashDelivery', id, f.c);
        await f.act('receiveCashDelivery', id, f.o);
        await f.count(id);
        await (await f.confirm(id)).execute();
        const stale = await web.client.call('GET', base + '/reports/PORTFOLIO?snapshotToken=' + token);
        assert.equal(stale.status, 409, JSON.stringify(stale.body));
        const delivered = await web.client.call('GET', base + '/dashboard' + query);
        assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
        assert.equal(metric(delivered.body.data, 'DELIVERED_NET'), '250000.00');
        assert.equal(metric(delivered.body.data, 'LIQUIDITY_RESERVED'), '50000.00');
        const otherActor = await f.newActor(), other = await f.tenant(otherActor);
        const equityPayload = { code: 'OTHER_EQUITY', name: 'Capital sintético de otra organización', currency: 'COP', accountClass: 'EQUITY', kind: 'GENERAL' }, accountKey = randomUUID();
        await f.proof(otherActor, 'FINANCE_ACCOUNT_CREATE', { organizationId: other.org, idempotencyKey: accountKey, payload: equityPayload });
        const equity = (await f.runtime.finance.mutate(otherActor.issued.context, 'createAccount', other.org, equityPayload, accountKey)).data;
        const journal = { currency: 'COP', effectiveDate: today(f.now()), sourceId: randomUUID(), supportReference: 'S08-PROJECTION-OTHER', description: 'Capital sintético ajeno', lines: [{ accountId: other.account, debit: '777000.00', credit: '0.00' }, { accountId: equity['id'], debit: '0.00', credit: '777000.00' }] }, journalKey = randomUUID();
        await f.proof(otherActor, 'FINANCE_JOURNAL_POST', { organizationId: other.org, idempotencyKey: journalKey, payload: journal });
        await f.runtime.finance.mutate(otherActor.issued.context, 'postJournal', other.org, journal, journalKey);
        const stableToken = encodeURIComponent(String(delivered.body.data['meta']['snapshotToken']));
        const stillValid = await web.client.call('GET', base + '/dashboard' + query + '&snapshotToken=' + stableToken);
        assert.equal(stillValid.status, 200, JSON.stringify(stillValid.body));
        assert.deepEqual(stillValid.body.data['organizationMetrics'], delivered.body.data['organizationMetrics']);
        assert.equal((await web.client.call('GET', base.replace(f.org, other.org) + '/dashboard' + query)).status, 404);
        const raw = f.database.client.db(f.database.db.databaseName).collection('loan_positions');
        const row = await raw.findOne({ _id: f.l.id });
        assert.ok(row);
        await raw.updateOne({ _id: f.l.id }, { $set: { principalOutstanding: '1.00' } });
        await raw.updateOne({ _id: f.l.id }, { $set: { principalOutstanding: row.principalOutstanding } });
        const invalid = await web.client.call('GET', base + '/dashboard' + query);
        assert.equal(invalid.status, 503, JSON.stringify(invalid.body));
        assert.equal(await f.database.db.collection(collections.heads).countDocuments({ _id: f.org }), 1);
        const oldHead = await f.database.db.collection(collections.heads).findOne({ _id: f.org });
        const previousToken = encodeURIComponent(String(delivered.body.data['meta']['snapshotToken']));
        // Explicit synthetic operator rebuild after reverting and inspecting the source.
        projection = await ProjectionRuntime.createOwned(f.identity, f.keys.cursor, ownership, true);
        f.identity.reporting.projection = projection;
        const newHead = await f.database.db.collection(collections.heads).findOne({ _id: f.org });
        assert.notEqual(newHead.generation, oldHead.generation);
        assert.ok(await f.database.db.collection(collections.units).countDocuments({ generation: oldHead.generation }));
        assert.equal((await web.client.call('GET', base + '/dashboard' + query + '&snapshotToken=' + previousToken)).status, 409);
        const rebuilt = await web.client.call('GET', base + '/dashboard' + query);
        assert.equal(rebuilt.status, 200, JSON.stringify(rebuilt.body));
        assert.deepEqual(rebuilt.body.data['organizationMetrics'], delivered.body.data['organizationMetrics']);
        const restartToken = encodeURIComponent(String(rebuilt.body.data['meta']['snapshotToken']));
        await f.restore.flush();
        const peer = await group.peer({ keys: f.keys, now: f.now() });
        try {
            const read = await peer.execute({ operation: 'getReportingDashboard', org: f.org, token: f.a.issued.token, query: { from: '2026-10-01', to: today(f.now()), asOf: today(f.now()), snapshotToken: decodeURIComponent(restartToken) } });
            assert.equal(read['status'], 200, JSON.stringify(read));
            assert.deepEqual(read['data']['organizationMetrics'], delivered.body.data['organizationMetrics']);
            const parent = await web.client.call('GET', base + '/dashboard' + query + '&snapshotToken=' + restartToken);
            assert.equal(parent.status, 200, JSON.stringify(parent.body));
        }
        finally {
            await peer.close();
        }
        await projection.stop();
        projection = await ProjectionRuntime.createOwned(f.identity, f.keys.cursor, ownership);
        f.identity.reporting.projection = projection;
        assert.equal((await web.client.call('GET', base + '/dashboard' + query + '&snapshotToken=' + restartToken)).status, 200);
        await projection.stop();
        const head = await f.database.db.collection(collections.heads).findOne({ _id: f.org });
        const rawManifests = f.database.client.db(f.database.db.databaseName).collection(collections.manifests);
        const chunk = await rawManifests.findOne({ _id: head.lastManifest + ':0' });
        assert.ok(chunk);
        await rawManifests.updateOne({ _id: chunk._id }, { $set: { 'mutations.0.after': '0'.repeat(64) } });
        await assert.rejects(ProjectionRuntime.createOwned(f.identity, f.keys.cursor, ownership));
        assert.equal((await rawManifests.findOne({ _id: chunk._id })).mutations[0].after, '0'.repeat(64), 'No startup repair');
        await rawManifests.replaceOne({ _id: chunk._id }, chunk);
        projection = await ProjectionRuntime.createOwned(f.identity, f.keys.cursor, ownership);
        f.identity.reporting.projection = projection;
        const snapshot = await f.restore.snapshot();
        for (const name of Object.values(collections))
            assert.equal(name in snapshot.collections, false);
        await f.restore.beginRestore(snapshot);
        await f.restore.reconcile({ approved: true, reviewId: 'S08-projection-owned-current-cut' });
        assert.equal(f.restore.isOpen(), true);
        assert.equal(await f.database.db.collection(collections.heads).countDocuments(), 0);
        const oldSession = await web.client.call('GET', base + '/dashboard' + query);
        assert.ok([401, 403].includes(oldSession.status), JSON.stringify(oldSession.body));
        const login = await f.identity.login('TENANT', 'S08-PROJECTION-RESTORE', f.a.email, password);
        web.client.cookies.set('__Host-caudelyx-session', login.issued.token);
        projection = await ProjectionRuntime.createOwned(f.identity, f.keys.cursor, ownership);
        f.identity.reporting.projection = projection;
        const afterRestore = await web.client.call('GET', base + '/dashboard' + query);
        assert.equal(afterRestore.status, 200, JSON.stringify(afterRestore.body));
        assert.deepEqual(afterRestore.body.data['organizationMetrics'], delivered.body.data['organizationMetrics']);
        assert.equal((await web.client.call('GET', base + '/dashboard' + query + '&snapshotToken=' + restartToken)).status, 409);
        process.stdout.write('PROJECTED_FINANCIAL_PROOF ' + JSON.stringify({ principal: '1760000.00', interest: '60000.00', recovered: '240000.00', delivered: '250000.00', reserved: '50000.00', sameTokenSevenReports: true, getOriginalAndProjectionWrites: 0, copScopesAndADenied: true, otherTenant777kDoesNotInvalidateToken: true, tamperUndoBlocked: true, verifiedRebuildNewGeneration: true, realPeerTokenAndParentPreserved: true, restartTokenPreserved: true, coldManifestCorruptionBlockedWithoutRepair: true, restoreInvalidatesDerivedAndOldW: true, restoreEconomyEqual: true }) + '\n');
    }
    finally {
        await projection?.stop();
        release();
        await group.dispose();
    }
});
//# sourceMappingURL=projection.test.js.map