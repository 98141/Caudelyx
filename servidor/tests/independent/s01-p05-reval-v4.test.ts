/* eslint-disable security/detect-object-injection -- Keys are this test's own fixed field names/array indexes, never request input. */
// S01-P05-REVAL-v4 independent tests (Claude) on candidate P04-v4-INTEGRADO, API 0.11 candidate (never BASELINE).
// Real HTTPS app + real MongoDB replica set, controllable clock. The software authenticator below produces genuine
// ECDSA P-256 signatures verified by @simplewebauthn/server. No secret, token or key is printed or persisted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { once } from 'node:events';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import type { Document } from 'mongodb';
import { fixture } from '../helpers/fixture.js';
import { testCertificate } from '../helpers/tls.js';
import { ApiClient } from '../helpers/client.js';
import { createApp } from '../../src/app.js';
import { attachRuntime } from '../../src/shared/runtime.js';

// ---------- shared harness (copied from REVAL-v3 (historical file untouched); reservation allows only the REVAL-v4 files) ----------
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
const evidence = (name: string, data: Record<string, unknown>) => console.log(JSON.stringify({ evidence: name, ...data }));

const SAME = 'attacker chosen passphrase 0.11 review';
const profileBody = (email: string, displayName: string, password = SAME) => ({ mode: 'PROFILE', email, displayName, password, privacyPolicyVersion: 'synthetic-v1', acceptTerms: true });
async function freshP(st: Stack) { const c = st.client(); await c.refreshCsrf(); return c; }
async function intentToken(st: Stack, email: string) {
  const subject = await st.f.identity.identities.findOne({ email }); if (!subject) return null;
  await st.f.identity.dispatchMail();
  return [...st.f.messages.inbox.values()].reverse().find(m => m.subjectId === subject._id && m.purpose === 'ACTIVATION')?.token ?? null;
}
const shape = (v: unknown): unknown => v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== 'requestId').map(([k, x]) => [k, k === 'email' || k === 'displayName' ? typeof x : shape(x)])) : v;
const SESSION = '__Host-caudelyx-session';

test('P05v4-REG-01 A02 PROFILE -> A07 -> A05 enumeration matrix with the same chosen password: new / pending / verified-no-factor / verified-with-MFA are indistinguishable and existing accounts never change', { timeout: 300000 }, async () => {
  const st = await stack();
  try {
    const observed = new Map<string, unknown>();
    const pendingEmail = `${randomUUID()}@example.test`;
    await st.f.identity.register('TENANT', 'p05v4-seed', { email: pendingEmail, displayName: 'Real pendiente', privacyPolicyVersion: 'synthetic-v1' });
    const verifiedNoFactor = await activated(st), withMfa = await actor(st);
    const before = new Map<string, Document | null>();
    for (const e of [pendingEmail, verifiedNoFactor.email, withMfa.email]) before.set(e, await st.f.identity.identities.findOne({ email: e }));
    const cases: [string, string][] = [['new', `${randomUUID()}@example.test`], ['pending', pendingEmail], ['verified-no-factor', verifiedNoFactor.email], ['verified-with-MFA', withMfa.email]];
    const rows: Record<string, unknown>[] = [];
    for (const [name, email] of cases) {
      const c = await freshP(st), display = `Intruso ${name}`;
      const a02 = await c.call('POST', '/api/v1/auth/register', profileBody(email, display));
      const a07 = await c.call('GET', '/api/v1/auth/me');
      const a05c = await freshP(st), cookieBefore = a05c.cookies.get(SESSION), a05 = await a05c.call('POST', '/api/v1/auth/login', { email, password: SAME });
      const a03 = await c.call('POST', '/api/v1/auth/email-verifications/request', { purpose: 'ACTIVATION', email });
      const a22 = await c.call('POST', '/api/v1/auth/mfa/totp/enrollments', { label: 'x' });
      const a09 = await c.call('GET', '/api/v1/organization');
      const prof = a07.body.data?.['profile'] as Record<string, unknown> | undefined;
      rows.push({ name, a02: a02.status, a02Shape: JSON.stringify(shape(a02.body)), a07: a07.status, a07Shape: JSON.stringify(shape(a07.body)),
        a07ShowsIntroduced: prof?.['displayName'] === display && prof['email'] === email && prof['emailVerified'] === false,
        a07HasUserId: JSON.stringify(a07.body).includes('userId'), a05: a05.status, a05Code: a05.body.error?.code ?? null, a05RotatedCookie: a05c.cookies.get(SESSION) !== cookieBefore,
        a03: a03.status, a22: a22.status, a09: a09.status });
    }
    observed.set('matrix', rows);
    const keys = ['a02', 'a02Shape', 'a07', 'a07Shape', 'a05', 'a05Code', 'a05RotatedCookie', 'a03', 'a22', 'a09'];
    const differs = keys.filter(k => new Set(rows.map(r => JSON.stringify(r[k]))).size > 1);
    observed.set('observable fields that differ between cases', differs);
    const changes: string[] = [];
    for (const [e, doc] of before) { const now = await st.f.identity.identities.findOne({ email: e }) as Document | null; for (const f of ['passwordHash', 'displayName', 'state', 'credentialVersion', 'authEpoch']) if (JSON.stringify(now?.[f]) !== JSON.stringify(doc?.[f])) changes.push(`${e.slice(0, 6)}… ${f}`); }
    observed.set('existing identity fields changed by attacker A02', changes);
    const real = await login(st, withMfa.email); observed.set('real MFA owner login', real.r.status);
    observed.set('real MFA owner passkey', (await passkeyVerify(real.c, withMfa.key, 'LOGIN')).status);
    const watcher = await freshP(st); await watcher.call('POST', '/api/v1/auth/register', profileBody(pendingEmail, 'Observador'));
    const w1 = JSON.stringify((await watcher.call('GET', '/api/v1/auth/me')).body.data);
    const token = await intentToken(st, pendingEmail); assert.ok(token);
    const owner = await freshP(st);
    observed.set('owner legacy activation of pending', (await owner.call('POST', '/api/v1/auth/email-verifications/confirm', { purpose: 'ACTIVATION', token, newPassword: PASSWORD })).status);
    observed.set('other P profile unchanged after owner activation', w1 === JSON.stringify((await watcher.call('GET', '/api/v1/auth/me')).body.data));
    observed.set('attacker chosen password after owner activation', (await login(st, pendingEmail, SAME)).r.status);
    observed.set('attacker LINK with owner token after activation', (await watcher.call('POST', '/api/v1/auth/email-verifications/confirm', { purpose: 'ACTIVATION', mode: 'LINK', token })).status);
    evidence('P05v4-REG-01', { observed: Object.fromEntries(observed) });
    assert.deepEqual(differs, []);
    assert.ok(rows.every(r => r['a02'] === 202 && r['a07ShowsIntroduced'] === true && r['a07HasUserId'] === false && r['a05'] === 401 && r['a05RotatedCookie'] === false));
    assert.deepEqual(changes, []); assert.equal(observed.get('real MFA owner passkey'), 200);
    assert.equal(observed.get('owner legacy activation of pending'), 200); assert.equal(observed.get('other P profile unchanged after owner activation'), true);
    assert.equal(observed.get('attacker chosen password after owner activation'), 401); assert.notEqual(observed.get('attacker LINK with owner token after activation'), 200);
  } finally { await st.close(); }
});

test('P05v4-REG-02 A04 LINK: own intent only, 4:59 vs 5:00 from the chosen password while A07 still shows EMAIL_REQUIRED, no consumption on failure, legacy from a clean P, replay/other email/other context denied, E_INITIAL bounded', { timeout: 300000 }, async () => {
  const st = await stack();
  try {
    const observed = new Map<string, unknown>();
    const link = (c: ApiClient, token: string) => c.call('POST', '/api/v1/auth/email-verifications/confirm', { purpose: 'ACTIVATION', mode: 'LINK', token });
    const ea = `${randomUUID()}@example.test`, pa = await freshP(st), t0 = st.f.clock.value;
    assert.equal((await pa.call('POST', '/api/v1/auth/register', profileBody(ea, 'Alta A'))).status, 202);
    const ta = await intentToken(st, ea); assert.ok(ta);
    st.f.clock.value = t0 + 299000; const ok = await link(pa, ta); observed.set('LINK at 4:59', ok.status);
    const subjectA = (await st.f.identity.identities.findOne({ email: ea }))?._id ?? '';
    const e = await st.f.sessions.contexts.findOne({ kind: 'E_INITIAL', subjectId: subjectA, revoked: false });
    observed.set('E_INITIAL expiresAt - passwordAt (ms)', (e?.expiresAt ?? 0) - t0);
    observed.set('replay of consumed link', (await link(await freshP(st), ta)).status);
    const chosen = await login(st, ea, SAME); observed.set('login with chosen password after activation', `${chosen.r.status} ${String(chosen.r.body.data?.['authState'] ?? '')}`);
    // At 5:00 the intent is still alive (10 min) and A07 still says EMAIL_REQUIRED, but LINK is refused.
    const eb = `${randomUUID()}@example.test`, pb = await freshP(st), t1 = st.f.clock.value;
    await pb.call('POST', '/api/v1/auth/register', profileBody(eb, 'Alta B')); const tb = await intentToken(st, eb); assert.ok(tb);
    st.f.clock.value = t1 + 300000; const late = await link(pb, tb);
    observed.set('LINK at 5:00 (intent alive)', `${late.status} ${late.body.error?.code ?? ''}`);
    const meLate = await pb.call('GET', '/api/v1/auth/me'); observed.set('A07 of that P at 5:00', `${meLate.status} ${String(meLate.body.data?.['authState'] ?? '')}`);
    st.f.clock.value = t1 + 540000; const meLater = await pb.call('GET', '/api/v1/auth/me');
    observed.set('A07 of that P at 9:00', `${meLater.status} ${String(meLater.body.data?.['authState'] ?? '')}`);
    const resend = await pb.call('POST', '/api/v1/auth/email-verifications/request', { purpose: 'ACTIVATION', email: eb }); const tb2 = await intentToken(st, eb);
    observed.set('resend at 9:00 then LINK with the new link', `${resend.status} ${tb2 ? (await link(pb, tb2)).status : 'no-mail'}`);
    const legacy = await (await freshP(st)).call('POST', '/api/v1/auth/email-verifications/confirm', { purpose: 'ACTIVATION', token: tb2 ?? tb, newPassword: PASSWORD });
    observed.set('legacy initial password from a clean P after failed LINK', legacy.status);
    const ec = `${randomUUID()}@example.test`, pc = await freshP(st); await pc.call('POST', '/api/v1/auth/register', profileBody(ec, 'Alta C')); const tc = await intentToken(st, ec); assert.ok(tc);
    observed.set('LINK from P without intent', (await link(await freshP(st), tc)).status);
    const other = await freshP(st); await other.call('POST', '/api/v1/auth/register', profileBody(`${randomUUID()}@example.test`, 'Otro'));
    observed.set('LINK from P with intent for another email', (await link(other, tc)).status);
    const strong = await actor(st); observed.set('LINK from an S context', (await link(strong.c, tc)).status);
    observed.set('LINK with newPassword too', (await pc.call('POST', '/api/v1/auth/email-verifications/confirm', { purpose: 'ACTIVATION', mode: 'LINK', token: tc, newPassword: PASSWORD })).status);
    observed.set('token still usable by its own intent after those failures', (await link(pc, tc)).status);
    const pend = `${randomUUID()}@example.test`; await (await freshP(st)).call('POST', '/api/v1/auth/register', profileBody(pend, 'Pendiente'));
    const r18 = await (await freshP(st)).call('POST', '/api/v1/auth/password-reset/request', { email: pend });
    await st.f.identity.dispatchMail();
    const pid = (await st.f.identity.identities.findOne({ email: pend }))?._id;
    observed.set('A18 for PENDING_EMAIL: status and RESET mails', `${r18.status} ${[...st.f.messages.inbox.values()].filter(m => m.subjectId === pid && m.purpose === 'RESET').length}`);
    evidence('P05v4-REG-02', { observed: Object.fromEntries(observed) });
    assert.equal(ok.status, 200); assert.ok(Number(observed.get('E_INITIAL expiresAt - passwordAt (ms)')) <= 300000);
    assert.equal(observed.get('replay of consumed link'), 401); assert.equal(late.status, 401); assert.equal(legacy.status, 200);
    assert.equal(observed.get('LINK from P without intent'), 401); assert.equal(observed.get('LINK from P with intent for another email'), 401);
    assert.notEqual(observed.get('LINK from an S context'), 200); assert.equal(observed.get('LINK with newPassword too'), 422);
    assert.equal(observed.get('token still usable by its own intent after those failures'), 200);
    assert.equal(observed.get('A18 for PENDING_EMAIL: status and RESET mails'), '202 0');
  } finally { await st.close(); }
});

test('P05v4-REG-03 concurrent PROFILE registrations of one address from two browsers: one identity without password, both private profiles stable, second submit in the same P ignored', { timeout: 200000 }, async () => {
  const st = await stack();
  try {
    const email = `${randomUUID()}@example.test`, a = await freshP(st), b = await freshP(st);
    const [ra, rb] = await Promise.all([a.call('POST', '/api/v1/auth/register', profileBody(email, 'Navegador A', SAME + ' a')), b.call('POST', '/api/v1/auth/register', profileBody(email, 'Navegador B', SAME + ' b'))]);
    const ids = await st.f.identity.identities.countDocuments({ email }), hash = (await st.f.identity.identities.findOne({ email }))?.passwordHash ?? null;
    const name = async (c: ApiClient) => ((await c.call('GET', '/api/v1/auth/me')).body.data?.['profile'] as Record<string, unknown> | undefined)?.['displayName'];
    const pa = await name(a), pb = await name(b);
    const again = await a.call('POST', '/api/v1/auth/register', profileBody(email, 'Navegador A cambia', SAME + ' c'));
    const pa2 = await name(a);
    evidence('P05v4-REG-03', { statuses: [ra.status, rb.status], identities: ids, identityPasswordHashBeforeProof: hash, profileA: pa, profileB: pb, secondSubmitSameP: again.status, profileAAfterSecond: pa2 });
    assert.deepEqual([ra.status, rb.status], [202, 202]); assert.equal(ids, 1); assert.equal(hash, null);
    assert.equal(pa, 'Navegador A'); assert.equal(pb, 'Navegador B'); assert.equal(pa2, 'Navegador A');
  } finally { await st.close(); }
});
