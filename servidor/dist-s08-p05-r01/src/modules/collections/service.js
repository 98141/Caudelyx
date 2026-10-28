/* eslint-disable security/detect-object-injection -- Closed schema names/command allowlists and fixed domain tables, never query operators from input. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { etag, today } from '../finance/service.js';
import { cents, money } from '../finance/money.js';
import { recordFinancialEvidence } from '../finance/integrity.js';
import { canonical, hash, uuid } from '../lending/contract.js';
import { beginEvidence, domainCollection } from '../lending/evidence-v2.js';
import { recordLendingEvidence } from '../lending/integrity.js';
import { paymentDocument } from '../payments/contract.js';
import { collectionContract, isCollectionPurpose } from './contract.js';
import { collectionTables, policy, bucketNames } from './models.js';
import { activeDelivery, addBucket, countedState, denominations, fail, physicalMovement, requireState, validatePortions, zeroBuckets } from './engine.js';
import { accountBalance, available, cashLot, deliveries, effectiveReserves } from './funds.js';
const idFor = (...parts) => { const h = createHash('sha256').update(JSON.stringify(parts)).digest('hex'); return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-8' + h.slice(17, 20) + '-' + h.slice(20, 32); };
const publicFields = (schema, row) => {
    const definition = paymentDocument().components.schemas[schema];
    return Object.fromEntries(Object.keys(definition.properties).map(k => [k, k === 'id' ? row['_id'] : row[k]]));
};
const reason = (payload) => ({ reason: payload['reason'] ?? null, supportReference: payload['supportReference'] });
export class CollectionsService {
    identity;
    key;
    constructor(identity, key) {
        this.identity = identity;
        this.key = key;
    }
    table(name) { return domainCollection(this.identity.database, name); }
    async initialize() {
        for (const name of collectionTables)
            await this.table(name).createIndex({ organizationId: 1, _id: 1 }, { name: 'lending_domain_org' });
        await this.table('collection_journeys').createIndex({ organizationId: 1, ownerId: 1 }, { unique: true, partialFilterExpression: { status: 'OPEN' } });
        await this.table('cash_stations').createIndex({ organizationId: 1, accountId: 1 }, { unique: true });
        await this.table('cash_delivery_allocations').createIndex({ organizationId: 1, sourcePaymentId: 1, deliveryId: 1 }, { unique: true });
        await this.table('cash_deliveries').createIndex({ organizationId: 1, originalDeliveryId: 1 }, { unique: true, partialFilterExpression: { kind: 'COMPENSATION', state: { $in: policy.deliveryStates.filter(s => s !== 'CANCELLED') } } });
        await this.table('cash_delivery_facts').createIndex({ organizationId: 1, deliveryId: 1, sequence: 1 }, { unique: true });
        await this.table('collection_commands').createIndex({ organizationId: 1, actorId: 1, purpose: 1, key: 1 }, { unique: true });
        await this.table('collection_actions').createIndex({ organizationId: 1, journeyId: 1, recordedAt: 1, _id: 1 });
    }
    async actor(context, org, s) { return await this.identity.payments.actor(context, org, s); }
    role(actor, roles) { if (actor.suspended || actor.roles.includes('SA') || !actor.roles.some(r => roles.includes(r)))
        fail('ACCESS_DENIED', 403); }
    expected(row, value) { if (typeof value !== 'string')
        fail('ETAG_REQUIRED', 428); if (etag(row) !== value)
        fail('PRECONDITION_FAILED', 412); }
    async party(org, id, s, roles = ['T', 'O', 'C']) {
        const actor = await this.identity.identities.findOne({ _id: id, organizationId: org, realm: 'TENANT', suspended: false }, { session: s });
        if (!actor)
            fail('ACCESS_DENIED', 403);
        this.role(actor, roles);
        return actor;
    }
    async account(org, id, s, expected) {
        const row = await this.identity.finance.accounts.findOne({ _id: uuid(id), organizationId: org, ownerId: org, bookId: org, financialScope: 'BUSINESS', currency: 'COP' }, { session: s });
        if (!row)
            fail('RESOURCE_NOT_FOUND', 404);
        if (row.status !== 'ACTIVE' || row.accountClass !== 'ASSET' || row.kind !== 'CASH')
            fail('ACCOUNT_INELIGIBLE', 422);
        if (expected !== undefined)
            this.expected(row, expected);
        return row;
    }
    async row(table, org, id, s) { const row = await this.table(table).findOne({ _id: uuid(id), organizationId: org }, { session: s }); if (!row)
        fail('RESOURCE_NOT_FOUND', 404); return row; }
    async journey(org, id, a, s, owner = false) { const j = await this.row('collection_journeys', org, id, s); if (j['ownerId'] !== a._id && (owner || !a.roles.includes('T')))
        fail('RESOURCE_NOT_FOUND', 404); return j; }
    async loan(org, id, a, s) {
        await this.identity.lending.verifiedLoan(uuid(id), org, s);
        if (!a.roles.some(r => ['T', 'O'].includes(r)) && !await domainCollection(this.identity.database, 'payment_registration_scopes').findOne({ organizationId: org, registrarId: a._id, loanId: id, active: true }, { session: s }))
            fail('ACCESS_DENIED', 403);
    }
    async delivery(org, id, a, s) { const d = await this.row('cash_deliveries', org, id, s); if (!a.roles.includes('T') && ![d.senderId, d.receiverId].includes(a._id))
        fail('RESOURCE_NOT_FOUND', 404); return d; }
    async actionHead(org, id, s) { let a = await this.row('collection_actions', org, id, s); const seen = new Set(); for (;;) {
        if (seen.has(a._id))
            fail('INTEGRITY_MISMATCH', 503);
        seen.add(a._id);
        const next = await this.table('collection_actions').findOne({ organizationId: org, supersedesActionId: a._id }, { session: s });
        if (!next)
            return a;
        a = next;
    } }
    signed(value, domain = 'S07:') { const body = Buffer.from(JSON.stringify(value)).toString('base64url'); return body + '.' + createHmac('sha256', this.key).update(domain + body).digest('base64url'); }
    decoded(value, domain = 'S07:') {
        try {
            const [b, sig, ...extra] = value.split('.');
            if (!b || !sig || extra.length)
                throw Error();
            const a = Buffer.from(sig, 'base64url'), e = createHmac('sha256', this.key).update(domain + b).digest();
            if (a.length !== e.length || !timingSafeEqual(a, e))
                throw Error();
            return JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
        }
        catch {
            return fail(domain === 'S07:' ? 'INPUT_INVALID' : 'INVALID_CURSOR', 422);
        }
    }
    async state(org, s) {
        const b = await this.table('collection_books').findOne({ _id: org, organizationId: org }, { session: s }), p = await domainCollection(this.identity.database, 'payment_books').findOne({ _id: org, organizationId: org }, { session: s }), o = await this.identity.operations.books.findOne({ _id: org, organizationId: org }, { session: s }), f = await this.identity.database.db.collection('financial_books').findOne({ _id: org }, { session: s });
        return { organizationId: org, collectionsBookETag: '"' + org + ':collections:' + (b?.version ?? 0) + '"', paymentsBookETag: '"' + org + ':payments:' + (p?.version ?? 0) + '"', operationsBookETag: '"' + org + ':ops:' + (o?.version ?? 0) + '"', financeBookETag: '"' + org + ':finance:' + (f?.value ?? 0) + '"' };
    }
    async authority(operation, org, a, p, id, s) {
        this.role(a, ['T', 'O', 'C']);
        if (['setCashStation', 'investigateCashDelivery', 'correctCashDelivery', 'confirmCashDelivery', 'confirmCashDeliveryCompensation', 'requestCashDeliveryCompensation', 'confirmCashDeliveryReturn'].includes(operation))
            this.role(a, ['T']);
        if (operation === 'previewCashDelivery') {
            const c = p['command'], k = String(c['kind']);
            if (k === 'CONFIRM' || k === 'COMPENSATE_CONFIRM' || k === 'COMPENSATE_REQUEST')
                this.role(a, ['T']);
            if (c['deliveryId'] || c['originalDeliveryId'])
                await this.delivery(org, String(c['deliveryId'] ?? c['originalDeliveryId']), a, s);
        }
        if (operation === 'closeCollectionJourney' || operation === 'recordCollectionAction') {
            const j = await this.journey(org, id, a, s, operation === 'recordCollectionAction');
            if (operation === 'recordCollectionAction')
                await this.loan(org, String(p['loanId']), a, s);
            return j;
        }
        if (operation === 'correctCollectionAction') {
            const previous = await this.actionHead(org, id, s);
            if (previous['ownerId'] !== a._id)
                fail('RESOURCE_NOT_FOUND', 404);
            await this.loan(org, String(previous['loanId']), a, s);
            return previous;
        }
        if (id && operation.includes('CashDelivery')) {
            const d = await this.delivery(org, id, a, s);
            if (['dispatchCashDelivery', 'acknowledgeCashDeliveryCount'].includes(operation) && d.senderId !== a._id)
                fail('ACCESS_DENIED', 403);
            if (['receiveCashDelivery', 'countCashDelivery'].includes(operation) && d.receiverId !== a._id)
                fail('ACCESS_DENIED', 403);
            if (operation === 'cancelCashDelivery' && d.senderId !== a._id && !a.roles.includes('T'))
                fail('ACCESS_DENIED', 403);
            if (operation === 'recordCashDeliveryReturnFact') {
                const receiver = String(p['kind']).startsWith('RECEIVER_');
                if (a._id !== (receiver ? d.receiverId : d.senderId))
                    fail('ACCESS_DENIED', 403);
            }
            return d;
        }
        if (operation === 'finalizeCashClose') {
            const c = await this.row('cash_close_records', org, id, s);
            if (c['subjectId'] !== a._id && !a.roles.includes('T'))
                fail('RESOURCE_NOT_FOUND', 404);
            return c;
        }
        return null;
    }
    async snapshot(purpose, id, a, s, command) {
        if (!command || !isCollectionPurpose(purpose))
            fail('INPUT_INVALID', 422);
        const org = uuid(command['organizationId']);
        if (a.organizationId !== org || a.realm !== 'TENANT')
            fail('RESOURCE_NOT_FOUND', 404);
        const op = String(command['operationId']), p = command['payload'];
        collectionContract().validate(op, p);
        if (collectionContract().purpose(op, p) !== purpose || id !== (command['resourceId'] ?? null))
            fail('INPUT_INVALID', 422);
        await this.authority(op, org, a, p, id ?? undefined, s);
        const tenant = await this.identity.database.db.collection('organizations').findOne({ _id: org, status: 'ACTIVE' }, { session: s });
        if (!tenant)
            fail('ACCESS_DENIED', 403);
        return hash({ purpose, id, command, actor: a._id, authz: a.authzVersion, epoch: a.authEpoch, credential: a.credentialVersion, tenant: tenant.authEpoch });
    }
    async position(org, account, responsible, s) {
        const ledger = await accountBalance(this.identity.database, org, account._id, s), rs = await effectiveReserves(this.identity.database, org, s), all = await deliveries(this.identity.database, org, s), cs = await domainCollection(this.identity.database, 'cash_custody').find({ organizationId: org, responsibleId: responsible, accountId: account._id }, { session: s }).toArray();
        let retained = 0n, committed = 0n, delivered = 0n, held = 0n;
        const physical = zeroBuckets(), pendingRefs = [];
        for (const c of cs) {
            if (c['state'] === 'CONFIRMED_HELD') {
                const lot = await cashLot(this.identity.database, org, c._id, s);
                retained += lot.retained;
                committed += lot.committed;
                delivered += lot.delivered;
            }
            if (c['state'] === 'PROVISIONAL')
                addBucket(physical, 'provisionalOnSite', cents(String(c['amountHeld'])));
            if (c['state'] === 'RETURN_REQUIRED') {
                addBucket(physical, 'returnRequiredOnSite', cents(String(c['amountHeld'])));
                pendingRefs.push({ kind: 'RETURN', resourceId: c._id });
            }
            if (c['state'] === 'HELD_UNALLOCATED')
                pendingRefs.push({ kind: 'HELD', resourceId: c._id });
            if (c['state'] === 'PROVISIONAL')
                pendingRefs.push({ kind: 'PAYMENT', resourceId: c._id });
        }
        const heldRows = await domainCollection(this.identity.database, 'held_funds_reservations').find({ organizationId: org, accountId: account._id }, { session: s }).toArray();
        for (const h of heldRows)
            held += cents(String(h['amount']));
        physical.heldOnSite = money(held);
        physical.confirmedOnSite = money(ledger - held);
        for (const d of all) {
            if (![d.senderId, d.receiverId].includes(responsible) || ![d.sourceAccountId, d.destinationAccountId].includes(account._id))
                continue;
            if (activeDelivery(d))
                pendingRefs.push({ kind: d.state === 'DISCREPANCY' || d.state === 'INVESTIGATION' ? 'DISCREPANCY' : 'DELIVERY', resourceId: d._id });
            const m = physicalMovement(d);
            if (!m)
                continue;
            if (account._id === m.source && responsible === d.senderId) {
                if (m.at !== 'SOURCE')
                    addBucket(physical, 'confirmedOnSite', -m.amount);
                else if (m.missing)
                    addBucket(physical, 'confirmedOnSite', -m.missing);
                if (m.at === 'TRANSIT_SENDER')
                    addBucket(physical, 'inTransit', m.amount);
                if (m.at === 'DESTINATION' && m.missing)
                    addBucket(physical, 'unlocatedDisputed', m.missing);
                if (m.at === 'SOURCE' && m.surplus)
                    addBucket(physical, 'unidentifiedSurplus', m.surplus);
            }
            if (account._id === m.destination && responsible === d.receiverId) {
                if (m.at === 'DESTINATION') {
                    addBucket(physical, 'receivedUnposted', m.observed);
                    addBucket(physical, 'unidentifiedSurplus', m.surplus);
                }
                if (m.at === 'TRANSIT_RECEIVER')
                    addBucket(physical, 'inTransit', m.amount);
                if (m.at === 'SOURCE' && m.missing)
                    addBucket(physical, 'unlocatedDisputed', m.missing);
            }
        }
        const required = rs.filter(r => r.accountId === account._id).reduce((n, r) => n + cents(r.amount), 0n), comp = rs.filter(r => all.some(d => d._id === r.paymentId && d.kind === 'COMPENSATION')).filter(r => r.accountId === account._id).reduce((n, r) => n + cents(r.amount), 0n);
        if (required > ledger)
            fail('INTEGRITY_MISMATCH', 503);
        const u = await beginEvidence(this.identity.database, s, org);
        const binding = await domainCollection(this.identity.database, 'custody_bindings').findOne({ organizationId: org, custodianId: responsible, accountId: account._id }, { session: s });
        return { organizationId: org, responsibleId: responsible, accountId: account._id, accountETag: etag(account), bindingETag: binding ? etag(binding) : null, revisionETag: '"' + org + ':cash:' + u.org.revision + '"', ledgerBalance: money(ledger), retainedAtOrigin: money(retained), committed: money(committed), uncommitted: money(retained - committed), deliveredNet: money(delivered), held: money(held), compensationReserve: money(comp), available: money(ledger - required), physical, pendingRefs };
    }
    async positions(org, subject, s) {
        const rows = await domainCollection(this.identity.database, 'custody_bindings').find({ organizationId: org, custodianId: subject }, { session: s }).toArray(), stations = await this.table('cash_stations').find({ organizationId: org, receiverId: subject }, { session: s }).toArray(), ids = [...new Set([...rows.map(r => String(r['accountId'])), ...stations.map(r => r.accountId)])], result = [];
        for (const id of ids)
            result.push(await this.position(org, await this.account(org, id, s), subject, s));
        return result;
    }
    async plan(org, a, key, c, s, issued) {
        const kind = String(c['kind']);
        let d;
        const pre = [];
        if (kind === 'REQUEST') {
            const station = await this.row('cash_stations', org, String(c['stationId']), s);
            this.expected(station, c['stationETag']);
            if (!station.active)
                fail('STATE_CONFLICT');
            const binding = await domainCollection(this.identity.database, 'custody_bindings').findOne({ organizationId: org, custodianId: a._id }, { session: s });
            if (!binding || binding['accountId'] !== c['sourceAccountId'])
                fail('ACCESS_DENIED', 403);
            this.expected(binding, c['bindingETag']);
            await this.account(org, String(c['sourceAccountId']), s, c['sourceAccountETag']);
            await this.account(org, station.accountId, s);
            await this.party(org, station.receiverId, s, ['T', 'O']);
            if (a._id === station.receiverId || c['sourceAccountId'] === station.accountId)
                fail('DELIVERY_COUNTERPARTY_REQUIRED');
            if (c['journeyId']) {
                const j = await this.journey(org, String(c['journeyId']), a, s, true);
                if (j['status'] !== 'OPEN')
                    fail('STATE_CONFLICT');
            }
            const portions = c['portions'];
            validatePortions(portions, String(c['amount']));
            for (const portion of portions) {
                const lot = await cashLot(this.identity.database, org, portion.sourcePaymentId, s);
                this.expected(lot.row, portion.sourceCustodyETag);
                if (lot.row['responsibleId'] !== a._id || lot.row['accountId'] !== c['sourceAccountId'])
                    fail('RESOURCE_NOT_FOUND', 404);
                const p = await domainCollection(this.identity.database, 'payments').findOne({ _id: portion.sourcePaymentId, organizationId: org }, { session: s });
                if (!p || p['status'] !== 'CONFIRMED' || lot.row['state'] !== 'CONFIRMED_HELD')
                    fail('STATE_CONFLICT');
                if (lot.uncommitted < cents(portion.amount))
                    fail('DELIVERY_FUNDS_COMMITTED');
                pre.push({ resourceType: 'CUSTODY', resourceId: portion.sourcePaymentId, etag: etag(lot.row) });
            }
            d = { _id: idFor(org, a._id, 'REQUEST', key), organizationId: org, version: 1, kind: 'FORWARD', originalDeliveryId: null, sourceAccountId: String(c['sourceAccountId']), destinationAccountId: station.accountId, senderId: a._id, receiverId: station.receiverId, stationId: station._id, journeyId: c['journeyId'], amount: String(c['amount']), portions: structuredClone(portions), state: 'REQUESTED', immutableIntentHash: hash(c), countId: null, senderAckId: null, journalId: null, recordedAt: new Date(issued).toISOString(), effectiveDate: null, compensatingDeliveryId: null, sequence: 0, lastCount: null, receivedAt: null, investigated: false, returnFrom: null, receiverNonReceipt: false, sourceRecalled: false, receiverReturnDispatched: false, sourceReceived: false, returnCount: null, lastFactHash: null, requestDate: today(issued) };
            pre.push({ resourceType: 'STATION', resourceId: station._id, etag: etag(station) }, { resourceType: 'BINDING', resourceId: a._id, etag: etag(binding) });
        }
        else if (kind === 'COMPENSATE_REQUEST') {
            this.role(a, ['T']);
            const original = await this.delivery(org, String(c['originalDeliveryId']), a, s);
            this.expected(original, c['resourceETag']);
            requireState(original, ['CONFIRMED']);
            if (original.kind !== 'FORWARD' || original.compensatingDeliveryId || await this.table('cash_deliveries').findOne({ organizationId: org, originalDeliveryId: original._id, state: { $ne: 'CANCELLED' } }, { session: s }))
                fail('STATE_CONFLICT');
            const station = await this.row('cash_stations', org, original.stationId, s);
            if (!station.active || station.accountId !== original.destinationAccountId || station.receiverId !== original.receiverId)
                fail('STATE_CONFLICT');
            if (await available(this.identity.database, org, original.destinationAccountId, s) < cents(original.amount))
                fail('FUNDS_NOT_HELD');
            d = { ...structuredClone(original), _id: idFor(org, a._id, 'COMPENSATE_REQUEST', key), version: 1, kind: 'COMPENSATION', originalDeliveryId: original._id, sourceAccountId: original.destinationAccountId, destinationAccountId: original.sourceAccountId, senderId: original.receiverId, receiverId: original.senderId, journeyId: null, state: 'REQUESTED', immutableIntentHash: hash({ original: original.immutableIntentHash, command: c }), countId: null, senderAckId: null, journalId: null, recordedAt: new Date(issued).toISOString(), effectiveDate: null, compensatingDeliveryId: null, sequence: 0, lastCount: null, receivedAt: null, investigated: false, returnFrom: null, receiverNonReceipt: false, sourceRecalled: false, receiverReturnDispatched: false, sourceReceived: false, returnCount: null, lastFactHash: null, requestDate: today(issued) };
            pre.push({ resourceType: 'DELIVERY', resourceId: original._id, etag: etag(original) });
        }
        else if (kind === 'CONFIRM' || kind === 'COMPENSATE_CONFIRM') {
            this.role(a, ['T']);
            d = structuredClone(await this.delivery(org, String(c['deliveryId']), a, s));
            this.expected(d, c['resourceETag']);
            requireState(d, ['COUNTED', 'CORRECTED']);
            if (d.kind !== (kind === 'CONFIRM' ? 'FORWARD' : 'COMPENSATION'))
                fail('STATE_CONFLICT');
            if (d.lastCount !== d.amount || !d.countId || c['countId'] !== d.countId)
                fail('DELIVERY_COUNT_MISMATCH');
            const count = await this.row('cash_delivery_facts', org, d.countId, s);
            this.expected(count, c['countETag']);
            if (count['actorId'] !== d.receiverId || d.senderId === d.receiverId)
                fail('DELIVERY_COUNTERPARTY_REQUIRED');
            if (d.state === 'CORRECTED' && !d.senderAckId)
                fail('DELIVERY_COUNTERPARTY_REQUIRED');
            if (c['effectiveDate'] !== today(this.identity.now()))
                fail('DATE_NOT_ALLOWED');
            const station = await this.row('cash_stations', org, d.stationId, s);
            if (!station.active || station.receiverId !== (d.kind === 'FORWARD' ? d.receiverId : d.senderId))
                fail('STATE_CONFLICT');
            pre.push({ resourceType: 'DELIVERY', resourceId: d._id, etag: etag(d) }, { resourceType: 'COUNT', resourceId: count._id, etag: etag(count) }, { resourceType: 'STATION', resourceId: station._id, etag: etag(station) });
        }
        else
            return fail('INPUT_INVALID', 422);
        await this.authorizeParties(d, s);
        for (const id of [d.senderId, d.receiverId]) {
            const p = await this.party(org, id, s);
            pre.push({ resourceType: 'IDENTITY', resourceId: id, etag: p.version });
        }
        for (const id of [d.sourceAccountId, d.destinationAccountId])
            pre.push({ resourceType: 'ACCOUNT', resourceId: id, etag: etag(await this.account(org, id, s)) });
        const before = [await this.position(org, await this.account(org, d.sourceAccountId, s), d.senderId, s), await this.position(org, await this.account(org, d.destinationAccountId, s), d.receiverId, s)], after = structuredClone(before), postings = [];
        if (kind === 'CONFIRM' || kind === 'COMPENSATE_CONFIRM') {
            const n = cents(d.amount);
            postings.push({ accountId: d.destinationAccountId, debit: d.amount, credit: '0.00' }, { accountId: d.sourceAccountId, debit: '0.00', credit: d.amount });
            after[0].ledgerBalance = money(cents(after[0].ledgerBalance) - n);
            after[1].ledgerBalance = money(cents(after[1].ledgerBalance) + n);
            if (d.kind === 'FORWARD') {
                after[0].retainedAtOrigin = money(cents(after[0].retainedAtOrigin) - n);
                after[0].committed = money(cents(after[0].committed) - n);
                after[0].deliveredNet = money(cents(after[0].deliveredNet) + n);
                after[1].available = money(cents(after[1].available) + n);
            }
            else {
                after[0].compensationReserve = money(cents(after[0].compensationReserve) - n);
                after[1].retainedAtOrigin = money(cents(after[1].retainedAtOrigin) + n);
                after[1].uncommitted = money(cents(after[1].uncommitted) + n);
                after[1].deliveredNet = money(cents(after[1].deliveredNet) - n);
            }
            after[1].physical.receivedUnposted = money(cents(after[1].physical.receivedUnposted) - n);
            after[1].physical.confirmedOnSite = money(cents(after[1].physical.confirmedOnSite) + n);
        }
        else if (kind === 'REQUEST') {
            after[0].committed = money(cents(after[0].committed) + cents(d.amount));
            after[0].uncommitted = money(cents(after[0].uncommitted) - cents(d.amount));
        }
        else {
            after[0].compensationReserve = money(cents(after[0].compensationReserve) + cents(d.amount));
            after[0].available = money(cents(after[0].available) - cents(d.amount));
        }
        if (kind === 'CONFIRM' || kind === 'COMPENSATE_CONFIRM')
            for (const row of after)
                row.pendingRefs = row.pendingRefs.filter(x => x.resourceId !== d._id);
        else
            for (const row of after)
                row.pendingRefs.push({ kind: 'DELIVERY', resourceId: d._id });
        const unit = await beginEvidence(this.identity.database, s, org), state = await this.state(org, s);
        return { delivery: d, state, plan: { immutableIntentHash: d.immutableIntentHash, effectiveDate: String(c['effectiveDate'] ?? today(issued)), postings, before, after, currentPreconditions: pre, snapshotHash: hash({ state, readSet: [...unit.readSet].sort(), command: c, actor: { id: a._id, authz: a.authzVersion, epoch: a.authEpoch }, parties: await Promise.all([d.senderId, d.receiverId].map(id => this.party(org, id, s))) }) } };
    }
    async authorizeParties(d, s) {
        await this.party(d.organizationId, d.senderId, s);
        await this.party(d.organizationId, d.receiverId, s);
        if (d.senderId === d.receiverId || d.sourceAccountId === d.destinationAccountId)
            fail('DELIVERY_COUNTERPARTY_REQUIRED');
        const owner = d.kind === 'FORWARD' ? d.senderId : d.receiverId, account = d.kind === 'FORWARD' ? d.sourceAccountId : d.destinationAccountId, binding = await domainCollection(this.identity.database, 'custody_bindings').findOne({ organizationId: d.organizationId, custodianId: owner }, { session: s });
        if (!binding || binding['accountId'] !== account)
            fail('ACCOUNT_PROFILE_CONFLICT');
    }
    async preview(context, organization, input) {
        collectionContract().validate('previewCashDelivery', input);
        const payload = canonical(input);
        collectionContract().validate('previewCashDelivery', payload);
        const org = uuid(organization), key = uuid(payload['executionKey']);
        return await this.identity.database.transaction(async (s) => { const { actor } = await this.actor(context, org, s); await this.authority('previewCashDelivery', org, actor, payload, undefined, s); const issued = this.identity.now(), c = payload['command'], planned = await this.plan(org, actor, key, c, s, issued), claims = { org, actor: actor._id, key, command: c, issued, expires: issued + 300000, collections: planned.state.collectionsBookETag, fingerprint: hash(planned.plan) }; return { status: 200, data: { token: this.signed(claims), expiresAt: new Date(claims.expires).toISOString(), state: planned.state, plan: planned.plan } }; });
    }
    async fact(d, a, kind, p, key, s, amount = null) {
        const at = String(p['occurredAt'] ?? new Date(this.identity.now()).toISOString());
        if (Date.parse(at) > this.identity.now() || Date.parse(at) < Date.parse(d.recordedAt))
            fail('INPUT_INVALID', 422);
        d.sequence++;
        const row = { _id: idFor(d.organizationId, key, 'fact'), organizationId: d.organizationId, version: 1, deliveryId: d._id, sequence: d.sequence, actorId: a._id, kind, amount, countId: p['countId'] ?? null, occurredAt: at, recordedAt: new Date(this.identity.now()).toISOString(), ...reason(p), denominations: p['denominations'] ?? [], previousHash: d.lastFactHash };
        await this.table('cash_delivery_facts').insertOne(row, { session: s });
        d.lastFactHash = hash(row);
        return row;
    }
    async mutate(context, operation, organization, input, keyValue, ifMatch, resourceId) {
        collectionContract().validate(operation, input);
        const p = canonical(input);
        collectionContract().validate(operation, p);
        const org = uuid(organization), key = uuid(keyValue), purpose = collectionContract().purpose(operation, p);
        if (!isCollectionPurpose(purpose) || purpose === 'CASH_DELIVERY_PREVIEW')
            fail('INPUT_INVALID', 422);
        if (!ifMatch)
            fail('ETAG_REQUIRED', 428);
        const command = { organizationId: org, idempotencyKey: key, expectedETag: ifMatch, operationId: operation, resourceId: resourceId ?? null, payload: p }, fingerprint = hash(command);
        try {
            return await this.identity.database.transaction(async (s) => {
                const { actor: a, org: tenant } = await this.actor(context, org, s);
                const authorized = await this.authority(operation, org, a, p, resourceId, s);
                await this.snapshot(purpose, resourceId ?? null, a, s, command);
                await this.identity.sessions.consumeProof(context, purpose, resourceId ?? null, s, command);
                const old = await this.table('collection_commands').findOne({ organizationId: org, actorId: a._id, purpose, key }, { session: s });
                if (old) {
                    if (old['fingerprint'] !== fingerprint)
                        fail('IDEMPOTENCY_CONFLICT');
                    const result = structuredClone(old['result']);
                    result.data['replayed'] = true;
                    return { ...result, status: 200 };
                }
                const state = await this.state(org, s);
                if (state.collectionsBookETag !== ifMatch)
                    fail('PRECONDITION_FAILED', 412);
                let entity, entityType = 'DELIVERY', journalId = null;
                const now = new Date(this.identity.now()).toISOString(), newId = idFor(org, a._id, purpose, key);
                if (['requestCashDelivery', 'confirmCashDelivery', 'requestCashDeliveryCompensation', 'confirmCashDeliveryCompensation'].includes(operation)) {
                    const claims = this.decoded(String(p['previewToken'])), c = p['command'];
                    if (claims.org !== org || claims.actor !== a._id || claims.key !== key || claims.collections !== ifMatch || hash(claims.command) !== hash(c))
                        fail('PREVIEW_STALE');
                    if (this.identity.now() >= claims.expires || claims.issued > this.identity.now() || claims.expires - claims.issued !== 300000)
                        fail('PREVIEW_EXPIRED');
                    const kind = operation === 'requestCashDelivery' ? 'REQUEST' : operation === 'confirmCashDelivery' ? 'CONFIRM' : operation === 'requestCashDeliveryCompensation' ? 'COMPENSATE_REQUEST' : 'COMPENSATE_CONFIRM';
                    if (c['kind'] !== kind || resourceId && resourceId !== c[c['kind'] === 'COMPENSATE_REQUEST' ? 'originalDeliveryId' : 'deliveryId'])
                        fail('INPUT_INVALID', 422);
                    const planned = await this.plan(org, a, key, c, s, claims.issued);
                    if (hash(planned.plan) !== claims.fingerprint)
                        fail('PREVIEW_STALE');
                    const d = planned.delivery;
                    if (kind === 'REQUEST' || kind === 'COMPENSATE_REQUEST') {
                        await this.table('cash_deliveries').insertOne(d, { session: s });
                        for (const part of d.portions)
                            await this.table('cash_delivery_allocations').insertOne({ _id: idFor(d._id, part.sourcePaymentId), organizationId: org, version: 1, deliveryId: d._id, sourcePaymentId: part.sourcePaymentId, amount: part.amount, kind: d.kind, recordedAt: now }, { session: s });
                    }
                    else {
                        d.state = 'CONFIRMED';
                        d.effectiveDate = String(c['effectiveDate']);
                        d.version++;
                        await this.table('cash_deliveries').replaceOne({ _id: d._id, organizationId: org }, d, { session: s });
                        await this.identity.database.db.collection('financial_books').updateOne({ _id: org }, { $inc: { value: 1 }, $setOnInsert: { recordedAt: 0 } }, { session: s, upsert: true });
                        if (await this.identity.finance.journals.findOne({ organizationId: org, effectiveDate: { $gt: d.effectiveDate } }, { session: s }))
                            fail('LATER_JOURNAL_CONFLICT');
                        const j = await this.identity.finance.writeJournal(org, d.effectiveDate, planned.plan.postings, { type: d.kind === 'FORWARD' ? 'CASH_DELIVERY' : 'CASH_DELIVERY_COMPENSATION', id: d._id }, null, 'Traslado de efectivo existente S07', String(c['supportReference']), s);
                        journalId = j._id;
                        d.journalId = j._id;
                        await this.table('cash_deliveries').replaceOne({ _id: d._id, organizationId: org }, d, { session: s });
                        await recordFinancialEvidence(this.identity.database, s);
                    }
                    entity = d;
                }
                else if (operation === 'openCollectionJourney') {
                    if (await this.table('collection_journeys').findOne({ organizationId: org, ownerId: a._id, status: 'OPEN' }, { session: s }))
                        fail('STATE_CONFLICT');
                    entity = { _id: newId, organizationId: org, version: 1, ownerId: a._id, openedAt: now, recordedAt: now, workDate: today(this.identity.now()), zone: 'America/Bogota', status: 'OPEN', closedAt: null, cashCloseId: null, pendingRefs: [], reason: null };
                    await this.table('collection_journeys').insertOne(entity, { session: s });
                    entityType = 'JOURNEY';
                }
                else if (operation === 'closeCollectionJourney') {
                    const j = authorized;
                    this.expected(j, p['resourceETag']);
                    if (j['status'] !== 'OPEN')
                        fail('STATE_CONFLICT');
                    const positions = await this.positions(org, String(j['ownerId']), s), pending = positions.flatMap(x => x.pendingRefs);
                    if (positions.some(x => bucketNames.some(k => cents(x.physical[k]) > 0n)) || await this.table('cash_deliveries').findOne({ organizationId: org, journeyId: j._id }, { session: s })) {
                        if (p['cashCloseId']) {
                            const close = await this.row('cash_close_records', org, String(p['cashCloseId']), s);
                            this.expected(close, p['cashCloseETag']);
                            if (close['journeyId'] !== j._id || close['subjectId'] !== j['ownerId'] || close['state'] === 'OPEN')
                                fail('STATE_CONFLICT');
                            pending.push(...close['pendingRefs']);
                        }
                        else
                            pending.push({ kind: 'COUNT_MISSING', resourceId: j._id });
                    }
                    if (p['mode'] === 'EXACT' && pending.length)
                        fail('CASH_CLOSE_PENDING');
                    j['status'] = pending.length ? 'CLOSED_WITH_PENDING' : 'CLOSED';
                    j['closedAt'] = now;
                    j['cashCloseId'] = p['cashCloseId'];
                    j['pendingRefs'] = pending;
                    j['reason'] = p['reason'];
                    j.version++;
                    await this.table('collection_journeys').replaceOne({ _id: j._id, organizationId: org }, j, { session: s });
                    entity = j;
                    entityType = 'JOURNEY';
                }
                else if (operation === 'recordCollectionAction' || operation === 'correctCollectionAction') {
                    const previous = operation === 'correctCollectionAction' ? authorized : null, j = previous ? await this.journey(org, String(previous['journeyId']), a, s, true) : authorized;
                    this.expected(previous ?? j, p['resourceETag']);
                    if (j['status'] !== 'OPEN')
                        fail('STATE_CONFLICT');
                    const kind = String(previous?.['kind'] ?? p['kind']), loanId = String(previous?.['loanId'] ?? p['loanId']);
                    if (Date.parse(String(p['occurredAt'])) > this.identity.now() || Date.parse(String(p['occurredAt'])) < Date.parse(String(j['openedAt'])))
                        fail('INPUT_INVALID', 422);
                    if (kind === 'PROMISE') {
                        if (!p['promisedAmount'] || !p['promisedDate'] || String(p['promisedDate']) < today(Date.parse(String(p['occurredAt']))))
                            fail('INPUT_INVALID', 422);
                    }
                    else if (p['promisedAmount'] !== null || p['promisedDate'] !== null)
                        fail('INPUT_INVALID', 422);
                    entity = { _id: newId, organizationId: org, version: (previous?.version ?? 0) + 1, journeyId: j._id, ownerId: a._id, loanId, kind, occurredAt: p['occurredAt'], recordedAt: now, note: p['note'], supportReference: p['supportReference'], promisedAmount: p['promisedAmount'], promisedDate: p['promisedDate'], supersedesActionId: previous?._id ?? null, reason: p['reason'] ?? null };
                    await this.table('collection_actions').insertOne(entity, { session: s });
                    entityType = 'ACTION';
                }
                else if (operation === 'setCashStation') {
                    const id = uuid(p['stationId']), current = await this.table('cash_stations').findOne({ _id: id, organizationId: org }, { session: s });
                    this.expected(current ?? { _id: id, version: 0 }, p['resourceETag']);
                    const receiver = await this.party(org, uuid(p['receiverId']), s, ['T', 'O']);
                    if (receiver.version !== p['receiverETag'])
                        fail('PRECONDITION_FAILED', 412);
                    const account = await this.account(org, String(p['accountId']), s, p['accountETag']);
                    if (await domainCollection(this.identity.database, 'custody_bindings').findOne({ organizationId: org, accountId: account._id }, { session: s }))
                        fail('ACCOUNT_PROFILE_CONFLICT');
                    if (current && (current.receiverId !== receiver._id || current.accountId !== account._id || p['active'] === false) && (await accountBalance(this.identity.database, org, current.accountId, s) > 0n || await this.table('cash_deliveries').findOne({ organizationId: org, stationId: id, state: { $in: policy.deliveryStates.filter(state => !['CONFIRMED', 'CANCELLED'].includes(state)) } }, { session: s })))
                        fail('STATE_CONFLICT');
                    entity = { _id: id, organizationId: org, version: (current?.version ?? 0) + 1, accountId: account._id, accountETag: etag(account), receiverId: receiver._id, receiverETag: receiver.version, active: p['active'], recordedAt: current?.recordedAt ?? now };
                    await this.table('cash_stations').replaceOne({ _id: id, organizationId: org }, entity, { session: s, upsert: true });
                    entityType = 'STATION';
                }
                else if (operation === 'createCashClose') {
                    const subject = uuid(p['subjectId']);
                    if (a._id !== subject && !a.roles.includes('T'))
                        fail('RESOURCE_NOT_FOUND', 404);
                    const positions = await this.positions(org, subject, s), position = positions.find(x => x.accountId === p['accountId']);
                    if (!position)
                        fail('RESOURCE_NOT_FOUND', 404);
                    const account = await this.account(org, String(p['accountId']), s, p['accountETag']);
                    if (p['journeyId']) {
                        const j = await this.row('collection_journeys', org, String(p['journeyId']), s);
                        if (j['ownerId'] !== subject)
                            fail('RESOURCE_NOT_FOUND', 404);
                    }
                    if (Date.parse(String(p['observedAt'])) > this.identity.now())
                        fail('INPUT_INVALID', 422);
                    if (p['countStatus'] === 'DECLARED' && a._id !== subject)
                        fail('ACCESS_DENIED', 403);
                    const pending = [...position.pendingRefs];
                    if (p['countStatus'] === 'MISSING')
                        pending.push({ kind: 'COUNT_MISSING', resourceId: account._id });
                    else {
                        const counted = p['counted'];
                        denominations(p['denominations'], bucketNames.filter(k => k !== 'unlocatedDisputed').reduce((n, k) => n + cents(counted[k]), 0n));
                        if (hash(counted) !== hash(position.physical))
                            pending.push({ kind: 'DISCREPANCY', resourceId: account._id });
                    }
                    if (p['supersedesCloseId']) {
                        const oldClose = await this.row('cash_close_records', org, String(p['supersedesCloseId']), s);
                        if (oldClose['subjectId'] !== subject || oldClose['accountId'] !== account._id)
                            fail('RESOURCE_NOT_FOUND', 404);
                    }
                    entity = { _id: newId, organizationId: org, version: 1, subjectId: subject, accountId: account._id, journeyId: p['journeyId'], observedAt: p['observedAt'], recordedAt: now, state: 'OPEN', expected: position.physical, counted: p['counted'], countStatus: p['countStatus'], declaredBy: p['countStatus'] === 'DECLARED' ? a._id : null, denominations: p['denominations'], snapshotHash: hash(position), expectedPositionHash: hash({ ...position, revisionETag: '' }), pendingRefs: pending, supersedesCloseId: p['supersedesCloseId'], reason: p['reason'], positionRevision: position.revisionETag };
                    await this.table('cash_close_records').insertOne(entity, { session: s });
                    entityType = 'CASH_CLOSE';
                }
                else if (operation === 'finalizeCashClose') {
                    const c = authorized;
                    this.expected(c, p['resourceETag']);
                    if (c['state'] !== 'OPEN')
                        fail('STATE_CONFLICT');
                    const currentPosition = (await this.positions(org, String(c['subjectId']), s)).find(x => x.accountId === c['accountId']);
                    if (!currentPosition || hash({ ...currentPosition, revisionETag: '' }) !== c['expectedPositionHash'])
                        fail('PRECONDITION_FAILED', 412);
                    if (p['mode'] === 'EXACT' && (c['countStatus'] === 'MISSING' || c['pendingRefs'].length))
                        fail('CASH_CLOSE_PENDING');
                    c['state'] = c['pendingRefs'].length ? 'CLOSED_WITH_PENDING' : 'CLOSED';
                    c['reason'] = p['reason'];
                    c.version++;
                    await this.table('cash_close_records').replaceOne({ _id: c._id, organizationId: org }, c, { session: s });
                    entity = c;
                    entityType = 'CASH_CLOSE';
                }
                else {
                    const d = authorized;
                    if (!d)
                        fail('INPUT_INVALID', 422);
                    this.expected(d, p['resourceETag']);
                    await this.authorizeParties(d, s);
                    let fact;
                    if (operation === 'dispatchCashDelivery') {
                        requireState(d, ['REQUESTED']);
                        d.state = 'IN_TRANSIT';
                        fact = await this.fact(d, a, 'DISPATCH', p, key, s, d.amount);
                    }
                    else if (operation === 'receiveCashDelivery') {
                        requireState(d, ['IN_TRANSIT']);
                        d.state = 'RECEIVED_FOR_REVIEW';
                        d.receivedAt = now;
                        fact = await this.fact(d, a, 'RECEIVE', p, key, s, d.amount);
                    }
                    else if (operation === 'countCashDelivery') {
                        denominations(p['denominations'], cents(String(p['amount'])));
                        d.state = countedState(d, String(p['amount']));
                        d.lastCount = String(p['amount']);
                        d.senderAckId = null;
                        fact = await this.fact(d, a, 'COUNT', p, key, s, d.lastCount);
                        d.countId = fact._id;
                    }
                    else if (operation === 'investigateCashDelivery') {
                        requireState(d, ['DISCREPANCY']);
                        d.investigated = true;
                        d.state = 'INVESTIGATION';
                        fact = await this.fact(d, a, 'INVESTIGATION', p, key, s);
                    }
                    else if (operation === 'acknowledgeCashDeliveryCount' || operation === 'correctCashDelivery') {
                        requireState(d, ['INVESTIGATION']);
                        if (d.lastCount !== d.amount || p['countId'] !== d.countId)
                            fail('DELIVERY_COUNT_MISMATCH');
                        const count = await this.row('cash_delivery_facts', org, String(p['countId']), s);
                        this.expected(count, p['countETag']);
                        if (operation === 'correctCashDelivery') {
                            if (!d.senderAckId)
                                fail('DELIVERY_COUNTERPARTY_REQUIRED');
                            d.state = 'CORRECTED';
                            fact = await this.fact(d, a, 'CORRECTION', p, key, s);
                        }
                        else {
                            fact = await this.fact(d, a, 'SENDER_ACK', p, key, s);
                            d.senderAckId = fact._id;
                        }
                    }
                    else if (operation === 'cancelCashDelivery') {
                        requireState(d, ['REQUESTED']);
                        d.state = 'CANCELLED';
                        fact = await this.fact(d, a, 'CANCEL', p, key, s);
                    }
                    else if (operation === 'requestCashDeliveryReturn') {
                        requireState(d, ['IN_TRANSIT', 'RECEIVED_FOR_REVIEW', 'COUNTED', 'CORRECTED', 'DISCREPANCY', 'INVESTIGATION']);
                        d.returnFrom = d.state;
                        d.state = 'RETURN_REQUIRED';
                        fact = await this.fact(d, a, 'RETURN_REQUEST', p, key, s);
                    }
                    else if (operation === 'recordCashDeliveryReturnFact') {
                        requireState(d, ['RETURN_REQUIRED', 'RETURN_IN_TRANSIT', 'RETURN_RECEIVED']);
                        const kind = String(p['kind']), amount = String(p['amount']);
                        if (kind !== 'SOURCE_COUNT' && amount !== d.amount)
                            fail('DELIVERY_COUNT_MISMATCH');
                        if (kind === 'RECEIVER_NON_RECEIPT') {
                            if (d.receivedAt)
                                fail('STATE_CONFLICT');
                            d.receiverNonReceipt = true;
                        }
                        else if (kind === 'SOURCE_RECALLED') {
                            if (d.receivedAt || !d.receiverNonReceipt)
                                fail('STATE_CONFLICT');
                            d.sourceRecalled = true;
                            d.state = 'RETURN_RECEIVED';
                        }
                        else if (kind === 'RECEIVER_RETURN_DISPATCHED') {
                            if (!d.receivedAt || d.sourceReceived)
                                fail('STATE_CONFLICT');
                            d.receiverReturnDispatched = true;
                            d.state = 'RETURN_IN_TRANSIT';
                        }
                        else if (kind === 'SOURCE_RECEIVED') {
                            if (!d.receiverReturnDispatched)
                                fail('STATE_CONFLICT');
                            d.sourceReceived = true;
                            d.state = 'RETURN_RECEIVED';
                        }
                        else {
                            if (!d.sourceReceived && !d.sourceRecalled)
                                fail('STATE_CONFLICT');
                            d.returnCount = amount;
                        }
                        fact = await this.fact(d, a, kind, p, key, s, amount);
                    }
                    else if (operation === 'confirmCashDeliveryReturn') {
                        requireState(d, ['RETURN_RECEIVED']);
                        if (d.returnCount !== d.amount || !(d.sourceReceived && d.receiverReturnDispatched || d.sourceRecalled && d.receiverNonReceipt))
                            fail('DELIVERY_COUNTERPARTY_REQUIRED');
                        d.state = 'CANCELLED';
                        fact = await this.fact(d, a, 'RETURN_CONFIRMED', p, key, s, d.amount);
                    }
                    else
                        return fail('INPUT_INVALID', 422);
                    d.version++;
                    await this.table('cash_deliveries').replaceOne({ _id: d._id, organizationId: org }, d, { session: s });
                    entity = fact;
                    entityType = 'FACT';
                }
                const oldBook = await this.table('collection_books').findOne({ _id: org, organizationId: org }, { session: s }), version = (oldBook?.version ?? 0) + 1;
                await this.table('collection_books').replaceOne({ _id: org, organizationId: org }, { _id: org, organizationId: org, version, policyVersion: policy.version }, { session: s, upsert: true });
                const data = { id: key, organizationId: org, actorId: a._id, purpose, entityId: entity._id, entityType, resourceETag: etag(entity), collectionsBookETag: (await this.state(org, s)).collectionsBookETag, journalId, replayed: false }, result = { status: 201, data, etag: etag(entity) };
                collectionContract().result(operation, 201, { data });
                await this.table('collection_transitions').insertOne({ _id: newId, organizationId: org, version, operation, purpose, actorId: a._id, entityId: entity._id, entityHash: hash(entity), payloadHash: hash(p), recordedAt: now }, { session: s });
                await this.table('collection_commands').insertOne({ _id: newId, organizationId: org, version: 1, actorId: a._id, purpose, key, fingerprint, result, recordedAt: now }, { session: s });
                await this.identity.identities.updateOne({ _id: a._id, authEpoch: a.authEpoch, authzVersion: a.authzVersion, suspended: false }, { $inc: { operationCommandFence: 1 } }, { session: s });
                await this.identity.database.db.collection('organizations').updateOne({ _id: org, status: 'ACTIVE', authEpoch: tenant.authEpoch }, { $inc: { operationCommandFence: 1 } }, { session: s });
                await recordLendingEvidence(this.identity.database, s);
                await this.identity.audit.append({ realm: 'TENANT', actorId: a._id, subjectId: a._id, action: purpose, outcome: 'SUCCESS', lending: { operation, id: entity._id, version: entity.version } }, s);
                return result;
            });
        }
        catch (e) {
            if (e && typeof e === 'object' && 'code' in e && e.code === 11000)
                fail('STATE_CONFLICT');
            throw e;
        }
    }
    page(items, query, binding, revision) {
        const limit = query['limit'] === undefined ? 100 : Number(query['limit']);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
            fail('INPUT_INVALID', 422);
        const key = (row) => String(row['recordedAt'] ?? row['openedAt'] ?? '') + '|' + String(row['id'] ?? row['loanId'] ?? row['stationId'] ?? row['accountId']);
        items.sort((a, b) => key(a).localeCompare(key(b)));
        let last = '';
        if (query['cursor']) {
            const c = this.decoded(String(query['cursor']), 'S07_CURSOR:');
            if (c.binding !== binding || c.revision !== revision)
                fail('INVALID_CURSOR', 422);
            last = c.last;
        }
        const rows = items.filter(x => key(x) > last), page = rows.slice(0, limit), next = rows.length > limit ? this.signed({ binding, revision, last: key(page.at(-1)) }, 'S07_CURSOR:') : null;
        if (next && next.length > 2048)
            fail('INPUT_TOO_LARGE', 413);
        return { items: page, nextCursor: next, snapshotETag: '"collections:snapshot:' + revision + '"' };
    }
    async read(context, operation, organization, id, query = {}) {
        const org = uuid(organization);
        return await this.identity.database.transaction(async (s) => {
            const { actor: a, org: tenant } = await this.actor(context, org, s);
            if (operation === 'getCollectionsPolicy')
                return { status: 200, data: policy };
            this.role(a, ['T', 'O', 'C']);
            if (operation === 'getCollectionsState')
                return { status: 200, data: await this.state(org, s) };
            const defs = {
                listCollectionJourneys: { table: 'collection_journeys', schema: 'S07Journey', scope: r => r['ownerId'] === a._id }, getCollectionJourney: { table: 'collection_journeys', schema: 'S07Journey', scope: r => r['ownerId'] === a._id },
                listCollectionActions: { table: 'collection_actions', schema: 'S07Action', scope: r => r['ownerId'] === a._id }, getCollectionAction: { table: 'collection_actions', schema: 'S07Action', scope: r => r['ownerId'] === a._id },
                listCashDeliveries: { table: 'cash_deliveries', schema: 'S07Delivery', scope: r => r['senderId'] === a._id || r['receiverId'] === a._id }, getCashDelivery: { table: 'cash_deliveries', schema: 'S07Delivery', scope: r => r['senderId'] === a._id || r['receiverId'] === a._id },
                listCashCloses: { table: 'cash_close_records', schema: 'S07CashClose', scope: r => r['subjectId'] === a._id }, getCashClose: { table: 'cash_close_records', schema: 'S07CashClose', scope: r => r['subjectId'] === a._id },
                getCashStation: { table: 'cash_stations', schema: 'S07Station', scope: r => r['receiverId'] === a._id },
            };
            let data, resourceETag, items;
            if (defs[operation]) {
                const def = defs[operation], rows = id ? [operation === 'getCollectionAction' ? await this.actionHead(org, id, s) : await this.row(def.table, org, id, s)] : await this.table(def.table).find({ organizationId: org }, { session: s }).toArray();
                const allowed = rows.filter(r => a.roles.includes('T') || def.scope(r));
                if (id && !allowed[0])
                    fail('RESOURCE_NOT_FOUND', 404);
                if (def.schema === 'S07Delivery')
                    for (const row of allowed)
                        if (row['kind'] === 'FORWARD') {
                            const compensation = await this.table('cash_deliveries').findOne({ organizationId: org, originalDeliveryId: row._id, state: 'CONFIRMED' }, { session: s });
                            row['compensatingDeliveryId'] = compensation?._id ?? null;
                        }
                items = allowed.filter(r => Object.entries(query).every(([k, v]) => ['cursor', 'limit'].includes(k) || String(r[k === 'status' && def.table !== 'collection_journeys' ? 'state' : k === 'ownerId' && def.table === 'cash_close_records' ? 'subjectId' : k]) === String(v))).map(r => publicFields(def.schema, r));
                if (id) {
                    data = items[0];
                    resourceETag = etag(allowed[0]);
                }
            }
            else if (operation === 'listCashStations') {
                const rows = await this.table('cash_stations').find({ organizationId: org }, { session: s }).toArray();
                items = [];
                for (const st of rows) {
                    if (!a.roles.includes('T') && !(st.active || st.receiverId === a._id))
                        continue;
                    if (query['active'] !== undefined && st.active !== (query['active'] === true || query['active'] === 'true'))
                        continue;
                    const account = await this.account(org, st.accountId, s), receiver = await this.identity.identities.findOne({ _id: st.receiverId, organizationId: org }, { session: s });
                    if (!receiver)
                        fail('INTEGRITY_MISMATCH', 503);
                    items.push({ stationId: st._id, stationETag: etag(st), accountId: st.accountId, accountLabel: account.name, receiverId: st.receiverId, receiverName: receiver.displayName, active: st.active });
                }
            }
            else if (operation === 'listCashPositions' || operation === 'getCashPosition') {
                const subject = id ?? String(query['responsibleId'] ?? a._id);
                if (subject !== a._id && !a.roles.includes('T'))
                    fail('RESOURCE_NOT_FOUND', 404);
                if (!await this.identity.identities.findOne({ _id: subject, organizationId: org, realm: 'TENANT' }, { session: s }))
                    fail('RESOURCE_NOT_FOUND', 404);
                if (operation === 'listCashPositions' && a.roles.includes('T') && !query['responsibleId']) {
                    const bindings = await domainCollection(this.identity.database, 'custody_bindings').find({ organizationId: org }, { session: s }).toArray(), stations = await this.table('cash_stations').find({ organizationId: org }, { session: s }).toArray(), ids = [...new Set([...bindings.map(b => String(b['custodianId'])), ...stations.map(st => st.receiverId)])];
                    items = [];
                    for (const owner of ids)
                        items.push(...await this.positions(org, owner, s));
                }
                else
                    items = await this.positions(org, subject, s);
            }
            else if (operation === 'listCashDeliveryFacts') {
                await this.delivery(org, id, a, s);
                items = (await this.table('cash_delivery_facts').find({ organizationId: org, deliveryId: id }, { session: s }).toArray()).map(r => publicFields('S07Fact', r));
            }
            else if (operation === 'getCollectionCommand') {
                const row = await this.table('collection_commands').findOne({ organizationId: org, key: uuid(id), ...(!a.roles.includes('T') ? { actorId: a._id } : {}) }, { session: s });
                if (!row)
                    fail('RESOURCE_NOT_FOUND', 404);
                const transition = await this.table('collection_transitions').findOne({ _id: row._id, organizationId: org }, { session: s });
                if (!transition || transition['actorId'] !== row['actorId'] || transition['purpose'] !== row['purpose'])
                    fail('INTEGRITY_MISMATCH', 503);
                data = row['result'].data;
            }
            else if (operation === 'listCollectionPortfolio') {
                items = [];
                const seen = new Set();
                const contexts = await this.identity.payments.registrationContexts(tenant, a, s);
                for (const row of contexts) {
                    const loanId = String(row['loanId']);
                    if (seen.has(loanId) || query['loanId'] && query['loanId'] !== loanId)
                        continue;
                    seen.add(loanId);
                    items.push({ loanId, loanReference: row['loanReference'], borrowerId: row['borrowerId'], borrowerCode: row['borrowerCode'], borrowerName: row['borrowerName'], principalOutstanding: row['principalOutstanding'], dueAmount: row['dueAmount'], positionETag: row['positionETag'] });
                }
            }
            else
                return fail('INPUT_INVALID', 422);
            if (data === undefined && items) {
                const u = await beginEvidence(this.identity.database, s, org);
                data = this.page(items, query, hash({ org, actor: a._id, roles: a.roles, epoch: a.authEpoch, authz: a.authzVersion, operation, id, filters: Object.fromEntries(Object.entries(query).filter(([k]) => !['limit', 'cursor'].includes(k))) }), u.org.revision);
            }
            const result = { status: 200, data, ...(resourceETag ? { etag: resourceETag } : {}) };
            collectionContract().result(operation, 200, { data });
            return result;
        });
    }
}
//# sourceMappingURL=service.js.map