import { pristineHistory } from '../identity/onboarding.js';
import { MongoServerError, type ClientSession } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { AuditWriter } from '../../shared/audit.js';
import type { Database } from '../../shared/database.js';
import { digest, opaque, seal, unseal } from '../../shared/crypto.js';
import type { EmailProof, Identity, Quota, SyntheticMessage } from '../identity/models.js';

export const resetWarning = 'Si completas este restablecimiento antes de registrar tu primer factor MFA, no podrás terminar el alta y no hay reparación disponible en esta fase. Si no solicitaste el restablecimiento, ignora este correo y no lo completes';
export interface DeliveredMail { id: string; subjectId: string; purpose: EmailProof['purpose']; token: string; warning: string | null; activationNotice?:string|null; rejectionAction?:string|null }
export interface SyntheticNotification { _id:string;realm:Identity['realm'];subjectId:string;kind:string;encryptedPayload:string;expiresAt:number;delivered:boolean;leaseUntil?:number;leaseOwner?:string }

export class SyntheticMessaging {
  readonly messages;
  readonly proofs;
  readonly quotas;
  private readonly sink;
  private readonly audit;
  readonly notifications;
  private readonly notificationSink;
  readonly notificationInbox=new Map<string,{kind:string;subjectId:string;payload:Record<string,string>}>();
  notificationAllowed?: (notification:SyntheticNotification)=>Promise<boolean>;
  private readonly owner = randomUUID();
  readonly telemetry = { retries: 0, overdue: 0, failures: 0,queueOverdue:0,maxQueueDelayMs:0 };
  // Synthetic transport is memory only, never an HTTP endpoint or a file containing clear tokens.
  readonly inbox = new Map<string, DeliveredMail>();
  constructor(database: Database, private readonly key: Buffer, readonly now: () => number) {
    if (key.length !== 32) throw new Error('Synthetic encryption key must be 32 bytes');
    this.messages = database.db.collection<SyntheticMessage>('synthetic_mail');
    this.proofs = database.db.collection<EmailProof>('email_proofs');
    this.quotas = database.db.collection<Quota>('mail_quotas');
    this.sink = database.client.db(`${database.db.databaseName}_external_mail`).collection<SyntheticMessage>('delivered');
    this.audit = new AuditWriter(database);
    this.notifications=database.db.collection<SyntheticNotification>('synthetic_notifications');
    this.notificationSink=database.client.db(`${database.db.databaseName}_external_mail`).collection<SyntheticNotification>('notifications');
  }
  async notify(realm:Identity['realm'],subjectId:string,kind:string,payload:Record<string,string>,session:ClientSession):Promise<void>{
    await this.notifications.insertOne({_id:randomUUID(),realm,subjectId,kind,encryptedPayload:seal(JSON.stringify(payload),this.key),expiresAt:this.now()+86400000,delivered:false},{session});
  }
  async deliverNotifications(afterSink?:()=>void):Promise<void>{
    if(!this.notificationAllowed)return;
    for(const note of await this.notifications.find({delivered:false,expiresAt:{$gt:this.now()}}).toArray()){
      if(!await this.notificationAllowed(note))continue;
      const claim=await this.notifications.findOneAndUpdate({_id:note._id,delivered:false,$or:[{leaseUntil:{$exists:false}},{leaseUntil:{$lte:this.now()}}]},{$set:{leaseOwner:this.owner,leaseUntil:this.now()+30000}},{returnDocument:'after'});
      if(!claim)continue;
      try{
        if(claim.expiresAt<=this.now()||!await this.notificationAllowed(claim))continue;
        try{await this.notificationSink.insertOne({...claim,delivered:true});}catch(e){if(!(e instanceof MongoServerError)||e.code!==11000)throw e;}
        afterSink?.(); // Synthetic process-failure test only; never supplied from HTTP.
        await this.notifications.updateOne({_id:claim._id,leaseOwner:this.owner},{$set:{delivered:true},$unset:{leaseUntil:'',leaseOwner:''}});
        this.notificationInbox.set(claim._id,{kind:claim.kind,subjectId:claim.subjectId,payload:JSON.parse(unseal(claim.encryptedPayload,this.key)) as Record<string,string>});
      }catch(e){this.telemetry.failures++;throw e;}
    }
  }
  async enqueue(identity: Identity, purpose: EmailProof['purpose'], source: string, contextId: string | null,
    session: ClientSession, fromPending = false): Promise<boolean> {
    const now = this.now(), id = digest(`${identity.realm}:${identity.email}:${purpose}`);
    const quota = await this.quotas.findOne({ _id: id }, { session }) ?? { _id: id,
      subjectId: identity._id, realm: identity.realm, purpose, sentAt: [], sourceTimes: {}, pending: null };
    if (quota.pending && !fromPending) return false; // Later requests cannot replace an admitted turn.
    const times = quota.sentAt.filter(time => time > now - 3600000);
    const sourceKey = digest(source);
    // sourceKey is SHA256 hex generated here, never an input property/operator.
    // eslint-disable-next-line security/detect-object-injection
    const sourceTime = quota.sourceTimes[sourceKey] ?? -Infinity;
    const dueAt = Math.max(times.length >= 3 ? (times[0] ?? now) + 3600000 : now,
      (times.at(-1) ?? -Infinity) + 60000, sourceTime + 600000);
    if (dueAt > now) {
      const firstAdmission = !quota.pending;
      quota.pending ??= { admittedAt: now, dueAt, source, contextId };
      await this.quotas.replaceOne({ _id: id }, { ...quota, sentAt: times }, { upsert: true, session });
      if (firstAdmission) await this.audit.append({ realm: identity.realm, action: 'EMAIL_QUEUED', subjectId: identity._id,
        actorId: identity._id, outcome: 'SUCCESS' }, session);
      return false;
    }
    const lifetime=purpose==='ACTIVATION'?3600000:600000;
    if(await this.proofs.countDocuments({subjectId:identity._id,purpose,consumed:false,expiresAt:{$gt:now}},{session})>=3)return false;
    const token = opaque(), hash = digest(token);
    await this.proofs.insertOne({ _id: hash, realm: identity.realm, subjectId: identity._id, purpose,
      credentialVersion: identity.credentialVersion, initialProofEpoch: identity.initialProofEpoch, contextId,
      expiresAt: now + lifetime, consumed: false }, { session });
    await this.messages.insertOne({ _id: hash, subjectId: identity._id, realm: identity.realm, purpose,
      encryptedToken: seal(token, this.key), proofHash: hash, expiresAt: now + lifetime,
      activationNotice:purpose==='ACTIVATION'?'Confirma solo si creaste esta cuenta. Si no fuiste tú, elige No fui yo para anularla.':null,rejectionAction:purpose==='ACTIVATION'?'REJECT_UNCONFIRMED_ACCOUNT':null,
      warning: purpose === 'RESET' && identity.state === 'MFA_ENROLLMENT' && !pristineHistory(identity) ? resetWarning : null, delivered: false }, { session });
    await this.quotas.replaceOne({ _id: id }, { subjectId: identity._id, realm: identity.realm, purpose, sentAt: [...times, now],
      sourceTimes: { ...Object.fromEntries(Object.entries(quota.sourceTimes).filter(([, t]) => t > now - 600000)), [sourceKey]: now }, pending: null }, { upsert: true, session });
    await this.audit.append({ realm: identity.realm, action: 'EMAIL_ADMITTED', actorId: identity._id,
      subjectId: identity._id, outcome: 'SUCCESS' }, session);
    return true;
  }
  async deliver(allowed: (message: SyntheticMessage) => Promise<boolean>, afterSink?: () => void): Promise<void> {
    for (const message of await this.messages.find({ delivered: false }).toArray()) {
      if (message.expiresAt <= this.now()) { this.telemetry.overdue++; continue; }
      if (!await allowed(message)) continue;
      const claim = await this.messages.findOneAndUpdate({ _id: message._id, delivered: false,
        $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: this.now() } }] },
      { $set: { leaseOwner: this.owner, leaseUntil: this.now() + 30000 } }, { returnDocument: 'after' });
      if (!claim) continue;
      try {
        if (claim.expiresAt<=this.now()||!await allowed(claim)) {
          await this.messages.updateOne({_id:claim._id,leaseOwner:this.owner},{$unset:{leaseOwner:'',leaseUntil:''}});
          continue;
        }
        const token = unseal(message.encryptedToken, this.key);
        try { await this.sink.insertOne({ ...claim, delivered: true }); }
        catch (error) { if (!(error instanceof MongoServerError) || error.code !== 11000) throw error; this.telemetry.retries++; }
        afterSink?.(); // Local test fault injection only, not exposed by HTTP.
        await this.messages.updateOne({ _id: message._id, leaseOwner: this.owner }, { $set: { delivered: true }, $unset: { leaseOwner: '', leaseUntil: '' } });
        this.inbox.set(message._id, { id: message._id, subjectId: message.subjectId, purpose: message.purpose, token, warning: message.warning,activationNotice:message.activationNotice??null,rejectionAction:message.rejectionAction??null });
      } catch (error) { this.telemetry.failures++; throw error; }
    }
  }
}
