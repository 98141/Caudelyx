import { createHash, randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { decimal } from '../finance/money.js';
import { etag, today } from '../finance/service.js';
import { recordFinancialEvidence } from '../finance/integrity.js';
import { loadReportingFinance } from '../finance/scoped-integrity.js';
import { AppError } from '../../shared/errors.js';
import { AuditWriter } from '../../shared/audit.js';
import { canonicalOpening, openingContract, purposes, isOpening } from './contract.js';
import { reconcile } from './reconcile.js';
const uuid = (value) => { if (typeof value !== 'string' || !(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)))
    throw new AppError(422, 'INPUT_INVALID'); return value.toLowerCase(); };
const hash = (value) => createHash('sha256').update(JSON.stringify(canonicalOpening(value))).digest('hex');
export class OpeningService {
    identity;
    cursorKey;
    files;
    validations;
    references;
    idempotency;
    audit;
    constructor(identity, cursorKey) {
        this.identity = identity;
        this.cursorKey = cursorKey;
        const db = identity.database.db;
        this.files = db.collection('opening_files');
        this.validations = db.collection('opening_validations');
        this.references = db.collection('opening_references');
        this.idempotency = db.collection('opening_idempotency');
        this.audit = new AuditWriter(identity.database);
    }
    async initialize() {
        await this.files.createIndex({ organizationId: 1, bookId: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true } });
        await this.references.createIndex({ organizationId: 1, bookId: 1, type: 1, externalReference: 1 }, { unique: true });
        await this.references.createIndex({ openingId: 1, referenceId: 1 }, { unique: true });
        await this.idempotency.createIndex({ organizationId: 1, actorId: 1, operation: 1, key: 1 }, { unique: true });
    }
    async actor(context, organizationId, session) {
        await this.identity.requireOpen(context.realm);
        if (context.realm !== 'TENANT')
            throw new AppError(403, 'ACCESS_DENIED');
        const current = await this.identity.sessions.requireOperational(context, session), actor = current.identity;
        if (actor.organizationId !== organizationId)
            throw new AppError(404, 'RESOURCE_NOT_FOUND');
        if (!actor.roles.includes('T') || actor.roles.includes('SA'))
            throw new AppError(403, 'ACCESS_DENIED');
        const org = await this.identity.database.db.collection('organizations').findOne({ _id: organizationId, status: 'ACTIVE' }, { session });
        if (!org)
            throw new AppError(403, 'ACCESS_DENIED');
        return { ...current, org };
    }
    async file(id, org, session) {
        const row = await this.files.findOne({ _id: id, organizationId: org, bookId: org, ownerId: org, financialScope: 'BUSINESS' }, { session });
        if (!row)
            throw new AppError(404, 'RESOURCE_NOT_FOUND');
        return row;
    }
    publicFile(row) { const { _id, active, ...rest } = row; void active; return { id: _id, ...rest }; }
    async snapshot(purpose, resourceId, actor, session, command) {
        if (!isOpening(purpose) || !command)
            throw new AppError(422, 'INPUT_INVALID');
        openingContract().intent(purpose, resourceId, command);
        const orgId = uuid(command['organizationId']);
        if (actor.realm !== 'TENANT' || actor.roles.includes('SA') || !actor.roles.includes('T'))
            throw new AppError(403, 'ACCESS_DENIED');
        if (actor.organizationId !== orgId)
            throw new AppError(404, 'RESOURCE_NOT_FOUND');
        const org = await this.identity.database.db.collection('organizations').findOne({ _id: orgId, status: 'ACTIVE' }, { session });
        if (!org || actor.suspended)
            throw new AppError(403, 'ACCESS_DENIED');
        if (resourceId)
            await this.file(resourceId, orgId, session);
        // Bind the requested ETag, not mutable state; the final CAS is enforced after replay lookup.
        return hash({ purpose, resourceId, command, actorId: actor._id, authzVersion: actor.authzVersion, organizationEpoch: org.authEpoch });
    }
    async eligible(org, session) {
        const book = await this.identity.database.db.collection('financial_books').findOne({ _id: org }, { session });
        if (book?.openingId)
            throw new AppError(409, 'OPENING_ALREADY_POSTED');
        if (await this.identity.database.db.collection('financial_journals').countDocuments({ organizationId: org, bookId: org }, { session }))
            throw new AppError(409, 'BOOK_NOT_ELIGIBLE');
    }
    async reconciliation(row, actor, org, session) {
        const db = this.identity.database.db;
        const accounts = await db.collection('financial_accounts').find({ organizationId: org._id, bookId: org._id, ownerId: org._id, financialScope: 'BUSINESS' }, { session }).sort({ _id: 1 }).toArray();
        const journals = await db.collection('financial_journals').find({ organizationId: org._id, bookId: org._id }, { session }).project({ _id: 1, version: 1, recordedAt: 1 }).sort({ _id: 1 }).toArray();
        const book = await db.collection('financial_books').findOne({ _id: org._id }, { session });
        const report = reconcile(row.snapshot, accounts, today(this.identity.now()), journals.length === 0 && !book?.openingId);
        // Session validity is rechecked transactionally; normal R/MFA cookie rotation
        // must not invalidate its own validation. No context token/hash enters this digest.
        const dependencyDigest = hash({ accounts, journals, openingId: book?.openingId ?? null, cutoff: row.snapshot.cutoffDate, references: row.snapshot.references, actorId: actor._id, authzVersion: actor.authzVersion, authEpoch: actor.authEpoch, credentialVersion: actor.credentialVersion, organizationEpoch: org.authEpoch, sessionValid: true });
        return { report, dependencyDigest, fingerprint: hash({ policyVersion: row.policyVersion, schemaVersion: row.schemaVersion, organizationId: org._id, bookId: org._id, ownerId: org._id, financialScope: 'BUSINESS', currency: 'COP', openingId: row._id, contentVersion: row.contentVersion, snapshot: row.snapshot, proposedLines: report.proposedLines, dependencyDigest }) };
    }
    async inspectImportSnapshot(context, organization, snapshot, session) {
        const { org } = await this.actor(context, organization, session), source = await loadReportingFinance(this.identity.database, org._id, null, session, () => { }), book = await this.identity.database.db.collection('financial_books').findOne({ _id: org._id }, { session });
        return reconcile(snapshot, source.accounts, today(this.identity.now()), source.journals.length === 0 && !book?.openingId);
    }
    async mutate(context, operation, organization, input, keyValue, idValue, expectedETag) {
        const contract = openingContract(), purpose = purposes.get(operation), organizationId = uuid(organization), key = uuid(keyValue), id = idValue ? uuid(idValue) : null;
        if (!purpose)
            throw new AppError(422, 'INPUT_INVALID');
        contract.validate(operation, input);
        if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 65536)
            throw new AppError(413, 'INPUT_TOO_LARGE');
        const payload = canonicalOpening(input);
        contract.validate(operation, payload);
        if (id && !expectedETag)
            throw new AppError(428, 'ETAG_REQUIRED');
        const command = { organizationId, idempotencyKey: key, payload, ...(id ? { expectedETag } : {}) };
        contract.intent(purpose, id, command);
        const fingerprint = hash({ operation, purpose, resourceId: id, command });
        const bridgeStarted = performance.now(), bridgeBarrier = payload['importBridge'] ? await this.identity.obligations?.enter(bridgeStarted) : undefined;
        if (payload['importBridge'] && (!bridgeBarrier || !this.identity.exchange))
            throw new AppError(503, 'SERVICE_UNAVAILABLE');
        try {
            const output = await this.identity.database.transaction(async (session) => {
                const { identity: actor, org } = await this.actor(context, organizationId, session), db = this.identity.database.db;
                await db.collection('financial_books').updateOne({ _id: organizationId }, { $inc: { value: 1 }, $setOnInsert: { recordedAt: 0 } }, { session, upsert: true });
                try {
                    await this.identity.sessions.consumeProof(context, purpose, id, session, command);
                }
                catch (e) {
                    if (e instanceof AppError && e.code === 'REAUTH_REQUIRED')
                        throw new AppError(403, 'R_REQUIRED');
                    throw e;
                }
                const previous = await this.idempotency.findOne({ organizationId, actorId: actor._id, operation, key }, { session });
                if (previous) {
                    if (previous.hash !== fingerprint)
                        throw new AppError(409, 'IDEMPOTENCY_CONFLICT');
                    await this.audit.append({ realm: 'TENANT', actorId: actor._id, subjectId: actor._id, action: 'OPENING_REPLAY', outcome: 'SUCCESS' }, session);
                    return { ...previous.result, status: 200 };
                }
                const at = new Date(this.identity.now()).toISOString();
                let row, result;
                if (operation === 'createOpening') {
                    await this.eligible(organizationId, session);
                    if (await this.files.findOne({ organizationId, active: true }, { session }))
                        throw new AppError(409, 'OPENING_STATE_CONFLICT');
                    const predecessor = payload['predecessorId'];
                    if (predecessor && (await this.file(predecessor, organizationId, session)).status !== 'CANCELLED')
                        throw new AppError(409, 'OPENING_STATE_CONFLICT');
                    const snapshot = payload['snapshot'];
                    if (snapshot.cutoffDate > today(this.identity.now()))
                        throw new AppError(422, 'INPUT_INVALID');
                    row = { _id: randomUUID(), active: true, organizationId, bookId: organizationId, ownerId: organizationId, financialScope: 'BUSINESS', currency: 'COP', policyVersion: 'S03-OPENING-0.1', schemaVersion: '0.1.0-candidate', version: 1, contentVersion: 1, status: 'DRAFT', snapshot, predecessorId: predecessor ?? null, createdAt: at, updatedAt: at, validation: null, approval: null, commit: null, cancellation: null };
                    await this.files.insertOne(row, { session });
                    result = { status: 201, data: this.publicFile(row), etag: etag(row) };
                }
                else {
                    row = await this.file(id, organizationId, session);
                    if (etag(row) !== expectedETag)
                        throw new AppError(412, 'PRECONDITION_FAILED');
                    if (row.status === 'POSTED' || row.status === 'CANCELLED')
                        throw new AppError(409, row.status === 'POSTED' ? 'OPENING_IMMUTABLE' : 'OPENING_STATE_CONFLICT');
                    row.version++;
                    row.updatedAt = at;
                    if (operation === 'replaceOpening') {
                        const snapshot = payload['snapshot'];
                        if (snapshot.cutoffDate > today(this.identity.now()))
                            throw new AppError(422, 'INPUT_INVALID');
                        row.snapshot = snapshot;
                        row.contentVersion++;
                        row.status = 'DRAFT';
                        row.validation = null;
                        row.approval = null;
                    }
                    else if (operation === 'cancelOpening') {
                        row.status = 'CANCELLED';
                        row.active = false;
                        row.validation = null;
                        row.approval = null;
                        row.cancellation = { actorId: actor._id, cancelledAt: at, reason: payload['reason'] };
                    }
                    else if (operation === 'validateOpening') {
                        if (!['DRAFT', 'VALIDATED'].includes(row.status))
                            throw new AppError(409, 'OPENING_STATE_CONFLICT');
                        const checked = await this.reconciliation(row, actor, org, session);
                        const validation = checked.report.issues.length ? null : { id: randomUUID(), validatedAt: at, contentVersion: row.contentVersion, policyVersion: row.policyVersion, ...checked };
                        row.validation = validation;
                        row.approval = null;
                        row.status = validation ? 'VALIDATED' : 'DRAFT';
                        result = { status: 200, data: { opening: this.publicFile(row), report: checked.report, validation }, etag: etag(row) };
                    }
                    else {
                        if (operation === 'approveOpening' && row.status !== 'VALIDATED' || operation === 'commitOpening' && row.status !== 'APPROVED')
                            throw new AppError(409, 'OPENING_STATE_CONFLICT');
                        if (!row.validation)
                            throw new AppError(409, 'OPENING_NOT_BALANCED');
                        if (payload['validationId'] !== row.validation.id || payload['validationFingerprint'] !== row.validation.fingerprint)
                            throw new AppError(409, 'OPENING_VALIDATION_STALE');
                        const checked = await this.reconciliation(row, actor, org, session);
                        if (checked.report.issues.length || checked.fingerprint !== row.validation.fingerprint)
                            throw new AppError(409, 'OPENING_VALIDATION_STALE');
                        if (operation === 'approveOpening') {
                            row.status = 'APPROVED';
                            row.approval = { actorId: actor._id, approvedAt: at, validationId: row.validation.id, validationFingerprint: row.validation.fingerprint };
                        }
                        else {
                            if (!row.approval || row.approval.actorId !== actor._id || row.approval.validationId !== row.validation.id || row.approval.validationFingerprint !== row.validation.fingerprint)
                                throw new AppError(409, 'OPENING_VALIDATION_STALE');
                            await this.eligible(organizationId, session);
                            const book = await db.collection('financial_books').findOne({ _id: organizationId }, { session }), stamp = Math.max(this.identity.now(), (book?.recordedAt ?? 0) + 1), recordedAt = new Date(stamp).toISOString();
                            const journal = { _id: randomUUID(), organizationId, bookId: organizationId, ownerId: organizationId, financialScope: 'BUSINESS', currency: 'COP', createdAt: recordedAt, status: 'POSTED', version: 1, effectiveDate: row.snapshot.cutoffDate, recordedAt, source: { type: 'OPENING', id: row._id }, reversalOfId: null, supportReference: `OPENING:${row._id}`, description: `Apertura manual al corte ${row.snapshot.cutoffDate}`, lines: checked.report.proposedLines.map(l => ({ accountId: l.accountId, debit: decimal(l.debit), credit: decimal(l.credit) })) };
                            await db.collection('financial_journals').insertOne(journal, { session });
                            for (const r of row.snapshot.references) {
                                const principal = row.snapshot.components.find(c => c.category === 'PRINCIPAL_RECEIVABLE' && c.referenceId === r.id)?.amount;
                                await this.references.insertOne({ _id: randomUUID(), organizationId, bookId: organizationId, openingId: row._id, referenceId: r.id, ...r, ...(principal ? { principalOutstanding: principal } : {}), source: 'OPENING', recordedAt }, { session });
                            }
                            await db.collection('financial_books').updateOne({ _id: organizationId }, { $set: { openingId: row._id, cutoffDate: row.snapshot.cutoffDate, recordedAt: stamp } }, { session });
                            row.status = 'POSTED';
                            row.active = false;
                            row.commit = { journalId: journal._id, recordedAt, ledgerLineMap: checked.report.proposedLines.map((l, lineIndex) => ({ lineIndex, accountId: l.accountId, componentIds: l.componentIds, interestIds: l.interestIds })) };
                        }
                    }
                    await this.files.replaceOne({ _id: row._id, version: row.version - 1 }, row, { session });
                    result ??= { status: operation === 'commitOpening' ? 201 : 200, data: this.publicFile(row), etag: etag(row) };
                    await this.validations.insertOne({ _id: randomUUID(), openingId: row._id, organizationId, bookId: organizationId, operation, actorId: actor._id, version: row.version, contentVersion: row.contentVersion, at, validation: row.validation, approval: row.approval, cancellation: row.cancellation, ...(operation === 'validateOpening' ? { report: result.data.report } : {}), ...(payload['changeReason'] ? { changeReason: payload['changeReason'] } : {}) }, { session });
                }
                await this.idempotency.insertOne({ _id: randomUUID(), organizationId, actorId: actor._id, operation, key, hash: fingerprint, result }, { session });
                await recordFinancialEvidence(this.identity.database, session);
                if (payload['importBridge'])
                    await this.identity.exchange.commitOpeningBridge(context, organizationId, payload['importBridge'], row, session);
                await this.audit.append({ realm: 'TENANT', actorId: actor._id, subjectId: actor._id, action: `OPENING_${operation}`, outcome: 'SUCCESS', opening: { id: row._id, version: row.version, validationId: row.validation?.id ?? null, fingerprint: row.validation?.fingerprint ?? null } }, session);
                return result;
            });
            if (bridgeBarrier) {
                await this.identity.database.flushEvidence?.();
                await this.identity.obligations.leave(bridgeBarrier, bridgeStarted);
            }
            return output;
        }
        catch (e) {
            if (e && typeof e === 'object' && 'code' in e && e.code === 11000)
                throw new AppError(409, 'SOURCE_CONFLICT');
            throw e;
        }
    }
    async read(context, operation, organization, idValue, query = {}) {
        const organizationId = uuid(organization);
        return await this.identity.database.transaction(async (session) => {
            const { identity: actor } = await this.actor(context, organizationId, session);
            if (operation === 'readOpening') {
                if (Object.keys(query).length)
                    throw new AppError(422, 'INPUT_INVALID');
                const row = await this.file(uuid(idValue), organizationId, session);
                return { status: 200, data: this.publicFile(row), etag: etag(row) };
            }
            if (operation !== 'listOpeningFiles' || Object.keys(query).some(k => !['limit', 'cursor'].includes(k)))
                throw new AppError(422, 'INPUT_INVALID');
            const raw = query['limit'] ?? '20';
            if (typeof raw !== 'string' || !/^([1-9][0-9]?|100)$/.test(raw))
                throw new AppError(422, 'INPUT_INVALID');
            const limit = Number(raw), binding = hash({ actor: actor._id, authz: actor.authzVersion, organizationId, operation, limit });
            let last;
            if (query['cursor'] !== undefined) {
                try {
                    if (typeof query['cursor'] !== 'string' || query['cursor'].length > 1024 || !/^[A-Za-z0-9_-]+$/.test(query['cursor']))
                        throw Error('cursor');
                    const b = Buffer.from(query['cursor'], 'base64url'), c = createDecipheriv('aes-256-gcm', this.cursorKey, b.subarray(0, 12));
                    c.setAuthTag(b.subarray(12, 28));
                    const value = JSON.parse(Buffer.concat([c.update(b.subarray(28)), c.final()]).toString());
                    if (value.binding !== binding)
                        throw Error('binding');
                    last = uuid(value.last);
                }
                catch {
                    throw new AppError(422, 'INPUT_INVALID');
                }
            }
            const rows = await this.files.find({ organizationId, bookId: organizationId, ...(last ? { _id: { $gt: last } } : {}) }, { session }).sort({ _id: 1 }).limit(limit + 1).toArray(), items = rows.slice(0, limit);
            let nextCursor = null;
            if (rows.length > limit) {
                const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', this.cursorKey, iv), bytes = Buffer.concat([c.update(JSON.stringify({ binding, last: items.at(-1)._id })), c.final()]);
                nextCursor = Buffer.concat([iv, c.getAuthTag(), bytes]).toString('base64url');
            }
            return { status: 200, data: { items: items.map(r => ({ id: r._id, status: r.status, version: r.version, cutoffDate: r.snapshot.cutoffDate, updatedAt: r.updatedAt })), nextCursor } };
        });
    }
}
//# sourceMappingURL=service.js.map