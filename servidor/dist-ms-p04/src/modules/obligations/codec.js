import { BSON } from 'mongodb';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
const canonical = (value) => Array.isArray(value) ? value.map(canonical) :
    value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;
const legacyEncode = (value) => JSON.stringify(canonical(BSON.EJSON.serialize(value, { relaxed: false })));
const useLegacy = Symbol('legacy-json');
// Same strict EJSON bytes, one traversal for persisted signed row data.
// HMAC bodies, transport structures and unusual JS objects retain the original
// encoder. No cached rows, hashes, authority, keys or proof results.
function rowValue(value, depth = 0, decimals) {
    if (depth > 80)
        throw useLegacy;
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return JSON.stringify(value);
    if (typeof value === 'number')
        return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 && !Object.is(value, -0) ? '{"$numberInt":' + JSON.stringify(String(value)) + '}' : legacyEncode(value);
    if (typeof value !== 'object')
        throw useLegacy;
    if (value instanceof BSON.Decimal128) {
        const key = decimals ? Buffer.from(value.bytes.buffer, value.bytes.byteOffset, value.bytes.byteLength).toString('hex') : null;
        let result = key ? decimals?.get(key) : undefined;
        if (result === undefined) {
            result = '{"$numberDecimal":' + JSON.stringify(value.toString()) + '}';
            if (key)
                decimals?.set(key, result);
        }
        return result;
    }
    if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype || Object.hasOwn(value, 'toJSON'))
            throw useLegacy;
        return '[' + Array.from(value, v => rowValue(v, depth + 1, decimals)).join(',') + ']';
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return legacyEncode(value);
    const entries = [];
    for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!('value' in descriptor) || key === '_bsontype' || key === 'toJSON' || key === 'toBSON')
            throw useLegacy;
        entries.push([key, descriptor.value]);
    }
    // JSON enumerates canonical array-index keys numerically before other keys,
    // even after the original encoder has sorted Object.fromEntries lexically.
    const index = (key) => /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 4294967295 ? Number(key) : null;
    return '{' + entries.sort(([a], [b]) => { const x = index(a), y = index(b); return x !== null && y !== null ? x - y : x !== null ? -1 : y !== null ? 1 : a < b ? -1 : a > b ? 1 : 0; }).map(([key, item]) => JSON.stringify(key) + ':' + rowValue(item, depth + 1, decimals)).join(',') + '}';
}
export function encode(value, decimals) {
    if (value && typeof value === 'object' && typeof Object.getOwnPropertyDescriptor(value, 'mac')?.value === 'string' && typeof Object.getOwnPropertyDescriptor(value, 'bookId')?.value === 'string' && ['PERSONAL', 'BUSINESS'].includes(Object.getOwnPropertyDescriptor(value, 'domainKind')?.value)) {
        try {
            return rowValue(value, 0, decimals);
        }
        catch (error) {
            if (error !== useLegacy)
                throw error;
        }
    }
    return legacyEncode(value);
}
const frame = (value) => `${Buffer.byteLength(value)}:${value}`;
export const hash = (value) => createHash('sha256').update(frame('S09-AUTH-BOOKS-1'))
    .update(frame(encode(value))).digest('hex');
// One complete table proof, one short-lived conversion dictionary. It contains
// only Decimal128 bit-pattern-to-EJSON strings; no cached hashes or authority.
export const rowHashes = (rows) => { const decimals = new Map(); return new Map(rows.map(row => [String(row['_id']), createHash('sha256').update(frame('S09-AUTH-BOOKS-1')).update(frame(encode(row, decimals))).digest('hex')])); };
export const copy = (value) => BSON.EJSON.parse(BSON.EJSON.stringify(value, { relaxed: false }), { relaxed: false });
export const unavailable = () => { throw new AppError(503, 'SERVICE_UNAVAILABLE'); };
export class ProjectionCodec {
    key;
    constructor(key) { this.key = createHmac('sha256', key).update('CAUDELYX:S09:BOOKS:KEY:v1').digest(); }
    seal(purpose, body) {
        return createHmac('sha256', this.key).update(frame(purpose)).update(frame(encode(body))).digest('hex');
    }
    verify(purpose, body, mac) {
        return typeof mac === 'string' && /^[a-f0-9]{64}$/.test(mac) && timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(this.seal(purpose, body), 'hex'));
    }
}
export const mutation = (namespace, before, after) => ({
    namespace, key: copy((after ?? before)['_id']), before: before === null ? null : hash(before), after: after === null ? null : hash(after),
});
export const mutationKey = (item) => encode([item.namespace, item.key]);
export function orderedPaths(items) {
    const paths = new Map();
    for (const item of items) {
        const key = mutationKey(item), path = paths.get(key) ?? [];
        path.push(item);
        paths.set(key, path);
    }
    return [...paths].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).flatMap(([, path]) => path);
}
export const transactionId = (sessionId, number) => hash({ session: sessionId, number: String(number) });
//# sourceMappingURL=codec.js.map