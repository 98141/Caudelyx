import type {Document} from 'mongodb';
import type {Loan,Borrower} from '../lending/models.js';
import type {HistoricalLoan} from '../lending/historical.js';
import type {Event,Position,Installment,Schedule} from '../lending/operations-models.js';
import type {Account,Journal} from '../finance/models.js';
export type Row=Document&{_id:string;organizationId:string};
export type Data=Record<string,unknown>;
export const POLICY='S08-REPORTING-CO-1.0';
export const REPORTS=['PORTFOLIO','INSTALLMENTS','MOVEMENTS','CASH','RECONCILIATION','COLLECTORS','CONCENTRATION'] as const;
export type ReportKind=typeof REPORTS[number];
export type Status='COMPLETE'|'INCOMPLETE'|'UNAVAILABLE'|'NO_DENOMINATOR';
export interface Cut {asOf:string;recordedThrough:string;from:string;to:string}
export interface Authority {actorId:string;organizationId:string;roles:string[];isT:boolean;isC:boolean;isO:boolean;isP:boolean;loanIds:string[];scopeKind:'ORGANIZATION'|'ASSIGNED_AND_OWN'|'OWN_ACTIVITY'|'AUTHORIZED_PAYMENTS';binding:string}
export interface Sources {historicalOrigins?:HistoricalLoan[];fundDeltas?:{accountId:string;delta:string;effectiveDate:string;unitKnownAt:string}[];managementEvents?:import('../obligations/models.js').Event[];unitKnownAt?:Record<string,string>;loans:Loan[];borrowers:Borrower[];positions:Position[];installments:Installment[];schedules:Schedule[];events:Event[];compensations:Row[];snapshots:Row[];payments:Row[];paymentTransitions?:Row[];custody:Row[];held:Row[];deliveries:Row[];facts:Row[];actions:Row[];journeys:Row[];stations:Row[];bindings:Row[];reconciliation:Row[];opening:Row[];accounts:Account[];journals:Journal[];profile:Row|null;versions:string;currentDate:string;knownThrough?:string;dataThrough?:string}
export interface Coverage {status:Status;populationCount:number|null;evaluableCount:number|null;unclassifiableCount:number|null;coveredPrincipal:string|null;unclassifiablePrincipal:string|null;principalCoveragePercent:string|null;partialNumerator:string|null;partialDenominator:string|null;partialPercent:string|null;reasons:string[]}
export interface Indicator {id:string;kind:'STOCK'|'FLOW'|'RATIO';unit:'COP'|'PERCENT';status:Status;value:string|null;numerator:string|null;denominator:string|null;gross:string|null;compensations:string|null;net:string|null;reasons:string[];sourceRefs:Data[]}
export interface Claims extends Cut {v:1;actor:string;org:string;authority:string;versions:string;issued:number;expires:number;nonce:string}
export const ASSIGNED=['PRINCIPAL_OUTSTANDING','PRINCIPAL_DUE_TODAY_OR_EARLIER','PRINCIPAL_OVERDUE','INTEREST_OVERDUE','PRINCIPAL_EXPOSED_OVERDUE','PAR30','INTEREST_EXPECTED_FUTURE','INTEREST_DUE_UNACCRUED','BORROWER_CONCENTRATION','INSTALLMENT_FULFILMENT'];
export const OWN=['RECEIPTS_REGISTERED','RECEIPTS_CONFIRMED','PRINCIPAL_RECOVERED','INTEREST_RECEIVED','CUSTODY_PROVISIONAL','CUSTODY_CONFIRMED','CUSTODY_COMMITTED','DELIVERED_NET','HELD_FUNDS'];

