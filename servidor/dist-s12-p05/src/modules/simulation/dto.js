import { metric } from './engine.js';
import { cents } from './money.js';
export const fields = (r, keys) => Object.fromEntries(keys.map(k => [k, r[k]]));
export const tag = (r) => '"s12:' + r._id + ':' + r.version + '"';
export const scenarioDTO = (r) => ({ id: r._id, ...fields(r, ['version', 'status', 'name', 'currentVersion', 'createdAt', 'expiresAt']) });
export const versionDTO = (r) => ({ id: r._id, ...fields(r, ['scenarioId', 'number', 'baseId', 'horizonDays', 'assumptions', 'alternatives', 'digest', 'createdAt', 'expiresAt']) });
export const runDTO = (r) => ({ id: r._id, ...fields(r, ['scenarioId', 'scenarioVersion', 'baseId', 'state', 'version', 'createdAt', 'expiresAt', 'sourceDigest', 'errorCode', 'retryable']) });
export const alertDTO = (r) => fields(r, ['id', 'type', 'class', 'severity', 'state', 'freshness', 'episode', 'version', 'conditionFingerprint', 'amount', 'effectiveDate', 'lastEvaluatedAt', 'expiresAt', 'ackAt', 'sourceRefs', 'runId']);
export const commandDTO = (r) => fields(r, ['key', 'purpose', 'state', 'resourceId', 'requestDigest', 'expiresAt']);
export function baseDTO(r, b, token) {
    const summary = (name) => metric(b.books.reduce((n, v) => n + cents(v[name]), 0n));
    return { id: r._id, scope: { kind: r.scopeKind, bookId: r.bookId, ownerId: r.ownerId }, asOf: b.asOf, knownAt: b.knownAt, capturedAt: r.createdAt, expiresAt: r.expiresAt, freshUntil: r['freshUntil'], baseToken: token, sourceDigest: b.sourceDigest, schemaVersion: '1.0.0', policyVersion: 'S12-SIMULATION-1.0', currency: 'COP', cashBook: summary('cashBook'), available: summary('available'), reserved: summary('reserved'), held: summary('held'), custodyProvisional: summary('custodyProvisional'), custodyConfirmed: summary('custodyConfirmed'), committed: summary('committed'), coverage: b.books.every(v => v.coverage === 'COMPLETE') ? 'COMPLETE' : 'INCOMPLETE', sourceRefs: b.books.flatMap(v => v.sourceRefs) };
}
//# sourceMappingURL=dto.js.map