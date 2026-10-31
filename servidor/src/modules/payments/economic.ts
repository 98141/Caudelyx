import {assertReceiptReversible} from '../collections/funds.js';
import type {ClientSession} from 'mongodb';
import type {IdentityService} from '../identity/service.js';
import type {Identity} from '../identity/models.js';
import type {Organization} from '../organizations/service.js';
import {domainCollection} from '../lending/evidence-v2.js';
import {stateOf} from '../lending/operations-service.js';
import {operationLoan,isHistorical} from '../lending/historical.js';
import {hash} from '../lending/contract.js';
import {publicInstallment} from '../lending/operations-engine.js';
import type {Intent,Event,EngineLoan,Plan,Credit,Schedule} from '../lending/operations-models.js';
import {cents,money,storedCents} from '../finance/money.js';
import type {Line,Journal} from '../finance/models.js';
import {today} from '../finance/service.js';
import {recordFinancialEvidence} from '../finance/integrity.js';
import {AppError} from '../../shared/errors.js';
import type {Row,EconomicSnapshot,Payment,PaymentIntent} from './models.js';
const fail=(code:string):never=>{throw new AppError(409,code);};
export class PaymentEconomics {
 constructor(readonly identity:IdentityService){}
 collection<T extends {_id:string}>(name:Parameters<typeof domainCollection>[1]){return domainCollection<T>(this.identity.database,name);}
 async record(planned:{eventId:string;before:EngineLoan[];states:EngineLoan[];plan:Plan;credit:Credit|null},request:Intent,payment:Payment|null,s:ClientSession){
  const org=planned.states[0]!.loan.organizationId;
  const events=await this.identity.operations!.events.find({organizationId:org},{session:s}).toArray();
  const data={_id:planned.eventId,organizationId:org,version:1,eventId:planned.eventId,request,before:planned.before,after:planned.states,plan:planned.plan,creditBefore:planned.credit?.balance??'0.00',destinationAccountId:request.kind==='RECEIPT'?request.destinationAccountId:null,paymentId:payment?._id??null,custodianId:payment?.intent.custodianId??null,bindingId:payment?.intent.custodianId??null,causalVersions:Object.fromEntries(planned.states.map(x=>[x.loan._id,x.position.version])),priorEventIds:events.map(e=>e._id)};
  await this.collection<EconomicSnapshot>('payment_event_snapshots').insertOne({...data,hash:hash(data)},{session:s});
 }
 async receipt(actor:Identity,org:Organization,payment:Payment,date:string,key:string,operationsETag:string,s:ClientSession,at:number,commit=false,effectiveIntent?:PaymentIntent){
  const intent=effectiveIntent??payment.intent;
  const request:Intent={kind:'RECEIPT',borrowerId:intent.borrowerId,destinationAccountId:intent.destinationAccountId,destinationAccountETag:intent.destinationAccountETag,receivedAmount:intent.amount,targets:intent.targets,excessDisposition:intent.excessDisposition,receiptReference:intent.receiptReference,effectiveDate:date,supportReference:intent.supportReference};
  // Effective current preconditions are signed by the approval preview; capture intent stays immutable.
  const planned=await this.identity.operations!.plan(actor,org,request,key,operationsETag,s,at);
  if(commit){await this.identity.operations!.persist(planned,actor,org._id,request,key,s);await this.record(planned,request,payment,s);}
  return planned;
 }
 async reverse(org:string,eventId:string,date:string,key:string,s:ClientSession,commit=false){
  if(date!==today(this.identity.now()))fail('DATE_NOT_ALLOWED');
  const cut=await this.identity.database.db.collection<{_id:string;openingId?:string;cutoffDate?:string}>('financial_books').findOne({_id:org},{session:s});if(cut?.openingId&&(!cut.cutoffDate||date<=cut.cutoffDate))fail('OPENING_CUTOFF_CONFLICT');if(await this.identity.finance!.journals.findOne({organizationId:org,effectiveDate:{$gt:date}},{session:s}))fail('LATER_JOURNAL_CONFLICT');
  const ops=this.identity.operations!,event=await ops.events.findOne({_id:eventId,organizationId:org},{session:s});
  if(!event)throw new AppError(404,'RESOURCE_NOT_FOUND');
  if(!['RECEIPT','APPLY_CREDIT'].includes(event.kind))throw new AppError(422,'UNSUPPORTED_REVERSAL_KIND');
  const comp=this.collection<Row>('loan_compensations'),prior=await comp.findOne({organizationId:org,originalEventId:eventId},{session:s});if(prior)fail('ALREADY_REVERSED');
  const snapshots=this.collection<EconomicSnapshot>('payment_event_snapshots'),snap=await snapshots.findOne({_id:eventId,organizationId:org},{session:s});
  if(!snap)fail('REVERSAL_SNAPSHOT_UNAVAILABLE');
  const {hash:expected,...unsigned}=snap!;if(hash(unsigned)!==expected)throw new AppError(503,'INTEGRITY_MISMATCH');
  const events=await ops.events.find({organizationId:org},{session:s}).toArray(),compensated=await comp.find({organizationId:org},{session:s}).toArray();
  const beforeIds=snap!['priorEventIds'] as string[];
  for(const later of events){
   if(beforeIds.includes(later._id)||later._id===eventId)continue;
   const sharesLoan=later.loanIds.some(id=>event.loanIds.includes(id)),sharesCredit=Boolean(event.plan.creditChange&&later.plan.creditChange&&later.borrowerId===event.borrowerId);
   if((sharesLoan||sharesCredit)&&!compensated.some(c=>c['originalEventId']===later._id))fail('REVERSAL_DEPENDENCY');
  }
  const book=await ops.books.findOne({_id:org,organizationId:org},{session:s});if(!book)throw new AppError(503,'INTEGRITY_MISMATCH');
  const totals=new Map<string,bigint>(),post=(id:string,n:bigint)=>totals.set(id,(totals.get(id)??0n)+n);
  for(const app of event.plan.allocations){const loan=await operationLoan(this.identity,app.loanId,org,s),profile=isHistorical(loan)?loan.profile:book.profile;post(app.component==='INTEREST'?profile.interestReceivableAccountId:profile.principalAccountId,cents(app.amount));}
  const change=event.plan.creditChange,creditDelta=change?cents(change.applied)-cents(change.added):0n;
  if(change)post(book.profile.borrowerCreditAccountId,-creditDelta);
  const credit=await ops.credits.findOne({_id:event.borrowerId,organizationId:org},{session:s});if((credit?cents(credit.balance):0n)+creditDelta<0n)fail('CREDIT_INSUFFICIENT');
  let payment:Payment|null=null,heldAccount:string|null=null;
  if(event.kind==='RECEIPT'){
   payment=await this.collection<Payment>('payments').findOne({_id:snap!.paymentId??'',organizationId:org},{session:s});
   if(!payment)fail('REVERSAL_SNAPSHOT_UNAVAILABLE');if(payment!.reconciliationState==='RECONCILED')fail('STATE_CONFLICT');
   const profile=await this.collection<Row>('held_funds_profiles').findOne({_id:org,organizationId:org},{session:s});if(!profile)fail('ACCOUNT_PROFILE_CONFLICT');
   heldAccount=String(profile!['accountId']);
   if(payment!.intent.method==='CASH')await assertReceiptReversible(this.identity.database,org,payment!._id,s);
   const funds=await this.collection<Row>('held_funds_reservations').find({organizationId:org,accountId:payment!.intent.destinationAccountId},{session:s}).toArray();
   const reserved=funds.reduce((n,h)=>n+cents(String(h['amount'])),0n);let balance=0n;
   for await(const j of this.identity.finance!.journals.find({organizationId:org},{session:s}))for(const l of j.lines)if(l.accountId===payment!.intent.destinationAccountId)balance+=storedCents(l.debit)-storedCents(l.credit);
   if(balance<reserved+cents(payment!.intent.amount))fail('FUNDS_NOT_HELD');
   if(payment!.intent.method==='CASH'){
    const custody=await this.collection<Row>('cash_custody').findOne({organizationId:org,paymentId:payment!._id},{session:s});
    if(!custody||custody['state']!=='CONFIRMED_HELD'||custody['responsibleId']!==payment!.intent.custodianId||custody['accountId']!==payment!.intent.destinationAccountId||custody['amountHeld']!==payment!.intent.amount)fail('FUNDS_NOT_HELD');
   }
   post(heldAccount,-cents(payment!.intent.amount));
  }
  const postings:Line[]=[...totals].filter(([,n])=>n!==0n).map(([accountId,n])=>({accountId,debit:n>0n?money(n):'0.00',credit:n<0n?money(-n):'0.00'})).sort((a,b)=>a.accountId.localeCompare(b.accountId));
  const states:EngineLoan[]=[];
  for(const loanId of event.loanIds){
   const loan=await operationLoan(this.identity,loanId,org,s),state=await stateOf(this.identity.database,loan,s);if(!state)throw new AppError(503,'INTEGRITY_MISMATCH');
   const before=snap!.before.find(x=>x.loan._id===loanId);if(!before)fail('REVERSAL_SNAPSHOT_UNAVAILABLE');
   // A later accrual on a revised schedule cannot be undone by restoring its predecessor.
   if(event.plan.scheduleRevisions.some(x=>x.loanId===loanId)&&state!.accruals.some(a=>!snap!.after.find(x=>x.loan._id===loanId)!.accruals.some(b=>a._id===b._id)))fail('REVERSAL_DEPENDENCY');
   for(const app of event.plan.allocations.filter(a=>a.loanId===loanId)){
    const row=state!.rows.find(r=>r.scheduleVersion===app.scheduleVersion&&r.number===app.installmentNumber);if(!row)throw new AppError(503,'INTEGRITY_MISMATCH');
    if(app.component==='INTEREST')row.interestPaid=money(cents(row.interestPaid)-cents(app.amount));
    else {state!.position.principalOutstanding=money(cents(state!.position.principalOutstanding)+cents(app.amount));if(app.component==='DUE_PRINCIPAL')row.principalPaid=money(cents(row.principalPaid)-cents(app.amount));}
   }
   if(event.plan.scheduleRevisions.some(x=>x.loanId===loanId)){
    const version=state!.position.scheduleVersion+1;
    for(const r of state!.rows.filter(r=>r.active&&r.dueDate>snap!.request.effectiveDate)){r.active=false;r.supersededByVersion=version;}
    const restored=before!.rows.filter(r=>r.active&&r.dueDate>snap!.request.effectiveDate).map(r=>({...r,_id:`${loanId}:${version}:${r.number}`,scheduleVersion:version,active:true,supersededByVersion:null,createdAt:new Date(this.identity.now()).toISOString()}));state!.rows.push(...restored);state!.position.scheduleVersion=version;
   }
   state!.position.version++;state!.position.status=cents(state!.position.principalOutstanding)>0n||(isHistorical(state!.loan)?cents(state!.loan.recognizedInterest):0n)+state!.accruals.reduce((n,a)=>n+cents(a.interest),0n)>state!.applications.filter(a=>a.eventId!==eventId&&a.component==='INTEREST').reduce((n,a)=>n+cents(a.amount),0n)?'ACTIVE':'SETTLED';states.push(state!);
  }
  if(commit){
   const reversalId=key,at=new Date(this.identity.now()).toISOString();
   for(const state of states){
    await ops.positions.replaceOne({_id:state.position._id,organizationId:org},state.position,{session:s});
    for(const row of state.rows){const existing=await ops.rows.findOne({_id:row._id,organizationId:org},{session:s});if(existing){if(hash(existing)!==hash(row))await ops.rows.replaceOne({_id:row._id,organizationId:org},row,{session:s});}else await ops.rows.insertOne(row,{session:s});}
    if(event.plan.scheduleRevisions.some(x=>x.loanId===state.loan._id)){
     const revision:Schedule={_id:`${state.loan._id}:${state.position.scheduleVersion}`,organizationId:org,loanId:state.loan._id,version:state.position.scheduleVersion,parentVersion:state.position.scheduleVersion-1,originTermsVersion:isHistorical(state.loan)?null:state.loan.termsVersion,eventId:reversalId,reason:'REVERSAL_RESTORE',createdAt:at,remainingPrincipal:state.position.principalOutstanding,futureInstallments:state.rows.filter(r=>r.active&&r.scheduleVersion===state.position.scheduleVersion).map(r=>publicInstallment(r,date))};await ops.schedules.insertOne(revision,{session:s});
    }
   }
   if(change&&credit){credit.balance=money(cents(credit.balance)+creditDelta);credit.version++;await ops.credits.replaceOne({_id:credit._id,organizationId:org},credit,{session:s});}
   const journal=await this.identity.finance!.writeJournal(org,date,postings,{type:'LOAN_COMPENSATION',id:reversalId},null,'Reversión compensatoria local S06',event.supportReference,s);
   await comp.insertOne({_id:reversalId,organizationId:org,version:1,originalEventId:eventId,creditDelta:money(creditDelta),journalId:journal._id,postings,effectiveDate:date,createdAt:at,snapshotHash:expected},{session:s});
   book.version++;await ops.books.replaceOne({_id:org,organizationId:org},book,{session:s});
   if(payment){await this.collection<Row>('held_funds_reservations').insertOne({_id:reversalId,organizationId:org,version:1,paymentId:payment._id,accountId:payment.intent.destinationAccountId,liabilityAccountId:heldAccount,borrowerId:payment.intent.borrowerId,amount:payment.intent.amount,effectiveDate:date,createdAt:at},{session:s});}
   await recordFinancialEvidence(this.identity.database,s);
   return {postings,states,eventId:reversalId,journalId:journal._id,paymentId:payment?._id??null,creditDelta:money(creditDelta)};
  }
  return {postings,states,eventId:key,journalId:null,paymentId:payment?._id??null,creditDelta:money(creditDelta)};
 }
}
export async function paymentsEvidenceMatches(identityDatabase:import('../../shared/database.js').Database){
 try{
  const db=identityDatabase.db;
  for await(const c of db.collection<Row>('loan_compensations').find()){
   const j=await db.collection<Journal>('financial_journals').findOne({_id:c['journalId']});if(!j||j.organizationId!==c.organizationId||j.source.type!=='LOAN_COMPENSATION'||j.source.id!==c._id||hash(j.lines.map(l=>({accountId:l.accountId,debit:money(storedCents(l.debit)),credit:money(storedCents(l.credit))})))!==hash(c['postings']))return false;
  }
  for await(const p of db.collection<Payment>('payments').find()){
   if(['CONFIRMED','REVERSAL_REQUESTED','REVERSED'].includes(p.status)){const e=await db.collection<Event>('loan_events').findOne({_id:p.eventId??'',organizationId:p.organizationId});if(!e||e.kind!=='RECEIPT'||e.receiptReference!==p.intent.receiptReference)return false;}
   if(p.intent.method==='CASH'){const c=await db.collection<Row>('cash_custody').findOne({organizationId:p.organizationId,paymentId:p._id});if(!c||c['state']!==p.custodyState||c['responsibleId']!==p.intent.custodianId)return false;}else if(await db.collection('cash_custody').countDocuments({organizationId:p.organizationId,paymentId:p._id}))return false;
  }
  for await(const r of db.collection<Row>('held_funds_reservations').find())if(!await db.collection<Row>('loan_compensations').findOne({_id:r._id,organizationId:r.organizationId}))return false;
  return true;
 }catch{return false;}
}

