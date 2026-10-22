/* eslint-disable security/detect-non-literal-fs-filename -- Paths are this test's own controller/journal fixtures, never request input. */
// S01-P05-REVAL-v3 independent tests (Claude) on candidate P04-v3-INTEGRADO. Real HTTPS app + real MongoDB replica set, controllable clock.
// The software authenticator below produces genuine ECDSA P-256 signatures that the server verifies with
// @simplewebauthn/server; it is not a mock of verification. No secret, token or key is printed or persisted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { once } from 'node:events';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { fixture } from '../helpers/fixture.js';
import { testCertificate } from '../helpers/tls.js';
import { ApiClient } from '../helpers/client.js';
import { createApp } from '../../src/app.js';
import { attachRuntime } from '../../src/shared/runtime.js';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { readFile, writeFile, unlink, stat, utimes, copyFile, rename, open as openFile } from 'node:fs/promises';
import { Database } from '../../src/shared/database.js';
import { Sessions } from '../../src/modules/sessions/service.js';
import { SyntheticMessaging } from '../../src/modules/messaging/service.js';
import { IdentityService } from '../../src/modules/identity/service.js';
import { PasswordHasher } from '../../src/modules/identity/password.js';
import { RestoreController } from '../../src/shared/restore.js';
import { captureSecurityState, reconstructSecurityState } from '../../src/shared/evidence.js';
import { startReplicaSet } from '../helpers/replica-set.js';

// ---------- shared harness (duplicated per P05 file on purpose: reservation allows only these four files) ----------
type Cbor = number | string | Buffer | Cbor[] | Map<Cbor, Cbor>;
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3); b.writeUInt8((major << 5) | 25, 0); b.writeUInt16BE(n, 1); return b;
}
function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, s.length), s]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const parts = [head(5, v.size)]; for (const [k, x] of v) parts.push(cbor(k), cbor(x)); return Buffer.concat(parts);
}
const b64u = (b: Buffer) => b.toString('base64url');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();
interface Tweak { flags?: number; origin?: string; rpId?: string; type?: string; challenge?: string; counter?: number; tamper?: boolean }
class SoftPasskey {
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  readonly id = randomBytes(32);
  counter = 0;
  constructor(public origin: string, readonly rpId = 'localhost') {}
  private cose(): Buffer {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    return cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(String(jwk.x), 'base64url')], [-3, Buffer.from(String(jwk.y), 'base64url')]]));
  }
  private client(type: string, challenge: string, origin: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }
  registration(challenge: string, t: Tweak = {}, extra: Record<string, unknown> = {}) {
    const count = Buffer.alloc(4); count.writeUInt32BE(t.counter ?? 0);
    const len = Buffer.alloc(2); len.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([sha(t.rpId ?? this.rpId), Buffer.from([t.flags ?? 0x45]), count, Buffer.alloc(16), len, this.id, this.cose()]);
    const attestation = cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return { id: b64u(this.id), rawId: b64u(this.id), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(this.client(t.type ?? 'webauthn.create', t.challenge ?? challenge, t.origin ?? this.origin)), attestationObject: b64u(attestation), ...extra } };
  }
  assertion(challenge: string, t: Tweak = {}) {
    const next = t.counter ?? ++this.counter;
    const count = Buffer.alloc(4); count.writeUInt32BE(next);
    const authData = Buffer.concat([sha(t.rpId ?? this.rpId), Buffer.from([t.flags ?? 0x05]), count]);
    const clientData = this.client(t.type ?? 'webauthn.get', t.challenge ?? challenge, t.origin ?? this.origin);
    const signature = sign('sha256', Buffer.concat([authData, sha(clientData)]), this.keys.privateKey);
    if (t.tamper) signature.writeUInt8(signature.readUInt8(signature.length - 1) ^ 0xff, signature.length - 1);
    return { id: b64u(this.id), rawId: b64u(this.id), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature) } };
  }
}
async function freePort(): Promise<number> {
  const probe = createNetServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const address = probe.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(r => probe.close(() => r())); return address.port;
}
const s = (v: unknown): string => { assert.equal(typeof v, 'string'); return v as string; };
type Stack = Awaited<ReturnType<typeof stack>>;
async function stack(options: { controlledRestore?: boolean } = {}) {
  const f = await fixture(options), tls = await testCertificate(), port = await freePort();
  const config = { mongoUri: f.uri, databaseName: f.database.db.databaseName, port,
    tenantOrigin: `https://localhost:${port}`, platformOrigin: `https://platform.localhost:${port}` };
  const keys = { version: 1 as const, mail: f.mailKey, totp: f.totpKey, journal: randomBytes(32), cursor: randomBytes(32) };
  const runtime = await attachRuntime(f.identity, keys, config);
  const server = createServer(tls, createApp({ identity: f.identity, config })).listen(port, '127.0.0.1'); await once(server, 'listening');
  const client = (host = 'localhost') => new ApiClient(port, tls.cert, host);
  return { f, tls, port, config, keys, runtime, client, origin: config.tenantOrigin,
    close: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await f.close(); } };
}
const PASSWORD = 'independent P05 synthetic passphrase 24680';
async function mailToken(st: Stack, subjectId: string, purpose: string): Promise<string> {
  await st.f.identity.dispatchMail();
  const mail = [...st.f.messages.inbox.values()].reverse().find(m => m.subjectId === subjectId && m.purpose === purpose);
  assert.ok(mail, `synthetic ${purpose} mail`); st.f.messages.inbox.delete(mail.id); return mail.token;
}
/** Activated identity holding E_INITIAL over HTTP (setup uses the service only for the synthetic registration intent). */
async function activated(st: Stack, email = `${randomUUID()}@example.test`) {
  await st.f.identity.register('TENANT', `p05-setup-${randomUUID()}`, { email, displayName: 'Persona P05', privacyPolicyVersion: 'synthetic-v1' });
  const subject = await st.f.identity.identities.findOne({ email }); assert.ok(subject);
  const token = await mailToken(st, subject._id, 'ACTIVATION');
  const c = st.client(); await c.refreshCsrf();
  const r = await c.call('POST', '/api/v1/auth/email-verifications/confirm', { purpose: 'ACTIVATION', token, newPassword: PASSWORD });
  assert.equal(r.status, 200, 'A04 activation'); await c.refreshCsrf();
  return { c, email, userId: subject._id };
}
async function enrollPasskey(c: ApiClient, key: SoftPasskey, extra: Record<string, unknown> = {}) {
  const o = await c.call('POST', '/api/v1/auth/mfa/webauthn/registration/options', { label: 'Passkey P05' });
  assert.equal(o.status, 200, 'A24');
  const pk = o.body.data?.['publicKey'] as { challenge: string };
  const r = await c.call('POST', '/api/v1/auth/mfa/webauthn/registration/verify', { ceremonyId: s(o.body.data?.['ceremonyId']), credential: key.registration(pk.challenge, {}, extra) });
  return r;
}
async function actor(st: Stack, email?: string) {
  const a = await activated(st, email), key = new SoftPasskey(st.origin);
  const r = await enrollPasskey(a.c, key); assert.equal(r.status, 201, 'A25 first passkey'); await a.c.refreshCsrf();
  return { ...a, key };
}
async function passkeyVerify(c: ApiClient, key: SoftPasskey, purpose: string, resourceId?: string, t: Tweak = {}) {
  const target = { purpose, ...(resourceId ? { resourceId } : {}) };
  const o = await c.call('POST', '/api/v1/auth/mfa/webauthn/authentication/options', target);
  if (o.status !== 200) return o;
  const challenge = (o.body.data?.['publicKey'] as { challenge: string }).challenge;
  const r = await c.call('POST', '/api/v1/auth/mfa/challenges/verify', { ...target, method: 'WEBAUTHN', ceremonyId: s(o.body.data?.['ceremonyId']), credential: key.assertion(challenge, t) });
  if (r.status === 200) await c.refreshCsrf();
  return r;
}
async function login(st: Stack, email: string, password = PASSWORD) {
  const c = st.client(); await c.refreshCsrf();
  const r = await c.call('POST', '/api/v1/auth/login', { email, password }); await c.refreshCsrf();
  return { c, r };
}
async function stepUp(c: ApiClient, key: SoftPasskey, purpose: string, resourceId?: string, command?: Record<string, unknown>) {
  const a = await c.call('POST', '/api/v1/auth/reauthenticate', { password: PASSWORD, purpose, ...(resourceId ? { resourceId } : {}), ...(command ? { command } : {}) });
  assert.equal(a.status, 200, `A32 ${purpose}`);
  const v = await passkeyVerify(c, key, purpose, resourceId); assert.equal(v.status, 200, `A27 ${purpose}`);
}
const evidence = (name: string, data: Record<string, unknown>) => console.log(JSON.stringify({ evidence: name, ...data }));
// ---------- end harness ----------

// ---------- real-clock harness mirroring src/server.ts (Date.now, file journal, single-task 1s dispatcher) ----------
async function realStack(existing?: { uri: string; dbName: string; keys: { version: 1; mail: Buffer; totp: Buffer; journal: Buffer; cursor: Buffer }; gatePath: string }) {
  const replica = existing ? null : await startReplicaSet();
  const uri = existing?.uri ?? replica?.uri ?? '', tls = await testCertificate(), port = await freePort();
  const dbName = existing?.dbName ?? `caudelyx_${randomUUID().replaceAll('-', '')}`, database = new Database(uri, dbName); await database.connect();
  const keys = existing?.keys ?? { version: 1 as const, mail: randomBytes(32), totp: randomBytes(32), journal: randomBytes(32), cursor: randomBytes(32) };
  const gatePath = existing?.gatePath ?? resolve('.runtime', `gate-${dbName}.json`);
  const restore = new RestoreController(database, gatePath, keys.journal); await restore.initialize();
  const messaging = new SyntheticMessaging(database, keys.mail, Date.now);
  const identity = new IdentityService(database, new Sessions(database), messaging, new PasswordHasher(), () => restore.isOpen());
  await identity.initialize();
  const config = { mongoUri: uri, databaseName: dbName, port, tenantOrigin: `https://localhost:${port}`, platformOrigin: `https://platform.localhost:${port}` };
  await attachRuntime(identity, keys, config);
  const server = createServer(tls, createApp({ identity, config })).listen(port, '127.0.0.1'); await once(server, 'listening');
  const state = { dispatcher: false, errors: 0 };
  let pending: Promise<void> | null = null;
  const timer = setInterval(() => { if (!state.dispatcher || pending) return; pending = (async () => { await restore.flush(); if (restore.isOpen()) { await identity.dispatchMail(); await identity.beforeRequest?.(); } })().catch(() => { state.errors++; }).finally(() => { pending = null; }); }, 1000);
  const client = () => new ApiClient(port, tls.cert);
  return { identity, messaging, restore, database, state, client, origin: config.tenantOrigin, gatePath, keys, uri, dbName,
    drain: async () => { while (pending) await pending; },
    close: async (removeFiles = true) => {
      clearInterval(timer); state.dispatcher = false; while (pending) await pending; server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
      await database.close(); await replica?.stop();
      if (removeFiles) for (const f of [gatePath, gatePath + '.journal.jsonl', gatePath + '.journal.jsonl.lock']) await unlink(f).catch(() => undefined);
    },
    stopReplica: async () => { await replica?.stop(); } };
}
type Real = Awaited<ReturnType<typeof realStack>>;
async function realEnroll(rs: Real, peers: Real[] = []) {
  const email = `${randomUUID()}@example.test`;
  await rs.identity.register('TENANT', `p05v3-${randomUUID()}`, { email, displayName: 'P05 v3', privacyPolicyVersion: 'synthetic-v1' });
  const subject = await rs.identity.identities.findOne({ email }); assert.ok(subject);
  let token: string | undefined; const t0 = performance.now();
  for (let n = 0; n < 600 && !token; n++) {
    if (!rs.state.dispatcher) await rs.identity.dispatchMail();
    token = [rs, ...peers].flatMap(x => [...x.messaging.inbox.values()]).find(m => m.subjectId === subject._id && m.purpose === 'ACTIVATION')?.token;
    if (!token) await new Promise(r => setTimeout(r, 100));
  }
  const mailWaitMs = Math.round(performance.now() - t0);
  if (!token) return { status: 0, code: 'NO_MAIL_60S', ms: 0, mailWaitMs, client: undefined };
  const c = rs.client(); await c.refreshCsrf();
  const a04 = await c.call('POST', '/api/v1/auth/email-verifications/confirm', { purpose: 'ACTIVATION', token, newPassword: PASSWORD });
  if (a04.status !== 200) return { status: a04.status, code: `A04_${a04.body.error?.code ?? ''}`, ms: 0, mailWaitMs, client: undefined };
  await c.refreshCsrf();
  const key = new SoftPasskey(rs.origin), o = await c.call('POST', '/api/v1/auth/mfa/webauthn/registration/options', { label: 'V3' }); assert.equal(o.status, 200);
  const t = performance.now();
  const r = await c.call('POST', '/api/v1/auth/mfa/webauthn/registration/verify', { ceremonyId: s(o.body.data?.['ceremonyId']), credential: key.registration((o.body.data?.['publicKey'] as { challenge: string }).challenge) });
  if (r.status === 201) await c.refreshCsrf();
  return { status: r.status, code: r.body.error?.code ?? null, ms: Math.round(performance.now() - t), mailWaitMs, client: c };
}
/** Explicit SYNTHETIC signed legacy full-state checkpoints (format/volume only; not product activity). */
async function seedLegacy(rs: Real, targetBytes: number) {
  const state = JSON.parse(JSON.stringify(await rs.database.transaction(session => captureSecurityState(rs.database, session)))) as { identities: { _id: string }[] };
  let sequence = (await rs.database.db.collection<{ _id: string; value: number }>('security_sequence').findOne({ _id: 'security' }))?.value ?? 0;
  const one = Buffer.byteLength(JSON.stringify({ _id: sequence + 1, eventId: randomUUID(), previous: 'f'.repeat(64), state, signature: 'f'.repeat(64) }) + '\n');
  const count = Math.ceil((targetBytes - (await stat(rs.restore.fileJournal.path)).size) / one) + 1;
  const rows = Array.from({ length: count }, () => ({ _id: ++sequence, eventId: randomUUID(), state }));
  const actor = state.identities[0]?._id ?? 'synthetic';
  await rs.database.client.withSession(session => session.withTransaction(async () => {
    await rs.database.db.collection('security_evidence_outbox').insertMany(rows as unknown as Record<string, unknown>[], { session });
    await rs.database.db.collection('audit_events').insertMany(rows.map(r => ({ eventId: r.eventId, sequence: r._id, realm: 'TENANT', action: 'P05V3_SYNTHETIC_LEGACY_CHECKPOINT', subjectId: actor, actorId: actor, outcome: 'SUCCESS', createdAt: new Date() })), { session });
    await rs.database.db.collection<{ _id: string; value: number }>('security_sequence').updateOne({ _id: 'security' }, { $set: { value: sequence } }, { session });
  }));
  await rs.restore.flush();
  return { count, bytes: (await stat(rs.restore.fileJournal.path)).size };
}
const timed = (fn: () => unknown, n: number) => { const t = performance.now(); for (let i = 0; i < n; i++) fn(); return +(performance.now() - t).toFixed(1); };

test('P05v3-N01-A legacy signed journal >10MB: hot guards stay cheap, restart verifies async, 8/8 A25 with real dispatcher and 1000ms window intact', { timeout: 900000 }, async () => {
  const rs = await realStack();
  try {
    for (let i = 0; i < 20; i++) assert.equal((await realEnroll(rs)).status, 201);
    await rs.restore.flush();
    const legacy = await seedLegacy(rs, 12 * 1024 * 1024);
    assert.ok(legacy.bytes > 10 * 1024 * 1024);
    const before = { ...rs.restore.fileJournal.diagnostics };
    const guards500 = timed(() => rs.restore.isOpen(), 500);
    const after = { ...rs.restore.fileJournal.diagnostics };
    // Restart on the same files: async full verification during initialize; measure event-loop stalls.
    const lag0 = monitorEventLoopDelay({ resolution: 10 }); lag0.enable();
    // Separate connection: initialize() installs its own transaction guard on ITS Database object (as a restarted process would).
    const restartDb = new Database(rs.uri, rs.dbName); await restartDb.connect();
    const restarted = new RestoreController(restartDb, rs.gatePath, rs.keys.journal);
    const ti = performance.now(); await restarted.initialize(); const initializeMs = Math.round(performance.now() - ti); lag0.disable();
    const restartedOpen = restarted.isOpen(); await restartDb.close();
    const control: Awaited<ReturnType<typeof realEnroll>>[] = [];
    for (let n = 0; n < 8; n++) control.push(await realEnroll(rs));
    const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable(); rs.state.dispatcher = true;
    const trial: Awaited<ReturnType<typeof realEnroll>>[] = [];
    for (let n = 0; n < 8; n++) trial.push(await realEnroll(rs));
    rs.state.dispatcher = false; await rs.drain(); lag.disable();
    const finalBytes = (await stat(rs.restore.fileJournal.path)).size;
    const rows = await rs.restore.fileJournal.readVerified(true);
    const deltaRows = rows.filter(r => r.state.format === 'delta-v1').length, legacyRows = rows.length - deltaRows;
    evidence('P05v3-N01-A', { legacyBytes: legacy.bytes, legacyCheckpoints: legacy.count, guards500ms: guards500, fullReadsDuringGuards: after.fullAsyncReads - before.fullAsyncReads,
      inlineReadsDuringGuards: after.boundedInlineReads - before.boundedInlineReads, initializeMs, initializeMaxLoopDelayMs: Math.round(lag0.max / 1e6), restartedOpen,
      control: control.map(c => c.status), trial: trial.map(t => `${t.status}/${t.ms}ms`), maxLoopDelayMs: Math.round(lag.max / 1e6), p99LoopDelayMs: Math.round(lag.percentile(99) / 1e6),
      dispatcherErrors: rs.state.errors, finalBytes, legacyRows, deltaRows, windowMs: 1000 });
    assert.equal(after.fullAsyncReads - before.fullAsyncReads, 0, 'no full reads in hot guards'); assert.ok(guards500 < 1000);
    assert.ok(restartedOpen); assert.ok(control.every(c => c.status === 201)); assert.ok(trial.every(t => t.status === 201), JSON.stringify(trial));
    assert.equal(rs.state.errors, 0); assert.ok(lag.max / 1e6 < 1000, 'event loop never blocked past the 1000ms MFA window');
  } finally { await rs.close(); }
});

test('P05v3-N01-B large journal tamper: in-place same-size, mtime-restored, replaced, truncated, deleted, rolled back, forged tail all close; restart/reconcile never trust Mongo alone', { timeout: 600000 }, async () => {
  const rs = await realStack();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await realEnroll(rs)).status, 201);
    await rs.restore.flush(); await seedLegacy(rs, 2 * 1024 * 1024);
    const path = rs.restore.fileJournal.path, good = await readFile(path), goodStat = await stat(path);
    const observed = new Map<string, unknown>();
    let live = rs.restore;
    const check = async (name: string, mutate: () => Promise<void>, genuine = false) => {
      assert.equal(live.isOpen(), true, `precondition ${name}`);
      await mutate();
      const hot = live.isOpen();
      const fresh = new RestoreController(rs.database, rs.gatePath, rs.keys.journal); await fresh.initialize();
      const restartOpen = fresh.isOpen();
      let reconcile = 'not attempted';
      if (!restartOpen) { try { await fresh.reconcile({ approved: true, reviewId: 'P05v3-synthetic-fixture' }); reconcile = 'reconciled'; } catch { reconcile = 'refused'; } }
      observed.set(name, { hotIsOpen: hot, restartOpen, reconcile });
      assert.equal(hot, false, `${name}: hot guard closes on any stamp change of a large file`);
      if (genuine) assert.equal(restartOpen, true, `${name}: genuine bytes re-verified asynchronously`);
      else { assert.equal(restartOpen, false, name); assert.equal(reconcile, 'refused', name); }
      // Operator restores the exact bytes; reopening only through complete chain (+ explicit synthetic review if closed).
      await writeFile(path, good);
      const back = new RestoreController(rs.database, rs.gatePath, rs.keys.journal); await back.initialize();
      if (!back.isOpen()) await back.reconcile({ approved: true, reviewId: `P05v3-synthetic-restore-${name}` });
      live = new RestoreController(rs.database, rs.gatePath, rs.keys.journal); await live.initialize();
      assert.equal(live.isOpen(), true, `restore ${name}`);
    };
    const middle = Math.floor(good.length / 2);
    await check('in-place byte flip same size', async () => { const h = await openFile(path, 'r+'); try { const b = Buffer.from([good.readUInt8(middle) === 0x41 ? 0x42 : 0x41]); await h.write(b, 0, 1, middle); } finally { await h.close(); } });
    await check('in-place flip with mtime restored', async () => { const h = await openFile(path, 'r+'); try { await h.write(Buffer.from([good.readUInt8(middle) === 0x41 ? 0x42 : 0x41]), 0, 1, middle); } finally { await h.close(); } await utimes(path, goodStat.atime, goodStat.mtime); });
    await check('replaced by modified copy', async () => { const tmp = path + '.p05v3.tmp'; const copy = Buffer.from(good); copy.writeUInt8(copy.readUInt8(middle) === 0x41 ? 0x42 : 0x41, middle); await writeFile(tmp, copy); await rename(tmp, path); });
    await check('truncated by one byte', async () => { await writeFile(path, good.subarray(0, good.length - 1)); });
    await check('deleted', async () => { await unlink(path); });
    await check('rolled back to earlier prefix', async () => { const lines = good.toString('utf8').split('\n'); await writeFile(path, lines.slice(0, Math.floor(lines.length / 2)).join('\n') + '\n'); });
    await check('forged appended line', async () => { await writeFile(path, Buffer.concat([good, Buffer.from(good.toString('utf8').split('\n')[0] + '\n')])); });
    await check('identical bytes rewritten (metadata change only)', async () => { await copyFile(path, path + '.p05v3.same'); await rename(path + '.p05v3.same', path); }, true);
    evidence('P05v3-N01-B', { journalBytes: good.length, observed: Object.fromEntries(observed) });
  } finally { await rs.close(); }
});

test('P05v3-N01-C exact reconstruction legacy+delta+checkpoint vs live state after mixed operations and an aborted transaction; no partial event in either copy', { timeout: 420000 }, async () => {
  const st = await stack({ controlledRestore: true });
  try {
    const restore = st.f.restore; assert.ok(restore);
    const t = await actor(st);
    const command = { name: 'Org V3', timezone: 'America/Bogota', currency: 'COP' };
    await stepUp(t.c, t.key, 'ORGANIZATION_CREATE', undefined, command);
    assert.equal((await t.c.call('POST', '/api/v1/organizations', command, { 'Idempotency-Key': randomUUID() })).status, 201); await t.c.refreshCsrf();
    await stepUp(t.c, t.key, 'RECOVERY_CODES_REGENERATE'); assert.equal((await t.c.call('POST', '/api/v1/auth/mfa/recovery-codes/regenerate', {})).status, 200);
    const m = await actor(st);
    await restore.flush();
    // aborted transaction: audit validator rejects one action; nothing of it may reach the journals or projection
    const projBefore = await st.f.database.db.collection('security_evidence_projection').countDocuments();
    await st.f.database.db.command({ collMod: 'audit_events', validator: { $expr: { $ne: ['$action', 'RECOVERY_CODES_REPLACED'] } } });
    let aborted = 'committed';
    try { await stepUp(t.c, t.key, 'RECOVERY_CODES_REGENERATE'); const r = await t.c.call('POST', '/api/v1/auth/mfa/recovery-codes/regenerate', {}); aborted = String(r.status); }
    finally { await st.f.database.db.command({ collMod: 'audit_events', validator: {} }); }
    await t.c.refreshCsrf();
    await stepUp(m.c, m.key, 'SESSION_REVOKE_ALL'); assert.equal((await m.c.call('POST', '/api/v1/auth/sessions/revoke-all', {})).status, 204);
    await restore.flush();
    const rows = await restore.fileJournal.readVerified(true);
    const live = await st.f.database.transaction(session => captureSecurityState(st.f.database, session));
    const rebuilt = reconstructSecurityState(rows);
    const norm = (x: unknown) => JSON.stringify(x, (_k, v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v);
    const sortRows = (st2: Record<string, { _id: string }[]>) => Object.fromEntries(Object.entries(st2).map(([k, v]) => [k, [...v].sort((a, b) => a._id.localeCompare(b._id))]));
    const equal = norm(sortRows(rebuilt as unknown as Record<string, { _id: string }[]>)) === norm(sortRows(live as unknown as Record<string, { _id: string }[]>));
    const auditIds = new Set((await st.f.database.db.collection<{ eventId: string }>('audit_events').find({}, { projection: { eventId: 1 } }).toArray()).map(e => e.eventId));
    const orphanFile = rows.filter(r => !auditIds.has(r.eventId)).length;
    const mongoCopy = await st.f.database.client.db(`${st.f.database.db.databaseName}_external_security`).collection<{ eventId: string }>('events').find().toArray();
    const orphanMongo = mongoCopy.filter(e => !auditIds.has(e.eventId)).length;
    // Reconcile path rebuilds from both copies and drops the projection; the next event is a signed checkpoint.
    const snap = await restore.snapshot(); await restore.beginRestore(snap); await restore.reconcile({ approved: true, reviewId: 'P05v3-synthetic-fixture' });
    const l = await login(st, t.email); assert.equal((await passkeyVerify(l.c, t.key, 'LOGIN')).status, 200); await restore.flush();
    const after = await restore.fileJournal.readVerified(true);
    const tail = after.slice(rows.length);
    const checkpoint = tail.find(r => r.state.format === 'delta-v1')?.state.reset === true;
    const rebuilt2 = reconstructSecurityState(after), live2 = await st.f.database.transaction(session => captureSecurityState(st.f.database, session));
    const equal2 = norm(sortRows(rebuilt2 as unknown as Record<string, { _id: string }[]>)) === norm(sortRows(live2 as unknown as Record<string, { _id: string }[]>));
    evidence('P05v3-N01-C', { rows: rows.length, formats: { legacy: rows.filter(r => !r.state.format).length, delta: rows.filter(r => r.state.format === 'delta-v1').length },
      abortedRegenerateStatus: aborted, projectionBefore: projBefore, exactReconstruction: equal, orphanFileEvents: orphanFile, orphanMongoEvents: orphanMongo, firstEventAfterReconcileIsCheckpoint: checkpoint, exactAfterReconcile: equal2 });
    assert.notEqual(aborted, '200'); assert.ok(equal); assert.equal(orphanFile, 0); assert.equal(orphanMongo, 0); assert.ok(checkpoint); assert.ok(equal2);
  } finally { await st.close(); }
});

test('P05v3-N01-D two legitimate writers on the same files flush concurrently without closing; a peer holding the lock >5s is reported', { timeout: 300000 }, async () => {
  const st = await stack({ controlledRestore: true });
  try {
    const a = st.f.restore; assert.ok(a);
    const b = new RestoreController(st.f.database, a.gatePath, a.key); await b.initialize();
    const users: Promise<unknown>[] = [];
    for (let i = 0; i < 6; i++) users.push(actor(st));
    const flushes: Promise<string>[] = [];
    for (let i = 0; i < 4; i++) flushes.push((i % 2 ? a : b).flush().then(() => 'ok', () => 'fail'));
    await Promise.all(users); const results = await Promise.all(flushes); await a.flush(); await b.flush();
    const rows = await a.fileJournal.readVerified(true), seq = (await st.f.database.db.collection<{ _id: string; value: number }>('security_sequence').findOne({ _id: 'security' }))?.value;
    const concurrent = { flushResults: results, aOpen: a.isOpen(), bOpen: b.isOpen(), fileRows: rows.length, securitySequence: seq, contiguous: rows.every((r, i) => r._id === i + 1) };
    // Long-holding live peer (>5s) while the other instance flushes.
    let longOutcome = 'ok';
    const hold = a.fileJournal.exclusive(async () => { await new Promise(r => setTimeout(r, 6500)); });
    await new Promise(r => setTimeout(r, 200)); await actor(st);
    try { await b.flush(); } catch { longOutcome = 'flush failed'; }
    await hold;
    const afterLong = { outcome: longOutcome, bOpen: b.isOpen(), gateOpenOnDisk: a.isOpen() };
    evidence('P05v3-N01-D', { concurrent, longPeer: afterLong, note: 'long-peer outcome recorded for disposition; a closed gate here is fail-closed availability, not a bypass' });
    assert.ok(results.every(r => r === 'ok')); assert.ok(concurrent.aOpen && concurrent.bOpen); assert.ok(concurrent.contiguous); assert.equal(rows.length, seq);
  } finally { await st.close(); }
});

test('P05v3-N02 residual/garbage/dead-owner/foreign locks and flush errors close a DURABLE gate (also after restart); removing the lock never reopens; foreign lock never deleted', { timeout: 400000 }, async () => {
  const observed = new Map<string, unknown>();
  const variants: [string, (lock: string, key: Buffer) => Promise<void>][] = [
    ['empty residual lock', async lock => { await writeFile(lock, ''); }],
    ['garbage lock', async lock => { await writeFile(lock, 'not-json'); }],
    ['signed lock of dead pid', async (lock, key) => { const payload = { pid: 999999, nonce: randomUUID(), createdAt: Date.now() }; await writeFile(lock, JSON.stringify({ payload, signature: createHmac('sha256', key).update('lock:' + JSON.stringify(payload)).digest('hex') })); }],
    ['forged signature live pid', async lock => { const payload = { pid: process.pid, nonce: randomUUID(), createdAt: Date.now() }; await writeFile(lock, JSON.stringify({ payload, signature: 'f'.repeat(64) })); }],
  ];
  for (const [name, plant] of variants) {
    const st = await stack({ controlledRestore: true });
    try {
      const r = st.f.restore; assert.ok(r); await actor(st); await r.flush(); assert.equal(r.isOpen(), true);
      const lock = r.fileJournal.path + '.lock'; await plant(lock, r.key); const lockBytes = await readFile(lock);
      await actor(st).catch(() => undefined);
      let flush = 'ok'; try { await r.flush(); } catch { flush = 'failed'; }
      const lockKept = (await readFile(lock)).equals(lockBytes);
      const restarted = new RestoreController(st.f.database, r.gatePath, r.key); await restarted.initialize();
      const restartOpen = restarted.isOpen();
      await unlink(lock);
      const afterRemoval = new RestoreController(st.f.database, r.gatePath, r.key); await afterRemoval.initialize();
      const removalOpen = afterRemoval.isOpen(), loginStatus = (await login(st, st.f.email)).r.status;
      await afterRemoval.flush().catch(() => undefined);
      let reconciled = 'refused'; try { await afterRemoval.reconcile({ approved: true, reviewId: 'P05v3-synthetic-fixture' }); reconciled = 'reconciled'; } catch { /* keep */ }
      observed.set(name, { flush, liveOpen: r.isOpen(), lockKept, restartOpen, removalOpen, loginWhileClosed: loginStatus, reconciled, reopened: afterRemoval.isOpen() });
      assert.equal(flush, 'failed', name); assert.equal(r.isOpen(), false, name); assert.ok(lockKept, name); assert.equal(restartOpen, false, name); assert.equal(removalOpen, false, name); assert.equal(loginStatus, 503, name);
      assert.equal(reconciled, 'reconciled', name); assert.equal(afterRemoval.isOpen(), true, name);
    } finally { await st.close(); }
  }
  // Flush I/O error: external Mongo journal rejects inserts.
  const st = await stack({ controlledRestore: true });
  try {
    const r = st.f.restore; assert.ok(r); await actor(st); await r.flush();
    const ext = st.f.database.client.db(`${st.f.database.db.databaseName}_external_security`);
    await ext.command({ collMod: 'events', validator: { $expr: { $eq: [1, 0] } } });
    await actor(st).catch(() => undefined);
    let flush = 'ok'; try { await r.flush(); } catch { flush = 'failed'; }
    await ext.command({ collMod: 'events', validator: {} });
    const restarted = new RestoreController(st.f.database, r.gatePath, r.key); await restarted.initialize();
    const restartOpen = restarted.isOpen(); await restarted.flush().catch(() => undefined);
    const afterFlushOpen = restarted.isOpen();
    let reconciled = 'refused'; try { await restarted.reconcile({ approved: true, reviewId: 'P05v3-synthetic-fixture' }); reconciled = 'reconciled'; } catch { /* keep */ }
    observed.set('external Mongo insert error', { flush, liveOpen: r.isOpen(), restartOpen, afterSuccessfulFlushOpen: afterFlushOpen, reconciled, reopened: restarted.isOpen() });
    assert.equal(flush, 'failed'); assert.equal(r.isOpen(), false); assert.equal(restartOpen, false); assert.equal(afterFlushOpen, false);
  } finally { await st.close(); }
  evidence('P05v3-N02', { observed: Object.fromEntries(observed), note: 'reviewId values are synthetic fixtures, not an operational approval' });
});

async function twoInstances(label: string, users: number, seedBytes: number | null) {
  const one = await realStack();
  let two: Real | undefined;
  try {
    for (let i = 0; i < users; i++) assert.equal((await realEnroll(one)).status, 201);
    await one.restore.flush(); const legacy = seedBytes ? await seedLegacy(one, seedBytes) : { bytes: (await stat(one.restore.fileJournal.path)).size, count: 0 };
    two = await realStack({ uri: one.uri, dbName: one.dbName, keys: one.keys, gatePath: one.gatePath });
    const second = two;
    // Probe with a REAL strong session on instance 2 (created before dispatchers start): A07 returns 503 whenever that instance considers the realm closed (A01 would not).
    const probeUser = await realEnroll(second, [one]); assert.equal(probeUser.status, 201); const pc = probeUser.client; assert.ok(pc);
    await one.restore.flush(); await second.restore.flush();
    one.state.dispatcher = true; second.state.dispatcher = true;
    const probes: number[] = []; let stop = false;
    const prober = (async () => { while (!stop) { const r = await pc.call('GET', '/api/v1/auth/me'); probes.push(r.status); await new Promise(r2 => setTimeout(r2, 150)); } })();
    const onOne: number[] = [], onTwo: number[] = [];
    const detail: string[] = [];
    for (let n = 0; n < 6; n++) { const x = await realEnroll(one, [second]), y = await realEnroll(second, [one]); onOne.push(x.status); onTwo.push(y.status); if (x.code) detail.push(`i1:${x.code}`); if (y.code) detail.push(`i2:${y.code}`); }
    stop = true; await prober; one.state.dispatcher = false; second.state.dispatcher = false; await one.drain(); await second.drain();
    const closedProbes = probes.filter(p => p !== 200).length;
    evidence(label, { journalBytesBefore: legacy.bytes, legacyCheckpoints: legacy.count, enrollOnInstance1: onOne, enrollOnInstance2: onTwo, failureCodes: detail, probesOnInstance2: probes.length, non200ProbesOnInstance2: closedProbes, probeStatuses: [...new Set(probes)],
      dispatcherErrors: [one.state.errors, second.state.errors], instance1Open: one.restore.isOpen(), instance2Open: second.restore.isOpen() });
    assert.ok(onOne.every(x => x === 201), 'instance 1 enrolments'); assert.ok(onTwo.every(x => x === 201), 'instance 2 enrolments');
    assert.equal(closedProbes, 0, 'non-writing instance must not intermittently close after peer appends');
  } finally { await two?.close(false); await one.close(); }
}
test('P05v3-N01-E two real instances (own connections/dispatchers) on a >10MB legacy journal: availability of the non-writing instance after peer appends', { timeout: 900000 }, async () => { await twoInstances('P05v3-N01-E', 10, 12 * 1024 * 1024); });
test('P05v3-N01-F two real instances WITHOUT legacy: delta-only journal past the 64KiB inline threshold after normal activity', { timeout: 900000 }, async () => { await twoInstances('P05v3-N01-F', 30, null); });

test('P05v3-N06 a routine gate update failing on Windows rename (another process holds the gate file without delete-sharing) closes the realm of a SINGLE instance', { timeout: 240000 }, async () => {
  const { spawn: spawnProcess } = await import('node:child_process');
  const st = await stack({ controlledRestore: true });
  try {
    const r = st.f.restore; assert.ok(r);
    const u = await actor(st); await r.flush(); assert.equal(r.isOpen(), true);
    // Realistic environmental condition: a reader (antivirus/indexer/backup/editor) holds the gate with FileShare.Read only.
    const holder = spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$f=[IO.File]::Open('${r.gatePath}','Open','Read','Read'); Write-Output HELD; Start-Sleep -Seconds 5; $f.Close()`], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise<void>((ok, fail) => { const t = setTimeout(() => fail(new Error('holder not ready')), 20000); holder.stdout?.on('data', d => { if (String(d).includes('HELD')) { clearTimeout(t); ok(); } }); });
    await stepUp(u.c, u.key, 'SESSION_REVOKE_ALL'); // routine audited activity -> new evidence rows -> flush must update gate
    let flush = 'ok'; try { await r.flush(); } catch { flush = 'failed'; }
    const liveOpen = r.isOpen(), loginDuring = (await login(st, u.email)).r.status;
    await once(holder, 'exit');
    const leftoverTmp = (await import('node:fs/promises')).readdir(resolve(r.gatePath, '..')).then(n => n.filter(x => x.startsWith(r.gatePath.split(/[\/]/).pop() ?? '') && x.endsWith('.tmp')).length);
    const loginAfterRelease = (await login(st, u.email)).r.status;
    const restarted = new RestoreController(st.f.database, r.gatePath, r.key); await restarted.initialize();
    evidence('P05v3-N06', { flush, liveOpenAfterFailure: liveOpen, loginDuringHold: loginDuring, loginAfterHolderReleased: loginAfterRelease, leftoverGateTmpFiles: await leftoverTmp, restartedOpen: restarted.isOpen(),
      note: 'environmental condition injected by a separate process; product code/config unchanged' });
    assert.equal(flush, 'ok', 'a transient rename failure of an OPEN gate update must not durably close the realm');
    assert.equal(loginAfterRelease, 200);
  } finally { await st.close(); }
});
