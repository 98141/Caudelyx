/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection -- Own S11-P05 evidence paths and own synthetic maps only. */
// S11-P05 (Claude): exporter under test fed with an own synthetic snapshot; files decoded by readers.py (Python stdlib + pypdf).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {exportReport} from '../../src/modules/exchange/formats.js';
import type {SnapshotData, ReportCell} from '../../src/modules/exchange/models.js';
import {cents, money} from './book.js';

const OUT = '../../Construccion/Sprints/S11/Evidencias/S11-P05-DOWNLOADS';
const texts = ['=1+1', '+57 300 000', '-2+3', '@SUM(A1)', '\t=cmd|"/c calc"!A0', '\r=x', "'ya citado", '\\N', 'Dijo "hola", fin', 'línea1\nlínea2', ' =con espacio', 'Ñandú Pérez', ''];
const amounts = ['-150.00', '12345678901234.56', '0.01', '200.00', '99.99'];
const cell = (columnId: string, type: ReportCell['type'], value: ReportCell['value'], unit: ReportCell['unit'] = 'NONE'): ReportCell =>
  ({columnId, type, unit, value, status: value === null ? 'UNAVAILABLE' : 'COMPLETE', reason: value === null ? 'SOURCE_UNAVAILABLE' : 'NONE'});
function snapshot(rows: number, name: (i: number) => string): SnapshotData {
  const list = Array.from({length: rows}, (_, i) => ({id: randomUUID(), sourceRefs: [], cells: [
    cell('loanId', 'TEXT', 'P05-LOAN-' + i), cell('borrowerCode', 'TEXT', 'P05-B' + i), cell('borrowerName', 'TEXT', name(i)),
    cell('principal', 'MONEY', amounts[i % amounts.length]!, 'COP'), cell('overduePrincipal', 'MONEY', '0.00', 'COP'),
    cell('overdueInterest', 'MONEY', i % 4 === 0 ? null : '1.10', 'COP'), cell('dpd', 'COUNT', i % 40, 'COUNT'), cell('origin', 'ENUM', i % 2 ? 'HISTORICAL_S11' : 'S4')]}));
  const principal = list.reduce((n, r) => n + cents(String(r.cells[3]!.value)), 0n);
  return {reportKind: 'PORTFOLIO', meta: {cut: {asOf: '2026-10-31'}, coverage: 'COMPLETE', note: '=META("no")'}, rows: list, totalRows: rows,
    totals: [cell('principal', 'MONEY', money(principal), 'COP'), cell('overdueInterest', 'MONEY', null, 'COP')], sourceDigest: 'x', binding: 'y'};
}
type Read = {csv: {rows: string[][]; unprotectedDangerous: string[]}; xlsx: {sheets: Record<string, (string | number | null)[][]>; formulaParts: string[]; externalRels: string[]; activeParts: string[]};
  pdf: {pages: number; text: string[]; activeTokens: string[]; catalogKeys: string[]; header: string}};
const decode = (v: string | number | null) => typeof v !== 'string' ? v : v === '\\N' ? null : v.startsWith("'") ? v.slice(1) : v;

test('S11-P05 formats: complete set in CSV/XLSX/PDF, literal dangerous text, exact money/null, no active PDF content', () => {
  const checks: Record<string, unknown> = {}; mkdirSync(OUT, {recursive: true});
  try {
    const s = snapshot(130, i => texts[i % texts.length]!), files: Record<string, string> = {};
    for (const f of ['CSV', 'XLSX', 'PDF']) { const b = exportReport(f, s), path = `${OUT}/formats-portfolio-130.${f.toLowerCase()}`; writeFileSync(path, b); files[f] = path; checks['sha256-' + f] = createHash('sha256').update(b).digest('hex'); }
    const r = JSON.parse(execFileSync('python', ['-I', 'tests/s11-p05/readers.py', files['CSV']!, files['XLSX']!, files['PDF']!], {encoding: 'utf8', maxBuffer: 64 << 20})) as Read;
    const head = r.csv.rows[0]!, at = (c: string) => head.indexOf(c);
    const csvRows = r.csv.rows.filter(x => x[0] === 'ROW'), csvTotal = r.csv.rows.find(x => x[0] === 'TOTAL')!;
    checks['csv'] = {rows: csvRows.length, meta: r.csv.rows.filter(x => x[0] === 'META').length, unprotectedDangerous: r.csv.unprotectedDangerous};
    assert.equal(csvRows.length, 130); assert.deepEqual(r.csv.unprotectedDangerous, []);
    const datos = r.xlsx.sheets['Datos']!, xh = datos[0] as string[], xRows = datos.filter(x => x[0] === 'ROW');
    checks['xlsx'] = {rows: xRows.length, sheets: Object.keys(r.xlsx.sheets), formulaParts: r.xlsx.formulaParts, externalRels: r.xlsx.externalRels, activeParts: r.xlsx.activeParts};
    assert.equal(xRows.length, 130); assert.deepEqual(r.xlsx.formulaParts, []); assert.deepEqual(r.xlsx.externalRels, []); assert.deepEqual(r.xlsx.activeParts, []);
    let csvSum = 0n, xSum = 0n; const mismatches: unknown[] = [], crLoss: unknown[] = []; checks['observe-xlsx-cr-normalized'] = crLoss;
    s.rows.forEach((row, i) => {
      const c = csvRows[i]!, x = xRows[i]!;
      for (const k of ['loanId', 'borrowerName', 'principal', 'overdueInterest', 'dpd']) {
        const want = row.cells.find(v => v.columnId === k)!.value, gotC = decode(c[at(k)]!), gotX = decode(x[xh.indexOf(k)] ?? null);
        const norm = (v: unknown) => v === null ? null : String(v);
        // Observation O-XLSX-CR: a bare CR written raw into XML text is read back as LF (XML end-of-line normalization).
        if (typeof want === 'string' && want.includes('\r') && gotX === want.replace(/\r/g, '\n')) { crLoss.push({row: i, k}); if (norm(gotC) !== norm(want)) mismatches.push({row: i, k, want, gotC}); continue; }
        if (norm(gotC) !== norm(want) || norm(gotX) !== norm(want)) mismatches.push({row: i, k, want, gotC, gotX});
      }
      if (c[1] !== row.id || x[1] !== row.id) mismatches.push({row: i, id: row.id, c: c[1], x: x[1]});
      csvSum += cents(c[at('principal')]!); xSum += cents(String(x[xh.indexOf('principal')]));
    });
    checks['mismatches'] = mismatches; checks['sums'] = {oracle: s.totals[0]!.value, csv: money(csvSum), xlsx: money(xSum), csvTotal: csvTotal[at('principal')]};
    assert.deepEqual(mismatches, []); assert.equal(money(csvSum), s.totals[0]!.value); assert.equal(money(xSum), s.totals[0]!.value); assert.equal(csvTotal[at('principal')], s.totals[0]!.value);
    // Dangerous strings in XLSX cells are text (inlineStr) and quote-protected identically to CSV.
    const xDanger = xRows.flatMap(x => x.filter((v): v is string => typeof v === 'string' && /^[\s]*[=+\-@]/.test(v) && !/^-?[0-9]+\.[0-9]{2}$/.test(v)));
    checks['xlsxUnprotected'] = xDanger; assert.deepEqual(xDanger, []);
    const all = r.pdf.text.join('\n');
    checks['pdf'] = {pages: r.pdf.pages, activeTokens: r.pdf.activeTokens, catalogKeys: r.pdf.catalogKeys, header: r.pdf.header, missingIds: s.rows.filter(x => !all.replace(/\s/g, '').includes(x.id.replace(/-/g, '').slice(0, 8))).length, hasTotals: all.includes('Totales del conjunto'), totalShown: all.includes(String(s.totals[0]!.value))};
    assert.ok(r.pdf.pages > 1); assert.deepEqual(r.pdf.activeTokens, []); assert.deepEqual(r.pdf.catalogKeys, ['/Pages', '/Type']);
    assert.ok(all.includes('Totales del conjunto')); assert.ok(all.includes(String(s.totals[0]!.value)));
    assert.ok(all.includes('=1+1'), 'formula-like text printed literally in PDF'); assert.ok(all.includes('No disponible'), 'null printed as unavailable, not zero');
    for (const id of ['P05-LOAN-0', 'P05-LOAN-64', 'P05-LOAN-129']) assert.ok(all.includes(id), 'row on later pages present: ' + id);
    // Availability observation: characters outside the embedded font (emoji) or control chars in user-supplied text.
    for (const [label, text] of [['emoji', 'Ana 😀'], ['bell-control', 'Ana\u0007B'], ['cjk', '李小龙']] as const) {
      try { const b = exportReport('PDF', snapshot(2, () => text)); checks['pdf-' + label] = {ok: true, bytes: b.length}; }
      catch (e) { checks['pdf-' + label] = {ok: false, code: (e as {code?: string}).code, status: (e as {status?: number}).status}; }
      try { exportReport('CSV', snapshot(2, () => text)); checks['csv-' + label] = {ok: true}; } catch (e) { checks['csv-' + label] = {ok: false, code: (e as {code?: string}).code}; }
    }
  } finally {
    writeFileSync('../../Construccion/Sprints/S11/Evidencias/S11-P05-CHECKS-FORMATS.json', JSON.stringify({task: 'S11-P05', suite: 'formats', at: new Date().toISOString(), checks}, null, 1) + '\n');
  }
});
