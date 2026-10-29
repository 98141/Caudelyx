import { collections, limits } from './catalog.js';
import { ProjectionCodec, hash, encode, copy, orderedPaths, transactionId, unavailable } from './codec.js';
// This hook is deliberately not enabled by construction or by GET. Initialization
// must verify originals and the observer baseline before calling install().
export class ProjectionStore {
    database;
    codec;
    maintenance = new WeakMap();
    permitMaintenance;
    constructor(database, key) {
        this.database = database;
        this.codec = new ProjectionCodec(key);
    }
    install(builder) {
        this.database.projectionPublisher = async (session, changes) => {
            if (changes.mutations.length === 0)
                return;
            const descriptions = await builder(session, changes);
            await this.publish(session, changes, descriptions);
        };
        this.database.projectionTracking.enabled = true;
    }
    uninstall() { this.database.projectionTracking.enabled = false; delete this.database.projectionPublisher; }
    bootstrap(session, nonce, operation = 'BOOTSTRAP') { this.maintenance.set(session, { nonce, operation }); }
    async publish(session, changes, descriptions) {
        if (!session.inTransaction() || !session.id?.id)
            return unavailable();
        if (changes.mutations.length && descriptions.length === 0)
            return unavailable();
        const tx = transactionId(session.id.id, session.serverSession.txnNumber);
        const maintenance = this.maintenance.get(session);
        const headerCollection = this.database.db.collection(collections.heads);
        const previousHeads = {}, heads = [];
        const seen = new Set();
        for (const description of descriptions) {
            const organizationId = description.organizationId;
            if (seen.has(organizationId) || description._id !== organizationId || !changes.organizations.has(organizationId))
                return unavailable();
            seen.add(organizationId);
            const old = await headerCollection.findOne({ _id: organizationId }, { session });
            if (old) {
                const { mac, ...body } = old;
                if (!this.codec.verify('HEAD', body, mac))
                    return unavailable();
            }
            if (old && ((description.generation !== old.generation && maintenance?.operation !== 'REBUILD') || description.materialRevision !== old.materialRevision + 1))
                return unavailable();
            // eslint-disable-next-line security/detect-object-injection -- Organization IDs from the captured owned write set, not HTTP keys.
            previousHeads[organizationId] = old === null ? null : hash(old);
            const body = { ...description, databaseName: this.database.db.databaseName, lastManifest: tx, previousManifest: old?.lastManifest ?? null };
            const next = { ...body, mac: this.codec.seal('HEAD', body) };
            heads.push(next);
        }
        if (seen.size !== changes.organizations.size)
            return unavailable();
        const mutations = orderedPaths(copy(changes.mutations)), chunks = [];
        let pending = [];
        const add = () => { if (pending.length) {
            chunks.push({ _id: tx + ':' + chunks.length, kind: 'CHUNK', transactionId: tx, part: chunks.length, mutations: pending });
            pending = [];
        } };
        for (const item of mutations) {
            if (Buffer.byteLength(encode([item])) > limits.chunkBytes)
                return unavailable();
            if (pending.length === limits.chunkRows || Buffer.byteLength(encode([...pending, item])) > limits.chunkBytes - 1024)
                add();
            pending.push(item);
        }
        add();
        const nonce = maintenance?.nonce ?? null;
        if (maintenance) {
            if (!this.permitMaintenance)
                return unavailable();
            this.permitMaintenance(tx, maintenance.nonce, maintenance.operation);
            this.maintenance.delete(session);
        }
        const body = { _id: tx, kind: 'HEADER', formatVersion: 1, transactionId: tx, databaseName: this.database.db.databaseName,
            operation: maintenance?.operation ?? 'COMMAND', maintenanceNonce: nonce,
            organizations: [...seen].sort(), previousHeads, heads, chunkHashes: chunks.map(hash),
            mutationCount: mutations.length, mutationRoot: hash(mutations) };
        const header = { ...body, mac: this.codec.seal('MANIFEST', body) };
        const manifests = this.database.db.collection(collections.manifests);
        if (chunks.length)
            await manifests.insertMany(chunks, { session });
        await manifests.insertOne(header, { session });
        for (const head of heads)
            await headerCollection.replaceOne({ _id: head._id }, head, { upsert: true, session });
    }
}
//# sourceMappingURL=store.js.map