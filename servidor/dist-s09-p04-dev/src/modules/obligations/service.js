/* eslint-disable security/detect-object-injection -- Signed closed catalogs, validated contract IDs and parameter maps. */
import { randomUUID, createHash } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { cents } from '../finance/money.js';
import { managementContract, canonical } from './contract.js';
import { personalActor, resolveScope, grant } from './authority.js';
import { ManagementStore } from './store.js';
import { ManagementLedger } from './ledger.js';
import { ProjectionObserver } from './observer.js';
import { originals, collections, limits } from './catalog.js';
import { managementHead, managementEvidenceMatches, transportCodec, verifyRow } from './evidence.js';
import { expenseCommand } from './expenses.js';
import { liabilityCommand } from './liabilities.js';
import { relationshipCommand } from './relationships.js';
import { managementRead } from './queries.js';
import { today, validDate } from './calendar.js';
import { booksTable, assignments, privateAccounts, declarations, commands, table, etag } from './models.js';
function failure(status, code) { throw new AppError(status, code); }
export class ManagementService {
    identity;
    key;
    store;
    ledger;
    observer;
    prepared = false;
    constructor(identity, key) {
        this.identity = identity;
        this.key = key;
        managementContract();
        this.store = new ManagementStore(identity.database, key, identity.now);
        this.ledger = new ManagementLedger(identity, this.store);
    }
    get active() { return this.observer?.ready === true; }
    async requiresCertification() { return this.prepared || Boolean(this.observer) || Boolean(await managementHead(this.identity.database)) || Boolean(await this.identity.database.db.collection(booksTable).findOne({})); }
    async ownOperational(context, s) { const current = await this.identity.sessions.requirePersonalOperational(context, s); const resolved = await resolveScope(this.identity, context, 'PERSONAL', undefined, s); await this.store.get(assignments, resolved.book.assignmentId, resolved.scope, s); return current; }
    async prepareOwned(verifyOwnership) {
        const db = this.identity.database.db, hosts = this.identity.database.client.options.hosts;
        if (!/^caudelyx_(?:s08_p02|s09_p02)_[a-f0-9]{24}$/.test(db.databaseName) || hosts.length !== 1 || !['127.0.0.1', 'localhost'].includes(hosts[0]?.host ?? '') || hosts[0]?.port !== 27017 || !await verifyOwnership())
            failure(403, 'ACCESS_DENIED');
        const existing = new Map((await db.listCollections().toArray()).map(x => [x.name, x]));
        for (const name of [...originals, ...Object.values(collections)]) {
            const info = existing.get(name);
            if (!info)
                await db.createCollection(name, { changeStreamPreAndPostImages: { enabled: true } });
            else if (!('options' in info) || info.options?.['changeStreamPreAndPostImages']?.['enabled'] !== true) {
                if (await db.collection(name).countDocuments())
                    failure(503, 'INTEGRITY_MISMATCH');
                await db.command({ collMod: name, changeStreamPreAndPostImages: { enabled: true } });
            }
            if (originals.has(name) && name !== 's09_evidence')
                await db.collection(name).createIndex({ bookId: 1, _id: 1 });
        }
        await db.collection(booksTable).createIndex({ subjectId: 1, currency: 1 }, { unique: true, partialFilterExpression: { domainKind: 'PERSONAL' } });
        await db.collection(assignments).createIndex({ ownerId: 1 }, { unique: true, partialFilterExpression: { active: true } });
        await db.collection(privateAccounts).createIndex({ bookId: 1, code: 1 }, { unique: true });
        await db.collection('s09_personal_journals').createIndex({ bookId: 1, sourceKind: 1, sourceId: 1 }, { unique: true });
        await db.collection('s09_personal_journals').createIndex({ bookId: 1, reversalOfId: 1 }, { unique: true, partialFilterExpression: { reversalOfId: { $type: 'string' } } });
        await db.collection(commands).createIndex({ bookId: 1, actorId: 1, operation: 1, key: 1 }, { unique: true });
        for (const kind of ['BUSINESS', 'PERSONAL']) {
            await db.collection(table(kind, 'events')).createIndex({ bookId: 1, reversalOfId: 1 }, { unique: true, partialFilterExpression: { reversalOfId: { $type: 'string' } } });
            await db.collection(table(kind, 'expenses')).createIndex({ bookId: 1, seriesId: 1, nominalDate: 1 }, { unique: true, partialFilterExpression: { seriesId: { $type: 'string' } } });
        }
        await db.collection(collections.barriers).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
        this.prepared = true;
    }
    async activateOwned(verifyOwnership) {
        if (!this.prepared || !await verifyOwnership() || this.active)
            failure(403, 'ACCESS_DENIED');
        const heads = await this.identity.database.db.collection(collections.heads).find({}).toArray(), epochs = new Set(heads.map(h => h.restoreEpoch));
        if (epochs.size > 1)
            failure(503, 'INTEGRITY_MISMATCH');
        this.store.restoreEpoch = heads[0]?.restoreEpoch ?? randomUUID();
        this.observer = new ProjectionObserver(this.identity.database.db, transportCodec(this.identity.database), this.store.restoreEpoch);
        try {
            await this.observer.start(async () => { const head = await managementHead(this.identity.database); if (!await managementEvidenceMatches(this.identity.database, head ?? undefined))
                failure(503, 'INTEGRITY_MISMATCH'); await this.verifyManifestChains(heads); });
        }
        catch (e) {
            await this.stop();
            throw e;
        }
        const before = this.identity.database.projectionShutdown;
        this.identity.database.projectionShutdown = async () => { await this.stop(); await before?.(); };
    }
    async verifyManifestChains(heads) {
        const collection = this.identity.database.db.collection(collections.manifests), verified = new Map();
        let parts = 0;
        const load = async (id) => { let header = verified.get(id); if (header)
            return header; const row = await collection.findOne({ _id: id }); if (!row || row.kind !== 'HEADER')
            failure(503, 'INTEGRITY_MISMATCH'); header = row; const { mac, ...body } = header; if (header.transactionId !== id || header['databaseName'] !== this.identity.database.db.databaseName || !transportCodec(this.identity.database).verify('MANIFEST', body, mac))
            failure(503, 'INTEGRITY_MISMATCH'); const mutations = []; for (let i = 0; i < header.chunkHashes.length; i++) {
            const chunk = await collection.findOne({ _id: id + ':' + i });
            if (!chunk || chunk.kind !== 'CHUNK' || chunk.transactionId !== id || chunk.part !== i || hashBook(chunk) !== header.chunkHashes[i])
                failure(503, 'INTEGRITY_MISMATCH');
            mutations.push(...chunk.mutations);
        } if (mutations.length !== header.mutationCount || hashBook(mutations) !== header.mutationRoot)
            failure(503, 'INTEGRITY_MISMATCH'); verified.set(id, header); parts += 1 + header.chunkHashes.length; return header; };
        for (const head of heads) {
            let expected = head;
            const seen = new Set();
            while (true) {
                if (seen.has(expected.lastManifest))
                    failure(503, 'INTEGRITY_MISMATCH');
                seen.add(expected.lastManifest);
                const header = await load(expected.lastManifest), attested = header.heads.find(h => h.bookId === head.bookId);
                if (!attested || hashBook(attested) !== hashBook(expected))
                    failure(503, 'INTEGRITY_MISMATCH');
                if (expected.previousManifest === null) {
                    if (header.previousHeads[head.bookId] !== null)
                        failure(503, 'INTEGRITY_MISMATCH');
                    break;
                }
                const previous = await load(expected.previousManifest), row = previous.heads.find(h => h.bookId === head.bookId);
                if (!row || hashBook(row) !== header.previousHeads[head.bookId])
                    failure(503, 'INTEGRITY_MISMATCH');
                expected = row;
            }
        }
        if (await collection.countDocuments() !== parts)
            failure(503, 'INTEGRITY_MISMATCH');
    }
    async stop() { await this.observer?.stop(); this.observer = undefined; }
    async enter(started = performance.now()) { if (!this.observer?.ready)
        failure(503, 'SERVICE_UNAVAILABLE'); return await this.observer.barrierAfter(started, started + limits.requestMs); }
    async leave(barrier, started) { if (!this.observer)
        failure(503, 'SERVICE_UNAVAILABLE'); this.observer.assertCertified(barrier); const after = await this.observer.barrierAfter(performance.now(), started + limits.requestMs); this.observer.assertCertified(after); }
    async ensureBook(scope, s, subjectId = null, assignmentId = null) {
        let book = await this.identity.database.db.collection(booksTable).findOne({ _id: scope.bookId }, { session: s });
        if (!book)
            book = await this.store.put(booksTable, { _id: scope.bookId, bookId: scope.bookId, ownerId: scope.ownerId, domainKind: scope.kind, version: 1, currency: 'COP', status: 'ACTIVE', subjectId, assignmentId, monetaryRevision: 0 }, s);
        if (!verifyRow(this.identity.database, booksTable, book))
            failure(503, 'INTEGRITY_MISMATCH');
        return book;
    }
    async snapshot(purpose, resourceId, actor, s, command) {
        const c = managementContract().command(purpose, command), definition = managementContract().operations.get(String(c['operationId'])), personal = definition.path.startsWith('/me/');
        if (actor.realm !== 'TENANT' || actor.roles.includes('SA'))
            failure(403, 'ACCESS_DENIED');
        const scopeId = personal ? c['bookId'] : c['organizationId'];
        if (personal) {
            const b = await this.identity.database.db.collection(booksTable).findOne({ _id: String(scopeId), subjectId: actor._id, domainKind: 'PERSONAL', status: 'ACTIVE' }, { session: s });
            if (!b || !verifyRow(this.identity.database, booksTable, b))
                failure(404, 'RESOURCE_NOT_FOUND');
        }
        else if (!actor.roles.includes('T') || actor.organizationId !== scopeId)
            failure(403, 'ACCESS_DENIED');
        return createHash('sha256').update(JSON.stringify(canonical({ purpose, resourceId, command: c, actorId: actor._id, authzVersion: actor.authzVersion, authEpoch: actor.authEpoch }))).digest('hex');
    }
    context(context, scope, s, payload, params, eventIds, journalIds) {
        const fork = (next) => this.context(context, next, s, payload, params, eventIds, journalIds);
        return { identity: this.identity, store: this.store, ledger: this.ledger, scope, s, payload, params, eventIds, journalIds, fork,
            post: async (entityId, kind, date, amount, lines, allocations = [], components = {}, reversalOfId = null, existingJournal) => {
                if (!validDate(date) || date > today(this.identity.now()) || cents(amount) <= 0n)
                    failure(422, 'INPUT_INVALID');
                const id = existingJournal?.eventId ?? randomUUID(), journal = existingJournal ?? await this.ledger.post(scope, id, date, lines, String(payload['supportReference']), s);
                const book = await this.store.get(booksTable, scope.bookId, scope, s), unitTime = Math.max(this.identity.now(), Date.parse(journal.recordedAt), Date.parse(book.recordedAt) + 1), unitKnownAt = new Date(unitTime).toISOString();
                const event = await this.store.put(table(scope.kind, 'events'), { _id: id, bookId: scope.bookId, ownerId: scope.ownerId, domainKind: scope.kind, version: 1, entityId, kind, effectiveDate: date, unitKnownAt, recordedAt: unitKnownAt, amount, allocations, journalIds: [journal.id], reversalOfId, components }, s);
                if (scope.kind === 'BUSINESS' && existingJournal) {
                    await this.identity.database.db.collection('financial_books').updateOne({ _id: scope.bookId }, { $inc: { value: 1 } }, { session: s, upsert: true });
                }
                eventIds.push(id);
                journalIds.push(journal.id);
                await this.store.touch(scope, s, true, unitTime);
                return event;
            } };
    }
    async mutate(context, operation, input, params, key, expected) {
        const definition = managementContract().operations.get(operation);
        if (!definition || definition.method !== 'post')
            failure(422, 'INPUT_INVALID');
        managementContract().validate(operation, input);
        managementContract().validate('Id', key);
        const payload = canonical(input);
        managementContract().validate(operation, payload);
        const fp = hashCanonical({ operation, payload, params, key, expected: expected ?? null }), started = performance.now(), barrier = await this.enter(started);
        const business = definition.path.startsWith('/organizations/'), oldBarrier = business || operation.includes('Interbook') ? await this.identity.reporting?.projection?.enter(started) : undefined;
        if ((business || operation.includes('Interbook')) && !oldBarrier)
            failure(503, 'SERVICE_UNAVAILABLE');
        let result;
        try {
            result = await this.identity.database.transaction(async (s) => {
                this.store.tracking.begin(s);
                try {
                    const { actor } = await personalActor(this.identity, context, s);
                    await grant(this.identity, context, definition.definition['x-mej-category'], s);
                    let scope, book;
                    if (operation === 'createPersonalBook') {
                        book = await this.identity.database.db.collection(booksTable).findOne({ subjectId: actor._id, domainKind: 'PERSONAL' }, { session: s });
                        if (!book) {
                            if (!actor.organizationId)
                                failure(403, 'ACCESS_DENIED');
                            await this.identity.finance.actor(context, actor.organizationId, s);
                            const id = randomUUID(), assignment = randomUUID();
                            scope = { kind: 'PERSONAL', bookId: id, ownerId: actor._id };
                            book = await this.ensureBook(scope, s, actor._id, assignment);
                            await this.store.put(assignments, { _id: assignment, bookId: id, ownerId: actor._id, domainKind: 'PERSONAL', version: 1, subjectId: actor._id, active: true }, s);
                        }
                        scope = (await resolveScope(this.identity, context, 'PERSONAL', book._id, s)).scope;
                    }
                    else {
                        const resolved = await resolveScope(this.identity, context, business ? 'BUSINESS' : 'PERSONAL', business ? params['organizationId'] : params['bookId'], s);
                        scope = resolved.scope;
                        book = resolved.book;
                        if (!book)
                            book = await this.ensureBook(scope, s);
                    }
                    const oldHead = await this.store.head(scope.bookId, s);
                    if (oldHead && hashBook(book) !== oldHead.bookHash)
                        failure(503, 'INTEGRITY_MISMATCH');
                    const previous = await this.identity.database.db.collection(commands).findOne({ bookId: scope.bookId, actorId: actor._id, operation, key }, { session: s });
                    if (previous) {
                        if (!verifyRow(this.identity.database, commands, previous))
                            failure(503, 'INTEGRITY_MISMATCH');
                        if (previous['fingerprint'] !== fp)
                            failure(409, 'IDEMPOTENCY_CONFLICT');
                        return { ...previous['result'], status: 200 };
                    }
                    const rootId = params['expenseId'] ?? params['ruleId'] ?? params['liabilityId'] ?? params['relationshipId'];
                    if (rootId) {
                        const name = params['expenseId'] ? table(scope.kind, 'expenses') : params['ruleId'] ? table(scope.kind, 'expense_rules') : params['liabilityId'] ? table(scope.kind, 'liabilities') : 's09_relationships';
                        const row = await this.store.get(name, rootId, scope, s);
                        if (!expected)
                            failure(428, 'ETAG_REQUIRED');
                        if (expected !== etag(row))
                            failure(412, 'PRECONDITION_FAILED');
                    }
                    const eventIds = [], journalIds = [], c = this.context(context, scope, s, payload, params, eventIds, journalIds);
                    let row;
                    if (operation === 'createPersonalBook')
                        row = book;
                    else if (operation === 'createPersonalAccount') {
                        if (payload['kind'] !== 'GENERAL' && payload['accountClass'] !== 'ASSET')
                            failure(422, 'INPUT_INVALID');
                        row = await this.store.put(privateAccounts, { _id: randomUUID(), bookId: scope.bookId, ownerId: scope.ownerId, domainKind: scope.kind, version: 1, ...payload, status: 'ACTIVE' }, s);
                    }
                    else if (operation === 'declareOwnEligibility') {
                        const percent = cents(String(payload['percentage']));
                        if (percent <= 0n || percent > 10000n || payload['right'] === 'FULL_OWNERSHIP' && percent !== 10000n || !validDate(payload['validFrom']))
                            failure(422, 'INPUT_INVALID');
                        const all = await this.store.all(declarations, scope, s), version = 1 + Math.max(0, ...all.filter(r => r['subjectId'] === actor._id).map(r => r.version));
                        row = await this.store.put(declarations, { _id: randomUUID(), bookId: scope.bookId, ownerId: scope.ownerId, domainKind: scope.kind, version, ...payload, subjectId: actor._id, organizationId: scope.bookId }, s);
                    }
                    else if (operation === 'postInterbookRelationship' || operation === 'reverseInterbookRelationship')
                        row = await relationshipCommand(c, operation, context);
                    else {
                        const action = operation.replace(/^(business|personal)/, '');
                        const name = action.charAt(0).toLowerCase() + action.slice(1);
                        row = name.includes('Liability') || name === 'postCardPurchase' ? await liabilityCommand(c, name) : await expenseCommand(c, name);
                    }
                    await this.store.touch(scope, s);
                    if (row._id === scope.bookId)
                        row = await this.store.get(booksTable, row._id, scope, s);
                    const output = { status: 201, data: { id: row._id, version: row.version, status: String(row['status'] ?? row['planningStatus'] ?? 'CONFIRMED'), eventIds, journalIds }, etag: etag(row) };
                    await this.store.put(commands, { _id: randomUUID(), bookId: scope.bookId, ownerId: scope.ownerId, domainKind: scope.kind, version: 1, actorId: actor._id, operation, key, fingerprint: fp, result: output }, s);
                    await this.store.finish(s);
                    await this.identity.audit.append({ realm: 'TENANT', actorId: actor._id, subjectId: actor._id, action: 'FINANCIAL_MANAGEMENT_COMMAND', outcome: 'SUCCESS' }, s);
                    return output;
                }
                finally {
                    this.store.tracking.end(s);
                }
            });
        }
        catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 11000)
                throw new AppError(409, 'SOURCE_CONFLICT');
            throw error;
        }
        if (!this.identity.database.flushEvidence)
            failure(503, 'SERVICE_UNAVAILABLE');
        await this.identity.database.flushEvidence();
        await this.leave(barrier, started);
        if (oldBarrier)
            await this.identity.reporting.projection.leave(oldBarrier, started);
        return result;
    }
    async read(context, operation, params, query = {}) { return await managementRead(this, context, operation, params, query); }
    async businessSources(org, s) {
        const scope = { kind: 'BUSINESS', bookId: org, ownerId: org, organizationId: org }, book = await this.identity.database.db.collection(booksTable).findOne({ _id: org, domainKind: 'BUSINESS' }, { session: s });
        if (!book)
            return { events: [], revision: 0 };
        if (!this.active || !verifyRow(this.identity.database, booksTable, book))
            failure(503, 'SERVICE_UNAVAILABLE');
        return { events: await this.store.all(table('BUSINESS', 'events'), scope, s), revision: book.monetaryRevision };
    }
}
import { hash as hashBook } from './codec.js';
const hashCanonical = (v) => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
//# sourceMappingURL=service.js.map