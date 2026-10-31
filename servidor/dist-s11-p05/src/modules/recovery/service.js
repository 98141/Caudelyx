import { randomBytes, randomUUID } from 'node:crypto';
import { digest } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
export class RecoveryService {
    identity;
    flows;
    codes;
    constructor(identity, lifecycle) {
        this.identity = identity;
        this.flows = identity.database.db.collection('recoveries');
        this.codes = identity.database.db.collection('recovery_codes');
        lifecycle.recoveryGuard = async (context, session) => { await this.guard(context, session); };
        identity.terminateRecovery = async (subject, session) => { await this.terminal(subject, 'RESET', session); };
        identity.suspendRecovery = async (subject, session) => { await this.terminal(subject, 'SUSPENDED', session); };
        identity.sessions.factorCompletionHook = async (subject, session) => { await this.terminal(subject, 'DEFENSIVE_LOGIN', session); };
    }
    async initialize() {
        await this.flows.createIndex({ subjectId: 1 }, { unique: true, partialFilterExpression: { status: 'ACTIVE' } });
    }
    async guard(context, session) {
        await this.identity.requireOpen(context.realm);
        if (context.realm !== 'TENANT' || context.kind !== 'E_RECOVERY')
            throw new AppError(403, 'ACCESS_DENIED');
        const fresh = await this.identity.freshContext(context, session);
        const subject = await this.identity.identities.findOne({ _id: fresh.subjectId ?? '', realm: 'TENANT', suspended: false }, { session });
        const flow = await this.flows.findOne({ _id: fresh.recoveryId ?? '', contextId: fresh._id, subjectId: subject?._id ?? '', status: 'ACTIVE' }, { session });
        if (!subject || !flow || flow.expiresAt <= this.identity.now() || subject.credentialVersion !== flow.credentialVersion ||
            subject.authEpoch !== fresh.authEpoch || subject.authzVersion !== fresh.authzVersion)
            throw new AppError(401, 'AUTH_INVALID');
        return flow;
    }
    async generate(subject, session) {
        const batch = randomUUID(), codes = [];
        await this.codes.updateMany({ subjectId: subject._id }, { $set: { consumed: true } }, { session });
        for (let n = 0; n < 10; n++) {
            const raw = randomBytes(16).toString('hex').toUpperCase();
            codes.push(raw.match(/.{8}/g).join('-'));
            await this.codes.insertOne({ _id: digest(raw), subjectId: subject._id, realm: subject.realm, batch, consumed: false }, { session });
        }
        await this.identity.identities.updateOne({ _id: subject._id }, { $set: { recoveryBatch: batch } }, { session });
        return codes;
    }
    async regenerate(context) {
        await this.identity.requireOpen(context.realm);
        // O-01 retains A29 in PLATFORM; these codes cannot be consumed by any PLATFORM endpoint.
        return await this.identity.database.transaction(async (session) => {
            const subject = await this.identity.sessions.consumeProof(context, 'RECOVERY_CODES_REGENERATE', null, session);
            const codes = await this.generate(subject, session);
            await this.identity.audit.append({ realm: subject.realm, action: 'RECOVERY_CODES_REPLACED', actorId: subject._id, subjectId: subject._id, outcome: 'SUCCESS' }, session);
            await this.identity.messaging.notify(subject.realm, subject._id, 'RECOVERY_CODES_REPLACED', {}, session);
            return { codes };
        });
    }
    async start(context, value, source) {
        await this.identity.requireOpen(context.realm);
        if (context.realm !== 'TENANT')
            throw new AppError(403, 'ACCESS_DENIED');
        const key = digest(`recovery:${context.subjectId}:${source}`), day = digest(`recovery-day:${context.subjectId}:${source}`);
        await this.identity.sessions.enforceSourceLimit(key, 5, 1800000, false);
        await this.identity.sessions.enforceSourceLimit(day, 10, 86400000, false);
        const grouped = value.length === 35 && [8, 17, 26].every(i => value.charAt(i) === '-');
        if (!(value.length === 32 || grouped) || !/^[A-Fa-f0-9]{32}$/.test(value.replaceAll('-', '')))
            throw new AppError(422, 'INPUT_INVALID');
        try {
            return await this.identity.database.transaction(async (session) => {
                const fresh = await this.identity.freshContext(context, session);
                const subject = await this.identity.identities.findOne({ _id: fresh.subjectId ?? '', realm: 'TENANT', suspended: false }, { session });
                if (!subject || !['L', 'W'].includes(fresh.kind) || !fresh.passwordAt || fresh.passwordAt + 300000 <= this.identity.now() ||
                    fresh.credentialVersion !== subject.credentialVersion || fresh.authEpoch !== subject.authEpoch ||
                    !subject.hasEverConfirmedFactor || !['ACTIVE', 'AUTHENTICATED_NO_ORG', 'FACTOR_LOSS_BLOCKED'].includes(subject.state))
                    throw new AppError(401, 'AUTH_INVALID');
                if (await this.flows.findOne({ subjectId: subject._id, status: 'ACTIVE' }, { session }))
                    throw new AppError(401, 'AUTH_INVALID');
                const codeId = digest(value.replaceAll('-', '').toUpperCase());
                const used = await this.codes.updateOne({ _id: codeId, subjectId: subject._id, batch: subject.recoveryBatch ?? '', consumed: false }, { $set: { consumed: true } }, { session });
                if (used.modifiedCount !== 1)
                    throw new AppError(401, 'AUTH_INVALID');
                const active = await this.identity.sessions.factors.find({ subjectId: subject._id, state: 'ACTIVE', realm: subject.realm }, { session }).toArray();
                await this.identity.identities.updateOne({ _id: subject._id }, { $set: { state: 'RECOVERY_RESTRICTED' } }, { session });
                await this.identity.sessions.revokeAll(subject._id, session);
                const issued = await this.identity.sessions.issue('TENANT', 'E_RECOVERY', subject, session);
                const id = randomUUID();
                issued.context.recoveryId = id;
                await this.identity.sessions.contexts.updateOne({ _id: issued.context._id }, { $set: { recoveryId: id } }, { session });
                await this.flows.insertOne({ _id: id, contextId: issued.context._id, subjectId: subject._id, previousState: subject.state,
                    status: 'ACTIVE', expiresAt: issued.context.expiresAt, snapshot: active.map(f => f._id), codeId, credentialVersion: subject.credentialVersion }, { session });
                await this.identity.audit.append({ realm: subject.realm, action: 'RECOVERY_STARTED', actorId: subject._id, subjectId: subject._id, outcome: 'SUCCESS' }, session);
                await this.identity.messaging.notify(subject.realm, subject._id, 'RECOVERY_STARTED', {}, session);
                return { issued, data: { authState: 'RECOVERY_RESTRICTED', expiresAt: new Date(issued.context.expiresAt).toISOString() } };
            });
        }
        catch (error) {
            if (error instanceof AppError && error.status === 401) {
                await this.identity.sessions.enforceSourceLimit(key, 5, 1800000);
                await this.identity.sessions.enforceSourceLimit(day, 10, 86400000);
            }
            throw error;
        }
    }
    async terminal(subject, reason, session, flowId) {
        const flow = await this.flows.findOne({ subjectId: subject._id, status: 'ACTIVE', ...(flowId ? { _id: flowId } : {}) }, { session });
        if (!flow)
            return;
        const won = await this.flows.updateOne({ _id: flow._id, status: 'ACTIVE' }, { $set: { status: reason === 'EXPIRED' ? 'EXPIRED' : 'REVOKED' } }, { session });
        if (!won.modifiedCount)
            return;
        await this.identity.sessions.factors.updateMany({ recoveryId: flow._id, state: 'PENDING_RECOVERY' }, { $set: { state: 'REVOKED' }, $unset: { encryptedSecret: '', publicKey: '' } }, { session });
        await this.identity.sessions.contexts.updateMany({ recoveryId: flow._id }, { $set: { revoked: true } }, { session });
        if (subject.state === 'RECOVERY_RESTRICTED')
            await this.identity.identities.updateOne({ _id: subject._id }, { $set: { state: subject.suspended ? 'SUSPENDED' : flow.previousState } }, { session });
        await this.identity.audit.append({ realm: subject.realm, action: `RECOVERY_${reason}`, actorId: subject._id, subjectId: subject._id, outcome: 'SUCCESS' }, session);
    }
    async expire() {
        for (const flow of await this.flows.find({ status: 'ACTIVE', expiresAt: { $lte: this.identity.now() } }).toArray()) {
            await this.identity.database.transaction(async (session) => {
                const subject = await this.identity.identities.findOne({ _id: flow.subjectId }, { session });
                const fresh = await this.flows.findOne({ _id: flow._id, status: 'ACTIVE', expiresAt: { $lte: this.identity.now() } }, { session });
                if (subject && fresh)
                    await this.terminal(subject, 'EXPIRED', session, fresh._id);
            });
        }
    }
    async complete(context, newMethodId, retireMethodIds) {
        return await this.identity.database.transaction(async (session) => {
            const flow = await this.guard(context, session);
            const subject = await this.identity.identities.findOne({ _id: flow.subjectId }, { session });
            const method = await this.identity.sessions.factors.findOne({ _id: newMethodId, recoveryId: flow._id,
                contextId: context._id, subjectId: flow.subjectId, state: 'PENDING_RECOVERY', confirmed: true }, { session });
            if (!subject || !method)
                throw new AppError(409, 'INVALID_STATE');
            if (retireMethodIds.includes(newMethodId) || retireMethodIds.some(id => !flow.snapshot.includes(id)))
                throw new AppError(422, 'INPUT_INVALID');
            const won = await this.flows.updateOne({ _id: flow._id, status: 'ACTIVE', expiresAt: { $gt: this.identity.now() } }, { $set: { status: 'COMPLETED' } }, { session });
            if (won.modifiedCount !== 1)
                throw new AppError(409, 'INVALID_STATE');
            await this.identity.sessions.factors.updateMany({ _id: { $in: retireMethodIds }, subjectId: subject._id }, { $set: { state: 'REVOKED', version: `"${randomUUID()}"` } }, { session });
            await this.identity.sessions.factors.updateOne({ _id: newMethodId }, { $set: { state: 'ACTIVE', version: `"${randomUUID()}"` } }, { session });
            await this.identity.sessions.factors.updateMany({ recoveryId: flow._id, _id: { $ne: newMethodId } }, { $set: { state: 'REVOKED' }, $unset: { encryptedSecret: '', publicKey: '' } }, { session });
            const factorCount = await this.identity.sessions.factors.countDocuments({ subjectId: subject._id, state: 'ACTIVE' }, { session });
            await this.identity.identities.updateOne({ _id: subject._id }, { $set: { state: subject.organizationId ? 'ACTIVE' : 'AUTHENTICATED_NO_ORG', factorCount,
                    hasEverConfirmedFactor: true, cooldownUntil: this.identity.now() + 86400000, credentialVersion: randomUUID(), authEpoch: randomUUID() } }, { session });
            await this.identity.sessions.revokeAll(subject._id, session);
            const recoveryCodes = await this.generate(subject, session);
            await this.identity.audit.append({ realm: subject.realm, action: 'RECOVERY_COMPLETED', actorId: subject._id, subjectId: subject._id, outcome: 'SUCCESS' }, session);
            await this.identity.messaging.notify(subject.realm, subject._id, 'RECOVERY_COMPLETED', { cooldownUntil: new Date(this.identity.now() + 86400000).toISOString() }, session);
            return { nextAction: 'LOGIN', recoveryCodes };
        });
    }
    async methods(context) {
        return await this.identity.database.transaction(async (session) => {
            const fresh = await this.identity.freshContext(context, session);
            if (fresh.kind === 'S' || fresh.kind === 'W')
                await this.identity.sessions.requireOperational(fresh, session);
            else if (fresh.kind === 'E_RECOVERY')
                await this.guard(fresh, session);
            else if (fresh.kind !== 'E_INITIAL')
                throw new AppError(403, 'MFA_REQUIRED');
            const methods = await this.identity.sessions.factors.find({ subjectId: fresh.subjectId ?? '', realm: context.realm, state: 'ACTIVE' }, { session }).toArray();
            return { items: methods.map(f => ({ id: f._id, type: f.type, label: f.label, createdAt: new Date(f.createdAt).toISOString(),
                    lastUsedAt: f.lastUsedAt === null ? null : new Date(f.lastUsedAt).toISOString(), version: f.version })), nextCursor: null };
        });
    }
    async remove(context, id, ifMatch) {
        await this.identity.database.transaction(async (session) => {
            const { identity } = await this.identity.sessions.requireOperational(context, session);
            const factor = await this.identity.sessions.factors.findOne({ _id: id, subjectId: identity._id, realm: context.realm, state: 'ACTIVE' }, { session });
            if (!factor)
                throw new AppError(404, 'NOT_FOUND');
            if (!ifMatch)
                throw new AppError(428, 'PRECONDITION_REQUIRED');
            if (factor.version !== ifMatch)
                throw new AppError(412, 'PRECONDITION_FAILED');
            await this.identity.sessions.consumeProof(context, 'MFA_REMOVE', id, session);
            const fresh = await this.identity.sessions.contexts.findOne({ _id: context._id }, { session });
            const count = await this.identity.sessions.factors.countDocuments({ subjectId: identity._id, realm: context.realm, state: 'ACTIVE' }, { session });
            const passkeys = await this.identity.sessions.factors.countDocuments({ subjectId: identity._id, state: 'ACTIVE', type: 'WEBAUTHN' }, { session });
            if (count <= 1 || fresh?.reauth?.factorId === id || identity.realm === 'PLATFORM' && factor.type === 'WEBAUTHN' && passkeys <= 2)
                throw new AppError(409, 'INVALID_STATE');
            await this.identity.sessions.factors.updateOne({ _id: id }, { $set: { state: 'REVOKED', version: `"${randomUUID()}"` } }, { session });
            await this.identity.identities.updateOne({ _id: identity._id }, { $inc: { factorCount: -1 } }, { session });
            await this.identity.sessions.contexts.updateMany({ subjectId: identity._id, _id: { $ne: context._id } }, { $set: { revoked: true } }, { session });
            await this.identity.audit.append({ realm: identity.realm, action: 'MFA_FACTOR_REMOVED', actorId: identity._id, subjectId: identity._id, outcome: 'SUCCESS' }, session);
            await this.identity.messaging.notify(identity.realm, identity._id, 'MFA_FACTOR_REMOVED', {}, session);
        });
    }
}
//# sourceMappingURL=service.js.map