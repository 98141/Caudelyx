import { AppError } from '../../shared/errors.js';
const iso = (d) => d.toISOString().slice(0, 10);
export function dateValue(s) {
    const d = new Date(s + 'T00:00:00.000Z');
    if (!/^2[01][0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(s) || !Number.isFinite(d.getTime()) || iso(d) !== s)
        throw new AppError(422, 'INVALID_DATE');
    return d;
}
const end = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
export function scheduleDates(t) {
    if (t.calendarConvention !== 'PERIODIC_FIXED' || t.holidayAdjustment !== 'NO_SHIFT')
        throw new AppError(422, 'UNSUPPORTED_CALENDAR');
    const start = dateValue(t.effectiveDate), y = start.getUTCFullYear(), m = start.getUTCMonth(), day = start.getUTCDate(), eom = day === end(y, m);
    if (t.frequency === 'SEMIMONTH' && day !== 15 && !eom)
        throw new AppError(422, 'IRREGULAR_PERIOD_UNSUPPORTED');
    const fixed = new Map([['DAY', 1], ['WEEK', 7], ['FIFTEEN_DAYS', 15]]), step = fixed.get(t.frequency);
    let current = start;
    const dates = [];
    for (let k = 1; k <= t.installmentCount; k++) {
        if (step)
            current = new Date(Date.UTC(y, m, day + k * step));
        else if (t.frequency === 'MONTH') {
            const ym = new Date(Date.UTC(y, m + k, 1)), yy = ym.getUTCFullYear(), mm = ym.getUTCMonth();
            current = new Date(Date.UTC(yy, mm, eom ? end(yy, mm) : Math.min(day, end(yy, mm))));
        }
        else if (t.frequency === 'SEMIMONTH')
            current = current.getUTCDate() === 15 ? new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 0)) : new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 15));
        else
            throw new AppError(422, 'UNSUPPORTED_CALENDAR');
        dates.push(iso(dateValue(iso(current))));
    }
    if (dates[0] !== t.firstDueDate)
        throw new AppError(422, 'IRREGULAR_PERIOD_UNSUPPORTED');
    return dates;
}
//# sourceMappingURL=calendar.js.map