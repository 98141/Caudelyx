import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { s11Profile, world } from './fixture.js';
import { workbook } from './oracle.js';
import { today } from '../../src/modules/obligations/calendar.js';
const denied = async (work) => await assert.rejects(work, (e) => e instanceof Error && 'status' in e && [401, 403, 404, 409].includes(Number(e.status)));
test('S11 current privacy: actual invited roles, foreign tenant, PERSONAL, opaque cursor/job/file, epochs, suspension and closed contexts', { timeout: 360000 }, async (t) => {
    const group = await s11Profile();
    try {
        const f = await world(group), service = f.identity.exchange, params = { organizationId: f.org }, date = today(f.now()), query = { asOf: date, from: date, to: date }, ownerId = f.a.issued.context.subjectId;
        const oldURL = new URL('../../../dist-s10-p04/src/modules/obligations/evidence.js', import.meta.url).href, old = await import(oldURL);
        old.configureManagementEvidence(f.database, f.keys.cursor);
        old.configureManagementTransport(f.database, f.keys.cursor);
        assert.equal(await old.managementEvidenceMatches(f.database, (await old.managementHead(f.database)) ?? undefined), true, 'frozen old reader accepts original format2 control');
        const created = await service.createImport(f.a.issued.context, 'createBusinessImport', { label: 'PRIVATE_OWNER_LABEL', namespace: 'OWNER_IMPORT', mode: 'OPERATIVE', templateVersion: '1.0.0', mappingVersion: 'S11-MAP-1' }, params, randomUUID()), ps = { ...params, importId: String(created.data['id']) }, u = await service.upload(f.a.issued.context, ps, randomUUID(), created.etag, workbook('OPERATIVE', 'OWNER_IMPORT', { Cuentas: [{ externalKey: 'PRIVATE', action: 'CREATE', code: 'PRIVATE_ACCOUNT', name: 'PRIVATE_OWNER_NAME', accountClass: 'ASSET', kind: 'BANK', currency: 'COP' }] })), job = await service.preparePreview(f.a.issued.context, ps, randomUUID(), u.etag), snapshot = await service.report(f.a.issued.context, { ...params, reportKind: 'CASH' }, query), output = await service.createExport(f.a.issued.context, params, { reportKind: 'CASH', format: 'CSV', snapshotToken: snapshot.data['meta']['snapshotToken'] }, randomUUID()), ep = { ...params, exportId: String(output.data['id']) };
        assert.equal(await old.managementEvidenceMatches(f.database, (await old.managementHead(f.database)) ?? undefined), false, 'frozen old reader rejects S11 format3 instead of certifying unknown sources');
        const templatePolicy = await service.policy(f.a.issued.context, params);
        assert.equal(templatePolicy.data['templates'].length, 4);
        await t.test('real C/O/P/A/L invitees cannot read owner imports, exports, jobs or PERSONAL data; report policy stays role-specific', async () => {
            const read = service.files.read.bind(service.files);
            let reads = 0;
            service.files.read = async (...args) => { reads++; return await read(...args); };
            try {
                for (const role of ['C', 'O', 'P', 'A', 'L']) {
                    const actor = await f.actor(), payload = { email: actor.email, roleIds: [role] };
                    await f.proof(f.a, 'MEMBER_INVITE', payload, f.org);
                    await f.runtime.organizations.invite(f.a.issued.context, payload);
                    await f.identity.dispatchMail();
                    const mail = [...f.messages.notificationInbox.values()].find(m => m.kind === 'INVITATION' && m.payload['email'] === actor.email);
                    assert.ok(mail);
                    await f.runtime.organizations.accept(actor.issued.context, { mode: 'CONFIRM', token: mail.payload['token'] }, randomUUID());
                    const before = reads;
                    await denied(() => service.readImport(actor.issued.context, ps, 'getBusinessImport'));
                    await denied(() => service.readImport(actor.issued.context, ps, 'getBusinessImportPreview'));
                    await denied(() => service.job(actor.issued.context, { ...params, jobId: String(job.data['id']) }));
                    await denied(() => service.readExport(actor.issued.context, ep, 'getBusinessExport'));
                    await denied(() => service.download(actor.issued.context, ep, randomUUID(), false, output.etag));
                    await denied(() => service.policy(actor.issued.context, { bookId: f.book.id }));
                    assert.equal(reads, before, role + ' must not touch a foreign file');
                    if (['C', 'O', 'P'].includes(role)) {
                        const policy = await service.policy(actor.issued.context, params), kinds = policy.data['reportKinds'];
                        assert.deepEqual(policy.data['templates'], []);
                        assert.equal(kinds.includes('ASSETS'), false);
                        assert.equal(kinds.includes('CONSOLIDATED_SUMMARY'), false);
                        assert.equal(kinds.includes('PORTFOLIO'), role === 'C');
                        assert.equal(kinds.includes('CASH'), role !== 'P');
                    }
                    else
                        await denied(() => service.policy(actor.issued.context, params));
                }
            }
            finally {
                service.files.read = read;
            }
        });
        await t.test('foreign T cannot resolve opaque IDs, owner counts or cursor; PERSONAL book is not implicitly created', async () => {
            const b = await f.actor(), other = (await f.runtime.organizations.create(b.issued.context, { name: 'Otro titular sintético', currency: 'COP', timezone: 'America/Bogota' }, randomUUID())).data.organization.id;
            for (const op of ['getBusinessImport', 'getBusinessImportReceipt', 'getBusinessImportPreview'])
                await denied(() => service.readImport(b.issued.context, { organizationId: other, importId: ps.importId }, op));
            const before = await f.database.db.collection('s09_books').countDocuments();
            await denied(() => service.report(b.issued.context, { bookId: f.book.id, reportKind: 'PERSONAL_SUMMARY' }, query));
            assert.equal(await f.database.db.collection('s09_books').countDocuments(), before);
            await denied(() => service.reportPage(b.issued.context, { organizationId: other, reportKind: 'CASH' }, { snapshotToken: snapshot.data['meta']['snapshotToken'] }));
            await denied(() => service.readExport(b.issued.context, { organizationId: other, exportId: ep.exportId }, 'getBusinessExport'));
        });
        await t.test('current actor/org credentials, revocation, SA combination and non-W contexts deny prepared artifacts', async () => {
            const actor = await f.identity.identities.findOne({ _id: ownerId });
            assert.ok(actor);
            const original = await f.sessions.contexts.findOne({ _id: f.a.issued.context._id });
            assert.ok(original);
            // Explicit state-injection negatives in the synthetic fixture. No native SA
            // provisioning or persistent authority is claimed by these combinations.
            for (const change of [{ roles: ['T', 'SA'] }, { roles: ['SA'] }, { authEpoch: randomUUID() }, { credentialVersion: randomUUID() }, { suspended: true, state: 'SUSPENDED' }]) {
                await f.identity.identities.updateOne({ _id: ownerId }, { $set: change });
                try {
                    await denied(() => service.readExport(f.a.issued.context, ep, 'getBusinessExport'));
                    await denied(() => service.download(f.a.issued.context, ep, randomUUID(), false, output.etag));
                }
                finally {
                    await f.identity.identities.replaceOne({ _id: ownerId }, actor);
                }
            }
            for (const kind of ['B', 'L', 'P', 'E_INITIAL']) {
                await f.sessions.contexts.updateOne({ _id: original._id }, { $set: { kind } });
                try {
                    await denied(() => service.readExport(f.a.issued.context, ep, 'getBusinessExport'));
                }
                finally {
                    await f.sessions.contexts.replaceOne({ _id: original._id }, original);
                }
            }
            await f.sessions.contexts.updateOne({ _id: original._id }, { $set: { revoked: true } });
            try {
                await denied(() => service.readExport(f.a.issued.context, ep, 'getBusinessExport'));
            }
            finally {
                await f.sessions.contexts.replaceOne({ _id: original._id }, original);
            }
        });
        await t.test('BUSINESS suspension blocks its old artifacts while native PERSONAL self remains readable', async () => {
            const org = await f.runtime.organizations.organizations.findOne({ _id: f.org });
            assert.ok(org);
            await f.runtime.organizations.organizations.updateOne({ _id: f.org }, { $set: { status: 'SUSPENDED' } });
            try {
                await denied(() => service.readExport(f.a.issued.context, ep, 'getBusinessExport'));
                assert.equal((await service.policy(f.a.issued.context, { bookId: f.book.id })).status, 200);
                assert.equal((await service.report(f.a.issued.context, { bookId: f.book.id, reportKind: 'PERSONAL_SUMMARY' }, query)).status, 200);
            }
            finally {
                await f.runtime.organizations.organizations.replaceOne({ _id: f.org }, org);
            }
        });
        await t.test('source and restore binding changes invalidate snapshots; integrity guard is not a fallback to partial data', async () => {
            const read = await service.readImport(f.a.issued.context, ps, 'getBusinessImport');
            f.clock.value += 60001;
            await service.cancelImport(f.a.issued.context, ps, randomUUID(), read.etag);
            const epoch = service.repo.store.restoreEpoch;
            service.repo.store.restoreEpoch = randomUUID();
            try {
                await denied(() => service.reportPage(f.a.issued.context, { ...params, reportKind: 'CASH' }, { snapshotToken: snapshot.data['meta']['snapshotToken'] }));
                await denied(() => service.download(f.a.issued.context, ep, randomUUID(), false, output.etag));
            }
            finally {
                service.repo.store.restoreEpoch = epoch;
            }
            const account = await f.account('SOURCE_CHANGED', 'ASSET', 'BANK');
            assert.ok(account);
            await denied(() => service.reportPage(f.a.issued.context, { ...params, reportKind: 'CASH' }, { snapshotToken: snapshot.data['meta']['snapshotToken'] }));
        });
        await t.test('BUSINESS reporting honors the S8 observer even when S9 is healthy; tamper and undo remains latched', async () => {
            const raw = f.database.client.db(f.database.db.databaseName), row = await raw.collection('reporting_projection_heads').findOne({ organizationId: f.org });
            assert.ok(row);
            await raw.collection('reporting_projection_heads').updateOne({ _id: row._id }, { $set: { syntheticTamper: true } });
            await raw.collection('reporting_projection_heads').replaceOne({ _id: row._id }, row);
            await assert.rejects(() => service.report(f.a.issued.context, { ...params, reportKind: 'CASH' }, query), (e) => e instanceof Error && 'status' in e && e.status === 503);
            assert.equal(f.runtime.obligations.active, true);
        });
    }
    finally {
        await group.dispose();
    }
});
//# sourceMappingURL=privacy.test.js.map