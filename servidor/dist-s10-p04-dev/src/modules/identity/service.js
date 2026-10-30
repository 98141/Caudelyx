import { workData, IDLE_MS } from '../sessions/work-policy.js';
import { randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { AuditWriter } from '../../shared/audit.js';
import { AppError } from '../../shared/errors.js';
import { digest } from '../../shared/crypto.js';
import { resetWarning } from '../messaging/service.js';
import { validateCommand, normalizeCommand, authorizePurpose } from '../../shared/commands.js';
import { isFinancial } from '../finance/contract.js';
import { Onboarding, emailVerified, pendingExpired } from './onboarding.js';
import { isOpening } from '../opening/contract.js';
import { isLending } from '../lending/contract.js';
import { isOperation } from '../lending/operations-contract.js';
export function canonicalEmail(value) {
    if (value.length > 254 || /[\s\u0000-\u001f\u007f]/u.test(value))
        throw new AppError(422, 'INPUT_INVALID');
    const parts = value.split('@');
    const local = parts[0], domain = parts[1];
    if (parts.length !== 2 || !local || !domain || local.length > 64 ||
        !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
        throw new AppError(422, 'INPUT_INVALID');
    }
    const ascii = domainToASCII(domain).toLowerCase();
    if (!ascii || !ascii.includes('.') || ascii.split('.').some(label => !label || !/^[a-z0-9-]+$/.test(label) ||
        label.startsWith('-') || label.endsWith('-') || label.length > 63))
        throw new AppError(422, 'INPUT_INVALID');
    const canonical = `${local.toLowerCase()}@${ascii}`;
    if (canonical.length > 254)
        throw new AppError(422, 'INPUT_INVALID');
    return canonical;
}
export class IdentityService {
    database;
    sessions;
    messaging;
    passwords;
    realmOpen;
    now;
    obligations;
    wealth;
    payments;
    collections;
    reporting;
    work;
    finance;
    opening;
    lending;
    operations;
    identities;
    audit;
    registrations;
    onboarding;
    terminateRecovery;
    suspendRecovery;
    extension;
    beforeRequest;
    constructor(database, sessions, messaging, passwords, realmOpen, now = Date.now) {
        this.database = database;
        this.sessions = sessions;
        this.messaging = messaging;
        this.passwords = passwords;
        this.realmOpen = realmOpen;
        this.now = now;
        this.identities = sessions.identities;
        this.audit = new AuditWriter(database);
        this.registrations = database.db.collection('registration_intents');
        this.onboarding = new Onboarding(this);
    }
    async initialize() {
        await this.identities.createIndex({ realm: 1, email: 1 }, { unique: true });
        await this.registrations.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
        await this.registrations.createIndex({ email: 1 });
        await this.sessions.initialize();
        await this.passwords.initialize();
    }
    async isRealmOpen(realm) {
        return this.database.securityCheck ? await this.database.securityCheck(() => this.realmOpen(realm)) : this.realmOpen(realm);
    }
    async requireOpen(realm) { if (!await this.isRealmOpen(realm))
        throw new AppError(503, 'SERVICE_UNAVAILABLE'); }
    async eligible(identity) {
        return identity.realm === 'TENANT' && ['MFA_ENROLLMENT', 'AUTHENTICATED_NO_ORG', 'ACTIVE'].includes(identity.state) && emailVerified(identity) && !identity.hasEverConfirmedFactor && identity.factorCount === 0 && !identity.suspended && !identity.restoreBootstrapBlocked &&
            !await this.sessions.factors.findOne({ subjectId: identity._id, confirmed: true }) && await this.isRealmOpen(identity.realm);
    }
    async freshContext(context, session) {
        const current = await this.sessions.contexts.findOne({ _id: context._id, revoked: false, realm: context.realm }, { session });
        if (!current || current.expiresAt <= this.now() || ['B', 'W'].includes(current.kind) && current.lastSeenAt + IDLE_MS <= this.now())
            throw new AppError(401, 'AUTH_INVALID');
        if (current.subjectId) {
            const subject = await this.identities.findOne({ _id: current.subjectId, realm: current.realm }, { session });
            if (!subject || subject.suspended || pendingExpired(subject, this.now()) || subject.credentialVersion !== current.credentialVersion ||
                subject.authEpoch !== current.authEpoch || subject.authzVersion !== current.authzVersion || current.kind === 'E_INITIAL' && subject.initialProofEpoch !== current.initialProofEpoch)
                throw new AppError(401, 'AUTH_INVALID');
        }
        return current;
    }
    async sourceQuota(realm, source) {
        await this.sessions.enforceSourceLimit(digest(`email-source:${realm}:${source}`), 10, 3600000);
    }
    async register(realm, source, input, context) {
        return await this.onboarding.register(realm, source, { ...input, email: canonicalEmail(input.email) }, context);
    }
    async requestEmail(realm, source, purpose, email, context) {
        if (purpose === 'RESET' && !await this.isRealmOpen(realm))
            return { code: 'GENERIC_ACCOUNT_ACTION' };
        await this.requireOpen(realm);
        if (realm !== 'TENANT')
            throw new AppError(403, 'ACCESS_DENIED');
        await this.sourceQuota(realm, source);
        const canonical = email === null ? null : canonicalEmail(email);
        await this.database.transaction(async (session) => {
            const current = await this.freshContext(context, session);
            const identity = purpose === 'INITIAL_MFA_PROOF' ? await this.identities.findOne({ _id: current.subjectId ?? '', realm }, { session }) :
                await this.identities.findOne({ realm, email: canonical ?? '' }, { session });
            if (purpose === 'INITIAL_MFA_PROOF' && (!identity || current.kind !== 'L' || !current.passwordAt || current.passwordAt + 300000 <= this.now())) {
                throw new AppError(401, 'AUTH_INVALID');
            }
            if (purpose === 'INITIAL_MFA_PROOF' && identity && !await this.eligible(identity))
                throw new AppError(403, 'INITIAL_MFA_PROOF_DENIED');
            if (current.kind === 'B' && (purpose !== 'ACTIVATION' || !identity || identity._id !== current.subjectId))
                throw new AppError(403, 'ACCESS_DENIED');
            if (!identity || identity.suspended || pendingExpired(identity, this.now()) || identity.restoreBootstrapBlocked || (purpose === 'ACTIVATION' && identity.state !== 'PENDING_EMAIL') ||
                (purpose === 'RESET' && identity.state === 'RECOVERY_RESTRICTED'))
                return;
            const pendingBefore = await this.messaging.quotas.findOne({ _id: digest(`${realm}:${identity.email}:${purpose}`) }, { session });
            if (purpose === 'RESET' && !pendingBefore?.pending) {
                // Invalidate INITIAL once per admitted request, not each coalesced retry.
                const epoch = randomUUID();
                identity.initialProofEpoch = epoch;
                await this.identities.updateOne({ _id: identity._id }, { $set: { initialProofEpoch: epoch } }, { session });
                await this.sessions.contexts.updateMany({ subjectId: identity._id, kind: 'E_INITIAL' }, { $set: { revoked: true } }, { session });
            }
            await this.messaging.enqueue(identity, purpose, source, purpose === 'INITIAL_MFA_PROOF' ? current._id : null, session);
        });
        return { code: 'GENERIC_ACCOUNT_ACTION' };
    }
    async validProof(token, purpose, realm, session) {
        const proof = await this.messaging.proofs.findOne({ _id: digest(token), purpose, realm, consumed: false }, { session });
        if (!proof || proof.expiresAt <= this.now())
            throw new AppError(401, 'TOKEN_INVALID');
        const identity = await this.identities.findOne({ _id: proof.subjectId, realm }, { session });
        if (!identity || identity.suspended || pendingExpired(identity, this.now()) || identity.credentialVersion !== proof.credentialVersion)
            throw new AppError(401, 'TOKEN_INVALID');
        return { proof, identity };
    }
    async confirmEmail(context, input) {
        await this.requireOpen(context.realm);
        if (context.realm !== 'TENANT')
            throw new AppError(403, 'ACCESS_DENIED');
        if (input.purpose === 'ACTIVATION' && input.newPassword === undefined)
            return await this.onboarding.confirm(context, input.token);
        let passwordHash = null;
        const link = input.purpose === 'ACTIVATION' && input.mode === 'LINK';
        if (input.purpose === 'ACTIVATION' && !link) {
            if (!input.newPassword)
                throw new AppError(422, 'INPUT_INVALID');
            this.passwords.validate(input.newPassword);
            passwordHash = await this.passwords.hash(input.newPassword);
        }
        return await this.database.transaction(async (session) => {
            const current = await this.freshContext(context, session);
            const { proof, identity } = await this.validProof(input.token, input.purpose, context.realm, session);
            let passwordAt = null;
            if (input.purpose === 'ACTIVATION') {
                if (current.kind !== 'P')
                    throw new AppError(401, 'AUTH_INVALID');
                if (identity.registrationSource !== 'INVITATION' || identity.passwordHash !== null)
                    throw new AppError(422, 'INPUT_INVALID');
                if (identity.state !== 'PENDING_EMAIL' || identity.restoreBootstrapBlocked ||
                    identity.hasEverConfirmedFactor || identity.hasEverActive || identity.factorCount || identity.organizationId || identity.resetCompletedAt !== null)
                    throw new AppError(403, 'INITIAL_MFA_PROOF_DENIED');
                if (link && input.newPassword !== undefined)
                    throw new AppError(422, 'INPUT_INVALID');
                if (link) {
                    const intent = await this.registrations.findOne({ _id: current._id, realm: 'TENANT', consumed: false, expiresAt: { $gt: new Date(this.now()) } }, { session });
                    if (!intent || intent.email !== identity.email || intent.passwordAt + 300000 <= this.now())
                        throw new AppError(401, 'TOKEN_INVALID');
                    passwordHash = intent.passwordHash;
                    passwordAt = intent.passwordAt;
                    identity.displayName = intent.displayName;
                    await this.registrations.updateOne({ _id: intent._id, consumed: false }, { $set: { consumed: true } }, { session });
                    await this.database.db.collection('consents').updateOne({ subjectId: identity._id }, { $set: { privacyPolicyVersion: intent.privacyPolicyVersion, acceptedAt: intent.passwordAt } }, { session, upsert: true });
                }
                identity.passwordHash = passwordHash;
                // Verification admits a credential into a new security state even when
                // its hash was collected at signup. Preserve legacy proof invalidation
                // and the restore T0/T1 revision fence without changing that password.
                identity.credentialVersion = randomUUID();
                identity.state = 'MFA_ENROLLMENT';
                identity.emailVerified = true;
                if (!await this.eligible(identity))
                    throw new AppError(403, 'INITIAL_MFA_PROOF_DENIED');
                await this.identities.replaceOne({ _id: identity._id }, identity, { session });
            }
            else {
                if (current.kind !== 'L' || current._id !== proof.contextId || current.subjectId !== identity._id)
                    throw new AppError(401, 'TOKEN_INVALID');
                if (!await this.eligible(identity) || identity.initialProofEpoch !== proof.initialProofEpoch)
                    throw new AppError(403, 'INITIAL_MFA_PROOF_DENIED');
            }
            await this.messaging.proofs.updateOne({ _id: proof._id, consumed: false }, { $set: { consumed: true } }, { session });
            if (link)
                await this.sessions.contexts.updateMany({ subjectId: identity._id, realm: identity.realm }, { $set: { revoked: true } }, { session });
            await this.sessions.contexts.updateOne({ _id: current._id }, { $set: { revoked: true } }, { session });
            await this.audit.append({ realm: context.realm, action: 'EMAIL_VERIFIED', subjectId: identity._id, actorId: identity._id, outcome: 'SUCCESS' }, session);
            const issued = await this.sessions.issue(context.realm, 'E_INITIAL', identity, session);
            if (input.purpose === 'INITIAL_MFA_PROOF' || link) {
                // Email delivery cannot refresh the password's original five-minute validity.
                issued.context.passwordAt = link ? passwordAt : current.passwordAt;
                issued.context.expiresAt = Math.min(issued.context.expiresAt, current.expiresAt, (issued.context.passwordAt ?? 0) + 300000);
                await this.sessions.contexts.replaceOne({ _id: issued.context._id }, issued.context, { session });
            }
            return { issued, data: { authState: 'MFA_ENROLLMENT', nextAction: 'ENROLL_FIRST_FACTOR' } };
        });
    }
    async login(realm, source, emailValue, password) {
        await this.requireOpen(realm);
        const email = canonicalEmail(emailValue);
        await this.sessions.enforceSourceLimit(digest(`login-source:${source}`), 30, 900000);
        const key = digest(`login:${realm}:${email}:${source}`);
        const failures = this.database.db.collection('login_failures');
        const previous = await failures.findOne({ _id: key });
        if (previous && previous.backoffUntil > this.now())
            throw new AppError(429, 'RATE_LIMITED');
        const identity = await this.identities.findOne({ realm, email });
        const verified = await this.passwords.verify(identity?.passwordHash ?? null, password);
        if (!verified || !identity || identity.suspended || pendingExpired(identity, this.now())) {
            await this.database.transaction(async (session) => {
                const prior = await failures.findOne({ _id: key }, { session });
                const attempts = [...(prior?.attempts ?? []).filter(t => t > this.now() - 900000), this.now()];
                const delay = attempts.length < 5 ? 0 : Math.min(30000, 1000 * 2 ** Math.min(attempts.length - 5, 5));
                await failures.replaceOne({ _id: key }, { attempts, backoffUntil: this.now() + delay }, { session, upsert: true });
            });
            throw new AppError(401, 'AUTH_INVALID');
        }
        return await this.database.transaction(async (session) => {
            const fresh = await this.identities.findOne({ _id: identity._id, credentialVersion: identity.credentialVersion, suspended: false }, { session });
            if (!fresh || pendingExpired(fresh, this.now()))
                throw new AppError(401, 'AUTH_INVALID');
            await failures.deleteOne({ _id: key }, { session });
            const authState = fresh.state === 'RECOVERY_RESTRICTED' ? 'RECOVERY_RESTRICTED' :
                fresh.factorCount > 0 ? 'MFA_REQUIRED' : await this.eligible(fresh) ? 'MFA_ENROLLMENT' : 'FACTOR_LOSS_BLOCKED';
            await this.audit.append({ realm, action: 'PASSWORD_VERIFIED', actorId: fresh._id, subjectId: fresh._id, outcome: 'SUCCESS' }, session);
            if (realm === 'TENANT' && emailVerified(fresh) && fresh.state !== 'RECOVERY_RESTRICTED' && (fresh.factorCount > 0 || await this.eligible(fresh))) {
                const issued = await this.sessions.issue(realm, 'W', fresh, session);
                return { issued, data: workData(fresh, issued.context, this.ownProfile(fresh), this.now()) };
            }
            const basic = realm === 'TENANT' && !fresh.hasEverConfirmedFactor && !fresh.hasEverActive && fresh.factorCount === 0 && !fresh.organizationId && ['PENDING_EMAIL', 'MFA_ENROLLMENT'].includes(fresh.state) && !fresh.restoreBootstrapBlocked;
            return basic ? { issued: await this.sessions.issue(realm, 'B', fresh, session), data: { sessionContext: 'B', authState: emailVerified(fresh) ? 'MFA_ENROLLMENT' : 'PENDING_EMAIL', nextAction: emailVerified(fresh) ? 'ENROLL_FIRST_FACTOR' : 'VERIFY_EMAIL' } } : { issued: await this.sessions.issue(realm, 'L', fresh, session), data: { authState } };
        });
    }
    async reset(context, input, source) {
        await this.requireOpen(context.realm);
        if (context.realm !== 'TENANT')
            throw new AppError(403, 'ACCESS_DENIED');
        await this.sessions.enforceSourceLimit(digest(`reset-source:${context.realm}:${source}`), 30, 900000);
        // Verification limits are separate from mail quotas. Invalid requests persist attempts outside reset transaction.
        const failureKey = digest(`reset-token:${context.realm}:${digest(input.token)}:${source}`);
        await this.sessions.enforceSourceLimit(failureKey, 5, 900000, false);
        let newHash = null;
        if (input.mode === 'CONFIRM') {
            if (!input.newPassword || typeof input.warningAcknowledged !== 'boolean')
                throw new AppError(422, 'INPUT_INVALID');
            this.passwords.validate(input.newPassword);
            newHash = await this.passwords.hash(input.newPassword);
        }
        try {
            return await this.database.transaction(async (session) => {
                const current = await this.freshContext(context, session);
                const { proof, identity } = await this.validProof(input.token, 'RESET', context.realm, session);
                const warning = identity.state === 'MFA_ENROLLMENT' && !await this.eligible(identity);
                if (input.mode === 'PREVIEW') {
                    await this.sessions.contexts.updateOne({ _id: current._id }, { $set: { preview: { proofHash: proof._id,
                                credentialVersion: identity.credentialVersion, initialProofEpoch: identity.initialProofEpoch, state: identity.state, warning } } }, { session });
                    return { warningRequired: warning, warningMessage: warning ? resetWarning : null };
                }
                const preview = current.preview;
                if (!preview || preview.proofHash !== proof._id || preview.credentialVersion !== identity.credentialVersion ||
                    preview.initialProofEpoch !== identity.initialProofEpoch || preview.state !== identity.state ||
                    preview.warning !== warning || input.warningAcknowledged !== warning)
                    throw new AppError(409, 'INVALID_STATE');
                if (identity.state === 'RECOVERY_RESTRICTED') {
                    if (!this.terminateRecovery)
                        throw new AppError(503, 'SERVICE_UNAVAILABLE');
                    await this.terminateRecovery(identity, session);
                    const restored = await this.identities.findOne({ _id: identity._id }, { session });
                    if (!restored)
                        throw new AppError(401, 'TOKEN_INVALID');
                    identity.state = restored.state;
                }
                if (identity.state === 'PENDING_EMAIL') {
                    identity.emailVerified = true;
                    identity.state = 'MFA_ENROLLMENT';
                }
                identity.passwordHash = newHash;
                identity.credentialVersion = randomUUID();
                identity.authEpoch = randomUUID();
                identity.initialProofEpoch = randomUUID();
                identity.resetCompletedAt = this.now();
                await this.identities.replaceOne({ _id: identity._id }, identity, { session });
                await this.messaging.proofs.updateMany({ subjectId: identity._id }, { $set: { consumed: true } }, { session });
                await this.sessions.revokeAll(identity._id, session);
                await this.sessions.factors.deleteMany({ subjectId: identity._id, state: { $in: ['PENDING_INITIAL', 'PENDING_ADDITION'] } }, { session });
                await this.registrations.deleteMany({ realm: 'TENANT', email: identity.email }, { session });
                await this.audit.append({ realm: context.realm, action: 'PASSWORD_RESET', actorId: identity._id, subjectId: identity._id, outcome: 'SUCCESS' }, session);
                await this.messaging.notify(context.realm, identity._id, 'PASSWORD_RESET', {}, session);
                return { nextAction: 'LOGIN' };
            });
        }
        catch (error) {
            if (error instanceof AppError && [401, 409, 422].includes(error.status)) {
                await this.sessions.enforceSourceLimit(failureKey, 5, 900000);
            }
            throw error;
        }
    }
    async reauthenticate(context, input) {
        await this.requireOpen(context.realm);
        if (context.realm === 'TENANT')
            throw new AppError(403, 'ACCESS_DENIED');
        validateCommand('A32', input);
        authorizePurpose(context.realm, input.purpose, input.command);
        if ((isFinancial(input.purpose) || isOpening(input.purpose) || isLending(input.purpose) || isOperation(input.purpose)) && input.resourceId)
            input = { ...input, resourceId: input.resourceId.toLowerCase() };
        const command = normalizeCommand(input.purpose, input.command, canonicalEmail);
        if (command) {
            const operation = { ORGANIZATION_CREATE: 'A08', ORGANIZATION_EDIT: 'A10', MEMBER_INVITE: 'A12', MEMBER_ROLE_CHANGE: 'A16' }[input.purpose];
            if (operation)
                validateCommand(operation, command);
            else if (input.purpose === 'MFA_ENROLL')
                validateCommand('A22', { label: command['label'] });
        }
        const identity = await this.identities.findOne({ _id: context.subjectId ?? '', realm: context.realm });
        await this.sessions.enforceSourceLimit(digest(`reauth:${context._id}`), 5, 900000, false);
        if (!await this.passwords.verify(identity?.passwordHash ?? null, input.password)) {
            await this.sessions.enforceSourceLimit(digest(`reauth:${context._id}`), 5, 900000);
            throw new AppError(401, 'AUTH_INVALID');
        }
        return await this.database.transaction(async (session) => {
            const { context: fresh, identity: current } = await this.sessions.requireOperational(context, session);
            if (!identity || current.credentialVersion !== identity.credentialVersion)
                throw new AppError(401, 'AUTH_INVALID');
            const enrollmentIntent = input.purpose === 'MFA_ENROLL' ? randomUUID() : null;
            const snapshotHash = await this.sessions.snapshot(input.purpose, input.resourceId ?? null, current, session, command, enrollmentIntent);
            await this.sessions.contexts.updateOne({ _id: fresh._id }, { $set: { passwordAt: this.now(), reauth: {
                        purpose: input.purpose, resourceId: input.resourceId ?? null, snapshotHash, passwordAt: this.now(),
                        expiresAt: this.now() + 300000, factorId: null, consumed: false, command,
                        enrollmentIntent
                    } } }, { session });
            await this.audit.append({ realm: current.realm, action: 'REAUTH_PASSWORD_VERIFIED', actorId: current._id, subjectId: current._id, outcome: 'SUCCESS' }, session);
            return { nextAction: 'MFA_CHALLENGE' };
        });
    }
    async changePassword(context, input) {
        await this.requireOpen(context.realm);
        const before = await this.identities.findOne({ _id: context.subjectId ?? '', realm: context.realm });
        if (context.realm === 'PLATFORM' && !await this.passwords.verify(before?.passwordHash ?? null, input.currentPassword ?? ''))
            throw new AppError(401, 'AUTH_INVALID');
        this.passwords.validate(input.newPassword);
        const passwordHash = await this.passwords.hash(input.newPassword);
        await this.database.transaction(async (session) => {
            const identity = await this.sessions.consumeProof(context, 'PASSWORD_CHANGE', null, session);
            if (!before || before.credentialVersion !== identity.credentialVersion)
                throw new AppError(403, 'REAUTH_REQUIRED');
            await this.identities.updateOne({ _id: identity._id }, { $set: { passwordHash, credentialVersion: randomUUID(), authEpoch: randomUUID() } }, { session });
            await this.sessions.revokeAll(identity._id, session);
            await this.audit.append({ realm: identity.realm, action: 'PASSWORD_CHANGED', actorId: identity._id, subjectId: identity._id, outcome: 'SUCCESS' }, session);
            await this.messaging.notify(identity.realm, identity._id, 'PASSWORD_CHANGED', {}, session);
        });
    }
    async listSessions(context) {
        await this.requireOpen(context.realm);
        return await this.database.transaction(async (session) => {
            const { identity } = await this.sessions.requireOperational(context, session);
            const now = this.now();
            const rows = await this.sessions.contexts.find({ subjectId: identity._id, realm: identity.realm, kind: { $in: ['W', 'S'] }, revoked: false,
                expiresAt: { $gt: now }, lastSeenAt: { $gt: now - (identity.realm === 'TENANT' ? IDLE_MS : 900000) } }, { session }).sort({ createdAt: 1 }).toArray();
            return { items: rows.map(row => ({ id: row.managementId, createdAt: new Date(row.createdAt).toISOString(),
                    lastSeenAt: new Date(row.lastSeenAt).toISOString(), expiresAt: new Date(row.expiresAt).toISOString(),
                    deviceLabel: 'Sesión web', current: row._id === context._id })), nextCursor: null };
        });
    }
    async revokeSessions(context, managementId) {
        await this.requireOpen(context.realm);
        await this.database.transaction(async (session) => {
            const { identity } = await this.sessions.requireOperational(context, session);
            const target = managementId ? await this.sessions.contexts.findOne({ managementId, subjectId: identity._id, realm: identity.realm, kind: { $in: ['W', 'S'] } }, { session }) : null;
            if (managementId && !target)
                throw new AppError(404, 'NOT_FOUND');
            if (!target || target._id !== context._id)
                await this.sessions.consumeProof(context, managementId ? 'SESSION_REVOKE_OTHER' : 'SESSION_REVOKE_ALL', managementId ?? null, session);
            if (target)
                await this.sessions.contexts.updateOne({ _id: target._id }, { $set: { revoked: true } }, { session });
            else {
                await this.identities.updateOne({ _id: identity._id }, { $set: { authEpoch: randomUUID() } }, { session });
                await this.sessions.revokeAll(identity._id, session);
            }
            await this.audit.append({ realm: identity.realm, action: 'SESSIONS_REVOKED', actorId: identity._id, subjectId: identity._id, outcome: 'SUCCESS' }, session);
        });
    }
    async dispatchMail() {
        await this.onboarding.expire();
        for (const quota of await this.messaging.quotas.find({ 'pending.dueAt': { $lte: this.now() } }).toArray()) {
            await this.database.transaction(async (session) => {
                const current = await this.messaging.quotas.findOne({ _id: quota._id }, { session });
                if (!current?.pending || current.pending.dueAt > this.now())
                    return;
                const queueDelay = this.now() - current.pending.dueAt;
                if (queueDelay > 0) {
                    this.messaging.telemetry.queueOverdue++;
                    this.messaging.telemetry.maxQueueDelayMs = Math.max(this.messaging.telemetry.maxQueueDelayMs, queueDelay);
                }
                const identity = await this.identities.findOne({ _id: current.subjectId, realm: current.realm }, { session });
                if (!identity || !await this.isRealmOpen(current.realm) || identity.suspended ||
                    current.purpose === 'RESET' && identity.state === 'RECOVERY_RESTRICTED' ||
                    current.purpose === 'ACTIVATION' && identity.state !== 'PENDING_EMAIL') {
                    // Closed realm retains its pending turn; other obsolete work is discarded, never replayed.
                    if (await this.isRealmOpen(current.realm))
                        await this.messaging.quotas.updateOne({ _id: current._id }, { $set: { pending: null } }, { session });
                    return;
                }
                if (current.purpose === 'INITIAL_MFA_PROOF') {
                    const bound = await this.sessions.contexts.findOne({ _id: current.pending.contextId ?? '', kind: 'L', revoked: false }, { session });
                    if (!await this.eligible(identity) || !bound || bound.expiresAt <= this.now() || bound.credentialVersion !== identity.credentialVersion ||
                        !bound.passwordAt || bound.passwordAt + 300000 <= this.now()) {
                        await this.messaging.quotas.updateOne({ _id: current._id }, { $set: { pending: null } }, { session });
                        return;
                    }
                }
                await this.messaging.enqueue(identity, current.purpose, current.pending.source, current.pending.contextId, session, true);
            });
        }
        await this.messaging.deliver(async (message) => {
            if (!await this.isRealmOpen(message.realm))
                return false;
            const identity = await this.identities.findOne({ _id: message.subjectId, realm: message.realm });
            const proof = await this.messaging.proofs.findOne({ _id: message.proofHash, consumed: false });
            if (!identity || !proof || identity.suspended || identity.credentialVersion !== proof.credentialVersion ||
                pendingExpired(identity, this.now()) || message.purpose === 'RESET' && identity.state === 'RECOVERY_RESTRICTED')
                return false;
            if (message.purpose === 'INITIAL_MFA_PROOF') {
                const context = await this.sessions.contexts.findOne({ _id: proof.contextId ?? '', revoked: false });
                return await this.eligible(identity) && identity.initialProofEpoch === proof.initialProofEpoch && !!context && context.expiresAt > this.now();
            }
            return true;
        });
        await this.messaging.deliverNotifications();
    }
    ownProfile(identity) {
        return { displayName: identity.displayName, email: identity.email, emailVerified: emailVerified(identity), createdAt: new Date(identity.createdAt).toISOString(), hasFactor: identity.factorCount > 0, version: identity.profileVersion ?? identity.version };
    }
    async registrationProfile(context) {
        if (context.kind !== 'P' || context.realm !== 'TENANT')
            return null;
        const current = await this.sessions.contexts.findOne({ _id: context._id, realm: 'TENANT', kind: 'P', revoked: false, expiresAt: { $gt: this.now() } });
        if (!current)
            return null;
        const intent = await this.registrations.findOne({ _id: context._id, realm: 'TENANT', consumed: false, expiresAt: { $gt: new Date(this.now()) } });
        if (!intent)
            return null;
        return { authState: 'EMAIL_REQUIRED', profile: { displayName: intent.displayName, email: intent.email, emailVerified: false } };
    }
}
//# sourceMappingURL=service.js.map