import { fail } from './models.js';
const keys = ['runId', 'correlationId', 'phase', 'state', 'code', 'durationMs', 'bytes', 'ownResources'];
export function localReceipt(value) {
    if (Object.keys(value).length !== keys.length || Object.keys(value).some(k => !keys.includes(k)) || !['PREFLIGHT', 'CAPTURE', 'ENCRYPT', 'VERIFY', 'RESTORE', 'RECONCILE', 'CLEANUP'].includes(value.phase) || !['PASS', 'FAIL', 'CLOSED'].includes(value.state) || !['OK', 'INTEGRITY', 'ACCESS', 'LIMIT', 'CANCELLED', 'INCOMPLETE'].includes(value.code) || ![value.durationMs, value.bytes, value.ownResources].every(n => Number.isFinite(n) && n >= 0) || ![value.runId, value.correlationId].every(id => /^[a-f0-9-]{36}$/.test(id)))
        fail();
    return Object.freeze({ ...value });
}
//# sourceMappingURL=telemetry.js.map