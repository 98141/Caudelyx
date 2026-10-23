import { generateSecret, generateURI, verify } from 'otplib';
import type { Context } from '../identity/models.js';
import type { FactorLifecycle } from '../factors/service.js';
import { seal, unseal, digest } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';

export class TotpService {
  constructor(readonly lifecycle: FactorLifecycle, readonly key: Buffer) {}
  private async recordFailure(context: Context): Promise<void> {
    const sessions=this.lifecycle.identity.sessions;
    await sessions.enforceSourceLimit(digest(`mfa-context:${context._id}`),5,300000);
    await sessions.enforceSourceLimit(digest(`mfa-account:${context.realm}:${context.subjectId}`),10,900000);
  }
  async enroll(context: Context, label: string, password?:string) {
    const service = this.lifecycle.identity;
    await this.lifecycle.identity.onboarding.prepareFactor(context,'TOTP',label,password);
    return await service.database.transaction(async session => {
      const factor = await this.lifecycle.enrollment(context, 'TOTP', label, session);
      const secret = generateSecret({ length: 20 });
      factor.encryptedSecret = seal(secret, this.key); factor.keyVersion = 1; factor.lastStep = -1;
      await service.sessions.factors.insertOne(factor, { session });
      await service.audit.append({ realm: factor.realm, action: 'TOTP_ENROLLMENT_STARTED', actorId: factor.subjectId, subjectId: factor.subjectId, outcome: 'SUCCESS' }, session);
      return { enrollmentId: factor._id, provisioningUri: generateURI({ issuer: 'Caudelyx', label: (await service.identities.findOne({_id:factor.subjectId},{session}))!.email,
        secret, algorithm: 'sha1', digits: 6, period: 30 }), expiresAt: new Date(factor.expiresAt).toISOString() };
    });
  }
  private async check(context: Context, code: string, active: boolean, enrollmentId?: string) {
    const service = this.lifecycle.identity;
    if (context.realm !== 'TENANT' || !/^\d{6}$/.test(code)) throw new AppError(401, 'MFA_INVALID');
    const failureKey = digest(`mfa-context:${context._id}`), accountKey = digest(`mfa-account:${context.realm}:${context.subjectId}`);
    await service.sessions.enforceSourceLimit(failureKey, 5, 300000, false);
    await service.sessions.enforceSourceLimit(accountKey, 10, 900000, false);
    const factors = await service.sessions.factors.find({ subjectId: context.subjectId ?? '', realm: context.realm,
      type: 'TOTP', ...(active ? { state: 'ACTIVE' as const } : { _id: enrollmentId ?? '', contextId: context._id, confirmed: false }) }).toArray();
    for (const factor of factors) {
      if (!factor.encryptedSecret || factor.keyVersion !== 1) continue;
      const result = await verify({ secret: unseal(factor.encryptedSecret, this.key), token: code,
        epoch: Math.floor(service.now() / 1000), epochTolerance: 0, period: 30, digits: 6, algorithm: 'sha1' });
      if (result.valid) return factor;
    }
    await this.recordFailure(context);
    throw new AppError(401, 'MFA_INVALID');
  }
  async confirm(context: Context, enrollmentId: string, code: string) {
    const factor = await this.check(context, code, false, enrollmentId), service = this.lifecycle.identity;
    return await service.database.transaction(async session => {
      const step = Math.floor(service.now() / 30000);
      const updated = await service.sessions.factors.updateOne({ _id: factor._id, lastStep: { $lt: step }, confirmed: false }, { $set: { lastStep: step } }, { session });
      if (updated.modifiedCount !== 1) throw new AppError(401, 'MFA_INVALID');
      return await this.lifecycle.confirm(context, factor._id, session);
    }).catch(async (error: unknown)=>{
      if(error instanceof AppError&&error.code==='MFA_INVALID')await this.recordFailure(context);
      throw error;
    });
  }
  async authenticate(context: Context, code: string, purpose: string, resourceId: string | null) {
    const factor = await this.check(context, code, true), service = this.lifecycle.identity;
    return await service.database.transaction(async session => {
      const fresh = await this.lifecycle.challengeContext(context, purpose, resourceId, session);
      const step = Math.floor(service.now() / 30000);
      const updated = await service.sessions.factors.updateOne({ _id: factor._id, state: 'ACTIVE', lastStep: { $lt: step } },
        { $set: { lastStep: step, verifiedFor: fresh._id, verifiedAt: service.now(), lastUsedAt: service.now() } }, { session });
      if (updated.modifiedCount !== 1) throw new AppError(401, 'MFA_INVALID');
      return { issued: await service.sessions.completeFactor(fresh, factor._id, session) };
    }).catch(async (error: unknown)=>{
      if(error instanceof AppError&&error.code==='MFA_INVALID')await this.recordFailure(context);
      throw error;
    });
  }
}
