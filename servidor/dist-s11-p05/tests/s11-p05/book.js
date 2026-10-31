/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection, security/detect-unsafe-regex, security/detect-non-literal-regexp -- Regexes run only on own/frozen sample XML (bounded size); relationship id comes from that workbook. Fixed contract/template paths and own synthetic maps only. */
// S11-P05 (Claude): own OOXML/ZIP writer and reader. Deliberately does NOT import any product module (no exchange/zip, xml,
// workbook or contract code): sheet/column names come straight from the frozen COLUMN_DICTIONARY_S11.json.
import { readFileSync } from 'node:fs';
import { deflateRawSync, inflateRawSync, crc32 } from 'node:zlib';
const CONTRACTS = '../../Construccion/Sprints/S11/Contratos/';
export const TEMPLATES = '../../Construccion/Sprints/S11/Plantillas/v1.0.0/';
export const dictionary = JSON.parse(readFileSync(CONTRACTS + 'COLUMN_DICTIONARY_S11.json', 'utf8'));
const esc = (v) => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export const col = (n) => { let s = ''; for (; n; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PR = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_SHEET = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
export function cellXml(ref, v) {
    if (v === undefined || v === null)
        return '';
    if (typeof v === 'number')
        return `<c r="${ref}"><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}
export function sheetXml(columns, rows, extra = {}) {
    const all = [Object.fromEntries(columns.map(c => [c.name, c.name])), ...rows];
    const body = all.map((row, i) => `<row r="${i + 1}"${extra.rowAttr ? extra.rowAttr(i + 1) : ''}>` + columns.map((c, j) => cellXml(col(j + 1) + (i + 1), row[c.name])).join('') + '</row>').join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}"><sheetData>${body}</sheetData>${extra.tail ?? ''}</worksheet>`;
}
/** All 13 sheets of template 1.0.0 with the given rows; Control rows derived from `control`. */
export function parts(mode, namespace, rows, control = {}) {
    const controls = { templateVersion: '1.0.0', mappingVersion: 'S11-MAP-1', mode, namespace, currency: 'COP', timezone: 'America/Bogota', ...control };
    const data = { ...rows, Control: Object.entries(controls).map(([key, value]) => ({ key, value })) };
    const out = new Map(), sheets = [], rels = [], over = [];
    dictionary.sheets.forEach((s, i) => {
        const n = i + 1;
        out.set(`xl/worksheets/sheet${n}.xml`, Buffer.from(sheetXml(s.columns, data[s.name] ?? [])));
        sheets.push(`<sheet name="${esc(s.name)}" sheetId="${n}" r:id="rId${n}"/>`);
        rels.push(`<Relationship Id="rId${n}" Type="${R}/worksheet" Target="worksheets/sheet${n}.xml"/>`);
        over.push(`<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="${CT_SHEET}"/>`);
    });
    out.set('xl/workbook.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${NS}" xmlns:r="${R}"><sheets>${sheets.join('')}</sheets></workbook>`));
    out.set('xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PR}">${rels.join('')}</Relationships>`));
    out.set('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PR}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`));
    out.set('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${over.join('')}</Types>`));
    return out;
}
export const sheetIndex = (name) => dictionary.sheets.findIndex(s => s.name === name) + 1;
export const columnsOf = (name) => dictionary.sheets.find(s => s.name === name).columns;
/** Own ZIP writer (local headers + central directory + EOCD). Options allow adversarial variants. */
export function zip(entries, o = {}) {
    const list = [...entries];
    if (o.reverse)
        list.reverse();
    const local = [], central = [];
    let off = o.prefix?.length ?? 0;
    for (const [name, raw] of list) {
        const nb = Buffer.from(name, 'utf8'), data = o.store ? raw : deflateRawSync(raw), method = o.store ? 0 : 8, crc = crc32(raw) >>> 0;
        const size = o.sizeOverride ? o.sizeOverride(name, raw.length) : raw.length;
        const h = Buffer.alloc(30);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(0x800, 6);
        h.writeUInt16LE(method, 8);
        h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(data.length, 18);
        h.writeUInt32LE(size, 22);
        h.writeUInt16LE(nb.length, 26);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0);
        c.writeUInt16LE(o.attr ? 0x31e : 20, 4);
        c.writeUInt16LE(20, 6);
        c.writeUInt16LE(0x800, 8);
        c.writeUInt16LE(method, 10);
        c.writeUInt32LE(crc, 16);
        c.writeUInt32LE(data.length, 20);
        c.writeUInt32LE(size, 24);
        c.writeUInt16LE(nb.length, 28);
        c.writeUInt32LE(o.attr ? o.attr(name) >>> 0 : 0, 38);
        c.writeUInt32LE(off, 42);
        local.push(h, nb, data);
        central.push(c, nb);
        off += 30 + nb.length + data.length;
    }
    const dir = Buffer.concat(central), comment = Buffer.from(o.comment ?? ''), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(list.length, 8);
    end.writeUInt16LE(list.length, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(off, 16);
    end.writeUInt16LE(comment.length, 20);
    return Buffer.concat([...(o.prefix ? [o.prefix] : []), ...local, dir, end, comment, ...(o.trailing ? [o.trailing] : [])]);
}
export const workbook = (mode, namespace, rows, control = {}, o = {}) => zip(parts(mode, namespace, rows, control), o);
/** Own minimal ZIP reader (central directory), used to read the frozen samples without product code. */
export function unzip(bytes) {
    let e = -1;
    for (let i = bytes.length - 22; i >= 0; i--)
        if (bytes.readUInt32LE(i) === 0x06054b50) {
            e = i;
            break;
        }
    if (e < 0)
        throw Error('no EOCD');
    const n = bytes.readUInt16LE(e + 10);
    let at = bytes.readUInt32LE(e + 16);
    const out = new Map();
    for (let i = 0; i < n; i++) {
        const method = bytes.readUInt16LE(at + 10), comp = bytes.readUInt32LE(at + 20), nl = bytes.readUInt16LE(at + 28), xl = bytes.readUInt16LE(at + 30), cl = bytes.readUInt16LE(at + 32), lo = bytes.readUInt32LE(at + 42);
        const name = bytes.subarray(at + 46, at + 46 + nl).toString('utf8'), start = lo + 30 + bytes.readUInt16LE(lo + 26) + bytes.readUInt16LE(lo + 28), data = bytes.subarray(start, start + comp);
        out.set(name, method === 0 ? Buffer.from(data) : inflateRawSync(data));
        at += 46 + nl + xl + cl;
    }
    return out;
}
const unesc = (v) => v.replace(/&(lt|gt|quot|apos|amp);/g, (_m, k) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[k]);
/** Reads a frozen sample (shared or inline strings) into rows keyed by header, using regexes only (no product XML parser). */
export function readSample(file) {
    const p = unzip(readFileSync(file)), shared = [];
    const ss = p.get('xl/sharedStrings.xml')?.toString('utf8');
    if (ss)
        for (const si of ss.match(/<(?:\w+:)?si>[\s\S]*?<\/(?:\w+:)?si>/g) ?? [])
            shared.push(unesc((si.match(/<(?:\w+:)?t[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g) ?? []).map(t => t.replace(/<[^>]+>/g, '')).join('')));
    const wb = p.get('xl/workbook.xml').toString('utf8'), rels = p.get('xl/_rels/workbook.xml.rels').toString('utf8'), out = {};
    for (const m of wb.matchAll(/<(?:\w+:)?sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"/g)) {
        const target = new RegExp(`Id="${m[2]}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${m[2]}"`).exec(rels), t = (target[1] ?? target[2]).replace(/^\/?(xl\/)?/, '');
        const xml = p.get('xl/' + t).toString('utf8'), grid = {};
        for (const c of xml.matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
            const attrs = c[1], ref = /\br="([A-Z]+)([0-9]+)"/.exec(attrs), type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n', inner = c[2] ?? '';
            let colN = 0;
            for (const ch of ref[1])
                colN = colN * 26 + ch.charCodeAt(0) - 64;
            const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1];
            const value = type === 's' ? shared[Number(v)] : type === 'inlineStr' ? unesc((inner.match(/<(?:\w+:)?t[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g) ?? []).map(x => x.replace(/<[^>]+>/g, '')).join('')) : type === 'str' ? unesc(v ?? '') : v === undefined ? undefined : Number(v);
            (grid[Number(ref[2])] ??= {})[colN] = value;
        }
        const header = grid[1] ?? {}, rows = [];
        for (const r of Object.keys(grid).map(Number).filter(r => r > 1).sort((a, b) => a - b)) {
            const row = {};
            let any = false;
            for (const [c, name] of Object.entries(header)) {
                const v = grid[r][Number(c)];
                if (v !== undefined && v !== '') {
                    row[String(name)] = v;
                    any = true;
                }
            }
            if (any)
                rows.push(row);
        }
        out[m[1]] = rows;
    }
    return out;
}
// Independent integer-cents oracle (never the product money/ledger engine).
export const cents = (v) => { if (!/^-?(0|[1-9][0-9]*)\.[0-9]{2}$/.test(v))
    throw Error('noncanonical amount ' + v); return BigInt(v.replace('.', '')); };
export const money = (c) => (c < 0n ? '-' : '') + (c < 0n ? -c : c) / 100n + '.' + String((c < 0n ? -c : c) % 100n).padStart(2, '0');
export const sum = (xs) => xs.reduce((n, x) => n + cents(x), 0n);
//# sourceMappingURL=book.js.map