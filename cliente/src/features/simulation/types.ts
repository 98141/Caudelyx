export type ScopeKind = 'BUSINESS' | 'PERSONAL' | 'CONSOLIDATED';
export type ScenarioKind = 'PRUDENT' | 'BASE' | 'FAVORABLE';
export type AlternativeKind = 'HOLD_CASH' | 'DEBT_PREPAYMENT' | 'NEW_LOAN' | 'ASSET_PURCHASE';
export type InterestProjection = 'DECLARED_SCHEDULE_ONLY' | 'SUPPORTED_SOURCE_TERMS';

export interface Metric {
  value: string | null;
  status: string;
  reasons: string[];
  knownPartial: string | null;
}

export interface Policy {
  schemaVersion: string;
  simulationPolicy: string;
  alertPolicy: string;
  usage: string;
  realUseAllowed: boolean;
  scenarioKinds: ScenarioKind[];
  alternativeKinds: AlternativeKind[];
  alertTypes: string[];
  horizonMaxDays: number;
  freshnessSeconds: number;
  defaultAlertThresholds: { dueWithinDays: number; concentrationThreshold: string };
}

export interface BaseRecord {
  id: string;
  asOf: string;
  knownAt: string;
  capturedAt: string;
  freshUntil: string;
  baseToken: string;
  sourceDigest: string;
  schemaVersion: string;
  policyVersion: string;
  currency: string;
  coverage: string;
  cashBook: Metric;
  available: Metric;
  reserved: Metric;
  held: Metric;
  custodyProvisional: Metric;
  custodyConfirmed: Metric;
  committed: Metric;
  sourceRefs: { knownAt?: string; collection?: string; id?: string; version?: number }[];
}

export interface HypothesisDraft {
  dateOverrides?: {sourceKey:string;collectionDate:string;recoveryDate:string|null}[];
  reinvestment?: {id:string;date:string;amount:string;cashSourceFlowId:string;sourceReference:string};
  collectionFraction: string;
  delayDays: string;
  recoveryFraction: string;
  recoveryDelayDays: string;
  interestProjection: '' | InterestProjection;
  capitalOutDate: string;
  capitalOutAmount: string;
  capitalInDate: string;
  capitalInAmount: string;
  sourceReference: string;
}

export interface CapitalEventBody {
  id: string;
  date: string;
  kind: 'DECLARED_CAPITAL_IN' | 'DECLARED_CAPITAL_OUT' | 'REINVESTMENT';
  amount: string;
  cashSourceFlowId: string | null;
  sourceReference: string;
  economicClass: 'CAPITAL_CONTRIBUTION' | 'WITHDRAWAL' | 'EXTERNAL_BORROWING' | 'PRINCIPAL_RECOVERY' | 'INTEREST_RECEIPT';
}

export interface AssumptionBody {
  kind: ScenarioKind;
  collectionFraction: string;
  delayDays: number;
  recoveryFraction: string;
  recoveryDelayDays: number;
  interestProjection: InterestProjection;
  dateOverrides: {sourceKey:string;collectionDate:string;recoveryDate:string|null}[];
  capitalEvents: CapitalEventBody[];
}

export interface AlternativeBody {
  kind: AlternativeKind;
  budget: string;
  configured: boolean;
  reason?: 'NOT_CONFIGURED';
  reserveReleases?: {fundId:string;amount:string;date:string}[];
  date?:string;
  liabilityId?:string;
  prepaymentMode?:'REDUCE_TERM'|'REDUCE_INSTALLMENT';
  principal?:string;
  cashSourceFlowId?:string|null;
  terms?:{kind:'NATIVE_VERSION';sourceId:string;sourceVersion:number}|{kind:'DECLARED_HYPOTHESIS';sourceReference:string;principalOpening:string;installments:InstallmentBody[]};
  grossCost?:string;ownCash?:string;ownDebt?:string;directCreditor?:boolean;
  ownershipFraction?:string;estimatedGrossValue?:string|null;vacancyFraction?:string;
  rentSchedule?:ScheduleLeg[];costSchedule?:ScheduleLeg[];
}
export interface InstallmentBody {number:number;dueDate:string;principal:string;interest:string;insurance:string;fees:string;total:string}
export interface ScheduleLeg {id:string;date:string;amount:string;sourceReference:string}

export interface VersionBody {
  baseId: string;
  baseToken: string;
  horizonDays: number;
  assumptions: AssumptionBody[];
  alternatives: AlternativeBody[];
}

export interface Outcome {
  id: string;
  scenarioKind: ScenarioKind;
  alternativeKind: AlternativeKind;
  coverage: string;
  simulability: string;
  reasons: string[];
  firstDeficitDate: string | null;
  metrics: Record<string, Metric>;
}

export interface BookBreakdown {
  bookId: string;
  minimum: Metric;
  availableClosing: Metric;
}

export interface DayItem {
  outcomeId: string;
  date: string;
  minimumIntraday: Metric;
  cashIn: Metric;
  cashOut: Metric;
  bookBreakdown: BookBreakdown[];
}

export interface RunRecord {
  id: string;
  scenarioId: string;
  scenarioVersion: number;
  baseId: string;
  state: string;
  errorCode: string | null;
  retryable: boolean;
  sourceDigest: string;
}

export interface ResultsPage {
  runId: string;
  baseId: string;
  sourceDigest: string;
  freshness: string;
  outcomes: Outcome[];
  items: DayItem[];
  totalRows: number;
  nextCursor: string | null;
}

export interface StoredRun {
  id: string;
  scenarioVersion: number;
  baseId: string;
  sourceDigest: string;
  horizonDays: number;
  freshness: string;
  outcomes: Outcome[];
  items: DayItem[];
  totalRows: number;
  incomplete: boolean;
}

export interface Comparison {
  id: string;
  baseId: string;
  sourceDigest: string;
  outcomes: Outcome[];
  winner: null | string;
}

export interface AlertItem {
  id: string;
  type: string;
  class: string;
  severity: string;
  state: string;
  freshness: string;
  effectiveDate: string;
  amount: Metric;
  sourceRefs: unknown[];
  ackAt: string | null;
}

export const KINDS: ScenarioKind[] = ['PRUDENT', 'BASE', 'FAVORABLE'];
export const ALTERNATIVES: AlternativeKind[] = ['HOLD_CASH', 'DEBT_PREPAYMENT', 'NEW_LOAN', 'ASSET_PURCHASE'];

export function emptyHypothesis(): HypothesisDraft {
  return {
    collectionFraction: '', delayDays: '', recoveryFraction: '', recoveryDelayDays: '', interestProjection: '',
    capitalOutDate: '', capitalOutAmount: '', capitalInDate: '', capitalInAmount: '', sourceReference: '',
  };
}
