import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { Database } from '../src/shared/database.js';
import { createApp } from '../src/app.js';
import { Sessions } from '../src/modules/sessions/service.js';
import { IdentityService } from '../src/modules/identity/service.js';
import { SyntheticMessaging } from '../src/modules/messaging/service.js';
import { PasswordHasher } from '../src/modules/identity/password.js';
import { startReplicaSet } from './helpers/replica-set.js';
import { testCertificate } from './helpers/tls.js';
import { ApiClient } from './helpers/client.js';

test('HTTPS identity routes enforce host/CSRF, rotate pre-cookie and never grant password-only S', { timeout: 120000 }, async () => {
  const replica = await startReplicaSet(), db = new Database(replica.uri, 'caudelyx_http');
  const tls = await testCertificate();
  const config = { mongoUri: replica.uri, databaseName: 'caudelyx_http', port: 0,
    tenantOrigin: 'https://localhost:0', platformOrigin: 'https://127.0.0.1:0' };
  try {
    await db.connect();
    const sessions = new Sessions(db), messages = new SyntheticMessaging(db, randomBytes(32), Date.now);
    const identity = new IdentityService(db, sessions, messages, new PasswordHasher(), () => true);
    await identity.initialize();
    const server = createServer(tls, createApp({ identity, config })).listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address(); assert.ok(address && typeof address !== 'string');
      config.tenantOrigin = `https://localhost:${address.port}`; config.platformOrigin = `https://127.0.0.1:${address.port}`;
      const client = new ApiClient(address.port, tls.cert);
      const anonymous = await client.refreshCsrf();
      assert.ok(anonymous.headers['set-cookie']?.every(value => value.includes('Secure') && value.includes('HttpOnly') && !value.includes('Domain=')));
      const registration = { email: 'http_synthetic@example.test', displayName: 'Sintético', privacyPolicyVersion: 'synthetic-v1', acceptTerms: true };
      assert.equal((await client.call('POST', '/api/v1/auth/register', registration, { Origin: 'https://evil.invalid' })).status, 400);
      assert.equal((await client.call('POST', '/api/v1/auth/register', { ...registration, password: 'not-allowed' })).status, 422);
      assert.equal((await client.call('POST', '/api/v1/auth/register', registration)).status, 202);
      await identity.dispatchMail(); const mail = [...messages.inbox.values()][0]; assert.ok(mail);
      const before = client.cookies.get('__Host-caudelyx-pre');
      assert.equal((await client.call('POST', '/api/v1/auth/email-verifications/confirm', {
        purpose: 'ACTIVATION', token: mail.token, newPassword: 'a secure synthetic phrase 998877',
      })).status, 200);
      assert.notEqual(client.cookies.get('__Host-caudelyx-pre'), before);
      assert.equal(client.cookies.has('__Host-caudelyx-session'), false);
      await client.refreshCsrf();
      assert.equal((await client.call('GET', '/api/v1/auth/me')).body.data?.['authState'], 'MFA_ENROLLMENT');
      assert.equal((await client.call('POST', '/api/v1/auth/login', {
        email: registration.email, password: 'a secure synthetic phrase 998877',
      })).status, 200);
      await client.refreshCsrf();
      assert.equal(client.cookies.has('__Host-caudelyx-session'), false);
      assert.equal((await client.call('POST', '/api/v1/organizations', {})).status, 503);
      const platform = new ApiClient(address.port, tls.cert, '127.0.0.1'); await platform.refreshCsrf();
      assert.equal((await platform.call('POST', '/api/v1/auth/register', registration)).status, 403);
      assert.equal((await client.call('POST', '/api/v1/auth/logout')).status, 204);
      assert.equal((await client.call('GET', '/api/v1/auth/me')).status, 401);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  } finally { await db.close(); await replica.stop(); }
});
