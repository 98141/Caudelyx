// Operator admission for persistent SYNTHETIC deployments. This capability is
// bound to a real Database instance, signed control files and an exclusive
// renewable Mongo lease; HTTP input and fixture names cannot grant it.
import {readFile,lstat,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import type {Database} from './database.js';
import type {Config} from './config.js';
import type {SyntheticKeys} from './keys.js';
import type {IdentityService} from '../modules/identity/service.js';
import type {ClientSession} from 'mongodb';
const admitted=new WeakMap<Database,PersistentDemo>();
const digest=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const deny=(code:string):never=>{throw Error(code);};
async function ordinary(file:string){if(!(await lstat(file)).isFile()||await realpath(file)!==resolve(file))deny('DEMO_CONTROL_PATH_INVALID');return readFile(file);}
export function persistentDemoAdmitted(database:Database){return admitted.get(database)?.live()===true;}
export async function loadPersistentKeys(file:string):Promise<SyntheticKeys>{
  // Read-only loader: deliberately never calls the legacy generate-if-missing
  // loader, including if an operator removes the file during startup.
  const raw=JSON.parse((await ordinary(file)).toString('utf8')) as Record<string,unknown>;
  if(raw['version']!==2)deny('DEMO_KEYRING_VERSION_INVALID');
  const key=(name:'mail'|'totp'|'journal'|'cursor'|'priority')=>{const value=raw[name];if(typeof value!=='string')throw Error('DEMO_KEYRING_INVALID');const bytes=Buffer.from(value,'base64url');if(bytes.length!==32)deny('DEMO_KEYRING_INVALID');return bytes;};
  return{version:2,mail:key('mail'),totp:key('totp'),journal:key('journal'),cursor:key('cursor'),priority:key('priority')};
}
export async function activatePersistentModules(identity:IdentityService,keys:SyntheticKeys,verify:()=>Promise<boolean>){
  if(!persistentDemoAdmitted(identity.database)||!await verify())deny('DEMO_ADMISSION_REQUIRED');
  const management=identity.obligations!,wealth=identity.wealth!,simulation=identity.simulation!;
  await identity.exchange!.files.guard();
  // Protected catalogs must be created by their owners, with pre-images.
  await management.prepareOwned(verify);await wealth.prepareOwned(verify);await simulation.prepareOwned(verify);
  // Observers deliberately latch on ANY later DDL. Create the closed core
  // collection catalog before opening streams, including first-user/org paths.
  // This creates absent collections only; it never adopts/modifies old data.
  const core=['audit_events','bank_declarations','borrower_credits','cash_custody','consents','contexts','custody_bindings','custody_movements','demo_runtime_control','email_proofs','factors','financial_accounts','financial_books','financial_evidence_head','financial_idempotency','financial_journals','held_funds_profiles','held_funds_reservations','idempotency','identities','invitations','lending_domain_state','lending_loan_versions','lending_loans','lending_merkle_nodes','lending_merkle_orgs','lending_monthly_loans','lending_priority_checkpoint','lending_quotes','lending_rate_windows','lending_v2_checkpoint','loan_accruals','loan_applications','loan_compensations','loan_events','loan_installments','loan_operation_books','loan_positions','login_failures','mail_quotas','ms_mandates','onboarding_tombstones','opening_files','opening_idempotency','opening_references','opening_validations','organizations','outbox','payment_approvals','payment_books','payment_commands','payment_event_snapshots','payment_registration_scopes','payment_reversal_requests','payment_transitions','payments','rate_limits','reconciliation_events','recoveries','recovery_codes','registration_intents','restore_claims','s09_personal_journals','s11_historical_origins','s11_jobs','s11_limits','s12_runs','security_evidence_outbox','security_evidence_projection','security_sequence','synthetic_mail','synthetic_notifications','transaction_fence','webauthn_ceremonies'];
  const existing=new Set((await identity.database.db.listCollections({}, {nameOnly:true}).toArray()).map(c=>c.name));
  for(const name of core)if(!existing.has(name))await identity.database.db.createCollection(name);
  const {ProjectionRuntime}=await import('../modules/reporting/projection/service.js');
  const projection=await ProjectionRuntime.createOwned(identity,keys.cursor,verify,false,()=>management.activateOwned(verify));
  identity.reporting!.projection=projection;
  identity.database.projectionShutdown=async()=>{await management.stop();await projection.stop();};
  await simulation.activateOwned(verify);
  const {monthlyService}=await import('../modules/lending/ms-service.js');await monthlyService(identity).activateOwned(verify);
}
interface Profile {version:1;mode:'local-synthetic';realUseAllowed:false;deploymentId:string;databaseName:string;mongoUri:string;tenantOrigin:string;platformOrigin:string;keyringSHA256:string}
interface Identity {_id:string;profileSHA256:string;deploymentId:string;phase:'INITIALIZING'|'READY'}
interface Lease {_id:string;token:string;expiresAt:number;deploymentId:string;fence?:number}
export class PersistentDemo {
  private expiry=0;private timer:ReturnType<typeof setInterval>|undefined;private pending:Promise<void>|undefined;private closed=false;private failed=false;
  private readonly token=randomUUID();
  private constructor(readonly database:Database,readonly control:string,readonly profileFile:string,readonly profileSHA256:string,readonly deploymentId:string,readonly keyringFile:string,readonly keyringSHA256:string){}
  live(){return !this.closed&&!this.failed&&this.expiry>Date.now();}
  async guard(session:ClientSession,commit:boolean){
    if(!this.live())deny('DEMO_LEASE_UNAVAILABLE');
    if(!commit)return;
    if(digest(await ordinary(this.profileFile))!==this.profileSHA256||digest(await ordinary(this.keyringFile))!==this.keyringSHA256)deny('DEMO_CONTROL_CHANGED');
    // Serialize the financial commit with renewal/takeover of the real lease.
    // A local clock check alone cannot fence a paused, stale transaction.
    const result=await this.database.db.collection<Lease>('demo_runtime_control').updateOne({_id:'lease',token:this.token,deploymentId:this.deploymentId,expiresAt:{$gt:Date.now()}},{$inc:{fence:1}},{session});
    if(result.matchedCount!==1)deny('DEMO_COMMIT_FENCE_REJECTED');
  }
  async verify(){
    if(!this.live()||digest(await ordinary(this.profileFile))!==this.profileSHA256)deny('DEMO_LEASE_OR_PROFILE_INVALID');
    const lease=await this.database.db.collection<Lease>('demo_runtime_control').findOne({_id:'lease',token:this.token,expiresAt:{$gt:Date.now()}});
    return Boolean(lease);
  }
  static async open(database:Database,config:Config,keys:SyntheticKeys,control:string,keyringFile:string){
    if(config.profile!=='persistent-demo'||!config.profileFile||keys.version!==2||!keys.priority)deny('DEMO_PROFILE_REQUIRED');
    const profileFile=config.profileFile;
    if(typeof profileFile!=='string')throw Error('DEMO_PROFILE_REQUIRED');
    if(await realpath(control)!==resolve(control)||(await lstat(control)).isSymbolicLink())deny('DEMO_CONTROL_PATH_INVALID');
    const bytes=await ordinary(profileFile),envelope=JSON.parse(bytes.toString('utf8')) as {payload:Profile;signature:string};
    const p=envelope.payload,expected=createHmac('sha256',keys.journal).update('CAUDELYX:DEMO:PROFILE:v1:'+JSON.stringify(p)).digest('hex');
    if(typeof envelope.signature!=='string'||!/^[a-f0-9]{64}$/.test(envelope.signature)||!timingSafeEqual(Buffer.from(envelope.signature,'hex'),Buffer.from(expected,'hex'))||
      !p||p.version!==1||p.mode!=='local-synthetic'||p.realUseAllowed!==false||!(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/).test(p.deploymentId)||
      p.databaseName!==config.databaseName||p.mongoUri!==config.mongoUri||p.tenantOrigin!==config.tenantOrigin||p.platformOrigin!==config.platformOrigin||
      p.keyringSHA256!==digest(await ordinary(keyringFile)))deny('DEMO_PROFILE_BINDING_INVALID');
    if(!config.mongoOptions?.auth||config.mongoOptions.tls!==true||config.mongoOptions.tlsInsecure||config.mongoOptions.tlsAllowInvalidCertificates||config.mongoOptions.tlsAllowInvalidHostnames)deny('DEMO_AUTHENTICATED_TLS_REQUIRED');
    const auth=config.mongoOptions?.auth;if(!auth)throw Error('DEMO_AUTH_REQUIRED');
    const actual=database.client.options,endpoint=new URL(config.mongoUri),host=endpoint.hostname.replace(/^\[|\]$/g,'');
    if(database.db.databaseName!==config.databaseName||actual.tls!==true||actual.tlsInsecure||actual.tlsAllowInvalidCertificates||actual.tlsAllowInvalidHostnames||actual.replicaSet!=='rs0'||actual.hosts.length!==1||actual.hosts[0]?.host!==host||actual.hosts[0]?.port!==Number(endpoint.port||27017)||actual.credentials?.username!==auth.username||actual.credentials?.password!==auth.password||actual.credentials?.source!=='admin')deny('DEMO_ACTUAL_CONNECTION_INVALID');
    await database.client.connect();
    const hello=await database.client.db('admin').command({hello:1});
    if(hello['setName']!=='rs0'||hello['isWritablePrimary']!==true||!Array.isArray(hello['hosts'])||hello['hosts'].length!==1)deny('DEMO_TOPOLOGY_INVALID');
    const controls=database.db.collection<Identity>('demo_runtime_control'),profileSHA256=digest(bytes);
    const identity=await controls.findOne({_id:'identity'});
    if(!identity){
      for(const suffix of ['','_external_mail','_external_security']){
        const names=await database.client.db(config.databaseName+suffix).listCollections({}, {nameOnly:true}).toArray();
        if(names.length)deny('DEMO_UNCLAIMED_DATA');
      }
      await controls.insertOne({_id:'identity',profileSHA256,deploymentId:p.deploymentId,phase:'INITIALIZING'});
    }else{
      if(identity.profileSHA256!==profileSHA256||identity.deploymentId!==p.deploymentId)deny('DEMO_DATABASE_BINDING_INVALID');
      if(identity.phase==='READY')for(const file of ['gate.json','gate.json.journal.jsonl'])await ordinary(join(control,file));
      else if(identity.phase!=='INITIALIZING')deny('DEMO_INITIALIZATION_STATE_INVALID');
    }
    const runtime=new PersistentDemo(database,control,profileFile,profileSHA256,p.deploymentId,keyringFile,p.keyringSHA256);
    await runtime.renew();database.runtimeGuard=(session,commit)=>runtime.guard(session,commit);admitted.set(database,runtime);
    runtime.timer=setInterval(()=>{if(!runtime.pending)runtime.pending=runtime.renew().catch(()=>{runtime.failed=true;runtime.expiry=0;clearInterval(runtime.timer);admitted.delete(database);console.error('DEMO_LEASE_LOST');}).finally(()=>{runtime.pending=undefined;});},5000);
    runtime.timer.unref();return runtime;
  }
  private async renew(){
    if(this.closed)deny('DEMO_RUNTIME_CLOSED');
    if(digest(await ordinary(this.profileFile))!==this.profileSHA256||digest(await ordinary(this.keyringFile))!==this.keyringSHA256)deny('DEMO_CONTROL_CHANGED');
    const now=Date.now(),expiresAt=now+30000;
    try{
      const result=await this.database.db.collection<Lease>('demo_runtime_control').findOneAndUpdate({_id:'lease',deploymentId:this.deploymentId,$or:[{expiresAt:{$lte:now}},{token:this.token}]},{$set:{token:this.token,expiresAt,deploymentId:this.deploymentId}},{upsert:true,returnDocument:'after',writeConcern:{w:'majority'}});
      if(!result||result.token!==this.token)deny('DEMO_LEASE_BUSY');this.expiry=expiresAt;
    }catch{deny('DEMO_LEASE_BUSY_OR_UNAVAILABLE');}
  }
  async ready(){if(!await this.verify())deny('DEMO_LEASE_INVALID');await this.database.db.collection<Identity>('demo_runtime_control').updateOne({_id:'identity',profileSHA256:this.profileSHA256},{$set:{phase:'READY'}});}
  async close(){if(this.closed)return;this.closed=true;clearInterval(this.timer);await this.pending;admitted.delete(this.database);await this.database.db.collection<Lease>('demo_runtime_control').updateOne({_id:'lease',token:this.token},{$set:{expiresAt:0}});}
}
