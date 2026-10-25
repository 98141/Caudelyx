/* eslint-disable security/detect-object-injection -- Array indexes of own computed schedules, never request input. */
// S05-P05 independent economic oracle (Claude). Recomputes S05 loan operations from the APPROVED policy text
// (OPERATIONS_S05 O3/O4/O8, ACCOUNTING_ALLOCATION_S05 A1–A4, DC02/DC03) WITHOUT importing any production module.
// Amortization of an original or revised schedule reuses the reviewer's own S4 oracle (tests/independent/s04/oracle.ts),
// which never imported the engine either. Money is integer cents (BigInt); no float anywhere.
import { dueDates, oracle as s4oracle, type OracleTerms, type Row } from '../s04/oracle.js';

export type Sym = 'CASH' | 'PRINCIPAL' | 'INTEREST_RECEIVABLE' | 'INTEREST_INCOME' | 'BORROWER_CREDIT';
export interface Inst { version: number; k: number; dueDate: string; principal: bigint; interest: bigint; pPaid: bigint; iPaid: bigint; active: boolean }
export interface OLoan { id: string; borrower: string; terms: OracleTerms; status: 'NOT_DISBURSED' | 'ACTIVE' | 'SETTLED'; version: number; rows: Inst[]; accrued: Set<string>; pOut: bigint; original: bigint; revisions: { version: number; remaining: bigint; rows: Inst[] }[] }
export interface Posting { account: Sym | string; debit: bigint; credit: bigint }
export interface App { loan: string; version: number; k: number; component: 'INTEREST' | 'DUE_PRINCIPAL' | 'EXTRA_PRINCIPAL'; amount: bigint }
export interface Step { postings: Posting[]; applications: App[]; accruals: { loan: string; version: number; k: number; interest: bigint }[]; creditAdded: bigint; creditApplied: bigint; journal: boolean }
export class OracleError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const fail = (status: number, code: string): never => { throw new OracleError(status, code); };
export const c = (s: string) => { if (!/^\d+\.\d{2}$/.test(s)) throw Error('bad money ' + s); return BigInt(s.replace('.', '')); };
export const m = (v: bigint) => { const neg = v < 0n, a = neg ? -v : v; return (neg ? '-' : '') + (a / 100n).toString() + '.' + (a % 100n).toString().padStart(2, '0'); };

/** Amortize P over n periods with the approved S4 math (own S4 oracle, same frequency/rate/method), then attach the
 *  GIVEN (preserved) dates: S4 amounts depend only on P, n, i24 and method, never on the calendar. */
export function amortize(terms: OracleTerms, principal: bigint, dates: string[]): { k: number; date: string; principal: bigint; interest: bigint; payment: bigint }[] {
  const n = dates.length; if (n === 0) return [];
  const effectiveDate = terms.frequency === 'SEMIMONTH' ? '2024-01-15' : '2024-01-31', first = dueDates({ effectiveDate, frequency: terms.frequency, installmentCount: 1 });
  if (!Array.isArray(first)) throw Error('own calendar rejected synthetic anchor');
  const o = s4oracle({ ...terms, principal: m(principal), installmentCount: n, effectiveDate, firstDueDate: first[0]! });
  if ('error' in o) throw new OracleError(422, o.error);
  return o.value.schedule.map((r: Row, j) => ({ k: j + 1, date: dates[j]!, principal: c(r.principal), interest: c(r.interest), payment: c(r.payment) }));
}
/** Original S4 schedule (dates and amounts) from the own S4 oracle. */
export function originalSchedule(terms: OracleTerms) { const o = s4oracle(terms); if ('error' in o) throw Error('terms rejected by own S4 oracle: ' + o.error); return o.value.schedule.map(r => ({ k: r.k, date: r.date, principal: c(r.principal), interest: c(r.interest), payment: c(r.payment) })); }

export class Book {
  readonly balances = new Map<string, bigint>(); readonly loans = new Map<string, OLoan>(); readonly credit = new Map<string, bigint>();
  constructor(readonly cashAccounts: string[] = ['CASH']) {}
  private post(step: Step, account: string, delta: bigint) { this.balances.set(account, (this.balances.get(account) ?? 0n) + delta); const e = step.postings.find(p => p.account === account); if (e) { e.debit += delta; } else step.postings.push({ account, debit: delta, credit: 0n }); }
  private finish(step: Step): Step {
    step.postings = step.postings.filter(p => p.debit !== 0n).map(p => p.debit > 0n ? { account: p.account, debit: p.debit, credit: 0n } : { account: p.account, debit: 0n, credit: -p.debit });
    const d = step.postings.reduce((n, p) => n + p.debit - p.credit, 0n); if (d !== 0n) throw Error('oracle unbalanced');
    step.journal = step.postings.length > 0; return step;
  }
  fund(account: string, amount: bigint) { this.balances.set(account, (this.balances.get(account) ?? 0n) + amount); }
  addLoan(id: string, borrower: string, terms: OracleTerms) { this.loans.set(id, { id, borrower, terms, status: 'NOT_DISBURSED', version: 0, rows: [], accrued: new Set(), pOut: 0n, original: c(terms.principal), revisions: [] }); }
  disburse(id: string, fundingAccount: string): Step {
    const l = this.loans.get(id)!; if (l.status !== 'NOT_DISBURSED') fail(409, 'ALREADY_DISBURSED');
    if ((this.balances.get(fundingAccount) ?? 0n) < l.original) fail(409, 'ACCOUNT_OVERDRAFT');
    const step: Step = { postings: [], applications: [], accruals: [], creditAdded: 0n, creditApplied: 0n, journal: false };
    this.post(step, 'PRINCIPAL', l.original); this.post(step, fundingAccount, -l.original);
    l.rows = originalSchedule(l.terms).map(r => ({ version: 1, k: r.k, dueDate: r.date, principal: r.principal, interest: r.interest, pPaid: 0n, iPaid: 0n, active: true }));
    l.revisions.push({ version: 1, remaining: l.original, rows: l.rows.map(r => ({ ...r })) });
    l.status = 'ACTIVE'; l.version = 1; l.pOut = l.original; return this.finish(step);
  }
  private accrueInto(step: Step, l: OLoan, through: string) {
    for (const r of l.rows.filter(r => r.active && r.dueDate <= through).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.k - b.k)) {
      const key = r.version + ':' + r.k; if (l.accrued.has(key)) continue; l.accrued.add(key);
      step.accruals.push({ loan: l.id, version: r.version, k: r.k, interest: r.interest }); this.post(step, 'INTEREST_RECEIVABLE', r.interest); this.post(step, 'INTEREST_INCOME', -r.interest);
    }
  }
  accrue(id: string, through: string, today: string): Step {
    const l = this.loans.get(id)!; if (l.status !== 'ACTIVE') fail(409, 'STATE_CONFLICT'); if (through > today) fail(422, 'INPUT_INVALID');
    const step: Step = { postings: [], applications: [], accruals: [], creditAdded: 0n, creditApplied: 0n, journal: false };
    this.accrueInto(step, l, through); if (!step.accruals.length) fail(409, 'NO_ACCRUAL_DUE'); this.settle(l, today); return this.finish(step);
  }
  /** RECEIPT (cash) or APPLY_CREDIT (no cash): DC03 priority per loan, budgets as limits, remainder to credit or rejection. */
  collect(kind: 'RECEIPT' | 'APPLY_CREDIT', borrower: string, amount: bigint, targets: { loan: string; amount: bigint; mode: 'REGULAR' | 'EXTRA_PRINCIPAL' }[], today: string, o: { account?: string; excess?: 'CREDIT' | 'REJECT' } = {}): Step {
    if (targets.length < 1 || targets.length > 10 || amount <= 0n || targets.some(t => t.amount <= 0n)) fail(422, 'INPUT_INVALID');
    const budgets = targets.reduce((n, t) => n + t.amount, 0n); if (budgets > amount || kind === 'APPLY_CREDIT' && budgets !== amount) fail(422, 'INPUT_INVALID');
    if (new Set(targets.map(t => t.loan)).size !== targets.length) fail(422, 'INPUT_INVALID');
    for (const t of targets) { const l = this.loans.get(t.loan); if (!l) fail(404, 'RESOURCE_NOT_FOUND'); if (l!.borrower !== borrower) fail(422, 'INPUT_INVALID'); if (l!.status !== 'ACTIVE') fail(409, 'STATE_CONFLICT'); }
    if (kind === 'APPLY_CREDIT' && amount > (this.credit.get(borrower) ?? 0n)) fail(409, 'CREDIT_INSUFFICIENT');
    const step: Step = { postings: [], applications: [], accruals: [], creditAdded: 0n, creditApplied: 0n, journal: false };
    let applied = 0n;
    for (const t of targets) {
      const l = this.loans.get(t.loan)!; this.accrueInto(step, l, today);
      const due = l.rows.filter(r => r.active && r.dueDate <= today).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.k - b.k);
      let left = t.amount;
      const give = (r: Inst, component: App['component'], v: bigint) => { if (v <= 0n) return; step.applications.push({ loan: l.id, version: r.version, k: r.k, component, amount: v }); left -= v; applied += v;
        if (component === 'INTEREST') { r.iPaid += v; this.post(step, 'INTEREST_RECEIVABLE', -v); } else { if (component === 'DUE_PRINCIPAL') r.pPaid += v; l.pOut -= v; this.post(step, 'PRINCIPAL', -v); } };
      for (const r of due) give(r, 'INTEREST', r.interest - r.iPaid < left ? r.interest - r.iPaid : left);
      for (const r of due) give(r, 'DUE_PRINCIPAL', r.principal - r.pPaid < left ? r.principal - r.pPaid : left);
      if (t.mode === 'EXTRA_PRINCIPAL') {
        const anchor = due.find(r => r.dueDate === today);
        if (!anchor || due.some(r => r.pPaid !== r.principal || r.iPaid !== r.interest)) fail(422, 'UNSUPPORTED_PAYMENT_VARIANT');
        const extra = l.pOut < left ? l.pOut : left;
        if (extra > 0n) {
          give(anchor!, 'EXTRA_PRINCIPAL', extra);
          const future = l.rows.filter(r => r.active && r.dueDate > today).sort((a, b) => a.k - b.k), version = l.version + 1;
          for (const r of future) r.active = false;
          const rows = l.pOut > 0n ? amortize(l.terms, l.pOut, future.map(r => r.dueDate)).map((r, j) => ({ version, k: future[0]!.k + j, dueDate: r.date, principal: r.principal, interest: r.interest, pPaid: 0n, iPaid: 0n, active: true })) : [];
          l.rows.push(...rows); l.version = version; l.revisions.push({ version, remaining: l.pOut, rows: rows.map(r => ({ ...r })) });
        }
      }
    }
    const remainder = amount - applied;
    if (kind === 'RECEIPT') {
      if (remainder > 0n && o.excess === 'REJECT') fail(409, 'EXCESS_NOT_ALLOWED');
      this.post(step, o.account ?? 'CASH', amount); this.post(step, 'BORROWER_CREDIT', -remainder); step.creditAdded = remainder;
      this.credit.set(borrower, (this.credit.get(borrower) ?? 0n) + remainder);
    } else {
      if (remainder !== 0n) fail(409, 'EXCESS_NOT_ALLOWED');
      this.post(step, 'BORROWER_CREDIT', amount); step.creditApplied = amount; this.credit.set(borrower, (this.credit.get(borrower) ?? 0n) - amount);
    }
    for (const t of targets) this.settle(this.loans.get(t.loan)!, today);
    return this.finish(step);
  }
  private settle(l: OLoan, today: string) {
    const active = l.rows.filter(r => r.active), accruedOut = this.accruedOutstanding(l);
    const dueUnrecognized = active.filter(r => r.dueDate <= today && !l.accrued.has(r.version + ':' + r.k)).reduce((n, r) => n + r.interest, 0n);
    const futureInterest = active.filter(r => r.dueDate > today).reduce((n, r) => n + r.interest, 0n);
    if (l.pOut === 0n && accruedOut === 0n && dueUnrecognized === 0n && futureInterest === 0n) l.status = 'SETTLED';
  }
  accruedOutstanding(l: OLoan) { let acc = 0n; for (const r of l.rows) if (l.accrued.has(r.version + ':' + r.k)) acc += r.interest; return acc - l.rows.reduce((n, r) => n + r.iPaid, 0n); }
  view(id: string, today: string) {
    const l = this.loans.get(id)!, active = l.rows.filter(r => r.active);
    let accrued = 0n; for (const r of l.rows) if (l.accrued.has(r.version + ':' + r.k)) accrued += r.interest;
    const collected = l.rows.reduce((n, r) => n + r.iPaid, 0n);
    return { status: l.status, originalPrincipal: m(l.original), principalOutstanding: m(l.pOut), duePrincipal: m(active.filter(r => r.dueDate <= today).reduce((n, r) => n + r.principal - r.pPaid, 0n)),
      expectedFutureInterest: m(active.filter(r => r.dueDate > today).reduce((n, r) => n + r.interest, 0n)), dueUnrecognizedInterest: m(active.filter(r => r.dueDate <= today && !l.accrued.has(r.version + ':' + r.k)).reduce((n, r) => n + r.interest, 0n)),
      accruedInterestTotal: m(accrued), collectedInterestTotal: m(collected), accruedOutstandingInterest: m(accrued - collected), scheduleVersion: l.version };
  }
  installments(id: string) { return this.loans.get(id)!.rows.filter(r => r.active).sort((a, b) => a.k - b.k).map(r => ({ number: r.k, dueDate: r.dueDate, principal: m(r.principal), interest: m(r.interest), principalPaid: m(r.pPaid), interestPaid: m(r.iPaid), scheduleVersion: r.version })); }
}
export const fmtPostings = (p: Posting[], name: (a: string) => string = a => a) => p.map(x => ({ account: name(x.account), debit: m(x.debit), credit: m(x.credit) })).sort((a, b) => a.account.localeCompare(b.account));
export const fmtApps = (a: App[], name: (l: string) => string = l => l) => a.map(x => ({ loan: name(x.loan), scheduleVersion: x.version, installmentNumber: x.k, component: x.component, amount: m(x.amount) }));
