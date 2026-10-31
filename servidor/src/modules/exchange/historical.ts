/* eslint-disable security/detect-object-injection -- Four closed profile roles, signed source IDs and validated template fields. */
import type {ClientSession} from 'mongodb';
import type {IdentityService} from '../identity/service.js';
import type {Context} from '../identity/models.js';
import type {OpeningRow,Component} from '../opening/models.js';
import type {Book,Position,Installment,Schedule,Profile} from '../lending/operations-models.js';
import type {HistoricalLoan,HistoricalQuota} from '../lending/historical.js';
import {beginEvidence,domainCollection} from '../lending/evidence-v2.js';
import {publicInstallment} from '../lending/operations-engine.js';
import {cents,money,storedCents} from '../finance/money.js';
import {AppError} from '../../shared/errors.js';
import {etag,table,type Row,type Liability} from '../obligations/models.js';
import {liabilityCommand} from '../obligations/liabilities.js';
import {loadReportingFinance} from '../finance/scoped-integrity.js';
import {ExchangeRepository} from './repository.js';
import {exchangeContract} from './contract.js';
import type {Plan,Scope,Data,HistoricalProfile} from './models.js';
const roles=['principalAccountId','interestReceivableAccountId','interestIncomeAccountId','borrowerCreditAccountId'] as const;
function fail(code:string,status=409):never{throw new AppError(status,code);}
async function opening(identity:IdentityService,scope:Scope,id:string,s:ClientSession){
 const row=await identity.opening!.files.findOne({_id:id,organizationId:scope.bookId,bookId:scope.bookId,ownerId:scope.ownerId,financialScope:'BUSINESS',status:'POSTED'},{session:s});if(!row||!row.commit)throw new AppError(404,'RESOURCE_NOT_FOUND');
 const finance=await loadReportingFinance(identity.database,scope.bookId,null,s,()=>{}),journal=finance.journals.find(j=>j._id===row.commit!.journalId);if(!journal||journal.source.type!=='OPENING'||journal.source.id!==row._id||journal.effectiveDate!==row.snapshot.cutoffDate)fail('SOURCE_INCONSISTENT',503);return row;
}
async function unused(repo:ExchangeRepository,scope:Scope,id:string,s:ClientSession){if((await repo.all<Row>('s11_opening_component_claims',scope,s)).some(r=>r['componentId']===id))fail('SOURCE_CONFLICT');}
export interface ValidatedOrigin {loan:HistoricalLoan;opening:OpeningRow;component:Component;profile:HistoricalProfile;interestIds:string[]}
export async function validateHistorical(identity:IdentityService,scope:Scope,plan:Plan,s:ClientSession,committing=false):Promise<ValidatedOrigin[]>{
 if(scope.kind!=='BUSINESS'||plan.mode!=='HISTORICAL_LINK')fail('INPUT_INVALID',422);const repo=new ExchangeRepository(identity),links=plan.links.filter(l=>l['kind']==='LOAN'),profiles=plan.historicalProfiles??[],seen=new Set<string>(),origins:ValidatedOrigin[]=[];
 if(profiles.length!==links.length||new Set(profiles.map(p=>p.externalKey)).size!==profiles.length)fail('INPUT_INVALID',422);
 if(plan.commands.some(c=>!['createBorrower','businessCreateLiability'].includes(c.operationId)))fail('INPUT_INVALID',422);
 const book=await identity.operations!.books.findOne({_id:scope.bookId,organizationId:scope.bookId},{session:s});let common:Profile|undefined=book?.profile;
 for(const link of links){
  const key=String(link['externalKey']),configuration=profiles.find(p=>p.externalKey===key);if(!configuration)fail('INPUT_INVALID',422);exchangeContract().validate('HistoricalProfile',configuration);
  const profile=configuration!.accountProfile;if(new Set(Object.values(profile)).size!==4)fail('INPUT_INVALID',422);
  for(const role of roles){const account=await identity.finance!.accounts.findOne({_id:profile[role],organizationId:scope.bookId,bookId:scope.bookId,ownerId:scope.ownerId,financialScope:'BUSINESS',status:'ACTIVE',currency:'COP'},{session:s});if(!account)fail('RESOURCE_NOT_FOUND',404);if(account!.kind!=='GENERAL'||account!.accountClass!==(role==='interestIncomeAccountId'?'INCOME':role==='borrowerCreditAccountId'?'LIABILITY':'ASSET'))fail('IMPORT_REFERENCE_INVALID',422);if(etag(account!)!==configuration!.accountVersions[role])fail('PRECONDITION_FAILED',412);}
  if(common&&(common.interestIncomeAccountId!==profile.interestIncomeAccountId||common.borrowerCreditAccountId!==profile.borrowerCreditAccountId))fail('SOURCE_CONFLICT');common??=profile;
  const source=await opening(identity,scope,String(link['openingId']),s),component=source.snapshot.components.find(c=>c.id===link['principalComponentId']),reference=source.snapshot.references.find(r=>r.id===link['loanReferenceId']);
  if(!component||!reference||component.category!=='PRINCIPAL_RECEIVABLE'||component.referenceId!==reference.id||reference.type!=='HISTORICAL_LOAN'||component.accountId!==profile.principalAccountId||component.amount!==link['principalOutstanding']||reference.originationDate!==link['originationDate']||String(link['originationDate'])>source.snapshot.cutoffDate||plan.cutoffDate!==source.snapshot.cutoffDate)fail('IMPORT_REFERENCE_INVALID',422);
  const borrower=await identity.lending!.borrowers.findOne({_id:String(link['borrowerId']),organizationId:scope.bookId,ownerId:scope.ownerId},{session:s}),command=plan.commands.find(c=>c.operationId==='createBorrower'&&plan.aliases['Prestatarios:'+c.externalKey]===link['borrowerId']),binding=(borrower?.openingBorrowerReference??command?.payload['openingBorrowerReference']) as {openingId:string;referenceId:string}|undefined;
  if(!binding||binding.openingId!==source._id||binding.referenceId!==reference.borrowerId||committing&&!borrower)fail('IMPORT_REFERENCE_INVALID',422);
  const raw=link['installments'] as Data[],quotas:HistoricalQuota[]=raw.map(q=>({number:Number(q['number']),dueDate:String(q['dueDate']),principalRemaining:String(q['principalRemaining']),recognizedInterestRemaining:String(q['recognizedInterestRemaining']),unrecognizedInterestRemaining:String(q['unrecognizedInterestRemaining']),supportKeys:String(q['supportKeys']).split(';')})),principal=money(quotas.reduce((n,q)=>n+cents(q.principalRemaining),0n)),recognized=money(quotas.reduce((n,q)=>n+cents(q.recognizedInterestRemaining),0n)),interest=source.snapshot.historicalInterest.filter(i=>i.loanReferenceId===reference.id&&i.treatment==='RECOGNIZED_OPENING');
  exchangeContract().validate('HistoricalLink',{externalKey:key,openingId:source._id,loanReferenceId:reference.id,principalComponentId:component.id,borrowerId:link['borrowerId'],principal,scheduleVersion:1,installments:quotas});
  if(principal!==component.amount||new Set(quotas.map(q=>q.number)).size!==quotas.length||quotas.some((q,i)=>q.number!==i+1)||recognized!==money(interest.reduce((n,i)=>n+cents(i.amount),0n))||interest.some(i=>i.accountId!==profile.interestReceivableAccountId))fail('IMPORT_REFERENCE_INVALID',422);
  for(const q of quotas)for(const support of q.supportKeys){const declared=plan.normalized['Soportes']!.find(r=>r['externalKey']===support);if(!declared||String(declared['asOfDate'])>source.snapshot.cutoffDate)fail('IMPORT_REFERENCE_INVALID',422);}
  for(const id of [component.id,...interest.map(i=>i.id)]){if(seen.has(id))fail('SOURCE_CONFLICT');seen.add(id);await unused(repo,scope,id,s);}
  const id=String(link['id']);if(await identity.operations!.positions.findOne({_id:id,organizationId:scope.bookId},{session:s})||await identity.lending!.loans.findOne({_id:id,organizationId:scope.bookId},{session:s}))fail('SOURCE_CONFLICT');
  const loan={_id:id,bookId:scope.bookId,ownerId:scope.ownerId,domainKind:'BUSINESS',organizationId:scope.bookId,version:1,recordedAt:'',mac:'',borrowerId:String(link['borrowerId']),status:'HISTORICAL_DECLARED',origin:'HISTORICAL_S11',principal,recognizedInterest:recognized,cutoffDate:source.snapshot.cutoffDate,originationDate:String(link['originationDate']),openingId:source._id,loanReferenceId:reference.id,principalComponentId:component.id,profile,installments:quotas,createdAt:new Date(identity.now()).toISOString()} as HistoricalLoan;
  origins.push({loan,opening:source,component,profile:configuration!,interestIds:interest.map(i=>i.id)});
 }
 return origins;
}
export async function applyHistorical(identity:IdentityService,scope:Scope,plan:Plan,s:ClientSession,repo:ExchangeRepository,known:string){
 const origins=await validateHistorical(identity,scope,plan,s,true);if(!origins.length)return{effectCount:0};await beginEvidence(identity.database,s,scope.bookId);let book=await identity.operations!.books.findOne({_id:scope.bookId,organizationId:scope.bookId},{session:s});const finance=await loadReportingFinance(identity.database,scope.bookId,null,s,()=>{}),balances=new Map<string,bigint>();for(const j of finance.journals)for(const line of j.lines)balances.set(line.accountId,(balances.get(line.accountId)??0n)+storedCents(line.debit)-storedCents(line.credit));
 if(!book)book={_id:scope.bookId,organizationId:scope.bookId,version:0,profile:origins[0]!.loan.profile,baseline:[],currency:'COP',createdAt:known};
 for(const origin of origins){
  for(const accountId of Object.values(origin.loan.profile))if(!book.baseline.some(l=>l.accountId===accountId)){const value=balances.get(accountId)??0n;book.baseline.push({accountId,debit:value>0n?money(value):'0.00',credit:value<0n?money(-value):'0.00'});}
  const {mac,recordedAt,...raw}=origin.loan;void mac;void recordedAt;const loan=await repo.write('s11_historical_origins',scope,s,{...raw,createdAt:known},origin.loan._id) as HistoricalLoan;
  for(const componentId of [loan.principalComponentId,...origin.interestIds])await repo.write('s11_opening_component_claims',scope,s,{componentId,openingId:loan.openingId,resourceId:loan._id,kind:'HISTORICAL_LOAN',unitKnownAt:known});
  const position:Position={_id:loan._id,organizationId:scope.bookId,loanId:loan._id,borrowerId:loan.borrowerId,version:1,termsVersion:null,scheduleVersion:1,status:'ACTIVE',originalPrincipal:loan.principal,principalOutstanding:loan.principal,fundingEventId:null,historicalOriginId:loan._id,createdAt:known};await identity.operations!.positions.insertOne(position,{session:s});
  const rows:Installment[]=loan.installments.map(q=>({_id:loan._id+':1:'+q.number,organizationId:scope.bookId,loanId:loan._id,scheduleVersion:1,number:q.number,dueDate:q.dueDate,principal:q.principalRemaining,interest:money(cents(q.recognizedInterestRemaining)+cents(q.unrecognizedInterestRemaining)),openingRecognizedInterest:q.recognizedInterestRemaining,payment:money(cents(q.principalRemaining)+cents(q.recognizedInterestRemaining)+cents(q.unrecognizedInterestRemaining)),principalPaid:'0.00',interestPaid:'0.00',active:true,supersededByVersion:null,createdAt:known}));await identity.operations!.rows.insertMany(rows,{session:s});
  const schedule:Schedule={_id:loan._id+':1',organizationId:scope.bookId,loanId:loan._id,version:1,parentVersion:null,originTermsVersion:null,eventId:null,reason:'HISTORICAL_DECLARED',createdAt:known,remainingPrincipal:loan.principal,futureInstallments:rows.map(r=>publicInstallment(r,loan.cutoffDate))};await identity.operations!.schedules.insertOne(schedule,{session:s});
  const identityKey=scope.bookId+':'+plan.namespace+':LOAN:'+origin.profile.externalKey;if((await repo.all<Row>('s11_external_refs',scope,s)).some(r=>r['identityKey']===identityKey))fail('EXTERNAL_KEY_CONFLICT');await repo.write('s11_external_refs',scope,s,{identityKey,namespace:plan.namespace,externalKey:origin.profile.externalKey,entityType:'LOAN',resourceId:loan._id});
 }
 await domainCollection<Book>(identity.database,'loan_operation_books').replaceOne({_id:book._id},book,{session:s,upsert:true});await repo.store.touch(scope,s,true,Date.parse(known));return{effectCount:origins.length};
}
export async function claimOpeningLiability(identity:IdentityService,scope:Scope,openingId:string,componentId:string,liability:Pick<Liability,'_id'|'principal'>,principalAccountId:string,s:ClientSession,commit=false){
 const repo=new ExchangeRepository(identity),source=await opening(identity,scope,openingId,s),component=source.snapshot.components.find(c=>c.id===componentId);if(!component||component.category!=='LIABILITY'||component.amount!==liability.principal||component.accountId!==principalAccountId||!component.referenceId||!source.snapshot.references.some(r=>r.id===component.referenceId&&r.type==='OBLIGATION'))fail('IMPORT_REFERENCE_INVALID',422);await unused(repo,scope,componentId,s);
 if(commit)await repo.write('s11_opening_component_claims',scope,s,{componentId,openingId,resourceId:liability._id,kind:'LIABILITY',journalId:source.commit!.journalId,unitKnownAt:new Date(identity.now()).toISOString()});return{source,component};
}
export async function openingLiabilityLinks(identity:IdentityService,scope:Scope,plan:Plan,s:ClientSession){
 const control=Object.fromEntries(plan.normalized['Control']!.map(r=>[String(r['key']),r['value']])),links:Data[]=[],seen=new Set<string>(),local=(v:unknown,sheet:string)=>typeof v==='string'&&v.startsWith('@')?plan.aliases[sheet+':'+v.slice(1)]:v;
 for(const link of plan.links.filter(r=>r['kind']==='LIABILITY'&&r['openingComponentKey'])){
  if(scope.kind!=='BUSINESS'||link['recognitionKind']!=='EXISTING_JOURNAL_LINK')fail('IMPORT_REFERENCE_INVALID',422);const componentId=String(local(link['openingComponentKey'],'Apertura'));if(seen.has(componentId))fail('SOURCE_CONFLICT');seen.add(componentId);
  const id=String(link['id']),row=await identity.database.db.collection<Liability>(table(scope.kind,'liabilities')).findOne({_id:id,bookId:scope.bookId,ownerId:scope.ownerId,domainKind:scope.kind},{session:s}),create=plan.commands.find(c=>c.operationId==='businessCreateLiability'&&plan.aliases['Obligaciones:'+c.externalKey]===id),principal=row?.principal??String(create?.payload['principal']??'');
  if(!row&&!create)fail('RESOURCE_NOT_FOUND',404);if(row){await identity.obligations!.store.get<Liability>(table(scope.kind,'liabilities'),id,scope,s);if(row.status!=='DRAFT'||row.schedule.kind!=='OFFICIAL_DECLARED')fail('SOURCE_CONFLICT');}
  const input={externalKey:link['externalKey'],openingId:link['openingId']??control['openingId'],componentId,liabilityId:id,principalAccountId:local(link['principalAccountKey'],'Cuentas'),principal,expectedLiabilityETag:row?etag(row):'"'+id+':1"'};exchangeContract().validate('OpeningLiabilityLink',input);if(row&&link['expectedETag']!==etag(row))fail('PRECONDITION_FAILED',412);await claimOpeningLiability(identity,scope,String(input.openingId),componentId,{_id:id,principal},String(input.principalAccountId),s);links.push(input);
 }return links;
}
export async function applyOpeningLiabilities(identity:IdentityService,context:Context,scope:Scope,plan:Plan,s:ClientSession){
 const links=await openingLiabilityLinks(identity,scope,plan,s);for(const link of links){const c=identity.obligations!.context(context,scope,s,link,{liabilityId:String(link['liabilityId'])},[],[]);await liabilityCommand(c,'linkOpeningLiability');}return links.length;
}
