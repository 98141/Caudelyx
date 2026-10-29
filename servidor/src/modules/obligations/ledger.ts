import {randomUUID} from 'node:crypto';
import type {ClientSession} from 'mongodb';
import type {IdentityService} from '../identity/service.js';
import {balanced,cents,money,decimal,storedCents} from '../finance/money.js';
import {recordFinancialEvidence} from '../finance/integrity.js';
import {loadReportingFinance} from '../finance/scoped-integrity.js';
import {domainCollection} from '../lending/evidence-v2.js';
import {AppError} from '../../shared/errors.js';
import {today,validDate} from './calendar.js';
import {privateAccounts,privateJournals,table,type Scope,type Account,type Journal,type Line,type Event} from './models.js';
import type {ManagementStore} from './store.js';
export class ManagementLedger {
 constructor(readonly identity:IdentityService,readonly store:ManagementStore){}
 async account(scope:Scope,id:string,s:ClientSession,expected?:{accountClass?:string;kind?:string[]}){
  let row:Account|import('../finance/models.js').Account;
  if(scope.kind==='PERSONAL')row=await this.store.get<Account>(privateAccounts,id,scope,s);
  else{
   const found=await this.identity.finance!.accounts.findOne({_id:id,organizationId:scope.bookId,bookId:scope.bookId,ownerId:scope.bookId,financialScope:'BUSINESS'},{session:s});if(!found)throw new AppError(404,'RESOURCE_NOT_FOUND');row=found;
   const profile=await domainCollection<{_id:string;organizationId:string;profile:Record<string,string>}>(this.identity.database,'loan_operation_books').findOne({_id:scope.bookId,organizationId:scope.bookId},{session:s});
   const held=await domainCollection<{_id:string;organizationId:string;accountId:string}>(this.identity.database,'held_funds_profiles').findOne({organizationId:scope.bookId},{session:s});
   if(profile&&Object.values(profile.profile).includes(id)||held?.accountId===id)throw new AppError(409,'DOMAIN_ACCOUNT_PROTECTED');
  }
  if(row.status!=='ACTIVE'||row.currency!=='COP'||expected?.accountClass&&row.accountClass!==expected.accountClass||expected?.kind&&!expected.kind.includes(row.kind))throw new AppError(422,'INPUT_INVALID');return row;
 }
 async post(scope:Scope,eventId:string,date:string,lines:Line[],support:string,s:ClientSession,reversalOfId:string|null=null){
  if(!validDate(date)||date>today(this.identity.now())||!support.trim()||lines.length<2||lines.length>100||new Set(lines.map(x=>x.accountId)).size<2)throw new AppError(422,'INPUT_INVALID');balanced(lines);
  for(const line of lines)await this.account(scope,line.accountId,s);
  if(scope.kind==='BUSINESS'){
   await loadReportingFinance(this.identity.database,scope.bookId,null,s,()=>{});
   await this.identity.database.db.collection<{_id:string;value:number}>('financial_books').updateOne({_id:scope.bookId},{$inc:{value:1}},{session:s,upsert:true});
   const result=await this.identity.finance!.writeJournal(scope.bookId,date,lines,{type:'MANAGEMENT_OPERATION',id:eventId},reversalOfId,'Gestión financiera S09',support,s);
   await recordFinancialEvidence(this.identity.database,s);return{id:result._id,recordedAt:result.recordedAt,eventId};
  }
  const row=await this.store.put(privateJournals,{_id:randomUUID(),bookId:scope.bookId,ownerId:scope.ownerId,domainKind:scope.kind,version:1,effectiveDate:date,sourceKind:'MANAGEMENT_OPERATION',sourceId:eventId,supportReference:support,reversalOfId,lines:lines.map(l=>({accountId:l.accountId,debit:decimal(l.debit),credit:decimal(l.credit)}))},s) as Journal;
  const journals=await this.store.all<Journal>(privateJournals,scope,s),accounts=await this.store.all<Account>(privateAccounts,scope,s),cash=new Set(accounts.filter(a=>['CASH','BANK'].includes(a.kind)).map(a=>a._id));
  const byDate=new Map<string,Journal[]>();for(const j of journals){const v=byDate.get(j.effectiveDate)??[];v.push(j);byDate.set(j.effectiveDate,v);}
  const balances=new Map<string,bigint>();for(const date of [...byDate.keys()].sort()){
   for(const j of byDate.get(date)!)for(const l of j.lines)balances.set(l.accountId,(balances.get(l.accountId)??0n)+storedCents(l.debit)-storedCents(l.credit));
   for(const id of cash)if((balances.get(id)??0n)<0n)throw new AppError(409,'INSUFFICIENT_AVAILABLE_FUNDS');
   for(const value of balances.values())money(value);
  }return{id:row._id,recordedAt:row.recordedAt,eventId};
 }
 async inverse(scope:Scope,journalId:string,eventId:string,date:string,support:string,s:ClientSession){
  let original:Journal|import('../finance/models.js').Journal;
  if(scope.kind==='PERSONAL')original=await this.store.get<Journal>(privateJournals,journalId,scope,s);
  else{const found=await this.identity.finance!.journals.findOne({_id:journalId,organizationId:scope.bookId},{session:s});if(!found)throw new AppError(404,'RESOURCE_NOT_FOUND');original=found;}
  if(original.reversalOfId||date<original.effectiveDate)throw new AppError(409,'INVALID_STATE');
  const lines=original.lines.map(l=>({accountId:l.accountId,debit:money(storedCents(l.credit)),credit:money(storedCents(l.debit))}));return await this.post(scope,eventId,date,lines,support,s,journalId);
 }
 async totals(scope:Scope,s:ClientSession,date:string,known:string){
  const source=scope.kind==='PERSONAL'?{accounts:await this.store.all<Account>(privateAccounts,scope,s),journals:await this.store.all<Journal>(privateJournals,scope,s)}:await loadReportingFinance(this.identity.database,scope.bookId,null,s,()=>{});
  const events=await this.store.all<Event>(table(scope.kind,'events'),scope,s),unitTimes=new Map(events.filter(e=>!e.components['existingLink']).flatMap(e=>e.journalIds.map(id=>[id,e.unitKnownAt] as const)));
  const balances=new Map<string,bigint>();for(const j of source.journals)if(j.effectiveDate<=date&&j.recordedAt<=known&&(unitTimes.get(j._id)??j.recordedAt)<=known)for(const l of j.lines)balances.set(l.accountId,(balances.get(l.accountId)??0n)+storedCents(l.debit)-storedCents(l.credit));
  const result={assets:0n,liabilities:0n,equity:0n,income:0n,expense:0n,cashAvailable:0n};
  for(const a of source.accounts){const raw=balances.get(a._id)??0n;if(a.accountClass==='ASSET')result.assets+=raw;else if(a.accountClass==='LIABILITY')result.liabilities-=raw;else if(a.accountClass==='EQUITY')result.equity-=raw;else if(a.accountClass==='INCOME')result.income-=raw;else result.expense+=raw;if(['CASH','BANK'].includes(a.kind))result.cashAvailable+=raw;}
  if(scope.kind==='BUSINESS'){
   const {effectiveReserves}=await import('../collections/funds.js');const reserves=await effectiveReserves(this.identity.database,scope.bookId,s,date);result.cashAvailable-=reserves.reduce((n,r)=>n+cents(r.amount),0n);
  }
  if(result.cashAvailable<0n)throw new AppError(503,'SOURCE_INCONSISTENT');return result;
 }
 async cashAtCuts(scope:Scope,s:ClientSession,dates:string[],known:string,events:Event[]){
  const source=scope.kind==='PERSONAL'?{accounts:await this.store.all<Account>(privateAccounts,scope,s),journals:await this.store.all<Journal>(privateJournals,scope,s)}:await loadReportingFinance(this.identity.database,scope.bookId,null,s,()=>{});
  const cash=new Set(source.accounts.filter(a=>['CASH','BANK'].includes(a.kind)).map(a=>a._id)),unitTimes=new Map(events.filter(e=>!e.components['existingLink']).flatMap(e=>e.journalIds.map(id=>[id,e.unitKnownAt] as const))),changes=new Map<string,bigint>();
  for(const j of source.journals)if(j.recordedAt<=known&&(unitTimes.get(j._id)??j.recordedAt)<=known)for(const l of j.lines)if(cash.has(l.accountId))changes.set(j.effectiveDate,(changes.get(j.effectiveDate)??0n)+storedCents(l.debit)-storedCents(l.credit));
  const ordered=[...changes].sort(([a],[b])=>a.localeCompare(b)),answer=new Map<string,bigint>();let cursor=0,balance=0n;
  for(const date of [...new Set(dates)].sort()){
   // eslint-disable-next-line security/detect-object-injection -- Cursor is bounded by the server-sorted date changes array.
   while(cursor<ordered.length&&ordered[cursor]![0]<=date){balance+=ordered[cursor]![1];cursor++;}
   let available=balance;if(scope.kind==='BUSINESS'){const{effectiveReserves}=await import('../collections/funds.js');available-=(await effectiveReserves(this.identity.database,scope.bookId,s,date)).reduce((n,r)=>n+cents(r.amount),0n);}
   if(available<0n)throw new AppError(503,'SOURCE_INCONSISTENT');answer.set(date,available);
  }return answer;
 }
}
