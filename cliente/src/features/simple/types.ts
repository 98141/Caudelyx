export type SimpleScope = 'BUSINESS' | 'PERSONAL' | 'CONSOLIDATED';
export type SimpleScreen = 'mes' | 'prestamos' | 'cobros' | 'deudas' | 'gastos' | 'caja' | 'ahorro';

export interface Metric {
  value: string | null;
  status: 'COMPLETE' | 'INCOMPLETE' | 'UNAVAILABLE' | 'NOT_APPLICABLE';
  reasons: string[];
  sourceRefs: unknown[];
}

export interface Cuts {
  effectiveDate: string;
  knownAt: string;
  sourceVector: string;
  mappingVersion: string;
  contractVersion: string;
  currency: 'COP';
  timezone: 'America/Bogota';
}

export interface MonthlyView {
  bookId: string;
  scope: 'BUSINESS' | 'PERSONAL';
  month: string;
  cuts: Cuts;
  principal: Metric;
  availableToLend: Metric;
  cash: Metric;
  reserved: Metric;
  free: Metric;
  interestExpectedThisMonth?: Metric;
  interestExpected: Metric;
  interestCashCollected: Metric;
  otherIncome: Metric;
  fundingTransfers: Metric;
  paidExpenses: Metric;
  paidDebtInstallments: Metric;
  debtSavings: Metric;
  baseSurplus: Metric;
  distributedSurplus: Metric;
  remainingSurplus: Metric;
}

export interface ConsolidatedView {
  scope: 'CONSOLIDATED';
  month: string;
  cuts: Cuts;
  books: MonthlyView[];
  eliminatedRelationships: string[];
  totalCash: Metric;
  totalFree: Metric;
  totalReserved: Metric;
  baseSurplus: Metric;
  actionable: false;
}

export interface MonthlyPosition {
  id: string;
  bookId: string;
  borrowerId: string;
  termsVersion: number;
  status: 'ACTIVE' | 'SETTLED';
  effectiveDate: string;
  anchor: { mode: 'DAY_OF_MONTH' | 'END_OF_MONTH'; day?: number };
  monthlyRate: string;
  principalOutstanding: Metric;
  principalOverdue: Metric;
  interestExpected: Metric;
  interestDueUnrecognized: Metric;
  interestOverdue: Metric;
  interestRecognized: Metric;
  interestCashCollected: Metric;
  interestSatisfiedByCredit: Metric;
  overduePeriodCount: number | null;
  oldestUnpaidDueDate: string | null;
  cuts: Cuts;
}

export interface MonthlyPortfolio {
  rows: MonthlyPosition[];
  totalCount: number;
  nextCursor: string | null;
  totalsScope: 'FULL_FILTER';
  principalTotal: Metric;
  interestExpectedTotal: Metric;
  cuts: Cuts;
}

export interface PreviewDocument {
  previewToken: string;
  requestHash: string;
  expiresAt: string;
  sourceVector: string;
  bookId: string;
  status: 'READY' | 'BLOCKED';
  reasons: string[];
  postings: unknown[];
  interest: string;
  principal: string;
  credit: string;
  cashDelta: string;
  reservedDelta: string;
}

export interface ReceiptDocument {
  id: string;
  bookId: string;
  executionKey: string;
  requestHash: string;
  status: 'CONFIRMED' | 'PENDING_APPROVAL' | 'PROVISIONAL';
  effectiveDate: string;
  recordedAt: string;
  eventIds: string[];
  journalIds: string[];
  sourceVector: string;
}

export interface SavingsRow {
  liabilityId: string;
  installmentId: string | null;
  dueDate: string | null;
  quotaTotal: Metric;
  reservedExclusive: Metric;
  shortfall: Metric;
  opportunityDates: string[];
  recommendations: Metric[];
  officialPaymentCoverage: 'COMPLETE' | 'INCOMPLETE' | 'UNAVAILABLE';
}

export interface SavingsPlan {
  bookId: string;
  cuts: Cuts;
  startMonth: string;
  horizonMonths: 12;
  rows: SavingsRow[];
  totalCount: number;
  nextCursor: string | null;
  totalsScope: 'FULL_FILTER';
  totalShortfall: Metric;
}

export interface DebtPlan {
  id: string;
  bookId: string;
  version: number;
  status: 'INFORMATIONAL_DRAFT';
  details: {
    entity: string;
    declaredBalance: string;
    declaredQuota: string | null;
    frequency: 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL' | 'CUSTOM' | null;
    nextDueDate: string | null;
    installmentsRemaining: number | null;
  };
  paymentCoverage: 'INCOMPLETE';
}

export interface DebtPlanList {
  rows: DebtPlan[];
  totalCount: number;
  nextCursor: string | null;
}

export interface MappingRecord {
  id: string;
  bookId: string;
  version: number;
  digest: string;
  mapping: { effectiveFrom?: string };
}

export interface MappingList {
  rows: MappingRecord[];
  totalCount: number;
  nextCursor: string | null;
}
