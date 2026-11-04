import { AppError } from '../../shared/errors.js';
import { personalActor, resolveScope, authorityBinding } from '../obligations/authority.js';
import { authorize } from '../reporting/sources.js';
import { booksTable, declarations } from '../obligations/models.js';
import { hash } from './canonical.js';
import { today } from '../finance/service.js';
const assigned = new Set(['PORTFOLIO', 'PORTFOLIO_OVERDUE', 'AGEING', 'PAR30', 'INSTALLMENTS', 'INTEREST', 'PRINCIPAL', 'CONCENTRATION']);
export const businessReportAllowed = (a, kind) => a.isT && kind !== 'PERSONAL_SUMMARY' && kind !== 'CONSOLIDATED_SUMMARY' || a.isC && assigned.has(kind) || kind === 'MOVEMENTS' && (a.isC || a.isO || a.isP) || (kind === 'CASH' || kind === 'COLLECTORS') && (a.isC || a.isO);
export const personalReports = ['CASH', 'OBLIGATIONS', 'EXPENSES', 'SAVINGS', 'ASSETS', 'FUNDING_USES', 'NET_WORTH', 'NET_WORTH_EVOLUTION', 'PERSONAL_SUMMARY'];
export async function exchangeAuthority(identity, context, params, s, options = {}) {
    const current = await personalActor(identity, context, s), org = params['organizationId'];
    let scope, book, business = null, eligibility = null;
    if (org) {
        business = await authorize(identity, context, org, s, performance.now());
        if (options.importing && !business.isT)
            throw new AppError(403, 'ACCESS_DENIED');
        if (options.reportKind && !businessReportAllowed(business, options.reportKind))
            throw new AppError(403, 'ACCESS_DENIED');
        scope = { kind: 'BUSINESS', bookId: org, ownerId: org, organizationId: org };
        book = await identity.database.db.collection(booksTable).findOne({ _id: org, domainKind: 'BUSINESS' }, { session: s });
    }
    else {
        const r = await resolveScope(identity, context, 'PERSONAL', params['bookId'], s);
        scope = r.scope;
        book = r.book;
        if (options.consolidated) {
            if (!current.actor.organizationId || !current.actor.roles.includes('T'))
                throw new AppError(403, 'ACCESS_DENIED');
            business = await authorize(identity, context, current.actor.organizationId, s, performance.now());
            const bscope = { kind: 'BUSINESS', bookId: current.actor.organizationId, ownerId: current.actor.organizationId, organizationId: current.actor.organizationId };
            const rows = await identity.obligations.store.all(declarations, bscope, s);
            const latest = rows.filter(r => r['subjectId'] === current.actor._id && String(r['validFrom']) <= today(identity.now())).sort((a, b) => a.version - b.version).at(-1);
            eligibility = latest?.['right'] === 'FULL_OWNERSHIP' && latest['percentage'] === '100.00' ? latest : null;
            if (!business.isT || !eligibility)
                throw new AppError(403, 'ACCESS_DENIED');
            if (options.reportKind && options.reportKind !== 'CONSOLIDATED_SUMMARY')
                throw new AppError(403, 'ACCESS_DENIED');
        }
        else if (options.reportKind && !personalReports.includes(options.reportKind))
            throw new AppError(403, 'ACCESS_DENIED');
    }
    return { scope, actor: current.actor, context: current.context, business, consolidated: options.consolidated === true, binding: hash({ actor: authorityBinding(current.actor, current.context, book), business: business?.binding ?? null, eligibility, restore: identity.obligations?.store.restoreEpoch }) };
}
//# sourceMappingURL=authority.js.map