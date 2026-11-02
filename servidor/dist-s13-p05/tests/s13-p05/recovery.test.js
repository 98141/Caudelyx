/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection -- Own UUID controls/archives and own evidence path; secrets never serialized. */
// S13-P05 (Claude): independent recovery review. Uses the candidate's public workflow (cut/capture/save/read/restore) as
// system under test; comparisons are OWN: raw per-document equality of every collection of the three own databases,
// tampering of the REAL saved archive bytes, foreign key, restore-over-source, revived-privilege probes. No key in evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { s13Profile, world, password } from './profile.js';
import { definition, historicalSeed } from './oracle.js';
import { beginBackupCut, captureBackup, saveBackup, readBackup, restoreBackup } from '../../src/modules/local-recovery/workflow.js';
import { digest } from '../../src/modules/local-recovery/container.js';
import { RestoreController } from '../../src/shared/restore.js';
import { IdentityService } from '../../src/modules/identity/service.js';
import { Sessions } from '../../src/modules/sessions/service.js';
import { SyntheticMessaging } from '../../src/modules/messaging/service.js';
import { PasswordHasher } from '../../src/modules/identity/password.js';
import { today } from '../../src/modules/obligations/calendar.js';
const EV = '../../Construccion/Sprints/S13/Evidencias/', checks = {};
const ECONOMIC = /^(financial_|lending_|loan_|payment|payments$|cash_|held_|collection_|reconciliation|opening_|custody_|s09_|s10_|s11_|transaction_fence)/;
async function owner(group) { const o = JSON.parse(await readFile(join(group.folder, 'owner.json'), 'utf8')); return { folder: group.folder, runId: group.runId, nonce: o.nonce, names: group.names }; }
async function rawDb(db) { const out = {}; for (const c of await db.listCollections({}, { nameOnly: true }).toArray())
    out[c.name] = Object.fromEntries((await db.collection(c.name).find({}).toArray()).map(d => [String(d['_id']), JSON.stringify(d)])); return out; }
function compare(a, b) {
    const diff = {};
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const x = a[name] ?? {}, y = b[name] ?? {};
        let onlySource = 0, onlyDest = 0, changed = 0;
        const fields = new Set();
        for (const id of new Set([...Object.keys(x), ...Object.keys(y)])) {
            if (!(id in y))
                onlySource++;
            else if (!(id in x))
                onlyDest++;
            else if (x[id] !== y[id]) {
                changed++;
                const p = JSON.parse(x[id]), q = JSON.parse(y[id]);
                for (const k of new Set([...Object.keys(p), ...Object.keys(q)]))
                    if (JSON.stringify(p[k]) !== JSON.stringify(q[k]))
                        fields.add(k);
            }
        }
        if (onlySource || onlyDest || changed)
            diff[name] = { onlySource, onlyDest, changed, fields: [...fields].sort() };
    }
    return diff;
}
const fail = async (fn) => { try {
    await fn();
    return { ok: true };
}
catch (e) {
    return { ok: false, status: e.status, code: e.code ?? String(e.message ?? e).slice(0, 120) };
} };
test('S13-P05 own encrypted backup/restore review: raw equality, real-archive tamper, foreign key, restore-over-source, no privilege revival', { timeout: 900000 }, async (t) => {
    const start = performance.now(), phases = {}, mark = (k, s) => { phases[k] = Math.round(performance.now() - s); };
    const sourceGroup = await s13Profile();
    let destinationGroup;
    try {
        destinationGroup = await s13Profile();
        const so = await owner(sourceGroup), dso = await owner(destinationGroup);
        let s0 = performance.now();
        const f = await world(sourceGroup), h = await historicalSeed(f), ps = { organizationId: h.organizationId };
        mark('seed', s0);
        // Private scenario with a unique marker; one suspended member and one revoked session BEFORE the cut.
        const MARK = 'P05REC' + randomUUID().slice(0, 8), sim = f.runtime.simulation;
        const b = await sim.execute(h.actor.issued.context, 'captureBaseBusinessSimulation', { asOf: today(f.now()), currency: 'COP' }, ps, {}, randomUUID());
        await sim.execute(h.actor.issued.context, 'createScenarioBusinessSimulation', { name: 'Recuperacion ' + MARK, ...definition(), baseId: String(b.data['id']), baseToken: String(b.data['baseToken']) }, ps, {}, randomUUID());
        const stale = await f.actor(), staleToken = stale.issued;
        await f.identity.revokeSessions(stale.issued.context, stale.issued.context.managementId);
        await f.restore.flush();
        const statePath = '../../Construccion/Sprints/S13/Evidencias/S13-P04-BUILD-STATE.json', buildBytes = await readFile(statePath), build = JSON.parse(buildBytes.toString());
        const artifacts = await Promise.all(build.outputs.filter(([n]) => n.startsWith('src/')).map(async ([n, hsh]) => { const bytes = await readFile(join('dist-s13-p04', n)); assert.equal(digest(bytes), hsh); return { relativePath: 'runtime/server/' + n, bytes }; }));
        for (const n of ['package.json', 'package-lock.json'])
            artifacts.push({ relativePath: 'locks/server/' + n, bytes: await readFile(n) });
        artifacts.push({ relativePath: 'contracts/openapi-simulation-alerts-s13-p01.json', bytes: await readFile('../../Construccion/Sprints/S13/Contratos/openapi-simulation-alerts-s13-p01.json') });
        const source = { group: so, database: f.database, restore: f.restore, keys: f.keys, now: f.now, artifacts, configuration: { candidatePolicy: 'S13-P01-1.0.0', usage: 'LOCAL_SYNTHETIC', softwarePolicy: 'S13-P05 own review: exact compiled server (all src outputs) + server lock' }, quiesce: async () => { await f.database.projectionShutdown?.(); } };
        s0 = performance.now();
        const cut = await beginBackupCut(source);
        mark('cutT0', s0);
        const sourceRawT0 = { main: await rawDb(f.database.db), mail: await rawDb(f.database.client.db(sourceGroup.names[1])), security: await rawDb(f.database.client.db(sourceGroup.names[2])) };
        const candidate = { id: 'S13-P04-BUILD-' + build.key, manifestSHA256: digest(buildBytes), sourceFingerprint: digest(JSON.stringify(build.inputs)), contractsSHA256: 'f78197544bcc750f5d002dc067f326f1bd8e725ea673cd7141354f1bee755757', keyPolicyVersion: 2 };
        s0 = performance.now();
        const payload = await captureBackup(source, dso, cut, candidate);
        mark('capture', s0);
        s0 = performance.now();
        const archive = await saveBackup(so, payload);
        mark('save', s0);
        const archiveBytes = await readFile(archive.archivePath), keyText = await readFile(archive.keyPath, 'utf8');
        checks['container'] = { archiveBytes: archiveBytes.length, archiveSHA256: digest(archiveBytes), keySeparateDir: !archive.keyPath.startsWith(archive.archivePath.split('archives')[0] + 'archives'), plaintextMarkerInArchive: archiveBytes.includes(Buffer.from(MARK)), components: payload.components.map(c => c.kind).sort(), T0: payload.cut.T0, T1: payload.cut.T1 };
        assert.equal(archiveBytes.includes(Buffer.from(MARK)), false, 'archive is encrypted: private marker not visible');
        assert.equal(archiveBytes.includes(Buffer.from('financial_journals')), false, 'collection names not visible in ciphertext');
        s0 = performance.now();
        const loaded = await readBackup(so, archive.archivePath, archive.keyPath);
        mark('read', s0);
        const sourceRawAfterSave = await rawDb(f.database.db);
        checks['sourceUnchangedBySave'] = Object.keys(compare(sourceRawT0.main, sourceRawAfterSave)).filter(n => ECONOMIC.test(n));
        // ---- Negatives on the REAL archive, before any positive restore (destination must stay empty and closed).
        const negatives = {};
        const destinationEmpty = async (db) => { const cs = await db.listCollections({}, { nameOnly: true }).toArray(); let docs = 0; for (const c of cs)
            docs += await db.collection(c.name).countDocuments(); return { collections: cs.length, docs }; };
        const variants = [
            ['flipped ciphertext byte', async () => { const x = Buffer.from(archiveBytes); x[Math.floor(x.length / 2)] = x[Math.floor(x.length / 2)] ^ 0x01; return { bytes: x, key: loaded.key }; }],
            ['truncated archive', async () => ({ bytes: archiveBytes.subarray(0, archiveBytes.length - 17), key: loaded.key })],
            ['flipped auth tag', async () => { const x = Buffer.from(archiveBytes); x[x.length - 1] = x[x.length - 1] ^ 0x80; return { bytes: x, key: loaded.key }; }],
            ['key of another backup', async () => { const other = await saveBackup(so, payload); const k = await readBackup(so, other.archivePath, other.keyPath); return { bytes: archiveBytes, key: k.key }; }]
        ];
        for (const [name, make] of variants)
            await t.test('negative: ' + name, async () => {
                await destinationGroup.resetEmptyTarget();
                const db = await destinationGroup.restoreTarget(), input = await make(), s1 = performance.now();
                const r = await fail(() => restoreBackup({ ...input, source: so, destination: dso, database: db, expectedCandidate: payload.candidate, reviewId: 'S13_P05_NEGATIVE' }));
                const gate = new RestoreController(db, join(destinationGroup.folder, 'gate.json'), f.keys.journal, f.keys.priority, f.keys.cursor);
                await gate.initialize().catch(() => undefined);
                negatives[name] = { ...r, ms: Math.round(performance.now() - s1), destination: await destinationEmpty(db.db), gateOpen: gate.isOpen(), financialRows: await db.db.collection('financial_journals').countDocuments() };
                assert.equal(r.ok, false);
                assert.equal(gate.isOpen(), false);
                assert.equal(await db.db.collection('financial_journals').countDocuments(), 0);
            });
        // Restore over the SOURCE group (its own names) must be refused before touching it.
        await t.test('negative: restore targeting the source itself', async () => {
            const before = await rawDb(f.database.db), r = await fail(() => restoreBackup({ ...loaded, source: so, destination: so, database: f.database, expectedCandidate: payload.candidate, reviewId: 'S13_P05_OVER_SOURCE' }));
            const after = await rawDb(f.database.db);
            negatives['restore over source'] = { ...r, sourceChanged: Object.keys(compare(before, after)) };
            assert.equal(r.ok, false);
            assert.deepEqual(Object.keys(compare(before, after)).filter(n => ECONOMIC.test(n)), []);
        });
        checks['negatives'] = negatives;
        // ---- Positive restore into the own destination, then OWN raw comparison against the source cut.
        await t.test('positive restore: raw equality per document, companions, no privilege revival, marker only where expected', async () => {
            await destinationGroup.resetEmptyTarget();
            const db = await destinationGroup.restoreTarget(), s1 = performance.now();
            const restored = await restoreBackup({ ...loaded, source: so, destination: dso, database: db, expectedCandidate: payload.candidate, reviewId: 'S13_P05_OWN_FIXTURE' });
            mark('restore', s1);
            const dest = { main: await rawDb(db.db), mail: await rawDb(db.client.db(destinationGroup.names[1])), security: await rawDb(db.client.db(destinationGroup.names[2])) };
            const dMain = compare(sourceRawT0.main, dest.main), dMail = compare(sourceRawT0.mail, dest.mail), dSec = compare(sourceRawT0.security, dest.security);
            const TECH = /^(transaction_fence|s09_projection_barriers)$/, economicDiff = Object.keys(dMain).filter(n => ECONOMIC.test(n) && !TECH.test(n)), technicalDiff = Object.keys(dMain).filter(n => TECH.test(n)).map(n => ({ n, ...dMain[n] }));
            const activeContexts = await db.db.collection('contexts').countDocuments({ revoked: { $ne: true } });
            const staleCtx = await db.db.collection('contexts').findOne({ _id: staleToken.context._id });
            const cold = new RestoreController(db, join(destinationGroup.folder, 'gate.json'), restored.keys.journal, restored.keys.priority, restored.keys.cursor);
            await cold.initialize();
            const sessions = new Sessions(db, f.now), identity = new IdentityService(db, sessions, new SyntheticMessaging(db, restored.keys.mail, f.now), new PasswordHasher(), () => cold.isOpen(), f.now);
            await identity.initialize();
            const relogin = await fail(() => identity.login('TENANT', randomUUID(), h.actor.email, password)), oldToken = await sessions.find(staleToken.token, 'TENANT').then(c => c === null ? 'NOT_FOUND_OR_REVOKED' : 'ALIVE');
            const markerWhere = Object.entries(dest.main).filter(([, docs]) => Object.values(docs).some(x => x.includes(MARK))).map(([n]) => n);
            checks['positive'] = { ms: phases['restore'], observed: restored.observed, gateOpenAfterCold: cold.isOpen(), mainDiffVsT0: dMain, mailDiff: dMail, securityDiff: dSec, economicDiff, technicalDiff, activeContextsAfterRestore: activeContexts, preCutRevokedContext: staleCtx ? { revoked: staleCtx['revoked'] } : null, ownerRelogin: relogin, oldRevokedToken: oldToken, markerCollections: markerWhere, privateFiles: restored.observed.privateFiles };
            assert.deepEqual(economicDiff, [], 'every economic collection identical, document by document, to the source cut');
            assert.equal(activeContexts, 0, 'no session is alive after restore');
            assert.equal(oldToken, 'NOT_FOUND_OR_REVOKED');
            assert.equal(cold.isOpen(), true);
            assert.ok(markerWhere.every(n => n.startsWith('s12_')), 'private marker only in S12 private rows');
        });
        checks['phasesMs'] = phases;
        checks['totalMs'] = Math.round(performance.now() - start);
        checks['secretInEvidence'] = JSON.stringify(checks).includes(keyText.trim().slice(10, 40)) || JSON.stringify(checks).includes(String(loaded.key.keyBase64 ?? 'x').slice(0, 20));
        assert.equal(checks['secretInEvidence'], false);
        void stat;
        void writeFile;
    }
    finally {
        writeFileSync(EV + 'S13-P05-CHECKS-RECOVERY.json', JSON.stringify({ task: 'S13-P05', suite: 'recovery', at: new Date().toISOString(), groups: [sourceGroup.names[0], destinationGroup?.names[0]], checks }, null, 1) + '\n');
        const results = await Promise.allSettled([destinationGroup?.dispose(), sourceGroup.dispose()]);
        const failed = results.filter(r => r.status === 'rejected');
        if (failed.length)
            throw new AggregateError(failed.map(r => r.reason), 'Own recovery cleanup failed');
    }
});
//# sourceMappingURL=recovery.test.js.map