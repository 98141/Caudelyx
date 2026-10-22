import { randomUUID,randomBytes } from 'node:crypto';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions,
  verifyAuthenticationResponse, type RegistrationResponseJSON, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { Context } from '../identity/models.js';
import type { FactorLifecycle } from '../factors/service.js';
import { digest } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';

interface Ceremony { _id: string; contextId: string; subjectId: string; realm: Context['realm']; kind: 'REGISTER' | 'AUTH';
  factorId: string | null; challenge: string; purpose: string; resourceId: string | null; expiresAt: number; consumed: boolean }
export class WebAuthnService {
  private readonly ceremonies;
  constructor(readonly lifecycle: FactorLifecycle, readonly origins: { TENANT: string; PLATFORM: string }) {
    this.ceremonies = lifecycle.identity.database.db.collection<Ceremony>('webauthn_ceremonies');
  }
  async enroll(context: Context, label: string) {
    const service = this.lifecycle.identity;
    return await service.database.transaction(async session => {
      const factor = await this.lifecycle.enrollment(context, 'WEBAUTHN', label, session);
      const existing = await service.sessions.factors.find({ subjectId: factor.subjectId, realm: factor.realm, type: 'WEBAUTHN', state: 'ACTIVE' }, { session }).toArray();
      const origin = this.origins[factor.realm];
      const generated = await generateRegistrationOptions({ rpName: 'Caudelyx', rpID: new URL(origin).hostname,
        userName: factor.subjectId, userID: new TextEncoder().encode(factor.subjectId), userDisplayName: 'Usuario',
        challenge: new Uint8Array(randomBytes(32)), attestationType: 'none', supportedAlgorithmIDs: [-7, -257], timeout: 300000,
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
        excludeCredentials: existing.flatMap(f => f.credentialId ? [{ id: f.credentialId }] : []), extensions: {} });
      const options = { challenge: generated.challenge, rp: generated.rp, user: generated.user,
        pubKeyCredParams: generated.pubKeyCredParams, authenticatorSelection: generated.authenticatorSelection,
        attestation: 'none', excludeCredentials: generated.excludeCredentials ?? [], timeout: 300000, extensions: {} };
      const id = randomUUID();
      await service.sessions.factors.insertOne(factor, { session });
      await this.ceremonies.insertOne({ _id: id, contextId: context._id, subjectId: factor.subjectId, realm: factor.realm,
        kind: 'REGISTER', factorId: factor._id, challenge: generated.challenge, purpose: 'MFA_ENROLL', resourceId: null,
        expiresAt: factor.expiresAt, consumed: false }, { session });
      await service.audit.append({ realm: factor.realm, action: 'WEBAUTHN_ENROLLMENT_STARTED', actorId: factor.subjectId, subjectId: factor.subjectId, outcome: 'SUCCESS' }, session);
      return { ceremonyId: id, publicKey: options };
    });
  }
  private async failures(context: Context, id: string, record: boolean): Promise<void> {
    const service = this.lifecycle.identity;
    await service.sessions.enforceSourceLimit(digest(`webauthn:${context.realm}:${id}`), 5, 300000, record);
    await service.sessions.enforceSourceLimit(digest(`mfa-account:${context.realm}:${context.subjectId}`), 10, 900000, record);
  }
  async confirm(context: Context, id: string, response: RegistrationResponseJSON) {
    const service = this.lifecycle.identity; await service.requireOpen(context.realm);
    await this.failures(context, id, false);
    const ceremony = await this.ceremonies.findOne({ _id: id, contextId: context._id, realm: context.realm, consumed: false, kind: 'REGISTER' });
    if (!ceremony || ceremony.expiresAt <= service.now()) { await this.failures(context,id,true); throw new AppError(401, 'MFA_INVALID'); }
    let result;
    try { result = await verifyRegistrationResponse({ response, expectedChallenge: ceremony.challenge,
      expectedOrigin: this.origins[context.realm], expectedRPID: new URL(this.origins[context.realm]).hostname,
      requireUserVerification: true, requireUserPresence: true, supportedAlgorithmIDs: [-7, -257] }); }
    catch { await this.failures(context, id, true); throw new AppError(401, 'MFA_INVALID'); }
    if (!result.verified) { await this.failures(context, id, true); throw new AppError(401, 'MFA_INVALID'); }
    const verified = result.registrationInfo;
    return await service.database.transaction(async session => {
      const used = await this.ceremonies.updateOne({ _id: id, contextId: context._id, consumed: false, expiresAt: { $gt: service.now() } }, { $set: { consumed: true } }, { session });
      if (used.modifiedCount !== 1) throw new AppError(401, 'MFA_INVALID');
      await service.sessions.factors.updateOne({ _id: ceremony.factorId ?? '', confirmed: false, contextId: context._id },
        { $set: { credentialId: verified.credential.id, publicKey: Buffer.from(verified.credential.publicKey).toString('base64url'), counter: verified.credential.counter } }, { session });
      return await this.lifecycle.confirm(context, ceremony.factorId ?? '', session);
    }).catch(async(error:unknown)=>{
      if(error instanceof AppError&&error.code==='MFA_INVALID')await this.failures(context,id,true);
      throw error;
    });
  }
  async options(context: Context, purpose: string, resourceId: string | null) {
    const service = this.lifecycle.identity;
    return await service.database.transaction(async session => {
      const fresh = await this.lifecycle.challengeContext(context, purpose, resourceId, session);
      const factors = await service.sessions.factors.find({ subjectId: context.subjectId ?? '', realm: context.realm, type: 'WEBAUTHN', state: 'ACTIVE' }, { session }).toArray();
      const generated = await generateAuthenticationOptions({ rpID: new URL(this.origins[context.realm]).hostname,
        challenge: new Uint8Array(randomBytes(32)), userVerification: 'required', timeout: 300000,
        allowCredentials: factors.flatMap(f => f.credentialId ? [{ id: f.credentialId }] : []) });
      const id = randomUUID();
      await this.ceremonies.insertOne({ _id: id, kind: 'AUTH', contextId: context._id, subjectId: context.subjectId ?? '', realm: context.realm,
        factorId: null, challenge: generated.challenge, purpose, resourceId, expiresAt: Math.min(fresh.expiresAt, service.now() + 300000), consumed: false }, { session });
      return { ceremonyId: id, publicKey: { challenge: generated.challenge, rpId: generated.rpId,
        allowCredentials: generated.allowCredentials ?? [], userVerification: 'required', timeout: 300000, extensions: {} } };
    });
  }
  async authenticate(context: Context, id: string, response: AuthenticationResponseJSON, purpose: string, resourceId: string | null) {
    const service = this.lifecycle.identity; await service.requireOpen(context.realm);
    await this.failures(context, id, false);
    const ceremony = await this.ceremonies.findOne({ _id: id, contextId: context._id, realm: context.realm, kind: 'AUTH', purpose, resourceId, consumed: false });
    const factor = await service.sessions.factors.findOne({ subjectId: context.subjectId ?? '', realm: context.realm,
      state: 'ACTIVE', type: 'WEBAUTHN', credentialId: response.id });
    if (!ceremony || ceremony.expiresAt <= service.now() || !factor?.publicKey || !factor.credentialId) { await this.failures(context,id,true); throw new AppError(401, 'MFA_INVALID'); }
    let result;
    try { result = await verifyAuthenticationResponse({ response, expectedChallenge: ceremony.challenge,
      expectedOrigin: this.origins[context.realm], expectedRPID: new URL(this.origins[context.realm]).hostname, requireUserVerification: true,
      credential: { id: factor.credentialId, publicKey: new Uint8Array(Buffer.from(factor.publicKey, 'base64url')), counter: factor.counter ?? 0 } }); }
    catch { await this.failures(context, id, true); throw new AppError(401, 'MFA_INVALID'); }
    if (!result.verified) { await this.failures(context, id, true); throw new AppError(401, 'MFA_INVALID'); }
    return await service.database.transaction(async session => {
      const fresh = await this.lifecycle.challengeContext(context, purpose, resourceId, session);
      const used = await this.ceremonies.updateOne({ _id: id, consumed: false, expiresAt: { $gt: service.now() } }, { $set: { consumed: true } }, { session });
      const updated = await service.sessions.factors.updateOne({ _id: factor._id, state: 'ACTIVE', counter: factor.counter ?? 0 },
        { $set: { counter: result.authenticationInfo.newCounter, lastUsedAt: service.now(), verifiedFor: fresh._id, verifiedAt: service.now() } }, { session });
      if (used.modifiedCount !== 1 || updated.matchedCount !== 1) throw new AppError(401, 'MFA_INVALID');
      return { issued: await service.sessions.completeFactor(fresh, factor._id, session) };
    }).catch(async(error:unknown)=>{
      if(error instanceof AppError&&error.code==='MFA_INVALID')await this.failures(context,id,true);
      throw error;
    });
  }
}
