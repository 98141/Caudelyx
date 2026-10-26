import { randomUUID, randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { AuditWriter } from '../../shared/audit.js';
import { canonical, financeContract, isFinancial } from './contract.js';
import { balanced, decimal, money, storedCents, cents } from './money.js';
import { recordFinancialEvidence } from './integrity.js';
import { domainCollection } from '../lending/evidence-v2.js';
export const purposes = new Map([
    ['createAccount', 'FINANCE_ACCOUNT_CREATE'], ['renameAccount', 'FINANCE_ACCOUNT_UPDATE'],
    ['postJournal', 'FINANCE_JOURNAL_POST'], ['createTransfer', 'FINANCE_TRANSFER'], ['reverseJournal', 'FINANCE_JOURNAL_REVERSE'],
]);
export const etag = (row) => `"${row._id}:${row.version}"`;
const uuid = (value) => {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
        throw new AppError(422, 'INPUT_INVALID');
    return value.toLowerCase();
};
export const today = (now) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
export class FinanceService {
    identity;
    cursorKey;
    accounts;
    journals;
    idempotency;
    audit;
    constructor(identity, cursorKey) {
        this.identity = identity;
        this.cursorKey = cursorKey;
        this.accounts = identity.database.db.collection('financial_accounts');
        this.journals = identity.database.db.collection('financial_journals');
        this.idempotency = identity.database.db.collection('financial_idempotency');
        this.audit = new AuditWriter(identity.database);
    }
    async initialize() {
        await this.accounts.createIndex({ organizationId: 1, bookId: 1, code: 1 }, { unique: true });
        await this.journals.createIndex({ organizationId: 1, bookId: 1, 'source.type': 1, 'source.id': 1 }, { unique: true });
        await this.journals.createIndex({ organizationId: 1, bookId: 1, reversalOfId: 1 }, { unique: true, partialFilterExpression: { reversalOfId: { $type: 'string' } } });
        await this.journals.createIndex({ organizationId: 1, effectiveDate: 1, recordedAt: 1, _id: 1 });
        await this.idempotency.createIndex({ organizationId: 1, actorId: 1, operation: 1, key: 1 }, { unique: true });
    }
    async actor(context, organizationId, session) {
        await this.identity.requireOpen(context.realm);
        if (context.realm !== 'TENANT')
            throw new AppError(403, 'ACCESS_DENIED');
        const { identity } = await this.identity.sessions.requireOperational(context, session);
        if (identity.organizationId !== organizationId)
            throw new AppError(404, 'RESOURCE_NOT_FOUND');
        if (!identity.roles.includes('T') || identity.roles.includes('SA') || identity.suspended)
            throw new AppError(403, 'ACCESS_DENIED');
        if (!await this.identity.database.db.collection('organizations').findOne({ _id: organizationId, status: 'ACTIVE' }, { session }))
            throw new AppError(403, 'ACCESS_DENIED');
        return identity;
    }
    async snapshot(purpose, resourceId, actor, session, command) {
        if (!isFinancial(purpose) || !command)
            throw new AppError(422, 'INPUT_INVALID');
        const organizationId = uuid(command['organizationId']);
        if (actor.realm !== 'TENANT' || actor.roles.includes('SA'))
            throw new AppError(403, 'ACCESS_DENIED');
        if (actor.organizationId !== organizationId)
            throw new AppError(404, 'RESOURCE_NOT_FOUND');
        if (!actor.roles.includes('T') || actor.suspended)
            throw new AppError(403, 'ACCESS_DENIED');
        const org = await this.identity.database.db.collection('organizations').findOne({ _id: organizationId, status: 'ACTIVE' }, { session });
        if (!org)
            throw new AppError(403, 'ACCESS_DENIED');
        if (resourceId)
            await this.resource(purpose === 'FINANCE_ACCOUNT_UPDATE' ? 'account' : 'journal', resourceId, organizationId, session);
        return createHash('sha256').update(JSON.stringify(canonical({ purpose, resourceId, command, actorId: actor._id, authzVersion: actor.authzVersion, organizationEpoch: org.authEpoch }))).digest('hex');
    }
    ownership(organizationId, id) {
        return { _id: id, organizationId, bookId: organizationId, ownerId: organizationId, financialScope: 'BUSINESS', currency: 'COP', createdAt: new Date(this.identity.now()).toISOString() };
    }
    async resource(kind, id, organizationId, session) {
        const filter = { _id: id, organizationId, bookId: organizationId, ownerId: organizationId, financialScope: 'BUSINESS' };
        const row = kind === 'account' ? await this.accounts.findOne(filter, { session }) : await this.journals.findOne(filter, { session });
        if (!row)
            throw new AppError(404, 'RESOURCE_NOT_FOUND');
        return row;
    }
    account(row) { const copy = { ...row }; delete copy.initialBalancePurpose; const { _id, ...data } = copy; return { id: _id, ...data }; }
    journal(row) { const { _id, lines, ...data } = row; return { id: _id, ...data, lines: lines.map(l => ({ accountId: l.accountId, debit: money(storedCents(l.debit)), credit: money(storedCents(l.credit)) })) }; }
    expected(row, header) {
        if (!header)
            throw new AppError(428, 'ETAG_REQUIRED');
        if (etag(row) !== header)
            throw new AppError(412, 'PRECONDITION_FAILED');
    }
    async mutate(context, operation, organization, input, idempotencyKey, id, ifMatch) {
        const organizationId = uuid(organization), resourceId = id ? uuid(id) : null, purpose = purposes.get(operation);
        if (!purpose)
            throw new AppError(422, 'INPUT_INVALID');
        financeContract().validate(operation, input);
        const payload = canonical(input), key = uuid(idempotencyKey);
        // Normalize before binding, then validate again: whitespace cannot create an empty required name/support.
        financeContract().validate(operation, payload);
        if (['renameAccount', 'reverseJournal'].includes(operation) && !ifMatch)
            throw new AppError(428, 'ETAG_REQUIRED');
        const command = { organizationId, idempotencyKey: key, payload, ...(ifMatch ? { expectedETag: ifMatch } : {}) };
        const fingerprint = createHash('sha256').update(JSON.stringify(canonical({ operation, purpose, resourceId, command }))).digest('hex');
        try {
            return await this.identity.database.transaction(async (session) => {
                const actor = await this.actor(context, organizationId, session);
                await this.identity.database.db.collection('financial_books').updateOne({ _id: organizationId }, { $inc: { value: 1 }, $setOnInsert: { recordedAt: 0 } }, { session, upsert: true });
                try {
                    await this.identity.sessions.consumeProof(context, purpose, resourceId, session, command);
                }
                catch (error) {
                    if (error instanceof AppError && error.code === 'REAUTH_REQUIRED')
                        throw new AppError(403, 'R_REQUIRED');
                    throw error;
                }
                const previous = await this.idempotency.findOne({ organizationId, actorId: actor._id, operation, key }, { session });
                if (previous) {
                    if (previous.hash !== fingerprint)
                        throw new AppError(409, 'IDEMPOTENCY_CONFLICT');
                    await this.audit.append({ realm: 'TENANT', actorId: actor._id, subjectId: actor._id, action: 'FINANCE_REPLAY', outcome: 'SUCCESS' }, session);
                    return { ...previous.result, status: 200 };
                }
                let result;
                if (operation === 'createAccount') {
                    if (await this.accounts.findOne({ organizationId, code: payload['code'] }, { session }))
                        throw new AppError(409, 'INPUT_INVALID');
                    const book = await this.identity.database.db.collection('financial_books').findOne({ _id: organizationId }, { session });
                    const stamp = Math.max(this.identity.now(), (book?.recordedAt ?? 0) + 1);
                    await this.identity.database.db.collection('financial_books').updateOne({ _id: organizationId }, { $set: { recordedAt: stamp } }, { session });
                    const row = { ...this.ownership(organizationId, randomUUID()), ...payload, createdAt: new Date(stamp).toISOString(), status: 'ACTIVE', version: 1 };
                    await this.accounts.insertOne(row, { session });
                    result = { status: 201, data: this.account(row), etag: etag(row) };
                }
                else if (operation === 'renameAccount') {
                    const row = await this.resource('account', resourceId, organizationId, session);
                    this.expected(row, ifMatch);
                    if (row.name !== payload['name']) {
                        row.name = payload['name'];
                        row.version++;
                        await this.accounts.replaceOne({ _id: row._id }, row, { session });
                    }
                    result = { status: 200, data: this.account(row), etag: etag(row) };
                }
                else {
                    const row = await this.post(organizationId, operation, payload, resourceId, ifMatch, session);
                    result = { status: 201, data: this.journal(row), etag: etag(row) };
                }
                await this.idempotency.insertOne({ _id: randomUUID(), organizationId, actorId: actor._id, operation, key, hash: fingerprint, result }, { session });
                await recordFinancialEvidence(this.identity.database, session);
                await this.audit.append({ realm: 'TENANT', actorId: actor._id, subjectId: actor._id, action: `FINANCE_${operation}`, outcome: 'SUCCESS' }, session);
                return result;
            });
        }
        catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 11000)
                throw new AppError(409, 'SOURCE_CONFLICT');
            throw error;
        }
    }
    async post(organizationId, operation, payload, resourceId, ifMatch, session) {
        const effectiveDate = payload['effectiveDate'];
        if (effectiveDate > today(this.identity.now()))
            throw new AppError(422, 'INPUT_INVALID');
        const opened = await this.identity.database.db.collection('financial_books').findOne({ _id: organizationId }, { session });
        if (opened?.openingId && (!opened.cutoffDate || effectiveDate <= opened.cutoffDate))
            throw new AppError(409, 'OPENING_CUTOFF_CONFLICT');
        let lines, sourceType = 'MANUAL_JOURNAL';
        let reversalOfId = null, description = payload['description'];
        if (operation === 'postJournal')
            lines = payload.lines;
        else if (operation === 'createTransfer') {
            const transfer = payload;
            sourceType = 'TRANSFER';
            if (transfer.fromAccountId === transfer.toAccountId)
                throw new AppError(422, 'INPUT_INVALID');
            for (const id of [transfer.fromAccountId, transfer.toAccountId]) {
                const account = await this.resource('account', id, organizationId, session);
                if (!['CASH', 'BANK'].includes(account.kind))
                    throw new AppError(422, 'INPUT_INVALID');
            }
            lines = [{ accountId: transfer.toAccountId, debit: transfer.amount, credit: '0.00' }, { accountId: transfer.fromAccountId, debit: '0.00', credit: transfer.amount }];
        }
        else {
            const reversal = payload;
            const original = await this.resource('journal', resourceId, organizationId, session);
            this.expected(original, ifMatch);
            if (original.source.type === 'OPENING')
                throw new AppError(409, 'OPENING_IMMUTABLE');
            if (['LOAN_OPERATION', 'LOAN_COMPENSATION'].includes(original.source.type))
                throw new AppError(409, 'DOMAIN_REVERSAL_FORBIDDEN');
            if (original.reversalOfId || effectiveDate < original.effectiveDate)
                throw new AppError(422, 'INPUT_INVALID');
            if (await this.journals.findOne({ organizationId, reversalOfId: original._id }, { session }))
                throw new AppError(409, 'ALREADY_REVERSED');
            sourceType = 'REVERSAL';
            reversalOfId = original._id;
            description = reversal.reason;
            lines = original.lines.map(l => ({ accountId: l.accountId, debit: money(storedCents(l.credit)), credit: money(storedCents(l.debit)) }));
        }
        const source = { type: sourceType, id: payload['sourceId'] };
        const domain = await domainCollection(this.identity.database, 'loan_operation_books').findOne({ _id: organizationId, organizationId }, { session });
        const held = await domainCollection(this.identity.database, 'held_funds_profiles').findOne({ organizationId }, { session });
        if (held && lines.some(l => l.accountId === held.accountId))
            throw new AppError(409, 'DOMAIN_ACCOUNT_PROTECTED');
        if (domain && lines.some(l => Object.values(domain.profile).includes(l.accountId)))
            throw new AppError(409, 'DOMAIN_ACCOUNT_PROTECTED');
        return await this.writeJournal(organizationId, effectiveDate, lines, source, reversalOfId, description, payload['supportReference'], session);
    }
    async postOperation(organizationId, eventId, effectiveDate, lines, supportReference, session) {
        if (effectiveDate !== today(this.identity.now()))
            throw new AppError(422, 'INPUT_INVALID');
        await this.identity.database.db.collection('financial_books').updateOne({ _id: organizationId }, { $inc: { value: 1 }, $setOnInsert: { recordedAt: 0 } }, { session, upsert: true });
        if (await this.journals.findOne({ organizationId, effectiveDate: { $gt: effectiveDate } }, { session }))
            throw new AppError(409, 'LATER_JOURNAL_CONFLICT');
        return await this.writeJournal(organizationId, effectiveDate, lines, { type: 'LOAN_OPERATION', id: eventId }, null, 'Operación sintética de cartera S05', supportReference, session);
    }
    async writeJournal(organizationId, effectiveDate, lines, source, reversalOfId, description, supportReference, session) {
        if (lines.length < 2 || lines.length > 100 || new Set(lines.map(l => l.accountId)).size < 2)
            throw new AppError(422, 'INPUT_INVALID');
        balanced(lines);
        const opened = await this.identity.database.db.collection('financial_books').findOne({ _id: organizationId }, { session });
        if (opened?.openingId && (!opened.cutoffDate || effectiveDate <= opened.cutoffDate))
            throw new AppError(409, 'OPENING_CUTOFF_CONFLICT');
        if (await this.journals.findOne({ organizationId, 'source.type': source.type, 'source.id': source.id }, { session }))
            throw new AppError(409, 'SOURCE_CONFLICT');
        for (const line of lines) {
            const row = await this.resource('account', line.accountId, organizationId, session);
            if (row.currency !== 'COP')
                throw new AppError(422, 'CURRENCY_MISMATCH');
            if (row.status !== 'ACTIVE')
                throw new AppError(422, 'INPUT_INVALID');
        }
        const book = await this.identity.database.db.collection('financial_books').findOne({ _id: organizationId }, { session });
        const stamp = Math.max(this.identity.now(), (book?.recordedAt ?? 0) + 1);
        await this.identity.database.db.collection('financial_books').updateOne({ _id: organizationId }, { $set: { recordedAt: stamp } }, { session });
        const row = { ...this.ownership(organizationId, randomUUID()), status: 'POSTED', version: 1, effectiveDate, recordedAt: new Date(stamp).toISOString(),
            source, reversalOfId, description, supportReference,
            lines: lines.map(l => ({ accountId: l.accountId, debit: decimal(l.debit), credit: decimal(l.credit) })) };
        await this.journals.insertOne(row, { session });
        await this.assertBalances(organizationId, session);
        return row;
    }
    async assertBalances(organizationId, session) {
        const accounts = new Map((await this.accounts.find({ organizationId }, { session }).toArray()).map(a => [a._id, a]));
        const totals = new Map();
        const rows = await this.journals.find({ organizationId }, { session }).sort({ effectiveDate: 1, recordedAt: 1, _id: 1 }).toArray();
        // Economic cuts are dates, not intermediate line order within a date.
        const dates = new Map();
        for (const row of rows)
            dates.set(row.effectiveDate, [...(dates.get(row.effectiveDate) ?? []), row]);
        const held = await domainCollection(this.identity.database, 'held_funds_reservations').find({ organizationId }, { session }).toArray();
        const custody = await domainCollection(this.identity.database, 'cash_custody').find({ organizationId, state: 'CONFIRMED_HELD' }, { session }).toArray();
        // Owner-approved S06 temporary reserve: physical confirmed CASH is unavailable
        // until S7 defines delivery/outflow. Provisional cash never enters these sums.
        // A reversal replaces this reserve with HELD_FUNDS, never both for one payment.
        const reserves = [...held, ...custody.filter(c => !held.some(h => String(h['paymentId']) === c.paymentId)).map(c => ({ accountId: c.accountId, amount: c.amountHeld, effectiveDate: c.effectiveDate }))];
        for (const group of dates.values()) {
            for (const row of group)
                for (const line of row.lines) {
                    const total = totals.get(line.accountId) ?? { debit: 0n, credit: 0n };
                    total.debit += storedCents(line.debit);
                    total.credit += storedCents(line.credit);
                    money(total.debit);
                    money(total.credit);
                    money(total.debit - total.credit);
                    totals.set(line.accountId, total);
                }
            for (const [id, total] of totals)
                if (['CASH', 'BANK'].includes(accounts.get(id)?.kind ?? '') && total.debit < total.credit)
                    throw new AppError(409, 'ACCOUNT_OVERDRAFT');
            const cut = group[0].effectiveDate;
            for (const reserve of reserves) {
                const t = totals.get(reserve.accountId), required = reserves.filter(h => h.accountId === reserve.accountId && h.effectiveDate <= cut).reduce((n, h) => n + cents(h.amount), 0n);
                if ((t ? t.debit - t.credit : 0n) < required)
                    throw new AppError(409, 'ACCOUNT_OVERDRAFT');
            }
        }
        for (const reserve of reserves) {
            const t = totals.get(reserve.accountId);
            const required = reserves.filter(h => h.accountId === reserve.accountId).reduce((n, h) => n + cents(h.amount), 0n);
            if ((t ? (t.debit - t.credit) : 0n) < required)
                throw new AppError(409, 'ACCOUNT_OVERDRAFT');
        }
    }
    encode(cursor) {
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.cursorKey, iv);
        const data = Buffer.concat([cipher.update(JSON.stringify(cursor)), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
    }
    decode(raw) {
        try {
            if (raw.length > 1024 || !/^[a-zA-Z0-9_-]+$/.test(raw))
                throw Error('Invalid cursor');
            const b = Buffer.from(raw, 'base64url'), decipher = createDecipheriv('aes-256-gcm', this.cursorKey, b.subarray(0, 12));
            decipher.setAuthTag(b.subarray(12, 28));
            const cursor = JSON.parse(Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString());
            if (!Array.isArray(cursor.last) || !cursor.last.every(v => typeof v === 'string'))
                throw Error('Invalid cursor');
            return cursor;
        }
        catch {
            throw new AppError(422, 'INPUT_INVALID');
        }
    }
    async read(context, operation, organization, id, query = {}) {
        const organizationId = uuid(organization), resourceId = id ? uuid(id) : null;
        const allowed = operation === 'listAccounts' ? ['limit', 'cursor', 'q'] : operation === 'listJournals' ? ['limit', 'cursor', 'asOf', 'recordedThrough'] : operation === 'balances' ? ['asOf', 'recordedThrough'] : [];
        if (Object.entries(query).some(([k, v]) => !allowed.includes(k) || typeof v !== 'string'))
            throw new AppError(422, 'INPUT_INVALID');
        return await this.identity.database.transaction(async (session) => {
            const actor = await this.actor(context, organizationId, session);
            if (operation === 'readAccount') {
                const row = await this.resource('account', resourceId, organizationId, session);
                return { status: 200, data: this.account(row), etag: etag(row) };
            }
            if (operation === 'readJournal') {
                const row = await this.resource('journal', resourceId, organizationId, session);
                return { status: 200, data: this.journal(row), etag: etag(row) };
            }
            const incoming = typeof query['cursor'] === 'string' ? this.decode(query['cursor']) : undefined;
            const book = await this.identity.database.db.collection('financial_books').findOne({ _id: organizationId }, { session });
            const asOf = query['asOf'] ?? incoming?.asOf ?? today(this.identity.now());
            const recordedThrough = query['recordedThrough'] ?? incoming?.recordedThrough ?? new Date(Math.max(this.identity.now(), book?.recordedAt ?? 0)).toISOString();
            if (operation === 'balances' && !query['asOf'])
                throw new AppError(422, 'INPUT_INVALID');
            if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || !Number.isFinite(Date.parse(asOf)) || new Date(asOf).toISOString().slice(0, 10) !== asOf || !Number.isFinite(Date.parse(recordedThrough)))
                throw new AppError(422, 'INPUT_INVALID');
            const cut = new Date(recordedThrough).toISOString();
            const filter = { organizationId, bookId: organizationId, ownerId: organizationId, financialScope: 'BUSINESS', effectiveDate: { $lte: asOf }, recordedAt: { $lte: cut } };
            if (operation === 'balances') {
                const totals = new Map();
                for await (const row of this.journals.find(filter, { session }))
                    for (const line of row.lines) {
                        const t = totals.get(line.accountId) ?? { debit: 0n, credit: 0n };
                        t.debit += storedCents(line.debit);
                        t.credit += storedCents(line.credit);
                        totals.set(line.accountId, t);
                    }
                const accounts = await this.accounts.find({ organizationId, createdAt: { $lte: cut } }, { session }).sort({ code: 1, _id: 1 }).toArray();
                return { status: 200, data: { organizationId, bookId: organizationId, financialScope: 'BUSINESS', currency: 'COP', asOf, recordedThrough: cut, items: accounts.map(a => { const t = totals.get(a._id) ?? { debit: 0n, credit: 0n }; return { accountId: a._id, currency: 'COP', debitTotal: money(t.debit), creditTotal: money(t.credit), naturalBalance: money(['ASSET', 'EXPENSE'].includes(a.accountClass) ? t.debit - t.credit : t.credit - t.debit) }; }) } };
            }
            const rawLimit = query['limit'] ?? '20';
            if (typeof rawLimit !== 'string' || !/^([1-9][0-9]?|100)$/.test(rawLimit))
                throw new AppError(422, 'INPUT_INVALID');
            const limit = Number(rawLimit);
            const q = query['q'] ?? '';
            if (typeof q !== 'string' || Array.from(q).length > 100)
                throw new AppError(422, 'INPUT_INVALID');
            const search = q.trim().normalize('NFC').toLocaleLowerCase('es-CO');
            const binding = JSON.stringify({ q: search, actor: actor._id, authz: actor.authzVersion, organizationId, operation, limit, ...(operation === 'listJournals' ? { asOf, recordedThrough: cut } : {}) });
            if (incoming && incoming.binding !== binding)
                throw new AppError(422, 'INPUT_INVALID');
            if (operation === 'listAccounts') {
                const last = incoming?.last;
                const accountFilter = { organizationId, bookId: organizationId, ownerId: organizationId, financialScope: 'BUSINESS', ...(search ? { $expr: { $gte: [{ $indexOfCP: [{ $toLower: { $concat: ['$code', ' ', '$name'] } }, { $literal: search }] }, 0] } } : {}), ...(last ? { $or: [{ code: { $gt: last[0] ?? '' } }, { code: last[0] ?? '', _id: { $gt: last[1] ?? '' } }] } : {}) };
                const rows = await this.accounts.find(accountFilter, { session }).sort({ code: 1, _id: 1 }).limit(limit + 1).toArray(), items = rows.slice(0, limit), tail = items.at(-1);
                return { status: 200, data: { items: items.map(a => this.account(a)), nextCursor: rows.length > limit && tail ? this.encode({ binding, last: [tail.code, tail._id] }) : null } };
            }
            const last = incoming?.last;
            if (last)
                filter.$or = [{ effectiveDate: { $gt: last[0] ?? '', $lte: asOf } }, { effectiveDate: last[0] ?? '', recordedAt: { $gt: last[1] ?? '', $lte: cut } }, { effectiveDate: last[0] ?? '', recordedAt: last[1] ?? '', _id: { $gt: last[2] ?? '' } }];
            const rows = await this.journals.find(filter, { session }).sort({ effectiveDate: 1, recordedAt: 1, _id: 1 }).limit(limit + 1).toArray(), items = rows.slice(0, limit), tail = items.at(-1);
            return { status: 200, data: { items: items.map(j => this.journal(j)), nextCursor: rows.length > limit && tail ? this.encode({ binding, last: [tail.effectiveDate, tail.recordedAt, tail._id], asOf, recordedThrough: cut }) : null } };
        });
    }
}
//# sourceMappingURL=service.js.map