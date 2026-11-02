import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { s13Profile, world } from './fixture.js';
import { nativeLoan } from './native-seed.js';
import { today } from '../../src/modules/obligations/calendar.js';
test('ordinary S5 disbursement without historical opening interest remains capturable', { timeout: 120000 }, async () => { const group = await s13Profile(); try {
    const f = await world(group), loan = await nativeLoan(f), before = await f.runtime.finance.journals.countDocuments(), base = await f.runtime.simulation.execute(f.a.issued.context, 'captureBaseBusinessSimulation', { asOf: today(f.now()), currency: 'COP' }, { organizationId: f.org }, {}, randomUUID());
    assert.equal(base.status, 201);
    assert.equal(base.data['cashBook'].value, '19999500.00');
    assert.equal(await f.runtime.finance.journals.countDocuments(), before);
    assert.ok(loan.sourceKey);
}
finally {
    await group.dispose();
} });
//# sourceMappingURL=native.test.js.map