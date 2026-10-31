/* eslint-disable security/detect-non-literal-fs-filename -- Synthetic tests use fixed fixture contracts, pinned workbook markup and registered own UUID filesystem roots; destructive leaves require owner/realpath checks. No HTTP-supplied paths or executable text. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exchangeContract, dictionary, templateDownloads } from '../../src/modules/exchange/contract.js';
import { normalizeWorkbook } from '../../src/modules/exchange/normalizer.js';
import { parseWorkbook } from '../../src/modules/exchange/workbook.js';
test('approved S11 contract closes operations/purposes and all positive/negative forms', () => {
    const c = exchangeContract(), examples = JSON.parse(readFileSync('../../Construccion/Sprints/S11/Contratos/EXAMPLES_S11.json', 'utf8'));
    assert.equal(c.operations.size, 45);
    assert.equal(Object.keys(c.document['x-purposes']).length, 8);
    assert.equal(dictionary().sheets.length, 13);
    for (const x of examples.requests)
        c.validate(x.operationId, x.value);
    for (const x of examples.domainCommands)
        c.validate('DomainCommand', x);
    for (const x of examples.negatives)
        assert.equal(c.valid(x.schema, x.value), false, x.schema);
    assert.equal(c.valid('CreatePersonalImport', { label: 'Sintético', namespace: 'SYN', mode: 'OPENING', templateVersion: '1.0.0', mappingVersion: 'S11-MAP-1' }), false);
});
test('normalizes actual 600 opening and 200M acquisition, preserving one effect and rejecting 0.01 difference', () => {
    const scope = { kind: 'BUSINESS', bookId: '00000001-1111-4111-8111-111111111111', ownerId: '00000001-1111-4111-8111-111111111111' };
    const read = (n) => parseWorkbook(readFileSync('../../Construccion/Sprints/S11/Plantillas/v1.0.0/' + n + '.xlsx'));
    const a = normalizeWorkbook(read('opening-600'), scope, { mode: 'OPENING', namespace: 'SYN-S11' });
    assert.deepEqual(a.issues, []);
    assert.equal(a.totals['assets'], '600.00');
    assert.equal(a.totals['difference'], '0.00');
    assert.equal(a.commands.length, 0);
    assert.ok(a.opening);
    const bad = normalizeWorkbook(read('negative-cases'), scope, { mode: 'OPENING', namespace: 'SYN-S11' });
    assert.ok(bad.issues.some(x => x.code === 'BALANCE_DIFFERENCE'));
    const w = normalizeWorkbook(read('wealth-200m'), scope, { mode: 'OPERATIVE', namespace: 'SYN-S11-WEALTH' });
    assert.deepEqual(w.issues, []);
    assert.equal(w.commands.length, 2);
    assert.equal(w.commands[0].payload['ownedConsideration'], '200000000.00');
});
test('fixed approved templates are delivered with actual bytes, closed schema and exact hash', () => {
    const all = templateDownloads();
    assert.equal(all.length, 4);
    assert.equal(templateDownloads(true).length, 1);
    for (const row of all) {
        exchangeContract().validate('TemplateDownload', row);
        assert.deepEqual(Buffer.from(String(row['contentBase64']), 'base64'), readFileSync('../../Construccion/Sprints/S11/Plantillas/v1.0.0/' + String(row['filename'])));
    }
});
//# sourceMappingURL=preflight.test.js.map