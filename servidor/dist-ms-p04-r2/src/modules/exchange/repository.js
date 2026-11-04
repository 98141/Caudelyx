import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { booksTable } from '../obligations/models.js';
import { exchangeTables } from './models.js';
import { hash } from './canonical.js';
import { verifyRow } from '../obligations/evidence.js';
export class ExchangeRepository {
    identity;
    constructor(identity) {
        this.identity = identity;
    }
    get store() { const store = this.identity.obligations?.store; if (!store)
        throw new AppError(503, 'SERVICE_UNAVAILABLE'); return store; }
    get epoch() { return this.store.restoreEpoch; }
    async get(table, id, scope, s) { return await this.store.get(table, id, scope, s); }
    async all(table, scope, s) { return await this.store.all(table, scope, s); }
    async put(table, row, s) { return await this.store.put(table, row, s, false); }
    async write(table, scope, s, value, id = randomUUID()) { return await this.store.put(table, { _id: id, bookId: scope.bookId, ownerId: scope.ownerId, domainKind: scope.kind, version: 1, restoreEpoch: this.epoch, ...value }, s, false); }
    async owned(table, id, scope, actorId, s) { const row = await this.identity.database.db.collection(table).findOne({ _id: id, bookId: scope.bookId, ownerId: scope.ownerId, domainKind: scope.kind, actorId }, { session: s }); if (!row)
        throw new AppError(404, 'RESOURCE_NOT_FOUND'); if (!verifyRow(this.identity.database, table, row))
        throw new AppError(503, 'INTEGRITY_MISMATCH'); return row; }
    async ownedRows(table, scope, actorId, s) { const rows = await this.identity.database.db.collection(table).find({ bookId: scope.bookId, ownerId: scope.ownerId, domainKind: scope.kind, actorId }, { session: s, maxTimeMS: 10000 }).sort({ _id: 1 }).limit(10001).toArray(); if (rows.length > 10000)
        throw new AppError(422, 'REPORT_SCOPE_TOO_LARGE'); if (rows.some(r => !verifyRow(this.identity.database, table, r)))
        throw new AppError(503, 'INTEGRITY_MISMATCH'); return rows; }
    async findOwned(table, scope, actorId, filter, s) { const rows = await this.identity.database.db.collection(table).find({ ...filter, bookId: scope.bookId, ownerId: scope.ownerId, domainKind: scope.kind, actorId }, { session: s, maxTimeMS: 10000 }).limit(2).toArray(); if (rows.length > 1 || rows.some(r => !verifyRow(this.identity.database, table, r)))
        throw new AppError(503, 'INTEGRITY_MISMATCH'); return rows[0]; }
    async page(table, scope, actorId, s, limit, last = null, filter = {}) { const predicate = { ...filter, bookId: scope.bookId, ownerId: scope.ownerId, domainKind: scope.kind, actorId }, totalRows = await this.identity.database.db.collection(table).countDocuments(predicate, { session: s, maxTimeMS: 10000 }), rows = await this.identity.database.db.collection(table).find({ ...predicate, ...(last ? { _id: { $gt: last } } : {}) }, { session: s, maxTimeMS: 10000 }).sort({ _id: 1 }).limit(limit + 1).toArray(); if (rows.some(r => !verifyRow(this.identity.database, table, r)))
        throw new AppError(503, 'INTEGRITY_MISMATCH'); return { totalRows, items: rows.slice(0, limit), more: rows.length > limit }; }
    async chunks(table, scope, s, parentId, value) {
        const bytes = Buffer.from(JSON.stringify(value));
        if (bytes.length > 64 * 1024 * 1024)
            throw new AppError(413, 'FILE_LIMIT_EXCEEDED');
        const ids = [];
        // Base64 chunk is bounded below the existing authenticated mutation chunk budget.
        for (let p = 0; p < bytes.length; p += 32768) {
            const id = randomUUID();
            ids.push(id);
            await this.write(table, scope, s, { parentId, part: ids.length - 1, data: bytes.subarray(p, p + 32768).toString('base64') }, id);
        }
        return { ids, sha256: hash(value) };
    }
    async unchunks(table, scope, s, parentId, ids, expected) {
        if (ids.length > 2048 || new Set(ids).size !== ids.length)
            throw new AppError(503, 'INTEGRITY_MISMATCH');
        const chunks = [];
        for (const [i, id] of ids.entries()) {
            const row = await this.get(table, id, scope, s);
            if (row['parentId'] !== parentId || row['part'] !== i || typeof row['data'] !== 'string')
                throw new AppError(503, 'INTEGRITY_MISMATCH');
            chunks.push(Buffer.from(row['data'], 'base64'));
        }
        let value;
        try {
            value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        catch {
            throw new AppError(503, 'INTEGRITY_MISMATCH');
        }
        if (hash(value) !== expected)
            throw new AppError(503, 'INTEGRITY_MISMATCH');
        return value;
    }
    async sourceDigest(scope, s) {
        const book = await this.identity.database.db.collection(booksTable).findOne({ _id: scope.bookId, bookId: scope.bookId, ownerId: scope.ownerId, domainKind: scope.kind }, { session: s }), head = await this.store.head(scope.bookId, s);
        if (Boolean(book) !== Boolean(head) || book && !verifyRow(this.identity.database, booksTable, book))
            throw new AppError(503, 'INTEGRITY_MISMATCH');
        const roots = Object.fromEntries(Object.entries(head?.roots ?? {}).filter(([name]) => !exchangeTables.includes(name) || ['s11_historical_origins', 's11_historical_schedules', 's11_opening_component_claims', 's11_informational_history', 's11_external_refs'].includes(name)));
        const finance = scope.kind === 'BUSINESS' ? await this.identity.database.db.collection('financial_books').findOne({ _id: scope.bookId }, { session: s }) : null;
        const lending = scope.kind === 'BUSINESS' ? await this.identity.database.db.collection('lending_merkle_orgs').findOne({ _id: scope.bookId }, { session: s }) : null;
        // staging changes do not invalidate their own preview; monetaryRevision and source
        // roots do. Metadata aliases/claims participate when they become economic origins.
        return hash({ bookId: scope.bookId, monetaryRevision: book?.monetaryRevision ?? 0, roots, finance, lending, epoch: this.epoch });
    }
}
//# sourceMappingURL=repository.js.map