import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { cents, money, fraction, portion } from '../../src/modules/simulation/money.js';
import { normalizeHypotheses } from '../../src/modules/simulation/contract.js';
test('approved P01 remains immutable; new engine money is exact and canonical', async () => {
    const current = await readFile('../../Construccion/Sprints/S13/Evidencias/S13-P01-HASHES.json');
    assert.equal(createHash('sha256').update(current).digest('hex'), '040fb07aba6f396c27b5491f51d461e9eec9da4c7ee007325caa884a34f72f27');
    const api = await readFile('../../Construccion/Sprints/S13/Contratos/openapi-simulation-alerts-s13-p01.json');
    assert.equal(createHash('sha256').update(api).digest('hex'), '9d73fa2cc8a78c05b5b0780676d35750c64c8eafa5398fa18a248b438b299dc7');
    const root = '../../Construccion/Sprints/S12/';
    const raw = await readFile(root + 'Evidencias/S12-P01-HASHES.json');
    assert.equal(createHash('sha256').update(raw).digest('hex'), 'bd77e30ba6c3392acc61d666065a8e6b84429cf8cc75f7bddd468942b7469e8b');
    assert.equal(money(cents('9999999999999999.99')), '9999999999999999.99');
    assert.equal(fraction('0.5'), 500000n);
    assert.equal(portion(1n, '0.5'), 1n);
    assert.throws(() => cents('-0.00'));
    assert.throws(() => fraction('1.000001'));
    assert.throws(() => money(1000000000000000000n));
});
test('fractions canonicalize to six decimal places before stored definition and replay fingerprint', () => {
    assert.deepEqual(normalizeHypotheses({ assumptions: [{ collectionFraction: '0.5', recoveryFraction: '1' }], alternatives: [{ ownershipFraction: '0.4', vacancyFraction: '0' }] }), { assumptions: [{ collectionFraction: '0.500000', recoveryFraction: '1.000000' }], alternatives: [{ ownershipFraction: '0.400000', vacancyFraction: '0.000000' }] });
});
//# sourceMappingURL=preflight.test.js.map