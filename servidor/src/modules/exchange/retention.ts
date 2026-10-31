import type {ClientSession} from 'mongodb';
import {AppError} from '../../shared/errors.js';
import {verifyRow} from '../obligations/evidence.js';
import type {ExchangeService} from './service.js';
import type {Row,FileRow,ImportRow,JobRow,Scope,Table} from './models.js';
const scopeOf=(r:Row):Scope=>({kind:r.domainKind,bookId:r.bookId,ownerId:r.ownerId,...(r.domainKind==='BUSINESS'?{organizationId:r.bookId}:{})});
const active=(r:JobRow)=>r.state==='RUNNING'||r.state==='QUEUED';
const cursors=new WeakMap<ExchangeService,string>();
const verifiedCursors=new WeakMap<ExchangeService,string>();
// Explicit maintenance, never called from GET. Authenticated metadata selects
// exact UUIDs; there is no directory/prefix sweep or adoption of unknown files.
export async function reconcile(service:ExchangeService){
 const {repo,identity,files}=service,now=identity.now(),stamp=new Date(now).toISOString(),db=identity.database.db;
 const checked=async<T extends Row>(name:Table,filter:Record<string,unknown>,s?:ClientSession)=>{
  const rows=await db.collection<Row>(name).find(filter,{...(s?{session:s}:{}),maxTimeMS:10000}).sort({_id:1}).limit(100).toArray();
  if(rows.some(r=>!verifyRow(identity.database,name,r)))throw new AppError(503,'INTEGRITY_MISMATCH');return rows as T[];
 };
 // Bounded rotating verification also handles a restored Mongo backup without
 // its private filesystem. An economic receipt is never rolled back to repair it.
 const verifiedCursor=verifiedCursors.get(service),live={state:{$in:['VERIFIED','READY']}};let verify=(await checked<FileRow>('s11_files',{...live,...(verifiedCursor?{_id:{$gt:verifiedCursor}}:{})})).slice(0,4);if(!verify.length&&verifiedCursor){verifiedCursors.delete(service);verify=(await checked<FileRow>('s11_files',live)).slice(0,4);}if(verify.length)verifiedCursors.set(service,verify.at(-1)!._id);let corruptFiles=0;
 for(const selected of verify)try{await files.read(selected._id,selected);}catch(error){if(!(error instanceof AppError)||error.code!=='INTEGRITY_MISMATCH')throw error;await service.transaction(async s=>{const scope=scopeOf(selected),f=await repo.get<FileRow>('s11_files',selected._id,scope,s);if(f.version!==selected.version||!['VERIFIED','READY'].includes(f.state))return;await repo.put<FileRow>('s11_files',{...f,version:f.version+1,state:'CORRUPT'},s);const name=f.filename.startsWith('caudelyx-export-')?'s11_exports':'s11_imports',r=await repo.get<Row>(name,f.resourceId,scope,s);if(r['state']!=='COMMITTED'&&r['state']!=='CANCELLED')await repo.put(name,{...r,version:r.version+1,state:name==='s11_exports'?'FAILED':'INVALID'},s);corruptFiles++;});}
 const dueJobs=await checked<JobRow>('s11_jobs',{state:{$in:['QUEUED','RUNNING']},$or:[{restoreEpoch:{$ne:repo.epoch}},{'lease.expiresAt':{$lte:now}},{state:'QUEUED',createdAt:{$lte:new Date(now-30000).toISOString()}}]});
 for(const selected of dueJobs)await service.transaction(async s=>{
  const scope=scopeOf(selected),job=await repo.get<JobRow>('s11_jobs',selected._id,scope,s);if(!active(job)||job['restoreEpoch']===repo.epoch&&(job.lease?job.lease.expiresAt>now:Date.parse(job.createdAt)+30000>now))return;
  await repo.put<JobRow>('s11_jobs',{...job,version:job.version+1,state:'EXPIRED',lease:null,errorCode:null,updatedAt:stamp},s);
  const name=job.kind==='EXPORT'?'s11_exports':'s11_imports',r=await repo.get<Row>(name,job.resourceId,scope,s);
  if(r['jobId']!==job._id||r['state']==='COMMITTED'||r['state']==='CANCELLED')return;
  if(job.kind==='EXPORT')await repo.put(name,{...r,version:r.version+1,state:'EXPIRED'},s);
  else if(job.kind==='IMPORT_PREVIEW')await repo.put('s11_imports',{...r,version:r.version+1,state:'UPLOADED',previewId:null,jobId:null},s);
  else await repo.put('s11_imports',{...r,version:r.version+1,state:'INVALID',previewId:null,fileId:null},s);
 });
 const filter={$or:[{expiresAt:{$lte:stamp}},{state:{$in:['DELETED','CORRUPT','EXPIRED']}},{restoreEpoch:{$ne:repo.epoch}},{state:'STAGING',createdAt:{$lte:new Date(now-60000).toISOString()}}]},cursor=cursors.get(service);let candidates=await checked<FileRow>('s11_files',{...filter,...(cursor?{_id:{$gt:cursor}}:{})});if(!candidates.length&&cursor){cursors.delete(service);candidates=await checked<FileRow>('s11_files',filter);}if(candidates.length)cursors.set(service,candidates.at(-1)!._id);
 let removed=0;
 for(const selected of candidates){
  const eligible=await service.transaction(async s=>{
   const scope=scopeOf(selected),f=await repo.get<FileRow>('s11_files',selected._id,scope,s);if(f['purgedAt']&&!await files.has(f._id))return false;
   const resources=await checked<Row>(f.mediaType==='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'&&!f.filename.startsWith('caudelyx-export-')?'s11_imports':'s11_exports',{_id:f.resourceId,bookId:f.bookId,actorId:f.actorId},s),r=resources[0];
   const job=r?.['jobId']?await repo.get<JobRow>('s11_jobs',String(r['jobId']),scope,s):null;
   const due=Date.parse(f.expiresAt)<=now||f['restoreEpoch']!==repo.epoch||['DELETED','CORRUPT','EXPIRED'].includes(f.state)||f.state==='STAGING'&&(!job||!active(job));if(!due)return false;
   // A live lease owns the UUID and .part until its fixed deadline. Expiration
   // is committed first, so an old publisher cannot publish valid metadata.
   if(job&&active(job)&&job['restoreEpoch']===repo.epoch&&(job.lease?.expiresAt??Date.parse(job.createdAt)+30000)>now)return false;
   await repo.put<FileRow>('s11_files',{...f,version:f.version+1,state:f.state==='CORRUPT'?'CORRUPT':'EXPIRED',parsed:null},s);
   for(const chunk of await checked<Row>('s11_preview_chunks',{parentId:f._id,bookId:f.bookId},s))await repo.store.forgetExchange('s11_preview_chunks',chunk._id,scope,s);
   if(r&&'mode'in r&&r['fileId']===f._id){
    const preview=String(r['previewId']??'');if(preview){for(const chunk of await checked<Row>('s11_preview_chunks',{parentId:preview,bookId:f.bookId},s))await repo.store.forgetExchange('s11_preview_chunks',chunk._id,scope,s);await repo.store.forgetExchange('s11_import_previews',preview,scope,s);}
    await repo.put<ImportRow>('s11_imports',{...r,version:r.version+1,state:r['state']==='COMMITTED'?'COMMITTED':r['state']==='CANCELLED'?'CANCELLED':'EXPIRED',previewId:null,label:null},s);
   }else if(r&&!('mode'in r)&&r['state']!=='CANCELLED')await repo.put('s11_exports',{...r,version:r.version+1,state:'EXPIRED'},s);
   return true;
  });
  if(!eligible)continue;await files.remove(selected._id);
  await service.transaction(async s=>{const r=await repo.get<FileRow>('s11_files',selected._id,scopeOf(selected),s);await repo.put<FileRow>('s11_files',{...r,version:r.version+1,purgedAt:stamp},s);});removed++;
 }
 // Superseded preview versions also contain normalized input and must expire
 // independently of the import's current pointer or cancelled upload attempt.
 const previews=await checked<Row>('s11_import_previews',{'data.expiresAt':{$lte:stamp}});
 for(const p of previews)await service.transaction(async s=>{const scope=scopeOf(p);for(const chunk of await checked<Row>('s11_preview_chunks',{parentId:p._id,bookId:p.bookId},s))await repo.store.forgetExchange('s11_preview_chunks',chunk._id,scope,s);await repo.store.forgetExchange('s11_import_previews',p._id,scope,s);const r=await repo.get<ImportRow>('s11_imports',String(p['importId']),scope,s);if(r.previewId===p._id)await repo.put<ImportRow>('s11_imports',{...r,version:r.version+1,previewId:null,state:r.state==='READY'?'UPLOADED':r.state},s);});
 // CREATED/failed uploads can have no file pointer. Their original label and
 // any superseded preview must obey the same maximum retention.
 for(const selected of await checked<ImportRow>('s11_imports',{expiresAt:{$lte:stamp},retentionClosedAt:{$exists:false}}))await service.transaction(async s=>{const scope=scopeOf(selected),r=await repo.get<ImportRow>('s11_imports',selected._id,scope,s);await repo.put<ImportRow>('s11_imports',{...r,version:r.version+1,label:null,previewId:null,state:r.state==='COMMITTED'?'COMMITTED':r.state==='CANCELLED'?'CANCELLED':'EXPIRED',retentionClosedAt:stamp},s);});
 return{verifiedFiles:verify.length,corruptFiles,expiredJobs:dueJobs.length,removedFiles:removed,expiredPreviews:previews.length};
}
