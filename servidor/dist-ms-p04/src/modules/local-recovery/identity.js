/* eslint-disable security/detect-non-literal-fs-filename -- Fixed authenticated synthetic recovery control, never an HTTP path. No Mongo name/proxy is replaced. */
import { createHmac, createHash } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { strictDocument } from './container.js';
const domain = 'CAUDELYX:S13:RECOVERY_IDENTITY:v1:', name = /^caudelyx_s08_p02_[a-f0-9]{24}$/, hash = /^[a-f0-9]{64}$/;
const bindings = new WeakMap();
const invalid = () => { throw Error('RECOVERY_IDENTITY_INVALID'); };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const mac = (key, payload) => createHmac('sha256', key).update(domain + JSON.stringify(payload)).digest('hex');
export const evidenceIdentity = (database) => bindings.get(database)?.name ?? database.db.databaseName;
export const recoveryIdentityDigest = (database) => bindings.get(database)?.digest;
export function recoveryIdentityCurrent(database, gatePath, key) { if (!bindings.has(database))
    return true; try {
    configureRecoveryIdentity(database, gatePath, key);
    return true;
}
catch {
    return false;
} }
export function createRecoveryIdentity(sourceDatabaseName, group, candidate, cut, signature, key) {
    if (!name.test(sourceDatabaseName) || !name.test(group.names[0] ?? '') || key.length !== 32 || !Number.isSafeInteger(cut) || cut < 0 || cut > 0 && !hash.test(signature) || cut === 0 && signature !== '')
        invalid();
    const payload = { formatVersion: 1, sourceDatabaseName, physicalDatabaseName: group.names[0], destinationRunId: group.runId, ownerNonceSHA256: digest(group.nonce), configurationSHA256: candidate.configurationSHA256, manifestSHA256: candidate.manifestSHA256, sourceFingerprint: candidate.sourceFingerprint, securityCut: cut, securitySignatureAtCut: signature };
    return Buffer.from(JSON.stringify({ payload, signature: mac(key, payload) }));
}
function readOptional(file) { try {
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || realpathSync(file) !== file || st.size > 65536)
        invalid();
    return readFileSync(file);
}
catch (error) {
    if (error.code === 'ENOENT')
        return;
    throw error;
} }
/** Default profiles retain physical identity. A recovery identity is accepted only
 * together with its authenticated gate pin, exact destination and private owner. */
export function configureRecoveryIdentity(database, gatePath, key) {
    const gateBytes = readOptional(gatePath), bytes = readOptional(gatePath + '.identity.json');
    let required;
    if (gateBytes) {
        try {
            const g = strictDocument(gateBytes);
            if (g.signature === createHmac('sha256', key).update(JSON.stringify(g.payload)).digest('hex'))
                required = g.payload['recoveryIdentitySHA256'];
        }
        catch {
            if (bytes)
                invalid();
        }
    }
    if (!bytes) {
        if (required !== undefined || bindings.has(database))
            invalid();
        return;
    }
    if (!hash.test(String(required)) || digest(bytes) !== required || key.length !== 32 || !path.isAbsolute(gatePath) || path.basename(gatePath) !== 'gate.json')
        invalid();
    const folder = path.dirname(gatePath), runtime = path.resolve('.runtime'), physical = database.db.databaseName;
    if (path.dirname(folder) !== runtime || !/^(?:s13-p(?:02|04|05)|ms-p(?:02|04))-[a-f0-9]{24}$/.test(path.basename(folder)) || !name.test(physical) || folder.slice(-24) !== physical.slice(-24) || realpathSync(folder) !== folder || realpathSync(runtime) !== runtime || lstatSync(folder).isSymbolicLink())
        invalid();
    const envelope = strictDocument(bytes), payload = envelope.payload;
    if (!envelope || Object.keys(envelope).sort().join(',') !== 'payload,signature' || !payload || Object.keys(payload).sort().join(',') !== ['formatVersion', 'sourceDatabaseName', 'physicalDatabaseName', 'destinationRunId', 'ownerNonceSHA256', 'configurationSHA256', 'manifestSHA256', 'sourceFingerprint', 'securityCut', 'securitySignatureAtCut'].sort().join(',') || envelope.signature !== mac(key, payload) || payload.formatVersion !== 1 || !name.test(payload.sourceDatabaseName) || payload.physicalDatabaseName !== physical || !Number.isSafeInteger(payload.securityCut) || payload.securityCut < 0 || payload.securityCut > 0 && !hash.test(payload.securitySignatureAtCut) || payload.securityCut === 0 && payload.securitySignatureAtCut !== '' || ![payload.ownerNonceSHA256, payload.configurationSHA256, payload.manifestSHA256, payload.sourceFingerprint].every(v => typeof v === 'string' && hash.test(v)))
        invalid();
    const ownerBytes = readOptional(path.join(folder, 'owner.json'));
    if (!ownerBytes)
        invalid();
    const owner = strictDocument(ownerBytes);
    if (owner.id !== physical.slice(-24) || owner.runId !== payload.destinationRunId || typeof owner.nonce !== 'string' || digest(owner.nonce) !== payload.ownerNonceSHA256 || JSON.stringify(owner.names) !== JSON.stringify([physical, physical + '_external_mail', physical + '_external_security']))
        invalid();
    const old = bindings.get(database);
    if (old && (old.name !== payload.sourceDatabaseName || old.digest !== required))
        invalid();
    bindings.set(database, { name: payload.sourceDatabaseName, digest: String(required) });
}
//# sourceMappingURL=identity.js.map