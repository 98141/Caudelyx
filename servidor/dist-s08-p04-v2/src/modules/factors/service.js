import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
export class FactorLifecycle {
    identity;
    recoveryGuard;
    constructor(identity) {
        this.identity = identity;
    }
    async enrollment(context, type, label, session) {
        await this.identity.requireOpen(context.realm);
        const fresh = await this.identity.freshContext(context, session);
        const subject = await this.identity.identities.findOne({ _id: fresh.subjectId ?? '', realm: fresh.realm }, { session });
        if (!subject || subject.suspended || fresh.credentialVersion !== subject.credentialVersion ||
            fresh.authEpoch !== subject.authEpoch || fresh.authzVersion !== subject.authzVersion)
            throw new AppError(401, 'AUTH_INVALID');
        if (context.realm === 'PLATFORM' && type !== 'WEBAUTHN')
            throw new AppError(403, 'ACCESS_DENIED');
        if (fresh.kind === 'B' || fresh.kind === 'W' && !subject.hasEverConfirmedFactor) {
            const intent = fresh.firstEnrollment;
            if (!await this.identity.eligible(subject) || fresh.initialProofEpoch !== subject.initialProofEpoch || !intent || intent.type !== type || intent.label !== label.trim() || intent.expiresAt <= this.identity.now())
                throw new AppError(403, 'INITIAL_MFA_PROOF_DENIED');
        }
        else if (fresh.kind === 'E_INITIAL') {
            if (!await this.identity.eligible(subject) || fresh.initialProofEpoch !== subject.initialProofEpoch ||
                !fresh.passwordAt || fresh.passwordAt + 300000 <= this.identity.now() || context.realm !== 'TENANT')
                throw new AppError(403, 'INITIAL_MFA_PROOF_DENIED');
        }
        else if (fresh.kind === 'E_RECOVERY') {
            if (!this.recoveryGuard)
                throw new AppError(503, 'SERVICE_UNAVAILABLE');
            await this.recoveryGuard(fresh, session);
        }
        else if (fresh.kind === 'S' || fresh.kind === 'W') {
            await this.identity.sessions.consumeProof(fresh, 'MFA_ENROLL', null, session, { methodType: type, label: label.trim() });
            if (!fresh.reauth?.enrollmentIntent)
                throw new AppError(403, 'REAUTH_REQUIRED');
        }
        else
            throw new AppError(403, 'MFA_REQUIRED');
        const factor = { _id: fresh.firstEnrollment ? fresh.firstEnrollment.id : ['S', 'W'].includes(fresh.kind) ? fresh.reauth.enrollmentIntent : randomUUID(), subjectId: subject._id, realm: subject.realm, type, label: label.trim(),
            state: fresh.kind === 'E_INITIAL' || !!fresh.firstEnrollment ? 'PENDING_INITIAL' : fresh.kind === 'E_RECOVERY' ? 'PENDING_RECOVERY' : 'PENDING_ADDITION',
            contextId: fresh._id, recoveryId: fresh.recoveryId ?? null, expiresAt: Math.min(this.identity.now() + 300000, fresh.expiresAt, fresh.firstEnrollment ? fresh.firstEnrollment.expiresAt : Infinity),
            confirmed: false, version: `"${randomUUID()}"`, createdAt: this.identity.now(), lastUsedAt: null };
        return factor;
    }
    async confirm(context, id, session) {
        await this.identity.requireOpen(context.realm);
        const fresh = await this.identity.freshContext(context, session);
        const factor = await this.identity.sessions.factors.findOne({ _id: id, contextId: context._id, subjectId: context.subjectId ?? '', realm: context.realm, confirmed: false }, { session });
        const identity = await this.identity.identities.findOne({ _id: context.subjectId ?? '', realm: context.realm, suspended: false }, { session });
        if (['B', 'W'].includes(fresh.kind) && fresh.firstEnrollment && fresh.firstEnrollment.expiresAt <= this.identity.now())
            throw new AppError(403, 'INITIAL_MFA_PROOF_DENIED');
        if (!identity || !factor || factor.expiresAt <= this.identity.now() || fresh.credentialVersion !== identity.credentialVersion ||
            fresh.authEpoch !== identity.authEpoch || fresh.authzVersion !== identity.authzVersion)
            throw new AppError(401, 'MFA_INVALID');
        if (factor.state === 'PENDING_INITIAL') {
            if (!['B', 'W', 'E_INITIAL'].includes(fresh.kind) || ['B', 'W'].includes(fresh.kind) && (!fresh.firstEnrollment || fresh.firstEnrollment.id !== id || fresh.firstEnrollment.expiresAt <= this.identity.now()) || !await this.identity.eligible(identity) || identity.initialProofEpoch !== fresh.initialProofEpoch ||
                !fresh.passwordAt || fresh.passwordAt + 300000 <= this.identity.now())
                throw new AppError(403, 'INITIAL_MFA_PROOF_DENIED');
            await this.identity.identities.updateOne({ _id: identity._id }, { $set: { hasEverConfirmedFactor: true,
                    factorCount: 1, state: identity.organizationId ? 'ACTIVE' : 'AUTHENTICATED_NO_ORG', initialProofEpoch: randomUUID() } }, { session });
            await this.identity.sessions.contexts.updateMany({ subjectId: identity._id, _id: { $ne: context._id }, kind: { $in: ['W', 'B', 'E_INITIAL', 'L'] } }, { $set: { revoked: true } }, { session });
            await this.identity.sessions.factors.updateMany({ subjectId: identity._id, _id: { $ne: id }, state: 'PENDING_INITIAL' }, { $set: { state: 'REVOKED' }, $unset: { encryptedSecret: '', publicKey: '' } }, { session });
            await this.identity.database.db.collection('webauthn_ceremonies').updateMany({ subjectId: identity._id, kind: 'REGISTER', factorId: { $ne: id } }, { $set: { consumed: true } }, { session });
            if (identity.resetCompletedAt !== null)
                await this.identity.messaging.notify(identity.realm, identity._id, 'FIRST_FACTOR_AFTER_PASSWORD_RESET', {}, session);
            await this.identity.messaging.proofs.updateMany({ subjectId: identity._id, purpose: 'INITIAL_MFA_PROOF' }, { $set: { consumed: true } }, { session });
        }
        else if (factor.state === 'PENDING_RECOVERY') {
            if (!this.recoveryGuard)
                throw new AppError(503, 'SERVICE_UNAVAILABLE');
            await this.recoveryGuard(fresh, session);
            await this.identity.sessions.factors.updateOne({ _id: id, confirmed: false }, { $set: { confirmed: true, expiresAt: fresh.expiresAt } }, { session });
            await this.identity.audit.append({ realm: identity.realm, action: 'RECOVERY_FACTOR_CONFIRMED_PENDING', actorId: identity._id, subjectId: identity._id, outcome: 'SUCCESS' }, session);
            return { data: { methodId: id } };
        }
        else if (factor.state === 'PENDING_ADDITION') {
            await this.identity.sessions.requireOperational(fresh, session);
            await this.identity.identities.updateOne({ _id: identity._id }, { $set: { credentialVersion: randomUUID(), hasEverConfirmedFactor: true }, $inc: { factorCount: 1 } }, { session });
            await this.identity.sessions.revokeAll(identity._id, session);
        }
        else
            throw new AppError(409, 'INVALID_STATE');
        await this.identity.sessions.factors.updateOne({ _id: id, confirmed: false }, { $set: {
                state: 'ACTIVE', confirmed: true, verifiedFor: context._id, verifiedAt: this.identity.now(), lastUsedAt: this.identity.now()
            } }, { session });
        await this.identity.audit.append({ realm: identity.realm, action: 'MFA_FACTOR_ACTIVATED', actorId: identity._id, subjectId: identity._id, outcome: 'SUCCESS' }, session);
        await this.identity.messaging.notify(identity.realm, identity._id, 'MFA_FACTOR_ACTIVATED', {}, session);
        if (factor.state === 'PENDING_ADDITION')
            return { data: { methodId: id, nextAction: 'LOGIN' } };
        return { data: { methodId: id, nextAction: 'READY' }, issued: await this.identity.sessions.completeFactor(fresh, id, session) };
    }
    async challengeContext(context, purpose, resourceId, session) {
        await this.identity.requireOpen(context.realm);
        const fresh = await this.identity.freshContext(context, session);
        if (fresh.kind === 'L' && purpose === 'LOGIN' && fresh.passwordAt && fresh.passwordAt + 300000 > this.identity.now())
            return fresh;
        if (fresh.kind === 'S' || fresh.kind === 'W') {
            await this.identity.sessions.requireOperational(fresh, session);
            const proof = fresh.reauth;
            if (proof && !proof.consumed && proof.expiresAt > this.identity.now() && proof.purpose === purpose && proof.resourceId === resourceId &&
                (fresh.kind === 'W' ? (proof.preparedAt ?? 0) : proof.passwordAt) + 300000 > this.identity.now())
                return fresh;
        }
        throw new AppError(403, 'REAUTH_REQUIRED');
    }
}
//# sourceMappingURL=service.js.map