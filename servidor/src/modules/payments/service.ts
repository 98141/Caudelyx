/* eslint-disable security/detect-object-injection -- Validated closed DTOs and fixed server collection/field maps. */
import {createHmac,timingSafeEqual,createHash} from 'node:crypto';
import type {ClientSession,Collection} from 'mongodb';
import type {IdentityService} from '../identity/service.js';
import type {Identity,Context} from '../identity/models.js';
import type {Organization} from '../organizations/service.js';
import type {Config} from '../../shared/config.js';
import {AppError} from '../../shared/errors.js';
import {canonical,hash,uuid} from '../lending/contract.js';
import {beginEvidence,domainCollection} from '../lending/evidence-v2.js';
import {recordLendingEvidence} from '../lending/integrity.js';
import {stateOf} from '../lending/operations-service.js';
import {positionView} from '../lending/operations-engine.js';
import {quoteQuota} from '../lending/quota.js';
import {today,etag} from '../finance/service.js';
import {cents,money} from '../finance/money.js';
import type {Result} from '../finance/models.js';
import {paymentCollections,type PaymentCollection,type Row,type Payment,type PaymentIntent} from './models.js';
import {paymentContract,isPaymentPurpose} from './contract.js';
import {PaymentEconomics} from './economic.js';
const fail=(code:string,status=409):never=>{throw new AppError(status,code);};
const policy={version:'S06-LOCAL-CO-0.1' as const,usage:'LOCAL_SYNTHETIC',realUseAllowed:false,currency:'COP',previewTTLSeconds:300,maxTargets:10,retention:'INDEFINITE',directRoles:['T'],registerRoles:['T','O','C'],approveRoles:['T','P'],segregation:'SUPERVISED_DIFFERENT_ACTOR',reversalKinds:['RECEIPT','APPLY_CREDIT'],reconciliationCardinality:'ONE_TO_ONE',fileUploads:false};
const fields=['registrarId','intent','approvalMode','status','approvalState','approvalOrigin','reconciliationState','custodyState','heldFundsState','decidedBy','eventId','reversalEventId','observedDate','effectiveDate','recordedAt','policyVersion','currentReconciliationLinkId','reversalRequestId'] as const;
const publicPayment=(p:Payment)=>({id:p._id,organizationId:p.organizationId,version:p.version,...Object.fromEntries(fields.map(k=>[k,p[k]]))});
const projection=(r:Row,keys:string[])=>({id:r._id,...Object.fromEntries(keys.map(k=>[k,r[k]])),version:r.version});
const stableId=(...parts:string[])=>{const h=createHash('sha256').update(JSON.stringify(parts)).digest('hex');return`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
interface Claims {org:string;actor:string;key:string;issued:number;expires:number;command:Record<string,unknown>;paymentsETag:string;operationsETag:string;fingerprint:string}
export class PaymentsService {
 readonly economic:PaymentEconomics;
 constructor(readonly identity:IdentityService,private readonly key:Buffer,readonly config:Config){this.economic=new PaymentEconomics(identity);}
 collection<T extends {_id:string}=Row>(name:PaymentCollection):Collection<T>{return domainCollection<T>(this.identity.database,name);}
 async initialize(){
  paymentContract();
  for(const name of paymentCollections)await this.collection(name).createIndex({organizationId:1,_id:1},{name:'lending_domain_org'});
  for(const[name,keys,options]of [
   ['payments',{organizationId:1,'intent.receiptReference':1},{}],
   ['payment_commands',{organizationId:1,actorId:1,purpose:1,key:1},{}],
   ['cash_custody',{organizationId:1,paymentId:1},{}],
   ['custody_bindings',{organizationId:1,accountId:1},{}],
   ['payment_registration_scopes',{organizationId:1,registrarId:1,loanId:1},{}],
   ['loan_compensations',{organizationId:1,originalEventId:1},{}],
   ['bank_declarations',{organizationId:1,accountId:1,statementReference:1,lineReference:1},{}],
   ['bank_declarations',{organizationId:1,contentHash:1},{}],
  ] as const)await this.collection(name).createIndex(keys,{unique:true,...options});
 }
 async actor(context:Context,org:string,s:ClientSession){
  const valid=await this.identity.sessions.requireOperational(context,s),actor=valid.identity;
  if(context.realm!=='TENANT'||valid.context.kind!=='W'||actor.organizationId!==org||actor.roles.includes('SA')||!actor.roles.some(x=>['T','O','C','P'].includes(x)))fail('ACCESS_DENIED',403);
  const tenant=await this.identity.database.db.collection<Organization>('organizations').findOne({_id:org,status:'ACTIVE'},{session:s});if(!tenant)fail('ACCESS_DENIED',403);
  await beginEvidence(this.identity.database,s,org);return{actor,org:tenant!};
 }
 private role(actor:Identity,roles:string[]){if(!actor.roles.some(r=>roles.includes(r))||actor.roles.includes('SA')||actor.suspended)fail('ACCESS_DENIED',403);}
 private expected(actual:string,expected:unknown){if(typeof expected!=='string')fail('ETAG_REQUIRED',428);if(actual!==expected)fail('PRECONDITION_FAILED',412);}
 private async versions(org:string,s:ClientSession){const b=await this.collection('payment_books').findOne({_id:org,organizationId:org},{session:s}),ops=await this.identity.operations!.books.findOne({_id:org,organizationId:org},{session:s});return{book:b,payments:`"${org}:payments:${b?.version??0}"`,operations:`"${org}:ops:${ops?.version??0}"`};}
 private signed(value:unknown){const body=Buffer.from(JSON.stringify(value)).toString('base64url');return body+'.'+createHmac('sha256',this.key).update('S06:'+body).digest('base64url');}
 private decoded<T>(value:string):T{try{const[b,signature,...extra]=value.split('.');if(!b||!signature||extra.length)throw Error('token');const expected=createHmac('sha256',this.key).update('S06:'+b).digest(),actual=Buffer.from(signature,'base64url');if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error('token');return JSON.parse(Buffer.from(b,'base64url').toString('utf8')) as T;}catch{return fail('INPUT_INVALID',422);}}
 async snapshot(purpose:string,id:string|null,actor:Identity,s:ClientSession,command?:Record<string,unknown>|null){
  if(!isPaymentPurpose(purpose)||!command)fail('INPUT_INVALID',422);
  const org=uuid(command!['organizationId']);if(actor.organizationId!==org)fail('RESOURCE_NOT_FOUND',404);
  const operation=String(command!['operationId']);paymentContract().validate(operation,command!['payload']);
  if(paymentContract().purpose(operation,command!['payload'] as Record<string,unknown>)!==purpose||id!==(command!['resourceId']??null))fail('INPUT_INVALID',422);
  if(['CUSTODY_BINDING_SET','PAYMENT_REGISTRATION_SCOPE_SET','PAYMENT_REGISTER_DIRECT','PAYMENT_REVERSAL_EXECUTE'].includes(purpose))this.role(actor,['T']);else if(purpose==='PAYMENT_APPROVE_CONFIRM')this.role(actor,['T','P']);
  if(['PAYMENT_REGISTER','PAYMENT_CANCEL','CUSTODY_PROVISIONAL_RETURN'].includes(purpose))this.role(actor,['T','O','C']);
  if(purpose==='PAYMENT_REJECT')this.role(actor,['T','P']);
  if(purpose.startsWith('BANK_')||purpose.startsWith('RECONCILIATION_')||purpose.startsWith('PAYMENT_REVERSAL_'))this.role(actor,['T']);
  if(purpose==='PAYMENT_REGISTER'&&actor.roles.includes('C')&&!actor.roles.some(r=>['T','O'].includes(r))){const intent=((command!['payload'] as Record<string,unknown>)['command'] as {intent:PaymentIntent}).intent;for(const t of intent.targets)if(!await this.collection('payment_registration_scopes').findOne({organizationId:org,registrarId:actor._id,loanId:t.loanId,active:true},{session:s}))fail('ACCESS_DENIED',403);}
  const tenant=await this.identity.database.db.collection<Organization>('organizations').findOne({_id:org,status:'ACTIVE'},{session:s});if(!tenant)fail('ACCESS_DENIED',403);
  return hash({purpose,id,command,actor:actor._id,authz:actor.authzVersion,epoch:actor.authEpoch,credential:actor.credentialVersion,tenantEpoch:tenant!.authEpoch});
 }
 private async account(org:string,id:string,s:ClientSession,kind?:'CASH'|'BANK'|'LIABILITY',expected?:unknown){
  const a=await this.identity.finance!.accounts.findOne({_id:uuid(id),organizationId:org,bookId:org,ownerId:org,financialScope:'BUSINESS'},{session:s});if(!a)fail('RESOURCE_NOT_FOUND',404);
  if(a!.status!=='ACTIVE'||a!.currency!=='COP'||(kind==='LIABILITY'?(a!.accountClass!=='LIABILITY'||a!.kind!=='GENERAL'):kind&&(a!.accountClass!=='ASSET'||a!.kind!==kind)))fail('ACCOUNT_INELIGIBLE',422);
  if(expected!==undefined)this.expected(etag(a!),expected);return a!;
 }
 private async binding(org:string,actorId:string,s:ClientSession){return await this.collection('custody_bindings').findOne({_id:actorId,organizationId:org},{session:s});}
 private async registrar(org:string,actor:Identity,intent:PaymentIntent,s:ClientSession){
  this.role(actor,['T','O','C']);
  if(actor.organizationId!==org||actor.suspended)fail('ACCESS_DENIED',403);
  if(!actor.roles.some(r=>['T','O'].includes(r))){for(const t of intent.targets){const scope=await this.collection('payment_registration_scopes').findOne({organizationId:org,registrarId:actor._id,loanId:t.loanId,active:true},{session:s});if(!scope)fail('RESOURCE_NOT_FOUND',404);}}
  if(new Set(intent.targets.map(t=>t.loanId)).size!==intent.targets.length||intent.targets.reduce((n,t)=>n+cents(t.amount),0n)>cents(intent.amount))fail('INPUT_INVALID',422);
  const date=today(this.identity.now());if(intent.observedDate>date||Date.parse(intent.observedAt)>this.identity.now())fail('INPUT_INVALID',422);
  await this.account(org,intent.destinationAccountId,s,intent.method==='CASH'?'CASH':'BANK',intent.destinationAccountETag);
  if(intent.method==='CASH'){
   if(intent.custodianId!==actor._id)fail('ACCESS_DENIED',403);const b=await this.binding(org,actor._id,s);if(!b||b['accountId']!==intent.destinationAccountId)fail('ACCOUNT_PROFILE_CONFLICT');this.expected(etag(b!),intent.bindingETag);
  }else if(intent.custodianId!==null||intent.bindingETag!==null)fail('INPUT_INVALID',422);
  for(const target of intent.targets){const loan=await this.identity.lending!.verifiedLoan(target.loanId,org,s);if(loan.borrowerId!==intent.borrowerId)fail('RESOURCE_NOT_FOUND',404);const state=await stateOf(this.identity.database,loan,s);if(!state||state.position.status!=='ACTIVE')fail('PAYMENT_STATE_CONFLICT');this.expected(etag(state!.position),target.positionETag);}
 }
 private async payment(org:string,id:string,actor:Identity,s:ClientSession,decision=false){
  const p=await this.collection<Payment>('payments').findOne({_id:uuid(id),organizationId:org},{session:s});if(!p)fail('RESOURCE_NOT_FOUND',404);
  if(!actor.roles.includes('T')&&!(p!.registrarId===actor._id&&actor.roles.some(r=>['O','C'].includes(r)))&&!(actor.roles.includes('P')&&p!.approvalMode==='SUPERVISED'&&p!.status==='PENDING'))fail('RESOURCE_NOT_FOUND',404);
  if(decision){this.role(actor,['T','P']);if(p!.registrarId===actor._id)fail('SEGREGATION_REQUIRED');}
  return p!;
 }
 private async freshRegistrar(p:Payment,s:ClientSession){const a=await this.identity.identities.findOne({_id:p.registrarId,realm:'TENANT',organizationId:p.organizationId,suspended:false},{session:s});if(!a)fail('ACCESS_DENIED',403);try{await this.registrar(p.organizationId,a!,p.intent,s);}catch(e){if(e instanceof AppError&&e.code==='RESOURCE_NOT_FOUND')fail('ACCESS_DENIED',403);throw e;}return a!;}
 private draft(org:string,actor:Identity,key:string,command:Record<string,unknown>,issued:number):Payment{
  const intent=command['intent'] as PaymentIntent;return{_id:stableId(org,actor._id,key),organizationId:org,version:1,receiptReference:intent.receiptReference,currentReconciliationLinkId:null,reversalRequestId:null,registrarId:actor._id,intent,approvalMode:command['mode'] as 'DIRECT'|'SUPERVISED',status:'PENDING',approvalState:'PENDING',approvalOrigin:'S06',reconciliationState:intent.method==='BANK'?'PENDING':'NOT_APPLICABLE',custodyState:intent.method==='CASH'?'PROVISIONAL':'NOT_APPLICABLE',heldFundsState:'NONE',decidedBy:null,eventId:null,reversalEventId:null,observedDate:intent.observedDate,effectiveDate:null,recordedAt:new Date(issued).toISOString(),policyVersion:policy.version};
 }
 private async plan(actor:Identity,org:Organization,key:string,command:Record<string,unknown>,s:ClientSession,issued:number,opsTag:string){
  let payment:Payment|null=null;let economic:Awaited<ReturnType<PaymentEconomics['receipt']>>|null=null;let reverse:Awaited<ReturnType<PaymentEconomics['reverse']>>|null=null;let registrarAuthority:Identity|null=null;
  if(command['kind']==='REGISTER'){
   payment=this.draft(org._id,actor,key,command,issued);await this.registrar(org._id,actor,payment.intent,s);
   if(command['effectiveDate']!==today(this.identity.now()))fail('DATE_NOT_ALLOWED');
   if(payment.approvalMode==='DIRECT'){this.role(actor,['T']);economic=await this.economic.receipt(actor,org,payment,String(command['effectiveDate']),key,opsTag,s,issued);}
   else if(!await this.identity.identities.findOne({organizationId:org._id,realm:'TENANT',suspended:false,roles:{$in:['T','P']},_id:{$ne:actor._id}},{session:s}))fail('SEGREGATION_REQUIRED');
  }else if(command['kind']==='APPROVE'){
   payment=await this.payment(org._id,String(command['paymentId']),actor,s,true);this.expected(etag(payment),command['resourceETag']);if(payment.status!=='PENDING')fail('PAYMENT_STATE_CONFLICT');registrarAuthority=await this.freshRegistrar(payment,s);this.expected(opsTag,command['expectedOperationsETag']);economic=await this.economic.receipt(actor,org,payment,String(command['effectiveDate']),key,opsTag,s,issued);
  }else if(command['kind']==='EXECUTE_REVERSAL'){
   this.role(actor,['T']);const request=await this.collection('payment_reversal_requests').findOne({_id:String(command['reversalRequestId']),organizationId:org._id},{session:s});if(!request)fail('RESOURCE_NOT_FOUND',404);this.expected(etag(request!),command['resourceETag']);if(request!['state']!=='REQUESTED'||request!['originalEventId']!==command['originalEventId'])fail('PAYMENT_STATE_CONFLICT');this.expected(opsTag,command['expectedOperationsETag']);reverse=await this.economic.reverse(org._id,String(command['originalEventId']),String(command['effectiveDate']),key,s);if((reverse.paymentId??null)!==(command['paymentId']??null))fail('INPUT_INVALID',422);
  }else fail('INPUT_INVALID',422);
  const unit=await beginEvidence(this.identity.database,s,org._id);
  const plan={effectiveDate:String(command['effectiveDate']),postings:economic?.plan.postings??reverse?.postings??[],allocations:economic?.plan.allocations??[],creditAdded:economic?.plan.creditChange?.added??'0.00',creditApplied:economic?.plan.creditChange?.applied??'0.00',heldFundsAdded:reverse?.paymentId?(await this.payment(org._id,reverse.paymentId,actor,s)).intent.amount:'0.00',custodyDelta:reverse?.paymentId?'HELD_UNALLOCATED':payment?.intent.method==='CASH'?(economic?'CONFIRM_PROVISIONAL':'PROVISIONAL'):'NONE',snapshotHash:hash({readSet:[...unit.readSet].sort(),actor:{id:actor._id,authz:actor.authzVersion,epoch:actor.authEpoch,credential:actor.credentialVersion},tenant:org.authEpoch,registrarAuthority:registrarAuthority?{id:registrarAuthority._id,authz:registrarAuthority.authzVersion,epoch:registrarAuthority.authEpoch,credential:registrarAuthority.credentialVersion,roles:registrarAuthority.roles}:null,policy,command,payment,economic:economic?.dependencies,reverse})};
  return{plan,payment,economic,reverse};
 }
 async preview(context:Context,organization:string,input:unknown):Promise<Result>{
  paymentContract().validate('PreviewInput',input);const p=canonical(input) as {executionKey:string;expectedPaymentsETag:string;command:Record<string,unknown>};paymentContract().validate('PreviewInput',p);
  return await this.identity.database.transaction(async s=>{const {actor,org}=await this.actor(context,uuid(organization),s),v=await this.versions(org._id,s);this.expected(v.payments,p.expectedPaymentsETag);const issued=this.identity.now(),planned=await this.plan(actor,org,p.executionKey,p.command,s,issued,v.operations);await quoteQuota(this.identity,actor._id,org._id,s);const claims:Claims={org:org._id,actor:actor._id,key:p.executionKey,issued,expires:issued+300000,command:p.command,paymentsETag:v.payments,operationsETag:v.operations,fingerprint:hash(planned.plan)};return{status:200,data:{token:this.signed(claims),expiresAt:new Date(claims.expires).toISOString(),paymentsBookETag:v.payments,operationsBookETag:v.operations,plan:planned.plan}};});
 }
 async recordEconomic(...args:Parameters<PaymentEconomics['record']>){return await this.economic.record(...args);}
 async mutate(context:Context,operation:string,organization:string,input:unknown,keyValue:unknown,ifMatch?:string,resourceId?:string):Promise<Result>{
  paymentContract().validate(operation,input);const payload=canonical(input) as Record<string,unknown>;paymentContract().validate(operation,payload);const orgId=uuid(organization),key=uuid(keyValue),purpose=paymentContract().purpose(operation,payload);if(!isPaymentPurpose(purpose))fail('INPUT_INVALID',422);if(!ifMatch)fail('ETAG_REQUIRED',428);
  const command={organizationId:orgId,idempotencyKey:key,expectedETag:ifMatch,operationId:operation,resourceId:resourceId??null,payload},fingerprint=hash(command);
  try{return await this.identity.database.transaction(async s=>{
   const {actor,org}=await this.actor(context,orgId,s);await this.snapshot(purpose,resourceId??null,actor,s,command);
   try{await this.identity.sessions.consumeProof(context,purpose,resourceId??null,s,command);}catch(e){if(e instanceof AppError&&e.code==='REAUTH_REQUIRED')fail('R_REQUIRED',403);throw e;}
   const oldCommand=await this.collection('payment_commands').findOne({organizationId:orgId,actorId:actor._id,purpose,key},{session:s});if(oldCommand){if(oldCommand['fingerprint']!==fingerprint)fail('IDEMPOTENCY_CONFLICT');const result=structuredClone(oldCommand['result'] as Result);(result.data as Record<string,unknown>)['replayed']=true;return{...result,status:200};}
   const v=await this.versions(orgId,s);this.expected(v.payments,ifMatch);let entity:Row|null=null,entityType='PAYMENT',eventId:string|null=null,journalId:string|null=null;let before:Payment|null=null;
   if(['registerPayment','approvePayment','executePaymentReversal'].includes(operation)){
    const c=payload['command'] as Record<string,unknown>,claims=this.decoded<Claims>(String(payload['previewToken']));if(claims.org!==orgId||claims.actor!==actor._id||claims.key!==key||hash(claims.command)!==hash(c)||claims.paymentsETag!==ifMatch)fail('PREVIEW_STALE');if(this.identity.now()>=claims.expires||claims.issued>this.identity.now()||claims.expires-claims.issued!==300000)fail('PREVIEW_EXPIRED');this.expected(v.operations,claims.operationsETag);
    if(operation==='approvePayment'&&resourceId!==c['paymentId']||operation==='executePaymentReversal'&&resourceId!==c['originalEventId'])fail('INPUT_INVALID',422);
    const planned=await this.plan(actor,org,key,c,s,claims.issued,v.operations);if(hash(planned.plan)!==claims.fingerprint)fail('PREVIEW_STALE');
    if(operation==='executePaymentReversal'){
     const reversal=await this.economic.reverse(orgId,String(c['originalEventId']),String(c['effectiveDate']),stableId(orgId,actor._id,purpose,key),s,true);eventId=reversal.eventId;journalId=reversal.journalId;
     const request=await this.collection('payment_reversal_requests').findOne({_id:String(c['reversalRequestId']),organizationId:orgId},{session:s});request!['state']='EXECUTED';request!.version++;await this.collection('payment_reversal_requests').replaceOne({_id:request!._id,organizationId:orgId},request!,{session:s});
     if(reversal.paymentId){before=await this.payment(orgId,reversal.paymentId,actor,s);const p=structuredClone(before);p.status='REVERSED';p.reversalEventId=eventId;p.heldFundsState='HELD_UNALLOCATED';if(p.intent.method==='BANK')p.reconciliationState='INVESTIGATION';else p.custodyState='HELD_UNALLOCATED';p.version++;await this.collection<Payment>('payments').replaceOne({_id:p._id,organizationId:orgId},p,{session:s});await this.custody(p,s);entity=p;}else{entity=request;entityType='REVERSAL_REQUEST';}
    }else{
     const p=planned.payment!;if(operation==='registerPayment'){p['_createdRevision']=(v.book?.version??0)+1;p.recordedAt=new Date(this.identity.now()).toISOString();
      if(await this.collection<Payment>('payments').findOne({organizationId:orgId,receiptReference:p.intent.receiptReference},{session:s})||await this.identity.operations!.events.findOne({organizationId:orgId,receiptReference:p.intent.receiptReference},{session:s}))fail('RECEIPT_REFERENCE_CONFLICT');
     }else before=structuredClone(p);
     if(planned.economic){await this.economic.receipt(actor,org,p,String(c['effectiveDate']),key,v.operations,s,claims.issued,true);eventId=planned.economic.eventId;const event=await this.identity.operations!.events.findOne({_id:eventId,organizationId:orgId},{session:s});journalId=event!.journalId;p.status='CONFIRMED';p.approvalState=p.approvalMode==='DIRECT'?'DIRECT_AUTHORIZED':'APPROVED';p.decidedBy=actor._id;p.effectiveDate=String(c['effectiveDate']);p.eventId=eventId;if(p.intent.method==='CASH')p.custodyState='CONFIRMED_HELD';}
     if(before){p.version++;await this.collection<Payment>('payments').replaceOne({_id:p._id,organizationId:orgId},p,{session:s});}else await this.collection<Payment>('payments').insertOne(p,{session:s});await this.custody(p,s);await this.collection('payment_approvals').insertOne({_id:stableId(orgId,key,'approval'),organizationId:orgId,version:p.version,paymentId:p._id,registrarId:p.registrarId,decidedBy:p.decidedBy,state:p.approvalState,snapshotHash:planned.plan.snapshotHash,policyVersion:policy.version,createdAt:new Date(this.identity.now()).toISOString()},{session:s});entity=p;
    }
   }else if(['rejectPayment','cancelPayment','returnProvisionalCash'].includes(operation)){
    if(operation!=='rejectPayment')this.role(actor,['T','O','C']);
    let p:Payment;if(operation==='returnProvisionalCash'){const custody=await this.collection('cash_custody').findOne({_id:resourceId??'',organizationId:orgId},{session:s});if(!custody)fail('RESOURCE_NOT_FOUND',404);p=await this.payment(orgId,String(custody!['paymentId']),actor,s);this.expected(etag(custody!),payload['custodyETag']);}else p=await this.payment(orgId,resourceId!,actor,s,operation==='rejectPayment');
    before=structuredClone(p);this.expected(etag(p),payload['resourceETag']);
    if(operation==='returnProvisionalCash'){
     if(p.custodyState!=='RETURN_REQUIRED'||payload['amount']!==p.intent.amount||Date.parse(String(payload['returnedAt']))>this.identity.now())fail('PAYMENT_STATE_CONFLICT');if(p.registrarId!==actor._id&&!actor.roles.includes('T'))fail('ACCESS_DENIED',403);p.custodyState='RETURNED';
    }else{if(p.status!=='PENDING')fail('PAYMENT_STATE_CONFLICT');if(operation==='cancelPayment'&&!actor.roles.includes('T')&&p.registrarId!==actor._id)fail('ACCESS_DENIED',403);p.status=operation==='rejectPayment'?'REJECTED':'CANCELLED';p.approvalState=p.status;if(p.intent.method==='CASH')p.custodyState='RETURN_REQUIRED';p.decidedBy=actor._id;}
    p.version++;await this.collection<Payment>('payments').replaceOne({_id:p._id,organizationId:orgId},p,{session:s});await this.custody(p,s);entity=p;
   }else if(['setCustodyBinding','setHeldFundsProfile','setPaymentRegistrationScope'].includes(operation)){
    this.role(actor,['T']);
    if(operation==='setHeldFundsProfile'){
     const account=await this.account(orgId,String(payload['heldLiabilityAccountId']),s,'LIABILITY',payload['heldLiabilityAccountETag']),b=await this.identity.operations!.books.findOne({_id:orgId,organizationId:orgId},{session:s});if(b&&Object.values(b.profile).includes(account._id))fail('ACCOUNT_PROFILE_CONFLICT');
     const old=await this.collection('held_funds_profiles').findOne({_id:orgId,organizationId:orgId},{session:s});this.expected(old?etag(old):`"${orgId}:held-profile:0"`,payload['resourceETag']);if(old&&old['accountId']!==account._id)fail('ACCOUNT_PROFILE_CONFLICT');entity=old??{_id:orgId,organizationId:orgId,version:1,accountId:account._id};if(!old)await this.collection('held_funds_profiles').insertOne(entity,{session:s});entityType='HELD_FUNDS_PROFILE';
    }else if(operation==='setCustodyBinding'){
     const owner=await this.identity.identities.findOne({_id:String(payload['custodianId']),organizationId:orgId,realm:'TENANT',suspended:false},{session:s});if(!owner||!owner.roles.some(r=>['T','O','C'].includes(r))||owner.roles.includes('SA'))fail('ACCESS_DENIED',403);
     const a=await this.account(orgId,String(payload['accountId']),s,'CASH',payload['accountETag']),profile=await this.collection('held_funds_profiles').findOne({_id:orgId,organizationId:orgId},{session:s});await this.account(orgId,String(payload['heldLiabilityAccountId']),s,'LIABILITY',payload['heldLiabilityAccountETag']);if(!profile||profile['accountId']!==payload['heldLiabilityAccountId'])fail('ACCOUNT_PROFILE_CONFLICT');
     const old=await this.binding(orgId,owner!._id,s);this.expected(old?etag(old):`"${owner!._id}:binding:0"`,payload['resourceETag']);if(old&&old['accountId']!==a._id&&await this.collection('cash_custody').findOne({organizationId:orgId,responsibleId:owner!._id,amountHeld:{$ne:'0.00'}},{session:s}))fail('STATE_CONFLICT');
     entity={_id:owner!._id,organizationId:orgId,version:(old?.version??0)+1,_createdRevision:old?.['_createdRevision']??(v.book?.version??0)+1,custodianId:owner!._id,accountId:a._id,heldLiabilityAccountId:profile!['accountId']};await this.collection('custody_bindings').replaceOne({_id:entity._id,organizationId:orgId},entity,{session:s,upsert:true});entityType='BINDING';
    }else{
     const owner=await this.identity.identities.findOne({_id:String(payload['registrarId']),organizationId:orgId,realm:'TENANT',suspended:false,roles:'C'},{session:s});if(!owner||owner.roles.includes('SA'))fail('ACCESS_DENIED',403);await this.identity.lending!.verifiedLoan(String(payload['loanId']),orgId,s);
     const old=await this.collection('payment_registration_scopes').findOne({_id:String(payload['scopeId']),organizationId:orgId},{session:s});this.expected(old?etag(old):`"${payload['scopeId']}:0"`,payload['resourceETag']);if(old&&(old['registrarId']!==owner!._id||old['loanId']!==payload['loanId']))fail('STATE_CONFLICT');entity={_id:String(payload['scopeId']),organizationId:orgId,version:(old?.version??0)+1,_createdRevision:old?.['_createdRevision']??(v.book?.version??0)+1,registrarId:owner!._id,loanId:payload['loanId'],scope:'PAYMENT_REGISTER_ONLY',active:payload['active']};await this.collection('payment_registration_scopes').replaceOne({_id:entity._id,organizationId:orgId},entity,{session:s,upsert:true});entityType='REGISTRATION_SCOPE';
    }
   }else if(['requestPaymentReversal','rejectPaymentReversal'].includes(operation)){
    this.role(actor,['T']);const event=await this.identity.operations!.events.findOne({_id:resourceId!,organizationId:orgId},{session:s});if(!event)fail('RESOURCE_NOT_FOUND',404);if(!['RECEIPT','APPLY_CREDIT'].includes(event!.kind))fail('UNSUPPORTED_REVERSAL_KIND',422);
    const old=await this.collection('payment_reversal_requests').findOne({_id:resourceId!,organizationId:orgId},{session:s});this.expected(old?etag(old):`"${event!._id}:1"`,payload['resourceETag']);if(old?.['state']==='EXECUTED')fail('ALREADY_REVERSED');if(operation==='rejectPaymentReversal'&&old?.['state']!=='REQUESTED')fail('PAYMENT_STATE_CONFLICT');
    const snap=await this.collection('payment_event_snapshots').findOne({_id:event!._id,organizationId:orgId},{session:s});if(!snap)fail('REVERSAL_SNAPSHOT_UNAVAILABLE');
    entity={_id:event!._id,organizationId:orgId,version:(old?.version??0)+1,paymentId:snap!['paymentId'],originalEventId:event!._id,originalKind:event!.kind,state:operation==='requestPaymentReversal'?'REQUESTED':'REJECTED',requestedBy:actor._id,requestedAt:new Date(this.identity.now()).toISOString(),reason:payload['reason']};await this.collection('payment_reversal_requests').replaceOne({_id:entity._id,organizationId:orgId},entity,{session:s,upsert:true});entityType='REVERSAL_REQUEST';
    if(entity['paymentId']){const p=await this.payment(orgId,String(entity['paymentId']),actor,s);before=structuredClone(p);if(!['CONFIRMED','REVERSAL_REQUESTED'].includes(p.status))fail('PAYMENT_STATE_CONFLICT');p.status=operation==='requestPaymentReversal'?'REVERSAL_REQUESTED':'CONFIRMED';p['reversalRequestId']=entity._id;p.version++;await this.collection<Payment>('payments').replaceOne({_id:p._id,organizationId:orgId},p,{session:s});}
   }else{
    this.role(actor,['T']);({entity,entityType}=await this.reconcile(orgId,actor,operation,payload,key,resourceId,s,(v.book?.version??0)+1));
   }
   if(!entity)throw new AppError(503,'SERVICE_UNAVAILABLE');
   const nextVersion=(v.book?.version??0)+1;await this.collection('payment_books').replaceOne({_id:orgId,organizationId:orgId},{_id:orgId,organizationId:orgId,version:nextVersion,policyRevision:policy.version},{session:s,upsert:true});
   const current=await this.versions(orgId,s),data={commandKey:key,operationId:operation,entityType,entityId:entity._id,entityETag:etag(entity),paymentsBookETag:current.payments,operationsBookETag:current.operations,eventId,journalId,replayed:false},result={status:201,data,etag:etag(entity)};
   paymentContract().result(operation,201,{data,requestId:key});
   const changeId=stableId(orgId,actor._id,purpose,key);await this.collection('payment_transitions').insertOne({_id:changeId,organizationId:orgId,version:nextVersion,operation,paymentId:before?._id??(entityType==='PAYMENT'?entity._id:null),actorId:actor._id,before:before?hash(before):null,after:hash(entity),payloadHash:hash(payload),createdAt:new Date(this.identity.now()).toISOString()},{session:s});
   await this.collection('payment_commands').insertOne({_id:changeId,organizationId:orgId,version:1,actorId:actor._id,purpose,key,fingerprint,result},{session:s});
   await this.fence(actor,org,s);if(before&&before.registrarId!==actor._id){const registrar=await this.identity.identities.findOne({_id:before.registrarId},{session:s});if(registrar)await this.fence(registrar,org,s);}
   await recordLendingEvidence(this.identity.database,s);await this.identity.audit.append({realm:'TENANT',actorId:actor._id,subjectId:actor._id,action:purpose,outcome:'SUCCESS',lending:{operation,id:entity._id,version:entity.version}},s);return result;
  });}catch(e){if(e&&typeof e==='object'&&'code'in e&&e.code===11000)fail(operation==='createBankDeclaration'?'BANK_DECLARATION_DUPLICATE':'SOURCE_CONFLICT');throw e;}
 }
 private async fence(actor:Identity,org:Organization,s:ClientSession){
  const a=await this.identity.identities.updateOne({_id:actor._id,authzVersion:actor.authzVersion,authEpoch:actor.authEpoch,credentialVersion:actor.credentialVersion,suspended:false},{$inc:{operationCommandFence:1}},{session:s});const o=await this.identity.database.db.collection<Organization>('organizations').updateOne({_id:org._id,status:'ACTIVE',authEpoch:org.authEpoch},{$inc:{operationCommandFence:1}},{session:s});if(!a.matchedCount||!o.matchedCount)fail('ACCESS_DENIED',403);
 }
 private async custody(p:Payment,s:ClientSession){
  if(p.intent.method!=='CASH')return;
  const old=await this.collection('cash_custody').findOne({organizationId:p.organizationId,paymentId:p._id},{session:s}),amountHeld=p.custodyState==='RETURNED'?'0.00':p.intent.amount;
  const c={_id:p._id,organizationId:p.organizationId,version:(old?.version??0)+1,paymentId:p._id,_createdRevision:p['_createdRevision'],responsibleId:p.intent.custodianId,accountId:p.intent.destinationAccountId,effectiveDate:p.effectiveDate,amountHeld,provisional:['PROVISIONAL','RETURN_REQUIRED'].includes(p.custodyState)?amountHeld:'0.00',confirmed:p.custodyState==='CONFIRMED_HELD'?amountHeld:'0.00',unallocated:p.custodyState==='HELD_UNALLOCATED'?amountHeld:'0.00',state:p.custodyState};await this.collection('cash_custody').replaceOne({_id:p._id,organizationId:p.organizationId},c,{session:s,upsert:true});
  await this.collection('custody_movements').insertOne({_id:stableId(p._id,String(c.version)),organizationId:p.organizationId,version:c.version,paymentId:p._id,before:old?hash(old):null,after:hash(c),responsibleId:p.intent.custodianId,createdAt:new Date(this.identity.now()).toISOString()},{session:s});
 }
 private async reconcile(org:string,actor:Identity,operation:string,payload:Record<string,unknown>,key:string,id:string|undefined,s:ClientSession,creationRevision:number):Promise<{entity:Row;entityType:string}>{
  if(operation==='createBankDeclaration'){
   await this.account(org,String(payload['accountId']),s,'BANK',payload['accountETag']);if(String(payload['valueDate'])>today(this.identity.now()))fail('INPUT_INVALID',422);const entity={...payload,_id:stableId(org,actor._id,key),organizationId:org,version:1,_createdRevision:creationRevision,declaredBy:actor._id,declaredAt:new Date(this.identity.now()).toISOString(),activeLinkId:null,state:'AVAILABLE',contentHash:hash({accountId:payload['accountId'],date:payload['valueDate'],amount:payload['amount'],reference:payload['reference']})};await this.collection('bank_declarations').insertOne(entity,{session:s});return{entity,entityType:'BANK_DECLARATION'};
  }
  if(operation==='voidBankDeclaration'){
   const d=await this.collection('bank_declarations').findOne({_id:id!,organizationId:org},{session:s});if(!d)fail('RESOURCE_NOT_FOUND',404);this.expected(etag(d!),payload['resourceETag']);if(d!['state']==='LINKED'||d!['state']==='VOID')fail('STATE_CONFLICT');d!['state']='VOID';d!.version++;await this.collection('bank_declarations').replaceOne({_id:d!._id,organizationId:org},d!,{session:s});return{entity:d!,entityType:'BANK_DECLARATION'};
  }
  const p=await this.payment(org,String(payload['paymentId']),actor,s);this.expected(etag(p),payload[operation==='disposeReconciliation'?'resourceETag':'paymentETag']);if(p.intent.method!=='BANK'||!(p.status==='CONFIRMED'||operation==='unlinkReconciliation'&&p.status==='REVERSAL_REQUESTED'))fail('PAYMENT_STATE_CONFLICT');
  if(operation==='disposeReconciliation'){
   if(p.reconciliationState==='RECONCILED')fail('STATE_CONFLICT');const target=String(payload['state']);if(!(['DISCREPANCY','INVESTIGATION','PENDING'].includes(target))||target==='PENDING'&&p.reconciliationState!=='INVESTIGATION')fail('STATE_CONFLICT');p.reconciliationState=target;
  }else{
   const d=await this.collection('bank_declarations').findOne({_id:String(payload['bankDeclarationId']),organizationId:org},{session:s});if(!d)fail('RESOURCE_NOT_FOUND',404);this.expected(etag(d!),payload['bankDeclarationETag']);
   if(operation==='linkReconciliation'){
    if(d!['state']==='LINKED'||d!['state']==='VOID'||p.reconciliationState==='RECONCILED')fail('LINK_CONFLICT');if(p.intent.destinationAccountId!==d!['accountId']||p.intent.amount!==d!['amount']||p.intent.observedDate!==d!['valueDate']||p.intent.receiptReference!==d!['reference'])fail('RECONCILIATION_MISMATCH');d!['state']='LINKED';d!['linkedPaymentId']=p._id;d!['activeLinkId']=key;p['currentReconciliationLinkId']=key;p['linkedDeclarationId']=d!._id;p.reconciliationState='RECONCILED';
   }else if(operation==='unlinkReconciliation'){
    if(d!['state']!=='LINKED'||d!['linkedPaymentId']!==p._id||p['linkedDeclarationId']!==d!._id||payload['linkId']!==d!['activeLinkId']||p['currentReconciliationLinkId']!==d!['activeLinkId'])fail('LINK_CONFLICT');d!['state']='AVAILABLE';d!['linkedPaymentId']=null;d!['activeLinkId']=null;p['currentReconciliationLinkId']=null;p['linkedDeclarationId']=null;p.reconciliationState='PENDING';
   }else fail('INPUT_INVALID',422);
   d!.version++;await this.collection('bank_declarations').replaceOne({_id:d!._id,organizationId:org},d!,{session:s});
  }
  p.version++;await this.collection<Payment>('payments').replaceOne({_id:p._id,organizationId:org},p,{session:s});const entity={_id:key,organizationId:org,version:1,paymentId:p._id,bankDeclarationId:payload['bankDeclarationId']??null,linkId:payload['bankDeclarationId']??null,operation,actorId:actor._id,payload,state:p.reconciliationState,createdAt:new Date(this.identity.now()).toISOString()};await this.collection('reconciliation_events').insertOne(entity,{session:s});return{entity,entityType:'RECONCILIATION'};
 }
 async read(context:Context,operation:string,organization:string,id?:string,query:Record<string,unknown>={}):Promise<Result>{
  return await this.identity.database.transaction(async s=>{
   const {actor,org}=await this.actor(context,uuid(organization),s),v=await this.versions(org._id,s);let data:unknown;
   if(operation==='getPaymentsPolicy')data=policy;
   else if(operation==='getPaymentsState')data={organizationId:org._id,paymentsBookETag:v.payments,operationsBookETag:v.operations,policyRevision:policy.version};
   else if(operation==='getPayment'){const p=await this.payment(org._id,id!,actor,s);return{status:200,data:publicPayment(p),etag:etag(p)};}
   else if(operation==='getPaymentCommand'){const c=await this.collection('payment_commands').findOne({organizationId:org._id,actorId:actor._id,key:uuid(id)},{session:s});if(!c)fail('RESOURCE_NOT_FOUND',404);return{...(c!['result'] as Result),status:200};}
   else if(operation==='getLegacyPaymentView'){
    this.role(actor,['T']);const event=await this.identity.operations!.events.findOne({_id:uuid(id),organizationId:org._id,kind:'RECEIPT'},{session:s});if(!event||await this.collection('payment_event_snapshots').findOne({_id:event._id,organizationId:org._id},{session:s}))fail('RESOURCE_NOT_FOUND',404);const journal=event!.journalId?await this.identity.finance!.journals.findOne({_id:event!.journalId,organizationId:org._id},{session:s}):null;const destinations=await this.identity.finance!.accounts.find({organizationId:org._id,kind:{$in:['CASH','BANK']}},{session:s}).toArray();const line=journal?.lines.find(l=>cents(l.debit.toString())>0n&&destinations.some(a=>a._id===l.accountId));const account=destinations.find(a=>a._id===line?.accountId);data={originalEventId:event!._id,state:'CONFIRMED',approvalOrigin:'LEGACY_NOT_RECORDED',method:account?.kind==='CASH'?'CASH':account?.kind==='BANK'?'BANK':'UNKNOWN_LEGACY',custodyOrigin:account?.kind==='BANK'?'NOT_APPLICABLE':'LEGACY_UNSPECIFIED',reconciliationState:account?.kind==='BANK'?'PENDING':account?.kind==='CASH'?'NOT_APPLICABLE':'UNKNOWN_LEGACY',reversalEligibility:'SNAPSHOT_UNAVAILABLE',effectiveDate:event!.effectiveDate,amount:line?.debit.toString()??'0.00'};
   }else if(operation==='listPaymentContexts'){
    this.role(actor,['T','O','C']);const scopes=await this.collection('payment_registration_scopes').find({organizationId:org._id,registrarId:actor._id,active:true},{session:s}).toArray(),loans=await this.identity.lending!.loans.find({organizationId:org._id,...(!actor.roles.some(r=>['T','O'].includes(r))?{_id:{$in:scopes.map(x=>String(x['loanId']))}}:{})},{session:s}).toArray(),binding=await this.binding(org._id,actor._id,s),banks=await this.identity.finance!.accounts.find({organizationId:org._id,bookId:org._id,ownerId:org._id,financialScope:'BUSINESS',currency:'COP',accountClass:'ASSET',kind:'BANK',status:'ACTIVE'},{session:s}).toArray(),items:Record<string,unknown>[]=[];
    for(const l of loans){if(!actor.roles.some(r=>['T','O'].includes(r))&&!scopes.some(x=>x['loanId']===l._id))continue;const state=await stateOf(this.identity.database,await this.identity.lending!.verifiedLoan(l._id,org._id,s),s);if(!state||state.position.status!=='ACTIVE')continue;const b=await this.identity.lending!.borrowers.findOne({_id:l.borrowerId,organizationId:org._id},{session:s});if(!b)throw new AppError(503,'INTEGRITY_MISMATCH');const view=positionView(state,{id:b._id,code:b.borrowerCode,name:b.profile.displayName},today(this.identity.now()));const cash=binding?await this.account(org._id,String(binding['accountId']),s,'CASH'):null;for(const destination of [...(cash?[cash]:[]),...banks])items.push({borrowerId:b._id,borrowerCode:b.borrowerCode,borrowerName:b.profile.displayName,loanId:l._id,loanReference:l._id.slice(0,8),principalOutstanding:view.principalOutstanding,dueAmount:money(cents(view.duePrincipal)+cents(view.accruedOutstandingInterest)+cents(view.dueUnrecognizedInterest)),positionETag:etag(state.position),permittedDestinationId:destination._id,permittedBindingETag:destination.kind==='CASH'&&binding?etag(binding):null,permittedDestinationAccountETag:etag(destination),permittedDestinationLabel:destination.name,permittedMethod:destination.kind,__createdAt:l.createdAt});}
    data=this.page(items,actor,operation,query,v.book?.version??0);
   }else{
    const map:Record<string,{collection:PaymentCollection;keys:string[]}>={getCashCustody:{collection:'cash_custody',keys:['paymentId','responsibleId','accountId','amountHeld','provisional','confirmed','unallocated','state']},listCashCustody:{collection:'cash_custody',keys:['paymentId','responsibleId','accountId','amountHeld','provisional','confirmed','unallocated','state']},getCustodyBinding:{collection:'custody_bindings',keys:['custodianId','accountId','heldLiabilityAccountId']},listCustodyBindings:{collection:'custody_bindings',keys:['custodianId','accountId','heldLiabilityAccountId']},getPaymentRegistrationScope:{collection:'payment_registration_scopes',keys:['registrarId','loanId','scope','active']},listPaymentRegistrationScopes:{collection:'payment_registration_scopes',keys:['registrarId','loanId','scope','active']},getLoanEventReversalRequest:{collection:'payment_reversal_requests',keys:['paymentId','originalEventId','originalKind','state','requestedBy','requestedAt','reason']}};
    if(operation==='getHeldFundsProfile'){this.role(actor,['T']);const profile=await this.collection('held_funds_profiles').findOne({_id:org._id,organizationId:org._id},{session:s});if(!profile)fail('RESOURCE_NOT_FOUND',404);return{status:200,data:{organizationId:org._id,heldLiabilityAccountId:profile!['accountId'],version:profile!.version},etag:etag(profile!)};}
    if(operation==='listPayments'){
     const ps=await this.collection<Payment>('payments').find({organizationId:org._id,...(!actor.roles.includes('T')?{$or:[...(actor.roles.some(r=>['O','C'].includes(r))?[{registrarId:actor._id}]:[]),...(actor.roles.includes('P')?[{status:'PENDING' as const,approvalMode:'SUPERVISED' as const}]:[])]}:{})},{session:s}).toArray(),items=ps.filter(p=>actor.roles.includes('T')||p.registrarId===actor._id&&actor.roles.some(r=>['O','C'].includes(r))||actor.roles.includes('P')&&p.status==='PENDING'&&p.approvalMode==='SUPERVISED').map(p=>({...publicPayment(p),__revision:p['_createdRevision']}));data=this.page(items,actor,operation,query,v.book?.version??0);
    }else if(['getBankDeclaration','listBankDeclarations'].includes(operation)){
     this.role(actor,['T']);const rows=await this.collection('bank_declarations').find({organizationId:org._id,...(id?{_id:uuid(id)}:{})},{session:s}).toArray(),keys=['accountId','accountETag','currency','direction','amount','valueDate','reference','source','declaredBankName','statementReference','lineReference','supportReference','organizationId','declaredBy','declaredAt','state','activeLinkId'];if(id){if(!rows[0])fail('RESOURCE_NOT_FOUND',404);return{status:200,data:projection(rows[0]!,keys),etag:etag(rows[0]!)};}data=this.page(rows.map(r=>({...projection(r,keys),__revision:r['_createdRevision']})),actor,operation,query,v.book?.version??0);
    }else{
     const def=map[operation];if(!def)fail('INPUT_INVALID',422);if(def!.collection!=='cash_custody')this.role(actor,['T']);else this.role(actor,['T','O','C']);const rows=await this.collection(def!.collection).find({organizationId:org._id,...(id?{_id:uuid(id)}:{}),...(!actor.roles.includes('T')?{responsibleId:actor._id}:{})},{session:s}).toArray();if(id){if(!rows[0])fail('RESOURCE_NOT_FOUND',404);return{status:200,data:projection(rows[0]!,def!.keys),etag:etag(rows[0]!)};}data=this.page(rows.map(r=>({...projection(r,def!.keys),__revision:r['_createdRevision']})),actor,operation,query,v.book?.version??0);
    }
   }
   return{status:200,data,etag:v.payments};
  });
 }
 private page(items:Record<string,unknown>[],actor:Identity,operation:string,query:Record<string,unknown>,revision:number){
  const limit=query['limit']===undefined?20:Number(query['limit']);if(!Number.isInteger(limit)||limit<1||limit>100)fail('INVALID_CURSOR',422);
  const binding=hash({actor:actor._id,authz:actor.authzVersion,epoch:actor.authEpoch,organization:actor.organizationId,operation,limit});
  if(query['cursor']&&String(query['cursor']).length>512)fail('INVALID_CURSOR',422);
  const cursor=query['cursor']?this.decoded<{binding:string;last:string;cut:number;at:string}>(String(query['cursor'])):null;
  if(cursor&&(cursor.binding!==binding||!Number.isSafeInteger(cursor.cut)||cursor.cut>revision||typeof cursor.last!=='string'||!Number.isFinite(Date.parse(cursor.at))))fail('INVALID_CURSOR',422);
  const cut=cursor?.cut??revision,at=cursor?.at??new Date(this.identity.now()).toISOString();
  const itemKey=(x:Record<string,unknown>)=>String(x['id']??(String(x['loanId'])+':'+String(x['permittedDestinationId'])));
  const rows=items.filter(x=>(Number(x['__revision']??0)<=cut)&&(!x['__createdAt']||String(x['__createdAt'])<=at)).sort((a,b)=>itemKey(a)<itemKey(b)?-1:itemKey(a)>itemKey(b)?1:0).filter(x=>!cursor||itemKey(x)>cursor.last),page=rows.slice(0,limit);
  return{items:page.map(x=>Object.fromEntries(Object.entries(x).filter(([k])=>!k.startsWith('__')))),nextCursor:rows.length>limit?this.signed({binding,last:itemKey(page.at(-1)!),cut,at}):null};
 }
}
