import { createHmac, createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { BSON, type Document, type ClientSession } from 'mongodb';
import type { Database } from './database.js';
import { reconstructSecurityState, type SecurityEvidence } from './evidence.js';
import type { Identity } from '../modules/identity/models.js';
import { AppError } from './errors.js';
import { ExternalJournal, type JournalEntry } from './external-journal.js';
import { financialEvidenceMatches } from '../modules/finance/integrity.js';
import {head as lendingHead,lendingEvidenceMatches,lendingDigest} from '../modules/lending/integrity.js';
import {migratePriorities,migrateV2,configureEvidenceKey,anchorEvidence} from '../modules/lending/evidence-v2.js';

interface Gate { open: boolean; requiredCut: number; snapshotWatermark: number; reviewId: string | null; flushedSequence: number; flushedSignature: string }
type Journal = JournalEntry;
export interface SyntheticSnapshot { watermark: number; collections: Record<string,string>; signature: string }
export class RestoreController {
  private failed = false;
  private priorityVerified = false;
  pendingWatermark = false;
  private readonly external;
  readonly fileJournal;
  constructor(readonly database: Database, readonly gatePath: string, readonly key: Buffer,readonly priority?:Buffer) {
    configureEvidenceKey(database,key,priority);this.priorityVerified=!priority;
    this.external = database.client.db(`${database.db.databaseName}_external_security`);
    this.fileJournal = new ExternalJournal(gatePath + '.journal.jsonl', key);
  }
  private mac(value: string): string { return createHmac('sha256',this.key).update(value).digest('hex'); }
  private gate(): Gate | null {
    try {
      // Trusted local operator path outside the restored database; never request-derived.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const envelope=JSON.parse(readFileSync(this.gatePath,'utf8')) as {payload:Gate;signature:string};
      return this.mac(JSON.stringify(envelope.payload))===envelope.signature && Number.isSafeInteger(envelope.payload.flushedSequence) && envelope.payload.flushedSequence >= 0 && typeof envelope.payload.flushedSignature === 'string' ? envelope.payload:null;
    } catch { return null; }
  }
  private writeGate(gate: Gate): void {
    const temp=this.gatePath+'.'+randomUUID()+'.tmp';
    // Config-owned local control directory, excluded from git, independent of DB restore.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    mkdirSync(dirname(this.gatePath),{recursive:true});
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const fd = openSync(temp,'wx',0o600);
    try {
      // Descriptor was opened above on the exact trusted temporary gate path.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      writeFileSync(fd,JSON.stringify({payload:gate,signature:this.mac(JSON.stringify(gate))}));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    // Atomic replacement makes every local instance observe closed before DB restore starts.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    try { renameSync(temp,this.gatePath); }
    catch (error) {
      // Remove only this writer's uncommitted temporary file, never another control file.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      try { unlinkSync(temp); } catch { /* Preserve the original replacement error. */ }
      throw error;
    }
  }
  isOpen(): boolean {
    const gate = this.gate(); if (this.failed || !this.priorityVerified || !gate?.open || !this.fileJournal.isVerified()) return false;
    return this.fileJournal.length >= gate.flushedSequence && this.fileJournal.signatureAt(gate.flushedSequence) === gate.flushedSignature;
  }
  async initialize(): Promise<void> {
    await this.external.collection<Journal>('events').createIndex({eventId:1},{unique:true});
    await this.external.collection<{_id:string;sequence:number;signature:string}>('head').updateOne({_id:'security'},{$setOnInsert:{sequence:0,signature:''}},{upsert:true});
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if(!existsSync(this.gatePath)) {
      const fresh=await this.database.db.collection('identities').countDocuments()===0&&
        await this.database.db.collection('audit_events').countDocuments()===0;
      if (fresh) {
        try { this.fileJournal.createEmpty(); } catch { /* Existing unclaimed evidence cannot be overwritten. */ }
      }
      this.writeGate({open:fresh,requiredCut:0,snapshotWatermark:0,reviewId:null,flushedSequence:0,flushedSignature:''});
    }
    let head=await this.external.collection<{_id:string;sequence:number;signature:string}>('head').findOne({_id:'security'});
    let sequence=await this.database.db.collection<{_id:string;value:number}>('security_sequence').findOne({_id:'security'});
    let gate = this.gate();
    let rows: Journal[] = [], valid = !!gate;
    try {
      await this.fileJournal.exclusive(async () => {
      head=await this.external.collection<{_id:string;sequence:number;signature:string}>('head').findOne({_id:'security'});
      sequence=await this.database.db.collection<{_id:string;value:number}>('security_sequence').findOne({_id:'security'});
      gate = this.gate();
      rows = await this.fileJournal.readVerified(true);
      const copy = await this.external.collection<Journal>('events').find({_id:{$lte:rows.length}}).sort({_id:1}).toArray();
      valid = valid && rows.length === (head?.sequence ?? 0) && (head?.signature??'') === (rows.at(-1)?.signature??'') && JSON.stringify(copy) === JSON.stringify(rows) && rows.length >= (gate?.flushedSequence ?? 0)
        && (gate?.flushedSequence === 0 ? gate.flushedSignature === '' : rows.at((gate?.flushedSequence ?? 0) - 1)?.signature === gate?.flushedSignature)
        && (sequence?.value ?? 0) >= Math.max(rows.length, gate?.flushedSequence ?? 0);
      });
    } catch { valid = false; }
    // Full financial evidence is checked at startup/reconcile, never synchronously on requests.
    // Include committed but not-yet-flushed domain evidence; a missing signed cut cannot reopen a restore.
    const localFinancialHead=await this.database.db.collection<{_id:string;digest:string;revision:number}>('financial_evidence_head').findOne({_id:'finance'});
    const signedFinance=rows.length?reconstructSecurityState(rows).finance:undefined;
    if(!await financialEvidenceMatches(this.database,localFinancialHead??signedFinance))valid=false;
    if(signedFinance&&(!localFinancialHead||localFinancialHead.revision<signedFinance.revision))valid=false;
    if(signedFinance&&localFinancialHead?.revision===signedFinance.revision&&localFinancialHead.digest!==signedFinance.digest)valid=false;
    const localLending=await lendingHead(this.database),signedLending=rows.length?reconstructSecurityState(rows).lending:undefined;
    if(valid)anchorEvidence(this.database,signedLending);
    if(!await lendingEvidenceMatches(this.database,localLending??signedLending))valid=false;
    if(signedLending&&(!localLending||localLending.revision<signedLending.revision||localLending.revision===signedLending.revision&&localLending.digest!==signedLending.digest))valid=false;
    if (!valid || !gate?.open) this.writeGate({open:false,requiredCut:Math.max(gate?.requiredCut??0,gate?.flushedSequence??0,head?.sequence??0,sequence?.value??0,rows.length),snapshotWatermark:sequence?.value??0,reviewId:null,flushedSequence:gate?.flushedSequence??rows.length,flushedSignature:gate?.flushedSignature??rows.at(-1)?.signature??''});
    else if(gate.flushedSequence!==rows.length||gate.flushedSignature!==(rows.at(-1)?.signature??''))
      this.writeGate({...gate,flushedSequence:rows.length,flushedSignature:rows.at(-1)?.signature??''});
    // A peer append invalidates the local cache; verify it asynchronously under the
    // same journal lock before deciding availability. An unknown stamp is not proof
    // that the signed journal is corrupt. No request trusts an unverified prefix.
    this.database.securityCheck = async predicate => {
      try {
        // A current authenticated prefix needs no writer lock. In particular,
        // queued audit events remain usable until the normal durable flush; a
        // residual lock is handled by that flush's fail-closed policy. Waiting is
        // needed only for an unverified peer change, never for unchanged evidence.
        // A different OS process may append between these two synchronous
        // observations. If the predicate sees that change, use the locked
        // verification below rather than reporting a spurious closed realm.
        if (this.isOpen() && predicate()) return true;
        return await this.fileJournal.exclusive(async () => {
        await this.fileJournal.readVerified();
        return this.isOpen() && predicate();
      }); } catch { return false; }
    };
    this.database.transactionGuard=async()=>{if(!await this.database.securityCheck!(()=>true))throw new AppError(503,'SERVICE_UNAVAILABLE');};
    if(valid&&this.isOpen()&&localLending?.format==='lending-v1'){
      try{
      // Flush/reconcile the verified legacy watermark before creating a new representation.
      // No command can bootstrap an unanchored digest or adopt tampered business terms.
      await this.flush();
      const signed=reconstructSecurityState(await this.fileJournal.readVerified()).lending;
      if(!signed||signed.format!=='lending-v1'||signed.digest!==localLending.digest||signed.revision!==localLending.revision)throw new AppError(503,'SERVICE_UNAVAILABLE');
      await migrateV2(this.database,signed,s=>lendingDigest(this.database,s));await this.flush();
      }catch{
        this.failed=true;const current=this.gate();if(current)this.writeGate({...current,open:false});throw new AppError(503,'SERVICE_UNAVAILABLE');
      }
    }
    if(this.priority&&valid&&gate?.open){
      try{
        const current=this.gate();if(!current)throw new AppError(503,'SERVICE_UNAVAILABLE');
        this.writeGate({...current,open:false});
        await this.ensurePriorityVerified();
        const ready=this.gate();if(!ready)throw new AppError(503,'SERVICE_UNAVAILABLE');
        this.writeGate({...ready,open:true});
      }catch{this.failed=true;const current=this.gate();if(current)this.writeGate({...current,open:false});throw new AppError(503,'SERVICE_UNAVAILABLE');}
    }
  }
  // Restore-only, closed-admission path. Normal database.transaction always keeps its guard.
  private async maintenance(work:(s:ClientSession)=>Promise<void>){
    if(this.gate()?.open)throw new AppError(503,'SERVICE_UNAVAILABLE');
    await this.database.client.withSession(async session=>await session.withTransaction(async()=>{
      await this.database.db.collection<{_id:string;value:number}>('transaction_fence').updateOne({_id:'security'},{$inc:{value:1}},{session,upsert:true});
      if(this.gate()?.open)throw new AppError(503,'SERVICE_UNAVAILABLE');await work(session);
    },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},readPreference:'primary'}));
  }
  private async ensurePriorityVerified(){
    if(!this.priority){this.priorityVerified=true;return;}
    if(this.gate()?.open)throw new AppError(503,'SERVICE_UNAVAILABLE');this.priorityVerified=false;
    const initial=await lendingHead(this.database);
    if(!initial){if(!await lendingEvidenceMatches(this.database,undefined))throw new AppError(503,'INTEGRITY_MISMATCH');this.priorityVerified=true;return;}
    if(!await lendingEvidenceMatches(this.database,initial))throw new AppError(503,'INTEGRITY_MISMATCH');
    for(let phase=0;phase<2;phase++){
      await this.flush();
      await this.fileJournal.exclusive(async()=>{
        const rows=await this.fileJournal.readVerified(),signed=rows.length?reconstructSecurityState(rows).lending:undefined,current=await lendingHead(this.database);
        if(!current||!signed||signed.digest!==current.digest||signed.revision!==current.revision||!await lendingEvidenceMatches(this.database,current))throw new AppError(503,'INTEGRITY_MISMATCH');
        if(current.format==='lending-v1')await migrateV2(this.database,signed,s=>lendingDigest(this.database,s),w=>this.maintenance(w));
        else await migratePriorities(this.database,signed,w=>this.maintenance(w));
      });
      await this.flush();
      const current=await this.database.db.collection<{_id:string;priorityPolicy?:string;priorityKeyId?:string}>('lending_domain_state').findOne({_id:'evidence'}),signed=reconstructSecurityState(await this.fileJournal.readVerified()).lending,head=await lendingHead(this.database);
      if(current?.priorityPolicy==='HMAC-SHA256-v1'&&current.priorityKeyId===createHash('sha256').update(this.priority).digest('hex')&&head&&signed?.digest===head.digest&&signed.revision===head.revision&&await lendingEvidenceMatches(this.database,head)){this.priorityVerified=true;return;}
    }
    throw new AppError(503,'INTEGRITY_MISMATCH');
  }

  async flush(): Promise<void> {
    try { return await this.fileJournal.exclusive(async () => {
    const initial = this.gate(); if (!initial) throw new AppError(503,'SERVICE_UNAVAILABLE');
    const file = await this.fileJournal.readVerified();
    anchorEvidence(this.database,file.at(-1)?.state.lending);
    if (file.length < initial.flushedSequence || (initial.flushedSequence > 0 && file.at(initial.flushedSequence - 1)?.signature !== initial.flushedSignature)) throw new AppError(503,'SERVICE_UNAVAILABLE');
    const rows=this.database.db.collection<{_id:number;eventId:string;state:SecurityEvidence}>('security_evidence_outbox').find({_id:{$gt:file.length}}).sort({_id:1});
    for await(const row of rows) {
      await this.database.client.withSession(async session=>await session.withTransaction(async()=>{
        const heads=this.external.collection<{_id:string;sequence:number;signature:string}>('head');
        const head=await heads.findOne({_id:'security'},{session});if(!head)throw new Error('External head missing');
        if(row._id<=head.sequence)return;
        if(row._id!==head.sequence+1)throw new Error('External evidence sequence gap');
        const data={_id:row._id,eventId:row.eventId,previous:head.signature,state:row.state};
        const signature=this.mac(JSON.stringify(data));
        await this.external.collection<Journal>('events').insertOne({...data,signature},{session});
        await heads.updateOne({_id:'security',sequence:head.sequence},{$set:{sequence:row._id,signature}},{session});
      }));
      if (row._id > this.fileJournal.length) {
        const persisted = await this.external.collection<Journal>('events').findOne({_id:row._id});
        if (!persisted) throw new AppError(503,'SERVICE_UNAVAILABLE');
        await this.fileJournal.append(persisted);
        anchorEvidence(this.database,persisted.state.lending);
      }
    }
    const gate = this.gate(); if (!gate) throw new AppError(503,'SERVICE_UNAVAILABLE');
    const flushedSequence = this.fileJournal.length, flushedSignature = this.fileJournal.signatureAt(flushedSequence) ?? '';
    if (gate.flushedSequence !== flushedSequence || gate.flushedSignature !== flushedSignature) {
      try {
        this.writeGate({...gate,flushedSequence,flushedSignature,requiredCut:gate.open?gate.requiredCut:Math.max(gate.requiredCut,flushedSequence)});
        this.pendingWatermark = false;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Windows readers may deny atomic replacement while allowing reads. Both
        // durable journal copies already contain this cut. Retain the *unchanged*,
        // authentic open gate and retry its watermark on the next dispatcher tick.
        // Never treat journal append/fsync errors, altered gates or closed gates as
        // this case. Startup independently checks primary sequence >= journal head.
        const current = this.gate();
        const head = await this.external.collection<{_id:string;sequence:number;signature:string}>('head').findOne({_id:'security'});
        const primary = await this.database.db.collection<{_id:string;value:number}>('security_sequence').findOne({_id:'security'});
        if (!['EPERM','EBUSY','EACCES'].includes(code ?? '') || !gate.open ||
          JSON.stringify(current) !== JSON.stringify(gate) || !this.fileJournal.isVerified() ||
          head?.sequence !== flushedSequence || head.signature !== flushedSignature ||
          (primary?.value ?? 0) < flushedSequence) throw error;
        this.pendingWatermark = true;
      }
    } else this.pendingWatermark = false;
    }); } catch {
      // A stalled journal is a durable closed gate, not a warning while auth stays available.
      this.failed = true;
      const gate = this.gate();
      try {
        const seq = await this.database.db.collection<{_id:string;value:number}>('security_sequence').findOne({_id:'security'});
        if (gate) this.writeGate({...gate,open:false,reviewId:null,requiredCut:Math.max(gate.requiredCut,gate.flushedSequence,this.fileJournal.length,seq?.value??0)});
      } catch { /* In-memory failure remains closed even if storage itself cannot persist the gate. */ }
      throw new AppError(503,'SERVICE_UNAVAILABLE');
    }
  }
  async snapshot(): Promise<SyntheticSnapshot> {
    await this.flush();
    const names=(await this.database.db.listCollections().toArray()).map(c=>c.name).filter(n=>!n.startsWith('system.')&&n!=='transaction_fence');
    return await this.database.transaction(async session=>{
      const collections:Record<string,string>={};
      for(const name of names){
        // Collection names are enumerated by MongoDB, not provided over HTTP.
        // eslint-disable-next-line security/detect-object-injection
        collections[name]=BSON.EJSON.stringify(await this.database.db.collection(name).find({},{session}).toArray());
      }
      const seq=await this.database.db.collection<{_id:string;value:number}>('security_sequence').findOne({_id:'security'},{session});
      const data={watermark:seq?.value??0,collections};
      return {...data,signature:this.mac(JSON.stringify(data))};
    });
  }
  async beginRestore(snapshot:SyntheticSnapshot):Promise<void>{
    const prior = this.gate();
    const stamp = {flushedSequence:prior?.flushedSequence??0,flushedSignature:prior?.flushedSignature??''};
    this.writeGate({open:false,requiredCut:prior?.requiredCut??0,snapshotWatermark:snapshot.watermark,reviewId:null,...stamp});
    if(snapshot.signature!==this.mac(JSON.stringify({watermark:snapshot.watermark,collections:snapshot.collections})))throw new AppError(503,'SERVICE_UNAVAILABLE');
    // Fence waits for security transactions already in flight; new transactions read the closed external gate.
    await this.database.client.withSession(async session=>await session.withTransaction(async()=>{
      await this.database.db.collection<{_id:string;value:number}>('transaction_fence').updateOne({_id:'security'},{$inc:{value:1}},{session,upsert:true});
    }));
    const seq=await this.database.db.collection<{_id:string;value:number}>('security_sequence').findOne({_id:'security'});
    const head=await this.external.collection<{_id:string;sequence:number}>('head').findOne({_id:'security'});
    const cut=Math.max(seq?.value??0,head?.sequence??0,stamp.flushedSequence);
    this.writeGate({open:false,requiredCut:cut,snapshotWatermark:snapshot.watermark,reviewId:null,...stamp});
    try{await this.flush();}catch{/* Missing external evidence MUST leave the realm closed; never fabricate events. */}
    const existing=(await this.database.db.listCollections().toArray()).map(c=>c.name).filter(n=>!n.startsWith('system.')&&n!=='transaction_fence');
    await this.database.client.withSession(async session=>await session.withTransaction(async()=>{
      for(const name of new Set([...existing,...Object.keys(snapshot.collections)])){
        await this.database.db.collection(name).deleteMany({},{session});
        // Snapshot produced by this local controller, not an HTTP document.
        // eslint-disable-next-line security/detect-object-injection
        const encoded=snapshot.collections[name];
        if(encoded){const documents=BSON.EJSON.parse(encoded) as Document[];if(documents.length)await this.database.db.collection(name).insertMany(documents,{session});}
      }
      await this.database.db.collection('contexts').updateMany({},{$set:{revoked:true}},{session});
      await this.database.db.collection('email_proofs').updateMany({},{$set:{consumed:true}},{session});
      await this.database.db.collection('synthetic_mail').updateMany({},{$set:{delivered:true}},{session});
      await this.database.db.collection('synthetic_notifications').updateMany({},{$set:{delivered:true}},{session});
      await this.database.db.collection('outbox').updateMany({},{$set:{dispatched:true}},{session});
      await this.database.db.collection('mail_quotas').updateMany({},{$set:{pending:null}},{session});
      // Provisional registration requests never survive a restore as credential grants.
      await this.database.db.collection('registration_intents').deleteMany({},{session});
      await this.database.db.collection('identities').updateMany({factorCount:0},{$set:{restoreBootstrapBlocked:true}},{session});
    }));
  }
  // Only the single committed, authenticated HMAC transition may bridge a failed
  // external flush. Admission stays closed; arbitrary pending domain events cannot
  // be adopted by operator review or replace the last signed financial/security cut.
  private async recoverPriorityFlush():Promise<void>{
    const recover=await this.fileJournal.exclusive(async()=>{
      const gate=this.gate();if(!gate||gate.open)throw new AppError(503,'SERVICE_UNAVAILABLE');
      const file=await this.fileJournal.readVerified(true);
      if(file.length>=gate.requiredCut)return false;
      const fail=()=>{throw new AppError(503,'SERVICE_UNAVAILABLE');};
      if(!this.priority||gate.requiredCut!==file.length+1||file.length<gate.flushedSequence||this.fileJournal.signatureAt(gate.flushedSequence)!==gate.flushedSignature)fail();
      const external=await this.external.collection<Journal>('events').find({}).sort({_id:1}).toArray();
      const externalHead=await this.external.collection<{_id:string;sequence:number;signature:string}>('head').findOne({_id:'security'});
      if(JSON.stringify(external)!==JSON.stringify(file)||externalHead?.sequence!==file.length||externalHead.signature!==(file.at(-1)?.signature??''))fail();
      const primary=await this.database.db.collection<{_id:string;value:number}>('security_sequence').findOne({_id:'security'});
      const queued=await this.database.db.collection<{_id:number;eventId:string;state:SecurityEvidence}>('security_evidence_outbox').find({_id:{$gt:file.length}}).toArray();
      const row=queued[0];if(primary?.value!==gate.requiredCut||queued.length!==1||row?._id!==gate.requiredCut)fail();
      const audit=await this.database.db.collection('audit_events').findOne({eventId:row!.eventId,sequence:gate.requiredCut,actorId:'SYSTEM_LOCAL_TRANSITION',subjectId:'PRIORITY_HMAC_V1',action:'PRIORITY_HMAC_VERIFIED_TRANSITION',outcome:'SUCCESS'});
      const old=reconstructSecurityState(file),local=await lendingHead(this.database);
      const stored=await this.database.db.collection<{_id:string;previousDigest:string;priorityPolicy?:string;priorityKeyId?:string}>('lending_domain_state').findOne({_id:'evidence'});
      const checkpoint=await this.database.db.collection<{_id:string;previous:{digest:string;revision:number}}>('lending_priority_checkpoint').findOne({_id:'hmac-v1'});
      if(!audit||!old.lending||!local||stored?.priorityPolicy!=='HMAC-SHA256-v1'||stored.priorityKeyId!==createHash('sha256').update(this.priority!).digest('hex')||stored.previousDigest!==old.lending.digest||local.revision!==old.lending.revision+1||checkpoint?.previous.digest!==old.lending.digest||checkpoint.previous.revision!==old.lending.revision||!await lendingEvidenceMatches(this.database,local)||!await financialEvidenceMatches(this.database,old.finance))fail();
      const next=reconstructSecurityState([...file,row!]);
      if(next.lending?.digest!==local!.digest||next.lending.revision!==local!.revision||JSON.stringify({...next,lending:old.lending})!==JSON.stringify(old))fail();
      return true;
    });
    if(recover)await this.flush();
  }
  async reconcile(review:{approved:boolean;reviewId:string}):Promise<void>{
    if(!review.approved||!review.reviewId.trim())throw new AppError(503,'SERVICE_UNAVAILABLE');
    await this.recoverPriorityFlush();
    const gate=this.gate();if(!gate||gate.open)throw new Error('Restore gate not closed');
    const events=await this.external.collection<Journal>('events').find({_id:{$lte:gate.requiredCut}}).sort({_id:1}).toArray();
    const file = await this.fileJournal.readVerified(true);
    if (gate.requiredCut < gate.flushedSequence || file.length < gate.requiredCut || JSON.stringify(file.slice(0,gate.requiredCut)) !== JSON.stringify(events)) throw new AppError(503,'SERVICE_UNAVAILABLE');
    let previous='',sequence=0;
    for(const event of events){
      const data={_id:event._id,eventId:event.eventId,previous:event.previous,state:event.state};
      if(event._id!==++sequence||event.previous!==previous||event.signature!==this.mac(JSON.stringify(data)))throw new AppError(503,'SERVICE_UNAVAILABLE');
      previous=event.signature;
    }
    if(sequence!==gate.requiredCut||gate.snapshotWatermark>sequence)throw new AppError(503,'SERVICE_UNAVAILABLE');
    const state=events.length ? reconstructSecurityState(events) : null;
    if(!state&&gate.requiredCut!==0)throw new AppError(503,'SERVICE_UNAVAILABLE');
    if(!await financialEvidenceMatches(this.database,state?.finance))throw new AppError(503,'SERVICE_UNAVAILABLE');
    let pendingMigration=false;
    if(!await lendingEvidenceMatches(this.database,state?.lending)){
      const local=await lendingHead(this.database),checkpoint=await this.database.db.collection<{_id:string;previous?:{digest:string;revision:number}}>('lending_priority_checkpoint').findOne({_id:'hmac-v1'});
      if(!this.priority||!local||!state?.lending||checkpoint?.previous?.digest!==state.lending.digest||checkpoint.previous.revision!==state.lending.revision||!await lendingEvidenceMatches(this.database,local))throw new AppError(503,'SERVICE_UNAVAILABLE');pendingMigration=true;
    }
    const primary=await this.database.db.collection<{_id:string;value:number}>('security_sequence').findOne({_id:'security'});
    await this.database.client.withSession(async session=>await session.withTransaction(async()=>{
      if(state){
        const onboardingById=new Map(state.onboarding?.identities.map(i=>[i._id,i])??[]);
        for(const tombstone of state.onboarding?.tombstones??[]){
          await this.database.db.collection<{_id:string}>('identities').deleteOne({_id:tombstone._id},{session});
          await this.database.db.collection<{_id:string}>('restore_claims').updateOne({_id:tombstone.emailHash},{$setOnInsert:{_id:tombstone.emailHash}},{session,upsert:true});
          await this.database.db.collection<{_id:string}>('onboarding_tombstones').replaceOne({_id:tombstone._id},tombstone,{session,upsert:true});
        }
        for(const current of state.identities){
          const stored=await this.database.db.collection<Identity>('identities').findOne({_id:current._id},{session});
          if(!stored){await this.database.db.collection<{_id:string}>('restore_claims').updateOne({_id:current.emailHash},{$setOnInsert:{_id:current.emailHash}},{session,upsert:true});continue;}
          const onboarding=onboardingById.get(current._id);
          const mismatch=stored.credentialVersion!==current.credentialVersion;
          const update:Partial<Identity>={...(onboarding?{emailVerified:onboarding.emailVerified,createdAt:onboarding.createdAt,profileVersion:onboarding.profileVersion,...(onboarding.registrationSource?{registrationSource:onboarding.registrationSource}:{})}:{}),roles:current.roles,organizationId:current.organizationId,suspended:current.suspended,version:current.version,
            credentialVersion:current.credentialVersion,authEpoch:current.authEpoch,authzVersion:current.authzVersion,
            initialProofEpoch:current.initialProofEpoch,hasEverConfirmedFactor:stored.hasEverConfirmedFactor||current.hasEverConfirmedFactor,
            hasEverActive:stored.hasEverActive||current.hasEverActive,resetCompletedAt:Math.max(stored.resetCompletedAt??0,current.resetCompletedAt??0)||null,
            state:current.suspended?'SUSPENDED':current.state==='RECOVERY_RESTRICTED'?'FACTOR_LOSS_BLOCKED':current.state,
            restoreBootstrapBlocked:mismatch||current.hasEverConfirmedFactor||current.resetCompletedAt!==null,
            ...(mismatch?{passwordHash:null}:{})};
          await this.database.db.collection<Identity>('identities').updateOne({_id:stored._id},{$set:update},{session});
        }
        const factorStates=new Map(state.factors.map(f=>[f._id,f]));
        for(const factor of await this.database.db.collection('factors').find({},{session}).toArray()){
          const latest=factorStates.get(String(factor['_id']));
          const safe=latest?.state==='ACTIVE'&&latest.version===factor['version'];
          await this.database.db.collection('factors').updateOne({_id:factor['_id']},{$set:{state:safe?'ACTIVE':'REVOKED',
            counter:Math.max(Number(factor['counter']??0),latest?.counter??0),
            ...(latest?.lastStep!==null&&latest?.lastStep!==undefined?{lastStep:Math.max(Number(factor['lastStep']??-1),latest.lastStep)}:{})}},{session});
        }
        const codeStates=new Map(state.codes.map(c=>[c._id,c]));
        for(const code of await this.database.db.collection('recovery_codes').find({},{session}).toArray()){
          const latest=codeStates.get(String(code['_id']));
          await this.database.db.collection('recovery_codes').updateOne({_id:code['_id']},{$set:{consumed:code['consumed']===true||!latest||latest.consumed||latest.batch!==code['batch']}},{session});
        }
        for(const invitation of state.invitations)await this.database.db.collection<{_id:string}>('invitations').updateOne({_id:invitation._id},{$set:{status:invitation.status,roleIds:invitation.roleIds,version:invitation.version,inviterAuthzVersion:invitation.inviterAuthzVersion}},{session});
        for(const organization of state.organizations)await this.database.db.collection<{_id:string}>('organizations').updateOne({_id:organization._id},{$set:{status:organization.status,name:organization.name,version:organization.version,authEpoch:organization.authEpoch}},{session});
        for(const identity of await this.database.db.collection<Identity>('identities').find({},{session}).toArray()){
          const count=await this.database.db.collection('factors').countDocuments({subjectId:identity._id,state:'ACTIVE'},{session});
          await this.database.db.collection<Identity>('identities').updateOne({_id:identity._id},{$set:{factorCount:count,
            ...(!count&&identity.hasEverConfirmedFactor&&!identity.suspended?{state:'FACTOR_LOSS_BLOCKED' as const}:{})}},{session});
        }
      }
      await this.database.db.collection('webauthn_ceremonies').updateMany({},{$set:{consumed:true}},{session});
      await this.database.db.collection('recoveries').updateMany({status:'ACTIVE'},{$set:{status:'REVOKED'}},{session});
      await this.database.db.collection<{_id:string;value:number}>('security_sequence').updateOne({_id:'security'},{$set:{value:pendingMigration?Math.max(gate.requiredCut,primary?.value??0):gate.requiredCut}},{session,upsert:true});
      // Projection rolled back with primary data; the next event is an explicit signed checkpoint.
      await this.database.db.collection('security_evidence_projection').deleteMany({},{session});
    }));
    await this.ensurePriorityVerified();
    const ready=this.gate();if(!ready||!this.priorityVerified)throw new AppError(503,'SERVICE_UNAVAILABLE');
    this.writeGate({...ready,open:true,reviewId:review.reviewId});
    this.failed = false;
  }
}
