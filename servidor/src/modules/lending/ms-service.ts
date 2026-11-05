import {persistentDemoAdmitted} from '../../shared/persistent-demo.js';
/* eslint-disable security/detect-object-injection -- Closed contract operations, four profile keys, and server-owned signed metadata only. */
import {createHash,randomUUID} from 'node:crypto';
import type {ClientSession} from 'mongodb';
import type {IdentityService} from '../identity/service.js';
import type {Context,Identity} from '../identity/models.js';
import type {Organization} from '../organizations/service.js';
import {personalActor,resolveScope,grant,authorityBinding} from '../obligations/authority.js';
import {booksTable,privateAccounts,etag,type Row,type Book,type Scope,type Data,type Result} from '../obligations/models.js';
import {hash,canonical} from './contract.js';
import {beginEvidence,domainCollection} from './evidence-v2.js';
import {recordLendingEvidence} from './integrity.js';
import {monthlyContract} from './ms-contract.js';
import {isMonthlyLoan,type MonthlyLoan,type MonthlyTerms} from './ms-models.js';
import {validateMonthlyTerms,versionMonthlyRate,msCents,msRate,msDate} from './ms-engine.js';
import {stateOf} from './operations-service.js';
import {today} from '../finance/service.js';
import {AppError} from '../../shared/errors.js';
import type {Account} from '../finance/models.js';
import type {Intent,Profile} from './operations-models.js';
import {configureMsAuthorization,encryptMsToken,decryptMsToken} from './ms-history.js';
import {queryMs,prepareMsComposite,commitMsComposite,prepareMsHistory,commitMsHistory,previewMsHistory} from './ms-queries.js';
import {MsWorker} from './ms-worker.js';

const fail=(code:string,status=409):never=>{throw new AppError(status,code);};
export const msStableId=(...parts:string[])=>{const h=createHash('sha256').update(JSON.stringify(parts)).digest('hex');return`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
export interface MsQuote {operation:string;scopeId:string;actorBinding:string;sourceTag:string;params:Record<string,string>;request:Data;executionKey:string;requestHash:string;planHash:string;issuedAt:number;expiresAt:number;date:string}
export interface MsPrepared {postings:{accountId:string;debit:string;credit:string}[];interest:string;principal:string;credit:string;cashDelta:string;reservedDelta:string;details:unknown}
export interface MsUnit {context:Context;actor:Identity;scope:Scope;book:Book|null;s:ClientSession;now:string;sourceTag:string;eventIds:string[];journalIds:string[];lendingChanged:boolean;budget:()=>void}
const instances=new WeakMap<IdentityService,MonthlyService>();
export const monthlyService=(identity:IdentityService)=>{const value=instances.get(identity);if(!value)throw new AppError(503,'SERVICE_UNAVAILABLE');return value;};
function economicHash(value:unknown):string{
 const strip=(v:unknown):unknown=>Array.isArray(v)?v.map(strip):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([k])=>!['createdAt','recordedAt','fixedAt','recognizedAt'].includes(k)).map(([k,x])=>[k,strip(x)])):v;
 return hash(strip(value));
}
export class MonthlyService {
 readonly worker:MsWorker;private enabled=false;
 constructor(readonly identity:IdentityService,key:Buffer){monthlyContract();configureMsAuthorization(identity,key);instances.set(identity,this);this.worker=new MsWorker(this);}
 get management(){if(!this.identity.obligations)throw new AppError(503,'SERVICE_UNAVAILABLE');return this.identity.obligations;}
 get active(){return this.enabled&&this.management.active&&Boolean(this.identity.reporting?.projection);}
 async activateOwned(owned:()=>Promise<boolean>,automatic=true){
  const db=this.identity.database,hosts=db.client.options.hosts;
  if((!persistentDemoAdmitted(db)&&(!/^caudelyx_s08_p02_[a-f0-9]{24}$/.test(db.db.databaseName)||hosts.length!==1||hosts[0]?.port!==27017||!['localhost','127.0.0.1'].includes(hosts[0]?.host??'')))||!await owned()||!this.management.active)fail('ACCESS_DENIED',403);
  this.enabled=true;const previous=db.projectionShutdown;db.projectionShutdown=async()=>{await this.worker.stop();this.enabled=false;await previous?.();};if(automatic)this.worker.start();
 }
 async requireActive(){await this.identity.requireOpen('TENANT');if(!this.active)fail('SERVICE_UNAVAILABLE',503);}
 async scope(context:Context,bookId:string,s:ClientSession){const current=await personalActor(this.identity,context,s);return await resolveScope(this.identity,context,current.actor.organizationId===bookId?'BUSINESS':'PERSONAL',bookId,s);}
 async tag(scope:Scope,s:ClientSession){
  const b=await this.identity.database.db.collection<Book>(booksTable).findOne({_id:scope.bookId},{session:s});
  if(b)return await this.identity.wealth!.bookTag(scope,s);
  const financial=scope.kind==='BUSINESS'?await this.identity.database.db.collection<{_id:string}>('financial_books').findOne({_id:scope.bookId},{session:s}):null;
  return '"ms-empty:'+scope.bookId+':'+hash({financial,restoreEpoch:this.management.store.restoreEpoch})+'"';
 }
 async rows<T extends Row=Row>(name:string,scope:Scope,s:ClientSession){return await this.management.store.all<T>(name,scope,s);}
 async loan(bookId:string,id:string,s:ClientSession){
  const unit=await beginEvidence(this.identity.database,s,bookId),loan=(await unit.query('lending_monthly_loans',{organizationId:bookId,_id:id},{},1))[0];
  if(!loan)fail('RESOURCE_NOT_FOUND',404);if(!isMonthlyLoan(loan))fail('INTEGRITY_MISMATCH',503);return loan as unknown as MonthlyLoan;
 }
 async mapping(scope:Scope,s:ClientSession,selector?:string,date=today(this.identity.now())){
  const rows=await this.rows('ms_mappings',scope,s),eligible=rows.filter(r=>String(r['effectiveFrom'])<=date&&(selector===undefined||selector===r._id+':'+r.version)).sort((a,b)=>String(a['effectiveFrom']).localeCompare(String(b['effectiveFrom']))||a.version-b.version);
  const row=eligible.at(-1);if(!row)fail('MAPPING_REQUIRED');return row!;
 }
 async snapshot(purpose:string,resourceId:string|null,actor:Identity,s:ClientSession,command?:Data|null){
  if(!this.active||!command||actor.realm!=='TENANT'||actor.roles.includes('SA'))fail('ACCESS_DENIED',403);
  const spec=monthlyContract().operations.get(String(command!['operationId']));if(!spec||spec.definition['x-purpose']!==purpose)fail('INPUT_INVALID',422);
  monthlyContract().validate(String(command!['operationId']),command!['payload']);const bookId=String(command!['bookId']);monthlyContract().validate('Id',bookId);
  if(actor.organizationId===bookId){if(!actor.roles.includes('T'))fail('ACCESS_DENIED',403);}else{
   const book=await this.identity.database.db.collection<Book>(booksTable).findOne({_id:bookId,subjectId:actor._id,domainKind:'PERSONAL',status:'ACTIVE'},{session:s});
   if(!book)fail('RESOURCE_NOT_FOUND',404);const assignment=await this.management.store.get<Row>('s09_personal_assignments',book!.assignmentId!,{kind:'PERSONAL',bookId,ownerId:actor._id},s);if(assignment['active']!==true)fail('ACCESS_DENIED',403);
  }
  return hash({purpose,resourceId,command,actorId:actor._id,authz:actor.authzVersion,epoch:actor.authEpoch,credential:actor.credentialVersion});
 }
 async readUnit<T>(context:Context,bookId:string,work:(unit:MsUnit)=>Promise<T>):Promise<T>{
  await this.requireActive();const started=performance.now(),barrier=await this.management.enter(started),legacy=await this.identity.reporting!.projection!.enter(started);
  const value=await this.identity.database.client.withSession(async s=>await s.withTransaction(async()=>{
   const budget=()=>{if(performance.now()-started>10000)fail('MS_QUERY_BUDGET_EXCEEDED',503);},resolved=await this.scope(context,bookId,s);budget();const result=await work({context:await this.identity.sessions.findById(context,s),...resolved,s,now:new Date(this.identity.now()).toISOString(),sourceTag:await this.tag(resolved.scope,s),eventIds:[],journalIds:[],lendingChanged:false,budget});budget();return result;
  },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'}}));
  await this.management.leave(barrier,started);await this.identity.reporting!.projection!.leave(legacy,started);return value;
 }
 async read(context:Context,operation:string,params:Record<string,string>,query:Data={}):Promise<Result>{
  if(operation==='msGetConsolidatedMonthlyView')return await queryMs(this,context,operation,params,query);
  return await this.readUnit(context,params['bookId']!,async u=>await queryMs(this,context,operation,params,query,u));
 }
 async mutateUnit(context:Context,operation:string,payload:Data,params:Record<string,string>,key:string,expected:string|undefined,work:(u:MsUnit)=>Promise<Result>):Promise<Result>{
  await this.requireActive();const spec=monthlyContract().operations.get(operation);if(!spec||spec.method!=='post'||spec.definition['x-mej-category']==='READ_ONLY')fail('INPUT_INVALID',422);
  const started=performance.now(),barrier=await this.management.enter(started),legacy=await this.identity.reporting!.projection!.enter(started),fingerprint=hash({operation,payload,params,key,expected:expected??null});
  const result=await this.identity.database.transaction(async s=>{
   this.management.store.tracking.begin(s);
   try{
    const resolved=await this.scope(context,params['bookId']!,s);await grant(this.identity,context,spec!.definition['x-mej-category'] as 'WORK_ONLY'|'BALANCE_60M',s);
    const old=(await this.rows('ms_commands',resolved.scope,s)).find(r=>r['actorId']===resolved.actor._id&&r['operation']===operation&&r['key']===key);
    if(old){if(old['fingerprint']!==fingerprint)fail('IDEMPOTENCY_CONFLICT');return old['result'] as unknown as Result;}
    if(!['msCreateMonthlyDraft','msCreateDebtPlan'].includes(operation)){
     if(!expected)fail('ETAG_REQUIRED',428);const tag=params['loanId']?etag(await this.loan(resolved.scope.bookId,params['loanId'],s)):await this.tag(resolved.scope,s);if(expected!==tag)fail('PRECONDITION_FAILED',412);
    }
    const sourceTag=await this.tag(resolved.scope,s),book=await this.management.ensureBook(resolved.scope,s);
    if(spec!.definition['x-mej-category']==='BALANCE_60M'&&resolved.scope.kind==='BUSINESS')await this.identity.database.db.collection<{_id:string;value:number}>('financial_books').updateOne({_id:resolved.scope.bookId},{$inc:{value:1}},{session:s,upsert:true});
    const budget=()=>{if(performance.now()-started>10000)fail('MS_QUERY_BUDGET_EXCEEDED',503);},u:MsUnit={context:await this.identity.sessions.findById(context,s),...resolved,book,s,now:new Date(this.identity.now()).toISOString(),sourceTag,eventIds:[],journalIds:[],lendingChanged:false,budget},output=await work(u);budget();
    await grant(this.identity,context,spec!.definition['x-mej-category'] as 'WORK_ONLY'|'BALANCE_60M',s);
    const fenced=await this.identity.identities.updateOne({_id:u.actor._id,authEpoch:u.actor.authEpoch,authzVersion:u.actor.authzVersion,credentialVersion:u.actor.credentialVersion,suspended:false},{$inc:{operationCommandFence:1}},{session:s});if(fenced.matchedCount!==1)fail('ACCESS_DENIED',403);
    if(u.scope.kind==='BUSINESS'){const org=await this.identity.database.db.collection<Organization>('organizations').findOne({_id:u.scope.bookId,status:'ACTIVE'},{session:s});if(!org)fail('ACCESS_DENIED',403);const fence=await this.identity.database.db.collection<Organization>('organizations').updateOne({_id:u.scope.bookId,status:'ACTIVE',authEpoch:org!.authEpoch},{$inc:{operationCommandFence:1}},{session:s});if(fence.matchedCount!==1)fail('ACCESS_DENIED',403);}
    await this.management.store.touch(u.scope,s,spec!.definition['x-mej-category']==='BALANCE_60M');
    await this.management.store.put('ms_commands',{_id:msStableId(u.scope.bookId,u.actor._id,operation,key),bookId:u.scope.bookId,ownerId:u.scope.ownerId,domainKind:u.scope.kind,version:1,actorId:u.actor._id,operation,key,fingerprint,result:output},s);
    if(u.lendingChanged)await recordLendingEvidence(this.identity.database,s);await this.management.store.finish(s);
    await this.identity.audit.append({realm:'TENANT',actorId:u.actor._id,subjectId:u.actor._id,action:'MS_COMMAND',outcome:'SUCCESS'},s);return output;
   }finally{this.management.store.tracking.end(s);}
  });
  if(!this.identity.database.flushEvidence)fail('SERVICE_UNAVAILABLE',503);await this.identity.database.flushEvidence!();await this.management.leave(barrier,started);await this.identity.reporting!.projection!.leave(legacy,started);return result;
 }
 async account(u:MsUnit,id:string,accountClass?:string,kind?:string[]){
  const row=u.scope.kind==='PERSONAL'?await this.management.store.get<import('../obligations/models.js').Account>(privateAccounts,id,u.scope,u.s):await this.identity.finance!.accounts.findOne({_id:id,organizationId:u.scope.bookId,ownerId:u.scope.ownerId,financialScope:'BUSINESS'},{session:u.s});
  if(!row)fail('RESOURCE_NOT_FOUND',404);if(row!.currency!=='COP'||row!.status!=='ACTIVE'||accountClass&&row!.accountClass!==accountClass||kind&&!kind.includes(row!.kind))fail('ACCOUNT_INELIGIBLE',422);return row!;
 }
 async setMapping(u:MsUnit,p:Data):Promise<Result>{
  for(const id of p['cashAccountIds'] as string[])await this.account(u,id,'ASSET',['CASH','BANK']);
  for(const c of p['categories'] as Data[])await this.account(u,String(c['expenseAccountId']),'EXPENSE',['GENERAL']);
  const profile=p['loanProfile'] as Profile|undefined;
  if(profile){if(u.scope.kind!=='BUSINESS'||new Set(Object.values(profile)).size!==4)fail('ACCOUNT_PROFILE_CONFLICT');for(const[k,id]of Object.entries(profile))await this.account(u,id,k==='interestIncomeAccountId'?'INCOME':k==='borrowerCreditAccountId'?'LIABILITY':'ASSET',['GENERAL']);}
  const liabilities=p['liabilityProfile'] as Data|undefined;if(liabilities)for(const[k,id]of Object.entries(liabilities))await this.account(u,String(id),k.endsWith('ExpenseAccountId')?'EXPENSE':'LIABILITY',['GENERAL']);
  const targets=p['savingsTargets'] as Data[]|undefined;if(targets){
   const {table}=await import('../obligations/models.js'),{wealthTable}=await import('../wealth/models.js'),oldLinks=await this.rows('ms_savings_links',u.scope,u.s),balances=await this.identity.wealth!.reserved(u.scope,u.s);
   if(new Set(targets.map(t=>t['fundId'])).size!==targets.length)fail('RESERVATION_CONFLICT');
   for(const t of targets){const l=await this.management.store.get<import('../obligations/models.js').Liability>(table(u.scope.kind,'liabilities'),String(t['liabilityId']),u.scope,u.s),fund=await this.management.store.get<import('../wealth/models.js').Fund>(wealthTable(u.scope.kind,'funds'),String(t['fundId']),u.scope,u.s),i=l.schedule.installments.find(i=>t['installmentNumber']===i.number||t['installmentId']===msStableId(l._id,l.schedule.id,String(i.number)));if(!i||fund.status!=='ACTIVE')fail('RESERVATION_CONFLICT');
    const installmentId=msStableId(l._id,l.schedule.id,String(i!.number)),prior=oldLinks.find(v=>v['fundId']===fund._id);if(prior&&(prior['liabilityId']!==l._id||prior['installmentId']!==installmentId)&&(balances.get(fund._id)??0n)>0n)fail('RESERVATION_CONFLICT');
    const dates=t['opportunityDates'] as string[];if(new Set(dates).size!==dates.length||dates.some(d=>d>=i!.dueDate))fail('INPUT_INVALID',422);
    await this.management.store.put('ms_savings_links',{_id:fund._id,bookId:u.scope.bookId,ownerId:u.scope.ownerId,domainKind:u.scope.kind,version:(prior?.version??0)+1,liabilityId:l._id,scheduleVersionId:l.schedule.id,installmentId,fundId:fund._id,opportunityDates:dates},u.s);
   }
  }
  const old=await this.rows('ms_mappings',u.scope,u.s),version=1+Math.max(0,...old.map(r=>r.version)),id=randomUUID();
  await this.management.store.put('ms_mappings',{_id:id,bookId:u.scope.bookId,ownerId:u.scope.ownerId,domainKind:u.scope.kind,version,...p},u.s);
  if(!(await this.rows('ms_closure_policies',u.scope,u.s)).length){
   const {ledgerSources}=await import('../wealth/sources.js'),source=await ledgerSources(this.identity.wealth!,u.scope,u.s);
   if(!source.journals.length)await this.management.store.put('ms_closure_policies',{_id:u.scope.bookId,bookId:u.scope.bookId,ownerId:u.scope.ownerId,domainKind:u.scope.kind,version:1,knownFrom:today(this.identity.now()),closedPeriods:[],origin:'EMPTY_BOOK_MS_ACTIVATION'},u.s);
  }
  return{status:200,data:{id,version,bookId:u.scope.bookId,effectiveFrom:p['effectiveFrom'],digest:hash(p)},etag:etag({_id:id,version})};
 }
 async draft(u:MsUnit,p:MonthlyTerms,key:string):Promise<Result>{
  if(u.scope.kind!=='BUSINESS')fail('ACCESS_DENIED',403);validateMonthlyTerms(p);
  const mapping=await this.mapping(u.scope,u.s,p.mappingVersion,p.effectiveDate),profile=mapping['loanProfile'] as Profile|undefined;if(!profile)fail('MAPPING_REQUIRED');
  const unit=await beginEvidence(this.identity.database,u.s,u.scope.bookId),borrower=(await unit.query('lending_borrowers',{organizationId:u.scope.bookId,_id:p.borrowerId},{},1))[0];if(!borrower||borrower['status']!=='ACTIVE')fail('RESOURCE_NOT_FOUND',404);
  await this.account(u,p.cashAccountId,'ASSET',['CASH','BANK']);if(!(mapping['cashAccountIds'] as string[]).includes(p.cashAccountId))fail('ACCOUNT_INELIGIBLE',422);
  const loan:MonthlyLoan={_id:msStableId(u.scope.bookId,u.actor._id,'MONTHLY_DRAFT',key),organizationId:u.scope.bookId,ownerId:u.scope.ownerId,borrowerId:p.borrowerId,version:1,modality:'MONTHLY_OPEN_V1',status:'MONTHLY_DRAFT',terms:structuredClone(p),termsVersion:1,profile:structuredClone(profile!),createdAt:u.now};
  await domainCollection<MonthlyLoan>(this.identity.database,'lending_monthly_loans').insertOne(loan,{session:u.s});u.lendingChanged=true;
  return{status:200,data:{id:loan._id,bookId:u.scope.bookId,version:1,status:'DRAFT',terms:p},etag:etag(loan)};
 }
 async mandate(u:MsUnit,loan:MonthlyLoan,p:Data,revoke=false){
  const old=(await this.rows('ms_mandates',u.scope,u.s)).find(m=>m['loanId']===loan._id),version=(old?.version??0)+1;
  if(revoke&&!old)fail('RESOURCE_NOT_FOUND',404);
  if(!revoke){if(loan.status!=='MONTHLY_ACTIVE')fail('INVALID_STATE');msDate(String(p['fromDate']));msDate(String(p['untilDate']));if(String(p['fromDate'])<loan.terms.effectiveDate||msRate(String(p['rateCeiling']))<msRate(loan.terms.monthlyRate))fail('INPUT_INVALID',422);}
  if(!revoke&&(p['consent']!==true||String(p['fromDate'])>String(p['untilDate'])||msCents(String(p['principalCeiling']))<msCents(loan.terms.principal)))fail('INPUT_INVALID',422);
  if(!revoke){const state=await stateOf(this.identity.database,loan,u.s);if(!state?.position.monthlyState)fail('INTEGRITY_MISMATCH',503);if(state!.position.monthlyState!.rateVersions.some(v=>v.effectiveFrom<=String(p['untilDate'])&&msRate(v.rate)>msRate(String(p['rateCeiling']))))fail('MANDATE_INVALID',403);}
  const org=await this.identity.database.db.collection<Organization>('organizations').findOne({_id:u.scope.bookId,status:'ACTIVE'},{session:u.s});if(!org)fail('ACCESS_DENIED',403);
  const value=revoke?{...old,status:'REVOKED'}:{...p,loanId:loan._id,status:'ACTIVE',actorId:u.actor._id,actorAuthz:u.actor.authzVersion,actorAuthEpoch:u.actor.authEpoch,credentialVersion:u.actor.credentialVersion,orgEpoch:org!.authEpoch,termsVersion:loan.termsVersion,restoreEpoch:this.management.store.restoreEpoch,restoreBinding:this.identity.database.monthlyRestoreBinding?.()??fail('SERVICE_UNAVAILABLE',503),factorId:u.context.balanceGrant?.factorId??null,nextWakeDate:loan.terms.firstDueDate,leaseOwner:null,leaseUntil:0};
  await this.management.store.put('ms_mandates',{...value,_id:old?._id??loan._id,bookId:u.scope.bookId,ownerId:u.scope.ownerId,domainKind:'BUSINESS',version},u.s);
 }
 receipt(u:MsUnit,key:string,id:string,status:'CONFIRMED'|'PENDING_APPROVAL'|'PROVISIONAL',effectiveDate:string,requestHash:string):Result{
  return{status:200,data:{id,bookId:u.scope.bookId,executionKey:key,requestHash,status,effectiveDate,recordedAt:new Date(this.identity.now()).toISOString(),eventIds:u.eventIds,journalIds:u.journalIds,sourceVector:hash({id,key,events:u.eventIds,journals:u.journalIds})}};
 }
 async prepareNative(u:MsUnit,operation:string,p:Data,params:Record<string,string>){
  if(u.scope.kind!=='BUSINESS')fail('ACCESS_DENIED',403);const loan=await this.loan(u.scope.bookId,params['loanId']!,u.s),ops=this.identity.operations!,book=await ops.books.findOne({_id:u.scope.bookId,organizationId:u.scope.bookId},{session:u.s}),bookTag='"'+u.scope.bookId+':ops:'+(book?.version??0)+'"';let request:Intent;
  if(operation==='msPreviewActivation'){
   if(p['expectedLoanETag']!==etag(loan))fail('PRECONDITION_FAILED',412);
   const funding=await this.account(u,loan.terms.cashAccountId,'ASSET',['CASH','BANK']),versions={} as Profile;
   for(const k of Object.keys(loan.profile) as (keyof Profile)[])versions[k]=etag(await this.account(u,loan.profile[k]));
   request={kind:'DISBURSE',loanId:loan._id,loanETag:etag(loan),fundingAccountETag:etag(funding as Account),accountProfile:loan.profile,accountVersions:versions,effectiveDate:String(p['effectiveDate']),supportReference:loan.terms.supportReference};
  }else{
   const state=await stateOf(this.identity.database,loan,u.s);if(!state)fail('INVALID_STATE');if(p['expectedLoanETag']!==etag(loan))fail('PRECONDITION_FAILED',412);
   if(operation==='msPreviewAccrual')request={kind:'ACCRUE',loanId:loan._id,positionETag:etag(state!.position),throughDate:String(p['throughDate']),effectiveDate:today(this.identity.now()),supportReference:loan.terms.supportReference};
   else request={kind:'APPLY_CREDIT',borrowerId:String(p['borrowerId']),amount:String(p['amount']),creditETag:String(p['expectedCreditETag']),targets:[{loanId:loan._id,positionETag:etag(state!.position),amount:String(p['amount']),mode:'REGULAR'}],effectiveDate:String(p['effectiveDate']),supportReference:String(p['supportReference'])};
  }
  const {actor,org}=await this.identity.lending!.actor(u.context,u.scope.bookId,u.s),planned=await ops.plan(actor,org,request,String(p['executionKey']),bookTag,u.s,this.identity.now());
  const interest=planned.plan.allocations.filter(a=>a.component==='INTEREST').reduce((n,a)=>n+msCents(a.amount),0n),principal=planned.plan.allocations.filter(a=>a.component!=='INTEREST').reduce((n,a)=>n+msCents(a.amount),0n);
  return{planned,request,bookTag,org,view:{postings:planned.plan.postings,interest:format(interest),principal:format(principal),credit:planned.plan.creditChange?.added??'0.00',cashDelta:request.kind==='DISBURSE'?'-'+loan.terms.principal:'0.00',reservedDelta:'0.00',details:planned.plan} satisfies MsPrepared};
 }
 async preview(context:Context,operation:string,p:Data,params:Record<string,string>,expected:string|undefined):Promise<Result>{
  if(operation==='msPreviewHistory')return await previewMsHistory(this,context,p,params,expected);
  return await this.readUnit(context,params['bookId']!,async u=>{
   const tag=await this.tag(u.scope,u.s);if(!expected)fail('ETAG_REQUIRED',428);const header=params['loanId']?etag(await this.loan(u.scope.bookId,params['loanId'],u.s)):tag;if(expected!==header||p['expectedBookETag']!==tag)fail('PRECONDITION_FAILED',412);
   const prepared=operation==='msPreviewHistory'?await prepareMsHistory(this,u,p):['msPreviewDistribution','msPreviewLiabilityPaymentFromFund'].includes(operation)?await prepareMsComposite(this,u,operation,p):(await this.prepareNative(u,operation,p,params)).view;
   const issuedAt=this.identity.now(),requestHash=hash({operation,params,request:p}),q:MsQuote={operation,scopeId:u.scope.bookId,actorBinding:authorityBinding(u.actor,u.context,u.book),sourceTag:tag,params,request:p,executionKey:String(p['executionKey']),requestHash,planHash:economicHash(prepared),issuedAt,expiresAt:issuedAt+300000,date:today(issuedAt)};
   return{status:200,data:{previewToken:encryptMsToken(this.identity,q,'PREVIEW'),requestHash,expiresAt:new Date(q.expiresAt).toISOString(),sourceVector:hash(tag),bookId:u.scope.bookId,status:'READY',reasons:[],postings:prepared.postings,interest:prepared.interest,principal:prepared.principal,credit:prepared.credit,cashDelta:prepared.cashDelta,reservedDelta:prepared.reservedDelta},etag:header};
  });
 }
 async mutate(context:Context,operation:string,input:unknown,params:Record<string,string>,key:string,expected?:string):Promise<Result>{
  monthlyContract().validate('Id',key);monthlyContract().validate(operation,input);const p=canonical(input) as Data;monthlyContract().validate(operation,p);
  if(operation.startsWith('msPreview'))return await this.preview(context,operation,p,params,expected);
  if(operation==='msCommitHistory')return await commitMsHistory(this,context,p,params,key,expected);
  return await this.mutateUnit(context,operation,p,params,key,expected,async u=>{
   if(operation==='msVersionMapping')return await this.setMapping(u,p);
   if(operation==='msCreateMonthlyDraft')return await this.draft(u,p as unknown as MonthlyTerms,key);
   if(operation==='msCreateDebtPlan'){
    if(msCents(String(p['declaredBalance']))<=0n||p['declaredQuota']!==null&&msCents(String(p['declaredQuota']))<=0n)fail('INPUT_INVALID',422);
    const id=msStableId(u.scope.bookId,u.actor._id,operation,key);await this.management.store.put('ms_debt_plans',{_id:id,bookId:u.scope.bookId,ownerId:u.scope.ownerId,domainKind:u.scope.kind,version:1,details:p,status:'INFORMATIONAL_DRAFT'},u.s);
    return{status:200,data:{id,bookId:u.scope.bookId,version:1,status:'INFORMATIONAL_DRAFT',details:p,paymentCoverage:'INCOMPLETE'},etag:etag({_id:id,version:1})};
   }
   const loan=params['loanId']?await this.loan(u.scope.bookId,params['loanId'],u.s):null;
   if(operation==='msVersionMonthlyTerms'){
    const l=loan!;await beginEvidence(this.identity.database,u.s,u.scope.bookId);const {effectiveFrom,...values}=p,proposed=values as unknown as MonthlyTerms;validateMonthlyTerms(proposed);
    let next=l;
    if(l.status==='MONTHLY_DRAFT'){
     if(proposed.borrowerId!==l.borrowerId)fail('INPUT_INVALID',422);const map=await this.mapping(u.scope,u.s,proposed.mappingVersion,proposed.effectiveDate),profile=map['loanProfile'] as Profile|undefined;if(!profile||!(map['cashAccountIds'] as string[]).includes(proposed.cashAccountId))fail('MAPPING_REQUIRED');await this.account(u,proposed.cashAccountId,'ASSET',['CASH','BANK']);
     for(const[k,id]of Object.entries(profile!))await this.account(u,id,k==='interestIncomeAccountId'?'INCOME':k==='borrowerCreditAccountId'?'LIABILITY':'ASSET',['GENERAL']);next={...l,terms:proposed,profile:structuredClone(profile!),termsVersion:l.termsVersion+1,version:l.version+1};
    }
    else{
     if(hash({...proposed,monthlyRate:l.terms.monthlyRate})!==hash(l.terms))fail('IRREGULAR_PERIOD_UNSUPPORTED',422);
     const state=await stateOf(this.identity.database,l,u.s);if(!state?.position.monthlyState)fail('INTEGRITY_MISMATCH',503);
     const updated=versionMonthlyRate(state!.position.monthlyState!,proposed.monthlyRate,String(effectiveFrom),today(this.identity.now()));state!.position.monthlyState=updated;state!.position.termsVersion=l.termsVersion+1;state!.position.version++;
     await this.identity.operations!.positions.replaceOne({_id:l._id,organizationId:u.scope.bookId},state!.position,{session:u.s});next={...l,termsVersion:l.termsVersion+1,version:l.version+1};
    }
    await domainCollection<MonthlyLoan>(this.identity.database,'lending_monthly_loans').replaceOne({_id:l._id,organizationId:u.scope.bookId,version:l.version},next,{session:u.s});u.lendingChanged=true;
    return{status:200,data:{id:next._id,bookId:u.scope.bookId,version:next.version,status:next.status==='MONTHLY_DRAFT'?'DRAFT':'ACTIVE',terms:next.terms},etag:etag(next)};
   }
   if(operation==='msSetMonthlyMandate'||operation==='msRevokeMonthlyMandate'){
    if(p['expectedLoanETag']!==etag(loan!))fail('PRECONDITION_FAILED',412);await this.mandate(u,loan!,p,operation==='msRevokeMonthlyMandate');return this.receipt(u,key,loan!._id,'CONFIRMED',today(this.identity.now()),hash(p));
   }
   const q=this.decodeQuote(p,params,key,u);if(q.operation!==operation.replace('Commit','Preview'))fail('INPUT_INVALID',422);const composite=['msCommitDistribution','msCommitLiabilityPaymentFromFund'].includes(operation),native=composite?null:await this.prepareNative(u,q.operation,q.request,params),prepared=composite?await prepareMsComposite(this,u,q.operation,q.request):native!.view;
   if(economicHash(prepared)!==q.planHash)fail('PRECONDITION_FAILED',412);
   if(['msCommitDistribution','msCommitLiabilityPaymentFromFund'].includes(operation))return await commitMsComposite(this,u,operation,q,key);
   const result=await this.identity.operations!.persist(native!.planned,u.actor,u.scope.bookId,native!.request,key,u.s);u.lendingChanged=true;
   if(native!.request.kind==='APPLY_CREDIT')await this.identity.payments!.recordEconomic(native!.planned,native!.request,null,u.s);
   const data=result.data as {event:{id:string;journalId:string|null}};u.eventIds.push(data.event.id);if(data.event.journalId)u.journalIds.push(data.event.journalId);
   if(operation==='msCommitActivation'&&q.request['mandateConsent']===true){const activeLoan=await this.loan(u.scope.bookId,params['loanId']!,u.s);await this.mandate(u,activeLoan,{consent:true,rateCeiling:activeLoan.terms.monthlyRate,principalCeiling:activeLoan.terms.principal,fromDate:activeLoan.terms.effectiveDate,untilDate:'2199-12-31',supportReference:activeLoan.terms.supportReference,policyVersion:'MS-MONTHLY-0.1.0'});}
   return this.receipt(u,key,data.event.id,'CONFIRMED',native!.request.effectiveDate,q.requestHash);
  });
 }
 decodeQuote(p:Data,params:Record<string,string>,key:string,u:MsUnit):MsQuote{
  const q=decryptMsToken<MsQuote>(this.identity,String(p['previewToken']),'PREVIEW');
  if(q.scopeId!==u.scope.bookId||q.sourceTag!==u.sourceTag||hash(q.params)!==hash(params)||q.actorBinding!==authorityBinding(u.actor,u.context,u.book)||q.executionKey!==key||p['executionKey']!==key||q.requestHash!==p['requestHash']||q.issuedAt>this.identity.now()||q.expiresAt-q.issuedAt!==300000||q.expiresAt<=this.identity.now()||q.date!==today(this.identity.now()))fail('PRECONDITION_FAILED',412);
  return q;
 }
}
const format=(n:bigint)=>(n/100n)+'.'+(n%100n).toString().padStart(2,'0');
