import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { normalizeCommand, authorizePurpose } from '../../shared/commands.js';
import { canonicalEmail } from '../identity/service.js';
import { purposeClass, sessionMeta, workContract } from './work-policy.js';
export class StepUpService {
    identity;
    totp;
    webauthn;
    constructor(identity, totp, webauthn) {
        this.identity = identity;
        this.totp = totp;
        this.webauthn = webauthn;
    }
    async prepareInTransaction(context, actor, input, session, initial = false) {
        workContract().validate('StepUpPrepare', input);
        if (context.kind !== 'W' || !purposeClass(input.purpose) || purposeClass(input.purpose) === 'WORK_ONLY')
            throw new AppError(403, 'ACCESS_DENIED');
        authorizePurpose(context.realm, input.purpose, input.command);
        const command = normalizeCommand(input.purpose, input.command, canonicalEmail), enrollmentIntent = input.purpose === 'MFA_ENROLL' ? randomUUID() : null;
        const resourceId = input.resourceId ?? null;
        const snapshotHash = await this.identity.sessions.snapshot(input.purpose, resourceId, actor, session, command, enrollmentIntent);
        if (!initial && !await this.identity.sessions.factors.findOne({ subjectId: actor._id, realm: 'TENANT', state: 'ACTIVE' }, { session }))
            throw new AppError(403, 'MFA_ENROLLMENT_REQUIRED');
        const reauth = { intentId: randomUUID(), preparedAt: this.identity.now(), method: input.method, purpose: input.purpose, resourceId, snapshotHash, passwordAt: context.passwordAt ?? context.createdAt, expiresAt: Math.min(this.identity.now() + 300000, context.expiresAt), factorId: null, consumed: false, command, enrollmentIntent };
        await this.identity.sessions.contexts.updateOne({ _id: context._id, revoked: false }, { $set: { reauth } }, { session });
        return reauth;
    }
    async prepare(context, input) {
        await this.identity.requireOpen(context.realm);
        const proof = await this.identity.database.transaction(async (session) => {
            const { context: fresh, identity } = await this.identity.sessions.requireOperational(context, session);
            return this.prepareInTransaction(fresh, identity, input, session);
        });
        let publicKey;
        if (input.method === 'WEBAUTHN') {
            const prepared = await this.webauthn.options(context, input.purpose, input.resourceId ?? null);
            publicKey = prepared.publicKey;
            await this.identity.sessions.contexts.updateOne({ _id: context._id, 'reauth.intentId': proof.intentId }, { $set: { 'reauth.ceremonyId': prepared.ceremonyId } });
        }
        return { intentId: proof.intentId, expiresAt: new Date(proof.expiresAt).toISOString(), method: input.method, ...(publicKey ? { publicKey } : {}) };
    }
    async verify(context, input, sessionToken) {
        await this.identity.requireOpen(context.realm);
        workContract().validate('StepUpVerify', input);
        const current = await this.identity.database.transaction(async (session) => this.identity.sessions.requireOperational(context, session));
        const proof = current.context.reauth;
        if (!proof || proof.intentId !== input.intentId || proof.method !== input.method || proof.consumed || proof.expiresAt <= this.identity.now())
            throw new AppError(403, 'REAUTH_REQUIRED');
        const result = input.method === 'TOTP' ? await this.totp.authenticate(context, input.code, proof.purpose, proof.resourceId, input.intentId, sessionToken) : await this.webauthn.authenticate(context, proof.ceremonyId ?? '', input.credential, proof.purpose, proof.resourceId, input.intentId, sessionToken);
        const data = purposeClass(proof.purpose) === 'BALANCE_60M' ? { verifiedClass: 'BALANCE_60M', session: sessionMeta(result.issued.context, this.identity.now()) } : { verifiedClass: 'SECURITY_ONE_SHOT', proofExpiresAt: new Date(proof.expiresAt).toISOString() };
        workContract().validate('StepUpVerified', { data, requestId: context.managementId }, true);
        return { issued: result.issued, data };
    }
}
//# sourceMappingURL=step-up.js.map