const S = 10n ** 24n;
const MAX_CENTS = 999999999999999999n; // S2 money maximum 9999999999999999.99
const WEIGHT = new Map([['DAY', [1n, 365n]], ['WEEK', [7n, 365n]], ['FIFTEEN_DAYS', [15n, 365n]], ['SEMIMONTH', [1n, 24n]], ['MONTH', [1n, 12n]], ['YEAR', [1n, 1n]]]);
const gcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b)
    [a, b] = [b, a % b]; return a; };
const bits = (x) => x.toString(2).length;
/** floor(X^(1/q)) for X >= 0 by integer Newton from a certified upper bound; asserted r^q <= X < (r+1)^q. */
export function iroot(X, q) {
    if (X < 2n || q === 1)
        return X;
    const Q = BigInt(q);
    // Float estimate only seeds Newton; it is forced above the root and the result is certified exactly below.
    const b = bits(X), top = Number(X >> BigInt(Math.max(0, b - 53))), log2 = Math.log2(top) + Math.max(0, b - 53), e = log2 / q;
    const whole = Math.floor(e), seed = BigInt(Math.floor(2 ** (e - whole) * 2 ** 52) + 1);
    let x = (whole >= 52 ? seed << BigInt(whole - 52) : seed >> BigInt(52 - whole)) + 2n;
    x += x >> 30n;
    while (x ** Q <= X)
        x *= 2n; // > root
    for (;;) {
        const y = ((Q - 1n) * x + X / x ** (Q - 1n)) / Q;
        if (y >= x)
            break;
        x = y;
    }
    while (x ** Q > X)
        x--;
    while ((x + 1n) ** Q <= X)
        x++;
    if (!(x ** Q <= X && (x + 1n) ** Q > X))
        throw new Error('iroot certification failed');
    return x;
}
/** Periodic rate rounded HALF_EVEN to 24 decimals, as a scaled integer I (i = I / 10^24). */
export function periodicRate24(rate, frequency) {
    const r = BigInt(rate.value.replace('.', ''));
    if (r === 0n)
        return 0n;
    const pay = WEIGHT.get(frequency), unit = WEIGHT.get(rate.unit);
    if (!pay || !unit || frequency === 'YEAR')
        throw new Error('unsupported weight');
    const R12 = 10n ** 12n;
    let num, den, p, q;
    if (rate.type === 'EFFECTIVE') {
        num = R12 + r;
        den = R12;
        p = pay[0] * unit[1];
        q = pay[1] * unit[0];
    }
    else {
        const m = BigInt(rate.compoundingPeriodsPerYear);
        num = m * R12 + r;
        den = m * R12;
        p = m * pay[0];
        q = pay[1];
    }
    const g = gcd(p, q);
    p /= g;
    q /= g;
    const qn = Number(q), twoS = 2n * S;
    const lhs = twoS ** q * num ** p, rhs = den ** p;
    const t = iroot(lhs / rhs, qn); // floor(2·S·y)
    let T;
    if (t % 2n === 0n)
        T = t / 2n;
    else {
        const tie = t ** q * rhs === lhs;
        const lo = (t - 1n) / 2n;
        T = tie ? (lo % 2n === 0n ? lo : lo + 1n) : lo + 1n;
    }
    return T - S;
}
export const rate24Text = (I) => (I / S).toString() + '.' + (I % S).toString().padStart(24, '0');
const q = (n, d = 1n) => { if (d < 0n) {
    n = -n;
    d = -d;
} const g = gcd(n, d) || 1n; return { n: n / g, d: d / g }; };
const add = (a, b) => q(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a, b) => q(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a, b) => q(a.n * b.n, a.d * b.d);
const div = (a, b) => q(a.n * b.d, a.d * b.n);
const powi = (a, n) => n >= 0 ? q(a.n ** BigInt(n), a.d ** BigInt(n)) : q(a.d ** BigInt(-n), a.n ** BigInt(-n));
/** Integer division n/d rounded; halfUp=false → HALF_EVEN. Assumes d > 0, n >= 0. */
function roundDiv(n, d, halfUp) {
    const f = n / d, r = n - f * d;
    if (2n * r > d)
        return f + 1n;
    if (2n * r < d)
        return f;
    return halfUp ? f + 1n : (f % 2n === 0n ? f : f + 1n);
}
/** Round a positive rational to 60 significant digits HALF_EVEN (Decimal60 context emulation). */
function round60(x) {
    if (x.n === 0n)
        return x;
    if (x.n < 0n) {
        const r = round60(q(-x.n, x.d));
        return q(-r.n, r.d);
    }
    // e such that 10^59 <= x / 10^e < 10^60
    let e = x.n.toString().length - x.d.toString().length - 60;
    const scaled = (k) => k >= 0 ? q(x.n, x.d * 10n ** BigInt(k)) : q(x.n * 10n ** BigInt(-k), x.d);
    for (;;) {
        const v = scaled(e);
        const lo = 10n ** 59n;
        if (v.n < lo * v.d) {
            e--;
            continue;
        }
        if (v.n >= 10n * lo * v.d) {
            e++;
            continue;
        }
        break;
    }
    const v = scaled(e), c = roundDiv(v.n, v.d, false);
    return e >= 0 ? q(c * 10n ** BigInt(e)) : q(c, 10n ** BigInt(-e));
}
const centsHalfUp = (x) => { if (x.n < 0n)
    throw new Error('negative'); return roundDiv(x.n * 100n, x.d, true); };
const money = (c) => { const s = c < 0n ? '-' : '', a = c < 0n ? -c : c; return s + (a / 100n).toString() + '.' + (a % 100n).toString().padStart(2, '0'); };
// ---------- calendar on civil days ----------
const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const dim = (y, m) => [31, leap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
function parse(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m)
        return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (y < 2000 || y > 2199 || mo < 1 || mo > 12 || d < 1 || d > dim(y, mo))
        return null;
    return [y, mo, d];
}
/** Days from 0000-03-01 style civil algorithm (H. Hinnant). */
function toDays(y, m, d) { y -= m <= 2 ? 1 : 0; const era = Math.floor(y / 400), yoe = y - era * 400, mp = (m + 9) % 12, doy = Math.floor((153 * mp + 2) / 5) + d - 1, doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; return era * 146097 + doe; }
function fromDays(z) { const era = Math.floor(z / 146097), doe = z - era * 146097, yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365), doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)), mp = Math.floor((5 * doy + 2) / 153), d = doy - Math.floor((153 * mp + 2) / 5) + 1, m = mp < 10 ? mp + 3 : mp - 9; return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d]; }
const fmt = ([y, m, d]) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export function dueDates(t) {
    const start = parse(t.effectiveDate);
    if (!start)
        return { error: 'INVALID_DATE' };
    const [y0, m0, d0] = start, eom = d0 === dim(y0, m0), out = [];
    const step = new Map([['DAY', 1], ['WEEK', 7], ['FIFTEEN_DAYS', 15]]).get(t.frequency);
    if (t.frequency === 'SEMIMONTH' && d0 !== 15 && !eom)
        return { error: 'IRREGULAR_PERIOD_UNSUPPORTED' };
    let cur = start;
    for (let k = 1; k <= t.installmentCount; k++) {
        let next;
        if (step)
            next = fromDays(toDays(y0, m0, d0) + k * step);
        else if (t.frequency === 'MONTH') {
            const idx = (m0 - 1) + k, y = y0 + Math.floor(idx / 12), m = (idx % 12) + 1;
            next = [y, m, eom ? dim(y, m) : Math.min(d0, dim(y, m))];
        }
        else if (t.frequency === 'SEMIMONTH')
            next = cur[2] === 15 ? [cur[0], cur[1], dim(cur[0], cur[1])] : (cur[1] === 12 ? [cur[0] + 1, 1, 15] : [cur[0], cur[1] + 1, 15]);
        else
            return { error: 'UNSUPPORTED_CALENDAR' };
        if (next[0] < 2000 || next[0] > 2199)
            return { error: 'INVALID_DATE' };
        out.push(fmt(next));
        cur = next;
    }
    return out;
}
/** Full schedule per the approved policy, or the policy's rejection code. */
export function oracle(t) {
    if (t.usage === 'REAL')
        return { error: 'REAL_USE_NOT_ALLOWED' };
    if (t.policyVersion !== 'S04-LOCAL-CO-0.1' || t.jurisdiction !== 'CO' || t.usage !== 'LOCAL_SYNTHETIC')
        return { error: 'POLICY_UNSUPPORTED' };
    if (t.calendarConvention !== 'PERIODIC_FIXED' || t.holidayAdjustment !== 'NO_SHIFT')
        return { error: 'UNSUPPORTED_CALENDAR' };
    if (!parse(t.effectiveDate) || !parse(t.firstDueDate))
        return { error: 'INVALID_DATE' };
    const dates = dueDates(t);
    if ('error' in dates)
        return dates;
    if (dates[0] !== t.firstDueDate)
        return { error: 'IRREGULAR_PERIOD_UNSUPPORTED' };
    const I = periodicRate24(t.rate, t.frequency), i = q(I, S), n = t.installmentCount, P = BigInt(t.principal.replace('.', ''));
    const interestOf = (b) => centsHalfUp(mul(q(b, 100n), i));
    let C = null;
    if (t.method === 'LEVEL_PAYMENT') {
        const Pq = q(P, 100n);
        const star = I === 0n ? round60(div(Pq, q(BigInt(n)))) : round60(div(round60(mul(Pq, i)), round60(sub(q(1n), round60(powi(add(q(1n), i), -n))))));
        C = centsHalfUp(star);
    }
    const fixed = P / BigInt(n);
    if (t.method === 'CONSTANT_PRINCIPAL' && n > 1 && fixed === 0n)
        return { error: 'PAYMENT_RESOLUTION_UNSUPPORTED' };
    const rows = [];
    let b = P, ti = 0n, tp = 0n;
    for (let k = 1; k <= n; k++) {
        const interest = interestOf(b);
        const principal = k === n ? b : t.method === 'CONSTANT_PRINCIPAL' ? fixed : t.method === 'LEVEL_PAYMENT' ? C - interest : 0n;
        if (t.method === 'LEVEL_PAYMENT' && k < n && (principal <= 0n || principal >= b))
            return { error: 'PAYMENT_RESOLUTION_UNSUPPORTED' };
        const payment = principal + interest, next = b - principal;
        if ([b, principal, interest, payment, next].some(v => v < 0n || v > MAX_CENTS))
            return { error: 'CALCULATION_UNREPRESENTABLE' };
        rows.push({ k, date: dates[k - 1], openingPrincipal: money(b), principal: money(principal), interest: money(interest), payment: money(payment), closingPrincipal: money(next) });
        b = next;
        ti += interest;
        tp += payment;
    }
    if (b !== 0n || ti > MAX_CENTS || tp > MAX_CENTS)
        return { error: 'CALCULATION_UNREPRESENTABLE' };
    const last = BigInt(rows.at(-1).payment.replace('.', ''));
    return { value: { schedule: rows, totals: { principal: t.principal, interest: money(ti), payment: money(tp) }, periodicRate24: rate24Text(I),
            basePayment: C === null ? null : money(C), finalPaymentAdjustment: C === null ? '0.00' : money(last - C) } };
}
/** Same level payment without the 60-digit context (exact rational), to measure context sensitivity only. */
export function exactLevelPayment(t) {
    const I = periodicRate24(t.rate, t.frequency), i = q(I, S), n = t.installmentCount, Pq = q(BigInt(t.principal.replace('.', '')), 100n);
    return centsHalfUp(I === 0n ? div(Pq, q(BigInt(n))) : div(mul(Pq, i), sub(q(1n), powi(add(q(1n), i), -n))));
}
//# sourceMappingURL=oracle.js.map