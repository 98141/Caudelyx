/* eslint-disable security/detect-object-injection -- Closed contract/profile keys and server-owned collection tables, not dynamic code or prototype paths. */
import {createHmac,timingSafeEqual,createHash} from 'node:crypto';
import type {ClientSession,Collection} from 'mongodb';
import type {Database} from '../../shared/database.js';
import type {IdentityService} from '../identity/service.js';
import type {Identity,Context} from '../identity/models.js';
import type {Organization} from '../organizations/service.js';
import type {Config} from '../../shared/config.js';
import type {Loan,Result} from './models.js';
import type {Account,Journal} from '../finance/models.js';
import {money,cents,storedCents} from '../finance/money.js';
import {today,etag} from '../finance/service.js';
import {AppError} from '../../shared/errors.js';
import {canonical,hash,uuid} from './contract.js';
import {operationsContract,operationPurpose,operationKinds,isOperation} from './operations-contract.js';
import {domainCollection,beginEvidence,exactHash,type domainCollections} from './evidence-v2.js';
import {recordLendingEvidence} from './integrity.js';
import {recordFinancialEvidence} from '../finance/integrity.js';
import {quoteQuota} from './quota.js';
import {integrityFailure} from './verification.js';
import {operate,positionView,publicInstallment} from './operations-engine.js';
import {installmentFromRow,type Intent,type Book,type Position,type Installment,type Accrual,type Application,type Credit,type Schedule,type Event,type EngineLoan,type Plan,type PublicPosition} from './operations-models.js';
const fail=(status:number,code:string):never=>{throw new AppError(status,code);};
const sum=(xs:string[])=>xs.reduce((s,x)=>s+cents(x),0n);
const profkeys=['principalAccountId','interestReceivableAccountId','interestIncomeAccountId','borrowerCreditAccountId'] as const;
export const operationsPolicy={version:'S05-LOCAL-CO-0.1',usage:'LOCAL_SYNTHETIC',realUseAllowed:false,currency:'COP',previewTTLSeconds:300,quoteTTLSeconds:900,maxTargets:10,actorQuotesPerWindow:30,orgQuotesPerWindow:60,windowSeconds:60,retention:'INDEFINITE',excludedVariants:['REFUND','CROSS_BORROWER','TERM_REDUCTION','MIDPERIOD_EXTRA','ACT','GRACE','FEES','PENALTY','REFINANCE']};
const publicCredit=(c:Credit|undefined|null,id:string)=>({borrowerId:id,version:c?.version??0,balance:c?.balance??'0.00',currency:'COP'});
const publicBook=(b:Book|null,org:string)=>({organizationId:org,version:b?.version??0,profile:b?.profile??null,baseline:b?.baseline??[],currency:'COP'});
const publicEvent=(e:Event)=>{const{_id,...rest}=e;return{id:_id,...rest};};
const publicSchedule=(s:Schedule)=>{const{_id,organizationId,...rest}=s;void _id;void organizationId;return rest;};
const bookETag=(org:string,v:number)=>`"${org}:ops:${v}"`;
const eventKey=(org:string,actor:string,kind:string,key:string)=>{const h=createHash('sha256').update(JSON.stringify([org,actor,kind,key])).digest('hex');return`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
const coll=<T extends {_id:string}>(db:Database,name:typeof domainCollections[number],guarded=true):Collection<T>=>guarded?domainCollection<T>(db,name):db.db.collection<T>(name);

export async function stateOf(db:Database,loan:Loan,session?:ClientSession,guarded=true):Promise<EngineLoan|null>{
  const opts=session?{session}:{},filter={organizationId:loan.organizationId,loanId:loan._id};
  const position=await coll<Position>(db,'loan_positions',guarded).findOne(filter,opts);if(!position)return null;
  const rows=await coll<Installment>(db,'loan_installments',guarded).find(filter,opts).toArray(),accruals=await coll<Accrual>(db,'loan_accruals',guarded).find(filter,opts).toArray(),applications=await coll<Application>(db,'loan_applications',guarded).find(filter,opts).toArray(),versions=await coll<Schedule>(db,'loan_schedule_versions',guarded).find(filter,opts).toArray();
  const compensations=await coll<{_id:string;originalEventId:string}>(db,'loan_compensations',guarded).find({organizationId:loan.organizationId},{...opts}).toArray();
  const effectiveApplications=applications.filter(a=>!compensations.some(c=>c.originalEventId===a.eventId));
  if(position.borrowerId!==loan.borrowerId||position.originalPrincipal!==loan.terms.principal||position.termsVersion!==loan.termsVersion||loan.status!=='TERMS_CONFIRMED'||!versions.some(v=>v.version===position.scheduleVersion))integrityFailure();
  if(cents(position.principalOutstanding)!==cents(position.originalPrincipal)-sum(effectiveApplications.filter(a=>a.component!=='INTEREST').map(a=>a.amount)))integrityFailure();
  if(cents(position.principalOutstanding)!==sum(rows.filter(r=>r.active).map(r=>money(cents(r.principal)-cents(r.principalPaid)))))integrityFailure();
  for(const row of rows){
    const original=versions.find(v=>v.version===row.scheduleVersion)?.futureInstallments.find(r=>r.number===row.number);
    if(!original||['principal','interest','payment','dueDate'].some(k=>original[k as keyof typeof original]!==row[k as keyof Installment]))integrityFailure();
    if(cents(row.principalPaid)!==sum(effectiveApplications.filter(a=>a.scheduleVersion===row.scheduleVersion&&a.installmentNumber===row.number&&a.component==='DUE_PRINCIPAL').map(a=>a.amount))||cents(row.interestPaid)!==sum(effectiveApplications.filter(a=>a.scheduleVersion===row.scheduleVersion&&a.installmentNumber===row.number&&a.component==='INTEREST').map(a=>a.amount)))integrityFailure();
  }
  for(const a of effectiveApplications)if(!rows.some(r=>r.scheduleVersion===a.scheduleVersion&&r.number===a.installmentNumber))integrityFailure();
  for(const a of accruals)if(!rows.some(r=>r.scheduleVersion===a.scheduleVersion&&r.number===a.installmentNumber&&r.interest===a.interest&&r.dueDate===a.dueDate))integrityFailure();
  if(sum(accruals.map(a=>a.interest))<sum(effectiveApplications.filter(a=>a.component==='INTEREST').map(a=>a.amount)))integrityFailure();
  for(const id of new Set([position.fundingEventId,...accruals.map(a=>a.eventId),...effectiveApplications.map(a=>a.eventId)])){
    const event=await coll<Event>(db,'loan_events',guarded).findOne({_id:id,organizationId:loan.organizationId},opts);if(!event||!event.loanIds.includes(loan._id))integrityFailure();
    const journal=event!.journalId?await db.db.collection<Journal>('financial_journals').findOne({_id:event!.journalId,organizationId:loan.organizationId},opts):null;
    if(event!.journalId){if(!journal||journal.source.type!=='LOAN_OPERATION'||journal.source.id!==id||journal.effectiveDate!==event!.effectiveDate||hash(journal.lines.map(l=>({accountId:l.accountId,debit:money(storedCents(l.debit)),credit:money(storedCents(l.credit))})))!==hash(event!.plan.postings))integrityFailure();}
    else if(event!.kind!=='ACCRUE'||event!.plan.postings.length||event!.plan.accruals.some(a=>a.interest!=='0.00'))integrityFailure();
  }
  return{loan,position,rows,accruals,applications:effectiveApplications};
}
interface Claims {org:string;actor:string;kind:string;key:string;requestHash:string;bookETag:string;dependencies:string;planHash:string;issuedAt:number;expiresAt:number;policy:string}
interface Replay {_id:string;organizationId:string;actorId:string;purpose:string;key:string;fingerprint:string;result:Result}
interface Planning {plan:Plan;states:EngineLoan[];before:EngineLoan[];book:Book|null;newBook:Book|null;credit:Credit|null;borrowerId:string;dependencies:string;eventId:string}
export class OperationsService {
  readonly books;readonly positions;readonly rows;readonly accruals;readonly applications;readonly credits;readonly schedules;readonly events;readonly idempotency;
  constructor(readonly identity:IdentityService,private readonly signingKey:Buffer,readonly config:Config){
    const uri=new URL(config.mongoUri),origin=new URL(config.tenantOrigin);
    if(!['localhost','127.0.0.1','[::1]'].includes(uri.hostname)||uri.protocol!=='mongodb:'||origin.protocol!=='https:'||origin.hostname!=='localhost')throw Error('Operations require existing local synthetic runtime');
    const db=identity.database;this.books=coll<Book>(db,'loan_operation_books');this.positions=coll<Position>(db,'loan_positions');this.rows=coll<Installment>(db,'loan_installments');this.accruals=coll<Accrual>(db,'loan_accruals');this.applications=coll<Application>(db,'loan_applications');this.credits=coll<Credit>(db,'borrower_credits');this.schedules=coll<Schedule>(db,'loan_schedule_versions');this.events=coll<Event>(db,'loan_events');this.idempotency=coll<Replay>(db,'loan_operation_idempotency');
  }
  async initialize(){
    operationsContract();
    await this.positions.createIndex({organizationId:1,loanId:1},{unique:true});
    await this.rows.createIndex({organizationId:1,loanId:1,scheduleVersion:1,number:1},{unique:true});
    await this.accruals.createIndex({organizationId:1,loanId:1,scheduleVersion:1,installmentNumber:1},{unique:true});
    await this.schedules.createIndex({organizationId:1,loanId:1,version:1},{unique:true});
    await this.events.createIndex({organizationId:1,receiptReference:1},{unique:true,partialFilterExpression:{receiptReference:{$type:'string'}}});
    await this.events.createIndex({organizationId:1,loanIds:1,kind:1},{unique:true,partialFilterExpression:{kind:'DISBURSE'}});
    await this.idempotency.createIndex({organizationId:1,actorId:1,purpose:1,key:1},{unique:true});
    await this.identity.database.db.collection('lending_rate_windows').createIndex({expiresAt:1},{expireAfterSeconds:0});
  }
  private signed(value:unknown){const body=Buffer.from(JSON.stringify(value)).toString('base64url');return body+'.'+createHmac('sha256',this.signingKey).update('S05:'+body).digest('base64url');}
  private decoded<T>(token:string):T{
    try{const[body,signature,...extra]=token.split('.');if(!body||!signature||extra.length)throw Error('token');const expected=createHmac('sha256',this.signingKey).update('S05:'+body).digest(),actual=Buffer.from(signature,'base64url');if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error('token');return JSON.parse(Buffer.from(body,'base64url').toString('utf8')) as T;}catch{return fail(422,'INPUT_INVALID');}
  }
  async snapshot(purpose:string,resourceId:string|null,actor:Identity,session:ClientSession,command?:Record<string,unknown>|null){
    if(!isOperation(purpose)||!command)fail(422,'INPUT_INVALID');operationsContract().intent(purpose,resourceId,command);
    const org=uuid(command!['organizationId']);if(actor.organizationId!==org)fail(404,'RESOURCE_NOT_FOUND');if(actor.realm!=='TENANT'||!actor.roles.includes('T')||actor.roles.includes('SA')||actor.suspended)fail(403,'ACCESS_DENIED');
    const organization=await this.identity.database.db.collection<Organization>('organizations').findOne({_id:org,status:'ACTIVE'},{session});if(!organization)fail(403,'ACCESS_DENIED');
    const request=(command!['payload'] as {request:Intent}).request,id=request.kind==='DISBURSE'||request.kind==='ACCRUE'?request.loanId:request.borrowerId;if(id!==resourceId)fail(422,'INPUT_INVALID');
    if(request.kind==='DISBURSE'||request.kind==='ACCRUE')await this.identity.lending!.loans.findOne({_id:id,organizationId:org},{session}).then(l=>{if(!l)fail(404,'RESOURCE_NOT_FOUND');});else await this.borrower(id,org,session);
    return hash({purpose,resourceId,command,actorId:actor._id,authz:actor.authzVersion,authEpoch:actor.authEpoch,credentialVersion:actor.credentialVersion,organizationEpoch:organization!.authEpoch});
  }
  private async borrower(id:string,org:string,s:ClientSession){return await this.identity.lending!.borrowers.findOne({_id:id,organizationId:org,ownerId:org},{session:s})??fail(404,'RESOURCE_NOT_FOUND');}
  private async account(id:string,org:string,s:ClientSession,external:Map<string,string>,className?:Account['accountClass'],kind?:'GENERAL'|'CASH_BANK'){
    const a=await this.identity.finance!.accounts.findOne({_id:id,organizationId:org,bookId:org,ownerId:org,financialScope:'BUSINESS'},{session:s});if(!a)fail(404,'RESOURCE_NOT_FOUND');
    if(a!.status!=='ACTIVE'||a!.currency!=='COP'||className&&a!.accountClass!==className||kind==='GENERAL'&&a!.kind!=='GENERAL'||kind==='CASH_BANK'&&!['CASH','BANK'].includes(a!.kind))fail(422,'ACCOUNT_INELIGIBLE');external.set('account:'+id,exactHash(a));return a!;
  }
  private expected(actual:string,expected:string|undefined){if(!expected)fail(428,'ETAG_REQUIRED');if(actual!==expected)fail(412,'PRECONDITION_FAILED');}
  private async ledger(org:string,s:ClientSession){
    const totals=new Map<string,bigint>();for await(const j of this.identity.finance!.journals.find({organizationId:org},{session:s}))for(const l of j.lines)totals.set(l.accountId,(totals.get(l.accountId)??0n)+storedCents(l.debit)-storedCents(l.credit));return totals;
  }
  async plan(actor:Identity,org:Organization,intent:Intent,key:string,expectedBook:string,s:ClientSession,issuedAt:number):Promise<Planning>{
    const db=this.identity.database,unit=await beginEvidence(db,s,org._id),book=await this.books.findOne({_id:org._id,organizationId:org._id},{session:s});this.expected(bookETag(org._id,book?.version??0),expectedBook);
    const financialBook=await db.db.collection<{_id:string;value:number;recordedAt:number;openingId?:string;cutoffDate?:string}>('financial_books').findOne({_id:org._id},{session:s});
    if(financialBook?.openingId&&(!financialBook.cutoffDate||intent.effectiveDate<=financialBook.cutoffDate))fail(409,'OPENING_CUTOFF_CONFLICT');
    if(intent.effectiveDate!==today(this.identity.now()))fail(422,'INPUT_INVALID');
    if(await this.identity.finance!.journals.findOne({organizationId:org._id,effectiveDate:{$gt:intent.effectiveDate}},{session:s}))fail(409,'LATER_JOURNAL_CONFLICT');
    const external=new Map<string,string>([['financialBook',exactHash(financialBook)],['authority',hash({actor:actor._id,authz:actor.authzVersion,authEpoch:actor.authEpoch,credentials:actor.credentialVersion,org:org.authEpoch,policy:operationsPolicy.version})]]);
    const at=new Date(issuedAt).toISOString(),id=eventKey(org._id,actor._id,intent.kind,key),loans=intent.kind==='DISBURSE'||intent.kind==='ACCRUE'?[intent.loanId]:intent.targets.map(t=>t.loanId);
    if(new Set(loans).size!==loans.length)fail(422,'INPUT_INVALID');
    const before:EngineLoan[]=[],borrowers=new Map<string,{id:string;code:string;name:string}>();let borrowerId='',newBook:Book|null=null,credit:Credit|null=null;
    let plan:Plan={postings:[],allocations:[],accruals:[],scheduleRevisions:[],positions:[],creditChange:null},states:EngineLoan[]=[];
    for(const loanId of loans){
      const loan=await this.identity.lending!.verifiedLoan(loanId,org._id,s),b=await this.borrower(loan.borrowerId,org._id,s);
      borrowerId ||=loan.borrowerId;if(borrowerId!==loan.borrowerId||'borrowerId'in intent&&intent.borrowerId!==loan.borrowerId)fail(422,'INPUT_INVALID');
      borrowers.set(b._id,{id:b._id,code:b.borrowerCode,name:b.profile.displayName});
      const old=await stateOf(db,loan,s);
      if(intent.kind==='DISBURSE'){
        if(old)fail(409,'ALREADY_DISBURSED');if(loan.status!=='TERMS_CONFIRMED')fail(409,'STATE_CONFLICT');this.expected(etag(loan),intent.loanETag);if(b.status!=='ACTIVE')fail(422,'INPUT_INVALID');
        const q=await this.identity.lending!.quotes.findOne({_id:loan.quoteId,organizationId:org._id},{session:s});if(!q)integrityFailure();
        const schema=await this.identity.lending!.schemas.findOne({organizationId:org._id},{session:s,sort:{schemaVersion:-1}}),funding=await this.account(loan.terms.plannedFundingAccountId,org._id,s,external,'ASSET','CASH_BANK');
        this.expected(etag(funding),intent.fundingAccountETag);
        if(loan.terms.usage!=='LOCAL_SYNTHETIC')fail(403,'REAL_USE_NOT_ALLOWED');
        if(q!.dependencies.borrowerVersion!==b.version||q!.dependencies.profileVersion!==b.profileVersion||q!.dependencies.schemaVersion!==(schema?.schemaVersion??1)||q!.dependencies.fundingAccountVersion!==funding.version||q!.dependencies.policyVersion!=='S04-LOCAL-CO-0.1')fail(409,'TERMS_STALE');
        if(new Set(Object.values(intent.accountProfile)).size!==4)fail(422,'ACCOUNT_INELIGIBLE');
        const heldProfile=await domainCollection<{_id:string;accountId:string}>(db,'held_funds_profiles').findOne({organizationId:org._id},{session:s});if(heldProfile&&Object.values(intent.accountProfile).includes(heldProfile.accountId))fail(409,'ACCOUNT_PROFILE_CONFLICT');
        if(book&&hash(book.profile)!==hash(intent.accountProfile))fail(409,'ACCOUNT_PROFILE_CONFLICT');
        for(const k of profkeys){const a=await this.account(intent.accountProfile[k],org._id,s,external,k==='interestIncomeAccountId'?'INCOME':k==='borrowerCreditAccountId'?'LIABILITY':'ASSET','GENERAL');this.expected(etag(a),intent.accountVersions[k]);}
        const balances=await this.ledger(org._id,s);if((balances.get(funding._id)??0n)<cents(loan.terms.principal))fail(409,'ACCOUNT_OVERDRAFT');
        if(!book)newBook={_id:org._id,organizationId:org._id,version:0,profile:intent.accountProfile,currency:'COP',createdAt:at,baseline:profkeys.map(k=>{const value=balances.get(intent.accountProfile[k])??0n;return{accountId:intent.accountProfile[k],debit:value>=0n?money(value):'0.00',credit:value<0n?money(-value):'0.00'};})};
        const position:Position={_id:loanId,organizationId:org._id,loanId,borrowerId,version:1,termsVersion:loan.termsVersion,scheduleVersion:1,status:'ACTIVE',originalPrincipal:loan.terms.principal,principalOutstanding:loan.terms.principal,fundingEventId:id,createdAt:at};
        const state:EngineLoan={loan,position,rows:loan.calculation.schedule.map(r=>installmentFromRow(r,loanId,org._id,1,at)),accruals:[],applications:[]};states=[state];
        plan={...plan,postings:[{accountId:intent.accountProfile.principalAccountId,debit:loan.terms.principal,credit:'0.00'},{accountId:funding._id,debit:'0.00',credit:loan.terms.principal}].sort((a,b)=>a.accountId.localeCompare(b.accountId)),scheduleRevisions:[{loanId,version:1,parentVersion:null,originTermsVersion:loan.termsVersion,eventId:id,reason:'ORIGINAL',createdAt:at,remainingPrincipal:loan.terms.principal,futureInstallments:state.rows.map(r=>publicInstallment(r,intent.effectiveDate))}],positions:[positionView(state,borrowers.get(borrowerId)!,intent.effectiveDate)]};
      }else{
        if(!old||old.position.status!=='ACTIVE')fail(409,'STATE_CONFLICT');const expected=intent.kind==='ACCRUE'?intent.positionETag:intent.targets.find(t=>t.loanId===loanId)!.positionETag;this.expected(etag(old!.position),expected);before.push(old!);
      }
    }
    if(intent.kind!=='DISBURSE'){
      if(!book)integrityFailure();for(const k of profkeys)await this.account(book!.profile[k],org._id,s,external,k==='interestIncomeAccountId'?'INCOME':k==='borrowerCreditAccountId'?'LIABILITY':'ASSET','GENERAL');
      credit=await this.credits.findOne({_id:borrowerId,organizationId:org._id},{session:s});
      if(intent.kind==='ACCRUE'&&intent.throughDate>intent.effectiveDate)fail(422,'INPUT_INVALID');
      if(intent.kind==='RECEIPT'){const account=await this.account(intent.destinationAccountId,org._id,s,external,'ASSET','CASH_BANK');this.expected(etag(account),intent.destinationAccountETag);if(await this.events.findOne({organizationId:org._id,receiptReference:intent.receiptReference},{session:s}))fail(409,'RECEIPT_REFERENCE_CONFLICT');}
      if(intent.kind==='APPLY_CREDIT')this.expected(`"${borrowerId}:${credit?.version??0}"`,intent.creditETag);
      const result=operate(intent,before,book!.profile,credit?.balance??'0.00',borrowers,id,at);plan=result.plan;states=result.states;
    }
    const dependencies=hash({readSet:[...unit.readSet].sort(([a],[b])=>a.localeCompare(b)),external:[...external].sort(([a],[b])=>a.localeCompare(b)),date:intent.effectiveDate});return{plan,states,before,book,newBook,credit,borrowerId,dependencies,eventId:id};
  }
  async preview(context:Context,organization:string,input:unknown):Promise<Result>{
    operationsContract().validate('PreviewRequest',input);const p=canonical(input) as {executionKey:string;expectedBookETag:string;request:Intent};operationsContract().validate('PreviewRequest',p);if(p.request.kind==='RECEIPT'&&this.identity.payments)fail(409,'PAYMENT_FLOW_REQUIRED');
    return await this.identity.database.transaction(async s=>{
      const {actor,org}=await this.identity.lending!.actor(context,uuid(organization),s),issuedAt=this.identity.now(),result=await this.plan(actor,org,p.request,p.executionKey,p.expectedBookETag,s,issuedAt);
      await quoteQuota(this.identity,actor._id,org._id,s);
      const claims:Claims={org:org._id,actor:actor._id,kind:p.request.kind,key:p.executionKey,requestHash:hash(p.request),bookETag:p.expectedBookETag,dependencies:result.dependencies,planHash:hash(result.plan),issuedAt,expiresAt:issuedAt+300000,policy:operationsPolicy.version};
      return{status:200,data:{previewToken:this.signed(claims),expiresAt:new Date(claims.expiresAt).toISOString(),fingerprint:claims.planHash,policyVersion:operationsPolicy.version,request:p.request,expectedBookETag:p.expectedBookETag,fundingAccountId:p.request.kind==='DISBURSE'?result.states[0]!.loan.terms.plannedFundingAccountId:null,plan:result.plan,realUseAllowed:false}};
    });
  }
  async mutate(context:Context,operation:string,organization:string,input:unknown,keyValue:unknown,ifMatch?:string):Promise<Result>{
    const purpose=operationPurpose.get(operation);if(!purpose)fail(422,'INPUT_INVALID');operationsContract().validate(operation,input);
    const payload=canonical(input) as {previewToken:string;request:Intent};operationsContract().validate(operation,payload);
    const orgId=uuid(organization),key=uuid(keyValue),id=payload.request.kind==='DISBURSE'||payload.request.kind==='ACCRUE'?payload.request.loanId:payload.request.borrowerId;
    if(!ifMatch)fail(428,'ETAG_REQUIRED');
    const command={organizationId:orgId,idempotencyKey:key,payload,expectedETag:ifMatch},fingerprint=hash({purpose,id,command});
    try{return await this.identity.database.transaction(async s=>{
      const {actor,org}=await this.identity.lending!.actor(context,orgId,s);await beginEvidence(this.identity.database,s,orgId);
      try{await this.identity.sessions.consumeProof(context,purpose!,id,s,command);}catch(e){if(e instanceof AppError&&e.code==='REAUTH_REQUIRED')fail(403,'R_REQUIRED');throw e;}
      const previous=await this.idempotency.findOne({organizationId:orgId,actorId:actor._id,purpose:purpose!,key},{session:s});
      if(previous){if(previous.fingerprint!==fingerprint)fail(409,'IDEMPOTENCY_CONFLICT');await this.identity.audit.append({realm:'TENANT',actorId:actor._id,subjectId:actor._id,action:'LOAN_OPERATION_REPLAY',outcome:'SUCCESS',lending:{operation,id,version:null}},s);return{...previous.result,status:200};}
      if(payload.request.kind==='RECEIPT'&&this.identity.payments)fail(409,'PAYMENT_FLOW_REQUIRED');
      const claims=this.decoded<Claims>(payload.previewToken);
      if(claims.org!==orgId||claims.actor!==actor._id||claims.kind!==operationKinds.get(operation)||claims.kind!==payload.request.kind||claims.key!==key||claims.requestHash!==hash(payload.request)||claims.bookETag!==ifMatch)fail(409,'PREVIEW_STALE');
      if(claims.policy!==operationsPolicy.version)fail(409,'POLICY_CHANGED');if(this.identity.now()>=claims.expiresAt||claims.issuedAt>this.identity.now()||claims.expiresAt-claims.issuedAt!==300000)fail(409,'PREVIEW_EXPIRED');
      const planned=await this.plan(actor,org,payload.request,key,ifMatch!,s,claims.issuedAt);
      if(planned.dependencies!==claims.dependencies||hash(planned.plan)!==claims.planHash)fail(409,'PREVIEW_STALE');
      const result=await this.persist(planned,actor,orgId,payload.request,key,s);
      if(payload.request.kind==='APPLY_CREDIT')await this.identity.payments?.recordEconomic(planned,payload.request,null,s);
      operationsContract().result(operation,result.status,{data:result.data,requestId:key});
      await this.idempotency.insertOne({_id:planned.eventId,organizationId:orgId,actorId:actor._id,purpose:purpose!,key,fingerprint,result},{session:s});
      // Real writes fence authority rows as well as the global security fence: an
      // out-of-band revocation racing this snapshot causes a write conflict/retry.
      const authority=await this.identity.database.db.collection<{_id:string;authzVersion:string;authEpoch:string;credentialVersion:string;suspended:boolean;operationCommandFence?:number}>('identities').updateOne({_id:actor._id,authzVersion:actor.authzVersion,authEpoch:actor.authEpoch,credentialVersion:actor.credentialVersion,suspended:false},{$inc:{operationCommandFence:1}},{session:s});
      const tenant=await this.identity.database.db.collection<{_id:string;status:string;authEpoch:string;operationCommandFence?:number}>('organizations').updateOne({_id:orgId,status:'ACTIVE',authEpoch:org.authEpoch},{$inc:{operationCommandFence:1}},{session:s});
      if(authority.matchedCount!==1||tenant.matchedCount!==1)fail(403,'ACCESS_DENIED');
      await recordLendingEvidence(this.identity.database,s);
      await this.identity.audit.append({realm:'TENANT',actorId:actor._id,subjectId:actor._id,action:purpose!,outcome:'SUCCESS',lending:{operation,id:planned.eventId,version:(result.data as {bookVersion:number}).bookVersion}},s);
      return result;
    });}catch(e){if(e&&typeof e==='object'&&'code'in e&&e.code===11000)fail(409,'SOURCE_CONFLICT');throw e;}
  }
  async persist(planned:Planning,actor:Identity,orgId:string,request:Intent,key:string,s:ClientSession):Promise<Result>{
      const at=new Date(this.identity.now()).toISOString(),book=planned.book??planned.newBook!;
      // Persist only deltas; all existing values were proved against their committed leaves.
      for(const state of planned.states){
        const old=planned.before.find(x=>x.loan._id===state.loan._id);
        if(old){const updated=await this.positions.replaceOne({_id:state.position._id,organizationId:orgId,version:old.position.version},state.position,{session:s});if(updated.matchedCount!==1)fail(412,'PRECONDITION_FAILED');}
        else await this.positions.insertOne(state.position,{session:s});
        for(const row of state.rows){const before=old?.rows.find(r=>r._id===row._id);if(before&&hash(before)===hash(row))continue;if(before)await this.rows.replaceOne({_id:row._id,organizationId:orgId},row,{session:s});else await this.rows.insertOne(row,{session:s});}
        for(const accrual of state.accruals)if(!old?.accruals.some(a=>a._id===accrual._id))await this.accruals.insertOne(accrual,{session:s});
        for(const app of state.applications)if(!old?.applications.some(a=>a._id===app._id))await this.applications.insertOne(app,{session:s});
      }
      for(const revision of planned.plan.scheduleRevisions)await this.schedules.insertOne({_id:`${revision.loanId}:${revision.version}`,organizationId:orgId,...revision},{session:s});
      if(planned.plan.creditChange){const change=planned.plan.creditChange,c:Credit={_id:change.borrowerId,organizationId:orgId,borrowerId:change.borrowerId,version:(planned.credit?.version??0)+1,balance:change.after,currency:'COP',createdAt:planned.credit?.createdAt??at};if(planned.credit)await this.credits.replaceOne({_id:c._id,version:planned.credit.version},c,{session:s});else await this.credits.insertOne(c,{session:s});}
      let journalId:string|null=null;
      if(planned.plan.postings.length){const journal=await this.identity.finance!.postOperation(orgId,planned.eventId,request.effectiveDate,planned.plan.postings,request.supportReference,s);journalId=journal._id;await recordFinancialEvidence(this.identity.database,s);}
      else if(request.kind!=='ACCRUE'||planned.plan.accruals.some(a=>a.interest!=='0.00'))integrityFailure();
      const event:Event={_id:planned.eventId,organizationId:orgId,borrowerId:planned.borrowerId,actorId:actor._id,kind:request.kind,status:'CONFIRMED',effectiveDate:request.effectiveDate,recordedAt:at,journalId,idempotencyKey:key,policyVersion:'S05-LOCAL-CO-0.1',supportReference:request.supportReference,receiptReference:request.kind==='RECEIPT'?request.receiptReference:null,loanIds:planned.states.map(x=>x.loan._id),plan:planned.plan};
      await this.events.insertOne(event,{session:s});book.version++;
      if(planned.book)await this.books.replaceOne({_id:orgId,version:planned.book.version-1},book,{session:s});else await this.books.insertOne(book,{session:s});
      const result:Result={status:201,data:{event:publicEvent(event),bookVersion:book.version},etag:bookETag(orgId,book.version)};
      return result;
  }
  async read(context:Context,operation:string,organization:string,id?:string,query:Record<string,unknown>={}):Promise<Result>{
    const orgId=uuid(organization);
    return await this.identity.database.transaction(async s=>{
      const {actor,org}=await this.identity.lending!.actor(context,orgId,s),date=today(this.identity.now());await beginEvidence(this.identity.database,s,orgId);
      if(operation==='getLoanOperationsPolicy')return{status:200,data:operationsPolicy};
      if(operation==='getLoanOperationsBook'){const b=await this.books.findOne({_id:orgId,organizationId:orgId},{session:s});return{status:200,data:publicBook(b,orgId),etag:bookETag(orgId,b?.version??0)};}
      if(operation==='getBorrowerCredit'){await this.borrower(uuid(id),orgId,s);const c=await this.credits.findOne({_id:id!,organizationId:orgId},{session:s});return{status:200,data:publicCredit(c,id!),etag:`"${id}:${c?.version??0}"`};}
      if(operation==='getLoanEvent'){const e=await this.events.findOne({_id:uuid(id),organizationId:orgId},{session:s});if(!e)fail(404,'RESOURCE_NOT_FOUND');return{status:200,data:publicEvent(e!)};}
      if(operation==='getLoanCommandResult'){const rows=await this.idempotency.find({organizationId:orgId,actorId:actor._id,key:uuid(id)},{session:s}).limit(2).toArray();if(!rows.length)fail(404,'RESOURCE_NOT_FOUND');if(rows.length>1)fail(409,'STATE_CONFLICT');return{...rows[0]!.result,status:200};}
      const view=async(l:Loan):Promise<PublicPosition>=>{
        const b=await this.borrower(l.borrowerId,orgId,s),label={id:b._id,code:b.borrowerCode,name:b.profile.displayName},state=await stateOf(this.identity.database,l,s);
        return state?positionView(state,label,date):{loanId:l._id,borrower:label,currency:'COP',version:0,termsVersion:l.termsVersion,scheduleVersion:0,termsStatus:l.status,status:'NOT_DISBURSED',statusLabel:'Sin desembolso',originalPrincipal:l.terms.principal,principalOutstanding:'0.00',duePrincipal:'0.00',originalExpectedInterest:l.calculation.totals.interest,expectedFutureInterest:'0.00',dueUnrecognizedInterest:'0.00',accruedInterestTotal:'0.00',collectedInterestTotal:'0.00',accruedOutstandingInterest:'0.00'};
      };
      if(operation==='getLoanPosition'){const l=await this.identity.lending!.verifiedLoan(uuid(id),orgId,s),p=await view(l);return{status:200,data:p,etag:`"${l._id}:${p.version}"`};}
      const limit=query['limit']===undefined?20:Number(query['limit']);if(!Number.isInteger(limit)||limit<1||limit>100)fail(422,'INPUT_INVALID');
      const binding=hash({actor:actor._id,authz:actor.authzVersion,org:orgId,epoch:org.authEpoch,operation,id:id??null,limit,borrower:query['borrowerId']??null,status:query['status']??null});
      const incoming=query['cursor']?this.decoded<{binding:string;cut:string;last:string}>(String(query['cursor'])):null;if(incoming&&incoming.binding!==binding)fail(422,'INPUT_INVALID');const cut=incoming?.cut??new Date(this.identity.now()).toISOString();
      let items:unknown[]=[],keys:string[]=[];
      if(operation==='listLoanPositions'){
        const loans=await this.identity.lending!.loans.find({organizationId:orgId,...(query['borrowerId']?{borrowerId:uuid(query['borrowerId'])}:{})},{session:s}).sort({createdAt:1,_id:1}).toArray();
        for(const l of loans){const key=l.createdAt+'|'+l._id;if(l.createdAt>cut||incoming&&key<=incoming.last)continue;const p=await view(l);if(query['status']&&p.status!==query['status'])continue;items.push(p);keys.push(key);if(items.length>limit)break;}
      }else if(operation==='listLoanEvents'){
        const events=await this.events.find({organizationId:orgId,recordedAt:{$lte:cut}},{session:s}).sort({recordedAt:1,_id:1}).toArray();for(const e of events){const k=e.recordedAt+'|'+e._id;if(incoming&&k<=incoming.last)continue;items.push(publicEvent(e));keys.push(k);if(items.length>limit)break;}
      }else{
        const loan=await this.identity.lending!.verifiedLoan(uuid(id),orgId,s);
        if(operation==='listLoanInstallments'){
          const rows=await this.rows.find({organizationId:orgId,loanId:loan._id,active:true},{session:s}).sort({number:1,_id:1}).toArray();for(const r of rows){const k=String(r.number).padStart(6,'0')+'|'+r._id;if(incoming&&k<=incoming.last)continue;items.push(publicInstallment(r,date));keys.push(k);if(items.length>limit)break;}
        }else if(operation==='listLoanScheduleVersions'){
          const versions=await this.schedules.find({organizationId:orgId,loanId:loan._id},{session:s}).sort({version:1,_id:1}).toArray();for(const v of versions){const k=String(v.version).padStart(6,'0')+'|'+v._id;if(incoming&&k<=incoming.last)continue;items.push(publicSchedule(v));keys.push(k);if(items.length>limit)break;}
        }else fail(422,'INPUT_INVALID');
      }
      const more=items.length>limit;items=items.slice(0,limit);keys=keys.slice(0,limit);return{status:200,data:{items,nextCursor:more?this.signed({binding,cut,last:keys.at(-1)}):null}};
    });
  }
}

export async function operationsEvidenceMatches(database:Database):Promise<boolean>{
  try{
    const books=await database.db.collection<Book>('loan_operation_books').find().toArray();
    for(const book of books){
      const org=book.organizationId,events=await database.db.collection<Event>('loan_events').find({organizationId:org}).toArray(),positions=await database.db.collection<Position>('loan_positions').find({organizationId:org}).toArray(),credits=await database.db.collection<Credit>('borrower_credits').find({organizationId:org}).toArray();
      const compensations=await database.db.collection<{_id:string;originalEventId:string;creditDelta:string;journalId:string}>('loan_compensations').find({organizationId:org}).toArray();
      if(book.version!==events.length+compensations.length||new Set(Object.values(book.profile)).size!==4)return false;
      for(const p of positions){const loan=await database.db.collection<Loan>('lending_loans').findOne({_id:p.loanId,organizationId:org});if(!loan||!await stateOf(database,loan,undefined,false))return false;}
      if(events.some(e=>e.loanIds.some(id=>!positions.some(p=>p.loanId===id))))return false;
      const allApplications=await database.db.collection<Application>('loan_applications').find({organizationId:org}).toArray(),applications=allApplications.filter(a=>!compensations.some(c=>c.originalEventId===a.eventId)),accruals=await database.db.collection<Accrual>('loan_accruals').find({organizationId:org}).toArray();
      for(const e of events){if(hash(allApplications.filter(a=>a.eventId===e._id).map(({_id,organizationId,eventId,createdAt,...a})=>{void _id;void organizationId;void eventId;void createdAt;return hash(a);}).sort())!==hash(e.plan.allocations.map(a=>hash(a)).sort()))return false;}
      for(const c of credits){const relevant=events.filter(e=>e.plan.creditChange?.borrowerId===c.borrowerId);if(cents(c.balance)!==relevant.reduce((n,e)=>n+cents(e.plan.creditChange!.added)-cents(e.plan.creditChange!.applied),0n)+compensations.filter(x=>relevant.some(e=>e._id===x.originalEventId)).reduce((n,x)=>n+(x.creditDelta.startsWith('-')?-cents(x.creditDelta.slice(1)):cents(x.creditDelta)),0n)||c.version!==relevant.length+compensations.filter(x=>relevant.some(e=>e._id===x.originalEventId)).length)return false;}
      const totals=new Map<string,bigint>();for await(const j of database.db.collection<Journal>('financial_journals').find({organizationId:org})){
        if(j.source.type==='LOAN_OPERATION'&&!events.some(e=>e._id===j.source.id&&e.journalId===j._id))return false;
        for(const l of j.lines)totals.set(l.accountId,(totals.get(l.accountId)??0n)+storedCents(l.debit)-storedCents(l.credit));
      }
      const baseline=(id:string)=>{const l=book.baseline.find(l=>l.accountId===id);return l?cents(l.debit)-cents(l.credit):0n;};
      const expected=new Map([[book.profile.principalAccountId,sum(positions.map(p=>p.principalOutstanding))],[book.profile.interestReceivableAccountId,sum(accruals.map(a=>a.interest))-sum(applications.filter(a=>a.component==='INTEREST').map(a=>a.amount))],[book.profile.interestIncomeAccountId,-sum(accruals.map(a=>a.interest))],[book.profile.borrowerCreditAccountId,-sum(credits.map(c=>c.balance))]]);
      for(const[id,value]of expected)if((totals.get(id)??0n)!==baseline(id)+value)return false;
    }
    for(const c of ['loan_positions','loan_installments','loan_schedule_versions','loan_accruals','loan_applications','borrower_credits','loan_events','loan_operation_idempotency'])for await(const r of database.db.collection(c).find())if(!books.some(b=>b.organizationId===r['organizationId']))return false;
    return true;
  }catch{return false;}
}
