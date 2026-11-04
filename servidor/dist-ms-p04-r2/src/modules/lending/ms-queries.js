import { effectiveReserves } from '../collections/funds.js';
/* eslint-disable security/detect-object-injection -- Fixed metric/component keys and authenticated versioned metadata. */
import { randomUUID } from 'node:crypto';
import { msStableId } from './ms-service.js';
import { table, relationships, etag } from '../obligations/models.js';
import { wealthTable, signedCents } from '../wealth/models.js';
import { ledgerSources } from '../wealth/sources.js';
import { fundCommand, consume } from '../wealth/funds.js';
import { liabilityPosition, liabilityCommand, effectiveTerms } from '../obligations/liabilities.js';
import { storedCents } from '../finance/money.js';
import { today } from '../finance/service.js';
import { authorityBinding, personalActor, resolveScope, grant } from '../obligations/authority.js';
import { beginEvidence } from './evidence-v2.js';
import { stateOf } from './operations-service.js';
import { monthlyPosition, monthlySavings, distributeMonthly, summarizeMonthly, msCents, msMoney, msDate, msDue, monthlyInterest, newMonthlyState } from './ms-engine.js';
import { monthlyEngineState, periodRows, monthlySchedule } from './ms-adapter.js';
import { domainCollection } from './evidence-v2.js';
import { hash } from './contract.js';
import { encryptMsToken, decryptMsToken, issueMsExecution, withMsExecution } from './ms-history.js';
import { AppError } from '../../shared/errors.js';
const fail = (code, status = 409) => { throw new AppError(status, code); };
const metric = (value, reason) => ({ value, status: reason ? 'INCOMPLETE' : 'COMPLETE', reasons: reason ? [reason] : [], sourceRefs: [] });
const sum = (xs) => msMoney(xs.reduce((n, v) => n + msCents(v), 0n));
const visible = (e, E, K) => e.effectiveDate <= E && (e.unitKnownAt ?? e.recordedAt) <= K;
const installmentId = (row, n) => msStableId(row._id, row.schedule.id, String(n));
async function cuts(ms, u, q) {
    const E = String(q['effectiveDate'] ?? today(ms.identity.now())), K = String(q['knownAt'] ?? new Date(ms.identity.now()).toISOString());
    msDate(E);
    if (E > today(ms.identity.now()) || !Number.isFinite(Date.parse(K)) || Date.parse(K) > ms.identity.now())
        fail('INPUT_INVALID', 422);
    const mapping = (await ms.rows('ms_mappings', u.scope, u.s)).filter(r => r.recordedAt <= K && String(r['effectiveFrom']) <= E).sort((a, b) => String(a['effectiveFrom']).localeCompare(String(b['effectiveFrom'])) || a.version - b.version).at(-1);
    return { effectiveDate: E, knownAt: K, sourceVector: hash({ tag: u.sourceTag, E }), mappingVersion: mapping ? mapping._id + ':' + mapping.version : 'UNAVAILABLE', contractVersion: '1.0.3', currency: 'COP', timezone: 'America/Bogota' };
}
async function loans(ms, u) { u.budget(); if (u.scope.kind !== 'BUSINESS')
    return []; const unit = await beginEvidence(ms.identity.database, u.s, u.scope.bookId), rows = await unit.query('lending_monthly_loans', { organizationId: u.scope.bookId, status: 'MONTHLY_ACTIVE' }, { _id: 1 }, 10001); if (rows.length > 10000)
    fail('MS_SCOPE_TOO_LARGE', 422); return rows; }
async function positions(ms, u, c) {
    const out = [];
    for (const l of await loans(ms, u)) {
        u.budget();
        const state = await stateOf(ms.identity.database, l, u.s);
        if (!state?.position.monthlyState)
            fail('INTEGRITY_MISMATCH', 503);
        const s = state.position.monthlyState;
        if (s.createdAt > c.knownAt || s.terms.effectiveDate > c.effectiveDate)
            continue;
        const p = monthlyPosition(s, c.effectiveDate, c.knownAt), period = s.periods.filter(p => p.fixedAt <= c.knownAt && p.startDate <= c.effectiveDate).at(-1), expected = p.principal === '0.00' && p.interestDue === '0.00' ? '0.00' : period?.interest ?? null;
        out.push({ id: l._id, bookId: u.scope.bookId, borrowerId: l.borrowerId, termsVersion: period?.termsVersion ?? 1, status: p.principal === '0.00' && p.interestDue === '0.00' ? 'SETTLED' : 'ACTIVE', effectiveDate: c.effectiveDate, anchor: l.terms.anchor, monthlyRate: period?.rate ?? l.terms.monthlyRate, principalOutstanding: metric(p.principal), principalOverdue: metric('0.00'), interestExpected: metric(expected, expected === null ? 'PERIOD_NOT_FIXED' : undefined), interestDueUnrecognized: metric(p.interestDueUnrecognized), interestOverdue: metric(p.interestOverdue), interestRecognized: metric(p.interestRecognized), interestCashCollected: metric(p.interestCashCollected), interestSatisfiedByCredit: metric(p.interestSatisfiedByCredit), overduePeriodCount: p.overduePeriodCount, oldestUnpaidDueDate: p.oldestUnpaidDueDate, cuts: c });
    }
    return out;
}
function page(ms, u, operation, q, rows, c) {
    const binding = hash({ actor: authorityBinding(u.actor, u.context, u.book), operation, book: u.scope.bookId, query: { ...q, cursor: undefined }, cuts: c });
    let offset = 0;
    if (q['cursor']) {
        const token = decryptMsToken(ms.identity, String(q['cursor']), 'CURSOR');
        if (token.binding !== binding || token.expires <= ms.identity.now() || !Number.isInteger(token.offset) || token.offset < 0)
            fail('PRECONDITION_FAILED', 412);
        offset = token.offset;
    }
    return { rows: rows.slice(offset, offset + 100), totalCount: rows.length, nextCursor: offset + 100 < rows.length ? encryptMsToken(ms.identity, { binding, offset: offset + 100, expires: ms.identity.now() + 300000 }, 'CURSOR') : null };
}
export async function msBookData(ms, u, q) {
    const c = await cuts(ms, u, q), E = c.effectiveDate, K = c.knownAt, source = await ledgerSources(ms.identity.wealth, u.scope, u.s), cashIds = new Set(source.accounts.filter(a => ['CASH', 'BANK'].includes(a.kind)).map(a => a._id));
    const journal = source.journals.filter(j => visible(j, E, K)), balances = new Map();
    for (const j of journal)
        for (const l of j.lines)
            balances.set(l.accountId, (balances.get(l.accountId) ?? 0n) + storedCents(l.debit) - storedCents(l.credit));
    const cash = [...cashIds].reduce((n, id) => n + (balances.get(id) ?? 0n), 0n), funds = await ms.rows(wealthTable(u.scope.kind, 'funds'), u.scope, u.s), reservedByFund = await ms.identity.wealth.reserved(u.scope, u.s, E, K), protection = u.scope.kind === 'BUSINESS' ? await effectiveReserves(ms.identity.database, u.scope.bookId, u.s, E, K) : funds.map(f => ({ accountId: f.backingAccountId, amount: msMoney(reservedByFund.get(f._id) ?? 0n) })), reserved = protection.reduce((n, r) => n + msCents(r.amount), 0n), flows = [], events = (await ms.rows(table(u.scope.kind, 'events'), u.scope, u.s)).filter(e => visible(e, E, K));
    const claimedJournals = new Set();
    // Recognition is not a cash payment. S09 expense journals are represented by
    // their actual payment events, rather than counted again as generic expenses.
    for (const e of events)
        if (e.kind.startsWith('EXPENSE_'))
            for (const id of e.journalIds)
                claimedJournals.add(id);
    for (const e of events) {
        let kind = null;
        if (e.kind === 'EXPENSE_PAY' || e.kind === 'EXPENSE_RECOGNIZE_PAY' || e.kind === 'EXPENSE_PAYMENT' || e.kind === 'EXPENSE_RECOGNIZE_AND_PAY')
            kind = 'EXPENSE_PAID';
        else if (e.kind === 'LIABILITY_PAY' || e.kind === 'LIABILITY_PREPAY')
            kind = 'DEBT_PAID';
        if (e.kind === 'EXPENSE_PAYMENT_REVERSE')
            kind = 'EXPENSE_PAID';
        if (e.kind === 'LIABILITY_EVENT_REVERSE' && ['LIABILITY_PAY', 'LIABILITY_PREPAY'].includes(String(e.components['originalKind'])))
            kind = 'DEBT_PAID';
        if (kind) {
            flows.push({ id: e._id, bookId: u.scope.bookId, effectiveDate: e.effectiveDate, knownAt: e.unitKnownAt, kind, amount: (e.reversalOfId ? '-' : '') + e.amount });
            for (const id of e.journalIds)
                claimedJournals.add(id);
        }
    }
    const relations = await ms.rows(relationships, u.scope, u.s);
    for (const r of relations) {
        if (String(r['effectiveDate']) > E || String(r['unitKnownAt']) > K)
            continue;
        const from = r['fromScope'] === u.scope.kind, amount = (from ? '-' : '') + String(r['amount']);
        flows.push({ id: 'relationship:' + r._id + ':' + u.scope.bookId, bookId: u.scope.bookId, effectiveDate: String(r['effectiveDate']), knownAt: String(r['unitKnownAt']), kind: 'FUNDING_TRANSFER', amount, relationshipId: r._id, relationshipLeg: 'ORIGIN', alreadyDistributedSource: Boolean(r['msDistributionId']) });
        claimedJournals.add(String(r[u.scope.kind === 'BUSINESS' ? 'businessJournalId' : 'personalJournalId']));
    }
    // Read actual reversal journals at their own E/K; never erase the origin from
    // its month. BUSINESS uses only its own signed events, without PERSONAL reads.
    for (const e of events.filter(e => e.components['relationshipId'] && e.kind.startsWith('INTERBOOK_') && (u.scope.kind === 'BUSINESS' || e.kind === 'INTERBOOK_REVERSE'))) {
        const j = journal.find(j => e.journalIds.includes(j._id));
        if (!j)
            fail('SOURCE_INCONSISTENT', 503);
        const amount = j.lines.filter(l => cashIds.has(l.accountId)).reduce((n, l) => n + storedCents(l.debit) - storedCents(l.credit), 0n), relationId = String(e.components['relationshipId']), origin = events.find(v => v.components['relationshipId'] === relationId && v.kind !== 'INTERBOOK_REVERSE');
        flows.push({ id: 'relationship-event:' + e._id + ':' + u.scope.bookId, bookId: u.scope.bookId, effectiveDate: e.effectiveDate, knownAt: e.unitKnownAt, kind: 'FUNDING_TRANSFER', amount: msMoney(amount), relationshipId: relationId, relationshipLeg: e.kind === 'INTERBOOK_REVERSE' ? 'REVERSAL' : 'ORIGIN', alreadyDistributedSource: Boolean(origin?.components['msDistributionId']) });
        claimedJournals.add(j._id);
    }
    const incomeIds = new Set(source.accounts.filter(a => a.accountClass === 'INCOME').map(a => a._id)), expenseIds = new Set(source.accounts.filter(a => a.accountClass === 'EXPENSE').map(a => a._id)), monthlyIncome = new Set();
    let expectedMonth = 0n;
    for (const l of await loans(ms, u)) {
        monthlyIncome.add(l.profile.interestIncomeAccountId);
        const state = await stateOf(ms.identity.database, l, u.s);
        if (!state?.position.monthlyState)
            fail('INTEGRITY_MISMATCH', 503);
        const s = state.position.monthlyState;
        for (const p of s.periods)
            if (p.fixedAt <= K && p.dueDate <= E && p.dueDate.startsWith(String(q['month'])))
                expectedMonth += msCents(p.contractualInterest ?? p.interest);
        for (const f of s.facts.filter(f => visible(f, E, K))) {
            if (f.kind === 'CREDIT_APPLICATION')
                continue;
            if (f.kind === 'COMPENSATION' && s.facts.find(v => v.id === f.reverses)?.kind === 'CREDIT_APPLICATION')
                continue;
            flows.push({ id: 'interest:' + l._id + ':' + f.id, bookId: u.scope.bookId, effectiveDate: f.effectiveDate, knownAt: f.recordedAt, kind: 'INTEREST_CASH', amount: (f.kind === 'COMPENSATION' ? '-' : '') + sum(f.interest.map(a => a.amount)) });
        }
    }
    for (const j of journal) {
        if (claimedJournals.has(j._id))
            continue;
        const income = j.lines.filter(l => incomeIds.has(l.accountId) && !monthlyIncome.has(l.accountId)).reduce((n, l) => n + storedCents(l.credit) - storedCents(l.debit), 0n), expense = j.lines.filter(l => expenseIds.has(l.accountId)).reduce((n, l) => n + storedCents(l.debit) - storedCents(l.credit), 0n);
        if (income)
            flows.push({ id: 'income:' + j._id, bookId: u.scope.bookId, effectiveDate: j.effectiveDate, knownAt: j.recordedAt, kind: 'EXTERNAL_INCOME', amount: msMoney(income) });
        if (expense)
            flows.push({ id: 'expense:' + j._id, bookId: u.scope.bookId, effectiveDate: j.effectiveDate, knownAt: j.recordedAt, kind: 'EXPENSE_PAID', amount: msMoney(expense) });
    }
    const currentLinks = await ms.rows('ms_savings_links', u.scope, u.s), linkHistory = (await ms.rows(table(u.scope.kind, 'history'), u.scope, u.s)).filter(r => r['entityTable'] === 'ms_savings_links').map(r => r['payload']), allLinks = [...linkHistory, ...currentLinks].filter(r => r.recordedAt <= K).sort((a, b) => a.version - b.version), links = [...new Map(allLinks.map(r => [r._id, r])).values()], fundEvents = (await ms.rows(wealthTable(u.scope.kind, 'fund_events'), u.scope, u.s)).filter(e => visible(e, E, K));
    for (const e of fundEvents) {
        const debt = e.deltas.filter(d => links.some(l => l['fundId'] === d.fundId)).reduce((n, d) => n + signedCents(d.delta), 0n);
        if (debt)
            flows.push({ id: 'saving:' + e._id, bookId: u.scope.bookId, effectiveDate: e.effectiveDate, knownAt: e.unitKnownAt, kind: 'DEBT_RESERVATION', amount: msMoney(debt) });
    }
    const distributions = (await ms.rows('ms_distributions', u.scope, u.s)).filter(r => visible({ effectiveDate: String(r['effectiveDate']), recordedAt: r.recordedAt }, E, K));
    for (const d of distributions)
        flows.push({ id: 'distribution:' + d._id, bookId: u.scope.bookId, effectiveDate: String(d['effectiveDate']), knownAt: d.recordedAt, kind: 'DISTRIBUTION', amount: (d['kind'] === 'REVERSE' ? '-' : '') + String(d['amount']) });
    return { c, expectedMonth, source, journal, balances, cashIds, cash, reserved, protection, reservedByFund, funds, links, flows, distributions, events, relations };
}
async function monthlyView(ms, u, q) {
    const raw = await msBookData(ms, u, q), rows = await positions(ms, u, raw.c), s = summarizeMonthly(raw.flows, [u.scope.bookId], String(q['month']), raw.c.effectiveDate, raw.c.knownAt), value = (k) => sum(rows.map(r => r[k].value));
    const view = { bookId: u.scope.bookId, scope: u.scope.kind, month: String(q['month']), cuts: raw.c, interestExpectedThisMonth: metric(msMoney(raw.expectedMonth)), principal: metric(value('principalOutstanding')), availableToLend: metric(msMoney(raw.cash - raw.reserved)), cash: metric(msMoney(raw.cash)), reserved: metric(msMoney(raw.reserved)), free: metric(msMoney(raw.cash - raw.reserved)), interestExpected: metric(value('interestExpected')), interestCashCollected: metric(sum(raw.flows.filter(f => f.kind === 'INTEREST_CASH' && f.effectiveDate.startsWith(String(q['month']))).map(f => f.amount))), otherIncome: metric(sum(raw.flows.filter(f => f.kind === 'EXTERNAL_INCOME' && f.effectiveDate.startsWith(String(q['month']))).map(f => f.amount))), fundingTransfers: metric(s.funding), paidExpenses: metric(s.expenses), paidDebtInstallments: metric(s.debt), debtSavings: metric(s.savings), baseSurplus: metric(s.baseSurplus), distributedSurplus: metric(s.distributedSurplus), remainingSurplus: metric(s.remainingSurplus) };
    return { view, raw };
}
export async function queryMs(ms, context, operation, params, q, u) {
    if (operation === 'msGetConsolidatedMonthlyView') {
        await ms.requireActive();
        const first = await ms.identity.database.client.withSession(async (s) => { const { actor } = await personalActor(ms.identity, context, s); if (!actor.organizationId)
            fail('ACCESS_DENIED', 403); const p = await resolveScope(ms.identity, context, 'PERSONAL', undefined, s); return { business: actor.organizationId, personal: p.scope.bookId }; });
        // Both books and their cuts must be read from one Mongo snapshot.
        return await ms.readUnit(context, first.business, async (b) => { const p = await ms.scope(context, first.personal, b.s); const declarations = await ms.rows('s09_ownership_declarations', b.scope, b.s), eligible = declarations.filter(r => r['subjectId'] === p.actor._id && String(r['validFrom']) <= today(ms.identity.now())).sort((a, z) => a.version - z.version).at(-1); if (!eligible || eligible['right'] !== 'FULL_OWNERSHIP' || eligible['percentage'] !== '100.00')
            fail('ACCESS_DENIED', 403); const pu = { ...b, ...p, sourceTag: await ms.tag(p.scope, b.s) }, a = await monthlyView(ms, b, q), z = await monthlyView(ms, pu, q), flows = [...a.raw.flows, ...z.raw.flows], s = summarizeMonthly(flows, [first.business, first.personal], String(q['month']), a.raw.c.effectiveDate, a.raw.c.knownAt, true); return { status: 200, data: { scope: 'CONSOLIDATED', month: q['month'], cuts: { ...a.raw.c, sourceVector: hash([a.raw.c, z.raw.c]), mappingVersion: hash([a.raw.c.mappingVersion, z.raw.c.mappingVersion]) }, books: [a.view, z.view], eliminatedRelationships: [...new Set(flows.filter(f => f.relationshipId).map(f => f.relationshipId))], totalCash: metric(msMoney(a.raw.cash + z.raw.cash)), totalFree: metric(msMoney(a.raw.cash + z.raw.cash - a.raw.reserved - z.raw.reserved)), totalReserved: metric(msMoney(a.raw.reserved + z.raw.reserved)), baseSurplus: metric(s.baseSurplus), actionable: false } }; });
    }
    if (!u)
        fail('SERVICE_UNAVAILABLE', 503);
    const unit = u, c = await cuts(ms, unit, q);
    if (operation === 'msGetInterbookOptions') {
        if (unit.scope.kind !== 'PERSONAL' || !unit.actor.organizationId)
            fail('ACCESS_DENIED', 403);
        const business = await ms.scope(context, unit.actor.organizationId, unit.s);
        if (business.scope.kind !== 'BUSINESS')
            fail('ACCESS_DENIED', 403);
        const now = today(ms.identity.now()), declarations = (await ms.rows('s09_ownership_declarations', business.scope, unit.s)).filter(r => r['subjectId'] === unit.actor._id && String(r['validFrom']) <= now).sort((a, b) => a.version - b.version), eligible = declarations.at(-1);
        const allowed = eligible?.['right'] === 'FULL_OWNERSHIP' && eligible['percentage'] === '100.00' && String(eligible['validFrom']) <= c.effectiveDate;
        const roots = allowed ? (await ms.rows('s09_relationships', unit.scope, unit.s)).filter(r => r['businessBookId'] === business.scope.bookId && r['kind'] === 'CONTRIBUTION' && r['fromScope'] === 'PERSONAL' && r['rootRelationshipId'] === null && r['status'] === 'POSTED' && msCents(String(r['remaining'])) > 0n && String(r['effectiveDate']) <= c.effectiveDate).sort((a, b) => String(a['effectiveDate']).localeCompare(String(b['effectiveDate'])) || a._id.localeCompare(b._id)) : [];
        const personalAccounts = await ms.rows('s09_personal_accounts', unit.scope, unit.s), businessAccounts = await ms.identity.finance.accounts.find({ organizationId: business.scope.bookId, ownerId: business.scope.ownerId, financialScope: 'BUSINESS', status: 'ACTIVE', currency: 'COP' }, { session: unit.s }).limit(101).toArray();
        if (roots.length > 100 || personalAccounts.length > 100 || businessAccounts.length > 100)
            fail('MS_SCOPE_TOO_LARGE', 422);
        const account = (r) => ({ id: r._id, code: r.code, name: r.name, accountClass: r.accountClass, kind: r.kind });
        return { status: 200, data: { personalBookId: unit.scope.bookId, organizationId: business.scope.bookId, metadataTime: 'CURRENT_AUTHORITY', personalAccounts: personalAccounts.filter(r => r['status'] === 'ACTIVE' && r['currency'] === 'COP').map(account), businessAccounts: businessAccounts.map(account), eligibilities: allowed ? [{ id: eligible._id, validFrom: eligible['validFrom'], percentage: '100.00' }] : [], contributions: roots.map(r => ({ id: r._id, effectiveDate: r['effectiveDate'], remaining: r['remaining'], sourceEventIds: r['sourceEventIds'], personalContraAccountId: r['personalContraAccountId'], businessContraAccountId: r['businessContraAccountId'] })) } };
    }
    if (operation === 'msListMappingVersions') {
        const rows = (await ms.rows('ms_mappings', unit.scope, unit.s)).filter(r => r.recordedAt <= c.knownAt).sort((a, b) => a.version - b.version).map(r => { const { _id, bookId, ownerId, domainKind, version, mac, recordedAt, ...mapping } = r; void ownerId; void domainKind; void mac; void recordedAt; return { id: _id, bookId, version, digest: hash(mapping), mapping }; });
        return { status: 200, data: page(ms, unit, operation, q, rows, c) };
    }
    if (operation === 'msListDebtPlans') {
        const rows = (await ms.rows('ms_debt_plans', unit.scope, unit.s)).filter(r => r.recordedAt <= c.knownAt).sort((a, b) => a._id.localeCompare(b._id)).map(r => ({ id: r._id, bookId: r.bookId, version: r.version, status: r['status'], details: r['details'], paymentCoverage: 'INCOMPLETE' }));
        return { status: 200, data: page(ms, unit, operation, q, rows, c) };
    }
    if (operation === 'msGetMonthlyView')
        return { status: 200, data: (await monthlyView(ms, unit, q)).view, etag: unit.sourceTag };
    if (operation === 'msGetMonthlyPosition' || operation === 'msListMonthlyPositions') {
        if (unit.scope.kind !== 'BUSINESS')
            fail('ACCESS_DENIED', 403);
        const rows = await positions(ms, unit, c);
        if (operation === 'msGetMonthlyPosition') {
            const row = rows.find(r => r['id'] === params['loanId']);
            if (!row)
                fail('RESOURCE_NOT_FOUND', 404);
            return { status: 200, data: row, etag: etag(await ms.loan(unit.scope.bookId, params['loanId'], unit.s)) };
        }
        return { status: 200, data: { ...page(ms, unit, operation, q, rows, c), totalsScope: 'FULL_FILTER', principalTotal: metric(sum(rows.map(r => r['principalOutstanding'].value))), interestExpectedTotal: metric(sum(rows.map(r => r['interestExpected'].value))), cuts: c } };
    }
    if (operation === 'msGetSavingsPlan') {
        const raw = await msBookData(ms, unit, q), rows = [];
        for (const link of raw.links) {
            unit.budget();
            const row = await ms.management.store.get(table(unit.scope.kind, 'liabilities'), String(link['liabilityId']), unit.scope, unit.s), base = ms.management.context(unit.context, unit.scope, unit.s, {}, {}, [], []), l = await effectiveTerms(base, row, c.effectiveDate, c.knownAt), i = l.schedule.installments.find(i => installmentId(l, i.number) === link['installmentId']);
            if (!i)
                fail('SOURCE_INCONSISTENT', 503);
            const paid = liabilityPosition(raw.events.filter(e => e.entityId === l._id)).paid, quota = ['PRINCIPAL', 'INTEREST', 'INSURANCE', 'FEES'].reduce((n, k) => n + msCents(String(i[k.toLowerCase()])) - (paid.get(l.schedule.id + ':' + i.number + ':' + k) ?? 0n), 0n), reserved = raw.reservedByFund.get(String(link['fundId'])) ?? 0n, s = monthlySavings(msMoney(quota), msMoney(reserved), link['opportunityDates'].filter(d => d >= c.effectiveDate), i.dueDate);
            rows.push({ liabilityId: l._id, installmentId: link['installmentId'], dueDate: i.dueDate, quotaTotal: metric(msMoney(quota)), reservedExclusive: metric(msMoney(reserved)), shortfall: metric(s.shortfall), opportunityDates: s.dates, recommendations: s.amounts.map(v => metric(v)), officialPaymentCoverage: l.schedule.kind === 'OFFICIAL_DECLARED' ? 'COMPLETE' : 'INCOMPLETE' });
        }
        const drafts = (await ms.rows('ms_debt_plans', unit.scope, unit.s)).filter(r => r.recordedAt <= c.knownAt);
        for (const d of drafts) {
            const details = d['details'];
            rows.push({ liabilityId: d._id, installmentId: null, dueDate: details['nextDueDate'], quotaTotal: metric(details['declaredQuota'], 'DECLARED_PLAN_NOT_OFFICIAL'), reservedExclusive: metric(null, 'NO_EXCLUSIVE_OFFICIAL_QUOTA_BINDING'), shortfall: metric(null, 'OFFICIAL_COMPONENTS_OR_CALENDAR_UNKNOWN'), opportunityDates: [], recommendations: [], officialPaymentCoverage: 'INCOMPLETE' });
        }
        rows.sort((a, b) => String(a['dueDate']).localeCompare(String(b['dueDate'])) || String(a['installmentId']).localeCompare(String(b['installmentId'])));
        return { status: 200, data: { bookId: unit.scope.bookId, cuts: c, startMonth: q['month'], horizonMonths: 12, ...page(ms, unit, operation, q, rows, c), totalsScope: 'FULL_FILTER', totalShortfall: drafts.length ? metric(null, 'OFFICIAL_COMPONENTS_OR_CALENDAR_UNKNOWN') : metric(sum(rows.map(r => r['shortfall'].value))) } };
    }
    return fail('INPUT_INVALID', 422);
}
function wealthContext(ms, u, p, params, id = randomUUID()) {
    const base = ms.management.context(u.context, u.scope, u.s, p, params, u.eventIds, u.journalIds), c = { system: ms.identity.wealth, scope: u.scope, s: u.s, actor: u.actor, auth: u.context, payload: p, params, unitId: id, eventKind: '', entityId: params['fundId'] ?? '', amount: '0.00', deltas: [], details: { msComposite: true }, reversalOfId: null, base, post: async (kind, amount, lines, details = {}) => { const e = await base.post(c.entityId, kind, String(p['effectiveDate']), amount, lines, [], { msCompositeId: id, ...details }); return e.journalIds[0]; } };
    return c;
}
export async function prepareMsComposite(ms, u, operation, p) {
    const E = String(p['effectiveDate']);
    msDate(E);
    if (E > today(ms.identity.now()))
        fail('INPUT_INVALID', 422);
    const raw = await msBookData(ms, u, { effectiveDate: E, knownAt: new Date(ms.identity.now()).toISOString(), month: p['month'] ?? E.slice(0, 7) });
    if (operation === 'msPreviewDistribution') {
        const m = await ms.mapping(u.scope, u.s, String(p['mappingVersion']), E);
        if (p['sourceVector'] !== raw.c.sourceVector)
            fail('PRECONDITION_FAILED', 412);
        void m;
        if (p['action'] === 'REVERSE') {
            const original = raw.distributions.find(r => r._id === p['reversesDistributionId'] && r['kind'] === 'DISTRIBUTE');
            if (!original || original['amount'] !== p['amount'] || String(original['effectiveDate']) > E || raw.distributions.some(r => r['reverses'] === original._id))
                fail('REVERSAL_DEPENDENCY');
            const used = (await ms.rows('ms_distribution_uses', u.scope, u.s)).some(r => r['distributionId'] === original._id && r['status'] === 'USED');
            if (used)
                fail('REVERSAL_DEPENDENCY');
            return { postings: [], interest: '0.00', principal: '0.00', credit: '0.00', cashDelta: '0.00', reservedDelta: msMoney(-original['allocations'].filter(a => a['kind'] === 'EMERGENCY').reduce((n, a) => n + msCents(String(a['amount'])), 0n)), details: { originalId: original._id, allocations: original['allocations'] } };
        }
        if (!E.startsWith(String(p['month'])))
            fail('INPUT_INVALID', 422);
        const destinations = p['destinations'];
        if (new Set(destinations.map(d => d['kind'])).size !== destinations.length)
            fail('INPUT_INVALID', 422);
        const s = summarizeMonthly(raw.flows, [u.scope.bookId], String(p['month']), E, raw.c.knownAt), parts = distributeMonthly(String(p['amount']), destinations.map(d => String(d['fraction'])), msMoney(raw.cash - raw.reserved), s.remainingSurplus), allocations = [];
        for (let i = 0; i < destinations.length; i++) {
            const d = destinations[i];
            if (d['kind'] === 'EMERGENCY') {
                const fund = raw.funds.find(f => f._id === d['fundId']);
                if (!fund || fund.status !== 'ACTIVE' || etag(fund) !== d['expectedFundETag'] || raw.links.some(l => l['fundId'] === fund._id))
                    fail('RESERVATION_CONFLICT');
            }
            else if (d['fundId'] || d['expectedFundETag'])
                fail('INPUT_INVALID', 422);
            allocations.push({ ...d, amount: parts[i] });
        }
        return { postings: [], interest: '0.00', principal: '0.00', credit: '0.00', cashDelta: '0.00', reservedDelta: sum(allocations.filter(d => d['kind'] === 'EMERGENCY').map(d => String(d.amount))), details: { allocations } };
    }
    const link = raw.links.find(l => l['liabilityId'] === p['liabilityId'] && l['installmentId'] === p['installmentId'] && l['fundId'] === p['fundId']);
    if (!link)
        fail('RESERVATION_CONFLICT');
    const fund = raw.funds.find(f => f._id === p['fundId']);
    if (!fund || etag(fund) !== p['expectedFundETag'] || fund.backingAccountId !== p['cashAccountId'])
        fail('PRECONDITION_FAILED', 412);
    const base = ms.management.context(u.context, u.scope, u.s, p, { liabilityId: String(p['liabilityId']) }, u.eventIds, u.journalIds), row = await ms.management.store.get(table(u.scope.kind, 'liabilities'), String(p['liabilityId']), u.scope, u.s), l = await effectiveTerms(base, row, E), i = l.schedule.installments.find(i => installmentId(l, i.number) === p['installmentId']);
    if (etag(row) !== p['expectedLiabilityETag'])
        fail('PRECONDITION_FAILED', 412);
    if (!i || l.status !== 'ACTIVE' || l.schedule.kind !== 'OFFICIAL_DECLARED')
        fail('SCHEDULE_REQUIRED', 422);
    const mapping = await ms.mapping(u.scope, u.s, undefined, E), profile = mapping['liabilityProfile'];
    if (!profile || profile['principalAccountId'] !== l.principalAccountId)
        fail('MAPPING_REQUIRED');
    const position = liabilityPosition(raw.events.filter(e => e.entityId === l._id)), allocations = [], recognitions = [], postings = [];
    let total = 0n;
    for (const component of ['PRINCIPAL', 'INTEREST', 'INSURANCE', 'FEES']) {
        const k = component.toLowerCase(), value = msCents(String(p[k])), remaining = msCents(i[k]) - (position.paid.get(l.schedule.id + ':' + i.number + ':' + component) ?? 0n);
        if (value !== remaining)
            fail('COMPONENT_MISMATCH', 422);
        if (!value)
            continue;
        const accountId = String(profile[component === 'PRINCIPAL' ? 'principalAccountId' : k + 'PayableAccountId']);
        allocations.push({ installmentNumber: i.number, component, amount: msMoney(value), accountId });
        if (component !== 'PRINCIPAL') {
            const missing = value - ((position.recognized.get(l.schedule.id + ':' + i.number + ':' + component) ?? 0n) - (position.paid.get(l.schedule.id + ':' + i.number + ':' + component) ?? 0n));
            if (missing > 0n) {
                if (i.dueDate > E)
                    fail('COMPONENT_MISMATCH', 422);
                recognitions.push({ installmentNumber: i.number, component, amount: msMoney(missing), expenseAccountId: String(profile[k + 'ExpenseAccountId']), payableAccountId: accountId });
                postings.push({ accountId: String(profile[k + 'ExpenseAccountId']), debit: msMoney(missing), credit: '0.00' }, { accountId, debit: '0.00', credit: msMoney(missing) });
            }
        }
        postings.push({ accountId, debit: msMoney(value), credit: '0.00' });
        total += value;
    }
    if (total <= 0n)
        fail('COMPONENT_MISMATCH', 422);
    const held = raw.reservedByFund.get(fund._id) ?? 0n, consumeAmount = held > total ? total : held, available = raw.balances.get(fund.backingAccountId) ?? 0n, allHeld = raw.protection.filter(r => r.accountId === fund.backingAccountId).reduce((n, r) => n + msCents(r.amount), 0n);
    if (consumeAmount < total && !p['allowFreeTopUp'] || available - allHeld + consumeAmount < total)
        fail('INSUFFICIENT_AVAILABLE_FUNDS');
    postings.push({ accountId: fund.backingAccountId, debit: '0.00', credit: msMoney(total) });
    return { postings, interest: String(p['interest']), principal: String(p['principal']), credit: '0.00', cashDelta: '-' + msMoney(total), reservedDelta: msMoney(-consumeAmount), details: { allocations, recognitions, total: msMoney(total), consumeAmount: msMoney(consumeAmount), scheduleVersionId: l.schedule.id } };
}
export async function commitMsComposite(ms, u, operation, q, key) {
    const p = q.request, prepared = await prepareMsComposite(ms, u, q.operation, p), id = msStableId(u.scope.bookId, u.actor._id, operation, key);
    if (operation === 'msCommitDistribution') {
        const allocations = prepared.details.allocations;
        for (const a of allocations)
            if (a['kind'] === 'EMERGENCY' && a['amount'] !== '0.00') {
                const c = wealthContext(ms, u, { effectiveDate: p['effectiveDate'], amount: a['amount'], supportReference: 'MS distribution ' + id }, { fundId: String(a['fundId']) });
                c.details = { msDistributionId: id };
                await fundCommand(c, p['action'] === 'REVERSE' ? 'ReleaseFund' : 'AllocateFund');
            }
        await ms.management.store.put('ms_distributions', { _id: id, bookId: u.scope.bookId, ownerId: u.scope.ownerId, domainKind: u.scope.kind, version: 1, kind: p['action'] === 'REVERSE' ? 'REVERSE' : 'DISTRIBUTE', reverses: p['reversesDistributionId'] ?? null, effectiveDate: p['effectiveDate'], month: p['month'], amount: p['amount'], mappingVersion: p['mappingVersion'], allocations, sourceVector: p['sourceVector'], sourceTag: u.sourceTag }, u.s);
    }
    else {
        const d = prepared.details, payload = { ...p, amount: d.total, scheduleVersionId: d.scheduleVersionId, allocations: d.allocations, componentRecognitions: d.recognitions }, base = ms.management.context(u.context, u.scope, u.s, payload, { liabilityId: String(p['liabilityId']) }, u.eventIds, u.journalIds);
        if (d.consumeAmount !== '0.00') {
            const c = wealthContext(ms, u, payload, { fundId: String(p['fundId']) }, id);
            c.eventKind = 'FUND_CONSUME';
            c.entityId = String(p['fundId']);
            c.amount = d.consumeAmount;
            c.details = { liabilityId: p['liabilityId'], installmentId: p['installmentId'], msCompositeId: id };
            await consume(c, String(p['fundId']), String(p['cashAccountId']), d.consumeAmount);
        }
        await liabilityCommand(base, d.recognitions.length ? 'recognizeAndPayLiability' : 'payLiability');
        if (d.consumeAmount !== '0.00') {
            const event = await ms.management.store.get(wealthTable(u.scope.kind, 'fund_events'), id, u.scope, u.s);
            await ms.management.store.put(wealthTable(u.scope.kind, 'fund_events'), { ...event, journalIds: [...u.journalIds], ledgerEventIds: [...u.eventIds] }, u.s, false);
        }
    }
    await ms.identity.wealth.guard(u.scope, u.s);
    return ms.receipt(u, key, id, 'CONFIRMED', String(p['effectiveDate']), q.requestHash);
}
async function historyInput(ms, u, p) {
    if (u.scope.kind !== 'BUSINESS')
        fail('ACCESS_DENIED', 403);
    const { org } = await ms.identity.lending.actor(u.context, u.scope.bookId, u.s), loan = await ms.loan(u.scope.bookId, String(p['loanId']), u.s), unit = await beginEvidence(ms.identity.database, u.s, u.scope.bookId);
    if (p['kind'] === 'LOAN_DISBURSE') {
        const profile = loan.profile, versions = {};
        for (const k of Object.keys(profile))
            versions[k] = etag(await ms.account(u, profile[k]));
        const request = { kind: 'DISBURSE', loanId: loan._id, loanETag: etag(loan), fundingAccountETag: etag(await ms.account(u, loan.terms.cashAccountId)), accountProfile: profile, accountVersions: versions, effectiveDate: String(p['effectiveDate']), supportReference: String(p['supportReference']) };
        return { org, loan, request, command: null, paymentId: undefined, operation: null, paymentsTag: '' };
    }
    if (p['kind'] !== 'LOAN_PAYMENT')
        return fail('VARIANT_UNSUPPORTED', 422);
    let intent = structuredClone(p['directIntent']), payment;
    if (p['paymentId']) {
        payment = (await unit.query('payments', { organizationId: u.scope.bookId, _id: String(p['paymentId']) }, {}, 1))[0];
        if (!payment)
            fail('RESOURCE_NOT_FOUND', 404);
        intent = structuredClone(payment.intent);
        intent.destinationAccountETag = etag(await ms.account(u, intent.destinationAccountId));
        for (const target of intent.targets) {
            const targetLoan = await ms.loan(u.scope.bookId, target.loanId, u.s), state = await stateOf(ms.identity.database, targetLoan, u.s);
            if (!state)
                fail('INVALID_STATE');
            target.positionETag = etag(state.position);
        }
        if (intent.method === 'CASH') {
            const binding = (await unit.query('custody_bindings', { organizationId: u.scope.bookId, _id: payment.registrarId }, {}, 1))[0];
            if (!binding)
                fail('ACCOUNT_PROFILE_CONFLICT');
            intent.bindingETag = etag(binding);
        }
    }
    if (!intent || intent.targets.length !== 1 || intent.targets[0].loanId !== loan._id)
        fail('INPUT_INVALID', 422);
    const opsBook = await ms.identity.operations.books.findOne({ _id: u.scope.bookId }, { session: u.s }), paymentBook = (await unit.query('payment_books', { organizationId: u.scope.bookId, _id: u.scope.bookId }, {}, 1))[0], opsTag = '"' + u.scope.bookId + ':ops:' + (opsBook?.version ?? 0) + '"';
    const command = payment ? { kind: 'APPROVE', paymentId: payment._id, resourceETag: etag(payment), expectedOperationsETag: opsTag, effectiveDate: p['effectiveDate'], msHistoryReference: hash(String(p['originReference']).trim().normalize('NFC')) } : { kind: 'REGISTER', mode: 'DIRECT', intent, effectiveDate: p['effectiveDate'], msHistoryReference: hash(String(p['originReference']).trim().normalize('NFC')) };
    const request = { kind: 'RECEIPT', borrowerId: intent.borrowerId, destinationAccountId: intent.destinationAccountId, destinationAccountETag: intent.destinationAccountETag, receivedAmount: intent.amount, targets: intent.targets, excessDisposition: intent.excessDisposition, receiptReference: intent.receiptReference, effectiveDate: String(p['effectiveDate']), supportReference: intent.supportReference };
    return { org, loan, request, command, paymentId: payment?._id, operation: payment ? 'approvePayment' : 'registerPayment', paymentsTag: '"' + u.scope.bookId + ':payments:' + (paymentBook?.['version'] ?? 0) + '"' };
}
export async function prepareMsHistory(ms, u, p) {
    if (p['kind'] === 'OPENING_MONTHLY_LINK')
        return await openingLink(ms, u, p, false);
    const cut = await ms.identity.database.db.collection('financial_books').findOne({ _id: u.scope.bookId }, { session: u.s });
    if (cut?.openingId && String(p['effectiveDate']) <= String(cut.cutoffDate) && p['kind'] !== 'OPENING_MONTHLY_LINK') {
        await ms.loan(u.scope.bookId, String(p['loanId']), u.s);
        return { postings: [], interest: '0.00', principal: '0.00', credit: '0.00', cashDelta: '0.00', reservedDelta: '0.00', details: { route: 'INFORMATIONAL', cutoffDate: cut.cutoffDate } };
    }
    const h = await historyInput(ms, u, p), token = issueMsExecution(ms.identity, u.actor, h.org, h.request, String(p['executionKey']), String(p['originReference']), 'HISTORY'), book = await ms.identity.operations.books.findOne({ _id: u.scope.bookId }, { session: u.s }), plan = await withMsExecution(token, () => ms.identity.operations.plan(u.actor, h.org, h.request, String(p['executionKey']), '"' + u.scope.bookId + ':ops:' + (book?.version ?? 0) + '"', u.s, ms.identity.now()));
    const interest = sum(plan.plan.allocations.filter(a => a.component === 'INTEREST').map(a => a.amount)), principal = sum(plan.plan.allocations.filter(a => a.component !== 'INTEREST').map(a => a.amount));
    return { postings: plan.plan.postings, interest, principal, credit: plan.plan.creditChange?.added ?? '0.00', cashDelta: h.request.kind === 'DISBURSE' ? '-' + h.loan.terms.principal : h.request.kind === 'RECEIPT' ? h.request.receivedAmount : '0.00', reservedDelta: '0.00', details: { route: 'ECONOMIC', command: h.command, paymentId: h.paymentId ?? null, operation: h.operation, paymentsTag: h.paymentsTag, request: h.request } };
}
export async function previewMsHistory(ms, context, p, params, expected) {
    const prepared = await ms.readUnit(context, params['bookId'], async (u) => { if (!expected)
        fail('ETAG_REQUIRED', 428); if (expected !== u.sourceTag || p['expectedBookETag'] !== u.sourceTag)
        fail('PRECONDITION_FAILED', 412); const view = await prepareMsHistory(ms, u, p), h = p['kind'] === 'LOAN_PAYMENT' && view.details['route'] === 'ECONOMIC' ? await historyInput(ms, u, p) : null; return { view, h, tag: u.sourceTag, binding: authorityBinding(u.actor, u.context, u.book), actor: u.actor }; });
    let native = null;
    const detail = prepared.view.details;
    if (prepared.h) {
        const h = prepared.h, token = issueMsExecution(ms.identity, prepared.actor, h.org, h.request, String(p['executionKey']), String(p['originReference']), 'HISTORY'), r = await withMsExecution(token, () => ms.identity.payments.preview(context, params['bookId'], { executionKey: p['executionKey'], expectedPaymentsETag: h.paymentsTag, command: h.command })), v = r.data;
        native = { payload: { previewToken: v['token'], command: h.command }, expected: h.paymentsTag, operation: h.operation, paymentId: h.paymentId ?? null, request: h.request };
    }
    const issuedAt = ms.identity.now(), requestHash = hash({ operation: 'msPreviewHistory', params, request: p }), q = { operation: 'msPreviewHistory', scopeId: params['bookId'], actorBinding: prepared.binding, sourceTag: prepared.tag, params, request: { ...p, _native: native, _route: detail['route'] }, executionKey: String(p['executionKey']), requestHash, planHash: hash(prepared.view), issuedAt, expiresAt: issuedAt + 300000, date: today(issuedAt) };
    return { status: 200, data: { previewToken: encryptMsToken(ms.identity, q, 'PREVIEW'), requestHash, expiresAt: new Date(q.expiresAt).toISOString(), sourceVector: hash(prepared.tag), bookId: q.scopeId, status: 'READY', reasons: detail['route'] === 'INFORMATIONAL' ? ['BEFORE_OR_AT_OPENING_CUT_INFORMATIONAL_ONLY'] : [], postings: prepared.view.postings, interest: prepared.view.interest, principal: prepared.view.principal, credit: prepared.view.credit, cashDelta: prepared.view.cashDelta, reservedDelta: prepared.view.reservedDelta }, etag: prepared.tag };
}
export async function commitMsHistory(ms, context, p, params, key, expected) {
    const q = decryptMsToken(ms.identity, String(p['previewToken']), 'PREVIEW');
    if (q.operation !== 'msPreviewHistory' || q.scopeId !== params['bookId'] || hash(q.params) !== hash(params) || q.executionKey !== key || p['executionKey'] !== key || q.requestHash !== p['requestHash'])
        fail('INPUT_INVALID', 422);
    const native = q.request['_native'];
    if (native) {
        const authorization = await ms.readUnit(context, params['bookId'], async (u) => {
            await grant(ms.identity, context, 'BALANCE_60M', u.s);
            if (q.actorBinding !== authorityBinding(u.actor, u.context, u.book))
                fail('ACCESS_DENIED', 403);
            const unit = await beginEvidence(ms.identity.database, u.s, u.scope.bookId), old = await unit.query('payment_commands', { organizationId: u.scope.bookId, actorId: u.actor._id, purpose: native['operation'] === 'registerPayment' ? 'PAYMENT_REGISTER_DIRECT' : 'PAYMENT_APPROVE', key }, {}, 1);
            if (!old.length)
                ms.decodeQuote(p, params, key, u);
            if (expected !== q.sourceTag)
                fail('PRECONDITION_FAILED', 412);
            const { org } = await ms.identity.lending.actor(context, u.scope.bookId, u.s);
            return { actor: u.actor, org };
        });
        const token = issueMsExecution(ms.identity, authorization.actor, authorization.org, native['request'], key, String(q.request['originReference']), 'HISTORY'), result = await withMsExecution(token, () => ms.identity.payments.mutate(context, String(native['operation']), params['bookId'], native['payload'], key, String(native['expected']), native['paymentId'] === null ? undefined : String(native['paymentId'])));
        await ms.identity.database.flushEvidence();
        return await ms.readUnit(context, params['bookId'], async (u) => { const r = result.data, event = r['eventId'] ? await ms.identity.operations.events.findOne({ _id: String(r['eventId']), organizationId: u.scope.bookId }, { session: u.s }) : null; u.eventIds = r['eventId'] ? [String(r['eventId'])] : []; u.journalIds = r['journalId'] ? [String(r['journalId'])] : []; const receipt = ms.receipt(u, key, String(r['entityId']), event ? 'CONFIRMED' : 'PENDING_APPROVAL', String(q.request['effectiveDate']), q.requestHash); receipt.data['recordedAt'] = event?.recordedAt ?? new Date(q.issuedAt).toISOString(); return receipt; });
    }
    return await ms.mutateUnit(context, 'msCommitHistory', p, params, key, expected, async (u) => {
        ms.decodeQuote(p, params, key, u);
        const view = await prepareMsHistory(ms, u, q.request);
        if (view.details['route'] === 'OPENING_LINK') {
            await openingLink(ms, u, q.request, true);
            return ms.receipt(u, key, String(q.request['loanId']), 'CONFIRMED', String(q.request['effectiveDate']), q.requestHash);
        }
        if (view.details['route'] === 'INFORMATIONAL') {
            const originHash = hash(String(q.request['originReference']).trim().normalize('NFC')), id = msStableId(u.scope.bookId, 'INFO', originHash), old = (await ms.rows('ms_history_claims', u.scope, u.s)).find(r => r['originHash'] === originHash);
            if (old)
                fail('SOURCE_ALREADY_USED');
            await ms.management.store.put('ms_history_claims', { _id: id, bookId: u.scope.bookId, ownerId: u.scope.ownerId, domainKind: u.scope.kind, version: 1, originHash, kind: 'INFORMATIONAL', effectiveDate: q.request['effectiveDate'], details: q.request }, u.s);
            return ms.receipt(u, key, id, 'PROVISIONAL', String(q.request['effectiveDate']), q.requestHash);
        }
        const h = await historyInput(ms, u, q.request), token = issueMsExecution(ms.identity, u.actor, h.org, h.request, key, String(q.request['originReference']), 'HISTORY'), book = await ms.identity.operations.books.findOne({ _id: u.scope.bookId }, { session: u.s });
        const result = await withMsExecution(token, async () => { const planned = await ms.identity.operations.plan(u.actor, h.org, h.request, key, '"' + u.scope.bookId + ':ops:' + (book?.version ?? 0) + '"', u.s, ms.identity.now()); return await ms.identity.operations.persist(planned, u.actor, u.scope.bookId, h.request, key, u.s); });
        u.lendingChanged = true;
        const event = result.data.event;
        u.eventIds.push(event.id);
        if (event.journalId)
            u.journalIds.push(event.journalId);
        return ms.receipt(u, key, event.id, 'CONFIRMED', String(q.request['effectiveDate']), q.requestHash);
    });
}
async function openingLink(ms, u, p, commit) {
    if (u.scope.kind !== 'BUSINESS')
        fail('ACCESS_DENIED', 403);
    const loan = await ms.loan(u.scope.bookId, String(p['loanId']), u.s), source = await ms.identity.opening.files.findOne({ _id: String(p['openingId']), organizationId: u.scope.bookId, bookId: u.scope.bookId, ownerId: u.scope.ownerId, financialScope: 'BUSINESS', status: 'POSTED' }, { session: u.s });
    if (!source?.commit)
        fail('RESOURCE_NOT_FOUND', 404);
    const finance = await ledgerSources(ms.identity.wealth, u.scope, u.s), journal = finance.journals.find(j => j._id === source.commit.journalId), component = source.snapshot.components.find(c => c.id === p['componentId']), reference = source.snapshot.references.find(r => r.id === component?.referenceId), unit = await beginEvidence(ms.identity.database, u.s, u.scope.bookId), borrower = (await unit.query('lending_borrowers', { organizationId: u.scope.bookId, _id: loan.borrowerId }, {}, 1))[0], binding = borrower?.['openingBorrowerReference'];
    if (!journal || !('source' in journal) || journal.source.type !== 'OPENING' || journal.source.id !== source._id || journal.effectiveDate !== source.snapshot.cutoffDate || loan.status !== 'MONTHLY_DRAFT' || p['effectiveDate'] !== source.snapshot.cutoffDate || component?.category !== 'PRINCIPAL_RECEIVABLE' || component.accountId !== loan.profile.principalAccountId || component.amount !== p['principal'] || p['principal'] !== loan.terms.principal || reference?.type !== 'HISTORICAL_LOAN' || reference.originationDate !== loan.terms.effectiveDate || binding?.openingId !== source._id || binding.referenceId !== reference.borrowerId)
        fail('SOURCE_CONFLICT');
    const { ExchangeRepository } = await import('../exchange/repository.js'), repo = new ExchangeRepository(ms.identity), claims = await repo.all('s11_opening_component_claims', u.scope, u.s), interest = source.snapshot.historicalInterest.filter(i => i.loanReferenceId === reference.id), recognized = interest.filter(i => i.treatment === 'RECOGNIZED_OPENING');
    if (recognized.some(i => i.accountId !== loan.profile.interestReceivableAccountId) || sum(recognized.map(i => i.amount)) !== p['recognizedInterest'] || sum(interest.filter(i => i.treatment === 'INFORMATIONAL').map(i => i.amount)) !== p['unrecognizedInterest'])
        fail('COMPONENT_MISMATCH', 422);
    if ([component.id, ...interest.map(i => i.id)].some(id => claims.some(c => c['componentId'] === id)) || await ms.identity.operations.positions.findOne({ _id: loan._id, organizationId: u.scope.bookId }, { session: u.s }))
        fail('SOURCE_ALREADY_USED');
    const supplied = p['openingPeriods'], state = newMonthlyState(loan._id, u.scope.bookId, loan.terms, loan.profile, u.now, source.commit.journalId, loan.termsVersion);
    state.periods = [];
    let rec = 0n, unrec = 0n;
    for (let index = 0; index < supplied.length; index++) {
        const row = supplied[index], ordinal = index + 1, base = String(row['principalBase']), rate = String(row['rate']), full = String(row['contractualInterest']), paid = String(row['paidBeforeOpening']), r = String(row['recognizedInterestRemaining']), n = String(row['unrecognizedInterestRemaining']), startDate = ordinal === 1 ? loan.terms.effectiveDate : msDue(loan.terms, ordinal - 1), dueDate = msDue(loan.terms, ordinal);
        if (row['ordinal'] !== ordinal || startDate > source.snapshot.cutoffDate || monthlyInterest(base, rate) !== full || msCents(paid) + msCents(r) + msCents(n) !== msCents(full))
            fail('COMPONENT_MISMATCH', 422);
        rec += msCents(r);
        unrec += msCents(n);
        state.periods.push({ ordinal, startDate, dueDate, principalBase: base, rate, termsVersion: loan.termsVersion, interest: msMoney(msCents(r) + msCents(n)), fixedAt: u.now, recognizedAt: null, recognitionDate: null, openingRecognizedInterest: r, contractualInterest: full, paidBeforeOpening: paid });
    }
    if (msMoney(rec) !== p['recognizedInterest'] || msMoney(unrec) !== p['unrecognizedInterest'] || state.periods.at(-1).dueDate < source.snapshot.cutoffDate)
        fail('COMPONENT_MISMATCH', 422);
    state.origin = { kind: 'OPENING_LINK', eventId: source.commit.journalId, cutoffDate: source.snapshot.cutoffDate, recognizedInterest: String(p['recognizedInterest']) };
    const ops = ms.identity.operations, book = await ops.books.findOne({ _id: u.scope.bookId }, { session: u.s });
    if (book && hash(book.profile) !== hash(loan.profile))
        fail('ACCOUNT_PROFILE_CONFLICT');
    if (commit) {
        const activated = monthlyEngineState(loan, u.now, source.commit.journalId);
        activated.position.monthlyState = state;
        activated.position.fundingEventId = null;
        activated.position.historicalOriginId = loan._id;
        activated.position.scheduleVersion = state.periods.length;
        activated.rows = periodRows(state, u.now);
        await domainCollection(ms.identity.database, 'lending_monthly_loans').replaceOne({ _id: loan._id, organizationId: u.scope.bookId, status: 'MONTHLY_DRAFT', version: loan.version }, activated.loan, { session: u.s });
        await ops.positions.insertOne(activated.position, { session: u.s });
        for (const row of activated.rows)
            await ops.rows.insertOne(row, { session: u.s });
        for (const period of state.periods) {
            const schedule = monthlySchedule(activated, period.ordinal, source.commit.journalId, u.now, period.ordinal === 1);
            await ops.schedules.insertOne({ ...schedule, eventId: null, _id: loan._id + ':' + period.ordinal, organizationId: u.scope.bookId }, { session: u.s });
        }
        if (!book) {
            const balances = new Map();
            for (const j of finance.journals)
                for (const l of j.lines)
                    balances.set(l.accountId, (balances.get(l.accountId) ?? 0n) + storedCents(l.debit) - storedCents(l.credit));
            await ops.books.insertOne({ _id: u.scope.bookId, organizationId: u.scope.bookId, version: 0, profile: loan.profile, currency: 'COP', createdAt: u.now, baseline: Object.values(loan.profile).map(accountId => { const n = balances.get(accountId) ?? 0n; return { accountId, debit: n >= 0n ? msMoney(n) : '0.00', credit: n < 0n ? msMoney(-n) : '0.00' }; }) }, { session: u.s });
        }
        for (const componentId of [component.id, ...interest.map(i => i.id)])
            await repo.write('s11_opening_component_claims', u.scope, u.s, { componentId, openingId: source._id, resourceId: loan._id, kind: 'MONTHLY_OPEN_V1', journalId: source.commit.journalId, unitKnownAt: u.now });
        u.lendingChanged = true;
    }
    return { postings: [], interest: '0.00', principal: '0.00', credit: '0.00', cashDelta: '0.00', reservedDelta: '0.00', details: { route: 'OPENING_LINK', openingId: source._id, componentId: component.id, state } };
}
//# sourceMappingURL=ms-queries.js.map