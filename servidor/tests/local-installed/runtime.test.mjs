/* eslint-disable security/detect-non-literal-fs-filename -- Fixed operator-owned profile paths; never derived from HTTP input. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { MongoClient } from 'mongodb';
import { generate } from 'otplib';
import { ApiClient } from '../../dist/tests/helpers/client.js';
import { installedSettings, projectRoot } from '../../scripts/installed-profile.mjs';

const exec = promisify(execFile), delay = ms => new Promise(r => setTimeout(r, ms));
const hash = b => createHash('sha256').update(b).digest('hex');
const apiPort = 5401, uiPort = 5301;
const baseEnv = { ...process.env, CAUDELYX_MODE: 'local-synthetic', MONGODB_URI: 'mongodb://localhost:27017/?replicaSet=rs0',
  CAUDELYX_DEV_API_PORT: String(apiPort), CAUDELYX_DEV_UI_PORT: String(uiPort), CAUDELYX_DEV_PLATFORM_PORT: '5302' };
delete baseEnv.MONGODB_DATABASE;
const logPath = process.env.CAUDELYX_S02_RUNTIME_LOG ?? path.resolve(projectRoot, 'servidor/.runtime/installed-runtime.log');
class Client extends ApiClient {
  async call(method, route, body, headers = {}) {
    return super.call(method, route, body, { Host: `localhost:${uiPort}`, Origin: `https://localhost:${uiPort}`, ...headers });
  }
}
async function runtime(env) {
  const log = await fs.open(logPath, 'a');
  const child = spawn(process.execPath, ['scripts/dev.mjs'], { cwd: projectRoot, env, windowsHide: true, stdio: ['ignore', log.fd, log.fd, 'ipc'] });
  const stopped = async () => {
    if (child.exitCode === null) {
      const ended = once(child, 'exit'); child.send('LOCAL_DEV_STOP');
      const timer = setTimeout(() => child.kill(), 25000);
      try { await ended; } finally { clearTimeout(timer); }
    }
    await log.close();
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('S02 runtime readiness timeout; inspect redacted runtime.log')), 45000);
      child.on('message', m => { if (m === 'S02_INSTALLED_READY') { clearTimeout(timer); resolve(); } });
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('S02 runtime exited; inspect runtime.log')); });
    });
    return { stop: stopped, child };
  } catch (error) { await stopped(); throw error; }
}
const envFor = () => ({ ...baseEnv, CAUDELYX_DEV_TEST_ID: randomUUID().replaceAll('-', '').slice(0, 24) });
const mailbox = async (email, env) => JSON.parse((await exec(process.execPath,
  ['servidor/scripts/mailbox-installed.mjs', '--email', email], { cwd: projectRoot, env, windowsHide: true })).stdout).messages;
async function nextStep(previous) { while (Math.floor(Date.now() / 30000) <= previous) await delay(200); }

test('AT-S02-01/02/03/12: installed Mongo, real signup/CLI/LINK/MFA/org, restart, audit and journal guard', { timeout: 180000 }, async () => {
  const env = envFor(), settings = installedSettings(env);
  let app, mongo;
  try {
    app = await runtime(env);
    const cert = await fs.readFile(path.join(settings.tls, 'cert.pem'));
    const api = new Client(apiPort, cert); await api.refreshCsrf();
    const password = 'Synthetic S02 installed passphrase 13579', email = `installed_${randomUUID()}@example.test`;
    assert.equal((await api.call('POST', '/api/v1/auth/register', { mode: 'PROFILE', email, password, displayName: 'Perfil S02', privacyPolicyVersion: 'synthetic-v1', acceptTerms: true })).status, 202);
    await api.refreshCsrf();
    assert.equal((await api.call('GET', '/api/v1/auth/me')).body.data.authState, 'EMAIL_REQUIRED');
    assert.notEqual((await api.call('GET', '/api/v1/organizations/current')).status, 200);
    let token;
    for (let n = 0; n < 24 && !token; n++) {
      token = (await mailbox(email, env)).find(m => m.purpose === 'ACTIVATION')?.code;
      if (!token) await delay(250);
    }
    assert.ok(typeof token === 'string' && token.length === 43, 'current CLI proof, never logged');
    mongo = new MongoClient('mongodb://localhost:27017/?replicaSet=rs0', { family: 4 }); await mongo.connect();
    const db = mongo.db(settings.database);
    const quotas = await db.collection('mail_quotas').find().toArray(), proofs = await db.collection('email_proofs').find().toArray();
    await mailbox(email, env); await mailbox(email, env);
    assert.deepEqual(await db.collection('mail_quotas').find().toArray(), quotas);
    assert.deepEqual(await db.collection('email_proofs').find().toArray(), proofs);
    await assert.rejects(mailbox('persona@gmail.com', env));
    await assert.rejects(mailbox(email, { ...env, CAUDELYX_MODE: 'production' }));
    await assert.rejects(mailbox(email, { ...env, MONGODB_URI: 'mongodb://remote.invalid:27017' }));
    assert.notEqual((await api.call('GET', '/api/v1/dev/mailbox')).status, 200);
    const wrong = await api.call('POST', '/api/v1/auth/email-verifications/confirm', { purpose: 'ACTIVATION', mode: 'LINK', token: 'Z'.repeat(43) });
    assert.equal(wrong.status, 401);
    const other = new Client(apiPort, cert); await other.refreshCsrf();
    assert.equal((await other.call('POST', '/api/v1/auth/email-verifications/confirm', { purpose: 'ACTIVATION', mode: 'LINK', token })).status, 401);
    assert.equal((await api.call('POST', '/api/v1/auth/email-verifications/confirm', { purpose: 'ACTIVATION', mode: 'LINK', token })).status, 200);
    await api.refreshCsrf();
    assert.notEqual((await api.call('POST', '/api/v1/auth/email-verifications/confirm', { purpose: 'ACTIVATION', mode: 'LINK', token })).status, 200);
    assert.notEqual((await api.call('GET', '/api/v1/organizations/current')).status, 200);
    const enrollment = await api.call('POST', '/api/v1/auth/mfa/totp/enrollments', { label: 'S02 local TOTP' });
    assert.equal(enrollment.status, 201);
    const secret = new URL(enrollment.body.data.provisioningUri).searchParams.get('secret'); assert.ok(secret);
    assert.equal((await api.call('POST', `/api/v1/auth/mfa/totp/enrollments/${enrollment.body.data.enrollmentId}/confirm`, { code: await generate({ secret }) })).status, 200);
    const usedStep = Math.floor(Date.now() / 30000); await api.refreshCsrf();
    const command = { name: 'Org sintética S02', timezone: 'America/Bogota', currency: 'COP' };
    assert.equal((await api.call('POST', '/api/v1/auth/reauthenticate', { password, purpose: 'ORGANIZATION_CREATE', command })).status, 200);
    await nextStep(usedStep);
    assert.equal((await api.call('POST', '/api/v1/auth/mfa/challenges/verify', { method: 'TOTP', purpose: 'ORGANIZATION_CREATE', code: await generate({ secret }) })).status, 200);
    await api.refreshCsrf();
    assert.equal((await api.call('POST', '/api/v1/organizations', command, { 'Idempotency-Key': randomUUID() })).status, 201);
    await api.refreshCsrf();
    const before = await api.call('GET', '/api/v1/auth/me'); assert.equal(before.status, 200);
    assert.ok(before.body.data.userId && before.body.data.organizationId);
    assert.ok(await db.collection('audit_events').countDocuments() > 0);
    assert.ok(await db.collection('outbox').countDocuments() > 0);
    assert.equal(JSON.stringify(await db.collection('synthetic_mail').find().toArray()).includes(token), false);
    const keysBefore = hash(await fs.readFile(settings.keyring)), tlsBefore = hash(cert);
    const journalPath = path.join(settings.control, `gate-${settings.database}.json.journal.jsonl`);
    await app.stop(); app = undefined;
    const journalBefore = await fs.readFile(journalPath);
    // Removing an existing profile's keyring must not silently generate a replacement.
    await fs.rename(settings.keyring, settings.keyring + '.withheld');
    await assert.rejects(async () => { app = await runtime(env); }, /runtime exited/);
    await assert.rejects(fs.stat(settings.keyring), { code: 'ENOENT' });
    await fs.rename(settings.keyring + '.withheld', settings.keyring);
    app = await runtime(env);
    assert.equal(hash(await fs.readFile(settings.keyring)), keysBefore);
    assert.equal(hash(await fs.readFile(path.join(settings.tls, 'cert.pem'))), tlsBefore);
    const after = await api.call('GET', '/api/v1/auth/me');
    assert.equal(after.status, 200); assert.equal(after.body.data.userId, before.body.data.userId); assert.equal(after.body.data.organizationId, before.body.data.organizationId);
    const journalAfter = await fs.readFile(journalPath);
    assert.equal(journalAfter.subarray(0, journalBefore.length).equals(journalBefore), true);
    // Separate installed database: an opaque session from A cannot authenticate in B.
    await app.stop(); app = undefined;
    const secondEnv = envFor(); app = await runtime(secondEnv);
    const cross = new Client(apiPort, cert); for (const [k, v] of api.cookies) cross.cookies.set(k, v);
    assert.notEqual((await cross.call('GET', '/api/v1/auth/me')).body.data?.userId, before.body.data.userId);
    await app.stop(); app = undefined;
    // No deleted files/bases: withhold only A's own external journal, preserve it for evidence.
    await fs.rename(journalPath, journalPath + '.withheld');
    await assert.rejects(async () => { app = await runtime(env); }, /runtime exited/);
    assert.ok(await fs.stat(journalPath + '.withheld'));
    console.log('Installed profile: real persistence/CLI/MFA/R/org, audit/outbox, cross-database denial and missing-file fail-closed verified. No DB dropped.');
  } finally { await app?.stop(); await mongo?.close(); }
});

test('AT-S02-01/02 negative: unavailable configured topology fails without fallback or control creation', { timeout: 15000 }, async () => {
  const env = { ...envFor(), MONGODB_URI: 'mongodb://localhost:27017/?replicaSet=s02_deliberately_unavailable' };
  const settings = installedSettings(env);
  await assert.rejects(exec(process.execPath, ['scripts/dev.mjs'], { cwd: projectRoot, env, windowsHide: true, timeout: 10000 }));
  await assert.rejects(fs.stat(settings.control), { code: 'ENOENT' });
  console.log('Unavailable topology deliberately configured; real Mongo service never stopped, no fallback/control material.');
});
