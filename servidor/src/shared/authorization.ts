import { AppError } from './errors.js';
import type { Identity } from '../modules/identity/models.js';

export class Authorization {
  static manager(actor: Identity): void {
    if (actor.realm !== 'TENANT' || !actor.organizationId || actor.suspended || !actor.roles.some(role => ['T','A'].includes(role))) throw new AppError(403, 'ACCESS_DENIED');
  }
  static target(actor: Identity, target: Identity): void {
    this.manager(actor);
    if (actor.organizationId !== target.organizationId || actor.realm !== target.realm) throw new AppError(404, 'NOT_FOUND');
    if (actor._id === target._id || target.roles.includes('T') || target.roles.includes('SA') ||
      !actor.roles.includes('T') && target.roles.includes('A')) throw new AppError(403, 'ACCESS_DENIED');
  }
  static assign(actor: Identity, roles: string[]): void {
    this.manager(actor);
    if (!roles.length || roles.some(role => !['A','O','C','P','L'].includes(role)) || new Set(roles).size !== roles.length ||
      !actor.roles.includes('T') && roles.includes('A')) throw new AppError(403, 'ACCESS_DENIED');
  }
  static boundary(actor: Identity, resource: { organizationId: string; financialScope: string; legalOwnerId: string; assigneeId?: string },
    trustedPolicy: { scope: 'BUSINESS' | 'PERSONAL'; legalOwnerIds: readonly string[]; assignmentRequired: boolean }): void {
    if (actor.realm !== 'TENANT' || !actor.organizationId || actor.suspended || actor.organizationId !== resource.organizationId ||
      resource.financialScope !== trustedPolicy.scope || !trustedPolicy.legalOwnerIds.includes(resource.legalOwnerId) ||
      trustedPolicy.assignmentRequired && resource.assigneeId !== actor._id) throw new AppError(404, 'NOT_FOUND');
    // Boundary is necessary but never grants a permission; the caller must authorize a real operation first.
  }
}
