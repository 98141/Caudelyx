import { AppError } from './errors.js';
export class Authorization {
    static manager(actor) {
        if (actor.realm !== 'TENANT' || !actor.organizationId || actor.suspended || !actor.roles.some(role => ['T', 'A'].includes(role)))
            throw new AppError(403, 'ACCESS_DENIED');
    }
    static target(actor, target) {
        this.manager(actor);
        if (actor.organizationId !== target.organizationId || actor.realm !== target.realm)
            throw new AppError(404, 'NOT_FOUND');
        if (actor._id === target._id || target.roles.includes('T') || target.roles.includes('SA') ||
            !actor.roles.includes('T') && target.roles.includes('A'))
            throw new AppError(403, 'ACCESS_DENIED');
    }
    static assign(actor, roles) {
        this.manager(actor);
        if (!roles.length || roles.some(role => !['A', 'O', 'C', 'P', 'L'].includes(role)) || new Set(roles).size !== roles.length ||
            !actor.roles.includes('T') && roles.includes('A'))
            throw new AppError(403, 'ACCESS_DENIED');
    }
    static boundary(actor, resource, trustedPolicy) {
        if (actor.realm !== 'TENANT' || !actor.organizationId || actor.suspended || actor.organizationId !== resource.organizationId ||
            resource.financialScope !== trustedPolicy.scope || !trustedPolicy.legalOwnerIds.includes(resource.legalOwnerId) ||
            trustedPolicy.assignmentRequired && resource.assigneeId !== actor._id)
            throw new AppError(404, 'NOT_FOUND');
        // Boundary is necessary but never grants a permission; the caller must authorize a real operation first.
    }
}
//# sourceMappingURL=authorization.js.map