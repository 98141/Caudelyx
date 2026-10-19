import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import type { Database } from '../../shared/database.js';
import { opaque, digest, equalSecret } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import type { Context, ContextKind, Identity, Realm } from '../identity/models.js';
import type { Factor } from '../identity/models.js';
import { AuditWriter } from '../../shared/audit.js';

export class Sessions {
  readonly contexts;
  readonly identities;
  readonly factors;
  private readonly audit;
  snapshotResolver?: (purpose: string, resourceId: string | null, identity: Identity, session: ClientSession,command?:Record<string,unknown>|null) => Promise<string>;
  factorCompletionHook?: (identity: Identity, session: ClientSession) => Promise<void>;
  constructor(readonly database: Database, readonly now: () => number = Date.now) {
    this.contexts = database.db.collection<Context>('contexts');
    this.identities = database.db.collection<Identity>('identities');
    this.factors = database.db.collection<Factor>('factors');
    this.audit = new AuditWriter(database);
  }
  async initialize(): Promise<void> {
    await this.contexts.createIndex({ managementId: 1 }, { unique: true });
    await this.contexts.createIndex({ subjectId: 1, realm: 1, kind: 1 });
    await this.factors.createIndex({ credentialId: 1 }, { unique: true, partialFilterExpression: { credentialId: { $type: 'string' } } });
  }
  async issue(realm: Realm, kind: ContextKind, identity: Identity | null, session?: ClientSession) {
    if (kind === 'S') throw new AppError(503, 'SERVICE_UNAVAILABLE'); // Only completeFactor can create S after a committed factor verification.
    const token = opaque(), csrf = opaque(), now = this.now();
    const context: Context = { _id: digest(token), managementId: randomUUID(), realm, kind,
      subjectId: identity?._id ?? null, csrfHash: digest(csrf), createdAt: now, lastSeenAt: now,
      expiresAt: now + (kind === 'P' ? 600000 : kind === 'E_RECOVERY' ? 900000 : 300000), revoked: false,
      credentialVersion: identity?.credentialVersion ?? null, initialProofEpoch: identity?.initialProofEpoch ?? null,
      authEpoch: identity?.authEpoch ?? null, authzVersion: identity?.authzVersion ?? null,
      passwordAt: kind === 'P' ? null : now, preview: null };
    await this.contexts.insertOne(context, session ? { session } : {});
    return { context, token, csrf };
  }
  async find(token: string | undefined, realm: Realm, session?: ClientSession): Promise<Context | null> {
    if (!token || token.length > 128) return null;
    const context = await this.contexts.findOne({ _id: digest(token), realm, revoked: false }, session ? { session } : {});
    if (!context || context.expiresAt <= this.now()) return null;
    if (context.kind === 'S' && context.lastSeenAt + (realm === 'TENANT' ? 1800000 : 900000) <= this.now()) return null;
    if (context.subjectId) {
      const identity = await this.identities.findOne({ _id: context.subjectId, realm }, session ? { session } : {});
      if (!identity || identity.suspended || identity.credentialVersion !== context.credentialVersion ||
        identity.authEpoch !== context.authEpoch || identity.authzVersion !== context.authzVersion ||
        (context.kind === 'E_INITIAL' && identity.initialProofEpoch !== context.initialProofEpoch)) return null;
      if (context.kind === 'S') {
        if (!await this.factors.findOne({ _id: context.factorId ?? '', subjectId: identity._id, state: 'ACTIVE' }, session ? { session } : {})) return null;
        if (identity.organizationId) {
          const organization = await this.database.db.collection<{ _id: string; status: string; authEpoch: string }>('organizations').findOne({ _id: identity.organizationId }, session ? { session } : {});
          if (!organization || organization['status'] !== 'ACTIVE' || organization['authEpoch'] !== context.organizationEpoch) return null;
        }
        if (!session) {
          const touched = await this.contexts.updateOne({ _id: context._id, revoked: false }, { $set: { lastSeenAt: this.now() } });
          if (!touched.matchedCount) return null;
          context.lastSeenAt = this.now();
        }
      }
    }
    return context;
  }
  async requireStrong(context: Context, session: ClientSession): Promise<{ context: Context; identity: Identity }> {
    const current = await this.contexts.findOne({ _id: context._id, realm: context.realm, kind: 'S', revoked: false }, { session });
    if (!current || current.expiresAt <= this.now() || current.lastSeenAt + (current.realm === 'TENANT' ? 1800000 : 900000) <= this.now()) throw new AppError(401, 'AUTH_INVALID');
    const identity = await this.identities.findOne({ _id: current.subjectId ?? '', realm: current.realm, suspended: false }, { session });
    if (!identity || identity.credentialVersion !== current.credentialVersion || identity.authEpoch !== current.authEpoch || identity.authzVersion !== current.authzVersion) throw new AppError(401, 'AUTH_INVALID');
    if (!await this.factors.findOne({ _id: current.factorId ?? '', subjectId: identity._id, state: 'ACTIVE' }, { session })) throw new AppError(401, 'AUTH_INVALID');
    if (identity.organizationId) {
      const org = await this.database.db.collection<{ _id: string; status: string; authEpoch: string }>('organizations').findOne({ _id: identity.organizationId }, { session });
      if (!org || org.status !== 'ACTIVE' || org.authEpoch !== current.organizationEpoch) throw new AppError(403, 'ACCESS_DENIED');
    }
    return { context: current, identity };
  }
  async completeFactor(context: Context, factorId: string, session: ClientSession) {
    const current = await this.contexts.findOne({ _id: context._id, realm: context.realm, revoked: false }, { session });
    let identity = await this.identities.findOne({ _id: context.subjectId ?? '', realm: context.realm, suspended: false }, { session });
    const factor = await this.factors.findOneAndUpdate({ _id: factorId, subjectId: context.subjectId ?? '', realm: context.realm,
      state: 'ACTIVE', verifiedFor: context._id, verifiedAt: { $gte: this.now() - 1000 } },
    { $unset: { verifiedFor: '', verifiedAt: '' } }, { session, returnDocument: 'before' });
    if (!current || !identity || !factor || current.expiresAt <= this.now() || !current.passwordAt || current.passwordAt + 300000 <= this.now() ||
      !['L','E_INITIAL','S'].includes(current.kind) || current.credentialVersion !== identity.credentialVersion ||
      current.authEpoch !== identity.authEpoch || current.authzVersion !== identity.authzVersion ||
      current.kind === 'S' && current.lastSeenAt + (current.realm === 'TENANT' ? 1800000 : 900000) <= this.now()) throw new AppError(401, 'MFA_INVALID');
    if (identity.state === 'RECOVERY_RESTRICTED') {
      if (!this.factorCompletionHook) throw new AppError(503, 'SERVICE_UNAVAILABLE');
      await this.factorCompletionHook(identity, session);
      identity = await this.identities.findOne({ _id: identity._id }, { session });
      if (!identity) throw new AppError(401, 'AUTH_INVALID');
    }
    if (identity.realm === 'PLATFORM' && (factor.type !== 'WEBAUTHN' || await this.factors.countDocuments({ subjectId: identity._id, state: 'ACTIVE', type: 'WEBAUTHN' }, { session }) < 2)) throw new AppError(403, 'MFA_REQUIRED');
    await this.identities.updateOne({ _id: identity._id }, { $inc: { sessionSerial: 1 } }, { session });
    await this.contexts.updateOne({ _id: current._id }, { $set: { revoked: true } }, { session });
    const token = opaque(), csrf = opaque(), now = this.now();
    const org = identity.organizationId ? await this.database.db.collection<{ _id: string; authEpoch: string; status: string }>('organizations').findOne({ _id: identity.organizationId }, { session }) : null;
    if (identity.organizationId && (!org || org.status !== 'ACTIVE')) throw new AppError(403, 'ACCESS_DENIED');
    const strong: Context = { ...current, _id: digest(token), managementId: randomUUID(), kind: 'S', csrfHash: digest(csrf),
      createdAt: current.kind === 'S' ? current.createdAt : now, lastSeenAt: now,
      expiresAt: current.kind === 'S' ? current.expiresAt : now + (identity.realm === 'TENANT' ? 43200000 : 28800000),
      revoked: false, factorId, organizationEpoch: org?.authEpoch ?? null, authEpoch: identity.authEpoch,
      credentialVersion: identity.credentialVersion, authzVersion: identity.authzVersion, preview: null };
    if (current.kind === 'S') {
      if (!current.reauth || current.reauth.expiresAt <= now || current.reauth.consumed) throw new AppError(403, 'REAUTH_REQUIRED');
      strong.reauth = { ...current.reauth, factorId };
    } else strong.reauth = null;
    await this.contexts.insertOne(strong, { session });
    const live = await this.contexts.find({ subjectId: identity._id, realm: identity.realm, kind: 'S', revoked: false,
      expiresAt: { $gt: now }, lastSeenAt: { $gt: now - (identity.realm === 'TENANT' ? 1800000 : 900000) } }, { session }).sort({ createdAt: 1, _id: 1 }).toArray();
    const max = identity.realm === 'TENANT' ? 5 : 2;
    for (const old of live.slice(0, Math.max(0, live.length - max))) {
      await this.contexts.updateOne({ _id: old._id }, { $set: { revoked: true } }, { session });
      await this.audit.append({ realm: identity.realm, action: 'SESSION_LIMIT_REVOKED', actorId: identity._id, subjectId: identity._id, outcome: 'SUCCESS' }, session);
    }
    await this.audit.append({ realm: identity.realm, action: 'MFA_SESSION_ISSUED', actorId: identity._id, subjectId: identity._id, outcome: 'SUCCESS' }, session);
    return { context: strong, token, csrf };
  }
  async snapshot(purpose: string, resourceId: string | null, identity: Identity, session: ClientSession,command?:Record<string,unknown>|null,enrollmentIntent?:string|null): Promise<string> {
    if(purpose==='MFA_ENROLL'){
      if(!command||!enrollmentIntent||identity.realm==='PLATFORM'&&command['methodType']!=='WEBAUTHN')throw new AppError(403,'ACCESS_DENIED');
      return digest(JSON.stringify([purpose,identity._id,command,enrollmentIntent]));
    }
    if (['PASSWORD_CHANGE','RECOVERY_CODES_REGENERATE','SESSION_REVOKE_ALL'].includes(purpose)) return digest(`${purpose}:${identity._id}`);
    if (purpose === 'MFA_REMOVE') {
      const factor = await this.factors.findOne({ _id: resourceId ?? '', subjectId: identity._id, realm: identity.realm, state: 'ACTIVE' }, { session });
      if (!factor) throw new AppError(404, 'NOT_FOUND');
      return digest(JSON.stringify([purpose, factor._id, factor.version]));
    }
    if (purpose === 'SESSION_REVOKE_OTHER') {
      const target = await this.contexts.findOne({ managementId: resourceId ?? '', subjectId: identity._id, realm: identity.realm, kind: 'S' }, { session });
      if (!target) throw new AppError(404, 'NOT_FOUND');
      return digest(JSON.stringify([purpose, target.managementId]));
    }
    if (this.snapshotResolver) return await this.snapshotResolver(purpose, resourceId, identity, session,command);
    throw new AppError(503, 'SERVICE_UNAVAILABLE'); // D01 must resolve payload-bound purposes; never issue generic R.
  }
  async consumeProof(context: Context, purpose: string, resourceId: string | null, session: ClientSession,command?:Record<string,unknown>|null): Promise<Identity> {
    const { context: fresh, identity } = await this.requireStrong(context, session);
    const proof = fresh.reauth;
    if (!proof || proof.consumed || proof.expiresAt <= this.now() || !proof.factorId || proof.purpose !== purpose || proof.resourceId !== resourceId ||
      proof.snapshotHash !== await this.snapshot(purpose, resourceId, identity, session,command,proof.enrollmentIntent)) throw new AppError(403, 'REAUTH_REQUIRED');
    if ((identity.cooldownUntil ?? 0) > this.now() && !['PASSWORD_CHANGE','SESSION_REVOKE_ALL','SESSION_REVOKE_OTHER'].includes(purpose)) throw new AppError(403, 'RECOVERY_RESTRICTED');
    const used = await this.contexts.updateOne({ _id: fresh._id, 'reauth.consumed': false }, { $set: { 'reauth.consumed': true } }, { session });
    if (used.modifiedCount !== 1) throw new AppError(403, 'REAUTH_REQUIRED');
    return identity;
  }
  checkCsrf(context: Context, csrf: string | undefined): void {
    if (!csrf || csrf.length > 256 || !equalSecret(csrf, context.csrfHash)) throw new AppError(400, 'CSRF_INVALID');
  }
  async operationalCount(subjectIds:string[],session:ClientSession):Promise<number>{
    let count=0;
    for(const context of await this.contexts.find({subjectId:{$in:subjectIds},kind:'S',revoked:false,expiresAt:{$gt:this.now()}},{session}).toArray()){
      try{await this.requireStrong(context,session);count++;}catch(e){if(!(e instanceof AppError)||![401,403].includes(e.status))throw e;}
    }return count;
  }
  async revokeAll(subjectId: string, session: ClientSession): Promise<void> {
    await this.contexts.updateMany({ subjectId }, { $set: { revoked: true } }, { session });
  }
  async enforceSourceLimit(key: string, count: number, window: number, record = true): Promise<void> {
    const collection = this.database.db.collection<{ _id: string; attempts: number[] }>('rate_limits');
    const now = this.now();
    const accepted = await this.database.transaction(async session => {
      const doc = await collection.findOne({ _id: key }, { session });
      const attempts = (doc?.attempts ?? []).filter(t => t > now - window);
      if (attempts.length >= count) return false;
      if (!record) return true;
      await collection.replaceOne({ _id: key }, { attempts: [...attempts, now] }, { upsert: true, session });
      return true;
    });
    if (!accepted) throw new AppError(429, 'RATE_LIMITED');
  }
}
