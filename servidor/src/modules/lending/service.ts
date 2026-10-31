/* eslint-disable security/detect-object-injection -- Dynamic fields below are validated schema keys or closed server-owned sort/operation maps; no prototype traversal. */
import {randomUUID,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import type {ClientSession,Filter,Document} from 'mongodb';
import type {IdentityService} from '../identity/service.js';
import type {Identity,Context} from '../identity/models.js';
import type {Organization} from '../organizations/service.js';
import type {Account} from '../finance/models.js';
import {AppError} from '../../shared/errors.js';
import {lendingContract,canonical,hash,uuid,purposes,isLending} from './contract.js';
import {calculate,policy} from './calculator.js';
import {recordLendingEvidence} from './integrity.js';
import {domainCollection,beginEvidence,domainCollections,initializeEvidenceIndexes} from './evidence-v2.js';
import {verifyLoan,verifyQuote} from './verification.js';
import {quoteQuota} from './quota.js';
import type {Borrower,Schema,Profile,Field,Quote,Loan,Calculation,Terms,Dependencies,Result} from './models.js';

interface History extends Document {_id:string;organizationId:string;borrowerId?:string;profileVersion?:number;loanId?:string;termsVersion?:number}
interface Replay {_id:string;organizationId:string;actorId:string;operation:string;key:string;fingerprint:string;result:Result}
interface State {_id:string;value:number}
const etag=(id:string,version:number)=>`"${id}:${version}"`;
const nameKey=(s:string)=>s.trim().normalize('NFC').replace(/\s+/gu,' ').toLowerCase();
const publicRow=<T extends {_id:string}>(row:T)=>{const {_id,...rest}=row;return{id:_id,...rest};};
const calc=(q:Quote):Calculation=>({schedule:q.schedule,totals:q.totals,periodicRate24:q.periodicRate24,basePayment:q.basePayment,finalPaymentAdjustment:q.finalPaymentAdjustment,policyVersion:q.policyVersion,mathVersion:q.mathVersion,calendarVersion:q.calendarVersion});
const error=(status:number,code:string):never=>{throw new AppError(status,code);};
export class LendingService {
  readonly borrowers;readonly schemas;readonly quotes;readonly loans;readonly borrowerVersions;readonly loanVersions;readonly idempotency;readonly actions;readonly state;
  constructor(readonly identity:IdentityService,private readonly cursorKey:Buffer){
    const db=identity.database;this.borrowers=domainCollection<Borrower>(db,'lending_borrowers');this.schemas=domainCollection<Schema>(db,'lending_field_schemas');
    this.quotes=domainCollection<Quote>(db,'lending_quotes');this.loans=domainCollection<Loan>(db,'lending_loans');this.borrowerVersions=domainCollection<History>(db,'lending_borrower_versions');
    this.loanVersions=domainCollection<History>(db,'lending_loan_versions');this.idempotency=domainCollection<Replay>(db,'lending_idempotency');this.actions=domainCollection<{_id:string;organizationId:string;actorId:string;operation:string;resourceId:string|null;version:number|null;at:string}>(db,'lending_actions');this.state=domainCollection<State>(db,'lending_domain_state');
  }
  async initialize(){
    lendingContract();
    await initializeEvidenceIndexes(this.identity.database);
    await this.borrowers.createIndex({organizationId:1,borrowerCode:1},{unique:true});
    await this.borrowers.createIndex({organizationId:1,'profile.document.type':1,'profile.document.number':1},{unique:true,partialFilterExpression:{'profile.document.number':{$type:'string'}}});
    await this.borrowers.createIndex({organizationId:1,'openingBorrowerReference.openingId':1,'openingBorrowerReference.referenceId':1},{unique:true,partialFilterExpression:{'openingBorrowerReference.referenceId':{$type:'string'}}});
    await this.borrowers.createIndex({organizationId:1,nameKey:1});
    await this.schemas.createIndex({organizationId:1,schemaVersion:1},{unique:true});
    await this.borrowerVersions.createIndex({organizationId:1,borrowerId:1,profileVersion:1},{unique:true});
    await this.loanVersions.createIndex({organizationId:1,loanId:1,termsVersion:1},{unique:true});
    await this.loanVersions.createIndex({organizationId:1,quoteId:1},{unique:true});
    await this.loans.createIndex({organizationId:1,createdAt:1,_id:1});
    await this.idempotency.createIndex({organizationId:1,actorId:1,operation:1,key:1},{unique:true});
  }
  async actor(context:Context,orgId:string,session:ClientSession){
    await this.identity.requireOpen(context.realm);
    if(context.realm!=='TENANT')error(403,'ACCESS_DENIED');
    const {identity:actor}=await this.identity.sessions.requireOperational(context,session);
    if(actor.organizationId!==orgId)error(404,'RESOURCE_NOT_FOUND');
    if(!actor.roles.includes('T')||actor.roles.includes('SA')||actor.suspended)error(403,'ACCESS_DENIED');
    const org=await this.identity.database.db.collection<Organization>('organizations').findOne({_id:orgId,status:'ACTIVE'},{session});
    if(!org)error(403,'ACCESS_DENIED');
    return{actor,org:org!};
  }
  private async borrower(id:string,org:string,session:ClientSession){return await this.borrowers.findOne({_id:id,organizationId:org,ownerId:org},{session})??error(404,'RESOURCE_NOT_FOUND');}
  private async loan(id:string,org:string,session:ClientSession){return await this.loans.findOne({_id:id,organizationId:org,ownerId:org},{session})??error(404,'RESOURCE_NOT_FOUND');}
  async verifiedLoan(id:string,org:string,session:ClientSession){
    const loan=await this.loan(id,org,session);
    await this.quotes.findOne({_id:loan.quoteId,organizationId:org},{session});
    await this.loanVersions.findOne({organizationId:org,loanId:id,termsVersion:loan.termsVersion},{session});
    await verifyLoan(this.identity.database,loan,session);return loan;
  }
  private async schema(org:string,session:ClientSession):Promise<Schema>{
    return await this.schemas.findOne({organizationId:org},{session,sort:{schemaVersion:-1}})??{_id:org,organizationId:org,schemaVersion:1,fields:[],publishedAt:null,publishedBy:null,systemInitial:true};
  }
  private schemaData(s:Schema){const {_id,...rest}=s;void _id;return rest;}
  private async borrowerData(b:Borrower,session:ClientSession){
    const {_id,nameKey,...rest}=b;
    const duplicates=await this.borrowers.find({organizationId:b.organizationId,nameKey,_id:{$ne:_id}},{session}).sort({borrowerCode:1,_id:1}).limit(10).toArray();
    return{id:_id,...rest,possibleDuplicate:duplicates.length>0,duplicateCandidates:duplicates.map(d=>({id:d._id,borrowerCode:d.borrowerCode,displayName:d.profile.displayName}))};
  }
  private expected(id:string,version:number,header:string|undefined){if(!header)error(428,'ETAG_REQUIRED');if(etag(id,version)!==header)error(412,'PRECONDITION_FAILED');}
  async snapshot(purpose:string,resourceId:string|null,actor:Identity,session:ClientSession,command?:Record<string,unknown>|null){
    if(!isLending(purpose)||!command)error(422,'INPUT_INVALID');lendingContract().intent(purpose,resourceId,command);
    const orgId=uuid(command!['organizationId']);
    if(actor.realm!=='TENANT'||!actor.roles.includes('T')||actor.roles.includes('SA')||actor.suspended)error(403,'ACCESS_DENIED');
    if(actor.organizationId!==orgId)error(404,'RESOURCE_NOT_FOUND');
    const org=await this.identity.database.db.collection<Organization>('organizations').findOne({_id:orgId,status:'ACTIVE'},{session});if(!org)error(403,'ACCESS_DENIED');
    if(resourceId){if(purpose.startsWith('BORROWER_'))await this.borrower(resourceId,orgId,session);else await this.loan(resourceId,orgId,session);}
    return hash({purpose,resourceId,command,actorId:actor._id,actorAuthzVersion:actor.authzVersion,actorAuthEpoch:actor.authEpoch,credentialVersion:actor.credentialVersion,organizationEpoch:org!.authEpoch});
  }
  private async profile(profile:Profile,org:string,session:ClientSession){
    const schema=await this.schema(org,session);if(profile.schemaVersion!==schema.schemaVersion)error(409,'SCHEMA_EVOLUTION_CONFLICT');
    const fields=new Map(schema.fields.map(f=>[f.key,f]));
    for(const [key,value] of Object.entries(profile.extras)){
      const f=fields.get(key);if(!f||f.deprecated)error(422,'INPUT_INVALID');
      if(f!.type==='BOOLEAN'){if(typeof value!=='boolean')error(422,'INPUT_INVALID');}
      else {
        if(typeof value!=='string'||!value.length||value.length>240)error(422,'INPUT_INVALID');
        if(f!.type==='DATE'){const d=new Date(value+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(value as string)||!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==value)error(422,'INVALID_DATE');}
        if(f!.type==='ENUM'&&!f!.options?.some(o=>o.code===value))error(422,'INPUT_INVALID');
      }
    }
    if(profile.document)profile.document.number=profile.document.number.toUpperCase();
    lendingContract().validate('Profile',profile);return profile;
  }
  private evolution(prior:Field[],next:Field[]){
    const map=new Map(next.map(f=>[f.key,f]));if(map.size!==next.length)error(409,'SCHEMA_EVOLUTION_CONFLICT');
    for(const field of next)if(field.type==='ENUM'&&new Set(field.options!.map(o=>o.code)).size!==field.options!.length)error(409,'SCHEMA_EVOLUTION_CONFLICT');
    for(const old of prior){const n=map.get(old.key);if(!n||n.type!==old.type||old.deprecated&&!n.deprecated||old.type==='ENUM'&&old.options!.some(o=>!n.options!.some(v=>v.code===o.code)))error(409,'SCHEMA_EVOLUTION_CONFLICT');}
  }
  private async uniqueBorrower(b:Borrower,session:ClientSession){
    const other={organizationId:b.organizationId,_id:{$ne:b._id}};
    if(await this.borrowers.findOne({...other,borrowerCode:b.borrowerCode},{session}))error(409,'BORROWER_CODE_CONFLICT');
    if(b.profile.document&&await this.borrowers.findOne({...other,'profile.document.type':b.profile.document.type,'profile.document.number':b.profile.document.number},{session}))error(409,'BORROWER_DOCUMENT_CONFLICT');
    if(b.openingBorrowerReference){
      const link=b.openingBorrowerReference;
      const opening=await this.identity.opening?.files.findOne({_id:link.openingId,organizationId:b.organizationId,ownerId:b.organizationId,status:'POSTED'},{session});
      if(!opening||!opening.snapshot.references.some(r=>r.id===link.referenceId&&r.type==='BORROWER'))error(404,'RESOURCE_NOT_FOUND');
      if(await this.borrowers.findOne({...other,'openingBorrowerReference.openingId':link.openingId,'openingBorrowerReference.referenceId':link.referenceId},{session}))error(409,'OPENING_REFERENCE_CONFLICT');
    }
  }
  private async dependencies(t:Terms,actor:Identity,org:Organization,session:ClientSession):Promise<Dependencies>{
    const b=await this.borrower(t.borrowerId,org._id,session);if(b.status!=='ACTIVE')error(422,'INPUT_INVALID');
    const account=await this.identity.database.db.collection<Account>('financial_accounts').findOne({_id:t.plannedFundingAccountId,organizationId:org._id,bookId:org._id,ownerId:org._id,financialScope:'BUSINESS'},{session});
    if(!account)error(404,'RESOURCE_NOT_FOUND');
    if(account!.status!=='ACTIVE'||account!.accountClass!=='ASSET'||!['CASH','BANK'].includes(account!.kind)||account!.currency!=='COP')error(422,'INPUT_INVALID');
    return{borrowerVersion:b.version,profileVersion:b.profileVersion,schemaVersion:(await this.schema(org._id,session)).schemaVersion,fundingAccountVersion:account!.version,organizationEpoch:org.authEpoch,actorAuthzVersion:actor.authzVersion,actorAuthEpoch:actor.authEpoch,credentialVersion:actor.credentialVersion,policyVersion:policy.policyVersion};
  }
  private async currentQuote(payload:Record<string,unknown>,actor:Identity,org:Organization,session:ClientSession){
    const q=await this.quotes.findOne({_id:payload['quoteId'] as string,organizationId:org._id},{session});if(!q)error(404,'RESOURCE_NOT_FOUND');
    verifyQuote(q!);
    if(q!.actorId!==actor._id||q!.fingerprint!==payload['quoteFingerprint'])error(409,'QUOTE_BINDING_MISMATCH');
    if(this.identity.now()>=Date.parse(q!.expiresAt))error(409,'QUOTE_EXPIRED');
    let deps:Dependencies;
    try{deps=await this.dependencies(q!.terms,actor,org,session);}catch(e){if(e instanceof AppError&&[404,422].includes(e.status))error(409,'QUOTE_STALE');throw e;}
    if(hash(deps!)!==hash(q!.dependencies))error(409,'QUOTE_STALE');return q!;
  }
  async mutate(context:Context,operation:string,organization:string,input:unknown,keyValue:unknown,idValue?:string,ifMatch?:string):Promise<Result>{
    const orgId=uuid(organization),id=idValue?uuid(idValue):null,key=uuid(keyValue),purpose=purposes.get(operation);
    if(!purpose&&operation!=='createLoanQuote')error(422,'INPUT_INVALID');
    try{return await this.identity.database.transaction(async session=>{
      const {actor,org}=await this.actor(context,orgId,session);
      await beginEvidence(this.identity.database,session,orgId);
      if(Buffer.byteLength(JSON.stringify(input)??'','utf8')>65536)error(413,'INPUT_TOO_LARGE');
      const raw=input as {terms?:Terms}|null;
      if(operation==='createLoanQuote'&&raw?.terms){if(raw.terms.usage==='REAL')error(403,'REAL_USE_NOT_ALLOWED');if(raw.terms.policyVersion!==policy.policyVersion||raw.terms.jurisdiction!=='CO')error(422,'POLICY_UNSUPPORTED');}
      lendingContract().validate(operation,input);const payload=canonical(input) as Record<string,unknown>;lendingContract().validate(operation,payload);
      const command={organizationId:orgId,idempotencyKey:key,payload,...(ifMatch?{expectedETag:ifMatch}:{})};
      if(id||operation==='publishBorrowerSchema'){if(!ifMatch)error(428,'ETAG_REQUIRED');}
      // Security transaction_fence serializes legitimate authority/account changes; this separate fence serializes S4 state only.
      await this.state.updateOne({_id:orgId},{$inc:{value:1}},{upsert:true,session});
      if(purpose){try{await this.identity.sessions.consumeProof(context,purpose,id,session,command);}catch(e){if(e instanceof AppError&&e.code==='REAUTH_REQUIRED')error(403,'R_REQUIRED');throw e;}}
      const fingerprint=hash({operation,id,command}),previous=await this.idempotency.findOne({organizationId:orgId,actorId:actor._id,operation,key},{session});
      let result:Result;
      if(previous){if(previous.fingerprint!==fingerprint)error(409,'IDEMPOTENCY_CONFLICT');result={...previous.result,status:200};}
      else {
        if(operation==='createLoanQuote')await quoteQuota(this.identity,actor._id,orgId,session);
        result=await this.apply(operation,payload,org,actor,id,ifMatch,session);
        lendingContract().result(operation,result.status,{data:result.data,requestId:randomUUID()});
        await this.idempotency.insertOne({_id:randomUUID(),organizationId:orgId,actorId:actor._id,operation,key,fingerprint,result},{session});
      }
      const version=(result.data as {version?:number}).version??null;
      await this.actions.insertOne({_id:randomUUID(),organizationId:orgId,actorId:actor._id,operation:(previous?'REPLAY_':'')+operation,resourceId:id??(result.data as {id?:string}).id??null,version,at:new Date(this.identity.now()).toISOString()},{session});
      await recordLendingEvidence(this.identity.database,session);
      await this.identity.audit.append({realm:'TENANT',actorId:actor._id,subjectId:actor._id,action:'LENDING_'+(previous?'REPLAY':operation),outcome:'SUCCESS',lending:{operation,id:id??(result.data as {id?:string}).id??null,version}},session);
      return result;
    });}catch(e){
      if(e&&typeof e==='object'&&'code'in e&&e.code===11000){
        const keyPattern='keyPattern'in e?e.keyPattern as Record<string,unknown>:{};
        error(409,'borrowerCode'in keyPattern?'BORROWER_CODE_CONFLICT':'profile.document.number'in keyPattern?'BORROWER_DOCUMENT_CONFLICT':'openingBorrowerReference.referenceId'in keyPattern?'OPENING_REFERENCE_CONFLICT':'quoteId'in keyPattern?'QUOTE_ALREADY_USED':'STATE_CONFLICT');
      }throw e;
    }
  }
  async importCommand(context:Context,operation:'createBorrower'|'createLoanDraft',orgId:string,input:unknown,assignedId:string,s:ClientSession){
    if(!s.inTransaction())error(503,'SERVICE_UNAVAILABLE');lendingContract().validate(operation,input);const p=canonical(input) as Record<string,unknown>;lendingContract().validate(operation,p);const {actor,org}=await this.actor(context,orgId,s);await beginEvidence(this.identity.database,s,orgId);
    await this.state.updateOne({_id:orgId},{$inc:{value:1}},{session:s,upsert:true});return await this.apply(operation,p,org,actor,null,undefined,s,assignedId);
  }
  private async apply(op:string,p:Record<string,unknown>,org:Organization,actor:Identity,id:string|null,ifMatch:string|undefined,s:ClientSession,assignedId?:string):Promise<Result>{
    const at=new Date(this.identity.now()).toISOString(),organizationId=org._id;
    if(op==='publishBorrowerSchema'){
      const prior=await this.schema(organizationId,s);this.expected(organizationId,prior.schemaVersion,ifMatch);const fields=p['fields'] as Field[];this.evolution(prior.fields,fields);
      const row:Schema={_id:randomUUID(),organizationId,schemaVersion:prior.schemaVersion+1,fields,publishedAt:at,publishedBy:actor._id,systemInitial:false};
      await this.schemas.insertOne(row,{session:s});return{status:200,data:this.schemaData(row),etag:etag(organizationId,row.schemaVersion)};
    }
    if(op==='createBorrower'||op==='replaceBorrower'||op==='deactivateBorrower'||op==='reactivateBorrower'){
      const b:Borrower=op==='createBorrower'?{_id:assignedId??randomUUID(),organizationId,ownerId:organizationId,borrowerCode:p['borrowerCode'] as string,status:'ACTIVE',version:1,profileVersion:1,profile:await this.profile(p['profile'] as Profile,organizationId,s),nameKey:'',createdAt:at,updatedAt:at,...(p['openingBorrowerReference']?{openingBorrowerReference:p['openingBorrowerReference'] as Borrower['openingBorrowerReference']&{}}:{})}:await this.borrower(id!,organizationId,s);
      if(op!=='createBorrower'){
        this.expected(b._id,b.version,ifMatch);
        if(op==='replaceBorrower'){b.profile=await this.profile(p['profile'] as Profile,organizationId,s);b.profileVersion++;}
        else {const target=op==='deactivateBorrower'?'INACTIVE':'ACTIVE';if(b.status===target)error(409,'STATE_CONFLICT');b.status=target;}
        b.version++;b.updatedAt=at;
      }
      b.nameKey=nameKey(b.profile.displayName);await this.uniqueBorrower(b,s);
      if(op==='createBorrower')await this.borrowers.insertOne(b,{session:s});else await this.borrowers.replaceOne({_id:b._id,version:b.version-1},b,{session:s});
      if(op==='createBorrower'||op==='replaceBorrower')await this.borrowerVersions.insertOne({_id:randomUUID(),organizationId,borrowerId:b._id,profileVersion:b.profileVersion,profile:b.profile,createdAt:at,createdBy:actor._id,...(p['changeReason']?{changeReason:p['changeReason']}:{})},{session:s});
      return{status:op==='createBorrower'?201:200,data:await this.borrowerData(b,s),etag:etag(b._id,b.version)};
    }
    if(op==='createLoanQuote'){
      const terms=p['terms'] as Terms,calculation=calculate(terms),dependencies=await this.dependencies(terms,actor,org,s);
      const content={id:randomUUID(),organizationId,actorId:actor._id,createdAt:at,expiresAt:new Date(this.identity.now()+900000).toISOString(),terms,dependencies,...calculation};
      const {id,...rest}=content;const q:Quote={_id:id,...rest,fingerprint:hash(content)};
      await this.quotes.insertOne(q,{session:s});return{status:201,data:publicRow(q)};
    }
    let loan:Loan;
    if(op==='createLoanDraft'){
      const q=await this.currentQuote(p,actor,org,s);
      if(await this.loanVersions.findOne({organizationId,quoteId:q._id},{session:s}))error(409,'QUOTE_ALREADY_USED');
      loan={_id:assignedId??randomUUID(),organizationId,ownerId:organizationId,borrowerId:q.terms.borrowerId,status:'DRAFT',version:1,termsVersion:1,terms:q.terms,quoteId:q._id,quoteFingerprint:q.fingerprint,calculation:calc(q),confirmation:null,createdAt:at,updatedAt:at,...(p['note']?{note:p['note'] as string}:{})};
    } else {
      loan=await this.verifiedLoan(id!,organizationId,s);this.expected(loan._id,loan.version,ifMatch);
      if(await this.identity.database.db.collection<{_id:string;loanId:string}>('loan_positions').findOne({loanId:loan._id},{session:s}))error(409,'STATE_CONFLICT');
      if(loan.status==='CANCELLED')error(409,'STATE_CONFLICT');
      if(op==='replaceLoanTerms'){
        const q=await this.currentQuote(p,actor,org,s);
        if(q.terms.borrowerId!==loan.borrowerId)error(409,'QUOTE_BINDING_MISMATCH');
        if(await this.loanVersions.findOne({organizationId,quoteId:q._id},{session:s}))error(409,'QUOTE_ALREADY_USED');
        loan.termsVersion++;loan.terms=q.terms;loan.quoteId=q._id;loan.quoteFingerprint=q.fingerprint;loan.calculation=calc(q);loan.status='DRAFT';loan.confirmation=null;
      }else if(op==='confirmLoanTerms'){
        if(loan.status!=='DRAFT')error(409,'STATE_CONFLICT');
        if(loan.termsVersion!==p['termsVersion']||loan.quoteId!==p['quoteId']||loan.quoteFingerprint!==p['quoteFingerprint'])error(409,'QUOTE_BINDING_MISMATCH');
        await this.currentQuote(p,actor,org,s);loan.status='TERMS_CONFIRMED';loan.confirmation={actorId:actor._id,confirmedAt:at,quoteId:loan.quoteId,quoteFingerprint:loan.quoteFingerprint,termsVersion:loan.termsVersion};
      }else if(op==='cancelLoan'){loan.status='CANCELLED';loan.cancellation={reason:p['reason'] as string,cancelledAt:at,actorId:actor._id};}
      else error(422,'INPUT_INVALID');
      loan.version++;loan.updatedAt=at;
    }
    if(op==='createLoanDraft')await this.loans.insertOne(loan,{session:s});else await this.loans.replaceOne({_id:loan._id,version:loan.version-1},loan,{session:s});
    if(op==='createLoanDraft'||op==='replaceLoanTerms')await this.loanVersions.insertOne({_id:randomUUID(),organizationId,loanId:loan._id,termsVersion:loan.termsVersion,terms:loan.terms,quoteId:loan.quoteId,quoteFingerprint:loan.quoteFingerprint,calculation:loan.calculation,createdAt:at,createdBy:actor._id,...(p['changeReason']?{changeReason:p['changeReason']}:{})},{session:s});
    return{status:op==='createLoanDraft'?201:200,data:publicRow(loan),etag:etag(loan._id,loan.version)};
  }
  private cursor(binding:string,last:unknown[]){const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.cursorKey,nonce),data=Buffer.concat([cipher.update(JSON.stringify({binding,last})),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),data]).toString('base64url');}
  private uncursor(token:string,binding:string):[string|number,string]{
    try{if(token.length>2048||!/^[A-Za-z0-9_-]+$/.test(token))error(422,'INVALID_CURSOR');const bytes=Buffer.from(token,'base64url'),d=createDecipheriv('aes-256-gcm',this.cursorKey,bytes.subarray(0,12));d.setAuthTag(bytes.subarray(12,28));const body=JSON.parse(Buffer.concat([d.update(bytes.subarray(28)),d.final()]).toString()) as {binding:string;last:[string|number,string]};if(body.binding!==binding||!Array.isArray(body.last)||body.last.length!==2||!['string','number'].includes(typeof body.last[0])||typeof body.last[1]!=='string')error(422,'INVALID_CURSOR');return body.last;}catch{return error(422,'INVALID_CURSOR');}
  }
  async read(context:Context,operation:string,organization:string,idValue?:string,query:Record<string,unknown>={},versionValue?:string):Promise<Result>{
    const orgId=uuid(organization),id=idValue?uuid(idValue):null;
    return await this.identity.database.transaction(async s=>{
      const {actor,org}=await this.actor(context,orgId,s);
      if(operation==='getLendingPolicy')return{status:200,data:policy};
      if(operation==='getCurrentBorrowerSchema'||operation==='getBorrowerSchema'){
        const current=await this.schema(orgId,s),v=operation==='getCurrentBorrowerSchema'?current.schemaVersion:Number(versionValue);
        const schema=v===1?{_id:orgId,organizationId:orgId,schemaVersion:1,fields:[],publishedAt:null,publishedBy:null,systemInitial:true} as Schema:await this.schemas.findOne({organizationId:orgId,schemaVersion:v},{session:s});
        if(!schema)error(404,'RESOURCE_NOT_FOUND');return{status:200,data:this.schemaData(schema!),etag:etag(orgId,v)};
      }
      if(operation==='getBorrower'){const b=await this.borrower(id!,orgId,s);return{status:200,data:await this.borrowerData(b,s),etag:etag(b._id,b.version)};}
      if(operation==='getLoan'){const l=await this.loan(id!,orgId,s);return{status:200,data:publicRow(l),etag:etag(l._id,l.version)};}
      if(operation==='getLoanQuote'){const q=await this.quotes.findOne({_id:id!,organizationId:orgId},{session:s});if(!q)error(404,'RESOURCE_NOT_FOUND');return{status:200,data:publicRow(q!)};}
      const borrowerHistory=operation.includes('BorrowerVersion'),loanHistory=operation.includes('LoanVersion');
      if(borrowerHistory)await this.borrower(id!,orgId,s);if(loanHistory)await this.loan(id!,orgId,s);
      if(operation==='getBorrowerVersion'||operation==='getLoanVersion'){
        const row=await(borrowerHistory?this.borrowerVersions:this.loanVersions).findOne({organizationId:orgId,...(borrowerHistory?{borrowerId:id!,profileVersion:Number(versionValue)}:{loanId:id!,termsVersion:Number(versionValue)})},{session:s});
        if(!row)error(404,'RESOURCE_NOT_FOUND');return{status:200,data:publicRow(row!)};
      }
      const limit=query['limit']===undefined?20:Number(query['limit']);if(!Number.isInteger(limit)||limit<1||limit>100)error(422,'INPUT_INVALID');
      if(!['listBorrowers','listLoans','listBorrowerVersions','listLoanVersions'].includes(operation))error(422,'INPUT_INVALID');
      const binding=hash({operation,id,orgId,actorId:actor._id,authz:actor.authzVersion,epoch:org.authEpoch,authEpoch:actor.authEpoch,limit,status:query['status']??null,q:query['q']??null,borrowerId:query['borrowerId']??null});
      const filter:Filter<History>={organizationId:orgId};
      if(query['status'])filter['status']=query['status'];
      if(query['borrowerId'])filter.borrowerId=uuid(query['borrowerId']);
      if(borrowerHistory)filter.borrowerId=id!;if(loanHistory)filter.loanId=id!;
      if(query['q']){const escaped=String(query['q']).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');filter['$or']=[{borrowerCode:{$regex:escaped,$options:'i'}},{'profile.displayName':{$regex:escaped,$options:'i'}}];}
      const sort=operation==='listBorrowers'?'borrowerCode':borrowerHistory?'profileVersion':loanHistory?'termsVersion':'createdAt';
      if(query['cursor']){const last=this.uncursor(String(query['cursor']),binding);filter['$and']=[{$or:[{[sort]:{$gt:last[0]}},{[sort]:last[0],_id:{$gt:last[1]}}]}];}
      const collection=operation==='listBorrowers'?this.borrowers:borrowerHistory?this.borrowerVersions:loanHistory?this.loanVersions:this.loans;
      const found=await domainCollection<History>(this.identity.database,collection.collectionName as typeof domainCollections[number]).find(filter,{session:s}).sort({[sort]:1,_id:1}).limit(limit+1).toArray();
      const selected=found.slice(0,limit),last=selected.at(-1),items=[];
      for(const row of selected)items.push(operation==='listBorrowers'?await this.borrowerData(row as unknown as Borrower,s):publicRow(row));
      return{status:200,data:{items,nextCursor:found.length>limit&&last?this.cursor(binding,[last[sort],last._id]):null}};
    });
  }
}
