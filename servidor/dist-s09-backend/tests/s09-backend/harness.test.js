import { test } from 'node:test';
import assert from 'node:assert/strict';
import { s09Profile, assertOwnUri } from './profile.js';
test('S09 actual Mongo fixture: active lease refused, protected URI refused, partial setup closes consumer and safely reuses one group', { timeout: 120000 }, async () => { const group = await s09Profile(); try {
    await group.fixture();
    const release = group.hold();
    try {
        await assert.rejects(() => group.fixture(), /lease|active|Active/);
    }
    finally {
        release();
    }
    assert.throws(() => assertOwnUri('mongodb://127.0.0.1:27181/?replicaSet=rs0'));
    await assert.rejects(() => group.fixture({ failSetup: true }), /Injected own partial setup/);
    const recovered = await group.fixture();
    assert.equal(recovered.database.db.databaseName, group.names[0]);
    assert.equal((await recovered.database.db.command({ ping: 1 }))['ok'], 1);
    console.log('S09_HARNESS_PASS same group / real partial setup consumer closed / active lease / protected URI');
}
finally {
    await group.dispose();
} });
//# sourceMappingURL=harness.test.js.map