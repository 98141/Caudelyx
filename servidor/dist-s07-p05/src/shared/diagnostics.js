import { randomUUID } from 'node:crypto';
// Internal opt-in synthetic diagnostic only. No IDs from requests, credentials,
// cookies, proof contents, bodies or public error differentiation.
const enabled = process.env['CAUDELYX_AUTH_DIAGNOSTICS'] === 'S03-P02';
const instance = randomUUID();
let observations = 0;
const counts = new Map(['sessionMissing', 'sessionRevoked', 'proofConsumed', 'orgEpoch', 'evidenceClosed', 'storageUnavailable', 'unknown'].map(k => [k, 0]));
export function observeAuthFailure(reason = 'unknown') {
    if (enabled && observations < 240) {
        observations++;
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
}
export const diagnosticSnapshot = () => ({ instance, observations, counts: Object.fromEntries(counts), limit: 240 });
if (enabled)
    process.once('exit', () => { process.stderr.write('S03_AUTH_DIAGNOSTIC ' + JSON.stringify(diagnosticSnapshot()) + '\n'); });
//# sourceMappingURL=diagnostics.js.map