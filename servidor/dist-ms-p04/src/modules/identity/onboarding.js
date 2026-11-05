import { randomUUID } from 'node:crypto';
import { MongoServerError } from 'mongodb';
import { AppError } from '../../shared/errors.js';
import { digest } from '../../shared/crypto.js';
export const pendingLifetime = 7 * 86400000;
export function emailVerified(identity) {
    return identity.emailVerified ?? identity.state !== 'PENDING_EMAIL';
}
export function pendingExpired(identity, now) {
    return identity.state === 'PENDING_EMAIL' && identity.createdAt + pendingLifetime <= now;
}
export function pristineHistory(identity) {
    return identity.hasEverConfirmedFactor === false && identity.hasEverActive === false &&
        identity.organizationId === null && identity.factorCount === 0 && identity.roles.length === 0 &&
        identity.restoreBootstrapBlocked === false && !identity.suspended;
}
/** AJ-ONB's account transitions; no tenant/financial permission is granted here. */
export class Onboarding {
    identity;
    constructor(identity) {
        this.identity = identity;
    }
    async register(realm, source, input, context) {
        const service = this.identity;
        await service.requireOpen(realm);
        if (realm !== 'TENANT')
            throw new AppError(403, 'ACCESS_DENIED');
        // Canonicalization remains owned by IdentityService's caller.
        const email = input.email;
        await service.sessions.enforceSourceLimit(digest(`email-source:${realm}:${source}`), 10, 3600000);
        const invitation = !context;
        if (!invitation && !input.password)
            throw new AppError(422, 'INPUT_INVALID');
        if (input.password)
            service.passwords.validate(input.password);
        const passwordHash = input.password ? await service.passwords.hash(input.password) : null;
        try {
            return await service.database.transaction(async (session) => {
                if (invitation) {
                    // Only the internal A15 PREPARE call omits a context. HTTP never controls this branch.
                    const proof = await service.database.db.collection('invitations')
                        .findOne({ email, status: 'PENDING', expiresAt: { $gt: service.now() } }, { session });
                    if (!proof)
                        throw new AppError(403, 'ACCESS_DENIED');
                }
                else {
                    const current = await service.freshContext(context, session);
                    if (current.kind !== 'P' || current.realm !== realm)
                        throw new AppError(401, 'AUTH_INVALID');
                }
                const existing = await service.identities.findOne({ realm, email }, { session });
                if (existing) {
                    if (invitation)
                        return { data: { code: 'GENERIC_ACCOUNT_ACTION' } };
                    throw new AppError(409, 'ACCOUNT_ALREADY_EXISTS');
                }
                if (await service.database.db.collection('restore_claims').findOne({ _id: digest(`${realm}:${email}`) }, { session })) {
                    throw new AppError(503, 'SERVICE_UNAVAILABLE');
                }
                const subject = { _id: randomUUID(), realm, email, displayName: input.displayName.trim(),
                    passwordHash, state: 'PENDING_EMAIL', emailVerified: false, registrationSource: invitation ? 'INVITATION' : 'DIRECT',
                    organizationId: null, roles: [], version: `"${randomUUID()}"`, profileVersion: `"${randomUUID()}"`,
                    credentialVersion: randomUUID(), initialProofEpoch: randomUUID(), authEpoch: randomUUID(), authzVersion: randomUUID(),
                    hasEverConfirmedFactor: false, hasEverActive: false, resetCompletedAt: null, restoreBootstrapBlocked: false,
                    suspended: false, createdAt: service.now(), factorCount: 0 };
                await service.identities.insertOne(subject, { session });
                await service.database.db.collection('consents').insertOne({ subjectId: subject._id,
                    privacyPolicyVersion: input.privacyPolicyVersion, acceptedAt: service.now() }, { session });
                await service.audit.append({ realm, action: invitation ? 'INVITATION_REGISTRATION' : 'ACCOUNT_REGISTERED', subjectId: subject._id, actorId: subject._id, outcome: 'SUCCESS' }, session);
                await service.messaging.enqueue(subject, 'ACTIVATION', source, null, session);
                if (invitation)
                    return { data: { code: 'GENERIC_ACCOUNT_ACTION' } };
                await service.sessions.contexts.updateOne({ _id: context._id }, { $set: { revoked: true } }, { session });
                return { issued: await service.sessions.issue(realm, 'B', subject, session),
                    data: { authState: 'PENDING_EMAIL', nextAction: 'VERIFY_EMAIL', sessionContext: 'B' } };
            });
        }
        catch (error) {
            if (error instanceof MongoServerError && error.code === 11000 && error.keyPattern?.['realm'] === 1 && error.keyPattern?.['email'] === 1) {
                throw new AppError(409, 'ACCOUNT_ALREADY_EXISTS');
            }
            throw error;
        }
    }
    async confirm(context, token) {
        const service = this.identity;
        await service.requireOpen(context.realm);
        if (context.realm !== 'TENANT')
            throw new AppError(403, 'ACCESS_DENIED');
        return await service.database.transaction(async (session) => {
            const current = await service.freshContext(context, session);
            if (!['P', 'B'].includes(current.kind))
                throw new AppError(401, 'AUTH_INVALID');
            const proof = await service.messaging.proofs.findOne({ _id: digest(token), realm: context.realm, purpose: 'ACTIVATION', consumed: false, expiresAt: { $gt: service.now() } }, { session });
            const subject = proof ? await service.identities.findOne({ _id: proof.subjectId, realm: context.realm }, { session }) : null;
            if (!proof || !subject || subject.credentialVersion !== proof.credentialVersion || subject.state !== 'PENDING_EMAIL' ||
                !pristineHistory(subject) || pendingExpired(subject, service.now()))
                throw new AppError(401, 'TOKEN_INVALID');
            if (current.kind === 'B' && current.subjectId !== subject._id)
                throw new AppError(403, 'ACCESS_DENIED');
            if (!subject.passwordHash)
                throw new AppError(422, 'INPUT_INVALID'); // Legacy invitation must set its first password explicitly.
            await service.identities.updateOne({ _id: subject._id, state: 'PENDING_EMAIL', credentialVersion: proof.credentialVersion }, { $set: { state: 'MFA_ENROLLMENT', emailVerified: true } }, { session });
            await service.messaging.proofs.updateMany({ subjectId: subject._id, purpose: 'ACTIVATION' }, { $set: { consumed: true } }, { session });
            await service.audit.append({ realm: subject.realm, action: 'EMAIL_VERIFIED', actorId: subject._id, subjectId: subject._id, outcome: 'SUCCESS' }, session);
            if (current.kind === 'P') {
                await service.sessions.contexts.updateOne({ _id: current._id }, { $set: { revoked: true } }, { session });
                return { issued: await service.sessions.issue('TENANT', 'P', null, session), data: { emailVerified: true, nextAction: 'LOGIN' } };
            }
            await service.sessions.contexts.updateOne({ _id: current._id }, { $set: { revoked: true } }, { session });
            const issued = await service.sessions.issue(subject.realm, 'W', { ...subject, state: 'MFA_ENROLLMENT', emailVerified: true }, session);
            issued.context.createdAt = current.createdAt;
            issued.context.expiresAt = current.expiresAt;
            await service.sessions.contexts.replaceOne({ _id: issued.context._id }, issued.context, { session });
            return { issued, data: { emailVerified: true, nextAction: 'PROFILE' } };
        });
    }
    async prepareFactor(context, type, label, password, stepUp) {
        if (context.kind !== 'B' && context.kind !== 'W') {
            // eslint-disable-next-line security/detect-possible-timing-attacks -- Tests property absence, never compares credential values.
            if (password !== undefined)
                throw new AppError(422, 'INPUT_INVALID');
            return;
        }
        const service = this.identity;
        await service.requireOpen(context.realm);
        if (!label.trim() || label.trim().length > 60)
            throw new AppError(422, 'INPUT_INVALID');
        const subject = await service.identities.findOne({ _id: context.subjectId ?? '', realm: context.realm });
        if (!subject || pendingExpired(subject, service.now()))
            throw new AppError(401, 'AUTH_INVALID');
        // eslint-disable-next-line security/detect-possible-timing-attacks -- Tests presence, never compares a password value.
        if (context.kind === 'W' && subject.hasEverConfirmedFactor) {
            if (password !== undefined)
                throw new AppError(422, 'INPUT_INVALID');
            return;
        }
        if (!emailVerified(subject))
            throw new AppError(403, 'EMAIL_NOT_VERIFIED');
        await service.sessions.enforceSourceLimit(digest(`onboarding-password:${context._id}`), 5, 900000);
        if (!password || !await service.passwords.verify(subject.passwordHash, password))
            throw new AppError(401, 'AUTH_INVALID');
        await service.database.transaction(async (session) => {
            const fresh = await service.freshContext(context, session);
            const current = await service.identities.findOne({ _id: subject._id }, { session });
            if (!current || fresh.credentialVersion !== subject.credentialVersion || !await service.eligible(current))
                throw new AppError(403, 'INITIAL_MFA_PROOF_DENIED');
            if (stepUp) {
                if (stepUp.method !== type)
                    throw new AppError(422, 'INPUT_INVALID');
                if (!service.work)
                    throw new AppError(503, 'SERVICE_UNAVAILABLE');
                await service.work.prepareInTransaction(fresh, current, stepUp, session, true);
            }
            const intent = { id: randomUUID(), type, label: label.trim(), passwordAt: service.now(), expiresAt: Math.min(service.now() + 300000, fresh.expiresAt) };
            await service.sessions.contexts.updateOne({ _id: fresh._id }, { $set: { firstEnrollment: intent, passwordAt: intent.passwordAt, initialProofEpoch: current.initialProofEpoch } }, { session });
        });
    }
    async profile(context, input, ifMatch) {
        const service = this.identity;
        await service.requireOpen(context.realm);
        return await service.database.transaction(async (session) => {
            const fresh = await service.freshContext(context, session);
            if (fresh.realm !== 'TENANT' || !['B', 'W', 'L', 'S'].includes(fresh.kind))
                throw new AppError(403, 'ACCESS_DENIED');
            const subject = await service.identities.findOne({ _id: fresh.subjectId ?? '', realm: fresh.realm }, { session });
            if (!subject)
                throw new AppError(401, 'AUTH_INVALID');
            if (!ifMatch)
                throw new AppError(428, 'PRECONDITION_REQUIRED');
            if (ifMatch !== (subject.profileVersion ?? subject.version))
                throw new AppError(412, 'PRECONDITION_FAILED');
            subject.displayName = input.displayName.trim();
            subject.profileVersion = `"${randomUUID()}"`;
            subject.version = `"${randomUUID()}"`; // A11 also projects the name; preserve its strong resource ETag.
            if (!subject.displayName)
                throw new AppError(422, 'INPUT_INVALID');
            await service.identities.updateOne({ _id: subject._id }, { $set: { displayName: subject.displayName, profileVersion: subject.profileVersion, version: subject.version } }, { session });
            await service.audit.append({ realm: subject.realm, action: 'OWN_PROFILE_UPDATED', actorId: subject._id, subjectId: subject._id, outcome: 'SUCCESS' }, session);
            return { data: service.ownProfile(subject), etag: subject.profileVersion };
        });
    }
    async remove(subject, reason, session) {
        const service = this.identity;
        if (subject.state !== 'PENDING_EMAIL' || !pristineHistory(subject))
            throw new AppError(401, 'TOKEN_INVALID');
        const removed = await service.identities.deleteOne({ _id: subject._id, state: 'PENDING_EMAIL', credentialVersion: subject.credentialVersion }, { session });
        if (removed.deletedCount !== 1)
            throw new AppError(401, 'TOKEN_INVALID');
        await service.sessions.revokeAll(subject._id, session);
        await service.registrations.deleteMany({ realm: 'TENANT', email: subject.email }, { session });
        await service.messaging.proofs.deleteMany({ subjectId: subject._id }, { session });
        await service.messaging.messages.deleteMany({ subjectId: subject._id }, { session });
        await service.messaging.quotas.deleteMany({ subjectId: subject._id }, { session });
        await service.database.db.collection('consents').deleteMany({ subjectId: subject._id }, { session });
        await service.database.db.collection('onboarding_tombstones').insertOne({
            _id: subject._id, emailHash: digest(`${subject.realm}:${subject.email}`), reason, removedAt: service.now()
        }, { session });
        await service.audit.append({ realm: subject.realm, action: 'UNCONFIRMED_ACCOUNT_' + reason, actorId: subject._id, subjectId: subject._id, outcome: 'SUCCESS' }, session);
    }
    async reject(context, token) {
        const service = this.identity;
        await service.requireOpen(context.realm);
        await service.database.transaction(async (session) => {
            const fresh = await service.freshContext(context, session);
            if (fresh.kind !== 'P' || fresh.realm !== 'TENANT')
                throw new AppError(403, 'ACCESS_DENIED');
            const proof = await service.messaging.proofs.findOne({ _id: digest(token), realm: 'TENANT', purpose: 'ACTIVATION', consumed: false, expiresAt: { $gt: service.now() } }, { session });
            const subject = proof ? await service.identities.findOne({ _id: proof.subjectId, realm: 'TENANT' }, { session }) : null;
            if (!proof || !subject || proof.credentialVersion !== subject.credentialVersion || pendingExpired(subject, service.now()))
                throw new AppError(401, 'TOKEN_INVALID');
            await this.remove(subject, 'REJECTED', session);
        });
    }
    async expire() {
        const service = this.identity;
        if (!await service.isRealmOpen('TENANT'))
            return;
        const candidates = await service.identities.find({ realm: 'TENANT', state: 'PENDING_EMAIL', createdAt: { $lte: service.now() - pendingLifetime } }).limit(100).toArray();
        for (const candidate of candidates)
            await service.database.transaction(async (session) => {
                const subject = await service.identities.findOne({ _id: candidate._id, state: 'PENDING_EMAIL' }, { session });
                if (subject && pristineHistory(subject) && pendingExpired(subject, service.now()))
                    await this.remove(subject, 'EXPIRED', session);
            });
    }
}
//# sourceMappingURL=onboarding.js.map