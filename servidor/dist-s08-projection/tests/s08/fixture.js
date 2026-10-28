/* Synthetic fixture fields from fixed versioned models; no HTTP input. */
import { randomUUID, createHmac } from 'node:crypto';
import { BSON, Decimal128 } from 'mongodb';
import { setup } from '../s07/fixture.js';
import { password } from './profile.js';
import { domainCollections, evidenceIndexData, evidenceIndexEntries, exactHash, headDigest } from '../../src/modules/lending/evidence-v2.js';
import { recordFinancialEvidence } from '../../src/modules/finance/integrity.js';
import { verifyLoan } from '../../src/modules/lending/verification.js';
import { hash } from '../../src/modules/lending/contract.js';
import { stateOf } from '../../src/modules/lending/operations-service.js';
const clone = (value) => BSON.EJSON.parse(BSON.EJSON.stringify(value, { relaxed: false }));
function fixturePriority(f) { const key = Reflect.get(f.keys, 'priority'); if (!Buffer.isBuffer(key))
    throw Error('Owned fixture requires existing priority key'); return key; }
function fixtureTree(namespace, items, priorityKey) {
    const stack = [], nodes = [];
    for (const [key, data] of items.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        const n = { key, data, priority: createHmac('sha256', priorityKey).update(JSON.stringify(['CAUDELYX:PRIORITY:v1', namespace, key])).digest('hex'), left: null, right: null };
        while (stack.length && (stack.at(-1).priority > n.priority || stack.at(-1).priority === n.priority && stack.at(-1).key > n.key))
            n.left = stack.pop();
        if (stack.length)
            stack.at(-1).right = n;
        stack.push(n);
    }
    const finish = (n) => {
        if (!n)
            return null;
        const left = finish(n.left), right = finish(n.right), height = 1 + Math.max(left?.height ?? 0, right?.height ?? 0);
        if (height > 128)
            throw Error('Owned fixture evidence height exceeded');
        const { key, data, priority } = n, _id = namespace + ':' + exactHash(key), hash = exactHash({ namespace, key, priority, data, left, right, height }), count = 1 + (left?.count ?? 0) + (right?.count ?? 0);
        nodes.push({ _id, namespace, key, priority, data, left, right, height, hash, count });
        return { id: _id, hash, count, height };
    };
    return { root: finish(stack[0] ?? null), nodes };
}
async function ownedEvidenceImage(f) {
    if (!/^caudelyx_s08_p02_[a-f0-9]{24}$/.test(f.database.db.databaseName))
        throw Error('Unowned bulk fixture');
    const priority = fixturePriority(f);
    const counts = {}, items = [];
    // eslint-disable-next-line security/detect-object-injection -- Names come from the fixed domain collection catalogue, never request input.
    for (const name of domainCollections) {
        const rows = await f.database.db.collection(name).find(name === 'lending_domain_state' ? { _id: f.org } : { organizationId: f.org }).toArray();
        counts[name] = rows.length;
        for (const row of rows)
            items.push(...evidenceIndexEntries(evidenceIndexData(name, row)));
    }
    return { counts, ...fixtureTree('hmac-v1:' + f.org, items, priority) };
}
export async function benchmarkFixture(group, population = 1000) {
    if (![100, 1000].includes(population))
        throw Error('Unsupported own benchmark population');
    const f = await setup(group), l = await f.loan({ principal: '2000000.00', installmentCount: 12 });
    await f.disburse(l);
    if (!group.names.includes(f.database.db.databaseName) || !/^caudelyx_s08_p02_[a-f0-9]{24}$/.test(f.database.db.databaseName))
        throw Error('Unowned benchmark fixture');
    const db = f.database.db, org = f.org, actor = f.a.issued.context.subjectId, loan = (await db.collection('lending_loans').findOne({ _id: l.id })), version = (await db.collection('lending_loan_versions').findOne({ loanId: l.id, termsVersion: 1 })), position = (await db.collection('loan_positions').findOne({ loanId: l.id })), schedule = (await db.collection('loan_schedule_versions').findOne({ loanId: l.id })), fund = (await db.collection('loan_events').findOne({ _id: position['fundingEventId'] })), fundJournal = (await db.collection('financial_journals').findOne({ _id: fund['journalId'] }));
    const oldOrg = await db.collection('lending_merkle_orgs').findOne({ _id: org }), oldHead = await db.collection('lending_domain_state').findOne({ _id: 'evidence' });
    if (!oldOrg || oldHead?.format !== 'lending-v2' || await db.collection('lending_merkle_orgs').countDocuments({}) !== 1)
        throw Error('Unexpected owned fixture base');
    const initial = await ownedEvidenceImage(f);
    if (JSON.stringify(initial.root) !== JSON.stringify(oldOrg['root']))
        throw Error('Bulk fixture algorithm differs from existing transactional writer root');
    const installments = await db.collection('loan_installments').find({ loanId: l.id }).sort({ number: 1 }).toArray(), quote = (await db.collection('lending_quotes').findOne({ _id: loan['quoteId'] }));
    let sampleCloneId = l.id;
    const tables = new Map();
    const add = (table, row) => { const list = tables.get(table) ?? []; list.push(row); tables.set(table, list); };
    const journals = [], stamp = Date.parse('2027-07-31T17:00:00.000Z');
    let sequence = 0;
    const at = () => new Date(stamp + (++sequence)).toISOString();
    const line = (id, debit, credit) => ({ accountId: id, debit: Decimal128.fromString(debit), credit: Decimal128.fromString(credit) });
    const equity = (await db.collection('financial_accounts').findOne({ organizationId: org, accountClass: 'EQUITY' }));
    const manual = (value, label) => ({ ...clone(fundJournal), _id: randomUUID(), effectiveDate: '2027-07-31', recordedAt: at(), createdAt: new Date(stamp).toISOString(), source: { type: 'MANUAL_JOURNAL', id: randomUUID() }, supportReference: label, description: 'Capital sintético benchmark', lines: [line(f.account, value, '0.00'), line(equity._id, '0.00', value)] });
    const capital = manual(String(2000000 * population) + '.00', 'S08-BENCH-CAPITAL');
    capital['effectiveDate'] = fund['effectiveDate'];
    capital['recordedAt'] = new Date(Date.parse(String(fund['recordedAt'])) + 1).toISOString();
    journals.push(capital);
    for (let i = 0; i < population; i++) {
        const id = i === 0 ? l.id : randomUUID(), eventId = i === 0 ? fund._id : randomUUID(), journalId = i === 0 ? fundJournal._id : randomUUID();
        if (i !== 0) {
            if (i === 1)
                sampleCloneId = id;
            const q = clone(quote), qid = randomUUID();
            q._id = qid;
            const { _id, fingerprint, ...rest } = q;
            void _id;
            void fingerprint;
            q['fingerprint'] = hash({ id: qid, ...rest });
            add('lending_quotes', q);
            const newLoan = { ...clone(loan), _id: id, quoteId: qid, quoteFingerprint: q['fingerprint'] };
            newLoan['confirmation'] = { ...newLoan['confirmation'], quoteId: qid, quoteFingerprint: q['fingerprint'] };
            add('lending_loans', newLoan);
            add('lending_loan_versions', { ...clone(version), _id: randomUUID(), loanId: id, quoteId: qid, quoteFingerprint: q['fingerprint'] });
            add('loan_positions', { ...clone(position), _id: id, loanId: id, fundingEventId: eventId, version: 10 });
            const revised = clone(schedule);
            revised._id = id + ':1';
            revised['loanId'] = id;
            revised['eventId'] = eventId;
            revised['futureInstallments'] = revised['futureInstallments'].map(r => ({ ...r, loanId: id }));
            add('loan_schedule_versions', revised);
            for (const r of installments)
                add('loan_installments', { ...clone(r), _id: id + ':1:' + r['number'], loanId: id });
            const fundingAt = new Date(Date.parse(String(fund['recordedAt'])) + i + 2).toISOString();
            const event = clone(fund);
            event._id = eventId;
            event['journalId'] = journalId;
            event['loanIds'] = [id];
            event['recordedAt'] = fundingAt;
            event['idempotencyKey'] = randomUUID();
            event['plan'].positions = event['plan'].positions.map(p => ({ ...p, loanId: id }));
            event['plan'].scheduleRevisions = event['plan'].scheduleRevisions.map(p => ({ ...p, loanId: id, eventId, futureInstallments: p['futureInstallments'].map(r => ({ ...r, loanId: id })) }));
            add('loan_events', event);
            journals.push({ ...clone(fundJournal), _id: journalId, recordedAt: fundingAt, source: { type: 'LOAN_OPERATION', id: eventId } });
        }
        for (const r of installments.slice(0, 9)) {
            const eid = randomUUID(), jid = randomUUID(), time = at(), interest = String(r['interest']), accrual = { loanId: id, scheduleVersion: 1, installmentNumber: r['number'], dueDate: r['dueDate'], interest };
            add('loan_accruals', { _id: id + ':1:' + r['number'], organizationId: org, ...accrual, eventId: eid, createdAt: time });
            const postings = [{ accountId: f.profile.interestReceivableAccountId, debit: interest, credit: '0.00' }, { accountId: f.profile.interestIncomeAccountId, debit: '0.00', credit: interest }];
            add('loan_events', { ...clone(fund), _id: eid, loanIds: [id], kind: 'ACCRUE', effectiveDate: '2027-07-31', recordedAt: time, journalId: jid, idempotencyKey: randomUUID(), receiptReference: null, plan: { postings, allocations: [], accruals: [accrual], scheduleRevisions: [], positions: [], creditChange: null } });
            journals.push({ ...clone(fundJournal), _id: jid, effectiveDate: '2027-07-31', recordedAt: time, createdAt: time, source: { type: 'LOAN_OPERATION', id: eid }, lines: postings.map(p => line(p.accountId, p.debit, p.credit)) });
        }
    }
    for (let i = 0; i < 15 * population - 2; i++)
        journals.push(manual('0.01', 'S08-BENCH-DECLARED-CAPITAL'));
    // Private model fixture creation, never authoring throughput: raw owned seed
    // then one publication of the identical canonical treap. The base root above
    // must equal the root made by the real transactional writer, byte for byte.
    for (const [name, rows] of tables) {
        for (let offset = 0; offset < rows.length; offset += 500) {
            await db.collection(name).insertMany(rows.slice(offset, offset + 500));
        }
        process.stdout.write('BENCHMARK_SEED ' + JSON.stringify({ table: name, rows: rows.length, at: new Date().toISOString() }) + '\n');
    }
    await db.collection('loan_positions').updateOne({ _id: l.id }, { $set: { version: 10 } });
    await db.collection('loan_operation_books').updateOne({ _id: org }, { $set: { version: 10000 } });
    for (let offset = 0; offset < journals.length; offset += 500)
        await db.collection('financial_journals').insertMany(journals.slice(offset, offset + 500));
    await db.collection('financial_books').updateOne({ _id: org }, { $inc: { value: journals.length }, $set: { recordedAt: stamp + sequence } });
    const image = await ownedEvidenceImage(f), newOrg = { ...oldOrg, root: image.root, counts: image.counts, revision: Number(oldOrg['revision']) + 1 }, global = fixtureTree('hmac-v1:@global', [['org|' + org, { id: org, collection: '@org', documentHash: exactHash(newOrg), meta: {} }]], fixturePriority(f));
    const nextHead = { ...oldHead, revision: oldHead.revision + 1, root: global.root, previousDigest: oldHead.digest, digest: '', mac: '' };
    nextHead.digest = headDigest(nextHead);
    nextHead.mac = createHmac('sha256', f.keys.journal).update('CAUDELYX:LENDING-V2-HEAD:' + nextHead.digest).digest('hex');
    await f.database.transaction(async (session) => {
        const nodes = [...image.nodes, ...global.nodes];
        for (let offset = 0; offset < nodes.length; offset += 1000)
            await db.collection('lending_merkle_nodes').bulkWrite(nodes.slice(offset, offset + 1000).map(n => ({ replaceOne: { filter: { _id: n._id }, replacement: n, upsert: true } })), { session });
        await db.collection('lending_merkle_orgs').replaceOne({ _id: org }, newOrg, { session });
        await db.collection('lending_domain_state').replaceOne({ _id: 'evidence' }, nextHead, { session });
        await recordFinancialEvidence(f.database, session);
        await f.identity.audit.append({ realm: 'TENANT', actorId: actor, subjectId: actor, action: 'REPORTING_FIXTURE_COMPLETE', outcome: 'SUCCESS' }, session);
    });
    f.clock.value = stamp + 120000;
    const login = await f.identity.login('TENANT', 'S08-BENCHMARK', f.a.email, password);
    f.a.issued = login.issued;
    const sample = await db.collection('lending_loans').findOne({ _id: sampleCloneId });
    await verifyLoan(f.database, sample);
    await stateOf(f.database, sample, undefined, false);
    const count = await db.collection('loan_events').countDocuments({ organizationId: org }), loanCount = await db.collection('loan_positions').countDocuments({ organizationId: org });
    const rawJournals = await db.collection('financial_journals').find({ organizationId: org }).project({ lines: 1 }).toArray(), lineCount = rawJournals.reduce((n, j) => n + j['lines'].length, 0);
    if (loanCount !== population || count !== 10 * population || lineCount !== 50 * population)
        throw Error('Benchmark target fixture counts differ');
    return { ...f, benchmarkCounts: { loans: loanCount, events: count, journalLines: lineCount }, expected: { principal: String(2000000 * population) + '.00', interestAccrued: String(360000 * population) + '.00', cash: population === 1000 ? '20000149.98' : '20000014.98' } };
}
//# sourceMappingURL=fixture.js.map