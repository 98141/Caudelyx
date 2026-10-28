import { Decimal128 } from 'mongodb';
import { AppError } from '../../shared/errors.js';
export const MAX_CENTS = 999999999999999999n;
export function cents(value) {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})\.[0-9]{2}$/.test(value))
        throw new AppError(422, 'INPUT_INVALID');
    return BigInt(value.replace('.', ''));
}
export function money(value) {
    const absolute = value < 0n ? -value : value;
    if (absolute > MAX_CENTS)
        throw new AppError(422, 'INPUT_INVALID');
    return `${value < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}
export const decimal = (value) => Decimal128.fromString(money(cents(value)));
export const storedCents = (value) => cents(value.toString());
export function balanced(lines) {
    let debit = 0n, credit = 0n;
    for (const line of lines) {
        const d = cents(line.debit), c = cents(line.credit);
        if ((d > 0n) === (c > 0n))
            throw new AppError(422, 'INPUT_INVALID');
        debit += d;
        credit += c;
    }
    money(debit);
    money(credit);
    if (debit !== credit)
        throw new AppError(422, 'UNBALANCED_ENTRY');
}
//# sourceMappingURL=money.js.map