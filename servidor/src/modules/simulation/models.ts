import type {ClientSession} from 'mongodb';
import type {Context} from '../identity/models.js';
import type {Scope} from '../obligations/models.js';
export type Data=Record<string,unknown>;
export type ScenarioKind='PRUDENT'|'BASE'|'FAVORABLE';
export type AlternativeKind='HOLD_CASH'|'DEBT_PREPAYMENT'|'NEW_LOAN'|'ASSET_PURCHASE';
export const scenarioKinds:ScenarioKind[]=['PRUDENT','BASE','FAVORABLE'];
export const alternativeKinds:AlternativeKind[]=['HOLD_CASH','DEBT_PREPAYMENT','NEW_LOAN','ASSET_PURCHASE'];
export type Coverage='COMPLETE'|'INCOMPLETE'|'UNAVAILABLE'|'NOT_APPLICABLE';
export interface Metric {value:string|null;status:Coverage;reasons:string[];knownPartial:string|null}
export interface SourceRef {collection:string;id:string;version:number;digest:string;effectiveDate:string;knownAt:string}
export interface Installment {number:number;dueDate:string;principal:string;interest:string;insurance:string;fees:string;total:string}
export type Terms={kind:'NATIVE_VERSION';sourceId:string;sourceVersion:number}|{kind:'DECLARED_HYPOTHESIS';sourceReference:string;principalOpening:string;installments:Installment[]};
export interface CapitalEvent {id:string;date:string;kind:'DECLARED_CAPITAL_IN'|'DECLARED_CAPITAL_OUT'|'REINVESTMENT';amount:string;cashSourceFlowId:string|null;sourceReference:string;economicClass:'CAPITAL_CONTRIBUTION'|'EXTERNAL_BORROWING'|'PRINCIPAL_RECOVERY'|'INTEREST_RECEIPT'|'WITHDRAWAL'}
export interface Assumption {kind:ScenarioKind;collectionFraction:string;delayDays:number;recoveryFraction:string;recoveryDelayDays:number;interestProjection:'DECLARED_SCHEDULE_ONLY'|'SUPPORTED_SOURCE_TERMS';dateOverrides:{sourceKey:string;collectionDate:string;recoveryDate:string|null}[];capitalEvents:CapitalEvent[]}
export interface ReserveRelease {fundId:string;amount:string;date:string}
export interface Alternative {kind:AlternativeKind;budget:string;configured:boolean;reason?:'NOT_CONFIGURED';reserveReleases?:ReserveRelease[];liabilityId?:string;date?:string;prepaymentMode?:'REDUCE_TERM'|'REDUCE_INSTALLMENT';terms?:Terms;principal?:string;cashSourceFlowId?:string|null;grossCost?:string;ownCash?:string;ownDebt?:string;directCreditor?:boolean;ownershipFraction?:string;estimatedGrossValue?:string|null;vacancyFraction?:string;rentSchedule?:{id:string;date:string;amount:string;sourceReference:string}[];costSchedule?:{id:string;date:string;amount:string;sourceReference:string}[]}
export interface VersionInput {baseId:string;baseToken:string;horizonDays:number;assumptions:Assumption[];alternatives:Alternative[]}
export interface Flow {id:string;sourceKey:string;bookId:string;date:string;direction:'IN'|'OUT';classification:'PRINCIPAL'|'INTEREST_RECOGNIZED'|'INTEREST_UNRECOGNIZED'|'INSURANCE'|'FEES'|'EXPENSE'|'DEBT_PRINCIPAL'|'RENT'|'CAPITAL'|'UNKNOWN';amount:string|null;sourceRefs:SourceRef[];entityId:string;installment:number|null;recognized?:boolean;capitalClass?:CapitalEvent['economicClass'];debtCash?:boolean;loanDisbursement?:boolean;assetCash?:boolean;linkedTranche?:string}
export interface NativeTerms {id:string;entityId?:string;validFrom?:string;effectiveDate?:string;permissionsByDate?:{validFrom:string;permissions:string[]}[];version:number;bookId:string;principalOpening:string;installments:Installment[];prepaymentPermissions:string[];supported:boolean;reason:string|null;kind:'LOAN'|'LIABILITY';rate?:Data;projectionMethod?:string}
export interface BookInput {bookId:string;kind:'BUSINESS'|'PERSONAL';cashBook:string;available:string;reserved:string;held:string;custodyProvisional:string;custodyConfirmed:string;committed:string;principalOutstanding:string|null;recognizedInterest:string|null;ownDebt:string;netWorthBook:string;estimatedOwnValue:string|null;netWorthIndicative:string|null;assetCost:string|null;funds:{id:string;reserved:string}[];terms:NativeTerms[];flows:Flow[];sourceRefs:SourceRef[];coverage:Coverage;reasons:string[]}
export interface EngineBase {id:string;targetBookId:string;asOf:string;knownAt:string;sourceDigest:string;books:BookInput[]}
export interface MetricSet {cashFinal:Metric;cashMinimum:Metric;availableFinal:Metric;availableMinimum:Metric;peakDeficit:Metric;principalOutstanding:Metric;expectedInterest:Metric;recognizedInterest:Metric;cost:Metric;reserved:Metric;ownDebt:Metric;estimatedOwnValue:Metric;netWorthBook:Metric;netWorthIndicative:Metric}
export interface Outcome {id:string;scenarioKind:ScenarioKind;alternativeKind:AlternativeKind;coverage:Coverage;simulability:'SIMULABLE'|'PARTIALLY_SIMULABLE'|'NOT_SIMULABLE';reasons:string[];firstDeficitDate:string|null;metrics:MetricSet}
export interface Day {outcomeId:string;date:string;cashOpening:Metric;cashClosing:Metric;availableOpening:Metric;availableClosing:Metric;minimumIntraday:Metric;cashIn:Metric;cashOut:Metric;reserved:Metric;held:Metric}
export interface Evaluation {outcomes:Outcome[];days:Day[];bookDays:{outcomeId:string;bookId:string;date:string;minimum:string|null;closing:string|null}[];reserveShortfalls?:{outcomeId:string;fundId:string;date:string;amount:string}[];flows:Flow[];metrics:{expandedFlows:number;durationMs:number}}
export interface Authority {scope:Scope;actorId:string;context:Context;binding:string;consolidated:boolean;key:string}
export interface Frame {session:ClientSession;authority:Authority}
export const tables=['s12_bases','s12_scenarios','s12_scenario_versions','s12_runs','s12_results','s12_alerts','s12_alert_evaluations','s12_commands','s12_limits','s12_payload_chunks'] as const;
export type Table=typeof tables[number];
export interface Row extends Data {_id:string;actorId:string;scopeKind:string;bookId:string;ownerId:string;version:number;createdAt:string;expiresAt:string;restoreEpoch:string;mac:string}
export interface Result {status:number;data:Data;etag?:string}
export const limits={days:366,sourceRows:10000,baseBytes:16777216,expandedFlows:50000,resultBytes:16777216,workerMs:10000,workerRSS:268435456,requestsPerMinute:10,queue:8,payloadMs:86400000,definitionMs:2592000000,freshMs:300000} as const;
