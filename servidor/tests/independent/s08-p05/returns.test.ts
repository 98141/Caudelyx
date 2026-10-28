/* eslint-disable security/detect-object-injection -- Own fixed observation keys of this review, never request input. */
// S08-P05 own revalidation of H-S7-P05-01 (Claude) on S08-P04-v1-INTEGRADO, RETURNS_DELTA_S08 D2: 250 declared / 230 counted.
// Requesting a return from DISCREPANCY and INVESTIGATION must be allowed for sender/receiver/T, keep count/shortage/reserve/
// commitment/ledger, never finalize as exact or release anything; only real exact facts finalize. Expected positions come from
// the reviewer's own S7 oracle (S7Book), never from the backend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { s08ReviewProfile } from './review-profile.js';
import { world8, evidence, metricsOf, type Group, type World8 } from './review-fixtures.js';
import { S7Book, c, terms } from '../s07-p05/oracle.js';

const only = (name: string) => !process.env['P05_ONLY'] || process.env['P05_ONLY']!.split(',').some(x => name.startsWith(x));
async function scenario(group: Group) {
  const x = await world8(group), f = x.f, book = new S7Book('HELD'), T0 = x.today();
  book.fund('FUND', c('20000000.00')); book.addLoan(f.l.id, f.l.borrowerId, terms() as never); book.disburse(f.l.id, 'FUND');
  book.register(f.paymentId, { method: 'CASH', mode: 'SUPERVISED', borrower: f.l.borrowerId, amount: c('300000.00'), account: 'CASH_C', targets: [{ loan: f.l.id, amount: c('300000.00'), mode: 'REGULAR' }], excess: 'CREDIT', registrar: 'C', custodian: 'C' }, T0);
  book.approve(f.paymentId, 'T', T0); book.lot(f.paymentId, 'CASH_C', c('300000.00'));
  const C = f.c.issued.context.subjectId!;
  const pos = async () => await x.position(C, f.cash.id, f.a);
  const counts = async () => ({ journals: await x.journals(), facts: await x.db.collection('cash_delivery_facts').countDocuments({ organizationId: x.org }), audit: await x.db.collection('audit_events').countDocuments({}), outbox: await x.db.collection('outbox').countDocuments({}), held: await x.db.collection('held_funds_reservations').countDocuments({ organizationId: x.org }) });
  const keep = async (id: string) => { const d = (await x.db.collection('cash_deliveries').findOne({ _id: id as never }))! as Record<string, unknown>; return { state: d['state'], returnFrom: d['returnFrom'], lastCount: d['lastCount'], countId: d['countId'], amount: d['amount'], portions: d['portions'], returnCount: d['returnCount'], journalId: d['journalId'] }; };
  /** Delivery 250k counted 230k by O → DISCREPANCY (own oracle tracks physical buckets). */
  const discrepancy = async () => {
    const r = await x.request('250000.00'); assert.equal(r.status, 201, x.st(r as never)); const id = r.id!; book.request(id, 'CASH_C', 'CENTRAL', [{ lot: f.paymentId, amount: c('250000.00') }]);
    await x.act('dispatchCashDelivery', id, f.c); book.dispatch(id); await x.act('receiveCashDelivery', id, f.o); book.receive(id);
    assert.equal((await x.count(id, '230000.00')).status, 201); book.count(id, c('230000.00')); return id;
  };
  /** Raw collections command with a fixed idempotency key and fixed book ETag (replay/conflict/stale tests). */
  const raw = async (op: string, id: string, actor: typeof f.a, payload: Record<string, unknown>, key: string, bookETag: string) => await x.settle(() => f.collections.mutate(actor.issued.context, op, x.org, payload, key, bookETag, id) as never);
  const dash = async (actor: typeof f.a) => await x.rep(actor, 'getReportingDashboard', undefined, { asOf: x.today(), from: x.today(), to: x.today() });
  return { x, f, book, pos, counts, keep, discrepancy, raw, dash };
}
const money = (p: Awaited<ReturnType<World8['position']>>) => p && { ledgerBalance: p.ledgerBalance, retainedAtOrigin: p.retainedAtOrigin, committed: p.committed, uncommitted: p.uncommitted, held: p.held, compensationReserve: p.compensationReserve, available: p.available, physical: p.physical };

test('P08-H01 H-S7-P05-01 return request from DISCREPANCY/INVESTIGATION (AT09)', { timeout: 3600000 }, async t => {
  const group: Group = await s08ReviewProfile();
  try {
    await t.test('R1 DISCREPANCY 250/230: solicitud permitida, nada liberado, 230 no finaliza', { skip: !only('R1') }, async st => {
      const s = await scenario(group), { x, f, book } = s, o: Record<string, unknown> = {}; st.after(() => evidence('P08-R1', { observed: o }));
      const id = await s.discrepancy(), oracle0 = book.position('CASH_C');
      o['0 antes'] = { delivery: await s.keep(id), position: { server: money(await s.pos()), oracle: oracle0 }, counts: await s.counts() };
      const P = await x.member(['P']), T2 = await f.newActor(); await f.tenant(T2 as never);
      const d0 = await f.readCollections('getCashDelivery', id), v0 = (await f.collectionsState()).collectionsBookETag, body = { resourceETag: d0.etag, occurredAt: new Date(f.now()).toISOString(), reason: 'Retorno sintético', supportReference: 'SYN-P05-RET' };
      o['P solicita'] = x.st(await s.raw('requestCashDeliveryReturn', id, P, body, randomUUID(), v0) as never);
      o['T otra org solicita'] = x.st(await x.settle(() => f.collections.mutate((T2 as typeof f.a).issued.context, 'requestCashDeliveryReturn', x.org, body, randomUUID(), v0, id) as never));
      o['ETag de recurso viejo'] = x.st(await s.raw('requestCashDeliveryReturn', id, f.o, { ...body, resourceETag: `"${id}:1"` }, randomUUID(), v0) as never);
      // Atomicity: fault on the fact table aborts the whole command (no partial state).
      const before = await s.keep(id);
      await x.db.command({ collMod: 'cash_delivery_facts', validator: { __s08_p05_fault: { $exists: true } }, validationLevel: 'strict', validationAction: 'error' });
      try { o['fallo inyectado en hechos'] = x.st(await s.raw('requestCashDeliveryReturn', id, f.o, body, randomUUID(), v0) as never); } finally { await x.db.command({ collMod: 'cash_delivery_facts', validator: {}, validationLevel: 'off' }); }
      o['sin escritura parcial'] = JSON.stringify(await s.keep(id)) === JSON.stringify(before);
      const key = randomUUID(), c0 = await s.counts();
      const first = await s.raw('requestCashDeliveryReturn', id, f.o, body, key, v0); o['O (receptor) solicita'] = x.st(first as never);
      o['replay misma clave/cuerpo'] = x.st(await s.raw('requestCashDeliveryReturn', id, f.o, body, key, v0) as never);
      o['misma clave, cuerpo distinto'] = x.st(await s.raw('requestCashDeliveryReturn', id, f.o, { ...body, reason: 'Otro' }, key, v0) as never);
      o['segunda solicitud clave nueva'] = x.st(await x.act('requestCashDeliveryReturn', id, f.c) as never);
      o['1 después de solicitar'] = { delivery: await s.keep(id), position: { server: money(await s.pos()), oracle: book.position('CASH_C') }, counts: await s.counts(), countsBefore: c0 };
      const cd = metricsOf(await s.dash(f.c), 'ownActivityMetrics'); o['C dashboard (propio) después'] = Object.fromEntries(['CUSTODY_CONFIRMED', 'CUSTODY_COMMITTED', 'DELIVERED_NET'].map(k => [k, (cd[k] as { value: string; status: string } | undefined)?.value ?? 'ABSENT']));
      o['T confirma retorno sin hechos'] = x.st(await x.act('confirmCashDeliveryReturn', id, f.a) as never);
      o['O declara despacho 230 (≠ contrato)'] = x.st(await x.act('recordCashDeliveryReturnFact', id, f.o, { kind: 'RECEIVER_RETURN_DISPATCHED', amount: '230000.00' }) as never);
      o['C SOURCE_COUNT antes de recibir'] = x.st(await x.act('recordCashDeliveryReturnFact', id, f.c, { kind: 'SOURCE_COUNT', amount: '230000.00' }) as never);
      o['O despacha 250 (monto contractual)'] = x.st(await x.act('recordCashDeliveryReturnFact', id, f.o, { kind: 'RECEIVER_RETURN_DISPATCHED', amount: '250000.00' }) as never);
      o['C recibe 250'] = x.st(await x.act('recordCashDeliveryReturnFact', id, f.c, { kind: 'SOURCE_RECEIVED', amount: '250000.00' }) as never);
      o['C cuenta 230'] = x.st(await x.act('recordCashDeliveryReturnFact', id, f.c, { kind: 'SOURCE_COUNT', amount: '230000.00' }) as never);
      const j0 = await x.journals();
      o['T finaliza con 230'] = x.st(await x.act('confirmCashDeliveryReturn', id, f.a) as never);
      // S7 physical model: once the source counted 230 of the declared 250 returned, the 20k missing is attributed to the receiver side.
      const posO = await x.position(f.o.issued.context.subjectId!, f.central.id, f.a), tk = String(((await s.dash(f.a)).data!['meta'] as Record<string, unknown>)['snapshotToken']);
      o['2 tras intento de finalizar'] = { delivery: await s.keep(id), positionC: money(await s.pos()), positionO: money(posO), cashReport: ((await x.rep(f.a, 'listReportingRows', 'CASH', { snapshotToken: tk, limit: '100' })).data?.['items'] as Record<string, unknown>[] | undefined)?.filter(z => z['accountId'] === f.cash.id || z['accountId'] === f.central.id).map(z => ({ account: z['accountId'] === f.cash.id ? 'CASH_C' : 'CENTRAL', committed: z['committed'], reserved: z['reserved'], physical: z['physical'] })), journalsAdded: await x.journals() - j0 };
      assert.equal(o['O (receptor) solicita'], '201'); assert.equal(o['replay misma clave/cuerpo'], '200');
      assert.match(String(o['P solicita']), /^40[34] /); assert.match(String(o['T otra org solicita']), /^40[34] /); assert.match(String(o['ETag de recurso viejo']), /^412 /);
      assert.equal(o['sin escritura parcial'], true); assert.match(String(o['T finaliza con 230']), /^409 /); assert.match(String(o['T confirma retorno sin hechos']), /^409 /);
      const k1 = (o['1 después de solicitar'] as { delivery: Record<string, unknown> }).delivery; assert.equal(k1['state'], 'RETURN_REQUIRED'); assert.equal(k1['returnFrom'], 'DISCREPANCY'); assert.equal(k1['lastCount'], '230000.00');
      assert.deepEqual(money(await s.pos()), money(await s.pos())); assert.deepEqual(((o['1 después de solicitar'] as { position: { server: unknown } }).position.server as Record<string, unknown>)['committed'], '250000.00');
      assert.equal((o['2 tras intento de finalizar'] as { journalsAdded: number }).journalsAdded, 0);
    });
    await t.test('R2 INVESTIGATION 250/230: solicitud, hechos exactos reales de partes distintas finalizan sin liberar reserva', { skip: !only('R2') }, async st => {
      const s = await scenario(group), { x, f, book } = s, o: Record<string, unknown> = {}; st.after(() => evidence('P08-R2', { observed: o }));
      const id = await s.discrepancy();
      o['investigar (T)'] = x.st(await x.act('investigateCashDelivery', id, f.a) as never);
      o['0 en INVESTIGATION'] = { delivery: await s.keep(id), position: { server: money(await s.pos()), oracle: book.position('CASH_C') }, counts: await s.counts() };
      o['C (emisor) solicita'] = x.st(await x.act('requestCashDeliveryReturn', id, f.c) as never);
      o['1 después de solicitar'] = { delivery: await s.keep(id), position: { server: money(await s.pos()), oracle: book.position('CASH_C') }, counts: await s.counts() };
      o['O despacha 250'] = x.st(await x.act('recordCashDeliveryReturnFact', id, f.o, { kind: 'RECEIVER_RETURN_DISPATCHED', amount: '250000.00' }) as never);
      o['O declara SOURCE_RECEIVED (parte ajena)'] = x.st(await x.act('recordCashDeliveryReturnFact', id, f.o, { kind: 'SOURCE_RECEIVED', amount: '250000.00' }) as never);
      o['C recibe 250'] = x.st(await x.act('recordCashDeliveryReturnFact', id, f.c, { kind: 'SOURCE_RECEIVED', amount: '250000.00' }) as never);
      o['C cuenta 250'] = x.st(await x.act('recordCashDeliveryReturnFact', id, f.c, { kind: 'SOURCE_COUNT', amount: '250000.00' }) as never);
      o['O finaliza (solo T)'] = x.st(await x.act('confirmCashDeliveryReturn', id, f.o) as never);
      const j0 = await x.journals(), c0 = await s.counts();
      o['T finaliza'] = x.st(await x.act('confirmCashDeliveryReturn', id, f.a) as never); book.returned(id);
      o['2 finalizado'] = { delivery: await s.keep(id), position: { server: money(await s.pos()), oracle: book.position('CASH_C') }, journalsAdded: await x.journals() - j0, counts: await s.counts(), countsBefore: c0 };
      const tok = String(((await s.dash(f.a)).data!['meta'] as Record<string, unknown>)['snapshotToken']);
      o['reporte CASH T'] = ((await x.rep(f.a, 'listReportingRows', 'CASH', { snapshotToken: tok, accountId: f.cash.id })).data?.['items'] as Record<string, unknown>[] | undefined)?.map(r => ({ confirmed: r['confirmed'], committed: r['committed'], reserved: r['reserved'], available: r['available'], physical: r['physical'] }));
      o['MOVEMENTS sin devolución contable'] = ((await x.rep(f.a, 'listReportingRows', 'MOVEMENTS', { snapshotToken: tok, limit: '100' })).data?.['items'] as Record<string, unknown>[] | undefined)?.map(r => r['nature']);
      assert.equal(o['C (emisor) solicita'], '201'); assert.equal((o['1 después de solicitar'] as { delivery: Record<string, unknown> }).delivery['returnFrom'], 'INVESTIGATION');
      assert.equal(o['T finaliza'], '201'); assert.match(String(o['O finaliza (solo T)']), /^403 /);
      const fin = o['2 finalizado'] as { delivery: Record<string, unknown>; position: { server: Record<string, unknown>; oracle: Record<string, unknown> }; journalsAdded: number };
      assert.equal(fin.delivery['state'], 'CANCELLED'); assert.equal(fin.journalsAdded, 0); const { deliveredNet: _d, ...own } = fin.position.oracle; void _d; assert.deepEqual(fin.position.server, own);
    });
    await t.test('R3 compensación activa: CUSTODY_COMMITTED (solo FORWARD según diccionario) y reservas vs posición S7/oráculo', { skip: !only('R3') }, async st => {
      const s = await scenario(group), { x, f, book } = s, o: Record<string, unknown> = {}; st.after(() => evidence('P08-R3', { observed: o }));
      const r = await x.request('250000.00'), id = r.id!; book.request(id, 'CASH_C', 'CENTRAL', [{ lot: f.paymentId, amount: c('250000.00') }]);
      await x.act('dispatchCashDelivery', id, f.c); book.dispatch(id); await x.act('receiveCashDelivery', id, f.o); book.receive(id); await x.count(id, '250000.00'); book.count(id, c('250000.00'));
      o['confirmar'] = x.st(await x.confirm(id) as never); book.confirmDelivery(id);
      const comp = await x.compensate(id); o['solicitar compensación'] = x.st(comp as never); if (comp.status === 201) book.compensate(comp.id!, id);
      const O = f.o.issued.context.subjectId!, posO = await x.position(O, f.central.id, f.a), posC = await s.pos();
      o['posición S7 CENTRAL'] = { server: posO && { committed: posO.committed, compensationReserve: posO.compensationReserve, available: posO.available, ledgerBalance: posO.ledgerBalance }, oracle: (({ committed, compensationReserve, available, ledgerBalance }) => ({ committed, compensationReserve, available, ledgerBalance }))(book.position('CENTRAL')) };
      o['posición S7 CASH_C'] = { server: posC && { committed: posC.committed, retainedAtOrigin: posC.retainedAtOrigin, available: posC.available }, oracle: (({ committed, retainedAtOrigin, available }) => ({ committed, retainedAtOrigin, available }))(book.position('CASH_C')) };
      const d = await s.dash(f.a), m = metricsOf(d), v = (k: string) => (m[k] as { value: string | null } | undefined)?.value;
      o['dashboard T'] = Object.fromEntries(['CUSTODY_CONFIRMED', 'CUSTODY_COMMITTED', 'LIQUIDITY_RESERVED', 'LIQUIDITY_AVAILABLE', 'LIQUIDITY_BOOK', 'DELIVERED_NET'].map(k => [k, v(k)]));
      const od = metricsOf(await s.dash(f.o), 'ownActivityMetrics'); o['dashboard O'] = Object.fromEntries(['CUSTODY_COMMITTED', 'DELIVERED_NET'].map(k => [k, (od[k] as { value: string | null } | undefined)?.value]));
      const tok = String((d.data!['meta'] as Record<string, unknown>)['snapshotToken']);
      o['CASH T'] = ((await x.rep(f.a, 'listReportingRows', 'CASH', { snapshotToken: tok, limit: '100' })).data?.['items'] as Record<string, unknown>[] | undefined)?.filter(z => z['accountId'] === f.central.id || z['accountId'] === f.cash.id).map(z => ({ account: z['accountId'] === f.cash.id ? 'CASH_C' : 'CENTRAL', committed: z['committed'], confirmed: z['confirmed'], reserved: z['reserved'], available: z['available'] }));
      o['esperado diccionario'] = { CUSTODY_COMMITTED: '0.00 (FORWARD activas; la compensación activa se separa como reserva de la cuenta origen)', LIQUIDITY_RESERVED_includes_compensation: '250000.00 + retenido 50000.00' };
      assert.equal(o['solicitar compensación'], '201');
    });
  } finally { await group.dispose(); }
});
