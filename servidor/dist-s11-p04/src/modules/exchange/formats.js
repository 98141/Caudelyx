/* Fixed pinned font asset; closed report column catalog, XML/PDF text encoded, no renderer/network callbacks. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { exchangeContract } from './contract.js';
import { checkBudget } from './budget.js';
import { columnName } from './workbook.js';
import { xmlEscape } from './xml.js';
import { writeZip } from './zip.js';
import { reportColumnType } from './reports.js';
const dangerous = /^[\p{White_Space}\p{Cc}\p{Cf}]*[=+\-@]/u;
export function encodeText(value) { return value.startsWith("'") || value.startsWith('\\N') || dangerous.test(value) ? "'" + value : value; }
export function decodeText(value) { if (!value.startsWith("'"))
    return value; const original = value.slice(1); if (original.startsWith("'") || original.startsWith('\\N') || dangerous.test(original))
    return original; throw new AppError(422, 'INPUT_INVALID'); }
const value = (c) => c.value === null ? '\\N' : c.type === 'TEXT' ? encodeText(String(c.value)) : String(c.value);
function columns(s) { const cols = exchangeContract().document['x-report-columns'][s.reportKind]; if (!cols)
    throw new AppError(422, 'INPUT_INVALID'); return cols; }
function reportMatrix(s, xlsx = false) {
    const cols = columns(s), head = ['recordType', 'id', ...cols.flatMap(c => [c, c + '_status', c + '_reason'])];
    if ((s.rows.length + 3) * head.length > 1000000)
        throw new AppError(413, 'FILE_LIMIT_EXCEEDED');
    const line = (kind, id, cells) => { checkBudget(); const map = new Map(cells.map(c => [c.columnId, c])); return [kind, id, ...cols.flatMap(k => { const c = map.get(k); return c ? [xlsx && c.value === null ? null : xlsx && c.type === 'COUNT' ? c.value : value(c), c.status, c.reason] : [xlsx ? null : '\\N', 'NOT_APPLICABLE', 'NONE']; })]; };
    return [head, ...s.rows.map(r => line('ROW', r.id, r.cells)), line('TOTAL', 'TOTAL', s.totals)];
}
export function exportCsv(s) {
    const matrix = reportMatrix(s), cols = matrix[0].length;
    // Metadata records are explicitly distinct, aligned to the same column width.
    const metadata = ['META', 'schema=1.0.0;escape=S11-TEXT-1;null=\\N;' + JSON.stringify(Object.fromEntries(Object.entries(s.meta).filter(([k]) => !['snapshotToken', 'sourceVectorDigest'].includes(k))))];
    matrix.splice(1, 0, [...metadata, ...Array.from({ length: cols - metadata.length }, () => null)]);
    const data = Buffer.from(matrix.map(row => row.map(v => '"' + String(v ?? '\\N').replaceAll('"', '""') + '"').join(',')).join('\r\n') + '\r\n', 'utf8');
    if (data.length > 33554432)
        throw new AppError(413, 'FILE_LIMIT_EXCEEDED');
    return data;
}
const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
export function makeXlsx(sheets, maxBytes = 33554432) {
    const files = new Map(), ct = [], book = [], rels = [];
    let index = 0, cells = 0;
    for (const [name, matrix] of sheets) {
        index++;
        if (!/^[A-Za-zÁÉÍÓÚáéíóúÑñ][A-Za-zÁÉÍÓÚáéíóúÑñ0-9_ ]{0,30}$/.test(name))
            throw new AppError(422, 'INPUT_INVALID');
        const body = matrix.map((row, r) => '<row r="' + (r + 1) + '">' + row.map((v, c) => {
            if (++cells > 1000000)
                throw new AppError(413, 'FILE_LIMIT_EXCEEDED');
            const a = columnName(c + 1) + (r + 1);
            if (v === null)
                return '<c r="' + a + '"/>';
            if (typeof v === 'number') {
                if (!Number.isSafeInteger(v))
                    throw new AppError(422, 'INPUT_INVALID');
                return '<c r="' + a + '" t="n"><v>' + v + '</v></c>';
            }
            return '<c r="' + a + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEscape(String(v)) + '</t></is></c>';
        }).join('') + '</row>').join('');
        files.set('xl/worksheets/sheet' + index + '.xml', Buffer.from(xmlHeader + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews><sheetData>' + body + '</sheetData></worksheet>'));
        ct.push('<Override PartName="/xl/worksheets/sheet' + index + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>');
        book.push('<sheet name="' + xmlEscape(name) + '" sheetId="' + index + '" r:id="rId' + index + '"/>');
        rels.push('<Relationship Id="rId' + index + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + index + '.xml"/>');
    }
    files.set('xl/workbook.xml', Buffer.from(xmlHeader + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + book.join('') + '</sheets></workbook>'));
    files.set('xl/_rels/workbook.xml.rels', Buffer.from(xmlHeader + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels.join('') + '</Relationships>'));
    files.set('_rels/.rels', Buffer.from(xmlHeader + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'));
    files.set('[Content_Types].xml', Buffer.from(xmlHeader + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + ct.join('') + '</Types>'));
    return writeZip(files, maxBytes);
}
export function exportXlsx(s) {
    const cols = columns(s), dict = [['columnId', 'type', 'unit', 'escape', 'null']], types = new Map(s.rows[0]?.cells.map(c => [c.columnId, c]) ?? []);
    for (const col of cols) {
        const c = types.get(col) ?? s.totals.find(c => c.columnId === col), type = c?.type ?? reportColumnType(col);
        dict.push([col, type, c?.unit ?? (type === 'MONEY' ? 'COP' : type === 'PERCENT' ? 'PERCENT' : type === 'COUNT' ? 'COUNT' : 'NONE'), 'S11-TEXT-1', '\\N']);
    }
    const metadata = [['key', 'value'], ...Object.entries(s.meta).filter(([k]) => !['snapshotToken', 'sourceVectorDigest'].includes(k)).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])];
    return makeXlsx(new Map([['Datos', reportMatrix(s, true)], ['Metadatos', metadata], ['Totales', [['columnId', 'value', 'status', 'reason'], ...s.totals.map(c => [c.columnId, c.value === null ? null : c.type === 'COUNT' ? c.value : value(c), c.status, c.reason])]], ['Diccionario', dict]]));
}
let font;
function fontBytes() { if (!font) {
    font = readFileSync(resolve('src/modules/exchange/assets/DejaVuSans.ttf'));
    if (createHash('sha256').update(font).digest('hex') !== '7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954')
        throw new AppError(503, 'INTEGRITY_MISMATCH');
} return font; }
function fontMetrics(bytes) {
    const tables = new Map();
    for (let i = 0; i < bytes.readUInt16BE(4); i++)
        tables.set(bytes.toString('ascii', 12 + i * 16, 16 + i * 16), bytes.readUInt32BE(20 + i * 16));
    const units = bytes.readUInt16BE(tables.get('head') + 18), hhea = tables.get('hhea'), hmtx = tables.get('hmtx'), metricCount = bytes.readUInt16BE(hhea + 34), cmap = tables.get('cmap');
    let sub = 0, fmt = 0;
    for (let i = 0; i < bytes.readUInt16BE(cmap + 2); i++) {
        const off = cmap + bytes.readUInt32BE(cmap + 8 + i * 8), f = bytes.readUInt16BE(off);
        if (f === 12 || f === 4 && !sub) {
            sub = off;
            fmt = f;
        }
    }
    const glyph = (cp) => {
        if (fmt === 12) {
            const count = bytes.readUInt32BE(sub + 12);
            let lo = 0, hi = count - 1;
            while (lo <= hi) {
                const m = (lo + hi) >> 1, at = sub + 16 + m * 12, a = bytes.readUInt32BE(at), b = bytes.readUInt32BE(at + 4);
                if (cp < a)
                    hi = m - 1;
                else if (cp > b)
                    lo = m + 1;
                else
                    return bytes.readUInt32BE(at + 8) + cp - a;
            }
        }
        else if (fmt === 4 && cp <= 65535) {
            const count = bytes.readUInt16BE(sub + 6) / 2;
            for (let i = 0; i < count; i++) {
                const end = bytes.readUInt16BE(sub + 14 + i * 2), start = bytes.readUInt16BE(sub + 16 + count * 2 + i * 2);
                if (cp < start || cp > end)
                    continue;
                const delta = bytes.readInt16BE(sub + 16 + count * 4 + i * 2), at = sub + 16 + count * 6 + i * 2, range = bytes.readUInt16BE(at);
                return range ? (bytes.readUInt16BE(at + range + (cp - start) * 2) + delta) & 65535 : (cp + delta) & 65535;
            }
        }
        return 0;
    };
    return { glyph, width: (gid) => Math.round(bytes.readUInt16BE(hmtx + Math.min(gid, metricCount - 1) * 4) * 1000 / units) };
}
export function exportPdf(s) {
    const bytes = fontBytes(), metrics = fontMetrics(bytes), ids = new Map(), glyphs = [0], widths = [600];
    const encode = (text) => [...text].map(ch => { let id = ids.get(ch); if (!id) {
        const gid = metrics.glyph(ch.codePointAt(0));
        if (!gid)
            throw new AppError(503, 'SERVICE_UNAVAILABLE');
        id = ids.size + 1;
        if (id > 65535)
            throw new AppError(413, 'FILE_LIMIT_EXCEEDED');
        ids.set(ch, id);
        glyphs.push(gid);
        widths.push(metrics.width(gid));
    } return id.toString(16).padStart(4, '0'); }).join('');
    const lines = [s.reportKind + ' - COP - America/Bogota', 'Corte ' + JSON.stringify(s.meta['cut']), 'Filas totales: ' + s.totalRows + '; cobertura: ' + JSON.stringify(s.meta['coverage'])];
    let cells = 0;
    for (const [r, row] of s.rows.entries()) {
        checkBudget();
        lines.push('Fila ' + (r + 1) + ' / ' + row.id);
        for (const c of row.cells) {
            if (++cells > 1000000)
                throw new AppError(413, 'FILE_LIMIT_EXCEEDED');
            lines.push(c.columnId + ': ' + (c.value === null ? 'No disponible' : String(c.value)) + ' [' + c.status + (c.reason === 'NONE' ? '' : ' / ' + c.reason) + ']');
        }
    }
    lines.push('Totales del conjunto');
    for (const c of s.totals)
        lines.push(c.columnId + ': ' + (c.value === null ? 'No disponible' : String(c.value)) + ' [' + c.status + ']');
    // Width is measured with the embedded font at 8pt, within both 32pt margins.
    const wrapped = lines.flatMap(text => { checkBudget(); const parts = []; let line = '', width = 0; for (const ch of text.replace(/[\r\n\t]/g, ' ')) {
        const next = metrics.width(metrics.glyph(ch.codePointAt(0))) * 8 / 1000;
        if (width + next > 778 && line) {
            parts.push(line);
            line = '';
            width = 0;
        }
        line += ch;
        width += next;
    } parts.push(line || ' '); return parts; });
    const pageCount = Math.ceil(wrapped.length / 42);
    if (pageCount > 2000)
        throw new AppError(413, 'FILE_LIMIT_EXCEEDED');
    const objects = [];
    const add = (v) => { objects.push(typeof v === 'string' ? Buffer.from(v) : v); return objects.length; };
    const stream = (data, extra = '') => { const compressed = deflateSync(data); return Buffer.concat([Buffer.from('<< /Length ' + compressed.length + ' /Filter /FlateDecode ' + extra + ' >>\nstream\n'), compressed, Buffer.from('\nendstream')]); };
    add('');
    add('');
    const fontId = add(''), descriptor = add(''), fontFile = add(stream(bytes, '/Length1 ' + bytes.length)), cmapId = add(''), cidMapId = add(''), cidFont = add(''), pages = [];
    for (let p = 0; p < pageCount; p++) {
        checkBudget();
        const content = ['BT /F1 8 Tf 12 TL 32 558 Td', '<' + encode(s.reportKind + ' - página ' + (p + 1) + '/' + pageCount) + '> Tj T*', ...wrapped.slice(p * 42, (p + 1) * 42).map(line => '<' + encode(line) + '> Tj T*'), 'ET'].join('\n'), contentId = add(stream(Buffer.from(content))), page = add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 ' + fontId + ' 0 R >> >> /Contents ' + contentId + ' 0 R >>');
        pages.push(page);
    }
    const cidMap = Buffer.alloc(glyphs.length * 2);
    glyphs.forEach((g, i) => cidMap.writeUInt16BE(g, i * 2));
    objects[cidMapId - 1] = stream(cidMap);
    const unicode = [...ids].map(([ch, id]) => '<' + id.toString(16).padStart(4, '0') + '> <' + Buffer.from(ch, 'utf16le').swap16().toString('hex') + '>');
    const cmap = ['/CIDInit /ProcSet findresource begin', '12 dict begin begincmap', '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def', '/CMapName /S11Unicode def /CMapType 2 def', '1 begincodespacerange <0000> <FFFF> endcodespacerange'];
    for (let i = 0; i < unicode.length; i += 100)
        cmap.push(Math.min(100, unicode.length - i) + ' beginbfchar', ...unicode.slice(i, i + 100), 'endbfchar');
    cmap.push('endcmap CMapName currentdict /CMap defineresource pop end end');
    objects[cmapId - 1] = stream(Buffer.from(cmap.join('\n')));
    objects[fontId - 1] = Buffer.from('<< /Type /Font /Subtype /Type0 /BaseFont /DejaVuSans /Encoding /Identity-H /DescendantFonts [' + cidFont + ' 0 R] /ToUnicode ' + cmapId + ' 0 R >>');
    objects[descriptor - 1] = Buffer.from('<< /Type /FontDescriptor /FontName /DejaVuSans /Flags 32 /FontBBox [-1100 -500 2000 1500] /ItalicAngle 0 /Ascent 928 /Descent -236 /CapHeight 729 /StemV 80 /FontFile2 ' + fontFile + ' 0 R >>');
    objects[cidFont - 1] = Buffer.from('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DejaVuSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ' + descriptor + ' 0 R /CIDToGIDMap ' + cidMapId + ' 0 R /W [0 [' + widths.join(' ') + ']] >>');
    objects[0] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>');
    objects[1] = Buffer.from('<< /Type /Pages /Count ' + pages.length + ' /Kids [' + pages.map(p => p + ' 0 R').join(' ') + '] >>');
    const chunks = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'binary')], offsets = [0];
    let offset = chunks[0].length;
    objects.forEach((b, i) => { offsets.push(offset); const obj = Buffer.concat([Buffer.from((i + 1) + ' 0 obj\n'), b, Buffer.from('\nendobj\n')]); chunks.push(obj); offset += obj.length; });
    const xref = offset;
    chunks.push(Buffer.from('xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n' + offsets.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n'));
    const output = Buffer.concat(chunks);
    if (output.length > 33554432)
        throw new AppError(413, 'FILE_LIMIT_EXCEEDED');
    return output;
}
export function exportReport(format, s) { if (s.totalRows !== s.rows.length || s.rows.length > 50000)
    throw new AppError(413, 'FILE_LIMIT_EXCEEDED'); const t = performance.now(), bytes = format === 'CSV' ? exportCsv(s) : format === 'XLSX' ? exportXlsx(s) : format === 'PDF' ? exportPdf(s) : (() => { throw new AppError(422, 'INPUT_INVALID'); })(); if (performance.now() - t > 60000)
    throw new AppError(503, 'FILE_BUDGET_EXCEEDED'); return bytes; }
//# sourceMappingURL=formats.js.map