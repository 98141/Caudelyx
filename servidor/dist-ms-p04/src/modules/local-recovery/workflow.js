/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection -- Leased synthetic groups and bounded files; dictionary reads use closed keyring fields or authenticated collection names. No public route/dynamic execution. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { BSON } from 'mongodb';
import { createHmac, randomUUID } from 'node:crypto';
import { RestoreController } from '../../shared/restore.js';
import { originals as managed } from '../obligations/catalog.js';
import { originals as legacy } from '../reporting/projection/catalog.js';
import { backupLimits as limits, fail, BackupError } from './models.js';
import { component, digest, openContainer, sealContainer, strictDocument, safeRelative } from './container.js';
import { owned, ownedPath, boundedFile, privateDirectory, exclusiveFile } from './paths.js';
import { evidenceIdentity, createRecoveryIdentity } from './identity.js';
import { reconstructSecurityState } from '../../shared/evidence.js';
import { financialEvidenceMatches } from '../finance/integrity.js';
import { lendingEvidenceMatches } from '../lending/integrity.js';
import { managementEvidenceMatches } from '../obligations/evidence.js';
import { simulationEvidenceMatches } from '../simulation/evidence.js';
import { ProjectionCodec } from '../obligations/codec.js';
import { globalEvidence } from '../obligations/models.js';
const economics = [...new Set([...managed, ...legacy])].sort();
const sorted = (v) => v.sort((a, b) => String(a['_id']).localeCompare(String(b['_id'])));
const stringify = (v) => BSON.EJSON.stringify(v, { relaxed: false });
const parse = (text) => BSON.EJSON.parse(text);
async function boundDatabase(database, group) { await owned(group); if (database.db.databaseName !== group.names[0] || database.client.options.replicaSet !== 'rs0' || !database.client.options.hosts.every(h => typeof h.host === 'string' && ['127.0.0.1', 'localhost'].includes(h.host) && h.port === 27017))
    fail('BACKUP_OWNERSHIP'); }
async function readCollection(db, name) { if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name))
    fail(); const rows = await db.collection(name).find({}).limit(limits.documents + 1).toArray(); if (rows.length > limits.documents)
    fail('BACKUP_LIMIT'); return sorted(rows); }
async function catalog(db) { const rows = (await db.listCollections().toArray()).filter(c => !c.name.startsWith('system.')).sort((a, b) => a.name.localeCompare(b.name)); const items = []; for (const c of rows) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(c.name))
        fail();
    items.push({ name: c.name, indexes: await db.collection(c.name).listIndexes().toArray(), options: 'options' in c ? c.options ?? {} : {} });
} return items; }
function software(items) {
    if (!Array.isArray(items) || items.length > 2000)
        fail('BACKUP_LIMIT');
    const seen = new Set();
    let total = 0;
    for (const item of items) {
        if (!item || Object.keys(item).sort().join(',') !== 'bytes,dataBase64,relativePath,sha256' || typeof item.relativePath !== 'string' || !['runtime/server/', 'contracts/', 'locks/server/'].some(prefix => item.relativePath.startsWith(prefix)) || safeRelative(item.relativePath) !== item.relativePath || seen.has(item.relativePath.toLowerCase()) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > limits.component || typeof item.dataBase64 !== 'string' || typeof item.sha256 !== 'string')
            fail();
        seen.add(item.relativePath.toLowerCase());
        const bytes = Buffer.from(item.dataBase64, 'base64');
        total += bytes.length;
        if (total > limits.component)
            fail('BACKUP_LIMIT');
        if (bytes.length !== item.bytes || bytes.toString('base64') !== item.dataBase64 || digest(bytes) !== item.sha256)
            fail('BACKUP_CUT');
    }
    for (const required of ['runtime/server/src/server.js', 'locks/server/package-lock.json', 'locks/server/package.json', 'contracts/openapi-simulation-alerts-s13-p01.json'])
        if (!seen.has(required))
            fail('BACKUP_CUT');
    return items;
}
function options(raw) { if (!raw || Array.isArray(raw) || Object.keys(raw).some(k => !['changeStreamPreAndPostImages', 'validator', 'validationLevel', 'validationAction', 'collation'].includes(k)))
    fail('BACKUP_STATE'); return raw; }
async function collections(db) { const rows = []; for (const c of await catalog(db))
    rows.push({ ...c, documents: stringify(await readCollection(db, c.name)) }); return rows; }
export async function economicDigest(database) { const rows = []; for (const name of economics)
    rows.push([name, await readCollection(database.db, name)]); return digest(stringify(rows)); }
function snapshotDigest(snapshot) { return digest(stringify(economics.map(n => [n, sorted(snapshot.collections[n] ? parse(snapshot.collections[n]) : [])]))); }
async function domains(database, journal) { const expected = reconstructSecurityState(journal); if (!await financialEvidenceMatches(database, expected.finance) || !await lendingEvidenceMatches(database, expected.lending) || !await managementEvidenceMatches(database, expected.management) || !await simulationEvidenceMatches(database, expected.simulation))
    fail('BACKUP_CUT'); }
function snapshotIdentity(snapshot, identity, cursor) {
    if (!/^caudelyx_s08_p02_[a-f0-9]{24}$/.test(identity))
        fail('BACKUP_CUT');
    const codec = new ProjectionCodec(createHmac('sha256', cursor).update('S09:ORIGINALS:v1').digest());
    for (const name of managed) {
        const rows = parse(snapshot.collections[name] ?? '[]');
        if (!Array.isArray(rows))
            fail('BACKUP_CUT');
        for (const row of rows) {
            const { mac, ...body } = row;
            if (!codec.verify(name === globalEvidence ? 'GLOBAL:' + identity : 'ROW:' + identity + ':' + name, body, mac))
                fail('BACKUP_CUT');
        }
    }
    const manifests = parse(snapshot.collections['s12_projection_manifests'] ?? '[]');
    if (!Array.isArray(manifests) || manifests.some(m => m['databaseName'] !== identity))
        fail('BACKUP_CUT');
}
async function quiet(source) { await boundDatabase(source.database, source.group); await source.quiesce(); for (const table of ['s11_jobs', 's12_runs'])
    if (await source.database.db.collection(table).countDocuments({ state: { $in: ['QUEUED', 'RUNNING'] } }))
        fail('BACKUP_STATE'); }
export async function beginBackupCut(source) {
    await quiet(source);
    await source.restore.flush();
    if (!source.restore.isOpen())
        fail('BACKUP_STATE');
    await domains(source.database, await source.restore.fileJournal.readVerified(true));
    const snapshot = await source.restore.snapshot(), rows = await source.restore.fileJournal.readVerified(true);
    if (snapshot.watermark > rows.length)
        fail('BACKUP_CUT');
    return { snapshot, signatureAtT0: rows[snapshot.watermark - 1]?.signature ?? '', economicDigest: snapshotDigest(snapshot) };
}
export async function captureBackup(source, destination, cut, candidate, signal) {
    signal?.throwIfAborted();
    await quiet(source);
    await owned(destination);
    if (source.group.names.some(n => destination.names.includes(n)))
        fail('BACKUP_OWNERSHIP');
    await source.restore.flush();
    if (!source.restore.isOpen() || cut.economicDigest !== snapshotDigest(cut.snapshot) || await economicDigest(source.database) !== cut.economicDigest)
        fail('BACKUP_CUT');
    const signed = { watermark: cut.snapshot.watermark, collections: cut.snapshot.collections };
    if (createHmac('sha256', source.keys.journal).update(JSON.stringify(signed)).digest('hex') !== cut.snapshot.signature)
        fail('BACKUP_CUT');
    const journal = await source.restore.fileJournal.readVerified(true), head = await source.database.client.db(source.group.names[2]).collection('head').findOne({ _id: 'security' }), sequence = await source.database.db.collection('security_sequence').findOne({ _id: 'security' });
    if (head?.['sequence'] !== journal.length || sequence?.['value'] !== journal.length || (head?.['signature'] ?? '') !== (journal.at(-1)?.signature ?? '') || cut.snapshot.watermark > journal.length || (journal[cut.snapshot.watermark - 1]?.signature ?? '') !== cut.signatureAtT0)
        fail('BACKUP_CUT');
    await domains(source.database, journal);
    const components = [component('SIGNED_PRINCIPAL_SNAPSHOT', 'snapshot/principal.ejson', Buffer.from(JSON.stringify(cut.snapshot))), component('EXTERNAL_MAIL_DATA', 'external/mail.ejson', Buffer.from(stringify(await collections(source.database.client.db(source.group.names[1]))))), component('EXTERNAL_SECURITY_DATA', 'external/security.ejson', Buffer.from(stringify(await collections(source.database.client.db(source.group.names[2])))))];
    const controls = [];
    for (const name of ['gate.json', 'gate.json.journal.jsonl', 'gate.json.journal.jsonl.receipts.json', 'cert.pem', 'key.pem']) {
        const target = path.join(source.group.folder, name);
        await ownedPath(source.group, target);
        try {
            const bytes = await boundedFile(source.group, target, limits.component);
            components.push(component(name === 'gate.json.journal.jsonl' ? 'EXTERNAL_JOURNAL' : 'EXTERNAL_CONTROL', 'controls/' + name, bytes));
            controls.push(name);
        }
        catch (error) {
            if (error.code !== 'ENOENT' || ['gate.json', 'gate.json.journal.jsonl'].includes(name))
                throw error;
        }
    }
    const privateFiles = [], privateRoot = path.join(source.group.folder, 'private');
    await ownedPath(source.group, privateRoot);
    for (const name of (await fs.readdir(privateRoot)).sort()) {
        if (!/^[a-f0-9-]{36}$/.test(name))
            fail('BACKUP_STATE');
        const bytes = await boundedFile(source.group, path.join(privateRoot, name), 33554432);
        components.push(component('PRIVATE_FILE', 'private/' + name, bytes));
        privateFiles.push(name);
    }
    const mainCatalog = await catalog(source.database.db);
    const keyring = { version: source.keys.priority ? 2 : 1, mail: source.keys.mail.toString('base64url'), totp: source.keys.totp.toString('base64url'), journal: source.keys.journal.toString('base64url'), cursor: source.keys.cursor.toString('base64url'), ...(source.keys.priority ? { priority: source.keys.priority.toString('base64url') } : {}) };
    components.push(component('PRODUCT_KEYRING', 'keys/product.json', Buffer.from(JSON.stringify(keyring))));
    const softwareArtifacts = software(source.artifacts.map(a => ({ relativePath: a.relativePath, bytes: a.bytes.length, sha256: digest(a.bytes), dataBase64: a.bytes.toString('base64') })));
    const configuration = { version: 1, evidenceIdentityName: evidenceIdentity(source.database), softwareArtifacts, mainCatalog, excluded: mainCatalog.filter(c => !Object.hasOwn(cut.snapshot.collections, c.name)).map(c => c.name), controls, privateFiles, economicDigest: cut.economicDigest, securityCut: { watermark: journal.length, signature: journal.at(-1)?.signature ?? '' }, componentCatalog: components.map(({ dataBase64, ...metadata }) => { void dataBase64; return metadata; }), configuration: source.configuration }, configBytes = Buffer.from(stringify(configuration));
    components.push(component('CONFIGURATION', 'config/configuration.json', configBytes));
    signal?.throwIfAborted();
    if (await economicDigest(source.database) !== cut.economicDigest)
        fail('BACKUP_CUT');
    return { formatVersion: 1, runId: source.group.runId, source: { databaseNames: [...source.group.names] }, destination: { databaseNames: [...destination.names] }, cut: { economicAsOf: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(source.now()), capturedAtUTC: new Date(source.now()).toISOString(), T0: cut.snapshot.watermark, T1: journal.length, securitySignatureAtT0: cut.signatureAtT0, securitySignatureAtT1: journal.at(-1)?.signature ?? '' }, candidate: { ...candidate, configurationSHA256: digest(configBytes) }, components };
}
export async function saveBackup(group, payload, signal) {
    await owned(group);
    if (JSON.stringify(payload.source.databaseNames) !== JSON.stringify(group.names) || payload.runId !== group.runId)
        fail('BACKUP_OWNERSHIP');
    const sealed = sealContainer(payload, signal), archives = await privateDirectory(group, 'archives'), secrets = await privateDirectory(group, 'secrets'), archivePath = path.join(archives, sealed.key.keyId + '.cbk'), keyPath = path.join(secrets, sealed.key.keyId + '.json');
    await exclusiveFile(group, archivePath, sealed.bytes, signal);
    await exclusiveFile(group, keyPath, Buffer.from(JSON.stringify(sealed.key)), signal);
    return { archivePath, keyPath, bytes: sealed.bytes.length, containerSHA256: sealed.key.containerSHA256, keyId: sealed.key.keyId };
}
export async function readBackup(group, archivePath, keyPath) {
    if (path.dirname(archivePath) !== path.join(group.folder, 'archives') || path.dirname(keyPath) !== path.join(group.folder, 'secrets'))
        fail('BACKUP_PATH');
    const bytes = await boundedFile(group, archivePath, limits.cipher), key = strictDocument(await boundedFile(group, keyPath, 4096));
    return { bytes, key };
}
function keyring(bytes) {
    const value = strictDocument(bytes);
    if (!value || ![1, 2].includes(Number(value['version'])) || typeof value['version'] !== 'number')
        return fail();
    const keys = ['mail', 'totp', 'journal', 'cursor', ...(value['version'] === 2 ? ['priority'] : [])];
    if (Object.keys(value).length !== keys.length + 1 || Object.keys(value).some(k => k !== 'version' && !keys.includes(k)))
        fail();
    const result = { version: value['version'] };
    for (const name of keys) {
        const v = value[name];
        if (typeof v !== 'string')
            fail();
        const bytes = Buffer.from(v, 'base64url');
        if (bytes.length !== 32 || bytes.toString('base64url') !== v)
            fail();
        if (name === 'mail')
            result.mail = bytes;
        else if (name === 'totp')
            result.totp = bytes;
        else if (name === 'journal')
            result.journal = bytes;
        else if (name === 'cursor')
            result.cursor = bytes;
        else
            result.priority = bytes;
    }
    return result;
}
async function restoreCollections(db, items) {
    const seen = new Set();
    if (!Array.isArray(items))
        fail();
    for (const item of items) {
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(item.name) || seen.has(item.name) || typeof item.documents !== 'string' || !Array.isArray(item.indexes))
            fail();
        seen.add(item.name);
        const rows = parse(item.documents);
        if (!Array.isArray(rows) || rows.length > limits.documents)
            fail('BACKUP_LIMIT');
        await db.createCollection(item.name, options(item.options)).catch(e => { if (e.code !== 48)
            throw e; });
        if (rows.length)
            await db.collection(item.name).insertMany(rows);
        for (const raw of item.indexes) {
            const { v, ns, ...index } = raw;
            void v;
            void ns;
            if (index['name'] === '_id_')
                continue;
            if (!index['key'] || typeof index['key'] !== 'object')
                fail();
            await db.collection(item.name).createIndexes([index]);
        }
    }
}
export async function restoreBackup(input) {
    const { destination: group, database, signal } = input;
    signal?.throwIfAborted();
    await owned(input.source);
    await boundDatabase(database, group);
    if (!input.reviewId.trim())
        fail('BACKUP_OWNERSHIP');
    for (const name of group.names)
        for (const c of await database.client.db(name).listCollections().toArray())
            if (await database.client.db(name).collection(c.name).countDocuments())
                fail('BACKUP_STATE');
    const gatePath = path.join(group.folder, 'gate.json');
    await ownedPath(group, gatePath);
    // This non-authenticating sentinel is persistent BEFORE decryption. An invalid/missing
    // key must not turn an attempted restore back into an apparently fresh database.
    const pending = Buffer.from(JSON.stringify({ localRecoveryPending: 'S13_LOCAL_RECOVERY_PENDING_V1', runId: group.runId, manifestSHA256: input.expectedCandidate.manifestSHA256 }));
    try {
        const prior = await boundedFile(group, gatePath, 65536);
        if (!prior.equals(pending))
            fail('BACKUP_STATE');
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        await exclusiveFile(group, gatePath, pending, signal);
    }
    const payload = openContainer(input.bytes, input.key, signal);
    if (payload.runId !== input.source.runId || JSON.stringify(payload.source.databaseNames) !== JSON.stringify(input.source.names) || JSON.stringify(payload.destination.databaseNames) !== JSON.stringify(group.names) || JSON.stringify(payload.candidate) !== JSON.stringify(input.expectedCandidate))
        fail('BACKUP_OWNERSHIP');
    const contents = new Map(payload.components.map(c => [c.relativePath, Buffer.from(c.dataBase64, 'base64')])), get = (name) => contents.get(name) ?? fail();
    const keys = keyring(get('keys/product.json')), configuration = parse(get('config/configuration.json').toString('utf8')), snapshot = strictDocument(get('snapshot/principal.ejson'));
    if (configuration.version !== 1 || configuration.securityCut?.watermark !== payload.cut.T1 || configuration.securityCut?.signature !== payload.cut.securitySignatureAtT1 || JSON.stringify(configuration.componentCatalog) !== JSON.stringify(payload.components.filter(c => c.kind !== 'CONFIGURATION').map(({ dataBase64, ...metadata }) => { void dataBase64; return metadata; })) || !Array.isArray(configuration.mainCatalog) || !Array.isArray(configuration.controls) || !Array.isArray(configuration.privateFiles) || !configuration.controls.includes('gate.json') || !configuration.controls.includes('gate.json.journal.jsonl') || digest(get('config/configuration.json')) !== payload.candidate.configurationSHA256 || snapshot.watermark !== payload.cut.T0 || snapshotDigest(snapshot) !== configuration.economicDigest)
        fail('BACKUP_CUT');
    if (createHmac('sha256', keys.journal).update(JSON.stringify({ watermark: snapshot.watermark, collections: snapshot.collections })).digest('hex') !== snapshot.signature)
        fail('BACKUP_CUT');
    software(configuration.softwareArtifacts);
    snapshotIdentity(snapshot, configuration.evidenceIdentityName, keys.cursor);
    const declared = new Set(['snapshot/principal.ejson', 'external/mail.ejson', 'external/security.ejson', 'keys/product.json', 'config/configuration.json', ...configuration.controls.map(n => 'controls/' + n), ...configuration.privateFiles.map(n => 'private/' + n)]);
    if (contents.size !== declared.size || [...contents.keys()].some(n => !declared.has(n)))
        fail('BACKUP_CUT');
    const fileRows = parse(snapshot.collections['s11_files'] ?? '[]');
    if (!Array.isArray(fileRows))
        fail('BACKUP_CUT');
    for (const record of fileRows) {
        if (['STAGING', 'CORRUPT'].includes(String(record['state'])))
            fail('BACKUP_STATE');
        if (['VERIFIED', 'READY'].includes(String(record['state']))) {
            const name = 'private/' + String(record['_id']), file = contents.get(name);
            if (!file || typeof record['bytes'] !== 'number' || file.length !== record['bytes'] || digest(file) !== record['sha256'])
                fail('BACKUP_CUT');
        }
    }
    // Replace only our exact pending sentinel atomically with an authenticated CLOSED
    // destination control. Original source signatures/rows are never changed.
    if (!(await boundedFile(group, gatePath, 65536)).equals(pending))
        fail('BACKUP_STATE');
    const identityBytes = createRecoveryIdentity(configuration.evidenceIdentityName, group, payload.candidate, payload.cut.T1, payload.cut.securitySignatureAtT1, keys.journal), identityPath = gatePath + '.identity.json';
    await ownedPath(group, identityPath);
    const closed = { open: false, requiredCut: payload.cut.T1, snapshotWatermark: payload.cut.T0, reviewId: null, flushedSequence: payload.cut.T1, flushedSignature: payload.cut.securitySignatureAtT1, recoveryIdentitySHA256: digest(identityBytes) }, temporary = path.join(group.folder, 'gate.' + randomUUID() + '.tmp');
    await exclusiveFile(group, temporary, Buffer.from(JSON.stringify({ payload: closed, signature: createHmac('sha256', keys.journal).update(JSON.stringify(closed)).digest('hex') })), signal);
    await ownedPath(group, gatePath);
    await fs.rename(temporary, gatePath);
    await exclusiveFile(group, identityPath, identityBytes, signal);
    const restore = new RestoreController(database, gatePath, keys.journal, keys.priority, keys.cursor);
    await restore.closeForLocalRecovery();
    let phase = 'FILES';
    try {
        if (restore.isOpen())
            fail('BACKUP_STATE');
        const secretRoot = await privateDirectory(group, 'secrets');
        await exclusiveFile(group, path.join(secretRoot, 'product.json'), get('keys/product.json'), signal);
        // gate.json is archived for evidence, never copied open into the new destination.
        for (const name of configuration.controls)
            if (name !== 'gate.json') {
                if (!['gate.json.journal.jsonl', 'gate.json.journal.jsonl.receipts.json', 'cert.pem', 'key.pem'].includes(name))
                    fail('BACKUP_PATH');
                await exclusiveFile(group, path.join(group.folder, name), get('controls/' + name), signal);
            }
        const privateRoot = path.join(group.folder, 'private');
        await ownedPath(group, privateRoot);
        await fs.mkdir(privateRoot, { mode: 0o700 });
        for (const name of configuration.privateFiles) {
            if (!/^[a-f0-9-]{36}$/.test(name))
                fail('BACKUP_PATH');
            await exclusiveFile(group, path.join(privateRoot, name), get('private/' + name), signal);
        }
        phase = 'EXTERNAL';
        await restoreCollections(database.client.db(group.names[1]), parse(get('external/mail.ejson').toString('utf8')));
        await restoreCollections(database.client.db(group.names[2]), parse(get('external/security.ejson').toString('utf8')));
        const journal = await restore.fileJournal.readVerified(true), head = await database.client.db(group.names[2]).collection('head').findOne({ _id: 'security' });
        if (journal.length !== payload.cut.T1 || (journal.at(-1)?.signature ?? '') !== payload.cut.securitySignatureAtT1 || (journal[payload.cut.T0 - 1]?.signature ?? '') !== payload.cut.securitySignatureAtT0 || head?.['sequence'] !== journal.length || head?.['signature'] !== (journal.at(-1)?.signature ?? ''))
            fail('BACKUP_CUT');
        phase = 'CATALOG';
        for (const c of configuration.mainCatalog) {
            if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(c.name))
                fail();
            await database.db.createCollection(c.name, options(c.options)).catch(e => { if (e.code !== 48)
                throw e; });
            for (const raw of c.indexes) {
                const { v, ns, ...index } = raw;
                void v;
                void ns;
                if (index['name'] !== '_id_')
                    await database.db.collection(c.name).createIndexes([index]);
            }
        }
        phase = 'BEGIN_RESTORE';
        signal?.throwIfAborted();
        await restore.beginRestore(snapshot);
        if (restore.isOpen() || await economicDigest(database) !== configuration.economicDigest)
            fail('BACKUP_CUT');
        await domains(database, journal);
        phase = 'INITIALIZE';
        await restore.initialize();
        if (restore.isOpen())
            fail('BACKUP_STATE');
        signal?.throwIfAborted();
        phase = 'RECONCILE';
        await restore.reconcile({ approved: true, reviewId: input.reviewId });
        signal?.throwIfAborted();
        if (!restore.isOpen())
            fail('BACKUP_STATE');
        return { restore, keys, privateRoot, payload, observed: { economicDigest: configuration.economicDigest, securityCut: journal.length, privateFiles: configuration.privateFiles.length, components: payload.components.length, softwareArtifacts: configuration.softwareArtifacts.length, evidenceIdentity: evidenceIdentity(database), physicalDatabaseName: database.db.databaseName, lossWithinIncludedCut: 0 } };
    }
    catch (error) {
        try {
            await restore.closeForLocalRecovery();
        }
        catch {
            throw new BackupError('BACKUP_STATE', phase);
        }
        throw new BackupError(error instanceof BackupError ? error.code : 'BACKUP_CUT', phase);
    }
}
//# sourceMappingURL=workflow.js.map