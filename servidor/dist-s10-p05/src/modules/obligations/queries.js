/* eslint-disable security/detect-object-injection -- Validated closed DTO fields, signed snapshot claims, component enums and original-source refs. */
import { randomBytes, createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { cents, money } from '../finance/money.js';
import { personalActor, resolveScope, authorityBinding } from './authority.js';
import { today, validDate } from './calendar.js';
import { publicExpense, live, expensePosition } from './expenses.js';
import { publicLiability, effectiveTerms } from './liabilities.js';
import { relationships, declarations, booksTable, privateAccounts, table, etag } from './models.js';
import { hash } from './codec.js';
function seal(key, v) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); c.setAAD(Buffer.from('S09:SNAPSHOT:v1')); const body = Buffer.concat([c.update(JSON.stringify(v)), c.final()]); return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url'); }
function open(key, v) { try {
    if (typeof v !== 'string' || v.length > 16384)
        throw Error();
    const raw = Buffer.from(v, 'base64url');
    if (raw.length < 29)
        throw Error();
    const c = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    c.setAAD(Buffer.from('S09:SNAPSHOT:v1'));
    c.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([c.update(raw.subarray(28)), c.final()]).toString());
}
catch {
    throw new AppError(422, 'INPUT_INVALID');
} }
const dtoBook = (b) => ({ id: b._id, currency: b.currency, status: b.status, version: b.version });
const dtoAccount = (r) => ({ id: r._id, code: r['code'], name: r['name'], accountClass: r['accountClass'], kind: r['kind'], currency: r['currency'], status: r['status'], version: r.version });
const publicTotals = (t) => Object.fromEntries(Object.entries(t).map(([k, n]) => [k, money(n)]));
async function historical(m, name, scope, s, known, current = false) {
    const present = await m.store.all(name, scope, s);
    if (current)
        return present;
    const history = await m.store.all(table(scope.kind, 'history'), scope, s), candidates = [...present, ...history.filter(x => x['entityTable'] === name).map(x => x['payload'])], rows = new Map();
    for (const row of candidates)
        if (row.recordedAt <= known && (!rows.has(row._id) || rows.get(row._id).version < row.version))
            rows.set(row._id, row);
    return [...rows.values()];
}
const contextFor = (m, scope, s) => ({ identity: m.identity, store: m.store, ledger: m.ledger, scope, s });
export async function consolidated(m, context, scope, s, asOf, known) {
    const personal = await m.ledger.totals(scope, s, asOf, known), gross = { ...personal }, businesses = [], participations = [], eliminations = [], reasons = [];
    const { actor } = await personalActor(m.identity, context, s);
    let business, eligible;
    if (actor.organizationId) {
        try {
            const resolved = await resolveScope(m.identity, context, 'BUSINESS', actor.organizationId, s);
            business = resolved.scope;
            if (resolved.book) {
                const ds = await m.store.all(declarations, business, s), current = ds.filter(d => d['subjectId'] === actor._id && String(d['validFrom']) <= today(m.identity.now())).sort((a, b) => a.version - b.version).at(-1);
                if (current && current['right'] === 'FULL_OWNERSHIP' && current['percentage'] === '100.00') {
                    const atCut = ds.filter(d => d['subjectId'] === actor._id && String(d['validFrom']) <= asOf && d.recordedAt <= known).sort((a, b) => a.version - b.version).at(-1);
                    if (atCut && atCut['right'] === 'FULL_OWNERSHIP' && atCut['percentage'] === '100.00')
                        eligible = atCut;
                    else
                        reasons.push('ELIGIBILITY_NOT_VISIBLE_AT_CUT');
                }
                else if (current) {
                    participations.push({ referenceId: current._id, percentage: current['percentage'], ...(current['declaredValue'] ? { declaredValue: current['declaredValue'], valueDate: current['valueDate'] } : {}), reason: 'PARTICIPATION_SEPARATE_NOT_FULLY_CONSOLIDATED' });
                }
            }
        }
        catch (e) {
            if (!(e instanceof AppError) || ![403, 404].includes(e.status))
                throw e;
            reasons.push('CURRENT_BUSINESS_NOT_AUTHORIZED');
        }
    }
    if (eligible && business) {
        const totals = await m.ledger.totals(business, s, asOf, known);
        for (const k of Object.keys(gross))
            gross[k] += totals[k];
        businesses.push({ organizationId: business.bookId, eligibilityVersionId: eligible._id, totals: publicTotals(totals) });
    }
    const net = { ...gross };
    if (eligible && business) {
        const relations = await m.store.all(relationships, scope, s), pe = await m.store.all(table('PERSONAL', 'events'), scope, s), be = await m.store.all(table('BUSINESS', 'events'), business, s);
        const visible = (r) => r.effectiveDate <= asOf && r.unitKnownAt <= known && !(r.reversedEffectiveDate && r.reversedEffectiveDate <= asOf && r.reversedKnownAt <= known);
        for (const r of relations.filter(r => r.businessBookId === business.bookId && r.rootRelationshipId === null && visible(r))) {
            if (!pe.some(e => e._id === r.sourceEventIds[0] && e.unitKnownAt <= known && e.effectiveDate <= asOf) || !be.some(e => e._id === r.sourceEventIds[1] && e.unitKnownAt <= known && e.effectiveDate <= asOf)) {
                reasons.push('RELATIONSHIP_COUNTERPART_NOT_VISIBLE');
                continue;
            }
            const settlements = relations.filter(x => x.rootRelationshipId === r._id && visible(x)), amount = cents(r.amount) - settlements.reduce((n, x) => n + cents(x.amount), 0n);
            if (amount < 0n)
                throw new AppError(503, 'SOURCE_INCONSISTENT');
            if (amount === 0n)
                continue;
            net.assets -= amount;
            if (r.kind === 'CONTRIBUTION')
                net.equity -= amount;
            else
                net.liabilities -= amount;
            eliminations.push({ relationshipId: r._id, kind: r.kind, component: r.kind === 'CONTRIBUTION' ? 'INVESTMENT_EQUITY' : 'RECIPROCAL_PRINCIPAL', amount: money(amount), sourceRefs: r.sourceEventIds });
        }
    }
    if (net.assets < 0n || net.liabilities < 0n)
        throw new AppError(503, 'SOURCE_INCONSISTENT');
    return { data: { personalTotals: publicTotals(personal), businesses, gross: publicTotals(gross), eliminations, net: publicTotals(net), participations }, reasons };
}
export async function managementRead(m, context, operation, params, query) {
    const started = performance.now(), barrier = await m.enter(started), business = operation.includes('Business') || operation.startsWith('listBusiness'), consolidation = operation === 'getPrivateConsolidation', needsLegacy = business && operation !== 'getBusinessBook' || consolidation;
    const oldBarrier = needsLegacy ? await m.identity.reporting?.projection?.enter(started) : undefined;
    if (needsLegacy && !oldBarrier)
        throw new AppError(503, 'SERVICE_UNAVAILABLE');
    const tokenKey = createHmac('sha256', m.key).update('S09:TOKENS:v1').digest();
    const answer = await m.identity.database.client.withSession({ causalConsistency: true }, async (s) => {
        s.advanceOperationTime(barrier.time);
        if (oldBarrier)
            s.advanceOperationTime(oldBarrier.time);
        return await s.withTransaction(async () => {
            const { actor, scope, book } = await resolveScope(m.identity, context, business ? 'BUSINESS' : 'PERSONAL', business ? params['organizationId'] : params['bookId'], s);
            if (!book)
                throw new AppError(404, 'RESOURCE_NOT_FOUND');
            await m.store.get(booksTable, book._id, scope, s);
            const head = await m.store.head(scope.bookId, s);
            if (!head || hash(book) !== head.bookHash)
                throw new AppError(503, 'INTEGRITY_MISMATCH');
            if (operation === 'getOwnPersonalBook' || operation === 'getBusinessBook')
                return { status: 200, data: dtoBook(book), etag: etag(book) };
            const binding = authorityBinding(actor, context, book), now = m.identity.now(), limit = query['limit'] === undefined ? 20 : Number(query['limit']);
            if (!Number.isInteger(limit) || limit < 20 || limit > 100)
                throw new AppError(422, 'INPUT_INVALID');
            const incoming = query['snapshotToken'] === undefined ? undefined : open(tokenKey, query['snapshotToken']), asOf = incoming?.asOf ?? String(query['asOf'] ?? today(now));
            if (!validDate(asOf) || asOf > today(now))
                throw new AppError(422, 'INPUT_INVALID');
            const source = hash({ head, actor: actor._id, auth: binding, ...(consolidation || business ? { finance: (await m.identity.database.db.collection('financial_evidence_head').findOne({ _id: 'finance' }, { session: s }))?.digest, ...(actor.organizationId ? { businessHead: await m.store.head(actor.organizationId, s), organization: await m.identity.database.db.collection('organizations').findOne({ _id: actor.organizationId }, { session: s }) } : {}) } : {}) });
            if (incoming && (incoming.actor !== actor._id || incoming.scope !== scope.bookId || incoming.operation !== operation || incoming.limit !== limit))
                throw new AppError(422, 'INPUT_INVALID');
            if (incoming && incoming.expires <= now)
                throw new AppError(409, 'REPORT_SNAPSHOT_EXPIRED');
            if (incoming && (incoming.binding !== binding || incoming.source !== source))
                throw new AppError(409, 'REPORT_SNAPSHOT_STALE');
            const events = await m.store.all(table(scope.kind, 'events'), scope, s), allThrough = events.flatMap(e => [e.recordedAt, e.unitKnownAt]), maxKnown = [new Date(now).toISOString(), book.recordedAt, ...allThrough].sort().at(-1);
            const known = incoming?.known ?? String(query['recordedThrough'] ?? maxKnown);
            if (!Number.isFinite(Date.parse(known)) || new Date(known).toISOString() !== known || known > maxKnown || incoming && query['recordedThrough'] !== undefined && query['recordedThrough'] !== incoming.known || incoming && query['asOf'] !== undefined && query['asOf'] !== incoming.asOf)
                throw new AppError(422, 'INPUT_INVALID');
            const claims = incoming ?? { kind: 'SNAPSHOT', actor: actor._id, scope: scope.bookId, binding, source, asOf, known, expires: now + 300000, issued: now, operation, limit };
            const token = typeof query['snapshotToken'] === 'string' ? query['snapshotToken'] : seal(tokenKey, claims), meta = { currency: 'COP', timezone: 'America/Bogota', asOf, recordedThrough: known, policyVersion: 'S09-CO-1.0', schemaVersion: '1.0.2', scope: consolidation ? 'PRIVATE_CONSOLIDATED' : scope.kind, coverage: 'COMPLETE', snapshotToken: token, expiresAt: new Date(claims.expires).toISOString(), reasons: [] };
            if (consolidation) {
                const value = await consolidated(m, context, scope, s, asOf, known);
                meta.reasons = value.reasons;
                if (value.reasons.length)
                    meta.coverage = 'INCOMPLETE';
                return { status: 200, data: value.data, meta };
            }
            const visibleEvents = events.filter(e => e.effectiveDate <= asOf && e.unitKnownAt <= known), byEntity = new Map();
            for (const e of visibleEvents) {
                const xs = byEntity.get(e.entityId) ?? [];
                xs.push(e);
                byEntity.set(e.entityId, xs);
            }
            const versions = operation.toLowerCase().includes('liabilit') || operation.toLowerCase().includes('agenda') ? await m.store.all(table(scope.kind, 'liability_versions'), scope, s) : [], versionsByEntity = new Map();
            for (const v of versions) {
                const xs = versionsByEntity.get(String(v['liabilityId'])) ?? [];
                xs.push(v);
                versionsByEntity.set(String(v['liabilityId']), xs);
            }
            const isAccounts = operation === 'listPersonalAccounts' || operation === 'getPersonalAccount';
            let rows = [];
            if (isAccounts)
                rows = (await m.store.all(privateAccounts, scope, s)).map(dtoAccount);
            else if (operation.toLowerCase().includes('agenda')) {
                const expenses = await historical(m, table(scope.kind, 'expenses'), scope, s, known, book.recordedAt <= known), liabilities = await historical(m, table(scope.kind, 'liabilities'), scope, s, known, book.recordedAt <= known), obligations = [];
                for (const e of expenses)
                    if (e.planningStatus !== 'CANCELLED') {
                        const xs = byEntity.get(e._id) ?? [], p = expensePosition(xs), amount = p.recognized > 0n ? p.recognized : e.amount === undefined ? null : cents(e.amount);
                        obligations.push({ sourceId: e._id, sourceKind: 'EXPENSE', dueDate: e.dueDate, amount, kind: e.amount === undefined ? 'UNPRICED' : p.recognized > 0n ? 'OFFICIAL_DECLARED' : 'PLANNED', paid: cut => expensePosition(xs.filter(x => x.effectiveDate <= cut)).paid });
                    }
                for (let l of liabilities)
                    if (live(byEntity.get(l._id) ?? []).some(e => e.kind === 'LIABILITY_ACTIVATE') || l.schedule.kind === 'PROJECTED') {
                        l = await effectiveTerms(contextFor(m, scope, s), l, asOf, known, versionsByEntity.get(l._id) ?? []);
                        const xs = byEntity.get(l._id) ?? [], version = l.schedule.id;
                        for (const i of l.schedule.installments)
                            obligations.push({ sourceId: l._id, sourceKind: 'LIABILITY', dueDate: i.dueDate, amount: cents(i.total), kind: l.schedule.kind, paid: cut => live(xs.filter(e => e.effectiveDate <= cut)).filter(e => e.kind === 'LIABILITY_PAY' && e.components['scheduleVersionId'] === version).flatMap(e => e.allocations).filter(a => a.installmentNumber === i.number).reduce((n, a) => n + cents(a.amount), 0n) });
                    }
                const cut = (date) => date < asOf ? date : asOf, cash = await m.ledger.cashAtCuts(scope, s, obligations.map(o => cut(o.dueDate)), known, events), gaps = new Map();
                for (const date of [...new Set(obligations.map(o => o.dueDate))].sort()) {
                    let required = 0n, incomplete = false;
                    for (const o of obligations)
                        if (o.dueDate <= date && o.kind !== 'PROJECTED') {
                            if (o.amount === null)
                                incomplete = true;
                            else {
                                const remaining = o.amount - o.paid(cut(date));
                                required += remaining > 0n ? remaining : 0n;
                            }
                        }
                    const available = cash.get(cut(date)) ?? 0n;
                    gaps.set(date, incomplete ? null : required > available ? required - available : 0n);
                }
                for (const o of obligations) {
                    const remaining = o.amount === null ? null : o.amount - o.paid(asOf);
                    if (remaining !== null && remaining <= 0n)
                        continue;
                    const gap = gaps.get(o.dueDate);
                    rows.push({ sourceId: o.sourceId, sourceKind: o.sourceKind, dueDate: o.dueDate, amount: remaining === null ? null : money(remaining), kind: o.kind, confirmedAvailable: money(cash.get(cut(o.dueDate)) ?? 0n), shortfall: o.kind === 'PROJECTED' || gap === null || gap === undefined ? null : money(gap) });
                }
                rows.sort((a, b) => String(a['dueDate']).localeCompare(String(b['dueDate'])) || String(a['sourceId']).localeCompare(String(b['sourceId'])));
                if (rows.some(r => r['amount'] === null)) {
                    meta.coverage = 'INCOMPLETE';
                    meta.reasons.push('UNPRICED_OBLIGATION');
                }
            }
            else if (operation.toLowerCase().includes('expense') && !operation.toLowerCase().includes('rule'))
                rows = (await historical(m, table(scope.kind, 'expenses'), scope, s, known, book.recordedAt <= known)).map(e => publicExpense(e, byEntity.get(e._id) ?? []));
            else if (operation.toLowerCase().includes('rule'))
                rows = (await historical(m, table(scope.kind, 'expense_rules'), scope, s, known, book.recordedAt <= known)).map(r => ({ id: r._id, version: r.version, frequency: r.frequency, startDate: r.startDate, ...(r.endDate ? { endDate: r.endDate } : {}), effectiveFrom: r.effectiveFrom, amountMode: r.amountMode, ...(r.amount !== undefined ? { amount: r.amount } : {}) }));
            else if (operation.toLowerCase().includes('liabilit'))
                for (let l of await historical(m, table(scope.kind, 'liabilities'), scope, s, known, book.recordedAt <= known)) {
                    l = await effectiveTerms(contextFor(m, scope, s), l, asOf, known, versionsByEntity.get(l._id) ?? []);
                    rows.push({ ...publicLiability(l, byEntity.get(l._id) ?? []), projections: (versionsByEntity.get(l._id) ?? []).filter(v => v.recordedAt <= known && v['schedule'].kind === 'PROJECTED').map(v => v['schedule']) });
                }
            else
                throw new AppError(422, 'INPUT_INVALID');
            const id = params['expenseId'] ?? params['ruleId'] ?? params['liabilityId'] ?? params['accountId'];
            if (id) {
                const r = rows.find(x => x['id'] === id);
                if (!r)
                    throw new AppError(404, 'RESOURCE_NOT_FOUND');
                return { status: 200, data: r, ...(isAccounts ? {} : { meta }), etag: '"' + id + ':' + r['version'] + '"' };
            }
            if (!operation.toLowerCase().includes('agenda'))
                rows.sort((a, b) => String(a['id']).localeCompare(String(b['id'])));
            const cursor = query['cursor'] === undefined ? undefined : open(tokenKey, query['cursor']);
            if (cursor && (cursor.kind !== 'CURSOR' || cursor.binding !== hash({ token, operation, limit }) || !Number.isInteger(cursor.offset) || cursor.offset < 0))
                throw new AppError(422, 'INPUT_INVALID');
            const offset = cursor?.offset ?? 0, items = rows.slice(offset, offset + limit), nextCursor = offset + limit < rows.length ? seal(tokenKey, { kind: 'CURSOR', binding: hash({ token, operation, limit }), offset: offset + limit }) : null;
            if (performance.now() - started > 10000)
                throw new AppError(503, 'REPORT_BUDGET_EXCEEDED');
            return { status: 200, data: { items, nextCursor }, ...(isAccounts ? {} : { meta }) };
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    });
    await m.leave(barrier, started);
    if (oldBarrier)
        await m.identity.reporting.projection.leave(oldBarrier, started);
    return answer;
}
//# sourceMappingURL=queries.js.map