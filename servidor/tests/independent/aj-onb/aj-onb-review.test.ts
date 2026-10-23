/* eslint-disable security/detect-non-literal-fs-filename -- Only the exact AJ-ONB-5 reserved paths below; never HTTP input. */
// AJ-ONB-5 independent review (Claude). Own ephemeral Mongo group; never 27017, 27181, caudelyx_dev or manual data.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer as createControlServer } from 'node:http';
import { mkdir, readFile, writeFile, appendFile, rm, lstat, realpath, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer as probe } from 'node:net';
import { createServer } from 'node:https';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { MongoClient } from 'mongodb';
import { generate } from 'otplib';
import { Database } from '../../../src/shared/database.js';
import { Sessions } from '../../../src/modules/sessions/service.js';
import { SyntheticMessaging } from '../../../src/modules/messaging/service.js';
import { IdentityService } from '../../../src/modules/identity/service.js';
import { PasswordHasher } from '../../../src/modules/identity/password.js';
import { RestoreController } from '../../../src/shared/restore.js';
import { attachRuntime } from '../../../src/shared/runtime.js';
import { createApp } from '../../../src/app.js';
import { AppError } from '../../../src/shared/errors.js';
import type { Context, Identity } from '../../../src/modules/identity/models.js';
import { startReplicaSet } from '../../helpers/replica-set.js';
import { ApiClient } from '../../helpers/client.js';

const runId = '2170bda8cf79eadb41f236e0', uuid = '2170bda8-cf79-eadb-41f2-36e000000005';
const root = resolve('.runtime'), folder = join(root, 'aj-onb-5', runId), mongoFolder = join(root, 'manual-test-' + uuid);
const databaseName = 'caudelyx_aj_onb5_' + runId;
const names = [databaseName, databaseName + '_external_mail', databaseName + '_external_security'];
const receipts = resolve('../../Construccion/Sprints/AJ-ONB/Evidencias/AJ-ONB-5-RESOURCES.jsonl');
const password = 'Frase sintetica revisora independiente 4417';
const other = 'Otra frase sintetica de la revisora 9902';
const budget = { mongoBytes: 134217728, controlBytes: 16777216 };
const receipt = async (r: Record<string, unknown>) => await appendFile(receipts, JSON.stringify({ at: new Date().toISOString(), task: 'AJ-ONB-5', runId, ...r }) + '\n');
const denied = (code: string) => (e: unknown) => e instanceof AppError && e.code === code;
const observations = new Map<string, unknown>();
const observe = (key: string, value: unknown) => { observations.set(key, value); };

function assertOwnUri(uri: string) {
  const u = new URL(uri);
  if (u.hostname !== '127.0.0.1' || !u.port || ['27017', '27181'].includes(u.port) || u.searchParams.get('replicaSet') !== 'caudelyx-manual') throw Error('Protected/unknown Mongo profile');
}
async function size(path: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(path, { withFileTypes: true })) {
    const p = join(path, e.name), s = await lstat(p);
    if (s.isSymbolicLink()) throw Error('Refuse linked controls');
    n += e.isDirectory() ? await size(p) : s.size;
  }
  return n;
}
async function removeOwn(path: string) {
  if (![folder, mongoFolder].includes(resolve(path)) || resolve(await realpath(path)) !== resolve(path) || (await lstat(path)).isSymbolicLink()) throw Error('Unowned control path');
  if (resolve(await realpath(root)) !== root) throw Error('Linked runtime root');
  await size(path); await rm(path, { recursive: true, force: false, maxRetries: 3 });
}
async function freePort(exclude: number[]): Promise<number> {
  const p = probe().listen(0, '127.0.0.1'); await once(p, 'listening'); const a = p.address();
  await new Promise<void>(r => p.close(() => r()));
  if (!a || typeof a === 'string' || [27017, 27181, 3001, 3002, 4001, ...exclude].includes(a.port)) throw Error('Protected port');
  return a.port;
}

async function ownProfile() {
  const port = await freePort([]);
  await receipt({ event: 'reserved-before-create', owner: 'Claude/AJ-ONB-5', ownerPid: process.pid, mongoPort: port, databases: names, folder, mongoFolder, budget: { groups: 1, ...budget } });
  await mkdir(join(root, 'aj-onb-5'), { recursive: true }); await mkdir(folder);
  const owner = { runId, pid: process.pid, nonce: randomUUID(), names, port };
  await writeFile(join(folder, 'owner.json'), JSON.stringify(owner), { flag: 'wx' });
  const servers: ReturnType<typeof createServer>[] = [], clients: Database[] = [];
  let replica: Awaited<ReturnType<typeof startReplicaSet>> | undefined, control: MongoClient | undefined, disposed = false;
  let peak = { mongoBytes: 0, controlBytes: 0 }, reuses = 0;
  const closeConsumers = async () => { for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r())); for (const d of clients.splice(0)) await d.close(); };
  const dispose = async () => {
    if (disposed) return;
    try {
      if (JSON.stringify(JSON.parse(await readFile(join(folder, 'owner.json'), 'utf8'))) !== JSON.stringify(owner)) throw Error('Ownership changed');
      await closeConsumers();
      if (control) {
        const opts = await control.db('admin').command({ getCmdLineOpts: 1 });
        const dbPath = (opts['parsed'] as { storage?: { dbPath?: string } }).storage?.dbPath;
        if (!dbPath || resolve(dbPath) !== mongoFolder) throw Error('Unknown Mongo process');
        const foreign = await control.db('admin').aggregate([{ $currentOp: { allUsers: true, idleConnections: true, idleSessions: true } },
          { $match: { 'clientMetadata.application.name': { $ne: 'AJ_ONB_5_CLEANUP' }, $or: [{ 'command.$db': { $in: names } }, { $expr: { $in: [{ $arrayElemAt: [{ $split: [{ $ifNull: ['$ns', ''] }, '.'] }, 0] }, names] } }] } },
          { $project: { _id: 0, active: 1 } }]).toArray();
        if (foreign.length) throw Error('Unclosed or unknown fixture consumer');
        const stats = [];
        for (const name of names) { const s = await control.db(name).command({ dbStats: 1 }); stats.push({ name, storageSize: s['storageSize'], indexSize: s['indexSize'], dataSize: s['dataSize'] }); }
        await receipt({ event: 'cleanup-before', stats, controlBytes: await size(folder), dbPathBytes: await size(mongoFolder), peak, reuses });
        for (const name of names) await control.db(name).dropDatabase();
        const remaining = await control.db('admin').command({ listDatabases: 1, nameOnly: true, filter: { name: { $in: names } } });
        if ((remaining['databases'] as unknown[]).length) throw Error('Test databases remain');
        await control.close(); control = undefined;
      }
      await replica?.stop();
      try { await removeOwn(mongoFolder); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      await removeOwn(folder); disposed = true;
      await receipt({ event: 'cleanup-complete', databases: names, remaining: 0, controlRemoved: true, mongoProcessStopped: true });
    } catch (error) {
      await receipt({ event: 'cleanup-failed', reason: String(error).slice(0, 200), retainUntil: new Date(Date.now() + 86400000).toISOString(), responsible: 'Claude/AJ-ONB-5' });
      throw error;
    }
  };
  try {
    replica = await startReplicaSet({ manualProfile: 'test-' + uuid, port }); assertOwnUri(replica.uri);
    control = new MongoClient(replica.uri, { appName: 'AJ_ONB_5_CLEANUP' }); await control.connect();
    await receipt({ event: 'created', databases: names, mongoPort: port, folder, mongoFolder });
    const fixture = async (options: { static?: boolean } = {}) => {
      await closeConsumers();
      let mongoBytes = 0;
      for (const name of names) { const s = await control!.db(name).command({ dbStats: 1 }); mongoBytes += Number(s['storageSize']) + Number(s['indexSize']); }
      const controls = await size(folder);
      peak = { mongoBytes: Math.max(peak.mongoBytes, mongoBytes), controlBytes: Math.max(peak.controlBytes, controls) };
      if (mongoBytes > budget.mongoBytes || controls > budget.controlBytes) throw Error('Own resource budget exceeded');
      for (const name of names) await control!.db(name).dropDatabase();
      for (const e of await readdir(folder)) if (e !== 'owner.json') {
        const p = join(folder, e), s = await lstat(p);
        if (s.isSymbolicLink()) throw Error('Linked test control');
        if (s.isDirectory()) {
          if (e !== 'playwright' || resolve(await realpath(p)) !== join(folder, 'playwright')) throw Error('Unexpected test control');
          await size(p); await rm(p, { recursive: true, force: false });
        } else await rm(p);
      }
      reuses++; await receipt({ event: 'group-reused', reuses, mongoBytesBefore: mongoBytes, controlBytesBefore: controls });
      const database = new Database(replica!.uri, databaseName); clients.push(database); await database.connect();
      const clock = { value: Math.floor(Date.now() / 30000) * 30000 + 1000, open: true }, now = () => clock.value;
      const keys = { version: 1 as const, mail: randomBytes(32), totp: randomBytes(32), journal: randomBytes(32), cursor: randomBytes(32) };
      const restore = new RestoreController(database, join(folder, 'gate.json'), keys.journal); await restore.initialize();
      const sessions = new Sessions(database, now), messages = new SyntheticMessaging(database, keys.mail, now);
      const identity = new IdentityService(database, sessions, messages, new PasswordHasher(), () => clock.open && restore.isOpen(), now); await identity.initialize();
      const config = { mongoUri: replica!.uri, databaseName, port: 0, tenantOrigin: 'https://localhost:0', platformOrigin: 'https://platform.localhost:0' };
      const runtime = await attachRuntime(identity, keys, config);
      const mail = async (subjectId: string, purpose: string) => {
        await identity.dispatchMail();
        const m = [...messages.inbox.values()].filter(x => x.subjectId === subjectId && x.purpose === purpose).at(-1);
        if (!m) throw Error('No synthetic mail ' + purpose); return m;
      };
      const signup = async (source: string = randomUUID()) => {
        const anonymous = await sessions.issue('TENANT', 'P', null), email = 'r5-' + randomUUID() + '@example.test';
        const registered = await identity.register('TENANT', source, { email, displayName: 'Revisora sintética', privacyPolicyVersion: 'synthetic-v1', password }, anonymous.context);
        if (!registered.issued) throw Error('No basic session');
        const subject = (await identity.identities.findOne({ email }))!;
        return { email, issued: registered.issued, subject, token: (await mail(subject._id, 'ACTIVATION')).token };
      };
      const confirmed = async () => {
        const a = await signup();
        const c = await identity.confirmEmail(a.issued.context, { purpose: 'ACTIVATION', token: a.token });
        if (!c.issued) throw Error('No rotated B');
        return { ...a, issued: c.issued };
      };
      const totpCode = async (secret: string) => await generate({ secret, epoch: Math.floor(now() / 1000) });
      const strong = async () => {
        const a = await confirmed();
        const enrollment = await runtime.totp.enroll(a.issued.context, 'Revisora', password);
        const secret = new URL(enrollment.provisioningUri).searchParams.get('secret')!;
        const done = await runtime.totp.confirm(a.issued.context, enrollment.enrollmentId, await totpCode(secret));
        if (!done.issued) throw Error('No strong session');
        return { ...a, secret, uri: enrollment.provisioningUri, strong: done.issued };
      };
      const https = async () => {
        const run = promisify(execFile);
        await run('C:/Program Files/Git/usr/bin/openssl.exe', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(folder, 'key.pem'), '-out', join(folder, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,DNS:platform.localhost,IP:127.0.0.1'], { windowsHide: true });
        const cert = await readFile(join(folder, 'cert.pem')), key = await readFile(join(folder, 'key.pem'));
        const httpsPort = await freePort([port]);
        await receipt({ event: 'https-reserved-before-listen', httpsPort });
        const app = express();
        if (options.static) app.use(express.static(resolve('../cliente/dist')));
        app.use(createApp({ identity, config }));
        const server = createServer({ cert, key }, app); servers.push(server); server.listen(httpsPort, '127.0.0.1'); await once(server, 'listening');
        config.tenantOrigin = 'https://localhost:' + httpsPort; config.platformOrigin = 'https://platform.localhost:' + httpsPort;
        await receipt({ event: 'https-created', httpsPort });
        const client = async (session?: string, host = 'localhost') => {
          const c = new ApiClient(httpsPort, cert, host);
          if (session) c.cookies.set('__Host-caudelyx-session', session);
          await c.refreshCsrf(); return c;
        };
        return { port: httpsPort, cert, client };
      };
      return { database, clock, now, keys, restore, sessions, messages, identity, runtime, config, mail, signup, confirmed, strong, totpCode, https };
    };
    return { fixture, dispose, port, uri: replica.uri };
  } catch (error) { await dispose(); throw error; }
}
type Fixture = Awaited<ReturnType<Awaited<ReturnType<typeof ownProfile>>['fixture']>>;
type Client = Awaited<ReturnType<Awaited<ReturnType<Fixture['https']>>['client']>>;
const post = async (c: Client, path: string, body?: unknown, headers: Record<string, string> = {}) => { await c.refreshCsrf(); return await c.call('POST', '/api/v1' + path, body, headers); };
const send = async (c: Client, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => { if (method !== 'GET') await c.refreshCsrf(); return await c.call(method, path.startsWith('/api') ? path : '/api/v1' + path, body, headers); };
const code = (r: { status: number; body: { error?: { code: string } } }) => `${r.status}:${r.body.error?.code ?? 'OK'}`;
const lastSeen = async (f: Fixture, context: Context) => (await f.sessions.contexts.findOne({ _id: context._id }))?.lastSeenAt;

test('AJ-ONB-5: revisión independiente con grupo propio reutilizado', { timeout: 900000 }, async t => {
  for (const uri of ['mongodb://127.0.0.1:27017/?replicaSet=caudelyx-manual', 'mongodb://127.0.0.1:27181/?replicaSet=caudelyx-manual', 'mongodb://127.0.0.1:30000/?replicaSet=rs0']) assert.throws(() => assertOwnUri(uri));
  const profile = await ownProfile();
  try {
    await t.test('R01 AT07: variantes de ruta financiera no exponen datos a B', async () => {
      const f = await profile.fixture(), h = await f.https(), a = await f.signup(), c = await h.client(a.issued.token), org = randomUUID();
      const variants = [`/api/v1/organizations/${org}/financial/accounts`, `/api/v1/organizations/${org}/FINANCIAL/accounts`, `/api/v1/ORGANIZATIONS/${org}/financial/accounts`,
        `/API/V1/organizations/${org}/financial/balances`, `/api/v1/organizations/${org}/Financial/opening-files`, `/api/v1/organizations/${org}/financial/accounts/`];
      const result = new Map<string, string>();
      for (const v of variants) { const r = await c.call('GET', v); result.set(v.replace(org, '{org}'), code(r)); assert(r.status >= 400, v); assert.equal(r.body.data, undefined); }
      const before = await lastSeen(f, a.issued.context);
      const created = await send(c, 'POST', `/api/v1/organizations/${org}/FINANCIAL/accounts`, { name: 'Caja', kind: 'CASH' }, { 'Idempotency-Key': randomUUID() });
      result.set('POST {org}/FINANCIAL/accounts', code(created)); assert(created.status >= 400);
      assert.equal(await lastSeen(f, a.issued.context), before);
      observe('R01', Object.fromEntries(result));
      const confirmed = await f.confirmed(), c2 = await h.client(confirmed.issued.token);
      observe('R01-confirmed', { lower: code(await c2.call('GET', `/api/v1/organizations/${org}/financial/accounts`)), upper: code(await c2.call('GET', `/api/v1/organizations/${org}/FINANCIAL/accounts`)) });
    });

    await t.test('R02 AT07/AT16: B pendiente y confirmada fuera de la lista cerrada', async () => {
      const f = await profile.fixture(), h = await f.https(), pending = await f.signup(), done = await f.confirmed();
      const ops: [string, string, unknown?, Record<string, string>?][] = [
        ['POST', '/auth/password/change', { currentPassword: password, newPassword: other }], ['POST', '/auth/reauthenticate', { password, purpose: 'PASSWORD_CHANGE' }],
        ['GET', '/auth/sessions'], ['POST', '/auth/sessions/revoke-all'], ['POST', '/auth/mfa/recovery-codes/regenerate', {}],
        ['POST', '/auth/mfa/webauthn/authentication/options', { purpose: 'LOGIN' }], ['POST', '/auth/mfa/challenges/verify', { method: 'TOTP', purpose: 'LOGIN', code: '123456' }],
        ['POST', '/organizations', { name: 'Org B', timezone: 'America/Bogota', currency: 'COP' }, { 'Idempotency-Key': randomUUID() }], ['GET', '/organization'],
        ['POST', '/organization/invitations', { email: 'x@example.test', roleIds: ['O'] }], ['POST', '/auth/invitations/accept', { mode: 'CONFIRM', token: 'a'.repeat(43) }],
        ['POST', '/auth/register', { email: 'nuevo-' + randomUUID() + '@example.test', displayName: 'Otra', password, privacyPolicyVersion: 'synthetic-v1', acceptTerms: true }],
        ['POST', '/auth/login', { email: pending.email, password }], ['POST', '/auth/password-reset/request', { email: pending.email }],
        ['POST', '/auth/password-reset/confirm', { mode: 'PREVIEW', token: 'a'.repeat(43) }], ['POST', '/auth/registrations/reject', { token: 'a'.repeat(43) }],
      ];
      const table = new Map<string, string>();
      for (const [label, subject] of [['pending', pending], ['confirmed', done]] as const) {
        const c = await h.client(subject.issued.token);
        for (const [method, path, body, headers] of ops) {
          const before = await lastSeen(f, subject.issued.context);
          const r = await send(c, method, path, body, headers ?? {});
          table.set(`${label} ${method} ${path}`, code(r));
          assert(r.status === 403 || r.status === 401, `${label} ${method} ${path} -> ${code(r)}`);
          assert.equal(r.body.data, undefined);
          assert.equal(await lastSeen(f, subject.issued.context), before, 'denied request must not renew B');
        }
        assert.equal((await c.call('GET', '/api/v1/auth/me')).status, 200, 'B survives denied calls');
      }
      assert.equal(await f.identity.identities.countDocuments({ organizationId: { $ne: null } }), 0);
      assert.equal((await f.identity.identities.findOne({ _id: done.subject._id }))!.passwordHash, done.subject.passwordHash);
      observe('R02', Object.fromEntries(table));
    });

    await t.test('R03 AT06/TM21: B ajena no consume; P confirma; B del registrante sigue viva', async () => {
      const f = await profile.fixture(), h = await f.https(), victim = await f.signup(), intruder = await f.signup();
      const ci = await h.client(intruder.issued.token);
      const cross = await post(ci, '/auth/email-verifications/confirm', { purpose: 'ACTIVATION', token: victim.token });
      assert.equal(code(cross), '403:ACCESS_DENIED');
      assert.equal(await f.messages.proofs.countDocuments({ subjectId: victim.subject._id, purpose: 'ACTIVATION', consumed: false }), 1);
      const browser = await h.client();
      const ok = await post(browser, '/auth/email-verifications/confirm', { purpose: 'ACTIVATION', mode: 'LINK', token: victim.token });
      assert.equal(ok.status, 200); assert.deepEqual(ok.body.data, { emailVerified: true, nextAction: 'LOGIN' });
      assert.equal((await browser.call('GET', '/api/v1/auth/me')).status, 401, 'other browser stays anonymous');
      assert.equal((await f.identity.identities.findOne({ _id: victim.subject._id }))!.passwordHash, victim.subject.passwordHash);
      const registrant = await h.client(victim.issued.token), me = await registrant.call('GET', '/api/v1/auth/me');
      observe('R03-registrant-B-after-foreign-confirm', { status: me.status, authState: me.body.data?.['authState'] });
      const replay = await post(await h.client(), '/auth/email-verifications/confirm', { purpose: 'ACTIVATION', token: victim.token });
      assert.equal(code(replay), '401:TOKEN_INVALID');
    });

    await t.test('R04 AT05/AT11: tokens fuera de su finalidad o realm', async () => {
      const f = await profile.fixture(), h = await f.https(), a = await f.signup();
      const p = await h.client();
      assert.equal((await post(p, '/auth/password-reset/request', { email: a.email })).status, 202);
      const reset = (await f.mail(a.subject._id, 'RESET')).token;
      const results = {
        activationAsResetPreview: code(await post(await h.client(), '/auth/password-reset/confirm', { mode: 'PREVIEW', token: a.token })),
        resetAsActivation: code(await post(await h.client(), '/auth/email-verifications/confirm', { purpose: 'ACTIVATION', token: reset })),
        resetAsReject: code(await post(await h.client(), '/auth/registrations/reject', { token: reset })),
        activationAsInitial: code(await post(await h.client(), '/auth/email-verifications/confirm', { purpose: 'INITIAL_MFA_PROOF', token: a.token })),
        activationOnPlatformHost: code(await post(await h.client(undefined, 'platform.localhost'), '/auth/email-verifications/confirm', { purpose: 'ACTIVATION', token: a.token })),
        rejectWithB: code(await post(await h.client(a.issued.token), '/auth/registrations/reject', { token: a.token })),
      };
      for (const [k, v] of Object.entries(results)) assert(!v.startsWith('2'), k + ' ' + v);
      assert.equal(await f.messages.proofs.countDocuments({ subjectId: a.subject._id, purpose: 'ACTIVATION', consumed: false }), 1, 'no misuse consumed ACTIVATION');
      assert((await f.identity.identities.findOne({ _id: a.subject._id }))!.state === 'PENDING_EMAIL');
      observe('R04', results);
    });

    await t.test('R05 AT11/AT12: carreras confirmar/rechazar/RESET, una transición coherente', async () => {
      const f = await profile.fixture(), outcomes: string[] = [];
      for (let n = 0; n < 4; n++) {
        const a = await f.signup('race-a' + n), p1 = await f.sessions.issue('TENANT', 'P', null), p2 = await f.sessions.issue('TENANT', 'P', null);
        const [c, r] = await Promise.allSettled([f.identity.confirmEmail(p1.context, { purpose: 'ACTIVATION', token: a.token }), f.identity.onboarding.reject(p2.context, a.token)]);
        const subject = await f.identity.identities.findOne({ _id: a.subject._id }), tomb = await f.database.db.collection('onboarding_tombstones').findOne({ _id: a.subject._id as never });
        assert.equal([c, r].filter(x => x.status === 'fulfilled').length, 1, 'exactly one winner');
        if (c.status === 'fulfilled') { assert.equal(subject?.state, 'MFA_ENROLLMENT'); assert.equal(tomb, null); } else { assert.equal(subject, null); assert(tomb); }
        outcomes.push('confirm-vs-reject:' + (c.status === 'fulfilled' ? 'confirm' : 'reject'));
      }
      for (let n = 0; n < 4; n++) {
        const a = await f.signup('race-b' + n), p = await f.sessions.issue('TENANT', 'P', null);
        await f.identity.requestEmail('TENANT', 'race-reset' + n, 'RESET', a.email, p.context);
        const reset = (await f.mail(a.subject._id, 'RESET')).token;
        await f.identity.reset(p.context, { mode: 'PREVIEW', token: reset }, 'race-reset' + n);
        const p2 = await f.sessions.issue('TENANT', 'P', null);
        const [rs, rj] = await Promise.allSettled([f.identity.reset(p.context, { mode: 'CONFIRM', token: reset, newPassword: other, warningAcknowledged: false }, 'race-reset' + n), f.identity.onboarding.reject(p2.context, a.token)]);
        const subject = await f.identity.identities.findOne({ _id: a.subject._id });
        assert.equal([rs, rj].filter(x => x.status === 'fulfilled').length, 1, 'reset and reject are mutually exclusive');
        if (rs.status === 'fulfilled') { assert.equal(subject?.state, 'MFA_ENROLLMENT'); assert.equal(subject?.emailVerified, true); assert(await f.identity.passwords.verify(subject!.passwordHash, other)); }
        else assert.equal(subject, null);
        assert.equal(await f.sessions.find(a.issued.token, 'TENANT'), null, 'registrant B never survives either transition');
        outcomes.push('reset-vs-reject:' + (rs.status === 'fulfilled' ? 'reset' : 'reject'));
      }
      for (let n = 0; n < 3; n++) {
        const a = await f.signup('race-c' + n), p = await f.sessions.issue('TENANT', 'P', null);
        await f.identity.requestEmail('TENANT', 'race-c-reset' + n, 'RESET', a.email, p.context);
        const reset = (await f.mail(a.subject._id, 'RESET')).token;
        await f.identity.reset(p.context, { mode: 'PREVIEW', token: reset }, 'race-c' + n);
        const p2 = await f.sessions.issue('TENANT', 'P', null);
        const [rs, cf] = await Promise.allSettled([f.identity.reset(p.context, { mode: 'CONFIRM', token: reset, newPassword: other, warningAcknowledged: false }, 'race-c' + n), f.identity.confirmEmail(p2.context, { purpose: 'ACTIVATION', token: a.token })]);
        const subject = (await f.identity.identities.findOne({ _id: a.subject._id }))!;
        assert.equal(subject.state, 'MFA_ENROLLMENT'); assert.equal(subject.emailVerified, true);
        if (rs.status === 'fulfilled') assert(await f.identity.passwords.verify(subject.passwordHash, other)); else assert.equal(subject.passwordHash, a.subject.passwordHash);
        assert.equal(await f.sessions.find(a.issued.token, 'TENANT') !== null, rs.status !== 'fulfilled', 'RESET revokes registrant B');
        outcomes.push('reset-vs-confirm:' + rs.status + '/' + cf.status);
      }
      observe('R05', outcomes);
    });

    await t.test('R06 AT12: purga 7d en el borde exacto, confirmada se conserva, no prístina queda bloqueada', async () => {
      const f = await profile.fixture();
      const a = await f.signup('purge-a'), kept = await f.signup('purge-b'), blocked = await f.signup('purge-c');
      await f.identity.confirmEmail((await f.sessions.issue('TENANT', 'P', null)).context, { purpose: 'ACTIVATION', token: kept.token });
      await f.identity.identities.updateOne({ _id: blocked.subject._id }, { $set: { restoreBootstrapBlocked: true } });
      const deadline = a.subject.createdAt + 7 * 86400000;
      f.clock.value = deadline - 1;
      const login = await f.identity.login('TENANT', 'purge-login', a.email, password); assert.equal(login.issued.context.kind, 'B');
      f.clock.value = deadline;
      assert.equal(await f.sessions.find(login.issued.token, 'TENANT'), null, 'B dies at deadline');
      await assert.rejects(f.identity.login('TENANT', 'purge-login', a.email, password), denied('AUTH_INVALID'));
      await assert.rejects(f.identity.confirmEmail((await f.sessions.issue('TENANT', 'P', null)).context, { purpose: 'ACTIVATION', token: a.token }), denied('TOKEN_INVALID'));
      const before = await f.messages.proofs.countDocuments({ subjectId: a.subject._id, purpose: 'RESET' });
      await f.identity.requestEmail('TENANT', 'purge-reset', 'RESET', a.email, (await f.sessions.issue('TENANT', 'P', null)).context);
      assert.equal(await f.messages.proofs.countDocuments({ subjectId: a.subject._id, purpose: 'RESET' }), before, 'no RESET for expired pending');
      await f.identity.onboarding.expire();
      assert.equal(await f.identity.identities.findOne({ _id: a.subject._id }), null);
      assert(await f.database.db.collection('onboarding_tombstones').findOne({ _id: a.subject._id as never }));
      assert.equal((await f.identity.identities.findOne({ _id: kept.subject._id }))!.state, 'MFA_ENROLLMENT', 'confirmed before deadline is kept');
      const zombie = await f.identity.identities.findOne({ _id: blocked.subject._id });
      const p = await f.sessions.issue('TENANT', 'P', null);
      const again = await f.identity.register('TENANT', 'purge-again', { email: blocked.email, displayName: 'Dueña real', privacyPolicyVersion: 'synthetic-v1', password: other }, p.context).then(() => 'registered', (e: unknown) => e instanceof AppError ? e.code : String(e));
      const resetMail = await f.messages.proofs.countDocuments({ subjectId: blocked.subject._id, purpose: 'RESET' });
      await f.identity.requestEmail('TENANT', 'purge-c-reset', 'RESET', blocked.email, (await f.sessions.issue('TENANT', 'P', null)).context);
      observe('R06-non-pristine-expired', { stillStored: !!zombie, reRegister: again, resetIssued: (await f.messages.proofs.countDocuments({ subjectId: blocked.subject._id, purpose: 'RESET' })) > resetMail,
        login: await f.identity.login('TENANT', 'purge-c', blocked.email, password).then(() => 'ok', (e: unknown) => e instanceof AppError ? e.code : String(e)) });
    });

    await t.test('R07 AT10/G01: fuera de la excepción no hay primer factor por B', async () => {
      const f = await profile.fixture();
      const s = await f.strong();
      const p = await f.sessions.issue('TENANT', 'P', null);
      await f.identity.requestEmail('TENANT', 'g01-reset', 'RESET', s.email, p.context);
      const reset = (await f.mail(s.subject._id, 'RESET')).token;
      const preview = await f.identity.reset(p.context, { mode: 'PREVIEW', token: reset }, 'g01') as { warningRequired: boolean };
      await f.identity.reset(p.context, { mode: 'CONFIRM', token: reset, newPassword: other, warningAcknowledged: preview.warningRequired }, 'g01');
      const login = await f.identity.login('TENANT', 'g01-login', s.email, other);
      assert.equal(login.issued.context.kind, 'L'); assert.equal(login.data.authState, 'MFA_REQUIRED');
      await assert.rejects(f.runtime.totp.enroll(login.issued.context, 'Atajo', other));
      const ghost = await f.confirmed();
      await f.sessions.factors.insertOne({ _id: randomUUID(), subjectId: ghost.subject._id, realm: 'TENANT', type: 'TOTP', label: 'histórico', state: 'REVOKED', contextId: 'x', recoveryId: null, expiresAt: 0, confirmed: true, version: '"v"', createdAt: 0, lastUsedAt: null });
      const g = await f.identity.login('TENANT', 'g01-ghost', ghost.email, password);
      await assert.rejects(f.runtime.totp.enroll(g.issued.context, 'Fantasma', password), denied('INITIAL_MFA_PROOF_DENIED'));
      const me = await f.identity.extension!('A07', g.issued.context, {}, undefined, undefined, 'g01', {});
      observe('R07-ghost-history', { loginContext: g.issued.context.kind, me: me.data });
      const blocked = await f.confirmed();
      await f.identity.identities.updateOne({ _id: blocked.subject._id }, { $set: { restoreBootstrapBlocked: true } });
      const b = await f.identity.login('TENANT', 'g01-blocked', blocked.email, password);
      assert.notEqual(b.issued.context.kind, 'B');
      const resetBefore = await f.messages.proofs.countDocuments({ subjectId: blocked.subject._id, purpose: 'RESET' });
      await f.identity.requestEmail('TENANT', 'g01-blocked-reset', 'RESET', blocked.email, (await f.sessions.issue('TENANT', 'P', null)).context);
      observe('R07-restore-blocked', { loginContext: b.issued.context.kind, authState: b.data.authState, resetIssued: (await f.messages.proofs.countDocuments({ subjectId: blocked.subject._id, purpose: 'RESET' })) > resetBefore });
    });

    await t.test('R08 AT08/AT09: contraseña reintroducida, cuota, ventana 5 min, intento reemplazado y B hermana', async () => {
      const f = await profile.fixture(), a = await f.confirmed();
      const second = (await f.identity.login('TENANT', 'r08-second', a.email, password)).issued;
      await assert.rejects(f.runtime.totp.enroll(a.issued.context, 'X'), denied('AUTH_INVALID'));
      for (let n = 0; n < 4; n++) await assert.rejects(f.runtime.totp.enroll(a.issued.context, 'X', other), denied('AUTH_INVALID'));
      await assert.rejects(f.runtime.totp.enroll(a.issued.context, 'X', password), denied('RATE_LIMITED'), 'sixth password attempt per B is limited');
      f.clock.value += 900001;
      await f.sessions.contexts.updateOne({ _id: a.issued.context._id }, { $set: { lastSeenAt: f.now() } });
      const e1 = await f.runtime.totp.enroll(a.issued.context, 'Primero', password);
      assert.equal(new URL(e1.provisioningUri).pathname.includes(encodeURIComponent(a.email)) || decodeURIComponent(e1.provisioningUri).includes(a.email), true, 'label is own email');
      const s1 = new URL(e1.provisioningUri).searchParams.get('secret')!;
      f.clock.value += 300000;
      await assert.rejects(f.runtime.totp.confirm(a.issued.context, e1.enrollmentId, await f.totpCode(s1)), (e: unknown) => e instanceof AppError && ['INITIAL_MFA_PROOF_DENIED', 'MFA_INVALID'].includes(e.code), 'window closes at exactly 5 min');
      await f.sessions.contexts.updateOne({ _id: a.issued.context._id }, { $set: { lastSeenAt: f.now() } });
      const e2 = await f.runtime.totp.enroll(a.issued.context, 'Segundo', password);
      const s2 = new URL(e2.provisioningUri).searchParams.get('secret')!;
      await f.runtime.webauthn.enroll(a.issued.context, 'Llave', password);
      await assert.rejects(f.runtime.totp.confirm(a.issued.context, e2.enrollmentId, await f.totpCode(s2)), (e: unknown) => e instanceof AppError && e.status === 403, 'replaced intent cannot confirm');
      await f.sessions.contexts.updateOne({ _id: second.context._id }, { $set: { lastSeenAt: f.now() } });
      const e3 = await f.runtime.totp.enroll(a.issued.context, 'Tercero', password);
      const s3 = new URL(e3.provisioningUri).searchParams.get('secret')!;
      await assert.rejects(f.runtime.totp.confirm(second.context, e3.enrollmentId, await f.totpCode(s3)), (e: unknown) => e instanceof AppError && [401, 403].includes(e.status), 'sister B cannot confirm');
      const done = await f.runtime.totp.confirm(a.issued.context, e3.enrollmentId, await f.totpCode(s3));
      assert.equal(done.issued?.context.kind, 'S');
      assert.equal(await f.sessions.find(second.token, 'TENANT'), null, 'sister B revoked');
      assert.equal((await f.sessions.factors.countDocuments({ subjectId: a.subject._id, state: 'ACTIVE' })), 1);
      assert.equal(await f.sessions.factors.countDocuments({ subjectId: a.subject._id, state: 'PENDING_INITIAL' }), 0);
    });

    await t.test('R09 AT13: B 30 min de inactividad; denegadas y CSRF no renuevan; 12 h absolutas', async () => {
      const f = await profile.fixture(), h = await f.https(), a = await f.signup(), c = await h.client(a.issued.token);
      f.clock.value += 1799999; assert.equal((await c.call('GET', '/api/v1/auth/me')).status, 200);
      f.clock.value += 1200000; await c.call('GET', '/api/v1/auth/csrf'); assert.equal(code(await c.call('GET', '/api/v1/auth/sessions')), '403:ACCESS_DENIED');
      f.clock.value += 600000; assert.equal((await c.call('GET', '/api/v1/auth/me')).status, 401, 'csrf/denied calls did not renew');
      const b = await f.signup(), cb = await h.client(b.issued.token);
      for (let elapsed = 0; elapsed + 1740000 < 43200000; elapsed += 1740000) { f.clock.value += 1740000; if (b.subject.createdAt + 7 * 86400000 <= f.now()) break; assert.equal((await cb.call('GET', '/api/v1/auth/me')).status, 200); }
      f.clock.value = b.issued.context.createdAt + 43200000; assert.equal((await cb.call('GET', '/api/v1/auth/me')).status, 401, '12 h absolute');
    });

    await t.test('R10 AT04/G02: A39 precondiciones, límites y ajenos', async () => {
      const f = await profile.fixture(), h = await f.https(), a = await f.signup(), b = await f.signup(), c = await h.client(a.issued.token);
      const me = await c.call('GET', '/api/v1/auth/me'), version = (me.body.data?.['profile'] as { version: string }).version;
      const otherVersion = ((await (await h.client(b.issued.token)).call('GET', '/api/v1/auth/me')).body.data?.['profile'] as { version: string }).version;
      const results = {
        noIfMatch: code(await send(c, 'PATCH', '/auth/profile', { displayName: 'Nueva' })),
        foreignVersion: code(await send(c, 'PATCH', '/auth/profile', { displayName: 'Nueva' }, { 'If-Match': otherVersion })),
        tooLong: code(await send(c, 'PATCH', '/auth/profile', { displayName: 'x'.repeat(101) }, { 'If-Match': version })),
        blank: code(await send(c, 'PATCH', '/auth/profile', { displayName: '   ' }, { 'If-Match': version })),
        extra: code(await send(c, 'PATCH', '/auth/profile', { displayName: 'Nueva', email: 'otro@example.test' }, { 'If-Match': version })),
        anonymous: code(await send(await h.client(), 'PATCH', '/auth/profile', { displayName: 'Nueva' }, { 'If-Match': version })),
      };
      const ok = await send(c, 'PATCH', '/auth/profile', { displayName: '  Nombre nuevo  ' }, { 'If-Match': version });
      assert.equal(ok.status, 200); assert.equal(ok.body.data?.['displayName'], 'Nombre nuevo'); assert(ok.headers['etag'] && ok.headers['etag'] !== version);
      const stale = code(await send(c, 'PATCH', '/auth/profile', { displayName: 'Otra vez' }, { 'If-Match': version }));
      const after = (await f.identity.identities.findOne({ _id: a.subject._id }))!;
      assert.equal(after.passwordHash, a.subject.passwordHash); assert.equal(after.credentialVersion, a.subject.credentialVersion); assert.deepEqual(after.roles, []);
      assert.equal((await f.identity.identities.findOne({ _id: b.subject._id }))!.displayName, 'Revisora sintética');
      assert.equal(results.noIfMatch, '428:PRECONDITION_REQUIRED'); assert.equal(results.foreignVersion, '412:PRECONDITION_FAILED'); assert.equal(stale, '412:PRECONDITION_FAILED');
      assert.equal(results.tooLong.split(':')[0], '422'); assert.equal(results.blank.split(':')[0], '422'); assert.equal(results.extra.split(':')[0], '422');
      assert(!results.anonymous.startsWith('2'));
      observe('R10', { ...results, stale });
    });

    await t.test('R11 AT02/D6: 409 sin sesión ni cambios; login y A18 siguen neutros; A03 desde B', async () => {
      const f = await profile.fixture(), h = await f.https(), a = await f.confirmed(), p = await h.client();
      const dup = await post(p, '/auth/register', { email: a.email.toUpperCase(), displayName: 'Intrusa', password: other, privacyPolicyVersion: 'synthetic-v1', acceptTerms: true });
      assert.equal(code(dup), '409:ACCOUNT_ALREADY_EXISTS');
      assert(!(dup.headers['set-cookie'] ?? []).some(v => v.startsWith('__Host-caudelyx-session=') && !v.startsWith('__Host-caudelyx-session=;')));
      const stored = (await f.identity.identities.findOne({ _id: a.subject._id }))!;
      assert.equal(stored.passwordHash, a.subject.passwordHash); assert.equal(stored.displayName, 'Revisora sintética');
      const loginKnown = await post(await h.client(), '/auth/login', { email: a.email, password: other });
      const loginUnknown = await post(await h.client(), '/auth/login', { email: 'nadie-' + randomUUID() + '@example.test', password: other });
      assert.equal(code(loginKnown), code(loginUnknown)); assert.deepEqual(Object.keys(loginKnown.body), Object.keys(loginUnknown.body));
      const resetKnown = await post(await h.client(), '/auth/password-reset/request', { email: a.email });
      const resetUnknown = await post(await h.client(), '/auth/password-reset/request', { email: 'nadie-' + randomUUID() + '@example.test' });
      assert.equal(resetKnown.status, 202); assert.deepEqual(resetKnown.body.data, resetUnknown.body.data);
      const pending = await f.signup(), cb = await h.client(pending.issued.token);
      const foreign = code(await post(cb, '/auth/email-verifications/request', { purpose: 'ACTIVATION', email: a.email }));
      const missing = code(await post(cb, '/auth/email-verifications/request', { purpose: 'ACTIVATION', email: 'nadie-' + randomUUID() + '@example.test' }));
      assert.equal(foreign, missing, 'B gets no oracle about other emails');
      const own = code(await post(cb, '/auth/email-verifications/request', { purpose: 'ACTIVATION', email: pending.email }));
      observe('R11', { dup: code(dup), login: code(loginKnown), foreign, missing, own });
    });

    await t.test('R12 D5: cuenta pendiente previa a AJ sin contraseña sale por RESET', async () => {
      const f = await profile.fixture(), id = randomUUID(), email = 'legado-' + randomUUID() + '@example.test';
      const legacy: Identity = { _id: id, realm: 'TENANT', email, displayName: 'Legado', passwordHash: null, state: 'PENDING_EMAIL', organizationId: null, roles: [], version: '"v1"',
        credentialVersion: randomUUID(), initialProofEpoch: randomUUID(), authEpoch: randomUUID(), authzVersion: randomUUID(), hasEverConfirmedFactor: false, hasEverActive: false,
        resetCompletedAt: null, restoreBootstrapBlocked: false, suspended: false, createdAt: f.now(), factorCount: 0 };
      await f.identity.identities.insertOne(legacy);
      await f.database.transaction(async s => { await f.messages.enqueue(legacy, 'ACTIVATION', 'legacy', null, s); });
      const activation = (await f.mail(id, 'ACTIVATION')).token;
      await assert.rejects(f.identity.confirmEmail((await f.sessions.issue('TENANT', 'P', null)).context, { purpose: 'ACTIVATION', token: activation }), denied('INPUT_INVALID'));
      await assert.rejects(f.identity.confirmEmail((await f.sessions.issue('TENANT', 'P', null)).context, { purpose: 'ACTIVATION', token: activation, newPassword: other }), denied('INPUT_INVALID'));
      const p = await f.sessions.issue('TENANT', 'P', null);
      await f.identity.requestEmail('TENANT', 'legacy-reset', 'RESET', email, p.context);
      const reset = (await f.mail(id, 'RESET')).token;
      const preview = await f.identity.reset(p.context, { mode: 'PREVIEW', token: reset }, 'legacy') as { warningRequired: boolean };
      assert.equal(preview.warningRequired, false);
      await f.identity.reset(p.context, { mode: 'CONFIRM', token: reset, newPassword: other, warningAcknowledged: false }, 'legacy');
      const login = await f.identity.login('TENANT', 'legacy-login', email, other);
      assert.equal(login.issued.context.kind, 'B'); assert.equal(login.data.authState, 'MFA_ENROLLMENT');
      const e = await f.runtime.totp.enroll(login.issued.context, 'Legado', other);
      const done = await f.runtime.totp.confirm(login.issued.context, e.enrollmentId, await f.totpCode(new URL(e.provisioningUri).searchParams.get('secret')!));
      assert.equal(done.issued?.context.kind, 'S');
    });

    await t.test('R13 AT13: confirmar con B propia rota sin extender la vida absoluta', async () => {
      const f = await profile.fixture(), a = await f.signup();
      // First run used +60 min: the token correctly expired (AT-ONB-05). Rotation is checked just inside the window.
      f.clock.value += 59 * 60000; await f.sessions.contexts.updateOne({ _id: a.issued.context._id }, { $set: { lastSeenAt: f.now() } });
      const c = await f.identity.confirmEmail(a.issued.context, { purpose: 'ACTIVATION', token: a.token });
      assert.equal(c.issued!.context.kind, 'B'); assert.equal(c.issued!.context.expiresAt, a.issued.context.expiresAt); assert.equal(c.issued!.context.createdAt, a.issued.context.createdAt);
      assert.equal(await f.sessions.find(a.issued.token, 'TENANT'), null);
    });

    await t.test('R15 AT13: fallo del almacén cierra la sesión B con 503, sin datos', async () => {
      const f = await profile.fixture(), h = await f.https(), a = await f.signup(), c = await h.client(a.issued.token);
      assert.equal((await c.call('GET', '/api/v1/auth/me')).status, 200);
      await f.database.close();
      const me = await c.call('GET', '/api/v1/auth/me'), org = await c.call('GET', '/api/v1/organization');
      assert.equal(code(me), '503:SERVICE_UNAVAILABLE'); assert.equal(me.body.data, undefined); assert.equal(org.status, 503);
    });

    await t.test('R16 AT09: dos B con intentos propios confirman en paralelo, un único primer factor', async () => {
      const f = await profile.fixture(), a = await f.confirmed();
      const twin = (await f.identity.login('TENANT', 'r16', a.email, password)).issued;
      const e1 = await f.runtime.totp.enroll(a.issued.context, 'Uno', password), e2 = await f.runtime.totp.enroll(twin.context, 'Dos', password);
      const s = (e: { provisioningUri: string }) => new URL(e.provisioningUri).searchParams.get('secret')!;
      const [r1, r2] = await Promise.allSettled([f.runtime.totp.confirm(a.issued.context, e1.enrollmentId, await f.totpCode(s(e1))), f.runtime.totp.confirm(twin.context, e2.enrollmentId, await f.totpCode(s(e2)))]);
      assert.equal([r1, r2].filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(await f.sessions.factors.countDocuments({ subjectId: a.subject._id, state: 'ACTIVE' }), 1);
      const stored = (await f.identity.identities.findOne({ _id: a.subject._id }))!;
      assert.equal(stored.factorCount, 1); assert.equal(stored.state, 'AUTHENTICATED_NO_ORG');
      assert.equal(await f.sessions.contexts.countDocuments({ subjectId: a.subject._id, kind: 'B', revoked: false }), 0);
    });

    await t.test('R17 AT03: cookie B de tenant no sirve en el realm de plataforma', async () => {
      const f = await profile.fixture(), h = await f.https(), a = await f.signup();
      const c = new ApiClient(h.port, h.cert, 'platform.localhost'); c.cookies.set('__Host-caudelyx-session', a.issued.token); c.cookies.set('__Host-caudelyx-platform-session', a.issued.token);
      const me = await c.call('GET', '/api/v1/auth/me');
      assert.equal(me.status, 401); assert.equal(me.body.data, undefined);
      await c.refreshCsrf();
      const profilePatch = await c.call('PATCH', '/api/v1/auth/profile', { displayName: 'Plataforma' }, { 'If-Match': '"x"' });
      assert.equal(code(profilePatch), '403:ACCESS_DENIED');
      observe('R17', { me: code(me), profilePatch: code(profilePatch) });
    });

    await t.test('R14 AJ4-F02: reemplazo de gate.json con un lector externo abierto', async () => {
      const f = await profile.fixture(), gate = join(folder, 'gate.json');
      const snapshot = await f.restore.snapshot();
      const hold = async (kind: 'node' | 'powershell') => {
        const script = kind === 'node'
          ? ['-e', `const fs=require('fs');const fd=fs.openSync(${JSON.stringify(gate)},'r');process.stdout.write('held\\n');setTimeout(()=>fs.closeSync(fd),4000);`]
          : ['-NoProfile', '-NonInteractive', '-Command', `$s=[System.IO.File]::Open('${gate.replace(/'/g, "''")}','Open','Read','Read');[Console]::Out.WriteLine('held');Start-Sleep -Seconds 4;$s.Close()`];
        const child = spawn(kind === 'node' ? process.execPath : 'powershell.exe', script, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        await receipt({ event: 'diagnostic-child-created', kind, pid: child.pid });
        await new Promise<void>((ok, fail) => { const timer = setTimeout(() => fail(Error('holder timeout')), 15000); child.stdout!.on('data', b => { if (String(b).includes('held')) { clearTimeout(timer); ok(); } }); });
        const exited = once(child, 'exit');
        return async () => { await exited; await receipt({ event: 'diagnostic-child-stopped', kind, pid: child.pid }); };
      };
      const result = new Map<string, Record<string, unknown>>();
      for (const kind of ['node', 'powershell'] as const) {
        const openBefore = f.restore.isOpen();
        const release = await hold(kind);
        const attempt = await f.restore.beginRestore(snapshot).then(() => 'started', (e: unknown) => (e as NodeJS.ErrnoException).code ?? (e instanceof AppError ? e.code : String(e)));
        const entry: Record<string, unknown> = { attempt, openBefore, openAfter: f.restore.isOpen(), identitiesUntouched: await f.identity.identities.countDocuments() }; result.set(kind, entry);
        await release();
        if (attempt === 'started') await f.restore.reconcile({ approved: true, reviewId: 'aj5-f02-' + kind });
        else {
          const retry = await f.restore.beginRestore(snapshot).then(() => 'started', (e: unknown) => String((e as NodeJS.ErrnoException).code ?? e));
          entry['retryAfterRelease'] = retry;
          if (retry === 'started') await f.restore.reconcile({ approved: true, reviewId: 'aj5-f02-retry-' + kind });
        }
        assert.equal(f.restore.isOpen(), true);
      }
      observe('R14-F02', Object.fromEntries(result));
    });

    await t.test('R18 AT14/AT15/AT20/AT21: navegador real, QR = URI, TOTP, S, R y organización', async () => {
      const f = await profile.fixture({ static: true }), h = await f.https(), nonce = randomUUID();
      const controlPort = await freePort([profile.port, h.port]);
      await receipt({ event: 'control-reserved-before-listen', controlPort });
      const actions: string[] = [];
      const control = createControlServer(async (req, res) => {
        if (req.headers['x-fixture-owner'] !== nonce || req.method !== 'POST') { res.writeHead(403); res.end(); return; }
        try {
          let raw = ''; for await (const part of req) { raw += String(part); if (raw.length > 4096) throw Error('Control too large'); }
          const body = JSON.parse(raw) as Record<string, string | number>, email = String(body['email'] ?? '');
          if (email && !email.endsWith('@example.test')) throw Error('Synthetic email only');
          actions.push(String(body['action']));
          let data: unknown;
          if (body['action'] === 'mail') { const s = await f.identity.identities.findOne({ email }); data = { token: (await f.mail(s?._id ?? '', String(body['purpose']))).token }; }
          else if (body['action'] === 'inspect') { const s = await f.identity.identities.findOne({ email }); data = { exists: !!s, emailVerified: s?.emailVerified ?? null, state: s?.state ?? null, hash: createHash('sha256').update(s?.passwordHash ?? '').digest('hex') }; }
          else if (body['action'] === 'code') data = { code: await f.totpCode(String(body['secret'])) };
          else if (body['action'] === 'tick') { f.clock.value += Number(body['ms'] ?? 30000); data = { now: f.now() }; }
          else throw Error('Unknown own control');
          res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data));
        } catch { res.writeHead(400); res.end('{}'); }
      });
      control.listen(controlPort, '127.0.0.1'); await once(control, 'listening');
      const started = Date.now();
      const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/independent/aj-onb/playwright.config.ts'], { cwd: resolve('../cliente'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, AJ5_URL: 'https://localhost:' + h.port, AJ5_CONTROL: 'http://127.0.0.1:' + controlPort, AJ5_NONCE: nonce, AJ5_OUTPUT: folder } });
      await receipt({ event: 'playwright-child-created', pid: child.pid });
      let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { output += String(b); });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        timer = setTimeout(() => child.kill(), 240000);
        const [exit] = await once(child, 'exit');
        const redacted = output.replace(/otpauth:\/\/[^\s"']+/g, 'otpauth://[REDACTED]');
        await appendFile(resolve('../../Construccion/Sprints/AJ-ONB/Evidencias/AJ-ONB-5-browser.log'), `\n===== ${new Date(started).toISOString()} R18 exit=${String(exit)} ${(Date.now() - started) / 1000}s controlActions=${actions.join(',')}\n` + redacted);
        observe('R18', { exit, seconds: (Date.now() - started) / 1000, evidence: redacted.match(/AJ5_EVIDENCE (.*)/)?.[1] ?? null });
        assert.equal(exit, 0, 'real browser journey must pass');
      } finally {
        clearTimeout(timer); if (child.exitCode === null && !child.killed) { child.kill(); await once(child, 'exit'); }
        await new Promise<void>(r => control.close(() => r()));
        await receipt({ event: 'playwright-child-stopped', pid: child.pid, controlPort });
      }
      const stored = (await f.identity.identities.findOne({ email: { $regex: /^r5-e2e-/ } }))!;
      assert.equal(stored.state, 'ACTIVE'); assert.deepEqual(stored.roles, ['T']); assert(stored.organizationId);
      assert.equal(await f.sessions.factors.countDocuments({ subjectId: stored._id, state: 'ACTIVE' }), 1);
      assert.equal(await f.sessions.factors.countDocuments({ subjectId: stored._id, state: 'PENDING_INITIAL' }), 0);
      assert.equal(await f.sessions.contexts.countDocuments({ subjectId: stored._id, kind: 'B', revoked: false }), 0);
    });
  } finally {
    await receipt({ event: 'observations', observations: Object.fromEntries(observations) });
    console.log('AJ5_OBSERVATIONS ' + JSON.stringify(Object.fromEntries(observations)));
    await profile.dispose();
  }
});
