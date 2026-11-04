import { AppError } from '../../shared/errors.js';
import { validDate } from '../obligations/calendar.js';
import { cents } from './money.js';
export function checkedSchedule(rows, principal) {
    let previous = '', sum = 0n;
    if (!rows.length || rows.length > 1000)
        throw new AppError(422, 'INPUT_INVALID');
    for (const [i, row] of rows.entries()) {
        if (row.number !== i + 1 || !validDate(row.dueDate) || row.dueDate <= previous || cents(row.total) !== cents(row.principal) + cents(row.interest) + cents(row.insurance) + cents(row.fees))
            throw new AppError(422, 'INPUT_INVALID');
        for (const v of [row.principal, row.interest, row.insurance, row.fees])
            if (cents(v) < 0n)
                throw new AppError(422, 'INPUT_INVALID');
        sum += cents(row.principal);
        previous = row.dueDate;
    }
    if (cents(principal) < 0n || sum !== cents(principal))
        throw new AppError(422, 'INPUT_INVALID');
    return rows;
}
export function resolveTerms(input, book, kind) {
    if (input.kind === 'DECLARED_HYPOTHESIS')
        return { id: 'HYPOTHETICAL', version: 1, bookId: book.bookId, principalOpening: input.principalOpening, installments: checkedSchedule(input.installments, input.principalOpening), prepaymentPermissions: [], supported: true, reason: null, kind };
    const found = book.terms.find(t => t.id === input.sourceId && t.version === input.sourceVersion && t.kind === kind);
    return found?.supported ? found : null;
}
//# sourceMappingURL=terms.js.map