/* Closed operation catalogs and authenticated, scope-bound rows. */
import { randomUUID, createHmac } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { grant } from '../obligations/authority.js';
import { recordLendingEvidence } from '../lending/integrity.js';
import { booksTable } from '../obligations/models.js';
import { verifyRow } from '../obligations/evidence.js';
import { ReportTokens } from '../reporting/token.js';
import { exchangeContract, dictionary, templateDownloads } from './contract.js';
import { columnName } from './workbook.js';
import { exchangeAuthority, businessReportAllowed, personalReports } from './authority.js';
import { ExchangeRepository } from './repository.js';
import { ExchangeJobs } from './jobs.js';
import { hash, binaryHash } from './canonical.js';
import { isolated } from './process.js';
import { validateReferences, applyCommands, finalizeUnit, registerReferences } from './domains.js';
import { validateHistorical, applyHistorical, openingLiabilityLinks, applyOpeningLiabilities } from './historical.js';
import { captureReport, cutFrom, reportTotals } from './reports.js';
import { POLICY, VERSION } from './models.js';
const fail = (code, status = 409) => { throw new AppError(status, code); };
const importTag = (r) => '"s11-import:' + r._id + ':' + r.version + '"';
const iso = (n) => new Date(n).toISOString();
const importDTO = (r) => ({ id: r._id, version: r.version, contentVersion: r.contentVersion, mode: r.mode, namespace: r.namespace, state: r.state, createdAt: r.createdAt, expiresAt: r.expiresAt, previewId: r.previewId, receiptId: r.receiptId, jobId: r.jobId });
const fileDTO = (r) => ({ id: r._id, state: r.state, mediaType: r.mediaType, bytes: r.bytes, sha256: r.sha256, createdAt: r.createdAt, expiresAt: r.expiresAt, filename: r.filename });
const jobDTO = (r) => ({ id: r._id, kind: r.kind, state: r.state, version: r.version, createdAt: r.createdAt, updatedAt: r.updatedAt, errorCode: r.errorCode, resourceId: r.resourceId });
const informationalDTO = (r) => ({ id: r['id'], date: r['date'], description: r['description'], referenceId: r['referenceId'] ?? null, supportReferences: r['supportReferences'] });
export class ExchangeService {
    identity;
    files;
    repo;
    jobs;
    tokens;
    maintenance = null;
    frames = new WeakMap();
    audits = new WeakMap();
    async reconcile() { if (!this.maintenance) {
        this.maintenance = import('./retention.js').then(m => m.reconcile(this)).finally(() => { this.maintenance = null; });
    } return await this.maintenance; }
    constructor(identity, files, key) {
        this.identity = identity;
        this.files = files;
        exchangeContract();
        this.repo = new ExchangeRepository(identity);
        this.jobs = new ExchangeJobs(this.repo);
        this.tokens = new ReportTokens(createHmac('sha256', key).update('CAUDELYX:S11:EXCHANGE:v1').digest());
    }
    get management() { return this.identity.obligations; }
    async transaction(work, timeoutCode = 'SERVICE_UNAVAILABLE') {
        const started = performance.now(), barrier = await this.management.enter(started);
        let last;
        const result = await this.identity.database.transaction(async (s) => {
            last = { started, legacy: null };
            this.frames.set(s, last);
            this.audits.set(s, []);
            this.repo.store.tracking.begin(s);
            try {
                const r = await work(s), changed = Boolean(this.repo.store.tracking.active.get(s)?.books.size);
                if (performance.now() - started > 10000)
                    fail(timeoutCode, 503);
                if (changed)
                    await this.repo.store.finish(s);
                const events = this.audits.get(s);
                if (changed && !events.length)
                    events.push({ realm: 'TENANT', actorId: 'SYSTEM_LOCAL_TRANSITION', subjectId: 'S11_EXCHANGE_TECHNICAL', action: 'EXCHANGE_TECHNICAL_STATE_COMMITTED', outcome: 'SUCCESS' });
                // Capture security evidence only after the final management head exists.
                for (const event of events)
                    await this.identity.audit.append(event, s);
                if (performance.now() - started > 10000)
                    fail(timeoutCode, 503);
                return r;
            }
            finally {
                this.frames.delete(s);
                this.audits.delete(s);
                this.repo.store.tracking.end(s);
            }
        });
        if (!this.identity.database.flushEvidence)
            fail('SERVICE_UNAVAILABLE', 503);
        await this.identity.database.flushEvidence();
        await this.management.leave(barrier, started);
        if (last?.legacy)
            await this.identity.reporting.projection.leave(last.legacy, started);
        return result;
    }
    async read(work) {
        const started = performance.now(), barrier = await this.management.enter(started);
        let frame;
        const result = await this.identity.database.client.withSession({ causalConsistency: true }, async (s) => { s.advanceOperationTime(barrier.time); return await s.withTransaction(async () => { frame = { started, legacy: null }; this.frames.set(s, frame); try {
            return await work(s);
        }
        finally {
            this.frames.delete(s);
        } }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' }); });
        await this.management.leave(barrier, started);
        if (frame?.legacy)
            await this.identity.reporting.projection.leave(frame.legacy, started);
        return result;
    }
    async authorize(context, params, s, options = {}) {
        const auth = await exchangeAuthority(this.identity, context, params, s, options), frame = this.frames.get(s);
        if (frame && (auth.scope.kind === 'BUSINESS' || auth.consolidated) && !frame.legacy) {
            const projection = this.identity.reporting?.projection;
            if (!projection)
                fail('SERVICE_UNAVAILABLE', 503);
            frame.legacy = await projection.enter(frame.started);
        }
        return auth;
    }
    async liveImport(auth, id, s) {
        const r = await this.repo.owned('s11_imports', id, auth.scope, auth.actor._id, s);
        if (r.state !== 'COMMITTED' && (r.binding !== auth.binding || r.contextId !== auth.context._id))
            fail('ACCESS_DENIED', 403);
        if (Date.parse(r.expiresAt) <= this.identity.now() && r.state !== 'COMMITTED')
            fail('IMPORT_PREVIEW_EXPIRED');
        return r;
    }
    precondition(r, expected) { if (!expected)
        fail('ETAG_REQUIRED', 428); if (expected !== importTag(r))
        fail('PRECONDITION_FAILED', 412); }
    async clearPreview(r, auth, s) { if (r.previewId) {
        const row = await this.repo.owned('s11_import_previews', r.previewId, auth.scope, auth.actor._id, s);
        if (row['current'] === true)
            await this.repo.put('s11_import_previews', { ...row, version: row.version + 1, current: false }, s);
    } }
    async snapshot(purpose, resourceId, actor, s, command) {
        const c = exchangeContract().command(purpose, command), op = exchangeContract().operations.get(String(c['operationId'])), ps = c['pathParameters'];
        if (actor.realm !== 'TENANT' || actor.roles.includes('SA'))
            fail('ACCESS_DENIED', 403);
        if (op.path.startsWith('/me/')) {
            if (ps['bookId']) {
                const b = await this.identity.database.db.collection(booksTable).findOne({ _id: String(ps['bookId']), subjectId: actor._id, domainKind: 'PERSONAL', status: 'ACTIVE' }, { session: s });
                if (!b || !verifyRow(this.identity.database, booksTable, b))
                    fail('RESOURCE_NOT_FOUND', 404);
                if (c['bookId'] !== ps['bookId'] || c['organizationId'] !== undefined)
                    fail('INPUT_INVALID', 422);
            }
            else if (c['bookId'] !== undefined || c['organizationId'] !== undefined)
                fail('INPUT_INVALID', 422);
        }
        else if (actor.organizationId !== ps['organizationId'] || c['organizationId'] !== ps['organizationId'] || !actor.roles.some(r => ['T', 'C', 'O', 'P'].includes(r)))
            fail('ACCESS_DENIED', 403);
        return hash({ purpose, resourceId, command: c, actor: actor._id, auth: actor.authEpoch, authz: actor.authzVersion, credential: actor.credentialVersion });
    }
    async createImport(context, operation, payload, params, key) {
        exchangeContract().validate(operation, payload);
        exchangeContract().validate('Id', key);
        const fp = hash({ operation, payload, params });
        return await this.transaction(async (s) => {
            let auth = await this.authorize(context, params, s, { importing: true });
            await grant(this.identity, context, 'WORK_ONLY', s);
            const old = await this.repo.findOwned('s11_import_commands', auth.scope, auth.actor._id, { operation, key }, s);
            if (old) {
                if (old['fingerprint'] !== fp)
                    fail('IDEMPOTENCY_CONFLICT');
                return { status: 200, data: old['result'], etag: String(old['etag']) };
            }
            await this.jobs.rate(auth, s);
            await this.management.ensureBook(auth.scope, s);
            auth = await this.authorize(context, params, s, { importing: true });
            const now = this.identity.now(), r = await this.repo.write('s11_imports', auth.scope, s, { actorId: auth.actor._id, contextId: auth.context._id, namespace: payload['namespace'], mode: payload['mode'], label: payload['label'], state: 'CREATED', contentVersion: 0, createdAt: iso(now), expiresAt: iso(now + 86400000), fileId: null, previewId: null, receiptId: null, jobId: null, binding: auth.binding }), data = importDTO(r), etag = importTag(r);
            await this.repo.write('s11_import_commands', auth.scope, s, { actorId: auth.actor._id, operation, key, fingerprint: fp, result: data, etag });
            await this.audit(auth, 'EXCHANGE_IMPORT_CREATED', s);
            return { status: 201, data, etag };
        });
    }
    async audit(auth, action, s) { const event = { realm: 'TENANT', actorId: auth.actor._id, subjectId: auth.actor._id, action, outcome: 'SUCCESS' }, pending = this.audits.get(s); if (pending)
        pending.push(event);
    else
        await this.identity.audit.append(event, s); }
    async running(context, params, id, kind, consolidated = false) { await this.read(async (s) => { const auth = await this.authorize(context, params, s, kind === 'IMPORT' ? { importing: true } : { reportKind: kind, consolidated }); await grant(this.identity, context, 'WORK_ONLY', s); const job = await this.repo.owned('s11_jobs', id, auth.scope, auth.actor._id, s); if (job.state !== 'RUNNING' || job.binding !== auth.binding || job.contextId !== auth.context._id || !job.lease || job.lease.expiresAt <= this.identity.now())
        fail('SOURCE_CONFLICT'); }); }
    // This guard runs before the HTTP layer consumes an upload body.
    async uploadAuthority(context, params, expected) {
        return await this.read(async (s) => { const auth = await this.authorize(context, params, s, { importing: true }); await grant(this.identity, context, 'WORK_ONLY', s); const r = await this.liveImport(auth, params['importId'], s); this.precondition(r, expected); if (['COMMITTED', 'CANCELLED', 'EXPIRED'].includes(r.state))
            fail('IMPORT_STATE_CONFLICT'); return { version: r.version, binding: auth.binding }; });
    }
    async beginUpload(context, params, key, expected) {
        exchangeContract().validate('Id', key);
        const retired = [];
        const ticket = await this.transaction(async (s) => {
            const auth = await this.authorize(context, params, s, { importing: true });
            await grant(this.identity, context, 'WORK_ONLY', s);
            const r = await this.liveImport(auth, params['importId'], s);
            await this.jobs.rate(auth, s);
            await this.jobs.expire(auth, s);
            const prior = await this.repo.findOwned('s11_import_commands', auth.scope, auth.actor._id, { operation: 'upload', key }, s);
            if (prior) {
                if (prior['resourceId'] !== r._id || prior['expected'] !== expected)
                    fail('IDEMPOTENCY_CONFLICT');
                if (prior['state'] !== 'DONE')
                    fail(prior['errorCode'] ? String(prior['errorCode']) : 'IMPORT_STATE_CONFLICT');
                return { auth, params, commandId: prior._id, fileId: String(prior['fileId']), jobId: String(prior['jobId']), nonce: String(prior['nonce']), replay: { status: 200, data: prior['result'], etag: String(prior['etag']) } };
            }
            this.precondition(r, expected);
            if (['COMMITTED', 'CANCELLED', 'EXPIRED', 'PREVIEWING'].includes(r.state))
                fail('IMPORT_STATE_CONFLICT');
            await this.clearPreview(r, auth, s);
            const job = await this.jobs.enqueue(auth, 'IMPORT_PARSE', r._id, s), fileId = randomUUID(), nonce = randomUUID();
            if (r.fileId) {
                const old = await this.repo.owned('s11_files', r.fileId, auth.scope, auth.actor._id, s);
                await this.repo.put('s11_files', { ...old, version: old.version + 1, state: 'DELETED' }, s);
                retired.push(old._id);
            }
            const next = await this.repo.put('s11_imports', { ...r, version: r.version + 1, contentVersion: r.contentVersion + 1, state: 'CREATED', fileId: null, previewId: null, jobId: job._id }, s);
            await this.repo.write('s11_files', auth.scope, s, { actorId: auth.actor._id, contextId: auth.context._id, state: 'STAGING', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: 0, sha256: null, createdAt: iso(this.identity.now()), expiresAt: r.expiresAt, filename: 'caudelyx-import-' + fileId + '.xlsx', resourceId: r._id, binding: auth.binding, nonce }, fileId);
            const command = await this.repo.write('s11_import_commands', auth.scope, s, { actorId: auth.actor._id, operation: 'upload', state: 'IN_PROGRESS', key, expected, resourceId: r._id, importVersion: next.version, fileId, jobId: job._id, nonce, fingerprint: null });
            return { auth, params, commandId: command._id, fileId, jobId: job._id, nonce, replay: null };
        });
        for (const id of retired)
            await this.files.remove(id);
        return ticket;
    }
    async upload(context, params, key, expected, bytes) { const ticket = await this.beginUpload(context, params, key, expected); return await this.finishUpload(context, ticket, bytes); }
    async finishUpload(context, ticket, bytes) {
        try {
            if (bytes.length > 5242880)
                fail('FILE_LIMIT_EXCEEDED', 413);
            if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50)
                fail('FILE_TYPE_REJECTED', 422);
            const physical = { bytes: bytes.length, sha256: binaryHash(bytes) };
            if (ticket.replay)
                return await this.read(async (s) => { const auth = await this.authorize(context, ticket.params, s, { importing: true }); await grant(this.identity, context, 'WORK_ONLY', s); const c = await this.repo.owned('s11_import_commands', ticket.commandId, auth.scope, auth.actor._id, s); if (c['fingerprint'] !== physical.sha256)
                    fail('IDEMPOTENCY_CONFLICT'); const r = await this.liveImport(auth, ticket.params['importId'], s); if (r.state !== 'COMMITTED') {
                    const file = await this.repo.owned('s11_files', ticket.fileId, auth.scope, auth.actor._id, s);
                    if (file.state !== 'VERIFIED')
                        fail('INTEGRITY_MISMATCH', 503);
                    await this.files.read(file._id, file);
                } return ticket.replay; });
            const prepared = await this.transaction(async (s) => { const auth = await this.authorize(context, ticket.params, s, { importing: true }); await grant(this.identity, context, 'WORK_ONLY', s); const r = await this.liveImport(auth, ticket.params['importId'], s), c = await this.repo.owned('s11_import_commands', ticket.commandId, auth.scope, auth.actor._id, s); if (r.version !== c['importVersion'] || c['nonce'] !== ticket.nonce || r.jobId !== ticket.jobId)
                fail('IMPORT_PREVIEW_STALE'); const job = await this.jobs.claim(auth, ticket.jobId, s); await this.repo.put('s11_import_commands', { ...c, version: c.version + 1, fingerprint: physical.sha256 }, s); return { auth, r, job }; });
            const parsed = await isolated({ kind: 'PARSE', bytes, scope: prepared.auth.scope, mode: prepared.r.mode, namespace: prepared.r.namespace }, () => this.running(context, ticket.params, ticket.jobId, 'IMPORT'));
            await this.files.publish(ticket.fileId, bytes);
            return await this.transaction(async (s) => {
                const auth = await this.authorize(context, ticket.params, s, { importing: true });
                await grant(this.identity, context, 'WORK_ONLY', s);
                const r = await this.liveImport(auth, ticket.params['importId'], s), command = await this.repo.owned('s11_import_commands', ticket.commandId, auth.scope, auth.actor._id, s), file = await this.repo.owned('s11_files', ticket.fileId, auth.scope, auth.actor._id, s);
                if (r.version !== command['importVersion'] || command['nonce'] !== ticket.nonce || file['nonce'] !== ticket.nonce || r.jobId !== ticket.jobId)
                    fail('IMPORT_PREVIEW_STALE');
                await this.files.read(file._id, physical);
                const cached = await this.repo.chunks('s11_preview_chunks', auth.scope, s, file._id, parsed.value);
                await this.repo.put('s11_files', { ...file, ...physical, version: file.version + 1, state: 'VERIFIED', parsed: cached, parseMetrics: parsed.metrics }, s);
                await this.jobs.complete(auth, ticket.jobId, prepared.job.lease.nonce, null, s);
                const next = await this.repo.put('s11_imports', { ...r, version: r.version + 1, state: 'UPLOADED', fileId: file._id }, s), data = importDTO(next), etag = importTag(next);
                await this.repo.put('s11_import_commands', { ...command, version: command.version + 1, state: 'DONE', result: data, etag }, s);
                await this.audit(auth, 'EXCHANGE_IMPORT_UPLOADED', s);
                return { status: 200, data, etag };
            });
        }
        catch (error) {
            if (!ticket.replay)
                await this.abortUpload(ticket, error);
            throw error;
        }
    }
    async abortUpload(ticket, error) {
        if (ticket.replay)
            return;
        const remove = await this.transaction(async (s) => { const auth = ticket.auth, c = await this.repo.owned('s11_import_commands', ticket.commandId, auth.scope, auth.actor._id, s); if (c['nonce'] !== ticket.nonce || c['state'] !== 'IN_PROGRESS')
            return false; const r = await this.repo.owned('s11_imports', String(c['resourceId']), auth.scope, auth.actor._id, s), file = await this.repo.owned('s11_files', ticket.fileId, auth.scope, auth.actor._id, s), code = error instanceof AppError && exchangeContract().document['x-error-codes'].includes(error.code) ? error.code : 'SERVICE_UNAVAILABLE'; await this.jobs.fail(auth, ticket.jobId, code, s); await this.repo.put('s11_import_commands', { ...c, version: c.version + 1, state: 'FAILED', errorCode: code }, s); if (file.state === 'STAGING')
            await this.repo.put('s11_files', { ...file, version: file.version + 1, state: 'CORRUPT' }, s); if (r.jobId === ticket.jobId && r.state !== 'COMMITTED' && r.state !== 'CANCELLED')
            await this.repo.put('s11_imports', { ...r, version: r.version + 1, state: 'INVALID', fileId: null, previewId: null }, s); return true; });
        if (remove)
            await this.files.remove(ticket.fileId);
    }
    async preparePreview(context, params, key, expected, input = {}) {
        exchangeContract().validate('Id', key);
        exchangeContract().validate('PreparePreview', input);
        const fp = hash({ params, expected, input });
        let discard = null;
        const prepared = await this.transaction(async (s) => {
            const auth = await this.authorize(context, params, s, { importing: true });
            await grant(this.identity, context, 'WORK_ONLY', s);
            let r = await this.liveImport(auth, params['importId'], s);
            await this.jobs.rate(auth, s);
            const prior = await this.repo.findOwned('s11_import_commands', auth.scope, auth.actor._id, { operation: 'preview', key }, s);
            if (prior) {
                if (prior['fingerprint'] !== fp)
                    fail('IDEMPOTENCY_CONFLICT');
                if (prior['state'] !== 'DONE')
                    fail(prior['errorCode'] ? String(prior['errorCode']) : 'IMPORT_STATE_CONFLICT');
                return { replay: { status: 200, data: prior['result'], etag: String(prior['etag']) } };
            }
            await this.jobs.expire(auth, s);
            if (r.state === 'PREVIEWING' && r.jobId) {
                const old = await this.repo.owned('s11_jobs', r.jobId, auth.scope, auth.actor._id, s);
                if (['EXPIRED', 'FAILED', 'CANCELLED'].includes(old.state))
                    r = await this.repo.put('s11_imports', { ...r, version: r.version + 1, state: 'UPLOADED', jobId: null, previewId: null }, s);
            }
            this.precondition(r, expected);
            if (!r.fileId || !['UPLOADED', 'READY', 'INVALID'].includes(r.state))
                fail('IMPORT_STATE_CONFLICT');
            const file = await this.repo.owned('s11_files', r.fileId, auth.scope, auth.actor._id, s);
            if (file.state !== 'VERIFIED' || file.binding !== auth.binding)
                fail('INTEGRITY_MISMATCH', 503);
            await this.files.read(file._id, file);
            const cached = file['parsed'];
            if (!cached)
                fail('INTEGRITY_MISMATCH', 503);
            const plan = await this.repo.unchunks('s11_preview_chunks', auth.scope, s, file._id, cached.ids, cached.sha256);
            await this.clearPreview(r, auth, s);
            const job = await this.jobs.enqueue(auth, 'IMPORT_PREVIEW', r._id, s), running = await this.jobs.claim(auth, job._id, s), command = await this.repo.write('s11_import_commands', auth.scope, s, { actorId: auth.actor._id, operation: 'preview', key, fingerprint: fp, state: 'IN_PROGRESS', resourceId: r._id });
            await this.repo.put('s11_imports', { ...r, version: r.version + 1, state: 'PREVIEWING', previewId: null, jobId: job._id }, s);
            return { replay: null, auth, plan, metrics: file['parseMetrics'], job: running, import: r, commandId: command._id };
        });
        if (prepared.replay)
            return prepared.replay;
        try {
            const plan = prepared.plan;
            if (plan.mode === 'HISTORICAL_LINK') {
                plan.historicalProfiles = [...(input['historicalProfiles'] ?? [])].sort((a, b) => a.externalKey.localeCompare(b.externalKey));
                plan.semanticHash = hash({ workbook: plan.semanticHash, historicalProfiles: plan.historicalProfiles ?? [] });
            }
            else if (Object.keys(input).length)
                fail('INPUT_INVALID', 422);
            const result = await this.transaction(async (s) => {
                discard = null;
                const auth = await this.authorize(context, params, s, { importing: true });
                await grant(this.identity, context, 'WORK_ONLY', s);
                const r = await this.liveImport(auth, params['importId'], s);
                if (r.state !== 'PREVIEWING' || r.contentVersion !== prepared.import.contentVersion || r.jobId !== prepared.job._id)
                    fail('IMPORT_PREVIEW_STALE');
                const file = await this.repo.owned('s11_files', r.fileId, auth.scope, auth.actor._id, s);
                await this.files.read(file._id, file);
                const existing = await this.repo.findOwned('s11_import_commands', auth.scope, auth.actor._id, { operation: 'receipt', semanticHash: plan.semanticHash }, s), current = existing ? null : await this.repo.findOwned('s11_import_previews', auth.scope, auth.actor._id, { current: true, binding: auth.binding, 'data.semanticHash': plan.semanticHash, 'data.canConfirm': true, 'data.expiresAt': { $gt: iso(this.identity.now()) }, source: await this.repo.sourceDigest(auth.scope, s) }, s), targetId = existing ? String(existing['result']['importId']) : current ? String(current['importId']) : null;
                if (targetId && targetId !== r._id) {
                    const target = await this.repo.owned('s11_imports', targetId, auth.scope, auth.actor._id, s);
                    if (target.state === 'COMMITTED' || target.state === 'READY' && target.previewId === current?._id) {
                        const completed = await this.jobs.complete(auth, prepared.job._id, prepared.job.lease.nonce, null, s), redirected = await this.repo.put('s11_jobs', { ...completed, version: completed.version + 1, resourceId: targetId }, s), next = await this.repo.put('s11_imports', { ...r, version: r.version + 1, state: 'CANCELLED', previewId: null, duplicateOf: targetId }, s);
                        await this.repo.put('s11_files', { ...file, version: file.version + 1, state: 'DELETED' }, s);
                        discard = file._id;
                        const command = await this.repo.owned('s11_import_commands', prepared.commandId, auth.scope, auth.actor._id, s), data = jobDTO(redirected), etag = importTag(next);
                        await this.repo.put('s11_import_commands', { ...command, version: command.version + 1, state: 'DONE', result: data, etag }, s);
                        return { status: 200, data, etag };
                    }
                }
                // A structurally invalid plan is diagnostic only; do not resolve its unrelated external IDs.
                if (!plan.issues.some(i => i.severity === 'ERROR'))
                    await validateReferences(this.identity, context, auth.scope, plan, s);
                if (plan.mode === 'HISTORICAL_LINK' && !plan.issues.some(i => i.severity === 'ERROR'))
                    await validateHistorical(this.identity, auth.scope, plan, s);
                if (plan.mode !== 'OPENING' && !plan.issues.some(i => i.severity === 'ERROR'))
                    await openingLiabilityLinks(this.identity, auth.scope, plan, s);
                if (plan.mode === 'OPENING' && plan.opening && !plan.issues.some(i => i.severity === 'ERROR')) {
                    const report = await this.identity.opening.inspectImportSnapshot(context, auth.scope.bookId, plan.opening, s), sheets = { components: 'Apertura', historicalInterest: 'Intereses', supports: 'Soportes', references: 'Prestamos', informationalHistory: 'Antecedentes' }, fields = { accountId: 'accountKey', equityComponentId: 'equityComponentKey', referenceId: 'openingReferenceKey', loanReferenceId: 'loanKey', supportIds: 'supportKeys' };
                    for (const issue of report.issues) {
                        const parts = issue.path.split('/'), sheet = sheets[parts[1]] ?? 'Control', row = /^[0-9]+$/.test(parts[2] ?? '') ? Number(parts[2]) + 2 : 2, field = fields[parts[3]] ?? parts[3] ?? 'externalKey', columns = dictionary().sheets.find(x => x.name === sheet).columns, col = Math.max(0, columns.findIndex(c => c.name === field));
                        plan.issues.push({ sheet, row, cell: columnName(col + 1) + row, code: issue.code === 'BOOK_NOT_ELIGIBLE' ? 'BOOK_NOT_ELIGIBLE' : issue.code.includes('INTEREST') ? 'INTEREST_MISMATCH' : issue.code === 'BALANCE_DIFFERENCE' ? 'BALANCE_DIFFERENCE' : 'REFERENCE_INVALID', severity: 'ERROR', expectedType: 'REFERENCE', relatedKeys: issue.relatedIds.flatMap(id => Object.entries(plan.aliases).filter(([, value]) => value === id).map(([key]) => key.split(':')[1])).slice(0, 100) });
                    }
                }
                const source = await this.repo.sourceDigest(auth.scope, s), previewId = randomUUID(), bookETag = await this.identity.wealth.bookTag(auth.scope, s), chunks = await this.repo.chunks('s11_preview_chunks', auth.scope, s, previewId, plan), counts = { errorCount: plan.issues.filter(i => i.severity === 'ERROR').length, warningCount: plan.issues.filter(i => i.severity === 'WARNING').length, deferredCount: plan.issues.filter(i => i.severity === 'DEFERRED').length };
                const data = { id: previewId, contentVersion: r.contentVersion, semanticHash: plan.semanticHash, physicalHash: file.sha256, expiresAt: iso(Math.min(this.identity.now() + 300000, Date.parse(r.expiresAt))), canConfirm: counts.errorCount === 0 && counts.deferredCount === 0, totalRows: plan.totalRows, ...(plan.informationals.length ? { informationalHistory: plan.informationals.map(informationalDTO) } : {}), ...counts, commandCount: plan.commands.length, totals: plan.totals, items: plan.issues.slice(0, 100), nextCursor: plan.issues.length > 100 ? previewId + ':100' : null, ...(plan.opening ? { openingSnapshot: plan.opening } : {}) };
                exchangeContract().validate('Preview', data);
                await this.repo.write('s11_import_previews', auth.scope, s, { actorId: auth.actor._id, importId: r._id, binding: auth.binding, contextId: auth.context._id, current: true, source, bookETag, chunks, data, workerMetrics: prepared.metrics }, previewId);
                const completed = await this.jobs.complete(auth, prepared.job._id, prepared.job.lease.nonce, null, s);
                const next = await this.repo.put('s11_imports', { ...r, version: r.version + 1, state: data.canConfirm ? 'READY' : 'INVALID', previewId }, s);
                await this.audit(auth, 'EXCHANGE_IMPORT_PREVIEWED', s);
                const command = await this.repo.owned('s11_import_commands', prepared.commandId, auth.scope, auth.actor._id, s), output = jobDTO(completed), etag = importTag(next);
                await this.repo.put('s11_import_commands', { ...command, version: command.version + 1, state: 'DONE', result: output, etag }, s);
                return { status: 202, data: output, etag };
            });
            if (discard)
                await this.files.remove(discard);
            return result;
        }
        catch (error) {
            await this.failPreview(context, params, prepared.job._id, prepared.job.lease.nonce, error, prepared.commandId);
            throw error;
        }
    }
    async failPreview(context, params, id, nonce, error, commandId) {
        await this.transaction(async (s) => { const auth = await this.authorize(context, params, s, { importing: true }), r = await this.liveImport(auth, params['importId'], s); if (r.jobId !== id || r.state !== 'PREVIEWING')
            return; const code = error instanceof AppError && exchangeContract().document['x-error-codes'].includes(error.code) ? error.code : 'SOURCE_CONFLICT'; await this.jobs.complete(auth, id, nonce, code, s); const command = await this.repo.owned('s11_import_commands', commandId, auth.scope, auth.actor._id, s); await this.repo.put('s11_import_commands', { ...command, version: command.version + 1, state: 'FAILED', errorCode: code }, s); await this.repo.put('s11_imports', { ...r, version: r.version + 1, state: 'INVALID', previewId: null }, s); });
    }
    async confirm(context, params, payload, key, expected) {
        exchangeContract().validate('ConfirmImport', payload);
        exchangeContract().validate('Id', key);
        const fp = hash({ payload, params });
        return await this.transaction(async (s) => {
            const auth = await this.authorize(context, params, s, { importing: true });
            await grant(this.identity, context, 'BALANCE_60M', s);
            const r = await this.liveImport(auth, params['importId'], s), old = await this.repo.findOwned('s11_import_commands', auth.scope, auth.actor._id, { operation: 'confirm', key }, s);
            if (old) {
                if (old['fingerprint'] !== fp)
                    fail('IDEMPOTENCY_CONFLICT');
                return { status: 200, data: old['result'] };
            }
            if (r.state === 'COMMITTED')
                fail('IMPORT_ALREADY_COMMITTED');
            this.precondition(r, expected);
            if (r.state !== 'READY' || r.previewId !== payload['previewId'])
                fail('IMPORT_STATE_CONFLICT');
            await this.jobs.rate(auth, s);
            const preview = await this.repo.owned('s11_import_previews', r.previewId, auth.scope, auth.actor._id, s), data = preview['data'];
            if (Date.parse(String(data['expiresAt'])) <= this.identity.now())
                fail('IMPORT_PREVIEW_EXPIRED');
            if (data['canConfirm'] !== true || data['semanticHash'] !== payload['semanticHash'] || preview['binding'] !== auth.binding || preview['source'] !== await this.repo.sourceDigest(auth.scope, s) || preview['bookETag'] !== payload['bookETag'] || payload['bookETag'] !== await this.identity.wealth.bookTag(auth.scope, s))
                fail('IMPORT_PREVIEW_STALE');
            const file = await this.repo.owned('s11_files', r.fileId, auth.scope, auth.actor._id, s);
            if (file.state !== 'VERIFIED')
                fail('INTEGRITY_MISMATCH', 503);
            await this.files.read(file._id, file);
            const chunks = preview['chunks'], plan = await this.repo.unchunks('s11_preview_chunks', auth.scope, s, r.previewId, chunks.ids, chunks.sha256);
            await validateReferences(this.identity, context, auth.scope, plan, s);
            if (plan.mode === 'OPENING')
                fail('IMPORT_STATE_CONFLICT');
            const duplicate = (await this.repo.all('s11_import_commands', auth.scope, s)).find(x => x['semanticHash'] === plan.semanticHash && x['operation'] === 'receipt');
            if (duplicate)
                fail('EXTERNAL_KEY_CONFLICT');
            const effects = plan.mode === 'OPERATIVE' || plan.mode === 'HISTORICAL_LINK' ? await applyCommands(this.identity, context, auth.scope, plan, s, this.repo) : { effectCount: 0, journalIds: [], known: iso(this.identity.now()) };
            if (plan.mode === 'HISTORICAL_LINK') {
                const historical = await applyHistorical(this.identity, auth.scope, plan, s, this.repo, effects.known);
                effects.effectCount += historical.effectCount;
            }
            effects.effectCount += await applyOpeningLiabilities(this.identity, context, auth.scope, plan, s);
            for (const item of plan.informationals)
                await this.repo.write('s11_informational_history', auth.scope, s, { ...item, namespace: plan.namespace, importId: r._id, unitKnownAt: effects.known }, String(item['id']));
            effects.effectCount += plan.informationals.length;
            await registerReferences(auth.scope, plan, s, this.repo);
            effects.known = await finalizeUnit(this.identity, auth.scope, plan, s);
            if (auth.scope.kind === 'BUSINESS')
                await recordLendingEvidence(this.identity.database, s);
            await this.clearPreview(r, auth, s);
            const receipt = { id: randomUUID(), importId: r._id, semanticHash: plan.semanticHash, committedAt: effects.known, state: 'COMMITTED', effectCount: effects.effectCount, journalIds: effects.journalIds, resolvedRefs: plan.externalRefs.map(x => ({ externalKey: x.key, entityType: x.type, id: x.id })), totals: plan.totals };
            exchangeContract().validate('Receipt', receipt);
            await this.repo.write('s11_import_commands', auth.scope, s, { actorId: auth.actor._id, operation: 'receipt', semanticHash: plan.semanticHash, result: receipt, recordedAt: effects.known }, receipt.id);
            await this.repo.write('s11_import_commands', auth.scope, s, { actorId: auth.actor._id, operation: 'confirm', key, fingerprint: fp, result: receipt, recordedAt: effects.known });
            await this.repo.put('s11_imports', { ...r, version: r.version + 1, state: 'COMMITTED', receiptId: receipt.id, recordedAt: effects.known }, s);
            await this.audit(auth, 'EXCHANGE_IMPORT_COMMITTED', s);
            return { status: 201, data: receipt };
        }, 'FILE_BUDGET_EXCEEDED');
    }
    async reportSource(auth, s) { const own = await this.repo.sourceDigest(auth.scope, s); if (!auth.consolidated)
        return own; const org = auth.business.organizationId; return hash({ personal: own, business: await this.repo.sourceDigest({ kind: 'BUSINESS', bookId: org, ownerId: org, organizationId: org }, s) }); }
    async knowledge(auth, s) {
        const book = await this.identity.database.db.collection(booksTable).findOne({ _id: auth.scope.bookId, bookId: auth.scope.bookId, ownerId: auth.scope.ownerId, domainKind: auth.scope.kind }, { session: s }), finance = auth.scope.kind === 'BUSINESS' ? await this.identity.database.db.collection('financial_books').findOne({ _id: auth.scope.bookId }, { session: s }) : null;
        if (book && !verifyRow(this.identity.database, booksTable, book))
            fail('INTEGRITY_MISMATCH', 503);
        const stamp = typeof finance?.recordedAt === 'number' ? finance.recordedAt : Date.parse(finance?.recordedAt ?? '');
        return Math.max(this.identity.now(), book ? Date.parse(book.recordedAt) : 0, Number.isFinite(stamp) ? stamp : 0);
    }
    reportMeta(auth, cut, filters, source, captured, issued, expires, token) {
        return { policyVersion: POLICY, schemaVersion: VERSION, currency: 'COP', timezone: 'America/Bogota', cut, scope: auth.consolidated ? 'CONSOLIDATED' : auth.scope.kind === 'PERSONAL' ? 'PERSONAL' : auth.business.isT ? 'BUSINESS' : auth.business.isC ? 'ASSIGNED_AND_OWN' : auth.business.isO ? 'OWN_ACTIVITY' : 'AUTHORIZED_PAYMENTS', capturedAt: iso(issued), expiresAt: iso(expires), snapshotToken: token, sourceVectorDigest: source, coverage: captured.coverage, denominatorScope: Object.keys(filters).length ? 'FILTERED_UNIVERSE' : 'AUTHORIZED_UNIVERSE' };
    }
    async report(context, params, query, consolidated = false) {
        const kind = params['reportKind'];
        exchangeContract().validate('ReportKind', kind);
        return await this.read(async (s) => {
            const auth = await this.authorize(context, params, s, { reportKind: kind, consolidated }), now = this.identity.now(), cut = cutFrom(query, now, await this.knowledge(auth, s)), filters = Object.fromEntries(Object.entries(query).filter(([k]) => !['asOf', 'from', 'to', 'recordedThrough'].includes(k))), source = await this.reportSource(auth, s), captured = await captureReport(this.identity, context, auth, kind, cut, filters, s), expires = now + 300000;
            // Stateless AEAD capture: GET does not persist rows, PII or a new evidence
            // head. Current vector + exact content digest must match on every reuse.
            const claims = { version: 1, kind, binding: auth.binding, scope: auth.scope, consolidated, cut, filters, issued: now, expires, source, contentsHash: hash(captured) }, token = this.tokens.seal(claims, 'snapshot'), meta = this.reportMeta(auth, cut, filters, source, captured, now, expires, token);
            if (token.length > 8192)
                fail('REPORT_SCOPE_TOO_LARGE', 422);
            return { status: 200, data: { reportKind: kind, meta, totalRows: captured.rows.length, totals: captured.totals } };
        });
    }
    async snapshotData(auth, token, kind, s) {
        const claims = this.tokens.open(token, 'snapshot');
        if (claims.version !== 1 || claims.kind !== kind || claims.binding !== auth.binding || hash(claims.scope) !== hash(auth.scope) || claims.consolidated !== auth.consolidated || !Number.isSafeInteger(claims.issued) || !Number.isSafeInteger(claims.expires) || claims.expires - claims.issued !== 300000)
            fail('REPORT_SNAPSHOT_STALE');
        if (claims.expires <= this.identity.now())
            fail('REPORT_SNAPSHOT_EXPIRED');
        if (claims.source !== await this.reportSource(auth, s))
            fail('REPORT_SNAPSHOT_STALE');
        const captured = await captureReport(this.identity, auth.context, auth, kind, claims.cut, claims.filters, s);
        if (hash(captured) !== claims.contentsHash)
            fail('REPORT_SNAPSHOT_STALE');
        return { reportKind: kind, meta: this.reportMeta(auth, claims.cut, claims.filters, claims.source, captured, claims.issued, claims.expires, token), rows: captured.rows, totalRows: captured.rows.length, totals: captured.totals, sourceDigest: claims.source, binding: auth.binding };
    }
    async reportPage(context, params, query, consolidated = false) {
        return await this.read(async (s) => { const kind = params['reportKind'], auth = await this.authorize(context, params, s, { reportKind: kind, consolidated }), token = String(query['snapshotToken']), snapshot = await this.snapshotData(auth, token, kind, s), limit = Number(query['limit'] ?? 20), binding = hash({ token, params, limit }), cursor = query['cursor'] === undefined ? null : this.tokens.open(query['cursor'], 'cursor'); if (!Number.isInteger(limit) || limit < 1 || limit > 100 || cursor && cursor.binding !== binding)
            fail('INPUT_INVALID', 422); const keys = snapshot.rows.map((r, i) => String(i).padStart(6, '0') + ':' + r.id), start = cursor ? keys.indexOf(cursor.last) + 1 : 0; if (cursor && start === 0)
            fail('INPUT_INVALID', 422); const items = snapshot.rows.slice(start, start + limit); return { status: 200, data: { reportKind: kind, meta: snapshot.meta, items, totalRows: snapshot.totalRows, totals: snapshot.totals, pageTotals: reportTotals(kind, items), nextCursor: start + items.length < snapshot.totalRows ? this.tokens.seal({ binding, last: keys[start + items.length - 1] }, 'cursor') : null } }; });
    }
    async policy(context, params, consolidated = false) { return await this.read(async (s) => { const auth = await this.authorize(context, params, s, { consolidated }), kinds = Object.keys(exchangeContract().document['x-report-columns']).filter(k => consolidated ? k === 'CONSOLIDATED_SUMMARY' : auth.scope.kind === 'PERSONAL' ? personalReports.includes(k) : businessReportAllowed(auth.business, k)); return { status: 200, data: { schemaVersion: VERSION, policyVersion: POLICY, usage: 'LOCAL_SYNTHETIC', realUseAllowed: false, reportKinds: kinds, formats: ['CSV', 'XLSX', 'PDF'], importModes: consolidated ? [] : auth.scope.kind === 'PERSONAL' ? ['OPERATIVE', 'INFORMATIONAL'] : auth.business.isT ? ['OPENING', 'OPERATIVE', 'HISTORICAL_LINK', 'INFORMATIONAL'] : [], maxRows: 1000, maxUploadBytes: 5242880, previewTTLSeconds: 300, templates: consolidated ? [] : auth.scope.kind === 'PERSONAL' ? templateDownloads(true) : auth.business.isT ? templateDownloads() : [] } }; }); }
    async list(name, auth, s, query, binding, filter = {}) {
        const limit = Number(query['limit'] ?? 20), fp = hash({ binding, limit }), cursor = query['cursor'] === undefined ? null : this.tokens.open(query['cursor'], 'cursor');
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || cursor && cursor.binding !== fp)
            fail('INPUT_INVALID', 422);
        const page = await this.repo.page(name, auth.scope, auth.actor._id, s, limit, cursor?.last ?? null, filter);
        return { items: page.items, totalRows: page.totalRows, nextCursor: page.more ? this.tokens.seal({ binding: fp, last: page.items.at(-1)._id }, 'cursor') : null };
    }
    async readImport(context, params, operation, query = {}) {
        return await this.read(async (s) => {
            const auth = await this.authorize(context, params, s, { importing: true });
            if (operation.startsWith('list')) {
                const page = await this.list('s11_imports', auth, s, query, { operation, params, binding: auth.binding }, { $or: [{ binding: auth.binding }, { state: 'COMMITTED' }] });
                return { status: 200, data: { items: page.items.map(importDTO), totalRows: page.totalRows, nextCursor: page.nextCursor } };
            }
            const r = await this.liveImport(auth, params['importId'], s);
            if (operation.endsWith('Receipt')) {
                if (!r.receiptId)
                    fail('RESOURCE_NOT_FOUND', 404);
                const receipt = await this.repo.owned('s11_import_commands', r.receiptId, auth.scope, auth.actor._id, s), informationals = (await this.repo.all('s11_informational_history', auth.scope, s)).filter(i => i['importId'] === r._id);
                return { status: 200, data: { ...receipt['result'], ...(informationals.length ? { informationalHistory: informationals.map(informationalDTO) } : {}) } };
            }
            if (operation.endsWith('Preview')) {
                if (!r.previewId)
                    fail('IMPORT_STATE_CONFLICT');
                const preview = await this.repo.owned('s11_import_previews', r.previewId, auth.scope, auth.actor._id, s), data = preview['data'];
                if (Date.parse(String(data['expiresAt'])) <= this.identity.now())
                    fail('IMPORT_PREVIEW_EXPIRED');
                if (preview['binding'] !== auth.binding || r.mode !== 'OPENING' && preview['source'] !== await this.repo.sourceDigest(auth.scope, s))
                    fail('IMPORT_PREVIEW_STALE');
                const file = await this.repo.owned('s11_files', r.fileId, auth.scope, auth.actor._id, s);
                await this.files.read(file._id, file);
                const chunks = preview['chunks'], plan = await this.repo.unchunks('s11_preview_chunks', auth.scope, s, r.previewId, chunks.ids, chunks.sha256);
                const limit = Number(query['limit'] ?? 20), binding = hash({ id: r.previewId, limit, auth: auth.binding }), cursor = query['cursor'] === undefined ? null : this.tokens.open(query['cursor'], 'cursor');
                if (!Number.isInteger(limit) || limit < 1 || limit > 100 || cursor && (cursor.binding !== binding || !Number.isInteger(cursor.last) || cursor.last < 0 || cursor.last > plan.issues.length))
                    fail('INPUT_INVALID', 422);
                const start = cursor?.last ?? 0, items = plan.issues.slice(start, start + limit);
                return { status: 200, data: { ...data, items, nextCursor: start + items.length < plan.issues.length ? this.tokens.seal({ binding, last: start + items.length }, 'cursor') : null } };
            }
            if (r.fileId && !['COMMITTED', 'CANCELLED', 'EXPIRED'].includes(r.state)) {
                const f = await this.repo.owned('s11_files', r.fileId, auth.scope, auth.actor._id, s);
                if (f.state !== 'VERIFIED')
                    fail('INTEGRITY_MISMATCH', 503);
                await this.files.read(f._id, f);
            }
            return { status: 200, data: importDTO(r), etag: importTag(r) };
        });
    }
    async cancelImport(context, params, key, expected) {
        exchangeContract().validate('Id', key);
        const files = [];
        const result = await this.transaction(async (s) => {
            const auth = await this.authorize(context, params, s, { importing: true });
            await grant(this.identity, context, 'WORK_ONLY', s);
            const r = await this.liveImport(auth, params['importId'], s);
            if (r.state === 'CANCELLED')
                return { status: 200, data: importDTO(r), etag: importTag(r) };
            this.precondition(r, expected);
            await this.jobs.rate(auth, s);
            if (r.jobId)
                await this.jobs.cancel(auth, r.jobId, s);
            await this.clearPreview(r, auth, s);
            if (r.fileId) {
                const f = await this.repo.owned('s11_files', r.fileId, auth.scope, auth.actor._id, s);
                await this.repo.put('s11_files', { ...f, state: 'DELETED', version: f.version + 1 }, s);
                files.push(f._id);
            }
            const next = await this.repo.put('s11_imports', { ...r, state: r.state === 'COMMITTED' ? 'COMMITTED' : 'CANCELLED', version: r.version + 1 }, s);
            await this.audit(auth, 'EXCHANGE_IMPORT_CANCELLED', s);
            return { status: 200, data: importDTO(next), etag: importTag(next) };
        });
        for (const id of files)
            await this.files.remove(id);
        return result;
    }
    async createExport(context, params, payload, key, consolidated = false) {
        exchangeContract().validate('CreateExport', payload);
        exchangeContract().validate('Id', key);
        const kind = String(payload['reportKind']), fp = hash({ payload, params, consolidated });
        const prepared = await this.transaction(async (s) => {
            const auth = await this.authorize(context, params, s, { reportKind: kind, consolidated });
            await grant(this.identity, context, 'WORK_ONLY', s);
            const prior = await this.repo.findOwned('s11_import_commands', auth.scope, auth.actor._id, { operation: 'export', key }, s);
            if (prior) {
                if (prior['fingerprint'] !== fp)
                    fail('IDEMPOTENCY_CONFLICT');
                return { prior: String(prior['resourceId']), auth };
            }
            await this.jobs.rate(auth, s);
            await this.jobs.expire(auth, s);
            const snapshot = await this.snapshotData(auth, String(payload['snapshotToken']), kind, s), id = randomUUID(), job = await this.jobs.enqueue(auth, 'EXPORT', id, s), running = await this.jobs.claim(auth, job._id, s), createdAt = iso(this.identity.now());
            await this.repo.write('s11_exports', auth.scope, s, { actorId: auth.actor._id, contextId: auth.context._id, binding: auth.binding, reportKind: kind, format: payload['format'], state: 'RUNNING', jobId: job._id, fileId: null, meta: snapshot.meta, totalRows: snapshot.totalRows, createdAt, expiresAt: iso(this.identity.now() + 3600000), snapshotToken: payload['snapshotToken'] }, id);
            await this.repo.write('s11_import_commands', auth.scope, s, { actorId: auth.actor._id, operation: 'export', key, fingerprint: fp, resourceId: id });
            await this.audit(auth, 'EXCHANGE_EXPORT_CREATED', s);
            return { prior: null, auth, snapshot, id, job: running };
        });
        if (prepared.prior)
            return await this.readExport(context, { ...params, exportId: prepared.prior }, 'getExport', {}, consolidated);
        const fileId = randomUUID();
        let published = false, committed = false;
        try {
            const generated = await isolated({ kind: 'EXPORT', format: String(payload['format']), snapshot: prepared.snapshot }, () => this.running(context, params, prepared.job._id, kind, consolidated)), bytes = Buffer.from(generated.value), extension = String(payload['format']).toLowerCase(), mediaType = extension === 'csv' ? 'text/csv; charset=utf-8' : extension === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
            await this.transaction(async (s) => { const auth = await this.authorize(context, params, s, { reportKind: kind, consolidated }); await grant(this.identity, context, 'WORK_ONLY', s); await this.snapshotData(auth, String(payload['snapshotToken']), kind, s); const row = await this.repo.owned('s11_exports', prepared.id, auth.scope, auth.actor._id, s); if (row['state'] !== 'RUNNING')
                fail('SOURCE_CONFLICT'); await this.repo.write('s11_files', auth.scope, s, { actorId: auth.actor._id, contextId: auth.context._id, state: 'STAGING', mediaType, bytes: bytes.length, sha256: null, createdAt: row['createdAt'], expiresAt: row['expiresAt'], filename: 'caudelyx-export-' + fileId + '.' + extension, resourceId: row._id, binding: auth.binding }, fileId); });
            const physical = await this.files.publish(fileId, bytes);
            published = true;
            await this.transaction(async (s) => { const auth = await this.authorize(context, params, s, { reportKind: kind, consolidated }); await grant(this.identity, context, 'WORK_ONLY', s); await this.snapshotData(auth, String(payload['snapshotToken']), kind, s); const row = await this.repo.owned('s11_exports', prepared.id, auth.scope, auth.actor._id, s), file = await this.repo.owned('s11_files', fileId, auth.scope, auth.actor._id, s); if (row['state'] !== 'RUNNING' || row['binding'] !== auth.binding)
                fail('SOURCE_CONFLICT'); await this.files.read(fileId, physical); await this.repo.put('s11_files', { ...file, ...physical, version: file.version + 1, state: 'READY' }, s); await this.jobs.complete(auth, prepared.job._id, prepared.job.lease.nonce, null, s); await this.repo.put('s11_exports', { ...row, version: row.version + 1, state: 'SUCCEEDED', fileId }, s); });
            committed = true;
            const result = await this.readExport(context, { ...params, exportId: prepared.id }, 'getExport', {}, consolidated);
            return { ...result, status: 202 };
        }
        catch (error) {
            if (committed)
                throw error;
            if (published)
                await this.files.remove(fileId);
            await this.transaction(async (s) => { const auth = await this.authorize(context, params, s, { reportKind: kind, consolidated }), row = await this.repo.owned('s11_exports', prepared.id, auth.scope, auth.actor._id, s); if (row['state'] === 'RUNNING') {
                await this.repo.put('s11_exports', { ...row, version: row.version + 1, state: 'FAILED' }, s);
                await this.jobs.complete(auth, prepared.job._id, prepared.job.lease.nonce, error instanceof AppError ? error.code : 'SERVICE_UNAVAILABLE', s);
            } });
            throw error;
        }
    }
    async exportDTO(auth, row, s, check = true) {
        if (row['binding'] !== auth.binding || row['contextId'] !== auth.context._id)
            fail('ACCESS_DENIED', 403);
        let file = null;
        if (row['state'] === 'SUCCEEDED' && check) {
            await this.snapshotData(auth, String(row['snapshotToken']), String(row['reportKind']), s);
            if (Date.parse(String(row['expiresAt'])) <= this.identity.now())
                fail('REPORT_SNAPSHOT_EXPIRED');
            file = await this.repo.owned('s11_files', String(row['fileId']), auth.scope, auth.actor._id, s);
            if (file.state !== 'READY')
                fail('INTEGRITY_MISMATCH', 503);
            await this.files.read(file._id, file);
        }
        return { id: row._id, version: row.version, reportKind: row['reportKind'], format: row['format'], state: row['state'], jobId: row['jobId'], file: file ? fileDTO(file) : null, meta: row['meta'], totalRows: row['totalRows'] };
    }
    async readExport(context, params, operation, query = {}, consolidated = false) {
        return await this.read(async (s) => {
            let auth = await this.authorize(context, params, s, { consolidated });
            if (operation.startsWith('list')) {
                const allowed = Object.keys(exchangeContract().document['x-report-columns']).filter(k => consolidated ? k === 'CONSOLIDATED_SUMMARY' : auth.scope.kind === 'PERSONAL' ? personalReports.includes(k) : businessReportAllowed(auth.business, k)), page = await this.list('s11_exports', auth, s, query, { operation, params, binding: auth.binding }, { binding: auth.binding, contextId: auth.context._id, reportKind: { $in: allowed } }), items = [];
                for (const row of page.items)
                    items.push(await this.exportDTO(auth, row, s, false));
                return { status: 200, data: { items, totalRows: page.totalRows, nextCursor: page.nextCursor } };
            }
            const row = await this.repo.owned('s11_exports', params['exportId'], auth.scope, auth.actor._id, s);
            auth = await this.authorize(context, params, s, { reportKind: String(row['reportKind']), consolidated });
            return { status: 200, data: await this.exportDTO(auth, row, s), etag: '"s11-export:' + row._id + ':' + row.version + '"' };
        });
    }
    async job(context, params, consolidated = false) { return await this.read(async (s) => { let auth = await this.authorize(context, params, s, { consolidated }); const row = await this.repo.owned('s11_jobs', params['jobId'], auth.scope, auth.actor._id, s); if (row.kind === 'EXPORT') {
        const resource = await this.repo.owned('s11_exports', row.resourceId, auth.scope, auth.actor._id, s);
        auth = await this.authorize(context, params, s, { reportKind: String(resource['reportKind']), consolidated });
    }
    else
        auth = await this.authorize(context, params, s, { importing: true }); if (row.binding !== auth.binding || row.contextId !== auth.context._id)
        fail('ACCESS_DENIED', 403); return { status: 200, data: jobDTO(row) }; }); }
    async cancelExport(context, params, key, expected, consolidated = false) {
        exchangeContract().validate('Id', key);
        let fileId = null;
        const result = await this.transaction(async (s) => {
            let auth = await this.authorize(context, params, s, { consolidated });
            await grant(this.identity, context, 'WORK_ONLY', s);
            const r = await this.repo.owned('s11_exports', params['exportId'], auth.scope, auth.actor._id, s);
            auth = await this.authorize(context, params, s, { reportKind: String(r['reportKind']), consolidated });
            if (r['state'] === 'CANCELLED')
                return { status: 200, data: await this.exportDTO(auth, r, s, false) };
            if (!expected)
                fail('ETAG_REQUIRED', 428);
            if (expected !== '"s11-export:' + r._id + ':' + r.version + '"')
                fail('PRECONDITION_FAILED', 412);
            await this.jobs.rate(auth, s);
            await this.jobs.cancel(auth, String(r['jobId']), s);
            if (r['fileId']) {
                const f = await this.repo.owned('s11_files', String(r['fileId']), auth.scope, auth.actor._id, s);
                await this.repo.put('s11_files', { ...f, version: f.version + 1, state: 'DELETED' }, s);
                fileId = f._id;
            }
            const next = await this.repo.put('s11_exports', { ...r, version: r.version + 1, state: 'CANCELLED' }, s);
            await this.audit(auth, 'EXCHANGE_EXPORT_CANCELLED', s);
            return { status: 200, data: await this.exportDTO(auth, next, s, false) };
        });
        if (fileId)
            await this.files.remove(fileId);
        return result;
    }
    async download(context, params, key, consolidated = false, expected) {
        exchangeContract().validate('Id', key);
        return await this.transaction(async (s) => {
            let auth = await this.authorize(context, params, s, { consolidated });
            await grant(this.identity, context, 'WORK_ONLY', s);
            const row = await this.repo.owned('s11_exports', params['exportId'], auth.scope, auth.actor._id, s);
            auth = await this.authorize(context, params, s, { reportKind: String(row['reportKind']), consolidated });
            await this.exportDTO(auth, row, s, false);
            if (!expected)
                fail('ETAG_REQUIRED', 428);
            if (expected !== '"s11-export:' + row._id + ':' + row.version + '"')
                fail('PRECONDITION_FAILED', 412);
            if (row['state'] !== 'SUCCEEDED' || !row['fileId'])
                fail('SOURCE_CONFLICT');
            await this.snapshotData(auth, String(row['snapshotToken']), String(row['reportKind']), s);
            await this.jobs.rate(auth, s);
            const file = await this.repo.owned('s11_files', String(row['fileId']), auth.scope, auth.actor._id, s);
            if (file.state !== 'READY' || Date.parse(file.expiresAt) <= this.identity.now() || file.binding !== auth.binding)
                fail('INTEGRITY_MISMATCH', 503);
            const bytes = await this.files.read(file._id, file), fp = hash({ exportId: row._id, fileId: file._id, sha256: file.sha256 }), old = await this.repo.findOwned('s11_import_commands', auth.scope, auth.actor._id, { operation: 'download', key }, s);
            if (old && old['fingerprint'] !== fp)
                fail('IDEMPOTENCY_CONFLICT');
            if (!old)
                await this.repo.write('s11_import_commands', auth.scope, s, { actorId: auth.actor._id, operation: 'download', key, fingerprint: fp, resourceId: row._id });
            await this.audit(auth, 'EXCHANGE_ACCESS_STARTED', s);
            return { bytes, file, reportKind: String(row['reportKind']), attempt: randomUUID() };
        });
    }
    async finishDownload(context, params, completed, consolidated = false) { await this.transaction(async (s) => { let auth = await this.authorize(context, params, s, { consolidated }); const row = await this.repo.owned('s11_exports', params['exportId'], auth.scope, auth.actor._id, s); auth = await this.authorize(context, params, s, { reportKind: String(row['reportKind']), consolidated }); await this.audit(auth, completed ? 'EXCHANGE_ACCESS_COMPLETED' : 'EXCHANGE_ACCESS_INTERRUPTED', s); }); }
    async commitOpeningBridge(context, organizationId, input, opening, s) {
        exchangeContract().validate('OpeningCommitBridge', input);
        if (!s.inTransaction() || opening.status !== 'POSTED' || !opening.commit || !opening.validation)
            fail('IMPORT_STATE_CONFLICT');
        const auth = await this.authorize(context, { organizationId }, s, { importing: true }), r = await this.liveImport(auth, String(input['importId']), s);
        if (r.mode !== 'OPENING' || r.state !== 'READY' || r.previewId !== input['previewId'] || input['openingId'] !== opening._id || input['validationId'] !== opening.validation.id || input['openingFingerprint'] !== opening.validation.fingerprint)
            fail('IMPORT_PREVIEW_STALE');
        const preview = await this.repo.owned('s11_import_previews', r.previewId, auth.scope, auth.actor._id, s), data = preview['data'];
        if (data['semanticHash'] !== input['semanticHash'] || data['canConfirm'] !== true || preview['binding'] !== auth.binding)
            fail('IMPORT_PREVIEW_STALE');
        if (Date.parse(String(data['expiresAt'])) <= this.identity.now())
            fail('IMPORT_PREVIEW_EXPIRED');
        const chunks = preview['chunks'], plan = await this.repo.unchunks('s11_preview_chunks', auth.scope, s, r.previewId, chunks.ids, chunks.sha256);
        if (hash(plan.opening) !== hash(opening.snapshot))
            fail('IMPORT_PREVIEW_STALE');
        const file = await this.repo.owned('s11_files', r.fileId, auth.scope, auth.actor._id, s);
        if (file.state !== 'VERIFIED')
            fail('INTEGRITY_MISMATCH', 503);
        await this.files.read(file._id, file);
        await validateReferences(this.identity, context, auth.scope, plan, s);
        this.repo.store.tracking.begin(s);
        try {
            const receipt = { id: randomUUID(), importId: r._id, semanticHash: plan.semanticHash, committedAt: opening.commit.recordedAt, state: 'COMMITTED', effectCount: 1, journalIds: [opening.commit.journalId], resolvedRefs: plan.externalRefs.map(x => ({ externalKey: x.key, entityType: x.type, id: x.id })), totals: plan.totals };
            exchangeContract().validate('Receipt', receipt);
            await this.repo.write('s11_import_commands', auth.scope, s, { actorId: auth.actor._id, operation: 'receipt', semanticHash: plan.semanticHash, openingId: opening._id, result: receipt }, receipt.id);
            await this.repo.put('s11_imports', { ...r, version: r.version + 1, state: 'COMMITTED', receiptId: receipt.id }, s);
            await this.repo.store.touch(auth.scope, s, true, Date.parse(opening.commit.recordedAt));
            await this.repo.store.finish(s);
            await this.audit(auth, 'EXCHANGE_OPENING_COMMITTED', s);
        }
        finally {
            this.repo.store.tracking.end(s);
        }
    }
}
//# sourceMappingURL=service.js.map