/* eslint-disable security/detect-object-injection -- Closed OpenAPI operations, signed private rows and explicitly selected DTO fields. */
import { randomUUID, createHmac } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { today } from '../obligations/calendar.js';
import { grant } from '../obligations/authority.js';
import { booksTable } from '../obligations/models.js';
import { verifyRow as nativeRow } from '../obligations/evidence.js';
import { ReportTokens } from '../reporting/token.js';
import { simulationContract, normalizeHypotheses } from './contract.js';
import { authority } from './authority.js';
import { Store } from './store.js';
import { retain } from './retention.js';
import { controls, codec, signedBody } from './evidence.js';
import { capture, factCandidates } from './sources.js';
import { hash } from './codec.js';
import { validateVersion } from './engine.js';
import { isolated } from './process.js';
import { baseDTO, scenarioDTO, versionDTO, runDTO, alertDTO, commandDTO, tag } from './dto.js';
import { factTypes, scenarioTypes, evaluateAlerts, scenarioCandidates, acknowledge, dedupeKey } from './alerts.js';
import { scenarioKinds, alternativeKinds, limits } from './models.js';
const fail = (code, status = 409) => { throw new AppError(status, code); };
const iso = (n) => new Date(n).toISOString();
export class SimulationService {
    identity;
    store;
    tokens;
    queue = [];
    pumping = false;
    stopped = false;
    constructor(identity, key) {
        this.identity = identity;
        simulationContract();
        this.store = new Store(identity);
        this.tokens = new ReportTokens(createHmac('sha256', key).update('S12:SIMULATION:TOKENS').digest());
    }
    async prepareOwned(owner) { await this.store.prepareOwned(owner); }
    async activateOwned(owner) { await this.store.activateOwned(owner); await this.reconcile(); const old = this.identity.database.projectionShutdown; this.identity.database.projectionShutdown = async () => { await this.stop(); await old?.(); }; }
    maintenance = null;
    maintenanceAfter = '';
    async reconcile() { if (!this.maintenance)
        this.maintenance = this.maintain().finally(() => { this.maintenance = null; }); return await this.maintenance; }
    async maintain() {
        if (!this.store.active)
            return;
        const started = performance.now(), d = this.identity.database, heads = await d.db.collection(controls.heads).find({ _id: { $ne: 'GLOBAL', $gt: this.maintenanceAfter } }).sort({ _id: 1 }).limit(16).toArray();
        if (!heads.length) {
            this.maintenanceAfter = '';
            return;
        }
        for (const h of heads) {
            if (!codec(d).verify('HEAD', signedBody(h), h.mac))
                fail('INTEGRITY_MISMATCH', 503);
            const a = { actorId: h.actorId, key: h._id, scope: { kind: h.scopeKind === 'BUSINESS' ? 'BUSINESS' : 'PERSONAL', bookId: h.bookId, ownerId: h.ownerId, ...(h.scopeKind === 'BUSINESS' ? { organizationId: h.bookId } : {}) }, consolidated: h.scopeKind === 'CONSOLIDATED', binding: 'SYSTEM_RETENTION', context: {} };
            await this.store.barrier();
            await d.client.withSession(async (s) => s.withTransaction(async () => {
                await d.transactionGuard?.();
                this.store.begin(s);
                try {
                    await retain(this.store, a, s);
                    await this.store.finish(a, s, true);
                }
                finally {
                    this.store.end(s);
                }
            }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' }));
            await d.flushEvidence?.();
            await this.store.barrier();
            this.maintenanceAfter = h._id;
            if (performance.now() - started >= 1000)
                break;
        }
    }
    async stop() { this.stopped = true; this.queue.splice(0); while (this.pumping)
        await new Promise(resolve => setTimeout(resolve, 10)); await this.store.stop(); }
    async snapshot(purpose, resourceId, actor, s, command) {
        const c = simulationContract().command(purpose, command), ps = c['pathParameters'], op = simulationContract().operations.get(String(c['operationId']));
        if (actor.realm !== 'TENANT' || actor.roles.includes('SA'))
            fail('ACCESS_DENIED', 403);
        // Snapshot resolvers receive the actor, not a session context. Validate actor
        // ownership here; execute re-resolves the real live W session and all sources.
        if (op.definition['x-scope'] !== 'BUSINESS') {
            const book = await this.identity.database.db.collection(booksTable).findOne({ _id: ps['bookId'], subjectId: actor._id, domainKind: 'PERSONAL', status: 'ACTIVE' }, { session: s });
            if (!book || !nativeRow(this.identity.database, booksTable, book))
                fail('RESOURCE_NOT_FOUND', 404);
        }
        if (op.definition['x-scope'] === 'BUSINESS' && (!actor.roles.includes('T') || actor.organizationId !== ps['organizationId'] || c['organizationId'] !== ps['organizationId']))
            fail('ACCESS_DENIED', 403);
        if (op.definition['x-scope'] !== 'BUSINESS' && c['bookId'] !== ps['bookId'])
            fail('INPUT_INVALID', 422);
        return hash({ purpose, resourceId, command: c, actorId: actor._id, auth: actor.authEpoch, authz: actor.authzVersion, credential: actor.credentialVersion });
    }
    async frame(context, params, consolidated, writing, work) {
        if (this.stopped)
            fail('SERVICE_UNAVAILABLE', 503);
        const started = performance.now(), m = this.identity.obligations, mb = await m.enter(started), legacy = params['organizationId'] !== undefined || consolidated ? await this.identity.reporting?.projection?.enter(started) : null;
        if ((params['organizationId'] !== undefined || consolidated) && !legacy)
            fail('SERVICE_UNAVAILABLE', 503);
        await this.store.barrier();
        const d = this.identity.database;
        let binding = '';
        const result = await d.client.withSession({ causalConsistency: true }, async (s) => {
            s.advanceOperationTime(mb.time);
            if (legacy)
                s.advanceOperationTime(legacy.time);
            return await s.withTransaction(async () => {
                await d.transactionGuard?.();
                const a = await authority(this.identity, context, params, s, consolidated);
                binding = a.binding;
                if (writing) {
                    await grant(this.identity, a.context, 'WORK_ONLY', s);
                    this.store.begin(s);
                }
                try {
                    if (writing)
                        await retain(this.store, a, s);
                    const result = await work(a, s);
                    if (writing)
                        await this.store.finish(a, s);
                    if (performance.now() - started > 10000)
                        fail('SIMULATION_BUDGET_EXCEEDED', 503);
                    return result;
                }
                finally {
                    if (writing)
                        this.store.end(s);
                }
            }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
        });
        if (writing) {
            if (!d.flushEvidence)
                fail('SERVICE_UNAVAILABLE', 503);
            await d.flushEvidence();
        }
        await this.store.barrier();
        await m.leave(mb, started);
        if (legacy)
            await this.identity.reporting.projection.leave(legacy, started);
        await d.client.withSession(async (s) => { const current = await authority(this.identity, context, params, s, consolidated); if (current.binding !== binding)
            fail('ACCESS_DENIED', 403); });
        return result;
    }
    check(r, expected) { if (!expected)
        fail('ETAG_REQUIRED', 428); if (expected !== tag(r))
        fail('PRECONDITION_FAILED', 412); }
    alive(r) { if (Date.parse(r.expiresAt) <= this.identity.now() || r['tombstone'] === true)
        fail('RESOURCE_EXPIRED', 410); }
    token(r, a, c) { return this.tokens.seal({ baseId: r._id, binding: a.binding, scopeKey: a.key, sourceDigest: c.base.sourceDigest, expires: Date.parse(String(r['freshUntil'])), asOf: c.base.asOf }, 'snapshot'); }
    async base(a, s, id, token, fresh = false) {
        const r = await this.store.get('s12_bases', id, a, s);
        this.alive(r);
        const c = await this.store.unchunks(a, id, r['chunks'], s);
        if (fresh) {
            const claims = this.tokens.open(token, 'snapshot');
            if (claims.baseId !== id || claims.binding !== a.binding || claims.scopeKey !== a.key || claims.sourceDigest !== c.base.sourceDigest || claims.expires <= this.identity.now() || claims.asOf !== today(this.identity.now()))
                fail('BASE_STALE');
            if ((await capture(this.identity, a, s, id)).base.sourceDigest !== c.base.sourceDigest)
                fail('BASE_STALE');
        }
        return { r, c };
    }
    async definition(a, s, r) { this.alive(r); return await this.store.unchunks(a, r._id, r['chunks'], s); }
    async version(a, s, scenarioId, number) { const list = await this.store.all('s12_scenario_versions', a, s), r = list.find(r => r['scenarioId'] === scenarioId && r['number'] === number); if (!r)
        fail('RESOURCE_NOT_FOUND', 404); return r; }
    async freshRun(a, s, r) { this.alive(r); if (r['state'] !== 'SUCCEEDED')
        fail('RUN_STATE_CONFLICT'); return await this.store.unchunks(a, r._id, r['resultChunks'], s); }
    async alerts(a, s, c, thresholds, run) {
        const candidates = run ? scenarioCandidates(run.result, run.id, c.base.asOf) : factCandidates(c, thresholds), old = await this.store.all('s12_alerts', a, s), key = hash(thresholds), types = run ? [...scenarioTypes] : [...factTypes];
        const previous = old.filter(r => r['thresholdKey'] === key && (run ? r['runId'] === run.id : r['class'] === 'FACT') && !r['tombstone']).map(r => r['payload']);
        for (const candidate of candidates.filter(c => c.condition === true)) {
            const prior = old.filter(r => r['tombstone'] === true && r['dedupeKey'] === dedupeKey(a.key, key, candidate)).sort((x, y) => Number(y['episode']) - Number(x['episode']))[0];
            if (prior)
                previous.push({ id: prior._id, type: candidate.type, class: candidate.class, severity: 'INFO', state: 'EXPIRED', freshness: 'STALE', episode: Number(prior['episode']), version: prior.version, conditionFingerprint: String(prior['recordDigest']), amount: { value: null, status: 'UNAVAILABLE', reasons: ['SOURCE_STALE'], knownPartial: null }, effectiveDate: candidate.effectiveDate, lastEvaluatedAt: prior.createdAt, expiresAt: iso(this.identity.now() - 1), ackAt: null, sourceRefs: [], runId: candidate.runId, dedupeKey: String(prior['dedupeKey']), entityKey: candidate.entityKey, thresholdKey: key, sourceDigest: c.base.sourceDigest });
        }
        const result = evaluateAlerts(candidates, previous, { actorScopeKey: a.key, thresholdKey: key, now: this.identity.now(), sourceDigest: c.base.sourceDigest, completelyEvaluated: c.factCoverage ? types : [] });
        if (result.updated.length > 1000 || old.filter(r => !r['tombstone']).length + result.created > 1000)
            fail('SIMULATION_SCOPE_TOO_LARGE', 413);
        for (const alert of result.updated)
            await this.store.put('s12_alerts', a, { payload: alert, thresholdKey: key, class: alert.class, runId: alert.runId, expiresAt: alert.expiresAt }, s, alert.id, limits.definitionMs);
        return await this.store.put('s12_alert_evaluations', a, { baseId: c.base.id, sourceDigest: c.base.sourceDigest, evaluatedTypes: types, coverage: c.factCoverage ? 'COMPLETE' : 'INCOMPLETE', created: result.created, updated: result.changed, resolved: result.resolved }, s);
    }
    async execute(context, operation, input, params, query = {}, key = '', expected) {
        const spec = simulationContract().operations.get(operation);
        if (!spec)
            fail('INPUT_INVALID', 422);
        const consolidated = spec.definition['x-scope'] === 'CONSOLIDATED', write = spec.method === 'post', action = operation.replace(/(?:Business|Personal|Consolidated)Simulation$/, '');
        if (write) {
            simulationContract().body(operation, input);
            input = normalizeHypotheses(input);
            simulationContract().validate('Id', key);
        }
        let ticket;
        const result = await this.frame(context, params, consolidated, write, async (a, s) => {
            const fp = hash({ policy: 'S12-SIMULATION-1.0', actor: a.actorId, scope: a.key, purpose: spec.definition['x-purpose'] ?? null, operation, input, params, expected: expected ?? null });
            if (write) {
                const commands = await this.store.all('s12_commands', a, s), old = commands.find(r => r._id === key || r['key'] === key);
                if (old) {
                    this.alive(old);
                    if (old['requestDigest'] !== fp)
                        fail('IDEMPOTENCY_CONFLICT');
                    return { ...old['result'], status: 200 };
                }
                const rate = await this.store.all('s12_limits', a, s), minute = Math.floor(this.identity.now() / 60000), lim = rate.find(r => r['minute'] === minute), n = Number(lim?.['count'] ?? 0);
                if (n >= limits.requestsPerMinute)
                    fail('RATE_LIMITED', 429);
                await this.store.put('s12_limits', a, { minute, count: n + 1 }, s, lim?._id);
            }
            const finish = async (result) => {
                if (write)
                    await this.store.put('s12_commands', a, { key, purpose: spec.definition['x-purpose'], state: 'COMPLETED', resourceId: typeof result.data['id'] === 'string' ? result.data['id'] : null, requestDigest: fp, result }, s, key);
                return result;
            };
            if (action === 'getPolicy')
                return { status: 200, data: { schemaVersion: '1.0.0', simulationPolicy: 'S12-SIMULATION-1.0', alertPolicy: 'S12-ALERTS-1.0', usage: 'LOCAL_SYNTHETIC', realUseAllowed: false, scenarioKinds, alternativeKinds, alertTypes: [...factTypes, ...scenarioTypes], horizonMaxDays: 366, freshnessSeconds: 300, defaultAlertThresholds: { dueWithinDays: 7, concentrationThreshold: '25.00' } } };
            if (action === 'captureBase') {
                if (input['asOf'] !== today(this.identity.now()))
                    fail('BASE_STALE');
                const c = await capture(this.identity, a, s);
                if (c.base.asOf !== input['asOf'])
                    fail('BASE_STALE');
                const id = c.base.id, chunks = await this.store.chunks(a, id, c, s), r = await this.store.put('s12_bases', a, { chunks, freshUntil: iso(this.identity.now() + limits.freshMs), binding: a.binding, sourceDigest: c.base.sourceDigest }, s, id);
                return await finish({ status: 201, data: baseDTO(r, c.base, this.token(r, a, c)), etag: tag(r) });
            }
            if (action === 'getBase') {
                const { r, c } = await this.base(a, s, params['baseId']);
                return { status: 200, data: baseDTO(r, c.base, this.token(r, a, c)), etag: tag(r) };
            }
            if (action === 'createScenario' || action === 'createVersion') {
                const b = await this.base(a, s, String(input['baseId']), input['baseToken'], true), definition = { ...input, baseToken: 'FROZEN_DEFINITION' };
                delete definition['name'];
                validateVersion(definition, b.c.base.asOf);
                let scenario;
                if (action === 'createScenario') {
                    if ((await this.store.all('s12_scenarios', a, s)).filter(r => r['status'] === 'ACTIVE' && Date.parse(r.expiresAt) > this.identity.now()).length >= 20)
                        fail('SIMULATION_SCOPE_TOO_LARGE', 413);
                    scenario = await this.store.put('s12_scenarios', a, { name: input['name'], status: 'ACTIVE', currentVersion: 1 }, s, undefined, limits.definitionMs);
                }
                else {
                    scenario = await this.store.get('s12_scenarios', params['scenarioId'], a, s);
                    this.alive(scenario);
                    this.check(scenario, expected);
                    if (scenario['status'] !== 'ACTIVE' || Number(scenario['currentVersion']) >= 32)
                        fail('RUN_STATE_CONFLICT');
                    scenario = await this.store.put('s12_scenarios', a, { ...scenario, currentVersion: Number(scenario['currentVersion']) + 1 }, s, scenario._id, limits.definitionMs);
                }
                const id = randomUUID(), chunks = await this.store.chunks(a, id, definition, s, limits.definitionMs), v = await this.store.put('s12_scenario_versions', a, { scenarioId: scenario._id, number: scenario['currentVersion'], baseId: input['baseId'], horizonDays: input['horizonDays'], digest: hash(definition), chunks }, s, id, limits.definitionMs);
                return await finish(action === 'createScenario' ? { status: 201, data: scenarioDTO(scenario), etag: tag(scenario) } : { status: 201, data: versionDTO({ ...v, ...definition }), etag: tag(v) });
            }
            if (action === 'getScenario' || action === 'archiveScenario') {
                let r = await this.store.get('s12_scenarios', params['scenarioId'], a, s);
                this.alive(r);
                if (action === 'archiveScenario') {
                    this.check(r, expected);
                    r = await this.store.put('s12_scenarios', a, { ...r, status: 'ARCHIVED' }, s, r._id, limits.definitionMs);
                }
                return await finish({ status: 200, data: scenarioDTO(r), etag: tag(r) });
            }
            if (action === 'getVersion') {
                const r = await this.version(a, s, params['scenarioId'], Number(params['versionNumber']));
                return { status: 200, data: versionDTO({ ...r, ...await this.definition(a, s, r) }), etag: tag(r) };
            }
            if (action === 'startRun') {
                const scenario = await this.store.get('s12_scenarios', String(input['scenarioId']), a, s);
                this.alive(scenario);
                if (scenario['status'] !== 'ACTIVE')
                    fail('RUN_STATE_CONFLICT');
                const v = await this.version(a, s, scenario._id, Number(input['scenarioVersion'])), definition = await this.definition(a, s, v), b = await this.base(a, s, definition.baseId, input['baseToken'], true);
                const runs = await this.store.all('s12_runs', a, s);
                if (runs.some(r => ['QUEUED', 'RUNNING'].includes(String(r['state']))))
                    fail('RUN_STATE_CONFLICT');
                if (await this.identity.database.db.collection('s12_runs').countDocuments({ state: 'QUEUED', freshUntil: { $gt: iso(this.identity.now()) } }) >= limits.queue)
                    fail('RATE_LIMITED', 429);
                const r = await this.store.put('s12_runs', a, { scenarioId: scenario._id, scenarioVersion: input['scenarioVersion'], versionId: v._id, baseId: definition.baseId, freshUntil: b.r['freshUntil'], state: 'QUEUED', sourceDigest: b.c.base.sourceDigest, errorCode: null, retryable: false, mode: input['mode'], sensitivity: input['sensitivity'], evaluateAlerts: input['evaluateAlerts'], binding: a.binding, leaseUntil: null }, s);
                ticket = { context, params: { ...params }, consolidated, runId: r._id };
                return await finish({ status: 202, data: runDTO(r), etag: tag(r) });
            }
            if (['getRun', 'resumeRun', 'cancelRun', 'getResults'].includes(action)) {
                let r = await this.store.get('s12_runs', params['runId'], a, s);
                this.alive(r);
                if (action === 'cancelRun') {
                    this.check(r, expected);
                    if (!['QUEUED', 'RUNNING', 'CANCELLED'].includes(String(r['state'])))
                        fail('RUN_STATE_CONFLICT');
                    r = await this.store.put('s12_runs', a, { ...r, state: 'CANCELLED', errorCode: null, retryable: false, leaseUntil: null }, s, r._id);
                    return await finish({ status: 200, data: runDTO(r), etag: tag(r) });
                }
                if (action === 'resumeRun') {
                    this.check(r, expected);
                    if (r['state'] !== 'QUEUED' && !(r['state'] === 'FAILED' && r['retryable'] === true))
                        fail('RUN_STATE_CONFLICT');
                    await this.base(a, s, String(r['baseId']), input['baseToken'], true);
                    r = await this.store.put('s12_runs', a, { ...r, state: 'QUEUED', binding: a.binding, errorCode: null, retryable: false, leaseUntil: null }, s, r._id);
                    ticket = { context, params: { ...params }, consolidated, runId: r._id };
                    return await finish({ status: 202, data: runDTO(r), etag: tag(r) });
                }
                if (action === 'getResults') {
                    const result = await this.freshRun(a, s, r), b = await this.base(a, s, String(r['baseId'])), current = (await capture(this.identity, a, s, b.r._id)).base.sourceDigest, stale = current !== r['sourceDigest'] || b.c.base.asOf !== today(this.identity.now());
                    const page = this.page(a, r._id, result.days, query), items = page.items.map(d => ({ ...d, bookBreakdown: result.bookDays.filter(b => b.outcomeId === d.outcomeId && b.date === d.date).map(b => ({ bookId: b.bookId, minimum: { value: b.minimum, status: b.minimum === null ? 'INCOMPLETE' : 'COMPLETE', reasons: b.minimum === null ? ['PARTIAL_COVERAGE'] : [], knownPartial: null }, availableClosing: { value: b.closing, status: b.closing === null ? 'INCOMPLETE' : 'COMPLETE', reasons: b.closing === null ? ['PARTIAL_COVERAGE'] : [], knownPartial: null } })) }));
                    return { status: 200, data: { runId: r._id, baseId: r['baseId'], sourceDigest: r['sourceDigest'], freshness: stale ? 'HISTORICAL_STALE' : 'CURRENT', outcomes: result.outcomes, ...page, items, expiresAt: r.expiresAt } };
                }
                return { status: 200, data: r['state'] === 'RUNNING' && Date.parse(String(r['leaseUntil'])) <= this.identity.now() ? { ...runDTO(r), state: 'FAILED', errorCode: 'RUN_INTERRUPTED', retryable: false } : runDTO(r), etag: tag(r) };
            }
            if (action === 'compare') {
                const runIds = input['runIds'], ids = input['outcomeIds'];
                if (new Set(runIds).size !== runIds.length || new Set(ids).size !== ids.length)
                    fail('DOUBLE_ALLOCATION');
                const outcomes = [];
                let baseId = '', sourceDigest = '', horizon, expiresAt = iso(this.identity.now() + limits.payloadMs);
                for (const id of runIds) {
                    const r = await this.store.get('s12_runs', id, a, s), value = await this.freshRun(a, s, r), v = await this.store.get('s12_scenario_versions', String(r['versionId']), a, s), days = Number(v['horizonDays']);
                    if (baseId && (baseId !== r['baseId'] || sourceDigest !== r['sourceDigest'] || horizon !== days))
                        fail('COMPARISON_BASE_MISMATCH');
                    baseId = String(r['baseId']);
                    sourceDigest = String(r['sourceDigest']);
                    horizon = days;
                    expiresAt = [expiresAt, r.expiresAt].sort()[0];
                    outcomes.push(...value.outcomes.filter(o => ids.includes(o.id)));
                }
                if (outcomes.length !== ids.length)
                    fail('RESOURCE_NOT_FOUND', 404);
                const c = await this.base(a, s, baseId);
                if (c.c.base.asOf !== today(this.identity.now()) || (await capture(this.identity, a, s, baseId)).base.sourceDigest !== sourceDigest)
                    fail('BASE_STALE');
                return await finish({ status: 201, data: { id: randomUUID(), baseId, sourceDigest, outcomes, winner: null, expiresAt } });
            }
            if (action === 'evaluateAlerts') {
                const thresholds = input['thresholds'];
                let c, run;
                if (input['kind'] === 'FACT')
                    c = (await this.base(a, s, String(input['baseId']), input['baseToken'], true)).c;
                else {
                    const r = await this.store.get('s12_runs', String(input['runId']), a, s), value = await this.freshRun(a, s, r);
                    c = (await this.base(a, s, String(r['baseId']))).c;
                    if ((await capture(this.identity, a, s, c.base.id)).base.sourceDigest !== c.base.sourceDigest || c.base.asOf !== today(this.identity.now()))
                        fail('BASE_STALE');
                    run = { id: r._id, result: value };
                }
                const r = await this.alerts(a, s, c, thresholds, run);
                return await finish({ status: 201, data: { id: r._id, ...Object.fromEntries(['baseId', 'sourceDigest', 'evaluatedTypes', 'coverage', 'created', 'updated', 'resolved', 'expiresAt'].map(k => [k, r[k]])) } });
            }
            if (action === 'getAlert' || action === 'acknowledgeAlert') {
                let r = await this.store.get('s12_alerts', params['alertId'], a, s);
                this.alive(r);
                let payload = r['payload'];
                if (action === 'getAlert') {
                    const current = await capture(this.identity, a, s);
                    if (current.base.sourceDigest !== payload.sourceDigest || Date.parse(payload.lastEvaluatedAt) + limits.freshMs <= this.identity.now() || payload.effectiveDate > today(this.identity.now()) && payload.class === 'FACT')
                        payload = { ...payload, freshness: 'STALE' };
                }
                if (action === 'acknowledgeAlert') {
                    this.check(r, expected);
                    const current = await capture(this.identity, a, s);
                    if (current.base.sourceDigest !== payload.sourceDigest)
                        fail('SOURCE_CONFLICT');
                    try {
                        payload = acknowledge(payload, this.identity.now());
                    }
                    catch {
                        fail('SOURCE_CONFLICT');
                    }
                    r = await this.store.put('s12_alerts', a, { ...r, payload }, s, r._id, limits.definitionMs);
                }
                return await finish({ status: 200, data: alertDTO(payload), etag: tag(r) });
            }
            if (action === 'getCommand') {
                const r = await this.store.get('s12_commands', params['commandKey'], a, s);
                this.alive(r);
                return { status: 200, data: commandDTO(r) };
            }
            const list = { listScenarios: { table: 's12_scenarios', dto: scenarioDTO }, listVersions: { table: 's12_scenario_versions', dto: versionDTO }, listRuns: { table: 's12_runs', dto: runDTO }, listAlerts: { table: 's12_alerts', dto: r => alertDTO(r['payload']) } }, kind = list[action];
            if (kind) {
                let rows = (await this.store.all(kind.table, a, s)).filter(r => Date.parse(r.expiresAt) > this.identity.now() && !r['tombstone']);
                if (action === 'listVersions') {
                    await this.store.get('s12_scenarios', params['scenarioId'], a, s);
                    rows = rows.filter(r => r['scenarioId'] === params['scenarioId']);
                    rows = await Promise.all(rows.map(async (r) => ({ ...r, ...await this.definition(a, s, r) })));
                }
                for (const p of spec.definition.parameters.filter(p => p.in === 'query' && !['limit', 'cursor'].includes(p.name)))
                    if (query[p.name] !== undefined)
                        rows = rows.filter(r => r[p.name] === query[p.name] || r['payload']?.[p.name] === query[p.name]);
                if (action === 'listAlerts') {
                    const current = await capture(this.identity, a, s);
                    rows = rows.map(r => { const p = r['payload']; return { ...r, payload: { ...p, freshness: current.base.sourceDigest === p.sourceDigest && Date.parse(p.lastEvaluatedAt) + limits.freshMs > this.identity.now() ? 'CURRENT' : 'STALE' } }; });
                }
                const page = this.page(a, operation + hash(params), rows, query);
                return { status: 200, data: { ...page, items: page.items.map(kind.dto) } };
            }
            return fail('INPUT_INVALID', 422);
        });
        if (ticket) {
            this.queue.push(ticket);
            void this.pump();
        }
        return result;
    }
    page(a, resource, rows, query) {
        const limit = Number(query['limit'] ?? 20);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
            fail('INPUT_INVALID', 422);
        const binding = hash({ resource, authority: a.binding, scope: a.key, limit, filters: Object.fromEntries(Object.entries(query).filter(([k]) => k !== 'cursor')), digest: hash(rows) });
        const c = query['cursor'] === undefined ? null : this.tokens.open(query['cursor'], 'cursor');
        if (c && (c.binding !== binding || !Number.isInteger(c.offset) || c.offset < 0 || c.offset > rows.length || c.expires <= this.identity.now()))
            fail('BASE_STALE');
        const offset = c?.offset ?? 0, items = rows.slice(offset, offset + limit);
        return { items, totalRows: rows.length, nextCursor: offset + items.length < rows.length ? this.tokens.seal({ binding, offset: offset + items.length, expires: this.identity.now() + limits.freshMs }, 'cursor') : null };
    }
    async pump() {
        if (this.pumping || this.stopped)
            return;
        this.pumping = true;
        try {
            while (this.queue.length && !this.stopped) {
                const ticket = this.queue.shift();
                if (await this.run(ticket).catch(() => false)) {
                    this.queue.push(ticket);
                    await new Promise(resolve => setTimeout(resolve, 250));
                }
            }
        }
        finally {
            this.pumping = false;
        }
    }
    async workerAuthorized(t) {
        if (this.stopped || !this.store.active || !this.identity.obligations?.active)
            fail('SERVICE_UNAVAILABLE', 503);
        const d = this.identity.database;
        await d.transactionGuard?.();
        await d.client.withSession(async (s) => s.withTransaction(async () => {
            const a = await authority(this.identity, t.context, t.params, s, t.consolidated), r = await this.store.get('s12_runs', t.runId, a, s);
            if (r['state'] !== 'RUNNING' || r['binding'] !== a.binding)
                fail('RUN_STATE_CONFLICT');
            if (Date.parse(String(r['leaseUntil'])) <= this.identity.now())
                fail('RUN_INTERRUPTED');
        }, { readConcern: { level: 'snapshot' }, readPreference: 'primary' }));
    }
    async run(t) {
        let claimed = false;
        try {
            const prepared = await this.frame(t.context, t.params, t.consolidated, true, async (a, s) => {
                const r = await this.store.get('s12_runs', t.runId, a, s);
                this.alive(r);
                if (r['state'] !== 'QUEUED')
                    return null;
                if (await this.identity.database.db.collection('s12_runs').countDocuments({ state: 'RUNNING', leaseUntil: { $gt: iso(this.identity.now()) }, _id: { $ne: r._id } }))
                    return { waiting: true };
                if (r['binding'] !== a.binding)
                    fail('ACCESS_DENIED', 403);
                const v = await this.store.get('s12_scenario_versions', String(r['versionId']), a, s), definition = await this.definition(a, s, v), b = await this.base(a, s, String(r['baseId']));
                if (b.c.base.asOf !== today(this.identity.now()) || Date.parse(String(b.r['freshUntil'])) <= this.identity.now() || (await capture(this.identity, a, s, b.r._id)).base.sourceDigest !== r['sourceDigest'])
                    fail('BASE_STALE');
                await this.store.put('s12_runs', a, { ...r, state: 'RUNNING', leaseUntil: iso(this.identity.now() + 60000) }, s, r._id);
                return { a, r, definition, base: b.c };
            });
            if (!prepared)
                return false;
            if ('waiting' in prepared)
                return true;
            claimed = true;
            let heartbeat = this.identity.now();
            const check = async () => { await this.workerAuthorized(t); if (this.identity.now() - heartbeat >= 5000) {
                heartbeat = this.identity.now();
                await this.frame(t.context, t.params, t.consolidated, true, async (a, s) => { const r = await this.store.get('s12_runs', t.runId, a, s); if (r['state'] !== 'RUNNING')
                    fail('RUN_STATE_CONFLICT'); await this.store.put('s12_runs', a, { ...r, leaseUntil: iso(this.identity.now() + 60000) }, s, r._id); });
            } };
            const output = await isolated(prepared.base.base, prepared.definition, t.runId, prepared.r['sensitivity'], check);
            await this.frame(t.context, t.params, t.consolidated, true, async (a, s) => {
                const r = await this.store.get('s12_runs', t.runId, a, s);
                if (r['state'] !== 'RUNNING' || r['binding'] !== a.binding)
                    fail('RUN_STATE_CONFLICT');
                const current = await capture(this.identity, a, s, prepared.base.base.id);
                if (current.base.sourceDigest !== r['sourceDigest'] || current.base.asOf !== prepared.base.base.asOf)
                    fail('BASE_STALE');
                const chunks = await this.store.chunks(a, r._id, output.value, s);
                await this.store.put('s12_results', a, { runId: r._id, chunks, metrics: output.metrics }, s, r._id);
                await this.store.put('s12_runs', a, { ...r, state: 'SUCCEEDED', resultChunks: chunks, leaseUntil: null, errorCode: null, retryable: false }, s, r._id);
                if (r['evaluateAlerts'] === true)
                    await this.alerts(a, s, current, { dueWithinDays: 7, concentrationThreshold: '25.00' }, { id: r._id, result: output.value });
            });
        }
        catch (error) {
            // No persisted credentials. Revoked contexts cannot publish failure data;
            // their abandoned lease is handled by explicit authorized resumption.
            await this.frame(t.context, t.params, t.consolidated, true, async (a, s) => {
                const r = await this.store.get('s12_runs', t.runId, a, s);
                if (!['RUNNING', 'QUEUED'].includes(String(r['state'])))
                    return;
                const code = error instanceof AppError ? error.code : 'SIMULATION_BUDGET_EXCEEDED';
                await this.store.put('s12_runs', a, { ...r, state: 'FAILED', errorCode: code, retryable: claimed && code === 'SIMULATION_BUDGET_EXCEEDED', leaseUntil: null }, s, r._id);
            }).catch(() => { });
        }
        return false;
    }
}
//# sourceMappingURL=service.js.map