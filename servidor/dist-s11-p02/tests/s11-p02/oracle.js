/* eslint-disable security/detect-unsafe-regex -- Synthetic tests use fixed fixture contracts, pinned workbook markup and registered own UUID filesystem roots; destructive leaves require owner/realpath checks. No HTTP-supplied paths or executable text. */
import { readFileSync } from 'node:fs';
import { dictionary } from '../../src/modules/exchange/contract.js';
import { readZip, writeZip } from '../../src/modules/exchange/zip.js';
import { columnName } from '../../src/modules/exchange/workbook.js';
import { xmlEscape } from '../../src/modules/exchange/xml.js';
export function workbook(mode, namespace, rows, control = {}) {
    const parts = readZip(readFileSync('../../Construccion/Sprints/S11/Plantillas/v1.0.0/caudelyx-import-template.xlsx'));
    const controls = { templateVersion: '1.0.0', mappingVersion: 'S11-MAP-1', mode, namespace, currency: 'COP', timezone: 'America/Bogota', ...control };
    const data = { ...rows, Control: Object.entries(controls).map(([key, value]) => ({ key, value })) };
    for (const [i, sheet] of dictionary().sheets.entries()) {
        const records = [Object.fromEntries(sheet.columns.map(c => [c.name, c.name])), ...(data[sheet.name] ?? [])];
        const body = records.map((r, row) => '<x:row r="' + (row + 1) + '">' + sheet.columns.flatMap((c, col) => { const value = r[c.name]; if (value === undefined)
            return []; const address = columnName(col + 1) + (row + 1); return typeof value === 'number' ? ['<x:c r="' + address + '"><x:v>' + value + '</x:v></x:c>'] : ['<x:c r="' + address + '" t="inlineStr"><x:is><x:t xml:space="preserve">' + xmlEscape(String(value)) + '</x:t></x:is></x:c>']; }).join('') + '</x:row>').join(''), name = 'xl/worksheets/sheet' + (i + 1) + '.xml', xml = parts.get(name).toString('utf8');
        if (!/<x:sheetData(?:\s[^>]*)?>[\s\S]*?<\/x:sheetData>/.test(xml))
            throw Error('Independent fixture template structure changed');
        parts.set(name, Buffer.from(xml.replace(/<x:sheetData(?:\s[^>]*)?>[\s\S]*?<\/x:sheetData>/, '<x:sheetData>' + body + '</x:sheetData>')));
    }
    return writeZip(parts);
}
// Separate integer-decimal oracle: it never calls the product money/ledger engine.
export function decimal(value) { if (!/^-?(0|[1-9][0-9]*)\.[0-9]{2}$/.test(value))
    throw Error('Noncanonical oracle amount'); return BigInt(value.replace('.', '')); }
export function formatted(value) { return (value < 0n ? '-' : '') + (value < 0n ? -value : value) / 100n + '.' + String((value < 0n ? -value : value) % 100n).padStart(2, '0'); }
//# sourceMappingURL=oracle.js.map