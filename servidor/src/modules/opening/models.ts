export interface Support {id:string;reference:string;asOfDate:string;declaration:'DECLARED'|'OWNER_CHECKED';note?:string}
export interface Reference {id:string;type:'BORROWER'|'HISTORICAL_LOAN'|'OBLIGATION'|'BASIC_ASSET'|'BASIC_INVESTMENT';externalReference:string;supportIds:string[];displayName?:string;borrowerId?:string;originationDate?:string;incurredDate?:string;acquisitionDate?:string;category?:string;counterpartyLabel?:string;fundingReference?:string}
export interface Component {id:string;category:'CASH'|'BANK'|'PRINCIPAL_RECEIVABLE'|'LIABILITY'|'EQUITY'|'BASIC_ASSET'|'BASIC_INVESTMENT';accountId:string;amount:string;supportIds:string[];referenceId?:string;equityKind?:'CONTRIBUTED'|'HISTORICAL_RESULTS'|'OTHER_DECLARED'}
export interface HistoricalInterest {id:string;loanReferenceId:string;amount:string;treatment:'RECOGNIZED_OPENING'|'INFORMATIONAL';supportIds:string[];accountId?:string;recognitionDeclaration?:string;equityComponentId?:string}
export interface Snapshot {cutoffDate:string;supports:Support[];references:Reference[];components:Component[];historicalInterest:HistoricalInterest[];informationalHistory:{id:string;date:string;description:string;supportIds:string[];referenceId?:string}[]}
export interface Issue {code:string;path:string;relatedIds:string[]}
export interface ProposedLine {accountId:string;debit:string;credit:string;componentIds:string[];interestIds:string[]}
export interface Totals {assets:string;liabilities:string;equity:string;debit:string;credit:string;balanceDifference:string;ledgerDifference:string;principal:string;recognizedInterest:string;informationalInterest:string}
export interface Report {issues:Issue[];totals:Totals;proposedLines:ProposedLine[]}
export interface Validation {id:string;validatedAt:string;contentVersion:number;policyVersion:'S03-OPENING-0.1';fingerprint:string;dependencyDigest:string;report:Report}
export interface Approval {actorId:string;approvedAt:string;validationId:string;validationFingerprint:string}
export interface Cancellation {actorId:string;cancelledAt:string;reason:string}
export interface CommitReceipt {journalId:string;recordedAt:string;ledgerLineMap:{lineIndex:number;accountId:string;componentIds:string[];interestIds:string[]}[]}
export interface OpeningFile {id:string;organizationId:string;bookId:string;ownerId:string;financialScope:'BUSINESS';currency:'COP';policyVersion:'S03-OPENING-0.1';schemaVersion:'0.1.0-candidate';version:number;contentVersion:number;status:'DRAFT'|'VALIDATED'|'APPROVED'|'POSTED'|'CANCELLED';snapshot:Snapshot;predecessorId:string|null;createdAt:string;updatedAt:string;validation:Validation|null;approval:Approval|null;commit:CommitReceipt|null;cancellation:Cancellation|null}
export interface OpeningRow extends Omit<OpeningFile,'id'> {_id:string;active:boolean}
