import { randomUUID } from 'node:crypto';
import { opaque, digest, equalSecret } from '../../shared/crypto.js';
import { emailVerified, pendingExpired } from '../identity/onboarding.js';
import { AppError } from '../../shared/errors.js';
import { WORK_POLICY, IDLE_MS, purposeClass } from './work-policy.js';
import { AuditWriter } from '../../shared/audit.js';
export class Sessions {
    database;
    now;
    contexts;
    identities;
    factors;
    audit;
    snapshotResolver;
    completionValidator;
    factorCompletionHook;
    constructor(database, now = Date.now) {
        this.database = database;
        this.now = now;
        this.contexts = database.db.collection('contexts');
        this.identities = database.db.collection('identities');
        this.factors = database.db.collection('factors');
        this.audit = new AuditWriter(database);
    }
    async initialize() {
        await this.contexts.createIndex({ managementId: 1 }, { unique: true });
        await this.contexts.createIndex({ subjectId: 1, realm: 1, kind: 1 });
        await this.factors.createIndex({ credentialId: 1 }, { unique: true, partialFilterExpression: { credentialId: { $type: 'string' } } });
    }
    async issue(realm, kind, identity, session) {
        if ((kind === 'B' || kind === 'W') && (realm !== 'TENANT' || !identity))
            throw new AppError(403, 'ACCESS_DENIED');
        if (kind === 'S')
            throw new AppError(503, 'SERVICE_UNAVAILABLE'); // Only completeFactor can create S after a committed factor verification.
        const token = opaque(), csrf = opaque(), now = this.now();
        const context = { _id: digest(token), managementId: randomUUID(), realm, kind,
            subjectId: identity?._id ?? null, csrfHash: digest(csrf), createdAt: now, lastSeenAt: now,
            expiresAt: now + (kind === 'B' || kind === 'W' ? 43200000 : kind === 'P' ? 600000 : kind === 'E_RECOVERY' ? 900000 : 300000), revoked: false,
            credentialVersion: identity?.credentialVersion ?? null, initialProofEpoch: identity?.initialProofEpoch ?? null,
            authEpoch: identity?.authEpoch ?? null, authzVersion: identity?.authzVersion ?? null,
            passwordAt: kind === 'P' || kind === 'B' ? null : now, preview: null };
        if (realm === 'TENANT')
            context.policyVersion = WORK_POLICY;
        if (kind === 'W' && identity) {
            if (!emailVerified(identity) || identity.restoreBootstrapBlocked && identity.factorCount === 0 || identity.suspended || ['RECOVERY_RESTRICTED', 'FACTOR_LOSS_BLOCKED'].includes(identity.state) || identity.hasEverConfirmedFactor && identity.factorCount === 0)
                throw new AppError(403, 'ACCESS_DENIED');
            const org = identity.organizationId ? await this.database.db.collection('organizations').findOne({ _id: identity.organizationId }, session ? { session } : {}) : null;
            if (identity.organizationId && org?.status !== 'ACTIVE')
                throw new AppError(403, 'ACCESS_DENIED');
            context.organizationEpoch = org?.authEpoch ?? null;
            context.policyVersion = WORK_POLICY;
            this.completionValidator?.(context, identity);
        }
        await this.contexts.insertOne(context, session ? { session } : {});
        if (kind === 'W' && identity) {
            await this.identities.updateOne({ _id: identity._id }, { $inc: { sessionSerial: 1 } }, session ? { session } : {});
            const live = await this.contexts.find({ subjectId: identity._id, realm, kind: { $in: ['W', 'S'] }, revoked: false, expiresAt: { $gt: now }, lastSeenAt: { $gt: now - IDLE_MS } }, session ? { session } : {}).sort({ createdAt: 1, _id: 1 }).toArray();
            for (const old of live.slice(0, Math.max(0, live.length - 5)))
                await this.contexts.updateOne({ _id: old._id }, { $set: { revoked: true } }, session ? { session } : {});
        }
        return { context, token, csrf };
    }
    async find(token, realm, session) {
        if (!token || token.length > 128)
            return null;
        const context = await this.contexts.findOne({ _id: digest(token), realm, revoked: false }, session ? { session } : {});
        if (!context || context.expiresAt <= this.now() || realm === 'TENANT' && (context.kind === 'S' || context.policyVersion !== WORK_POLICY) || context.kind === 'W' && context.policyVersion !== WORK_POLICY)
            return null;
        if ((context.kind === 'S' || context.kind === 'B' || context.kind === 'W') && context.lastSeenAt + (realm === 'TENANT' ? IDLE_MS : 900000) <= this.now())
            return null;
        if (context.subjectId) {
            const identity = await this.identities.findOne({ _id: context.subjectId, realm }, session ? { session } : {});
            if (!identity || identity.suspended || pendingExpired(identity, this.now()) || identity.credentialVersion !== context.credentialVersion ||
                identity.authEpoch !== context.authEpoch || identity.authzVersion !== context.authzVersion ||
                (context.kind === 'E_INITIAL' && identity.initialProofEpoch !== context.initialProofEpoch))
                return null;
            if (context.kind === 'W' && (!emailVerified(identity) || identity.restoreBootstrapBlocked && identity.factorCount === 0 || ['RECOVERY_RESTRICTED', 'FACTOR_LOSS_BLOCKED'].includes(identity.state) || identity.hasEverConfirmedFactor && identity.factorCount === 0))
                return null;
            if (context.kind === 'S' || context.kind === 'W') {
                if (context.kind === 'S' && !await this.factors.findOne({ _id: context.factorId ?? '', subjectId: identity._id, state: 'ACTIVE' }, session ? { session } : {}))
                    return null;
                if (identity.organizationId) {
                    const organization = await this.database.db.collection('organizations').findOne({ _id: identity.organizationId }, session ? { session } : {});
                    if (!organization || organization['status'] !== 'ACTIVE' || organization['authEpoch'] !== context.organizationEpoch)
                        return null;
                }
                if (!session && context.realm === 'PLATFORM') {
                    const touched = await this.contexts.updateOne({ _id: context._id, revoked: false }, { $set: { lastSeenAt: this.now() } });
                    if (!touched.matchedCount)
                        return null;
                    context.lastSeenAt = this.now();
                }
            }
        }
        return context;
    }
    async requireOperational(context, session) {
        if (context.realm === 'PLATFORM')
            return this.requireStrong(context, session);
        const current = await this.findById(context, session);
        const identity = await this.identities.findOne({ _id: current.subjectId ?? '', realm: 'TENANT' }, { session });
        if (!identity)
            throw new AppError(401, 'AUTH_INVALID');
        if (!emailVerified(identity))
            throw new AppError(403, 'EMAIL_NOT_VERIFIED');
        if (current.kind !== 'W')
            throw new AppError(403, 'MFA_REQUIRED');
        if (identity.restoreBootstrapBlocked && identity.factorCount === 0 || ['RECOVERY_RESTRICTED', 'FACTOR_LOSS_BLOCKED'].includes(identity.state) || identity.hasEverConfirmedFactor && identity.factorCount === 0)
            throw new AppError(403, 'ACCESS_DENIED');
        if (identity.organizationId) {
            const org = await this.database.db.collection('organizations').findOne({ _id: identity.organizationId }, { session });
            if (org?.status !== 'ACTIVE' || org.authEpoch !== current.organizationEpoch)
                throw new AppError(403, 'ACCESS_DENIED');
        }
        return { context: current, identity };
    }
    async findById(context, session) {
        const current = await this.contexts.findOne({ _id: context._id, realm: context.realm, revoked: false, expiresAt: { $gt: this.now() } }, { session });
        if (!current || ['W', 'B'].includes(current.kind) && current.lastSeenAt + IDLE_MS <= this.now() || current.kind === 'W' && current.policyVersion !== WORK_POLICY)
            throw new AppError(401, 'AUTH_INVALID');
        const identity = await this.identities.findOne({ _id: current.subjectId ?? '', realm: current.realm }, { session });
        if (!identity || identity.suspended || pendingExpired(identity, this.now()) || identity.credentialVersion !== current.credentialVersion || identity.authEpoch !== current.authEpoch || identity.authzVersion !== current.authzVersion)
            throw new AppError(401, 'AUTH_INVALID');
        return current;
    }
    async requireStrong(context, session) {
        if (context.kind !== 'S') {
            const fresh = await this.contexts.findOne({ _id: context._id, realm: context.realm, revoked: false, expiresAt: { $gt: this.now() } }, { session });
            const subject = fresh ? await this.identities.findOne({ _id: fresh.subjectId ?? '', realm: fresh.realm }, { session }) : null;
            if (!fresh || !subject || subject.suspended || pendingExpired(subject, this.now()) || fresh.credentialVersion !== subject.credentialVersion || fresh.authEpoch !== subject.authEpoch || fresh.authzVersion !== subject.authzVersion || fresh.kind === 'B' && fresh.lastSeenAt + IDLE_MS <= this.now())
                throw new AppError(401, 'AUTH_INVALID');
            throw new AppError(403, emailVerified(subject) ? 'MFA_REQUIRED' : 'EMAIL_NOT_VERIFIED');
        }
        const current = await this.contexts.findOne({ _id: context._id, realm: context.realm, kind: 'S', revoked: false }, { session });
        if (!current || current.expiresAt <= this.now() || current.lastSeenAt + (current.realm === 'TENANT' ? IDLE_MS : 900000) <= this.now())
            throw new AppError(401, 'AUTH_INVALID');
        const identity = await this.identities.findOne({ _id: current.subjectId ?? '', realm: current.realm, suspended: false }, { session });
        if (!identity || identity.credentialVersion !== current.credentialVersion || identity.authEpoch !== current.authEpoch || identity.authzVersion !== current.authzVersion)
            throw new AppError(401, 'AUTH_INVALID');
        if (!await this.factors.findOne({ _id: current.factorId ?? '', subjectId: identity._id, state: 'ACTIVE' }, { session }))
            throw new AppError(401, 'AUTH_INVALID');
        if (identity.organizationId) {
            const org = await this.database.db.collection('organizations').findOne({ _id: identity.organizationId }, { session });
            if (!org || org.status !== 'ACTIVE' || org.authEpoch !== current.organizationEpoch)
                throw new AppError(403, 'ACCESS_DENIED');
        }
        return { context: current, identity };
    }
    async completeFactor(context, factorId, session, sessionToken) {
        const current = await this.contexts.findOne({ _id: context._id, realm: context.realm, revoked: false }, { session });
        let identity = await this.identities.findOne({ _id: context.subjectId ?? '', realm: context.realm, suspended: false }, { session });
        const factor = await this.factors.findOneAndUpdate({ _id: factorId, subjectId: context.subjectId ?? '', realm: context.realm,
            state: 'ACTIVE', verifiedFor: context._id, verifiedAt: { $gte: this.now() - 1000 } }, { $unset: { verifiedFor: '', verifiedAt: '' } }, { session, returnDocument: 'before' });
        if (current?.kind === 'W') {
            const valid = await this.requireOperational(current, session);
            if (!identity || !factor)
                throw new AppError(401, 'MFA_INVALID');
            const initial = current.firstEnrollment;
            if (initial) {
                if (initial.id !== factorId || initial.expiresAt <= this.now() || initial.passwordAt + 300000 <= this.now())
                    throw new AppError(403, 'INITIAL_MFA_PROOF_DENIED');
            }
            else if (!current.reauth || current.reauth.consumed || current.reauth.expiresAt <= this.now())
                throw new AppError(403, 'REAUTH_REQUIRED');
            if (sessionToken && (initial || !current.passwordAt || digest(sessionToken) !== current._id))
                throw new AppError(403, 'ACCESS_DENIED');
            const token = sessionToken ?? opaque(), csrf = opaque(), next = { ...valid.context, _id: digest(token), managementId: sessionToken ? current.managementId : randomUUID(), csrfHash: digest(csrf), factorId, reauth: current.reauth ? { ...current.reauth, factorId } : null };
            if (next.reauth && purposeClass(next.reauth.purpose) === 'BALANCE_60M') {
                if ((identity.cooldownUntil ?? 0) > this.now())
                    throw new AppError(403, 'RECOVERY_RESTRICTED');
                next.balanceGrant = { factorId, organizationId: identity.organizationId, expiresAt: Math.min(this.now() + IDLE_MS, next.expiresAt) };
                next.reauth = null;
            }
            delete next.firstEnrollment;
            this.completionValidator?.(next, identity);
            if (sessionToken) {
                const changed = await this.contexts.replaceOne({ _id: current._id, revoked: false }, next, { session });
                if (changed.matchedCount !== 1)
                    throw new AppError(401, 'AUTH_INVALID');
            }
            else {
                await this.contexts.updateOne({ _id: current._id, revoked: false }, { $set: { revoked: true } }, { session });
                await this.contexts.insertOne(next, { session });
            }
            return { context: next, token, csrf };
        }
        if (!current || !identity || !factor || current.expiresAt <= this.now() || !current.passwordAt || current.passwordAt + 300000 <= this.now() ||
            !['B', 'L', 'E_INITIAL', 'S'].includes(current.kind) || current.credentialVersion !== identity.credentialVersion ||
            current.authEpoch !== identity.authEpoch || current.authzVersion !== identity.authzVersion ||
            current.kind === 'S' && current.lastSeenAt + (current.realm === 'TENANT' ? IDLE_MS : 900000) <= this.now())
            throw new AppError(401, 'MFA_INVALID');
        if (current.kind === 'B' && (!current.firstEnrollment || current.firstEnrollment.id !== factorId || current.firstEnrollment.expiresAt <= this.now() || current.lastSeenAt + IDLE_MS <= this.now() || !emailVerified(identity)))
            throw new AppError(403, 'INITIAL_MFA_PROOF_DENIED');
        if (identity.state === 'RECOVERY_RESTRICTED') {
            if (!this.factorCompletionHook)
                throw new AppError(503, 'SERVICE_UNAVAILABLE');
            await this.factorCompletionHook(identity, session);
            identity = await this.identities.findOne({ _id: identity._id }, { session });
            if (!identity)
                throw new AppError(401, 'AUTH_INVALID');
        }
        if (identity.realm === 'PLATFORM' && (factor.type !== 'WEBAUTHN' || await this.factors.countDocuments({ subjectId: identity._id, state: 'ACTIVE', type: 'WEBAUTHN' }, { session }) < 2))
            throw new AppError(403, 'MFA_REQUIRED');
        await this.identities.updateOne({ _id: identity._id }, { $inc: { sessionSerial: 1 } }, { session });
        await this.contexts.updateOne({ _id: current._id }, { $set: { revoked: true } }, { session });
        const token = opaque(), csrf = opaque(), now = this.now();
        const org = identity.organizationId ? await this.database.db.collection('organizations').findOne({ _id: identity.organizationId }, { session }) : null;
        if (identity.organizationId && (!org || org.status !== 'ACTIVE'))
            throw new AppError(403, 'ACCESS_DENIED');
        const strong = { ...current, _id: digest(token), managementId: randomUUID(), kind: identity.realm === 'TENANT' ? 'W' : 'S', ...(identity.realm === 'TENANT' ? { policyVersion: WORK_POLICY } : {}), csrfHash: digest(csrf),
            createdAt: current.kind === 'S' ? current.createdAt : now, lastSeenAt: now,
            expiresAt: current.kind === 'S' ? current.expiresAt : now + (identity.realm === 'TENANT' ? 43200000 : 28800000),
            revoked: false, factorId, organizationEpoch: org?.authEpoch ?? null, authEpoch: identity.authEpoch,
            credentialVersion: identity.credentialVersion, authzVersion: identity.authzVersion, preview: null };
        if (current.kind === 'S') {
            if (!current.reauth || current.reauth.expiresAt <= now || current.reauth.consumed)
                throw new AppError(403, 'REAUTH_REQUIRED');
            strong.reauth = { ...current.reauth, factorId };
        }
        else
            strong.reauth = null;
        delete strong.firstEnrollment;
        this.completionValidator?.(strong, identity);
        await this.contexts.insertOne(strong, { session });
        const live = await this.contexts.find({ subjectId: identity._id, realm: identity.realm, kind: { $in: ['W', 'S'] }, revoked: false,
            expiresAt: { $gt: now }, lastSeenAt: { $gt: now - (identity.realm === 'TENANT' ? IDLE_MS : 900000) } }, { session }).sort({ createdAt: 1, _id: 1 }).toArray();
        const max = identity.realm === 'TENANT' ? 5 : 2;
        for (const old of live.slice(0, Math.max(0, live.length - max))) {
            await this.contexts.updateOne({ _id: old._id }, { $set: { revoked: true } }, { session });
            await this.audit.append({ realm: identity.realm, action: 'SESSION_LIMIT_REVOKED', actorId: identity._id, subjectId: identity._id, outcome: 'SUCCESS' }, session);
        }
        await this.audit.append({ realm: identity.realm, action: 'MFA_SESSION_ISSUED', actorId: identity._id, subjectId: identity._id, outcome: 'SUCCESS' }, session);
        return { context: strong, token, csrf };
    }
    async snapshot(purpose, resourceId, identity, session, command, enrollmentIntent) {
        if (purpose === 'MFA_ENROLL') {
            if (!command || !enrollmentIntent || identity.realm === 'PLATFORM' && command['methodType'] !== 'WEBAUTHN')
                throw new AppError(403, 'ACCESS_DENIED');
            return digest(JSON.stringify([purpose, identity._id, command, enrollmentIntent]));
        }
        if (['PASSWORD_CHANGE', 'RECOVERY_CODES_REGENERATE', 'SESSION_REVOKE_ALL'].includes(purpose))
            return digest(`${purpose}:${identity._id}`);
        if (purpose === 'MFA_REMOVE') {
            const factor = await this.factors.findOne({ _id: resourceId ?? '', subjectId: identity._id, realm: identity.realm, state: 'ACTIVE' }, { session });
            if (!factor)
                throw new AppError(404, 'NOT_FOUND');
            return digest(JSON.stringify([purpose, factor._id, factor.version]));
        }
        if (purpose === 'SESSION_REVOKE_OTHER') {
            const target = await this.contexts.findOne({ managementId: resourceId ?? '', subjectId: identity._id, realm: identity.realm, kind: { $in: ['W', 'S'] } }, { session });
            if (!target)
                throw new AppError(404, 'NOT_FOUND');
            return digest(JSON.stringify([purpose, target.managementId]));
        }
        if (this.snapshotResolver)
            return await this.snapshotResolver(purpose, resourceId, identity, session, command);
        throw new AppError(503, 'SERVICE_UNAVAILABLE'); // D01 must resolve payload-bound purposes; never issue generic R.
    }
    async consumeProof(context, purpose, resourceId, session, command) {
        const { context: fresh, identity } = await this.requireOperational(context, session);
        if (fresh.kind === 'W') {
            const kind = purposeClass(purpose);
            if (kind === 'WORK_ONLY')
                return identity;
            if (kind === 'BALANCE_60M') {
                const grant = fresh.balanceGrant;
                if (!grant || grant.expiresAt <= this.now() || grant.organizationId !== identity.organizationId || !await this.factors.findOne({ _id: grant.factorId, subjectId: identity._id, realm: identity.realm, state: 'ACTIVE' }, { session }))
                    throw new AppError(403, 'REAUTH_REQUIRED');
                if ((identity.cooldownUntil ?? 0) > this.now())
                    throw new AppError(403, 'RECOVERY_RESTRICTED');
                return identity;
            }
            if (kind !== 'SECURITY_ONE_SHOT')
                throw new AppError(403, 'ACCESS_DENIED');
        }
        const proof = fresh.reauth;
        if (!proof || proof.consumed || proof.expiresAt <= this.now() || !proof.factorId || !await this.factors.findOne({ _id: proof.factorId, subjectId: identity._id, realm: identity.realm, state: 'ACTIVE' }, { session }) || proof.purpose !== purpose || proof.resourceId !== resourceId ||
            proof.snapshotHash !== await this.snapshot(purpose, resourceId, identity, session, command, proof.enrollmentIntent))
            throw new AppError(403, 'REAUTH_REQUIRED');
        if ((identity.cooldownUntil ?? 0) > this.now() && !['PASSWORD_CHANGE', 'SESSION_REVOKE_ALL', 'SESSION_REVOKE_OTHER'].includes(purpose))
            throw new AppError(403, 'RECOVERY_RESTRICTED');
        const used = await this.contexts.updateOne({ _id: fresh._id, 'reauth.consumed': false }, { $set: { 'reauth.consumed': true } }, { session });
        if (used.modifiedCount !== 1)
            throw new AppError(403, 'REAUTH_REQUIRED');
        return identity;
    }
    checkCsrf(context, csrf) {
        if (!csrf || csrf.length > 256 || !equalSecret(csrf, context.csrfHash))
            throw new AppError(400, 'CSRF_INVALID');
    }
    async operationalCount(subjectIds, session) {
        let count = 0;
        for (const context of await this.contexts.find({ subjectId: { $in: subjectIds }, kind: { $in: ['W', 'S'] }, revoked: false, expiresAt: { $gt: this.now() } }, { session }).toArray()) {
            try {
                await this.requireOperational(context, session);
                count++;
            }
            catch (e) {
                if (!(e instanceof AppError) || ![401, 403].includes(e.status))
                    throw e;
            }
        }
        return count;
    }
    async revokeAll(subjectId, session) {
        await this.contexts.updateMany({ subjectId }, { $set: { revoked: true } }, { session });
    }
    async enforceSourceLimit(key, count, window, record = true) {
        const collection = this.database.db.collection('rate_limits');
        const now = this.now();
        const accepted = await this.database.transaction(async (session) => {
            const doc = await collection.findOne({ _id: key }, { session });
            const attempts = (doc?.attempts ?? []).filter(t => t > now - window);
            if (attempts.length >= count)
                return false;
            if (!record)
                return true;
            await collection.replaceOne({ _id: key }, { attempts: [...attempts, now] }, { upsert: true, session });
            return true;
        });
        if (!accepted)
            throw new AppError(429, 'RATE_LIMITED');
    }
}
//# sourceMappingURL=service.js.map