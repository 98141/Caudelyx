import {AsyncLocalStorage} from 'node:async_hooks';
import {createCipheriv,createDecipheriv,createHmac,randomBytes,createHash} from 'node:crypto';
import type {ClientSession} from 'mongodb';
import type {IdentityService} from '../identity/service.js';
import type {Identity} from '../identity/models.js';
import type {Organization} from '../organizations/service.js';
import type {Intent} from './operations-models.js';
import {beginEvidence} from './evidence-v2.js';
import type {Row,Scope} from '../obligations/models.js';
import {emailVerified} from '../identity/onboarding.js';
import {hash} from './contract.js';
import {today} from '../finance/service.js';
import {AppError} from '../../shared/errors.js';
import {assertMonthlyHistory,msCents,msRate} from './ms-engine.js';
import {isMonthlyLoan,type MonthlyLoan} from './ms-models.js';

interface MsAuthorization {
 kind:'HISTORY'|'MANDATE';organizationId:string;actorId:string;authz:string;authEpoch:string;credential:string;orgEpoch:string;
 requestHash:string;executionKey:string;expiresAt:number;originReference:string;mandateId:string|null;
}
interface Permit {organizationId:string;effectiveDate:string;eventId:string;transaction:string;originReference:string;executionKey:string;requestHash:string;kind:string;consumed:boolean}
const configured=new WeakMap<IdentityService,Buffer>(),context=new AsyncLocalStorage<string>(),permits=new WeakMap<ClientSession,Permit>();
const fail=(code:string,status=409):never=>{throw new AppError(status,code);};
export function configureMsAuthorization(identity:IdentityService,key:Buffer){
 const derived=createHmac('sha256',key).update('CAUDELYX:MS:EXECUTION:1').digest(),old=configured.get(identity);
 if(old&&!old.equals(derived))throw Error('MS authorization key change');if(!old)configured.set(identity,derived);
}
function keyFor(identity:IdentityService){const key=configured.get(identity);if(!key)return fail('SERVICE_UNAVAILABLE',503);return key;}
export function encryptMsToken(identity:IdentityService,value:unknown,purpose:string){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',keyFor(identity),iv);cipher.setAAD(Buffer.from('MS1:'+purpose));const body=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url');
}
export function decryptMsToken<T>(identity:IdentityService,token:string,purpose:string):T{
 try{if(token.length<40||token.length>32768)throw Error('token');const b=Buffer.from(token,'base64url');if(!Buffer.from(b.toString('base64url')).equals(Buffer.from(token)))throw Error('token');const d=createDecipheriv('aes-256-gcm',keyFor(identity),b.subarray(0,12));d.setAAD(Buffer.from('MS1:'+purpose));d.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8')) as T;}catch{return fail('INPUT_INVALID',422);}
}
export function issueMsExecution(identity:IdentityService,actor:Identity,org:Organization,intent:Intent,executionKey:string,originReference:string,kind:'HISTORY'|'MANDATE',mandateId:string|null=null){
 const value:MsAuthorization={kind,organizationId:org._id,actorId:actor._id,authz:actor.authzVersion,authEpoch:actor.authEpoch,credential:actor.credentialVersion,orgEpoch:org.authEpoch,requestHash:hash(intent),executionKey,expiresAt:identity.now()+300000,originReference:originReference.trim().normalize('NFC'),mandateId};
 return encryptMsToken(identity,value,'EXECUTION');
}
export const withMsExecution=<T>(token:string,work:()=>Promise<T>)=>context.run(token,work);
export function msHistoryReferenceValid(identity:IdentityService,reference:unknown){
 const token=context.getStore();if(!token||typeof reference!=='string')return false;const a=decryptMsToken<MsAuthorization>(identity,token,'EXECUTION');return a.kind==='HISTORY'&&a.expiresAt>identity.now()&&reference===hash(a.originReference);
}
const transaction=(s:ClientSession)=>s.serverSession.txnNumber.toString();
export function msPastPermitted(s:ClientSession,org:string,date:string,eventId?:string){
 const p=permits.get(s);return Boolean(p&&p.transaction===transaction(s)&&p.organizationId===org&&p.effectiveDate===date&&(!eventId||p.eventId===eventId));
}
export async function authorizeMsExecution(identity:IdentityService,actor:Identity,org:Organization,intent:Intent,executionKey:string,eventId:string,s:ClientSession){
 const encoded=context.getStore();if(!encoded){if(intent.effectiveDate!==today(identity.now()))fail('INPUT_INVALID',422);return;}
 const a=decryptMsToken<MsAuthorization>(identity,encoded,'EXECUTION');
 if(a.expiresAt<=identity.now()||a.organizationId!==org._id||a.actorId!==actor._id||a.authz!==actor.authzVersion||a.authEpoch!==actor.authEpoch||a.credential!==actor.credentialVersion||a.orgEpoch!==org.authEpoch||a.executionKey!==executionKey||a.requestHash!==hash(intent))fail('MANDATE_INVALID',403);
 const current=await identity.identities.findOne({_id:actor._id,realm:'TENANT',organizationId:org._id,authzVersion:a.authz,authEpoch:a.authEpoch,credentialVersion:a.credential,suspended:false,roles:{$in:['T']}},{session:s});
 const tenant=await identity.database.db.collection<Organization>('organizations').findOne({_id:org._id,status:'ACTIVE',authEpoch:a.orgEpoch},{session:s});
 if(!current||!emailVerified(current)||current.roles.includes('SA')||!tenant||['RECOVERY_RESTRICTED','FACTOR_LOSS_BLOCKED'].includes(current.state)||current.hasEverConfirmedFactor&&current.factorCount===0)fail('ACCESS_DENIED',403);
 const unit=await beginEvidence(identity.database,s,org._id),loanIds=intent.kind==='ACCRUE'||intent.kind==='DISBURSE'?[intent.loanId]:intent.targets.map(t=>t.loanId),loans=await unit.query('lending_monthly_loans',{organizationId:org._id,_id:{$in:loanIds}},{},11) as unknown as MonthlyLoan[];
 if(loans.length!==loanIds.length||loans.some(l=>!isMonthlyLoan(l)))fail('VARIANT_UNSUPPORTED',422);
 if(!identity.obligations?.active)fail('SERVICE_UNAVAILABLE',503);
 const scope:Scope={kind:'BUSINESS',bookId:org._id,ownerId:org._id,organizationId:org._id},store=identity.obligations!.store;
 if(a.kind==='MANDATE'){
  if(intent.kind!=='ACCRUE'||loans.length!==1||!a.mandateId)fail('MANDATE_INVALID',403);
  const m=(await store.all<Row>('ms_mandates',scope,s)).find(v=>v._id===a.mandateId),loan=loans[0]!;
  const position=(await unit.query('loan_positions',{organizationId:org._id,loanId:loan._id},{},1))[0] as unknown as import('./operations-models.js').Position|undefined;
  if(!m||!position?.monthlyState||position.monthlyState.rateVersions.some(v=>v.effectiveFrom<=intent.effectiveDate&&msRate(v.rate)>msRate(String(m?.['rateCeiling']))))fail('MANDATE_INVALID',403);
  if(!m||m['status']!=='ACTIVE'||m['loanId']!==loan._id||m['termsVersion']!==loan.termsVersion||m['restoreEpoch']!==store.restoreEpoch||!identity.database.monthlyRestoreBinding||m['restoreBinding']!==identity.database.monthlyRestoreBinding()||m['actorId']!==actor._id||m['actorAuthz']!==actor.authzVersion||m['actorAuthEpoch']!==actor.authEpoch||m['credentialVersion']!==actor.credentialVersion||m['orgEpoch']!==org.authEpoch||intent.effectiveDate<String(m['fromDate'])||intent.effectiveDate>String(m['untilDate'])||msCents(loan.terms.principal)>msCents(String(m['principalCeiling']))||msRate(loan.terms.monthlyRate)>msRate(String(m['rateCeiling']))||!await identity.sessions.factors.findOne({_id:String(m['factorId']),subjectId:actor._id,realm:'TENANT',state:'ACTIVE'},{session:s}))fail('MANDATE_INVALID',403);
 }else{
  const policy=(await store.all<Row>('ms_closure_policies',scope,s))[0];
  if(!policy||intent.effectiveDate<String(policy['knownFrom']))fail('PERIOD_CLOSURE_UNAVAILABLE');
  const cut=await identity.database.db.collection<{_id:string;cutoffDate?:string;openingId?:string}>('financial_books').findOne({_id:org._id},{session:s});
  const future=await identity.finance!.journals.find({organizationId:org._id,effectiveDate:{$gte:intent.effectiveDate}},{session:s}).limit(1001).toArray();
  const originHash=hash(a.originReference),existing=(await store.all<Row>('ms_history_claims',scope,s)).filter(v=>v['originHash']===originHash);
  const route=assertMonthlyHistory({effectiveDate:intent.effectiveDate,today:today(identity.now()),cutoffDate:cut?.openingId?cut.cutoffDate??null:null,closedPeriods:policy!['closedPeriods'] as {from:string;to:string}[],duplicate:existing.length>0,affectedFacts:future.length,incompatible:false,availabilityByDate:[]});
  if(route!=='ECONOMIC')fail('OPENING_CUTOFF_CONFLICT');
 }
 permits.set(s,{organizationId:org._id,effectiveDate:intent.effectiveDate,eventId,transaction:transaction(s),originReference:a.originReference,executionKey,requestHash:a.requestHash,kind:a.kind,consumed:false});
}
export async function commitMsHistoryClaim(identity:IdentityService,s:ClientSession,org:string,date:string,eventId:string){
 const p=permits.get(s);if(!p||!msPastPermitted(s,org,date,eventId))return;
 const originHash=hash(p.originReference),id=createHash('sha256').update(org+':'+originHash).digest('hex');
 const management=identity.obligations!;if(!management.active)fail('SERVICE_UNAVAILABLE',503);
 const scope:Scope={kind:'BUSINESS',bookId:org,ownerId:org,organizationId:org},own=!management.store.tracking.active.has(s);
 if(own)management.store.tracking.begin(s);
 try{
  await management.ensureBook(scope,s);
  await management.store.put('ms_history_claims',{_id:id,bookId:org,ownerId:org,domainKind:'BUSINESS',version:1,originHash,eventId,effectiveDate:date,executionKey:p.executionKey,requestHash:p.requestHash,kind:p.kind},s);
  await management.store.touch(scope,s);if(own)await management.store.finish(s);
 }finally{if(own)management.store.tracking.end(s);}
}
