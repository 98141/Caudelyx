import {randomUUID} from 'node:crypto';
import type {ClientSession} from 'mongodb';
import {AppError} from '../../shared/errors.js';
import {verifyRow} from '../obligations/evidence.js';
import {ExchangeRepository} from './repository.js';
import type {AuthorityState} from './authority.js';
import type {JobRow,Row} from './models.js';
const active=(j:JobRow)=>j.state==='QUEUED'||j.state==='RUNNING';
const lane=(j:JobRow)=>j.kind==='EXPORT'?'EXPORT':'IMPORT';
const fail=(code:string,status=409):never=>{throw new AppError(status,code);};
// Callers own one Mongo transaction and ManagementStore tracking/finish. Every
// claimant also writes the global gate, serializing actor and process quotas
// across processes without a query-then-insert race.
export class ExchangeJobs {
 readonly instance=randomUUID();
 constructor(readonly repo:ExchangeRepository){}
 private async gate(auth:AuthorityState,s:ClientSession){
  const scope=auth.scope,id='s11-job-gate';
  const row=await this.repo.identity.database.db.collection<Row>('s11_limits').findOne({_id:id},{session:s});
  if(row&&!verifyRow(this.repo.identity.database,'s11_limits',row))fail('INTEGRITY_MISMATCH',503);
  // This global technical lock contains no tenant payload. Its first scope owns
  // the signed row permanently; all instances update that same authenticated ID.
  if(row)await this.repo.put('s11_limits',{...row,version:row.version+1},s);
  else await this.repo.write('s11_limits',scope,s,{kind:'JOB_GATE'},id);
 }
 private async all(s:ClientSession){
  const rows=await this.repo.identity.database.db.collection<JobRow>('s11_jobs').find({state:{$in:['QUEUED','RUNNING']}},{session:s,maxTimeMS:10000}).limit(1001).toArray();
  if(rows.length>1000||rows.some(r=>!verifyRow(this.repo.identity.database,'s11_jobs',r)))fail('INTEGRITY_MISMATCH',503);return rows;
 }
 async rate(auth:AuthorityState,s:ClientSession){
  const id=auth.actor._id+':'+auth.scope.bookId+':rate',now=this.repo.identity.now(),old=await this.repo.identity.database.db.collection<Row>('s11_limits').findOne({_id:id,bookId:auth.scope.bookId},{session:s});
  if(old&&!verifyRow(this.repo.identity.database,'s11_limits',old))fail('INTEGRITY_MISMATCH',503);
  const times=(Array.isArray(old?.['times'])?old['times'] as number[]:[]).filter(t=>Number.isSafeInteger(t)&&t>now-60000);if(times.length>=10)fail('RATE_LIMITED',429);
  await this.repo.write('s11_limits',auth.scope,s,{version:(old?.version??0)+1,actorId:auth.actor._id,times:[...times,now]},id);
 }
 async enqueue(auth:AuthorityState,kind:JobRow['kind'],resourceId:string,s:ClientSession){
  await this.gate(auth,s);const all=await this.all(s),wanted=kind==='EXPORT'?'EXPORT':'IMPORT';
  if(all.filter(j=>active(j)&&j.actorId===auth.actor._id&&lane(j)===wanted).length>=1||all.filter(j=>j.state==='QUEUED').length>=10)fail('RATE_LIMITED',429);
  const now=new Date(this.repo.identity.now()).toISOString();
  return await this.repo.write('s11_jobs',auth.scope,s,{actorId:auth.actor._id,contextId:auth.context._id,kind,state:'QUEUED',createdAt:now,updatedAt:now,errorCode:null,resourceId,binding:auth.binding,lease:null}) as JobRow;
 }
 async claim(auth:AuthorityState,id:string,s:ClientSession){
  await this.gate(auth,s);const row=await this.repo.owned<JobRow>('s11_jobs',id,auth.scope,auth.actor._id,s),now=this.repo.identity.now();
  if(row.binding!==auth.binding||row.contextId!==auth.context._id)fail('ACCESS_DENIED',403);
  if(row.state!=='QUEUED')fail('SOURCE_CONFLICT');
  const all=await this.all(s);if(all.filter(j=>j.state==='RUNNING'&&j['instance']===this.instance&&lane(j)===lane(row)).length>=2)fail('RATE_LIMITED',429);
  const lease={nonce:randomUUID(),pid:process.pid,expiresAt:now+(row.kind==='EXPORT'?60000:10000)};
  return await this.repo.put<JobRow>('s11_jobs',{...row,version:row.version+1,state:'RUNNING',instance:this.instance,lease,updatedAt:new Date(now).toISOString()},s);
 }
 async complete(auth:AuthorityState,id:string,nonce:string,errorCode:string|null,s:ClientSession){
  const row=await this.repo.owned<JobRow>('s11_jobs',id,auth.scope,auth.actor._id,s);
  if(row.state!=='RUNNING'||row.lease?.nonce!==nonce||row['instance']!==this.instance)fail('SOURCE_CONFLICT');
  if(row.binding!==auth.binding||row.contextId!==auth.context._id)fail('ACCESS_DENIED',403);
  if(!errorCode&&this.repo.identity.now()>row.lease!.expiresAt)fail(row.kind==='EXPORT'?'REPORT_BUDGET_EXCEEDED':'FILE_BUDGET_EXCEEDED',503);
  return await this.repo.put<JobRow>('s11_jobs',{...row,version:row.version+1,state:errorCode?'FAILED':'SUCCEEDED',errorCode,lease:null,updatedAt:new Date(this.repo.identity.now()).toISOString()},s);
 }
 async cancel(auth:AuthorityState,id:string,s:ClientSession){
  const row=await this.repo.owned<JobRow>('s11_jobs',id,auth.scope,auth.actor._id,s);if(!active(row))return row;
  return await this.repo.put<JobRow>('s11_jobs',{...row,version:row.version+1,state:'CANCELLED',lease:null,updatedAt:new Date(this.repo.identity.now()).toISOString()},s);
 }
 async fail(auth:AuthorityState,id:string,errorCode:string,s:ClientSession){const row=await this.repo.owned<JobRow>('s11_jobs',id,auth.scope,auth.actor._id,s);if(!active(row))return row;return await this.repo.put<JobRow>('s11_jobs',{...row,version:row.version+1,state:'FAILED',errorCode,lease:null,updatedAt:new Date(this.repo.identity.now()).toISOString()},s);}
 async expire(auth:AuthorityState,s:ClientSession){
  await this.gate(auth,s);const now=this.repo.identity.now();
  for(const row of await this.repo.ownedRows<JobRow>('s11_jobs',auth.scope,auth.actor._id,s))if(active(row)&&(row.binding!==auth.binding||row.contextId!==auth.context._id||row.state==='QUEUED'&&Date.parse(row.createdAt)+30000<=now||row.lease!==null&&row.lease.expiresAt<=now))await this.repo.put<JobRow>('s11_jobs',{...row,version:row.version+1,state:'EXPIRED',errorCode:null,lease:null,updatedAt:new Date(now).toISOString()},s);
 }
}
