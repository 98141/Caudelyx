import type { Decimal128 } from 'mongodb';
export interface Ownership {
  _id: string; organizationId: string; bookId: string; ownerId: string;
  financialScope: 'BUSINESS'; currency: 'COP'; createdAt: string;
}
export interface Account extends Ownership {
  code: string; name: string; accountClass: 'ASSET'|'LIABILITY'|'EQUITY'|'INCOME'|'EXPENSE';
  kind: 'CASH'|'BANK'|'GENERAL'; status: 'ACTIVE'; version: number;
  initialBalancePurpose?: 'INITIAL_CAPITAL';
}
export interface Line { accountId: string; debit: string; credit: string }
export interface StoredLine { accountId: string; debit: Decimal128; credit: Decimal128 }
export interface Journal extends Ownership {
  status: 'POSTED'; version: 1; effectiveDate: string; recordedAt: string;
  source: {type: 'MANUAL_JOURNAL'|'TRANSFER'|'REVERSAL'|'OPENING'|'LOAN_OPERATION'|'INITIAL_BALANCE'|'LOAN_COMPENSATION'|'CASH_DELIVERY'|'CASH_DELIVERY_COMPENSATION'|'MANAGEMENT_OPERATION'; id: string}; reversalOfId: string|null;
  supportReference: string; description: string; lines: StoredLine[];
}
export interface Posting {currency: 'COP'; effectiveDate: string; sourceId: string; supportReference: string; description: string; lines: Line[]}
export interface Transfer extends Omit<Posting,'lines'> {fromAccountId: string; toAccountId: string; amount: string}
export interface Reversal {effectiveDate: string; sourceId: string; supportReference: string; reason: string}
export interface Result {data: unknown; status: number; etag?: string}
