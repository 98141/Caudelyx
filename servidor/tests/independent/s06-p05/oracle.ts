// S06-P05 independent economic oracle (Claude). Extends the reviewer's own S5 oracle (tests/independent/s05, which itself
// never imported production code) with the APPROVED S6 rules as written in PAYMENTS_S06 P1–P5, ACCOUNTING_REVERSALS_S06
// R1–R3, RECONCILIATION_S06 and AP6-02 «A: reservar CASH confirmado hasta S7». No production module is imported.
// Money is integer cents (BigInt).
import { Book, OracleError, m, type Step, type App, type Inst } from '../s05/economic-oracle.js';
export { Book, OracleError, m };
export { c } from '../s05/economic-oracle.js';

const fail = (status: number, code: string): never => { throw new OracleError(status, code); };
type Target = { loan: string; amount: bigint; mode: 'REGULAR' | 'EXTRA_PRINCIPAL' };
export interface OPayment {
  id: string; method: 'CASH' | 'BANK'; mode: 'DIRECT' | 'SUPERVISED'; borrower: string; amount: bigint; account: string; targets: Target[]; excess: 'CREDIT' | 'REJECT';
  registrar: string; custodian: string | null; status: 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'CANCELLED' | 'REVERSAL_REQUESTED' | 'REVERSED';
  custody: 'NOT_APPLICABLE' | 'PROVISIONAL' | 'CONFIRMED_HELD' | 'RETURN_REQUIRED' | 'RETURNED' | 'HELD_UNALLOCATED'; reconciliation: 'NOT_APPLICABLE' | 'PENDING' | 'RECONCILED' | 'DISCREPANCY' | 'INVESTIGATION';
  eventSeq: number | null;
}
interface OEvent { seq: number; kind: 'RECEIPT' | 'APPLY_CREDIT' | 'ACCRUE' | 'DISBURSE'; borrower: string; loans: string[]; step: Step; payment: string | null; before: Map<string, { rows: Inst[]; pOut: bigint; version: number; status: string }>; effectiveDate: string; compensated: boolean; creditChange: boolean; reversedOn?: string }

export class S6Book extends Book {
  readonly payments = new Map<string, OPayment>(); readonly events: OEvent[] = [];
  /** HELD_FUNDS reservations by receiving account (AP6-03 A) and confirmed CASH custody reserve (AP6-02 A). */
  readonly held = new Map<string, bigint>(); readonly confirmedCash = new Map<string, bigint>();
  constructor(readonly heldAccount = 'HELD') { super(); }
  /** Funds an account can spend in S2/S5/S6 writers: ledger balance minus confirmed custody minus HELD_FUNDS (provisional never counted). */
  available(account: string) { return (this.balances.get(account) ?? 0n) - (this.confirmedCash.get(account) ?? 0n) - (this.held.get(account) ?? 0n); }
  /** Spend from an account (S2 transfer/S5 disbursement): rejected if it invades reserved money. */
  spend(account: string, amount: bigint, to: string) { if (this.available(account) < amount) fail(409, 'ACCOUNT_OVERDRAFT'); this.balances.set(account, (this.balances.get(account) ?? 0n) - amount); this.balances.set(to, (this.balances.get(to) ?? 0n) + amount); }
  private snapshotLoans(ids: string[]) { const out = new Map<string, { rows: Inst[]; pOut: bigint; version: number; status: string }>(); for (const id of ids) { const l = this.loans.get(id)!; out.set(id, { rows: l.rows.map(r => ({ ...r })), pOut: l.pOut, version: l.version, status: l.status }); } return out; }
  register(id: string, p: Omit<OPayment, 'id' | 'status' | 'custody' | 'reconciliation' | 'eventSeq'>, today: string): Step | null {
    if (this.payments.has(id)) fail(409, 'RECEIPT_REFERENCE_CONFLICT');
    const pay: OPayment = { ...p, id, status: 'PENDING', custody: p.method === 'CASH' ? 'PROVISIONAL' : 'NOT_APPLICABLE', reconciliation: p.method === 'BANK' ? 'PENDING' : 'NOT_APPLICABLE', eventSeq: null };
    if (p.method === 'BANK' && p.custodian !== null) fail(422, 'INPUT_INVALID');
    this.payments.set(id, pay);
    // SUPERVISED: memo only — no ledger, debt, income or custody reserve (provisional is outside the ledger).
    return p.mode === 'DIRECT' ? this.confirm(pay, today) : null;
  }
  private confirm(pay: OPayment, today: string): Step {
    const before = this.snapshotLoans(pay.targets.map(t => t.loan));
    const step = this.collect('RECEIPT', pay.borrower, pay.amount, pay.targets, today, { account: pay.account, excess: pay.excess });
    pay.status = 'CONFIRMED'; if (pay.method === 'CASH') { pay.custody = 'CONFIRMED_HELD'; this.confirmedCash.set(pay.account, (this.confirmedCash.get(pay.account) ?? 0n) + pay.amount); }
    const seq = this.events.length + 1; pay.eventSeq = seq;
    this.events.push({ seq, kind: 'RECEIPT', borrower: pay.borrower, loans: pay.targets.map(t => t.loan), step, payment: pay.id, before, effectiveDate: today, compensated: false, creditChange: step.creditAdded > 0n || step.creditApplied > 0n });
    return step;
  }
  approve(id: string, approver: string, today: string): Step {
    const pay = this.payments.get(id)!; if (pay.status !== 'PENDING') fail(409, 'PAYMENT_STATE_CONFLICT'); if (approver === pay.registrar) fail(409, 'SEGREGATION_REQUIRED');
    return this.confirm(pay, today);
  }
  decline(id: string, how: 'REJECTED' | 'CANCELLED') { const pay = this.payments.get(id)!; if (pay.status !== 'PENDING') fail(409, 'PAYMENT_STATE_CONFLICT'); pay.status = how; if (pay.method === 'CASH') pay.custody = 'RETURN_REQUIRED'; }
  returnCash(id: string, amount: bigint) { const pay = this.payments.get(id)!; if (pay.custody !== 'RETURN_REQUIRED' || amount !== pay.amount) fail(409, 'PAYMENT_STATE_CONFLICT'); pay.custody = 'RETURNED'; }
  applyCredit(borrower: string, amount: bigint, targets: Target[], today: string): Step {
    const loans = targets.map(t => t.loan), before = this.snapshotLoans(loans), step = this.collect('APPLY_CREDIT', borrower, amount, targets, today);
    this.events.push({ seq: this.events.length + 1, kind: 'APPLY_CREDIT', borrower, loans, step, payment: null, before, effectiveDate: today, compensated: false, creditChange: true });
    return step;
  }
  accrueEvent(loan: string, through: string, today: string): Step { const step = this.accrue(loan, through, today); this.events.push({ seq: this.events.length + 1, kind: 'ACCRUE', borrower: this.loans.get(loan)!.borrower, loans: [loan], step, payment: null, before: new Map(), effectiveDate: today, compensated: false, creditChange: false }); return step; }
  /** ACCOUNTING_REVERSALS R1–R3: complete compensation of a RECEIPT/APPLY_CREDIT event; original stays; accrual kept. */
  reverse(seq: number, today: string): Step {
    const ev = this.events[seq - 1]; if (!ev) fail(404, 'RESOURCE_NOT_FOUND');
    if (ev!.kind !== 'RECEIPT' && ev!.kind !== 'APPLY_CREDIT') fail(422, 'UNSUPPORTED_REVERSAL_KIND');
    if (ev!.compensated) fail(409, 'ALREADY_REVERSED');
    for (const later of this.events.slice(seq)) {
      const sharesLoan = later.loans.some(l => ev!.loans.includes(l)), sharesCredit = ev!.creditChange && later.creditChange && later.borrower === ev!.borrower;
      if ((sharesLoan || sharesCredit) && !later.compensated) fail(409, 'REVERSAL_DEPENDENCY');
    }
    const pay = ev!.payment ? this.payments.get(ev!.payment)! : null;
    if (pay?.reconciliation === 'RECONCILED') fail(409, 'STATE_CONFLICT');
    if (pay) { const free = (this.balances.get(pay.account) ?? 0n) - (this.held.get(pay.account) ?? 0n); if (free < pay.amount) fail(409, 'FUNDS_NOT_HELD'); if (pay.method === 'CASH' && pay.custody !== 'CONFIRMED_HELD') fail(409, 'FUNDS_NOT_HELD'); }
    const creditDelta = ev!.step.creditApplied - ev!.step.creditAdded;
    if ((this.credit.get(ev!.borrower) ?? 0n) + creditDelta < 0n) fail(409, 'CREDIT_INSUFFICIENT');
    const step: Step = { postings: [], applications: [], accruals: [], creditAdded: 0n, creditApplied: 0n, journal: false };
    const post = (a: string, d: bigint) => { this.balances.set(a, (this.balances.get(a) ?? 0n) + d); const e = step.postings.find(p => p.account === a); if (e) e.debit += d; else step.postings.push({ account: a, debit: d, credit: 0n }); };
    for (const app of ev!.step.applications as App[]) {
      const l = this.loans.get(app.loan)!, row = l.rows.find(r => r.version === app.version && r.k === app.k)!;
      if (app.component === 'INTEREST') { row.iPaid -= app.amount; post('INTEREST_RECEIVABLE', app.amount); }
      else { if (app.component === 'DUE_PRINCIPAL') row.pPaid -= app.amount; l.pOut += app.amount; post('PRINCIPAL', app.amount); }
    }
    if (creditDelta !== 0n) { post('BORROWER_CREDIT', -creditDelta); this.credit.set(ev!.borrower, (this.credit.get(ev!.borrower) ?? 0n) + creditDelta); }
    for (const loanId of ev!.loans) {
      const l = this.loans.get(loanId)!, b = ev!.before.get(loanId)!;
      if (b.version !== l.version) {
        // EXTRA restore: new higher version copying the pre-event future rows (original dates), old versions kept inactive.
        const version = l.version + 1;
        for (const r of l.rows.filter(r => r.active && r.dueDate > ev!.effectiveDate)) r.active = false;
        const restored = b.rows.filter(r => r.active && r.dueDate > ev!.effectiveDate).map(r => ({ ...r, version, active: true }));
        l.rows.push(...restored); l.version = version; l.revisions.push({ version, remaining: l.pOut, rows: restored.map(r => ({ ...r })) });
      }
      if (l.pOut > 0n || this.accruedOutstanding(l) > 0n) l.status = 'ACTIVE';
    }
    if (pay) {
      post(this.heldAccount, -pay.amount); this.held.set(pay.account, (this.held.get(pay.account) ?? 0n) + pay.amount);
      if (pay.method === 'CASH') { this.confirmedCash.set(pay.account, (this.confirmedCash.get(pay.account) ?? 0n) - pay.amount); pay.custody = 'HELD_UNALLOCATED'; }
      else pay.reconciliation = 'INVESTIGATION';
      pay.status = 'REVERSED';
    }
    ev!.compensated = true; ev!.reversedOn = today;
    step.postings = step.postings.filter(p => p.debit !== 0n).map(p => p.debit > 0n ? { account: p.account, debit: p.debit, credit: 0n } : { account: p.account, debit: 0n, credit: -p.debit });
    if (step.postings.reduce((n, p) => n + p.debit - p.credit, 0n) !== 0n) throw Error('oracle reversal unbalanced');
    step.journal = step.postings.length > 0; return step;
  }
}

/** S4 terms of the review fixtures (CP 2M/4 monthly, effective 2026-09-30, first due 2026-10-31) with overrides. */
export const terms = (d: Record<string, unknown> = {}) => ({ principal: '2000000.00', effectiveDate: '2026-09-30', firstDueDate: '2026-10-31', installmentCount: 4, method: 'CONSTANT_PRINCIPAL', frequency: 'MONTH',
  rate: { type: 'EFFECTIVE', unit: 'MONTH', value: '0.030000000000' }, calendarConvention: 'PERIODIC_FIXED', holidayAdjustment: 'NO_SHIFT', policyVersion: 'S04-LOCAL-CO-0.1', jurisdiction: 'CO', usage: 'LOCAL_SYNTHETIC', ...d });
