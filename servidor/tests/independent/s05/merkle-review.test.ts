/* eslint-disable security/detect-object-injection -- Own computed maps/indexes; no request input. */
// S05-P05-v2 independent C3 review (Claude) of the lending-v2 authenticated treaps (owner condition 2):
//  1) membership/absence with an OWN verifier (hash/priority/order/heap/count/height recomputed from the spec as read in
//     code review, using only the mongodb BSON library — no product evidence code);
//  2) canonical root: the same fixed entry set inserted in different orders by an OWN treap builder gives the stored root;
//  3) tampering of nodes/counts/root/head with and without the HMAC key, plus rollback inside/outside the flushed window;
//  4) user-chosen keys: adversarial borrower codes and ground Idempotency-Keys (event ids) vs depth/time and the 128 limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BSON, type Document } from 'mongodb';
import { reviewProfile } from './review-profile.js';
import { world, type Group, type World, type Tenant } from './review-fixtures.js';

const evidence = (name: string, d: Record<string, unknown>) => console.log(JSON.stringify({ evidence: name, ...d }));
const out: Record<string, unknown> = {};
// ---- own re-implementation of the hashing spec (from code review of evidence-v2.ts) ----
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, canonical(x)])) : v;
const H = (v: unknown) => createHash('sha256').update(JSON.stringify(canonical(BSON.EJSON.serialize(v as Document, { relaxed: false })))).digest('hex');
type Ref = { id: string; hash: string; count: number; height: number };
type NodeDoc = { _id: string; namespace: string; key: string; priority: string; data: { id: string; collection: string; documentHash: string; meta: Record<string, unknown> }; left: Ref | null; right: Ref | null; hash: string; count: number; height: number };
const DOMAIN = ['lending_borrowers', 'lending_borrower_versions', 'lending_field_schemas', 'lending_quotes', 'lending_loans', 'lending_loan_versions', 'lending_actions', 'lending_idempotency', 'lending_domain_state', 'loan_operation_books', 'loan_positions', 'loan_schedule_versions', 'loan_installments', 'loan_accruals', 'loan_events', 'loan_applications', 'borrower_credits', 'loan_operation_idempotency'];
/** Verify a stored treap from its root with the own spec; returns the (key -> data) entry set and stats. */
async function verifyTree(w: World, namespace: string, root: Ref | null) {
  const nodes = w.db.collection<NodeDoc>('lending_merkle_nodes'), entries = new Map<string, NodeDoc['data']>(); let maxDepth = 0;
  const walk = async (r: Ref | null, lo: string | null, hi: string | null, parentPriority: string | null, depth: number): Promise<void> => {
    if (!r) return; maxDepth = Math.max(maxDepth, depth);
    const n = await nodes.findOne({ _id: r.id }); assert.ok(n, 'missing node ' + r.id);
    assert.equal(n!.namespace, namespace); assert.equal(n!.priority, H(n!.key), 'priority = H(key)');
    assert.equal(H({ namespace: n!.namespace, key: n!.key, priority: n!.priority, data: n!.data, left: n!.left, right: n!.right, height: n!.height }), n!.hash, 'node hash');
    assert.deepEqual({ id: n!._id, hash: n!.hash, count: n!.count, height: n!.height }, r, 'ref');
    assert.equal(n!.count, 1 + (n!.left?.count ?? 0) + (n!.right?.count ?? 0)); assert.equal(n!.height, 1 + Math.max(n!.left?.height ?? 0, n!.right?.height ?? 0));
    if (lo !== null) assert.ok(n!.key > lo, 'BST order'); if (hi !== null) assert.ok(n!.key < hi, 'BST order');
    if (parentPriority !== null) assert.ok(n!.priority > parentPriority, 'heap order (min-priority root)');
    entries.set(n!.key, n!.data);
    await walk(n!.left, lo, n!.key, n!.priority, depth + 1); await walk(n!.right, n!.key, hi, n!.priority, depth + 1);
  };
  await walk(root, null, null, null, 1); return { entries, maxDepth };
}
/** Own canonical treap from an entry set: root = min priority, recursive split by key. Order-free by construction. */
function canonicalRoot(namespace: string, entries: [string, NodeDoc['data']][]): Ref | null {
  const sorted = [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const build = (lo: number, hi: number): Ref | null => {
    if (lo >= hi) return null; let best = lo; for (let i = lo + 1; i < hi; i++) if (H(sorted[i]![0]) < H(sorted[best]![0])) best = i;
    const [key, data] = sorted[best]!, left = build(lo, best), right = build(best + 1, hi), height = 1 + Math.max(left?.height ?? 0, right?.height ?? 0), priority = H(key);
    return { id: namespace + ':' + H(key), hash: H({ namespace, key, priority, data, left, right, height }), count: 1 + (left?.count ?? 0) + (right?.count ?? 0), height };
  };
  return build(0, sorted.length);
}
/** Own incremental treap insertion (rotations) — used to show insertion ORDER does not change the root. */
function insertionRoot(namespace: string, order: [string, NodeDoc['data']][]) {
  type N = { key: string; data: NodeDoc['data']; p: string; l: N | null; r: N | null };
  const ins = (t: N | null, n: N): N => { if (!t) return n; if (n.key < t.key) { t.l = ins(t.l, n); if (t.l.p < t.p) { const x = t.l; t.l = x.r; x.r = t; return x; } } else { t.r = ins(t.r, n); if (t.r.p < t.p) { const x = t.r; t.r = x.l; x.l = t; return x; } } return t; };
  let root: N | null = null; for (const [key, data] of order) root = ins(root, { key, data, p: H(key), l: null, r: null });
  const ref = (n: N | null): Ref | null => { if (!n) return null; const left = ref(n.l), right = ref(n.r), height = 1 + Math.max(left?.height ?? 0, right?.height ?? 0); return { id: namespace + ':' + H(n.key), hash: H({ namespace, key: n.key, priority: n.p, data: n.data, left, right, height }), count: 1 + (left?.count ?? 0) + (right?.count ?? 0), height }; };
  return ref(root);
}
const shuffle = <T>(a: T[], seed: number) => { const x = [...a]; let s = seed >>> 0; const r = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [x[i], x[j]] = [x[j]!, x[i]!]; } return x; };
/** In-process S5 receipt (setup-speed path for the depth experiment): preview + R + mutate, with a chosen Idempotency-Key. */
async function receipt(w: World, T: Tenant, borrowerId: string, loanId: string, key: string, ref: string) {
  const ops = w.f.runtime.operations, ctx = T.a.issued.context;
  const book = await ops.read(ctx, 'getLoanOperationsBook', T.org), pos = await ops.read(ctx, 'getLoanPosition', T.org, loanId), acc = await w.f.runtime.finance.read(ctx, 'readAccount', T.org, T.acc['BANK']!);
  const request = { kind: 'RECEIPT', borrowerId, destinationAccountId: T.acc['BANK']!, destinationAccountETag: acc.etag!, receivedAmount: '0.01', targets: [{ loanId, positionETag: pos.etag!, amount: '0.01', mode: 'REGULAR' }], excessDisposition: 'CREDIT', receiptReference: ref, effectiveDate: w.today(), supportReference: 'SYN-C3' };
  const pv = await ops.preview(ctx, T.org, { executionKey: key, expectedBookETag: book.etag!, request }), payload = { previewToken: (pv.data as { previewToken: string }).previewToken, request };
  await w.f.proof(T.a, 'LOAN_RECEIPT_POST', { organizationId: T.org, idempotencyKey: key, payload, expectedETag: book.etag! }, borrowerId);
  const t0 = performance.now(); try { const r = await ops.mutate(T.a.issued.context, 'postLoanReceipt', T.org, payload, key, book.etag!); return { status: r.status, ms: Math.round(performance.now() - t0) }; }
  catch (e) { return { status: (e as { status?: number }).status ?? 500, code: (e as { code?: string }).code, ms: Math.round(performance.now() - t0) }; }
}
const eventKey = (org: string, actor: string, kind: string, key: string) => { const h = createHash('sha256').update(JSON.stringify([org, actor, kind, key])).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const frac = (hex: string) => parseInt(hex.slice(0, 8), 16) / 0x100000000;

test('P05-S5-C3 authenticated treaps: membership/absence, canonical root, tampering, rollback, user-chosen keys vs limit 128', { timeout: 7200000 }, async t => {
  const group: Group = await reviewProfile();
  try {
    const w = await world(group, '2026-10-24T08:00:00-05:00'), A = await w.tenant('C3', '1000000.00');
    const b = await w.borrower(A, 'C3_B'); const loans: string[] = []; for (let k = 0; k < 3; k++) loans.push(await w.confirmed(A, 'L' + k, b, { principal: '100.00' }));
    await w.connect(A);
    for (const id of loans) assert.equal((await w.run(A, await w.disburseRequest(A, id))).status, 201);
    assert.equal((await w.run(A, await w.receiptRequest(A, b, '5.00', [{ loanId: loans[0]!, amount: '5.00' }], 'CREDIT'))).status, 201);
    const orgDoc = async () => (await w.db.collection<{ _id: string; root: Ref | null; counts: Record<string, number>; revision: number }>('lending_merkle_orgs').findOne({ _id: A.org }))!;
    const head = async () => (await w.db.collection<Document>('lending_domain_state').findOne({ _id: 'evidence' as never }))!;
    await t.test('C3-1 membership/absence with the own verifier, global anchor and head MAC recomputed with the journal key', async () => {
      const org = await orgDoc(), v = await verifyTree(w, A.org, org.root), h = await head();
      // Every domain document of the org has its primary entry with the own document hash; counts match; absence of foreign ids.
      let docs = 0; for (const c of DOMAIN) { const f = c === 'lending_domain_state' ? { _id: A.org } : { organizationId: A.org }; const rows = await w.db.collection<Document>(c).find(f as never).toArray();
        assert.equal(rows.length, org.counts[c] ?? 0, c + ' count'); for (const r of rows) { const e = v.entries.get(c + '|P|' + String(r['_id'])); assert.ok(e, 'member ' + c); assert.equal(e!.documentHash, H(r), 'document hash ' + c); docs++; } }
      const absent = [randomUUID(), randomUUID(), '00000000-0000-4000-8000-000000000000'].map(id => v.entries.has('loan_events|P|' + id) || v.entries.has('lending_loans|P|' + id));
      const global = await verifyTree(w, '@global', h['root'] as Ref), anchor = global.entries.get('org|' + A.org);
      const digest = H({ format: h['format'], revision: h['revision'], root: h['root'], previousDigest: h['previousDigest'], checkpointHash: h['checkpointHash'] }), mac = createHmac('sha256', w.f.keys.journal).update('CAUDELYX:LENDING-V2-HEAD:' + digest).digest('hex');
      out['C3-1'] = { entries: v.entries.size, domainDocuments: docs, orgTreeHeight: org.root?.height, ownMaxDepth: v.maxDepth, absentFound: absent, globalAnchorMatches: anchor?.documentHash === H(org), headDigestMatches: digest === h['digest'], headMacMatchesJournalKey: mac === h['mac'] };
      assert.ok(absent.every(x => !x)); assert.equal(anchor?.documentHash, H(org)); assert.equal(digest, h['digest']); assert.equal(mac, h['mac']); assert.equal(v.maxDepth, org.root?.height);
    });
    await t.test('C3-2 same entry set in different insertion orders -> same root (own canonical builder and own rotating inserts)', async () => {
      const org = await orgDoc(), v = await verifyTree(w, A.org, org.root), entries = [...v.entries];
      const canon = canonicalRoot(A.org, entries), orders = [entries, [...entries].reverse(), shuffle(entries, 1), shuffle(entries, 99)].map(o => insertionRoot(A.org, o)?.hash);
      out['C3-2'] = { entries: entries.length, storedRoot: org.root?.hash.slice(0, 16), canonical: canon?.hash.slice(0, 16), insertionOrders: orders.map(x => x?.slice(0, 16)), allEqual: orders.every(x => x === org.root?.hash) && canon?.hash === org.root?.hash, note: 'head chain digest is sequence-dependent by design; the tree root is not' };
      assert.equal(canon?.hash, org.root?.hash); for (const x of orders) assert.equal(x, org.root?.hash);
    });
    await t.test('C3-3 tampering of node/counts/root/head without the key fails closed (online probe and full verifier); with the key a full reseal is accepted (residual)', async () => {
      const cases: Record<string, unknown> = {}, nodes = w.db.collection<NodeDoc>('lending_merkle_nodes'); out['C3-3'] = cases;
      const { verifyV2 } = await import('../../../src/modules/lending/evidence-v2.js');
      const expected = async () => { const h = await head(); return { digest: String(h['digest']), revision: Number(h['revision']) }; };
      const probe = async () => { const bk = await w.get(A, '/loan-operations/book'); if (bk.status !== 200) return `book ${bk.status}${bk.body.error?.code ? ' ' + bk.body.error.code : ''}`;
        const r = await w.run(A, await w.receiptRequest(A, b, '1.00', [{ loanId: loans[1]!, amount: '1.00' }], 'CREDIT')); return `${r.status}${r.body.error?.code ? ' ' + r.body.error.code : ''}`; };
      const leafId = async () => (await nodes.findOne({ namespace: A.org, key: { $regex: '^loan_events\\|P\\|' } }))!._id;
      const tampers: [string, () => Promise<{ coll: string; id: string }>, () => Promise<void>][] = [
        ['leaf documentHash changed', async () => ({ coll: 'lending_merkle_nodes', id: await leafId() }), async () => { await nodes.updateOne({ _id: await leafId() }, { $set: { 'data.documentHash': '0'.repeat(64) } }); }],
        ['leaf count changed (node possibly off the probe path)', async () => ({ coll: 'lending_merkle_nodes', id: await leafId() }), async () => { const id = await leafId(), n = (await nodes.findOne({ _id: id }))!; await nodes.updateOne({ _id: id }, { $set: { count: n.count + 1 } }); }],
        ['org root node count changed (always on path)', async () => ({ coll: 'lending_merkle_nodes', id: (await orgDoc()).root!.id }), async () => { const id = (await orgDoc()).root!.id, n = (await nodes.findOne({ _id: id }))!; await nodes.updateOne({ _id: id }, { $set: { count: n.count + 1 } }); }],
        ['org counts changed', async () => ({ coll: 'lending_merkle_orgs', id: A.org }), async () => { await w.db.collection('lending_merkle_orgs').updateOne({ _id: A.org as never }, { $inc: { 'counts.loan_events': 1 } }); }],
        ['org root hash changed', async () => ({ coll: 'lending_merkle_orgs', id: A.org }), async () => { await w.db.collection('lending_merkle_orgs').updateOne({ _id: A.org as never }, { $set: { 'root.hash': '0'.repeat(64) } }); }],
        ['head digest recomputed without key (mac stale)', async () => ({ coll: 'lending_domain_state', id: 'evidence' }), async () => { const h = await head(); await w.db.collection('lending_domain_state').updateOne({ _id: 'evidence' as never }, { $set: { revision: Number(h['revision']) + 5, digest: H({ format: h['format'], revision: Number(h['revision']) + 5, root: h['root'], previousDigest: h['previousDigest'], checkpointHash: h['checkpointHash'] }) } }); }],
      ];
      const same = (x: unknown, y: unknown) => JSON.stringify(BSON.EJSON.serialize(x as Document)) === JSON.stringify(BSON.EJSON.serialize(y as Document));
      for (const [label, where, mutate] of tampers) {
        const exp = await expected(), baseline = await verifyV2(w.f.database, exp), target = await where();
        // Snapshot ONLY the tampered document; put it back only if the probe left it as tampered (exact inverse, no rollback of other state).
        const original = await w.db.collection<Document>(target.coll).findOne({ _id: target.id as never });
        await mutate(); const tampered = await w.db.collection<Document>(target.coll).findOne({ _id: target.id as never });
        const fullVerifierAfterTamper = await verifyV2(w.f.database, exp), onlineProbe = await probe();
        const committed = onlineProbe === '201', fullVerifierAfterProbe = await verifyV2(w.f.database, committed ? await expected() : exp);
        const untouched = same(await w.db.collection<Document>(target.coll).findOne({ _id: target.id as never }), tampered);
        if (untouched) await w.db.collection<Document>(target.coll).replaceOne({ _id: target.id as never }, original!);
        const fullVerifierAfterRevert = await verifyV2(w.f.database, await expected()), afterExactRevert = await probe();
        cases[label] = { baselineFullVerifier: baseline, fullVerifierAfterTamper, onlineProbe, fullVerifierAfterProbe, revertExact: untouched, fullVerifierAfterRevert, afterExactRevert };
      }
      // Full consistent reseal of a modified domain document, path, org, global anchor and head WITH the journal key (adversary holding base + key).
      const target = (await w.db.collection<Document>('borrower_credits').findOne({ organizationId: A.org }))!;
      const before = { credit: target, nodes: await nodes.find({ namespace: { $in: [A.org, '@global'] } }).toArray(), org: await orgDoc(), head: await head() };
      const forged = { ...target, balance: '999999.00' }; await w.db.collection('borrower_credits').replaceOne({ _id: target['_id'] }, forged);
      // Recompute: leaf data, then all ancestors bottom-up, org doc, global leaf+path, head digest and MAC — with the own spec only.
      const reseal = async (namespace: string, rootRef: Ref, changeKey: string, newData: NodeDoc['data']): Promise<Ref> => {
        const fix = async (r: Ref): Promise<Ref> => { const n = (await nodes.findOne({ _id: r.id }))!; let changed = false;
          if (n.key === changeKey) { n.data = newData; changed = true; } else if (changeKey < n.key && n.left) { const nl = await fix(n.left); changed = nl.hash !== n.left.hash; n.left = nl; } else if (changeKey > n.key && n.right) { const nr = await fix(n.right); changed = nr.hash !== n.right.hash; n.right = nr; }
          if (!changed) return r; n.hash = H({ namespace, key: n.key, priority: n.priority, data: n.data, left: n.left, right: n.right, height: n.height }); await nodes.replaceOne({ _id: n._id }, n); return { id: n._id, hash: n.hash, count: n.count, height: n.height }; };
        return await fix(rootRef); };
      const org = await orgDoc(), affected = await nodes.find({ namespace: A.org, 'data.collection': 'borrower_credits', 'data.id': String(target['_id']) }).toArray();
      let newRoot = org.root!;
      for (const leafNode of affected) newRoot = await reseal(A.org, newRoot, leafNode.key, { ...leafNode.data, documentHash: H(forged), meta: { ...leafNode.data.meta, balance: '999999.00' } });
      // Secondary index entries carrying the balance do not exist (balance not indexed); org doc + global + head.
      const newOrg = { ...org, root: newRoot }; await w.db.collection('lending_merkle_orgs').replaceOne({ _id: A.org as never }, newOrg);
      const h = await head(), globalRoot = await reseal('@global', h['root'] as Ref, 'org|' + A.org, { id: A.org, collection: '@org', documentHash: H(newOrg), meta: {} });
      const digest = H({ format: h['format'], revision: h['revision'], root: globalRoot, previousDigest: h['previousDigest'], checkpointHash: h['checkpointHash'] });
      await w.db.collection('lending_domain_state').updateOne({ _id: 'evidence' as never }, { $set: { root: globalRoot, digest, mac: createHmac('sha256', w.f.keys.journal).update('CAUDELYX:LENDING-V2-HEAD:' + digest).digest('hex') } });
      const forgedRead = await w.get(A, '/loan-operations/credits/' + b);
      cases['full reseal WITH journal key (base+key adversary)'] = { fullVerifier: await verifyV2(w.f.database, await expected()), entriesResealed: affected.length, readCredit: `${forgedRead.status} ${String((forgedRead.body.data as { balance?: string } | undefined)?.balance ?? forgedRead.body.error?.code)}` };
      await w.db.collection('borrower_credits').replaceOne({ _id: target['_id'] }, before.credit); await nodes.deleteMany({ namespace: { $in: [A.org, '@global'] } }); await nodes.insertMany(before.nodes);
      await w.db.collection('lending_merkle_orgs').replaceOne({ _id: A.org as never }, before.org); await w.db.collection('lending_domain_state').replaceOne({ _id: 'evidence' as never }, before.head);
      cases['after restoring the original state'] = { probe: await probe() };
      out['C3-3'] = cases;
      for (const [k] of tampers) { const v = cases[k] as Record<string, unknown>; assert.equal(v['baselineFullVerifier'], true, k); assert.equal(v['fullVerifierAfterTamper'], false, k); assert.equal(v['revertExact'], true, k); assert.equal(v['fullVerifierAfterRevert'], true, k); assert.equal(v['afterExactRevert'], '201', k);
        if (!k.includes('off the probe path')) assert.match(String(v['onlineProbe']), /503/, k); else if (v['onlineProbe'] === '201') assert.equal(v['fullVerifierAfterProbe'], false, k + ' (dormant tamper still caught by the full verifier)'); }
    });
    await t.test('C3-4 user-chosen keys: adversarial borrower codes and ground Idempotency-Keys (event ids) vs depth/time and the 128 limit', async () => {
      const r: Record<string, unknown> = {}; out['C3-4'] = r;
      const w = await world(group, '2026-10-24T08:00:00-05:00');
      // (a) 120 borrowers with strictly ascending, attacker-chosen codes.
      const T2 = await w.tenant('C3K', '1000000.00'), h0 = (await w.db.collection<{ root: Ref | null }>('lending_merkle_orgs').findOne({ _id: T2.org as never }))?.root?.height ?? 0;
      for (let k = 0; k < 120; k++) await w.borrower(T2, 'Z' + String(k).padStart(6, '0'));
      const t2org = (await w.db.collection<{ root: Ref | null }>('lending_merkle_orgs').findOne({ _id: T2.org as never }))!;
      r['ascending borrower codes x120'] = { heightBefore: h0, heightAfter: t2org.root?.height, entries: t2org.root?.count, log2Entries: Math.round(Math.log2(t2org.root?.count ?? 1) * 10) / 10 };
      // (b) Ground Idempotency-Keys so event ids AND their primary-entry priorities increase together (offline, no server help).
      const T3 = await w.tenant('C3G', '1000000.00'), b3 = await w.borrower(T3, 'C3G_B'), L3 = await w.confirmed(T3, 'L', b3, { principal: '100.00' });
      await w.connect(T3); assert.equal((await w.run(T3, await w.disburseRequest(T3, L3))).status, 201);
      const actor = String(T3.a.issued.context.subjectId), bins = 150, ground: string[] = []; let tries = 0; const g0 = performance.now();
      // Sanity: own priority formula equals a stored node's priority.
      const sample = (await w.db.collection<NodeDoc>('lending_merkle_nodes').findOne({ namespace: T3.org, key: { $regex: '^loan_events\\|P\\|' } }))!; assert.equal(H(sample.key), sample.priority);
      for (let i = 0; i < bins; i++) { for (;;) { tries++; const key = randomUUID(), id = eventKey(T3.org, actor, 'RECEIPT', key), p = H('loan_events|P|' + id); const fi = frac(id.replace(/-/g, '')), fp = frac(p);
        if (fi >= i / bins && fi < (i + 1) / bins && fp >= i / bins && fp < (i + 1) / bins) { ground.push(key); break; } } }
      r['grinding'] = { keys: ground.length, tries, ms: Math.round(performance.now() - g0), method: 'offline SHA256 of the public eventKey formula and H(primary key); no secret involved' };
      const heights: { n: number; height: number; ms: number }[] = []; let firstFailure: unknown = null, okCount = 0;
      for (let i = 0; i < ground.length; i++) {
        const res = await receipt(w, T3, b3, L3, ground[i]!, 'SYN-G-' + i);
        if (res.status !== 201) { firstFailure = { at: i, ...res }; break; } okCount++;
        if (i % 10 === 9 || i < 3) heights.push({ n: i + 1, height: (await w.db.collection<{ root: Ref }>('lending_merkle_orgs').findOne({ _id: T3.org as never }))!.root.height, ms: res.ms });
      }
      const after = (await w.db.collection<{ root: Ref }>('lending_merkle_orgs').findOne({ _id: T3.org as never }))!.root;
      // (c) After the chain: ordinary random-key receipts in the same org.
      const random: Record<string, number> = {}; for (let k = 0; k < 100; k++) { const res = await receipt(w, T3, b3, L3, randomUUID(), 'SYN-R-' + k); const s = `${res.status}${'code' in res && res.code ? ' ' + res.code : ''}`; random[s] = (random[s] ?? 0) + 1; }
      r['ground keys'] = { committed: okCount, firstFailure, heightTrace: heights, finalHeight: after.height, finalCount: after.count, log2Count: Math.round(Math.log2(after.count) * 10) / 10 };
      r['100 random-key receipts after the chain'] = random; r['height after random receipts'] = (await w.db.collection<{ root: Ref }>('lending_merkle_orgs').findOne({ _id: T3.org as never }))!.root.height;
      { const t0 = performance.now(), bk = await w.get(T3, '/loan-operations/book'); r['book read at final height'] = { status: bk.status, ms: Math.round(performance.now() - t0) }; }
      { const T4 = await w.tenant('C3O', '1000000.00'), b4 = await w.borrower(T4, 'C3O_B'), L4 = await w.confirmed(T4, 'L', b4, { principal: '100.00' }); await w.connect(T4); r['other tenant after the chain'] = { disburse: (await w.run(T4, await w.disburseRequest(T4, L4))).status, receipt: (await receipt(w, T4, b4, L4, randomUUID(), 'SYN-O')).status }; }
      out['C3-4'] = r;
      writeFileSync(resolve('../../Construccion/Sprints/S05/Evidencias/S05-P05-v2-MERKLE.json'), JSON.stringify({ task: 'S05-P05-v2', condition2: out }, null, 1) + '\n');
    });
    await t.test('C3-5 administrator rollback to an older, consistently sealed state: inside vs outside the external-journal window', async () => {
      const r: Record<string, unknown> = {}; out['C3-5'] = r;
      const DOCS = [...DOMAIN.filter(c => c !== 'lending_domain_state'), 'financial_journals', 'financial_books', 'financial_evidence_head'];
      for (const flushed of [false, true]) {
        const w = await world(group, '2026-10-24T08:00:00-05:00'), T = await w.tenant(flushed ? 'C3RF' : 'C3RU', '1000000.00'), bb = await w.borrower(T, flushed ? 'C3RF_B' : 'C3RU_B'), L = await w.confirmed(T, 'L', bb, { principal: '100.00' });
        await w.connect(T); assert.equal((await w.run(T, await w.disburseRequest(T, L))).status, 201);
        const nodes = w.db.collection('lending_merkle_nodes');
        const capture = async () => ({ docs: Object.fromEntries(await Promise.all(DOCS.map(async c => [c, await w.db.collection(c).find({}).toArray()] as const))), nodes: await nodes.find({}).toArray(), orgs: await w.db.collection('lending_merkle_orgs').find({}).toArray(), state: await w.db.collection('lending_domain_state').find({}).toArray() });
        const putBack = async (st0: Awaited<ReturnType<typeof capture>>) => { for (const [c, rows] of Object.entries(st0.docs)) { await w.db.collection(c).deleteMany({}); if (rows.length) await w.db.collection(c).insertMany(rows); } await nodes.deleteMany({}); await nodes.insertMany(st0.nodes); await w.db.collection('lending_merkle_orgs').deleteMany({}); await w.db.collection('lending_merkle_orgs').insertMany(st0.orgs); await w.db.collection('lending_domain_state').deleteMany({}); await w.db.collection('lending_domain_state').insertMany(st0.state); };
        const rec = async (amount: string) => { const bk = await w.get(T, '/loan-operations/book'); if (bk.status !== 200) return `book ${bk.status}${bk.body.error?.code ? ' ' + bk.body.error.code : ''}`; const x = await w.run(T, await w.receiptRequest(T, bb, amount, [{ loanId: L, amount }], 'CREDIT')); return `${x.status}${x.body.error?.code ? ' ' + x.body.error.code : ''}`; };
        if (flushed) await w.f.restore.flush();
        const older = await capture(); const second = await rec('7.00'); if (flushed) await w.f.restore.flush();
        const creditBefore = String((await w.db.collection('borrower_credits').findOne({ organizationId: T.org }))?.['balance']);
        await putBack(older);
        const creditAfterRollback = String((await w.db.collection('borrower_credits').findOne({ organizationId: T.org }))?.['balance'] ?? 'absent');
        const next = await rec('1.00');
        let restartOpen: boolean | string = 'n/a';
        try { const { RestoreController } = await import('../../../src/shared/restore.js'); const c2 = new RestoreController(w.f.database, w.f.restore.gatePath, w.f.keys.journal); await c2.initialize(); restartOpen = c2.isOpen(); } catch (e) { restartOpen = 'error ' + String((e as { code?: string }).code ?? e); }
        let flushAfter = 'not attempted', afterFlush = 'n/a'; if (!flushed) { try { await w.f.restore.flush(); flushAfter = 'ok'; } catch (e) { flushAfter = String((e as { code?: string }).code ?? e); } afterFlush = await rec('1.00'); }
        r[flushed ? 'rollback after external flush' : 'rollback inside unflushed window'] = { secondEvent: second, creditBeforeRollback: creditBefore, creditAfterRollback, nextCommandOnRolledBackState: next, restartOpen, flushAfter, commandAfterFlush: afterFlush };
      }
      writeFileSync(resolve('../../Construccion/Sprints/S05/Evidencias/S05-P05-v2-MERKLE.json'), JSON.stringify({ task: 'S05-P05-v2', condition2: out }, null, 1) + '\n');
    });
    evidence('P05-S5-C3', out);
  } finally { await group.dispose('end'); }
});
