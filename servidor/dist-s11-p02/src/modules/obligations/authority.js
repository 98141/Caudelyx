import { createHash } from 'node:crypto';
import { emailVerified } from '../identity/onboarding.js';
import { AppError } from '../../shared/errors.js';
import { assignments, booksTable } from './models.js';
import { verifyRow } from './evidence.js';
export async function personalActor(identity, context, s) {
    await identity.requireOpen('TENANT');
    if (context.realm !== 'TENANT')
        throw new AppError(403, 'ACCESS_DENIED');
    const current = await identity.sessions.findById(context, s), actor = await identity.identities.findOne({ _id: current.subjectId ?? '', realm: 'TENANT' }, { session: s });
    if (!actor || current.kind !== 'W' || !emailVerified(actor) || actor.roles.includes('SA') || actor.restoreBootstrapBlocked && actor.factorCount === 0 || ['RECOVERY_RESTRICTED', 'FACTOR_LOSS_BLOCKED'].includes(actor.state) || actor.hasEverConfirmedFactor && actor.factorCount === 0)
        throw new AppError(403, 'ACCESS_DENIED');
    return { actor, context: current };
}
export async function resolveScope(identity, context, kind, id, s) {
    const { actor } = await personalActor(identity, context, s);
    if (kind === 'BUSINESS') {
        if (actor.organizationId !== id)
            throw new AppError(404, 'RESOURCE_NOT_FOUND');
        await identity.finance.actor(context, id, s);
        return { actor, scope: { kind, bookId: id, ownerId: id, organizationId: id }, book: await identity.database.db.collection(booksTable).findOne({ _id: id, domainKind: kind }, { session: s }) };
    }
    const book = await identity.database.db.collection(booksTable).findOne({ subjectId: actor._id, domainKind: kind }, { session: s });
    if (!book || id && book._id !== id)
        throw new AppError(404, 'RESOURCE_NOT_FOUND');
    const a = await identity.database.db.collection(assignments).findOne({ _id: book.assignmentId ?? '', bookId: book._id, ownerId: actor._id, active: true }, { session: s });
    if (!a || book.status !== 'ACTIVE')
        throw new AppError(403, 'ACCESS_DENIED');
    if (!verifyRow(identity.database, booksTable, book) || !verifyRow(identity.database, assignments, a))
        throw new AppError(503, 'INTEGRITY_MISMATCH');
    return { actor, scope: { kind, bookId: book._id, ownerId: actor._id }, book };
}
export const authorityBinding = (actor, context, book) => createHash('sha256').update(JSON.stringify({ actor: actor._id, context: context._id, roles: actor.roles, org: actor.organizationId, auth: actor.authEpoch, authz: actor.authzVersion, credential: actor.credentialVersion, assignment: book?.assignmentId, status: book?.status })).digest('hex');
export async function grant(identity, context, kind, s) {
    const { actor, context: fresh } = await personalActor(identity, context, s);
    if (kind === 'BALANCE_60M') {
        const g = fresh.balanceGrant;
        if (!g || g.expiresAt <= identity.now() || g.organizationId !== actor.organizationId || !await identity.sessions.factors.findOne({ _id: g.factorId, subjectId: actor._id, realm: 'TENANT', state: 'ACTIVE' }, { session: s }))
            throw new AppError(403, 'R_REQUIRED');
        if ((actor.cooldownUntil ?? 0) > identity.now())
            throw new AppError(403, 'RECOVERY_RESTRICTED');
    }
    return actor;
}
//# sourceMappingURL=authority.js.map