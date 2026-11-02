import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localReceipt } from '../../src/modules/local-recovery/telemetry.js';
test('operation receipts accept closed technical metadata and reject private fields, arbitrary errors and identifiers', () => {
    const record = { runId: randomUUID(), correlationId: randomUUID(), phase: 'RESTORE', state: 'PASS', code: 'OK', durationMs: 123, bytes: 456, ownResources: 2 };
    const accepted = localReceipt(record);
    assert.equal(Object.isFrozen(accepted), true);
    assert.equal(JSON.stringify(accepted).includes('BACKUP_TEST_PRIVATE_MARKER'), false);
    for (const field of ['email', 'token', 'cookie', 'nonce', 'otp', 'grant', 'key', 'uri', 'requestBody', 'balance'])
        assert.throws(() => localReceipt({ ...record, [field]: 'BACKUP_TEST_PRIVATE_MARKER' }));
    for (const value of [{ ...record, runId: 'person@example.test' }, { ...record, phase: 'ARBITRARY_PRIVATE_MESSAGE' }, { ...record, code: 'ERROR_WITH_PII' }, { ...record, bytes: -1 }, { ...record, durationMs: NaN }])
        assert.throws(() => localReceipt(value));
});
//# sourceMappingURL=telemetry.test.js.map