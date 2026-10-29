/* eslint-disable security/detect-object-injection -- Names and root keys are from the closed signed namespace catalog. */
import {randomUUID} from 'node:crypto';
import type {ClientSession,Document} from 'mongodb';
import type {Database} from '../../shared/database.js';
import {AppError} from '../../shared/errors.js';
import {originals,collections,limits} from './catalog.js';
import {booksTable,globalEvidence,table,type Row,type Book,type Scope} from './models.js';
import {codec,transportCodec,configureManagementEvidence,configureManagementTransport,signRow,verifyRow,tableRoot,type Evidence} from './evidence.js';
import {hash,copy,orderedPaths,transactionId,type Mutation} from './codec.js';
import {ManagementTracking} from './tracking.js';
export interface ProjectionHead extends Document {_id:string;bookId:string;restoreEpoch:string;materialRevision:number;generation:string;formatVersion:1;bookHash:string;roots:Record<string,{count:number;hash:string}>;lastManifest:string;previousManifest:string|null;mac:string}
export type ManifestChunk=Document&{_id:string;kind:'CHUNK';transactionId:string;part:number;mutations:Mutation[]};
export type ManifestHeader=Document&{_id:string;kind:'HEADER';formatVersion:1;transactionId:string;operation:'COMMAND'|'BOOTSTRAP'|'REBUILD';maintenanceNonce:string|null;books:string[];previousHeads:Record<string,string|null>;heads:ProjectionHead[];chunkHashes:string[];mutationCount:number;mutationRoot:string;mac:string};
export class ManagementStore {
 readonly tracking=new ManagementTracking();
 restoreEpoch='';
 constructor(readonly database:Database,key:Buffer,readonly now:()=>number){configureManagementEvidence(database,key);configureManagementTransport(database,key);}
 async put(name:string,input:Document&{_id:string;bookId:string},s:ClientSession,archive=true):Promise<Row>{
  if(!originals.has(name)||name===globalEvidence)throw Error('Unknown management table');
  const old=await this.database.db.collection<Row>(name).findOne({_id:input._id},{session:s});
  if(old&&(!verifyRow(this.database,name,old)||old.bookId!==input.bookId||old.ownerId!==input['ownerId']||old.domainKind!==input['domainKind']))throw new AppError(503,'INTEGRITY_MISMATCH');
  if(old&&archive&&name!==booksTable&&!name.includes('_history_')){
   const history=table(old.domainKind,'history'),id=name+':'+old._id+':'+old.version;
   if(!await this.database.db.collection<Row>(history).findOne({_id:id},{session:s}))await this.put(history,{_id:id,bookId:old.bookId,ownerId:old.ownerId,domainKind:old.domainKind,version:1,entityTable:name,entityId:old._id,payload:old,recordedAt:old.recordedAt},s,false);
  }
  const supplied=typeof input['recordedAt']==='string'?Date.parse(input['recordedAt']):0;
  const body={...input,version:input['version']??(old?.version??0)+1,recordedAt:new Date(Math.max(this.now(),old?Date.parse(old.recordedAt)+1:0,Number.isFinite(supplied)?supplied:0)).toISOString()};
  const row=signRow(this.database,name,body);await this.database.db.collection<Row>(name).replaceOne({_id:row._id},row,{upsert:true,session:s});this.tracking.capture(s,name,old,row);return row;
 }
 async get<T extends Row>(name:string,id:string,scope:Scope,s:ClientSession):Promise<T>{
  const row=await this.database.db.collection<Row>(name).findOne({_id:id,bookId:scope.bookId,ownerId:scope.ownerId,domainKind:scope.kind},{session:s});
  if(!row)throw new AppError(404,'RESOURCE_NOT_FOUND');if(!verifyRow(this.database,name,row))throw new AppError(503,'INTEGRITY_MISMATCH');return row as T;
 }
 async all<T extends Row>(name:string,scope:Scope,s:ClientSession,budget:()=>void=()=>{}):Promise<T[]>{
  const h=await this.head(scope.bookId,s),rows=await this.database.db.collection<Row>(name).find({bookId:scope.bookId,ownerId:scope.ownerId,domainKind:scope.kind},{session:s,maxTimeMS:10000}).sort({_id:1}).toArray();budget();
  // The authenticated head commits to every complete row, including its MAC.
  // Matching that complete root proves contents and completeness; recomputing
  // a second HMAC per row is redundant. Writes, singleton loads and startup
  // retain individual MAC verification. No unverified data or cached authority.
  if(!this.matchesBefore(name,scope.bookId,rows,h?.roots[name],s))throw new AppError(503,'INTEGRITY_MISMATCH');return rows as T[];
 }
 private matchesBefore(name:string,bookId:string,rows:Row[],expected:{count:number;hash:string}|undefined,s:ClientSession){
  const values=new Map(rows.map(r=>[r._id,hash(r)])),mutations=this.tracking.active.get(s)?.mutations??[];
  for(const m of [...mutations].reverse())if(m.namespace===name){
   const id=String(m.key);if(!values.has(id)&&m.after!==null)continue;
   if(m.after!==null&&values.get(id)!==m.after)return false;
   if(m.before===null)values.delete(id);else values.set(id,m.before);
  }
  void bookId;
  const actual={count:values.size,hash:hash([...values].sort(([a],[b])=>a<b?-1:a>b?1:0))};return hash(actual)===hash(expected??tableRoot([]));
 }
 async head(id:string,s:ClientSession){const h=await this.database.db.collection<ProjectionHead>(collections.heads).findOne({_id:id},{session:s});if(h){const{mac,...body}=h;if(h._id!==id||h.bookId!==id||h['databaseName']!==this.database.db.databaseName||h.formatVersion!==1||!transportCodec(this.database).verify('HEAD',body,mac))throw new AppError(503,'INTEGRITY_MISMATCH');}return h;}
 async touch(scope:Scope,s:ClientSession,monetary=false,knownAt=this.now()){
  const old=await this.database.db.collection<Book>(booksTable).findOne({_id:scope.bookId},{session:s});
  if(!old)throw new AppError(404,'RESOURCE_NOT_FOUND');
  const {mac:_,...body}=old;void _;
  return await this.put(booksTable,{...body,version:old.version+1,monetaryRevision:old.monetaryRevision+(monetary?1:0),recordedAt:new Date(Math.max(knownAt,this.tracking.active.get(s)?.latest.get(scope.bookId)??0)).toISOString()},s) as Book;
 }
 async finish(s:ClientSession){
  const state=this.tracking.active.get(s);if(!state||!s.id?.id||!state.books.size)throw Error('Empty management transaction');
  const tx=transactionId(s.id.id,s.serverSession.txnNumber),heads:ProjectionHead[]=[],previousHeads:Record<string,string|null>={},oldHeadRows=new Map<string,ProjectionHead|null>();
  for(const id of [...state.books].sort()){
   const old=await this.head(id,s),book=await this.database.db.collection<Row>(booksTable).findOne({_id:id},{session:s});oldHeadRows.set(id,old);if(!book||!verifyRow(this.database,booksTable,book))throw new AppError(503,'INTEGRITY_MISMATCH');
   const roots:ProjectionHead['roots']={};
   for(const name of originals){if(name===booksTable||name===globalEvidence)continue;const rows=await this.database.db.collection<Row>(name).find({bookId:id},{session:s}).sort({_id:1}).toArray();if(rows.some(row=>!verifyRow(this.database,name,row))||!this.matchesBefore(name,id,rows,old?.roots[name],s))throw new AppError(503,'INTEGRITY_MISMATCH');roots[name]=tableRoot(rows);}
   previousHeads[id]=old===null?null:hash(old);const body={_id:id,bookId:id,restoreEpoch:this.restoreEpoch,generation:old?.generation??randomUUID(),formatVersion:1 as const,materialRevision:(old?.materialRevision??0)+1,bookHash:hash(book),roots,databaseName:this.database.db.databaseName,lastManifest:tx,previousManifest:old?.lastManifest??null};
   const head={...body,mac:transportCodec(this.database).seal('HEAD',body)};heads.push(head);await this.database.db.collection<ProjectionHead>(collections.heads).replaceOne({_id:id},head,{session:s,upsert:true});
  }
  const allHeads=await this.database.db.collection<ProjectionHead>(collections.heads).find({},{session:s}).sort({_id:1}).toArray(),old=await this.database.db.collection<Evidence>(globalEvidence).findOne({_id:'management'},{session:s});
  if(old){const {mac,...body}=old;const before=new Map(allHeads.map(h=>[h._id,h]));for(const[id,h]of oldHeadRows)if(h)before.set(id,h);else before.delete(id);if(!codec(this.database).verify('GLOBAL:'+this.database.db.databaseName,body,mac)||hash([...before].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([id,h])=>[id,hash(h)]))!==old.digest)throw new AppError(503,'INTEGRITY_MISMATCH');}
  const body={_id:'management',revision:(old?.revision??0)+1,digest:hash(allHeads.map(h=>[h._id,hash(h)])),previousDigest:old?.digest??''};
  const next={...body,mac:codec(this.database).seal('GLOBAL:'+this.database.db.databaseName,body)};
  await this.database.db.collection<Evidence>(globalEvidence).replaceOne({_id:'management'},next,{session:s,upsert:true});this.tracking.capture(s,globalEvidence,old,next);
  const mutations=orderedPaths(copy(state.mutations)),chunks:ManifestChunk[]=[];let pending:Mutation[]=[];
  const flush=()=>{if(pending.length){chunks.push({_id:tx+':'+chunks.length,kind:'CHUNK',transactionId:tx,part:chunks.length,mutations:pending});pending=[];}};
  for(const m of mutations){if(Buffer.byteLength(JSON.stringify(m))>limits.chunkBytes)throw new AppError(503,'SERVICE_UNAVAILABLE');if(pending.length===limits.chunkRows||Buffer.byteLength(JSON.stringify([...pending,m]))>limits.chunkBytes-1024)flush();pending.push(m);}flush();
  const headerBody={_id:tx,kind:'HEADER' as const,formatVersion:1 as const,transactionId:tx,databaseName:this.database.db.databaseName,operation:'COMMAND' as const,maintenanceNonce:null,books:[...state.books].sort(),previousHeads,heads,chunkHashes:chunks.map(hash),mutationCount:mutations.length,mutationRoot:hash(mutations)};
  const header={...headerBody,mac:transportCodec(this.database).seal('MANIFEST',headerBody)};
  const collection=this.database.db.collection<ManifestHeader|ManifestChunk>(collections.manifests);if(chunks.length)await collection.insertMany(chunks,{session:s});await collection.insertOne(header,{session:s});
 }
}
