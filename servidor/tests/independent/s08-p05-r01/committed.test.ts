/* eslint-disable security/detect-object-injection -- Own fixed indicator ids/labels/account maps of this review, never request input. */
// S08-P05-R01 own focal revalidation (Claude) of H-S8-P05-01 on S08-P04-v2-H01-CORREGIDO. Derived from own P05 R3 (frozen: not
// edited, not executed). ONE own group, ONE world: cobro 300k CASH_C (C) → FORWARD 250k activa (REQUESTED, COUNTED) → FORWARD
// confirmada → COMPENSATION 250k activa → COMPENSATION confirmada. Each phase compares T/C/O dashboards with the own raw-data
// oracle (../s08-p05/indicators.ts: FORWARD-only commitment per INDICATORS_DICTIONARY_S08) AND with amounts commanded here; CASH
// rows with expectations from commanded amounts; S7 positions with the own S7Book. S7 reads (inherited Database.transaction/fence)
// happen BEFORE the reporting-only purity baseline. Nothing expected is taken from the backend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { s08R01Profile } from './review-profile.js';
import { world8, evidence, metricsOf, type Reply, type World8 } from '../s08-p05/review-fixtures.js';
import { oracle, cents, money, type Scope } from '../s08-p05/indicators.js';
import { S7Book, c, terms } from '../s07-p05/oracle.js';

const ALL = ['PRINCIPAL_DISBURSED', 'PRINCIPAL_OUTSTANDING', 'PRINCIPAL_LEDGER', 'PRINCIPAL_DUE_TODAY_OR_EARLIER', 'PRINCIPAL_OVERDUE', 'INTEREST_OVERDUE', 'PRINCIPAL_EXPOSED_OVERDUE', 'PAR30', 'INTEREST_EXPECTED_FUTURE', 'INTEREST_DUE_UNACCRUED', 'INTEREST_ACCRUED', 'INTEREST_RECEIVABLE', 'INTEREST_RECEIVED', 'INTEREST_SATISFIED_BY_CREDIT', 'PRINCIPAL_RECOVERED', 'RECEIPTS_CONFIRMED', 'RECEIPTS_REGISTERED', 'BORROWER_CREDIT', 'HELD_FUNDS', 'LIQUIDITY_BOOK', 'LIQUIDITY_RESERVED', 'LIQUIDITY_AVAILABLE', 'CUSTODY_PROVISIONAL', 'CUSTODY_CONFIRMED', 'CUSTODY_COMMITTED', 'DELIVERED_NET', 'INSTALLMENT_FULFILMENT', 'RETURN_ON_AVERAGE_CAPITAL', 'OBLIGATIONS_COVERAGE', 'INTEGRAL_NET_WORTH'];
const OWN = ['RECEIPTS_REGISTERED', 'RECEIPTS_CONFIRMED', 'PRINCIPAL_RECOVERED', 'INTEREST_RECEIVED', 'CUSTODY_PROVISIONAL', 'CUSTODY_CONFIRMED', 'CUSTODY_COMMITTED', 'DELIVERED_NET', 'HELD_FUNDS'];
const KEY = ['CUSTODY_CONFIRMED', 'CUSTODY_COMMITTED', 'DELIVERED_NET', 'LIQUIDITY_BOOK', 'LIQUIDITY_RESERVED', 'LIQUIDITY_AVAILABLE', 'RECEIPTS_CONFIRMED', 'INTEREST_RECEIVED'];
type Mismatch = { at: string; id: string; server: unknown; oracle: unknown };
type Row = Record<string, unknown>;

test('S08-P05-R01 H-S8-P05-01: CUSTODY_COMMITTED solo FORWARD activas; compensación activa = reserva de origen', { timeout: 1800000 }, async () => {
  const group = await s08R01Profile(), o: Record<string, unknown> = {}, bad: Mismatch[] = [], fail: string[] = [];
  const expect = (at: string, got: unknown, want: unknown) => { if (JSON.stringify(got) !== JSON.stringify(want)) fail.push(`${at}: servidor ${JSON.stringify(got)} ≠ esperado ${JSON.stringify(want)}`); };
  try {
    const x: World8 = await world8(group as never), f = x.f, book = new S7Book('HELD'), T0 = x.today();
    book.fund('FUND', c('20000000.00')); book.addLoan(f.l.id, f.l.borrowerId, terms() as never); book.disburse(f.l.id, 'FUND');
    book.register(f.paymentId, { method: 'CASH', mode: 'SUPERVISED', borrower: f.l.borrowerId, amount: c('300000.00'), account: 'CASH_C', targets: [{ loan: f.l.id, amount: c('300000.00'), mode: 'REGULAR' }], excess: 'CREDIT', registrar: 'C', custodian: 'C' }, T0);
    book.approve(f.paymentId, 'T', T0); book.lot(f.paymentId, 'CASH_C', c('300000.00'));
    const T = f.a, C = f.c, O = f.o, cId = C.issued.context.subjectId!, oId = O.issued.context.subjectId!;
    const acct = (id: unknown) => id === f.cash.id ? 'CASH_C' : id === f.central.id ? 'CENTRAL' : 'OTRA';
    const cut = () => ({ asOf: x.today(), from: x.today().slice(0, 8) + '01', to: x.today() });
    const dash = async (a: typeof T) => await x.rep(a, 'getReportingDashboard', undefined, cut());
    const token = (r: Reply) => String((r.data!['meta'] as Row)['snapshotToken']);
    const cash = async (a: typeof T, r: Reply) => { const q = await x.rep(a, 'listReportingRows', 'CASH', { snapshotToken: token(r), limit: '100' }); if (q.status !== 200) return x.st(q as never);
      return Object.fromEntries(((q.data!['items'] as Row[]) ?? []).filter(z => acct(z['accountId']) !== 'OTRA').map(z => [acct(z['accountId']), { responsible: z['responsibleId'] === cId ? 'C' : z['responsibleId'] === oId ? 'O' : String(z['responsibleId']), committed: z['committed'], confirmed: z['confirmed'], provisional: z['provisional'], held: z['held'], ...('reserved' in z ? { reserved: z['reserved'], available: z['available'], bookBalance: z['bookBalance'] } : {}) }])); };
    const pick = (r: Reply, list: string, ids = KEY) => { const m = metricsOf(r, list); return Object.fromEntries(ids.filter(k => m[k]).map(k => [k, (m[k] as { value: string | null }).value])); };
    /** Compares every id of a dashboard list with the own oracle (value and status discipline). */
    const compare = (at: string, r: Reply, scope: Scope, ids: string[], list: string, data: Awaited<ReturnType<World8['dump']>>) => {
      const K = String((r.data!['meta'] as Row)['recordedThrough']), exp = oracle(data, { ...cut(), recordedThrough: K }, scope, true), got = metricsOf(r, list);
      for (const id of ids) { const m = got[id] as { value: string | null; status: string } | undefined;
        if (!m) { bad.push({ at, id, server: 'ABSENT', oracle: exp.metrics[id] }); continue; }
        if (m.value !== exp.metrics[id]) bad.push({ at, id, server: m.value + ' ' + m.status, oracle: exp.metrics[id] });
        if (exp.status[id] && m.status !== exp.status[id]) bad.push({ at, id: id + '.status', server: m.status, oracle: exp.status[id] }); }
      return exp;
    };
    const s7 = async () => { const pc = await x.position(cId, f.cash.id, T), po = await x.position(oId, f.central.id, T);
      const sel = (p: Row | null) => p && { committed: p['committed'], compensationReserve: p['compensationReserve'], retainedAtOrigin: p['retainedAtOrigin'], available: p['available'], ledgerBalance: p['ledgerBalance'] };
      const bk = (a: string) => { const p = book.position(a); return { committed: p.committed, compensationReserve: p.compensationReserve, retainedAtOrigin: p.retainedAtOrigin, available: p.available, ledgerBalance: p.ledgerBalance }; };
      return { CASH_C: { server: sel(pc as never), oracle: bk('CASH_C') }, CENTRAL: { server: sel(po as never), oracle: bk('CENTRAL') } }; };
    /** One phase: S7 positions first (outside the purity line), then reporting GETs T/C/O + CASH rows (T and O), oracle comparison. */
    const phase = async (label: string, purity = false) => {
      const pos = await s7(), g0 = purity ? await x.digestAll() : null;
      const dT = await dash(T), dC = await dash(C), dO = await dash(O);
      for (const [who, r] of [['T', dT], ['C', dC], ['O', dO]] as const) assert.equal(r.status, 200, `${label} ${who} ${x.st(r as never)}`);
      const rowsT = await cash(T, dT), rowsO = await cash(O, dO), rowsC = await cash(C, dC), g1 = purity ? await x.digestAll() : null;
      const data = await x.dump(), expT = compare(label + ' T', dT, { kind: 'T', actor: T.issued.context.subjectId! }, ALL, 'organizationMetrics', data);
      compare(label + ' C own', dC, { kind: 'C', actor: cId }, OWN, 'ownActivityMetrics', data); compare(label + ' O own', dO, { kind: 'O', actor: oId }, OWN, 'ownActivityMetrics', data);
      const ph = { T: pick(dT, 'organizationMetrics'), C: pick(dC, 'ownActivityMetrics', OWN), O: pick(dO, 'ownActivityMetrics', OWN), cashRowsT: rowsT, cashRowsO: rowsO, cashRowsC: rowsC, s7: pos,
        oracleCommittedParts: expT.parts['CUSTODY_COMMITTED_WITH_COMPENSATION'], deliveries: (await x.db.collection('cash_deliveries').find({ organizationId: x.org }).sort({ createdAt: 1 }).toArray()).map(d => ({ kind: d['kind'], state: d['state'], amount: String(d['amount']), source: acct(d['sourceAccountId']) })),
        ...(purity ? { purity: { changed: x.diff(g0!.collections, g1!.collections), collections: Object.keys(g0!.collections).length, projection: [g0!.projection, g1!.projection], reads: 6 } } : {}) };
      expect(label + ' S7 CASH_C', ph.s7.CASH_C.server, ph.s7.CASH_C.oracle); expect(label + ' S7 CENTRAL', ph.s7.CENTRAL.server, ph.s7.CENTRAL.oracle);
      o[label] = ph; return { ...ph, dT };
    };
    const num = (v: unknown) => cents(v);
    // ---- F0 base: cobro 300k confirmado en custodia de C (sin entregas)
    const f0 = await phase('F0 base cobro 300k');
    // ---- F1 FORWARD 250k solicitada (activa)
    const r = await x.request('250000.00'); assert.equal(r.status, 201, x.st(r as never)); const fwd = r.id!; book.request(fwd, 'CASH_C', 'CENTRAL', [{ lot: f.paymentId, amount: c('250000.00') }]);
    const f1 = await phase('F1 FORWARD 250k REQUESTED');
    // ---- F2 FORWARD despachada/recibida/contada exacta (sigue activa)
    o['F2 comandos'] = [x.st(await x.act('dispatchCashDelivery', fwd, C) as never), x.st(await x.act('receiveCashDelivery', fwd, O) as never), x.st(await x.count(fwd, '250000.00') as never)];
    book.dispatch(fwd); book.receive(fwd); book.count(fwd, c('250000.00'));
    const f2 = await phase('F2 FORWARD 250k COUNTED');
    // ---- F3 FORWARD confirmada
    o['F3 confirmar FORWARD'] = x.st(await x.confirm(fwd) as never); book.confirmDelivery(fwd);
    const f3 = await phase('F3 FORWARD confirmada');
    // ---- F4 COMPENSATION 250k activa (caso obligatorio). Purity line covers only reporting GETs.
    const comp = await x.compensate(fwd); o['F4 solicitar compensación'] = x.st(comp as never); assert.equal(comp.status, 201); const cid = comp.id!; book.compensate(cid, fwd);
    const j4 = await x.journals(), f4 = await phase('F4 COMPENSATION 250k activa', true);
    // Projection 0.1 (T, día actual): same engine via materialize; own guard/ownership callback kept as in P05 (not relaxed).
    const rt = await x.w.settle(async () => ({ status: 200, data: await x.activate() as never }));
    if (rt.status === 200) {
      const pT = await dash(T), pRows = await cash(T, pT), proj = (await x.digestAll()).projection;
      o['F4 proyección T'] = { status: x.st(pT as never), T: pick(pT, 'organizationMetrics'), cashRowsT: pRows, projectionDocs: proj, equalToDirect: JSON.stringify(pick(pT, 'organizationMetrics', ALL)) === JSON.stringify(pick(f4.dT, 'organizationMetrics', ALL)) && JSON.stringify(pRows) === JSON.stringify(f4.cashRowsT) };
      await x.deactivate(rt.data as never);
    } else o['F4 proyección T'] = { activation: x.st(rt) };
    // ---- F5 COMPENSATION despachada por O, recibida/contada por C, confirmada (comprobación focal)
    o['F5 comandos'] = [x.st(await x.act('dispatchCashDelivery', cid, O) as never), x.st(await x.act('receiveCashDelivery', cid, C) as never), x.st(await x.count(cid, '250000.00', C) as never)];
    book.dispatch(cid); book.receive(cid); book.count(cid, c('250000.00'));
    o['F5 confirmar compensación'] = x.st(await x.confirm(cid, true) as never); book.confirmDelivery(cid);
    const f5 = await phase('F5 COMPENSATION confirmada'); o['F5 asientos añadidos desde F4'] = await x.journals() - j4;
    // ---- expectations from commanded amounts (independent of backend and of the oracle module)
    const E = (ph: { T: Row }, want: Row) => Object.fromEntries(Object.keys(want).map(k => [k, ph.T[k]]));
    expect('F0 T', E(f0, { CUSTODY_CONFIRMED: 0, CUSTODY_COMMITTED: 0, LIQUIDITY_RESERVED: 0 }), { CUSTODY_CONFIRMED: '300000.00', CUSTODY_COMMITTED: '0.00', LIQUIDITY_RESERVED: '300000.00' });
    for (const [l, ph] of [['F1', f1], ['F2', f2]] as const) {
      expect(l + ' T', E(ph, { CUSTODY_CONFIRMED: 0, CUSTODY_COMMITTED: 0, LIQUIDITY_RESERVED: 0 }), { CUSTODY_CONFIRMED: '300000.00', CUSTODY_COMMITTED: '250000.00', LIQUIDITY_RESERVED: '300000.00' });
      expect(l + ' C CUSTODY_COMMITTED', ph.C['CUSTODY_COMMITTED'], '250000.00'); expect(l + ' O CUSTODY_COMMITTED (receptor)', ph.O['CUSTODY_COMMITTED'], '250000.00');
      expect(l + ' CASH_C committed', (ph.cashRowsT as Record<string, Row>)['CASH_C']?.['committed'], '250000.00'); expect(l + ' CENTRAL committed', (ph.cashRowsT as Record<string, Row>)['CENTRAL']?.['committed'], '0.00');
      expect(l + ' S7 CASH_C committed', ph.s7.CASH_C.server?.committed, '250000.00');
    }
    expect('F3 T', E(f3, { CUSTODY_CONFIRMED: 0, CUSTODY_COMMITTED: 0, LIQUIDITY_RESERVED: 0, DELIVERED_NET: 0 }), { CUSTODY_CONFIRMED: '50000.00', CUSTODY_COMMITTED: '0.00', LIQUIDITY_RESERVED: '50000.00', DELIVERED_NET: '250000.00' });
    expect('F3 C/O CUSTODY_COMMITTED', [f3.C['CUSTODY_COMMITTED'], f3.O['CUSTODY_COMMITTED']], ['0.00', '0.00']);
    const rows4 = f4.cashRowsT as Record<string, Row>;
    expect('F4 T', E(f4, { CUSTODY_CONFIRMED: 0, CUSTODY_COMMITTED: 0, LIQUIDITY_RESERVED: 0, DELIVERED_NET: 0 }), { CUSTODY_CONFIRMED: '50000.00', CUSTODY_COMMITTED: '0.00', LIQUIDITY_RESERVED: '300000.00', DELIVERED_NET: '250000.00' });
    expect('F4 C/O CUSTODY_COMMITTED', [f4.C['CUSTODY_COMMITTED'], f4.O['CUSTODY_COMMITTED']], ['0.00', '0.00']);
    expect('F4 CENTRAL fila T', { committed: rows4['CENTRAL']?.['committed'], reserved: rows4['CENTRAL']?.['reserved'] }, { committed: '0.00', reserved: '250000.00' });
    expect('F4 CASH_C fila T', { committed: rows4['CASH_C']?.['committed'], reserved: rows4['CASH_C']?.['reserved'], confirmed: rows4['CASH_C']?.['confirmed'] }, { committed: '0.00', reserved: '50000.00', confirmed: '50000.00' });
    expect('F4 CENTRAL fila O committed', (f4.cashRowsO as Record<string, Row>)['CENTRAL']?.['committed'], '0.00');
    expect('F4 suma reservas filas = LIQUIDITY_RESERVED (sin duplicar)', money(num(rows4['CENTRAL']?.['reserved']) + num(rows4['CASH_C']?.['reserved'])), f4.T['LIQUIDITY_RESERVED']);
    for (const a of ['CENTRAL', 'CASH_C']) expect(`F4 ${a} available = book − reserved`, rows4[a]?.['available'], money(num(rows4[a]?.['bookBalance']) - num(rows4[a]?.['reserved'])));
    expect('F4 S7 CENTRAL', { committed: f4.s7.CENTRAL.server?.committed, compensationReserve: f4.s7.CENTRAL.server?.compensationReserve }, { committed: '0.00', compensationReserve: '250000.00' });
    expect('F4 LIQUIDITY_BOOK sin cambio desde F3', f4.T['LIQUIDITY_BOOK'], f3.T['LIQUIDITY_BOOK']);
    expect('F4 LIQUIDITY_AVAILABLE = F3 − 250k', f4.T['LIQUIDITY_AVAILABLE'], money(num(f3.T['LIQUIDITY_AVAILABLE']) - 25000000n));
    expect('F4 LIQUIDITY_AVAILABLE = BOOK − RESERVED', f4.T['LIQUIDITY_AVAILABLE'], money(num(f4.T['LIQUIDITY_BOOK']) - num(f4.T['LIQUIDITY_RESERVED'])));
    expect('F4 oráculo separa compensación', f4.oracleCommittedParts, { forward: '0.00', compensation: '250000.00' });
    expect('F4 pureza GET reporting', (f4.purity as { changed: string[] }).changed, []);
    const pj = o['F4 proyección T'] as { equalToDirect?: boolean }; expect('F4 proyección = directa', pj.equalToDirect, true);
    expect('F5 T', E(f5, { CUSTODY_CONFIRMED: 0, CUSTODY_COMMITTED: 0, LIQUIDITY_RESERVED: 0, DELIVERED_NET: 0 }), { CUSTODY_CONFIRMED: '300000.00', CUSTODY_COMMITTED: '0.00', LIQUIDITY_RESERVED: '300000.00', DELIVERED_NET: '0.00' });
    expect('F5 recaudo/interés sin cambio desde F0', [f5.T['RECEIPTS_CONFIRMED'], f5.T['INTEREST_RECEIVED']], [f0.T['RECEIPTS_CONFIRMED'], f0.T['INTEREST_RECEIVED']]);
    expect('F5 recaudo/interés (comandado 300k; 60k interés vencido primero)', [f5.T['RECEIPTS_CONFIRMED'], f5.T['INTEREST_RECEIVED']], ['300000.00', '60000.00']);
    expect('F5 S7 CENTRAL compensationReserve', f5.s7.CENTRAL.server?.compensationReserve, '0.00');
    expect('F5 LIQUIDITY_BOOK = F0', f5.T['LIQUIDITY_BOOK'], f0.T['LIQUIDITY_BOOK']);
    expect('F5 asientos añadidos (solo el de la compensación)', o['F5 asientos añadidos desde F4'], 1);
    o['discrepancias con oráculo'] = bad; o['fallos frente a lo comandado'] = fail;
    evidence('R01', { observed: o });
    assert.deepEqual(bad, [], 'oracle mismatches'); assert.deepEqual(fail, [], 'commanded-amount mismatches');
    console.log('R01_FOCAL_PASS');
  } catch (e) { evidence('R01-PARCIAL', { observed: o, mismatches: bad, failures: fail }); throw e; } finally { await group.dispose(); }
});
