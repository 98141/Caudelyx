export interface Terms {
  borrowerId:string;plannedFundingAccountId:string;principal:string;effectiveDate:string;firstDueDate:string;installmentCount:number;
  method:'CONSTANT_PRINCIPAL'|'LEVEL_PAYMENT'|'INTEREST_ONLY';frequency:string;
  rate:{type:'EFFECTIVE'|'NOMINAL_ANNUAL';unit:string;value:string;compoundingPeriodsPerYear?:number};
  calendarConvention:string;holidayAdjustment:string;policyVersion:string;jurisdiction:string;usage:string;
  documents?:{reference:string;label:string;kind:string}[];note?:string;
}
export interface Row {k:number;date:string;openingPrincipal:string;principal:string;interest:string;payment:string;closingPrincipal:string}
export interface Calculation {schedule:Row[];totals:{principal:string;interest:string;payment:string};periodicRate24:string;basePayment:string|null;finalPaymentAdjustment:string;policyVersion:string;mathVersion:string;calendarVersion:string}
export interface Field {key:string;label:string;type:'TEXT'|'DATE'|'BOOLEAN'|'ENUM';deprecated:boolean;options?:{code:string;label:string}[]}
export interface Profile {displayName:string;schemaVersion:number;extras:Record<string,string|boolean>;document?:{type:string;number:string};contact?:{email?:string;phone?:string;address?:string}}
export interface Schema {_id:string;organizationId:string;schemaVersion:number;fields:Field[];publishedAt:string|null;publishedBy:string|null;systemInitial:boolean}
export interface Borrower {_id:string;organizationId:string;ownerId:string;borrowerCode:string;status:'ACTIVE'|'INACTIVE';version:number;profileVersion:number;profile:Profile;openingBorrowerReference?:{openingId:string;referenceId:string};nameKey:string;createdAt:string;updatedAt:string}
export interface Dependencies {borrowerVersion:number;profileVersion:number;schemaVersion:number;fundingAccountVersion:number;organizationEpoch:string;actorAuthzVersion:string;actorAuthEpoch:string;credentialVersion:string;policyVersion:string}
export interface Quote extends Calculation {_id:string;organizationId:string;actorId:string;createdAt:string;expiresAt:string;terms:Terms;dependencies:Dependencies;fingerprint:string}
export interface Confirmation {actorId:string;confirmedAt:string;quoteId:string;quoteFingerprint:string;termsVersion:number}
export interface Loan {_id:string;organizationId:string;ownerId:string;borrowerId:string;status:'DRAFT'|'TERMS_CONFIRMED'|'CANCELLED';version:number;termsVersion:number;terms:Terms;quoteId:string;quoteFingerprint:string;calculation:Calculation;confirmation:Confirmation|null;createdAt:string;updatedAt:string;note?:string;cancellation?:{reason:string;cancelledAt:string;actorId:string}}
export interface Result {status:number;data:unknown;etag?:string}
