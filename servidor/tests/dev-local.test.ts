/* eslint-disable security/detect-non-literal-fs-filename -- Only closed-profile, project-owned runtime fixture paths. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { generate } from 'otplib';
import { MongoClient } from 'mongodb';
import { ApiClient } from './helpers/client.js';
const exec = promisify(execFile);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
class ManualClient extends ApiClient {
  override async call(method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
    return await super.call(method, route, body, { Host: 'localhost:3001', Origin: 'https://localhost:3001', ...headers });
  }
}
test('DEV-001 real manual restart: register → terminal CLI → activation → TOTP → shutdown/restart → same identity/factor/login, no27017', { timeout: 180000 }, async () => {
  const profile = `test-${randomUUID()}`, control = `.runtime/manual-control-${profile}`, descriptor = `.runtime/manual-${profile}-connection.json`;
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening'); const addr = probe.address(); assert.ok(addr && typeof addr !== 'string'); const mongoPort = addr.port; await new Promise<void>(r => probe.close(() => r()));
  assert.notEqual(mongoPort, 27017);
  const env: NodeJS.ProcessEnv = { ...process.env, CAUDELYX_MODE: 'local-synthetic', CAUDELYX_DEV_TEST_PROFILE: profile, CAUDELYX_DEV_TEST_MONGO_PORT: String(mongoPort) }; delete env['MONGODB_URI'];
  let child: ChildProcess | undefined, client: MongoClient | undefined;
  const start = async () => {
    child = spawn(process.execPath, ['scripts/manual-local.mjs'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let diagnostics = ''; child.stdout?.on('data', b => { diagnostics += b.toString(); }); child.stderr?.on('data', b => { diagnostics += b.toString(); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Manual readiness timeout: ' + diagnostics)), 30000);
      child!.on('message', message => { if (message === 'LOCAL_RUNTIME_READY') { clearTimeout(timer); resolve(); } });
      child!.once('exit', () => { clearTimeout(timer); reject(new Error('Manual runtime startup failed: ' + diagnostics)); });
    });
    return new ManualClient(4001, await readFile('.runtime/tls/cert.pem'));
  };
  const stop = async () => { if (!child || child.exitCode !== null) return; const ended = once(child, 'exit'); child.send?.('LOCAL_DEV_STOP'); await ended; child = undefined; };
  const mailbox = async (email: string, override: NodeJS.ProcessEnv = {}) => await exec(process.execPath, ['scripts/mailbox-local.mjs', '--email', email], { env: { ...env, ...override }, windowsHide: true });
  try {
    let api = await start(); await api.refreshCsrf();
    const email = `manual_${randomUUID()}@example.test`, password = 'synthetic manual passphrase 76543210';
    assert.equal((await api.call('POST', '/api/v1/auth/register', { email, displayName: 'Manual synthetic', privacyPolicyVersion: 'synthetic-v1', acceptTerms: true })).status, 202);
    const link = JSON.parse(await readFile(descriptor, 'utf8')) as { mongoUri: string; databaseName: string };
    assert.equal(Number(new URL(link.mongoUri).port), mongoPort);
    client = new MongoClient(link.mongoUri); await client.connect(); const db = client.db(link.databaseName);
    let token = '';
    for (let n = 0; n < 30 && !token; n++) {
      const response = JSON.parse((await mailbox(email)).stdout) as { messages: { purpose: string; code: string }[] };
      token = response.messages.find(m => m.purpose === 'ACTIVATION')?.code ?? ''; if (!token) await delay(250);
    }
    assert.ok(token.length === 43, 'CLI returns only a current synthetic code in memory');
    const quotaBefore = await db.collection('mail_quotas').find().toArray();
    const proofsBefore = await db.collection('email_proofs').find().toArray();
    await mailbox(email); await mailbox(email);
    assert.deepEqual(await db.collection('mail_quotas').find().toArray(), quotaBefore);
    assert.deepEqual(await db.collection('email_proofs').find().toArray(), proofsBefore);
    for (const overrides of [{ CAUDELYX_MODE: 'production' }, { CAUDELYX_MODE: '' }, { MONGODB_URI: 'mongodb://remote.invalid:27181/?replicaSet=bad' }]) await assert.rejects(mailbox(email, overrides));
    await assert.rejects(mailbox('person@gmail.com'));
    assert.equal((await api.call('GET', '/api/v1/dev/mailbox')).status, 503);
    assert.equal((await api.call('POST', '/api/v1/auth/email-verifications/confirm', { purpose: 'ACTIVATION', token, newPassword: password })).status, 200);
    await api.refreshCsrf();
    const enrollment = await api.call('POST', '/api/v1/auth/mfa/totp/enrollments', { label: 'Manual synthetic TOTP' }); assert.equal(enrollment.status, 201);
    const secret = new URL(String(enrollment.body.data?.['provisioningUri'])).searchParams.get('secret'); assert.ok(secret);
    const id = String(enrollment.body.data?.['enrollmentId']);
    assert.equal((await api.call('POST', `/api/v1/auth/mfa/totp/enrollments/${id}/confirm`, { code: await generate({ secret }) })).status, 200);
    const usedStep = Math.floor(Date.now() / 30000); await api.refreshCsrf();
    const me = await api.call('GET', '/api/v1/auth/me'); assert.equal(me.status, 200); const userId = me.body.data?.['userId'];
    await assert.rejects(exec(process.execPath, ['scripts/runtime-cleanup.mjs'], { env, windowsHide:true, timeout:15000 }));
    assert.equal((await api.call('GET', '/api/v1/auth/me')).status, 200);
    const keyHash = createHash('sha256').update(await readFile(control + '/keys.json')).digest('hex');
    const certHash = createHash('sha256').update(await readFile('.runtime/tls/cert.pem')).digest('hex');
    assert.ok(!JSON.stringify(await db.collection('synthetic_mail').find().toArray()).includes(token));
    // Mongo's own operational log, not a dump of data or a CLI redirect, must not contain a plaintext code.
    const log = await readFile(`.runtime/manual-${profile}/mongo.log`, 'utf8'); assert.ok(!log.includes(token));
    await client.close(); client = undefined; await stop();
    api = await start(); await api.refreshCsrf();
    assert.equal(createHash('sha256').update(await readFile('.runtime/tls/cert.pem')).digest('hex'), certHash);
    assert.equal(createHash('sha256').update(await readFile(control + '/keys.json')).digest('hex'), keyHash);
    assert.equal((await api.call('POST', '/api/v1/auth/login', { email, password })).status, 200);
    await api.refreshCsrf();
    while (Math.floor(Date.now() / 30000) === usedStep) await delay(250);
    assert.equal((await api.call('POST', '/api/v1/auth/mfa/challenges/verify', { method: 'TOTP', purpose: 'LOGIN', code: await generate({ secret }) })).status, 200);
    const after = await api.call('GET', '/api/v1/auth/me'); assert.equal(after.status, 200); assert.equal(after.body.data?.['userId'], userId);
    assert.equal((JSON.parse((await mailbox(email)).stdout) as {messages:unknown[]}).messages.length, 0);
    console.log('DEV-001 synthetic CLI guards/quota/proof/read-only checks, real MFA, persistent restart, unchanged keyring and identity: PASS.');
  } finally {
    await client?.close(); await stop();
    await exec(process.execPath, ['scripts/manual-local.mjs', '--reset'], { env, windowsHide: true });
  }
});
