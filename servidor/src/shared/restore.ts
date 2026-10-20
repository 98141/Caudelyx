import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { BSON, type Document } from 'mongodb';
import type { Database } from './database.js';
import type { SecurityState } from './evidence.js';
import type { Identity } from '../modules/identity/models.js';
import { AppError } from './errors.js';
import { ExternalJournal, type JournalEntry } from './external-journal.js';

interface Gate { open: boolean; requiredCut: number; snapshotWatermark: number; reviewId: string | null; flushedSequence: number; flushedSignature: string }
type Journal = JournalEntry;
export interface SyntheticSnapshot { watermark: number; collections: Record<string,string>; signature: string }
export class RestoreController {
  private readonly external;
  readonly fileJournal;
  constructor(readonly database: Database, readonly gatePath: string, readonly key: Buffer) {
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
    renameSync(temp,this.gatePath);
  }
  isOpen(): boolean {
    const gate = this.gate(); if (!gate?.open) return false;
    try {
      const rows = this.fileJournal.read();
      return rows.length >= gate.flushedSequence && (gate.flushedSequence === 0 ? gate.flushedSignature === '' : rows.at(gate.flushedSequence - 1)?.signature === gate.flushedSignature);
    } catch { return false; }
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
    const head=await this.external.collection<{_id:string;sequence:number;signature:string}>('head').findOne({_id:'security'});
    const sequence=await this.database.db.collection<{_id:string;value:number}>('security_sequence').findOne({_id:'security'});
    const gate = this.gate();
    let rows: Journal[] = [], valid = !!gate;
    try {
      rows = this.fileJournal.read();
      const copy = await this.external.collection<Journal>('events').find({_id:{$lte:rows.length}}).sort({_id:1}).toArray();
      valid = valid && rows.length === (head?.sequence ?? 0) && (head?.signature??'') === (rows.at(-1)?.signature??'') && JSON.stringify(copy) === JSON.stringify(rows) && rows.length >= (gate?.flushedSequence ?? 0)
        && (gate?.flushedSequence === 0 ? gate.flushedSignature === '' : rows.at((gate?.flushedSequence ?? 0) - 1)?.signature === gate?.flushedSignature)
        && (sequence?.value ?? 0) >= Math.max(rows.length, gate?.flushedSequence ?? 0);
    } catch { valid = false; }
    if (!valid || !gate?.open) this.writeGate({open:false,requiredCut:Math.max(gate?.requiredCut??0,gate?.flushedSequence??0,head?.sequence??0,rows.length),snapshotWatermark:sequence?.value??0,reviewId:null,flushedSequence:gate?.flushedSequence??rows.length,flushedSignature:gate?.flushedSignature??rows.at(-1)?.signature??''});
    this.database.transactionGuard=()=>{if(!this.isOpen())throw new AppError(503,'SERVICE_UNAVAILABLE');};
  }
  async flush(): Promise<void> {
    return await this.fileJournal.exclusive(async () => {
    const initial = this.gate(); if (!initial) throw new AppError(503,'SERVICE_UNAVAILABLE');
    const file = this.fileJournal.read();
    if (file.length < initial.flushedSequence || (initial.flushedSequence > 0 && file.at(initial.flushedSequence - 1)?.signature !== initial.flushedSignature)) throw new AppError(503,'SERVICE_UNAVAILABLE');
    const rows=await this.database.db.collection<{_id:number;eventId:string;state:SecurityState}>('security_evidence_outbox').find({_id:{$gt:file.length}}).sort({_id:1}).toArray();
    for(const row of rows) {
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
      const currentFile = this.fileJournal.read();
      if (row._id > currentFile.length) {
        const persisted = await this.external.collection<Journal>('events').findOne({_id:row._id});
        if (!persisted) throw new AppError(503,'SERVICE_UNAVAILABLE');
        this.fileJournal.append(persisted);
      }
      const last = this.fileJournal.read().at(-1), gate = this.gate();
      if (!gate) throw new AppError(503,'SERVICE_UNAVAILABLE');
      this.writeGate({...gate,flushedSequence:last?._id??0,flushedSignature:last?.signature??''});
    }
    });
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
      await this.database.db.collection('identities').updateMany({factorCount:0},{$set:{restoreBootstrapBlocked:true}},{session});
    }));
  }
  async reconcile(review:{approved:boolean;reviewId:string}):Promise<void>{
    if(!review.approved||!review.reviewId.trim())throw new AppError(503,'SERVICE_UNAVAILABLE');
    const gate=this.gate();if(!gate||gate.open)throw new Error('Restore gate not closed');
    const events=await this.external.collection<Journal>('events').find({_id:{$lte:gate.requiredCut}}).sort({_id:1}).toArray();
    const file = this.fileJournal.read();
    if (gate.requiredCut < gate.flushedSequence || file.length < gate.requiredCut || JSON.stringify(file.slice(0,gate.requiredCut)) !== JSON.stringify(events)) throw new AppError(503,'SERVICE_UNAVAILABLE');
    let previous='',sequence=0;
    for(const event of events){
      const data={_id:event._id,eventId:event.eventId,previous:event.previous,state:event.state};
      if(event._id!==++sequence||event.previous!==previous||event.signature!==this.mac(JSON.stringify(data)))throw new AppError(503,'SERVICE_UNAVAILABLE');
      previous=event.signature;
    }
    if(sequence!==gate.requiredCut||gate.snapshotWatermark>sequence)throw new AppError(503,'SERVICE_UNAVAILABLE');
    const state=events.at(-1)?.state;
    if(!state&&gate.requiredCut!==0)throw new AppError(503,'SERVICE_UNAVAILABLE');
    await this.database.client.withSession(async session=>await session.withTransaction(async()=>{
      if(state){
        for(const current of state.identities){
          const stored=await this.database.db.collection<Identity>('identities').findOne({_id:current._id},{session});
          if(!stored){await this.database.db.collection<{_id:string}>('restore_claims').updateOne({_id:current.emailHash},{$setOnInsert:{_id:current.emailHash}},{session,upsert:true});continue;}
          const mismatch=stored.credentialVersion!==current.credentialVersion;
          const update:Partial<Identity>={roles:current.roles,organizationId:current.organizationId,suspended:current.suspended,version:current.version,
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
      await this.database.db.collection<{_id:string;value:number}>('security_sequence').updateOne({_id:'security'},{$set:{value:gate.requiredCut}},{session,upsert:true});
    }));
    this.writeGate({...gate,open:true,reviewId:review.reviewId,flushedSequence:gate.requiredCut,flushedSignature:events.at(-1)?.signature??''});
  }
}
