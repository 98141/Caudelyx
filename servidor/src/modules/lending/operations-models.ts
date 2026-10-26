import type {Line} from '../finance/models.js';
import type {Row,Loan} from './models.js';
export type Kind='DISBURSE'|'ACCRUE'|'RECEIPT'|'APPLY_CREDIT';
export interface Profile {principalAccountId:string;interestReceivableAccountId:string;interestIncomeAccountId:string;borrowerCreditAccountId:string}
export interface Target {loanId:string;positionETag:string;amount:string;mode:'REGULAR'|'EXTRA_PRINCIPAL'}
interface Common {effectiveDate:string;supportReference:string}
export type Intent=Common&(
 {kind:'DISBURSE';loanId:string;loanETag:string;fundingAccountETag:string;accountProfile:Profile;accountVersions:Profile}|
 {kind:'ACCRUE';loanId:string;positionETag:string;throughDate:string}|
 {kind:'RECEIPT';borrowerId:string;destinationAccountId:string;destinationAccountETag:string;receivedAmount:string;targets:Target[];excessDisposition:'CREDIT'|'REJECT';receiptReference:string}|
 {kind:'APPLY_CREDIT';borrowerId:string;creditETag:string;amount:string;targets:Target[]});
export interface Book {_id:string;organizationId:string;version:number;profile:Profile;baseline:Line[];currency:'COP';createdAt:string}
export interface Position {_id:string;organizationId:string;loanId:string;borrowerId:string;version:number;termsVersion:number;scheduleVersion:number;status:'ACTIVE'|'SETTLED';originalPrincipal:string;principalOutstanding:string;fundingEventId:string;createdAt:string}
export interface Installment {_id:string;organizationId:string;loanId:string;scheduleVersion:number;number:number;dueDate:string;principal:string;interest:string;payment:string;principalPaid:string;interestPaid:string;active:boolean;supersededByVersion:number|null;createdAt:string}
export interface Accrual {_id:string;organizationId:string;loanId:string;scheduleVersion:number;installmentNumber:number;dueDate:string;interest:string;eventId:string;createdAt:string}
export interface Application {_id:string;organizationId:string;loanId:string;scheduleVersion:number;installmentNumber:number;component:'INTEREST'|'DUE_PRINCIPAL'|'EXTRA_PRINCIPAL';amount:string;eventId:string;createdAt:string}
export interface Credit {_id:string;organizationId:string;borrowerId:string;version:number;balance:string;currency:'COP';createdAt:string}
export interface Schedule {_id:string;organizationId:string;loanId:string;version:number;parentVersion:number|null;originTermsVersion:number;eventId:string|null;reason:'ORIGINAL'|'EXTRA_PRINCIPAL'|'EARLY_SETTLEMENT'|'REVERSAL_RESTORE';createdAt:string;remainingPrincipal:string;futureInstallments:PublicInstallment[]}
export interface PublicInstallment {loanId:string;scheduleVersion:number;number:number;dueDate:string;principal:string;interest:string;payment:string;principalPaid:string;interestPaid:string;status:'UNPAID'|'PARTIAL'|'PAID';dueState:'FUTURE'|'DUE'|'OVERDUE'}
export interface PublicPosition {loanId:string;borrower:{id:string;code:string;name:string};currency:'COP';version:number;termsVersion:number;scheduleVersion:number;termsStatus:Loan['status'];status:'NOT_DISBURSED'|'ACTIVE'|'SETTLED';statusLabel:'Sin desembolso'|'Activo'|'Liquidado';originalPrincipal:string;principalOutstanding:string;duePrincipal:string;originalExpectedInterest:string;expectedFutureInterest:string;dueUnrecognizedInterest:string;accruedInterestTotal:string;collectedInterestTotal:string;accruedOutstandingInterest:string}
export interface Plan {postings:Line[];allocations:Omit<Application,'_id'|'organizationId'|'eventId'|'createdAt'>[];accruals:Omit<Accrual,'_id'|'organizationId'|'eventId'|'createdAt'>[];scheduleRevisions:Omit<Schedule,'_id'|'organizationId'>[];positions:PublicPosition[];creditChange:{borrowerId:string;before:string;added:string;applied:string;after:string}|null}
export interface Event {_id:string;organizationId:string;borrowerId:string;actorId:string;kind:Kind;status:'CONFIRMED';effectiveDate:string;recordedAt:string;journalId:string|null;idempotencyKey:string;policyVersion:'S05-LOCAL-CO-0.1';supportReference:string;receiptReference:string|null;loanIds:string[];plan:Plan}
export interface EngineLoan {loan:Loan;position:Position;rows:Installment[];accruals:Accrual[];applications:Application[]}
export const installmentFromRow=(r:Row,loanId:string,organizationId:string,version:number,at:string,offset=0):Installment=>({_id:`${loanId}:${version}:${r.k+offset}`,organizationId,loanId,scheduleVersion:version,number:r.k+offset,dueDate:r.date,principal:r.principal,interest:r.interest,payment:r.payment,principalPaid:'0.00',interestPaid:'0.00',active:true,supersededByVersion:null,createdAt:at});
