// S01-P05 independent negative tests (Claude). Real HTTPS app + real MongoDB replica set, controllable clock.
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
async function stack() {
  const f = await fixture(), tls = await testCertificate(), port = await freePort();
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

test('P05-AUTH-01 WebAuthn registration negatives (UV/rpId/origin/type/foreign challenge) fail closed; unknown hints accepted and ignored', { timeout: 180000 }, async () => {
  const st = await stack();
  try {
    const a = await activated(st), key = new SoftPasskey(st.origin);
    const options = async () => {
      const o = await a.c.call('POST', '/api/v1/auth/mfa/webauthn/registration/options', { label: 'Passkey negativa' });
      assert.equal(o.status, 200); return { id: s(o.body.data?.['ceremonyId']), challenge: (o.body.data?.['publicKey'] as { challenge: string; rp: { id: string } }).challenge,
        rp: (o.body.data?.['publicKey'] as { rp: { id: string } }).rp.id };
    };
    const first = await options();
    assert.equal(first.rp, 'localhost', 'RP id is the tenant host');
    const cases: [string, Tweak][] = [['UV flag absent', { flags: 0x41 }], ['foreign rpId hash', { rpId: 'platform.localhost' }],
      ['PLATFORM origin on TENANT', { origin: st.config.platformOrigin }], ['wrong clientData type', { type: 'webauthn.get' }]];
    const observed = new Map<string, unknown>();
    for (const [name, tweak] of cases) {
      const o = await options();
      const r = await a.c.call('POST', '/api/v1/auth/mfa/webauthn/registration/verify', { ceremonyId: o.id, credential: key.registration(o.challenge, tweak) });
      observed.set(name, r.status); assert.equal(r.status, 401, name); assert.equal(r.body.error?.code, 'MFA_INVALID', name);
    }
    const other = await options();
    const foreign = await a.c.call('POST', '/api/v1/auth/mfa/webauthn/registration/verify', { ceremonyId: other.id, credential: key.registration(first.challenge) });
    observed.set('challenge of another ceremony', foreign.status); assert.equal(foreign.status, 401);
    assert.equal(await st.f.sessions.factors.countDocuments({ subjectId: a.userId, state: 'ACTIVE' }), 0, 'no factor activated by negatives');
    // Positive control on the SAME context, with unknown future hints in transports and extension results.
    const ok = await enrollPasskey(a.c, key, { transports: ['p05-future-transport-hint'] });
    observed.set('valid + unknown transport hint', ok.status); assert.equal(ok.status, 201);
    assert.equal(ok.body.data?.['nextAction'], 'READY');
    const factor = await st.f.sessions.factors.findOne({ subjectId: a.userId, state: 'ACTIVE' });
    assert.ok(factor); assert.equal(Object.keys(factor).some(k => /transport|hint/i.test(k)), false, 'hint not persisted as evidence');
    await a.c.refreshCsrf();
    assert.equal((await a.c.call('GET', '/api/v1/auth/me')).body.data?.['authState'], 'AUTHENTICATED_NO_ORG');
    evidence('P05-AUTH-01', { observed: Object.fromEntries(observed) });
  } finally { await st.close(); }
});

test('P05-AUTH-02 WebAuthn assertion negatives, distributed account limit, replay, counter, foreign context, purpose binding and exact ceremony TTL', { timeout: 240000 }, async () => {
  const st = await stack();
  try {
    const u = await actor(st), observed = new Map<string, unknown>();
    const loginOptions = async (c: ApiClient) => {
      const o = await c.call('POST', '/api/v1/auth/mfa/webauthn/authentication/options', { purpose: 'LOGIN' }); assert.equal(o.status, 200);
      return { id: s(o.body.data?.['ceremonyId']), challenge: (o.body.data?.['publicKey'] as { challenge: string }).challenge };
    };
    const verify = (c: ApiClient, id: string, credential: unknown, extra: Record<string, unknown> = {}) =>
      c.call('POST', '/api/v1/auth/mfa/challenges/verify', { method: 'WEBAUTHN', purpose: 'LOGIN', ceremonyId: id, credential, ...extra });
    // Batch 1: five invalid assertions (account limit is 10/15min including the 0 registration failures here).
    let l = await login(st, u.email); assert.equal(l.r.status, 200); assert.equal(l.r.body.data?.['authState'], 'MFA_REQUIRED');
    const bad: [string, Tweak][] = [['UV absent', { flags: 0x01 }], ['tampered signature', { tamper: true }], ['foreign rpId', { rpId: 'platform.localhost' }],
      ['wrong origin', { origin: 'https://evil.localhost:1' }]];
    for (const [name, tweak] of bad) {
      const o = await loginOptions(l.c); const r = await verify(l.c, o.id, u.key.assertion(o.challenge, tweak));
      observed.set(name, r.status); assert.equal(r.status, 401, name);
    }
    const o1 = await loginOptions(l.c), o2 = await loginOptions(l.c);
    const crossed = await verify(l.c, o2.id, u.key.assertion(o1.challenge)); observed.set('challenge of other ceremony', crossed.status); assert.equal(crossed.status, 401);
    // Batch 2 (same 15min window) reaches 10 account failures; a VALID assertion must then be throttled, not accepted.
    st.f.clock.value += 60000; l = await login(st, u.email);
    for (let n = 0; n < 5; n++) { const o = await loginOptions(l.c); await verify(l.c, o.id, u.key.assertion(o.challenge, { tamper: true })); }
    const o3 = await loginOptions(l.c), throttled = await verify(l.c, o3.id, u.key.assertion(o3.challenge));
    observed.set('valid after 10 account failures', throttled.status); assert.equal(throttled.status, 429);
    assert.equal(l.c.cookies.get('__Host-caudelyx-session') ?? '', '', 'no S issued under throttle');
    // Window elapses: positive control.
    st.f.clock.value += 15 * 60000 + 1000; l = await login(st, u.email);
    const o4 = await loginOptions(l.c), good = u.key.assertion(o4.challenge), ok = await verify(l.c, o4.id, good);
    observed.set('valid login', ok.status); assert.equal(ok.status, 200); assert.ok(l.c.cookies.get('__Host-caudelyx-session'));
    // Replay of the exact consumed assertion on a fresh L.
    const l2 = await login(st, u.email), replay = await verify(l2.c, o4.id, good);
    observed.set('replayed assertion/ceremony', replay.status); assert.equal(replay.status, 401);
    // Counter regression (signCount <= stored) rejected.
    const o5 = await loginOptions(l2.c), regress = await verify(l2.c, o5.id, u.key.assertion(o5.challenge, { counter: 1 }));
    observed.set('counter regression', regress.status); assert.equal(regress.status, 401);
    // Ceremony created by another L context of the same person.
    const l3 = await login(st, u.email), o6 = await loginOptions(l3.c), foreign = await verify(l2.c, o6.id, u.key.assertion(o6.challenge));
    observed.set('ceremony of another context', foreign.status); assert.equal(foreign.status, 401);
    // Purpose binding with S: R for SESSION_REVOKE_ALL; ceremony for that purpose presented as PASSWORD_CHANGE.
    const sc = l.c; await sc.refreshCsrf();
    assert.equal((await sc.call('POST', '/api/v1/auth/reauthenticate', { password: PASSWORD, purpose: 'SESSION_REVOKE_ALL' })).status, 200);
    const po = await sc.call('POST', '/api/v1/auth/mfa/webauthn/authentication/options', { purpose: 'SESSION_REVOKE_ALL' }); assert.equal(po.status, 200);
    const pch = (po.body.data?.['publicKey'] as { challenge: string }).challenge;
    const swapped = await sc.call('POST', '/api/v1/auth/mfa/challenges/verify', { method: 'WEBAUTHN', purpose: 'PASSWORD_CHANGE', ceremonyId: s(po.body.data?.['ceremonyId']), credential: u.key.assertion(pch) });
    observed.set('ceremony purpose swapped', swapped.status); assert.ok([401, 403].includes(swapped.status));
    // Exact TTL: same R, ceremony at t0 verified at t0+299999 succeeds; a new ceremony at t1 verified at t1+300000 fails.
    assert.equal((await sc.call('POST', '/api/v1/auth/reauthenticate', { password: PASSWORD, purpose: 'SESSION_REVOKE_ALL' })).status, 200);
    const t0 = st.f.clock.value, a1 = await sc.call('POST', '/api/v1/auth/mfa/webauthn/authentication/options', { purpose: 'SESSION_REVOKE_ALL' });
    st.f.clock.value = t0 + 299999;
    const edge = await sc.call('POST', '/api/v1/auth/mfa/challenges/verify', { method: 'WEBAUTHN', purpose: 'SESSION_REVOKE_ALL', ceremonyId: s(a1.body.data?.['ceremonyId']), credential: u.key.assertion((a1.body.data?.['publicKey'] as { challenge: string }).challenge) });
    observed.set('ceremony at 4:59.999', edge.status); assert.equal(edge.status, 200); await sc.refreshCsrf();
    assert.equal((await sc.call('POST', '/api/v1/auth/reauthenticate', { password: PASSWORD, purpose: 'SESSION_REVOKE_ALL' })).status, 200);
    const t1 = st.f.clock.value, a2 = await sc.call('POST', '/api/v1/auth/mfa/webauthn/authentication/options', { purpose: 'SESSION_REVOKE_ALL' });
    st.f.clock.value = t1 + 300000;
    const late = await sc.call('POST', '/api/v1/auth/mfa/challenges/verify', { method: 'WEBAUTHN', purpose: 'SESSION_REVOKE_ALL', ceremonyId: s(a2.body.data?.['ceremonyId']), credential: u.key.assertion((a2.body.data?.['publicKey'] as { challenge: string }).challenge) });
    observed.set('ceremony at 5:00.000', late.status); assert.notEqual(late.status, 200);
    evidence('P05-AUTH-02', { observed: Object.fromEntries(observed) });
  } finally { await st.close(); }
});

test('P05-AUTH-03 L/INITIAL exact 4:59/5:00/5:01, INITIAL token bound to its original L, queued INITIAL discarded after L expiry', { timeout: 240000 }, async () => {
  const st = await stack();
  try {
    const observed = new Map<string, unknown>();
    const a = await activated(st); // eligible: password set, no factor
    const requestInitial = (c: ApiClient) => c.call('POST', '/api/v1/auth/email-verifications/request', { purpose: 'INITIAL_MFA_PROOF' });
    const confirmInitial = (c: ApiClient, token: string) => c.call('POST', '/api/v1/auth/email-verifications/confirm', { purpose: 'INITIAL_MFA_PROOF', token });
    // L1: request at 4:59 succeeds; token confirmed at 4:59.999 yields E_INITIAL that cannot outlive L1 (enrolment at 5:00 fails).
    const l1 = await login(st, a.email); assert.equal(l1.r.body.data?.['authState'], 'MFA_ENROLLMENT');
    const t0 = st.f.clock.value; st.f.clock.value = t0 + 299000;
    const r459 = await requestInitial(l1.c); observed.set('A03 at 4:59', r459.status); assert.equal(r459.status, 202);
    const token1 = await mailToken(st, a.userId, 'INITIAL_MFA_PROOF');
    st.f.clock.value = t0 + 299999;
    const c1 = await confirmInitial(l1.c, token1); observed.set('A04 at 4:59.999', c1.status); assert.equal(c1.status, 200); await l1.c.refreshCsrf();
    const enrol = await l1.c.call('POST', '/api/v1/auth/mfa/webauthn/registration/options', { label: 'tardía' });
    st.f.clock.value = t0 + 300000;
    const key = new SoftPasskey(st.origin);
    const late = enrol.status === 200 ? await l1.c.call('POST', '/api/v1/auth/mfa/webauthn/registration/verify', { ceremonyId: s(enrol.body.data?.['ceremonyId']),
      credential: key.registration((enrol.body.data?.['publicKey'] as { challenge: string }).challenge) }) : enrol;
    observed.set('first factor at 5:00 via E_INITIAL from L1', late.status); assert.notEqual(late.status, 201);
    assert.equal(await st.f.sessions.factors.countDocuments({ subjectId: a.userId, state: 'ACTIVE' }), 0);
    // L2: request at exactly 5:00 and 5:01 rejected.
    const l2 = await login(st, a.email), t2 = st.f.clock.value;
    // Security property (hard): expired L never admits INITIAL. Contract M-06 status (A03 INITIAL with L absent/expired = 401 AUTH_INVALID) is collected separately.
    const deviations: string[] = [];
    const before = await st.f.messages.proofs.countDocuments({ subjectId: a.userId, purpose: 'INITIAL_MFA_PROOF' });
    st.f.clock.value = t2 + 300000; const r500 = await requestInitial(l2.c); observed.set('A03 at 5:00', `${r500.status} ${r500.body.error?.code ?? ''}`); assert.ok([400, 401].includes(r500.status));
    st.f.clock.value = t2 + 301000; const r501 = await requestInitial(l2.c); observed.set('A03 at 5:01', `${r501.status} ${r501.body.error?.code ?? ''}`); assert.ok([400, 401].includes(r501.status));
    assert.equal(await st.f.messages.proofs.countDocuments({ subjectId: a.userId, purpose: 'INITIAL_MFA_PROOF' }), before, 'no INITIAL proof after L expiry');
    for (const [name, r] of [['A03 at 5:00', r500], ['A03 at 5:01', r501]] as const) if (r.status !== 401 || r.body.error?.code !== 'AUTH_INVALID') deviations.push(`${name}: ${r.status} ${r.body.error?.code ?? ''} (M-06 expects 401 AUTH_INVALID)`);
    // L3 token presented by L4 (same person, other browser) is rejected; the original L3 accepts it.
    st.f.clock.value += 11 * 60000; // past per-source mail spacing
    const l3 = await login(st, a.email); assert.equal((await requestInitial(l3.c)).status, 202);
    const token3 = await mailToken(st, a.userId, 'INITIAL_MFA_PROOF');
    const l4 = await login(st, a.email), crossed = await confirmInitial(l4.c, token3);
    observed.set('L3 token used by L4', crossed.status); assert.equal(crossed.status, 401); assert.equal(crossed.body.error?.code, 'TOKEN_INVALID');
    const own = await confirmInitial(l3.c, token3); observed.set('L3 token used by L3', own.status); assert.equal(own.status, 200);
    // Queue: a coalesced INITIAL pending while L5 expires is discarded, never delivered to a later L6.
    st.f.clock.value += 11 * 60000;
    const l5 = await login(st, a.email); assert.equal((await requestInitial(l5.c)).status, 202);
    const token5 = await mailToken(st, a.userId, 'INITIAL_MFA_PROOF');
    st.f.clock.value += 1000; assert.equal((await requestInitial(l5.c)).status, 202, 'coalesced into pending turn');
    const quotaId = createHash('sha256').update(`TENANT:${a.email}:INITIAL_MFA_PROOF`).digest('hex');
    const pending = await st.f.messages.quotas.findOne({ _id: quotaId }); observed.set('pending admitted', !!pending?.pending); assert.ok(pending?.pending);
    st.f.clock.value = pending.pending.dueAt;
    await st.f.identity.dispatchMail();
    const delivered = [...st.f.messages.inbox.values()].filter(m => m.subjectId === a.userId && m.purpose === 'INITIAL_MFA_PROOF');
    observed.set('pending delivered after L5 expiry', delivered.length > 0); assert.equal(delivered.length, 0);
    assert.equal((await st.f.messages.quotas.findOne({ _id: quotaId }))?.pending ?? null, null, 'pending discarded');
    const l6 = await login(st, a.email), old5 = await confirmInitial(l6.c, token5);
    observed.set('L5 token used by L6', old5.status); assert.equal(old5.status, 401);
    evidence('P05-AUTH-03', { observed: Object.fromEntries(observed), contractDeviations: deviations });
    assert.deepEqual(deviations, [], 'contract status deviations (security properties above held)');
  } finally { await st.close(); }
});

test('P05-AUTH-04 CSRF/Origin/Fetch-Metadata/content-type/cookie/query matrix on a mutating operation', { timeout: 180000 }, async () => {
  const st = await stack();
  try {
    const u = await actor(st), other = await actor(st), observed = new Map<string, unknown>();
    const body = { password: PASSWORD, purpose: 'SESSION_REVOKE_ALL' };
    const probe = async (name: string, headers: Record<string, string>, expected: number, path = '/api/v1/auth/reauthenticate', payload: unknown = body) => {
      const r = await u.c.call('POST', path, payload, headers); observed.set(name, r.status); assert.equal(r.status, expected, name);
    };
    await probe('no Origin', { Origin: '' }, 400);
    await probe('Origin of PLATFORM realm', { Origin: st.config.platformOrigin }, 400);
    await probe('Origin null', { Origin: 'null' }, 400);
    await probe('Origin http scheme', { Origin: `http://localhost:${st.port}` }, 400);
    await probe('Sec-Fetch-Site cross-site', { 'Sec-Fetch-Site': 'cross-site' }, 400);
    await probe('wrong CSRF', { 'X-CSRF-Token': 'x'.repeat(43) }, 400);
    await probe('CSRF of another person', { 'X-CSRF-Token': other.c.csrf }, 400);
    await probe('CSRF absent', { 'X-CSRF-Token': '' }, 400);
    await probe('text/plain body', { 'Content-Type': 'text/plain' }, 400);
    await probe('duplicate session cookie', { Cookie: `__Host-caudelyx-session=${u.c.cookies.get('__Host-caudelyx-session') ?? ''}; __Host-caudelyx-session=x` }, 400);
    await probe('query parameter on POST', {}, 422, '/api/v1/auth/reauthenticate?purpose=LOGIN');
    await probe('unknown Host', { Host: `evil.localhost:${st.port}` }, 403);
    await probe('closed object extra property', {}, 422, '/api/v1/auth/reauthenticate', { ...body, admin: true });
    await probe('oversized body', {}, 400, '/api/v1/auth/reauthenticate', { ...body, padding: 'x'.repeat(17000) });
    // Old CSRF from before rotation (pre-session) cannot be replayed on the S context.
    const l = await login(st, u.email), preCsrf = l.c.csrf;
    assert.equal((await passkeyVerify(l.c, u.key, 'LOGIN')).status, 200);
    const stale = await l.c.call('POST', '/api/v1/auth/reauthenticate', body, { 'X-CSRF-Token': preCsrf });
    observed.set('pre-session CSRF on S', stale.status); assert.equal(stale.status, 400);
    await probe('valid control', {}, 200);
    // Safe GET is not CSRF-gated and changes nothing even cross-site.
    const g = await u.c.call('GET', '/api/v1/auth/me', undefined, { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.localhost:1' });
    observed.set('GET me cross-site', g.status); assert.equal(g.status, 200);
    evidence('P05-AUTH-04', { observed: Object.fromEntries(observed) });
  } finally { await st.close(); }
});

test('P05-AUTH-05 R binds password+factor/purpose/resource/command/version, exact 5:00 expiry, single CAS use; no factor = no R', { timeout: 180000 }, async () => {
  const st = await stack();
  try {
    const u = await actor(st), observed = new Map<string, unknown>();
    const create = (name: string) => u.c.call('POST', '/api/v1/organizations', { name, timezone: 'America/Bogota', currency: 'COP' }, { 'Idempotency-Key': randomUUID() });
    const cmd = (name: string) => ({ name, timezone: 'America/Bogota', currency: 'COP' });
    // Password-only proof (no factor) never authorizes.
    assert.equal((await u.c.call('POST', '/api/v1/auth/reauthenticate', { password: PASSWORD, purpose: 'ORGANIZATION_CREATE', command: cmd('Alfa') })).status, 200);
    const pwOnly = await create('Alfa'); observed.set('password-only R', pwOnly.status); assert.equal(pwOnly.status, 403);
    // Exact expiry: R at t0 verified immediately, used at t0+300000.
    const t0 = st.f.clock.value; await stepUp(u.c, u.key, 'ORGANIZATION_CREATE', undefined, cmd('Alfa'));
    st.f.clock.value = t0 + 300000; const expired = await create('Alfa'); observed.set('R at 5:00', expired.status); assert.equal(expired.status, 403);
    // Payload mismatch denied WITHOUT consuming; exact payload then succeeds at 4:59.999; replay denied.
    const t1 = st.f.clock.value; await stepUp(u.c, u.key, 'ORGANIZATION_CREATE', undefined, cmd('Alfa'));
    const mismatch = await create('Beta'); observed.set('R other command', mismatch.status); assert.equal(mismatch.status, 403);
    st.f.clock.value = t1 + 299999;
    const ok = await create('Alfa'); observed.set('R exact command at 4:59.999', ok.status); assert.equal(ok.status, 201);
    await u.c.refreshCsrf();
    const orgId = s((ok.body.data?.['organization'] as Record<string, unknown>)['id']);
    // Purpose mismatch: R for SESSION_REVOKE_ALL cannot change password.
    await stepUp(u.c, u.key, 'SESSION_REVOKE_ALL');
    const wrongPurpose = await u.c.call('POST', '/api/v1/auth/password/change', { currentPassword: PASSWORD, newPassword: PASSWORD + ' nueva' });
    observed.set('R purpose mismatch', wrongPurpose.status); assert.equal(wrongPurpose.status, 403);
    // Version binding: R for ORGANIZATION_EDIT bound to version v1 is unusable after the org version changes.
    const org1 = await u.c.call('GET', '/api/v1/organization'); const v1 = s(org1.headers['etag']);
    await stepUp(u.c, u.key, 'ORGANIZATION_EDIT', orgId, { name: 'Gamma' });
    const editA = await u.c.call('PATCH', '/api/v1/organization', { name: 'Gamma' }, { 'If-Match': v1 }); assert.equal(editA.status, 200); await u.c.refreshCsrf();
    await stepUp(u.c, u.key, 'ORGANIZATION_EDIT', orgId, { name: 'Delta' });
    const staleVersion = await u.c.call('PATCH', '/api/v1/organization', { name: 'Delta' }, { 'If-Match': v1 });
    observed.set('stale If-Match', staleVersion.status); assert.equal(staleVersion.status, 412);
    const noIfMatch = await u.c.call('PATCH', '/api/v1/organization', { name: 'Delta' }); observed.set('no If-Match', noIfMatch.status); assert.equal(noIfMatch.status, 428);
    // Wrong password at A32: 401, then per-context limit 5 → 429.
    const codes: number[] = [];
    for (let n = 0; n < 6; n++) codes.push((await u.c.call('POST', '/api/v1/auth/reauthenticate', { password: PASSWORD + ' x', purpose: 'SESSION_REVOKE_ALL' })).status);
    observed.set('A32 wrong password x5 then', codes.at(-1) ?? 0); assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
    evidence('P05-AUTH-05', { observed: Object.fromEntries(observed) });
  } finally { await st.close(); }
});

test('P05-AUTH-06 recovery: reset during A30 terminates flow (A31 impossible), surviving passkey kept; A31 at exactly 15:00 fails, code never refunded', { timeout: 240000 }, async () => {
  const st = await stack();
  try {
    const u = await actor(st), observed = new Map<string, unknown>();
    await stepUp(u.c, u.key, 'RECOVERY_CODES_REGENERATE');
    const gen = await u.c.call('POST', '/api/v1/auth/mfa/recovery-codes/regenerate', {}); assert.equal(gen.status, 200);
    const codes = gen.body.data?.['codes'] as string[]; assert.equal(codes.length, 10);
    const passkeyId = (await st.f.sessions.factors.findOne({ subjectId: u.userId, state: 'ACTIVE' }))?._id; assert.ok(passkeyId);
    // A RESET token delivered BEFORE recovery remains usable; using it during recovery must close the flow.
    const anon = st.client(); await anon.refreshCsrf();
    assert.equal((await anon.call('POST', '/api/v1/auth/password-reset/request', { email: u.email })).status, 202);
    const resetToken = await mailToken(st, u.userId, 'RESET');
    const l = await login(st, u.email), start = await l.c.call('POST', '/api/v1/auth/mfa/recovery/start', { recoveryCode: s(codes[0]) });
    observed.set('A30', start.status); assert.equal(start.status, 200); await l.c.refreshCsrf();
    const enrol = await l.c.call('POST', '/api/v1/auth/mfa/totp/enrollments', { label: 'Recuperación' }); assert.equal(enrol.status, 201);
    const secret = new URL(s(enrol.body.data?.['provisioningUri'])).searchParams.get('secret'); assert.ok(secret);
    const pendingId = s(enrol.body.data?.['enrollmentId']);
    const confirm = await l.c.call('POST', `/api/v1/auth/mfa/totp/enrollments/${pendingId}/confirm`, { code: await generate({ secret, epoch: Math.floor(st.f.clock.value / 1000) }) });
    observed.set('pending recovery factor confirmed', confirm.status); assert.equal(confirm.status, 200);
    const r = st.client(); await r.refreshCsrf();
    assert.equal((await r.call('POST', '/api/v1/auth/password-reset/confirm', { mode: 'PREVIEW', token: resetToken })).status, 200);
    const reset = await r.call('POST', '/api/v1/auth/password-reset/confirm', { mode: 'CONFIRM', token: resetToken, newPassword: PASSWORD + ' reset', warningAcknowledged: false });
    observed.set('A19 during recovery', reset.status); assert.equal(reset.status, 200);
    const a31 = await l.c.call('POST', '/api/v1/auth/mfa/recovery/complete', { newMethodId: pendingId, retireMethodIds: [passkeyId] });
    observed.set('A31 after A19', a31.status); assert.notEqual(a31.status, 200);
    const pend = await st.f.sessions.factors.findOne({ _id: pendingId }); observed.set('pending factor active', pend?.state === 'ACTIVE'); assert.notEqual(pend?.state, 'ACTIVE');
    assert.equal(pend?.encryptedSecret, undefined, 'pending secret erased');
    observed.set('surviving passkey active', (await st.f.sessions.factors.findOne({ _id: passkeyId }))?.state === 'ACTIVE');
    assert.equal((await st.f.sessions.factors.findOne({ _id: passkeyId }))?.state, 'ACTIVE');
    const me = await st.f.identity.identities.findOne({ _id: u.userId }); assert.notEqual(me?.state, 'RECOVERY_RESTRICTED');
    // New password + surviving passkey logs in; old consumed code is never refunded.
    const l2 = await login(st, u.email, PASSWORD + ' reset'); assert.equal(l2.r.status, 200);
    const again = await l2.c.call('POST', '/api/v1/auth/mfa/recovery/start', { recoveryCode: s(codes[0]) });
    observed.set('consumed code reused', again.status); assert.equal(again.status, 401);
    // Exact 15:00 expiry of E_RECOVERY: confirmed pending factor never activates.
    const l3 = await login(st, u.email, PASSWORD + ' reset'), t0 = st.f.clock.value;
    assert.equal((await l3.c.call('POST', '/api/v1/auth/mfa/recovery/start', { recoveryCode: s(codes[1]) })).status, 200); await l3.c.refreshCsrf();
    const e2 = await l3.c.call('POST', '/api/v1/auth/mfa/totp/enrollments', { label: 'Recuperación 2' });
    const secret2 = new URL(s(e2.body.data?.['provisioningUri'])).searchParams.get('secret'); assert.ok(secret2);
    const pending2 = s(e2.body.data?.['enrollmentId']); st.f.clock.value += 30000;
    assert.equal((await l3.c.call('POST', `/api/v1/auth/mfa/totp/enrollments/${pending2}/confirm`, { code: await generate({ secret: secret2, epoch: Math.floor(st.f.clock.value / 1000) }) })).status, 200);
    st.f.clock.value = t0 + 900000;
    const late = await l3.c.call('POST', '/api/v1/auth/mfa/recovery/complete', { newMethodId: pending2, retireMethodIds: [] });
    observed.set('A31 at 15:00', late.status); assert.notEqual(late.status, 200);
    assert.notEqual((await st.f.sessions.factors.findOne({ _id: pending2 }))?.state, 'ACTIVE');
    const l4 = await login(st, u.email, PASSWORD + ' reset'), refund = await l4.c.call('POST', '/api/v1/auth/mfa/recovery/start', { recoveryCode: s(codes[1]) });
    observed.set('expired flow code reused', refund.status); assert.equal(refund.status, 401);
    evidence('P05-AUTH-06', { observed: Object.fromEntries(observed) });
  } finally { await st.close(); }
});

test('P05-AUTH-07 S inactivity 29:59.999/30:00 and absolute 12h boundaries; revocation visible immediately on a second instance', { timeout: 240000 }, async () => {
  const st = await stack();
  try {
    const u = await actor(st), observed = new Map<string, unknown>();
    // Second real app instance on the same replica set (independent Database/IdentityService).
    const { Database } = await import('../../src/shared/database.js');
    const { Sessions } = await import('../../src/modules/sessions/service.js');
    const { SyntheticMessaging } = await import('../../src/modules/messaging/service.js');
    const { IdentityService } = await import('../../src/modules/identity/service.js');
    const { PasswordHasher } = await import('../../src/modules/identity/password.js');
    const db2 = new Database(st.f.uri, st.f.database.db.databaseName); await db2.connect();
    const id2 = new IdentityService(db2, new Sessions(db2, st.f.now), new SyntheticMessaging(db2, st.f.mailKey, st.f.now), new PasswordHasher(), () => true, st.f.now);
    await id2.initialize();
    const port2 = await freePort(), config2 = { ...st.config, port: port2, tenantOrigin: `https://localhost:${port2}`, platformOrigin: `https://platform.localhost:${port2}` };
    await attachRuntime(id2, st.keys, config2);
    const server2 = createServer(st.tls, createApp({ identity: id2, config: config2 })).listen(port2, '127.0.0.1'); await once(server2, 'listening');
    try {
      const on2 = (c: ApiClient) => { const x = new ApiClient(port2, st.tls.cert); for (const [k, v] of c.cookies) x.cookies.set(k, v); x.csrf = c.csrf; return x; };
      const b = await login(st, u.email); assert.equal((await passkeyVerify(b.c, u.key, 'LOGIN')).status, 200);
      assert.equal((await on2(b.c).call('GET', '/api/v1/auth/me')).status, 200, 'session B valid on instance 2');
      const list = await u.c.call('GET', '/api/v1/auth/sessions'), items = list.body.data?.['items'] as { id: string; current: boolean }[];
      const other = items.find(i => !i.current); assert.ok(other);
      await stepUp(u.c, u.key, 'SESSION_REVOKE_OTHER', other.id);
      assert.equal((await u.c.call('DELETE', `/api/v1/auth/sessions/${other.id}`)).status, 204);
      const afterRevoke = await on2(b.c).call('GET', '/api/v1/auth/me'); observed.set('revoked B on instance 2', afterRevoke.status); assert.equal(afterRevoke.status, 401);
      // Inactivity boundary on instance 2 for the current S of u.
      const touch = () => on2(u.c).call('GET', '/api/v1/auth/me');
      assert.equal((await touch()).status, 200);
      st.f.clock.value += 1799999; const edge = await touch(); observed.set('idle 29:59.999', edge.status); assert.equal(edge.status, 200);
      st.f.clock.value += 1800000; const idle = await touch(); observed.set('idle 30:00', idle.status); assert.equal(idle.status, 401);
      // Absolute 12h with continuous activity.
      const c = await login(st, u.email); assert.equal((await passkeyVerify(c.c, u.key, 'LOGIN')).status, 200);
      const issuedAt = st.f.clock.value; let last = 200;
      while (st.f.clock.value + 20 * 60000 < issuedAt + 43200000) { st.f.clock.value += 20 * 60000; last = (await on2(c.c).call('GET', '/api/v1/auth/me')).status; if (last !== 200) break; }
      observed.set('active just before 12h', last); assert.equal(last, 200);
      st.f.clock.value = issuedAt + 43200000; const abs = await on2(c.c).call('GET', '/api/v1/auth/me'); observed.set('absolute 12:00:00', abs.status); assert.equal(abs.status, 401);
      evidence('P05-AUTH-07', { observed: Object.fromEntries(observed) });
    } finally { server2.closeAllConnections(); await new Promise<void>(r => server2.close(() => r())); await db2.close(); }
  } finally { await st.close(); }
});
