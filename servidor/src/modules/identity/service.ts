import { randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import type { ClientSession } from 'mongodb';
import type { Database } from '../../shared/database.js';
import { AuditWriter } from '../../shared/audit.js';
import { AppError } from '../../shared/errors.js';
import { digest } from '../../shared/crypto.js';
import { Sessions } from '../sessions/service.js';
import { SyntheticMessaging, resetWarning } from '../messaging/service.js';
import { PasswordHasher } from './password.js';
import type { Context, EmailProof, Identity, Realm } from './models.js';
import { validateCommand,normalizeCommand,authorizePurpose,type Command } from '../../shared/commands.js';

export function canonicalEmail(value: string): string {
  if (value.length > 254 || /[\s\u0000-\u001f\u007f]/u.test(value)) throw new AppError(422, 'INPUT_INVALID');
  const parts = value.split('@');
  const local = parts[0], domain = parts[1];
  if (parts.length !== 2 || !local || !domain || local.length > 64 ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    throw new AppError(422, 'INPUT_INVALID');
  }
  const ascii = domainToASCII(domain).toLowerCase();
  if (!ascii || !ascii.includes('.') || ascii.split('.').some(label => !label || !/^[a-z0-9-]+$/.test(label) ||
    label.startsWith('-') || label.endsWith('-') || label.length > 63)) throw new AppError(422, 'INPUT_INVALID');
  const canonical = `${local.toLowerCase()}@${ascii}`;
  if (canonical.length > 254) throw new AppError(422, 'INPUT_INVALID');
  return canonical;
}

export class IdentityService {
  readonly identities;
  readonly audit: AuditWriter;
  terminateRecovery?: (identity: Identity, session: ClientSession) => Promise<void>;
  suspendRecovery?: (identity: Identity, session: ClientSession) => Promise<void>;
  extension?: (id: string, context: Context, body: unknown, resourceId: string | undefined,
    ifMatch: string | undefined, source: string, query: Record<string, unknown>, idempotencyKey?:string) => Promise<{
      data?: unknown; status?: number; issued?: Awaited<ReturnType<Sessions['issue']>>; etag?: string; clearCookies?: boolean }>;
  beforeRequest?: () => Promise<void>;
  constructor(readonly database: Database, readonly sessions: Sessions, readonly messaging: SyntheticMessaging,
    readonly passwords: PasswordHasher, readonly realmOpen: (realm: Realm) => boolean, readonly now: () => number = Date.now) {
    this.identities = sessions.identities;
    this.audit = new AuditWriter(database);
  }
  async initialize(): Promise<void> {
    await this.identities.createIndex({ realm: 1, email: 1 }, { unique: true });
    await this.sessions.initialize();
    await this.passwords.initialize();
  }
  requireOpen(realm: Realm): void { if (!this.realmOpen(realm)) throw new AppError(503, 'SERVICE_UNAVAILABLE'); }
  eligible(identity: Identity): boolean {
    return identity.state === 'MFA_ENROLLMENT' && !identity.suspended && !identity.hasEverConfirmedFactor &&
      !identity.hasEverActive && identity.factorCount === 0 && !identity.organizationId &&
      identity.resetCompletedAt === null && !identity.restoreBootstrapBlocked && this.realmOpen(identity.realm);
  }
  async freshContext(context: Context, session: ClientSession): Promise<Context> {
    const current = await this.sessions.contexts.findOne({ _id: context._id, revoked: false, realm: context.realm }, { session });
    if (!current || current.expiresAt <= this.now()) throw new AppError(401, 'AUTH_INVALID');
    return current;
  }
  private async sourceQuota(realm: Realm, source: string): Promise<void> {
    await this.sessions.enforceSourceLimit(digest(`email-source:${realm}:${source}`), 10, 3600000);
  }
  async register(realm: Realm, source: string, input: { email: string; displayName: string; privacyPolicyVersion: string }) {
    this.requireOpen(realm);
    if (realm !== 'TENANT') throw new AppError(403, 'ACCESS_DENIED');
    const email = canonicalEmail(input.email);
    await this.sourceQuota(realm, source);
    await this.database.transaction(async session => {
      let identity = await this.identities.findOne({ realm, email }, { session });
      if(!identity&&await this.database.db.collection<{_id:string}>('restore_claims').findOne({_id:digest(`${realm}:${email}`)},{session}))return;
      if (identity && identity.state !== 'PENDING_EMAIL') return;
      if (!identity) {
        identity = { _id: randomUUID(), realm, email, displayName: input.displayName.trim(), passwordHash: null,
          state: 'PENDING_EMAIL', organizationId: null, roles: [], version: `"${randomUUID()}"`,
          credentialVersion: randomUUID(), initialProofEpoch: randomUUID(), authEpoch: randomUUID(), authzVersion: randomUUID(),
          hasEverConfirmedFactor: false, hasEverActive: false, resetCompletedAt: null, restoreBootstrapBlocked: false,
          suspended: false, createdAt: this.now(), factorCount: 0 };
        await this.identities.insertOne(identity, { session });
        await this.audit.append({ realm, action: 'REGISTRATION_INTENT', subjectId: identity._id, actorId: identity._id, outcome: 'SUCCESS' }, session);
      }
      // Consent is associated with the admitted intent, not a claim to an existing verified identity.
      await this.database.db.collection('consents').updateOne({ subjectId: identity._id }, {
        $setOnInsert: { subjectId: identity._id, privacyPolicyVersion: input.privacyPolicyVersion, acceptedAt: this.now() },
      }, { upsert: true, session });
      await this.messaging.enqueue(identity, 'ACTIVATION', source, null, session);
    });
    return { code: 'GENERIC_ACCOUNT_ACTION' };
  }
  async requestEmail(realm: Realm, source: string, purpose: EmailProof['purpose'], email: string | null, context: Context) {
    if (purpose === 'RESET' && !this.realmOpen(realm)) return { code: 'GENERIC_ACCOUNT_ACTION' };
    this.requireOpen(realm);
    if (realm !== 'TENANT') throw new AppError(403, 'ACCESS_DENIED');
    await this.sourceQuota(realm, source);
    const canonical = email === null ? null : canonicalEmail(email);
    await this.database.transaction(async session => {
      const current = await this.freshContext(context, session);
      const identity = purpose === 'INITIAL_MFA_PROOF' ? await this.identities.findOne({ _id: current.subjectId ?? '', realm }, { session }) :
        await this.identities.findOne({ realm, email: canonical ?? '' }, { session });
      if (purpose === 'INITIAL_MFA_PROOF' && (!identity || current.kind !== 'L' || !current.passwordAt || current.passwordAt + 300000 <= this.now())) {
        throw new AppError(401, 'AUTH_INVALID');
      }
      if (purpose === 'INITIAL_MFA_PROOF' && identity && !this.eligible(identity)) throw new AppError(403, 'INITIAL_MFA_PROOF_DENIED');
      if (!identity || identity.suspended || (purpose === 'ACTIVATION' && identity.state !== 'PENDING_EMAIL') ||
        (purpose === 'RESET' && (!identity.passwordHash || identity.state === 'RECOVERY_RESTRICTED'))) return;
      const pendingBefore = await this.messaging.quotas.findOne({ _id: digest(`${realm}:${identity.email}:${purpose}`) }, { session });
      if (purpose === 'RESET' && !pendingBefore?.pending) {
        // Invalidate INITIAL once per admitted request, not each coalesced retry.
        const epoch = randomUUID(); identity.initialProofEpoch = epoch;
        await this.identities.updateOne({ _id: identity._id }, { $set: { initialProofEpoch: epoch } }, { session });
        await this.sessions.contexts.updateMany({ subjectId: identity._id, kind: 'E_INITIAL' }, { $set: { revoked: true } }, { session });
      }
      await this.messaging.enqueue(identity, purpose, source, purpose === 'INITIAL_MFA_PROOF' ? current._id : null, session);
    });
    return { code: 'GENERIC_ACCOUNT_ACTION' };
  }
  private async validProof(token: string, purpose: EmailProof['purpose'], realm: Realm, session: ClientSession) {
    const proof = await this.messaging.proofs.findOne({ _id: digest(token), purpose, realm, consumed: false }, { session });
    if (!proof || proof.expiresAt <= this.now()) throw new AppError(401, 'TOKEN_INVALID');
    const identity = await this.identities.findOne({ _id: proof.subjectId, realm }, { session });
    if (!identity || identity.suspended || identity.credentialVersion !== proof.credentialVersion) throw new AppError(401, 'TOKEN_INVALID');
    return { proof, identity };
  }
  async confirmEmail(context: Context, input: { purpose: 'ACTIVATION' | 'INITIAL_MFA_PROOF'; token: string; newPassword?: string }) {
    this.requireOpen(context.realm);
    if (context.realm !== 'TENANT') throw new AppError(403, 'ACCESS_DENIED');
    let passwordHash: string | null = null;
    if (input.purpose === 'ACTIVATION') {
      if (!input.newPassword) throw new AppError(422, 'INPUT_INVALID');
      this.passwords.validate(input.newPassword); passwordHash = await this.passwords.hash(input.newPassword);
    }
    return await this.database.transaction(async session => {
      const current = await this.freshContext(context, session);
      const { proof, identity } = await this.validProof(input.token, input.purpose, context.realm, session);
      if (input.purpose === 'ACTIVATION') {
        if (identity.state !== 'PENDING_EMAIL' || identity.passwordHash || identity.restoreBootstrapBlocked || identity.hasEverConfirmedFactor || identity.resetCompletedAt !== null) throw new AppError(403, 'INITIAL_MFA_PROOF_DENIED');
        identity.passwordHash = passwordHash; identity.state = 'MFA_ENROLLMENT'; identity.credentialVersion = randomUUID();
        if (!this.eligible(identity)) throw new AppError(403, 'INITIAL_MFA_PROOF_DENIED');
        await this.identities.replaceOne({ _id: identity._id }, identity, { session });
      } else {
        if (current.kind !== 'L' || current._id !== proof.contextId || current.subjectId !== identity._id) throw new AppError(401, 'TOKEN_INVALID');
        if (!this.eligible(identity) || identity.initialProofEpoch !== proof.initialProofEpoch) throw new AppError(403, 'INITIAL_MFA_PROOF_DENIED');
      }
      await this.messaging.proofs.updateOne({ _id: proof._id, consumed: false }, { $set: { consumed: true } }, { session });
      await this.sessions.contexts.updateOne({ _id: current._id }, { $set: { revoked: true } }, { session });
      await this.audit.append({ realm: context.realm, action: 'EMAIL_VERIFIED', subjectId: identity._id, actorId: identity._id, outcome: 'SUCCESS' }, session);
      const issued = await this.sessions.issue(context.realm, 'E_INITIAL', identity, session);
      if (input.purpose === 'INITIAL_MFA_PROOF') {
        // Email delivery cannot refresh the password's original five-minute validity.
        issued.context.passwordAt = current.passwordAt;
        issued.context.expiresAt = Math.min(issued.context.expiresAt, current.expiresAt);
        await this.sessions.contexts.replaceOne({ _id: issued.context._id }, issued.context, { session });
      }
      return { issued, data: { authState: 'MFA_ENROLLMENT', nextAction: 'ENROLL_FIRST_FACTOR' } };
    });
  }
  async login(realm: Realm, source: string, emailValue: string, password: string) {
    this.requireOpen(realm); const email = canonicalEmail(emailValue);
    await this.sessions.enforceSourceLimit(digest(`login-source:${source}`), 30, 900000);
    const key = digest(`login:${realm}:${email}:${source}`);
    const failures = this.database.db.collection<{ _id: string; attempts: number[]; backoffUntil: number }>('login_failures');
    const previous = await failures.findOne({ _id: key });
    if (previous && previous.backoffUntil > this.now()) throw new AppError(429, 'RATE_LIMITED');
    const identity = await this.identities.findOne({ realm, email });
    const verified = await this.passwords.verify(identity?.passwordHash ?? null, password);
    if (!verified || !identity || identity.suspended || identity.state === 'PENDING_EMAIL') {
      await this.database.transaction(async session => {
        const prior = await failures.findOne({ _id: key }, { session });
        const attempts = [...(prior?.attempts ?? []).filter(t => t > this.now() - 900000), this.now()];
        const delay = attempts.length < 5 ? 0 : Math.min(30000, 1000 * 2 ** Math.min(attempts.length - 5, 5));
        await failures.replaceOne({ _id: key }, { attempts, backoffUntil: this.now() + delay }, { session, upsert: true });
      });
      throw new AppError(401, 'AUTH_INVALID');
    }
    return await this.database.transaction(async session => {
      const fresh = await this.identities.findOne({ _id: identity._id, credentialVersion: identity.credentialVersion, suspended: false }, { session });
      if (!fresh) throw new AppError(401, 'AUTH_INVALID');
      await failures.deleteOne({ _id: key }, { session });
      const authState = fresh.state === 'RECOVERY_RESTRICTED' ? 'RECOVERY_RESTRICTED' :
        fresh.factorCount > 0 ? 'MFA_REQUIRED' : this.eligible(fresh) ? 'MFA_ENROLLMENT' : 'FACTOR_LOSS_BLOCKED';
      await this.audit.append({ realm, action: 'PASSWORD_VERIFIED', actorId: fresh._id, subjectId: fresh._id, outcome: 'SUCCESS' }, session);
      return { issued: await this.sessions.issue(realm, 'L', fresh, session), data: { authState } };
    });
  }
  async reset(context: Context, input: { mode: 'PREVIEW' | 'CONFIRM'; token: string; newPassword?: string; warningAcknowledged?: boolean }, source: string) {
    this.requireOpen(context.realm);
    if (context.realm !== 'TENANT') throw new AppError(403, 'ACCESS_DENIED');
    await this.sessions.enforceSourceLimit(digest(`reset-source:${context.realm}:${source}`), 30, 900000);
    // Verification limits are separate from mail quotas. Invalid requests persist attempts outside reset transaction.
    const failureKey = digest(`reset-token:${context.realm}:${digest(input.token)}:${source}`);
    await this.sessions.enforceSourceLimit(failureKey, 5, 900000, false);
    let newHash: string | null = null;
    if (input.mode === 'CONFIRM') {
      if (!input.newPassword || typeof input.warningAcknowledged !== 'boolean') throw new AppError(422, 'INPUT_INVALID');
      this.passwords.validate(input.newPassword); newHash = await this.passwords.hash(input.newPassword);
    }
    try { return await this.database.transaction(async session => {
      const current = await this.freshContext(context, session);
      const { proof, identity } = await this.validProof(input.token, 'RESET', context.realm, session);
      const warning = identity.state === 'MFA_ENROLLMENT';
      if (input.mode === 'PREVIEW') {
        await this.sessions.contexts.updateOne({ _id: current._id }, { $set: { preview: { proofHash: proof._id,
          credentialVersion: identity.credentialVersion, initialProofEpoch: identity.initialProofEpoch, state: identity.state, warning } } }, { session });
        return { warningRequired: warning, warningMessage: warning ? resetWarning : null };
      }
      const preview = current.preview;
      if (!preview || preview.proofHash !== proof._id || preview.credentialVersion !== identity.credentialVersion ||
        preview.initialProofEpoch !== identity.initialProofEpoch || preview.state !== identity.state ||
        preview.warning !== warning || input.warningAcknowledged !== warning) throw new AppError(409, 'INVALID_STATE');
      if (identity.state === 'RECOVERY_RESTRICTED') {
        if (!this.terminateRecovery) throw new AppError(503, 'SERVICE_UNAVAILABLE');
        await this.terminateRecovery(identity, session);
        const restored = await this.identities.findOne({ _id: identity._id }, { session });
        if (!restored) throw new AppError(401, 'TOKEN_INVALID');
        identity.state = restored.state;
      }
      identity.passwordHash = newHash; identity.credentialVersion = randomUUID(); identity.authEpoch = randomUUID();
      identity.initialProofEpoch = randomUUID(); identity.resetCompletedAt = this.now();
      await this.identities.replaceOne({ _id: identity._id }, identity, { session });
      await this.messaging.proofs.updateMany({ subjectId: identity._id }, { $set: { consumed: true } }, { session });
      await this.sessions.revokeAll(identity._id, session);
      await this.audit.append({ realm: context.realm, action: 'PASSWORD_RESET', actorId: identity._id, subjectId: identity._id, outcome: 'SUCCESS' }, session);
      await this.messaging.notify(context.realm,identity._id,'PASSWORD_RESET',{},session);
      return { nextAction: 'LOGIN' };
    }); } catch (error) {
      if (error instanceof AppError && [401, 409, 422].includes(error.status)) {
        await this.sessions.enforceSourceLimit(failureKey, 5, 900000);
      }
      throw error;
    }
  }

  async reauthenticate(context: Context, input: { password: string; purpose: string; resourceId?: string;command?:Command }) {
    this.requireOpen(context.realm);
    validateCommand('A32',input);
    authorizePurpose(context.realm,input.purpose,input.command);
    const command=normalizeCommand(input.purpose,input.command,canonicalEmail);
    if(command){
      const operation={ORGANIZATION_CREATE:'A08',ORGANIZATION_EDIT:'A10',MEMBER_INVITE:'A12',MEMBER_ROLE_CHANGE:'A16'}[input.purpose];
      if(operation)validateCommand(operation,command);
      else if(input.purpose==='MFA_ENROLL')validateCommand('A22',{label:command['label']});
    }
    const identity = await this.identities.findOne({ _id: context.subjectId ?? '', realm: context.realm });
    await this.sessions.enforceSourceLimit(digest(`reauth:${context._id}`), 5, 900000, false);
    if (!await this.passwords.verify(identity?.passwordHash ?? null, input.password)) {
      await this.sessions.enforceSourceLimit(digest(`reauth:${context._id}`), 5, 900000);
      throw new AppError(401, 'AUTH_INVALID');
    }
    return await this.database.transaction(async session => {
      const { context: fresh, identity: current } = await this.sessions.requireStrong(context, session);
      if (!identity || current.credentialVersion !== identity.credentialVersion) throw new AppError(401, 'AUTH_INVALID');
      const enrollmentIntent=input.purpose==='MFA_ENROLL'?randomUUID():null;
      const snapshotHash = await this.sessions.snapshot(input.purpose, input.resourceId ?? null, current, session,command,enrollmentIntent);
      await this.sessions.contexts.updateOne({ _id: fresh._id }, { $set: { passwordAt: this.now(), reauth: {
        purpose: input.purpose, resourceId: input.resourceId ?? null, snapshotHash, passwordAt: this.now(),
        expiresAt: this.now() + 300000, factorId: null, consumed: false,command,
        enrollmentIntent } } }, { session });
      await this.audit.append({ realm: current.realm, action: 'REAUTH_PASSWORD_VERIFIED', actorId: current._id, subjectId: current._id, outcome: 'SUCCESS' }, session);
      return { nextAction: 'MFA_CHALLENGE' };
    });
  }
  async changePassword(context: Context, input: { currentPassword: string; newPassword: string }): Promise<void> {
    this.requireOpen(context.realm);
    const before = await this.identities.findOne({ _id: context.subjectId ?? '', realm: context.realm });
    if (!await this.passwords.verify(before?.passwordHash ?? null, input.currentPassword)) throw new AppError(401, 'AUTH_INVALID');
    this.passwords.validate(input.newPassword);
    const passwordHash = await this.passwords.hash(input.newPassword);
    await this.database.transaction(async session => {
      const identity = await this.sessions.consumeProof(context, 'PASSWORD_CHANGE', null, session);
      if (!before || before.credentialVersion !== identity.credentialVersion) throw new AppError(403, 'REAUTH_REQUIRED');
      await this.identities.updateOne({ _id: identity._id }, { $set: { passwordHash, credentialVersion: randomUUID(), authEpoch: randomUUID() } }, { session });
      await this.sessions.revokeAll(identity._id, session);
      await this.audit.append({ realm: identity.realm, action: 'PASSWORD_CHANGED', actorId: identity._id, subjectId: identity._id, outcome: 'SUCCESS' }, session);
      await this.messaging.notify(identity.realm,identity._id,'PASSWORD_CHANGED',{},session);
    });
  }
  async listSessions(context: Context) {
    this.requireOpen(context.realm);
    return await this.database.transaction(async session => {
      const { identity } = await this.sessions.requireStrong(context, session);
      const now = this.now();
      const rows = await this.sessions.contexts.find({ subjectId: identity._id, realm: identity.realm, kind: 'S', revoked: false,
        expiresAt: { $gt: now }, lastSeenAt: { $gt: now - (identity.realm === 'TENANT' ? 1800000 : 900000) } }, { session }).sort({ createdAt: 1 }).toArray();
      return { items: rows.map(row => ({ id: row.managementId, createdAt: new Date(row.createdAt).toISOString(),
        lastSeenAt: new Date(row.lastSeenAt).toISOString(), expiresAt: new Date(row.expiresAt).toISOString(),
        deviceLabel: 'Sesión web', current: row._id === context._id })), nextCursor: null };
    });
  }
  async revokeSessions(context: Context, managementId?: string): Promise<void> {
    this.requireOpen(context.realm);
    await this.database.transaction(async session => {
      const { identity } = await this.sessions.requireStrong(context, session);
      const target = managementId ? await this.sessions.contexts.findOne({ managementId, subjectId: identity._id, realm: identity.realm, kind: 'S' }, { session }) : null;
      if (managementId && !target) throw new AppError(404, 'NOT_FOUND');
      if (!target || target._id !== context._id) await this.sessions.consumeProof(context, managementId ? 'SESSION_REVOKE_OTHER' : 'SESSION_REVOKE_ALL', managementId ?? null, session);
      if (target) await this.sessions.contexts.updateOne({ _id: target._id }, { $set: { revoked: true } }, { session });
      else {
        await this.identities.updateOne({ _id: identity._id }, { $set: { authEpoch: randomUUID() } }, { session });
        await this.sessions.revokeAll(identity._id, session);
      }
      await this.audit.append({ realm: identity.realm, action: 'SESSIONS_REVOKED', actorId: identity._id, subjectId: identity._id, outcome: 'SUCCESS' }, session);
    });
  }

  async dispatchMail(): Promise<void> {
    for (const quota of await this.messaging.quotas.find({ 'pending.dueAt': { $lte: this.now() } }).toArray()) {
      await this.database.transaction(async session => {
        const current = await this.messaging.quotas.findOne({ _id: quota._id }, { session });
        if (!current?.pending || current.pending.dueAt > this.now()) return;
        const queueDelay=this.now()-current.pending.dueAt;
        if(queueDelay>0){this.messaging.telemetry.queueOverdue++;this.messaging.telemetry.maxQueueDelayMs=Math.max(this.messaging.telemetry.maxQueueDelayMs,queueDelay);}
        const identity = await this.identities.findOne({ _id: current.subjectId, realm: current.realm }, { session });
        if (!identity || !this.realmOpen(current.realm) || identity.suspended ||
          current.purpose === 'RESET' && (!identity.passwordHash || identity.state === 'RECOVERY_RESTRICTED') ||
          current.purpose === 'ACTIVATION' && identity.state !== 'PENDING_EMAIL') {
          // Closed realm retains its pending turn; other obsolete work is discarded, never replayed.
          if (this.realmOpen(current.realm)) await this.messaging.quotas.updateOne({ _id: current._id }, { $set: { pending: null } }, { session });
          return;
        }
        if (current.purpose === 'INITIAL_MFA_PROOF') {
          const bound = await this.sessions.contexts.findOne({ _id: current.pending.contextId ?? '', kind: 'L', revoked: false }, { session });
          if (!this.eligible(identity) || !bound || bound.expiresAt <= this.now() || bound.credentialVersion !== identity.credentialVersion ||
            !bound.passwordAt || bound.passwordAt + 300000 <= this.now()) {
            await this.messaging.quotas.updateOne({ _id: current._id }, { $set: { pending: null } }, { session }); return;
          }
        }
        await this.messaging.enqueue(identity, current.purpose, current.pending.source, current.pending.contextId, session, true);
      });
    }
    await this.messaging.deliver(async message => {
      if (!this.realmOpen(message.realm)) return false;
      const identity = await this.identities.findOne({ _id: message.subjectId, realm: message.realm });
      const proof = await this.messaging.proofs.findOne({ _id: message.proofHash, consumed: false });
      if (!identity || !proof || identity.suspended || identity.credentialVersion !== proof.credentialVersion ||
        message.purpose === 'RESET' && identity.state === 'RECOVERY_RESTRICTED') return false;
      if (message.purpose === 'INITIAL_MFA_PROOF') {
        const context = await this.sessions.contexts.findOne({ _id: proof.contextId ?? '', revoked: false });
        return this.eligible(identity) && identity.initialProofEpoch === proof.initialProofEpoch && !!context && context.expiresAt > this.now();
      }
      return true;
    });
    await this.messaging.deliverNotifications();
  }
}
