import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isolated } from '../../src/modules/exchange/process.js';
import { workbook } from './oracle.js';
test('three cold isolated workers retain the approved ten second /256MiB budget for200informational rows', { timeout: 60000 }, async () => {
    const file = '../../Construccion/Sprints/S11/Evidencias/S11-P04-COLD-WORKER.json', prior = await readFile(file, 'utf8').then(JSON.parse, () => null), runs = [], contractSHA256 = createHash('sha256').update(await readFile('src/modules/exchange/contract.ts')).digest('hex'), date = '2026-10-30';
    try {
        for (let i = 0; i < 3; i++) {
            const start = performance.now();
            try {
                const out = await isolated({ kind: 'PARSE', bytes: workbook('INFORMATIONAL', 'COLD_INFO', { Antecedentes: Array.from({ length: 200 }, (_, i) => ({ externalKey: 'PAST_' + i, date, description: 'Antecedente sintético no monetario', supportKeys: 'SYN' })), Soportes: [{ externalKey: 'SYN', reference: 'Soporte sintético de antecedente', asOfDate: date, declaration: 'DECLARED' }] }), scope: { kind: 'BUSINESS', bookId: '11111111-1111-4111-8111-111111111111', ownerId: '11111111-1111-4111-8111-111111111111', organizationId: '11111111-1111-4111-8111-111111111111' }, mode: 'INFORMATIONAL', namespace: 'COLD_INFO' }, async () => undefined);
                assert.equal(out.value.informationals.length, 200);
                assert.deepEqual(out.value.issues, []);
                runs.push({ sample: i + 1, wallMs: performance.now() - start, ...out.metrics, result: 'PASS' });
            }
            catch (e) {
                runs.push({ sample: i + 1, wallMs: performance.now() - start, result: 'FAIL', error: String(e) });
                throw e;
            }
        }
    }
    finally {
        await writeFile(file, JSON.stringify({ contractSHA256, budget: { deadlineMs: 10000, RSSBytes: 268435456 }, runs, prior }, null, 2) + '\n');
    }
});
//# sourceMappingURL=cold.test.js.map