/* eslint-disable security/detect-object-injection -- Closed projection roots and registered owned collection names. */
import { BSON } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { POLICY } from '../models.js';
import { loadSources } from '../sources.js';
import { AppError } from '../../../shared/errors.js';
import { financialEvidenceMatches } from '../../finance/integrity.js';
import { head as lendingHead, lendingEvidenceMatches } from '../../lending/integrity.js';
import { collections, originals, limits } from './catalog.js';
import { ProjectionStore } from './store.js';
import { ProjectionObserver } from './observer.js';
import { materialize, unpack, tableRoot, systemAuthority } from './materialize.js';
import { hash, unavailable } from './codec.js';
export class ProjectionRuntime {
    identity;
    rebuild;
    store;
    observer;
    stopped = false;
    prepared = new WeakMap();
    constructor(identity, key, rebuild = false) {
        this.identity = identity;
        this.rebuild = rebuild;
        this.store = new ProjectionStore(identity.database, key);
    }
    static async createOwned(identity, key, verifyOwnership, rebuild = false) {
        const name = identity.database.db.databaseName;
        if (!/^caudelyx_s08_p02_[a-f0-9]{24}$/.test(name) || !await verifyOwnership())
            throw new AppError(403, 'ACCESS_DENIED');
        const hosts = identity.database.client.options.hosts;
        if (hosts.length !== 1 || !['127.0.0.1', 'localhost'].includes(hosts[0]?.host ?? '') || hosts[0]?.port !== 27017)
            throw new AppError(403, 'ACCESS_DENIED');
        if (rebuild)
            await identity.database.projectionShutdown?.();
        if (identity.database.projectionTracking.enabled)
            return unavailable();
        const runtime = new ProjectionRuntime(identity, key, rebuild);
        try {
            await runtime.initialize();
            return runtime;
        }
        catch (error) {
            await runtime.stop();
            throw error;
        }
    }
    async initialize() {
        const database = this.identity.database, db = database.db;
        await this.identity.requireOpen('TENANT');
        const hello = await db.admin().command({ hello: 1 });
        if (hello['setName'] !== 'rs0')
            return unavailable();
        const heads = await db.collection(collections.heads).find({}).toArray();
        for (const head of heads)
            this.verifyHead(head);
        const existing = new Map((await db.listCollections().toArray()).map(row => [row.name, row]));
        for (const name of [...originals, ...Object.values(collections)]) {
            if (existing.has(name)) {
                const info = existing.get(name);
                if (!info || !('options' in info) || info.options?.['changeStreamPreAndPostImages']?.['enabled'] !== true) {
                    if (heads.length)
                        return unavailable();
                    await db.command({ collMod: name, changeStreamPreAndPostImages: { enabled: true } });
                }
            }
            else {
                if (heads.length)
                    return unavailable();
                await db.createCollection(name, { changeStreamPreAndPostImages: { enabled: true } });
            }
        }
        await db.collection(collections.barriers).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
        for (const name of [collections.units, collections.flows, collections.rows, collections.nodes])
            await db.collection(name).createIndex({ organizationId: 1, generation: 1, _id: 1 }, { name: 'projection_scope' });
        const epochs = new Set(heads.map(head => head.restoreEpoch));
        if (epochs.size > 1 && !this.rebuild)
            return unavailable();
        if (!heads.length && !this.rebuild) {
            for (const name of [collections.units, collections.flows, collections.rows, collections.nodes, collections.manifests])
                if (await db.collection(name).countDocuments())
                    return unavailable();
        }
        const epoch = this.rebuild ? randomUUID() : heads[0]?.restoreEpoch ?? randomUUID();
        this.observer = new ProjectionObserver(db, this.store.codec, epoch);
        this.store.permitMaintenance = (tx, nonce, operation) => this.observer.permitBootstrap(tx, nonce, operation);
        this.store.install(async (session, changes) => {
            const prepared = this.prepared.get(session);
            if (prepared) {
                this.prepared.delete(session);
                return prepared;
            }
            const descriptions = [];
            for (const organization of changes.organizations) {
                const old = await db.collection(collections.heads).findOne({ _id: organization }, { session });
                const source = await loadSources(this.identity, organization, systemAuthority(organization), session, performance.now());
                const generation = old?.generation ?? randomUUID(), material = materialize(source, organization, generation);
                await this.checkBudget(material);
                await this.synchronize(organization, generation, material, session);
                descriptions.push(this.describe(organization, generation, epoch, old, source, material));
            }
            return descriptions;
        });
        const previousShutdown = database.projectionShutdown;
        database.projectionShutdown = async () => { await this.stop(); await previousShutdown?.(); };
        await this.observer.start(async () => {
            const financial = await db.collection('financial_evidence_head').findOne({ _id: 'finance' });
            const lending = await lendingHead(database);
            if (!await financialEvidenceMatches(database, financial ?? undefined) || !await lendingEvidenceMatches(database, lending ?? undefined))
                return unavailable();
            if (heads.length && !this.rebuild) {
                await this.verifyManifestChains(heads);
                for (const head of heads)
                    await database.client.withSession(async (session) => session.withTransaction(async () => {
                        const source = await loadSources(this.identity, head.organizationId, systemAuthority(head.organizationId), session, performance.now());
                        this.verifyHead(head);
                        if (source.versions !== head.sourceVector)
                            return unavailable();
                        for (const name of [collections.units, collections.flows, collections.rows, collections.nodes])
                            await this.readTable(head, name, session);
                        // Authenticate semantics against canonical originals as well as stored roots.
                        source.currentDate = String(head['viewDate']);
                        const expected = materialize(source, head.organizationId, head.generation);
                        if (hash(expected.roots) !== hash(head.roots))
                            return unavailable();
                    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' }));
            }
            else {
                const organizations = await db.collection('lending_merkle_orgs').find({}).toArray();
                const ids = new Set([...organizations.map(org => org._id), ...heads.map(head => head.organizationId)]);
                for (const organization of ids)
                    await database.transaction(async (session) => {
                        this.store.bootstrap(session, randomUUID(), this.rebuild ? 'REBUILD' : 'BOOTSTRAP');
                        const old = await db.collection(collections.heads).findOne({ _id: organization }, { session });
                        const source = await loadSources(this.identity, organization, systemAuthority(organization), session, performance.now());
                        const generation = randomUUID(), material = materialize(source, organization, generation);
                        await this.checkBudget(material);
                        await this.synchronize(organization, generation, material, session);
                        this.prepared.set(session, [this.describe(organization, generation, epoch, old, source, material)]);
                    });
            }
        });
    }
    describe(org, generation, epoch, old, source, material) {
        return { _id: org, organizationId: org, generation, formatVersion: 1, materialRevision: (old?.materialRevision ?? 0) + 1,
            restoreEpoch: epoch, sourceVector: source.versions, knowledgeMax: material.knowledgeMax, economicMax: material.economicMax,
            roots: material.roots, eligible: material.eligible, viewDate: material.viewDate, sourceCounts: material.sourceCounts,
            policyVersion: POLICY, codeVersion: 'S08-AUTH-PROJECTION-1', schemaVersion: '1.0.0', databaseName: this.identity.database.db.databaseName,
            retiredGenerations: [...(old?.['retiredGenerations'] ?? []),
                ...(old && old.generation !== generation ? [{ generation: old.generation, retiredAt: new Date().toISOString() }] : [])] };
    }
    async checkBudget(material) {
        const db = this.identity.database.db;
        const incoming = [...material.tables.values()].flat().reduce((n, row) => n + BSON.serialize(row).length, 0);
        let derived = 0;
        for (const name of Object.values(collections)) {
            const stats = await db.command({ collStats: name });
            derived += Number(stats.storageSize) + Number(stats.totalIndexSize);
        }
        let group = 0;
        for (const name of [db.databaseName, db.databaseName + '_external_mail', db.databaseName + '_external_security']) {
            const stats = await this.identity.database.client.db(name).command({ dbStats: 1 });
            group += Number(stats.storageSize) + Number(stats.indexSize);
        }
        // Include head/chunk/index amplification conservatively before committing.
        if (derived + incoming * 3 >= limits.derivedBytes || group + incoming * 3 >= limits.groupBytes)
            return unavailable();
    }
    async synchronize(org, generation, material, session) {
        const db = this.identity.database.db;
        for (const [name, rows] of material.tables) {
            const table = db.collection(name), old = await table.find({ organizationId: org, generation }, { session }).toArray();
            const previous = new Map(old.map(row => [row._id, hash(row)])), next = new Set(rows.map(row => row._id));
            const changed = rows.filter(row => previous.get(row._id) !== hash(row));
            const removed = old.filter(row => !next.has(row._id)).map(row => row._id);
            if (removed.length)
                await table.deleteMany({ _id: { $in: removed } }, { session });
            for (let start = 0; start < changed.length; start += 500) {
                const batch = changed.slice(start, start + 500);
                await table.bulkWrite(batch.map(row => ({ replaceOne: { filter: { _id: row._id }, replacement: row, upsert: true } })), { session });
            }
        }
    }
    verifyHead(head) {
        const { mac, ...body } = head;
        if (head.formatVersion !== 1 || head._id !== head.organizationId || head['databaseName'] !== this.identity.database.db.databaseName || head['policyVersion'] !== POLICY || head['codeVersion'] !== 'S08-AUTH-PROJECTION-1' || head['schemaVersion'] !== '1.0.0' || !this.store.codec.verify('HEAD', body, mac))
            return unavailable();
    }
    async verifyManifestChains(heads) {
        const manifests = this.identity.database.db.collection(collections.manifests);
        const verified = new Map();
        let totalParts = 0;
        const load = async (id) => {
            const cached = verified.get(id);
            if (cached)
                return cached;
            const row = await manifests.findOne({ _id: id });
            if (!row || row.kind !== 'HEADER')
                return unavailable();
            const header = row, { mac, ...body } = header;
            if (header.transactionId !== id || header['databaseName'] !== this.identity.database.db.databaseName || header.formatVersion !== 1 || !this.store.codec.verify('MANIFEST', body, mac))
                return unavailable();
            const mutations = [];
            for (let i = 0; i < header.chunkHashes.length; i++) {
                const chunk = await manifests.findOne({ _id: id + ':' + i });
                if (!chunk || chunk.kind !== 'CHUNK' || chunk.part !== i || chunk.transactionId !== id || hash(chunk) !== header.chunkHashes[i])
                    return unavailable();
                mutations.push(...chunk.mutations);
            }
            if (mutations.length !== header.mutationCount || hash(mutations) !== header.mutationRoot)
                return unavailable();
            verified.set(id, header);
            totalParts += 1 + header.chunkHashes.length;
            return header;
        };
        for (const head of heads) {
            let expected = head;
            const seen = new Set();
            while (true) {
                if (seen.has(expected.lastManifest))
                    return unavailable();
                seen.add(expected.lastManifest);
                const current = await load(expected.lastManifest), attested = current.heads.find(row => row.organizationId === head.organizationId);
                if (!attested || hash(attested) !== hash(expected))
                    return unavailable();
                this.verifyHead(expected);
                if (expected.previousManifest === null) {
                    if (current.previousHeads[head.organizationId] !== null)
                        return unavailable();
                    break;
                }
                const previous = await load(expected.previousManifest), previousHead = previous.heads.find(row => row.organizationId === head.organizationId);
                if (!previousHead || hash(previousHead) !== current.previousHeads[head.organizationId])
                    return unavailable();
                expected = previousHead;
            }
        }
        if (await manifests.countDocuments({ kind: 'HEADER' }) !== verified.size || await manifests.countDocuments() !== totalParts)
            return unavailable();
    }
    async readTable(head, name, session) {
        const expected = head.roots[name];
        if (!expected)
            return unavailable();
        const rows = await this.identity.database.db.collection(name).find({ organizationId: head.organizationId, generation: head.generation }, { session, maxTimeMS: limits.requestMs }).hint('projection_scope').toArray();
        if (hash(tableRoot(rows)) !== hash(expected))
            return unavailable();
        return rows;
    }
    async load(auth, cut, session, operation, report) {
        if (!auth.isT || operation === 'listReportingRows' && report === 'MOVEMENTS')
            return null;
        const head = await this.identity.database.db.collection(collections.heads).findOne({ _id: auth.organizationId }, { session });
        if (!head)
            return null;
        this.verifyHead(head);
        if (!head['eligible'] || head['viewDate'] !== cut.asOf || cut.asOf !== new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(this.identity.now())) || cut.recordedThrough < head.knowledgeMax)
            return null;
        const count = head['sourceCounts'];
        if (count.loans > 10000 || count.events > 100000 || count.lines > 200000)
            throw new AppError(422, 'REPORT_SCOPE_TOO_LARGE');
        const nodes = await this.readTable(head, collections.nodes, session);
        for (const row of nodes) {
            const root = head.roots[String(row['table'])];
            if (!root || hash({ hash: row['hash'], count: row['count'] }) !== hash(root))
                return unavailable();
        }
        const units = await this.readTable(head, collections.units, session), flows = await this.readTable(head, collections.flows, session);
        const source = unpack(units, flows);
        source.versions = head.sourceVector;
        source.knownThrough = [new Date(this.identity.now()).toISOString(), head.knowledgeMax].sort().at(-1);
        return source;
    }
    async bind(source, auth, session) {
        const head = await this.identity.database.db.collection(collections.heads).findOne({ _id: auth.organizationId }, { session });
        if (!head)
            return;
        this.verifyHead(head);
        if (auth.isT && source.versions !== head.sourceVector)
            return unavailable();
        source.versions = hash({ source: source.versions, generation: head.generation, revision: head.materialRevision });
    }
    async enter(started) {
        if (!this.observer?.ready)
            return unavailable();
        try {
            return await this.observer.barrierAfter(started, started + limits.requestMs);
        }
        catch {
            if (performance.now() - started >= limits.requestMs)
                throw new AppError(503, 'REPORT_BUDGET_EXCEEDED');
            return unavailable();
        }
    }
    async leave(previous, started) {
        if (!this.observer)
            return unavailable();
        this.observer.assertCertified(previous);
        try {
            const after = await this.observer.barrierAfter(performance.now(), started + limits.requestMs);
            this.observer.assertCertified(after);
        }
        catch {
            if (performance.now() - started >= limits.requestMs)
                throw new AppError(503, 'REPORT_BUDGET_EXCEEDED');
            return unavailable();
        }
    }
    async stop() {
        if (this.stopped)
            return;
        this.stopped = true;
        this.store.uninstall();
        await this.observer?.stop();
        delete this.identity.database.projectionShutdown;
    }
}
//# sourceMappingURL=service.js.map