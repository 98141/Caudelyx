/* eslint-disable security/detect-object-injection -- Root keys are a closed technical catalog, never HTTP keys. */
import { createHash, createHmac } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { Codec, hash } from './codec.js';
import { tables } from './models.js';
export const controls = { heads: 's12_projection_heads', manifests: 's12_projection_manifests', barriers: 's12_projection_barriers' };
export const protectedTables = [...tables, controls.heads, controls.manifests, controls.barriers];
const configured = new WeakMap();
export function configureSimulationEvidence(database, key) { const digest = createHash('sha256').update(key).digest('hex'), old = configured.get(database); if (old && old.keyDigest !== digest)
    throw Error('S12 evidence key cannot change'); if (!old)
    configured.set(database, { codec: new Codec(createHmac('sha256', key).update('S12:EVIDENCE').digest()), keyDigest: digest }); }
export const codec = (database) => { const c = configured.get(database); if (!c)
    throw new AppError(503, 'INTEGRITY_MISMATCH'); return c.codec; };
export function signedBody(row) { const { mac, ...body } = row; void mac; return body; }
export function verifyRow(database, table, row) { return codec(database).verify('ROW:' + table, signedBody(row), row['mac']); }
export function sealRow(database, table, row) { return { ...row, mac: codec(database).seal('ROW:' + table, row) }; }
export async function simulationHead(database, s) {
    const row = await database.db.collection(controls.heads).findOne({ _id: 'GLOBAL' }, s ? { session: s } : {});
    if (!row)
        return undefined;
    if (!codec(database).verify('HEAD', signedBody(row), row.mac))
        throw new AppError(503, 'INTEGRITY_MISMATCH');
    return { format: 'simulation-v1', digest: hash(row), revision: row.technicalRevision };
}
export async function simulationEvidenceMatches(database, expected) {
    const existing = new Set((await database.db.listCollections().toArray()).map(r => r.name));
    const global = await database.db.collection(controls.heads).findOne({ _id: 'GLOBAL' });
    if (!global) {
        if (expected)
            return false;
        for (const name of tables)
            if (existing.has(name) && await database.db.collection(name).countDocuments())
                return false;
        return true;
    }
    if (!expected || expected.format !== 'simulation-v1' || expected.digest !== hash(global) || expected.revision !== global.technicalRevision || protectedTables.some(n => !existing.has(n)))
        return false;
    if (!codec(database).verify('HEAD', signedBody(global), global.mac))
        return false;
    if (global.lastManifest.startsWith('FAULT:'))
        return false;
    let manifestId = global.lastManifest, expectedGlobal = hash(global);
    const chain = new Set();
    while (manifestId) {
        if (chain.has(manifestId) || chain.size > 100000)
            return false;
        chain.add(manifestId);
        const manifest = await database.db.collection(controls.manifests).findOne({ _id: manifestId });
        if (!manifest || manifest['databaseName'] !== database.db.databaseName || !codec(database).verify('MANIFEST', signedBody(manifest), manifest['mac']) || manifest['global'] !== expectedGlobal)
            return false;
        expectedGlobal = manifest['previousGlobal'];
        manifestId = manifest['previousManifest'];
    }
    if (expectedGlobal !== null || await database.db.collection(controls.manifests).countDocuments() !== chain.size)
        return false;
    const heads = await database.db.collection(controls.heads).find({ _id: { $ne: 'GLOBAL' } }).sort({ _id: 1 }).toArray();
    const roots = {};
    for (const h of heads) {
        if (!codec(database).verify('HEAD', signedBody(h), h.mac))
            return false;
        for (const name of tables) {
            const rows = await database.db.collection(name).find({ actorId: h.actorId, scopeKind: h.scopeKind, bookId: h.bookId, ownerId: h.ownerId }).sort({ _id: 1 }).toArray();
            if (rows.some(r => !verifyRow(database, name, r)))
                return false;
            const root = { count: rows.length, hash: hash(rows.map(r => [r._id, hash(r)])) };
            if (hash(root) !== hash(h.roots[name]))
                return false;
        }
        Object.assign(roots, { [h._id]: { count: 1, hash: hash(h) } });
    }
    if (hash(roots) !== hash(global.roots))
        return false;
    for (const name of tables) {
        const count = await database.db.collection(name).countDocuments();
        let total = 0;
        for (const h of heads)
            total += h.roots[name]?.count ?? 0;
        if (count !== total)
            return false;
    }
    return true;
}
//# sourceMappingURL=evidence.js.map