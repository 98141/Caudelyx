import type { ClientSession } from 'mongodb';
import type { Database } from '../../shared/database.js';
import { digest, opaque, seal, unseal } from '../../shared/crypto.js';
import type { EmailProof, Identity, Quota, SyntheticMessage } from '../identity/models.js';

export const resetWarning = 'Si completas este restablecimiento antes de registrar tu primer factor MFA, no podrás terminar el alta y no hay reparación disponible en esta fase. Si no solicitaste el restablecimiento, ignora este correo y no lo completes';
export interface DeliveredMail { id: string; subjectId: string; purpose: EmailProof['purpose']; token: string; warning: string | null }

export class SyntheticMessaging {
  readonly messages;
  readonly proofs;
  readonly quotas;
  // Synthetic transport is memory only, never an HTTP endpoint or a file containing clear tokens.
  readonly inbox = new Map<string, DeliveredMail>();
  constructor(database: Database, private readonly key: Buffer, readonly now: () => number) {
    if (key.length !== 32) throw new Error('Synthetic encryption key must be 32 bytes');
    this.messages = database.db.collection<SyntheticMessage>('synthetic_mail');
    this.proofs = database.db.collection<EmailProof>('email_proofs');
    this.quotas = database.db.collection<Quota>('mail_quotas');
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
      quota.pending ??= { admittedAt: now, dueAt, source, contextId };
      await this.quotas.replaceOne({ _id: id }, { ...quota, sentAt: times }, { upsert: true, session });
      return false;
    }
    const token = opaque(), hash = digest(token);
    await this.proofs.insertOne({ _id: hash, realm: identity.realm, subjectId: identity._id, purpose,
      credentialVersion: identity.credentialVersion, initialProofEpoch: identity.initialProofEpoch, contextId,
      expiresAt: now + 600000, consumed: false }, { session });
    await this.messages.insertOne({ _id: hash, subjectId: identity._id, realm: identity.realm, purpose,
      encryptedToken: seal(token, this.key), proofHash: hash, expiresAt: now + 600000,
      warning: purpose === 'RESET' && identity.state === 'MFA_ENROLLMENT' ? resetWarning : null, delivered: false }, { session });
    await this.quotas.replaceOne({ _id: id }, { subjectId: identity._id, realm: identity.realm, purpose, sentAt: [...times, now],
      sourceTimes: { ...Object.fromEntries(Object.entries(quota.sourceTimes).filter(([, t]) => t > now - 600000)), [sourceKey]: now }, pending: null }, { upsert: true, session });
    return true;
  }
  async deliver(allowed: (message: SyntheticMessage) => Promise<boolean>): Promise<void> {
    for (const message of await this.messages.find({ delivered: false }).toArray()) {
      if (message.expiresAt <= this.now() || !await allowed(message)) continue;
      const claim = await this.messages.findOneAndUpdate({ _id: message._id, delivered: false }, { $set: { delivered: true } });
      if (!claim) continue;
      this.inbox.set(message._id, { id: message._id, subjectId: message.subjectId, purpose: message.purpose,
        token: unseal(message.encryptedToken, this.key), warning: message.warning });
    }
  }
}
