/* eslint-disable security/detect-object-injection, security/detect-non-literal-fs-filename -- Own registered synthetic group, enumerated snapshot collections and fixed output. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BSON, Collection } from 'mongodb';
import { s06Profile, password } from './profile.js';
import { setup, code } from './fixture.js';
import { Database } from '../../src/shared/database.js';
import { RestoreController } from '../../src/shared/restore.js';
import { loadSyntheticKeys } from '../../src/shared/keys.js';
import { head, lendingDigest, lendingEvidenceMatches } from '../../src/modules/lending/integrity.js';
import { configureEvidenceKey, evidenceMetrics, maxEvidenceDepth, assertEvidenceDepth, domainCollections } from '../../src/modules/lending/evidence-v2.js';
import { PaymentsService } from '../../src/modules/payments/service.js';
import { today } from '../../src/modules/finance/service.js';
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, canonical(x)])) : v;
// Separate test oracle; does not import production hashing or treap implementation.
const H = (v) => createHash('sha256').update(JSON.stringify(canonical(BSON.EJSON.serialize(v, { relaxed: false })))).digest('hex');
const review = { approved: true, reviewId: 'S06_SYNTHETIC_RESTORE_FIXTURE_NOT_INDEPENDENT_REVIEW' };
const sources = ['lending_loans', 'lending_loan_versions', 'loan_events', 'loan_applications', 'loan_accruals', 'financial_journals'];
async function capture(db, names = sources) { return Object.fromEntries(await Promise.all(names.map(async (c) => [c, H(await db.db.collection(c).find().sort({ _id: 1 }).toArray())]))); }
if (process.env['S06_CONTINUITY_DELTA'] !== '1')
    test('S06 continuity: restore, secret priorities and local residuals', { timeout: 1200000 }, async (t) => {
        const group = await s06Profile(), out = { task: 'S06-P02', author: 'Codex', independentReview: false, startedUTC: new Date().toISOString(), cases: {} };
        const cases = out['cases'];
        const scenario = async (name, fn) => await t.test(name, async () => { const start = performance.now(); try {
            cases[name] = { status: 'PASS', evidence: await fn(), seconds: (performance.now() - start) / 1000 };
        }
        catch (e) {
            cases[name] = { status: 'FAIL', error: String(e), seconds: (performance.now() - start) / 1000 };
            throw e;
        } });
        const reopened = async (f, priority) => { const db = new Database(group.uri, group.names[0]); await db.connect(); try {
            const restore = new RestoreController(db, f.restore.gatePath, f.keys.journal, priority);
            return { db, restore };
        }
        catch (e) {
            await db.close();
            throw e;
        } };
        try {
            await scenario('keyring and no online rotation', async () => {
                const f = await setup(group), path = join(group.folder, 'test-keys.json'), k = await loadSyntheticKeys(path), first = await readFile(path);
                assert.equal(k.version, 2);
                assert.equal(k.priority?.length, 32);
                assert.ok(k.priority.equals((await loadSyntheticKeys(path)).priority));
                assert.deepEqual(await readFile(path), first);
                const v1 = JSON.stringify({ version: 1, ...Object.fromEntries(['mail', 'totp', 'journal', 'cursor'].map(x => [x, randomBytes(32).toString('base64url')])) });
                await writeFile(path, v1);
                assert.equal((await loadSyntheticKeys(path)).priority, undefined);
                assert.equal(await readFile(path, 'utf8'), v1);
                const malformed = v1.replace('"version":1', '"version":2');
                await writeFile(path, malformed);
                await assert.rejects(loadSyntheticKeys(path));
                assert.equal(await readFile(path, 'utf8'), malformed);
                assert.throws(() => configureEvidenceKey(f.database, f.keys.journal, randomBytes(32)));
                assert.throws(() => configureEvidenceKey(f.database, f.keys.journal));
                return { newKeyStable: true, legacyBytesPreserved: true, malformedNotReplaced: true, onlineRotationRejected: true, noKeyMaterialLogged: true };
            });
            await scenario('restore current and reject stale incomplete corrupt domain', async () => {
                const f = await setup(group), held = await f.heldProfile(), cash = await f.accountS06('RESTORE_CASH', 'ASSET', 'CASH');
                await f.bind(f.a, cash.id, held);
                const l = await f.loan({ principal: '2000000.00' });
                await f.disburse(l);
                const early = await f.restore.snapshot(), intent = await f.intent(l, cash.id, '300000.00', f.a, 'CASH');
                const d = (await (await f.preparePayment({ kind: 'REGISTER', mode: 'DIRECT', effectiveDate: today(f.now()), intent })).execute()).data;
                await (await f.reverse(d.eventId, d.entityId)).execute();
                const current = await f.restore.snapshot(), baseline = await capture(f.database, [...domainCollections.filter(x => x !== 'lending_domain_state'), 'financial_journals']), old = f.a.issued.context._id;
                await f.restore.beginRestore(current);
                assert.equal(f.restore.isOpen(), false);
                await f.restore.reconcile(review);
                assert.equal(f.restore.isOpen(), true);
                assert.equal((await f.sessions.contexts.findOne({ _id: old }))?.revoked, true);
                assert.deepEqual(await capture(f.database, Object.keys(baseline)), baseline);
                const login = await f.identity.login('TENANT', randomUUID(), f.a.email, password);
                assert.equal(login.issued.context.kind, 'W');
                assert.equal((await f.pay.read(login.issued.context, 'getPayment', f.org, d.entityId)).status, 200);
                await f.restore.beginRestore(early);
                await assert.rejects(f.restore.reconcile(review), code('SERVICE_UNAVAILABLE'));
                assert.equal(f.restore.isOpen(), false);
                const negatives = [];
                for (const field of ['payments', 'cash_custody', 'loan_compensations', 'lending_merkle_nodes']) {
                    const bad = structuredClone(current);
                    bad.collections[field] = '[]';
                    bad.signature = createHmac('sha256', f.keys.journal).update(JSON.stringify({ watermark: bad.watermark, collections: bad.collections })).digest('hex');
                    await f.restore.beginRestore(bad);
                    await assert.rejects(f.restore.reconcile(review), code('SERVICE_UNAVAILABLE'));
                    negatives.push(field);
                }
                const bad = structuredClone(current), rows = BSON.EJSON.parse(bad.collections['cash_custody']);
                rows[0]['amountHeld'] = '1.00';
                bad.collections['cash_custody'] = BSON.EJSON.stringify(rows);
                bad.signature = createHmac('sha256', f.keys.journal).update(JSON.stringify({ watermark: bad.watermark, collections: bad.collections })).digest('hex');
                await f.restore.beginRestore(bad);
                await assert.rejects(f.restore.reconcile(review));
                await f.restore.beginRestore(current);
                await f.restore.reconcile(review);
                assert.equal(await lendingEvidenceMatches(f.database, (await head(f.database))), true);
                return { currentRestored: true, oldSessionRevoked: true, passwordLoginW: true, staleRejected: true, incompleteRejected: negatives, innerTamperRejectedDespiteValidOuterMAC: true, compensationAndCustodyHashesPreserved: true };
            });
            await scenario('legacy v1 semantic verification and v2 secret migration', async () => {
                const results = [];
                for (const corrupt of [false, true]) {
                    const f = await setup(group, { legacy: true }), l = await f.loan({ principal: '1000.00' });
                    await f.database.transaction(async (s) => { for (const c of ['lending_merkle_nodes', 'lending_merkle_orgs', 'lending_v2_checkpoint'])
                        await f.database.db.collection(c).deleteMany({}, { session: s }); if (corrupt)
                        await f.database.db.collection('lending_loans').updateOne({ _id: l.id }, { $set: { 'terms.principal': '9000.00' } }, { session: s }); const old = (await head(f.database, s)), digest = await lendingDigest(f.database, s); await f.database.db.collection('lending_domain_state').replaceOne({ _id: 'evidence' }, { _id: 'evidence', format: 'lending-v1', digest, revision: old.revision + 1 }, { session: s }); await f.identity.audit.append({ realm: 'TENANT', actorId: f.a.issued.context.subjectId, subjectId: f.a.issued.context.subjectId, action: 'S06_CONTROLLED_LEGACY_FIXTURE', outcome: 'SUCCESS' }, s); });
                    await f.restore.flush();
                    const original = await capture(f.database), peer = await reopened(f, randomBytes(32));
                    try {
                        if (corrupt) {
                            await assert.rejects(peer.restore.initialize(), code('SERVICE_UNAVAILABLE'));
                            assert.equal(peer.restore.isOpen(), false);
                            assert.equal((await head(peer.db)).format, 'lending-v1');
                            assert.equal(await peer.db.db.collection('lending_v2_checkpoint').countDocuments(), 0);
                        }
                        else {
                            await peer.restore.initialize();
                            assert.equal(peer.restore.isOpen(), true);
                            assert.equal((await head(peer.db)).format, 'lending-v2');
                            assert.equal(await peer.db.db.collection('lending_v2_checkpoint').countDocuments(), 1);
                            assert.equal(await peer.db.db.collection('lending_priority_checkpoint').countDocuments(), 1);
                            assert.deepEqual(await capture(peer.db), original);
                            const before = await head(peer.db);
                            await peer.restore.initialize();
                            assert.deepEqual(await head(peer.db), before);
                        }
                        results.push({ controlledSyntheticV1: true, corrupt, rejected: corrupt, originalSourcesUnchanged: true });
                    }
                    finally {
                        await peer.db.close();
                    }
                }
                const f = await setup(group, { legacy: true }), l = await f.loan({ principal: '1000.00' });
                await f.disburse(l);
                await f.restore.flush();
                const original = await capture(f.database), peer = await reopened(f, randomBytes(32));
                try {
                    await peer.restore.initialize();
                    assert.equal(peer.restore.isOpen(), true);
                    assert.deepEqual(await capture(peer.db), original);
                    assert.equal(await lendingEvidenceMatches(peer.db, (await head(peer.db))), true);
                }
                finally {
                    await peer.db.close();
                }
                return { v1: results, v2SHAOriginalEventAndLedgerPreserved: true };
            });
            await scenario('migration interruption wrong missing keys and missing checkpoint fail closed', async () => {
                const f = await setup(group, { legacy: true });
                await f.loan();
                await f.restore.flush();
                const before = await capture(f.database, ['lending_domain_state', 'lending_merkle_orgs', 'lending_merkle_nodes']), key = randomBytes(32), peer = await reopened(f, key), original = Collection.prototype.insertOne;
                try {
                    Collection.prototype.insertOne = async function (...args) { if (this.collectionName === 'lending_priority_checkpoint')
                        throw Error('S06 injected priority checkpoint failure'); return await original.apply(this, args); };
                    await assert.rejects(peer.restore.initialize(), code('SERVICE_UNAVAILABLE'));
                    assert.equal(peer.restore.isOpen(), false);
                    assert.deepEqual(await capture(peer.db, Object.keys(before)), before);
                    assert.equal(await peer.db.db.collection('lending_priority_checkpoint').countDocuments(), 0);
                }
                finally {
                    Collection.prototype.insertOne = original;
                    await peer.db.close();
                }
                // New independent fixture: gate is deliberately not reopened after failed migration.
                const good = await setup(group, { legacy: true });
                await good.loan();
                await good.restore.flush();
                const migrated = await reopened(good, key);
                try {
                    await migrated.restore.initialize();
                    assert.equal(migrated.restore.isOpen(), true);
                }
                finally {
                    await migrated.db.close();
                }
                const diagnostics = [];
                for (const priority of [undefined, randomBytes(32)]) {
                    const p = await reopened(good, priority);
                    try {
                        await p.restore.initialize();
                        assert.equal(p.restore.isOpen(), false);
                        diagnostics.push(priority ? 'wrong' : 'missing');
                    }
                    finally {
                        await p.db.close();
                    }
                }
                const checkpoint = await good.database.db.collection('lending_priority_checkpoint').findOne();
                assert.ok(checkpoint);
                await good.database.db.collection('lending_priority_checkpoint').deleteMany({});
                const missing = await reopened(good, key);
                try {
                    await missing.restore.initialize();
                    assert.equal(missing.restore.isOpen(), false);
                }
                finally {
                    await missing.db.close();
                }
                return { transactionFullyRolledBack: true, closedAfterInterruption: true, keyFailures: diagnostics, missingCheckpointClosed: true };
            });
            await scenario('HMAC determinism membership absence and selected public priorities', async () => {
                const f = await setup(group), l = await f.loan();
                await f.disburse(l);
                const namespace = 'hmac-v1:' + f.org, rows = await f.database.db.collection('lending_merkle_nodes').find({ namespace }).toArray(), byKey = new Map(rows.map(n => [n.key, n]));
                const build = (input) => { if (!input.length)
                    return null; const sorted = [...input].sort((a, b) => a.key < b.key ? -1 : 1); let index = 0; for (let i = 1; i < sorted.length; i++)
                    if (sorted[i].priority < sorted[index].priority || sorted[i].priority === sorted[index].priority && sorted[i].key < sorted[index].key)
                        index = i; const n = sorted[index], left = build(sorted.slice(0, index)), right = build(sorted.slice(index + 1)), height = 1 + Math.max(left?.height ?? 0, right?.height ?? 0), hash = H({ namespace, key: n.key, priority: n.priority, data: n.data, left, right, height }); return { id: namespace + ':' + H(n.key), hash, count: 1 + (left?.count ?? 0) + (right?.count ?? 0), height }; };
                for (const n of rows)
                    assert.equal(n.priority, createHmac('sha256', f.keys.priority).update(JSON.stringify(['CAUDELYX:PRIORITY:v1', namespace, n.key])).digest('hex'));
                const org = await f.database.db.collection('lending_merkle_orgs').findOne({ _id: f.org });
                assert.deepEqual(build(rows), org['root']);
                assert.deepEqual(build([...rows].reverse()), org['root']);
                assert.ok(byKey.has('loan_positions|P|' + l.id));
                assert.equal(byKey.has('loan_positions|P|' + randomUUID()), false);
                assert.equal(await lendingEvidenceMatches(f.database, (await head(f.database))), true);
                // Attacker can compute public SHA priorities and select a long monotone chain offline.
                const candidates = Array.from({ length: 16000 }, (_, i) => { const key = 'loan_events|P|00000000-0000-4000-8000-' + i.toString(16).padStart(12, '0'); return { key, priority: H(key) }; }), tails = [], previous = new Array(candidates.length).fill(-1);
                for (let i = 0; i < candidates.length; i++) {
                    let lo = 0, hi = tails.length;
                    while (lo < hi) {
                        const m = (lo + hi) >> 1;
                        if (candidates[tails[m]].priority < candidates[i].priority)
                            lo = m + 1;
                        else
                            hi = m;
                    }
                    previous[i] = lo ? tails[lo - 1] : -1;
                    tails[lo] = i;
                }
                const chosen = [];
                let p = tails.at(-1);
                while (p >= 0) {
                    chosen.push(candidates[p]);
                    p = previous[p];
                }
                chosen.reverse();
                assert.ok(chosen.length > 129);
                const selected = chosen.slice(0, 129), synthetic = selected.map(n => ({ ...n, _id: '', namespace, data: {}, left: null, right: null, count: 1, height: 1, hash: '' })), publicHeight = build(synthetic).height, secretHeight = build(synthetic.map(n => ({ ...n, priority: createHmac('sha256', f.keys.priority).update(JSON.stringify(['CAUDELYX:PRIORITY:v1', namespace, n.key])).digest('hex') }))).height;
                assert.equal(publicHeight, 129);
                assert.ok(secretHeight < 128);
                assert.equal(maxEvidenceDepth, 128);
                assert.doesNotThrow(() => assertEvidenceDepth(128));
                assert.throws(() => assertEvidenceDepth(129));
                return { oracleRealRootMatches: true, rows: rows.length, realHeight: org['root'].height, reverseOrderRootIdentical: true, memberAndAbsentVerified: true, publicOfflineCandidates: candidates.length, selectedChain: 129, publicHeight, secretHeight, boundary128Accepted129Rejected: true, offlineAttackIsAlgorithmicReproductionNotHTTPAvailabilityClaim: true };
            });
            await scenario('H03 off-path tamper residual and full verifier rejection', async () => {
                const f = await setup(group), l = await f.loan();
                await f.disburse(l);
                const visited = new Set(), original = Collection.prototype.findOne;
                try {
                    Reflect.set(Collection.prototype, 'findOne', async function (...args) { if (this.collectionName === 'lending_merkle_nodes')
                        visited.add(String(args[0]['_id'])); return await original.apply(this, args); });
                    assert.equal((await f.position(l.id)).status, 200);
                }
                finally {
                    Collection.prototype.findOne = original;
                }
                const untouched = (await f.database.db.collection('lending_merkle_nodes').find({ namespace: 'hmac-v1:' + f.org }).toArray()).find(n => !visited.has(n._id));
                assert.ok(untouched);
                await f.database.db.collection('lending_merkle_nodes').updateOne({ _id: untouched._id }, { $set: { hash: '0'.repeat(64) } });
                let status;
                try {
                    status = (await f.position(l.id)).status;
                }
                catch (e) {
                    status = String(e);
                }
                assert.equal(await lendingEvidenceMatches(f.database, (await head(f.database))), false);
                await f.database.db.collection('lending_merkle_nodes').replaceOne({ _id: untouched._id }, untouched);
                assert.equal(await lendingEvidenceMatches(f.database, (await head(f.database))), true);
                return { onPathReads: visited.size, offPathProbe: status, fullVerifierRejected: true, exactPreimageRestored: true, H03: 'ACCEPTED_LOCAL_RESIDUAL_NOT_FIXED' };
            });
            await scenario('H02 coherent rollback before flush remains accepted local residual', async () => {
                const f = await setup(group), bank = await f.accountS06('ROLLBACK_BANK', 'ASSET', 'BANK');
                await f.heldProfile();
                const l = await f.loan({ principal: '1000.00' });
                await f.disburse(l);
                const before = await f.restore.snapshot(), intent = await f.intent(l, bank.id, '100.00');
                await (await f.preparePayment({ kind: 'REGISTER', mode: 'DIRECT', effectiveDate: today(f.now()), intent })).execute();
                assert.equal(await f.database.db.collection('payments').countDocuments(), 1);
                // Adversary simulation: raw primary rollback, no call to operator restore/reseal.
                for (const [c, encoded] of Object.entries(before.collections)) {
                    await f.database.db.collection(c).deleteMany({});
                    const rows = BSON.EJSON.parse(encoded);
                    if (rows.length)
                        await f.database.db.collection(c).insertMany(rows);
                }
                const p = await reopened(f, f.keys.priority);
                try {
                    await p.restore.initialize();
                    assert.equal(p.restore.isOpen(), true);
                    assert.equal(await p.db.db.collection('payments').countDocuments(), 0);
                    return { beforeFlushCoherentRollbackAdmitted: true, operatorRestoreUsed: false, H02: 'ACCEPTED_LOCAL_RESIDUAL_NOT_FIXED' };
                }
                finally {
                    await p.db.close();
                }
            });
            await scenario('360 installments ten-loan batch retained history measured successful reads', async () => {
                const f = await setup(group), l = await f.loan({ principal: '3600000.00', installmentCount: 360 });
                await f.disburse(l);
                assert.equal(await f.ops.rows.countDocuments({ organizationId: f.org, loanId: l.id, active: true }), 360);
                const loans = [l];
                for (let i = 0; i < 9; i++) {
                    f.clock.value += 60000;
                    const next = await f.loan({ principal: '1000.00' }, l.borrowerId);
                    await f.disburse(next);
                    loans.push(next);
                }
                const bank = await f.accountS06('BATCH_BANK', 'ASSET', 'BANK');
                await f.heldProfile();
                const intent = await f.intent(l, bank.id, '100.00');
                intent.amount = '1000.00';
                intent.targets = await Promise.all(loans.map(async (x) => ({ loanId: x.id, positionETag: (await f.position(x.id)).etag, amount: '100.00', mode: 'REGULAR' })));
                await (await f.preparePayment({ kind: 'REGISTER', mode: 'DIRECT', effectiveDate: today(f.now()), intent })).execute();
                const other = await f.tenant(await f.newActor()), b = (await f.mutate('createBorrower', { borrowerCode: 'SYN_OTHER', profile: { displayName: 'Sintética B', schemaVersion: 1, extras: {} } }, { actor: other.actor, org: other.org })).data;
                const records = [];
                let quotes = 0;
                evidenceMetrics.captureOrganizations = true;
                try {
                    for (const target of [0, 100, 300]) {
                        while (quotes < target) {
                            if (quotes % 20 === 0)
                                f.clock.value += 60000;
                            await f.quote(l.borrowerId);
                            quotes++;
                        }
                        const samples = [];
                        for (let i = 0; i < 20; i++) {
                            const docs = evidenceMetrics.documentReads, nodes = evidenceMetrics.indexNodesRead, bytes = evidenceMetrics.hashBytes, foreign = evidenceMetrics.documentOrganizations.get(f.org) ?? 0, start = performance.now();
                            const r = await f.runtime.lending.read(other.actor.issued.context, 'getBorrower', other.org, b.id);
                            assert.equal(r.status, 200);
                            samples.push({ ms: performance.now() - start, documentReads: evidenceMetrics.documentReads - docs, indexNodes: evidenceMetrics.indexNodesRead - nodes, hashBytes: evidenceMetrics.hashBytes - bytes, foreignOrgReads: (evidenceMetrics.documentOrganizations.get(f.org) ?? 0) - foreign, status: r.status });
                        }
                        const ordered = samples.map(x => x.ms).sort((a, b) => a - b);
                        assert.ok(samples.every(x => x.foreignOrgReads === 0));
                        records.push({ retainedQuotesInA: target, successfulReadsInB: 20, p50: ordered[9], p95: ordered[18], samples });
                    }
                }
                finally {
                    evidenceMetrics.captureOrganizations = false;
                }
                assert.equal(await lendingEvidenceMatches(f.database, (await head(f.database))), true);
                await f.restore.flush();
                return { installments: 360, batchTargets: 10, retention: 'INDEFINITE_NO_TTL', records, noAbsoluteLatencySLA: true };
            });
        }
        finally {
            out['endedUTC'] = new Date().toISOString();
            await writeFile(resolve('../../Construccion/Sprints/S06/Evidencias/S06-P02-CONTINUITY.json'), JSON.stringify(out, null, 2) + '\n');
            await group.dispose();
        }
    });
if (process.env['S06_CONTINUITY_DELTA'] === '1')
    test('S06 migration boundaries and legacy metadata', { timeout: 600000 }, async (t) => {
        const group = await s06Profile(), results = [];
        try {
            for (const [collection, method] of [['lending_merkle_nodes', 'bulkWrite'], ['lending_merkle_orgs', 'replaceOne'], ['lending_domain_state', 'replaceOne'], ['lending_priority_checkpoint', 'insertOne'], ['audit_events', 'insertOne'], ['outbox', 'insertOne'], ['security_evidence_outbox', 'insertOne']])
                await t.test('atomic migration ' + collection, async () => {
                    const f = await setup(group, { legacy: true });
                    await f.loan();
                    await f.restore.flush();
                    const names = ['lending_domain_state', 'lending_merkle_nodes', 'lending_merkle_orgs', 'lending_priority_checkpoint', 'audit_events', 'outbox', 'security_evidence_outbox'], before = await capture(f.database, names), db = new Database(group.uri, group.names[0]);
                    await db.connect();
                    const restore = new RestoreController(db, f.restore.gatePath, f.keys.journal, randomBytes(32)), original = Reflect.get(Collection.prototype, method);
                    let hit = false;
                    try {
                        Reflect.set(Collection.prototype, method, async function (...args) { if (this.collectionName === collection) {
                            hit = true;
                            throw Error('S06 injected migration boundary');
                        } return await Reflect.apply(original, this, args); });
                        await assert.rejects(restore.initialize(), code('SERVICE_UNAVAILABLE'));
                        assert.equal(hit, true);
                        assert.equal(restore.isOpen(), false);
                        assert.deepEqual(await capture(db, names), before);
                        results.push({ collection, method, hit, fullyRolledBack: true, gateClosed: true });
                    }
                    finally {
                        Reflect.set(Collection.prototype, method, original);
                        await db.close();
                    }
                });
            await t.test('committed migration then failed durable flush never admits traffic', async () => {
                const f = await setup(group, { legacy: true });
                await f.loan();
                await f.restore.flush();
                const db = new Database(group.uri, group.names[0]);
                await db.connect();
                const restore = new RestoreController(db, f.restore.gatePath, f.keys.journal, randomBytes(32)), original = restore.flush.bind(restore);
                let hit = false;
                try {
                    restore.flush = async () => { const h = await db.db.collection('lending_domain_state').findOne({ _id: 'evidence' }); if (h?.['priorityPolicy']) {
                        hit = true;
                        throw Error('S06 after commit before durable flush');
                    } await original(); };
                    await assert.rejects(restore.initialize(), code('SERVICE_UNAVAILABLE'));
                    assert.equal(hit, true);
                    assert.equal(restore.isOpen(), false);
                    assert.equal(await db.db.collection('lending_priority_checkpoint').countDocuments(), 1);
                    results.push({ boundary: 'afterCommitBeforeDurableFlush', committedCheckpoint: true, gateClosed: true });
                }
                finally {
                    await db.close();
                }
            });
            await t.test('legacy receipt destination metadata preserves event and has no invented approval', async () => {
                const f = await setup(group, { legacy: true }), l = await f.loan({ principal: '2000000.00' });
                await f.disburse(l);
                const position = await f.position(l.id), destination = await f.runtime.finance.read(f.a.issued.context, 'readAccount', f.org, f.account), r = await (await f.make({ kind: 'RECEIPT', borrowerId: l.borrowerId, destinationAccountId: f.account, destinationAccountETag: destination.etag, receivedAmount: '300000.00', targets: [{ loanId: l.id, positionETag: position.etag, amount: '300000.00', mode: 'REGULAR' }], excessDisposition: 'CREDIT', receiptReference: 'SYN-LEGACY', effectiveDate: today(f.now()), supportReference: 'SYN-LEGACY' })).execute(), id = r.data.event.id, before = await capture(f.database), payments = new PaymentsService(f.identity, f.keys.cursor, f.config), view = (await payments.read(f.a.issued.context, 'getLegacyPaymentView', f.org, id)).data;
                assert.equal(view['method'], 'CASH');
                assert.equal(view['amount'], '300000.00');
                assert.equal(view['approvalOrigin'], 'LEGACY_NOT_RECORDED');
                assert.equal(view['reversalEligibility'], 'SNAPSHOT_UNAVAILABLE');
                assert.deepEqual(await capture(f.database), before);
                results.push({ legacyReceiptRead: true, method: 'CASH', amount: '300000.00', sourceBytesUnchanged: true, noInventedApproval: true });
            });
            await t.test('HELD profile cannot become borrower credit in first disbursement book', async () => {
                const f = await setup(group), a = await f.runtime.finance.read(f.a.issued.context, 'readAccount', f.org, f.profile.borrowerCreditAccountId);
                await f.mutatePayment('setHeldFundsProfile', { configurationKind: 'HELD_FUNDS_PROFILE', heldLiabilityAccountId: f.profile.borrowerCreditAccountId, heldLiabilityAccountETag: a.etag, resourceETag: `"${f.org}:held-profile:0"`, supportReference: 'SYN-DISTINCT' });
                const l = await f.loan();
                await assert.rejects(f.disburse(l), code('ACCOUNT_PROFILE_CONFLICT'));
                assert.equal(await f.ops.events.countDocuments(), 0);
                results.push({ heldAndBorrowerCreditMustBeDistinct: true, noFirstBookCreated: true });
            });
        }
        finally {
            await writeFile(resolve('../../Construccion/Sprints/S06/Evidencias/S06-P02-CONTINUITY-DELTA.json'), JSON.stringify({ task: 'S06-P02', author: 'Codex', independentReview: false, results }, null, 2) + '\n');
            await group.dispose();
        }
    });
//# sourceMappingURL=continuity.test.js.map