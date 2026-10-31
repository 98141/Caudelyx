import { createHash } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
export function canonical(value) {
    if (Array.isArray(value))
        return value.map(canonical);
    if (value && typeof value === 'object') {
        if (Object.keys(value).some(k => ['__proto__', 'prototype', 'constructor'].includes(k)))
            throw new AppError(422, 'INPUT_INVALID');
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
    }
    if (typeof value === 'string')
        return value.normalize('NFC');
    if (typeof value === 'number' && !Number.isSafeInteger(value))
        throw new AppError(422, 'INPUT_INVALID');
    return value;
}
export const hash = (v) => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export const binaryHash = (v) => createHash('sha256').update(v).digest('hex');
export function workbookIdentity(data, scope) {
    const normalized = Object.fromEntries(Object.entries(data).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([sheet, rows]) => [sheet, [...rows].map(row => canonical(row)).sort((a, b) => String(a['externalKey'] ?? a['key']) < String(b['externalKey'] ?? b['key']) ? -1 : 1)]));
    return hash({ scope, policy: 'S11-EXCHANGE-1.0', data: normalized });
}
export function jsonText(v) {
    if (typeof v !== 'string' || Buffer.byteLength(v) > 32767)
        throw new AppError(422, 'INPUT_INVALID');
    let parsed;
    try {
        assertUniqueKeys(v);
        parsed = JSON.parse(v, ((k, x) => { if (['__proto__', 'prototype', 'constructor'].includes(k))
            throw Error('unsafe key'); return x; }));
    }
    catch {
        throw new AppError(422, 'INPUT_INVALID');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new AppError(422, 'INPUT_INVALID');
    canonical(parsed);
    return parsed;
}
// JSON.parse discards duplicate properties. Scan the grammar first so aliases,
// escaped property names and nested objects cannot conceal a second instruction.
function assertUniqueKeys(text) {
    let at = 0;
    const ws = () => { while (/\s/.test(text.charAt(at)) && at < text.length)
        at++; };
    const string = () => { const begin = at; if (text.charAt(at++) !== '"')
        throw Error('string'); while (at < text.length) {
        const c = text.charAt(at++);
        if (c === '"')
            return JSON.parse(text.slice(begin, at));
        if (c === '\\')
            at++;
    } throw Error('string'); };
    const value = (depth) => {
        if (depth > 40)
            throw Error('depth');
        ws();
        const c = text.charAt(at);
        if (c === '"') {
            string();
            return;
        }
        if (c === '{' || c === '[') {
            at++;
            ws();
            const close = c === '{' ? '}' : ']', keys = new Set();
            if (text.charAt(at) === close) {
                at++;
                return;
            }
            while (at < text.length) {
                if (c === '{') {
                    ws();
                    const key = string().normalize('NFC');
                    if (keys.has(key))
                        throw Error('duplicate');
                    keys.add(key);
                    ws();
                    if (text.charAt(at++) !== ':')
                        throw Error('colon');
                }
                value(depth + 1);
                ws();
                const next = text.charAt(at++);
                if (next === close)
                    return;
                if (next !== ',')
                    throw Error('comma');
            }
            throw Error('close');
        }
        // eslint-disable-next-line security/detect-unsafe-regex -- JSON number components have distinct decimal/exponent separators; input is bounded32KiB with depth40 and isolated deadline.
        const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
        if (!match)
            throw Error('value');
        at += match[0].length;
    };
    value(0);
    ws();
    if (at !== text.length)
        throw Error('trailing');
}
//# sourceMappingURL=canonical.js.map