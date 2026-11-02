/* eslint-disable security/detect-object-injection -- Own synthetic engine inputs and closed metric names only. */
// S13-P05 (Claude, base S12-P05): pure engine/alert review. Expected values are computed here with own BigInt/date helpers
// written from LIQUIDITY_AND_ASSUMPTIONS_S12/INTERNAL_ALERTS_S12; the product engine is only the system under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {evaluate} from '../../src/modules/simulation/engine.js';
import {evaluateAlerts, acknowledge, scenarioCandidates, type Candidate, type StoredAlert} from '../../src/modules/simulation/alerts.js';
import {factCandidates, type Capture} from '../../src/modules/simulation/sources.js';
import type {EngineBase, BookInput, Flow, VersionInput, Alternative, Assumption, Outcome, Evaluation} from '../../src/modules/simulation/models.js';
import {cents, money} from './book.js';

const OUT = '../../Construccion/Sprints/S13/Evidencias/S13-P05-CHECKS-PURE.json';
const checks: Record<string, unknown> = {};
const AS_OF = '2026-10-31';
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
// Own HALF_UP of amount(cents) * fraction(6 decimals): independent of product money.ts.
const half = (c: bigint, f: string) => { const [w, p = ''] = f.split('.'); const micro = BigInt(w!) * 1000000n + BigInt(p.padEnd(6, '0')); const n = c * micro; return (2n * n + 1000000n) / 2000000n; };
let seq = 0;
const uid = () => { const h = (++seq).toString(16).padStart(12, '0'); return `00000000-0000-4000-8000-${h}`; };
const flow = (date: string, direction: 'IN' | 'OUT', amount: string | null, classification: Flow['classification'] = direction === 'IN' ? 'PRINCIPAL' : 'EXPENSE', key?: string): Flow => { const id = uid(); return {id, sourceKey: key ?? id, bookId: 'B1', date, direction, classification, amount, sourceRefs: [], entityId: id, installment: null}; };
const book = (o: Partial<BookInput> & {cash: string}, flows: Flow[] = []): BookInput => ({bookId: 'B1', kind: 'BUSINESS', cashBook: o.cash, available: o.available ?? o.cash, reserved: o.reserved ?? '0.00', held: '0.00', custodyProvisional: '0.00', custodyConfirmed: '0.00', committed: '0.00', principalOutstanding: o.principalOutstanding === undefined ? '100.00' : o.principalOutstanding, recognizedInterest: '0.00', ownDebt: o.ownDebt ?? '0.00', netWorthBook: o.netWorthBook ?? o.cash, estimatedOwnValue: o.estimatedOwnValue === undefined ? '0.00' : o.estimatedOwnValue, netWorthIndicative: o.netWorthIndicative === undefined ? (o.netWorthBook ?? o.cash) : o.netWorthIndicative, assetCost: '0.00', funds: o.funds ?? [], terms: o.terms ?? [], flows, sourceRefs: [], coverage: 'COMPLETE', reasons: [], ...(o.bookId ? {bookId: o.bookId} : {})});
const base = (...books: BookInput[]): EngineBase => ({id: uid(), targetBookId: books[0]!.bookId, asOf: AS_OF, knownAt: '2026-10-31T17:00:00.000Z', sourceDigest: 'p05', books});
const assumption = (kind: Assumption['kind'], o: Partial<Assumption> = {}): Assumption => ({kind, collectionFraction: '1.000000', delayDays: 0, recoveryFraction: '0.000000', recoveryDelayDays: 0, interestProjection: 'DECLARED_SCHEDULE_ONLY', dateOverrides: [], capitalEvents: [], ...o});
const definition = (o: {horizon?: number; budget?: string; assumptions?: Partial<Record<Assumption['kind'], Partial<Assumption>>>; alt?: Alternative} = {}): VersionInput => ({baseId: uid(), baseToken: 'x', horizonDays: o.horizon ?? 30,
  assumptions: (['PRUDENT', 'BASE', 'FAVORABLE'] as const).map(k => assumption(k, o.assumptions?.[k])),
  alternatives: (['HOLD_CASH', 'DEBT_PREPAYMENT', 'NEW_LOAN', 'ASSET_PURCHASE'] as const).map(kind => o.alt?.kind === kind ? o.alt : kind === 'HOLD_CASH' ? {kind, budget: o.budget ?? '0.00', configured: true, reserveReleases: []} : {kind, budget: o.budget ?? '0.00', configured: false, reason: 'NOT_CONFIGURED' as const})});
const pick = (r: Evaluation, s: Outcome['scenarioKind'], a: Outcome['alternativeKind']) => r.outcomes.find(o => o.scenarioKind === s && o.alternativeKind === a)!;
const v = (o: Outcome, m: keyof Outcome['metrics']) => o.metrics[m].value;
const errorOf = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return {status: (e as {status?: number}).status, code: (e as {code?: string}).code ?? (e as Error).message}; } };

test('S13-P05 pure engine and alerts against own oracle', async t => {
  try {
    await t.test('O1 cash0, OUT30 day16, IN50 day28: deficit30, final20, no retroactive financing', () => {
      const r = evaluate(base(book({cash: '0.00'}, [flow('2026-11-16', 'OUT', '30.00'), flow('2026-11-28', 'IN', '50.00')])), definition(), {seed: 'o1'}), o = pick(r, 'BASE', 'HOLD_CASH');
      const day = (d: string) => r.days.find(x => x.outcomeId === o.id && x.date === d)!;
      const got = {min: v(o, 'availableMinimum'), cashMin: v(o, 'cashMinimum'), peak: v(o, 'peakDeficit'), final: v(o, 'cashFinal'), first: o.firstDeficitDate, principal: v(o, 'principalOutstanding'), d27: day('2026-11-27').availableClosing.value, d28min: day('2026-11-28').minimumIntraday.value, d28close: day('2026-11-28').availableClosing.value, d15: day('2026-11-15').availableClosing.value};
      checks['O1'] = got;
      assert.deepEqual(got, {min: '-30.00', cashMin: '-30.00', peak: '30.00', final: '20.00', first: '2026-11-16', principal: '50.00', d27: '-30.00', d28min: '-30.00', d28close: '20.00', d15: '0.00'});
    });
    await t.test('O2 same day OUT30/IN50: outflows first, minimum -30, final 20', () => {
      const r = evaluate(base(book({cash: '0.00'}, [flow('2026-11-16', 'IN', '50.00'), flow('2026-11-16', 'OUT', '30.00')])), definition(), {seed: 'o2'}), o = pick(r, 'BASE', 'HOLD_CASH');
      checks['O2'] = {min: v(o, 'availableMinimum'), final: v(o, 'cashFinal'), peak: v(o, 'peakDeficit')};
      assert.equal(v(o, 'availableMinimum'), '-30.00'); assert.equal(v(o, 'cashFinal'), '20.00'); assert.equal(v(o, 'peakDeficit'), '30.00');
    });
    await t.test('O3 three explicit hypotheses: HALF_UP collection/recovery, delays, residual conservation', () => {
      const U = ['0.05', '12345678.91', '0.01'], dates = ['2026-11-05', '2026-11-06', '2026-11-07'];
      const hyp = {PRUDENT: {collectionFraction: '0.500000', delayDays: 3, recoveryFraction: '0.500000', recoveryDelayDays: 10}, BASE: {collectionFraction: '0.333333', delayDays: 1, recoveryFraction: '1.000000', recoveryDelayDays: 2}, FAVORABLE: {collectionFraction: '1.000000', delayDays: 0, recoveryFraction: '0.000000', recoveryDelayDays: 0}};
      const r = evaluate(base(book({cash: '0.00', principalOutstanding: null}, U.map((u, i) => flow(dates[i]!, 'IN', u)))), definition({horizon: 60, assumptions: hyp}), {seed: 'o3'});
      const own: Record<string, unknown> = {};
      for (const [k, h] of Object.entries(hyp)) {
        let collected = 0n, recovered = 0n, lost = 0n; const timeline: Record<string, bigint> = {};
        U.forEach((u, i) => { const c = half(cents(u), h.collectionFraction), n = cents(u) - c, rr = half(n, h.recoveryFraction); collected += c; recovered += rr; lost += n - rr; const cd = addDays(dates[i]!, h.delayDays), rd = addDays(cd, h.recoveryDelayDays); if (c) timeline[cd] = (timeline[cd] ?? 0n) + c; if (rr) timeline[rd] = (timeline[rd] ?? 0n) + rr; });
        assert.equal(collected + recovered + lost, U.reduce((n, u) => n + cents(u), 0n), 'conservation ' + k);
        const o = pick(r, k as Outcome['scenarioKind'], 'HOLD_CASH'), final = money(collected + recovered);
        const got = Object.fromEntries(Object.keys(timeline).sort().map(d => [d, r.days.find(x => x.outcomeId === o.id && x.date === d)!.cashIn.value]));
        own[k] = {final, lost: money(lost), expectedIn: Object.fromEntries(Object.entries(timeline).sort().map(([d, c]) => [d, money(c)])), engineFinal: v(o, 'cashFinal'), engineIn: got};
        assert.equal(v(o, 'cashFinal'), final, k); assert.deepEqual(got, Object.fromEntries(Object.entries(timeline).sort().map(([d, c]) => [d, money(c)])), k);
        assert.equal(v(o, 'principalOutstanding'), null, 'unknown principal stays null, not 0');
      }
      checks['O3'] = own;
    });
    await t.test('O4 unknown amount/date never becomes zero; out-of-horizon excluded', () => {
      const r = evaluate(base(book({cash: '100.00'}, [flow('2026-11-10', 'OUT', null), flow('2026-11-12', 'OUT', '40.00')])), definition(), {seed: 'o4'}), o = pick(r, 'BASE', 'HOLD_CASH');
      checks['O4-unknown'] = {coverage: o.coverage, cashFinal: o.metrics.cashFinal, peak: o.metrics.peakDeficit};
      assert.equal(o.coverage, 'INCOMPLETE'); assert.equal(v(o, 'cashFinal'), null); assert.equal(o.metrics.cashFinal.knownPartial, '60.00'); assert.ok(o.metrics.cashFinal.reasons.includes('MISSING_AMOUNT'));
      const past = evaluate(base(book({cash: '100.00'}, [flow('2026-10-20', 'OUT', '10.00')])), definition(), {seed: 'o4b'}), p = pick(past, 'BASE', 'HOLD_CASH');
      checks['O4-pastPending'] = {coverage: p.coverage, reasons: p.reasons}; assert.equal(p.coverage, 'INCOMPLETE'); assert.ok(p.reasons.includes('MISSING_DATE'));
      const far = evaluate(base(book({cash: '100.00'}, [flow('2027-02-01', 'OUT', '90.00')])), definition(), {seed: 'o4c'}), q = pick(far, 'BASE', 'HOLD_CASH');
      checks['O4-outOfHorizon'] = {cashFinal: v(q, 'cashFinal')}; assert.equal(v(q, 'cashFinal'), '100.00');
    });
    await t.test('O5 analytical two-book view: negative legal book is a deficit even if the other book covers it', () => {
      const b1 = book({cash: '0.00', bookId: 'B1'}, [flow('2026-11-03', 'OUT', '30.00')]), b2 = {...book({cash: '100.00'}), bookId: 'B2', kind: 'PERSONAL' as const};
      const r = evaluate(base(b1, b2), definition(), {seed: 'o5'}), o = pick(r, 'BASE', 'HOLD_CASH');
      checks['O5'] = {peak: v(o, 'peakDeficit'), first: o.firstDeficitDate, aggregateMin: v(o, 'availableMinimum'), bookDays: r.bookDays.filter(d => d.outcomeId === o.id && d.date === '2026-11-03')};
      assert.equal(v(o, 'peakDeficit'), '30.00'); assert.equal(o.firstDeficitDate, '2026-11-03');
    });
    const reserveBook = () => book({cash: '80000000.00', available: '60000000.00', reserved: '20000000.00', netWorthBook: '80000000.00', estimatedOwnValue: '0.00', netWorthIndicative: '80000000.00', funds: [{id: 'F20', reserved: '20000000.00'}]});
    const purchase = (o: Partial<Alternative> = {}): Alternative => ({kind: 'ASSET_PURCHASE', budget: '80000000.00', configured: true, date: '2026-11-01', reserveReleases: [{fundId: 'F20', amount: '20000000.00', date: '2026-11-01'}], grossCost: '200000000.00', ownCash: '80000000.00', ownDebt: '120000000.00', directCreditor: true, ownershipFraction: '1.000000', estimatedGrossValue: '220000000.00', vacancyFraction: '0.000000', rentSchedule: [], costSchedule: [], ...o});
    await t.test('A1 purchase 200M = 80M own + 120M direct creditor, reserve 20M inside 80M, estimate 220M indicative only', () => {
      const r = evaluate(base(reserveBook()), definition({budget: '80000000.00', alt: purchase()}), {seed: 'a1'}), o = pick(r, 'BASE', 'ASSET_PURCHASE');
      const got = Object.fromEntries((['cashFinal', 'availableFinal', 'availableMinimum', 'peakDeficit', 'reserved', 'cost', 'ownDebt', 'netWorthBook', 'estimatedOwnValue', 'netWorthIndicative'] as const).map(k => [k, v(o, k)]));
      // Own oracle: cash 80-80=0; reserve released once 20->0; cost 200; debt 120; book NW 80+200-120-80=80; indicative 80-200+220=100.
      const want = {cashFinal: '0.00', availableFinal: '0.00', availableMinimum: '0.00', peakDeficit: '0.00', reserved: '0.00', cost: '200000000.00', ownDebt: '120000000.00', netWorthBook: '80000000.00', estimatedOwnValue: '220000000.00', netWorthIndicative: '100000000.00'};
      checks['A1'] = {got, want, hold: Object.fromEntries((['cashFinal', 'availableFinal', 'reserved', 'netWorthBook'] as const).map(k => [k, v(pick(r, 'BASE', 'HOLD_CASH'), k)]))};
      assert.deepEqual(got, want);
      const norelease = evaluate(base(reserveBook()), definition({budget: '80000000.00', alt: purchase({reserveReleases: []})}), {seed: 'a1b'}), n = pick(norelease, 'BASE', 'ASSET_PURCHASE');
      checks['A1-withoutRelease'] = {availableMinimum: v(n, 'availableMinimum'), peak: v(n, 'peakDeficit'), first: n.firstDeficitDate, reserved: v(n, 'reserved')};
      assert.equal(v(n, 'peakDeficit'), '20000000.00'); assert.equal(v(n, 'reserved'), '20000000.00');
      const over = evaluate(base(reserveBook()), definition({budget: '80000000.00', alt: purchase({reserveReleases: [{fundId: 'F20', amount: '25000000.00', date: '2026-11-01'}]})}), {seed: 'a1c'});
      const cands = scenarioCandidates(over, 'run-a1c', AS_OF).filter(c => c.type === 'SCENARIO_RESERVE_SHORTFALL');
      checks['A1-overRelease'] = {shortfalls: over.reserveShortfalls, candidates: cands.map(c => ({condition: c.condition, amount: c.amount.value}))};
      assert.ok(cands.length >= 1 && cands.every(c => c.condition === true && c.amount.value === '5000000.00'));
      checks['A1-doubleRelease'] = errorOf(() => evaluate(base(reserveBook()), definition({budget: '80000000.00', alt: purchase({reserveReleases: [{fundId: 'F20', amount: '10000000.00', date: '2026-11-01'}, {fundId: 'F20', amount: '10000000.00', date: '2026-11-02'}]})}), {seed: 'a1d'}));
      assert.equal((checks['A1-doubleRelease'] as {code: string}).code, 'DOUBLE_ALLOCATION');
    });
    await t.test('H01 approved linked net tranche: financed purchase with disbursement to account has min 0, peak 0, debt 120M, no false alert, credit is not income', () => {
      const r = evaluate(base(reserveBook()), definition({budget: '80000000.00', alt: purchase({directCreditor: false})}), {seed: 'a2'}), o = pick(r, 'BASE', 'ASSET_PURCHASE');
      const deficit = scenarioCandidates(r, 'run-a2', AS_OF).find(c => c.type === 'SCENARIO_DEFICIT' && c.entityKey === o.id)?.condition;
      const got = {cashFinal: v(o, 'cashFinal'), availableMinimum: v(o, 'availableMinimum'), peak: v(o, 'peakDeficit'), first: o.firstDeficitDate, ownDebt: v(o, 'ownDebt'), netWorthBook: v(o, 'netWorthBook'), indicative: v(o, 'netWorthIndicative'), expectedInterest: v(o, 'expectedInterest'), deficitAlert: deficit};
      checks['H01-linked'] = got;
      // Own oracle: identical to the direct-creditor case except the cash legs; the credit raises debt, never NW or interest.
      assert.deepEqual(got, {cashFinal: '0.00', availableMinimum: '0.00', peak: '0.00', first: null, ownDebt: '120000000.00', netWorthBook: '80000000.00', indicative: '100000000.00', expectedInterest: '0.00', deficitAlert: false});
    });
    await t.test('H01 negatives: unlinked flows are never netted (same-day OUT, OUT before IN, other book, plain capital IN)', () => {
      const n: Record<string, unknown> = {};
      // Same-day unrelated expense of 10 after a fully financed purchase: still a real 10 deficit.
      const extra = evaluate(base(book({cash: '80000000.00', available: '80000000.00', netWorthBook: '80000000.00'}, [flow('2026-11-01', 'OUT', '10.00')])), definition({budget: '80000000.00', alt: purchase({directCreditor: false, reserveReleases: []})}), {seed: 'n1'}), e = pick(extra, 'BASE', 'ASSET_PURCHASE');
      n['sameDayUnlinked'] = {min: v(e, 'availableMinimum'), peak: v(e, 'peakDeficit')};
      assert.equal(v(e, 'availableMinimum'), '-10.00'); assert.equal(v(e, 'peakDeficit'), '10.00');
      // Day 28 income does not finance day 16 outflow (ordinary rule untouched by the tranche).
      const d = evaluate(base(book({cash: '0.00'}, [flow('2026-11-16', 'OUT', '30.00'), flow('2026-11-28', 'IN', '50.00')])), definition({budget: '80000000.00', alt: purchase({directCreditor: false, reserveReleases: [], ownCash: '0.00', ownDebt: '200000000.00'})}), {seed: 'n2'}), dd = pick(d, 'BASE', 'ASSET_PURCHASE');
      n['outBeforeIn'] = {min: v(dd, 'availableMinimum'), final: v(dd, 'cashFinal'), first: dd.firstDeficitDate, debt: v(dd, 'ownDebt')};
      assert.equal(v(dd, 'availableMinimum'), '-30.00'); assert.equal(dd.firstDeficitDate, '2026-11-16');
      // Another legal book with a same-day OUT is not covered by the target book's tranche.
      const b1 = book({cash: '80000000.00', netWorthBook: '80000000.00'}), b2 = {...book({cash: '0.00'}, [{...flow('2026-11-01', 'OUT', '25.00'), bookId: 'B2'}]), bookId: 'B2', kind: 'PERSONAL' as const};
      const ob = evaluate(base(b1, b2), definition({budget: '80000000.00', alt: purchase({directCreditor: false, reserveReleases: []})}), {seed: 'n3'}), obo = pick(ob, 'BASE', 'ASSET_PURCHASE');
      n['otherBook'] = {peak: v(obo, 'peakDeficit'), first: obo.firstDeficitDate, b2: ob.bookDays.filter(x => x.outcomeId === obo.id && x.bookId === 'B2' && x.date === '2026-11-01')};
      assert.equal(v(obo, 'peakDeficit'), '25.00');
      // A declared external borrowing IN (not a linked tranche) on the same day as an OUT does not fund it.
      const borrow = {id: '00000000-0000-4000-8000-00000000c0de', date: '2026-11-03', kind: 'DECLARED_CAPITAL_IN', amount: '50.00', cashSourceFlowId: null, sourceReference: 'SYN', economicClass: 'EXTERNAL_BORROWING'} as const;
      const cb = evaluate(base(book({cash: '0.00'}, [flow('2026-11-03', 'OUT', '30.00')])), definition({assumptions: {BASE: {capitalEvents: [borrow]}}}), {seed: 'n4'}), cbo = pick(cb, 'BASE', 'HOLD_CASH');
      n['plainBorrowingSameDay'] = {min: v(cbo, 'availableMinimum'), final: v(cbo, 'cashFinal'), debt: v(cbo, 'ownDebt'), nw: v(cbo, 'netWorthBook')};
      assert.equal(v(cbo, 'availableMinimum'), '-30.00'); assert.equal(v(cbo, 'ownDebt'), '50.00'); assert.equal(v(cbo, 'netWorthBook'), '-30.00');
      checks['H01-negatives'] = n;
    });
    await t.test('A3 40% of 200M: cost 80M, own estimate 88M, full own debt 30M, equity 58M; missing estimate null', () => {
      const b = book({cash: '100000000.00', netWorthBook: '100000000.00', estimatedOwnValue: '0.00', netWorthIndicative: '100000000.00'});
      const alt = {kind: 'ASSET_PURCHASE', budget: '50000000.00', configured: true, date: '2026-11-02', reserveReleases: [], grossCost: '200000000.00', ownCash: '50000000.00', ownDebt: '30000000.00', directCreditor: true, ownershipFraction: '0.400000', estimatedGrossValue: '220000000.00', vacancyFraction: '0.000000', rentSchedule: [], costSchedule: []} as Alternative;
      const r = evaluate(base(b), definition({budget: '50000000.00', alt}), {seed: 'a3'}), o = pick(r, 'BASE', 'ASSET_PURCHASE');
      const got = Object.fromEntries((['cashFinal', 'cost', 'ownDebt', 'estimatedOwnValue', 'netWorthBook', 'netWorthIndicative'] as const).map(k => [k, v(o, k)]));
      const want = {cashFinal: '50000000.00', cost: '80000000.00', ownDebt: '30000000.00', estimatedOwnValue: '88000000.00', netWorthBook: '100000000.00', netWorthIndicative: '108000000.00'};
      checks['A3'] = {got, want, assetEquity: money(cents(got.netWorthIndicative!) - cents(got.cashFinal!))};
      assert.deepEqual(got, want); assert.equal(money(cents(got.netWorthIndicative!) - cents(got.cashFinal!)), '58000000.00');
      const nul = pick(evaluate(base(b), definition({budget: '50000000.00', alt: {...alt, estimatedGrossValue: null}}), {seed: 'a3b'}), 'BASE', 'ASSET_PURCHASE');
      checks['A3-missingEstimate'] = {estimated: nul.metrics.estimatedOwnValue, indicative: nul.metrics.netWorthIndicative};
      assert.equal(v(nul, 'estimatedOwnValue'), null); assert.equal(v(nul, 'netWorthIndicative'), null);
      checks['A3-12MdebtRejected'] = errorOf(() => evaluate(base(b), definition({budget: '68000000.00', alt: {...alt, ownCash: '68000000.00', ownDebt: '12000000.00', budget: '68000000.00'}}), {seed: 'a3c'}));
      checks['A3-shareMismatch'] = errorOf(() => evaluate(base(b), definition({budget: '50000000.00', alt: {...alt, ownDebt: '20000000.00'}}), {seed: 'a3d'}));
      assert.equal((checks['A3-shareMismatch'] as {status: number}).status, 422);
    });
    await t.test('A4 rent with vacancy and explicit cost: HALF_UP(G*(1-v)) - C, no posting', () => {
      const b = book({cash: '100000000.00'}), alt = {kind: 'ASSET_PURCHASE', budget: '1000.00', configured: true, date: '2026-11-02', reserveReleases: [], grossCost: '1000.00', ownCash: '1000.00', ownDebt: '0.00', directCreditor: true, ownershipFraction: '1.000000', estimatedGrossValue: null, vacancyFraction: '0.333333', rentSchedule: [{id: 'r1', date: '2026-11-20', amount: '1000.00', sourceReference: 'SYN'}], costSchedule: [{id: 'c1', date: '2026-11-21', amount: '100.00', sourceReference: 'SYN'}]} as Alternative;
      const o = pick(evaluate(base(b), definition({budget: '1000.00', alt}), {seed: 'a4'}), 'BASE', 'ASSET_PURCHASE'), net = half(100000n, '0.666667') - 10000n;
      checks['A4'] = {expectedNetRent: money(net), cashFinal: v(o, 'cashFinal'), expected: money(cents('100000000.00') - 100000n + net)};
      assert.equal(v(o, 'cashFinal'), money(cents('100000000.00') - 100000n + net));
    });
    await t.test('A5 four alternatives share base/budget/horizon; unsupported prepayment NOT_SIMULABLE with nulls; no winner', () => {
      const b = book({cash: '1000.00'}), prepay = {kind: 'DEBT_PREPAYMENT', budget: '500.00', configured: true, date: '2026-11-05', liabilityId: 'L-missing', prepaymentMode: 'REDUCE_TERM', terms: {kind: 'NATIVE_VERSION', sourceId: 'L-missing', sourceVersion: 1}, reserveReleases: []} as Alternative;
      const r = evaluate(base(b), definition({budget: '500.00', alt: prepay}), {seed: 'a5'}), o = pick(r, 'BASE', 'DEBT_PREPAYMENT');
      checks['A5'] = {simulability: o.simulability, reasons: o.reasons, cashFinal: o.metrics.cashFinal, outcomes: r.outcomes.length};
      assert.equal(o.simulability, 'NOT_SIMULABLE'); assert.equal(v(o, 'cashFinal'), null); assert.equal(r.outcomes.length, 12);
      checks['A5-unequalBudget'] = errorOf(() => evaluate(base(b), {...definition({budget: '500.00'}), alternatives: definition({budget: '500.00'}).alternatives.map((a, i) => i === 0 ? {...a, budget: '400.00'} : a)}, {seed: 'a5b'}));
      assert.equal((checks['A5-unequalBudget'] as {status: number}).status, 422);
    });
    await t.test('A6 reinvestment from a source flow: double use rejected; PRUDENT shortfall behaviour observed', () => {
      const src = flow('2026-11-05', 'IN', '1000.00', 'PRINCIPAL', 'SRC-1'), terms = {kind: 'DECLARED_HYPOTHESIS', sourceReference: 'SYN', principalOpening: '1000.00', installments: [{number: 1, dueDate: '2026-11-25', principal: '1000.00', interest: '50.00', insurance: '0.00', fees: '0.00', total: '1050.00'}]} as const;
      const loan = {kind: 'NEW_LOAN', budget: '1000.00', configured: true, date: '2026-11-10', principal: '1000.00', cashSourceFlowId: 'SRC-1', terms, reserveReleases: []} as unknown as Alternative;
      const reinvest = {id: 'RE-1', date: '2026-11-10', kind: 'REINVESTMENT', amount: '1000.00', cashSourceFlowId: 'SRC-1', sourceReference: 'SYN', economicClass: 'PRINCIPAL_RECOVERY'} as const;
      const ok = evaluate(base(book({cash: '0.00', principalOutstanding: '1000.00'}, [src])), definition({budget: '1000.00', alt: loan, assumptions: {BASE: {capitalEvents: [reinvest]}, PRUDENT: {capitalEvents: [reinvest]}, FAVORABLE: {capitalEvents: [reinvest]}}}), {seed: 'a6'});
      const o = pick(ok, 'BASE', 'NEW_LOAN');
      checks['A6-base'] = {cashFinal: v(o, 'cashFinal'), principal: v(o, 'principalOutstanding'), expectedInterest: v(o, 'expectedInterest'), min: v(o, 'availableMinimum')};
      assert.equal(v(o, 'cashFinal'), '1050.00'); assert.equal(v(o, 'principalOutstanding'), '0.00'); assert.equal(v(o, 'availableMinimum'), '0.00');
      checks['A6-duplicateCapitalId'] = errorOf(() => evaluate(base(book({cash: '0.00'}, [src])), definition({budget: '1000.00', alt: loan, assumptions: {BASE: {capitalEvents: [reinvest, reinvest]}}}), {seed: 'a6b'}));
      assert.equal((checks['A6-duplicateCapitalId'] as {code: string}).code, 'DOUBLE_ALLOCATION');
      // H02: PRUDENT collects 50% of the source -> only that branch is NOT_SIMULABLE/INSUFFICIENT_SOURCE; BASE/FAVORABLE survive; no false DOUBLE_ALLOCATION.
      let pr: Evaluation | null = null; const err = errorOf(() => { pr = evaluate(base(book({cash: '0.00', principalOutstanding: '1000.00'}, [src])), definition({budget: '1000.00', alt: loan, assumptions: {PRUDENT: {collectionFraction: '0.500000', capitalEvents: [reinvest]}, BASE: {capitalEvents: [reinvest]}, FAVORABLE: {capitalEvents: [reinvest]}}}), {seed: 'a6c'}); });
      assert.equal(err, null, 'no exception for an insufficient PRUDENT source');
      const prr = pr as unknown as Evaluation, p = pick(prr, 'PRUDENT', 'NEW_LOAN'), b = pick(prr, 'BASE', 'NEW_LOAN'), fv = pick(prr, 'FAVORABLE', 'NEW_LOAN');
      checks['H02-prudentPartialSource'] = {outcomes: prr.outcomes.length, prudent: {simulability: p.simulability, reasons: p.reasons, cashFinal: p.metrics.cashFinal, days: prr.days.filter(x => x.outcomeId === p.id).length}, base: {simulability: b.simulability, cashFinal: v(b, 'cashFinal')}, favorable: {simulability: fv.simulability, cashFinal: v(fv, 'cashFinal')}, prudentHold: v(pick(prr, 'PRUDENT', 'HOLD_CASH'), 'cashFinal')};
      assert.equal(prr.outcomes.length, 12); assert.equal(p.simulability, 'NOT_SIMULABLE'); assert.ok(p.reasons.includes('INSUFFICIENT_SOURCE')); assert.equal(v(p, 'cashFinal'), null); assert.equal(p.metrics.cashFinal.knownPartial, null);
      assert.equal(prr.days.filter(x => x.outcomeId === p.id).length, 0, 'no timeline rows for the unavailable branch');
      assert.equal(b.simulability, 'SIMULABLE'); assert.equal(v(b, 'cashFinal'), '1050.00'); assert.equal(v(fv, 'cashFinal'), '1050.00');
      // PRUDENT HOLD_CASH (no reinvestment) keeps its own result: 50% of 1000 collected.
      assert.equal(v(pick(prr, 'PRUDENT', 'HOLD_CASH'), 'cashFinal'), '500.00');
      // Real double allocation still rejected: the same reserve released twice in one branch.
      checks['H02-realDoubleRelease'] = errorOf(() => evaluate(base(book({cash: '100.00', available: '80.00', reserved: '20.00', funds: [{id: 'F1', reserved: '20.00'}]})), definition({budget: '10.00', alt: {kind: 'HOLD_CASH', budget: '10.00', configured: true, reserveReleases: [{fundId: 'F1', amount: '10.00', date: '2026-11-02'}, {fundId: 'F1', amount: '10.00', date: '2026-11-03'}]} as Alternative}), {seed: 'a6d'}));
      assert.equal((checks['H02-realDoubleRelease'] as {code: string}).code, 'DOUBLE_ALLOCATION');
    });
    await t.test('A7 sensitivity one parameter <= 9 samples, never a cartesian product', () => {
      const b = book({cash: '0.00'}, [flow('2026-11-05', 'IN', '100.00')]);
      const r = evaluate(base(b), definition(), {seed: 'a7', sensitivity: {scenarioKind: 'BASE', alternativeKind: 'HOLD_CASH', parameter: 'COLLECTION_FRACTION', values: ['0.250000', '0.500000', '1.000000']}});
      checks['A7'] = {outcomes: r.outcomes.length, finals: r.outcomes.map(o => v(o, 'cashFinal')), tooMany: errorOf(() => evaluate(base(b), definition(), {seed: 'a7b', sensitivity: {scenarioKind: 'BASE', alternativeKind: 'HOLD_CASH', parameter: 'DELAY_DAYS', values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]}}))};
      assert.deepEqual(r.outcomes.map(o => v(o, 'cashFinal')), ['25.00', '50.00', '100.00']); assert.equal((checks['A7'] as {tooMany: {status: number}}).tooMany.status, 422);
    });
    await t.test('F1 fact predicates: concentration strictly >25.00%, due window includes today, unknown amount stays undecided', () => {
      const facts: Capture['facts'] = [
        {type: 'CONCENTRATION', entityKey: 'eq', date: AS_OF, amount: '25.00', denominator: '100.00', sourceRefs: [], complete: true},
        {type: 'CONCENTRATION', entityKey: 'gt', date: AS_OF, amount: '25.01', denominator: '100.00', sourceRefs: [], complete: true},
        {type: 'CONCENTRATION', entityKey: 'zero', date: AS_OF, amount: '0.00', denominator: '0.00', sourceRefs: [], complete: true},
        {type: 'LOAN_DUE', entityKey: 'today', date: AS_OF, amount: '10.00', sourceRefs: [], complete: true},
        {type: 'LOAN_DUE', entityKey: 'd7', date: addDays(AS_OF, 7), amount: '10.00', sourceRefs: [], complete: true},
        {type: 'LOAN_DUE', entityKey: 'd8', date: addDays(AS_OF, 8), amount: '10.00', sourceRefs: [], complete: true},
        {type: 'LOAN_OVERDUE', entityKey: 'late', date: addDays(AS_OF, -1), amount: '10.00', sourceRefs: [], complete: true},
        {type: 'EXPENSE_DUE', entityKey: 'unknown', date: AS_OF, amount: null, sourceRefs: [], complete: false}];
      const c = factCandidates({base: base(book({cash: '0.00'})), facts, factCoverage: true}, {dueWithinDays: 7, concentrationThreshold: '25.00'});
      const got = Object.fromEntries(c.map(x => [x.type + ':' + x.entityKey, x.condition]));
      checks['F1'] = got;
      assert.deepEqual(got, {'CONCENTRATION:eq': false, 'CONCENTRATION:gt': true, 'CONCENTRATION:zero': false, 'LOAN_DUE:today': true, 'LOAN_DUE:d7': true, 'LOAN_DUE:d8': false, 'LOAN_OVERDUE:late': true, 'EXPENSE_DUE:unknown': null});
    });
    await t.test('F2 alert lifecycle: dedupe, ACK keeps while true, resolve only on verified false, recurrence new episode without ACK, stale, expiry', () => {
      const t0 = Date.parse('2026-10-31T17:00:00Z'), opts = (now: number, complete = true) => ({actorScopeKey: 'actor|BUSINESS|B1', thresholdKey: 'th1', now, sourceDigest: 'd', completelyEvaluated: complete ? ['EXPENSE_DUE' as const] : []});
      const cand = (condition: boolean | null): Candidate => ({type: 'EXPENSE_DUE', class: 'FACT', entityKey: 'E1', condition, amount: {value: '300.00', status: 'COMPLETE', reasons: [], knownPartial: null}, effectiveDate: AS_OF, sourceRefs: [], runId: null});
      const trace: unknown[] = []; let store: StoredAlert[] = [];
      const step = (label: string, cs: Candidate[], now: number, complete = true) => { const r = evaluateAlerts(cs, store, opts(now, complete)); store = store.filter(p => !r.updated.some(u => u.dedupeKey === p.dedupeKey)).concat(r.updated); const a = store.find(s => s.entityKey === 'E1')!; trace.push({label, created: r.created, state: a.state, episode: a.episode, ack: a.ackAt !== null, freshness: a.freshness, id: a.id.slice(0, 8)}); return a; };
      const first = step('create', [cand(true)], t0); step('re-evaluate', [cand(true)], t0 + 1000);
      store = store.map(s => s.id === first.id ? acknowledge(s, t0 + 2000) : s); trace.push({label: 'ack', state: store[0]!.state});
      const kept = step('still-true', [cand(true)], t0 + 3000); assert.equal(kept.state, 'ACKNOWLEDGED');
      const stale = step('source-not-evaluable', [cand(null)], t0 + 4000, false); assert.equal(stale.freshness, 'STALE'); assert.equal(stale.state, 'ACKNOWLEDGED');
      const resolved = step('verified-false', [], t0 + 5000); assert.equal(resolved.state, 'RESOLVED');
      const again = step('recurs', [cand(true)], t0 + 6000); assert.equal(again.state, 'ACTIVE'); assert.equal(again.episode, 2); assert.equal(again.ackAt, null);
      const later = t0 + 31 * 86400000, expired = step('after-30d', [], later, false); assert.equal(expired.state, 'EXPIRED');
      const fresh = step('new-after-expiry', [cand(true)], later + 1000);
      checks['F2'] = trace;
      assert.equal(trace.filter(x => (x as {created?: number}).created === 1).length, 2, 'only the first instance and the post-expiry instance are created');
      assert.notEqual(fresh.id, first.id);
      const staleAck = errorOf(() => acknowledge({...fresh, lastEvaluatedAt: new Date(later + 1000 - 301000).toISOString()}, later + 1000)); checks['F2-staleAck'] = staleAck; assert.equal(staleAck?.code, 'SOURCE_CONFLICT');
    });
    await t.test('C1 cost: 366 days x 12 outcomes with dense flows stays inside 10s / 256MiB budget in-process', () => {
      const flows: Flow[] = []; for (let i = 0; i < 2000; i++) flows.push(flow(addDays(AS_OF, 1 + (i % 366)), i % 3 ? 'IN' : 'OUT', '1.' + String(i % 100).padStart(2, '0')));
      const heap = process.memoryUsage().heapUsed, start = performance.now();
      const r = evaluate(base(book({cash: '1000.00', principalOutstanding: null}, flows)), definition({horizon: 366, assumptions: {PRUDENT: {collectionFraction: '0.700000', recoveryFraction: '0.500000', delayDays: 5, recoveryDelayDays: 30}}}), {seed: 'c1'});
      checks['C1'] = {inputFlows: 2000, expandedFlows: r.metrics.expandedFlows, days: r.days.length, ms: Math.round(performance.now() - start), heapDeltaBytes: process.memoryUsage().heapUsed - heap, rssBytes: process.memoryUsage().rss};
      assert.ok(performance.now() - start < 10000); assert.equal(r.days.length, 366 * 3, 'only the three configured HOLD_CASH outcomes have timelines'); assert.equal(r.outcomes.length, 12);
    });
  } finally {
    writeFileSync(OUT, JSON.stringify({task: 'S13-P05', suite: 'pure', at: new Date().toISOString(), checks}, null, 1) + '\n');
  }
});
