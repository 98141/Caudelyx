/* eslint-disable security/detect-object-injection -- Keys are this test's own fixed labels/array indexes, never request input. */
// S05-P05-v2 independent review (Claude) of S05-P04-v3-INTEGRADO: economics, atomicity, security, H01/H02, restore.
// One own §15 group (review-profile.ts) reused sequentially by every scenario; HTTPS real app for every S5 operation.
// Expected money comes ONLY from ./economic-oracle.ts (own S4 oracle underneath), never from production calculation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reviewProfile } from './review-profile.js';
import { world, st, data, type Group, type Tenant, type World, type Reply } from './review-fixtures.js';
import { Book, OracleError, c, m, fmtPostings, fmtApps, type Step } from './economic-oracle.js';
import type { OracleTerms } from '../s04/oracle.js';

const evidence = (name: string, d: Record<string, unknown>) => console.log(JSON.stringify({ evidence: name, ...d }));
type RC = { id: string; clock: string; input: { principal: string; installmentCount: number; method: string; frequency: string; rate: { kind: string; unit: string; value: string }; effectiveDate: string; firstDueDate: string };
  steps: { kind: string; clock: string; effectiveDate: string; throughDate: string; postings: { account: string; debit: string; credit: string }[]; applications: { loan: string; scheduleVersion: number; installmentNumber: number; component: string; amount: string }[]; accruals: { loan: string; scheduleVersion: number; installmentNumber: number; dueDate: string; interest: string }[]; journalExpected: boolean; scheduleRevision: null | { version: number; remainingPrincipal: string; schedule: { k: number; date: string; principal: string; interest: string; payment: string }[] } }[];
  receipt?: { amount: string; targets: { loan: string; amount: string; mode: 'REGULAR' | 'EXTRA_PRINCIPAL' }[]; excessDisposition: 'CREDIT' | 'REJECT' }; creditApplication?: { amount: string; targets: { loan: string; amount: string; mode: 'REGULAR' | 'EXTRA_PRINCIPAL' }[] };
  otherLoan?: { id: string; principal: string; schedule: { interest: string }[] }; alreadyAccrued?: unknown[]; expectedStatus?: string; expectedFirstDuePrincipalRemaining?: string; expectedFutureInterest?: string | string[]; expectedRemainingPrincipalByLoan?: Record<string, string>; expectedPrincipalRows?: string[] };
const cases = JSON.parse(readFileSync(resolve('../../Construccion/Sprints/S05/Contratos/REFERENCE_CASES_S05.json'), 'utf8')) as { numericCases: RC[] };
const termsOf = (rc: RC, principal = rc.input.principal, rateValue = rc.input.rate.value): OracleTerms => ({ principal, effectiveDate: rc.input.effectiveDate, firstDueDate: rc.input.firstDueDate, installmentCount: rc.input.installmentCount, method: rc.input.method, frequency: rc.input.frequency,
  rate: { type: rc.input.rate.kind, unit: rc.input.rate.unit, value: rateValue }, calendarConvention: 'PERIODIC_FIXED', holidayAdjustment: 'NO_SHIFT', policyVersion: 'S04-LOCAL-CO-0.1', jurisdiction: 'CO', usage: 'LOCAL_SYNTHETIC' });
const otherTerms = (rc: RC): OracleTerms => termsOf(rc, rc.otherLoan!.principal, rc.otherLoan!.schedule.every(r => r.interest === '0.00') ? '0.000000000000' : rc.input.rate.value);
/** Drive one RC through the oracle; returns per-step oracle results (after disbursement on 2026-10-24). */
function oracleRun(rc: RC, book: Book, ids: Record<string, string>, cash = 'CASH') {
  const borrower = 'B:' + rc.id;
  book.addLoan(ids['L1']!, borrower, termsOf(rc)); book.disburse(ids['L1']!, cash);
  if (rc.otherLoan) { book.addLoan(ids['L2']!, borrower, otherTerms(rc)); book.disburse(ids['L2']!, cash); }
  const out: Step[] = [];
  for (const s of rc.steps) {
    if (s.kind === 'DISBURSE') continue;
    if (s.kind === 'ACCRUE') out.push(book.accrue(ids['L1']!, s.throughDate, s.effectiveDate));
    if (s.kind === 'RECEIPT') { if (rc.alreadyAccrued && !rc.steps.some(x => x.kind === 'ACCRUE')) book.accrue(ids['L1']!, s.effectiveDate, s.effectiveDate); out.push(book.collect('RECEIPT', borrower, c(rc.receipt!.amount), rc.receipt!.targets.map(t => ({ loan: ids[t.loan]!, amount: c(t.amount), mode: t.mode })), s.effectiveDate, { account: cash, excess: rc.receipt!.excessDisposition })); }
    if (s.kind === 'APPLY_CREDIT') out.push(book.collect('APPLY_CREDIT', borrower, c(rc.creditApplication!.amount), rc.creditApplication!.targets.map(t => ({ loan: ids[t.loan]!, amount: c(t.amount), mode: t.mode })), s.effectiveDate));
  }
  return out;
}
/** Stored money (string/Decimal128) to canonical COP2 without floating point. */
const dec = (v: unknown) => { const t = String(v), neg = t.startsWith('-'), [w = '0', f = ''] = t.replace('-', '').split('.'); return m((BigInt(w) * 100n + BigInt((f + '00').slice(0, 2))) * (neg ? -1n : 1n)); };
const RC_STEPS = (rc: RC) => rc.steps.filter(s => s.kind !== 'DISBURSE');

test('P05-S5-O01 own economic oracle == the 12 approved reference cases (postings, applications, accruals, revisions, states)', () => {
  const seen: Record<string, unknown> = {};
  for (const rc of cases.numericCases) {
    const book = new Book(), ids = { L1: rc.id + ':L1', L2: rc.id + ':L2' };
    book.fund('CASH', c('100000000.00'));
    const steps = oracleRun(rc, book, ids), ref = RC_STEPS(rc);
    const name = (a: string) => a;
    assert.equal(steps.length, ref.length, rc.id);
    steps.forEach((s, j) => {
      const r = ref[j]!;
      assert.deepEqual(fmtPostings(s.postings, name), [...r.postings].sort((a, b) => a.account.localeCompare(b.account)), `${rc.id} step ${j} postings`);
      assert.deepEqual(fmtApps(s.applications, l => l.endsWith(':L2') ? 'L2' : 'L1'), r.applications, `${rc.id} step ${j} applications`);
      if (r.accruals.length) assert.deepEqual(s.accruals.map(a => ({ loan: a.loan.endsWith(':L2') ? 'L2' : 'L1', scheduleVersion: a.version, installmentNumber: a.k, interest: m(a.interest) })), r.accruals.map(a => ({ loan: a.loan, scheduleVersion: a.scheduleVersion, installmentNumber: a.installmentNumber, interest: a.interest })), `${rc.id} accruals`);
      assert.equal(s.journal, r.journalExpected, `${rc.id} journal`);
      if (r.scheduleRevision) {
        const l = book.loans.get(ids.L1)!, rev = l.revisions.at(-1)!;
        assert.equal(rev.version, r.scheduleRevision.version); assert.equal(m(rev.remaining), r.scheduleRevision.remainingPrincipal);
        assert.deepEqual(rev.rows.map(x => ({ date: x.dueDate, principal: m(x.principal), interest: m(x.interest), payment: m(x.principal + x.interest) })), r.scheduleRevision.schedule.map(x => ({ date: x.date, principal: x.principal, interest: x.interest, payment: x.payment })), `${rc.id} revision`);
      }
    });
    const v = book.view(ids.L1, rc.steps.at(-1)!.effectiveDate);
    if (rc.expectedStatus) assert.equal(v.status, rc.expectedStatus, rc.id + ' status');
    if (rc.expectedFirstDuePrincipalRemaining) assert.equal(v.duePrincipal, rc.expectedFirstDuePrincipalRemaining);
    if (Array.isArray(rc.expectedFutureInterest)) assert.deepEqual(book.installments(ids.L1).filter(i => i.dueDate > rc.steps.at(-1)!.effectiveDate).map(i => i.interest), rc.expectedFutureInterest);
    if (rc.expectedRemainingPrincipalByLoan) assert.deepEqual({ L1: v.principalOutstanding, L2: book.view(ids.L2, rc.steps.at(-1)!.effectiveDate).principalOutstanding }, rc.expectedRemainingPrincipalByLoan);
    if (rc.expectedPrincipalRows) assert.deepEqual(book.installments(ids.L1).map(i => i.principal), rc.expectedPrincipalRows);
    seen[rc.id] = { status: v.status, principalOutstanding: v.principalOutstanding, accrued: v.accruedInterestTotal, collected: v.collectedInterestTotal, credit: m(book.credit.get('B:' + rc.id) ?? 0n) };
  }
  // Controls written in prose in ACCOUNTING A5, recomputed here independently of the JSON.
  const b = new Book(); b.fund('CASH', c('20000000.00'));
  const t: OracleTerms = { ...termsOf(cases.numericCases[0]!), principal: '10000000.00', installmentCount: 2, rate: { type: 'EFFECTIVE', unit: 'MONTH', value: '0.000000000000' } };
  b.addLoan('X', 'BX', t); const d = b.disburse('X', 'CASH');
  assert.deepEqual(fmtPostings(d.postings), [{ account: 'CASH', debit: '0.00', credit: '10000000.00' }, { account: 'PRINCIPAL', debit: '10000000.00', credit: '0.00' }]);
  assert.equal(m(b.balances.get('INTEREST_INCOME') ?? 0n), '0.00');
  let rejected = ''; try { b.collect('RECEIPT', 'BX', c('1.00'), [{ loan: 'X', amount: c('2.00'), mode: 'REGULAR' }], '2026-10-24', { excess: 'CREDIT' }); } catch (e) { rejected = (e as OracleError).code; }
  assert.equal(rejected, 'INPUT_INVALID');
  evidence('P05-S5-O01', { cases: cases.numericCases.length, allEqual: true, seen });
});

/** Account ids of a tenant mapped to oracle symbols (BANK is the cash account in these scenarios). */
const symbols = (T: Tenant) => new Map<string, string>([[T.acc['BANK']!, 'CASH'], [T.acc['P']!, 'PRINCIPAL'], [T.acc['I']!, 'INTEREST_RECEIVABLE'], [T.acc['Y']!, 'INTEREST_INCOME'], [T.acc['C']!, 'BORROWER_CREDIT']]);
const serverPostings = (T: Tenant, lines: { accountId: string; debit: string; credit: string }[]) => { const s = symbols(T); return lines.map(l => ({ account: s.get(l.accountId) ?? l.accountId, debit: l.debit, credit: l.credit })).sort((a, b) => a.account.localeCompare(b.account)); };

test('P05-S5 runtime review on one own group', { timeout: 7200000 }, async t => {
  // P05_ONLY=<regex> runs only matching scenarios (explicit, reported skip) so a fixed scenario is not re-run blindly.
  // eslint-disable-next-line security/detect-non-literal-regexp -- Reviewer-supplied scenario filter from the own runner, not request input.
  const only = process.env['P05_ONLY'] ? new RegExp(process.env['P05_ONLY']) : null, skip = (id: string) => only !== null && !only.test(id);
  const group: Group = await reviewProfile();
  let interrupted = false;
  const signal = () => { interrupted = true; void group.dispose('cancelled-by-signal').finally(() => process.exit(130)); };
  process.once('SIGINT', signal); process.once('SIGTERM', signal);
  try {
    await t.test('P05-S5-E01 the 12 RC cases end to end over HTTPS: server plan/journal/applications/positions/installments/revisions == own oracle (AT01/03/04/05/07/08)', { skip: skip('P05-S5-E01') }, async () => {
      const w: World = await world(group, '2026-10-24T12:00:00-05:00'), A = await w.tenant('RC', '60000000.00'), o: Record<string, unknown> = {};
      // Setup in-process: one borrower per RC, S4 terms confirmed.
      const ids: Record<string, Record<string, string>> = {};
      for (const rc of cases.numericCases) {
        const b = await w.borrower(A, rc.id.slice(0, 4).replace('-', '') + '_B', 'Persona ' + rc.id.slice(0, 4));
        const tr = { principal: rc.input.principal, installmentCount: rc.input.installmentCount, method: rc.input.method, frequency: rc.input.frequency, rate: { type: rc.input.rate.kind, unit: rc.input.rate.unit, value: rc.input.rate.value } };
        ids[rc.id] = { L1: await w.confirmed(A, rc.id + ':L1', b, tr), B: b };
        if (rc.otherLoan) ids[rc.id]!['L2'] = await w.confirmed(A, rc.id + ':L2', b, { ...tr, principal: rc.otherLoan.principal, rate: { type: 'EFFECTIVE', unit: 'MONTH', value: otherTerms(rc).rate.value } });
      }
      await w.connect(A);
      const book = new Book(); book.fund('CASH', c('60000000.00'));
      const check: Record<string, unknown> = {};
      const compare = async (label: string, res: Reply, oracleStep: Step) => {
        assert.equal(res.status, 201, `${label}: ${st(res)}`);
        const event = (data(res) as { event: { id: string; journalId: string | null; plan: { postings: { accountId: string; debit: string; credit: string }[]; allocations: { loanId: string; scheduleVersion: number; installmentNumber: number; component: string; amount: string }[] } } }).event;
        const name = (id: string) => Object.entries(ids).flatMap(([rc, x]) => Object.entries(x).map(([k, v]) => [v, rc + ':' + k])).find(([v]) => v === id)?.[1] ?? id;
        assert.deepEqual(serverPostings(A, event.plan.postings), fmtPostings(oracleStep.postings), `${label} postings`);
        assert.deepEqual(event.plan.allocations.map(a => ({ loan: name(a.loanId), v: a.scheduleVersion, k: a.installmentNumber, component: a.component, amount: a.amount })), oracleStep.applications.map(a => ({ loan: name(a.loan), v: a.version, k: a.k, component: a.component, amount: m(a.amount) })), `${label} applications`);
        assert.equal(event.journalId !== null, oracleStep.journal, `${label} journal presence`);
        if (event.journalId) { const j = await w.db.collection('financial_journals').findOne({ _id: event.journalId as never }) as { lines: { accountId: string; debit: unknown; credit: unknown }[]; source: { type: string; id: string } } | null;
          assert.ok(j); assert.deepEqual(j!.source, { type: 'LOAN_OPERATION', id: event.id }, label + ' journal source');
          assert.deepEqual(serverPostings(A, j!.lines.map(l => ({ accountId: l.accountId, debit: String(l.debit), credit: String(l.credit) }))).map(x => ({ ...x, debit: dec(x.debit), credit: dec(x.credit) })), fmtPostings(oracleStep.postings), label + ' journal lines'); }
        return event;
      };
      // Day 1 (2026-10-24): every disbursement, compared with the oracle.
      for (const rc of cases.numericCases) for (const L of ['L1', 'L2'].filter(k => ids[rc.id]![k])) {
        const id = ids[rc.id]![L]!; book.addLoan(id, ids[rc.id]!['B']!, L === 'L1' ? termsOf(rc) : otherTerms(rc));
        const res = await w.run(A, await w.disburseRequest(A, id)); await compare(rc.id + ' disburse ' + L, res, book.disburse(id, 'CASH'));
      }
      check['after disbursements'] = { ledger: Object.fromEntries(Object.entries(await w.ledger(A)).map(([k, v]) => [k, m(v)])), oracle: { CASH: m(book.balances.get('CASH')!), PRINCIPAL: m(book.balances.get('PRINCIPAL')!) } };
      // Day 2 (2026-10-30) and Day 3 (2026-10-31): steps in RC order.
      for (const day of ['2026-10-30', '2026-10-31']) {
        w.setClock(day + 'T12:00:00-05:00'); await w.connect(A);
        for (const rc of cases.numericCases) {
          const L1 = ids[rc.id]!['L1']!, B = ids[rc.id]!['B']!;
          if (rc.alreadyAccrued && day === '2026-10-31') await compare(rc.id + ' pre-accrue', await w.run(A, await w.accrueRequest(A, L1)), book.accrue(L1, day, day));
          for (const s of RC_STEPS(rc).filter(x => x.effectiveDate === day)) {
            let res: Reply, step: Step;
            if (s.kind === 'ACCRUE') { res = await w.run(A, await w.accrueRequest(A, L1, s.throughDate)); step = book.accrue(L1, s.throughDate, day); }
            else if (s.kind === 'RECEIPT') { const targets = rc.receipt!.targets.map(x => ({ loanId: ids[rc.id]![x.loan]!, amount: x.amount, mode: x.mode })); res = await w.run(A, await w.receiptRequest(A, B, rc.receipt!.amount, targets, rc.receipt!.excessDisposition));
              step = book.collect('RECEIPT', B, c(rc.receipt!.amount), targets.map(x => ({ loan: x.loanId, amount: c(x.amount), mode: x.mode })), day, { account: 'CASH', excess: rc.receipt!.excessDisposition }); }
            else { const targets = rc.creditApplication!.targets.map(x => ({ loanId: ids[rc.id]![x.loan]!, amount: x.amount, mode: x.mode })); res = await w.run(A, await w.creditRequest(A, B, rc.creditApplication!.amount, targets));
              step = book.collect('APPLY_CREDIT', B, c(rc.creditApplication!.amount), targets.map(x => ({ loan: x.loanId, amount: c(x.amount), mode: x.mode })), day); }
            await compare(`${rc.id} ${s.kind} ${day}`, res, step);
          }
        }
      }
      // Read models: every position and active installment of every loan == oracle; schedule revisions == oracle.
      const views: Record<string, unknown> = {};
      for (const rc of cases.numericCases) for (const L of ['L1', 'L2'].filter(k => ids[rc.id]![k])) {
        const id = ids[rc.id]![L]!, p = data(await w.get(A, '/loan-operations/positions/' + id)) as Record<string, unknown>, mine = book.view(id, '2026-10-31');
        for (const k of Object.keys(mine).filter(k => k !== 'scheduleVersion')) assert.equal(p[k], (mine as Record<string, unknown>)[k], `${rc.id} ${L} position ${k}`);
        assert.equal(p['scheduleVersion'], mine.scheduleVersion, `${rc.id} ${L} scheduleVersion`);
        const inst = (data(await w.get(A, `/loan-operations/positions/${id}/installments?limit=100`)) as { items: Record<string, unknown>[] }).items;
        assert.deepEqual(inst.map(i => ({ number: i['number'], dueDate: i['dueDate'], principal: i['principal'], interest: i['interest'], principalPaid: i['principalPaid'], interestPaid: i['interestPaid'], scheduleVersion: i['scheduleVersion'] })), book.installments(id), `${rc.id} ${L} installments`);
        const versions = (data(await w.get(A, `/loan-operations/positions/${id}/schedule-versions?limit=100`)) as { items: { version: number; remainingPrincipal: string; futureInstallments: { dueDate: string; principal: string; interest: string }[] }[] }).items;
        const lo = book.loans.get(id)!;
        assert.deepEqual(versions.map(v => ({ version: v.version, remaining: v.remainingPrincipal, rows: v.futureInstallments.map(r => `${r.dueDate}:${r.principal}/${r.interest}`) })), lo.revisions.map(r => ({ version: r.version, remaining: m(r.remaining), rows: r.rows.map(x => `${x.dueDate}:${m(x.principal)}/${m(x.interest)}`) })), `${rc.id} ${L} schedule versions`);
        views[`${rc.id}:${L}`] = { status: p['status'], statusLabel: p['statusLabel'], principalOutstanding: p['principalOutstanding'], accrued: p['accruedInterestTotal'], collected: p['collectedInterestTotal'], versions: versions.length };
      }
      // Ledger reconciliation of the four bound GENERAL accounts and the cash account against the oracle.
      const ledger = await w.ledger(A);
      const expected = { BANK: book.balances.get('CASH')!, P: book.balances.get('PRINCIPAL')!, I: book.balances.get('INTEREST_RECEIVABLE') ?? 0n, Y: book.balances.get('INTEREST_INCOME') ?? 0n, C: book.balances.get('BORROWER_CREDIT') ?? 0n };
      for (const [k, v] of Object.entries(expected)) assert.equal(m(ledger[k]!), m(v), 'ledger ' + k);
      const credits: Record<string, string> = {};
      for (const rc of cases.numericCases) { const b = ids[rc.id]!['B']!; credits[rc.id] = String((data(await w.get(A, '/loan-operations/credits/' + b)) as { balance: string }).balance); assert.equal(credits[rc.id], m(book.credit.get(b) ?? 0n), rc.id + ' credit'); }
      o['ledger (natural sign)'] = Object.fromEntries(Object.entries(ledger).map(([k, v]) => [k, m(v)])); o['oracle'] = Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, m(v)])); o['positions'] = views; o['credits'] = credits; o['checks'] = check;
      o['events'] = await w.db.collection('loan_events').countDocuments({ organizationId: A.org }); o['journalsLoanOperation'] = await w.db.collection('financial_journals').countDocuments({ organizationId: A.org, 'source.type': 'LOAN_OPERATION' });
      evidence('P05-S5-E01', { observed: o });
    });

    await t.test('P05-S5-E02 negatives N01–N21: closed codes, zero financial effect, R not consumed; 1/10/11 targets; protected accounts (AT01/02/05/06/07)', { skip: skip('P05-S5-E02') }, async () => {
      const w = await world(group, '2026-10-24T12:00:00-05:00'), A = await w.tenant('NEG', '15000000.00'), B = await w.tenant('NEGB', '1000000.00'), o: Record<string, string> = {};
      // Setup: manual journal on P BEFORE binding (A5 "incluso revertir un asiento manual anterior a su vinculación").
      const pre = await w.journal(A, [{ accountId: A.acc['P']!, debit: '100.00', credit: '0.00' }, { accountId: A.acc['E']!, debit: '0.00', credit: '100.00' }], 'SYN-PRE-BINDING');
      const preId = (pre.data as { id: string }).id;
      const b1 = await w.borrower(A, 'NEG_B1'), b2 = await w.borrower(A, 'NEG_B2'), bB = await w.borrower(B, 'NEGB_B1');
      const zero = { rate: { type: 'EFFECTIVE', unit: 'MONTH', value: '0.000000000000' }, installmentCount: 2 };
      const L1 = await w.confirmed(A, 'L1', b1, { ...zero, principal: '10000000.00' }), L2 = await w.confirmed(A, 'L2', b1, { ...zero, principal: '10000000.00' });
      const Ldraft = await w.confirmed(A, 'Ld', b1, {}, false), Lsmall = await w.confirmed(A, 'Ls', b1, { principal: '100.00' }), Lother = await w.confirmed(A, 'Lo', b2, { principal: '100.00' });
      const Lb = await w.confirmed(B, 'Lb', bB, { principal: '100.00' });
      const many: string[] = []; for (let k = 0; k < 11; k++) many.push(await w.confirmed(A, 'M' + k, b2, { principal: '1.00', installmentCount: 1 }));
      await w.connect(A); await w.connect(B);
      const proofDelta = async (purpose: string, fn: () => Promise<Reply>) => { const before = await w.orgCounts(A), res = await fn(), after = await w.orgCounts(A), left = await w.proofsLeft(A, purpose); return { res, noEffect: JSON.stringify(before) === JSON.stringify(after), left }; };
      const neg = async (label: string, request: Record<string, unknown>, expected: string, viaPreviewOnly = false) => {
        const pv = await w.preview(A, request);
        if (pv.res.status !== 200 || viaPreviewOnly) { o[label] = 'preview ' + st(pv.res); assert.equal(st(pv.res), expected, label); return; }
        const purpose = new Map([['DISBURSE', 'LOAN_DISBURSE'], ['ACCRUE', 'LOAN_ACCRUE'], ['RECEIPT', 'LOAN_RECEIPT_POST'], ['APPLY_CREDIT', 'LOAN_CREDIT_APPLY']]).get(String(request['kind']))!;
        const x = await proofDelta(purpose, async () => await w.execute(A, request, pv));
        o[label] = `${st(x.res)} noEffect=${x.noEffect} proofLeft=${x.left}`; assert.equal(st(x.res), expected, label); assert.ok(x.noEffect, label + ' effect'); assert.ok(x.left >= 1, label + ' R consumed');
      };
      // N01 DRAFT / N04 overdraft / N06 not today (preview reproduces every guard; no R requested).
      await neg('N01 DRAFT', await w.disburseRequest(A, Ldraft), '409 STATE_CONFLICT', true);
      await neg('N06 effectiveDate yesterday', { ...await w.disburseRequest(A, L1), effectiveDate: '2026-10-23' }, '422 INPUT_INVALID', true);
      // N03: cash 15M, two 10M with the same initial book ETag, previewed, R'd and executed concurrently -> one 201, other 412.
      const r1 = await w.disburseRequest(A, L1), r2 = await w.disburseRequest(A, L2), etag = await w.book(A), p1 = await w.preview(A, r1, undefined, etag), p2 = await w.preview(A, r2, undefined, etag);
      const A2 = await w.connect({ ...A }); // second independent session of the same Titular for the concurrent request
      await w.execute(A, r1, p1, { onlyR: true }); await w.execute(A2, r2, p2, { onlyR: true });
      const [x1, x2] = await Promise.all([w.execute(A, r1, p1, { skipR: true }), w.execute(A2, r2, p2, { skipR: true })]);
      const winner = x1.status === 201 ? L1 : L2, bank = (await w.ledger(A))['BANK']!;
      o['N03 race two 10M vs 15M'] = `[${[st(x1), st(x2)].sort().join(', ')}] bank=${m(bank)} positions=${await w.db.collection('loan_positions').countDocuments({ organizationId: A.org })}`;
      assert.deepEqual([x1.status, x2.status].sort(), [201, 412]); assert.ok(bank >= 0n); assert.equal(await w.db.collection('loan_positions').countDocuments({ organizationId: A.org }), 1);
      await neg('N02 already disbursed (new key)', await w.disburseRequest(A, winner), '409 ALREADY_DISBURSED', true);
      await neg('N04 overdraft (5M left, 10M)', await w.disburseRequest(A, winner === L1 ? L2 : L1), '409 ACCOUNT_OVERDRAFT', true);
      assert.equal((await w.run(A, await w.disburseRequest(A, Lsmall))).status, 201); assert.equal((await w.run(A, await w.disburseRequest(A, Lother))).status, 201);
      for (const id of many.slice(0, 11)) assert.equal((await w.run(A, await w.disburseRequest(A, id))).status, 201);
      // Accrual/receipt/credit negatives (today 2026-10-24: no due date yet).
      await neg('N07 nothing due', await w.accrueRequest(A, Lsmall), '409 NO_ACCRUAL_DUE', true);
      await neg('N08 budgets > received', await w.receiptRequest(A, b1, '10.00', [{ loanId: Lsmall, amount: '20.00' }], 'CREDIT'), '422 INPUT_INVALID', true);
      await neg('N09 same loan twice', { ...await w.receiptRequest(A, b1, '10.00', [{ loanId: Lsmall, amount: '5.00' }], 'CREDIT'), targets: [...(await w.receiptRequest(A, b1, '10.00', [{ loanId: Lsmall, amount: '5.00' }])).targets, ...(await w.receiptRequest(A, b1, '10.00', [{ loanId: Lsmall, amount: '5.00' }])).targets] }, '422 INPUT_INVALID', true);
      await neg('N11 two borrowers', await w.receiptRequest(A, b1, '10.00', [{ loanId: Lsmall, amount: '5.00' }, { loanId: Lother, amount: '5.00' }], 'CREDIT'), '422 INPUT_INVALID', true);
      await neg('N12 EXTRA between due dates', await w.receiptRequest(A, b1, '10.00', [{ loanId: Lsmall, amount: '10.00', mode: 'EXTRA_PRINCIPAL' }]), '422 UNSUPPORTED_PAYMENT_VARIANT', true);
      await neg('N14 REJECT with excess', await w.receiptRequest(A, b1, '10.00', [{ loanId: Lsmall, amount: '10.00' }], 'REJECT'), '409 EXCESS_NOT_ALLOWED', true);
      await neg('N13 credit insufficient', await w.creditRequest(A, b1, '10.00', [{ loanId: Lsmall, amount: '10.00' }]), '409 CREDIT_INSUFFICIENT', true);
      await neg('N10 foreign loan in second item', { ...await w.receiptRequest(A, b1, '10.00', [{ loanId: Lsmall, amount: '5.00' }], 'CREDIT'), targets: [...(await w.receiptRequest(A, b1, '10.00', [{ loanId: Lsmall, amount: '5.00' }])).targets, { loanId: Lb, positionETag: `"${Lb}:0"`, amount: '5.00', mode: 'REGULAR' }] }, '404 RESOURCE_NOT_FOUND', true);
      const ten = await w.run(A, await w.receiptRequest(A, b2, '10.00', many.slice(0, 10).map(id => ({ loanId: id, amount: '1.00' })), 'CREDIT'));
      o['10 targets (advance -> credit)'] = st(ten); assert.equal(ten.status, 201);
      const elevenReq = { ...await w.receiptRequest(A, b2, '11.00', many.slice(0, 10).map(id => ({ loanId: id, amount: '1.00' })), 'CREDIT') }; elevenReq.targets = [...elevenReq.targets, { loanId: many[10]!, positionETag: await w.positionETag(A, many[10]!), amount: '1.00', mode: 'REGULAR' }];
      await neg('11 targets', elevenReq, '422 INPUT_INVALID', true);
      // N15 receipt reference reused with a new key; N16 same key other body; replay exact with fresh R.
      const ref = 'SYN-REF-UNIQUE', okRec = await w.run(A, await w.receiptRequest(A, b1, '5.00', [{ loanId: Lsmall, amount: '5.00' }], 'CREDIT', 'BANK', ref));
      assert.equal(okRec.status, 201);
      await neg('N15 receipt reference conflict', await w.receiptRequest(A, b1, '5.00', [{ loanId: Lsmall, amount: '5.00' }], 'CREDIT', 'BANK', ref), '409 RECEIPT_REFERENCE_CONFLICT', true);
      // N18 changed If-Match: preview, then another event bumps the book, then execute the stale preview.
      const staleReq = await w.receiptRequest(A, b1, '1.00', [{ loanId: Lsmall, amount: '1.00' }], 'CREDIT'), stalePv = await w.preview(A, staleReq);
      assert.equal((await w.run(A, await w.receiptRequest(A, b1, '1.00', [{ loanId: Lsmall, amount: '1.00' }], 'CREDIT'))).status, 201);
      await (async () => { const x = await proofDelta('LOAN_RECEIPT_POST', async () => await w.execute(A, staleReq, stalePv)); o['N18 stale If-Match'] = `${st(x.res)} noEffect=${x.noEffect} proofLeft=${x.left}`; assert.equal(x.res.status, 412); assert.ok(x.noEffect); })();
      // N19 R of another purpose; N17 preview expiry boundary (now == expiresAt -> expired; 1 ms before -> 201).
      const wrongReq = await w.receiptRequest(A, b1, '1.00', [{ loanId: Lsmall, amount: '1.00' }], 'CREDIT'), wrongPv = await w.preview(A, wrongReq);
      const wrong = await w.execute(A, wrongReq, wrongPv, { rPurpose: 'LOAN_CREDIT_APPLY' }); o['N19 R of other purpose'] = st(wrong); assert.ok(wrong.status === 403 || wrong.status === -403 || wrong.status === -422, st(wrong));
      const expReq = await w.receiptRequest(A, b1, '1.00', [{ loanId: Lsmall, amount: '1.00' }], 'CREDIT'), expPv = await w.preview(A, expReq), issued = w.f.now();
      w.f.clock.value = issued + 300000 - 30000; const expired = await w.execute(A, expReq, expPv); o['N17 now == expiresAt'] = st(expired); assert.equal(st(expired), '409 PREVIEW_EXPIRED');
      const justReq = await w.receiptRequest(A, b1, '1.00', [{ loanId: Lsmall, amount: '1.00' }], 'CREDIT'), justPv = await w.preview(A, justReq), issued2 = w.f.now();
      w.f.clock.value = issued2 + 300000 - 30001; const just = await w.execute(A, justReq, justPv); o['N17 1 ms before expiresAt'] = st(just); assert.equal(just.status, 201);
      // N20/N21 manual S2 protection (in-process S2 command API with its own R).
      const anyOpJournal = (await w.db.collection('financial_journals').findOne({ organizationId: A.org, 'source.type': 'LOAN_OPERATION' }))!;
      const s2 = async (op: string, payload: Record<string, unknown>, id?: string, etag?: string) => { const key = crypto.randomUUID(), purpose = op === 'reverseJournal' ? 'FINANCE_JOURNAL_REVERSE' : 'FINANCE_JOURNAL_POST'; await w.f.proof(A.a, purpose, { organizationId: A.org, idempotencyKey: key, payload, ...(etag ? { expectedETag: etag } : {}) }, id);
        try { return String((await w.f.runtime.finance.mutate(A.a.issued.context, op, A.org, payload, key, id, etag)).status); } catch (e) { return `${(e as { status?: number }).status} ${(e as { code?: string }).code}`; } };
      const jEtag = (j: Record<string, unknown>) => `"${String(j['_id'])}:${String(j['version'] ?? 1)}"`;
      o['N20 reverse LOAN_OPERATION journal'] = await s2('reverseJournal', { reason: 'Intento sintético', sourceId: crypto.randomUUID(), effectiveDate: w.today(), supportReference: 'SYN-N20' }, String(anyOpJournal['_id']), jEtag(anyOpJournal));
      o['N21 manual post touching bound P'] = await s2('postJournal', { currency: 'COP', effectiveDate: w.today(), sourceId: crypto.randomUUID(), supportReference: 'SYN-N21', description: 'Intento', lines: [{ accountId: A.acc['P']!, debit: '1.00', credit: '0.00' }, { accountId: A.acc['E']!, debit: '0.00', credit: '1.00' }] });
      const preJ = (await w.db.collection('financial_journals').findOne({ _id: preId as never }))!;
      o['N21 reverse pre-binding manual journal on P'] = await s2('reverseJournal', { reason: 'Intento sintético', sourceId: crypto.randomUUID(), effectiveDate: w.today(), supportReference: 'SYN-N21B' }, preId, jEtag(preJ));
      o['S2 cash transfer still allowed (BANK->CASH)'] = await s2('postJournal', { currency: 'COP', effectiveDate: w.today(), sourceId: crypto.randomUUID(), supportReference: 'SYN-S2-OK', description: 'Movimiento legítimo', lines: [{ accountId: A.acc['CASH']!, debit: '1.00', credit: '0.00' }, { accountId: A.acc['BANK']!, debit: '0.00', credit: '1.00' }] });
      for (const k of ['N20 reverse LOAN_OPERATION journal']) assert.match(o[k]!, /409 DOMAIN_REVERSAL_FORBIDDEN/, k);
      for (const k of ['N21 manual post touching bound P', 'N21 reverse pre-binding manual journal on P']) assert.match(o[k]!, /409 DOMAIN_ACCOUNT_PROTECTED/, k);
      assert.equal(o['S2 cash transfer still allowed (BANK->CASH)'], '201');
      // Baseline: P balance = pre-binding 100 + subledger.
      const book = data(await w.get(A, '/loan-operations/book')) as { baseline: { accountId: string; debit: string; credit: string }[] };
      o['baseline P'] = book.baseline.find(l => l.accountId === A.acc['P'])?.debit ?? 'none';
      assert.equal(o['baseline P'], '100.00');
      evidence('P05-S5-E02', { observed: o });
    });

    await t.test('P05-S5-E03 atomicity: injected failure at 7 write points, lost response + exact replay, double click, revocation/suspension/dependency change between preview and commit (AT06/07)', { skip: skip('P05-S5-E03') }, async () => {
      const w = await world(group, '2026-10-24T12:00:00-05:00'), A = await w.tenant('ATOM', '1000000.00'), o: Record<string, unknown> = {};
      const b = await w.borrower(A, 'ATOM_B'); const loans: string[] = []; for (let k = 0; k < 12; k++) loans.push(await w.confirmed(A, 'L' + k, b, { principal: '100.00' }));
      await w.connect(A);
      const inj: Record<string, unknown> = {};
      for (const [k, coll] of ['loan_events', 'loan_installments', 'loan_positions', 'financial_journals', 'lending_merkle_nodes', 'audit_events', 'loan_operation_idempotency'].entries()) {
        const req = await w.disburseRequest(A, loans[k]!), pv = await w.preview(A, req); assert.equal(pv.res.status, 200, st(pv.res));
        await w.execute(A, req, pv, { onlyR: true });
        const before = await w.orgCounts(A), merkle = await w.db.collection('lending_merkle_nodes').countDocuments(), failed = await w.inject(coll, async () => await w.execute(A, req, pv, { skipR: true }));
        const after = await w.orgCounts(A), merkleAfter = await w.db.collection('lending_merkle_nodes').countDocuments(), left = await w.proofsLeft(A, 'LOAN_DISBURSE');
        const retry = await w.execute(A, req, pv, { skipR: true });
        inj[coll] = { failed: st(failed), noPartialWrite: JSON.stringify(before) === JSON.stringify(after) && merkle === merkleAfter, proofLeft: left, retrySameKeySameR: st(retry) };
        assert.equal(failed.status, 503, coll); assert.ok(JSON.stringify(before) === JSON.stringify(after) && merkle === merkleAfter, coll + ' partial'); assert.equal(retry.status, 201, coll + ' retry');
      }
      o['injected failures'] = inj;
      // Lost response: the client never reads the 201; GET command by key, then exact replay with a fresh R -> 200 identical, one event.
      const req = await w.disburseRequest(A, loans[7]!), pv = await w.preview(A, req), first = await w.execute(A, req, pv);
      const byKey = await w.get(A, '/loan-operations/commands/' + pv.key), again = await w.execute(A, req, pv);
      const other = await w.execute(A, { ...req, supportReference: 'SYN-OTHER' }, pv);
      o['lost response'] = { first: st(first), commandLookup: st(byKey), sameAsFirst: JSON.stringify(data(byKey)) === JSON.stringify(data(first)), replayFreshR: st(again), replaySame: JSON.stringify(data(again)) === JSON.stringify(data(first)), sameKeyOtherBody: st(other), events: await w.db.collection('loan_events').countDocuments({ organizationId: A.org, loanIds: loans[7] }) };
      assert.equal(first.status, 201); assert.equal(again.status, 200); assert.equal(st(other).replace('-', ''), '409 IDEMPOTENCY_CONFLICT'.replace('-', '')); assert.equal(await w.db.collection('loan_events').countDocuments({ organizationId: A.org, loanIds: loans[7] }), 1);
      // Double click: ONE R, two identical POSTs at once -> one effect.
      const dReq = await w.disburseRequest(A, loans[8]!), dPv = await w.preview(A, dReq); await w.execute(A, dReq, dPv, { onlyR: true });
      const [d1, d2] = await Promise.all([w.execute(A, dReq, dPv, { skipR: true }), w.execute(A, dReq, dPv, { skipR: true })]);
      o['double click one R'] = { statuses: [st(d1), st(d2)].sort(), events: await w.db.collection('loan_events').countDocuments({ organizationId: A.org, loanIds: loans[8] }) };
      assert.equal(await w.db.collection('loan_events').countDocuments({ organizationId: A.org, loanIds: loans[8] }), 1);
      // Revocation between preview/R and commit.
      const rReq = await w.disburseRequest(A, loans[9]!), rPv = await w.preview(A, rReq); await w.execute(A, rReq, rPv, { onlyR: true });
      const subject = A.a.issued.context.subjectId as never;
      await w.db.collection('identities').updateOne({ _id: subject }, { $set: { roles: ['A'], authzVersion: crypto.randomUUID() } });
      const revoked = await w.execute(A, rReq, rPv, { skipR: true });
      await w.db.collection('identities').updateOne({ _id: subject }, { $set: { roles: ['T'], authzVersion: crypto.randomUUID() } });
      A.a = await w.login(A.a); await w.connect(A);
      const rePv = await w.preview(A, await w.disburseRequest(A, loans[9]!));
      o['revocation'] = { revokedCommit: st(revoked), eventsForLoan: await w.db.collection('loan_events').countDocuments({ organizationId: A.org, loanIds: loans[9] }), newPreviewAfterRestore: st(rePv.res) };
      assert.ok([401, 403, 400].includes(revoked.status), st(revoked)); assert.equal(o['revocation'] && (o['revocation'] as { eventsForLoan: number }).eventsForLoan, 0);
      // Organization suspended between preview and commit.
      const sReq = await w.disburseRequest(A, loans[10]!), sPv = await w.preview(A, sReq); await w.execute(A, sReq, sPv, { onlyR: true });
      await w.db.collection('organizations').updateOne({ _id: A.org as never }, { $set: { status: 'SUSPENDED' } });
      const suspended = await w.execute(A, sReq, sPv, { skipR: true });
      await w.db.collection('organizations').updateOne({ _id: A.org as never }, { $set: { status: 'ACTIVE' } });
      o['suspended org'] = st(suspended); assert.ok([401, 403].includes(suspended.status), st(suspended));
      // Funding account renamed (S2) after preview: dependency changed -> stale, no effect.
      const cReq = await w.disburseRequest(A, loans[11]!), cPv = await w.preview(A, cReq);
      const accReply = await A.c.call('GET', `${w.base(A.org)}/financial/accounts/${A.acc['BANK']}`), key = crypto.randomUUID(), payload = { name: 'Banco renombrado S5' };
      await w.r(A, 'FINANCE_ACCOUNT_UPDATE', { organizationId: A.org, idempotencyKey: key, payload, expectedETag: String(accReply.headers['etag']) }, A.acc['BANK']);
      const renamed = await A.c.call('PATCH', `${w.base(A.org)}/financial/accounts/${A.acc['BANK']}`, payload, { 'Idempotency-Key': key, 'If-Match': String(accReply.headers['etag']) });
      const changed = await w.execute(A, cReq, cPv);
      o['dependency changed (account renamed)'] = `${renamed.status} -> ${st(changed)}`; assert.ok([409, 412].includes(changed.status), st(changed));
      evidence('P05-S5-E03', { observed: o });
    });

    await t.test('P05-S5-E04 security: tenants A/B on every reference and batch, roles, sessions, CSRF, R bound to payload, invited second Titular, shared quote/preview quota (AT09/11)', { skip: skip('P05-S5-E04') }, async () => {
      const w = await world(group, '2026-10-24T09:00:00-05:00'), A = await w.tenant('SECA', '1000000.00'), B = await w.tenant('SECB', '1000000.00'), o: Record<string, unknown> = {};
      const bA = await w.borrower(A, 'SEC_A1'), bB = await w.borrower(B, 'SEC_B1');
      const LA = await w.confirmed(A, 'LA', bA, { principal: '100.00' }), LA2 = await w.confirmed(A, 'LA2', bA, { principal: '100.00' }), LB = await w.confirmed(B, 'LB', bB, { principal: '100.00' });
      const T2 = await w.invite(A, ['L']); // real invitation flow; S1 Authorization.assign admits only A/O/C/P/L (no second T)
      await w.db.collection('identities').updateOne({ _id: T2.h.subjectId as never }, { $set: { roles: ['T'] } }); // synthetic promotion, documented: no real flow creates a 2nd Titular
      await w.connect(A); await w.connect(B);
      const dA = await w.run(A, await w.disburseRequest(A, LA)); assert.equal(dA.status, 201);
      assert.equal((await w.run(B, await w.disburseRequest(B, LB))).status, 201);
      const ev = (data(dA) as { event: { id: string } }).event.id;
      const x: Record<string, string> = {};
      for (const p of [`/loan-operations/positions/${LA}`, `/loan-operations/positions/${LA}/installments`, `/loan-operations/positions/${LA}/schedule-versions`, `/loan-operations/events/${ev}`, `/loan-operations/credits/${bA}`, '/loan-operations/positions', '/loan-operations/events', '/loan-operations/book', '/loan-operations/policy'])
        x['B on A path ' + p.replace(/[0-9a-f-]{36}/g, '{id}')] = st(await B.c.call('GET', w.base(A.org) + p) as Reply);
      for (const p of [`/loan-operations/positions/${LA}`, `/loan-operations/events/${ev}`, `/loan-operations/credits/${bA}`]) x['B on own path, A id ' + p.replace(/[0-9a-f-]{36}/g, '{id}')] = st(await w.get(B, p));
      x['B preview with A loan'] = st((await w.preview(B, { ...(await w.disburseRequest(A, LA2)) })).res);
      x['B receipt batch with one A loan'] = st((await w.preview(B, { ...(await w.receiptRequest(B, bB, '2.00', [], 'CREDIT')), targets: [{ loanId: LB, positionETag: await w.positionETag(B, LB), amount: '1.00', mode: 'REGULAR' }, { loanId: LA, positionETag: `"${LA}:1"`, amount: '1.00', mode: 'REGULAR' }] })).res);
      x['B POST on A org (no CSRF/R)'] = st(await B.c.call('POST', w.base(A.org) + '/loan-operations/receipts', {}, { 'Idempotency-Key': crypto.randomUUID(), 'If-Match': '"x"', 'X-CSRF-Token': 'none' }) as Reply);
      o['cross-tenant'] = x;
      for (const [k, v] of Object.entries(x)) assert.match(v, /^404 RESOURCE_NOT_FOUND/, k);
      // Roles: none of A/O/C/P/L/SA/T+SA operates or reads.
      const subject = A.h.issued.context.subjectId as never, roles: Record<string, string> = {};
      for (const role of [['A'], ['O'], ['C'], ['P'], ['L'], ['SA'], ['T', 'SA']]) {
        await w.db.collection('identities').updateOne({ _id: subject }, { $set: { roles: role } });
        roles[role.join('+')] = `GET ${st(await w.get(A, '/loan-operations/policy'))} / preview ${st((await w.preview(A, await w.accrueRequest(A, LA).catch(() => ({ kind: 'ACCRUE', loanId: LA, positionETag: `"${LA}:1"`, throughDate: w.today(), effectiveDate: w.today(), supportReference: 'x' })))).res)}`;
      }
      await w.db.collection('identities').updateOne({ _id: subject }, { $set: { roles: ['T'] } });
      o['roles'] = roles; for (const [k, v] of Object.entries(roles)) assert.match(v, /^GET 403 ACCESS_DENIED \/ preview 403 ACCESS_DENIED$/, k);
      // Sessions: none, basic (password, no MFA), PLATFORM host; CSRF/Origin.
      const { ApiClient } = await import('../../helpers/client.js');
      const anon = new ApiClient(A.c.port, A.c.cert); await anon.refreshCsrf().catch(() => undefined);
      const basic = await w.f.signup(), bc = new ApiClient(A.c.port, A.c.cert); bc.cookies.set('__Host-caudelyx-session', basic.issued.token); await bc.refreshCsrf().catch(() => undefined);
      const plat = await w.f.client(A.h, 'platform.localhost');
      const s: Record<string, string> = { 'no session GET': st(await anon.call('GET', w.base(A.org) + '/loan-operations/book') as Reply), 'no session preview': st(await anon.call('POST', w.base(A.org) + '/loan-operation-previews', {}) as Reply),
        'basic session GET': st(await bc.call('GET', w.base(A.org) + '/loan-operations/book') as Reply), 'PLATFORM host GET': st(await plat.call('GET', w.base(A.org) + '/loan-operations/book') as Reply) };
      const csrfReq = await w.accrueRequest(A, LA);
      s['CSRF wrong'] = st(await A.c.call('POST', w.base(A.org) + '/loan-operation-previews', { executionKey: crypto.randomUUID(), expectedBookETag: await w.book(A), request: csrfReq }, { 'X-CSRF-Token': 'bad' }) as Reply);
      s['Origin other'] = st(await A.c.call('POST', w.base(A.org) + '/loan-operation-previews', { executionKey: crypto.randomUUID(), expectedBookETag: await w.book(A), request: csrfReq }, { Origin: 'https://evil.example' }) as Reply);
      // R bound to another payload / no R / reused R.
      const rq = await w.receiptRequest(A, bA, '1.00', [{ loanId: LA, amount: '1.00' }], 'CREDIT'), pv = await w.preview(A, rq);
      s['R for other payload'] = st(await w.execute(A, rq, pv, { rPayload: { previewToken: pv.token, request: { ...rq, receivedAmount: '2.00' } } }));
      s['no R'] = st(await w.execute(A, rq, pv, { skipR: true }));
      const used = await w.execute(A, rq, pv); s['valid'] = st(used);
      const rq2 = await w.receiptRequest(A, bA, '1.00', [{ loanId: LA, amount: '1.00' }], 'CREDIT'), pv2 = await w.preview(A, rq2);
      s['R already consumed (new command, no new R)'] = st(await w.execute(A, rq2, pv2, { skipR: true }));
      o['session/CSRF/R'] = s;
      for (const [k, v] of Object.entries({ 'no session GET': '401', 'no session preview': '401', 'basic session GET': '40', 'PLATFORM host GET': '403', 'CSRF wrong': '400 CSRF_INVALID', 'Origin other': '400 CSRF_INVALID', 'R for other payload': '403 R_REQUIRED', 'no R': '403 R_REQUIRED', valid: '201', 'R already consumed (new command, no new R)': '403 R_REQUIRED' })) assert.ok(String(s[k]).startsWith(v), `${k}: ${s[k]}`);
      // Invited second Titular (same org, real flow): may disburse confirmed terms with own preview/R (O8), may NOT use A's preview, may NOT read A's command.
      const aPv = await w.preview(A, await w.disburseRequest(A, LA2));
      const t2UsesA = await w.execute(T2, await w.disburseRequest(A, LA2), aPv);
      const t2Own = await w.run(T2, await w.disburseRequest(T2, LA2));
      const t2Cmd = await w.get(T2, '/loan-operations/commands/' + (dA as Reply & { preview: { key: string } }).preview.key);
      o['second Titular same org'] = { usesForeignPreview: st(t2UsesA), ownPreviewAndR: st(t2Own), readsOtherActorCommand: st(t2Cmd) };
      assert.equal(st(t2UsesA), '409 PREVIEW_STALE'); assert.equal(t2Own.status, 201); assert.equal(st(t2Cmd), '404 RESOURCE_NOT_FOUND');
      // Shared quote/preview quota: 30 per actor per UTC minute; replay of a quote does not count.
      w.setClock('2026-10-24T10:00:00-05:00'); await w.connect(A);
      const start = w.f.now(), windowEnd = (Math.floor(start / 60000) + 1) * 60000; let used30 = 0, last: Reply | undefined, firstQuote: Reply | undefined, quoteKey = '';
      for (let k = 0; k < 15; k++) { quoteKey = crypto.randomUUID(); const q = await A.c.call('POST', w.base(A.org) + '/loan-quotes', { terms: w.termsOf(A, bA, { principal: (1 + k) + '.00' }) }, { 'Idempotency-Key': quoteKey }) as Reply; if (!firstQuote) firstQuote = q; if (q.status === 201) used30++; }
      const replayQ = await A.c.call('POST', w.base(A.org) + '/loan-quotes', { terms: w.termsOf(A, bA, { principal: '15.00' }) }, { 'Idempotency-Key': quoteKey }) as Reply;
      for (let k = 0; k < 15; k++) { const p = await w.preview(A, await w.receiptRequest(A, bA, '1.00', [{ loanId: LA, amount: '1.00' }], 'CREDIT')); if (p.res.status === 200) used30++; last = p.res; }
      const overflow = await w.preview(A, await w.receiptRequest(A, bA, '1.00', [{ loanId: LA, amount: '1.00' }], 'CREDIT'));
      const inWindow = w.f.now() < windowEnd;
      o['quota'] = { quotesCreated: 15, quoteReplay: st(replayQ), previewsCounted: 15, lastPreview: last ? st(last) : 'none', thirtyFirst: st(overflow.res), retryAfter: String(overflow.res.headers['retry-after'] ?? 'none'), sameUtcWindow: inWindow, usedBeforeOverflow: used30 };
      assert.equal(replayQ.status, 200);
      if (inWindow) { assert.equal(st(overflow.res), '429 RATE_LIMITED'); assert.ok(Number(overflow.res.headers['retry-after']) >= 1); }
      evidence('P05-S5-E04', { observed: o });
    });

    await t.test('P05-S5-E05 H-S4-01: live tampering of S4 terms/quote/version and of S5 installments/positions/applications fails closed, no reseal, exact revert recovers (AT10)', { skip: skip('P05-S5-E05') }, async () => {
      const w = await world(group, '2026-10-24T12:00:00-05:00'), A = await w.tenant('H01', '1000000.00'), o: Record<string, unknown> = {}, db = w.db;
      const b = await w.borrower(A, 'H01_B');
      const Ld = await w.confirmed(A, 'Ld', b, {}, false), Lc = await w.confirmed(A, 'Lc', b), Lq = await w.confirmed(A, 'Lq', b), Lv = await w.confirmed(A, 'Lv', b), Lr = await w.confirmed(A, 'Lr', b), Lo = await w.confirmed(A, 'Lo', b);
      await w.connect(A);
      const loanTag = async (id: string) => String((await A.c.call('GET', `${w.base(A.org)}/loans/${id}`)).headers['etag']);
      const lending = async (op: string, id: string, payload: Record<string, unknown>, etag: string) => { const key = crypto.randomUUID(), purpose = op === 'confirmation' ? 'LOAN_TERMS_CONFIRM' : 'LOAN_TERMS_REPLACE';
        const a32 = await A.c.call('POST', '/api/v1/auth/reauthenticate', { password: (await import('./review-profile.js')).password, purpose, command: { organizationId: A.org, idempotencyKey: key, payload, expectedETag: etag }, resourceId: id }) as Reply;
        if (a32.status === 200) { w.f.clock.value += 30000; const { generate } = await import('otplib'); await A.c.call('POST', '/api/v1/auth/mfa/challenges/verify', { method: 'TOTP', purpose, code: await generate({ secret: A.a.secret, epoch: Math.floor(w.f.now() / 1000) }), resourceId: id }); await A.c.refreshCsrf(); }
        const cmd = st(await A.c.call(op === 'confirmation' ? 'POST' : 'PUT', `${w.base(A.org)}/loans/${id}/${op === 'confirmation' ? 'confirmation' : 'terms'}`, payload, { 'Idempotency-Key': key, 'If-Match': etag }) as Reply);
        return a32.status === 200 ? cmd : `A32 ${st(a32)} -> ${cmd}`; };
      const closed = (v: string) => /^(503 INTEGRITY_MISMATCH|A32 503 INTEGRITY_MISMATCH -> 40[13] [A-Z_]+)$/.test(v);
      const loanDoc = async (id: string) => await db.collection('lending_loans').findOne({ _id: id as never }) as Record<string, unknown>;
      const restoreDoc = async (coll: string, d: Record<string, unknown>) => { await db.collection(coll).replaceOne({ _id: d['_id'] as never }, d); };
      const cases: Record<string, unknown> = {};
      // DRAFT 1000 -> 9000 then confirm (the S4 finding).
      { const d = await loanDoc(Ld), q = (await db.collection('lending_quotes').findOne({ _id: d['quoteId'] as never }))!, et = await loanTag(Ld);
        await db.collection('lending_loans').updateOne({ _id: Ld as never }, { $set: { 'terms.principal': '9000.00', 'calculation.totals.principal': '9000.00' } });
        const confirm = await lending('confirmation', Ld, { quoteId: q['_id'], quoteFingerprint: q['fingerprint'], termsVersion: 1 }, et);
        const stillTampered = ((await loanDoc(Ld))['terms'] as { principal: string }).principal, status = (await loanDoc(Ld))['status'];
        await restoreDoc('lending_loans', d); const afterRevert = await lending('confirmation', Ld, { quoteId: q['_id'], quoteFingerprint: q['fingerprint'], termsVersion: 1 }, et);
        cases['DRAFT principal 1000->9000, confirm'] = { confirm, stillTampered, status, afterExactRevert: afterRevert }; assert.ok(closed(confirm), confirm); assert.equal(status, 'DRAFT'); assert.equal(afterRevert, '200'); }
      // TERMS_CONFIRMED tampered -> disburse preview and replace denied.
      { const d = await loanDoc(Lc), req = await w.disburseRequest(A, Lc), et = await loanTag(Lc);
        const qn = data(await A.c.call('POST', w.base(A.org) + '/loan-quotes', { terms: w.termsOf(A, b, { principal: '1200.00' }) }, { 'Idempotency-Key': crypto.randomUUID() }) as Reply) as { id: string; fingerprint: string };
        await db.collection('lending_loans').updateOne({ _id: Lc as never }, { $set: { 'terms.principal': '9000.00' } });
        const preview = st((await w.preview(A, req)).res), readLoan = st(await A.c.call('GET', `${w.base(A.org)}/loans/${Lc}`) as Reply);
        const replace = await lending('terms', Lc, { quoteId: qn.id, quoteFingerprint: qn.fingerprint, changeReason: 'Reemplazo sobre dato alterado' }, et);
        await restoreDoc('lending_loans', d); const after = st((await w.run(A, await w.disburseRequest(A, Lc))));
        cases['CONFIRMED principal tampered: disburse/replace'] = { preview, readLoan, replace, afterExactRevertDisburse: after }; assert.equal(preview, '503 INTEGRITY_MISMATCH'); assert.ok(closed(replace), replace); assert.equal(after, '201'); }
      // Quote calculation tampered; loan version tampered.
      for (const [label, id, coll, field] of [['quote totals tampered', Lq, 'lending_quotes', 'totals.interest'], ['loan version calculation tampered', Lv, 'lending_loan_versions', 'calculation.totals.interest']] as const) {
        const d = await loanDoc(id), req = await w.disburseRequest(A, id), target = (coll === 'lending_quotes' ? await db.collection(coll).findOne({ _id: d['quoteId'] as never }) : await db.collection(coll).findOne({ loanId: id }))!;
        await db.collection(coll).updateOne({ _id: target['_id'] }, { $set: { [field]: '0.01' } });
        const preview = st((await w.preview(A, req)).res);
        await restoreDoc(coll, target); const after = st(await w.run(A, await w.disburseRequest(A, id)));
        cases[label] = { preview, afterExactRevertDisburse: after }; assert.equal(preview, '503 INTEGRITY_MISMATCH', label); assert.equal(after, '201', label);
      }
      // S5 documents tampered after disbursement; another loan keeps working; tampered loan stays closed (no absorption).
      await w.run(A, await w.disburseRequest(A, Lr)); await w.run(A, await w.disburseRequest(A, Lo));
      const s5: Record<string, unknown> = {};
      for (const [label, coll, filter, set] of [['installment interest', 'loan_installments', { loanId: Lr, number: 2 }, { interest: '0.01' }], ['position principalOutstanding', 'loan_positions', { loanId: Lr }, { principalOutstanding: '1.00' }], ['schedule version row', 'loan_schedule_versions', { loanId: Lr }, { remainingPrincipal: '1.00' }]] as const) {
        const d = (await db.collection(coll).findOne(filter as never))!; await db.collection(coll).updateOne({ _id: d['_id'] }, { $set: set });
        const read = st(await w.get(A, '/loan-operations/positions/' + Lr)), other = st(await w.run(A, await w.receiptRequest(A, b, '1.00', [{ loanId: Lo, amount: '1.00' }], 'CREDIT')));
        const readAgain = st(await w.get(A, '/loan-operations/positions/' + Lr));
        await restoreDoc(coll, d); const healed = st(await w.get(A, '/loan-operations/positions/' + Lr));
        s5[label] = { readTampered: read, otherLoanCommand: other, tamperedStillClosedAfterOtherCommit: readAgain, afterExactRevert: healed };
        assert.equal(read, '503 INTEGRITY_MISMATCH', label); assert.equal(readAgain, '503 INTEGRITY_MISMATCH', label); assert.equal(healed, '200', label);
      }
      cases['S5 documents'] = s5; o['cases'] = cases;
      evidence('P05-S5-E05', { observed: o });
    });

    await t.test('P05-S5-E06 H-S4-02: cost for B with 0/100/300 quotes in A (latency, A documents read by B), retention without purge, restart (AT11)', { skip: skip('P05-S5-E06') }, async () => {
      const w = await world(group, '2026-10-24T07:00:00-05:00'), A = await w.tenant('H02A', '1000.00'), B = await w.tenant('H02B', '1000000.00'), o: Record<string, unknown> = {};
      const bA = await w.borrower(A, 'H02_A'), bB = await w.borrower(B, 'H02_B'); const LB = await w.confirmed(B, 'LB', bB, { principal: '100.00' });
      const { evidenceMetrics } = await import('../../../src/modules/lending/evidence-v2.js');
      await w.connect(B); assert.equal((await w.run(B, await w.disburseRequest(B, LB))).status, 201);
      const sample = async () => {
        const times: number[] = [], reads: number[] = [], nodes: number[] = [];
        for (let k = 0; k < 5; k++) {
          const req = await w.receiptRequest(B, bB, '1.00', [{ loanId: LB, amount: '1.00' }], 'CREDIT'), etag = await w.book(B), r0 = evidenceMetrics.documentReads, n0 = evidenceMetrics.indexNodesRead;
          const t0 = performance.now(), q = await B.c.call('POST', w.base(B.org) + '/loan-quotes', { terms: w.termsOf(B, bB, { principal: (100 + k) + '.00' }) }, { 'Idempotency-Key': crypto.randomUUID() }) as Reply;
          const pv = await w.preview(B, req, undefined, etag);
          times.push(Math.round(performance.now() - t0)); reads.push(evidenceMetrics.documentReads - r0); nodes.push(evidenceMetrics.indexNodesRead - n0);
          assert.equal(q.status, 201); assert.equal(pv.res.status, 200);
        }
        times.sort((a, b2) => a - b2); return { p50ms: times[2], maxms: times[4], domainDocsReadPerQuotePlusPreview: Math.max(...reads), indexNodesRead: Math.max(...nodes) };
      };
      let made = 0; const cost: Record<string, unknown> = {};
      for (const target of [0, 100, 300]) {
        while (made < target) { // 30 per actor per UTC minute: advance the harness clock per window (no bypass)
          for (let k = 0; k < 30 && made < target; k++, made++) await w.f.runtime.lending.mutate(A.a.issued.context, 'createLoanQuote', A.org, { terms: w.termsOf(A, bA, { method: 'CONSTANT_PRINCIPAL', frequency: 'DAY', installmentCount: 360, firstDueDate: '2026-10-01', principal: '3600.00' }) }, crypto.randomUUID());
          w.setClock(new Date((Math.floor(w.f.now() / 60000) + 1) * 60000 + 1000).toISOString());
        }
        await w.connect(B); const m2 = await group.measure();
        cost[`A has ${target} quotes x360`] = { ...(await sample()), mongoBytes: m2.mongoBytes };
      }
      o['cost (B quote+preview ms, 5 samples)'] = cost;
      const quotesA = await w.db.collection('lending_quotes').countDocuments({ organizationId: A.org });
      const ttl = (await w.db.collection('lending_quotes').indexes()).filter(i => 'expireAfterSeconds' in i).length, windowsTtl = (await w.db.collection('lending_rate_windows').indexes()).filter(i => 'expireAfterSeconds' in i).length;
      // Restart: a fresh restore controller opens and the quotes are all still there.
      const { RestoreController } = await import('../../../src/shared/restore.js'); await w.f.restore.flush();
      const c2 = new RestoreController(w.f.database, w.f.restore.gatePath, w.f.keys.journal); await c2.initialize();
      o['retention'] = { quotesInA: quotesA, expected: 300, ttlIndexesOnQuotes: ttl, ttlIndexOnRateWindowsOnly: windowsTtl, restartOpen: c2.isOpen(), quotesAfterRestart: await w.db.collection('lending_quotes').countDocuments({ organizationId: A.org }) };
      assert.equal(quotesA, 300); assert.equal(ttl, 0); assert.equal(c2.isOpen(), true);
      const rd = Object.values(cost).map(v => (v as { domainDocsReadPerQuotePlusPreview: number }).domainDocsReadPerQuotePlusPreview);
      assert.ok(rd[2]! - rd[0]! < 50, 'B reads must not grow with A quotes: ' + JSON.stringify(rd));
      evidence('P05-S5-E06', { observed: o });
    });

    await t.test('P05-S5-E07 restore with S5 sources: complete cut, offline tampering per source/tree/head, incomplete restore, pre-event cut (AT14)', { skip: skip('P05-S5-E07') }, async () => {
      const w = await world(group, '2026-10-24T12:00:00-05:00'), A = await w.tenant('REST', '1000000.00'), o: Record<string, unknown> = {}, db = w.db;
      const b = await w.borrower(A, 'REST_B'); const L1 = await w.confirmed(A, 'L1', b, { principal: '1000.00' });
      await w.connect(A);
      const { RestoreController } = await import('../../../src/shared/restore.js');
      const preEvents = await w.f.restore.snapshot();
      assert.equal((await w.run(A, await w.disburseRequest(A, L1))).status, 201);
      w.setClock('2026-10-31T12:00:00-05:00'); await w.connect(A);
      assert.equal((await w.run(A, await w.receiptRequest(A, b, '300.00', [{ loanId: L1, amount: '300.00' }], 'CREDIT'))).status, 201);
      await w.f.restore.flush();
      const restart = async () => { const c2 = new RestoreController(w.f.database, w.f.restore.gatePath, w.f.keys.journal); await c2.initialize(); return c2; };
      const position = async () => JSON.stringify(await db.collection('loan_positions').findOne({ loanId: L1 }));
      const before = await position(); o['restart'] = { open: (await restart()).isOpen() };
      const full = await w.f.restore.snapshot(); await w.f.restore.beginRestore(full); await w.f.restore.reconcile({ approved: true, reviewId: 'P05-S5-full-cut' });
      o['complete cut'] = { open: w.f.restore.isOpen(), samePosition: before === await position() }; assert.equal(w.f.restore.isOpen(), true);
      const cases: Record<string, unknown> = {};
      const check = async (label: string, mutate: () => Promise<() => Promise<void>>) => {
        const revert = await mutate(); const c1 = await restart(), open = c1.isOpen(); let rec = 'reconciled'; try { await c1.reconcile({ approved: true, reviewId: 'P05-S5-tampered' }); } catch (e) { rec = (e as { code?: string }).code ?? 'refused'; }
        await revert(); const c2 = await restart(); if (!c2.isOpen()) await c2.reconcile({ approved: true, reviewId: 'P05-S5-exact-revert' });
        cases[label] = { openWhileTampered: open, reconcileWhileTampered: rec, openAfterExactRevert: c2.isOpen() };
      };
      const edit = (coll: string, filter: Record<string, unknown>, set: Record<string, unknown>) => async () => { const d = (await db.collection(coll).findOne(filter as never))!; await db.collection(coll).updateOne({ _id: d['_id'] }, { $set: set }); return async () => { await db.collection(coll).replaceOne({ _id: d['_id'] }, d); }; };
      const drop = (coll: string, filter: Record<string, unknown>) => async () => { const d = (await db.collection(coll).findOne(filter as never))!; await db.collection(coll).deleteOne({ _id: d['_id'] }); return async () => { await db.collection(coll).insertOne(d); }; };
      await check('event plan edited', edit('loan_events', { organizationId: A.org, kind: 'RECEIPT' }, { 'plan.creditChange.after': '9.99' }));
      await check('installment principalPaid edited', edit('loan_installments', { loanId: L1, number: 1 }, { principalPaid: '1.00' }));
      await check('application deleted', drop('loan_applications', { organizationId: A.org }));
      await check('borrower credit balance edited', edit('borrower_credits', { organizationId: A.org }, { balance: '999.00' }));
      await check('LOAN_OPERATION journal edited', edit('financial_journals', { organizationId: A.org, 'source.type': 'LOAN_OPERATION' }, { supportReference: 'ALTERED' }));
      await check('merkle node data edited', edit('lending_merkle_nodes', { namespace: A.org }, { 'data.documentHash': '0'.repeat(64) }));
      await check('merkle org counts edited', edit('lending_merkle_orgs', { _id: A.org }, { 'counts.loan_events': 99 }));
      await check('evidence head mac edited', edit('lending_domain_state', { _id: 'evidence' }, { mac: '0'.repeat(64) }));
      await check('operations book version edited', edit('loan_operation_books', { _id: A.org }, { version: 99 }));
      await check('incomplete restore: positions missing', drop('loan_positions', { loanId: L1 }));
      o['offline tampering'] = cases;
      for (const [k, v] of Object.entries(cases)) { const c3 = v as { openWhileTampered: boolean; reconcileWhileTampered: string; openAfterExactRevert: boolean }; assert.equal(c3.openWhileTampered, false, k); assert.notEqual(c3.reconcileWhileTampered, 'reconciled', k); assert.equal(c3.openAfterExactRevert, true, k); }
      // Older cut (before the S5 events) on a system that already has S5 history.
      let pre = 'reconciled'; try { await w.f.restore.beginRestore(preEvents); await w.f.restore.reconcile({ approved: true, reviewId: 'P05-S5-pre-cut' }); } catch (e) { pre = (e as { code?: string }).code ?? 'refused'; }
      o['pre-event cut after S5 history'] = { reconcile: pre, open: w.f.restore.isOpen(), eventsAfter: await db.collection('loan_events').countDocuments({ organizationId: A.org }) };
      if (!w.f.restore.isOpen()) { await w.f.restore.beginRestore(full); await w.f.restore.reconcile({ approved: true, reviewId: 'P05-S5-back-to-full' }); }
      assert.equal(w.f.restore.isOpen(), true);
      evidence('P05-S5-E07', { observed: o });
    });
  } finally {
    process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal);
    if (!interrupted) await group.dispose(t.signal.aborted ? 'aborted' : 'end');
  }
});
