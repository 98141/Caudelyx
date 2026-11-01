/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection -- Own S12-P05 evidence paths and own synthetic corpus only. */
// S12-P05 (Claude): independent re-validation of H-S11-P05-02 (PDF Unicode representation) and H-S11-P05-03 (extra-header cell).
// Files are decoded by readers.py (Python stdlib + pypdf); expectations written from S11_FIXES_DELTA_S12 before running.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { exportReport } from '../../src/modules/exchange/formats.js';
import { parseWorkbook } from '../../src/modules/exchange/workbook.js';
import { parts, zip, sheetIndex, columnsOf, col } from './book.js';
const EV = '../../Construccion/Sprints/S12/Evidencias/', OUT = EV + 'S12-P05-DOWNLOADS';
const checks = {};
const cell = (columnId, type, value, unit = 'NONE') => ({ columnId, type, unit, value, status: value === null ? 'UNAVAILABLE' : 'COMPLETE', reason: value === null ? 'SOURCE_UNAVAILABLE' : 'NONE' });
const snapshot = (names) => ({ reportKind: 'PORTFOLIO', meta: { cut: { asOf: '2026-10-31' }, coverage: 'COMPLETE' }, totalRows: names.length, sourceDigest: 'x', binding: 'y',
    rows: names.map((n, i) => ({ id: randomUUID(), sourceRefs: [], cells: [cell('loanId', 'TEXT', 'P05-H02-' + i), cell('borrowerCode', 'TEXT', 'B' + i), cell('borrowerName', 'TEXT', n), cell('principal', 'MONEY', i % 2 ? '100.01' : '0.10', 'COP'), cell('overduePrincipal', 'MONEY', '0.00', 'COP'), cell('overdueInterest', 'MONEY', null, 'COP'), cell('dpd', 'COUNT', i, 'COUNT'), cell('origin', 'ENUM', 'S4')] })),
    totals: [cell('principal', 'MONEY', '0.00', 'COP')] });
// Own minimal cmap reader (formats 4/12) to decide independently whether the pinned font has a glyph.
function hasGlyph(font, cp) {
    const n = font.readUInt16BE(4);
    let cmap = 0;
    for (let i = 0; i < n; i++)
        if (font.toString('latin1', 12 + i * 16, 16 + i * 16) === 'cmap')
            cmap = font.readUInt32BE(20 + i * 16);
    let found = false;
    for (let i = 0; i < font.readUInt16BE(cmap + 2); i++) {
        const off = cmap + font.readUInt32BE(cmap + 8 + i * 8), fmt = font.readUInt16BE(off);
        if (fmt === 12)
            for (let g = 0; g < font.readUInt32BE(off + 12); g++) {
                const b = off + 16 + g * 12;
                if (cp >= font.readUInt32BE(b) && cp <= font.readUInt32BE(b + 4))
                    found = true;
            }
        if (fmt === 4 && cp <= 0xFFFF) {
            const segX2 = font.readUInt16BE(off + 6);
            for (let k = 0; k < segX2 / 2; k++) {
                const end = font.readUInt16BE(off + 14 + k * 2), start = font.readUInt16BE(off + 16 + segX2 + k * 2);
                if (cp >= start && cp <= end && end !== 0xFFFF)
                    found = true;
            }
        }
    }
    return found;
}
const issuesOf = (b) => { try {
    return parseWorkbook(b).issues.map(i => ({ cell: `${i.sheet}!${i.cell}`, code: i.code, severity: i.severity, expectedType: i.expectedType }));
}
catch (e) {
    return [{ code: e.code ?? String(e), status: e.status }];
} };
test('S12-P05 fixes H02/H03 against own corpus and independent readers', async (t) => {
    mkdirSync(OUT, { recursive: true });
    try {
        await t.test('H02 PDF_ESCAPED_UNICODE_V1: 李/control/emoji/backslash/tab/CR visible as escapes, money intact, CSV/XLSX keep originals', () => {
            const names = ['李小龙', 'Ana\u0001B', 'Ana 😀', 'literal \\u{674E}', 'tab\tX', 'cr\rY', 'Ñandú Pérez', 'línea1\nlínea2', '李'.repeat(140), 'zw​j'];
            // Own expected escapes (DejaVuSans has no CJK/emoji glyphs; C0 and Cf are escaped; backslash doubled; LF structural).
            const expectVisible = ['\\u{674E}\\u{5C0F}\\u{9F99}', 'Ana\\u{0001}B', 'Ana \\u{1F600}', 'literal \\\\u{674E}', 'tab\\u{0009}X', 'cr\\u{000D}Y', 'Ñandú Pérez', 'zw\\u{200B}j'];
            const font = readFileSync('src/modules/exchange/assets/DejaVuSans.ttf'), emojiGlyph = hasGlyph(font, 0x1F600), cjkGlyph = hasGlyph(font, 0x674E);
            if (emojiGlyph)
                expectVisible[2] = 'Ana 😀';
            const expectCount = 3 + 1 + (emojiGlyph ? 0 : 1) + 1 + 1 + 1 + 0 + 0 + 140 + 1;
            const s = snapshot(names), files = {};
            for (const f of ['CSV', 'XLSX', 'PDF']) {
                const path = `${OUT}/h02-unicode.${f.toLowerCase()}`;
                writeFileSync(path, exportReport(f, s));
                files[f] = path;
            }
            const r = JSON.parse(execFileSync('python', ['-I', 'tests/s12-p05/readers.py', files['CSV'], files['XLSX'], files['PDF']], { encoding: 'utf8', maxBuffer: 64 << 20 }));
            const pdf = r.pdf.text.join('\n'), flat = pdf.replace(/\s+/g, '');
            const header = /caracteres escapados (\d+)/.exec(pdf);
            const csvNames = r.csv.rows.filter(x => x[0] === 'ROW').map(x => x[r.csv.rows[0].indexOf('borrowerName')]);
            const xlsxRows = r.xlsx.sheets['Datos'].filter(x => x[0] === 'ROW'), xh = r.xlsx.sheets['Datos'][0], xlsxNames = xlsxRows.map(x => x[xh.indexOf('borrowerName')]);
            const escapes674E = (pdf.match(/\\u\{674E\}/g) ?? []).length, splitEscapes = (pdf.match(/\\u\{[0-9A-F]{0,5}\n|\\u\n|\\\n/g) ?? []).length;
            checks['H02'] = { pages: r.pdf.pages, header: header?.[0], expectedCount: expectCount, visible: Object.fromEntries(expectVisible.map(v => [v, flat.includes(v.replace(/\s+/g, ''))])), ownCmap: { emojiU1F600: emojiGlyph, cjkU674E: cjkGlyph }, escapes674E, splitEscapes, activeTokens: r.pdf.activeTokens, csvNames: csvNames.slice(0, 8), xlsxNames: xlsxNames.slice(0, 8), principalInPdf: flat.includes('100.01') };
            assert.equal(Number(header?.[1]), expectCount, 'escapedScalarCount = own count of transformed original scalars');
            for (const v of expectVisible)
                assert.ok(flat.includes(v.replace(/\s+/g, '')), 'visible in PDF: ' + v);
            assert.equal(cjkGlyph, false);
            assert.equal(escapes674E, 1 + 140 + 1, 'name + 140-long name + the doubled-backslash literal; all CJK scalars of the long name escaped; wrapping/page breaks keep escapes whole');
            assert.equal(splitEscapes, 0, 'no escape split across a line');
            assert.deepEqual(r.pdf.activeTokens, []);
            assert.ok(flat.includes('100.01') && flat.includes('0.10'));
            assert.equal(csvNames[0], '李小龙');
            assert.equal(csvNames[2], 'Ana 😀');
            assert.equal(xlsxNames[0], '李小龙');
        });
        await t.test('H02 unrepresentable text (lone surrogate) fails 422 with code, no partial file and no PII', () => {
            const secret = 'Prestatario-' + randomUUID();
            let observed = {};
            try {
                const b = exportReport('PDF', snapshot([secret + '\uD800']));
                observed = { ok: true, bytes: b.length };
            }
            catch (e) {
                observed = { status: e.status, code: e.code, leaks: JSON.stringify(e).includes(secret) || String(e).includes(secret) };
            }
            checks['H02-surrogate'] = observed;
            assert.equal(observed['status'], 422);
            assert.equal(observed['code'], 'REPORT_TEXT_UNREPRESENTABLE');
            assert.equal(observed['leaks'], false);
        });
        await t.test('H03 data right of the last header column is an ERROR per cell (0/false/space/text), empty and style-only cells ignored', () => {
            const cols = columnsOf('Cuentas'), extra = col(cols.length + 1), sheet = `xl/worksheets/sheet${sheetIndex('Cuentas')}.xml`;
            const row = { externalKey: 'K1', action: 'CREATE', code: 'P05_H03', name: 'Cuenta H03', accountClass: 'ASSET', kind: 'BANK', currency: 'COP' };
            const variants = { text: `<c r="${extra}2" t="inlineStr"><is><t>dato</t></is></c>`, zero: `<c r="${extra}2"><v>0</v></c>`, false: `<c r="${extra}2" t="b"><v>0</v></c>`, space: `<c r="${extra}2" t="inlineStr"><is><t xml:space="preserve"> </t></is></c>`, emptyString: `<c r="${extra}2" t="inlineStr"><is><t></t></is></c>`, styleOnly: `<c r="${extra}2" s="0"/>`, far: `<c r="XFD2" t="inlineStr"><is><t>lejos</t></is></c>` };
            const want = { text: true, zero: true, false: true, space: true, emptyString: false, styleOnly: false, far: false };
            const out = {};
            for (const [k, x] of Object.entries(variants)) {
                const m = parts('OPERATIVE', 'SYN-P05-H03', { Cuentas: [row] }), xml = m.get(sheet).toString('utf8'), mutated = xml.replace('</row></sheetData>', x + '</row></sheetData>');
                assert.notEqual(mutated, xml);
                m.set(sheet, Buffer.from(mutated));
                const issues = issuesOf(zip(m));
                if (k === 'far') {
                    out[k] = issues;
                    assert.ok(issues.length === 1 && issues[0].status === 422, 'XFD column stays rejected by file bounds, never silently dropped');
                    continue;
                }
                const extraIssues = issues.filter(i => i.code === 'EXTRA_HEADER_CELL');
                out[k] = issues;
                assert.equal(extraIssues.length > 0, want[k], k + ' ' + JSON.stringify(issues));
                if (want[k])
                    assert.ok(extraIssues.every(i => i.severity === 'ERROR' && i.expectedType === 'EMPTY'), k);
            }
            const clean = issuesOf(zip(parts('OPERATIVE', 'SYN-P05-H03', { Cuentas: [row] })));
            checks['H03'] = { extraColumn: extra, variants: out, cleanControl: clean };
            assert.deepEqual(clean, []);
        });
    }
    finally {
        writeFileSync(EV + 'S12-P05-CHECKS-FIXES.json', JSON.stringify({ task: 'S12-P05', suite: 'fixes', at: new Date().toISOString(), checks }, null, 1) + '\n');
    }
});
//# sourceMappingURL=fixes.test.js.map