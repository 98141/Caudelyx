import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { paymentContract, paymentClasses } from '../../src/modules/payments/contract.js';
import { purposeClass, WORK_PURPOSES, BALANCE_PURPOSES, SECURITY_PURPOSES } from '../../src/modules/sessions/work-policy.js';
test('closed S06 purposes retain all39 MEJ classes; unknown purposes never grant', () => {
    assert.equal(WORK_PURPOSES.length + BALANCE_PURPOSES.length + SECURITY_PURPOSES.length, 39);
    assert.equal(Object.keys(paymentClasses).length, 16);
    for (const p of WORK_PURPOSES)
        assert.equal(purposeClass(p), 'WORK_ONLY');
    for (const p of BALANCE_PURPOSES)
        assert.equal(purposeClass(p), 'BALANCE_60M');
    for (const p of SECURITY_PURPOSES)
        assert.equal(purposeClass(p), 'SECURITY_ONE_SHOT');
    for (const [p, c] of Object.entries(paymentClasses))
        assert.equal(purposeClass(p), c);
    assert.equal(purposeClass('PAYMENT_ALL'), null);
});
test('money is exact, schemas close additional fields and errors map to their HTTP status', () => {
    const c = paymentContract();
    for (const value of ['0.00', '1e3', '-1.00', '1.001', 1, NaN])
        assert.throws(() => c.validate('PositiveMoney', value));
    c.validate('PositiveMoney', '300000.00');
    const id = '11111111-1111-4111-8111-111111111111';
    c.validate('Error403', { error: { code: 'ACCESS_DENIED' }, requestId: id });
    assert.throws(() => c.validate('Error403', { error: { code: 'STATE_CONFLICT' }, requestId: id }));
    assert.throws(() => c.validate('ReasonInput', { resourceETag: '"x:1"', reason: 'SYN', supportReference: 'SYN', approved: true }));
});
test('approved documentary amounts form balanced exact oracles, including held cash and zero repost on reconciliation', () => {
    const doc = JSON.parse(readFileSync('../../Construccion/Sprints/S06/Contratos/REFERENCE_CASES_S06.json', 'utf8'));
    const n = (s) => BigInt(s.replace('.', ''));
    for (const c of doc.cases)
        assert.equal(c.postings.reduce((v, l) => v + n(l.debit) - n(l.credit), 0n), 0n, c.id);
    const recon = doc.cases.find(c => c.id === 'RC07');
    assert.deepEqual(recon.before, recon.after);
    assert.equal(recon.postings.length, 0);
});
//# sourceMappingURL=unit.test.js.map