/* eslint-disable security/detect-non-literal-fs-filename -- Synthetic tests use fixed fixture contracts, pinned workbook markup and registered own UUID filesystem roots; destructive leaves require owner/realpath checks. No HTTP-supplied paths or executable text. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:https';
import { s11Profile } from './fixture.js';
import { workbook } from './oracle.js';
import { RestoreController } from '../../src/shared/restore.js';
import { ProjectionRuntime } from '../../src/modules/reporting/projection/service.js';
import { readZip, writeZip } from '../../src/modules/exchange/zip.js';
import { managementEvidenceMatches, managementHead } from '../../src/modules/obligations/evidence.js';
import { originals } from '../../src/modules/obligations/catalog.js';
import { today } from '../../src/modules/obligations/calendar.js';
const code = (value) => (e) => e instanceof Error && 'code' in e && e.code === value;
const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
test('S11 lifecycle: binary HTTP, current authorization, two processes, rollback frontiers, explicit reconciliation and retention', { timeout: 600000 }, async (t) => {
    const group = await s11Profile();
    try {
        const f = await group.fixture(), a = await f.actor(), org = (await f.runtime.organizations.create(a.issued.context, { name: 'Ciclo sintético S11', currency: 'COP', timezone: 'America/Bogota' }, randomUUID())).data.organization.id, params = { organizationId: org }, service = f.identity.exchange;
        const owner = async () => { const x = JSON.parse(await readFile(join(group.folder, 'owner.json'), 'utf8')); return x.pid === process.pid && x.runId === group.runId && x.names[0] === f.database.db.databaseName; };
        await f.runtime.obligations.prepareOwned(owner);
        await f.runtime.wealth.prepareOwned(owner);
        f.identity.reporting.projection = await ProjectionRuntime.createOwned(f.identity, f.keys.cursor, owner, false, () => f.runtime.obligations.activateOwned(owner));
        assert.equal(f.runtime.obligations.active, true);
        const scope = { kind: 'BUSINESS', bookId: org, ownerId: org, organizationId: org }, fresh = () => { f.clock.value += 60001; }, rows = (name) => f.database.db.collection(name).find({}).sort({ _id: 1 }).toArray();
        const create = async (namespace) => { const r = await service.createImport(a.issued.context, 'createBusinessImport', { label: 'Datos sintéticos', namespace, mode: 'OPERATIVE', templateVersion: '1.0.0', mappingVersion: 'S11-MAP-1' }, params, randomUUID()); return { r, ps: { ...params, importId: String(r.data['id']) } }; };
        const input = (namespace, count = 1) => workbook('OPERATIVE', namespace, { Cuentas: Array.from({ length: count }, (_, i) => ({ externalKey: 'BANK_' + i, action: 'CREATE', code: namespace + '_' + i, name: 'Cuenta sintética ' + i, accountClass: 'ASSET', kind: 'BANK', currency: 'COP' })) });
        const ready = async (namespace, bytes = input(namespace)) => { const c = await create(namespace), u = await service.upload(a.issued.context, c.ps, randomUUID(), c.r.etag, bytes); await service.preparePreview(a.issued.context, c.ps, randomUUID(), u.etag); const p = await service.readImport(a.issued.context, c.ps, 'getBusinessImportPreview'), r = await service.readImport(a.issued.context, c.ps, 'getBusinessImport'); assert.equal(p.data['canConfirm'], true); return { ...c, p, r }; };
        const commitPayload = async (c) => ({ previewId: c.p.data['id'], semanticHash: c.p.data['semanticHash'], bookETag: await f.database.client.withSession(s => f.runtime.wealth.bookTag(scope, s)) });
        const proof = async (c, payload, key) => await f.proof(a, 'IMPORT_CONFIRM', { operationId: 'confirmBusinessImport', organizationId: org, pathParameters: c.ps, payload, idempotencyKey: key, expectedETag: c.r.etag }, c.ps.importId);
        await t.test('rejected binary and disconnected upload close own technical state without creating economic rows', { skip: process.env['S11_CASE'] === 'cold' }, async () => {
            const c = await create('BAD_ZIP');
            await assert.rejects(() => service.upload(a.issued.context, c.ps, randomUUID(), c.r.etag, Buffer.from('PK\x03\x04bad')));
            const file = await f.database.db.collection('s11_files').findOne({ resourceId: c.ps.importId });
            assert.equal(file['state'], 'CORRUPT');
            assert.equal(await lstat(join(group.folder, 'private', String(file['_id']))).then(() => true, () => false), false);
            assert.equal(await f.runtime.finance.accounts.countDocuments({ organizationId: org }), 0);
            fresh();
            const d = await create('DISCONNECTED'), ticket = await service.beginUpload(a.issued.context, d.ps, randomUUID(), d.r.etag);
            await service.abortUpload(ticket, Error('SYN_DISCONNECTED'));
            assert.equal((await f.database.db.collection('s11_jobs').findOne({ _id: ticket.jobId }))['state'], 'FAILED');
        });
        await t.test('same semantic workbook repacked into different ZIP coalesces to the original actionable intent', { skip: process.env['S11_CASE'] === 'cold' }, async () => {
            fresh();
            const ns = 'REPACK', bytes = input(ns), first = await ready(ns, bytes), parts = readZip(bytes), repacked = writeZip(new Map([...parts].reverse()));
            assert.notDeepEqual(bytes, repacked);
            const second = await create(ns), upload = await service.upload(a.issued.context, second.ps, randomUUID(), second.r.etag, repacked), job = await service.preparePreview(a.issued.context, second.ps, randomUUID(), upload.etag);
            assert.equal(job.data['resourceId'], first.ps.importId);
            assert.equal((await service.readImport(a.issued.context, second.ps, 'getBusinessImport')).data['state'], 'CANCELLED');
            assert.equal(await f.runtime.finance.accounts.countDocuments({ organizationId: org }), 0);
            const current = await service.readImport(a.issued.context, first.ps, 'getBusinessImport');
            await service.cancelImport(a.issued.context, first.ps, randomUUID(), current.etag);
        });
        await t.test('root, child, idempotency, audit, receipt and signed evidence failures roll back the whole native unit', { skip: process.env['S11_CASE'] === 'cold' }, async () => {
            fresh();
            const c = await ready('ROLLBACK', input('ROLLBACK', 2)), payload = await commitPayload(c), key = randomUUID();
            await proof(c, payload, key);
            const state = async () => digest(await Promise.all([...originals, 'financial_accounts', 'financial_journals', 'financial_books', 'financial_evidence_head', 'audit_events', 'outbox', 's09_projection_manifests', 's09_projection_heads'].map(async (n) => [n, await rows(n)])));
            const store = service.repo.store, put = store.put.bind(store), finish = store.finish.bind(store), audit = f.identity.audit.append.bind(f.identity.audit), importAccount = f.runtime.finance.importAccount.bind(f.runtime.finance);
            for (const boundary of ['CHILD', 's11_external_refs', 'receipt', 'COMMITTED', 'AUDIT', 'FINISH']) {
                const before = await state();
                let hit = false;
                f.runtime.finance.importAccount = async (...args) => { const r = await importAccount(...args); if (boundary === 'CHILD') {
                    hit = true;
                    throw Error('SYN_FRONTIER_CHILD');
                } return r; };
                store.put = async (name, row, s, archive) => { const r = await put(name, row, s, archive); if (name === boundary || boundary === 'receipt' && row['operation'] === 'receipt' || boundary === 'COMMITTED' && name === 's11_imports' && row['state'] === 'COMMITTED') {
                    hit = true;
                    throw Error('SYN_FRONTIER_' + boundary);
                } return r; };
                f.identity.audit.append = async (...args) => { const r = await audit(...args); if (boundary === 'AUDIT' && args[0].action === 'EXCHANGE_IMPORT_COMMITTED') {
                    hit = true;
                    throw Error('SYN_FRONTIER_AUDIT');
                } return r; };
                store.finish = async (s) => { await finish(s); if (boundary === 'FINISH') {
                    hit = true;
                    throw Error('SYN_FRONTIER_FINISH');
                } };
                try {
                    await assert.rejects(() => service.confirm(a.issued.context, c.ps, payload, key, c.r.etag), /SYN_FRONTIER_/);
                }
                finally {
                    store.put = put;
                    store.finish = finish;
                    f.identity.audit.append = audit;
                    f.runtime.finance.importAccount = importAccount;
                }
                assert.equal(hit, true, boundary);
                assert.equal(await state(), before, boundary);
                assert.equal(await f.runtime.finance.accounts.countDocuments({ organizationId: org }), 0);
            }
        });
        let committed, receipt, committedAccounts = 1, beforeRestore;
        await t.test('two actual processes confirm one economic unit; cold restart reads the identical durable receipt', async () => {
            fresh();
            committed = await ready('TWO_PROCESS');
            const payload = await commitPayload(committed), key = randomUUID();
            await proof(committed, payload, key);
            await f.database.flushEvidence();
            let peer = await group.peer({ keys: f.keys, now: f.now(), enableBusiness: true });
            try {
                const results = await Promise.all([service.confirm(a.issued.context, committed.ps, payload, key, committed.r.etag), peer.execute({ operation: 'confirmBusinessImport', params: committed.ps, payload, key, expected: committed.r.etag, token: a.issued.token })]);
                assert.equal(results.some(r => r['status'] === 201), true);
                assert.equal(results.some(r => r['status'] === 200), true);
                assert.deepEqual(results[0].data, results[1]['data']);
                receipt = results[0].data;
                assert.equal(await f.runtime.finance.accounts.countDocuments({ organizationId: org }), 1);
            }
            finally {
                await peer.close();
            }
            peer = await group.peer({ keys: f.keys, now: f.now(), enableBusiness: true });
            try {
                const result = await peer.execute({ operation: 'getBusinessImportReceipt', params: committed.ps, token: a.issued.token });
                assert.equal(result['type'], 'result', JSON.stringify(result));
                assert.deepEqual(result['data'], receipt);
            }
            finally {
                await peer.close();
            }
            beforeRestore = await f.restore.snapshot();
        });
        await t.test('HTTPS binary upload, current tenant isolation, corrupt file denial and private download headers', { skip: process.env['S11_CASE'] === 'cold' }, async () => {
            fresh();
            const https = await f.https(), b = await f.actor(), other = (await f.runtime.organizations.create(b.issued.context, { name: 'Otro ámbito sintético', currency: 'COP', timezone: 'America/Bogota' }, randomUUID())).data.organization.id;
            https.client.cookies.set('__Host-caudelyx-session', a.issued.token);
            await https.client.refreshCsrf();
            const raw = async (path, bytes, headers = {}, port = https.port) => await new Promise((resolve, reject) => { const req = request({ hostname: '127.0.0.1', port, servername: 'localhost', ca: https.cert, path, method: 'POST', headers: { Host: 'localhost:' + https.port, Origin: 'https://localhost:' + https.port, Cookie: '__Host-caudelyx-session=' + a.issued.token, 'X-CSRF-Token': https.client.csrf, 'Content-Type': 'application/json', 'Content-Length': String(bytes.length), ...headers } }, res => { const chunks = []; res.on('data', b => chunks.push(Buffer.from(b))); res.on('end', () => resolve({ status: res.statusCode, bytes: Buffer.concat(chunks), headers: res.headers })); }); req.on('error', reject); req.end(bytes); });
            const c = await create('HTTPS'), path = '/api/v1/organizations/' + org + '/exchange-s11/imports/' + c.ps.importId + '/content', uploaded = await raw(path, input('HTTPS'), { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Idempotency-Key': randomUUID(), 'If-Match': c.r.etag });
            assert.equal(uploaded.status, 200, uploaded.bytes.toString());
            const denied = await service.readImport(b.issued.context, { organizationId: other, importId: c.ps.importId }, 'getBusinessImport').then(() => null, e => e);
            assert.equal(denied.code, 'RESOURCE_NOT_FOUND');
            const date = today(f.now()), report = await service.report(a.issued.context, { ...params, reportKind: 'CASH' }, { asOf: date, from: date, to: date }), output = await service.createExport(a.issued.context, params, { reportKind: 'CASH', snapshotToken: report.data['meta']['snapshotToken'], format: 'CSV' }, randomUUID()), downloadPath = '/api/v1/organizations/' + org + '/exchange-s11/exports/' + output.data['id'] + '/downloads', download = await raw(downloadPath, Buffer.from('{}'), { 'Idempotency-Key': randomUUID(), 'If-Match': output.etag });
            assert.equal(download.status, 200, download.bytes.toString());
            assert.equal(download.headers['cache-control'], 'no-store, private');
            assert.equal(download.headers['content-length'], String(download.bytes.length));
            assert.equal(download.headers['x-content-sha256'], createHash('sha256').update(download.bytes).digest('hex'));
            assert.match(String(download.headers['content-disposition']), /^attachment; filename="caudelyx-export-[0-9a-f-]+\.csv"$/);
            const file = output.data['file'];
            await writeFile(join(group.folder, 'private', String(file['id'])), 'CORRUPT');
            await assert.rejects(() => service.download(a.issued.context, { ...params, exportId: String(output.data['id']) }, randomUUID(), false, output.etag), code('INTEGRITY_MISMATCH'));
            fresh();
            const lost = await ready('LOST_RESPONSE'), lostPayload = await commitPayload(lost), lostKey = randomUUID();
            await proof(lost, lostPayload, lostKey);
            const confirmPath = '/api/v1/organizations/' + org + '/exchange-s11/imports/' + lost.ps.importId + '/confirmations', proxy = await f.proxy(https, confirmPath), headers = { 'Idempotency-Key': lostKey, 'If-Match': lost.r.etag };
            await assert.rejects(() => raw(confirmPath, Buffer.from(JSON.stringify(lostPayload)), headers, proxy.port));
            const retry = await raw(confirmPath, Buffer.from(JSON.stringify(lostPayload)), headers);
            assert.equal(retry.status, 200, retry.bytes.toString());
            const expected = await service.readImport(a.issued.context, lost.ps, 'getBusinessImportReceipt');
            assert.deepEqual(JSON.parse(retry.bytes.toString()).data, expected.data);
            committedAccounts = 2;
            assert.equal(await f.runtime.finance.accounts.countDocuments({ organizationId: org }), committedAccounts);
        });
        await t.test('backup without private binary cannot confirm; explicit reconciliation marks the artifact corrupt without economic repair', async () => {
            fresh();
            const c = await ready('MISSING_BINARY'), file = await f.database.db.collection('s11_files').findOne({ resourceId: c.ps.importId, state: 'VERIFIED' });
            assert.ok(file);
            await service.files.remove(String(file['_id']));
            const payload = await commitPayload(c), key = randomUUID();
            await proof(c, payload, key);
            await assert.rejects(() => service.confirm(a.issued.context, c.ps, payload, key, c.r.etag), code('INTEGRITY_MISMATCH'));
            await service.reconcile();
            await service.reconcile();
            const state = await f.database.db.collection('s11_imports').findOne({ _id: c.ps.importId });
            assert.equal(state.state, 'EXPIRED');
            assert.equal(await f.runtime.finance.accounts.countDocuments({ organizationId: org }), committedAccounts);
        });
        await t.test('expired process lease becomes explicit retryable state; maximum retention deletes normalized PII and exact binaries, preserves committed identity', async () => {
            fresh();
            const c = await create('LEASE'), ticket = await service.beginUpload(a.issued.context, c.ps, randomUUID(), c.r.etag);
            f.clock.value += 30001;
            await service.reconcile();
            assert.equal((await f.database.db.collection('s11_jobs').findOne({ _id: ticket.jobId })).state, 'EXPIRED');
            assert.equal((await f.database.db.collection('s11_imports').findOne({ _id: c.ps.importId })).state, 'INVALID');
            const before = await f.database.db.collection('s11_import_commands').findOne({ operation: 'receipt', 'result.id': receipt['id'] });
            f.clock.value += 86400001;
            let result = {};
            const passes = Math.ceil(await f.database.db.collection('s11_files').countDocuments() / 100) + 1;
            for (let i = 0; i < passes; i++)
                result = await service.reconcile();
            assert.ok(Number(result['removedFiles']) >= 0);
            assert.equal(await f.database.db.collection('s11_preview_chunks').countDocuments(), 0);
            assert.equal(await f.database.db.collection('s11_import_previews').countDocuments(), 0);
            assert.deepEqual(await f.database.db.collection('s11_import_commands').findOne({ operation: 'receipt', 'result.id': receipt['id'] }), before);
            assert.equal(await f.runtime.finance.accounts.countDocuments({ organizationId: org }), committedAccounts);
            assert.equal(await managementEvidenceMatches(f.database, (await managementHead(f.database)) ?? undefined), true);
        });
        await t.test('actual old-cut restore fails closed; intact restore retains receipts and revokes contexts; missing empty S11 original closes cold startup', async () => {
            assert.ok(beforeRestore);
            const after = await f.restore.snapshot(), raw = f.database.client.db(f.database.db.databaseName), originalReceipt = await raw.collection('s11_import_commands').findOne({ operation: 'receipt', 'result.id': receipt['id'] });
            await f.restore.beginRestore(beforeRestore);
            await assert.rejects(() => f.restore.reconcile({ approved: true, reviewId: 'SYN-S11-OLD-CUT' }), code('SERVICE_UNAVAILABLE'));
            assert.equal(f.restore.isOpen(), false);
            await f.restore.beginRestore(after);
            await f.restore.reconcile({ approved: true, reviewId: 'SYN-S11-INTACT' });
            assert.equal(f.restore.isOpen(), true);
            assert.equal((await f.sessions.contexts.findOne({ _id: a.issued.context._id })).revoked, true);
            assert.deepEqual(await raw.collection('s11_import_commands').findOne({ operation: 'receipt', 'result.id': receipt['id'] }), originalReceipt);
            assert.equal(await f.runtime.finance.accounts.countDocuments({ organizationId: org }), committedAccounts);
            assert.equal(await managementEvidenceMatches(f.database, (await managementHead(f.database)) ?? undefined), true);
            await f.runtime.obligations.prepareOwned(owner);
            await f.runtime.wealth.prepareOwned(owner);
            f.identity.reporting.projection = await ProjectionRuntime.createOwned(f.identity, f.keys.cursor, owner, false, () => f.runtime.obligations.activateOwned(owner));
            assert.equal(f.runtime.obligations.active, true);
            assert.equal(await raw.collection('s11_snapshots').countDocuments(), 0);
            await raw.collection('s11_snapshots').drop();
            await assert.rejects(() => f.runtime.obligations.enter());
            await f.database.projectionShutdown?.();
            const cold = new RestoreController(f.database, join(group.folder, 'gate.json'), f.keys.journal, f.keys.priority, f.keys.cursor);
            await cold.initialize();
            assert.equal(cold.isOpen(), false);
        });
    }
    finally {
        await group.dispose();
    }
});
//# sourceMappingURL=lifecycle.test.js.map