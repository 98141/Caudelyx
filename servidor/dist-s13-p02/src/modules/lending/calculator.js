import { AppError } from '../../shared/errors.js';
import { Decimal60 as D, amount, cents, periodicRate } from './decimal.js';
import { scheduleDates, dateValue } from './calendar.js';
import { lendingContract } from './contract.js';
export const policy = { policyVersion: 'S04-LOCAL-CO-0.1', mathVersion: 'CALCULATION-S04-0.1', calendarVersion: 'S04-CALENDAR-0.1', jurisdiction: 'CO', usage: 'LOCAL_SYNTHETIC', legalStatus: 'NOT_REVIEWED_FOR_REAL_USE', realUseAllowed: false, methods: ['CONSTANT_PRINCIPAL', 'LEVEL_PAYMENT', 'INTEREST_ONLY'], frequencies: ['DAY', 'WEEK', 'FIFTEEN_DAYS', 'SEMIMONTH', 'MONTH'], minPrincipal: '0.01', maxPrincipal: '1000000000000.00', maxInstallments: 360, minDate: '2000-01-01', maxDate: '2199-12-31', quoteTtlSeconds: 900 };
const max = 999999999999999999n;
export function calculate(t) {
    if (t.usage === 'REAL')
        throw new AppError(403, 'REAL_USE_NOT_ALLOWED');
    if (t.policyVersion !== policy.policyVersion || t.jurisdiction !== 'CO' || t.usage !== 'LOCAL_SYNTHETIC')
        throw new AppError(422, 'POLICY_UNSUPPORTED');
    if (t.calendarConvention !== 'PERIODIC_FIXED' || t.holidayAdjustment !== 'NO_SHIFT')
        throw new AppError(422, 'UNSUPPORTED_CALENDAR');
    if (typeof t.effectiveDate === 'string')
        dateValue(t.effectiveDate);
    if (typeof t.firstDueDate === 'string')
        dateValue(t.firstDueDate);
    lendingContract().validate('Terms', t);
    return amortize(t, scheduleDates(t));
}
// S05 reuses the exact S04 arithmetic; future dates are copied from the committed
// schedule, preserving the original anchor instead of reanchoring a clamped date.
export function recalculateFuture(original, principal, dates) {
    const terms = { ...original, principal, installmentCount: dates.length };
    lendingContract().validate('Terms', terms);
    if (!dates.length || dates.some((d, k) => k > 0 && d <= dates[k - 1]))
        throw new AppError(422, 'INPUT_INVALID');
    for (const d of dates)
        dateValue(d);
    return amortize(terms, dates);
}
function amortize(t, dates) {
    const p = cents(t.principal), n = t.installmentCount, rate = periodicRate(t.rate, t.frequency), i = D.text(rate), one = new D(1n), P = D.text(t.principal);
    const fixed = p / BigInt(n), base = t.method === 'LEVEL_PAYMENT' ? (i.c === 0n ? P.div(new D(BigInt(n))) : P.mul(i).div(one.sub(one.add(i).pow(-n)))).cents() : null;
    if (t.method === 'CONSTANT_PRINCIPAL' && n > 1 && fixed === 0n)
        throw new AppError(422, 'PAYMENT_RESOLUTION_UNSUPPORTED');
    let b = p, totalInterest = 0n, totalPayment = 0n;
    const rows = [];
    for (let k = 1; k <= n; k++) {
        const interest = new D(b, -2).mul(i).cents(), principal = k === n ? b : t.method === 'CONSTANT_PRINCIPAL' ? fixed : t.method === 'LEVEL_PAYMENT' ? base - interest : 0n;
        if (t.method === 'LEVEL_PAYMENT' && k < n && (principal <= 0n || principal >= b))
            throw new AppError(422, 'PAYMENT_RESOLUTION_UNSUPPORTED');
        const payment = principal + interest, next = b - principal;
        if ([b, principal, interest, payment, next].some(v => v < 0n || v > max))
            throw new AppError(422, 'CALCULATION_UNREPRESENTABLE');
        rows.push({ k, date: dates[k - 1], openingPrincipal: amount(b), principal: amount(principal), interest: amount(interest), payment: amount(payment), closingPrincipal: amount(next) });
        b = next;
        totalInterest += interest;
        totalPayment += payment;
    }
    if (b !== 0n || totalPayment !== p + totalInterest || totalInterest > max || totalPayment > max)
        throw new AppError(422, 'CALCULATION_UNREPRESENTABLE');
    return { schedule: rows, totals: { principal: t.principal, interest: amount(totalInterest), payment: amount(totalPayment) }, periodicRate24: rate, basePayment: base === null ? null : amount(base), finalPaymentAdjustment: base === null ? '0.00' : amount(cents(rows.at(-1).payment) - base), policyVersion: policy.policyVersion, mathVersion: policy.mathVersion, calendarVersion: policy.calendarVersion };
}
//# sourceMappingURL=calculator.js.map