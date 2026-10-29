import { BSON } from 'mongodb';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
const canonical = (value) => Array.isArray(value) ? value.map(canonical) :
    value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;
export const encode = (value) => JSON.stringify(canonical(BSON.EJSON.serialize(value, { relaxed: false })));
const frame = (value) => `${Buffer.byteLength(value)}:${value}`;
export const hash = (value) => createHash('sha256').update(frame('S09-AUTH-BOOKS-1'))
    .update(frame(encode(value))).digest('hex');
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