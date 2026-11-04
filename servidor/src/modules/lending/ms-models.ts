import type {Profile} from './operations-models.js';

export const MS_POLICY='MS-MONTHLY-0.1.0';
export const MS_CONTRACT='1.0.0';
export interface MonthlyTerms {
 modality:'MONTHLY_OPEN_V1';borrowerId:string;principal:string;monthlyRate:string;
 effectiveDate:string;firstDueDate:string;anchor:{mode:'DAY_OF_MONTH'|'END_OF_MONTH';day?:number};
 cashAccountId:string;mappingVersion:string;supportReference:string;usage:'LOCAL_SYNTHETIC';
}
export interface MonthlyRateVersion {version:number;effectiveFrom:string;rate:string}
export interface MonthlyLoan {
 _id:string;organizationId:string;ownerId:string;borrowerId:string;version:number;
 modality:'MONTHLY_OPEN_V1';status:'MONTHLY_DRAFT'|'MONTHLY_ACTIVE';
 terms:MonthlyTerms;termsVersion:number;profile:Profile;createdAt:string;
}
export const isMonthlyLoan=(value:unknown):value is MonthlyLoan=>Boolean(value&&typeof value==='object'&&'modality'in value&&value.modality==='MONTHLY_OPEN_V1');
export interface MonthlyPeriod {
 ordinal:number;startDate:string;dueDate:string;principalBase:string;rate:string;
 termsVersion:number;interest:string;fixedAt:string;recognizedAt:string|null;recognitionDate:string|null;
 openingRecognizedInterest?:string;contractualInterest?:string;paidBeforeOpening?:string;
}
export interface MonthlyAllocation {ordinal:number;amount:string}
export interface MonthlyFact {
 id:string;kind:'PAYMENT'|'CREDIT_APPLICATION'|'COMPENSATION';effectiveDate:string;recordedAt:string;
 principal:string;interest:MonthlyAllocation[];creditAdded:string;creditUsed:string;amount:string;
 reverses:string|null;paymentId:string|null;
}
export interface MonthlyState {
 id:string;organizationId:string;bookId:string;borrowerId:string;version:number;
 terms:MonthlyTerms;profile:Profile;rateVersions:MonthlyRateVersion[];
 periods:MonthlyPeriod[];facts:MonthlyFact[];status:'ACTIVE'|'SETTLED';
 origin:{kind:'DISBURSEMENT'|'OPENING_LINK';eventId:string;cutoffDate:string|null;recognizedInterest:string};
 createdAt:string;
}
export interface MonthlyPost {accountId:string;debit:string;credit:string}
export interface MonthlyPlan {
 state:MonthlyState;postings:MonthlyPost[];newAccruals:number[];newPeriods:number[];
 fact:MonthlyFact|null;principalOutstanding:string;interestApplied:string;principalApplied:string;
 creditAdded:string;creditUsed:string;catchupPending:boolean;
}
export interface MonthlyPayment {
 id:string;effectiveDate:string;recordedAt:string;amount:string;cashAccountId:string;
 mode:'REGULAR'|'EXTRA_PRINCIPAL'|'SETTLEMENT';excess:'REJECT'|'CREDIT';
 source:'CASH'|'BORROWER_CREDIT';creditAvailable:string;paymentId:string|null;
}
export interface HistoryCheck {
 effectiveDate:string;today:string;cutoffDate:string|null;
 closedPeriods:{from:string;to:string}[]|null;
 duplicate:boolean;affectedFacts:number;incompatible:boolean;availabilityByDate:string[];
}
export type MonthlyFlowKind='INTEREST_CASH'|'EXTERNAL_INCOME'|'FUNDING_TRANSFER'|'EXPENSE_PAID'|'DEBT_PAID'|'DEBT_RESERVATION'|'DISTRIBUTION'|'PRINCIPAL_RECOVERY'|'OTHER';
export interface MonthlyFlow {
 id:string;bookId:string;effectiveDate:string;knownAt:string;kind:MonthlyFlowKind;amount:string;
 relationshipId?:string;relationshipLeg?:'ORIGIN'|'REVERSAL';alreadyDistributedSource?:boolean;
}
