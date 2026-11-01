/* eslint-disable security/detect-object-injection -- Private signed rows and closed technical catalog; authenticated scope, never client collection names. */
import {BSON,type ClientSession,type Document} from 'mongodb';
import {randomUUID} from 'node:crypto';
import type {IdentityService} from '../identity/service.js';
import {AppError} from '../../shared/errors.js';
import {tables,type Authority,type Table,type Row,type Data,limits} from './models.js';
import {codec,controls,protectedTables,sealRow,verifyRow,signedBody,simulationHead,simulationEvidenceMatches,type Head} from './evidence.js';
import {hash} from './codec.js';
import {Observer,transactionId,type Mutation} from './observer.js';
const fail=(code='INTEGRITY_MISMATCH',status=503):never=>{throw new AppError(status,code);};
export const predicate=(a:Authority)=>({actorId:a.actorId,scopeKind:a.consolidated?'CONSOLIDATED':a.scope.kind,bookId:a.scope.bookId,ownerId:a.scope.ownerId});
export class Store{
 private observer:Observer|undefined;private prepared=false;private frozen=false;
 private readonly tracking=new WeakMap<ClientSession,Mutation[]>();
 constructor(readonly identity:IdentityService){}
 get epoch(){return this.identity.obligations!.store.restoreEpoch;}
 get active(){return this.observer?.ready===true&&!this.frozen;}
 async prepareOwned(owner:()=>Promise<boolean>){
  const d=this.identity.database,h=d.client.options.hosts;
  if(!/^caudelyx_s08_p02_[a-f0-9]{24}$/.test(d.db.databaseName)||h.length!==1||!['localhost','127.0.0.1'].includes(h[0]?.host??'')||h[0]?.port!==27017||!await owner())fail('ACCESS_DENIED',403);
  const existing=new Map((await d.db.listCollections().toArray()).map(r=>[r.name,r]));
  for(const name of protectedTables){const r=existing.get(name);if(!r)await d.db.createCollection(name,{changeStreamPreAndPostImages:{enabled:true}});else if(!('options'in r)||r.options?.['changeStreamPreAndPostImages']?.['enabled']!==true)fail();}
  for(const name of tables)await d.db.collection(name).createIndex({actorId:1,scopeKind:1,bookId:1,ownerId:1,_id:1});
  await d.db.collection(controls.barriers).createIndex({expiresAt:1},{expireAfterSeconds:0});this.prepared=true;
 }
 async activateOwned(owner:()=>Promise<boolean>){
  if(!this.prepared||!await owner()||this.observer)fail('ACCESS_DENIED',403);
  const d=this.identity.database,head=await simulationHead(d);
  this.observer=new Observer(d,()=>this.latch());
  await this.observer.start(async()=>{if(!await simulationEvidenceMatches(d,head))fail();const g=await d.db.collection<Head>(controls.heads).findOne({_id:'GLOBAL'});if(g?.lastManifest.startsWith('FAULT:'))fail();});
  const old=d.projectionShutdown;d.projectionShutdown=async()=>{await this.stop();await old?.();};
 }
 async stop(){await this.observer?.stop();this.observer=undefined;}
 async barrier(){if(!this.active)fail('SERVICE_UNAVAILABLE');await this.observer!.barrier();}
 private async latch(){
  this.frozen=true;const d=this.identity.database;
  await d.client.withSession(async s=>s.withTransaction(async()=>{
   const old=await d.db.collection<Head>(controls.heads).findOne({_id:'GLOBAL'},{session:s});
   if(!old||!codec(d).verify('HEAD',signedBody(old),old.mac))return;
   const b={...signedBody(old),technicalRevision:old.technicalRevision+1,lastManifest:'FAULT:'+randomUUID()};
   await d.db.collection<Document&{_id:string}>(controls.heads).replaceOne({_id:'GLOBAL'},{...b,mac:codec(d).seal('HEAD',b)},{session:s});
   await this.identity.audit.append({realm:'TENANT',actorId:'SYSTEM_LOCAL_TRANSITION',subjectId:'S12_SIMULATION_TECHNICAL',action:'SIMULATION_INTEGRITY_GATE_CLOSED',outcome:'DENIED'},s);
  },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'}}));await d.flushEvidence?.();
 }
 begin(s:ClientSession){if(!this.active)fail('SERVICE_UNAVAILABLE');this.tracking.set(s,[]);}
 end(s:ClientSession){this.tracking.delete(s);}
 async all(table:Table,a:Authority,s:ClientSession):Promise<Row[]>{
  const rows=await this.identity.database.db.collection<Row>(table).find(predicate(a),{session:s}).sort({_id:1}).toArray();
  if(rows.length>12000||rows.some(r=>r.restoreEpoch!==this.epoch||!verifyRow(this.identity.database,table,r)))fail();return rows;
 }
 async get(table:Table,id:string,a:Authority,s:ClientSession){
  const r=await this.identity.database.db.collection<Row>(table).findOne({_id:id,...predicate(a)},{session:s});if(!r)fail('RESOURCE_NOT_FOUND',404);
  if(r!.restoreEpoch!==this.epoch||!verifyRow(this.identity.database,table,r!))fail();return r!;
 }
 async put(table:Table,a:Authority,data:Data,s:ClientSession,id:string=randomUUID(),duration:number=limits.payloadMs){
  const d=this.identity.database,c=d.db.collection<Row>(table),old=await c.findOne({_id:id},{session:s});
  if(old&&(!verifyRow(d,table,old)||hash(predicate(a))!==hash({actorId:old.actorId,scopeKind:old.scopeKind,bookId:old.bookId,ownerId:old.ownerId})))fail();
  const now=new Date(this.identity.now()).toISOString(),{mac,...values}=data;void mac;
  const row=sealRow(d,table,{...values,_id:id,...predicate(a),version:(old?.version??0)+1,createdAt:old?.createdAt??now,expiresAt:typeof data['expiresAt']==='string'?data['expiresAt']:new Date(this.identity.now()+duration).toISOString(),restoreEpoch:this.epoch}) as Row;
  if(BSON.serialize(row).length>65536)fail('SIMULATION_SCOPE_TOO_LARGE',413);
  const tracking=this.tracking.get(s);if(!tracking)fail();
  await c.replaceOne({_id:id},row,{session:s,upsert:true});tracking!.push({table,id,before:old?hash(old):null,after:hash(row)});return row;
 }
 async remove(table:Table,a:Authority,id:string,s:ClientSession){const r=await this.get(table,id,a,s),tracking=this.tracking.get(s);if(!tracking)fail();await this.identity.database.db.collection<Row>(table).deleteOne({_id:id},{session:s});tracking!.push({table,id,before:hash(r),after:null});}
 async chunks(a:Authority,parent:string,value:unknown,s:ClientSession,duration:number=limits.payloadMs){
  const raw=Buffer.from(JSON.stringify(value));if(raw.length>limits.resultBytes)fail('SIMULATION_SCOPE_TOO_LARGE',413);const ids:string[]=[];
  for(let i=0;i<raw.length;i+=32768){const r=await this.put('s12_payload_chunks',a,{parent,part:i/32768,value:raw.subarray(i,i+32768).toString('base64')},s,undefined,duration);ids.push(r._id);}return{ids,digest:hash(value),bytes:raw.length};
 }
 async unchunks<T>(a:Authority,parent:string,c:{ids:string[];digest:string},s:ClientSession):Promise<T>{
  if(!Array.isArray(c.ids)||c.ids.length>513||new Set(c.ids).size!==c.ids.length)fail();const parts:Buffer[]=[];
  for(const[i,id]of c.ids.entries()){const r=await this.get('s12_payload_chunks',id,a,s);if(r['parent']!==parent||r['part']!==i||Date.parse(r.expiresAt)<=this.identity.now())fail('RESOURCE_EXPIRED',410);parts.push(Buffer.from(String(r['value']),'base64'));}
  const raw=Buffer.concat(parts);if(raw.length>limits.resultBytes)fail();const v=JSON.parse(raw.toString()) as T;if(hash(v)!==c.digest)fail();return v;
 }
 async finish(a:Authority,s:ClientSession,system=false){
  const mutations=this.tracking.get(s);if(!mutations?.length)return;
  const d=this.identity.database,roots:Head['roots']={};let bytes=0;
  for(const table of tables){const rows=await this.all(table,a,s);for(const r of rows)bytes+=BSON.serialize(r).length;roots[table]={count:rows.length,hash:hash(rows.map(r=>[r._id,hash(r)]))};}
  if(bytes>67108864)fail('SIMULATION_SCOPE_TOO_LARGE',413);
  if(!s.id?.id||!s.serverSession)fail();const tx=transactionId(s.id!.id,s.serverSession!.txnNumber);
  const heads=d.db.collection<Head>(controls.heads),old=await heads.findOne({_id:a.key},{session:s});
  if(old&&!codec(d).verify('HEAD',signedBody(old),old.mac))fail();
  const body={_id:a.key,...predicate(a),restoreEpoch:this.epoch,catalogVersion:1 as const,technicalRevision:(old?.technicalRevision??0)+1,roots,lastManifest:tx,previousManifest:old?.lastManifest??null},head={...body,mac:codec(d).seal('HEAD',body)};
  await heads.replaceOne({_id:a.key},head,{session:s,upsert:true});mutations.push({table:controls.heads,id:a.key,before:old?hash(old):null,after:hash(head)});
  const all=await heads.find({_id:{$ne:'GLOBAL'}},{session:s}).sort({_id:1}).toArray(),g=await heads.findOne({_id:'GLOBAL'},{session:s});
  if(g&&(!codec(d).verify('HEAD',signedBody(g),g.mac)||g.lastManifest.startsWith('FAULT:')))fail();
  const gb={_id:'GLOBAL',actorId:'SYSTEM',scopeKind:'TECHNICAL',bookId:'GLOBAL',ownerId:'SYSTEM',restoreEpoch:this.epoch,catalogVersion:1 as const,technicalRevision:(g?.technicalRevision??0)+1,roots:Object.fromEntries(all.map(h=>[h._id,{count:1,hash:hash(h)}])),lastManifest:tx,previousManifest:g?.lastManifest??null},global={...gb,mac:codec(d).seal('HEAD',gb)};
  await heads.replaceOne({_id:'GLOBAL'},global,{session:s,upsert:true});mutations.push({table:controls.heads,id:'GLOBAL',before:g?hash(g):null,after:hash(global)});
  const mb={_id:tx,databaseName:d.db.databaseName,mutationRoot:hash(mutations),previousGlobal:g?hash(g):null,previousManifest:g?.lastManifest??null,global:hash(global),createdAt:new Date(this.identity.now()).toISOString()};
  await d.db.collection<Document&{_id:string}>(controls.manifests).insertOne({...mb,mac:codec(d).seal('MANIFEST',mb)},{session:s});
  await this.identity.audit.append({realm:'TENANT',actorId:system?'SYSTEM_LOCAL_TRANSITION':a.actorId,subjectId:a.scope.bookId,action:system?'SIMULATION_RETENTION_COMMITTED':'SIMULATION_TECHNICAL_STATE_COMMITTED',outcome:'SUCCESS'},s);
 }
}
