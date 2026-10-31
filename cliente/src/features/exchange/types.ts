export const TEMPLATE_VERSION = '1.0.0';
export const MAPPING_VERSION = 'S11-MAP-1';
export const MAX_UPLOAD_BYTES = 5_242_880;

export type ScopeKind = 'BUSINESS' | 'PERSONAL' | 'CONSOLIDATED';
export type ImportMode = 'OPENING' | 'OPERATIVE' | 'HISTORICAL_LINK' | 'INFORMATIONAL';
export type ImportState = 'CREATED' | 'UPLOADED' | 'PREVIEWING' | 'READY' | 'INVALID' | 'COMMITTED' | 'CANCELLED' | 'EXPIRED';
export type JobState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
export type ExportFormat = 'CSV' | 'XLSX' | 'PDF';

export interface TemplateDownload {
  id: string;
  templateVersion: string;
  filename: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  contentBase64: string;
}

export interface Policy {
  schemaVersion: string;
  policyVersion: string;
  usage: string;
  realUseAllowed: boolean;
  reportKinds: string[];
  formats: ExportFormat[];
  importModes: ImportMode[];
  maxRows: number;
  maxUploadBytes: number;
  previewTTLSeconds: number;
  templates?: TemplateDownload[];
}

export interface ImportRecord {
  id: string;
  version: number;
  contentVersion: number;
  mode: ImportMode;
  namespace: string;
  state: ImportState;
  createdAt: string;
  expiresAt: string;
  previewId: string | null;
  receiptId: string | null;
  jobId: string | null;
}

export interface JobRecord {
  id: string;
  kind: string;
  state: JobState;
  version: number;
  createdAt: string;
  updatedAt: string;
  errorCode: string | null;
  resourceId: string;
}

export interface Issue {
  sheet: string;
  row: number;
  cell: string;
  code: string;
  severity: 'ERROR' | 'WARNING' | 'DEFERRED';
  expectedType: string;
  relatedKeys: string[];
}

export interface PreviewTotals {
  assets: string;
  liabilities: string;
  equity: string;
  debit: string;
  credit: string;
  difference: string;
  principal: string;
  recognizedInterest: string;
  informationalInterest: string;
}

export interface Preview {
  id: string;
  contentVersion: number;
  semanticHash: string;
  physicalHash: string;
  expiresAt: string;
  canConfirm: boolean;
  totalRows: number;
  errorCount: number;
  warningCount: number;
  deferredCount: number;
  commandCount: number;
  totals: PreviewTotals;
  items: Issue[];
  nextCursor: string | null;
  openingSnapshot?: unknown;
  informationalHistory?: InformationalRecord[];
}

export interface InformationalRecord {
  id: string;
  date: string;
  description: string;
  referenceId: string | null;
  supportReferences: { reference: string; asOfDate: string; declaration: string }[];
}

export interface Receipt {
  id: string;
  importId: string;
  semanticHash: string;
  committedAt: string;
  state: 'COMMITTED';
  effectCount: number;
  journalIds: string[];
  resolvedRefs: { externalKey: string; entityType: string; id: string }[];
  totals: PreviewTotals;
  informationalHistory?: InformationalRecord[];
}

export interface Cell {
  columnId: string;
  status: string;
  value: string | number | null;
  unit?: string;
  reasons?: string[];
}

export interface ReportMeta {
  policyVersion: string;
  schemaVersion: string;
  currency: string;
  timezone: string;
  cut: { asOf: string; recordedThrough: string; from: string; to: string };
  scope: string;
  capturedAt: string;
  expiresAt: string;
  snapshotToken: string;
  sourceVectorDigest: string;
  coverage: { status: string; reasons?: string[]; populationCount?: number | null };
  denominatorScope: string;
}

export interface ReportSnapshot {
  reportKind: string;
  meta: ReportMeta;
  totalRows: number;
  totals: Cell[];
}

export interface ReportPage {
  reportKind: string;
  meta: ReportMeta;
  items: { id: string; cells: Cell[] }[];
  totalRows: number;
  totals: Cell[];
  pageTotals: Cell[];
  nextCursor: string | null;
}

export interface ExportFile {
  id: string;
  state: string;
  mediaType: string;
  bytes: number;
  sha256: string | null;
  createdAt: string;
  expiresAt: string;
  filename: string;
}

export interface ExportRecord {
  id: string;
  version: number;
  reportKind: string;
  format: ExportFormat;
  state: JobState;
  jobId: string;
  file: ExportFile | null;
  meta: ReportMeta;
  totalRows: number;
}

export interface HistoricalProfileInput {
  externalKey: string;
  principalAccountId: string;
  interestReceivableAccountId: string;
  interestIncomeAccountId: string;
  borrowerCreditAccountId: string;
  principalAccountETag: string;
  interestReceivableAccountETag: string;
  interestIncomeAccountETag: string;
  borrowerCreditAccountETag: string;
}
