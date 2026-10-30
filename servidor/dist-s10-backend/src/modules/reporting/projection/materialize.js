/* eslint-disable security/detect-object-injection -- Versioned internal source fields and closed collection map. */
import { BSON, Decimal128 } from 'mongodb';
import { hash, copy, encode } from './codec.js';
import { collections } from './catalog.js';
import { reconstruct } from '../engine.js';
import { money, storedCents } from '../../finance/money.js';
export const tableRoot = (rows) => ({ count: rows.length, hash: hash(rows.map(row => [row._id, hash(row)]).sort(([a], [b]) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)) });
const pick = (row, fields) => Object.fromEntries(fields.map(key => [key, row[key]]).filter(([, value]) => value !== undefined));
const compactEvent = (event) => ({ ...pick(event, ['_id', 'organizationId', 'borrowerId', 'actorId', 'kind', 'effectiveDate', 'recordedAt', 'journalId', 'loanIds']),
    plan: pick(event.plan, ['postings', 'allocations', 'accruals', 'creditChange']) });
export const systemAuthority = (org) => ({ actorId: 'SYSTEM_PROJECTION', organizationId: org, roles: ['T'], isT: true, isC: false, isO: false, isP: false, loanIds: [], scopeKind: 'ORGANIZATION', binding: 'INTERNAL_DERIVATION_ONLY' });
const byId = (a, b) => String(a['_id']).localeCompare(String(b['_id']));
export function materialize(source, org, generation) {
    const tables = new Map([[collections.units, []], [collections.flows, []], [collections.rows, []]]);
    const knowledgeMax = source.dataThrough ?? '0001-01-01T00:00:00.000Z';
    const economicMax = [...(source.fundDeltas ?? []).map(d => d.effectiveDate), ...source.events.map(e => e.effectiveDate), ...source.journals.map(j => j.effectiveDate),
        ...source.compensations.map(c => String(c['effectiveDate']))].sort().at(-1) ?? '0001-01-01';
    const sourceCounts = { loans: source.positions.length, events: source.events.length + (source.managementEvents?.length ?? 0), lines: source.journals.reduce((n, j) => n + j.lines.length, 0) };
    const accrualIds = new Set(source.events.filter(e => e.kind === 'ACCRUE').map(e => e._id));
    let eligible = economicMax <= source.currentDate && !source.compensations.some(c => accrualIds.has(String(c['originalEventId'])));
    const add = (table, id, data) => tables.get(table).push({ _id: org + ':' + generation + ':' + id, organizationId: org, generation, formatVersion: 1, ...data });
    if (eligible) {
        const positions = new Map(source.positions.map(p => [p.loanId, p]));
        const borrowers = new Map(source.borrowers.map(b => [b._id, b]));
        const schedules = new Map(), installments = new Map();
        for (const schedule of source.schedules) {
            const rows = schedules.get(schedule.loanId) ?? [];
            rows.push(pick(schedule, ['_id', 'loanId', 'version', 'eventId', 'createdAt']));
            schedules.set(schedule.loanId, rows);
        }
        for (const installment of source.installments) {
            const rows = installments.get(installment.loanId) ?? [];
            rows.push(pick(installment, ['_id', 'loanId', 'scheduleVersion', 'number', 'dueDate', 'principal', 'interest', 'supersededByVersion']));
            installments.set(installment.loanId, rows);
        }
        for (const loan of source.loans) {
            const borrower = borrowers.get(loan.borrowerId);
            add(collections.units, 'LOAN:' + loan._id, { kind: 'LOAN', sourceId: loan._id,
                loan: { ...pick(loan, ['_id', 'organizationId', 'borrowerId', 'status']), terms: { principal: loan.terms.principal } },
                borrower: { ...pick(borrower, ['_id', 'borrowerCode']), profile: { displayName: borrower.profile.displayName } },
                position: positions.get(loan._id), schedules: (schedules.get(loan._id) ?? []).sort(byId), installments: (installments.get(loan._id) ?? []).sort(byId) });
        }
        const cubes = new Map();
        const ordinary = [];
        for (const event of source.events) {
            if (event.kind !== 'ACCRUE') {
                ordinary.push(compactEvent(event));
                continue;
            }
            const key = encode([event.effectiveDate, event.borrowerId, event.actorId, event.loanIds]);
            let cube = cubes.get(key);
            if (!cube) {
                cube = { ...compactEvent(event), _id: 'DERIVED_ACCRUAL:' + hash(key), plan: { ...event.plan, postings: [], allocations: [], accruals: [], scheduleRevisions: [], positions: [], creditChange: null } };
                cubes.set(key, cube);
            }
            if (cube.recordedAt < event.recordedAt)
                cube.recordedAt = event.recordedAt;
            cube.plan.accruals.push(...copy(event.plan.accruals));
        }
        for (const [key, event] of cubes) {
            event.plan.accruals.sort((a, b) => encode(a).localeCompare(encode(b)));
            add(collections.flows, 'ACCRUAL:' + hash(key), { family: 'ACCRUAL', day: event.effectiveDate, sourceEvent: event });
        }
        // The current-only ledger unit is a computation input, never a financial_journal.
        // Actual delivery journals remain separate for their identity/date predicates.
        const deliveryIds = new Set(source.deliveries.map(d => String(d['journalId'])));
        const retained = source.journals.filter(j => deliveryIds.has(j._id)).sort(byId);
        const ledger = new Map();
        for (const journal of source.journals) {
            if (deliveryIds.has(journal._id))
                continue;
            for (const line of journal.lines)
                ledger.set(line.accountId, (ledger.get(line.accountId) ?? 0n) + storedCents(line.debit) - storedCents(line.credit));
        }
        const ledgerInput = { _id: 'DERIVED_LEDGER_INPUT', effectiveDate: source.currentDate, recordedAt: knowledgeMax,
            lines: [...ledger].sort(([a], [b]) => a.localeCompare(b)).map(([accountId, balance]) => ({ accountId, debit: Decimal128.fromString(money(balance > 0n ? balance : 0n)), credit: Decimal128.fromString(money(balance < 0n ? -balance : 0n)) })) };
        const metadata = { ...source, loans: [], borrowers: [], positions: [], schedules: [], installments: [], events: ordinary.sort(byId),
            journals: [ledgerInput, ...retained], snapshots: [], knownThrough: knowledgeMax };
        for (const key of ['compensations', 'payments', 'paymentTransitions', 'custody', 'held', 'deliveries', 'facts', 'actions', 'journeys', 'stations', 'bindings', 'reconciliation', 'opening', 'accounts']) {
            const rows = metadata[key];
            if (rows)
                metadata[key] = [...rows].sort(byId);
        }
        add(collections.units, 'METADATA', { kind: 'METADATA', data: metadata });
        // Persist only a represented row family. Other report families use canonical
        // replay rather than exposing synthetic cube IDs as original event IDs.
        const canonical = reconstruct(source, { asOf: source.currentDate, from: '0001-01-01', to: source.currentDate, recordedThrough: source.knownThrough ?? knowledgeMax }, systemAuthority(org));
        for (const row of canonical.rows.PORTFOLIO)
            add(collections.rows, 'PORTFOLIO:' + String(row['id']), { report: 'PORTFOLIO', data: row });
    }
    // Keep pre+post change events safely below Mongo's event/document limit. An
    // unrepresentable current view uses canonical replay; it never truncates data
    // or rejects a legitimate writer merely because its compact row grew too large.
    if ([...tables.values()].some(rows => rows.some(row => BSON.serialize(row).length > 4 * 1024 * 1024))) {
        eligible = false;
        for (const rows of tables.values())
            rows.length = 0;
    }
    const roots = {};
    const nodes = [];
    for (const [table, rows] of tables) {
        roots[table] = tableRoot(rows);
        nodes.push({ _id: org + ':' + generation + ':ROOT:' + table, organizationId: org, generation, formatVersion: 1, table, ...roots[table] });
    }
    tables.set(collections.nodes, nodes);
    roots[collections.nodes] = tableRoot(nodes);
    return { tables, roots, eligible, viewDate: source.currentDate, knowledgeMax, economicMax, sourceCounts };
}
export function unpack(units, flows) {
    const meta = units.find(row => row['kind'] === 'METADATA');
    if (!meta)
        throw new Error('Missing projection metadata');
    const loans = units.filter(row => row['kind'] === 'LOAN');
    const borrowers = new Map(loans.map(row => [row['borrower']['_id'], row['borrower']]));
    return { ...meta['data'], loans: loans.map(row => row['loan']), borrowers: [...borrowers.values()],
        positions: loans.map(row => row['position']), schedules: loans.flatMap(row => row['schedules']),
        installments: loans.flatMap(row => row['installments']), events: [...meta['data'].events, ...flows.map(row => row['sourceEvent'])] };
}
//# sourceMappingURL=materialize.js.map