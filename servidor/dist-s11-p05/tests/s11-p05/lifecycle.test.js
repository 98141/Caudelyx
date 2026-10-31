/* eslint-disable security/detect-non-literal-fs-filename -- Own group private root (UUID names from own rows) and own evidence path only. */
// S11-P05 (Claude): files/jobs lifecycle on ONE own Mongo group: missing/corrupt binaries before commit and before download,
// service re-instantiation with the same or a different key, snapshot expiry/staleness, cancellation and 24 h retention.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { readFile, unlink, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { s11Profile, world } from './profile.js';
import { workbook } from './book.js';
import { ExchangeService } from '../../src/modules/exchange/service.js';
import { PrivateStorage } from '../../src/modules/exchange/storage.js';
import { today } from '../../src/modules/obligations/calendar.js';
const CHECKS = {};
const code = (e) => e.code ?? String(e.message).slice(0, 100);
test('S11-P05 lifecycle: fail-closed binaries, restart, expiry, cancellation and retention', { timeout: 600000 }, async (t) => {
    const group = await s11Profile();
    try {
        const f = await world(group, Date.parse('2026-10-31T12:00:00-05:00')), a = f.a, org = f.org, p = { organizationId: org }, priv = join(group.folder, 'private');
        let service = f.identity.exchange;
        const accounts = f.database.db.collection('financial_accounts'), count = async () => await accounts.countDocuments({ organizationId: org });
        const ready = async (ns, k) => {
            f.clock.value += 61000;
            const c = await service.createImport(a.issued.context, 'createBusinessImport', { label: 'Ciclo P05', mode: 'OPERATIVE', namespace: ns, templateVersion: '1.0.0', mappingVersion: 'S11-MAP-1' }, p, randomUUID()), ps = { ...p, importId: String(c.data['id']) };
            const u = await service.upload(a.issued.context, ps, randomUUID(), c.etag, workbook('OPERATIVE', ns, { Cuentas: [{ externalKey: k, action: 'CREATE', code: 'L' + k, name: 'Cuenta ciclo ' + k, accountClass: 'ASSET', kind: 'BANK', currency: 'COP' }] }));
            await service.preparePreview(a.issued.context, ps, randomUUID(), u.etag);
            const cur = await service.readImport(a.issued.context, ps, 'getBusinessImport'), pv = await service.readImport(a.issued.context, ps, 'getBusinessImportPreview');
            const row = await f.database.db.collection('s11_imports').findOne({ _id: ps.importId });
            return { ps, cur, pv, fileId: String(row['fileId']) };
        };
        const confirm = async (r, key = randomUUID()) => {
            const bookETag = await f.database.client.withSession(x => f.runtime.wealth.bookTag({ kind: 'BUSINESS', bookId: org, ownerId: org, organizationId: org }, x));
            const payload = { previewId: r.pv.data['id'], semanticHash: r.pv.data['semanticHash'], bookETag };
            await f.proof(a, 'IMPORT_CONFIRM', { operationId: 'confirmBusinessImport', organizationId: org, pathParameters: r.ps, payload, idempotencyKey: key, expectedETag: r.cur.etag }, r.ps.importId);
            return await service.confirm(a.issued.context, r.ps, payload, key, r.cur.etag);
        };
        const exportCsv = async () => {
            f.clock.value += 61000;
            const d = today(f.now());
            const s = await service.report(a.issued.context, { ...p, reportKind: 'CASH' }, { asOf: d, from: d, to: d }), token = String(s.data['meta']['snapshotToken']);
            const e = await service.createExport(a.issued.context, p, { reportKind: 'CASH', snapshotToken: token, format: 'CSV' }, randomUUID());
            return { es: { ...p, exportId: String(e.data['id']) }, etag: String(e.etag), fileId: String(e.data['file']['id']), token };
        };
        await t.test('L1 original deleted or altered after preview: confirm 503, no account, import not committed', async () => {
            const base = await count(), r1 = await ready('P05-L1', 'K1');
            await unlink(join(priv, r1.fileId));
            let e1 = '';
            try {
                await confirm(r1);
            }
            catch (e) {
                e1 = code(e);
            }
            const r2 = await ready('P05-L2', 'K2');
            const bytes = await readFile(join(priv, r2.fileId));
            bytes[bytes.length - 30] = bytes[bytes.length - 30] ^ 0xff;
            await writeFile(join(priv, r2.fileId), bytes);
            let e2 = '';
            try {
                await confirm(r2);
            }
            catch (e) {
                e2 = code(e);
            }
            const s1 = (await f.database.db.collection('s11_imports').findOne({ _id: r1.ps.importId }))['state'], s2 = (await f.database.db.collection('s11_imports').findOne({ _id: r2.ps.importId }))['state'];
            CHECKS['L1'] = { deleted: e1, altered: e2, states: [s1, s2], accountsDelta: (await count()) - base };
            assert.equal(e1, 'INTEGRITY_MISMATCH');
            assert.equal(e2, 'INTEGRITY_MISMATCH');
            assert.equal(await count(), base);
            assert.notEqual(s1, 'COMMITTED');
            assert.notEqual(s2, 'COMMITTED');
        });
        await t.test('L2 export binary altered or deleted: download 503 before any byte', async () => {
            const x1 = await exportCsv(), b = await readFile(join(priv, x1.fileId));
            await writeFile(join(priv, x1.fileId), Buffer.concat([b, Buffer.from('"=1+1"\r\n')]));
            let d1 = '';
            try {
                await service.download(a.issued.context, x1.es, randomUUID(), false, x1.etag);
            }
            catch (e) {
                d1 = code(e);
            }
            const x2 = await exportCsv();
            await unlink(join(priv, x2.fileId));
            let d2 = '';
            try {
                await service.download(a.issued.context, x2.es, randomUUID(), false, x2.etag);
            }
            catch (e) {
                d2 = code(e);
            }
            CHECKS['L2'] = { tampered: d1, deleted: d2 };
            assert.equal(d1, 'INTEGRITY_MISMATCH');
            assert.equal(d2, 'INTEGRITY_MISMATCH');
        });
        await t.test('L3 re-instantiated service with SAME key keeps receipt/export usable; a DIFFERENT key fails closed', async () => {
            const r = await ready('P05-L3', 'K3'), receipt = await confirm(r), x = await exportCsv();
            service = new ExchangeService(f.identity, new PrivateStorage(priv), f.keys.cursor);
            f.identity.exchange = service;
            const again = await service.readImport(a.issued.context, r.ps, 'getBusinessImportReceipt'), dl = await service.download(a.issued.context, x.es, randomUUID(), false, x.etag);
            const other = new ExchangeService(f.identity, new PrivateStorage(priv), randomBytes(32));
            let wrong = '';
            try {
                await other.download(a.issued.context, x.es, randomUUID(), false, x.etag);
            }
            catch (e) {
                wrong = code(e);
            }
            CHECKS['L3'] = { receiptSame: again.data['id'] === receipt.data['id'], downloadBytes: dl.bytes.length, sha: dl.file.sha256, wrongKey: wrong };
            assert.equal(again.data['id'], receipt.data['id']);
            assert.ok(dl.bytes.length > 0);
            assert.notEqual(wrong, '');
        });
        await t.test('L4 snapshot older than 300 s or source changed: prepared export is not downloadable', async () => {
            const x1 = await exportCsv();
            f.clock.value += 300001;
            let late = '';
            try {
                await service.download(a.issued.context, x1.es, randomUUID(), false, x1.etag);
            }
            catch (e) {
                late = code(e);
            }
            const x2 = await exportCsv();
            const d = today(f.now()), journal = { currency: 'COP', effectiveDate: d, sourceId: randomUUID(), supportReference: 'SYN-P05-L4', description: 'Cambio de fuente P05', lines: [{ accountId: f.bank.id, debit: '1.00', credit: '0.00' }, { accountId: f.equity.id, debit: '0.00', credit: '1.00' }] }, k = randomUUID();
            await f.proof(a, 'FINANCE_JOURNAL_POST', { organizationId: org, idempotencyKey: k, payload: journal });
            await f.runtime.finance.mutate(a.issued.context, 'postJournal', org, journal, k);
            let stale = '';
            try {
                await service.download(a.issued.context, x2.es, randomUUID(), false, x2.etag);
            }
            catch (e) {
                stale = code(e);
            }
            CHECKS['L4'] = { expired: late, sourceChanged: stale };
            assert.equal(late, 'REPORT_SNAPSHOT_EXPIRED');
            assert.equal(stale, 'REPORT_SNAPSHOT_STALE');
        });
        await t.test('L5 cancel READY import blocks confirm; cancel after COMMITTED keeps receipt and effect', async () => {
            const base = await count(), r = await ready('P05-L5', 'K5'), cur = await service.readImport(a.issued.context, r.ps, 'getBusinessImport');
            await service.cancelImport(a.issued.context, r.ps, randomUUID(), String(cur.etag));
            let blocked = '';
            try {
                await confirm(r);
            }
            catch (e) {
                blocked = code(e);
            }
            const r2 = await ready('P05-L6', 'K6'), rc = await confirm(r2), cur2 = await service.readImport(a.issued.context, r2.ps, 'getBusinessImport');
            const cancelled = await service.cancelImport(a.issued.context, r2.ps, randomUUID(), String(cur2.etag)), still = await service.readImport(a.issued.context, r2.ps, 'getBusinessImportReceipt');
            CHECKS['L5'] = { blocked, afterCommitState: cancelled.data['state'], receiptKept: still.data['id'] === rc.data['id'], accountsDelta: (await count()) - base };
            assert.notEqual(blocked, '');
            assert.equal(cancelled.data['state'], 'COMMITTED');
            assert.equal(still.data['id'], rc.data['id']);
            assert.equal(await count(), base + 1);
        });
        await t.test('L6 after 24 h reconcile expires the staged original and removes its binary; committed receipt and effect survive', async () => {
            // The actor session also expires after 24 h (AUTH_INVALID), so retention is observed through reconcile() and raw rows.
            const r = await ready('P05-L7', 'K7'), committed = await ready('P05-L8', 'K8'), rc = await confirm(committed), before = await readdir(priv), base = await count();
            f.clock.value += 86400000 + 1000;
            for (let i = 0; i < 5; i++)
                await service.reconcile();
            const after = await readdir(priv), imports = f.database.db.collection('s11_imports');
            const staged = await imports.findOne({ _id: r.ps.importId }), done = await imports.findOne({ _id: committed.ps.importId });
            const receiptRow = await f.database.db.collection('s11_import_commands').findOne({ _id: String(rc.data['id']) });
            CHECKS['L6'] = { stagedFilePresentBefore: before.includes(r.fileId), stagedFilePresentAfter: after.includes(r.fileId), stagedState: staged['state'], committedState: done['state'], receiptRow: Boolean(receiptRow), accountsDelta: (await count()) - base, privateObjects: { before: before.length, after: after.length } };
            assert.equal(before.includes(r.fileId), true);
            assert.equal(after.includes(r.fileId), false);
            assert.notEqual(staged['state'], 'COMMITTED');
            assert.equal(done['state'], 'COMMITTED');
            assert.ok(receiptRow);
            assert.equal(await count(), base);
        });
    }
    finally {
        await group.dispose();
        writeFileSync('../../Construccion/Sprints/S11/Evidencias/S11-P05-CHECKS-LIFECYCLE.json', JSON.stringify({ task: 'S11-P05', suite: 'lifecycle', runId: group.runId, at: new Date().toISOString(), checks: CHECKS }, null, 1) + '\n');
    }
});
//# sourceMappingURL=lifecycle.test.js.map