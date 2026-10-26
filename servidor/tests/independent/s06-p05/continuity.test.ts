/* eslint-disable security/detect-object-injection -- Own fixed path/collection maps of this review, never request input. */
// S06-P05 continuity review (Claude), one own group: AT08 dedicated GET inventory (independent), C3-4 / H-S5-P05-01 at the
// 128 limit with legacy priorities vs the approved HMAC mitigation, and AT14 legacy v1→HMAC migration (interruption,
// restart, key loss). Reads go over the real HTTPS app; measurements report successful samples only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash, createHmac, randomBytes } from 'node:crypto';
import { BSON, type Document } from 'mongodb';
import { s06Profile } from './review-profile.js';
import { world, S5, S6, LEDGER, EVIDENCE, AUDIT, type Group, type World } from './review-fixtures.js';
import { ApiClient } from '../../helpers/client.js';
import { Database } from '../../../src/shared/database.js';
import { RestoreController } from '../../../src/shared/restore.js';
import { Sessions } from '../../../src/modules/sessions/service.js';
import { IdentityService } from '../../../src/modules/identity/service.js';
import { SyntheticMessaging } from '../../../src/modules/messaging/service.js';
import { PasswordHasher } from '../../../src/modules/identity/password.js';
import { attachRuntime } from '../../../src/shared/runtime.js';

const evidence = (name: string, d: Record<string, unknown>) => console.log(JSON.stringify({ evidence: name, ...d }));
const only = (name: string) => !process.env['P05_ONLY'] || process.env['P05_ONLY']!.split(',').some(x => name.startsWith(x));
// Own re-implementation of the public hashing used by legacy priorities (exactHash) — reviewed spec, no product import.
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, canonical(x)])) : v;
const H = (v: unknown) => createHash('sha256').update(JSON.stringify(canonical(BSON.EJSON.serialize(v as Document, { relaxed: false })))).digest('hex');
const eventKey = (org: string, actor: string, kind: string, key: string) => { const h = createHash('sha256').update(JSON.stringify([org, actor, kind, key])).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const frac = (hex: string) => parseInt(hex.slice(0, 8), 16) / 0x100000000;
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };
async function perCollection(w: World) { const out: Record<string, string> = {}; for (const c of (await w.db.listCollections({}, { nameOnly: true }).toArray()).map(x => x.name).sort()) { const h = createHash('sha256'); h.update(BSON.EJSON.stringify(await w.db.collection(c).find({}).sort({ _id: 1 }).toArray(), { relaxed: false })); out[c] = h.digest('hex'); } return out; }

test('P06-C continuity on one own group', { timeout: 3600000 }, async t => {
  const group: Group = await s06Profile();
  try {
    await t.test('C1 AT08 dedicated GET inventory: S5 and S6 readers by T/O/C/P make no domain/ledger/evidence/audit/outbox writes', { skip: !only('C1') }, async st => {
      const w = await world(group), f = w.f, T = f.a, o: Record<string, unknown> = {}; st.after(() => evidence('P06-C1', { observed: o }));
      const bank = (await f.accountS06('BANK_G', 'ASSET', 'BANK')).id, cashO = (await f.accountS06('CASH_OG', 'ASSET', 'CASH')).id, cashC = (await f.accountS06('CASH_CG', 'ASSET', 'CASH')).id, held = await f.heldProfile();
      const O = await f.member('O'), P = await f.member('P'), C = await f.member('C'); await f.bind(O, cashO, held); await f.bind(C, cashC, held);
      const L1 = await f.loan({ principal: '2000000.00' }); await f.disburse(L1); const L2 = await f.loan({ principal: '2000000.00' }); await f.disburse(L2); const L3 = await f.loan({ principal: '2000000.00' }); await f.disburse(L3);
      const sc = await w.scope(C.issued.context.subjectId!, L1.id, true);
      const pO = await w.register(await f.intent(L1, cashO, '300000.00', O, 'CASH'), 'SUPERVISED', O), pC = await w.register(await f.intent(L1, cashC, '1000.00', C, 'CASH'), 'SUPERVISED', C);
      const r2 = await w.register(await f.intent(L2, bank, '100000.00'), 'DIRECT'), p2 = await w.readPay(r2.id!); const d2 = await w.declare(bank, '100000.00', String((p2['intent'] as { observedDate: string }).observedDate), String((p2['intent'] as { receiptReference: string }).receiptReference), 'G-1'); await w.link(r2.id!, String(d2.data!['entityId']));
      const r3 = await w.register(await f.intent(L3, bank, '300000.00'), 'DIRECT'), p3 = await w.readPay(r3.id!); await w.reverseAll(p3.eventId!, r3.id!);
      const https = await f.https(), clients = new Map<string, ApiClient>();
      for (const [n, a] of [['T', T], ['O', O], ['P', P], ['C', C]] as const) { const c = new ApiClient(https.port, https.cert); c.cookies.set('__Host-caudelyx-session', a.issued.token); await c.refreshCsrf(); clients.set(n, c); }
      const evId = p2.eventId!, base = `/api/v1/organizations/${w.org}`;
      const plan: [string, string][] = [];
      for (const p of ['/loan-operations/book', '/loan-operations/policy', '/loan-operations/positions?limit=100', `/loan-operations/positions/${L1.id}`, `/loan-operations/positions/${L1.id}/installments?limit=100`, `/loan-operations/positions/${L1.id}/schedule-versions?limit=100`, '/loan-operations/events?limit=100', `/loan-operations/events/${evId}`, `/loan-operations/credits/${L2.borrowerId}`,
        '/payments/policy', '/payments/state', '/payments?limit=100', `/payments/${r2.id}`, `/payments/commands/${String(r2.data!['commandKey'])}`, '/payments/registration-contexts', '/cash-custody', `/cash-custody/${pO.id}`, '/custody-bindings', `/custody-bindings/${O.issued.context.subjectId}`, '/payment-registration-scopes', `/payment-registration-scopes/${sc.scopeId}`, '/held-funds-profile', '/bank-declarations', `/bank-declarations/${String(d2.data!['entityId'])}`, `/loan-event-reversal-requests/${p3.eventId}`, `/payments/legacy-events/${evId}`]) plan.push(['T', p]);
      for (const n of ['O', 'C']) for (const p of ['/payments?limit=100', `/payments/${n === 'O' ? pO.id : pC.id}`, '/cash-custody', '/payments/registration-contexts', `/loan-operations/positions/${L1.id}`, `/payments/${r2.id}`]) plan.push([n, p]);
      for (const p of ['/payments?limit=100', `/payments/${pO.id}`, `/payments/${r2.id}`, '/bank-declarations', `/loan-operations/positions/${L1.id}`]) plan.push(['P', p]);
      // Direct in-process reads of the same own payments (to separate HTTP routing from service authorization).
      const inproc = async (a: typeof T, id: string) => w.st(await w.settle(() => w.pay.read(a.issued.context, 'getPayment', w.org, id)));
      o['in-process getPayment'] = { 'O own pending': await inproc(O, pO.id!), 'C own pending': await inproc(C, pC.id!), 'P supervised pending': await inproc(P, pO.id!), 'T': await inproc(T, pO.id!), registrarIsO: (await w.db.collection('payments').findOne({ _id: pO.id! as never }))?.['registrarId'] === O.issued.context.subjectId, status: (await w.readPay(pO.id!)).status };
      const before = await perCollection(w), results: Record<string, string> = {};
      const names = new Map<string, string>([[L1.id, 'L1'], [L2.borrowerId, 'B2'], [evId, 'evR2'], [r2.id!, 'r2'], [String(r2.data!['commandKey']), 'cmdR2'], [pO.id!, 'pO'], [pC.id!, 'pC'], [O.issued.context.subjectId!, 'O'], [sc.scopeId, 'scopeC'], [String(d2.data!['entityId']), 'decl2'], [p3.eventId!, 'evR3']]);
      const tag = (p: string) => p.replace(/[0-9a-f-]{36}/g, x => names.get(x) ?? '{id}');
      for (const [n, p] of plan) { const r = await clients.get(n)!.call('GET', base + p); results[`${n} GET ${tag(p)}`] = `${r.status}${r.body.error?.code ? ' ' + r.body.error.code : ''}`; }
      const probe = async (n: string, id: string) => { const r = await clients.get(n)!.call('GET', base + '/payments/' + id); return `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`; };
      o['HTTP getPayment matrix'] = { 'T pending pO': await probe('T', pO.id!), 'T confirmed r2': await probe('T', r2.id!), 'O pending pO': await probe('O', pO.id!), 'P pending pO': await probe('P', pO.id!), 'C pending pC': await probe('C', pC.id!), 'T pending pC': await probe('T', pC.id!) };
      const after = await perCollection(w), changed = Object.keys(after).filter(c => before[c] !== after[c]), protectedSet = new Set([...S5, ...S6, ...LEDGER, ...EVIDENCE, ...AUDIT, 'lending_loans', 'lending_borrowers', 'lending_quotes', 'financial_accounts']);
      o['GET results'] = results; o['requests'] = plan.length; o['collections changed by GETs'] = changed; o['protected collections changed'] = changed.filter(c => protectedSet.has(c));
      assert.deepEqual(o['protected collections changed'], []);
      for (const [k, v] of Object.entries(results)) if (k.startsWith('T ') && !k.includes('legacy-events')) assert.match(v, /^200/, k);
    });
    await t.test('C2 C3-4/H-S5-01 and AT14: legacy priorities ground to 128 with reads at 128 vs normal; HMAC migration with interruption, restart, key loss; grinding after HMAC', { skip: !only('C2') }, async st => {
      const o: Record<string, unknown> = {}; st.after(() => evidence('P06-C2', { observed: o }));
      const w = await world(group, { legacy: true }), f = w.f, T = f.a, actor = T.issued.context.subjectId!;
      const bank = (await f.accountS06('BANK_L', 'ASSET', 'BANK')).id, L = await f.loan({ principal: '2000000.00' }); await f.disburse(L);
      // Legacy runtime = pre-S6 (no payments service): ground S5 RECEIPT keys offline so event ids AND their primary priorities rise together.
      const receipt = async (key: string, amount = '0.01') => { f.clock.value += 2100; const pos = await f.position(L.id), acc = await f.runtime.finance.read(T.issued.context, 'readAccount', w.org, bank); const c = await f.make({ kind: 'RECEIPT', borrowerId: L.borrowerId, destinationAccountId: bank, destinationAccountETag: acc.etag!, receivedAmount: amount, targets: [{ loanId: L.id, positionETag: pos.etag!, amount, mode: 'REGULAR' }], excessDisposition: 'CREDIT', receiptReference: 'G-' + key.slice(0, 18), effectiveDate: w.today(), supportReference: 'SYN-G' } as never, key as never); const t0 = performance.now(); const r = await w.settle(c.execute); return { ...r, ms: Math.round(performance.now() - t0) }; };
      const orgHeight = async () => (await w.db.collection<{ root: { height: number; count: number } | null }>('lending_merkle_orgs').findOne({ _id: w.org as never }))?.root;
      const sample = (await w.db.collection<{ key: string; priority: string }>('lending_merkle_nodes').findOne({ namespace: w.org, key: { $regex: '^loan_events\\|P\\|' } }))!; o['legacy priority == own public formula'] = H(sample.key) === sample.priority;
      const bins = 150, ground: string[] = []; let tries = 0; const g0 = performance.now();
      for (let i = 0; i < bins; i++) for (;;) { tries++; const key = randomUUID(), id = eventKey(w.org, actor, 'RECEIPT', key), p = H('loan_events|P|' + id), fi = frac(id.replace(/-/g, '')), fp = frac(p); if (fi >= i / bins && fi < (i + 1) / bins && fp >= i / bins && fp < (i + 1) / bins) { ground.push(key); break; } }
      o['grinding'] = { keys: ground.length, tries, ms: Math.round(performance.now() - g0), method: 'offline SHA-256 of the public eventKey formula and exactHash(primary key); no secret' };
      const trace: { n: number; height: number | undefined }[] = []; let committed = 0, failure: unknown = null, lastEvent = '';
      for (let i = 0; i < ground.length; i++) { const r = await receipt(ground[i]!); if (r.status !== 201) { failure = { at: i, status: r.status, code: r.code }; break; } committed++; lastEvent = eventKey(w.org, actor, 'RECEIPT', ground[i]!); if (i % 10 === 9 || i < 3) trace.push({ n: i + 1, height: (await orgHeight())?.height }); }
      o['legacy ground chain'] = { committed, failure, trace, final: await orgHeight() };
      // HTTP reads at the limit (deep event and shallow book) vs a normal read set, successful samples only; sessions kept alive by the activity route.
      const https = await f.https(), cl = new ApiClient(https.port, https.cert); cl.cookies.set('__Host-caudelyx-session', T.issued.token); await cl.refreshCsrf();
      const base = `/api/v1/organizations/${w.org}`, measure = async (client: ApiClient, path: string, n = 20) => { const ok: number[] = [], bad: string[] = []; for (let i = 0; i < n; i++) { const t0 = performance.now(), r = await client.call('GET', base + path); const ms = performance.now() - t0; if (r.status === 200) ok.push(ms); else bad.push(`${r.status} ${r.body.error?.code ?? ''}`); } return { ok: ok.length, failed: bad, p50: ok.length ? Math.round(pct(ok, 0.5)!) : null, p95: ok.length ? Math.round(pct(ok, 0.95)!) : null }; };
      const firstEvent = String((await w.db.collection('loan_events').findOne({ organizationId: w.org, kind: 'DISBURSE' }))!['_id']);
      o['reads at legacy height'] = { height: (await orgHeight())?.height, deepEvent: await measure(cl, `/loan-operations/events/${lastEvent}`), shallowEvent: await measure(cl, `/loan-operations/events/${firstEvent}`), book: await measure(cl, '/loan-operations/book') };
      // 20 ordinary random-key receipts still succeed at the limit (only further ground keys are refused).
      const ordinary: Record<string, number> = {}; for (let k = 0; k < 20; k++) { const r = await receipt(randomUUID()); ordinary[String(r.status)] = (ordinary[String(r.status)] ?? 0) + 1; } o['ordinary receipts at limit'] = ordinary;
      // ---- AT14 + AP6-06: activate HMAC priorities through the approved migration on a new runtime of the same database.
      await f.restore.flush(); const econ = [...S5, ...LEDGER], d0 = await w.digest(econ), legacyHead = await w.db.collection('lending_domain_state').findOne({ _id: 'evidence' as never });
      const priority = randomBytes(32), keys = { ...f.keys, version: 2 as const, priority }, uri = group.uri, name = group.names[0]!;
      const runtimeOn = async (k: typeof keys) => { const peer = new Database(uri, name); await peer.connect(); const restore = new RestoreController(peer, f.restore.gatePath, k.journal, k.priority); let error: string | null = null; try { await restore.initialize(); } catch (e) { error = String((e as { code?: string }).code ?? (e as Error).message); } return { peer, restore, error, open: restore.isOpen() }; };
      // Interruption: a write fault on the node collection during the migration must leave legacy state intact and the realm closed.
      await w.db.command({ collMod: 'lending_merkle_nodes', validator: { __s06_p05_fault: { $exists: true } }, validationLevel: 'strict', validationAction: 'error' });
      let interrupted; try { interrupted = await runtimeOn(keys); } finally { await w.db.command({ collMod: 'lending_merkle_nodes', validator: {}, validationLevel: 'off' }); }
      const headAfterFault = await w.db.collection('lending_domain_state').findOne({ _id: 'evidence' as never });
      o['migration interrupted'] = { error: interrupted.error, open: interrupted.open, economicUnchanged: await w.digest(econ) === d0, headUnchanged: H(headAfterFault) === H(legacyHead), checkpointWritten: await w.db.collection('lending_priority_checkpoint').countDocuments({}) };
      await interrupted.peer.close();
      // Gate closed by the interruption: an operator review reopens it. Record which priority policy the realm then runs with.
      const reviewed = await runtimeOn(keys); o['after interruption: first start'] = { open: reviewed.open, error: reviewed.error };
      if (!reviewed.open) { try { await reviewed.restore.reconcile({ approved: true, reviewId: 'S06_P05_AFTER_INTERRUPTED_MIGRATION' }); } catch (e) { o['review reconcile error'] = String((e as { code?: string }).code ?? e); } }
      const hReviewed = await w.db.collection('lending_domain_state').findOne({ _id: 'evidence' as never }), nodesReviewed = await w.db.collection<{ namespace: string; key: string; priority: string }>('lending_merkle_nodes').find({ namespace: w.org }).limit(50).toArray();
      o['after review reopen'] = { open: reviewed.restore.isOpen(), priorityPolicy: hReviewed?.['priorityPolicy'] ?? null, publicFormulaPriorities: nodesReviewed.filter(n => H(n.key) === n.priority).length + '/' + nodesReviewed.length, economicUnchanged: await w.digest(econ) === d0 };
      await reviewed.peer.close();
      // Next restart with the approved key performs the verified migration.
      const revBefore = (await w.db.collection('lending_domain_state').findOne({ _id: 'evidence' as never }))?.['revision'];
      const migrated = await runtimeOn(keys), head = await w.db.collection('lending_domain_state').findOne({ _id: 'evidence' as never });
      // Walk the CURRENT org tree from its root (reachable nodes only) and count unreachable leftovers in the same namespace.
      const walk = async () => { const coll = w.db.collection<{ _id: string; namespace: string; key: string; priority: string; left: { id: string } | null; right: { id: string } | null }>('lending_merkle_nodes'), root = (await w.db.collection<{ root: { id: string } | null }>('lending_merkle_orgs').findOne({ _id: w.org as never }))?.root, out: { namespace: string; key: string; priority: string }[] = [], stack = root ? [root.id] : [];
        while (stack.length) { const n = await coll.findOne({ _id: stack.pop()! }); if (!n) { out.push({ namespace: 'MISSING', key: '', priority: '' }); continue; } out.push(n); if (n.left) stack.push(n.left.id); if (n.right) stack.push(n.right.id); }
        return { reachable: out, stored: await coll.countDocuments({ namespace: w.org }) }; };
      const tree = await walk(), nodes = tree.reachable;
      o['migration on restart'] = { error: migrated.error, open: migrated.open, revisionChanged: head?.['revision'] !== revBefore, priorityPolicy: head?.['priorityPolicy'] ?? null, economicUnchanged: await w.digest(econ) === d0, height: (await orgHeight())?.height, count: (await orgHeight())?.count,
        checkpoint: await w.db.collection('lending_priority_checkpoint').countDocuments({}), reachableNodes: nodes.length, storedNodesInNamespace: tree.stored, ownHmac: nodes.filter(n => createHmac('sha256', priority).update(JSON.stringify(['CAUDELYX:PRIORITY:v1', n.namespace, n.key])).digest('hex') === n.priority).length + '/' + nodes.length, publicFormula: nodes.filter(n => H(n.key) === n.priority).length };
      await migrated.peer.close();
      const again = await runtimeOn(keys); o['second restart'] = { open: again.open, revisionStable: (await w.db.collection('lending_domain_state').findOne({ _id: 'evidence' as never }))?.['revision'] === head?.['revision'] }; await again.peer.close();
      // HMAC runtime over HTTPS: reads at the migrated height; grinding with the public formula no longer builds a chain.
      const hm = await runtimeOn(keys); const sessions = new Sessions(hm.peer, f.now), identity = new IdentityService(hm.peer, sessions, new SyntheticMessaging(hm.peer, keys.mail, f.now), new PasswordHasher(), () => hm.restore.isOpen(), f.now); await identity.initialize(); const rt = await attachRuntime(identity, keys, f.config);
      try {
        const https2 = await (f.https as unknown as (withClient: boolean, id: IdentityService) => Promise<{ port: number; cert: Buffer }>)(false, identity), cl2 = new ApiClient(https2.port, https2.cert); cl2.cookies.set('__Host-caudelyx-session', T.issued.token); await cl2.refreshCsrf();
        await cl2.call('POST', '/api/v1/auth/session/activity', {});
        o['reads after HMAC migration'] = { open: hm.restore.isOpen(), height: (await orgHeight())?.height, deepEvent: await measure(cl2, `/loan-operations/events/${lastEvent}`), shallowEvent: await measure(cl2, `/loan-operations/events/${firstEvent}`), book: await measure(cl2, '/loan-operations/book') };
        const pay = identity.payments!, ground2: string[] = []; let tries2 = 0;
        for (let i = 0; i < 30; i++) for (;;) { tries2++; const key = randomUUID(), id = eventKey(w.org, actor, 'RECEIPT', key), p = H('loan_events|P|' + id), fi = frac(id.replace(/-/g, '')), fp = frac(p); if (fi >= 0.5 + i / 60 && fi < 0.5 + (i + 1) / 60 && fp >= 0.5 + i / 60 && fp < 0.5 + (i + 1) / 60) { ground2.push(key); break; } }
        const h0 = (await orgHeight())?.height, trace2: { n: number; height: number | undefined; status: number }[] = [];
        for (let i = 0; i < ground2.length; i++) {
          f.clock.value += 2100; const key = ground2[i]! as ReturnType<typeof randomUUID>, pos = await rt.operations.read(T.issued.context, 'getLoanPosition', w.org, L.id), acc = await rt.finance.read(T.issued.context, 'readAccount', w.org, bank), state = (await pay.read(T.issued.context, 'getPaymentsState', w.org)).data as { paymentsBookETag: string };
          const command = { kind: 'REGISTER', mode: 'DIRECT', effectiveDate: w.today(), intent: { method: 'BANK', borrowerId: L.borrowerId, amount: '0.01', currency: 'COP', destinationAccountId: bank, destinationAccountETag: acc.etag!, custodianId: null, bindingETag: null, observedDate: w.today(), observedAt: new Date(f.now() - 1000).toISOString(), receiptReference: 'H-' + key.slice(0, 18), supportReference: 'SYN-H', targets: [{ loanId: L.id, positionETag: pos.etag!, amount: '0.01', mode: 'REGULAR' }], excessDisposition: 'CREDIT' } };
          const r = await w.settle(async () => { const pv = (await pay.preview(T.issued.context, w.org, { executionKey: key, expectedPaymentsETag: state.paymentsBookETag, command })).data as { token: string }, payload = { command, previewToken: pv.token };
            await f.proof(T, 'PAYMENT_REGISTER_DIRECT', { organizationId: w.org, idempotencyKey: key, expectedETag: state.paymentsBookETag, operationId: 'registerPayment', resourceId: null, payload }); return await pay.mutate(T.issued.context, 'registerPayment', w.org, payload, key, state.paymentsBookETag); });
          if (i % 5 === 4 || i < 2 || r.status !== 201) trace2.push({ n: i + 1, height: (await orgHeight())?.height, status: r.status });
          if (r.status !== 201) { o['HMAC grinding failure'] = w.st(r); break; }
        }
        o['grinding under HMAC'] = { keys: ground2.length, tries: tries2, heightBefore: h0, trace: trace2, heightAfter: (await orgHeight())?.height };
      } finally { await hm.peer.close(); }
      // Key loss / other key at the end (they close the shared gate); an approved review with the right key reopens.
      const wrong = await runtimeOn({ ...keys, priority: randomBytes(32) }); o['other priority key'] = { open: wrong.open, error: wrong.error }; await wrong.peer.close();
      const lost = await runtimeOn({ ...keys, priority: undefined as unknown as typeof priority }); o['priority key lost'] = { open: lost.open, error: lost.error }; await lost.peer.close();
      const back = await runtimeOn(keys); if (!back.open) { try { await back.restore.reconcile({ approved: true, reviewId: 'S06_P05_KEY_RESTORED' }); } catch (e) { o['reopen with right key error'] = String((e as { code?: string }).code ?? e); } }
      o['right key after loss'] = { open: back.restore.isOpen() }; await back.peer.close();
      evidence('P06-C2-summary', { committed });
      assert.equal(o['legacy priority == own public formula'], true);
      assert.equal((o['migration interrupted'] as { open: boolean }).open, false); assert.equal((o['migration interrupted'] as { economicUnchanged: boolean }).economicUnchanged, true);
      const mr = o['migration on restart'] as Record<string, unknown>; assert.deepEqual([mr['open'], mr['economicUnchanged'], mr['priorityPolicy'], mr['publicFormula']], [true, true, 'HMAC-SHA256-v1', 0]); assert.equal(mr['ownHmac'], `${String(mr['reachableNodes'])}/${String(mr['reachableNodes'])}`);
      assert.equal((o['second restart'] as { revisionStable: boolean }).revisionStable, true);
      assert.equal((o['other priority key'] as { open: boolean }).open, false); assert.equal((o['priority key lost'] as { open: boolean }).open, false);
      // 'right key after loss' is recorded, not asserted: here two in-process runtimes (legacy fixture + HMAC peer) share one gate/journal; recovery is asserted in C3 isolation.
    });
    await t.test('C3 key loss recovery isolated: migrate, other/lost key, right key — with and without HMAC commands/flush', { skip: !only('C3') }, async st => {
      const o: Record<string, unknown> = {}; st.after(() => evidence('P06-C3', { observed: o }));
      for (const variant of (process.env['P05_C3_VARIANTS'] ?? 'no commands|commands then flush|commands without flush|after interrupted migration').split('|')) {
        const w = await world(group, { legacy: true }), f = w.f, T = f.a, bank = (await f.accountS06('BANK_K', 'ASSET', 'BANK')).id, L = await f.loan({ principal: '2000000.00' }); await f.disburse(L); await f.restore.flush();
        const priority = randomBytes(32), keys = { ...f.keys, version: 2 as const, priority }, uri = group.uri, name = group.names[0]!;
        const on = async (k: typeof keys) => { const peer = new Database(uri, name); await peer.connect(); const restore = new RestoreController(peer, f.restore.gatePath, k.journal, k.priority); let error: string | null = null; try { await restore.initialize(); } catch (e) { error = String((e as { code?: string }).code ?? (e as Error).message); } return { peer, restore, error, open: restore.isOpen() }; };
        const r: Record<string, unknown> = {};
        if (variant === 'after interrupted migration') {
          await w.db.command({ collMod: 'lending_merkle_nodes', validator: { __s06_p05_fault: { $exists: true } }, validationLevel: 'strict', validationAction: 'error' });
          let i1; try { i1 = await on(keys); } finally { await w.db.command({ collMod: 'lending_merkle_nodes', validator: {}, validationLevel: 'off' }); } r['interrupted'] = { open: i1.open, error: i1.error }; await i1.peer.close();
          const rv = await on(keys); r['first start after interruption'] = { open: rv.open }; if (!rv.open) { try { await rv.restore.reconcile({ approved: true, reviewId: 'S06_P05_INT' }); } catch (e) { r['review error'] = String((e as { code?: string }).code ?? e); } } r['review reopened'] = rv.restore.isOpen(); r['policy after review'] = (await w.db.collection('lending_domain_state').findOne({ _id: 'evidence' as never }))?.['priorityPolicy'] ?? null; await rv.peer.close();
        }
        const m1 = await on(keys); r['migrate'] = { open: m1.open, error: m1.error, policy: (await w.db.collection('lending_domain_state').findOne({ _id: 'evidence' as never }))?.['priorityPolicy'] ?? null };
        if (variant !== 'no commands') {
          const sessions = new Sessions(m1.peer, f.now), identity = new IdentityService(m1.peer, sessions, new SyntheticMessaging(m1.peer, keys.mail, f.now), new PasswordHasher(), () => m1.restore.isOpen(), f.now); await identity.initialize(); const rt = await attachRuntime(identity, keys, f.config);
          const statuses: string[] = [];
          for (let i = 0; i < 3; i++) { f.clock.value += 2100; const key = randomUUID(), pos = await rt.operations.read(T.issued.context, 'getLoanPosition', w.org, L.id), acc = await rt.finance.read(T.issued.context, 'readAccount', w.org, bank), state = (await identity.payments!.read(T.issued.context, 'getPaymentsState', w.org)).data as { paymentsBookETag: string };
            const command = { kind: 'REGISTER', mode: 'DIRECT', effectiveDate: w.today(), intent: { method: 'BANK', borrowerId: L.borrowerId, amount: '1.00', currency: 'COP', destinationAccountId: bank, destinationAccountETag: acc.etag!, custodianId: null, bindingETag: null, observedDate: w.today(), observedAt: new Date(f.now() - 1000).toISOString(), receiptReference: 'K-' + key.slice(0, 18), supportReference: 'SYN-K', targets: [{ loanId: L.id, positionETag: pos.etag!, amount: '1.00', mode: 'REGULAR' }], excessDisposition: 'CREDIT' } };
            const res = await w.settle(async () => { const pv = (await identity.payments!.preview(T.issued.context, w.org, { executionKey: key, expectedPaymentsETag: state.paymentsBookETag, command })).data as { token: string }, payload = { command, previewToken: pv.token }; await f.proof(T, 'PAYMENT_REGISTER_DIRECT', { organizationId: w.org, idempotencyKey: key, expectedETag: state.paymentsBookETag, operationId: 'registerPayment', resourceId: null, payload }); return await identity.payments!.mutate(T.issued.context, 'registerPayment', w.org, payload, key, state.paymentsBookETag); });
            statuses.push(w.st(res)); }
          r['hmac commands'] = statuses;
          if (variant === 'commands then flush') { try { await m1.restore.flush(); r['flush'] = 'ok'; } catch (e) { r['flush'] = String((e as { code?: string }).code ?? e); } }
        }
        await m1.peer.close();
        const plain = await on(keys); r['restart right key (no loss yet)'] = { open: plain.open, error: plain.error }; if (!plain.open) { try { await plain.restore.reconcile({ approved: true, reviewId: 'S06_P05_PLAIN' }); } catch (e) { r['plain reconcile'] = String((e as { code?: string }).code ?? e); } r['plain after review'] = plain.restore.isOpen(); } await plain.peer.close();
        const wrong = await on({ ...keys, priority: randomBytes(32) }); r['other key'] = { open: wrong.open, error: wrong.error }; await wrong.peer.close();
        const headBeforeLost = H(await w.db.collection('lending_domain_state').findOne({ _id: 'evidence' as never })), gateBefore = await (await import('node:fs/promises')).readFile(f.restore.gatePath, 'utf8').catch(() => 'absent');
        const lost = await on({ ...keys, priority: undefined as unknown as typeof priority }); r['no priority key'] = { open: lost.open, error: lost.error }; await lost.peer.close();
        r['no-key start changed head'] = H(await w.db.collection('lending_domain_state').findOne({ _id: 'evidence' as never })) !== headBeforeLost; r['no-key start changed gate file'] = (await (await import('node:fs/promises')).readFile(f.restore.gatePath, 'utf8').catch(() => 'absent')) !== gateBefore;
        const back = await on(keys); r['right key after other key'] = { open: back.open, error: back.error }; if (!back.open) { try { await back.restore.reconcile({ approved: true, reviewId: 'S06_P05_BACK' }); } catch (e) { r['back reconcile'] = String((e as { code?: string }).code ?? e); } r['back after review'] = back.restore.isOpen(); } await back.peer.close();
        o[variant] = r;
        assert.equal(r['back after review'], true, variant); assert.equal((r['other key'] as { open: boolean }).open, false, variant); assert.equal((r['no priority key'] as { open: boolean }).open, false, variant);
      }
    });
  } finally { await group.dispose(); }
});
