import type {ClientSession} from 'mongodb';
import type {Database} from '../../shared/database.js';
import type {IdentityService} from '../identity/service.js';
import type {Loan} from './models.js';
import type {Profile} from './operations-models.js';
import type {Row} from '../obligations/models.js';
import {verifyRow} from '../obligations/evidence.js';
import {AppError} from '../../shared/errors.js';
import type {MonthlyLoan} from './ms-models.js';
import {beginEvidence} from './evidence-v2.js';
export interface HistoricalQuota {number:number;dueDate:string;principalRemaining:string;recognizedInterestRemaining:string;unrecognizedInterestRemaining:string;supportKeys:string[]}
export interface HistoricalLoan extends Row {
 organizationId:string;borrowerId:string;status:'HISTORICAL_DECLARED';origin:'HISTORICAL_S11';principal:string;cutoffDate:string;originationDate:string;openingId:string;loanReferenceId:string;principalComponentId:string;recognizedInterest:string;profile:Profile;installments:HistoricalQuota[];createdAt:string;
}
export type OperationLoan=Loan|HistoricalLoan|MonthlyLoan;
export const isHistorical=(loan:OperationLoan):loan is HistoricalLoan=>loan.status==='HISTORICAL_DECLARED';
export async function monthlyLoan(database:Database,id:string,org:string,s?:ClientSession){
 if(s){const unit=await beginEvidence(database,s,org);return(await unit.query('lending_monthly_loans',{organizationId:org,_id:id},{},1))[0] as unknown as MonthlyLoan|undefined;}
 // Cold verification calls this only after verifyV2 authenticated the complete roots.
 return await database.db.collection<MonthlyLoan>('lending_monthly_loans').findOne({_id:id,organizationId:org});
}
export async function historicalLoan(database:Database,id:string,org:string,s?:ClientSession){
 const row=await database.db.collection<HistoricalLoan>('s11_historical_origins').findOne({_id:id,bookId:org,ownerId:org,domainKind:'BUSINESS',organizationId:org},s?{session:s}:{});
 if(row&&(!verifyRow(database,'s11_historical_origins',row)||row.origin!=='HISTORICAL_S11'||row.status!=='HISTORICAL_DECLARED'))throw new AppError(503,'INTEGRITY_MISMATCH');return row;
}
export async function operationLoan(identity:IdentityService,id:string,org:string,s:ClientSession):Promise<OperationLoan>{
 const monthly=await monthlyLoan(identity.database,id,org,s);if(monthly)return monthly;
 const historical=await historicalLoan(identity.database,id,org,s);if(historical){if(!identity.obligations?.active)throw new AppError(503,'SERVICE_UNAVAILABLE');return historical;}return await identity.lending!.verifiedLoan(id,org,s);
}
export async function operationLoans(identity:IdentityService,org:string,s:ClientSession,options:{borrowerId?:string;loanIds?:string[]}={}):Promise<OperationLoan[]>{
 const filter={...(options.borrowerId?{borrowerId:options.borrowerId}:{}),...(options.loanIds?{_id:{$in:options.loanIds}}:{})},native=await identity.lending!.loans.find({organizationId:org,...filter},{session:s,maxTimeMS:10000}).limit(10001).toArray(),historical=await identity.database.db.collection<HistoricalLoan>('s11_historical_origins').find({bookId:org,ownerId:org,domainKind:'BUSINESS',...filter},{session:s,maxTimeMS:10000}).limit(10001).toArray();
 const unit=await beginEvidence(identity.database,s,org),monthly=await unit.query('lending_monthly_loans',{organizationId:org,...filter},{},10001) as unknown as MonthlyLoan[];
 if(native.length+historical.length+monthly.length>10000)throw new AppError(422,'REPORT_SCOPE_TOO_LARGE');if(historical.length&&(!identity.obligations?.active||historical.some(r=>!verifyRow(identity.database,'s11_historical_origins',r))))throw new AppError(503,'INTEGRITY_MISMATCH');return[...native,...historical,...monthly].sort((a,b)=>(a.createdAt+'|'+a._id).localeCompare(b.createdAt+'|'+b._id));
}
