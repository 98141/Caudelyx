/* eslint-disable security/detect-object-injection -- Own fixed symbol map, never request input. */
// S06-P05 O01 (Claude): the own S6 oracle reproduces the documentary REFERENCE_CASES_S06 money (postings, balances,
// installments, credit, held/custody states) for the economic cases, computed from the approved rules only. Pure: no Mongo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { S6Book, OracleError, c, m, terms } from './oracle.js';

type Case = { id: string; postings?: { account: string; debit: string; credit: string }[]; after: Record<string, string | number>; expectedError?: string };
const cases = new Map((JSON.parse(readFileSync(resolve('../../Construccion/Sprints/S06/Contratos/REFERENCE_CASES_S06.json'), 'utf8')) as { cases: Case[] }).cases.map(x => [x.id, x]));
const SYM: Record<string, string> = { PRINCIPAL: 'P', INTEREST_RECEIVABLE: 'I', INTEREST_INCOME: 'Y', BORROWER_CREDIT: 'C', HELD: 'HELD_FUNDS', BANK: 'BANK', CASH_C: 'CASH_CUSTODIAN' };
const fmt = (p: { account: string; debit: bigint; credit: bigint }[]) => p.map(x => ({ account: SYM[x.account] ?? x.account, debit: m(x.debit), credit: m(x.credit) })).sort((a, b) => a.account.localeCompare(b.account));
const doc = (id: string) => [...cases.get(id)!.postings!].map(x => ({ ...x })).sort((a, b) => a.account.localeCompare(b.account));
const T = '2026-10-31';
/** Book with loan L1 (CP 2M/4/3% monthly) disbursed and installment 1 (60k interest) accrued: the RC01/RC06/RC08/RC11 'before'. */
function base(rate = '0.030000000000', principal = '2000000.00', extra: Record<string, unknown> = {}) {
  const b = new S6Book(); b.fund('FUND', c('20000000.00')); b.addLoan('L1', 'B1', terms({ rate: { type: 'EFFECTIVE', unit: 'MONTH', value: rate }, principal, ...extra }) as never); b.disburse('L1', 'FUND'); return b;
}
const pay = (method: 'CASH' | 'BANK', amount: string, targets: { loan: string; amount: string; mode?: 'REGULAR' | 'EXTRA_PRINCIPAL' }[], mode: 'DIRECT' | 'SUPERVISED' = 'SUPERVISED', registrar = 'O1') => ({
  method, mode, borrower: 'B1', amount: c(amount), account: method === 'CASH' ? 'CASH_C' : 'BANK', targets: targets.map(t => ({ loan: t.loan, amount: c(t.amount), mode: t.mode ?? 'REGULAR' as const })), excess: 'CREDIT' as const, registrar, custodian: method === 'CASH' ? registrar : null });
const out: Record<string, unknown> = {};

test('P06-O01 own S6 oracle reproduces REFERENCE_CASES_S06 money', () => {
  // RC01 / RC13: supervised CASH 300k, distinct approver: I60k + P240k, custody CONFIRMED_HELD, provisional gone, no income.
  for (const id of ['RC01', 'RC13']) {
    const b = base(); b.accrueEvent('L1', T, T);
    assert.equal(b.register('p1', pay('CASH', '300000.00', [{ loan: 'L1', amount: '300000.00' }], 'SUPERVISED', id === 'RC13' ? 'C1' : 'O1'), T), null);
    assert.equal(b.balances.get('CASH_C') ?? 0n, 0n, 'pending creates no ledger asset');
    assert.throws(() => b.approve('p1', id === 'RC13' ? 'C1' : 'O1', T), (e: unknown) => e instanceof OracleError && e.code === 'SEGREGATION_REQUIRED');
    const s = b.approve('p1', 'T1', T); assert.deepEqual(fmt(s.postings), doc(id), id);
    assert.equal(m(b.loans.get('L1')!.pOut), cases.get(id)!.after['principal']); assert.equal(b.payments.get('p1')!.custody, 'CONFIRMED_HELD'); assert.equal(m(b.available('CASH_C')), '0.00');
    out[id] = { postings: fmt(s.postings), principal: m(b.loans.get('L1')!.pOut), available: m(b.available('CASH_C')) };
  }
  // RC04: BANK DIRECT 100k of an already accrued 100k interest (5% monthly on 2M): no second income.
  { const b = base('0.050000000000'); b.accrueEvent('L1', T, T); const y0 = b.balances.get('INTEREST_INCOME')!;
    const s = b.register('p4', pay('BANK', '100000.00', [{ loan: 'L1', amount: '100000.00' }], 'DIRECT', 'T1'), T)!; assert.deepEqual(fmt(s.postings), doc('RC04'));
    assert.equal(b.balances.get('INTEREST_INCOME'), y0, 'no second income'); out['RC04'] = fmt(s.postings); }
  // RC10: zero-interest 2M fully due recovered without income.
  { const b = new S6Book(); b.fund('FUND', c('20000000.00')); b.addLoan('L1', 'B1', terms({ installmentCount: 1, firstDueDate: '2026-10-31', rate: { type: 'EFFECTIVE', unit: 'MONTH', value: '0.000000000000' } }) as never); b.disburse('L1', 'FUND');
    const s = b.register('p10', pay('BANK', '2000000.00', [{ loan: 'L1', amount: '2000000.00' }], 'DIRECT', 'T1'), T)!; assert.deepEqual(fmt(s.postings), doc('RC10')); assert.equal(b.loans.get('L1')!.status, 'SETTLED');
    assert.equal(b.balances.get('INTEREST_INCOME') ?? 0n, 0n); out['RC10'] = { postings: fmt(s.postings), status: b.loans.get('L1')!.status }; }
  // RC06: BANK 400k (budget 300k, 100k to C) then reversal: Dr I60/P240/C100, Cr HELD400; Y60 retained; reconciliation INVESTIGATION.
  { const b = base(); const r = b.register('p6', pay('BANK', '400000.00', [{ loan: 'L1', amount: '300000.00' }], 'DIRECT', 'T1'), T)!;
    assert.deepEqual(fmt(r.postings), [{ account: 'BANK', debit: '400000.00', credit: '0.00' }, { account: 'C', debit: '0.00', credit: '100000.00' }, { account: 'P', debit: '0.00', credit: '240000.00' }, { account: 'Y', debit: '0.00', credit: '60000.00' }]);
    const y = b.balances.get('INTEREST_INCOME'), s = b.reverse(b.events.find(e => e.payment === 'p6')!.seq, T); assert.deepEqual(fmt(s.postings), doc('RC06'));
    assert.equal(b.balances.get('INTEREST_INCOME'), y, 'accrual kept'); assert.equal(m(b.credit.get('B1') ?? 0n), '0.00'); assert.equal(m(b.loans.get('L1')!.pOut), '2000000.00');
    assert.equal(b.payments.get('p6')!.reconciliation, 'INVESTIGATION'); assert.equal(m(b.available('BANK')), '0.00'); out['RC06'] = fmt(s.postings); }
  // RC08: auto-accrual 60k inside the 300k receipt is legitimate and survives the reversal.
  { const b = base(); const r = b.register('p8', pay('BANK', '300000.00', [{ loan: 'L1', amount: '300000.00' }], 'DIRECT', 'T1'), T)!;
    assert.deepEqual(fmt(r.postings), [{ account: 'BANK', debit: '300000.00', credit: '0.00' }, { account: 'P', debit: '0.00', credit: '240000.00' }, { account: 'Y', debit: '0.00', credit: '60000.00' }], 'original netted (I nets to 0)');
    const s = b.reverse(b.events.find(e => e.payment === 'p8')!.seq, T); assert.deepEqual(fmt(s.postings), doc('RC08')); assert.equal(m(b.balances.get('INTEREST_INCOME')!), '-60000.00'); out['RC08'] = fmt(s.postings); }
  // RC11: CASH 300k reversal: custody HELD_UNALLOCATED, reserve moves from confirmed custody to HELD, never 600.
  { const b = base(); b.accrueEvent('L1', T, T); b.register('p11', pay('CASH', '300000.00', [{ loan: 'L1', amount: '300000.00' }]), T); b.approve('p11', 'T1', T);
    const s = b.reverse(b.events.find(e => e.payment === 'p11')!.seq, T); assert.deepEqual(fmt(s.postings), doc('RC11'));
    assert.equal(b.payments.get('p11')!.custody, 'HELD_UNALLOCATED'); assert.equal(m(b.available('CASH_C')), '0.00'); assert.equal(m(b.balances.get('CASH_C')!), '300000.00'); out['RC11'] = fmt(s.postings); }
  // RC05 / NC02: receipt 400 with C100, APPLY_CREDIT 50 → reversing the receipt is blocked; reversing the application restores C.
  { const b = base(); b.register('p5', pay('BANK', '400000.00', [{ loan: 'L1', amount: '300000.00' }], 'DIRECT', 'T1'), T); const ac = b.applyCredit('B1', c('50000.00'), [{ loan: 'L1', amount: c('50000.00'), mode: 'REGULAR' }], T);
    assert.equal(m(ac.creditApplied), '50000.00');
    assert.throws(() => b.reverse(b.events.find(e => e.payment === 'p5')!.seq, T), (e: unknown) => e instanceof OracleError && e.code === 'REVERSAL_DEPENDENCY');
    const s = b.reverse(b.events.length, T); assert.deepEqual(fmt(s.postings), doc('RC05')); assert.equal(m(b.credit.get('B1')!), '100000.00'); assert.equal(m(b.loans.get('L1')!.pOut), '1760000.00'); out['RC05'] = fmt(s.postings); }
  // NC03: receiving account below existing reserves + amount → FUNDS_NOT_HELD.
  { const b = base(); b.register('pa', pay('BANK', '300000.00', [{ loan: 'L1', amount: '300000.00' }], 'DIRECT', 'T1'), T); b.spend('BANK', c('100000.00'), 'OUT');
    assert.throws(() => b.reverse(b.events.find(e => e.payment === 'pa')!.seq, T), (e: unknown) => e instanceof OracleError && e.code === 'FUNDS_NOT_HELD'); out['NC03'] = 'FUNDS_NOT_HELD'; }
  // RC09: CP 1000/4/1%, receipt 360 EXTRA on the due date: I10/P250/X100 then reversal restores v3 = original future rows.
  { const b = base('0.010000000000', '1000.00'); const r = b.register('p9', pay('BANK', '360.00', [{ loan: 'L1', amount: '360.00', mode: 'EXTRA_PRINCIPAL' }], 'DIRECT', 'T1'), T)!;
    const future = b.installments('L1').filter(x => x.dueDate > T).map(x => ({ date: x.dueDate, principal: x.principal, interest: x.interest }));
    assert.deepEqual(future, [{ date: '2026-11-30', principal: '216.66', interest: '6.50' }, { date: '2026-12-31', principal: '216.66', interest: '4.33' }, { date: '2027-01-31', principal: '216.68', interest: '2.17' }]);
    const s = b.reverse(b.events.find(e => e.payment === 'p9')!.seq, T); assert.deepEqual(fmt(s.postings), doc('RC09'));
    assert.equal(b.loans.get('L1')!.version, 3); assert.deepEqual(b.installments('L1').filter(x => x.dueDate > T).map(x => ({ date: x.dueDate, principal: x.principal, interest: x.interest })),
      [{ date: '2026-11-30', principal: '250.00', interest: '7.50' }, { date: '2026-12-31', principal: '250.00', interest: '5.00' }, { date: '2027-01-31', principal: '250.00', interest: '2.50' }]);
    out['RC09'] = { original: fmt(r.postings), reversal: fmt(s.postings), version: 3 }; }
  // AP6-02 A: confirmed CASH reserved; spending into it is rejected, free money still usable.
  { const b = base(); b.fund('CASH_C', c('50000.00')); b.accrueEvent('L1', T, T); b.register('pr', pay('CASH', '300000.00', [{ loan: 'L1', amount: '300000.00' }]), T);
    assert.equal(m(b.available('CASH_C')), '50000.00', 'provisional not counted'); b.approve('pr', 'T1', T); assert.equal(m(b.available('CASH_C')), '50000.00');
    b.spend('CASH_C', c('50000.00'), 'OUT'); assert.throws(() => b.spend('CASH_C', c('0.01'), 'OUT'), (e: unknown) => e instanceof OracleError && e.code === 'ACCOUNT_OVERDRAFT'); out['AP6-02A'] = 'free 50k spendable, reserved 300k not'; }
  console.log(JSON.stringify({ evidence: 'P06-O01', cases: Object.keys(out).length, out }));
});
