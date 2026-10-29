/* eslint-disable security/detect-object-injection -- Closed report kinds and validated fixed filter keys. */
import { randomUUID, createHash } from 'node:crypto';
import { MongoOperationTimeoutError, MongoServerError } from 'mongodb';
import { AppError } from '../../shared/errors.js';
import { today } from '../finance/service.js';
import { reportingContract } from './contract.js';
import { ReportTokens } from './token.js';
import { reconstruct, validDate, ageMatches, stock, ratio } from './engine.js';
import { authorize, loadSources } from './sources.js';
import { POLICY, REPORTS, ASSIGNED, OWN } from './models.js';
import { uuid } from '../lending/contract.js';
export const fail = (status, code) => { throw new AppError(status, code); };
const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const FILTERS = { PORTFOLIO: ['loanId', 'borrowerId', 'state', 'ageBand'], INSTALLMENTS: ['loanId', 'borrowerId', 'state', 'ageBand'], MOVEMENTS: ['loanId', 'borrowerId', 'method'], CASH: ['accountId', 'responsibleId'], RECONCILIATION: ['method', 'state'], COLLECTORS: ['responsibleId'], CONCENTRATION: ['borrowerId'] };
export class ReportingService {
    identity;
    projection;
    tokens;
    constructor(identity, key) {
        this.identity = identity;
        this.tokens = new ReportTokens(key);
        reportingContract();
    }
    async initialize() {
        // Existing domain org index is reused. Add only date/order helpers that match
        // the bounded source query, never change domain uniqueness or key policy.
        const db = this.identity.database.db;
        await db.collection('loan_events').createIndex({ organizationId: 1, recordedAt: 1, _id: 1 }, { name: 'reporting_event_cut' });
        await db.collection('loan_installments').createIndex({ organizationId: 1, loanId: 1, dueDate: 1 }, { name: 'reporting_installment_cut' });
        for (const name of ['financial_accounts', 'financial_journals', 'financial_idempotency', 'opening_files', 'opening_validations', 'opening_references', 'opening_idempotency'])
            await db.collection(name).createIndex({ organizationId: 1, _id: 1 }, { name: 'reporting_financial_scope' });
        await db.collection('financial_journals').createIndex({ organizationId: 1, 'lines.accountId': 1, _id: 1 }, { name: 'reporting_account_scope' });
    }
    cut(query, now) {
        const c = { asOf: String(query['asOf'] ?? ''), from: String(query['from'] ?? ''), to: String(query['to'] ?? ''), recordedThrough: query['recordedThrough'] === undefined ? new Date(now).toISOString() : String(query['recordedThrough']) };
        if (!validDate(c.asOf) || !validDate(c.from) || !validDate(c.to) || c.from > c.to || c.to > c.asOf || c.asOf > today(now) || !Number.isFinite(Date.parse(c.recordedThrough)) || new Date(c.recordedThrough).toISOString() !== c.recordedThrough)
            fail(422, 'INPUT_INVALID');
        return c;
    }
    allows(auth, kind) { return auth.isT || (kind === 'PORTFOLIO' || kind === 'INSTALLMENTS' || kind === 'CONCENTRATION' ? auth.isC : kind === 'CASH' || kind === 'COLLECTORS' ? auth.isC || auth.isO : kind === 'MOVEMENTS' ? auth.isC || auth.isO || auth.isP : false); }
    async read(context, operation, org, id, query = {}) {
        const started = performance.now();
        await this.identity.requireOpen(context.realm);
        const projection = operation === 'getReportingPolicy' ? undefined : this.projection;
        if (projection) {
            uuid(org);
            const current = await this.identity.database.client.withSession(async (session) => this.identity.sessions.requireOperational(context, session)), actor = current.identity;
            if (context.realm !== 'TENANT' || current.context.kind !== 'W' || actor.roles.includes('SA'))
                fail(403, 'ACCESS_DENIED');
            if (actor.organizationId !== org)
                fail(404, 'RESOURCE_NOT_FOUND');
            if (!actor.roles.some(role => ['T', 'C', 'O', 'P'].includes(role)))
                fail(403, 'ACCESS_DENIED');
        }
        const barrier = await projection?.enter(started);
        // A dedicated snapshot read transaction deliberately does not use the write
        // transaction fence or expiry sweep. Security gate and W authority still run.
        const answer = await this.identity.database.client.withSession({ causalConsistency: true }, async (session) => {
            if (barrier)
                session.advanceOperationTime(barrier.time);
            return await session.withTransaction(async () => {
                await this.identity.requireOpen(context.realm);
                const auth = await authorize(this.identity, context, org, session, started);
                if (operation === 'getReportingPolicy') {
                    const schema = reportingContract().document.components.schemas['Indicator'];
                    const ids = auth.isT ? schema.properties.id.enum : [...(auth.isC ? ASSIGNED : []), ...(auth.isC || auth.isO ? OWN : ['RECEIPTS_REGISTERED'])];
                    return { status: 200, data: { policyVersion: POLICY, schemaVersion: '1.0.0', usage: 'LOCAL_SYNTHETIC', realUseAllowed: false, currency: 'COP', timezone: 'America/Bogota', indicatorIds: ids, reportKinds: REPORTS.filter(k => this.allows(auth, k)), defaultLimit: 20, maxLimit: 100, tokenTTLSeconds: 300, maxLoans: 10000, maxEvents: 100000, maxJournalLines: 200000, queryTimeoutMs: 10000 } };
                }
                const incoming = query['snapshotToken'] === undefined ? null : this.tokens.open(query['snapshotToken'], 'snapshot');
                const now = this.identity.now();
                if (operation === 'getReportingLoan' && !auth.isT && (!auth.isC || !auth.loanIds.includes(id ?? '')))
                    fail(404, 'RESOURCE_NOT_FOUND');
                if (incoming && (incoming.v !== 1 || incoming.actor !== auth.actorId || incoming.org !== org))
                    fail(422, 'INPUT_INVALID');
                if (incoming && incoming.expires <= now)
                    fail(409, 'REPORT_SNAPSHOT_EXPIRED');
                if (incoming && incoming.authority !== auth.binding)
                    fail(409, 'REPORT_SNAPSHOT_STALE');
                if (operation !== 'getReportingDashboard' && !incoming)
                    fail(422, 'INPUT_INVALID');
                let kind;
                if (operation === 'listReportingRows') {
                    if (!REPORTS.includes(id))
                        fail(422, 'INPUT_INVALID');
                    kind = id;
                    if (!this.allows(auth, kind))
                        fail(403, 'ACCESS_DENIED');
                    for (const key of Object.keys(query))
                        if (!['snapshotToken', 'limit', 'cursor', ...FILTERS[kind]].includes(key))
                            fail(422, 'INPUT_INVALID');
                }
                if (query['responsibleId'] && !auth.isT && query['responsibleId'] !== auth.actorId)
                    fail(404, 'RESOURCE_NOT_FOUND');
                const cut = incoming ? { asOf: incoming.asOf, from: incoming.from, to: incoming.to, recordedThrough: incoming.recordedThrough } : this.cut(query, now);
                if (incoming && operation === 'getReportingDashboard') {
                    const requested = this.cut({ ...query, recordedThrough: query['recordedThrough'] ?? incoming.recordedThrough }, now);
                    if (digest(requested) !== digest(cut))
                        fail(422, 'INPUT_INVALID');
                }
                const source = await projection?.load(auth, cut, session, operation, id) ?? await loadSources(this.identity, org, auth, session, started);
                await projection?.bind(source, auth, session);
                if (incoming)
                    source.currentDate = today(incoming.issued);
                if (!incoming && query['recordedThrough'] === undefined)
                    cut.recordedThrough = source.knownThrough;
                if (cut.recordedThrough > source.knownThrough)
                    fail(422, 'INPUT_INVALID');
                if (incoming && incoming.versions !== source.versions)
                    fail(409, 'REPORT_SNAPSHOT_STALE');
                const claims = incoming ?? { v: 1, ...cut, actor: auth.actorId, org, authority: auth.binding, versions: source.versions, issued: now, expires: now + 300000, nonce: randomUUID() };
                const token = typeof query['snapshotToken'] === 'string' ? query['snapshotToken'] : this.tokens.seal(claims, 'snapshot');
                const data = reconstruct(source, cut, auth, () => { if (performance.now() - started > 10000)
                    fail(503, 'REPORT_BUDGET_EXCEEDED'); }), meta = { policyVersion: POLICY, schemaVersion: '1.0.0', currency: 'COP', timezone: 'America/Bogota', ...cut, capturedAt: new Date(claims.issued).toISOString(), expiresAt: new Date(claims.expires).toISOString(), snapshotToken: token, scopeKind: auth.scopeKind, coverage: data.coverage };
                const metric = (ids) => [...data.metrics.values()].filter(m => ids.includes(m.id));
                let result;
                if (operation === 'getReportingDashboard')
                    result = auth.isT ? { meta, organizationMetrics: [...data.metrics.values()] } : auth.isC ? { meta, assignedMetrics: metric(ASSIGNED), ownActivityMetrics: metric(OWN) } : { meta, ownActivityMetrics: metric(auth.isO ? OWN : ['RECEIPTS_REGISTERED']) };
                else if (operation === 'getReportingLoan') {
                    const loan = data.loans.get(id ?? '');
                    if (!loan)
                        fail(404, 'RESOURCE_NOT_FOUND');
                    result = { meta, position: loan.row, indicators: [stock('PRINCIPAL_OUTSTANDING', loan.principal), stock('PRINCIPAL_DUE_TODAY_OR_EARLIER', loan.due), stock('PRINCIPAL_OVERDUE', loan.overdue), stock('INTEREST_OVERDUE', loan.interestOverdue), stock('INTEREST_EXPECTED_FUTURE', loan.futureInterest), stock('INTEREST_DUE_UNACCRUED', loan.unaccrued), ratio('PAR30', loan.dpd > 30 ? loan.principal : 0n, loan.principal)], installmentsLink: '/api/v1/organizations/' + org + '/reporting/reports/INSTALLMENTS?loanId=' + id, movementsLink: '/api/v1/organizations/' + org + '/reporting/reports/MOVEMENTS?loanId=' + id };
                }
                else if (kind) {
                    const limit = query['limit'] === undefined ? 20 : Number(query['limit']);
                    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
                        fail(422, 'INPUT_INVALID');
                    const filters = Object.fromEntries(FILTERS[kind].filter(k => query[k] !== undefined).map(k => [k, query[k]]));
                    const states = { PORTFOLIO: ['ACTIVE', 'SETTLED', 'UNCLASSIFIABLE'], INSTALLMENTS: ['UNPAID', 'PARTIAL', 'PAID'], RECONCILIATION: ['PENDING', 'DISCREPANCY', 'INVESTIGATION', 'RECONCILED'] };
                    if (filters['state'] && !states[kind]?.includes(String(filters['state'])))
                        fail(422, 'INPUT_INVALID');
                    if (kind === 'RECONCILIATION' && filters['method'] && filters['method'] !== 'BANK')
                        fail(422, 'INPUT_INVALID');
                    if (filters['accountId'] && !source.accounts.some(a => a._id === filters['accountId']))
                        fail(404, 'RESOURCE_NOT_FOUND');
                    if (filters['responsibleId'] && auth.isT && !await this.identity.identities.findOne({ _id: String(filters['responsibleId']), organizationId: org }, { session }))
                        fail(404, 'RESOURCE_NOT_FOUND');
                    if (query['loanId'] && !data.loans.has(String(query['loanId'])))
                        fail(404, 'RESOURCE_NOT_FOUND');
                    if (query['borrowerId'] && !source.borrowers.some(b => b._id === query['borrowerId'] && (auth.isT || data.rows.PORTFOLIO.some(l => l['borrower']?.['id'] === b._id))))
                        fail(404, 'RESOURCE_NOT_FOUND');
                    const binding = digest({ token, kind, filters, limit }), cursor = query['cursor'] === undefined ? null : this.tokens.open(query['cursor'], 'cursor');
                    if (cursor?.binding !== undefined && cursor.binding !== binding)
                        fail(422, 'INPUT_INVALID');
                    const borrowers = new Map(source.loans.map(l => [l._id, l.borrowerId]));
                    const baseRows = kind === 'CONCENTRATION' && filters['borrowerId'] ? data.concentrationAll : data.rows[kind];
                    const rows = baseRows.filter(r => Object.entries(filters).every(([k, v]) => {
                        if (k === 'ageBand') {
                            if (v === 'DUE_TODAY')
                                return kind === 'INSTALLMENTS' ? r['dueDate'] === cut.asOf && r['state'] !== 'PAID' : data.loans.get(String(r['loanId']))?.installments.some(x => x['dueDate'] === cut.asOf && x['state'] !== 'PAID') === true;
                            return ageMatches(r, v);
                        }
                        if (k === 'borrowerId')
                            return (r['borrower']?.['id'] ?? borrowers.get(String(r['loanId']))) === v;
                        if (k === 'method' && kind === 'RECONCILIATION')
                            return v === 'BANK';
                        return r[k] === v;
                    }));
                    const key = (r) => kind === 'PORTFOLIO' ? String(r['borrower']?.['code'] ?? '\uffff') + '|' + r['id'] : kind === 'INSTALLMENTS' ? String(r['dueDate']) + '|' + r['loanId'] + '|' + String(r['scheduleVersion']).padStart(8, '0') + '|' + String(r['number']).padStart(8, '0') + '|' + r['id'] : kind === 'MOVEMENTS' ? String(r['effectiveDate']) + '|' + r['recordedAt'] + '|' + r['id'] : kind === 'CASH' ? String(r['accountId']) + '|' + r['responsibleId'] + '|' + r['id'] : kind === 'RECONCILIATION' ? String(r['effectiveDate']) + '|' + r['id'] : String(r['responsibleId'] ?? r['id']) + '|' + r['id'];
                    if (kind !== 'CONCENTRATION')
                        rows.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
                    const enumerated = rows.map((r, i) => ({ row: r, key: kind === 'CONCENTRATION' ? String(i).padStart(12, '0') + '|' + r['id'] : key(r) }));
                    const remaining = enumerated.filter(r => !cursor || r.key > cursor.last), page = remaining.slice(0, limit), next = remaining.length > limit ? this.tokens.seal({ binding, last: page.at(-1).key }, 'cursor') : null;
                    result = { meta, reportKind: kind, filterScope: JSON.stringify(kind === 'RECONCILIATION' ? { ...filters, population: 'S06_BANK', legacyState: 'UNAVAILABLE' } : filters), totalRows: rows.length, items: page.map(r => r.row), nextCursor: next };
                }
                else
                    fail(422, 'INPUT_INVALID');
                if (performance.now() - started > 10000)
                    fail(503, 'REPORT_BUDGET_EXCEEDED');
                reportingContract().validate(operation + ':response', { data: result }, true);
                return { status: 200, data: result };
            }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary', timeoutMS: Math.max(1, Math.floor(10000 - (performance.now() - started))) });
        }).catch((error) => {
            if (error instanceof MongoOperationTimeoutError || error instanceof MongoServerError && error.code === 50)
                fail(503, 'REPORT_BUDGET_EXCEEDED');
            throw error;
        });
        if (projection && barrier)
            await projection.leave(barrier, started);
        return answer;
    }
}
//# sourceMappingURL=service.js.map