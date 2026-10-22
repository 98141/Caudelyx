/* eslint-disable security/detect-non-literal-fs-filename -- Paths are this test's own controller/journal fixtures and .runtime listings, never request input. */
// S01-P05-REVAL-v2 independent tests (Claude) on candidate P04-v2. Real HTTPS app + real MongoDB replica set, controllable clock.
// The software authenticator below produces genuine ECDSA P-256 signatures that the server verifies with
// @simplewebauthn/server; it is not a mock of verification. No secret, token or key is printed or persisted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { once } from 'node:events';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { generate } from 'otplib';
import { fixture } from '../helpers/fixture.js';
import { testCertificate } from '../helpers/tls.js';
import { ApiClient } from '../helpers/client.js';
import { createApp } from '../../src/app.js';
import { attachRuntime } from '../../src/shared/runtime.js';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { readdir, readFile, writeFile, unlink, stat } from 'node:fs/promises';
import { Database } from '../../src/shared/database.js';
import { Sessions } from '../../src/modules/sessions/service.js';
import { SyntheticMessaging } from '../../src/modules/messaging/service.js';
import { IdentityService } from '../../src/modules/identity/service.js';
import { PasswordHasher } from '../../src/modules/identity/password.js';
import { RestoreController } from '../../src/shared/restore.js';
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

type Actor = Awaited<ReturnType<typeof actor>>;
async function createOrg(u: Actor, name: string): Promise<string> {
  const command = { name, timezone: 'America/Bogota', currency: 'COP' };
  await stepUp(u.c, u.key, 'ORGANIZATION_CREATE', undefined, command);
  const r = await u.c.call('POST', '/api/v1/organizations', command, { 'Idempotency-Key': randomUUID() });
  assert.equal(r.status, 201, 'A08'); await u.c.refreshCsrf();
  return s((r.body.data?.['organization'] as Record<string, unknown>)['id']);
}
async function invite(st: Stack, m: Actor, orgId: string, email: string, roleIds: string[]): Promise<string> {
  await stepUp(m.c, m.key, 'MEMBER_INVITE', orgId, { email, roleIds });
  const r = await m.c.call('POST', '/api/v1/organization/invitations', { email, roleIds }); assert.equal(r.status, 202, 'A12');
  await st.f.identity.dispatchMail();
  const note = [...st.f.messages.notificationInbox.entries()].find(([, n]) => n.kind === 'INVITATION' && n.payload['email'] === email);
  assert.ok(note, 'invitation notification'); st.f.messages.notificationInbox.delete(note[0]); return s(note[1].payload['token']);
}
async function member(st: Stack, owner: Actor, orgId: string, roleIds: string[]): Promise<Actor> {
  const email = `${randomUUID()}@example.test`, token = await invite(st, owner, orgId, email, roleIds), m = await actor(st, email);
  const r = await m.c.call('POST', '/api/v1/auth/invitations/accept', { mode: 'CONFIRM', token }); assert.equal(r.status, 200, 'A15'); await m.c.refreshCsrf();
  return m;
}
async function rowOf(m: Actor, userId: string): Promise<{ status: string; version: string; roleIds: string[] }> {
  const r = await m.c.call('GET', '/api/v1/organization/members?limit=50');
  const row = (r.body.data?.['items'] as { userId: string; status: string; version: string; roleIds: string[] }[]).find(i => i.userId === userId); assert.ok(row); return row;
}
async function command(m: Actor, targetId: string, kind: 'suspend' | 'reactivate' | 'revoke', version: string) {
  const purpose = kind === 'suspend' ? 'MEMBER_SUSPEND' : kind === 'reactivate' ? 'MEMBER_REACTIVATE' : 'MEMBER_SESSIONS_REVOKE';
  await stepUp(m.c, m.key, purpose, targetId);
  const path = kind === 'revoke' ? `/api/v1/organization/members/${targetId}/sessions/revoke` : `/api/v1/organization/members/${targetId}/${kind}`;
  return await m.c.call('POST', path, { reasonCode: 'SECURITY' }, { 'If-Match': version });
}
async function codesFor(u: Actor): Promise<string[]> {
  await stepUp(u.c, u.key, 'RECOVERY_CODES_REGENERATE');
  const r = await u.c.call('POST', '/api/v1/auth/mfa/recovery-codes/regenerate', {}); assert.equal(r.status, 200); return r.body.data?.['codes'] as string[];
}
async function startRecovery(st: Stack, u: Actor, code: string) {
  const l = await login(st, u.email); const r = await l.c.call('POST', '/api/v1/auth/mfa/recovery/start', { recoveryCode: code });
  if (r.status === 200) await l.c.refreshCsrf();
  return { c: l.c, r };
}
async function pendingTotp(st: Stack, c: ApiClient) {
  const e = await c.call('POST', '/api/v1/auth/mfa/totp/enrollments', { label: 'Rec' }); assert.equal(e.status, 201);
  const secret = new URL(s(e.body.data?.['provisioningUri'])).searchParams.get('secret'); assert.ok(secret);
  const id = s(e.body.data?.['enrollmentId']); st.f.clock.value += 30000;
  const ok = await c.call('POST', `/api/v1/auth/mfa/totp/enrollments/${id}/confirm`, { code: await generate({ secret, epoch: Math.floor(st.f.clock.value / 1000) }) });
  assert.equal(ok.status, 200); return id;
}

// ---------- real-clock harness mirroring src/server.ts (Date.now, file journal, 1s dispatcher chain) ----------
async function realStack() {
  const replica = await startReplicaSet(), tls = await testCertificate(), port = await freePort();
  const dbName = `caudelyx_${randomUUID().replaceAll('-', '')}`, database = new Database(replica.uri, dbName); await database.connect();
  const keys = { version: 1 as const, mail: randomBytes(32), totp: randomBytes(32), journal: randomBytes(32), cursor: randomBytes(32) };
  const gatePath = resolve('.runtime', `gate-${dbName}.json`);
  const restore = new RestoreController(database, gatePath, keys.journal); await restore.initialize();
  const messaging = new SyntheticMessaging(database, keys.mail, Date.now);
  const identity = new IdentityService(database, new Sessions(database), messaging, new PasswordHasher(), () => restore.isOpen());
  await identity.initialize();
  const config = { mongoUri: replica.uri, databaseName: dbName, port, tenantOrigin: `https://localhost:${port}`, platformOrigin: `https://platform.localhost:${port}` };
  await attachRuntime(identity, keys, config);
  const server = createServer(tls, createApp({ identity, config })).listen(port, '127.0.0.1'); await once(server, 'listening');
  const state = { dispatcher: false, errors: 0 };
  let pending = Promise.resolve();
  const timer = setInterval(() => { if (!state.dispatcher) return; pending = pending.then(async () => { await restore.flush(); if (restore.isOpen()) { await identity.dispatchMail(); await identity.beforeRequest?.(); } }).catch(() => { state.errors++; }); }, 1000);
  const client = () => new ApiClient(port, tls.cert);
  return { identity, messaging, restore, state, client, origin: config.tenantOrigin, gatePath,
    drain: async () => { await pending; },
    close: async () => {
      clearInterval(timer); state.dispatcher = false; await pending; server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
      await database.close(); await replica.stop();
      for (const f of [gatePath, gatePath + '.journal.jsonl']) await unlink(f).catch(() => undefined); // this test's own controller files
    } };
}
async function realEnroll(rs: Awaited<ReturnType<typeof realStack>>) {
  const email = `${randomUUID()}@example.test`;
  await rs.identity.register('TENANT', `p05v2-${randomUUID()}`, { email, displayName: 'P05 v2', privacyPolicyVersion: 'synthetic-v1' });
  const subject = await rs.identity.identities.findOne({ email }); assert.ok(subject);
  let token: string | undefined; const mailStart = performance.now();
  for (let n = 0; n < 600 && !token; n++) {
    if (!rs.state.dispatcher) await rs.identity.dispatchMail();
    token = [...rs.messaging.inbox.values()].find(m => m.subjectId === subject._id && m.purpose === 'ACTIVATION')?.token;
    if (!token) await new Promise(r => setTimeout(r, 100));
  }
  const mailWaitMs = Math.round(performance.now() - mailStart);
  if (!token) return { status: 0, code: 'NO_ACTIVATION_MAIL_60S', ms: 0, mailWaitMs };
  const c = rs.client(); await c.refreshCsrf();
  assert.equal((await c.call('POST', '/api/v1/auth/email-verifications/confirm', { purpose: 'ACTIVATION', token, newPassword: PASSWORD })).status, 200); await c.refreshCsrf();
  const key = new SoftPasskey(rs.origin), o = await c.call('POST', '/api/v1/auth/mfa/webauthn/registration/options', { label: 'IG01' }); assert.equal(o.status, 200);
  const t = performance.now();
  const r = await c.call('POST', '/api/v1/auth/mfa/webauthn/registration/verify', { ceremonyId: s(o.body.data?.['ceremonyId']), credential: key.registration((o.body.data?.['publicKey'] as { challenge: string }).challenge) });
  return { status: r.status, code: r.body.error?.code ?? null, ms: Math.round(performance.now() - t), mailWaitMs };
}

test('P05v2-IG01 classification: external-journal re-verification blocks the event loop past the 1s verifiedAt window and fails A25 with 401 MFA_INVALID', { timeout: 900000 }, async () => {
  const rs = await realStack();
  try {
    const growth: { users: number; journalBytes: number; isOpenMs: number; flushMs: number }[] = [], growthFailures: Record<string, unknown>[] = [];
    // Growth with dispatcher OFF and explicit sequential flushes (no concurrency): realistic security-state journal.
    for (let u = 1; u <= 60; u++) {
      const r = await realEnroll(rs); if (r.status !== 201) growthFailures.push({ user: u, ...r });
      const t = performance.now(); await rs.restore.flush(); const flushMs = Math.round(performance.now() - t);
      if (u % 10 === 0) {
        const t2 = performance.now(); assert.equal(rs.restore.isOpen(), true); const isOpenMs = Math.round(performance.now() - t2);
        growth.push({ users: u, journalBytes: (await stat(rs.gatePath + '.journal.jsonl')).size, isOpenMs, flushMs });
        console.log(JSON.stringify({ progress: 'IG01-growth', ...growth.at(-1), failures: growthFailures.length }));
      }
    }
    // Control: dispatcher OFF, 8 enrolments.
    const control: { status: number; code: string | null; ms: number; mailWaitMs: number }[] = [];
    for (let n = 0; n < 8; n++) control.push(await realEnroll(rs));
    // Trial: dispatcher ON (identical to server.ts), 8 enrolments; event-loop delay measured in-process.
    const lag = monitorEventLoopDelay({ resolution: 20 }); lag.enable(); rs.state.dispatcher = true;
    const trial: { status: number; code: string | null; ms: number; mailWaitMs: number }[] = [];
    for (let n = 0; n < 8; n++) { trial.push(await realEnroll(rs)); console.log(JSON.stringify({ progress: 'IG01-trial', n, ...trial.at(-1) })); }
    rs.state.dispatcher = false; await rs.drain(); lag.disable();
    const failures = trial.filter(t => t.status !== 201);
    evidence('P05v2-IG01', { growth, growthFailures, control, trial, maxEventLoopDelayMs: Math.round(lag.max / 1e6), p99EventLoopDelayMs: Math.round(lag.percentile(99) / 1e6), dispatcherErrors: rs.state.errors,
      completeFactorWindowMs: 1000, note: 'same product code; only the 1s dispatcher (server.ts) is toggled; no fault injection, no clock manipulation' });
    assert.ok(control.every(c => c.status === 201), 'control without concurrent flush must succeed');
    assert.equal(failures.length, 0, `A25 failures with dispatcher running: ${JSON.stringify(failures)}`);
  } finally { await rs.close(); }
});

test('P05v2-H02 A17 terminates recovery (pending discarded, E revoked, code consumed); A36 does not revive; A16/A37 keep E usable; single ACTIVE flow under concurrent A30; A17 rollback keeps flow', { timeout: 360000 }, async () => {
  const st = await stack();
  try {
    const observed = new Map<string, unknown>();
    const t = await actor(st), org = await createOrg(t, 'Org H02'), m = await member(st, t, org, ['O']);
    const codes = await codesFor(m);
    const flows = st.f.database.db.collection<{ _id: string; status: string }>('recoveries');
    // A16 and A37 keep E_RECOVERY usable and A31 still completes.
    let rec = await startRecovery(st, m, s(codes[0])); assert.equal(rec.r.status, 200);
    const pend1 = await pendingTotp(st, rec.c);
    assert.equal((await (async () => { await stepUp(t.c, t.key, 'MEMBER_ROLE_CHANGE', m.userId, { roleIds: ['C'] }); return t.c.call('PATCH', `/api/v1/organization/members/${m.userId}/roles`, { roleIds: ['C'] }, { 'If-Match': (await rowOf(t, m.userId)).version }); })()).status, 200);
    observed.set('E after A16', (await rec.c.call('GET', '/api/v1/auth/me')).status);
    assert.equal((await command(t, m.userId, 'revoke', (await rowOf(t, m.userId)).version)).status, 200);
    observed.set('E after A37', (await rec.c.call('GET', '/api/v1/auth/me')).status);
    const done = await rec.c.call('POST', '/api/v1/auth/mfa/recovery/complete', { newMethodId: pend1, retireMethodIds: [] });
    observed.set('A31 after A16+A37', done.status);
    assert.equal(observed.get('E after A16'), 200); assert.equal(observed.get('E after A37'), 200); assert.equal(done.status, 200);
    // Cooldown 24h after A31; move past it for the next scenario.
    st.f.clock.value += 24 * 3600000 + 1000;
    const m2 = await login(st, m.email); assert.equal((await passkeyVerify(m2.c, m.key, 'LOGIN')).status, 200);
    m.c.cookies.clear(); for (const [k, v] of m2.c.cookies) m.c.cookies.set(k, v); m.c.csrf = m2.c.csrf;
    const t2 = await login(st, t.email); assert.equal((await passkeyVerify(t2.c, t.key, 'LOGIN')).status, 200);
    t.c.cookies.clear(); for (const [k, v] of t2.c.cookies) t.c.cookies.set(k, v); t.c.csrf = t2.c.csrf;
    const codes2 = await codesFor(m);
    // Concurrent A30 with two different codes: exactly one ACTIVE flow; loser's code is NOT consumed.
    const [la, lb] = [await login(st, m.email), await login(st, m.email)];
    const race = await Promise.all([la.c.call('POST', '/api/v1/auth/mfa/recovery/start', { recoveryCode: s(codes2[0]) }), lb.c.call('POST', '/api/v1/auth/mfa/recovery/start', { recoveryCode: s(codes2[1]) })]);
    const activeFlows = await flows.countDocuments({ subjectId: m.userId, status: 'ACTIVE' });
    const consumed = await st.f.database.db.collection('recovery_codes').countDocuments({ subjectId: m.userId, consumed: true, batch: (await st.f.identity.identities.findOne({ _id: m.userId }))?.recoveryBatch ?? '' });
    observed.set('concurrent A30 statuses', race.map(r => r.status).sort()); observed.set('ACTIVE flows', activeFlows); observed.set('consumed codes of batch', consumed);
    assert.equal(activeFlows, 1); assert.equal(race.filter(r => r.status === 200).length, 1); assert.equal(consumed, 1);
    rec = { c: race[0].status === 200 ? la.c : lb.c, r: race[0].status === 200 ? race[0] : race[1] }; await rec.c.refreshCsrf();
    const pend2 = await pendingTotp(st, rec.c);
    // A17 rollback (fault injected in audit validator, labelled as such): flow stays ACTIVE and E usable.
    await st.f.database.db.command({ collMod: 'audit_events', validator: { $expr: { $ne: ['$action', 'MEMBER_SUSPEND'] } } });
    let rolled: number;
    try { rolled = (await command(t, m.userId, 'suspend', (await rowOf(t, m.userId)).version)).status; } finally { await st.f.database.db.command({ collMod: 'audit_events', validator: {} }); }
    observed.set('A17 with injected audit failure', rolled);
    observed.set('flow after rolled-back A17', (await flows.findOne({ subjectId: m.userId, status: 'ACTIVE' }))?.status ?? 'none');
    observed.set('E after rolled-back A17', (await rec.c.call('GET', '/api/v1/auth/me')).status);
    assert.notEqual(rolled, 200); assert.equal(observed.get('flow after rolled-back A17'), 'ACTIVE'); assert.equal(observed.get('E after rolled-back A17'), 200);
    // Real A17: flow REVOKED, pending discarded + secret erased, E revoked, code stays consumed.
    await t.c.refreshCsrf();
    const susp = await command(t, m.userId, 'suspend', (await rowOf(t, m.userId)).version); assert.equal(susp.status, 200);
    const p2 = await st.f.sessions.factors.findOne({ _id: pend2 });
    observed.set('after A17', { flows: (await flows.find({ subjectId: m.userId }).toArray()).map(f => f.status), pending: p2?.state, secretErased: p2?.encryptedSecret === undefined,
      eMe: (await rec.c.call('GET', '/api/v1/auth/me')).status, a31: (await rec.c.call('POST', '/api/v1/auth/mfa/recovery/complete', { newMethodId: pend2, retireMethodIds: [] })).status });
    assert.equal(await flows.countDocuments({ subjectId: m.userId, status: 'ACTIVE' }), 0); assert.notEqual(p2?.state, 'ACTIVE'); assert.equal(p2?.encryptedSecret, undefined);
    // A36: no revival of flow/RECOVERY_RESTRICTED; state projected from active factors.
    const re = await command(t, m.userId, 'reactivate', s(susp.body.data?.['version'])); assert.equal(re.status, 200);
    const after = await st.f.identity.identities.findOne({ _id: m.userId });
    observed.set('after A36', { response: re.body.data?.['status'], state: after?.state, activeFlows: await flows.countDocuments({ subjectId: m.userId, status: 'ACTIVE' }), eMe: (await rec.c.call('GET', '/api/v1/auth/me')).status });
    assert.notEqual(after?.state, 'RECOVERY_RESTRICTED'); assert.equal(await flows.countDocuments({ subjectId: m.userId, status: 'ACTIVE' }), 0);
    const reuse = await (await login(st, m.email)).c.call('POST', '/api/v1/auth/mfa/recovery/start', { recoveryCode: s(codes2[race[0].status === 200 ? 0 : 1]) });
    observed.set('consumed code after A17 reused', reuse.status); assert.equal(reuse.status, 401);
    evidence('P05v2-H02', { observed: Object.fromEntries(observed) });
  } finally { await st.close(); }
});

test('P05v2-H03 runtime: deleting/forging/rolling back the external file closes the realm immediately over HTTP; stale journal lock blocks flush', { timeout: 300000 }, async () => {
  const st = await stack({ controlledRestore: true });
  try {
    const restore = st.f.restore; assert.ok(restore);
    const observed = new Map<string, unknown>();
    const u = await actor(st); await restore.flush();
    const journal = restore.fileJournal.path, good = await readFile(journal, 'utf8');
    const probe = async () => (await login(st, u.email)).r.status;
    observed.set('baseline login', await probe());
    await unlink(journal); observed.set('file deleted: open/login', [restore.isOpen(), await probe()]); await writeFile(journal, good);
    await writeFile(journal, good + good.split('\n')[0] + '\n'); observed.set('forged appended line', [restore.isOpen(), await probe()]); await writeFile(journal, good);
    // Rollback of the file to an earlier prefix after more events were flushed.
    await actor(st); await restore.flush(); const longer = await readFile(journal, 'utf8');
    await writeFile(journal, good); observed.set('file rolled back to earlier prefix', [restore.isOpen(), await probe()]); await writeFile(journal, longer);
    observed.set('restored file reopens (no restart needed)', restore.isOpen());
    for (const [k, v] of observed) if (Array.isArray(v)) { assert.equal(v[0], false, k); assert.equal(v[1], 503, k); }
    // Stale lock (crash inside exclusive): flush fails closed; record realm state for disposition.
    await writeFile(journal + '.lock', '');
    await actor(st); let flushOutcome = 'ok'; try { await restore.flush(); } catch { flushOutcome = 'rejected'; }
    const fileLines = (await readFile(journal, 'utf8')).trim().split('\n').length, seq = (await st.f.database.db.collection<{ _id: string; value: number }>('security_sequence').findOne({ _id: 'security' }))?.value ?? 0;
    observed.set('stale lock: flush / realm open / file lines vs security sequence', [flushOutcome, restore.isOpen(), fileLines, seq]);
    await unlink(journal + '.lock'); await restore.flush(); observed.set('after operator removes lock: flushed lines', (await readFile(journal, 'utf8')).trim().split('\n').length);
    evidence('P05v2-H03', { observed: Object.fromEntries(observed) });
    assert.equal(flushOutcome, 'rejected');
  } finally { await st.close(); }
});

test('P05v2-H05-H06 no automatic ETag; manager keeps strong explicit ETag; A09 actorRoleIds exact; INITIAL with expired L 401 without proof, Origin/CSRF/type still enforced', { timeout: 240000 }, async () => {
  const st = await stack();
  try {
    const observed = new Map<string, unknown>();
    const t = await actor(st), org = await createOrg(t, 'Org H05'), o = await member(st, t, org, ['O', 'C']);
    const mt = await t.c.call('GET', '/api/v1/organization'), mo = await o.c.call('GET', '/api/v1/organization');
    observed.set('A09 T', { etag: mt.headers['etag'] ?? null, version: mt.body.data?.['version'] ?? null, actorRoleIds: mt.body.data?.['actorRoleIds'] });
    observed.set('A09 O', { etag: mo.headers['etag'] ?? null, hasVersion: 'version' in (mo.body.data ?? {}), actorRoleIds: mo.body.data?.['actorRoleIds'] });
    assert.equal(mt.headers['etag'], mt.body.data?.['version']); assert.ok(!String(mt.headers['etag']).startsWith('W/'));
    assert.deepEqual(mt.body.data?.['actorRoleIds'], ['T']); assert.deepEqual([...(mo.body.data?.['actorRoleIds'] as string[])].sort(), ['C', 'O']);
    assert.equal(mo.headers['etag'], undefined); assert.equal('version' in (mo.body.data ?? {}), false);
    for (const [name, path, who] of [['A07', '/api/v1/auth/me', o], ['A11', '/api/v1/organization/members', t], ['A33', '/api/v1/auth/sessions', o], ['A21', '/api/v1/auth/mfa/methods', o]] as const) {
      const r = await who.c.call('GET', path); observed.set(`${name} ETag`, r.headers['etag'] ?? null); assert.equal(r.headers['etag'], undefined, name);
      if (name === 'A07') assert.equal('actorRoleIds' in (r.body.data ?? {}), false);
    }
    const inm = await o.c.call('GET', '/api/v1/auth/me', undefined, { 'If-None-Match': '*' }); observed.set('If-None-Match * on A07 (generic HTTP freshness, no ETag emitted)', `${inm.status} etag=${inm.headers['etag'] ?? 'none'}`); assert.equal(inm.headers['etag'], undefined);
    // H-06
    const a = await activated(st), l = await login(st, a.email), t0 = st.f.clock.value; st.f.clock.value = t0 + 300000;
    const proofs = () => st.f.messages.proofs.countDocuments({ subjectId: a.userId, purpose: 'INITIAL_MFA_PROOF' }), before = await proofs();
    const r03 = await l.c.call('POST', '/api/v1/auth/email-verifications/request', { purpose: 'INITIAL_MFA_PROOF' });
    const r04 = await l.c.call('POST', '/api/v1/auth/email-verifications/confirm', { purpose: 'INITIAL_MFA_PROOF', token: 'A'.repeat(43) });
    const badOrigin = await l.c.call('POST', '/api/v1/auth/email-verifications/request', { purpose: 'INITIAL_MFA_PROOF' }, { Origin: st.config.platformOrigin });
    const crossSite = await l.c.call('POST', '/api/v1/auth/email-verifications/request', { purpose: 'INITIAL_MFA_PROOF' }, { 'Sec-Fetch-Site': 'cross-site' });
    const plain = await l.c.call('POST', '/api/v1/auth/email-verifications/request', { purpose: 'INITIAL_MFA_PROOF' }, { 'Content-Type': 'text/plain' });
    const badBody = await l.c.call('POST', '/api/v1/auth/email-verifications/request', { purpose: 'INITIAL_MFA_PROOF', extra: 1 });
    const activation = await l.c.call('POST', '/api/v1/auth/email-verifications/confirm', { purpose: 'ACTIVATION', token: 'A'.repeat(43), newPassword: PASSWORD });
    observed.set('expired L', { A03: `${r03.status} ${r03.body.error?.code}`, A04: `${r04.status} ${r04.body.error?.code}`, platformOrigin: badOrigin.status, crossSite: crossSite.status,
      textPlain: plain.status, extraProperty: `${badBody.status} ${badBody.body.error?.code}`, activationNoContext: `${activation.status} ${activation.body.error?.code}` });
    assert.equal(r03.status, 401); assert.equal(r03.body.error?.code, 'AUTH_INVALID'); assert.equal(r04.status, 401); assert.equal(r04.body.error?.code, 'AUTH_INVALID');
    assert.equal(badOrigin.status, 400); assert.equal(crossSite.status, 400); assert.equal(plain.status, 400); assert.equal(activation.status, 400);
    assert.equal(await proofs(), before, 'no INITIAL proof issued');
    evidence('P05v2-H05-H06', { observed: Object.fromEntries(observed) });
  } finally { await st.close(); }
});

test('P05v2-H07 helpers: replica dbpath removed after stop and after failed setup; TLS temp folder removed; manual/control untouched', { timeout: 180000 }, async () => {
  const list = async (prefix: string) => (await readdir('.runtime')).filter(n => n.startsWith(prefix)).sort();
  const manualBefore = await list('manual'), replicasBefore = await list('replica-'), tlsBefore = await list('tls-');
  const r = await startReplicaSet(); const dir = r.directory; await r.stop();
  const removedAfterStop = !(await list('replica-')).includes(dir.split(/[\\/]/).pop() ?? '');
  await testCertificate(); const tlsAfter = await list('tls-');
  const previous = process.env['MONGOD_BINARY']; process.env['MONGOD_BINARY'] = resolve('.runtime', 'p05v2-missing-mongod.exe');
  let failed = false; try { await startReplicaSet(); } catch { failed = true; } finally { if (previous === undefined) delete process.env['MONGOD_BINARY']; else process.env['MONGOD_BINARY'] = previous; }
  const replicasAfter = await list('replica-'), manualAfter = await list('manual');
  const observed = { removedAfterStop, failedSetup: failed, replicaDelta: replicasAfter.filter(n => !replicasBefore.includes(n)), tlsDelta: tlsAfter.filter(n => !tlsBefore.includes(n)), manualUnchanged: JSON.stringify(manualBefore) === JSON.stringify(manualAfter) };
  evidence('P05v2-H07', { observed });
  assert.ok(removedAfterStop); assert.ok(failed); assert.deepEqual(observed.replicaDelta, []); assert.deepEqual(observed.tlsDelta, []); assert.ok(observed.manualUnchanged);
});

// ---------- DEV-001 minimal independent review (CLI stdout kept in memory only; never printed or logged) ----------
class DevApi extends ApiClient {
  constructor(cert: Buffer) { super(4001, cert); }
  override async call(method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
    return await super.call(method, route, body, { Host: 'localhost:3001', Origin: 'https://localhost:3001', ...headers });
  }
}
test('P05v2-DEV-001 CLI guards before any connection, read-only mailbox, persistent restart (identity/factor/session/quotas/TTL), clean/reset scope, no HTTP mailbox', { timeout: 300000 }, async () => {
  const { spawn, execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { MongoClient } = await import('mongodb');
  const exec = promisify(execFile), profile = `test-${randomUUID()}`, mongoPort = await freePort();
  const control = `.runtime/manual-control-${profile}`, descriptor = `.runtime/manual-${profile}-connection.json`;
  const env: NodeJS.ProcessEnv = { ...process.env, CAUDELYX_MODE: 'local-synthetic', CAUDELYX_DEV_TEST_PROFILE: profile, CAUDELYX_DEV_TEST_MONGO_PORT: String(mongoPort) }; delete env['MONGODB_URI'];
  const mailbox = async (email: string, override: NodeJS.ProcessEnv = {}) => {
    try { const r = await exec(process.execPath, ['scripts/mailbox-local.mjs', '--email', email], { env: { ...env, ...override }, windowsHide: true, timeout: 20000 }); return { ok: true, stdout: r.stdout }; }
    catch { return { ok: false, stdout: '' }; }
  };
  const observed = new Map<string, unknown>();
  const listing = async () => (await readdir('.runtime')).sort().join('|');
  const email = `dev_${randomUUID()}@example.test`;
  observed.set('mode production', (await mailbox(email, { CAUDELYX_MODE: 'production' })).ok);
  observed.set('mode absent', (await mailbox(email, { CAUDELYX_MODE: '' })).ok);
  observed.set('real domain', (await mailbox('persona@gmail.com')).ok);
  observed.set('remote MONGODB_URI env', (await mailbox(email, { MONGODB_URI: 'mongodb://remote.invalid:27181/?replicaSet=x' })).ok);
  const craft = async (uri: string, keyring = resolve(control, 'keys.json')) => writeFile(descriptor, JSON.stringify({ mode: 'local-synthetic', mongoUri: uri, databaseName: 'caudelyx_manual', keyringFile: keyring }));
  await craft('mongodb://127.0.0.1:27017/?replicaSet=rs'); observed.set('descriptor 27017', (await mailbox(email, { CAUDELYX_DEV_TEST_MONGO_PORT: '27017' })).ok);
  await craft(`mongodb://remote.invalid:${mongoPort}/?replicaSet=rs`); observed.set('descriptor remote host', (await mailbox(email)).ok);
  await craft(`mongodb://u:p@127.0.0.1:${mongoPort}/?replicaSet=rs`); observed.set('descriptor with credentials', (await mailbox(email)).ok);
  await craft(`mongodb://127.0.0.1:${mongoPort}/?replicaSet=rs`, resolve('.runtime', 'synthetic-keys.json')); observed.set('foreign keyring', (await mailbox(email)).ok);
  await craft(`mongodb://127.0.0.1:${mongoPort}/?replicaSet=rs`); const before = await listing();
  observed.set('missing keyring', (await mailbox(email)).ok);
  observed.set('CLI created files', before !== await listing());
  await unlink(descriptor);
  for (const [k, v] of observed) assert.equal(v, false, k);
  let child: import('node:child_process').ChildProcess | undefined;
  const start = async () => {
    child = spawn(process.execPath, ['scripts/manual-local.mjs'], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await new Promise<void>((ok, fail) => {
      const t = setTimeout(() => fail(new Error('manual readiness timeout')), 40000);
      child?.on('message', m => { if (m === 'LOCAL_RUNTIME_READY') { clearTimeout(t); ok(); } });
      child?.once('exit', () => { clearTimeout(t); fail(new Error('manual runtime exited')); });
    });
    return new DevApi(await readFile('.runtime/tls/cert.pem'));
  };
  const stop = async () => { if (!child || child.exitCode !== null) return; const ended = once(child, 'exit'); child.send?.('LOCAL_DEV_STOP'); await ended; child = undefined; };
  let db: import('mongodb').MongoClient | undefined;
  try {
    let api = await start(); await api.refreshCsrf();
    assert.equal((await api.call('POST', '/api/v1/auth/register', { email, displayName: 'DEV P05', privacyPolicyVersion: 'synthetic-v1', acceptTerms: true })).status, 202);
    let token = '';
    for (let n = 0; n < 40 && !token; n++) {
      const r = await mailbox(email);
      if (r.ok) token = (JSON.parse(r.stdout) as { messages: { purpose: string; code: string }[] }).messages.find(m => m.purpose === 'ACTIVATION')?.code ?? '';
      if (!token) await new Promise(r2 => setTimeout(r2, 250));
    }
    observed.set('CLI returned a 43-char activation code (value not shown)', token.length === 43); assert.equal(token.length, 43);
    const link = JSON.parse(await readFile(descriptor, 'utf8')) as { mongoUri: string; databaseName: string };
    observed.set('descriptor port is own isolated port, not 27017', Number(new URL(link.mongoUri).port) === mongoPort && mongoPort !== 27017);
    db = new MongoClient(link.mongoUri); await db.connect(); const d = db.db(link.databaseName);
    const snap = async (x: import('mongodb').Db) => JSON.stringify({ q: await x.collection('mail_quotas').find().sort({ _id: 1 }).toArray(), p: await x.collection('email_proofs').find().sort({ _id: 1 }).toArray() });
    const s0 = await snap(d); await mailbox(email); await mailbox(email);
    observed.set('repeated CLI reads change quotas/proofs', s0 !== await snap(d));
    observed.set('plain code persisted in synthetic_mail', JSON.stringify(await d.collection('synthetic_mail').find().toArray()).includes(token));
    assert.equal((await api.call('POST', '/api/v1/auth/email-verifications/confirm', { purpose: 'ACTIVATION', token, newPassword: PASSWORD })).status, 200); await api.refreshCsrf();
    const e = await api.call('POST', '/api/v1/auth/mfa/totp/enrollments', { label: 'DEV TOTP' }); assert.equal(e.status, 201);
    const secret = new URL(s(e.body.data?.['provisioningUri'])).searchParams.get('secret'); assert.ok(secret);
    assert.equal((await api.call('POST', `/api/v1/auth/mfa/totp/enrollments/${s(e.body.data?.['enrollmentId'])}/confirm`, { code: await generate({ secret }) })).status, 200);
    const step = Math.floor(Date.now() / 30000); await api.refreshCsrf();
    const me = await api.call('GET', '/api/v1/auth/me'); assert.equal(me.status, 200); const userId = s(me.body.data?.['userId']);
    const sBefore = await d.collection<{ _id: string; expiresAt: number }>('contexts').findOne({ subjectId: userId, kind: 'S', revoked: false });
    const s1 = await snap(d), keyHash = createHash('sha256').update(await readFile(`${control}/keys.json`)).digest('hex');
    let clean = 'allowed'; try { await exec(process.execPath, ['scripts/runtime-cleanup.mjs'], { env, windowsHide: true, timeout: 20000 }); } catch { clean = 'refused'; }
    observed.set('runtime:clean while profile runs', clean);
    observed.set('HTTP mailbox routes', [(await api.call('GET', '/api/v1/dev/mailbox')).status, (await api.call('GET', '/api/v1/mailbox')).status]);
    await db.close(); db = undefined; await stop();
    api = await start();
    db = new MongoClient(link.mongoUri); await db.connect(); const d2 = db.db(link.databaseName);
    observed.set('keyring unchanged after restart', createHash('sha256').update(await readFile(`${control}/keys.json`)).digest('hex') === keyHash);
    observed.set('quotas/proofs unchanged by restart', s1 === await snap(d2));
    const sAfter = await d2.collection<{ _id: string; expiresAt: number }>('contexts').findOne({ _id: sBefore?._id ?? '' });
    observed.set('S expiresAt not renewed by restart', !!sBefore && sAfter?.expiresAt === sBefore.expiresAt);
    await api.refreshCsrf();
    assert.equal((await api.call('POST', '/api/v1/auth/login', { email, password: PASSWORD })).status, 200); await api.refreshCsrf();
    while (Math.floor(Date.now() / 30000) === step) await new Promise(r => setTimeout(r, 250));
    assert.equal((await api.call('POST', '/api/v1/auth/mfa/challenges/verify', { method: 'TOTP', purpose: 'LOGIN', code: await generate({ secret }) })).status, 200);
    observed.set('same identity after restart', (await api.call('GET', '/api/v1/auth/me')).body.data?.['userId'] === userId);
    const left = await mailbox(email); observed.set('CLI shows consumed activation again', left.ok && (JSON.parse(left.stdout) as { messages: unknown[] }).messages.length > 0);
    await db.close(); db = undefined; await stop();
    observed.set('plain code in own mongo.log', (await readFile(`.runtime/manual-${profile}/mongo.log`, 'utf8')).includes(token));
    await exec(process.execPath, ['scripts/manual-local.mjs', '--reset'], { env, windowsHide: true, timeout: 30000 });
    const after = await readdir('.runtime');
    observed.set('reset removed own data dir', !after.includes(`manual-${profile}`)); observed.set('reset kept own keyring', (await readdir(control)).includes('keys.json'));
    observed.set('owner manual untouched', after.includes('manual-replica') && after.includes('manual-control'));
    evidence('P05v2-DEV-001', { observed: Object.fromEntries(observed), note: 'CLI output captured in memory only; no code value printed' });
    for (const k of ['CLI returned a 43-char activation code (value not shown)', 'descriptor port is own isolated port, not 27017', 'keyring unchanged after restart', 'quotas/proofs unchanged by restart', 'S expiresAt not renewed by restart', 'same identity after restart', 'reset removed own data dir', 'reset kept own keyring', 'owner manual untouched']) assert.equal(observed.get(k), true, k);
    for (const k of ['repeated CLI reads change quotas/proofs', 'plain code persisted in synthetic_mail', 'plain code in own mongo.log', 'CLI shows consumed activation again']) assert.equal(observed.get(k), false, k);
    assert.equal(observed.get('runtime:clean while profile runs'), 'refused');
  } finally {
    await db?.close(); await stop();
    await exec(process.execPath, ['scripts/manual-local.mjs', '--reset'], { env, windowsHide: true, timeout: 30000 }).catch(() => undefined);
    await unlink(descriptor).catch(() => undefined);
  }
});
