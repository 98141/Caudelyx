import {randomUUID} from 'node:crypto';
import type {ClientSession} from 'mongodb';
import type {IdentityService} from '../identity/service.js';
import {AppError} from '../../shared/errors.js';
import {booksTable,type Book} from '../obligations/models.js';
import type {Scope,Row,Table,Data} from './models.js';
import {exchangeTables} from './models.js';
import {hash} from './canonical.js';
import {verifyRow} from '../obligations/evidence.js';
export class ExchangeRepository {
 constructor(readonly identity:IdentityService){}
 get store(){const store=this.identity.obligations?.store;if(!store)throw new AppError(503,'SERVICE_UNAVAILABLE');return store;}
 get epoch(){return this.store.restoreEpoch;}
 async get<T extends Row>(table:Table,id:string,scope:Scope,s:ClientSession){return await this.store.get<T>(table,id,scope,s);}
 async all<T extends Row>(table:Table,scope:Scope,s:ClientSession){return await this.store.all<T>(table,scope,s);}
 async put<T extends Row>(table:Table,row:Omit<T,'mac'|'recordedAt'>&{_id:string;bookId:string},s:ClientSession){return await this.store.put(table,row,s,false) as T;}
 async write(table:Table,scope:Scope,s:ClientSession,value:Data,id:string=randomUUID()){return await this.store.put(table,{_id:id,bookId:scope.bookId,ownerId:scope.ownerId,domainKind:scope.kind,version:1,restoreEpoch:this.epoch,...value},s,false);}
 async owned<T extends Row>(table:Table,id:string,scope:Scope,actorId:string,s:ClientSession){const row=await this.identity.database.db.collection<Row>(table).findOne({_id:id,bookId:scope.bookId,ownerId:scope.ownerId,domainKind:scope.kind,actorId},{session:s});if(!row)throw new AppError(404,'RESOURCE_NOT_FOUND');if(!verifyRow(this.identity.database,table,row))throw new AppError(503,'INTEGRITY_MISMATCH');return row as T;}
 async ownedRows<T extends Row>(table:Table,scope:Scope,actorId:string,s:ClientSession){const rows=await this.identity.database.db.collection<Row>(table).find({bookId:scope.bookId,ownerId:scope.ownerId,domainKind:scope.kind,actorId},{session:s,maxTimeMS:10000}).sort({_id:1}).limit(10001).toArray();if(rows.length>10000)throw new AppError(422,'REPORT_SCOPE_TOO_LARGE');if(rows.some(r=>!verifyRow(this.identity.database,table,r)))throw new AppError(503,'INTEGRITY_MISMATCH');return rows as T[];}
 async findOwned<T extends Row>(table:Table,scope:Scope,actorId:string,filter:Data,s:ClientSession){const rows=await this.identity.database.db.collection<Row>(table).find({...filter,bookId:scope.bookId,ownerId:scope.ownerId,domainKind:scope.kind,actorId},{session:s,maxTimeMS:10000}).limit(2).toArray();if(rows.length>1||rows.some(r=>!verifyRow(this.identity.database,table,r)))throw new AppError(503,'INTEGRITY_MISMATCH');return rows[0] as T|undefined;}
 async page<T extends Row>(table:Table,scope:Scope,actorId:string,s:ClientSession,limit:number,last:string|null=null,filter:Data={}){const predicate={...filter,bookId:scope.bookId,ownerId:scope.ownerId,domainKind:scope.kind,actorId},totalRows=await this.identity.database.db.collection<Row>(table).countDocuments(predicate,{session:s,maxTimeMS:10000}),rows=await this.identity.database.db.collection<Row>(table).find({...predicate,...(last?{_id:{$gt:last}}:{})},{session:s,maxTimeMS:10000}).sort({_id:1}).limit(limit+1).toArray();if(rows.some(r=>!verifyRow(this.identity.database,table,r)))throw new AppError(503,'INTEGRITY_MISMATCH');return{totalRows,items:rows.slice(0,limit) as T[],more:rows.length>limit};}
 async chunks(table:'s11_preview_chunks'|'s11_snapshot_chunks',scope:Scope,s:ClientSession,parentId:string,value:unknown){
  const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>64*1024*1024)throw new AppError(413,'FILE_LIMIT_EXCEEDED');const ids:string[]=[];
  // Base64 chunk is bounded below the existing authenticated mutation chunk budget.
  for(let p=0;p<bytes.length;p+=32768){const id=randomUUID();ids.push(id);await this.write(table,scope,s,{parentId,part:ids.length-1,data:bytes.subarray(p,p+32768).toString('base64')},id);}return{ids,sha256:hash(value)};
 }
 async unchunks(table:'s11_preview_chunks'|'s11_snapshot_chunks',scope:Scope,s:ClientSession,parentId:string,ids:string[],expected:string):Promise<unknown>{
  if(ids.length>2048||new Set(ids).size!==ids.length)throw new AppError(503,'INTEGRITY_MISMATCH');const chunks:Buffer[]=[];
  for(const[i,id]of ids.entries()){const row=await this.get<Row>(table,id,scope,s);if(row['parentId']!==parentId||row['part']!==i||typeof row['data']!=='string')throw new AppError(503,'INTEGRITY_MISMATCH');chunks.push(Buffer.from(row['data'],'base64'));}
  let value:unknown;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new AppError(503,'INTEGRITY_MISMATCH');}if(hash(value)!==expected)throw new AppError(503,'INTEGRITY_MISMATCH');return value;
 }
 async sourceDigest(scope:Scope,s:ClientSession){
  const book=await this.identity.database.db.collection<Book>(booksTable).findOne({_id:scope.bookId,bookId:scope.bookId,ownerId:scope.ownerId,domainKind:scope.kind},{session:s}),head=await this.store.head(scope.bookId,s);if(Boolean(book)!==Boolean(head)||book&&!verifyRow(this.identity.database,booksTable,book))throw new AppError(503,'INTEGRITY_MISMATCH');
  const roots=Object.fromEntries(Object.entries(head?.roots??{}).filter(([name])=>!exchangeTables.includes(name as Table)||['s11_historical_origins','s11_historical_schedules','s11_opening_component_claims','s11_informational_history','s11_external_refs'].includes(name)));
  const finance=scope.kind==='BUSINESS'?await this.identity.database.db.collection<{_id:string;value:number;recordedAt:number}>('financial_books').findOne({_id:scope.bookId},{session:s}):null;
  const lending=scope.kind==='BUSINESS'?await this.identity.database.db.collection<{_id:string;root:unknown;revision:number}>('lending_merkle_orgs').findOne({_id:scope.bookId},{session:s}):null;
  // staging changes do not invalidate their own preview; monetaryRevision and source
  // roots do. Metadata aliases/claims participate when they become economic origins.
  return hash({bookId:scope.bookId,monetaryRevision:book?.monetaryRevision??0,roots,finance,lending,epoch:this.epoch});
 }
}
