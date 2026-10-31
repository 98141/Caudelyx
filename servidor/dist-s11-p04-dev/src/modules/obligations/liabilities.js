/* eslint-disable security/detect-object-injection -- Closed component names and versioned official schedule keys. */
import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { cents, money, storedCents } from '../finance/money.js';
import { today, validDate, schedule as calculateSchedule } from './calendar.js';
import { live, entityEvents } from './expenses.js';
import { table, privateJournals } from './models.js';
const positive = (v) => { const n = cents(String(v)); if (n <= 0n)
    throw new AppError(422, 'INPUT_INVALID'); return n; };
const fields = (c) => ({ bookId: c.scope.bookId, ownerId: c.scope.ownerId, domainKind: c.scope.kind });
const body = (r) => { const { mac, recordedAt, ...v } = r; void mac; void recordedAt; return v; };
const cmp = (x) => x.installmentNumber + ':' + x.component;
export function liabilityPosition(events) {
    const xs = live(events);
    let principal = 0n, activated = false;
    const recognized = new Map(), paid = new Map(), payables = new Map();
    for (const e of xs) {
        if (e.kind === 'LIABILITY_ACTIVATE')
            activated = true;
        principal += cents(String(e.components['principalAdded'] ?? '0.00'));
        if (['LIABILITY_PAY', 'LIABILITY_PREPAY'].includes(e.kind))
            principal -= e.allocations.filter(a => a.component === 'PRINCIPAL').reduce((n, a) => n + cents(a.amount), 0n);
        const version = String(e.components['scheduleVersionId'] ?? '');
        if (e.kind === 'LIABILITY_COMPONENT_RECOGNIZE')
            for (const a of e.allocations) {
                const k = version + ':' + cmp(a);
                recognized.set(k, (recognized.get(k) ?? 0n) + cents(a.amount));
                if (payables.has(k) && payables.get(k) !== a.accountId)
                    throw new AppError(503, 'SOURCE_INCONSISTENT');
                payables.set(k, a.accountId);
            }
        if (e.kind === 'LIABILITY_PAY')
            for (const a of e.allocations) {
                const k = version + ':' + cmp(a);
                paid.set(k, (paid.get(k) ?? 0n) + cents(a.amount));
            }
    }
    let components = 0n;
    for (const [k, n] of recognized) {
        const v = n - (paid.get(k) ?? 0n);
        if (v < 0n)
            throw new AppError(503, 'SOURCE_INCONSISTENT');
        components += v;
    }
    if (principal < 0n)
        throw new AppError(503, 'SOURCE_INCONSISTENT');
    return { principal, recognized, paid, payables, components, activated };
}
export async function effectiveTerms(c, row, date = today(c.identity.now()), known = '9999-12-31T23:59:59.999Z', supplied) {
    const versions = (supplied ?? await c.store.all(table(c.scope.kind, 'liability_versions'), c.scope, c.s)).filter(v => v['liabilityId'] === row._id && v.recordedAt <= known && String(v['validFrom']) <= date && v['schedule'].kind === 'OFFICIAL_DECLARED').sort((a, b) => String(a['validFrom']).localeCompare(String(b['validFrom'])) || a.version - b.version);
    const current = versions.at(-1);
    return current ? { ...row, rate: current['rate'], schedule: current['schedule'], prepaymentPermissions: current['prepaymentPermissions'] } : row;
}
async function terms(c, row, proposed, validFrom) {
    const position = liabilityPosition(await entityEvents(c, row._id)), principal = row.status === 'DRAFT' ? row.principal : money(position.principal);
    const old = await c.store.all(table(c.scope.kind, 'liability_versions'), c.scope, c.s), version = 1 + Math.max(0, ...old.filter(v => v['liabilityId'] === row._id).map(v => v.version));
    const rate = proposed['rate'];
    if (rate.decimalValue.length > 64 || (rate.spread?.length ?? 0) > 64 || !validDate(validFrom) || !validDate(rate.validFrom) || !validDate(rate.observedOn))
        throw new AppError(422, 'INPUT_INVALID');
    const schedule = calculateSchedule({ ...proposed['schedule'], id: randomUUID(), version }, rate, principal);
    await c.store.put(table(c.scope.kind, 'liability_versions'), { _id: schedule.id, ...fields(c), version, liabilityId: row._id, validFrom, rate, schedule, prepaymentPermissions: proposed['prepaymentPermissions'], supportReference: proposed['supportReference'] }, c.s);
    return { rate, schedule, prepaymentPermissions: proposed['prepaymentPermissions'] };
}
const expectedComponent = (schedule, a) => {
    const row = schedule.installments.find(i => i.number === a.installmentNumber);
    if (!row)
        throw new AppError(422, 'COMPONENT_MISMATCH');
    const key = new Map([['PRINCIPAL', 'principal'], ['INTEREST', 'interest'], ['INSURANCE', 'insurance'], ['FEES', 'fees']]).get(a.component);
    if (!key)
        throw new AppError(422, 'INPUT_INVALID');
    return { amount: cents(String(row[key])), dueDate: row.dueDate };
};
export async function liabilityCommand(c, action) {
    const p = c.payload, name = table(c.scope.kind, 'liabilities');
    if (action === 'createLiability') {
        positive(p['principal']);
        const id = c.params['importRootId'] ?? randomUUID();
        let row = { _id: id, ...fields(c), ...p, version: 1, status: 'DRAFT' };
        const t = await terms(c, row, p, p['schedule'].validFrom);
        row = { ...row, ...t };
        return await c.store.put(name, row, c.s);
    }
    let row = await c.store.get(name, c.params['liabilityId'], c.scope, c.s), events = await entityEvents(c, row._id);
    row = await effectiveTerms(c, row);
    let position = liabilityPosition(events);
    if (action === 'linkOpeningLiability') {
        if (c.scope.kind !== 'BUSINESS' || row.status !== 'DRAFT' || row.schedule.kind !== 'OFFICIAL_DECLARED' || p['liabilityId'] !== row._id || p['principal'] !== row.principal || p['expectedLiabilityETag'] !== '"' + row._id + ':' + row.version + '"')
            throw new AppError(409, 'SOURCE_CONFLICT');
        await c.ledger.account(c.scope, String(p['principalAccountId']), c.s, { accountClass: 'LIABILITY', kind: ['GENERAL'] });
        const { claimOpeningLiability } = await import('../exchange/historical.js'), { source, component } = await claimOpeningLiability(c.identity, c.scope, String(p['openingId']), String(p['componentId']), row, String(p['principalAccountId']), c.s, true);
        const prior = (await c.store.all(table(c.scope.kind, 'events'), c.scope, c.s)).filter(e => e.journalIds.includes(source.commit.journalId));
        if (prior.some(e => !e.components['existingLink'] || e.entityId !== row._id && !e.components['openingComponentId'] && e.kind === 'LIABILITY_ACTIVATE'))
            throw new AppError(409, 'SOURCE_CONFLICT');
        const event = await c.post(row._id, 'LIABILITY_ACTIVATE', source.snapshot.cutoffDate, row.principal, [], [], { principalAdded: row.principal, existingLink: true, openingId: source._id, openingComponentId: component.id }, null, { id: source.commit.journalId, recordedAt: source.commit.recordedAt });
        return await c.store.put(name, { ...body(row), version: row.version + 1, status: 'ACTIVE', principalAccountId: String(p['principalAccountId']), activationEventId: event._id }, c.s);
    }
    if (action === 'versionLiabilityTerms') {
        const date = String(p['effectiveFrom']);
        if (row.status !== 'DRAFT' && date <= today(c.identity.now()))
            throw new AppError(409, 'FUTURE_VERSION_CONFLICT');
        if (row.status !== 'DRAFT')
            for (const i of row.schedule.installments)
                if (i.dueDate < date)
                    for (const component of ['PRINCIPAL', 'INTEREST', 'INSURANCE', 'FEES']) {
                        const a = { installmentNumber: i.number, component, amount: '0.00', accountId: '' }, k = row.schedule.id + ':' + cmp(a);
                        if (expectedComponent(row.schedule, a).amount > (position.paid.get(k) ?? 0n))
                            throw new AppError(409, 'FUTURE_VERSION_CONFLICT');
                    }
        const t = await terms(c, row, p, date);
        return await c.store.put(name, { ...body(row), ...t, version: row.version + 1 }, c.s);
    }
    if (action === 'activateLiability') {
        if (row.status !== 'DRAFT' || row.schedule.kind !== 'OFFICIAL_DECLARED')
            throw new AppError(409, 'INVALID_STATE');
        const date = String(p['effectiveDate']);
        if (!validDate(date) || date > today(c.identity.now()))
            throw new AppError(422, 'INPUT_INVALID');
        await c.ledger.account(c.scope, String(p['principalAccountId']), c.s, { accountClass: 'LIABILITY', kind: ['GENERAL'] });
        const kind = String(p['recognitionKind']), destination = String(p['destinationAccountId']), funding = p['funding'];
        const principal = cents(row.principal), credit = funding.filter(f => f.kind === 'DIRECT_CREDIT').reduce((n, f) => n + cents(f.amount), 0n), cash = funding.filter(f => f.kind === 'CASH'), total = funding.reduce((n, f) => n + cents(f.amount), 0n);
        let event;
        if (kind === 'EXISTING_JOURNAL_LINK') {
            const id = String(p['existingJournalId']);
            let original;
            if (c.scope.kind === 'PERSONAL')
                original = await c.store.get(privateJournals, id, c.scope, c.s);
            else {
                const j = await c.identity.finance.journals.findOne({ _id: id, organizationId: c.scope.bookId }, { session: c.s });
                if (!j)
                    throw new AppError(404, 'RESOURCE_NOT_FOUND');
                original = j;
            }
            if (original.effectiveDate !== date || original.lines.filter(l => l.accountId === p['principalAccountId']).reduce((n, l) => n + storedCents(l.credit) - storedCents(l.debit), 0n) !== principal)
                throw new AppError(422, 'COMPONENT_MISMATCH');
            const references = (await c.store.all(table(c.scope.kind, 'events'), c.scope, c.s)).filter(e => e.journalIds.includes(id));
            if (references.some(e => !e.components['existingLink']) || (await c.store.all(name, c.scope, c.s)).some(l => l.principalAccountId === p['principalAccountId'] && references.some(e => e._id === l.activationEventId)))
                throw new AppError(409, 'SOURCE_CONFLICT');
            event = await c.post(row._id, 'LIABILITY_ACTIVATE', date, row.principal, [], [], { principalAdded: row.principal, existingLink: true }, null, { id, recordedAt: original.recordedAt });
        }
        else {
            if (credit !== principal || funding.some(f => !['DIRECT_CREDIT', 'CASH'].includes(f.kind)))
                throw new AppError(422, 'COMPONENT_MISMATCH');
            if (kind === 'CASH_RECEIPT' && (cash.length || total !== principal))
                throw new AppError(422, 'COMPONENT_MISMATCH');
            const expected = kind === 'EXPENSE_PURCHASE' ? 'EXPENSE' : 'ASSET';
            await c.ledger.account(c.scope, destination, c.s, { accountClass: expected, kind: kind === 'CASH_RECEIPT' ? ['CASH', 'BANK'] : ['GENERAL'] });
            const lines = [{ accountId: destination, debit: money(total), credit: '0.00' }, { accountId: String(p['principalAccountId']), debit: '0.00', credit: row.principal }];
            for (const f of cash) {
                if (!f.accountId)
                    throw new AppError(422, 'INPUT_INVALID');
                await c.ledger.account(c.scope, f.accountId, c.s, { accountClass: 'ASSET', kind: ['CASH', 'BANK'] });
                lines.push({ accountId: f.accountId, debit: '0.00', credit: f.amount });
            }
            event = await c.post(row._id, 'LIABILITY_ACTIVATE', date, money(total), lines, [], { principalAdded: row.principal, recognitionKind: kind });
            if (kind === 'ASSET_PURCHASE')
                await c.store.put(table(c.scope.kind, 'asset_stubs'), { _id: randomUUID(), ...fields(c), version: 1, liabilityId: row._id, legalOwnerReference: p['legalOwnerReference'], date, cost: money(total), accountId: destination, sourceEventId: event._id, fundingLines: funding }, c.s);
        }
        return await c.store.put(name, { ...body(row), status: 'ACTIVE', version: row.version + 1, principalAccountId: p['principalAccountId'], recognitionKind: kind, activationEventId: event._id }, c.s);
    }
    if (row.status !== 'ACTIVE')
        throw new AppError(409, 'INVALID_STATE');
    const activation = live(events).find(e => e.kind === 'LIABILITY_ACTIVATE');
    if (!activation)
        throw new AppError(503, 'SOURCE_INCONSISTENT');
    if (String(p['effectiveDate']) < activation.effectiveDate)
        throw new AppError(422, 'INPUT_INVALID');
    if (action === 'postCardPurchase') {
        if (row.kind !== 'CARD' || p['cardLiabilityAccountId'] !== row.principalAccountId || !validDate(p['cycleStart']) || !validDate(p['cycleEnd']) || !validDate(p['paymentDue']) || String(p['cycleStart']) > String(p['effectiveDate']) || String(p['effectiveDate']) > String(p['cycleEnd']) || String(p['cycleEnd']) >= String(p['paymentDue']))
            throw new AppError(422, 'INPUT_INVALID');
        const amount = positive(p['amount']);
        await c.ledger.account(c.scope, String(p['destinationAccountId']), c.s, { accountClass: p['classification'] === 'ASSET' ? 'ASSET' : 'EXPENSE', kind: ['GENERAL'] });
        const e = await c.post(row._id, 'LIABILITY_CARD_PURCHASE', String(p['effectiveDate']), money(amount), [{ accountId: String(p['destinationAccountId']), debit: money(amount), credit: '0.00' }, { accountId: row.principalAccountId, debit: '0.00', credit: money(amount) }], [], { principalAdded: money(amount), cycleStart: p['cycleStart'], cycleEnd: p['cycleEnd'], paymentDue: p['paymentDue'] });
        await c.store.put(table(c.scope.kind, 'card_acquisitions'), { _id: randomUUID(), ...fields(c), version: 1, liabilityId: row._id, acquisitionEventId: e._id, amount: money(amount), cycleStart: p['cycleStart'], cycleEnd: p['cycleEnd'], paymentDue: p['paymentDue'] }, c.s);
        if (p['classification'] === 'ASSET')
            await c.store.put(table(c.scope.kind, 'asset_stubs'), { _id: randomUUID(), ...fields(c), version: 1, liabilityId: row._id, sourceEventId: e._id, cost: money(amount), accountId: p['destinationAccountId'], legalOwnerReference: p['legalOwnerReference'], date: p['effectiveDate'] }, c.s);
    }
    else if (action === 'prepayLiability') {
        if (!row.prepaymentPermissions.includes(String(p['mode'])))
            throw new AppError(409, 'ABON_NOT_ALLOWED');
        if (p['previousScheduleVersionId'] !== row.schedule.id)
            throw new AppError(412, 'PRECONDITION_FAILED');
        const amount = positive(p['amount']);
        if (amount > position.principal)
            throw new AppError(422, 'COMPONENT_MISMATCH');
        const result = p['resultSchedule'];
        if (result.kind !== 'OFFICIAL_DECLARED' || cents(result.principalOpening) !== position.principal - amount)
            throw new AppError(422, 'SCHEDULE_REQUIRED');
        const oldLast = row.schedule.installments.at(-1).dueDate, newLast = result.installments.at(-1)?.dueDate;
        if (p['mode'] === 'REDUCE_INSTALLMENT' && (oldLast !== newLast || result.installments.length !== row.schedule.installments.length) || p['mode'] === 'REDUCE_TERM' && (!newLast || newLast > oldLast || result.installments.length > row.schedule.installments.length))
            throw new AppError(422, 'COMPONENT_MISMATCH');
        // Past effective obligations cannot disappear through a future calendar version.
        for (const old of row.schedule.installments.filter(i => i.dueDate < String(p['effectiveDate'])))
            for (const component of ['PRINCIPAL', 'INTEREST', 'INSURANCE', 'FEES']) {
                const a = { installmentNumber: old.number, component, amount: '0.00', accountId: '' }, remaining = expectedComponent(row.schedule, a).amount - (position.paid.get(row.schedule.id + ':' + cmp(a)) ?? 0n);
                if (remaining > 0n) {
                    const replacement = result.installments.find(i => i.dueDate === old.dueDate);
                    const key = component.toLowerCase();
                    if (!replacement || cents(String(replacement[key])) !== remaining)
                        throw new AppError(409, 'FUTURE_VERSION_CONFLICT');
                }
            }
        await c.ledger.account(c.scope, String(p['cashAccountId']), c.s, { accountClass: 'ASSET', kind: ['CASH', 'BANK'] });
        await c.post(row._id, 'LIABILITY_PREPAY', String(p['effectiveDate']), money(amount), [{ accountId: row.principalAccountId, debit: money(amount), credit: '0.00' }, { accountId: String(p['cashAccountId']), debit: '0.00', credit: money(amount) }], [{ installmentNumber: 1, component: 'PRINCIPAL', amount: money(amount), accountId: row.principalAccountId }], { scheduleVersionId: row.schedule.id, beforeSchedule: row.schedule, beforeRate: row.rate, mode: p['mode'] });
        const newTerms = await terms(c, row, { rate: row.rate, schedule: result, prepaymentPermissions: row.prepaymentPermissions, supportReference: p['supportReference'] }, String(p['effectiveDate']));
        row = { ...row, ...newTerms };
    }
    else if (action === 'reverseLiabilityEvent') {
        const original = events.find(e => e._id === c.params['eventId']);
        if (!original)
            throw new AppError(404, 'RESOURCE_NOT_FOUND');
        if (original.reversalOfId || events.some(e => e.reversalOfId === original._id))
            throw new AppError(409, 'ALREADY_REVERSED');
        const later = live(events).filter(e => e._id !== original._id && e.unitKnownAt > original.unitKnownAt);
        if (['LIABILITY_ACTIVATE', 'LIABILITY_CARD_PURCHASE', 'LIABILITY_PREPAY'].includes(original.kind) && later.length)
            throw new AppError(409, 'INVALID_STATE');
        if (original.kind === 'LIABILITY_COMPONENT_RECOGNIZE')
            for (const a of original.allocations)
                if ((position.paid.get(String(original.components['scheduleVersionId']) + ':' + cmp(a)) ?? 0n) > 0n)
                    throw new AppError(409, 'INVALID_STATE');
        if (String(p['effectiveDate']) < original.effectiveDate)
            throw new AppError(422, 'INPUT_INVALID');
        if (original.components['existingLink'])
            throw new AppError(409, 'DOMAIN_REVERSAL_FORBIDDEN');
        const id = randomUUID(), j = await c.ledger.inverse(c.scope, original.journalIds[0], id, String(p['effectiveDate']), String(p['supportReference']), c.s);
        await c.post(row._id, 'LIABILITY_EVENT_REVERSE', String(p['effectiveDate']), original.amount, [], [], { originalKind: original.kind }, original._id, j);
        if (original.kind === 'LIABILITY_ACTIVATE')
            row = { ...row, status: 'DRAFT' };
        if (original.kind === 'LIABILITY_PREPAY')
            row = { ...row, ...await terms(c, row, { rate: original.components['beforeRate'], schedule: original.components['beforeSchedule'], prepaymentPermissions: row.prepaymentPermissions, supportReference: p['supportReference'] }, String(p['effectiveDate'])) };
    }
    else {
        if (row.schedule.kind !== 'OFFICIAL_DECLARED' || p['scheduleVersionId'] !== row.schedule.id)
            throw new AppError(422, 'SCHEDULE_REQUIRED');
        const recognize = async () => {
            const input = (p['components'] ?? p['componentRecognitions']);
            if (!Array.isArray(input) || !input.length || new Set(input.map(cmp)).size !== input.length)
                throw new AppError(422, 'INPUT_INVALID');
            const allocations = [], lines = [];
            let total = 0n;
            for (const r of input) {
                const value = positive(r.amount), a = { installmentNumber: r.installmentNumber, component: r.component, amount: r.amount, accountId: r.payableAccountId }, official = expectedComponent(row.schedule, a), key = row.schedule.id + ':' + cmp(a);
                if (official.dueDate > String(p['effectiveDate']) || value > official.amount - (position.recognized.get(key) ?? 0n) || position.payables.has(key) && position.payables.get(key) !== r.payableAccountId)
                    throw new AppError(422, 'COMPONENT_MISMATCH');
                await c.ledger.account(c.scope, r.expenseAccountId, c.s, { accountClass: 'EXPENSE', kind: ['GENERAL'] });
                await c.ledger.account(c.scope, r.payableAccountId, c.s, { accountClass: 'LIABILITY', kind: ['GENERAL'] });
                lines.push({ accountId: r.expenseAccountId, debit: r.amount, credit: '0.00' }, { accountId: r.payableAccountId, debit: '0.00', credit: r.amount });
                allocations.push(a);
                total += value;
            }
            await c.post(row._id, 'LIABILITY_COMPONENT_RECOGNIZE', String(p['effectiveDate']), money(total), lines, allocations, { scheduleVersionId: row.schedule.id });
            events = await entityEvents(c, row._id);
            position = liabilityPosition(events);
        };
        if (action === 'recognizeLiabilityComponent' || action === 'recognizeAndPayLiability')
            await recognize();
        if (action === 'payLiability' || action === 'recognizeAndPayLiability') {
            const allocations = p['allocations'], total = positive(p['amount']);
            if (!Array.isArray(allocations) || new Set(allocations.map(cmp)).size !== allocations.length || allocations.reduce((n, a) => n + cents(a.amount), 0n) !== total)
                throw new AppError(422, 'COMPONENT_MISMATCH');
            const lines = [];
            for (const a of allocations) {
                const value = positive(a.amount), key = row.schedule.id + ':' + cmp(a), official = expectedComponent(row.schedule, a);
                const accruedAtPayment = live(events).filter(e => e.kind === 'LIABILITY_COMPONENT_RECOGNIZE' && e.effectiveDate <= String(p['effectiveDate']) && e.components['scheduleVersionId'] === row.schedule.id).flatMap(e => e.allocations).filter(r => cmp(r) === cmp(a)).reduce((n, r) => n + cents(r.amount), 0n);
                if (value > official.amount - (position.paid.get(key) ?? 0n) || a.component === 'PRINCIPAL' && (a.accountId !== row.principalAccountId || value > position.principal) || a.component !== 'PRINCIPAL' && (position.payables.get(key) !== a.accountId || value > accruedAtPayment - (position.paid.get(key) ?? 0n)))
                    throw new AppError(422, 'COMPONENT_MISMATCH');
                await c.ledger.account(c.scope, a.accountId, c.s, { accountClass: 'LIABILITY', kind: ['GENERAL'] });
                lines.push({ accountId: a.accountId, debit: a.amount, credit: '0.00' });
            }
            await c.ledger.account(c.scope, String(p['cashAccountId']), c.s, { accountClass: 'ASSET', kind: ['CASH', 'BANK'] });
            lines.push({ accountId: String(p['cashAccountId']), debit: '0.00', credit: money(total) });
            await c.post(row._id, 'LIABILITY_PAY', String(p['effectiveDate']), money(total), lines, allocations, { scheduleVersionId: row.schedule.id });
        }
        else if (action !== 'recognizeLiabilityComponent')
            throw new AppError(422, 'INPUT_INVALID');
    }
    return await c.store.put(name, { ...body(row), version: row.version + 1 }, c.s);
}
export function publicLiability(row, events) {
    const p = liabilityPosition(events), schedulePrincipal = row.schedule.installments.reduce((n, r) => n + cents(r.principal), 0n), paidPrincipal = live(events).filter(e => e.components['scheduleVersionId'] === row.schedule.id && e.kind === 'LIABILITY_PAY').flatMap(e => e.allocations).filter(a => a.component === 'PRINCIPAL').reduce((n, a) => n + cents(a.amount), 0n);
    const complete = !p.activated || schedulePrincipal - paidPrincipal === p.principal;
    let officialRemaining = 0n;
    for (const i of row.schedule.installments)
        for (const comp of ['PRINCIPAL', 'INTEREST', 'INSURANCE', 'FEES']) {
            const a = { installmentNumber: i.number, component: comp, amount: '0.00', accountId: '' };
            officialRemaining += expectedComponent(row.schedule, a).amount - (p.paid.get(row.schedule.id + ':' + cmp(a)) ?? 0n);
        }
    return { id: row._id, version: row.version, kind: row.kind, label: row.label, status: p.activated && complete && p.principal === 0n && p.components === 0n && officialRemaining === 0n ? 'SETTLED' : p.activated ? 'ACTIVE' : 'DRAFT', principalOutstanding: money(p.principal), componentOutstanding: money(p.components), schedule: row.schedule, coverage: complete ? 'COMPLETE' : 'INCOMPLETE', events: events.map(e => ({ id: e._id, kind: e.kind, effectiveDate: e.effectiveDate, amount: e.amount, reversalOfId: e.reversalOfId })) };
}
//# sourceMappingURL=liabilities.js.map