/* eslint-disable security/detect-object-injection -- Unit-time keys are authenticated original entity/journal IDs; the derived dictionary has no prototype. */
/* Fixed table catalogue and server-built authority predicates; no query operators from HTTP. */
import { createHash } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { beginEvidence } from '../lending/evidence-v2.js';
import { uuid } from '../lending/contract.js';
import { verifyRow } from '../obligations/evidence.js';
import { today } from '../finance/service.js';
import { loadReportingFinance } from '../finance/scoped-integrity.js';
const hash = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export async function authorize(identity, context, organizationId, s, started = performance.now()) {
    const budget = () => { if (performance.now() - started > 10000)
        throw new AppError(503, 'REPORT_BUDGET_EXCEEDED'); };
    budget();
    uuid(organizationId);
    const current = await identity.sessions.requireOperational(context, s), actor = current.identity;
    if (context.realm !== 'TENANT' || current.context.kind !== 'W' || actor.roles.includes('SA'))
        throw new AppError(403, 'ACCESS_DENIED');
    if (actor.organizationId !== organizationId)
        throw new AppError(404, 'RESOURCE_NOT_FOUND');
    if (!actor.roles.some(r => ['T', 'C', 'O', 'P'].includes(r)))
        throw new AppError(403, 'ACCESS_DENIED');
    const org = await identity.database.db.collection('organizations').findOne({ _id: organizationId, status: 'ACTIVE' }, { session: s });
    if (!org)
        throw new AppError(403, 'ACCESS_DENIED');
    const isT = actor.roles.includes('T'), isC = actor.roles.includes('C'), isO = actor.roles.includes('O'), isP = actor.roles.includes('P');
    const unit = await beginEvidence(identity.database, s, organizationId);
    const scopeFilter = { organizationId, registrarId: actor._id, active: true };
    const scopes = isC && !isT ? await identity.database.db.collection('payment_registration_scopes').find(scopeFilter, { session: s, maxTimeMS: 10000 }).limit(10001).toArray() : [];
    if (scopes.length > 10000)
        throw new AppError(422, 'REPORT_SCOPE_TOO_LARGE');
    if (isC && !isT)
        await unit.verifyRows('payment_registration_scopes', scopes, budget, scopeFilter);
    budget();
    const loanIds = [...new Set(scopes.map(x => String(x['loanId'])))].sort();
    const binding = hash({ actor: actor._id, contextId: current.context._id, roles: actor.roles, epoch: actor.authEpoch, authz: actor.authzVersion, credential: actor.credentialVersion, orgEpoch: org.authEpoch, loanIds, scopeVersions: scopes.map(x => [x._id, x['version']]).sort() });
    return { actorId: actor._id, organizationId, roles: actor.roles, isT, isC, isO, isP, loanIds, scopeKind: isT ? 'ORGANIZATION' : isC ? 'ASSIGNED_AND_OWN' : isO ? 'OWN_ACTIVITY' : 'AUTHORIZED_PAYMENTS', binding };
}
export async function loadSources(identity, org, a, s, started) {
    const db = identity.database.db, unit = await beginEvidence(identity.database, s, org);
    const budget = () => { if (performance.now() - started > 10000)
        throw new AppError(503, 'REPORT_BUDGET_EXCEEDED'); };
    const rows = async (name, filter = {}, limit) => {
        budget();
        const result = [];
        const predicate = { organizationId: org, ...filter }, cursor = db.collection(name).find(predicate, { session: s, maxTimeMS: 10000 }).batchSize(500);
        if (limit !== undefined)
            cursor.limit(limit + 1);
        const consume = (row) => { budget(); if (limit !== undefined && result.length === limit)
            throw new AppError(422, 'REPORT_SCOPE_TOO_LARGE'); result.push(row); };
        try {
            while (await cursor.hasNext()) {
                const first = await cursor.next();
                if (first)
                    consume(first);
                for (const row of cursor.readBufferedDocuments())
                    consume(row);
            }
        }
        finally {
            await cursor.close();
        }
        await unit.verifyRows(name, result, budget, predicate);
        budget();
        return result;
    };
    const positions = await rows('loan_positions', a.isT ? {} : { loanId: { $in: a.loanIds } }, 10000);
    const historicalOrigins = await db.collection('s11_historical_origins').find({ bookId: org, ownerId: org, domainKind: 'BUSINESS', _id: { $in: positions.filter(p => p.historicalOriginId === p.loanId && p.fundingEventId === null).map(p => p.loanId) } }, { session: s, maxTimeMS: 10000 }).limit(10001).toArray();
    if (historicalOrigins.length > 10000 || historicalOrigins.some(r => !verifyRow(identity.database, 's11_historical_origins', r)))
        throw new AppError(503, 'INTEGRITY_MISMATCH');
    const loans = await rows('lending_loans', { _id: { $in: positions.map(p => p.loanId) } }, 10000);
    const ids = [...loans, ...historicalOrigins].map(l => l._id), loanFilter = { loanId: { $in: ids } };
    const borrowers = await rows('lending_borrowers', { _id: { $in: [...new Set([...loans, ...historicalOrigins].map(l => l.borrowerId))] } });
    const installments = await rows('loan_installments', loanFilter), schedules = await rows('loan_schedule_versions', loanFilter), profile = await rows('loan_operation_books', { _id: org }, 1);
    const payments = await rows('payments', a.isT ? {} : { $or: [...(a.isC || a.isO ? [{ registrarId: a.actorId }] : []), ...(a.isP ? [{ approvalMode: 'SUPERVISED', status: 'PENDING' }] : [])] });
    const paymentTransitions = await rows('payment_transitions', { paymentId: { $in: payments.map(p => p._id) } });
    const bindings = await rows('custody_bindings', a.isT ? {} : { custodianId: a.actorId }), stations = await rows('cash_stations', a.isT ? {} : { receiverId: a.actorId });
    const ownEventIds = payments.map(p => p['eventId']).filter((x) => typeof x === 'string');
    const applications = a.isT ? [] : await rows('loan_applications', loanFilter), accruals = a.isT ? [] : await rows('loan_accruals', loanFilter);
    const referencedEvents = [...ownEventIds, ...positions.map(p => p.fundingEventId), ...applications.map(x => String(x['eventId'])), ...accruals.map(x => String(x['eventId'])), ...schedules.map(x => x.eventId).filter((x) => x !== null)];
    const eventFilter = a.isT ? {} : { _id: { $in: [...new Set(referencedEvents)] } };
    const events = await rows('loan_events', eventFilter, 100000);
    const eventIds = events.map(e => e._id);
    const compensations = await rows('loan_compensations', a.isT ? {} : { originalEventId: { $in: eventIds } }), snapshots = await rows('payment_event_snapshots', a.isT ? {} : { eventId: { $in: eventIds } });
    const custody = await rows('cash_custody', a.isT ? {} : { responsibleId: a.actorId }), deliveries = await rows('cash_deliveries', a.isT ? {} : { $or: [{ senderId: a.actorId }, { receiverId: a.actorId }] });
    const actions = await rows('collection_actions', a.isT ? {} : { ownerId: a.actorId }), journeys = await rows('collection_journeys', a.isT ? {} : { ownerId: a.actorId }), reconciliation = await rows('reconciliation_events', a.isT ? {} : { _id: { $in: [] } });
    const facts = await rows('cash_delivery_facts', a.isT ? {} : { deliveryId: { $in: deliveries.map(d => d._id) } }), held = await rows('held_funds_reservations', a.isT ? {} : { paymentId: { $in: custody.map(c => c['paymentId']) } });
    const accountIds = [...new Set([...bindings.map(b => String(b['accountId'])), ...stations.map(b => String(b['accountId']))])];
    const finance = await loadReportingFinance(identity.database, org, a.isT ? null : accountIds, s, budget);
    const financialBook = await db.collection('financial_books').findOne({ _id: org }, { session: s });
    if (finance.proofDigest === 'EMPTY_FINANCE' && ((financialBook?.value ?? 0) > 0 || positions.length > 0 || payments.length > 0))
        throw new AppError(503, 'INTEGRITY_MISMATCH');
    budget();
    const latestPaymentChange = (await unit.query('payment_transitions', { organizationId: org }, { createdAt: -1 }, 1))[0];
    const management = await identity.obligations?.businessSources(org, s), managementEvents = a.isT ? management?.events.filter(e => !e.components['wealthInternal']) ?? [] : [], unitKnownAt = Object.create(null);
    const journalTimes = new Map(finance.journals.map(j => [j._id, j.recordedAt]));
    for (const e of events) {
        const time = [e.recordedAt, ...(e.journalId ? [journalTimes.get(e.journalId) ?? e.recordedAt] : [])].sort().at(-1);
        unitKnownAt[e._id] = time;
        if (e.journalId)
            unitKnownAt[e.journalId] = time;
    }
    for (const e of compensations) {
        const id = String(e['journalId'] ?? ''), time = [String(e['createdAt']), journalTimes.get(id) ?? String(e['createdAt'])].sort().at(-1);
        unitKnownAt[e._id] = time;
        if (id)
            unitKnownAt[id] = time;
    }
    for (const e of management?.events.filter(e => !e.components['wealthInternal']) ?? []) {
        if (a.isT)
            unitKnownAt[e._id] = e.unitKnownAt;
        if (!e.components['existingLink'])
            for (const id of e.journalIds)
                if (a.isT || journalTimes.has(id))
                    unitKnownAt[id] = e.unitKnownAt;
    }
    const bind = (ids, times) => { const valid = times.filter(t => Number.isFinite(Date.parse(t))), stamp = [...valid, ...ids.flatMap(id => unitKnownAt[id] ? [unitKnownAt[id]] : [])].sort().at(-1); if (stamp)
        for (const id of ids)
            unitKnownAt[id] = stamp; };
    for (const p of payments) {
        const event = events.find(e => e._id === p['eventId']);
        if (event) {
            const transitions = paymentTransitions.filter(t => t['paymentId'] === p._id && ['registerPayment', 'approvePayment'].includes(String(t['operation'])));
            bind([event._id, ...(event.journalId ? [event.journalId] : []), ...(p['approvalMode'] === 'DIRECT' ? [p._id] : [])], [event.recordedAt, ...transitions.map(t => String(t['createdAt']))]);
        }
        const compensation = compensations.find(e => e._id === p['reversalEventId']);
        if (compensation)
            bind([compensation._id, String(compensation['journalId'])], [String(compensation['createdAt']), ...paymentTransitions.filter(t => t['paymentId'] === p._id && t['operation'] === 'executePaymentReversal').map(t => String(t['createdAt']))]);
    }
    for (const d of deliveries)
        if (d['journalId']) {
            const required = facts.filter(f => f['deliveryId'] === d._id && ['CONFIRM', 'COMPENSATE_CONFIRM'].includes(String(f['kind'])) || [d['countId'], d['senderAckId']].includes(f._id));
            bind([d._id, String(d['journalId'])], [journalTimes.get(String(d['journalId'])) ?? '', ...required.map(f => String(f['recordedAt']))]);
        }
    const fundDeltas = a.isT && identity.wealth ? (await identity.wealth.fundEvents({ kind: 'BUSINESS', bookId: org, ownerId: org, organizationId: org }, s)).flatMap(e => e.deltas.map(d => ({ accountId: d.accountId, delta: d.delta, effectiveDate: e.effectiveDate, unitKnownAt: e.unitKnownAt }))) : [];
    const dataThrough = [...historicalOrigins.map(h => h.createdAt), ...fundDeltas.map(d => d.unitKnownAt), ...Object.values(unitKnownAt), ...events.map(e => e.recordedAt), ...compensations.map(x => String(x['createdAt'])), ...finance.accounts.map(a => a.createdAt), ...finance.journals.map(j => j.recordedAt), ...facts.map(f => String(f['recordedAt'])), ...payments.map(p => String(p['recordedAt'])), ...actions.map(x => String(x['recordedAt'])), ...journeys.flatMap(x => [String(x['recordedAt']), String(x['closedAt'])]), String(latestPaymentChange?.['createdAt'])].filter(x => Number.isFinite(Date.parse(x))).sort().at(-1) ?? '0001-01-01T00:00:00.000Z';
    const knownThrough = [new Date(identity.now()).toISOString(), dataThrough].sort().at(-1);
    return { ...(fundDeltas.length ? { fundDeltas } : {}), ...(managementEvents.length ? { managementEvents } : {}), unitKnownAt, historicalOrigins, loans, borrowers, positions, installments, schedules, events, compensations, snapshots, payments, paymentTransitions, custody, held, deliveries, facts, actions, journeys, stations, bindings, reconciliation, profile: profile[0] ?? null, ...finance, versions: hash({ domainRevision: unit.org.revision, domainRoot: unit.org.root, finance: finance.proofDigest, financialBook: financialBook?.['value'] ?? 0, ...(management?.revision ? { managementRevision: management.revision } : {}) }), currentDate: today(identity.now()), knownThrough, dataThrough };
}
//# sourceMappingURL=sources.js.map