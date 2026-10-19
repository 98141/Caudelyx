import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { PasswordHasher } from '../../src/modules/identity/password.js';
import { Database } from '../../src/shared/database.js';
import { Sessions } from '../../src/modules/sessions/service.js';
import { fixture } from '../helpers/fixture.js';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { createApp } from '../../src/app.js';
import { attachRuntime } from '../../src/shared/runtime.js';
import { FrozenContract } from '../../src/shared/contract.js';
import { testCertificate } from '../helpers/tls.js';
import { ApiClient } from '../helpers/client.js';
import { randomBytes } from 'node:crypto';

test('P04 Argon2id load: salted hashes, no truncation, compromised/context values denied and bounded overflow', { timeout: 120000 }, async () => {
  const hasher = new PasswordHasher(); await hasher.initialize();
  const password = 'synthetic P04 unique long password 987654321';
  hasher.validate(password);
  assert.throws(() => hasher.validate('passwordpassword'));
  assert.throws(() => hasher.validate('synthetic-company', ['synthetic-company']));
  const start = performance.now();
  const outcomes = await Promise.allSettled(Array.from({ length: 14 }, () => hasher.hash(password)));
  const hashes = outcomes.filter(r => r.status === 'fulfilled').map(r => r.value);
  assert.equal(hashes.length, 10);
  assert.equal(new Set(hashes).size, 10);
  assert.ok(hashes.every(h => h.split('$')[1] === 'argon2id' && h.split('$')[2] === 'v=19'
    && h.split('$')[3]?.split(',').sort().join(',') === 'm=65536,p=1,t=3'));
  assert.equal(await hasher.verify(hashes[0]!, password + 'different-suffix'), false);
  assert.equal(await hasher.verify(hashes[0]!, password), true);
  console.log(JSON.stringify({ evidence: 'P04-argon2-load', requested: 14, admitted: 10, overflow503: outcomes.length - hashes.length, elapsedMs: Math.round(performance.now() - start), scope: 'local synthetic sample, not capacity benchmark' }));
});

test('P04 real HTTPS realm matrix: every forbidden PLATFORM operation returns403 before schema/auth; anonymous CSRF works in both realms', { timeout: 120000 }, async () => {
  const f = await fixture(), tls = await testCertificate();
  const config = { mongoUri: f.uri, databaseName: f.database.db.databaseName, port: 0, tenantOrigin: 'https://localhost:0', platformOrigin: 'https://platform.localhost:0' };
  await attachRuntime(f.identity, { version: 1, mail: f.mailKey, totp: f.totpKey, journal: randomBytes(32), cursor: randomBytes(32) }, config);
  const server = createServer(tls, createApp({ identity: f.identity, config })).listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const a = server.address(); assert.ok(a && typeof a !== 'string');
    config.tenantOrigin = `https://localhost:${a.port}`; config.platformOrigin = `https://platform.localhost:${a.port}`;
    const platform = new ApiClient(a.port, tls.cert, 'platform.localhost'), tenant = new ApiClient(a.port, tls.cert);
    assert.equal((await platform.refreshCsrf()).status, 200);
    assert.equal((await tenant.refreshCsrf()).status, 200);
    const allowed = new Set(['A01', 'A05', 'A06', 'A07', 'A20', 'A21', 'A24', 'A25', 'A26', 'A27', 'A28', 'A29', 'A32', 'A33', 'A34', 'A35']);
    let denied = 0;
    for (const [id, op] of new FrozenContract().operations) {
      if (allowed.has(id)) continue;
      const route = '/api/v1' + op.path.replace(/\{[^}]+\}/g, '00000000-0000-4000-8000-000000000001');
      const response = await platform.call(op.method.toUpperCase(), route, ['get', 'delete'].includes(op.method) ? undefined : {});
      assert.equal(response.status, 403, id);
      denied++;
    }
    assert.equal(denied, 22);
    for (const [name, value] of platform.cookies) tenant.cookies.set(name, value);
    assert.equal((await tenant.call('GET', '/api/v1/auth/me')).status, 401);
    console.log(JSON.stringify({ evidence: 'P04-realm-matrix', forbiddenPlatformOperations: denied, anonymousCsrfBothRealms: true, platformCookieOpensTenant: false }));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});

test('P04 two Mongo connections share source limiter; other sources and existing sessions survive attacker saturation', { timeout: 120000 }, async () => {
  const f = await fixture(), other = new Database(f.uri, f.database.db.databaseName);
  await other.connect();
  try {
    const sessions = new Sessions(other, f.now);
    const key = 'p04-synthetic-source';
    for (let n = 0; n < 5; n++) await f.sessions.enforceSourceLimit(key, 5, 60000, true);
    await assert.rejects(sessions.enforceSourceLimit(key, 5, 60000, false));
    await sessions.enforceSourceLimit('p04-other-source', 5, 60000, false);
    assert.ok(await f.sessions.find(f.initial.token, 'TENANT'));
    f.clock.value += 60000;
    await sessions.enforceSourceLimit(key, 5, 60000, false);
    console.log('P04 distributed source limit exact expiry: denied saturated source, independent source/session preserved.');
  } finally { await other.close(); await f.close(); }
});
