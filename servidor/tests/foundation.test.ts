import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/shared/config.js';
import { Database } from '../src/shared/database.js';
import { AuditWriter } from '../src/shared/audit.js';
import { startReplicaSet } from './helpers/replica-set.js';

test('configuration refuses remote database, production and same platform host', () => {
  const env = { CAUDELYX_MODE: 'local-synthetic', MONGODB_URI: 'mongodb://127.0.0.1:27017/?replicaSet=test' };
  assert.equal(loadConfig(env).databaseName, 'caudelyx_synthetic');
  assert.throws(() => loadConfig({ ...env, CAUDELYX_MODE: 'production' }));
  assert.throws(() => loadConfig({ ...env, MONGODB_URI: 'mongodb://remote.invalid:27017/?replicaSet=test' }));
  assert.throws(() => loadConfig({ ...env, PLATFORM_ORIGIN: 'https://localhost:4444' }));
  assert.throws(() => loadConfig({ ...env, MONGODB_URI: 'mongodb://127.0.0.1:27017/' }));
});

test('unimplemented authentication fails closed over real HTTP, no secrets/stack', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/auth/login`, {
      method: 'POST', body: JSON.stringify({ password: 'synthetic-only-not-a-real-password' }),
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-powered-by'), null);
    const body = await response.text(); assert.ok(!body.includes('password')); assert.ok(!body.includes('stack'));
    assert.equal(JSON.parse(body).error.code, 'SERVICE_UNAVAILABLE');
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});

test('real replica set atomically commits domain + audit + outbox, rolls back failures', { timeout: 90000 }, async () => {
  const replica = await startReplicaSet();
  const db = new Database(replica.uri, 'caudelyx_foundation');
  try {
    await db.connect(); const audit = new AuditWriter(db);
    await db.db.createCollection('synthetic_subjects');
    const event = { action: 'SYNTHETIC_TEST', realm: 'TENANT' as const, actorId: 'actor_synthetic', subjectId: 'subject_synthetic', outcome: 'SUCCESS' as const };
    await db.transaction(async session => {
      await db.db.collection('synthetic_subjects').insertOne({ name: 'synthetic' }, { session });
      await audit.append(event, session);
    });
    assert.equal(await db.db.collection('synthetic_subjects').countDocuments(), 1);
    assert.equal(await db.db.collection('audit_events').countDocuments(), 1);
    assert.equal(await db.db.collection('outbox').countDocuments(), 1);
    // Real server validator denies audit writes, so the domain write must roll back too.
    await db.db.command({ collMod: 'audit_events', validator: { action: { $eq: 'DENY_ALL' } }, validationLevel: 'strict' });
    await assert.rejects(db.transaction(async session => {
      await db.db.collection('synthetic_subjects').insertOne({ name: 'must-rollback' }, { session });
      await audit.append(event, session);
    }));
    assert.equal(await db.db.collection('synthetic_subjects').countDocuments(), 1);
    assert.equal(await db.db.collection('outbox').countDocuments(), 1);
    const stored = await db.db.collection('audit_events').findOne(); assert.ok(stored);
    assert.deepEqual(Object.keys(stored).sort(), ['_id', 'eventId', 'action', 'realm', 'subjectId', 'actorId', 'outcome', 'createdAt'].sort());
  } finally { await db.close(); await replica.stop(); }
});
