/* eslint-disable security/detect-object-injection -- Own fixed indicator ids/labels of this review, never request input. */
// S08-P05 independent runtime review (Claude) of S08-P04-v1-INTEGRADO on ONE own group. One synthetic timeline (Bogotá):
// D0 2026-10-31 cobro C 300k (60k I + 240k P), 2M EXTRA_PRINCIPAL sin utilidad, devengo 60k, entrega 250/50, préstamo al día;
// D1 2026-11-02 23:30 cobro de interés ya devengado (registro 04:30Z del día siguiente); D2 11-30 (DPD30); D3 12-01 (DPD31) +
// reverso con compensación posterior. Every reporting figure is compared with the own raw-data oracle (indicators.ts) and with
// the amounts commanded here; nothing is taken from the backend as expected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { s08ReviewProfile } from './review-profile.js';
import { world8, evidence, metricsOf, values, type World8, type Reply, type Group } from './review-fixtures.js';
import { oracle, money, type Cut, type Scope } from './indicators.js';
import { ApiClient } from '../../helpers/client.js';

const only = (name: string) => !process.env['P05_ONLY'] || process.env['P05_ONLY']!.split(',').some(x => name.startsWith(x));
const ALL = ['PRINCIPAL_DISBURSED', 'PRINCIPAL_OUTSTANDING', 'PRINCIPAL_LEDGER', 'PRINCIPAL_DUE_TODAY_OR_EARLIER', 'PRINCIPAL_OVERDUE', 'INTEREST_OVERDUE', 'PRINCIPAL_EXPOSED_OVERDUE', 'PAR30', 'INTEREST_EXPECTED_FUTURE', 'INTEREST_DUE_UNACCRUED', 'INTEREST_ACCRUED', 'INTEREST_RECEIVABLE', 'INTEREST_RECEIVED', 'INTEREST_SATISFIED_BY_CREDIT', 'PRINCIPAL_RECOVERED', 'RECEIPTS_CONFIRMED', 'RECEIPTS_REGISTERED', 'BORROWER_CREDIT', 'HELD_FUNDS', 'LIQUIDITY_BOOK', 'LIQUIDITY_RESERVED', 'LIQUIDITY_AVAILABLE', 'CUSTODY_PROVISIONAL', 'CUSTODY_CONFIRMED', 'CUSTODY_COMMITTED', 'DELIVERED_NET', 'INSTALLMENT_FULFILMENT', 'RETURN_ON_AVERAGE_CAPITAL', 'OBLIGATIONS_COVERAGE', 'INTEGRAL_NET_WORTH'];
const ASSIGNED = ['PRINCIPAL_OUTSTANDING', 'PRINCIPAL_DUE_TODAY_OR_EARLIER', 'PRINCIPAL_OVERDUE', 'INTEREST_OVERDUE', 'PRINCIPAL_EXPOSED_OVERDUE', 'PAR30', 'INTEREST_EXPECTED_FUTURE', 'INTEREST_DUE_UNACCRUED', 'INSTALLMENT_FULFILMENT'];
const OWN = ['RECEIPTS_REGISTERED', 'RECEIPTS_CONFIRMED', 'PRINCIPAL_RECOVERED', 'INTEREST_RECEIVED', 'CUSTODY_PROVISIONAL', 'CUSTODY_CONFIRMED', 'CUSTODY_COMMITTED', 'DELIVERED_NET', 'HELD_FUNDS'];
type Mismatch = { at: string; id: string; server: unknown; oracle: unknown };

/** Compares a dashboard list with the own oracle for the given ids; returns mismatches (value and status/null discipline). */
function compare(at: string, r: Reply, exp: ReturnType<typeof oracle>, ids: string[], list: string, out: Mismatch[]) {
  const got = metricsOf(r, list);
  for (const id of ids) {
    const m = got[id] as { value: string | null; status: string } | undefined;
    if (!m) { out.push({ at, id, server: 'ABSENT', oracle: exp.metrics[id] }); continue; }
    if (m.value !== exp.metrics[id]) out.push({ at, id, server: m.value + ' ' + m.status, oracle: exp.metrics[id] });
    if (exp.status[id] && m.status !== exp.status[id]) out.push({ at, id: id + '.status', server: m.status, oracle: exp.status[id] });
  }
  return got;
}
async function walk(x: World8, actor: World8['f']['a'], kind: string, token: string, extra: Record<string, unknown> = {}, limit = 1) {
  const items: Record<string, unknown>[] = [], totals: unknown[] = []; let cursor: string | undefined, pages = 0;
  do { const r = await x.rep(actor, 'listReportingRows', kind, { snapshotToken: token, limit: String(limit), ...extra, ...(cursor ? { cursor } : {}) }); if (r.status !== 200) return { error: x.st(r as never), items, pages }; pages++;
    items.push(...(r.data!['items'] as Record<string, unknown>[])); totals.push(r.data!['totalRows']); cursor = (r.data!['nextCursor'] as string | null) ?? undefined; } while (cursor && pages < 200);
  return { items, pages, totals: [...new Set(totals)] };
}

test('P08 runtime review on one own group', { timeout: 5400000 }, async t => {
  const group: Group = await s08ReviewProfile();
  try {
    await t.test('E1 economía/corte/cobertura/roles/pureza == oráculo propio (AT01–AT08, AT10 parcial)', { skip: !only('E1') }, async st => {
      const o: Record<string, unknown> = {}, bad: Mismatch[] = []; st.after(() => evidence('P08-E1', { observed: o, mismatches: bad }));
      const x = await world8(group), f = x.f, T = f.a, C = f.c, O = f.o, cId = C.issued.context.subjectId!, oId = O.issued.context.subjectId!;
      const P = await x.member(['P']), C2 = await x.member(['C']), CO = await x.member(['C', 'O']);
      const dash = async (actor: typeof T, cut: Partial<Cut>, extra: Record<string, unknown> = {}) => await x.rep(actor, 'getReportingDashboard', undefined, { ...cut, ...extra });
      const check = async (label: string, cut: Cut, roles: [string, typeof T, Scope][] = [['T', T, { kind: 'T', actor: T.issued.context.subjectId! }], ['C', C, { kind: 'C', actor: cId }], ['O', O, { kind: 'O', actor: oId }]]) => {
        const data = await x.dump(), res: Record<string, unknown> = {};
        for (const [name, actor, scope] of roles) {
          // K omitted (as the UI does): the server fixes K once; the oracle replays the raw dataset at that same K.
          const r = await dash(actor, { asOf: cut.asOf, from: cut.from, to: cut.to }); if (r.status !== 200) { bad.push({ at: label, id: name + ' dashboard', server: x.st(r as never), oracle: 200 }); continue; }
          const K = String((r.data!['meta'] as Record<string, unknown>)['recordedThrough']), exp = oracle(data, { ...cut, recordedThrough: K }, scope, cut.asOf === x.today());
          if (name === 'T') compare(label + ' T', r, exp, ALL, 'organizationMetrics', bad);
          else if (name === 'C') { compare(label + ' C assigned', r, exp, ASSIGNED, 'assignedMetrics', bad); compare(label + ' C own', r, exp, OWN, 'ownActivityMetrics', bad); }
          else compare(label + ' ' + name + ' own', r, exp, name === 'P' ? ['RECEIPTS_REGISTERED'] : OWN, 'ownActivityMetrics', bad);
          res[name] = { server: values(r, name === 'T' ? 'organizationMetrics' : name === 'C' ? 'assignedMetrics' : 'ownActivityMetrics'), ...(name === 'C' ? { own: values(r, 'ownActivityMetrics') } : {}), scopeKind: (r.data!['meta'] as Record<string, unknown>)['scopeKind'], coverage: ((r.data!['meta'] as Record<string, unknown>)['coverage'] as Record<string, unknown>)['status'], parts: exp.parts };
        }
        o[label] = { cut: { asOf: cut.asOf, from: cut.from, to: cut.to }, ...res }; return { data };
      };
      // ---- D0 2026-10-31 (fixture): L assigned to C, cobro C 300k CASH approved by T, then own operations.
      const L = f.l, L2 = await x.newLoan(), L3 = await x.newLoan(), L4 = await x.newLoan();
      const r2m = await x.bankReceipt(L2, '2000000.00', 'EXTRA_PRINCIPAL'); o['D0 2M EXTRA_PRINCIPAL on L2'] = x.st(r2m as never);
      const r4 = await x.bankReceipt(L4, '560000.00'); o['D0 L4 cuota 1 completa 560k'] = x.st(r4 as never);
      o['D0 accrue L3 through 10-31'] = x.st(await x.accrue(L3.id, '2026-10-31') as never);
      const dq = await x.request('250000.00'); const did = dq.id!; await x.act('dispatchCashDelivery', did, C); await x.act('receiveCashDelivery', did, O); await x.count(did, '250000.00'); const cf = await x.confirm(did); o['D0 entrega 250k confirmada'] = x.st(cf as never);
      const D0: Cut = { asOf: '2026-10-31', from: '2026-10-01', to: '2026-10-31', recordedThrough: new Date(f.now()).toISOString() };
      await check('D0', D0, [['T', T, { kind: 'T', actor: T.issued.context.subjectId! }], ['C', C, { kind: 'C', actor: cId }], ['O', O, { kind: 'O', actor: oId }], ['C2', C2, { kind: 'C', actor: C2.issued.context.subjectId! }]]);
      // Anchors from commanded amounts (independent of both oracle and backend).
      const d0 = values(await dash(T, { asOf: D0.asOf, from: D0.from, to: D0.to }));
      { const ex = await dash(T, D0); o['D0 K explícito = reloj (asientos sellados max(now,último+1ms))'] = { K: D0.recordedThrough, status: x.st(ex as never), journalsAfterK: (await x.db.collection('financial_journals').find({ organizationId: x.org, recordedAt: { $gt: D0.recordedThrough } }).toArray()).length, eventsAfterK: await x.db.collection('loan_events').countDocuments({ organizationId: x.org, recordedAt: { $gt: D0.recordedThrough } }) }; }
      o['D0 anchors'] = { PRINCIPAL_DISBURSED: d0['PRINCIPAL_DISBURSED'], RECEIPTS_CONFIRMED: d0['RECEIPTS_CONFIRMED'], PRINCIPAL_RECOVERED: d0['PRINCIPAL_RECOVERED'], INTEREST_RECEIVED: d0['INTEREST_RECEIVED'], DELIVERED_NET: d0['DELIVERED_NET'], CUSTODY_CONFIRMED: d0['CUSTODY_CONFIRMED'], PRINCIPAL_OUTSTANDING: d0['PRINCIPAL_OUTSTANDING'] };
      // 4×2M disbursed; receipts 300k (60k I + 240k P), 2M on L2 (S5 rule: due interest 60k first, 1.94M principal), 560k (60k I + 500k P).
      const anchors0 = { PRINCIPAL_DISBURSED: '8000000.00', RECEIPTS_CONFIRMED: '2860000.00', PRINCIPAL_RECOVERED: '2680000.00', INTEREST_RECEIVED: '180000.00', DELIVERED_NET: '250000.00', CUSTODY_CONFIRMED: '50000.00', PRINCIPAL_OUTSTANDING: '5320000.00' };
      const c2 = await dash(C2, { asOf: D0.asOf, from: D0.from, to: D0.to }); o['D0 C2 sin asignación PAR30'] = metricsOf(c2, 'assignedMetrics')['PAR30'];
      // ---- D1 2026-11-02 23:30 Bogotá (04:30Z next UTC day): T cobra 60k de interés ya devengado en L3.
      await x.at('2026-11-02T23:30:00.000-05:00');
      const r3 = await x.bankReceipt(L3, '60000.00'); const recAt = String((await x.db.collection('payments').findOne({ _id: r3.paymentId as never }))?.['recordedAt']); o['D1 cobro interés devengado L3'] = { status: x.st(r3 as never), recordedAt: recAt };
      const D1: Cut = { asOf: '2026-11-02', from: '2026-11-02', to: '2026-11-02', recordedThrough: new Date(f.now()).toISOString() };
      await check('D1', D1);
      // Explicit K (dual cut, LATE-like): before the registration, at the loan event instant, at the journal instant (finance stamps max(now,last+1ms)).
      const ev3 = await x.db.collection('loan_events').findOne({ _id: r3.eventId as never }), jr3 = await x.db.collection('financial_journals').findOne({ _id: ev3?.['journalId'] as never });
      const kq = async (K: string) => { const r = await dash(T, { ...D1, recordedThrough: K }); return r.status === 200 ? { RECEIPTS_CONFIRMED: values(r)['RECEIPTS_CONFIRMED'], PRINCIPAL_OUTSTANDING: values(r)['PRINCIPAL_OUTSTANDING'], CUSTODY_CONFIRMED: metricsOf(r)['CUSTODY_CONFIRMED'] } : x.st(r as never); };
      const kb = new Date(Date.parse(String(ev3?.['recordedAt'])) - 1).toISOString();
      o['D1 K explícito'] = { eventRecordedAt: ev3?.['recordedAt'], journalRecordedAt: jr3?.['recordedAt'], paymentRecordedAt: recAt, clock: new Date(f.now()).toISOString(), 'K=evento-1ms': await kq(kb), 'K=evento': await kq(String(ev3?.['recordedAt'])), 'K=asiento': await kq(String(jr3?.['recordedAt'])), 'K=reloj': await kq(new Date(f.now()).toISOString()),
        oracle: { 'K=evento-1ms': oracle(await x.dump(), { ...D1, recordedThrough: kb }, { kind: 'T', actor: '' }).metrics['RECEIPTS_CONFIRMED'], 'K=asiento': oracle(await x.dump(), { ...D1, recordedThrough: String(jr3?.['recordedAt']) }, { kind: 'T', actor: '' }).metrics['RECEIPTS_CONFIRMED'] } };
      o['D1 Bogotá: registro UTC día siguiente'] = { utcDate: recAt.slice(0, 10), periodNov03: values(await dash(T, { asOf: '2026-11-02', from: '2026-11-02', to: '2026-11-02' }))['RECEIPTS_REGISTERED'] };
      // ---- D2 2026-11-30 (DPD 30) and D3 2026-12-01 (DPD 31); historical cuts replayed from D3.
      await x.at('2026-11-30T12:00:00.000-05:00');
      const D2: Cut = { asOf: '2026-11-30', from: '2026-11-01', to: '2026-11-30', recordedThrough: new Date(f.now()).toISOString() }; await check('D2', D2);
      await x.at('2026-12-01T12:00:00.000-05:00');
      const D3: Cut = { asOf: '2026-12-01', from: '2026-11-01', to: '2026-12-01', recordedThrough: new Date(f.now()).toISOString() }; await check('D3 antes del reverso', D3);
      // Reverse the L3 interest receipt today: compensation effective 12-01 (after the 11-30 cut).
      const rv = await x.reverse(r3.eventId!, r3.paymentId!); o['D3 reverso cobro L3'] = x.st(rv as never);
      const D3b: Cut = { ...D3, recordedThrough: new Date(f.now()).toISOString() }; await check('D3 después del reverso', D3b, [['T', T, { kind: 'T', actor: T.issued.context.subjectId! }], ['C', C, { kind: 'C', actor: cId }], ['O', O, { kind: 'O', actor: oId }], ['P', P, { kind: 'P', actor: P.issued.context.subjectId! }], ['CO', CO, { kind: 'C', actor: CO.issued.context.subjectId! }]]);
      await check('HIST asOf 11-30 desde D3 (compensación posterior excluida)', { asOf: '2026-11-30', from: '2026-11-01', to: '2026-11-30', recordedThrough: D3b.recordedThrough });
      await check('HIST asOf 11-02 desde D3', { asOf: '2026-11-02', from: '2026-11-02', to: '2026-11-02', recordedThrough: D3b.recordedThrough });
      await check('HIST asOf 10-31 desde D3', { ...D0, recordedThrough: D3b.recordedThrough });
      const missing = await dash(T, { asOf: '2026-10-30', from: '2026-10-01', to: '2026-10-30' }); o['MISSING asOf antes de historia'] = { status: x.st(missing as never), meta: (missing.data?.['meta'] as Record<string, unknown>)?.['coverage'], sample: metricsOf(missing)['PRINCIPAL_OUTSTANDING'], zeros: Object.entries(values(missing)).filter(([, v]) => v === '0.00').map(([k]) => k) };
      // ---- per-loan contrast: PORTFOLIO walk (cursor limit 1) vs oracle stocks vs domain position; detail; INSTALLMENTS.
      const tok = (await dash(T, { asOf: D3b.asOf, from: '2026-10-01', to: D3b.asOf })).data!['meta'] as Record<string, unknown>, token = String(tok['snapshotToken']);
      const exp3 = oracle(await x.dump(), { asOf: D3b.asOf, from: '2026-10-01', to: D3b.asOf, recordedThrough: String(tok['recordedThrough']) }, { kind: 'T', actor: '' });
      const pf = await walk(x, T, 'PORTFOLIO', token); const per: Record<string, unknown> = {};
      for (const row of pf.items) { const s = exp3.stocks.get(String(row['loanId'])); if (!s) continue; const pos = (await f.position(s.loanId)).data as Record<string, unknown>;
        const server = { principal: row['principal'], duePrincipal: row['duePrincipal'], overduePrincipal: row['overduePrincipal'], overdueInterest: row['overdueInterest'], exposedPrincipal: row['exposedPrincipal'], dpd: row['dpd'], state: row['state'] };
        const own = { principal: money(s.principal), duePrincipal: money(s.due), overduePrincipal: money(s.overdue), overdueInterest: money(s.interestOverdue), exposedPrincipal: money(s.exposed), dpd: s.dpd, state: s.settled ? 'SETTLED' : 'ACTIVE' };
        if (JSON.stringify(server) !== JSON.stringify(own)) bad.push({ at: 'PORTFOLIO', id: s.loanId, server, oracle: own });
        const det = await x.rep(T, 'getReportingLoan', s.loanId, { snapshotToken: token }), di = Object.fromEntries(((det.data?.['indicators'] ?? []) as Record<string, unknown>[]).map(m => [m['id'], m['value']]));
        const ownDet = { PRINCIPAL_OUTSTANDING: money(s.principal), PRINCIPAL_OVERDUE: money(s.overdue), INTEREST_OVERDUE: money(s.interestOverdue), INTEREST_EXPECTED_FUTURE: money(s.futureInterest), PAR30: s.principal === 0n ? null : s.par30 ? '100.00' : '0.00' };
        for (const [k, v] of Object.entries(ownDet)) if (di[k] !== v) bad.push({ at: 'DETAIL', id: s.loanId + ':' + k, server: di[k], oracle: v });
        per[s.loanId === L.id ? 'L' : s.loanId === L2.id ? 'L2' : s.loanId === L3.id ? 'L3' : 'L4'] = { server, oracle: own, domainPrincipalOutstanding: pos['principalOutstanding'], next: s.next, detail: di };
        if (pos['principalOutstanding'] !== money(s.principal)) bad.push({ at: 'DOMAIN', id: s.loanId, server: pos['principalOutstanding'], oracle: money(s.principal) });
      }
      o['PORTFOLIO walk limit1'] = { pages: pf.pages, totals: pf.totals, loans: per };
      const ins = await walk(x, T, 'INSTALLMENTS', token, {}, 3), insBad: unknown[] = [];
      for (const row of ins.items) { const s = exp3.stocks.get(String(row['loanId']))!, i = s.installments.find(z => z.id === row['id']); if (!i || i.principalPaid !== row['principalPaid'] || i.interestPaid !== row['interestPaid'] || i.state !== row['state'] || i.dpd !== row['dpd']) insBad.push({ server: row, oracle: i }); }
      o['INSTALLMENTS walk limit3'] = { rows: ins.items.length, pages: ins.pages, totals: ins.totals, mismatches: insBad }; for (const m of insBad) bad.push({ at: 'INSTALLMENTS', id: 'row', server: m, oracle: null });
      // MOVEMENTS: same snapshot; DISBURSE/RECEIPT/ACCRUE components non-zero (H-S8-P04-04) and delivery is never a receipt.
      const mv = await walk(x, T, 'MOVEMENTS', token, {}, 100);
      o['MOVEMENTS'] = { rows: mv.items.length, byNature: mv.items.reduce((acc: Record<string, string[]>, r) => { const k = String(r['nature']); (acc[k] ??= []).push(`${r['amount']}/P${r['principal']}/I${r['interest']}/s${r['sign']}`); return acc; }, {}) };
      const cash = await walk(x, T, 'CASH', token, {}, 100); o['CASH T'] = cash.items.map(r => ({ accountKind: r['accountKind'], physicalStatus: r['physicalStatus'], responsible: r['responsibleId'] === cId ? 'C' : r['responsibleId'] === oId ? 'O' : r['responsibleId'], book: r['bookBalance'], reserved: r['reserved'], available: r['available'], confirmed: r['confirmed'], committed: r['committed'], held: r['held'], physical: r['physical'] }));
      // ---- roles / tenant / filters / tokens (AT07/AT08)
      const n: Record<string, unknown> = {}; o['negatives'] = n;
      const cTok = String(((await dash(C, { asOf: D3b.asOf, from: '2026-11-01', to: D3b.asOf })).data!['meta'] as Record<string, unknown>)['snapshotToken']);
      n['C PORTFOLIO'] = (await walk(x, C, 'PORTFOLIO', cTok, {}, 100)).items.map(r => r['loanId'] === L.id ? 'L' : 'OTHER:' + String(r['loanId']));
      n['C detail L2'] = x.st(await x.rep(C, 'getReportingLoan', L2.id, { snapshotToken: cTok }) as never);
      n['C MOVEMENTS loans'] = [...new Set((await walk(x, C, 'MOVEMENTS', cTok, {}, 100)).items.map(r => r['loanId'] === undefined ? 'omitted' : r['loanId'] === L.id ? 'L' : 'OTHER'))];
      n['C RECONCILIATION'] = x.st(await x.rep(C, 'listReportingRows', 'RECONCILIATION', { snapshotToken: cTok }) as never);
      n['C CASH filas'] = (await walk(x, C, 'CASH', cTok, {}, 100)).items.map(r => ({ resp: r['responsibleId'] === cId ? 'C' : 'OTHER', hasBook: 'bookBalance' in r }));
      n['C responsibleId=O'] = x.st(await x.rep(C, 'listReportingRows', 'CASH', { snapshotToken: cTok, responsibleId: oId }) as never);
      n['C cursor de T'] = x.st(await x.rep(C, 'listReportingRows', 'PORTFOLIO', { snapshotToken: token, limit: '1' }) as never);
      const oTok = String(((await dash(O, { asOf: D3b.asOf, from: '2026-11-01', to: D3b.asOf })).data!['meta'] as Record<string, unknown>)['snapshotToken']);
      for (const k of ['PORTFOLIO', 'INSTALLMENTS', 'CONCENTRATION', 'RECONCILIATION']) n['O ' + k] = x.st(await x.rep(O, 'listReportingRows', k, { snapshotToken: oTok }) as never);
      n['O detail L'] = x.st(await x.rep(O, 'getReportingLoan', L.id, { snapshotToken: oTok }) as never);
      n['O dashboard keys'] = Object.keys((await dash(O, { asOf: D3b.asOf, from: '2026-11-01', to: D3b.asOf })).data ?? {});
      const pTok = String(((await dash(P, { asOf: D3b.asOf, from: '2026-11-01', to: D3b.asOf })).data!['meta'] as Record<string, unknown>)['snapshotToken']);
      for (const k of ['PORTFOLIO', 'CASH', 'COLLECTORS']) n['P ' + k] = x.st(await x.rep(P, 'listReportingRows', k, { snapshotToken: pTok }) as never);
      n['P policy ids'] = (await x.rep(P, 'getReportingPolicy')).data?.['indicatorIds'];
      n['C policy ids'] = (await x.rep(C, 'getReportingPolicy')).data?.['indicatorIds']; n['O policy reports'] = (await x.rep(O, 'getReportingPolicy')).data?.['reportKinds'];
      { const r = await dash(CO, { asOf: D3b.asOf, from: '2026-11-01', to: D3b.asOf }); n['CO (C+O) scopeKind/lists'] = { scope: (r.data?.['meta'] as Record<string, unknown>)?.['scopeKind'], keys: Object.keys(r.data ?? {}), organizationMetrics: 'organizationMetrics' in (r.data ?? {}) }; }
      for (const role of ['A', 'SA', 'L', 'B']) { const a = await x.w.settle(async () => ({ status: 200, data: await x.member([role]) as never })); if (a.status !== 200) { n[role + ' invitación'] = x.st(a); continue; } const actor = a.data as unknown as typeof T; n[role + ' dashboard'] = x.st(await dash(actor, { asOf: D3b.asOf, from: '2026-11-01', to: D3b.asOf }) as never); n[role + ' policy'] = x.st(await x.rep(actor, 'getReportingPolicy') as never); }
      // Foreign organization T2 (own second tenant) and random ids.
      const T2 = await f.newActor(), org2 = (await f.tenant(T2 as never)).org;
      n['T2 dashboard org1'] = x.st(await x.rep(T2 as never, 'getReportingDashboard', undefined, { asOf: D3b.asOf, from: '2026-11-01', to: D3b.asOf }) as never);
      n['T dashboard org2'] = x.st(await x.rep(T, 'getReportingDashboard', undefined, { asOf: D3b.asOf, from: '2026-11-01', to: D3b.asOf }, org2) as never);
      n['T2 own org empty PAR30'] = metricsOf(await x.rep(T2 as never, 'getReportingDashboard', undefined, { asOf: D3b.asOf, from: '2026-11-01', to: D3b.asOf }, org2))['PAR30'];
      // Membership/organization writes above legitimately renew the source vector (observed 409 on older seals): take a fresh seal for the filter negatives.
      n['sello anterior tras invitaciones'] = x.st(await x.rep(T, 'listReportingRows', 'PORTFOLIO', { snapshotToken: token }) as never);
      const ntok = String(((await dash(T, { asOf: D3b.asOf, from: '2026-10-01', to: D3b.asOf })).data!['meta'] as Record<string, unknown>)['snapshotToken']);
      n['T sello en org2'] = x.st(await x.rep(T2 as never, 'listReportingRows', 'PORTFOLIO', { snapshotToken: ntok }, org2) as never);
      n['T loan id ajeno'] = x.st(await x.rep(T, 'getReportingLoan', randomUUID(), { snapshotToken: ntok }) as never);
      n['T responsibleId de otra org'] = x.st(await x.rep(T, 'listReportingRows', 'CASH', { snapshotToken: ntok, responsibleId: T2.issued.context.subjectId! }) as never);
      const bads: [string, Record<string, unknown>][] = [['limit 0', { limit: '0' }], ['limit 101', { limit: '101' }], ['limit abc', { limit: 'abc' }], ['sort libre', { sort: 'principal' }], ['q', { q: 'x' }], ['state inválido', { state: 'OVERDUE' }], ['ageBand inválido', { ageBand: 'D30' }], ['filtro de otro reporte', { accountId: f.cash.id }], ['loanId no uuid', { loanId: 'abc' }], ['cursor manipulado', { cursor: 'AAAA' + randomUUID().replaceAll('-', '') }]];
      for (const [k, q] of bads) n['PORTFOLIO ' + k] = x.st(await x.rep(T, 'listReportingRows', 'PORTFOLIO', { snapshotToken: ntok, ...q }) as never);
      n['sello manipulado'] = x.st(await x.rep(T, 'listReportingRows', 'PORTFOLIO', { snapshotToken: ntok.slice(0, -2) + (token.endsWith('A') ? 'B' : 'A') + token.slice(-1) }) as never);
      n['reporte sin sello'] = x.st(await x.rep(T, 'listReportingRows', 'PORTFOLIO', {}) as never);
      n['tipo inexistente'] = x.st(await x.rep(T, 'listReportingRows', 'LEDGER', { snapshotToken: ntok }) as never);
      const p1 = await x.rep(T, 'listReportingRows', 'PORTFOLIO', { snapshotToken: ntok, limit: '1' }), cur = String(p1.data?.['nextCursor']);
      n['cursor con otro filtro'] = x.st(await x.rep(T, 'listReportingRows', 'PORTFOLIO', { snapshotToken: ntok, limit: '1', cursor: cur, state: 'ACTIVE' }) as never);
      n['cursor con otro limit'] = x.st(await x.rep(T, 'listReportingRows', 'PORTFOLIO', { snapshotToken: ntok, limit: '2', cursor: cur }) as never);
      n['cursor en otra ruta'] = x.st(await x.rep(T, 'listReportingRows', 'INSTALLMENTS', { snapshotToken: ntok, limit: '1', cursor: cur }) as never);
      n['dashboard sello + corte distinto'] = x.st(await dash(T, { asOf: '2026-11-30', from: '2026-11-01', to: '2026-11-30' }, { snapshotToken: ntok }) as never);
      for (const [k, q] of [['asOf futuro', { asOf: '2026-12-02', from: '2026-12-01', to: '2026-12-02' }], ['from>to', { asOf: '2026-12-01', from: '2026-11-30', to: '2026-11-01' }], ['fecha inexistente', { asOf: '2026-11-31', from: '2026-11-01', to: '2026-11-30' }], ['K futuro', { asOf: '2026-12-01', from: '2026-11-01', to: '2026-12-01', recordedThrough: new Date(f.now() + 3600000).toISOString() }], ['K no canónico', { asOf: '2026-12-01', from: '2026-11-01', to: '2026-12-01', recordedThrough: '2026-12-01T10:00:00Z' }]] as [string, Partial<Cut>][]) n['dashboard ' + k] = x.st(await dash(T, q) as never);
      // Pagination 0/1/many and filters keep the same snapshot.
      n['páginas 0 (borrowerId de C2 inexistente → 404)'] = x.st(await x.rep(T, 'listReportingRows', 'PORTFOLIO', { snapshotToken: ntok, borrowerId: randomUUID() }) as never);
      const empty = await x.rep(T, 'listReportingRows', 'PORTFOLIO', { snapshotToken: ntok, state: 'UNCLASSIFIABLE' }); n['páginas 0 (state UNCLASSIFIABLE)'] = { status: empty.status, totalRows: empty.data?.['totalRows'], items: (empty.data?.['items'] as unknown[])?.length, next: empty.data?.['nextCursor'] };
      const one = await x.rep(T, 'listReportingRows', 'PORTFOLIO', { snapshotToken: ntok, loanId: L.id }); n['páginas 1 (loanId)'] = { totalRows: one.data?.['totalRows'], next: one.data?.['nextCursor'] };
      const par = await x.rep(T, 'listReportingRows', 'PORTFOLIO', { snapshotToken: ntok, ageBand: 'D31_60' }); n['ageBand D31_60'] = (par.data?.['items'] as Record<string, unknown>[] | undefined)?.map(r => [r['loanId'] === L.id ? 'L' : r['loanId'] === L3.id ? 'L3' : r['loanId'] === L2.id ? 'L2' : 'L4', r['dpd']]);
      // Expired / stale tokens (AT06/AT08/CONSISTENCY).
      const fresh = String(((await dash(T, { asOf: D3b.asOf, from: '2026-11-01', to: D3b.asOf })).data!['meta'] as Record<string, unknown>)['snapshotToken']);
      const page1 = await x.rep(T, 'listReportingRows', 'PORTFOLIO', { snapshotToken: fresh, limit: '1' });
      const w1 = await x.bankReceipt(L4, '1000.00'); n['escritura entre páginas'] = x.st(w1 as never);
      n['página 2 con sello previo'] = x.st(await x.rep(T, 'listReportingRows', 'PORTFOLIO', { snapshotToken: fresh, limit: '1', cursor: String(page1.data?.['nextCursor']) }) as never);
      n['detalle con sello previo'] = x.st(await x.rep(T, 'getReportingLoan', L.id, { snapshotToken: fresh }) as never);
      const late = String(((await dash(T, { asOf: D3b.asOf, from: '2026-11-01', to: D3b.asOf })).data!['meta'] as Record<string, unknown>)['snapshotToken']);
      f.clock.value += 301000; n['sello expirado 301 s'] = x.st(await x.rep(T, 'listReportingRows', 'PORTFOLIO', { snapshotToken: late }) as never);
      // Concurrency: writes racing with dashboards — each dashboard equals the oracle either before or after the write.
      const race: unknown[] = [];
      for (let i = 0; i < 4; i++) {
        const cutNow = { asOf: D3b.asOf, from: '2026-11-01', to: D3b.asOf }, b = oracle(await x.dump(), { ...cutNow, recordedThrough: '9999-12-31T23:59:59.999Z' }, { kind: 'T', actor: '' }).metrics['RECEIPTS_CONFIRMED'];
        const [d, wr] = await Promise.all([dash(T, cutNow), x.bankReceipt(L4, '100.00')]);
        const a = oracle(await x.dump(), { ...cutNow, recordedThrough: '9999-12-31T23:59:59.999Z' }, { kind: 'T', actor: '' }).metrics['RECEIPTS_CONFIRMED'], got = values(d)['RECEIPTS_CONFIRMED'];
        race.push({ dashboard: x.st(d as never), write: x.st(wr as never), got, before: b, after: a, consistent: got === b || got === a });
      }
      n['carrera lectura/escritura'] = race;
      // ---- revocation of C assignment (current authority also for historical cuts) and P after decision.
      const cTok2 = String(((await dash(C, { asOf: D3b.asOf, from: '2026-11-01', to: D3b.asOf })).data!['meta'] as Record<string, unknown>)['snapshotToken']);
      const scopeDoc = await x.db.collection('payment_registration_scopes').findOne({ _id: f.scopeId as never });
      const rev = await x.w.settle(() => f.mutatePayment('setPaymentRegistrationScope', { scopeId: f.scopeId, registrarId: cId, loanId: L.id, scope: 'PAYMENT_REGISTER_ONLY', active: false, resourceETag: `"${f.scopeId}:${scopeDoc?.['version']}"`, supportReference: 'SYN-P05-REVOKE' }) as never);
      n['revocar asignación C'] = x.st(rev);
      n['C sello previo tras revocar'] = x.st(await x.rep(C, 'listReportingRows', 'PORTFOLIO', { snapshotToken: cTok2 }) as never);
      const cHist = await dash(C, { asOf: '2026-11-02', from: '2026-11-02', to: '2026-11-02' }); n['C histórico 11-02 tras revocar'] = { assigned: values(cHist, 'assignedMetrics')['PRINCIPAL_OUTSTANDING'], own: values(cHist, 'ownActivityMetrics') };
      const cNow = String(((await dash(C, { asOf: D3b.asOf, from: '2026-10-01', to: D3b.asOf })).data!['meta'] as Record<string, unknown>)['snapshotToken']);
      n['C detalle L tras revocar'] = x.st(await x.rep(C, 'getReportingLoan', L.id, { snapshotToken: cNow }) as never);
      n['C pago propio tras revocar'] = (await walk(x, C, 'MOVEMENTS', cNow, {}, 100)).items.filter(r => r['paymentId'] === f.paymentId).map(r => ({ nature: r['nature'], amount: r['amount'], loanId: r['loanId'] ?? 'omitted', borrower: r['borrower'] ?? 'omitted' }));
      const pend = await x.w.prepared(async () => await f.preparePayment({ kind: 'REGISTER', mode: 'SUPERVISED', effectiveDate: x.today(), intent: { ...(await f.intent(L4 as never, x.bank, '7000.00', CO, 'BANK')), custodianId: null, bindingETag: null } }, CO)); const pr = pend.p ? await x.w.settle(pend.p.execute) : pend.failed!;
      n['pago supervisado pendiente (CO)'] = x.st(pr);
      const pT1 = String(((await dash(P, { asOf: D3b.asOf, from: '2026-11-01', to: D3b.asOf })).data!['meta'] as Record<string, unknown>)['snapshotToken']);
      n['P MOVEMENTS pendientes'] = (await walk(x, P, 'MOVEMENTS', pT1, {}, 100)).items.map(r => ({ nature: r['nature'], state: r['state'], amount: r['amount'] }));
      const pid = pr.data?.['entityId'] as string | undefined;
      if (pid) { const pay = await f.readPayment(pid), v = await f.state(); n['T aprueba pendiente'] = x.st(await x.w.settle(async () => (await f.preparePayment({ kind: 'APPROVE', paymentId: pid, resourceETag: pay.etag, effectiveDate: x.today(), expectedOperationsETag: v.operationsBookETag })).execute()) as never); }
      n['P sello previo tras aprobación'] = x.st(await x.rep(P, 'listReportingRows', 'MOVEMENTS', { snapshotToken: pT1 }) as never);
      const pT2 = String(((await dash(P, { asOf: D3b.asOf, from: '2026-11-01', to: D3b.asOf })).data!['meta'] as Record<string, unknown>)['snapshotToken']);
      n['P MOVEMENTS tras aprobación'] = (await walk(x, P, 'MOVEMENTS', pT2, {}, 100)).items.length;
      await check('FINAL tras revocación/aprobación', { asOf: D3b.asOf, from: '2026-11-01', to: D3b.asOf, recordedThrough: new Date(f.now()).toISOString() }, [['T', T, { kind: 'T', actor: '' }], ['C', C, { kind: 'C', actor: cId }], ['P', P, { kind: 'P', actor: P.issued.context.subjectId! }], ['CO', CO, { kind: 'C', actor: CO.issued.context.subjectId! }]]);
      // ---- GET/preview purity (AT06): all collections of the 3 own databases before/after successful and failed reads.
      const g0 = await x.digestAll(), sess0 = await x.db.collection('sessions').find({}).sort({ _id: 1 }).toArray();
      const gets: string[] = [];
      for (const actor of [T, C, O, P, CO]) { const r = await dash(actor, { asOf: D3b.asOf, from: '2026-11-01', to: D3b.asOf }); gets.push(x.st(r as never)); const tk = (r.data?.['meta'] as Record<string, unknown>)?.['snapshotToken']; for (const k of ['PORTFOLIO', 'INSTALLMENTS', 'MOVEMENTS', 'CASH', 'RECONCILIATION', 'COLLECTORS', 'CONCENTRATION']) gets.push(k + ' ' + x.st(await x.rep(actor, 'listReportingRows', k, { snapshotToken: tk }) as never)); gets.push('policy ' + x.st(await x.rep(actor, 'getReportingPolicy') as never)); gets.push('loan ' + x.st(await x.rep(actor, 'getReportingLoan', L4.id, { snapshotToken: tk }) as never)); }
      gets.push('bad ' + x.st(await x.rep(T, 'listReportingRows', 'PORTFOLIO', { snapshotToken: 'x' }) as never));
      const prevC = await x.w.prepared(() => f.prepareCollections({ kind: 'REQUEST', stationId: f.stationId, stationETag: 'x', sourceAccountId: f.cash.id, sourceAccountETag: 'x', bindingETag: 'x', journeyId: null, amount: '1.00', portions: [], supportReference: 'SYN' }, C)); gets.push('collections preview ' + (prevC.failed ? x.st(prevC.failed) : 'ok'));
      const g1 = await x.digestAll(), sess1 = await x.db.collection('sessions').find({}).sort({ _id: 1 }).toArray();
      o['AT06 pureza'] = { reads: gets.length, statuses: [...new Set(gets.map(s => s.replace(/^[A-Z ]+ /, '')))], changed: x.diff(g0.collections, g1.collections), projection: { before: g0.projection, after: g1.projection }, sessionsUnchanged: JSON.stringify(sess0) === JSON.stringify(sess1), collections: Object.keys(g0.collections).length };
      // ---- HTTPS: headers, method, cookie, host (W read without monetary grant), p50/p95 on this dataset.
      const https = await (f.https as unknown as (withClient?: boolean) => Promise<{ port: number; cert: Buffer }>)(false), cl = new ApiClient(https.port, https.cert); cl.cookies.set('__Host-caudelyx-session', T.issued.token);
      const base = `/api/v1/organizations/${x.org}/reporting`, q = `asOf=${D3b.asOf}&from=2026-11-01&to=${D3b.asOf}`;
      const h = await cl.call('GET', `${base}/dashboard?${q}`) as { status: number; headers?: Record<string, string>; body?: Record<string, unknown> };
      const hb = (h as unknown as { body: { data: Record<string, unknown> } }).body?.data; o['HTTPS dashboard'] = { status: h.status, cacheControl: (h as unknown as { headers: Record<string, string> }).headers?.['cache-control'], sameAsService: JSON.stringify(values({ status: 200, data: hb })) === JSON.stringify(values(await dash(T, { asOf: D3b.asOf, from: '2026-11-01', to: D3b.asOf }))) };
      await cl.refreshCsrf(); o['HTTPS POST'] = (await cl.call('POST', `${base}/dashboard?${q}`, {}) as { status: number }).status;
      const anon = new ApiClient(https.port, https.cert); o['HTTPS sin sesión'] = (await anon.call('GET', `${base}/dashboard?${q}`) as { status: number }).status;
      o['HTTPS host plataforma'] = (await cl.call('GET', `${base}/dashboard?${q}`, undefined, { Host: 'platform.localhost:' + https.port }) as { status: number }).status;
      o['HTTPS parámetro extra'] = (await cl.call('GET', `${base}/dashboard?${q}&role=T`) as { status: number }).status;
      const ms: number[] = [], rs: number[] = []; const tk = String(((hb?.['meta'] ?? {}) as Record<string, unknown>)['snapshotToken']);
      for (let i = 0; i < 20; i++) { const s0 = performance.now(); const r = await cl.call('GET', `${base}/dashboard?${q}`) as { status: number }; ms.push(performance.now() - s0); assert.equal(r.status, 200); const s1 = performance.now(); const r2 = await cl.call('GET', `${base}/reports/PORTFOLIO?snapshotToken=${encodeURIComponent(tk)}&limit=100`) as { status: number }; rs.push(performance.now() - s1); if (r2.status !== 200) break; }
      const pq = (a: number[], p: number) => { const s = [...a].sort((x1, y) => x1 - y); return Math.round(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]! * 10) / 10; };
      o['HTTPS latencia (dataset pequeño)'] = { dashboard: { n: ms.length, p50: pq(ms, 0.5), p95: pq(ms, 0.95) }, portfolio100: { n: rs.length, p50: pq(rs, 0.5), p95: pq(rs, 0.95) } };
      // ---- projection 0.1 (T, current day): same figures as direct path, invalidated by data change.
      await x.at('2026-12-01T13:00:00.000-05:00');
      const direct = values(await dash(T, { asOf: D3b.asOf, from: '2026-11-01', to: D3b.asOf }));
      const rt = await x.w.settle(async () => ({ status: 200, data: await x.activate() as never }));
      if (rt.status === 200) {
        const proj = values(await dash(T, { asOf: D3b.asOf, from: '2026-11-01', to: D3b.asOf }));
        const wr = await x.bankReceipt(L4, '500.00'); const proj2 = values(await dash(T, { asOf: D3b.asOf, from: '2026-11-01', to: D3b.asOf }));
        const exp2 = oracle(await x.dump(), { asOf: D3b.asOf, from: '2026-11-01', to: D3b.asOf, recordedThrough: '9999-12-31T23:59:59.999Z' }, { kind: 'T', actor: '' });
        o['proyección'] = { equalToDirect: JSON.stringify(proj) === JSON.stringify(direct), diff: Object.keys(direct).filter(k => direct[k] !== proj[k]), write: x.st(wr as never), afterWriteMatchesOracle: Object.keys(exp2.metrics).filter(k => k in proj2 && proj2[k] !== exp2.metrics[k]) };
        await x.deactivate(rt.data as never);
      } else o['proyección'] = { activation: x.st(rt) };
      o['anchors esperados D0'] = anchors0;
      // ---- assertions (after evidence is complete)
      assert.deepEqual(bad, [], 'oracle mismatches');
      assert.deepEqual(o['D0 anchors'], anchors0);
      assert.deepEqual((o['AT06 pureza'] as { changed: string[] }).changed, []);
      assert.equal(n['C detail L2'], '404 RESOURCE_NOT_FOUND'); assert.match(String(n['O PORTFOLIO']), /^403 /); assert.match(String(n['P PORTFOLIO']), /^403 /);
      assert.match(String(n['página 2 con sello previo']), /^409 REPORT_SNAPSHOT_STALE/); assert.match(String(n['sello expirado 301 s']), /^409 REPORT_SNAPSHOT_EXPIRED/);
      for (const r of race as { consistent: boolean }[]) assert.equal(r.consistent, true);
    });
  } finally { await group.dispose(); }
});
