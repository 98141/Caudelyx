// MEJ-5 economic oracle (Claude). MEJ changes authentication/presentation only; money rules S2–S5 are unchanged.
// This adapter reuses, READ-ONLY, the reviewer's own independent oracles written for S04-P05/S05-P05-v2
// (tests/independent/s05/economic-oracle.ts sha256 50b1e0df…8b1c, tests/independent/s04/oracle.ts sha256 8db7e62f…7bc5),
// which never import a production module. Expectations are computed here from terms; nothing is copied from the author.
import { Book, c, m, fmtPostings, type Step } from '../s05/economic-oracle.js';
import type { OracleTerms } from '../s04/oracle.js';

export { c, m };
export const ORACLE_SOURCES = {
  's05/economic-oracle.ts': '50b1e0df5398e723e1eadd4cdd9615842c437e2b47d999efbd84892f5e2e8b1c',
  's04/oracle.ts': '8db7e62fe26a721f8b2ed751fe27b3e0adfa0d37500533ad0c609b8e564a7bc5',
};

/** S2: natural balances (debit − credit, cents) after a sequence of balanced journals; reversal = mirrored lines. */
export function ledgerOracle(journals: { lines: { account: string; debit: string; credit: string }[] }[]) {
  const out = new Map<string, bigint>();
  for (const j of journals) {
    let d = 0n;
    for (const l of j.lines) { const delta = c(l.debit) - c(l.credit); d += delta; out.set(l.account, (out.get(l.account) ?? 0n) + delta); }
    if (d !== 0n) throw Error('oracle: unbalanced journal');
  }
  return out;
}
export const mirror = (lines: { account: string; debit: string; credit: string }[]) => lines.map(l => ({ account: l.account, debit: l.credit, credit: l.debit }));

/** S5 scenario: fund BANK, disburse L, accrue through the first due date, receipt with excess to credit, apply credit. */
export function s5Scenario(terms: OracleTerms, o: { funding: bigint; receipt: bigint; receiptBudget: bigint; creditApply: bigint; disburseDay: string; dueDay: string }) {
  const book = new Book(['BANK']);
  book.fund('BANK', o.funding);
  book.addLoan('L', 'B', terms);
  const steps: Record<string, Step> = {};
  steps['disburse'] = book.disburse('L', 'BANK');
  const afterDisburse = book.view('L', o.disburseDay);
  steps['accrue'] = book.accrue('L', o.dueDay, o.dueDay);
  steps['receipt'] = book.collect('RECEIPT', 'B', o.receipt, [{ loan: 'L', amount: o.receiptBudget, mode: 'REGULAR' }], o.dueDay, { account: 'BANK', excess: 'CREDIT' });
  const creditAfterReceipt = book.credit.get('B') ?? 0n;
  steps['credit'] = book.collect('APPLY_CREDIT', 'B', o.creditApply, [{ loan: 'L', amount: o.creditApply, mode: 'REGULAR' }], o.dueDay);
  return {
    steps: Object.fromEntries(Object.entries(steps).map(([k, s]) => [k, fmtPostings(s.postings)])),
    afterDisburse, final: book.view('L', o.dueDay), creditAfterReceipt: m(creditAfterReceipt), creditFinal: m(book.credit.get('B') ?? 0n),
    balances: Object.fromEntries([...book.balances].map(([k, v]) => [k, m(v)])), installments: book.installments('L'),
  };
}
