/* eslint-disable security/detect-object-injection -- Closed operation/namespace catalogs and validated signed row fields. */
import {randomUUID} from 'node:crypto';
import type {ClientSession} from 'mongodb';
import type {IdentityService} from '../identity/service.js';
import type {Context,Identity} from '../identity/models.js';
import {cents,money} from '../finance/money.js';
import {effectiveReserves} from '../collections/funds.js';
import {personalActor,resolveScope,grant} from '../obligations/authority.js';
import {hash} from '../obligations/codec.js';
import {verifyRow} from '../obligations/evidence.js';
import {booksTable,commands,table,etag,type Book,type Result} from '../obligations/models.js';
import {signedCents,amountReader,wealthTable,wealthOriginals,type Scope,type Row,type Data,type Fund,type Asset,type Claim,type WealthEvent,type WealthContext} from './models.js';
import {wealthContract,canonical} from './contract.js';
import {fundCommand,fail,stageFundEffects} from './funds.js';
import {assetCommand} from './assets.js';
import {externalCommand} from './sources.js';
import {wealthRead,mutationView} from './queries.js';
export class WealthService {
 readonly management:NonNullable<IdentityService['obligations']>;
 readonly catalogFingerprint=hash({contract:wealthContract().document,catalogVersion:2,policyVersion:'S10-CO-1.0',schemaVersion:'1.0.0'});
 constructor(readonly identity:IdentityService,readonly key:Buffer){
  wealthContract();if(!identity.obligations)throw Error('Management runtime required');this.management=identity.obligations;
  this.management.store.validateBook=async(book,rows,s)=>{await this.guard({kind:book.domainKind,bookId:book.bookId,ownerId:book.ownerId,...(book.domainKind==='BUSINESS'?{organizationId:book.bookId}:{})},s,rows);};
  const db=identity.database;
  db.wealthReserves=async(bookId,s,cut,known)=>{
   const scope=await this.existingScope(bookId,s);if(!scope)return[];
   const funds=await this.management.store.all<Fund>(wealthTable(scope.kind,'funds'),scope,s),amounts=await this.reserved(scope,s,cut,known);
   return funds.map(f=>({paymentId:f._id,accountId:f.backingAccountId,amount:money(amounts.get(f._id)??0n),effectiveDate:cut??'0001-01-01'})).filter(r=>r.amount!=='0.00');
  };
  db.wealthGuard=async(scope,s)=>{await this.guard(scope,s);};
  db.wealthAssertReversible=async(scope,id,s)=>{
   if(!await this.existingScope(scope.bookId,s))return;
   const claims=await this.management.store.all<Claim>(wealthTable(scope.kind,'source_claims'),scope,s);
   if(claims.some(c=>c.journalId===id&&c.status==='CLAIMED'))fail(409,'REVERSAL_DEPENDENCY');
   const links=await this.management.store.all<Row>(wealthTable(scope.kind,'asset_flow_links'),scope,s),events=await this.management.store.all<import('../obligations/models.js').Event>(table(scope.kind,'events'),scope,s);
   const assets=await this.management.store.all<Asset>(wealthTable(scope.kind,'assets'),scope,s);
   if(assets.some(a=>a.status==='ACTIVE'&&a.liabilityIds.some(liabilityId=>events.some(e=>e.entityId===liabilityId&&e.kind==='LIABILITY_ACTIVATE'&&e.journalIds.includes(id)))))fail(409,'REVERSAL_DEPENDENCY');
   if(links.some(l=>l['status']==='ACTIVE'&&events.some(e=>e._id===l['sourceEventId']&&e.journalIds.includes(id))))fail(409,'REVERSAL_DEPENDENCY');
  };
  db.wealthBeforeCommit=async(s,changes)=>{for(const org of changes.organizations)await this.guard({kind:'BUSINESS',bookId:org,ownerId:org,organizationId:org},s);};
 }
 async prepareOwned(verifyOwnership:()=>Promise<boolean>){
  const db=this.identity.database,hosts=db.client.options.hosts;if(!/^caudelyx_(?:s08_p02|s09_p02)_[a-f0-9]{24}$/.test(db.db.databaseName)||hosts.length!==1||!['localhost','127.0.0.1'].includes(hosts[0]?.host??'')||hosts[0]?.port!==27017||!await verifyOwnership()||this.management.active)fail(403,'ACCESS_DENIED');
  for(const kind of ['BUSINESS','PERSONAL'] as const){
   for(const name of ['fund_events','asset_events'] as const){await db.db.collection(wealthTable(kind,name)).createIndex({bookId:1,entityId:1,effectiveDate:1,unitKnownAt:1,_id:1});await db.db.collection(wealthTable(kind,name)).createIndex({bookId:1,reversalOfId:1},{unique:true,partialFilterExpression:{reversalOfId:{$type:'string'}}});}
   await db.db.collection(wealthTable(kind,'asset_versions')).createIndex({bookId:1,assetId:1,version:1},{unique:true});await db.db.collection(wealthTable(kind,'asset_valuations')).createIndex({bookId:1,assetId:1,valuationDate:1,recordedAt:1,_id:1});
   await db.db.collection(wealthTable(kind,'source_claims')).createIndex({bookId:1,sourceKind:1,sourceId:1,lineIndex:1,assetId:1},{unique:true,partialFilterExpression:{status:'CLAIMED'}});await db.db.collection(wealthTable(kind,'asset_flow_links')).createIndex({bookId:1,sourceEventId:1},{unique:true,partialFilterExpression:{status:'ACTIVE'}});
  }
 }
 private async existingScope(id:string,s:ClientSession):Promise<Scope|null>{
  const row=await this.identity.database.db.collection<Book>(booksTable).findOne({_id:id},{session:s});if(!row)return null;
  if(!verifyRow(this.identity.database,booksTable,row))fail(503,'INTEGRITY_MISMATCH');return{kind:row.domainKind,bookId:id,ownerId:row.ownerId,...(row.domainKind==='BUSINESS'?{organizationId:id}:{})};
 }
 async events(scope:Scope,s:ClientSession){return [...await this.management.store.all<WealthEvent>(wealthTable(scope.kind,'fund_events'),scope,s),...await this.management.store.all<WealthEvent>(wealthTable(scope.kind,'asset_events'),scope,s)];}
 async fundEvents(scope:Scope,s:ClientSession){return await this.management.store.all<WealthEvent>(wealthTable(scope.kind,'fund_events'),scope,s);}
 async reserved(scope:Scope,s:ClientSession,date='9999-12-31',known='9999-12-31T23:59:59.999Z'){
  const values=new Map<string,bigint>();for(const e of await this.fundEvents(scope,s))if(e.effectiveDate<=date&&e.unitKnownAt<=known)for(const d of e.deltas)values.set(d.fundId,(values.get(d.fundId)??0n)+signedCents(d.delta));
  if([...values.values()].some(n=>n<0n))fail(409,'RESERVATION_CONFLICT');return values;
 }
 async guard(scope:Scope,s:ClientSession,verified?:Map<string,Row[]>){
  if(!await this.existingScope(scope.bookId,s))return;
  const load=async<T extends Row>(name:string)=>{const rows=verified?.get(name);if(rows){if(rows.some(r=>r.ownerId!==scope.ownerId||r.domainKind!==scope.kind))fail(503,'INTEGRITY_MISMATCH');return rows as T[];}return await this.management.store.all<T>(name,scope,s);};
  const fundEvents=await load<WealthEvent>(wealthTable(scope.kind,'fund_events')),events=[...fundEvents,...await load<WealthEvent>(wealthTable(scope.kind,'asset_events'))],fundEventSet=new Set(fundEvents),assets=await load<Asset>(wealthTable(scope.kind,'assets')),funds=await load<Fund>(wealthTable(scope.kind,'funds'));if(!events.length&&!assets.length&&!funds.length)return;
  if(!this.management.active&&!verified)fail(503,'SERVICE_UNAVAILABLE');
  const source=scope.kind==='BUSINESS'?{accounts:await this.identity.finance!.accounts.find({organizationId:scope.bookId},{session:s}).toArray(),journals:await this.identity.finance!.journals.find({organizationId:scope.bookId},{session:s}).toArray()}:{accounts:await load<import('../obligations/models.js').Account>('s09_personal_accounts'),journals:await load<import('../obligations/models.js').Journal>('s09_personal_journals')},dates=[...new Set([...source.journals.map(j=>j.effectiveDate),...events.map(e=>e.effectiveDate)])].sort();
  const amount=amountReader(),balances=new Map<string,bigint>(),reserved=new Map<string,bigint>(),assetCosts=new Map<string,bigint>(),journals=[...source.journals].sort((a,b)=>a.effectiveDate.localeCompare(b.effectiveDate)),ordered=[...events].sort((a,b)=>a.effectiveDate.localeCompare(b.effectiveDate));let j=0,e=0;
  for(const date of dates){
   while(j<journals.length&&journals[j]!.effectiveDate<=date){for(const l of journals[j]!.lines)balances.set(l.accountId,(balances.get(l.accountId)??0n)+amount(l.debit)-amount(l.credit));j++;}
   while(e<ordered.length&&ordered[e]!.effectiveDate<=date){const event=ordered[e++]!;if(fundEventSet.has(event))for(const d of event.deltas)reserved.set(d.fundId,(reserved.get(d.fundId)??0n)+signedCents(d.delta));if(event.details['assetAccountId'])assetCosts.set(String(event.details['assetAccountId']),(assetCosts.get(String(event.details['assetAccountId']))??0n)+signedCents(String(event.details['costDelta']??'0.00')));}
   if([...reserved.values()].some(v=>v<0n))fail(409,'RESERVATION_CONFLICT');
   for(const fund of funds)if(date===dates.at(-1)&&(reserved.get(fund._id)??0n)>0n){if(fund.status!=='ACTIVE')fail(409,'RESERVATION_CONFLICT');await this.management.ledger.account(scope,fund.backingAccountId,s,{accountClass:'ASSET',kind:['CASH','BANK']});}
   const protection=scope.kind==='BUSINESS'?await effectiveReserves(this.identity.database,scope.bookId,s,date):funds.map(f=>({accountId:f.backingAccountId,amount:money(reserved.get(f._id)??0n)}));
   for(const account of source.accounts.filter(a=>['CASH','BANK'].includes(a.kind))){const protectedAmount=protection.filter(r=>r.accountId===account._id).reduce((n,r)=>n+cents(r.amount),0n);if((balances.get(account._id)??0n)<protectedAmount)fail(409,'INSUFFICIENT_AVAILABLE_FUNDS');}
   for(const[id,cost]of assetCosts)if(cost<0n||cost>(balances.get(id)??0n))fail(409,'SOURCE_CAPACITY_EXCEEDED');
  }
 }
 async bookTag(scope:Scope,s:ClientSession){
  const b=await this.management.store.get<Book>(booksTable,scope.bookId,scope,s),financial=scope.kind==='BUSINESS'?await this.identity.database.db.collection<{_id:string;value:number;recordedAt:string}>('financial_books').findOne({_id:scope.bookId},{session:s}):null;
  const h=await this.management.store.head(scope.bookId,s),first=this.management.store.tracking.active.get(s)?.mutations.find(m=>m.namespace===booksTable&&String(m.key)===scope.bookId),before=first?first.before:hash(b);if(h?before!==h.bookHash:before!==null)fail(503,'INTEGRITY_MISMATCH');
  return '"s10-book:'+scope.bookId+':'+hash({book:b,financial,catalog:this.catalogFingerprint,restoreEpoch:this.management.store.restoreEpoch})+'"';
 }
 async snapshot(purpose:string,resourceId:string|null,actor:Identity,s:ClientSession,command?:Data|null){
  const c=wealthContract().command(purpose,command),op=wealthContract().operations.get(String(c['operationId']))!,ps=c['pathParameters'] as Data,personal=op.path.startsWith('/me/');
  if(actor.realm!=='TENANT'||actor.roles.includes('SA'))fail(403,'ACCESS_DENIED');
  if(personal){if(c['organizationId']!==undefined||c['bookId']!==ps['bookId'])fail(422,'INPUT_INVALID');const b=await this.identity.database.db.collection<Book>(booksTable).findOne({_id:String(ps['bookId']),subjectId:actor._id,domainKind:'PERSONAL',status:'ACTIVE'},{session:s});if(!b||!verifyRow(this.identity.database,booksTable,b))fail(404,'RESOURCE_NOT_FOUND');}
  else if(!actor.roles.includes('T')||actor.organizationId!==ps['organizationId']||c['organizationId']!==ps['organizationId'])fail(403,'ACCESS_DENIED');
  return hash({purpose,resourceId,command:c,actor:actor._id,authz:actor.authzVersion,epoch:actor.authEpoch});
 }
 async mutate(context:Context,operation:string,input:unknown,params:Record<string,string>,key:string,expected?:string):Promise<Result>{
  const spec=wealthContract().operations.get(operation);if(!spec||spec.method!=='post')fail(422,'INPUT_INVALID');wealthContract().validate(operation,input);wealthContract().validate('Id',key);const p=canonical(input) as Data;wealthContract().validate(operation,p);
  const fingerprint=hash({operation,p,params,key,expected:expected??null}),started=performance.now(),barrier=await this.management.enter(started),business=spec.path.startsWith('/organizations/'),legacy=business?await this.identity.reporting?.projection?.enter(started):undefined;if(business&&!legacy)fail(503,'SERVICE_UNAVAILABLE');
  const result=await this.identity.database.transaction(async s=>{
   this.management.store.tracking.begin(s);
   try{
    const {actor}=await personalActor(this.identity,context,s);await grant(this.identity,context,spec.definition['x-mej-category']!,s);
    const {scope}=await resolveScope(this.identity,context,business?'BUSINESS':'PERSONAL',business?params['organizationId']:params['bookId'],s);await this.management.ensureBook(scope,s);
    const old=await this.identity.database.db.collection<Row>(commands).findOne({bookId:scope.bookId,actorId:actor._id,operation,key},{session:s});
    if(old){if(!verifyRow(this.identity.database,commands,old))fail(503,'INTEGRITY_MISMATCH');if(old['fingerprint']!==fingerprint)fail(409,'IDEMPOTENCY_CONFLICT');return{...old['result'] as Result,status:200};}
    const action=operation.replace(/^(business|personal)/,''),fund=action.includes('Fund')&&action!=='RecordExternalFunds',id=params['fundId']??params['assetId'];
    if(id){const row=await this.management.store.get<Row>(wealthTable(scope.kind,fund?'funds':'assets'),id,scope,s);if(!expected)fail(428,'ETAG_REQUIRED');if(expected!==etag(row))fail(412,'PRECONDITION_FAILED');}
    if(spec.definition['x-mej-category']==='BALANCE_60M'&&p['bookETag']!==await this.bookTag(scope,s))fail(412,'PRECONDITION_FAILED');
    if(business&&spec.definition['x-mej-category']==='BALANCE_60M')await this.identity.database.db.collection<{_id:string;value:number}>('financial_books').updateOne({_id:scope.bookId},{$inc:{value:1}},{session:s,upsert:true});
    const eventIds:string[]=[],journalIds:string[]=[],base=this.management.context(context,scope,s,p,params,eventIds,journalIds),c:WealthContext={system:this,scope,s,actor,auth:context,payload:p,params,unitId:randomUUID(),eventKind:'',entityId:id??'',amount:'0.00',deltas:[],details:{},reversalOfId:null,base,post:async(kind,amount,lines,details={})=>{const event=await base.post(c.entityId,kind,String(p['effectiveDate']),amount,lines,[],{wealthRootId:c.unitId,...details});return event.journalIds[0]!;}};
    let row:Row|undefined;if(action==='RecordExternalFunds')await externalCommand(c);else row=fund?await fundCommand(c,action):await assetCommand(c,action);
    if(c.eventKind){
     const name=wealthTable(scope.kind,fund||action==='RecordExternalFunds'?'fund_events':'asset_events');await this.management.store.put(name,{_id:c.unitId,bookId:scope.bookId,ownerId:scope.ownerId,domainKind:scope.kind,version:1,entityId:c.entityId,kind:c.eventKind,effectiveDate:String(p['effectiveDate']??p['valuationDate']),unitKnownAt:new Date(this.identity.now()).toISOString(),amount:c.amount,reversalOfId:c.reversalOfId,journalIds:[...new Set(journalIds)],ledgerEventIds:eventIds,deltas:c.deltas,details:c.details},s,false);
    }
    await stageFundEffects(c);
    if(row&&!fund){const{mac,recordedAt,...payload}=row;void mac;void recordedAt;await this.management.store.put(wealthTable(scope.kind,'asset_versions'),{_id:randomUUID(),bookId:scope.bookId,ownerId:scope.ownerId,domainKind:scope.kind,version:row.version,assetId:row._id,payload},s);}
    // Publish every new component of the transaction at one knowledge instant.
    await this.management.store.touch(scope,s,spec.definition['x-mej-category']==='BALANCE_60M');
    const tracking=this.management.store.tracking.active.get(s)!,known=new Date(Math.max(this.identity.now(),tracking.latest.get(scope.bookId)??0)+1).toISOString(),changed=new Map(tracking.mutations.filter(m=>m.after!==null).map(m=>[m.namespace+':'+m.key,{name:m.namespace,id:String(m.key)}]));
    for(const {name,id:changedId}of changed.values()){
     if(!wealthOriginals.includes(name)&&name!==booksTable&&name!==table(scope.kind,'events')&&name!==table(scope.kind,'liabilities')&&name!==table(scope.kind,'liability_versions')&&name!==table(scope.kind,'asset_stubs'))continue;
     await this.management.store.alignPending(name,changedId,scope,s,known);
    }
    if(row)row=await this.management.store.get<Row>(wealthTable(scope.kind,fund?'funds':'assets'),row._id,scope,s);
    const output=await mutationView(this,context,scope,s,operation,row,c,known);
    await this.management.store.put(commands,{_id:randomUUID(),bookId:scope.bookId,ownerId:scope.ownerId,domainKind:scope.kind,version:1,actorId:actor._id,operation,key,fingerprint,result:output},s);
    await this.management.store.finish(s);await this.identity.audit.append({realm:'TENANT',actorId:actor._id,subjectId:actor._id,action:'WEALTH_COMMAND',outcome:'SUCCESS'},s);return output;
   }finally{this.management.store.tracking.end(s);}
  });
  if(!this.identity.database.flushEvidence)fail(503,'SERVICE_UNAVAILABLE');await this.identity.database.flushEvidence();await this.management.leave(barrier,started);if(legacy)await this.identity.reporting!.projection!.leave(legacy,started);return result;
 }
 async read(context:Context,operation:string,params:Record<string,string>,query:Data={}):Promise<Result>{return await wealthRead(this,context,operation,params,query);}
}
