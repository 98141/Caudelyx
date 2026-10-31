import type {Row,Scope,Data} from '../obligations/models.js';
import type {Profile} from '../lending/operations-models.js';
export type {Row,Scope,Data};
export const POLICY='S11-EXCHANGE-1.0';
export const VERSION='1.0.0';
export const exchangeTables=['s11_imports','s11_import_previews','s11_preview_chunks','s11_external_refs','s11_import_commands','s11_historical_origins','s11_historical_schedules','s11_opening_component_claims','s11_informational_history','s11_files','s11_jobs','s11_exports','s11_snapshots','s11_snapshot_chunks','s11_limits'] as const;
export type Table=typeof exchangeTables[number];
export type Mode='OPENING'|'OPERATIVE'|'HISTORICAL_LINK'|'INFORMATIONAL';
export type WorkbookData=Record<string,Data[]>;
export interface HistoricalProfile {externalKey:string;accountProfile:Profile;accountVersions:Profile}
export interface Issue {sheet:string;row:number;cell:string;code:string;severity:'ERROR'|'WARNING'|'DEFERRED';expectedType:string;relatedKeys:string[]}
export interface Command {operationId:string;externalKey:string;pathReferences:Record<string,string>;expectedETag:string|null;payload:Data;dependsOnKeys?:string[]}
export interface Plan {mode:Mode;namespace:string;cutoffDate:string|null;commands:Command[];links:Data[];opening:Data|null;informationals:Data[];aliases:Record<string,string>;externalRefs:{key:string;type:string;id:string}[];issues:Issue[];totals:Record<string,string>;totalRows:number;semanticHash:string;normalized:WorkbookData;historicalProfiles?:HistoricalProfile[]}
export interface ImportRow extends Row {actorId:string;contextId:string;namespace:string;mode:Mode;state:'CREATED'|'UPLOADED'|'PREVIEWING'|'READY'|'INVALID'|'COMMITTED'|'CANCELLED'|'EXPIRED';contentVersion:number;createdAt:string;expiresAt:string;fileId:string|null;previewId:string|null;receiptId:string|null;jobId:string|null;binding:string}
export interface FileRow extends Row {actorId:string;contextId:string;state:'STAGING'|'VERIFIED'|'READY'|'DELETED'|'CORRUPT'|'EXPIRED';mediaType:string;bytes:number;sha256:string|null;createdAt:string;expiresAt:string;filename:string;resourceId:string;binding:string}
export interface JobRow extends Row {actorId:string;contextId:string;kind:'IMPORT_PARSE'|'IMPORT_PREVIEW'|'EXPORT';state:'QUEUED'|'RUNNING'|'SUCCEEDED'|'FAILED'|'CANCELLED'|'EXPIRED';createdAt:string;updatedAt:string;errorCode:string|null;resourceId:string;binding:string;lease:{nonce:string;pid:number;expiresAt:number}|null}
export interface ReportCell {columnId:string;type:'TEXT'|'MONEY'|'PERCENT'|'COUNT'|'DATE'|'INSTANT'|'BOOLEAN'|'ENUM';unit:'COP'|'PERCENT'|'COUNT'|'NONE';value:string|number|boolean|null;status:'COMPLETE'|'INCOMPLETE'|'UNAVAILABLE'|'NO_DENOMINATOR'|'NOT_APPLICABLE';reason:string}
export interface ReportRow {id:string;cells:ReportCell[];sourceRefs:Data[]}
export interface SnapshotData {reportKind:string;meta:Data;rows:ReportRow[];totalRows:number;totals:ReportCell[];sourceDigest:string;binding:string}
