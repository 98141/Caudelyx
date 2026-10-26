/**
 * Acceptance figures for the published operations example.
 * This file does not import the production loan engine and does not
 * recompute a schedule. A live comparison is NOT_REVIEWED unless a
 * separate MEJ-R2 case posts those commands and checks these strings.
 */
export const publishedOperationsExample = {
  disbursement: '2000000.00',
  accrual: '60000.00',
  receipt: '400000.00',
  imputed: '300000.00',
  creditIssued: '100000.00',
  creditApplied: '50000.00',
  principalOutstanding: '1710000.00',
  creditRemaining: '50000.00',
} as const;

export function oracleWasExecuted(): false {
  return false;
}
