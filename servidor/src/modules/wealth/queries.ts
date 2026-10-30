/* eslint-disable security/detect-object-injection -- Closed DTO fields and authenticated token maps. */
import {randomBytes,createCipheriv,createDecipheriv,createHmac} from 'node:crypto';
import type {ClientSession} from 'mongodb';
import type {Context} from '../identity/models.js';
import {cents,money} from '../finance/money.js';
import {effectiveReserves} from '../collections/funds.js';
import {personalActor,resolveScope,authorityBinding} from '../obligations/authority.js';
import {today,validDate} from '../obligations/calendar.js';
import {table,etag,relationships,booksTable,type Book,type Event,type Result} from '../obligations/models.js';
import {liabilityPosition} from '../obligations/liabilities.js';
import {consolidated} from '../obligations/queries.js';
import {hash} from '../obligations/codec.js';
import {signedCents,amountReader,wealthTable,type Scope,type Row,type Data,type Asset,type Fund,type WealthContext,type WealthEvent} from './models.js';
import {wealthContract} from './contract.js';
import {ledgerSources} from './sources.js';
import {fail} from './funds.js';
import type {WealthService} from './service.js';
function seal(key:Buffer,value:unknown){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from('S10:SNAPSHOT:1'));const bytes=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),bytes]).toString('base64url');}
function open(key:Buffer,value:unknown):Claims{try{if(typeof value!=='string'||value.length>16384)throw Error();const b=Buffer.from(value,'base64url'),c=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAAD(Buffer.from('S10:SNAPSHOT:1'));c.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([c.update(b.subarray(28)),c.final()]).toString()) as Claims;}catch{fail(422,'REPORT_TOKEN_INVALID');}}
interface Claims {binding:string;source:string;asOf:string;known:string;expires:number;op:string;params:string;limit:number;after?:string}
const keyFor=(w:WealthService)=>createHmac('sha256',w.key).update('S10:TOKENS:1').digest();
async function historical<T extends Row>(w:WealthService,name:string,scope:Scope,s:ClientSession,known:string,history?:Row[]){
 const current=await w.management.store.all<T>(name,scope,s),old=history??await w.management.store.all<Row>(table(scope.kind,'history'),scope,s),rows=new Map<string,T>();
 for(const row of [...current,...old.filter(r=>r['entityTable']===name).map(r=>r['payload'] as T)])if(row.recordedAt<=known&&(!rows.has(row._id)||rows.get(row._id)!.version<row.version))rows.set(row._id,row);return [...rows.values()];
}
type ViewMode='BOOK'|'FUNDS'|'ASSETS'|'POSITIONS'|'AVAILABILITY';
export class View {
 events:WealthEvent[]=[];funds:Fund[]=[];assets:Asset[]=[];funding:Row[]=[];management:Event[]=[];reserves=new Map<string,bigint>();
 private readonly byAsset=new Map<string,WealthEvent[]>();private readonly byDebt=new Map<string,Event[]>();private readonly bySource=new Map<string,Row[]>();private readonly unitTimes=new Map<string,string>();
 private current=false;private sourcePromise:ReturnType<typeof ledgerSources>|undefined;
 constructor(readonly w:WealthService,readonly scope:Scope,readonly s:ClientSession,readonly asOf:string,readonly known:string,readonly mode:ViewMode='POSITIONS'){}
 async load(){
  const store=this.w.management.store,book=await store.get<Book>(booksTable,this.scope.bookId,this.scope,this.s);this.current=book.recordedAt<=this.known;if(this.mode==='BOOK')return this;
  const wantsAssets=['ASSETS','POSITIONS'].includes(this.mode),wantsFunds=['FUNDS','POSITIONS','AVAILABILITY'].includes(this.mode),history=this.current?[]:await store.all<Row>(table(this.scope.kind,'history'),this.scope,this.s);
  const assetEvents=wantsAssets?await store.all<WealthEvent>(wealthTable(this.scope.kind,'asset_events'),this.scope,this.s):[],fundEvents=wantsFunds?await this.w.fundEvents(this.scope,this.s):[],visible=(e:WealthEvent)=>e.effectiveDate<=this.asOf&&e.unitKnownAt<=this.known;
  this.events=[...assetEvents,...fundEvents].filter(visible);
  if(wantsAssets){this.assets=await historical<Asset>(this.w,wealthTable(this.scope.kind,'assets'),this.scope,this.s,this.known,history);const eventIds=new Set(this.events.map(e=>e._id));this.funding=(await store.all<Row>(wealthTable(this.scope.kind,'asset_funding'),this.scope,this.s)).filter(r=>r.recordedAt<=this.known&&eventIds.has(String(r['sourceEventId'])));}
  if(wantsFunds)this.funds=await historical<Fund>(this.w,wealthTable(this.scope.kind,'funds'),this.scope,this.s,this.known,history);
  const needsDebt=this.assets.some(a=>a.liabilityIds.length>0),needsHistoricalCash=!this.current&&['POSITIONS','AVAILABILITY'].includes(this.mode),allManagement=needsDebt||needsHistoricalCash?await store.all<Event>(table(this.scope.kind,'events'),this.scope,this.s):[];
  this.management=allManagement.filter(e=>e.effectiveDate<=this.asOf&&e.unitKnownAt<=this.known);
  // Full unit times include future knowledge relative to K. Dropping those
  // events before this map would expose their earlier journal at K-1.
  for(const e of allManagement)if(!e.components['existingLink'])for(const id of e.journalIds)this.unitTimes.set(id,e.unitKnownAt);
  for(const e of [...assetEvents,...fundEvents])for(const id of e.journalIds){const previous=this.unitTimes.get(id);if(!previous||previous<e.unitKnownAt)this.unitTimes.set(id,e.unitKnownAt);}
  for(const e of this.events){const rows=this.byAsset.get(e.entityId)??[];rows.push(e);this.byAsset.set(e.entityId,rows);}for(const e of this.management){const rows=this.byDebt.get(e.entityId)??[];rows.push(e);this.byDebt.set(e.entityId,rows);}for(const f of this.funding){const id=String(f['assetId']),rows=this.bySource.get(id)??[];rows.push(f);this.bySource.set(id,rows);}
  for(const e of fundEvents.filter(visible))for(const d of e.deltas)this.reserves.set(d.fundId,(this.reserves.get(d.fundId)??0n)+signedCents(d.delta));if([...this.reserves].some(([id,n])=>n<0n||n>0n&&!this.funds.some(f=>f._id===id)))fail(503,'SOURCE_INCONSISTENT');return this;
 }
 private async cash(){
  this.sourcePromise??=ledgerSources(this.w,this.scope,this.s);const source=await this.sourcePromise,cashIds=new Set(source.accounts.filter(a=>['CASH','BANK'].includes(a.kind)).map(a=>a._id)),balances=new Map<string,bigint>();for(const id of cashIds)balances.set(id,0n);
  const amount=amountReader();for(const j of source.journals)if(j.effectiveDate<=this.asOf&&j.recordedAt<=this.known&&(this.current||(this.unitTimes.get(j._id)??j.recordedAt)<=this.known))for(const l of j.lines)if(cashIds.has(l.accountId))balances.set(l.accountId,(balances.get(l.accountId)??0n)+amount(l.debit)-amount(l.credit));
  const legacy=this.scope.kind==='BUSINESS'?await effectiveReserves(this.w.identity.database,this.scope.bookId,this.s,this.asOf,this.known,false):[];return{balances,legacy};
 }
 fund(row:Fund){return{id:row._id,mode:row.mode,label:row.label,purpose:row.purpose,backingAccountId:row.backingAccountId,reserved:money(this.reserves.get(row._id)??0n),status:row.status,version:row.version};}
 asset(row:Asset):Data{
  const events=this.byAsset.get(row._id)??[],reversed=new Set(events.map(e=>e.reversalOfId)),live=events.filter(e=>!e.reversalOfId&&!reversed.has(e._id)),acquisition=live.find(e=>['ASSET_ACQUIRE','ASSET_EXISTING_LINK'].includes(e.kind)),disposed=live.some(e=>e.kind==='ASSET_DISPOSE'),cost=events.reduce((n,e)=>n+signedCents(String(e.details['costDelta']??'0.00')),0n),valuationEvent=live.filter(e=>e.kind==='ASSET_VALUATION').sort((a,b)=>a.effectiveDate.localeCompare(b.effectiveDate)||a.unitKnownAt.localeCompare(b.unitKnownAt)).at(-1),v=valuationEvent?.details['valuation'] as Data|undefined;
  const owned=v&&row.ownershipPercentage!==null?money((cents(String(v['grossEstimatedValue']))*cents(row.ownershipPercentage)+5000n)/10000n):null,reasons:string[]=[];
  if(row.ownershipPercentage===null)reasons.push('OWNERSHIP_NOT_DECLARED');if(!v)reasons.push('NO_VALUATION_AT_CUT');
  const ids=acquisition?row.liabilityIds:[],debt=ids.reduce((n,id)=>{const events=this.byDebt.get(id)??[];if(!events.some(e=>e.kind==='LIABILITY_ACTIVATE'||e.kind==='CARD_PURCHASE'))fail(503,'SOURCE_INCONSISTENT');return n+liabilityPosition(events).principal;},0n);
  const sources=(this.bySource.get(row._id)??[]).filter(f=>f['sourceEventId']===acquisition?._id);if(sources.some(f=>f['provenanceKind']==='UNKNOWN'))reasons.push('PROVENANCE_UNKNOWN');
  const status=disposed?'DISPOSED':acquisition?'ACTIVE':row.status==='CANCELLED'?'CANCELLED':'DRAFT';
  const metadata=Object.fromEntries(['assetClass','otherClassDescription','label','origin','legalOwnerReference','ownershipPercentage','grossCostDeclared','assetAccountId','supportReferences','locationGeneral'].map(k=>[k,row[k]]));
  return{id:row._id,...metadata,recognizedCost:money(cost),status,version:row.version,acquisitionEventId:acquisition?._id??null,liabilityIds:ids,valuation:v?{id:valuationEvent!._id,...v,recordedAt:valuationEvent!.unitKnownAt}:null,ownedEstimatedValue:status==='ACTIVE'?owned:null,linkedPrincipal:money(debt),indicativeEquity:status==='ACTIVE'&&owned!==null?money(cents(owned)-debt):null,sourceCompleteness:reasons.includes('PROVENANCE_UNKNOWN')?'INCOMPLETE':'COMPLETE',reasons,events:events.slice(-100).map(e=>({id:e._id,type:e.kind,effectiveDate:e.effectiveDate,unitKnownAt:e.unitKnownAt,reversalOfId:e.reversalOfId,journalIds:e.journalIds}))};
 }
 async availability(account:string,fundId?:string){
  await this.w.management.ledger.account(this.scope,account,this.s,{accountClass:'ASSET',kind:['CASH','BANK']});const {balances,legacy:protectedRows}=await this.cash(),confirmed=balances.get(account)??0n,fund=this.funds.filter(f=>f.backingAccountId===account).reduce((n,f)=>n+(this.reserves.get(f._id)??0n),0n),legacy=protectedRows.filter(r=>r.accountId===account).reduce((n,r)=>n+cents(r.amount),0n);
  if(confirmed<legacy+fund||legacy<0n)fail(503,'SOURCE_INCONSISTENT');if(fundId&&!this.funds.some(f=>f._id===fundId&&f.backingAccountId===account))fail(404,'RESOURCE_NOT_FOUND');
  return{accountId:account,confirmedCash:money(confirmed),legacyProtected:money(legacy),fundReserved:money(fund),free:money(confirmed-legacy-fund),fundAvailableToConsume:fundId?money(this.reserves.get(fundId)??0n):null};
 }
 async positions(){
  const assets=this.assets.map(a=>this.asset(a)).filter(a=>a['status']==='ACTIVE'),nullable=(k:string)=>assets.every(a=>a[k]!==null)?money(assets.reduce((n,a)=>n+signedCents(String(a[k])),0n)):null;
  const reversed=new Set(this.events.map(e=>e.reversalOfId)),live=this.events.filter(e=>!e.reversalOfId&&!reversed.has(e._id)),rent=live.filter(e=>e.kind==='ASSET_RENT_RECEIVE').reduce((n,e)=>n+cents(e.amount),0n),expense=live.filter(e=>e.kind==='ASSET_EXPENSE_LINK').reduce((n,e)=>n+cents(e.amount),0n);
  const {balances,legacy}=await this.cash();let available=0n;for(const [id,balance]of balances){const protectedAmount=legacy.filter(r=>r.accountId===id).reduce((n,r)=>n+cents(r.amount),0n),reserved=this.funds.filter(f=>f.backingAccountId===id).reduce((n,f)=>n+(this.reserves.get(f._id)??0n),0n);if(balance<protectedAmount+reserved)fail(503,'SOURCE_INCONSISTENT');available+=balance-protectedAmount-reserved;}
  return{recognizedAssetCost:money(assets.reduce((n,a)=>n+cents(String(a['recognizedCost'])),0n)),grossDeclaredCost:nullable('grossCostDeclared'),ownedEstimatedValue:nullable('ownedEstimatedValue'),linkedPrincipal:nullable('linkedPrincipal'),indicativeEquity:nullable('indicativeEquity'),rentCashReceived:money(rent),linkedOperatingCashPaid:money(expense),operatingNetCash:money(rent-expense),cashAvailable:money(available),unvaluedCount:assets.filter(a=>a['ownedEstimatedValue']===null).length};
 }
}
async function metadata(w:WealthService,context:Context,scope:Scope,s:ClientSession,op:string,params:Data,asOf:string,known:string,source:string,limit=20,expires=w.identity.now()+300000){
 const {actor}=await personalActor(w.identity,context,s),book=await w.management.ensureBook(scope,s),claims:Claims={binding:authorityBinding(actor,context,book),source,asOf,known,expires,op,params:hash(params),limit};
 return{claims,meta:{scope:op==='getPrivateWealth'?'PRIVATE_CONSOLIDATED':scope.kind,currency:'COP',timezone:'America/Bogota',asOf,recordedThrough:known,policyVersion:'S10-CO-1.0',schemaVersion:'1.0.0',coverage:'COMPLETE',reasons:[] as string[],snapshotToken:seal(keyFor(w),claims),expiresAt:new Date(expires).toISOString()}};
}
export async function mutationView(w:WealthService,context:Context,scope:Scope,s:ClientSession,operation:string,row:Row|undefined,c:WealthContext,known:string):Promise<Result>{
 if(!c.eventKind&&row){const asOf=today(w.identity.now()),v=await new View(w,scope,s,asOf,known,operation.includes('Fund')?'FUNDS':'ASSETS').load(),{meta}=await metadata(w,context,scope,s,operation,c.params,asOf,known,await w.bookTag(scope,s));return{status:201,data:operation.includes('Fund')?v.fund(row as Fund):v.asset(row as Asset),meta,etag:etag(row)};}
 return{status:201,data:{eventId:c.unitId,resourceId:row?._id??c.unitId,version:row?.version??1,journalIds:[...new Set(c.base.journalIds)],unitKnownAt:known},...(row?{etag:etag(row)}:{})};
}
export async function wealthRead(w:WealthService,context:Context,operation:string,params:Record<string,string>,query:Data):Promise<Result>{
 const spec=wealthContract().operations.get(operation);if(!spec||spec.method!=='get')fail(422,'INPUT_INVALID');
 const accepted=spec.definition.parameters.filter(p=>p.in==='query');if(Object.keys(query).some(k=>!accepted.some(p=>p.name===k)))fail(422,'INPUT_INVALID');
 for(const p of accepted){const v=query[p.name];if(v===undefined&&p.required)fail(422,'INPUT_INVALID');if(v!==undefined){const check=wealthContract().ajv.compile({...p.schema,components:wealthContract().document.components});if(!check(p.name==='limit'?Number(v):v))fail(422,'INPUT_INVALID');}}
 const started=performance.now(),barrier=await w.management.enter(started),business=spec.path.startsWith('/organizations/'),consolidation=operation==='getPrivateWealth',legacy=business||consolidation?await w.identity.reporting?.projection?.enter(started):undefined;if((business||consolidation)&&!legacy)fail(503,'SERVICE_UNAVAILABLE');
 const result=await w.identity.database.client.withSession({causalConsistency:true},async s=>{
  s.advanceOperationTime(barrier.time);if(legacy)s.advanceOperationTime(legacy.time);
  return await s.withTransaction(async()=>{
   const {actor}=await personalActor(w.identity,context,s),{scope,book}=await resolveScope(w.identity,context,business?'BUSINESS':'PERSONAL',business?params['organizationId']:params['bookId'],s);
   if(!book)fail(404,'RESOURCE_NOT_FOUND');const financialClock=business?await w.identity.database.db.collection<{_id:string;recordedAt:number}>('financial_books').findOne({_id:scope.bookId},{session:s}):null,maxKnown=[new Date(w.identity.now()).toISOString(),book.recordedAt,...(financialClock?.recordedAt?[new Date(financialClock.recordedAt).toISOString()]:[])].sort().at(-1)!;let asOf=String(query['asOf']),known=String(query['recordedThrough']??maxKnown);if(!validDate(asOf)||asOf>today(w.identity.now())||!Number.isFinite(Date.parse(known))||known>maxKnown)fail(422,'INPUT_INVALID');
   const boundParams={...params,...(query['accountId']?{accountId:query['accountId']}:{}),...(query['fundId']?{fundId:query['fundId']}: {})};let source=await w.bookTag(scope,s),privateData:Data|undefined,privateReasons:string[]=[];
   if(consolidation){const consolidatedValue=await consolidated(w.management,context,scope,s,asOf,known);privateData=consolidatedValue.data;privateReasons=consolidatedValue.reasons;const org=(privateData['businesses'] as Data[])[0]?.['organizationId'];if(org)source=hash({personal:source,business:await w.bookTag({kind:'BUSINESS',bookId:String(org),ownerId:String(org),organizationId:String(org)},s)});}
   let claims:Claims|undefined;const token=query['cursor']??query['snapshotToken'];
   if(token){claims=open(keyFor(w),token);if(claims.binding!==authorityBinding(actor,context,book)||claims.op!==operation||claims.params!==hash(boundParams))fail(422,'REPORT_TOKEN_INVALID');if(claims.expires<=w.identity.now())fail(409,'REPORT_SNAPSHOT_EXPIRED');if(claims.source!==source)fail(409,'REPORT_SNAPSHOT_STALE');if(claims.asOf!==asOf||query['recordedThrough']!==undefined&&claims.known!==known||query['limit']!==undefined&&claims.limit!==Number(query['limit']))fail(422,'REPORT_TOKEN_INVALID');known=claims.known;asOf=claims.asOf;}
   const mode:ViewMode=operation.endsWith('GetWealthBook')?'BOOK':operation.endsWith('GetWealthAvailability')?'AVAILABILITY':operation.includes('Fund')?'FUNDS':operation.endsWith('GetWealthPositions')||consolidation?'POSITIONS':'ASSETS',limit=Number(query['limit']??claims?.limit??20),v=await new View(w,scope,s,asOf,known,mode).load(),{meta,claims:nextClaims}=await metadata(w,context,scope,s,operation,boundParams,asOf,known,source,limit,claims?.expires);let data:unknown,tag:string|undefined;
   if(operation.endsWith('GetWealthBook')){data={id:scope.bookId,scope:scope.kind,currency:'COP'};tag=source;}
   else if(operation.endsWith('GetWealthAvailability'))data=await v.availability(String(query['accountId']),query['fundId'] as string|undefined);
   else if(operation.endsWith('GetWealthPositions'))data=await v.positions();
   else if(consolidation){
    const pd=privateData!,businesses=pd['businesses'] as Data[],org=businesses[0]?.['organizationId'],personal=await v.positions(),bv=org?await new View(w,{kind:'BUSINESS',bookId:String(org),ownerId:String(org),organizationId:String(org)},s,asOf,known).load():null,bp=bv?await bv.positions():null,net=pd['net'] as Data;
    const eliminated=new Set((pd['eliminations'] as Data[]).filter(e=>e['component']==='INVESTMENT_EQUITY').map(e=>String(e['relationshipId']))),relations=await w.management.store.all<Row>(relationships,scope,s),eliminatedJournals=new Set(relations.filter(r=>eliminated.has(r._id)).map(r=>String(r['personalJournalId']))),claims=await historical<Row>(w,wealthTable(scope.kind,'source_claims'),scope,s,known);let estimate:bigint|null=cents(String(net['assets']));
    for(const view of [v,...(bv?[bv]:[])])for(const asset of view.assets.map(a=>view.asset(a)).filter(a=>a['status']==='ACTIVE')){
     const cost=cents(String(asset['recognizedCost'])),eliminatedCost=view===v?claims.filter(c=>c['assetId']===asset['id']&&c['status']==='CLAIMED'&&eliminatedJournals.has(String(c['journalId']))).reduce((n,c)=>n+cents(String(c['amount'])),0n):0n;
     if(eliminatedCost===cost&&cost>0n)continue;
     if(eliminatedCost>0n){estimate=null;privateReasons.push('VALUATION_ELIMINATION_ALLOCATION_UNAVAILABLE');continue;}
     if(asset['ownedEstimatedValue']===null){estimate=null;privateReasons.push('UNVALUED_ASSET_AT_CUT');}else if(estimate!==null)estimate+=cents(String(asset['ownedEstimatedValue']))-cost;
    }
    const estimated=estimate===null?null:money(estimate);
    privateReasons=[...new Set(privateReasons)].slice(0,20);data={personal,business:bp,eligibleBusinessOrganizationId:org??null,eliminations:(pd['eliminations'] as Data[]).map(e=>({relationshipId:e['relationshipId'],amount:e['amount'],sourceEventIds:e['sourceRefs']})),ledgerGrossAssets:(pd['gross'] as Data)['assets'],ledgerNetAssets:money(cents(String(net['assets']))-cents(String(net['liabilities']))),indicativeOwnedAssets:estimated,reasons:privateReasons};meta.reasons=privateReasons;meta.coverage=privateReasons.length?'INCOMPLETE':'COMPLETE';
   }else if(operation.endsWith('GetFund')){const row=v.funds.find(f=>f._id===params['fundId']);if(!row)fail(404,'RESOURCE_NOT_FOUND');data=v.fund(row);tag=etag(row);}
   else if(operation.endsWith('GetAsset')){const row=v.assets.find(a=>a._id===params['assetId']);if(!row)fail(404,'RESOURCE_NOT_FOUND');data=v.asset(row);tag=etag(row);}
   else{
    const sources=operation.endsWith('ListAssetSources');if(sources&&!v.assets.some(a=>a._id===params['assetId']))fail(404,'RESOURCE_NOT_FOUND');
    const rows=(sources?v.funding.filter(f=>f['assetId']===params['assetId']).map(f=>({id:f._id,assetId:f['assetId']||null,amount:f['amount'],provenanceKind:f['provenanceKind'],reference:f['reference'],sourceKind:f['sourceKind'],sourceEventId:f['sourceEventId']})):operation.endsWith('ListFunds')?v.funds.map(f=>v.fund(f)):v.assets.map(a=>v.asset(a))).sort((a,b)=>String(a.id).localeCompare(String(b.id))),remaining=rows.filter(r=>!claims?.after||String(r.id)>claims.after),page=remaining.slice(0,limit);
    data={items:page,nextCursor:remaining.length>limit?seal(keyFor(w),{...nextClaims,after:page.at(-1)!.id}):null};
   }
   return{status:200,data,meta,...(tag?{etag:tag}:{})};
  },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'}});
 });await w.management.leave(barrier,started);if(legacy)await w.identity.reporting!.projection!.leave(legacy,started);return result;
}
