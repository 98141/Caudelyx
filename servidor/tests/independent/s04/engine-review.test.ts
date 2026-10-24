/* eslint-disable security/detect-object-injection -- Keys are this test's own fixed labels/array indexes, never request input. */
// S04-P05 independent recalculation (Claude) of the S04-P04-v1-INTEGRADO engine against an OWN oracle (./oracle.ts),
// the approved AT-S04 literals and the 33 P01 reference cases. The engine is only the system under test; expected values
// never come from it. Pure computation: no database, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { calculate } from '../../../src/modules/lending/calculator.js';
import { scheduleDates } from '../../../src/modules/lending/calendar.js';
import { AppError } from '../../../src/shared/errors.js';
import type { Terms } from '../../../src/modules/lending/models.js';
import { oracle, dueDates, exactLevelPayment, periodicRate24, rate24Text, type Outcome, type OracleTerms } from './oracle.js';

const evidence = (name: string, data: Record<string, unknown>) => console.log(JSON.stringify({ evidence: name, ...data }));
const EVID = resolve('../../Construccion/Sprints/S04/Evidencias');
const base = (d: Partial<Terms> = {}): Terms => ({ borrowerId: '00000000-0000-4000-8000-000000000001', plannedFundingAccountId: '00000000-0000-4000-8000-000000000002',
  principal: '1000.00', effectiveDate: '2024-01-31', firstDueDate: '2024-02-29', installmentCount: 3, method: 'LEVEL_PAYMENT', frequency: 'MONTH',
  rate: { type: 'EFFECTIVE', unit: 'MONTH', value: '0.010000000000' }, calendarConvention: 'PERIODIC_FIXED', holidayAdjustment: 'NO_SHIFT',
  policyVersion: 'S04-LOCAL-CO-0.1', jurisdiction: 'CO', usage: 'LOCAL_SYNTHETIC', ...d });
/** Engine outcome in the oracle's shape (error code or the economic fields only). */
function engine(t: Terms): Outcome {
  try {
    const c = calculate(t);
    return { value: { schedule: c.schedule, totals: c.totals, periodicRate24: c.periodicRate24, basePayment: c.basePayment, finalPaymentAdjustment: c.finalPaymentAdjustment } };
  } catch (e) { if (e instanceof AppError) return { error: e.code }; throw e; }
}
const cents = (s: string) => BigInt(s.replace('.', ''));
/** Invariants that must hold for ANY accepted schedule, independent of the oracle. */
function invariants(t: Terms, o: Outcome): string[] {
  if ('error' in o) return [];
  const v = o.value, bad: string[] = [], P = cents(t.principal), rows = v.schedule;
  if (rows.length !== t.installmentCount) bad.push('rows');
  let sp = 0n, si = 0n, spay = 0n, prev = '';
  rows.forEach((r, k) => {
    if (r.k !== k + 1) bad.push('k');
    if (!(r.date > prev)) bad.push('dates not strictly increasing'); prev = r.date;
    if (k > 0 && r.openingPrincipal !== rows[k - 1]!.closingPrincipal) bad.push('chain');
    if (cents(r.payment) !== cents(r.principal) + cents(r.interest)) bad.push('payment=principal+interest');
    if (cents(r.closingPrincipal) !== cents(r.openingPrincipal) - cents(r.principal)) bad.push('closing');
    for (const f of [r.openingPrincipal, r.principal, r.interest, r.payment, r.closingPrincipal]) if (f.startsWith('-') || !/^\d+\.\d{2}$/.test(f)) bad.push('format/negative ' + f);
    if (k < rows.length - 1) {
      if (t.method === 'INTEREST_ONLY' && r.principal !== '0.00') bad.push('IO principal before last');
      if (t.method === 'CONSTANT_PRINCIPAL' && r.principal !== rows[0]!.principal) bad.push('CP constant');
      if (t.method === 'LEVEL_PAYMENT' && r.payment !== v.basePayment) bad.push('LP level');
    }
    sp += cents(r.principal); si += cents(r.interest); spay += cents(r.payment);
  });
  if (sp !== P) bad.push('sum principal != P');
  if (rows.at(-1)?.closingPrincipal !== '0.00') bad.push('final balance');
  if (v.totals.principal !== t.principal || cents(v.totals.interest) !== si || cents(v.totals.payment) !== spay || spay !== P + si) bad.push('totals');
  if (t.method === 'LEVEL_PAYMENT' ? cents(v.finalPaymentAdjustment) !== cents(rows.at(-1)!.payment) - cents(v.basePayment!) : (v.finalPaymentAdjustment !== '0.00' || v.basePayment !== null)) bad.push('adjustment/base');
  if (v.finalPaymentAdjustment === '-0.00') bad.push('-0.00');
  return bad;
}

test('P05-S4-E01 the 33 P01 reference cases: own oracle == reference expected == engine, plus invariants', () => {
  const doc = JSON.parse(readFileSync(resolve('../../Construccion/Sprints/S04/Contratos/REFERENCE_CASES_S04.json'), 'utf8')) as { cases: { id: string; terms: Terms; expected: Record<string, unknown> }[] };
  const rows: Record<string, string> = {};
  for (const c of doc.cases) {
    const mine = oracle(c.terms as unknown as OracleTerms), got = engine(c.terms);
    const ref: Outcome = typeof c.expected['error'] === 'string' ? { error: c.expected['error'] } : { value: { schedule: c.expected['schedule'], totals: c.expected['totals'], periodicRate24: c.expected['periodicRate24'], basePayment: c.expected['basePayment'] ?? null, finalPaymentAdjustment: c.expected['finalPaymentAdjustment'] } as never };
    assert.deepEqual(mine, ref, `oracle vs reference ${c.id}`);
    assert.deepEqual(got, mine, `engine vs oracle ${c.id}`);
    assert.deepEqual(invariants(c.terms, got), [], c.id);
    rows[c.id] = 'error' in got ? got.error : `i24=${got.value.periodicRate24} interest=${got.value.totals.interest} payment=${got.value.totals.payment}`;
  }
  evidence('P05-S4-E01', { cases: doc.cases.length, allEqual: true, rows });
});

test('P05-S4-E02 AT-S04-02..05/08 literals recomputed by hand and asserted on both oracle and engine', () => {
  const pay = (o: Outcome) => 'error' in o ? o.error : o.value.schedule.map(r => r.payment);
  const lit: { name: string; t: Terms; payments: string[] | string; interest?: string; adj?: string; principals?: string[] }[] = [
    { name: 'AT03 CP 1000/n3/1%', t: base({ method: 'CONSTANT_PRINCIPAL' }), payments: ['343.33', '340.00', '336.67'], interest: '20.00' },
    { name: 'AT03 CP 0.09/n6/0', t: base({ method: 'CONSTANT_PRINCIPAL', principal: '0.09', installmentCount: 6, frequency: 'DAY', firstDueDate: '2024-02-01', rate: { type: 'EFFECTIVE', unit: 'DAY', value: '0.000000000000' } }), payments: ['0.01', '0.01', '0.01', '0.01', '0.01', '0.04'], interest: '0.00', principals: ['0.01', '0.01', '0.01', '0.01', '0.01', '0.04'] },
    { name: 'AT04 LP 1000/n3/1%', t: base(), payments: ['340.02', '340.02', '340.03'], interest: '20.07', adj: '0.01' },
    { name: 'AT04 LP 1.01/n2/0', t: base({ principal: '1.01', installmentCount: 2, rate: { type: 'EFFECTIVE', unit: 'MONTH', value: '0.000000000000' } }), payments: ['0.51', '0.50'], interest: '0.00', adj: '-0.01' },
    { name: 'AT04 reject LP 0.09/n6/0', t: base({ principal: '0.09', installmentCount: 6, rate: { type: 'EFFECTIVE', unit: 'MONTH', value: '0.000000000000' } }), payments: 'PAYMENT_RESOLUTION_UNSUPPORTED' },
    { name: 'AT04 LP 0.01/n1/0 accepted', t: base({ principal: '0.01', installmentCount: 1, rate: { type: 'EFFECTIVE', unit: 'MONTH', value: '0.000000000000' } }), payments: ['0.01'], adj: '0.00' },
    { name: 'AT05 IO 1000/n3/1%', t: base({ method: 'INTEREST_ONLY' }), payments: ['10.00', '10.00', '1010.00'], interest: '30.00', principals: ['0.00', '0.00', '1000.00'] },
    { name: 'AT02 IO tasa0 n3 keeps zero rows', t: base({ method: 'INTEREST_ONLY', rate: { type: 'EFFECTIVE', unit: 'MONTH', value: '0.000000000000' } }), payments: ['0.00', '0.00', '1000.00'], interest: '0.00' },
    { name: 'AT02 LP tasa0 n3 no division by zero', t: base({ rate: { type: 'EFFECTIVE', unit: 'MONTH', value: '0.000000000000' } }), payments: ['333.33', '333.33', '333.34'], interest: '0.00', adj: '0.01' },
    { name: 'AT02 CP tasa0 n3', t: base({ method: 'CONSTANT_PRINCIPAL', rate: { type: 'EFFECTIVE', unit: 'MONTH', value: '0.000000000000' } }), payments: ['333.33', '333.33', '333.34'], interest: '0.00' },
    { name: 'AT08 half cent 0.50×1% → 0.01 HALF_UP', t: base({ method: 'CONSTANT_PRINCIPAL', principal: '0.50', installmentCount: 1 }), payments: ['0.51'], interest: '0.01' },
    { name: 'AT08 0.49×1% → 0.00', t: base({ method: 'CONSTANT_PRINCIPAL', principal: '0.49', installmentCount: 1 }), payments: ['0.49'], interest: '0.00' },
    { name: 'AT07 nominal 12%/m12 → 1% per month', t: base({ method: 'INTEREST_ONLY', rate: { type: 'NOMINAL_ANNUAL', unit: 'YEAR', value: '0.120000000000', compoundingPeriodsPerYear: 12 } }), payments: ['10.00', '10.00', '1010.00'], interest: '30.00' },
    { name: 'AT08 money overflow', t: base({ method: 'CONSTANT_PRINCIPAL', principal: '1000000000000.00', installmentCount: 1, rate: { type: 'EFFECTIVE', unit: 'DAY', value: '1.000000000000' } }), payments: 'CALCULATION_UNREPRESENTABLE' },
    { name: 'AT08 CP 0.01/n2 too small', t: base({ method: 'CONSTANT_PRINCIPAL', principal: '0.01', installmentCount: 2 }), payments: 'PAYMENT_RESOLUTION_UNSUPPORTED' },
  ];
  const seen: Record<string, unknown> = {};
  for (const l of lit) {
    for (const [who, o] of [['oracle', oracle(l.t as unknown as OracleTerms)], ['engine', engine(l.t)]] as const) {
      assert.deepEqual(pay(o), l.payments, `${who} ${l.name}`);
      if ('value' in o) {
        if (l.interest) assert.equal(o.value.totals.interest, l.interest, `${who} ${l.name} interest`);
        if (l.adj) assert.equal(o.value.finalPaymentAdjustment, l.adj, `${who} ${l.name} adj`);
        if (l.principals) assert.deepEqual(o.value.schedule.map(r => r.principal), l.principals, `${who} ${l.name} principals`);
        assert.deepEqual(invariants(l.t, o), [], `${who} ${l.name}`);
      }
    }
    seen[l.name] = pay(engine(l.t));
  }
  // Rate conversions by hand: EA 12% → month = 1.12^(1/12)-1; i24 must equal the certified value in both.
  const ea = { type: 'EFFECTIVE', unit: 'YEAR', value: '0.120000000000' };
  assert.equal(rate24Text(periodicRate24(ea, 'MONTH')), '0.009488792934582974126355');
  const eaEngine = engine(base({ rate: ea as Terms['rate'] }));
  assert.ok('value' in eaEngine); assert.equal(eaEngine.value.periodicRate24, '0.009488792934582974126355');
  // EA/12 must NOT be used (would be 0.01).
  evidence('P05-S4-E02', { literals: seen, eaMonthly: '0.009488792934582974126355', notEaDividedBy12: true });
});

/** Seeded xorshift so the sweep is reproducible and recorded. */
function rng(seed: number) { let s = seed >>> 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const UNITS = ['DAY', 'WEEK', 'FIFTEEN_DAYS', 'SEMIMONTH', 'MONTH', 'YEAR'], FREQ = ['DAY', 'WEEK', 'FIFTEEN_DAYS', 'SEMIMONTH', 'MONTH'], METHODS = ['CONSTANT_PRINCIPAL', 'LEVEL_PAYMENT', 'INTEREST_ONLY'] as const;
const pad = (n: number, w: number) => String(n).padStart(w, '0');
const dimOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function randomTerms(r: () => number): Terms {
  const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)]!;
  const method = pick(METHODS), frequency = pick(FREQ);
  const y = 2000 + Math.floor(r() * 200), m = 1 + Math.floor(r() * 12), last = dimOf(y, m);
  const d = frequency === 'SEMIMONTH' && r() < 0.85 ? (r() < 0.5 ? 15 : last) : (r() < 0.25 ? last : 1 + Math.floor(r() * last));
  const effectiveDate = `${y}-${pad(m, 2)}-${pad(d, 2)}`;
  const k = r(), frac = () => pad(Math.floor(r() * 1e6), 6) + pad(Math.floor(r() * 1e6), 6);
  const value = k < 0.1 ? '0.000000000000' : k < 0.15 ? '0.000000000001' : k < 0.2 ? '1.000000000000' : k < 0.6 ? '0.0' + pad(Math.floor(r() * 1e5), 5) + pad(Math.floor(r() * 1e6), 6) : '0.' + frac();
  const nominal = r() < 0.3, mval = pick([1, 2, 4, 12, 24, 52, 360, 365, 366, 1 + Math.floor(r() * 366)]);
  const rate = nominal ? { type: 'NOMINAL_ANNUAL' as const, unit: 'YEAR', value, compoundingPeriodsPerYear: mval } : { type: 'EFFECTIVE' as const, unit: pick(UNITS), value };
  const pk = r(), P = pk < 0.08 ? BigInt(1 + Math.floor(r() * 100)) : pk < 0.16 ? 100000000000000n : BigInt(Math.floor(10 ** (r() * 14))) + 1n;
  const principal = (P / 100n).toString() + '.' + pad(Number(P % 100n), 2);
  const nk = r(), installmentCount = nk < 0.12 ? 1 : nk < 0.24 ? 360 : nk < 0.7 ? 1 + Math.floor(r() * 36) : 1 + Math.floor(r() * 360);
  const dates = dueDates({ effectiveDate, frequency, installmentCount: 1 });
  let firstDueDate = Array.isArray(dates) ? dates[0]! : '2024-02-29';
  if (r() < 0.04) firstDueDate = new Date(Date.parse(firstDueDate + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  return base({ method, frequency, effectiveDate, firstDueDate, installmentCount, principal, rate });
}

test('P05-S4-E03 seeded random sweep: engine == own oracle on every field or the same rejection; invariants on all accepted', () => {
  const SEED = 0x5045c4, N = Number(process.env['P05_S4_SWEEP'] ?? 3000), r = rng(SEED), t0 = performance.now();
  const stats = { accepted: 0, byError: {} as Record<string, number>, byMethod: {} as Record<string, number>, byRateType: {} as Record<string, number>, mismatches: [] as unknown[], invariantFailures: [] as unknown[], contextSensitive: 0, n360: 0, maxPrincipal: 0 };
  const sample: unknown[] = [];
  for (let k = 0; k < N; k++) {
    const t = randomTerms(r), mine = oracle(t as unknown as OracleTerms), got = engine(t);
    stats.byMethod[t.method] = (stats.byMethod[t.method] ?? 0) + 1; stats.byRateType[t.rate.type + '/' + t.rate.unit] = (stats.byRateType[t.rate.type + '/' + t.rate.unit] ?? 0) + 1;
    if (t.installmentCount === 360) stats.n360++; if (t.principal === '1000000000000.00') stats.maxPrincipal++;
    try { assert.deepEqual(got, mine); } catch { if (stats.mismatches.length < 5) stats.mismatches.push({ k, t, mine: 'error' in mine ? mine.error : mine.value.basePayment, got: 'error' in got ? got.error : got.value.basePayment }); else stats.mismatches.push(k); }
    const inv = invariants(t, got); if (inv.length) stats.invariantFailures.push({ k, inv });
    if ('error' in got) stats.byError[got.error] = (stats.byError[got.error] ?? 0) + 1; else {
      stats.accepted++;
      if (t.method === 'LEVEL_PAYMENT' && got.value.basePayment !== null && exactLevelPayment(t as unknown as OracleTerms) !== cents(got.value.basePayment)) stats.contextSensitive++;
      if (sample.length < 400 && t.rate.value !== '0.000000000000') sample.push({ rate: t.rate, frequency: t.frequency, engineI24: got.value.periodicRate24 });
    }
  }
  writeFileSync(resolve(EVID, 'S04-P05-I24-SAMPLE.json'), JSON.stringify({ seed: SEED, note: 'engine i24 for 400 accepted sweep cases, for the independent Python decimal cross-check', sample }, null, 1) + '\n');
  evidence('P05-S4-E03', { seed: SEED, cases: N, durationMs: Math.round(performance.now() - t0), ...stats, mismatchCount: stats.mismatches.length });
  assert.equal(stats.mismatches.length, 0, JSON.stringify(stats.mismatches.slice(0, 5)));
  assert.equal(stats.invariantFailures.length, 0, JSON.stringify(stats.invariantFailures.slice(0, 5)));
  assert.ok(stats.accepted > N / 2, 'sweep must mostly produce accepted schedules');
});

test('P05-S4-E04 calendar sweep 2023–2025 + century/limit windows: engine dates == civil-day oracle; NO_SHIFT keeps weekends', () => {
  const t0 = performance.now(); let compared = 0, weekend = 0; const errors: Record<string, number> = {}; const mismatches: unknown[] = [];
  const windows: [string, number][] = [['2023-01-01', 1096], ['2099-11-01', 160], ['2199-01-01', 365], ['2000-01-01', 70]];
  for (const [start, days] of windows) for (let dd = 0; dd < days; dd++) {
    const effectiveDate = new Date(Date.parse(start + 'T00:00:00Z') + dd * 86400000).toISOString().slice(0, 10);
    for (const frequency of FREQ) for (const installmentCount of [1, 2, 3, 6, 13, 25]) {
      const mine = dueDates({ effectiveDate, frequency, installmentCount });
      const first = Array.isArray(mine) ? mine[0]! : effectiveDate;
      let got: string[] | { error: string };
      try { got = scheduleDates({ effectiveDate, firstDueDate: first, frequency, installmentCount, calendarConvention: 'PERIODIC_FIXED', holidayAdjustment: 'NO_SHIFT' }); }
      catch (e) { if (!(e instanceof AppError)) throw e; got = { error: e.code }; }
      compared++;
      try { assert.deepEqual(got, mine); } catch { if (mismatches.length < 5) mismatches.push({ effectiveDate, frequency, installmentCount, mine, got }); }
      if (!Array.isArray(got)) errors[got.error] = (errors[got.error] ?? 0) + 1;
      else for (const d of got) { const w = new Date(d + 'T00:00:00Z').getUTCDay(); if (w === 0 || w === 6) weekend++; }
    }
  }
  // Named counterexamples from AT-S04-06.
  const named = {
    anchor30: dueDates({ effectiveDate: '2023-01-30', frequency: 'MONTH', installmentCount: 3 }),
    eomLeap: dueDates({ effectiveDate: '2024-02-29', frequency: 'MONTH', installmentCount: 3 }),
    century2100: dueDates({ effectiveDate: '2100-01-31', frequency: 'MONTH', installmentCount: 2 }),
    year2000Leap: dueDates({ effectiveDate: '2000-01-31', frequency: 'MONTH', installmentCount: 1 }),
    fifteenVsSemimonth: [dueDates({ effectiveDate: '2024-01-31', frequency: 'FIFTEEN_DAYS', installmentCount: 3 }), dueDates({ effectiveDate: '2024-01-31', frequency: 'SEMIMONTH', installmentCount: 3 })],
    semimonthFrom10: dueDates({ effectiveDate: '2024-01-10', frequency: 'SEMIMONTH', installmentCount: 2 }),
    beyond2199: dueDates({ effectiveDate: '2199-12-31', frequency: 'MONTH', installmentCount: 1 }),
  };
  assert.deepEqual(named.anchor30, ['2023-02-28', '2023-03-30', '2023-04-30']);
  assert.deepEqual(named.eomLeap, ['2024-03-31', '2024-04-30', '2024-05-31']);
  assert.deepEqual(named.century2100, ['2100-02-28', '2100-03-31']);
  assert.deepEqual(named.year2000Leap, ['2000-02-29']);
  assert.deepEqual(named.fifteenVsSemimonth, [['2024-02-15', '2024-03-01', '2024-03-16'], ['2024-02-15', '2024-02-29', '2024-03-15']]);
  assert.deepEqual(named.semimonthFrom10, { error: 'IRREGULAR_PERIOD_UNSUPPORTED' });
  assert.deepEqual(named.beyond2199, { error: 'INVALID_DATE' });
  evidence('P05-S4-E04', { compared, durationMs: Math.round(performance.now() - t0), errors, weekendDueDatesKept: weekend, mismatches: mismatches.length, named });
  assert.equal(mismatches.length, 0, JSON.stringify(mismatches));
  assert.ok(weekend > 0);
});

test('P05-S4-E05 structural/semantic negatives at the engine boundary: no default, no truncation, no fallback', () => {
  const cases: [string, Partial<Terms> | Record<string, unknown>, string][] = [
    ['principal 1000.001', { principal: '1000.001' }, 'INPUT_INVALID'], ['principal 1e3', { principal: '1e3' }, 'INPUT_INVALID'], ['principal -0.00', { principal: '-0.00' }, 'INPUT_INVALID'],
    ['principal 0.00', { principal: '0.00' }, 'INPUT_INVALID'], ['principal above 1e12', { principal: '1000000000000.01' }, 'INPUT_INVALID'], ['principal as number', { principal: 1000 as unknown as string }, 'INPUT_INVALID'],
    ['principal padded', { principal: ' 1000.00' }, 'INPUT_INVALID'],
    ['rate 0.01 (not 12 decimals)', { rate: { type: 'EFFECTIVE', unit: 'MONTH', value: '0.01' } }, 'INPUT_INVALID'], ['rate above 1', { rate: { type: 'EFFECTIVE', unit: 'MONTH', value: '1.000000000001' } }, 'INPUT_INVALID'],
    ['rate negative', { rate: { type: 'EFFECTIVE', unit: 'MONTH', value: '-0.010000000000' } }, 'INPUT_INVALID'], ['rate percent text', { rate: { type: 'EFFECTIVE', unit: 'MONTH', value: '1%' } }, 'INPUT_INVALID'],
    ['effective with m', { rate: { type: 'EFFECTIVE', unit: 'MONTH', value: '0.010000000000', compoundingPeriodsPerYear: 12 } }, 'INPUT_INVALID'],
    ['nominal without m', { rate: { type: 'NOMINAL_ANNUAL', unit: 'YEAR', value: '0.120000000000' } }, 'INPUT_INVALID'],
    ['nominal unit MONTH', { rate: { type: 'NOMINAL_ANNUAL', unit: 'MONTH', value: '0.010000000000', compoundingPeriodsPerYear: 12 } }, 'INPUT_INVALID'],
    ['nominal m 367', { rate: { type: 'NOMINAL_ANNUAL', unit: 'YEAR', value: '0.120000000000', compoundingPeriodsPerYear: 367 } }, 'INPUT_INVALID'],
    ['rate missing', { rate: undefined }, 'INPUT_INVALID'], ['unit missing', { rate: { type: 'EFFECTIVE', value: '0.010000000000' } }, 'INPUT_INVALID'],
    ['frequency YEAR', { frequency: 'YEAR' }, 'INPUT_INVALID'], ['n 0', { installmentCount: 0 }, 'INPUT_INVALID'], ['n 361', { installmentCount: 361 }, 'INPUT_INVALID'], ['n 1.5', { installmentCount: 1.5 }, 'INPUT_INVALID'],
    ['method unknown', { method: 'FRENCH' as never }, 'INPUT_INVALID'], ['extra isDisbursed', { isDisbursed: true }, 'INPUT_INVALID'], ['extra outstandingBalance', { outstandingBalance: '1.00' }, 'INPUT_INVALID'],
    ['ACT_365', { calendarConvention: 'ACT_365' }, 'UNSUPPORTED_CALENDAR'], ['holiday shift', { holidayAdjustment: 'NEXT_BUSINESS_DAY' }, 'UNSUPPORTED_CALENDAR'],
    ['usage REAL', { usage: 'REAL' }, 'REAL_USE_NOT_ALLOWED'], ['policy other', { policyVersion: 'S04-LOCAL-CO-0.2' }, 'POLICY_UNSUPPORTED'], ['jurisdiction PE', { jurisdiction: 'PE' }, 'POLICY_UNSUPPORTED'],
    ['date 2024-02-30', { effectiveDate: '2024-02-30' }, 'INVALID_DATE'], ['date 1999-12-31', { effectiveDate: '1999-12-31' }, 'INVALID_DATE'], ['first due irregular (long first period)', { firstDueDate: '2024-03-31' }, 'IRREGULAR_PERIOD_UNSUPPORTED'],
    ['documents 11', { documents: Array.from({ length: 11 }, (_, k) => ({ reference: 'DOC-' + k, label: 'Doc', kind: 'OTHER' })) }, 'INPUT_INVALID'], ['note 241', { note: 'x'.repeat(241) }, 'INPUT_INVALID'],
  ];
  const seen: Record<string, string> = {};
  for (const [name, delta, expected] of cases) {
    const t = { ...base(), ...delta } as Terms; if ('rate' in delta && delta.rate === undefined) delete (t as Partial<Terms>).rate;
    const got = engine(t); seen[name] = 'error' in got ? got.error : 'ACCEPTED';
    assert.equal(seen[name], expected, name);
  }
  evidence('P05-S4-E05', { cases: cases.length, seen });
});
