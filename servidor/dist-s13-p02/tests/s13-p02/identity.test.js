/* eslint-disable security/detect-non-literal-fs-filename -- Exact own synthetic control directory/nonce, no DB connection; all writers guarded and teardown verifies its root. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash, createHmac } from 'node:crypto';
import { readFile, rm, unlink, realpath } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { Database } from '../../src/shared/database.js';
import { RestoreController } from '../../src/shared/restore.js';
import { configureRecoveryIdentity, createRecoveryIdentity, evidenceIdentity } from '../../src/modules/local-recovery/identity.js';
import { configureManagementEvidence, signRow, verifyRow } from '../../src/modules/obligations/evidence.js';
import { protectGroup } from '../../src/modules/local-recovery/paths.js';
const guard = await import(new URL('../../../scripts/s13-p02-guard.mjs', import.meta.url).href);
const sha = (v) => createHash('sha256').update(v).digest('hex');
test('approved recovery identity preserves original MAC and physical driver, persists gate pin and rejects cold missing/corrupt/misbinding controls before DB', { timeout: 30000 }, async () => {
    const id = randomBytes(12).toString('hex'), runId = randomUUID(), folder = resolve('.runtime/s13-p02-' + id), physical = 'caudelyx_s08_p02_' + id, group = { folder, runId, nonce: randomBytes(24).toString('hex'), names: [physical, physical + '_external_mail', physical + '_external_security'] }, key = randomBytes(32), cursor = randomBytes(32), gatePath = join(folder, 'gate.json'), bindingPath = gatePath + '.identity.json', clients = [], checks = [];
    const receipt = join(guard.projectRoot, 'Construccion/Sprints/S13/Evidencias/S13-P02-IDENTITY-RESOURCES.json'), history = receipt + 'l', reserved = { state: 'FS_CONTROLS_RESERVED_BEFORE_CREATE', runId, folder, registeredNames: group.names, createdDatabaseNames: [], DBConnections: 0 };
    await guard.writeOwn(receipt, JSON.stringify(reserved) + '\n');
    await guard.appendOwn(history, JSON.stringify(reserved) + '\n');
    await guard.mkdirOwn(folder);
    const owner = { id, runId, pid: process.pid, nonce: group.nonce, names: group.names };
    await guard.writeOwn(join(folder, 'owner.json'), JSON.stringify(owner));
    try {
        await protectGroup(group);
        const candidate = { id: 'SYNTHETIC_UNIT', manifestSHA256: '1'.repeat(64), sourceFingerprint: '2'.repeat(64), contractsSHA256: '3'.repeat(64), configurationSHA256: '4'.repeat(64), keyPolicyVersion: 2 }, sourceName = 'caudelyx_s08_p02_' + 'a'.repeat(24), bytes = createRecoveryIdentity(sourceName, group, candidate, 5, '5'.repeat(64), key);
        const gate = (binding, pin = sha(binding)) => { const payload = { open: false, requiredCut: 5, snapshotWatermark: 4, reviewId: null, flushedSequence: 5, flushedSignature: '5'.repeat(64), recoveryIdentitySHA256: pin }; return JSON.stringify({ payload, signature: createHmac('sha256', key).update(JSON.stringify(payload)).digest('hex') }); };
        const reset = async () => { await guard.writeOwn(bindingPath, bytes); await guard.writeOwn(gatePath, gate(bytes)); await guard.writeOwn(join(folder, 'owner.json'), JSON.stringify(owner)); };
        const database = (name = physical) => { const d = new Database('mongodb://127.0.0.1:27017/?replicaSet=rs0', name); clients.push(d); return d; };
        await reset();
        const destination = database(), source = database(sourceName);
        configureRecoveryIdentity(destination, gatePath, key);
        assert.equal(evidenceIdentity(destination), sourceName);
        assert.equal(destination.db.databaseName, physical);
        configureManagementEvidence(source, cursor);
        configureManagementEvidence(destination, cursor);
        const row = signRow(source, 's09_books', { _id: randomUUID(), amount: '1.00' }), oldBytes = JSON.stringify(row);
        assert.equal(verifyRow(destination, 's09_books', row), true);
        assert.equal(JSON.stringify(row), oldBytes);
        checks.push('valid-control-original-MAC-physical-driver');
        for (const variant of ['missing-binding', 'corrupt-binding', 'wrong-key', 'wrong-physical-destination', 'missing-gate', 'changed-owner-nonce', 'wrong-gate-pin']) {
            await reset();
            let readKey = key;
            if (variant === 'missing-binding')
                await unlink(bindingPath);
            if (variant === 'corrupt-binding')
                await guard.writeOwn(bindingPath, Buffer.from(bytes.toString().replace('sourceDatabaseName', 'sourceDatabaseNamX')));
            if (variant === 'wrong-key')
                readKey = Buffer.alloc(32, 7);
            if (variant === 'wrong-physical-destination') {
                const copy = JSON.parse(bytes.toString());
                copy.payload.physicalDatabaseName = 'caudelyx_s08_p02_' + 'b'.repeat(24);
                copy.signature = createHmac('sha256', key).update('CAUDELYX:S13:RECOVERY_IDENTITY:v1:' + JSON.stringify(copy.payload)).digest('hex');
                const altered = Buffer.from(JSON.stringify(copy));
                await guard.writeOwn(bindingPath, altered);
                await guard.writeOwn(gatePath, gate(altered));
            }
            if (variant === 'missing-gate')
                await unlink(gatePath);
            if (variant === 'changed-owner-nonce')
                await guard.writeOwn(join(folder, 'owner.json'), JSON.stringify({ ...owner, nonce: 'wrong' }));
            if (variant === 'wrong-gate-pin')
                await guard.writeOwn(gatePath, gate(bytes, '0'.repeat(64)));
            const cold = new RestoreController(database(), gatePath, readKey);
            assert.equal(cold.isOpen(), false);
            await assert.rejects(() => cold.initialize());
            assert.equal(cold.isOpen(), false);
            checks.push(variant);
        }
        await reset();
        assert.equal(JSON.parse(await readFile(bindingPath, 'utf8')).payload.sourceDatabaseName, sourceName);
        await guard.writeOwn(join(guard.projectRoot, 'Construccion/Sprints/S13/Evidencias/S13-P02-IDENTITY.json'), JSON.stringify({ state: 'PASS_AUTHOR_FS_AND_CRYPTO', checks, DBConnections: 0, originalMACUnchanged: true, physicalDriverUnchanged: true, missingControlCannotBecomeFresh: true, keyValuesRecorded: false }, null, 2) + '\n');
    }
    finally {
        await Promise.all(clients.map(d => d.close()));
        key.fill(0);
        cursor.fill(0);
        assert.equal(dirname(folder), resolve('.runtime'));
        assert.equal(await realpath(folder), folder);
        await guard.assertWritable(folder);
        await rm(folder, { recursive: true, force: false });
        const removed = { state: 'FS_CONTROLS_REMOVED', runId, folder, registeredNames: group.names, createdDatabaseNames: [], DBConnections: 0, controlRemoved: true, keyValuesRecorded: false };
        await guard.writeOwn(receipt, JSON.stringify(removed) + '\n');
        await guard.appendOwn(history, JSON.stringify(removed) + '\n');
    }
});
//# sourceMappingURL=identity.test.js.map