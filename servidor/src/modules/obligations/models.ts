import type {Document,Decimal128} from 'mongodb';
import type {ClientSession} from 'mongodb';
import type {IdentityService} from '../identity/service.js';
import type {ManagementStore} from './store.js';
import type {ManagementLedger} from './ledger.js';
export type Kind='BUSINESS'|'PERSONAL';
export type Data=Record<string,unknown>;
export interface Scope {kind:Kind;bookId:string;ownerId:string;organizationId?:string}
export interface Row extends Document {_id:string;bookId:string;ownerId:string;domainKind:Kind;version:number;recordedAt:string;mac:string}
export interface Book extends Row {currency:'COP';status:'ACTIVE'|'FROZEN';subjectId:string|null;assignmentId:string|null;monetaryRevision:number}
export interface Account extends Row {code:string;name:string;accountClass:'ASSET'|'LIABILITY'|'EQUITY'|'INCOME'|'EXPENSE';kind:'CASH'|'BANK'|'GENERAL';currency:'COP';status:'ACTIVE'}
export interface Line {accountId:string;debit:string;credit:string}
export interface Journal extends Row {effectiveDate:string;sourceKind:string;sourceId:string;supportReference:string;lines:{accountId:string;debit:Decimal128;credit:Decimal128}[];reversalOfId:string|null}
export interface Allocation {installmentNumber:number;component:'PRINCIPAL'|'INTEREST'|'INSURANCE'|'FEES';amount:string;accountId:string}
export interface Installment {number:number;dueDate:string;principal:string;interest:string;insurance:string;fees:string;total:string}
export interface Schedule {id:string;version:number;kind:'OFFICIAL_DECLARED'|'PROJECTED';validFrom:string;referenceDate:string;sourceReference:string;principalOpening:string;rateVersionIds:string[];installments:Installment[];projectionMethod?:'EQUAL_PRINCIPAL'|'DECLARED_PRINCIPAL_SCHEDULE'}
export interface Event extends Row {entityId:string;kind:string;effectiveDate:string;unitKnownAt:string;amount:string;allocations:Allocation[];journalIds:string[];reversalOfId:string|null;components:Data;relationshipId?:string}
export interface Expense extends Row {nominalDate:string;dueDate:string;description:string;category:string;amountMode:'FIXED'|'VARIABLE';amount?:string;supportReference:string;planningStatus:'PLANNED'|'UNPRICED'|'CANCELLED';seriesId?:string;ruleVersionId?:string}
export interface Rule extends Row {seriesId:string;frequency:string;startDate:string;endDate?:string;monthDay?:number|'LAST_DAY';twiceMonthlyDays?:(number|'LAST_DAY')[];customDates?:string[];effectiveFrom:string;amountMode:'FIXED'|'VARIABLE';amount?:string;description:string;category:string;supportReference:string;monthEndPolicy:'CLAMP_TO_LAST_DAY'}
export interface Rate extends Data {kind:string;unit:string;convention:string;decimalValue:string;combine:string;validFrom:string;observedOn:string;validTo?:string;spread?:string;periodDefinition?:string;resetDates?:string[]}
export interface Liability extends Row {kind:'BANK_LOAN'|'FINANCED_PURCHASE'|'CARD'|'PRIVATE_DEBT';label:string;counterpartyReference:string;principal:string;status:'DRAFT'|'ACTIVE'|'SETTLED'|'CANCELLED';rate:Rate;schedule:Schedule;prepaymentPermissions:string[];supportReference:string;principalAccountId?:string;recognitionKind?:string;activationEventId?:string}
export interface Result {status:number;data:unknown;etag?:string;meta?:unknown}
export interface CommandContext {
 identity:IdentityService;store:ManagementStore;ledger:ManagementLedger;scope:Scope;s:ClientSession;payload:Data;params:Record<string,string>;
 eventIds:string[];journalIds:string[];
 fork:(scope:Scope)=>CommandContext;
 post:(entityId:string,kind:string,date:string,amount:string,lines:Line[],allocations?:Allocation[],components?:Data,reversalOfId?:string|null,existingJournal?:{id:string;recordedAt:string;eventId?:string})=>Promise<Event>;
}
export const etag=(row:{_id:string;version:number})=>'"'+row._id+':'+row.version+'"';
export const keyNames=['expenses','expense_rules','liabilities','liability_versions','card_acquisitions','asset_stubs','events','history'] as const;
export const table=(kind:Kind,name:typeof keyNames[number])=>'s09_'+name+'_'+kind.toLowerCase();
export const booksTable='s09_books';
export const privateAccounts='s09_personal_accounts';
export const privateJournals='s09_personal_journals';
export const assignments='s09_personal_assignments';
export const declarations='s09_ownership_declarations';
export const relationships='s09_relationships';
export const commands='s09_commands';
export const globalEvidence='s09_evidence';
