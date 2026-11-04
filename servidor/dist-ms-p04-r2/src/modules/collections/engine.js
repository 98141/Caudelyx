import { AppError } from '../../shared/errors.js';
import { cents, money } from '../finance/money.js';
import { bucketNames } from './models.js';
export const fail = (code, status = 409) => { throw new AppError(status, code); };
export const zeroBuckets = () => Object.fromEntries(bucketNames.map(k => [k, '0.00']));
export const activeDelivery = (d) => !['CONFIRMED', 'CANCELLED'].includes(d.state);
export function validatePortions(portions, amount) {
    if (!portions.length || portions.length > 100 || new Set(portions.map(p => p.sourcePaymentId)).size !== portions.length || portions.reduce((n, p) => n + cents(p.amount), 0n) !== cents(amount))
        fail('INPUT_INVALID', 422);
}
export function denominations(rows, amount) {
    if (!rows.length)
        return;
    const units = [5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000, 2000000, 5000000, 10000000];
    if (new Set(rows.map(r => r.unitCents)).size !== rows.length || rows.some(r => !units.includes(r.unitCents) || !Number.isSafeInteger(r.quantity) || r.quantity < 0) || rows.reduce((n, r) => n + BigInt(r.unitCents) * BigInt(r.quantity), 0n) !== amount)
        fail('INPUT_INVALID', 422);
}
export function requireState(d, states) { if (!states.includes(d.state))
    fail('STATE_CONFLICT'); }
export function countedState(d, amount) {
    requireState(d, ['RECEIVED_FOR_REVIEW', 'COUNTED', 'DISCREPANCY', 'INVESTIGATION', 'CORRECTED']);
    if (cents(amount) !== cents(d.amount))
        return 'DISCREPANCY';
    return d.investigated ? 'INVESTIGATION' : 'COUNTED';
}
export function physicalMovement(d) {
    const amount = cents(d.amount), source = d.sourceAccountId, destination = d.destinationAccountId;
    if (!activeDelivery(d) || d.state === 'REQUESTED')
        return null;
    const returning = d.state.startsWith('RETURN_');
    let at = 'TRANSIT_SENDER', count = amount;
    if (d.receivedAt) {
        at = 'DESTINATION';
        count = d.lastCount === null ? amount : cents(d.lastCount);
    }
    if (returning) {
        if (d.sourceReceived || d.sourceRecalled) {
            at = 'SOURCE';
            count = d.returnCount === null ? amount : cents(d.returnCount);
        }
        else if (d.receiverReturnDispatched) {
            at = 'TRANSIT_RECEIVER';
            count = amount;
        }
    }
    return { amount, source, destination, at, observed: count < amount ? count : amount, missing: count < amount ? amount - count : 0n, surplus: count > amount ? count - amount : 0n };
}
// eslint-disable-next-line security/detect-object-injection -- keyof the fixed internal Buckets DTO, never a request key.
export function addBucket(b, k, value) { const n = cents(b[k]) + value; if (n < 0n)
    fail('INTEGRITY_MISMATCH', 503); b[k] = money(n); }
//# sourceMappingURL=engine.js.map