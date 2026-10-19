import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import type { Database } from '../../shared/database.js';
import { opaque, digest, equalSecret } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import type { Context, ContextKind, Identity, Realm } from '../identity/models.js';

export class Sessions {
  readonly contexts;
  readonly identities;
  constructor(readonly database: Database, readonly now: () => number = Date.now) {
    this.contexts = database.db.collection<Context>('contexts');
    this.identities = database.db.collection<Identity>('identities');
  }
  async initialize(): Promise<void> {
    await this.contexts.createIndex({ managementId: 1 }, { unique: true });
    await this.contexts.createIndex({ subjectId: 1, realm: 1, kind: 1 });
  }
  async issue(realm: Realm, kind: ContextKind, identity: Identity | null, session?: ClientSession) {
    if (kind === 'S') throw new AppError(503, 'SERVICE_UNAVAILABLE'); // MFA provider not integrated yet.
    const token = opaque(), csrf = opaque(), now = this.now();
    const context: Context = { _id: digest(token), managementId: randomUUID(), realm, kind,
      subjectId: identity?._id ?? null, csrfHash: digest(csrf), createdAt: now, lastSeenAt: now,
      expiresAt: now + (kind === 'P' ? 600000 : 300000), revoked: false,
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
    if (context.subjectId) {
      const identity = await this.identities.findOne({ _id: context.subjectId, realm }, session ? { session } : {});
      if (!identity || identity.suspended || identity.credentialVersion !== context.credentialVersion ||
        identity.authEpoch !== context.authEpoch || identity.authzVersion !== context.authzVersion ||
        (context.kind === 'E_INITIAL' && identity.initialProofEpoch !== context.initialProofEpoch)) return null;
    }
    return context;
  }
  checkCsrf(context: Context, csrf: string | undefined): void {
    if (!csrf || csrf.length > 256 || !equalSecret(csrf, context.csrfHash)) throw new AppError(400, 'CSRF_INVALID');
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
