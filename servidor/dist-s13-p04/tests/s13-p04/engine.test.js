import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../../src/modules/simulation/engine.js';
import { base, definition, flow, uid } from './oracle.js';
import { scenarioCandidates } from '../../src/modules/simulation/alerts.js';
import { portion } from '../../src/modules/simulation/money.js';
test('future inflows do not fund earlier or same-day outflows; independent expected prefix arithmetic', () => {
    for (const incomingDate of ['2026-11-28', '2026-11-16']) {
        const b = base([flow(10, '2026-11-16', 'OUT', '30.00'), flow(11, incomingDate, 'IN', '50.00', 'INTEREST_UNRECOGNIZED')]);
        const result = evaluate(b, definition(), { seed: 'fixed' }), o = result.outcomes[0];
        assert.equal(o.metrics.availableMinimum.value, '-30.00');
        assert.equal(o.metrics.availableFinal.value, '20.00');
        assert.equal(o.metrics.peakDeficit.value, '30.00');
        assert.equal(o.firstDeficitDate, '2026-11-16');
        const again = evaluate(b, definition(), { seed: 'fixed' });
        assert.deepEqual({ ...result, metrics: null }, { ...again, metrics: null });
    }
});
test('200M purchase uses reserved20M +free60M +direct debt120M, valuation substitutes and never creates cash', () => {
    const b = base([], { cashBook: '80000000.00', available: '60000000.00', reserved: '20000000.00', netWorthBook: '80000000.00', netWorthIndicative: '80000000.00', funds: [{ id: uid(30), reserved: '20000000.00' }] });
    const d = definition({ kind: 'ASSET_PURCHASE', configured: true, budget: '80000000.00', date: '2026-11-02', reserveReleases: [{ fundId: uid(30), amount: '20000000.00', date: '2026-11-02' }], grossCost: '200000000.00', ownCash: '80000000.00', ownDebt: '120000000.00', directCreditor: true, ownershipFraction: '1.000000', estimatedGrossValue: '220000000.00', vacancyFraction: '0.000000', rentSchedule: [], costSchedule: [] });
    const o = evaluate(b, d, { seed: 'asset' }).outcomes.find(o => o.alternativeKind === 'ASSET_PURCHASE');
    assert.equal(o.metrics.cashFinal.value, '0.00');
    assert.equal(o.metrics.availableMinimum.value, '0.00');
    assert.equal(o.metrics.peakDeficit.value, '0.00');
    assert.equal(o.metrics.cost.value, '200000000.00');
    assert.equal(o.metrics.ownDebt.value, '120000000.00');
    assert.equal(o.metrics.netWorthBook.value, '80000000.00');
    assert.equal(o.metrics.netWorthIndicative.value, '100000000.00');
    assert.equal(o.metrics.expectedInterest.value, '0.00');
});
test('unknown money/dates remain null; zero collection does not destroy principal; historical terms remain uncomputable', () => {
    const b = base([flow(21, '2026-11-16', 'OUT', null)]);
    const r = evaluate(b, definition(), { seed: 'unknown' });
    assert.equal(r.outcomes[0].metrics.availableFinal.value, null);
    assert.equal(r.outcomes[0].coverage, 'INCOMPLETE');
    const p = base([flow(22, '2026-11-28', 'IN', '100.00', 'PRINCIPAL')], { principalOutstanding: '100.00' }), d = definition();
    for (const a of d.assumptions)
        a.collectionFraction = '0';
    const o = evaluate(p, d, { seed: 'zero' }).outcomes[0];
    assert.equal(o.metrics.principalOutstanding.value, '100.00');
    assert.equal(o.metrics.cashFinal.value, '0.00');
    assert.equal(evaluate(p, definition({ kind: 'DEBT_PREPAYMENT', budget: '10.00', configured: true, date: '2026-11-02', liabilityId: uid(99), prepaymentMode: 'REDUCE_TERM', reserveReleases: [], terms: { kind: 'NATIVE_VERSION', sourceId: uid(99), sourceVersion: 1 } }), { seed: 'missing' }).outcomes[1].simulability, 'NOT_SIMULABLE');
});
test('cancellation callback interrupts pure work without publishing result, and invalid hypotheses fail before evaluation', () => {
    let checks = 0;
    assert.throws(() => evaluate(base(), definition(), { seed: 'cancel', budget: () => { if (++checks > 3)
            throw Error('cancelled'); } }), /cancelled/);
    const d = definition();
    d.horizonDays = 367;
    assert.throws(() => evaluate(base(), d, { seed: 'too-long' }));
});
test('HALF_UP component rounding conserves three cents and nine sensitivity samples stay separate', () => {
    assert.equal(portion(1n, '0.5'), 1n);
    assert.equal(portion(-1n, '0.5'), -1n);
    assert.equal(portion(10001n, '0.4'), 4000n);
    const b = base([flow(70, '2026-11-01', 'IN', '0.03', 'PRINCIPAL')], { principalOutstanding: '0.03' }), d = definition();
    for (const a of d.assumptions) {
        a.collectionFraction = '0.5';
        a.recoveryFraction = '0.5';
        a.recoveryDelayDays = 1;
    }
    const r = evaluate(b, d, { seed: 'round' });
    assert.equal(r.outcomes[0].metrics.cashFinal.value, '0.03');
    assert.equal(r.outcomes[0].metrics.principalOutstanding.value, '0.00');
    const s = evaluate(b, d, { seed: 'sensitivity', sensitivity: { parameter: 'COLLECTION_FRACTION', scenarioKind: 'BASE', alternativeKind: 'HOLD_CASH', values: ['0', '0.1', '0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '1'] } });
    assert.equal(s.outcomes.length, 9);
    assert.equal(s.days.length, 270);
});
test('40% ownership retains full own debt30M and yields indicative equity58M, without cash from estimate', () => {
    const b = base([], { cashBook: '50000000.00', available: '50000000.00', netWorthBook: '50000000.00', netWorthIndicative: '50000000.00' }), d = definition({ kind: 'ASSET_PURCHASE', configured: true, budget: '50000000.00', date: '2026-11-01', reserveReleases: [], grossCost: '200000000.00', ownCash: '50000000.00', ownDebt: '30000000.00', directCreditor: true, ownershipFraction: '0.4', estimatedGrossValue: '220000000.00', vacancyFraction: '0', rentSchedule: [], costSchedule: [] });
    const o = evaluate(b, d, { seed: '40percent' }).outcomes.find(o => o.alternativeKind === 'ASSET_PURCHASE');
    assert.equal(o.metrics.cost.value, '80000000.00');
    assert.equal(o.metrics.estimatedOwnValue.value, '88000000.00');
    assert.equal(o.metrics.ownDebt.value, '30000000.00');
    assert.equal(o.metrics.netWorthIndicative.value, '58000000.00');
    assert.equal(o.metrics.cashFinal.value, '0.00');
});
test('insufficient hypothetical reserve emits a shortfall and cannot release HELD or manufacture cash', () => {
    const b = base([], { cashBook: '10.00', available: '0.00', reserved: '10.00', held: '99.00', funds: [{ id: uid(80), reserved: '10.00' }] }), d = definition();
    d.alternatives[0].reserveReleases = [{ fundId: uid(80), amount: '20.00', date: '2026-11-01' }];
    const r = evaluate(b, d, { seed: 'reserve' });
    assert.equal(r.reserveShortfalls?.[0]?.amount, '10.00');
    assert.ok(scenarioCandidates(r, uid(81), b.asOf).some(c => c.type === 'SCENARIO_RESERVE_SHORTFALL'));
    assert.equal(r.outcomes[0].metrics.availableFinal.value, null);
    assert.equal(r.outcomes[0].metrics.availableFinal.knownPartial, '10.00');
    assert.equal(r.days[0].held.knownPartial, '99.00');
});
test('leap year366, year boundary and legal-book deficits preserve dates and do not pool funding', () => {
    const b = base([], { cashBook: '0.00', available: '0.00' });
    b.asOf = '2027-12-31';
    b.books[0].flows = [flow(85, '2028-02-29', 'OUT', '30.00'), flow(86, '2028-03-01', 'IN', '50.00', 'INTEREST_UNRECOGNIZED')];
    b.books.push({ ...structuredClone(b.books[0]), kind: 'PERSONAL', bookId: uid(88), cashBook: '100.00', available: '100.00', flows: [] });
    const d = definition();
    d.horizonDays = 366;
    const r = evaluate(b, d, { seed: 'leap' });
    assert.equal(r.days[365].date, '2028-12-31');
    assert.equal(r.outcomes[0].firstDeficitDate, '2028-02-29');
    assert.equal(r.outcomes[0].metrics.peakDeficit.value, '30.00');
    assert.ok(r.bookDays.some(d => d.bookId === b.targetBookId && d.minimum === '-30.00'));
});
test('an alternative outside the horizon is explicitly not simulable rather than receiving zero effects', () => {
    const d = definition({ kind: 'ASSET_PURCHASE', configured: true, budget: '1.00', date: '2027-01-01', reserveReleases: [], grossCost: '1.00', ownCash: '1.00', ownDebt: '0.00', directCreditor: true, ownershipFraction: '1.000000', estimatedGrossValue: null, vacancyFraction: '0.000000', rentSchedule: [], costSchedule: [] });
    const r = evaluate(base(), d, { seed: 'outside' });
    assert.equal(r.outcomes.find(o => o.alternativeKind === 'ASSET_PURCHASE').simulability, 'NOT_SIMULABLE');
    d.alternatives[3].date = '2026-11-01';
    d.alternatives[3].rentSchedule = [{ id: uid(95), date: '2026-11-02', amount: '1.00', sourceReference: 'SYN' }, { id: uid(95), date: '2026-11-02', amount: '1.00', sourceReference: 'SYN' }];
    assert.throws(() => evaluate(base(), d, { seed: 'duplicate' }), /DOUBLE_ALLOCATION/);
});
test('H01 approved linked tranche: debt120M is neither temporary deficit nor income', () => {
    const b = base([], { cashBook: '80000000.00', available: '80000000.00', netWorthBook: '80000000.00', netWorthIndicative: '80000000.00' }), d = definition({ kind: 'ASSET_PURCHASE', configured: true, budget: '80000000.00', date: '2026-11-02', reserveReleases: [], grossCost: '200000000.00', ownCash: '80000000.00', ownDebt: '120000000.00', directCreditor: false, ownershipFraction: '1.000000', estimatedGrossValue: '220000000.00', vacancyFraction: '0.000000', rentSchedule: [], costSchedule: [] });
    const r = evaluate(b, d, { seed: 'H01' });
    for (const o of r.outcomes.filter(o => o.alternativeKind === 'ASSET_PURCHASE')) {
        assert.equal(o.metrics.availableMinimum.value, '0.00');
        assert.equal(o.metrics.cashMinimum.value, '0.00');
        assert.equal(o.metrics.peakDeficit.value, '0.00');
        assert.equal(o.metrics.ownDebt.value, '120000000.00');
        assert.equal(o.metrics.netWorthBook.value, '80000000.00');
        assert.equal(o.metrics.netWorthIndicative.value, '100000000.00');
        assert.equal(o.metrics.expectedInterest.value, '0.00');
    }
    assert.equal(scenarioCandidates(r, uid(89), b.asOf).some(a => a.type === 'SCENARIO_DEFICIT' && a.condition === true), false);
});
test('H02 one insufficient source branch preserves other outcomes and unknown is never zero', () => {
    const f = flow(210, '2026-11-02', 'IN', '500.00', 'PRINCIPAL'), b = base([f], { principalOutstanding: '500.00' }), d = definition({ kind: 'NEW_LOAN', configured: true, budget: '500.00', date: '2026-11-03', reserveReleases: [], principal: '500.00', cashSourceFlowId: f.sourceKey, terms: { kind: 'DECLARED_HYPOTHESIS', sourceReference: 'SYN', principalOpening: '500.00', installments: [{ number: 1, dueDate: '2026-11-20', principal: '500.00', interest: '0.00', insurance: '0.00', fees: '0.00', total: '500.00' }] } });
    d.assumptions[0].collectionFraction = '0.500000';
    const r = evaluate(b, d, { seed: 'H02' });
    assert.equal(r.outcomes.length, 12);
    const o = r.outcomes.find(o => o.scenarioKind === 'PRUDENT' && o.alternativeKind === 'NEW_LOAN');
    assert.equal(o.simulability, 'NOT_SIMULABLE');
    assert.deepEqual(o.reasons, ['INSUFFICIENT_SOURCE']);
    assert.equal(o.metrics.availableFinal.value, null);
    assert.equal(r.days.some(v => v.outcomeId === o.id), false);
    for (const k of ['BASE', 'FAVORABLE'])
        assert.equal(r.outcomes.find(o => o.scenarioKind === k && o.alternativeKind === 'NEW_LOAN').simulability, 'SIMULABLE');
    const sensitivity = evaluate(b, d, { seed: 'H02samples', sensitivity: { parameter: 'COLLECTION_FRACTION', scenarioKind: 'BASE', alternativeKind: 'NEW_LOAN', values: ['0.5', '1'] } });
    assert.deepEqual(sensitivity.outcomes.map(o => o.simulability), ['NOT_SIMULABLE', 'SIMULABLE']);
});
test('linked financing cannot cover an unrelated same-day expense', () => {
    const b = base([flow(300, '2026-11-02', 'OUT', '30.00')], { cashBook: '80.00', available: '80.00', netWorthBook: '80.00', netWorthIndicative: '80.00' }), d = definition({ kind: 'ASSET_PURCHASE', configured: true, budget: '80.00', date: '2026-11-02', reserveReleases: [], grossCost: '200.00', ownCash: '80.00', ownDebt: '120.00', directCreditor: false, ownershipFraction: '1.000000', estimatedGrossValue: '220.00', vacancyFraction: '0.000000', rentSchedule: [], costSchedule: [] });
    const o = evaluate(b, d, { seed: 'unrelated' }).outcomes.find(o => o.alternativeKind === 'ASSET_PURCHASE');
    assert.equal(o.metrics.availableMinimum.value, '-30.00');
    assert.equal(o.metrics.peakDeficit.value, '30.00');
    assert.equal(o.metrics.cashFinal.value, '-30.00');
});
test('explicit funding arriving after the new loan never becomes retroactive branch funding', () => {
    const source = flow(401, '2026-11-04', 'IN', '500.00', 'PRINCIPAL'), b = base([source], { principalOutstanding: '500.00' }), d = definition({ kind: 'NEW_LOAN', configured: true, budget: '500.00', date: '2026-11-03', reserveReleases: [], principal: '500.00', cashSourceFlowId: source.id, terms: { kind: 'DECLARED_HYPOTHESIS', sourceReference: 'SYN-LATE', principalOpening: '500.00', installments: [{ number: 1, dueDate: '2026-11-20', principal: '500.00', interest: '0.00', insurance: '0.00', fees: '0.00', total: '500.00' }] } }), result = evaluate(b, d, { seed: 'R06' });
    for (const o of result.outcomes.filter(o => o.alternativeKind === 'NEW_LOAN')) {
        assert.equal(o.simulability, 'NOT_SIMULABLE');
        assert.deepEqual(o.reasons, ['INSUFFICIENT_SOURCE']);
        assert.equal(o.metrics.availableFinal.value, null);
        assert.equal(result.days.some(d => d.outcomeId === o.id), false);
    }
});
test('untrusted linked pairs for another book, date or purchase cannot receive atomic netting', () => {
    for (const variant of ['book', 'date', 'purchase']) {
        const incoming = { ...flow(410, '2026-11-02', 'IN', '120.00', 'CAPITAL'), linkedTranche: 'untrusted-pair', debtCash: true, entityId: 'asset-credit-cash' }, outgoing = { ...flow(411, variant === 'date' ? '2026-11-03' : '2026-11-02', 'OUT', '120.00', 'CAPITAL'), linkedTranche: 'untrusted-pair', assetCash: true, entityId: variant === 'purchase' ? 'another-purchase' : 'asset-credit-use' }, b = base([incoming, ...(variant === 'book' ? [] : [outgoing])], { cashBook: '80.00', available: '80.00', netWorthBook: '80.00', netWorthIndicative: '80.00' });
        if (variant === 'book')
            b.books.push({ ...structuredClone(b.books[0]), bookId: uid(412), kind: 'PERSONAL', flows: [{ ...outgoing, bookId: uid(412) }] });
        const d = definition({ kind: 'ASSET_PURCHASE', configured: true, budget: '80.00', date: '2026-11-02', reserveReleases: [], grossCost: '200.00', ownCash: '80.00', ownDebt: '120.00', directCreditor: false, ownershipFraction: '1.000000', estimatedGrossValue: '220.00', vacancyFraction: '0.000000', rentSchedule: [], costSchedule: [] });
        assert.throws(() => evaluate(b, d, { seed: 'R08-' + variant, sensitivity: { parameter: 'COLLECTION_FRACTION', scenarioKind: 'BASE', alternativeKind: 'ASSET_PURCHASE', values: ['1'] } }), (e) => e instanceof Error && 'code' in e && e.code === 'INPUT_INVALID');
    }
});
//# sourceMappingURL=engine.test.js.map