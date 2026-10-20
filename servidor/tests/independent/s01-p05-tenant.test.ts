// S01-P05 independent tenant/authorization tests (Claude). Real HTTPS app + real MongoDB replica set, controllable clock.
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
import { Authorization } from '../../src/shared/authorization.js';
import type { Identity } from '../../src/modules/identity/models.js';

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
  const r = await m.c.call('POST', '/api/v1/auth/invitations/accept', { mode: 'CONFIRM', token }); assert.equal(r.status, 200, 'A15 CONFIRM'); await m.c.refreshCsrf();
  return m;
}
interface Row { userId: string; status: string; version: string; roleIds: string[]; email: string; displayName: string }
async function rows(m: Actor, query = ''): Promise<{ items: Row[]; nextCursor: string | null; status: number }> {
  const r = await m.c.call('GET', `/api/v1/organization/members${query}`);
  return { items: (r.body.data?.['items'] as Row[] | undefined) ?? [], nextCursor: (r.body.data?.['nextCursor'] as string | null | undefined) ?? null, status: r.status };
}
async function rowOf(m: Actor, userId: string): Promise<Row> {
  let cursor: string | null = null;
  do {
    const page = await rows(m, `?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const hit = page.items.find(i => i.userId === userId); if (hit) return hit; cursor = page.nextCursor;
  } while (cursor);
  throw new Error('member row not found');
}
const PURPOSE = new Map([['suspend', 'MEMBER_SUSPEND'], ['reactivate', 'MEMBER_REACTIVATE'], ['revoke', 'MEMBER_SESSIONS_REVOKE']] as const);
async function memberCommand(m: Actor, targetId: string, kind: 'suspend' | 'reactivate' | 'revoke', version: string, withR = true) {
  if (withR) await stepUp(m.c, m.key, s(PURPOSE.get(kind)), targetId);
  const path = kind === 'revoke' ? `/api/v1/organization/members/${targetId}/sessions/revoke` : `/api/v1/organization/members/${targetId}/${kind}`;
  return await m.c.call('POST', path, { reasonCode: 'SECURITY' }, { 'If-Match': version });
}
async function roleChange(m: Actor, targetId: string, roleIds: string[], version: string, withR = true) {
  if (withR) await stepUp(m.c, m.key, 'MEMBER_ROLE_CHANGE', targetId, { roleIds });
  return await m.c.call('PATCH', `/api/v1/organization/members/${targetId}/roles`, { roleIds }, { 'If-Match': version });
}

test('P05-TEN-01 cross-tenant IDs/cursors are 404 without R, realm/state escalation denied, non-manager 403, foreign membership never revealed', { timeout: 300000 }, async () => {
  const st = await stack();
  try {
    const observed = new Map<string, unknown>();
    const t1 = await actor(st), org1 = await createOrg(t1, 'Org Uno'), m1 = await member(st, t1, org1, ['O']), m1b = await member(st, t1, org1, ['L']);
    const t2 = await actor(st), org2 = await createOrg(t2, 'Org Dos');
    const v1 = (await rowOf(t1, m1.userId)).version;
    // Foreign target: R cannot even be prepared, and every member operation is 404 (not 403/412/428) before R/version.
    const a32 = await t2.c.call('POST', '/api/v1/auth/reauthenticate', { password: PASSWORD, purpose: 'MEMBER_ROLE_CHANGE', resourceId: m1.userId, command: { roleIds: ['L'] } });
    observed.set('A32 foreign target', a32.status); assert.equal(a32.status, 404);
    for (const [name, r] of [
      ['A16', await roleChange(t2, m1.userId, ['L'], v1, false)], ['A16 no If-Match', await t2.c.call('PATCH', `/api/v1/organization/members/${m1.userId}/roles`, { roleIds: ['L'] })],
      ['A17', await memberCommand(t2, m1.userId, 'suspend', v1, false)], ['A36', await memberCommand(t2, m1.userId, 'reactivate', v1, false)],
      ['A37', await memberCommand(t2, m1.userId, 'revoke', v1, false)]] as const) { observed.set(`${name} foreign`, r.status); assert.equal(r.status, 404, name); }
    // Foreign invitation id.
    const inviteEmail = `${randomUUID()}@example.test`; await invite(st, t1, org1, inviteEmail, ['C']);
    const inv = await t1.c.call('GET', '/api/v1/organization/invitations'), invItem = (inv.body.data?.['items'] as { id: string; version: string; email: string }[]).find(i => i.email === inviteEmail); assert.ok(invItem);
    const a14 = await t2.c.call('DELETE', `/api/v1/organization/invitations/${invItem.id}`, undefined, { 'If-Match': invItem.version });
    observed.set('A14 foreign invitation', a14.status); assert.equal(a14.status, 404);
    // Lists never cross; T1 cursor rejected for T2 and for another manager of org1; tampered cursor 422.
    const list2 = await rows(t2); assert.ok(list2.items.every(i => i.userId !== m1.userId && i.userId !== t1.userId)); observed.set('A11 org2 rows', list2.items.length);
    const page = await rows(t1, '?limit=1'); assert.ok(page.nextCursor);
    const foreignCursor = await rows(t2, `?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`); observed.set('cursor of org1 used by org2', foreignCursor.status); assert.ok([404, 422].includes(foreignCursor.status));
    const forged = page.nextCursor.replace(/^./, c => (c === 'A' ? 'B' : 'A'));
    const tampered = await rows(t1, `?limit=1&cursor=${encodeURIComponent(forged)}`); observed.set('tampered cursor', tampered.status); assert.equal(tampered.status, 422);
    const badLimit = await rows(t1, '?limit=51'); observed.set('limit 51', badLimit.status); assert.equal(badLimit.status, 422);
    // Full chain with limit=1 enumerates org1 exactly once each.
    const seen: string[] = []; let cur: string | null = null;
    do { const p = await rows(t1, `?limit=1${cur ? `&cursor=${encodeURIComponent(cur)}` : ''}`); seen.push(...p.items.map(i => i.userId)); cur = p.nextCursor; } while (cur);
    observed.set('org1 rows by limit=1 chain', seen.length); assert.deepEqual([...seen].sort(), [t1.userId, m1.userId, m1b.userId].sort());
    // Non-manager O: management reads/writes 403; own org read without version.
    const asO = await rows(m1); observed.set('A11 by O', asO.status); assert.equal(asO.status, 403);
    const readO = await m1.c.call('GET', '/api/v1/organization'); observed.set('A09 by O has version', 'version' in (readO.body.data ?? {})); assert.equal(readO.status, 200); assert.equal('version' in (readO.body.data ?? {}), false);
    const deviations: string[] = []; observed.set('A09 by O ETag header', readO.headers['etag'] ?? null);
    if (readO.headers['etag'] !== undefined) deviations.push(`A09 non-management response carries ETag ${String(readO.headers['etag']).slice(0, 2)}... (code omits etag for non-managers; Express default ETag active)`);
    const o32 = await m1.c.call('POST', '/api/v1/auth/reauthenticate', { password: PASSWORD, purpose: 'MEMBER_INVITE', resourceId: org1, command: { email: 'x@example.test', roleIds: ['L'] } });
    observed.set('A32 MEMBER_INVITE by O', o32.status); assert.equal(o32.status, 403);
    // Password-only L and E_INITIAL never reach management; S without org gets ONBOARDING_REQUIRED.
    const l = await login(st, t1.email); const lr = await l.c.call('GET', '/api/v1/organization/members'); observed.set('A11 with L', lr.status); assert.equal(lr.status, 401);
    const e = await activated(st); const er = await e.c.call('GET', '/api/v1/organization/members'); observed.set('A11 with E_INITIAL', er.status); assert.equal(er.status, 401);
    const noOrg = await actor(st); const nr = await noOrg.c.call('GET', '/api/v1/organization/members'); observed.set('A11 S without org', `${nr.status} ${nr.body.error?.code ?? ''}`); assert.equal(nr.status, 409);
    // Tenant cookie presented on PLATFORM host is not a session there.
    const plat = st.client('platform.localhost'); for (const [k, v] of t1.c.cookies) plat.cookies.set(k, v);
    const pr = await plat.call('GET', '/api/v1/auth/me'); observed.set('tenant cookie on PLATFORM', pr.status); assert.equal(pr.status, 401);
    // Foreign membership: org2 invites m1 (already in org1) -> neutral 202; CONFIRM yields the same generic 409 as a garbage token.
    const cross = await invite(st, t2, org2, m1.email, ['L']);
    const c1 = await m1.c.call('POST', '/api/v1/auth/invitations/accept', { mode: 'CONFIRM', token: cross });
    const c2 = await m1.c.call('POST', '/api/v1/auth/invitations/accept', { mode: 'CONFIRM', token: 'A'.repeat(43) });
    observed.set('CONFIRM while member elsewhere', `${c1.status} ${c1.body.error?.code ?? ''}`); observed.set('CONFIRM garbage token', `${c2.status} ${c2.body.error?.code ?? ''}`);
    assert.equal(c1.status, c2.status); assert.equal(c1.body.error?.code, c2.body.error?.code);
    // Suspension denies the member's S immediately.
    const susp = await memberCommand(t1, m1b.userId, 'suspend', (await rowOf(t1, m1b.userId)).version); assert.equal(susp.status, 200);
    const after = await m1b.c.call('GET', '/api/v1/auth/me'); observed.set('suspended member S', after.status); assert.equal(after.status, 401);
    const meEtag = (await m1.c.call('GET', '/api/v1/auth/me')).headers['etag']; observed.set('A07 ETag header', meEtag ?? null);
    if (meEtag !== undefined) deviations.push('A07 /auth/me carries an ETag not defined by the contract');
    evidence('P05-TEN-01', { observed: Object.fromEntries(observed), contractDeviations: deviations });
    assert.deepEqual(deviations, [], 'contract deviations (security assertions above held)');
  } finally { await st.close(); }
});

test('P05-TEN-02 hierarchy: A cannot manage A/T/self or grant A; T cannot grant T; no self-promotion; only T revokes org sessions', { timeout: 300000 }, async () => {
  const st = await stack();
  try {
    const observed = new Map<string, unknown>();
    const t = await actor(st), org = await createOrg(t, 'Org Jerarquía');
    const a1 = await member(st, t, org, ['A']), a2 = await member(st, t, org, ['A']), m = await member(st, t, org, ['O']);
    const ver = async (id: string) => (await rowOf(t, id)).version;
    const r32 = async (who: Actor, purpose: string, resourceId: string, command?: Record<string, unknown>) =>
      (await who.c.call('POST', '/api/v1/auth/reauthenticate', { password: PASSWORD, purpose, resourceId, ...(command ? { command } : {}) })).status;
    observed.set('A: R role change of other A', await r32(a1, 'MEMBER_ROLE_CHANGE', a2.userId, { roleIds: ['O'] }));
    observed.set('A: R role change of T', await r32(a1, 'MEMBER_ROLE_CHANGE', t.userId, { roleIds: ['O'] }));
    observed.set('A: R grant A to O', await r32(a1, 'MEMBER_ROLE_CHANGE', m.userId, { roleIds: ['A'] }));
    observed.set('A: R self role change', await r32(a1, 'MEMBER_ROLE_CHANGE', a1.userId, { roleIds: ['A', 'O'] }));
    observed.set('A: R invite with A', await r32(a1, 'MEMBER_INVITE', org, { email: `${randomUUID()}@example.test`, roleIds: ['A'] }));
    observed.set('A: R suspend other A', await r32(a1, 'MEMBER_SUSPEND', a2.userId));
    observed.set('A: R org sessions revoke', await r32(a1, 'ORGANIZATION_SESSIONS_REVOKE', org));
    observed.set('T: R self role change', await r32(t, 'MEMBER_ROLE_CHANGE', t.userId, { roleIds: ['A'] }));
    for (const [k, v] of observed) assert.equal(v, 403, k);
    // Direct operations without valid R are still denied by hierarchy (403) before version/R.
    observed.set('A: A16 on A direct', (await roleChange(a1, a2.userId, ['O'], await ver(a2.userId), false)).status);
    observed.set('A: A17 on T direct', (await memberCommand(a1, t.userId, 'suspend', await ver(t.userId), false)).status);
    observed.set('A: A38 direct', (await a1.c.call('POST', '/api/v1/organization/sessions/revoke-all', { reasonCode: 'SECURITY' }, { 'If-Match': s((await t.c.call('GET', '/api/v1/organization')).headers['etag']) })).status);
    for (const k of ['A: A16 on A direct', 'A: A17 on T direct', 'A: A38 direct']) assert.equal(observed.get(k), 403, k);
    // Schema forbids T/SA as assignable roles (no override).
    const grantT = await t.c.call('POST', '/api/v1/auth/reauthenticate', { password: PASSWORD, purpose: 'MEMBER_ROLE_CHANGE', resourceId: m.userId, command: { roleIds: ['T'] } });
    observed.set('T: R grant T', grantT.status); assert.equal(grantT.status, 422);
    // A may manage O; T may demote A; then the demoted A loses management immediately.
    const okA = await roleChange(a1, m.userId, ['C'], await ver(m.userId)); observed.set('A manages O', okA.status); assert.equal(okA.status, 200); await a1.c.refreshCsrf();
    const demote = await roleChange(t, a2.userId, ['O'], await ver(a2.userId)); observed.set('T demotes A', demote.status); assert.equal(demote.status, 200);
    const a2me = await a2.c.call('GET', '/api/v1/organization/members'); observed.set('demoted A old S', a2me.status); assert.equal(a2me.status, 401);
    // A invitation with role A created by T cannot be revoked by A.
    const email = `${randomUUID()}@example.test`; await invite(st, t, org, email, ['A']); await t.c.refreshCsrf();
    const inv = (await a1.c.call('GET', '/api/v1/organization/invitations')).body.data?.['items'] as { id: string; email: string; version: string }[];
    const item = inv.find(i => i.email === email); assert.ok(item);
    observed.set('A: R revoke invitation carrying A', await r32(a1, 'INVITATION_REVOKE', item.id)); assert.equal(observed.get('A: R revoke invitation carrying A'), 403);
    evidence('P05-TEN-02', { observed: Object.fromEntries(observed) });
  } finally { await st.close(); }
});

test('P05-TEN-03 recovery privacy before/during/after for A11/A16/A17/A36/A37/A38 (count only operational S) and recovery state after admin actions', { timeout: 360000 }, async () => {
  const st = await stack();
  try {
    const observed = new Map<string, unknown>(), notes: string[] = [];
    const t = await actor(st), org = await createOrg(t, 'Org Privacidad');
    const m1 = await member(st, t, org, ['O']), m2 = await member(st, t, org, ['O']);
    await stepUp(m1.c, m1.key, 'RECOVERY_CODES_REGENERATE');
    const codes = (await m1.c.call('POST', '/api/v1/auth/mfa/recovery-codes/regenerate', {})).body.data?.['codes'] as string[]; assert.equal(codes.length, 10);
    const view = (r: Row) => ({ status: r.status, version: r.version, roleIds: r.roleIds });
    const before1 = view(await rowOf(t, m1.userId)), before2 = view(await rowOf(t, m2.userId));
    observed.set('before m1/m2 status', [before1.status, before2.status]);
    // m2 logs out (0 S); m1 enters recovery (all S revoked, E_RECOVERY only).
    assert.equal((await m2.c.call('POST', '/api/v1/auth/logout')).status, 204);
    const l = await login(st, m1.email), started = await l.c.call('POST', '/api/v1/auth/mfa/recovery/start', { recoveryCode: s(codes[0]) });
    assert.equal(started.status, 200); await l.c.refreshCsrf();
    // DURING: identical manager view, no ETag change; A37 counts 0 for both (E not counted).
    const during1 = view(await rowOf(t, m1.userId)), during2 = view(await rowOf(t, m2.userId));
    observed.set('A11 m1 during == before', JSON.stringify(during1) === JSON.stringify(before1)); assert.deepEqual(during1, before1);
    assert.deepEqual(during2, before2);
    const r37a = await memberCommand(t, m1.userId, 'revoke', during1.version), r37b = await memberCommand(t, m2.userId, 'revoke', during2.version);
    observed.set('A37 during m1 vs m2', [r37a.status, r37a.body.data?.['revokedCount'], r37b.status, r37b.body.data?.['revokedCount']]);
    assert.equal(r37a.status, r37b.status); assert.equal(r37a.body.data?.['revokedCount'], 0); assert.equal(r37b.body.data?.['revokedCount'], 0);
    const eAfter37 = await l.c.call('GET', '/api/v1/auth/me'); notes.push(`E_RECOVERY after admin A37: ${eAfter37.status}`);
    // A17/A36 during: same responses for m1 and m2.
    const s1 = await memberCommand(t, m1.userId, 'suspend', (await rowOf(t, m1.userId)).version), s2 = await memberCommand(t, m2.userId, 'suspend', (await rowOf(t, m2.userId)).version);
    observed.set('A17 during m1 vs m2', [s1.status, s1.body.data?.['status'], s2.status, s2.body.data?.['status']]);
    assert.equal(s1.status, 200); assert.equal(s1.body.data?.['status'], s2.body.data?.['status']);
    const re1 = await memberCommand(t, m1.userId, 'reactivate', s(s1.body.data?.['version'])), re2 = await memberCommand(t, m2.userId, 'reactivate', s(s2.body.data?.['version']));
    observed.set('A36 during m1 vs m2', [re1.status, re1.body.data?.['status'], re2.status, re2.body.data?.['status']]);
    assert.equal(re1.status, 200); assert.equal(re1.body.data?.['status'], re2.body.data?.['status']);
    const flow1 = await st.f.database.db.collection<{ _id: string; status: string; expiresAt: number }>('recoveries').findOne({ subjectId: m1.userId, status: 'ACTIVE' });
    const stateAfter36 = (await st.f.identity.identities.findOne({ _id: m1.userId }))?.state;
    notes.push(`after A17+A36 during recovery: identity.state=${stateAfter36}, flow1 status=${flow1?.status ?? 'none'}`);
    // A16 during: same status for both (m1 still has an ACTIVE passkey; pending recovery material is not counted).
    const rc1 = await roleChange(t, m1.userId, ['C'], (await rowOf(t, m1.userId)).version), rc2 = await roleChange(t, m2.userId, ['C'], (await rowOf(t, m2.userId)).version);
    observed.set('A16 during m1 vs m2', [rc1.status, rc2.status]); assert.equal(rc1.status, 200); assert.equal(rc2.status, 200);
    // m1 starts a second recovery (allowed because A36 set ACTIVE); then flow1 expires while flow2 is still live.
    st.f.clock.value += 60000; // flow2 must start after flow1
    const l2 = await login(st, m1.email), start2 = await l2.c.call('POST', '/api/v1/auth/mfa/recovery/start', { recoveryCode: s(codes[1]) });
    notes.push(`second A30 while flow1 ACTIVE: ${start2.status}`);
    if (start2.status === 200 && flow1) {
      await l2.c.refreshCsrf();
      st.f.clock.value = flow1.expiresAt + 1;
      await t.c.call('GET', '/api/v1/auth/me'); // any request runs recovery.expire()
      const flows = await st.f.database.db.collection<{ _id: string; status: string }>('recoveries').find({ subjectId: m1.userId }).toArray();
      const st2 = (await st.f.identity.identities.findOne({ _id: m1.userId }))?.state;
      const live2 = await l2.c.call('GET', '/api/v1/auth/me');
      observed.set('after flow1 expiry: flows', flows.map(f => f.status)); observed.set('after flow1 expiry: identity.state', st2); observed.set('after flow1 expiry: E_RECOVERY2 /me', live2.status);
      // Expected (state machine): flow2 stays ACTIVE and identity stays RECOVERY_RESTRICTED while its flow is live.
      if (st2 !== 'RECOVERY_RESTRICTED' || live2.status !== 200) notes.push('DEFECT: stale flow1 expiry altered state of live flow2');
      // AFTER: m1 completes flow2 if still possible; manager view version unchanged by A31.
      const vBefore31 = (await rowOf(t, m1.userId)).version;
      const e = await l2.c.call('POST', '/api/v1/auth/mfa/totp/enrollments', { label: 'Rec2' });
      if (e.status === 201) {
        const secret = new URL(s(e.body.data?.['provisioningUri'])).searchParams.get('secret'); assert.ok(secret);
        const id = s(e.body.data?.['enrollmentId']); st.f.clock.value += 30000;
        await l2.c.call('POST', `/api/v1/auth/mfa/totp/enrollments/${id}/confirm`, { code: await generate({ secret, epoch: Math.floor(st.f.clock.value / 1000) }) });
        const done = await l2.c.call('POST', '/api/v1/auth/mfa/recovery/complete', { newMethodId: id, retireMethodIds: [] });
        notes.push(`A31 flow2: ${done.status}`);
        const after1 = view(await rowOf(t, m1.userId)); observed.set('A11 version unchanged by A31', after1.version === vBefore31); assert.equal(after1.version, vBefore31);
        observed.set('A11 status after A31', after1.status);
      } else notes.push(`TOTP enrolment in E_RECOVERY2: ${e.status}`);
    }
    // A38: count only operational S (t's own), never E/L/P contexts.
    const l3 = await login(st, m2.email); assert.equal(l3.r.status, 200); // L only for m2
    const live = await st.f.database.db.collection('contexts').countDocuments({ kind: 'S', revoked: false, subjectId: { $in: [t.userId, m1.userId, m2.userId] }, expiresAt: { $gt: st.f.clock.value } });
    await stepUp(t.c, t.key, 'ORGANIZATION_SESSIONS_REVOKE', org);
    const a38 = await t.c.call('POST', '/api/v1/organization/sessions/revoke-all', { reasonCode: 'SECURITY' }, { 'If-Match': s((await t.c.call('GET', '/api/v1/organization')).headers['etag']) });
    observed.set('A38', [a38.status, a38.body.data?.['revokedCount'], `live S rows=${live}`]); assert.equal(a38.status, 200);
    assert.ok(Number(a38.body.data?.['revokedCount']) <= live, 'count bounded by live S rows');
    evidence('P05-TEN-03', { observed: Object.fromEntries(observed), notes });
    assert.equal(notes.some(n => n.startsWith('DEFECT')), false, notes.join(' | '));
  } finally { await st.close(); }
});

test('P05-TEN-04 concurrency: two managers same If-Match one winner; reactivate/revoke race never resurrects revoked S', { timeout: 300000 }, async () => {
  const st = await stack();
  try {
    const observed = new Map<string, unknown>();
    const t = await actor(st), org = await createOrg(t, 'Org Carreras'), a = await member(st, t, org, ['A']), m = await member(st, t, org, ['O']);
    const v = (await rowOf(t, m.userId)).version;
    await stepUp(t.c, t.key, 'MEMBER_ROLE_CHANGE', m.userId, { roleIds: ['C'] });
    await stepUp(a.c, a.key, 'MEMBER_ROLE_CHANGE', m.userId, { roleIds: ['P'] });
    const race = await Promise.all([roleChange(t, m.userId, ['C'], v, false), roleChange(a, m.userId, ['P'], v, false)]);
    observed.set('concurrent A16 statuses', race.map(r => r.status).sort());
    assert.equal(race.filter(r => r.status === 200).length, 1); assert.ok(race.some(r => [412, 403].includes(r.status)));
    // Same manager double submit with one R: at most one success.
    await t.c.refreshCsrf(); const v2 = (await rowOf(t, m.userId)).version;
    await stepUp(t.c, t.key, 'MEMBER_ROLE_CHANGE', m.userId, { roleIds: ['L'] });
    const dbl = await Promise.all([roleChange(t, m.userId, ['L'], v2, false), roleChange(t, m.userId, ['L'], v2, false)]);
    observed.set('double submit one R', dbl.map(r => r.status).sort()); assert.equal(dbl.filter(r => r.status === 200).length, 1);
    // Reactivate vs revoke race on a suspended member: old S never valid again.
    await t.c.refreshCsrf();
    const l = await login(st, m.email); assert.equal((await passkeyVerify(l.c, m.key, 'LOGIN')).status, 200);
    const sv = await memberCommand(t, m.userId, 'suspend', (await rowOf(t, m.userId)).version); assert.equal(sv.status, 200); await t.c.refreshCsrf();
    const vs = s(sv.body.data?.['version']);
    await stepUp(t.c, t.key, 'MEMBER_REACTIVATE', m.userId); await stepUp(a.c, a.key, 'MEMBER_SESSIONS_REVOKE', m.userId);
    const both = await Promise.all([memberCommand(t, m.userId, 'reactivate', vs, false), memberCommand(a, m.userId, 'revoke', vs, false)]);
    observed.set('A36 vs A37 statuses', both.map(r => r.status));
    const old = await l.c.call('GET', '/api/v1/auth/me'); observed.set('pre-suspension S after race', old.status); assert.equal(old.status, 401);
    const fresh = await login(st, m.email); const fr = await passkeyVerify(fresh.c, m.key, 'LOGIN'); observed.set('fresh login after race', fr.status);
    evidence('P05-TEN-04', { observed: Object.fromEntries(observed) });
  } finally { await st.close(); }
});

test('P05-TEN-05 financial boundary policy (unit, no runtime endpoint exists): tenant/scope/owner/assignment/realm/suspension all deny', () => {
  const base: Identity = { _id: 'u1', realm: 'TENANT', email: 'u1@example.test', displayName: 'u', passwordHash: null, state: 'ACTIVE', organizationId: 'org1', roles: ['O'],
    version: '"v"', credentialVersion: 'c', initialProofEpoch: 'i', authEpoch: 'a', authzVersion: 'z', hasEverConfirmedFactor: true, hasEverActive: true,
    resetCompletedAt: null, restoreBootstrapBlocked: false, suspended: false, createdAt: 0, factorCount: 1 };
  const resource = { organizationId: 'org1', financialScope: 'BUSINESS', legalOwnerId: 'owner1', assigneeId: 'u1' };
  const policy = { scope: 'BUSINESS' as const, legalOwnerIds: ['owner1'] as const, assignmentRequired: true };
  Authorization.boundary(base, resource, policy);
  const denied: [string, () => void][] = [
    ['other tenant', () => Authorization.boundary(base, { ...resource, organizationId: 'org2' }, policy)],
    ['PERSONAL vs BUSINESS', () => Authorization.boundary(base, { ...resource, financialScope: 'PERSONAL' }, policy)],
    ['other legal owner', () => Authorization.boundary(base, { ...resource, legalOwnerId: 'owner2' }, policy)],
    ['not assigned', () => Authorization.boundary(base, { ...resource, assigneeId: 'u2' }, policy)],
    ['PLATFORM realm', () => Authorization.boundary({ ...base, realm: 'PLATFORM' }, resource, policy)],
    ['suspended', () => Authorization.boundary({ ...base, suspended: true }, resource, policy)],
    ['no organization', () => Authorization.boundary({ ...base, organizationId: null }, resource, policy)],
    ['role union does not bypass', () => Authorization.boundary({ ...base, roles: ['T', 'A', 'O', 'C', 'P', 'L'] }, { ...resource, organizationId: 'org2' }, policy)],
  ];
  for (const [name, fn] of denied) assert.throws(fn, (e: unknown) => (e as { status?: number }).status === 404, name);
  evidence('P05-TEN-05', { deniedCases: denied.length, note: 'policy unit only; no financial endpoint implemented in S1' });
});
