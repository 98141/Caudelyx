import { verifyRow } from '../obligations/evidence.js';
import { AppError } from '../../shared/errors.js';
export const isHistorical = (loan) => loan.status === 'HISTORICAL_DECLARED';
export async function historicalLoan(database, id, org, s) {
    const row = await database.db.collection('s11_historical_origins').findOne({ _id: id, bookId: org, ownerId: org, domainKind: 'BUSINESS', organizationId: org }, s ? { session: s } : {});
    if (row && (!verifyRow(database, 's11_historical_origins', row) || row.origin !== 'HISTORICAL_S11' || row.status !== 'HISTORICAL_DECLARED'))
        throw new AppError(503, 'INTEGRITY_MISMATCH');
    return row;
}
export async function operationLoan(identity, id, org, s) {
    const historical = await historicalLoan(identity.database, id, org, s);
    if (historical) {
        if (!identity.obligations?.active)
            throw new AppError(503, 'SERVICE_UNAVAILABLE');
        return historical;
    }
    return await identity.lending.verifiedLoan(id, org, s);
}
export async function operationLoans(identity, org, s, options = {}) {
    const filter = { ...(options.borrowerId ? { borrowerId: options.borrowerId } : {}), ...(options.loanIds ? { _id: { $in: options.loanIds } } : {}) }, native = await identity.lending.loans.find({ organizationId: org, ...filter }, { session: s, maxTimeMS: 10000 }).limit(10001).toArray(), historical = await identity.database.db.collection('s11_historical_origins').find({ bookId: org, ownerId: org, domainKind: 'BUSINESS', ...filter }, { session: s, maxTimeMS: 10000 }).limit(10001).toArray();
    if (native.length + historical.length > 10000)
        throw new AppError(422, 'REPORT_SCOPE_TOO_LARGE');
    if (historical.length && (!identity.obligations?.active || historical.some(r => !verifyRow(identity.database, 's11_historical_origins', r))))
        throw new AppError(503, 'INTEGRITY_MISMATCH');
    return [...native, ...historical].sort((a, b) => (a.createdAt + '|' + a._id).localeCompare(b.createdAt + '|' + b._id));
}
//# sourceMappingURL=historical.js.map