// S01-P05 independent restore/journal tests (Claude). Real HTTPS app + real MongoDB replica set, controllable clock.
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
import { RestoreController } from '../../src/shared/restore.js';
import type { Document } from 'mongodb';

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
  const r = await m.c.call('POST', '/api/v1/auth/invitations/accept', { mode: 'CONFIRM', token }); assert.equal(r.status, 200, 'A15 CONFIRM'); await m.c.refreshCsrf();
  return m;
}
async function version(m: Actor, userId: string): Promise<string> {
  const r = await m.c.call('GET', '/api/v1/organization/members?limit=50');
  const row = (r.body.data?.['items'] as { userId: string; version: string }[]).find(i => i.userId === userId); assert.ok(row); return row.version;
}
async function dump(db: import('mongodb').Db): Promise<Map<string, Document[]>> {
  const out = new Map<string, Document[]>();
  for (const c of await db.listCollections().toArray()) if (!c.name.startsWith('system.')) out.set(c.name, await db.collection(c.name).find({}).toArray());
  return out;
}
async function load(db: import('mongodb').Db, data: Map<string, Document[]>): Promise<void> {
  for (const c of await db.listCollections().toArray()) if (!c.name.startsWith('system.')) await db.collection(c.name).deleteMany({});
  for (const [name, docs] of data) if (docs.length) await db.collection(name).insertMany(docs);
}

test('P05-RES-01 journal tamper/gap variants keep the WHOLE realm closed; approved reconcile applies conservative T1 effects without replay', { timeout: 420000 }, async () => {
  const st = await stack({ controlledRestore: true });
  try {
    const restore = st.f.restore; assert.ok(restore);
    const observed = new Map<string, unknown>(), deviations: string[] = [];
    // ---- T0 ----
    const t = await actor(st), org = await createOrg(t, 'Org Restore'), m = await member(st, t, org, ['O']);
    await stepUp(m.c, m.key, 'RECOVERY_CODES_REGENERATE');
    const batch1 = (await m.c.call('POST', '/api/v1/auth/mfa/recovery-codes/regenerate', {})).body.data?.['codes'] as string[]; assert.equal(batch1.length, 10);
    const invEmail = `${randomUUID()}@example.test`; await invite(st, t, org, invEmail, ['C']);
    const inv1 = await st.f.database.db.collection<{ _id: string; email: string; status: string }>('invitations').findOne({ email: invEmail }); assert.ok(inv1);
    const counterT0 = (await st.f.sessions.factors.findOne({ subjectId: t.userId, state: 'ACTIVE' }))?.counter ?? 0;
    const T0 = await restore.snapshot();
    // ---- T1 (after snapshot) ----
    for (let n = 0; n < 3; n++) { const l = await login(st, t.email); assert.equal((await passkeyVerify(l.c, t.key, 'LOGIN')).status, 200); }
    const counterT1 = (await st.f.sessions.factors.findOne({ subjectId: t.userId, state: 'ACTIVE' }))?.counter ?? 0;
    await stepUp(t.c, t.key, 'MEMBER_ROLE_CHANGE', m.userId, { roleIds: ['C'] });
    assert.equal((await t.c.call('PATCH', `/api/v1/organization/members/${m.userId}/roles`, { roleIds: ['C'] }, { 'If-Match': await version(t, m.userId) })).status, 200); await t.c.refreshCsrf();
    const invList = (await t.c.call('GET', '/api/v1/organization/invitations')).body.data?.['items'] as { id: string; version: string }[];
    const inv1v = invList.find(i => i.id === inv1._id); assert.ok(inv1v);
    await stepUp(t.c, t.key, 'INVITATION_REVOKE', inv1._id);
    assert.equal((await t.c.call('DELETE', `/api/v1/organization/invitations/${inv1._id}`, undefined, { 'If-Match': inv1v.version })).status, 204);
    const inv2Email = `${randomUUID()}@example.test`; await invite(st, t, org, inv2Email, ['P']);
    // m (role C now, new S needed after role change) replaces codes and changes password after T0.
    const ml = await login(st, m.email); assert.equal((await passkeyVerify(ml.c, m.key, 'LOGIN')).status, 200);
    await stepUp(ml.c, m.key, 'RECOVERY_CODES_REGENERATE'); assert.equal((await ml.c.call('POST', '/api/v1/auth/mfa/recovery-codes/regenerate', {})).status, 200);
    await stepUp(ml.c, m.key, 'PASSWORD_CHANGE');
    assert.equal((await ml.c.call('POST', '/api/v1/auth/password/change', { currentPassword: PASSWORD, newPassword: PASSWORD + ' T1' })).status, 204);
    const lateEmail = `${randomUUID()}@example.test`; await actor(st, lateEmail); // identity that did not exist at T0
    const tOld = st.client(); for (const [k, v] of t.c.cookies) tOld.cookies.set(k, v); tOld.csrf = t.c.csrf;
    await restore.flush();
    // ---- controlled restore to T0 ----
    await restore.beginRestore(T0);
    observed.set('gate open after beginRestore', restore.isOpen()); assert.equal(restore.isOpen(), false);
    const anon = st.client(); await anon.refreshCsrf();
    const closedLogin = await anon.call('POST', '/api/v1/auth/login', { email: t.email, password: PASSWORD });
    const closedReset = await anon.call('POST', '/api/v1/auth/password-reset/request', { email: t.email });
    const closedRegister = await anon.call('POST', '/api/v1/auth/register', { email: `${randomUUID()}@example.test`, displayName: 'x', privacyPolicyVersion: 'synthetic-v1', acceptTerms: true });
    observed.set('closed realm A05/A18/A02', [closedLogin.status, closedReset.status, closedRegister.status]);
    assert.deepEqual([closedLogin.status, closedReset.status, closedRegister.status], [503, 202, 503]);
    const journal = st.f.database.client.db(`${st.f.database.db.databaseName}_external_security`).collection<{ _id: number; previous: string; state: { identities: { roles: string[] }[] }; signature: string }>('events');
    const all = await journal.find({}).sort({ _id: 1 }).toArray(); assert.ok(all.length > 4);
    const mid = all[Math.floor(all.length / 2)], last = all.at(-1); assert.ok(mid && last);
    const tryReconcile = async (name: string) => {
      let outcome = 'reconciled'; try { await restore.reconcile({ approved: true, reviewId: 'P05-synthetic-fixture-not-an-approval' }); } catch (e) { outcome = `rejected ${(e as { status?: number }).status ?? 'error'}`; }
      observed.set(name, `${outcome}; gateOpen=${restore.isOpen()}`); assert.notEqual(outcome, 'reconciled', name); assert.equal(restore.isOpen(), false, name);
    };
    await journal.updateOne({ _id: mid._id }, { $set: { 'state.identities.0.roles': ['T'] } }); await tryReconcile('tampered middle state');
    await journal.replaceOne({ _id: mid._id }, mid);
    await journal.deleteOne({ _id: mid._id }); await tryReconcile('missing middle event'); await journal.insertOne(mid);
    await journal.deleteOne({ _id: last._id }); await tryReconcile('truncated tail'); await journal.insertOne(last);
    await journal.updateOne({ _id: mid._id }, { $set: { previous: 'f'.repeat(64) } }); await tryReconcile('broken chain link'); await journal.replaceOne({ _id: mid._id }, mid);
    await journal.insertOne({ _id: last._id + 1, previous: last.signature, state: last.state, signature: 'a'.repeat(64) });
    let forgedTail = 'ignored'; try { await restore.reconcile({ approved: true, reviewId: 'P05' }); forgedTail = 'reconciled'; } catch { forgedTail = 'rejected'; }
    observed.set('forged event beyond cut', `${forgedTail}; gateOpen=${restore.isOpen()}`); await journal.deleteOne({ _id: last._id + 1 });
    if (restore.isOpen()) { await restore.beginRestore(T0); } // keep the experiment deterministic if the extra event was ignored
    for (const [name, review] of [['approved:false', { approved: false, reviewId: 'x' }], ['blank reviewId', { approved: true, reviewId: '  ' }]] as const) {
      let r = 'reconciled'; try { await restore.reconcile(review); } catch { r = 'rejected'; } observed.set(name, r); assert.equal(r, 'rejected'); assert.equal(restore.isOpen(), false);
    }
    let sigOk = 'accepted'; try { await restore.beginRestore({ ...T0, watermark: T0.watermark + 1 }); } catch { sigOk = 'rejected'; }
    observed.set('snapshot with altered watermark', `${sigOk}; gateOpen=${restore.isOpen()}`); assert.equal(sigOk, 'rejected'); assert.equal(restore.isOpen(), false);
    await restore.beginRestore(T0);
    // ---- positive control: complete chain + synthetic fixture approval (NOT a real approval) ----
    await restore.reconcile({ approved: true, reviewId: 'P05-synthetic-fixture-not-an-approval' });
    observed.set('gate open after valid reconcile', restore.isOpen()); assert.equal(restore.isOpen(), true);
    const oldS = await tOld.call('GET', '/api/v1/auth/me'); observed.set('T1 session after restore', oldS.status); assert.equal(oldS.status, 401);
    const mOld = await login(st, m.email, PASSWORD), mNew = await login(st, m.email, PASSWORD + ' T1');
    observed.set('m login old/new password', [mOld.r.status, mNew.r.status]); assert.equal(mOld.r.status, 401); assert.equal(mNew.r.status, 401);
    const mRow = await st.f.identity.identities.findOne({ _id: m.userId }); observed.set('m roles after restore', mRow?.roles); assert.deepEqual(mRow?.roles, ['C']);
    assert.equal(mRow?.passwordHash, null);
    const inv1After = await st.f.database.db.collection<{ _id: string; status: string }>('invitations').findOne({ _id: inv1._id }); observed.set('inv1 status', inv1After?.status); assert.equal(inv1After?.status, 'REVOKED');
    observed.set('inv2 exists', !!await st.f.database.db.collection('invitations').findOne({ email: inv2Email })); assert.equal(observed.get('inv2 exists'), false);
    observed.set('post-T0 identity exists', !!await st.f.identity.identities.findOne({ email: lateEmail })); assert.equal(observed.get('post-T0 identity exists'), false);
    await st.f.identity.register('TENANT', 'p05-claim', { email: lateEmail, displayName: 'x', privacyPolicyVersion: 'synthetic-v1' });
    observed.set('post-T0 email re-registration creates identity', !!await st.f.identity.identities.findOne({ email: lateEmail })); assert.equal(observed.get('post-T0 email re-registration creates identity'), false);
    const usable = await st.f.database.db.collection('recovery_codes').countDocuments({ subjectId: m.userId, consumed: false });
    observed.set('m usable recovery codes (batch1 replaced at T1)', usable); assert.equal(usable, 0);
    const pendingMail = await st.f.database.db.collection('synthetic_mail').countDocuments({ delivered: false });
    const pendingNotes = await st.f.database.db.collection('synthetic_notifications').countDocuments({ delivered: false });
    observed.set('restored mail/notifications pending replay', [pendingMail, pendingNotes]); assert.equal(pendingMail + pendingNotes, 0);
    // WebAuthn signature counter: journal does not carry it, so T0 counter is restored.
    const counterAfter = (await st.f.sessions.factors.findOne({ subjectId: t.userId, state: 'ACTIVE' }))?.counter ?? 0;
    observed.set('passkey counter T0/T1/after', [counterT0, counterT1, counterAfter]);
    const tl = await login(st, t.email); assert.equal(tl.r.status, 200);
    const lowCounter = await passkeyVerify(tl.c, t.key, 'LOGIN', undefined, { counter: counterT0 + 1 });
    observed.set('assertion with signCount between T0 and T1 accepted', lowCounter.status === 200);
    if (counterAfter < counterT1 && lowCounter.status === 200) deviations.push(`signature counter regressed by restore (${counterT1} -> ${counterAfter}); signCount ${counterT0 + 1} <= last seen ${counterT1} accepted`);
    evidence('P05-RES-01', { observed: Object.fromEntries(observed), deviations, note: 'approved:true/reviewId are synthetic fixtures, not a real restore approval' });
    assert.deepEqual(deviations, []);
  } finally { await st.close(); }
});

test('P05-RES-02 journal and gate vs a cluster-wide rollback: same-replica-set journal cannot detect it (control: main-DB-only rollback is detected)', { timeout: 300000 }, async () => {
  const st = await stack({ controlledRestore: true });
  try {
    const restore = st.f.restore; assert.ok(restore);
    const observed = new Map<string, unknown>();
    const u = await actor(st);
    const main = st.f.database.db, external = st.f.database.client.db(`${main.databaseName}_external_security`);
    await restore.flush();
    const mainT0 = await dump(main), extT0 = await dump(external);
    const oldS = st.client(); for (const [k, v] of u.c.cookies) oldS.cookies.set(k, v); oldS.csrf = u.c.csrf;
    // T1: password change revokes every session; journal flushed.
    await stepUp(u.c, u.key, 'PASSWORD_CHANGE');
    assert.equal((await u.c.call('POST', '/api/v1/auth/password/change', { currentPassword: PASSWORD, newPassword: PASSWORD + ' T1' })).status, 204);
    await restore.flush();
    assert.equal((await oldS.call('GET', '/api/v1/auth/me')).status, 401, 'old S revoked at T1');
    // Control: only the main DB is rolled back; a restarted controller sees head > sequence and closes the realm.
    const mainT1 = await dump(main);
    await load(main, mainT0);
    const restarted = new RestoreController(st.f.database, restore.gatePath, restore.key); await restarted.initialize();
    observed.set('main-only rollback: gate open after restart', restarted.isOpen()); assert.equal(restarted.isOpen(), false);
    // Put T1 back; the closed gate is reopened only through reconcile over the complete external chain.
    await load(main, mainT1);
    await restarted.reconcile({ approved: true, reviewId: 'P05-synthetic-control-reset' }); // complete chain again -> legitimate reopen
    observed.set('control reopened with complete chain', restarted.isOpen()); assert.equal(restarted.isOpen(), true);
    // Cluster-wide rollback: main AND sibling journal DB to T0 (what a replica-set/provider snapshot would do).
    await load(main, mainT0); await load(external, extT0);
    const afterCluster = new RestoreController(st.f.database, restore.gatePath, restore.key); await afterCluster.initialize();
    const open = afterCluster.isOpen(); observed.set('cluster rollback: gate open after restart', open);
    const revived = (await oldS.call('GET', '/api/v1/auth/me')).status; observed.set('T0 session after cluster rollback', revived);
    const oldPw = (await login(st, u.email, PASSWORD)).r.status; observed.set('T0 password after cluster rollback', oldPw);
    evidence('P05-RES-02', { observed: Object.fromEntries(observed), meaning: 'journal is a sibling DB on the same replica set; gate keeps no independent high-watermark' });
    assert.equal(open, false, 'cluster-wide rollback must not leave the realm open (journal/gate need an independent failure domain)');
  } finally { await st.close(); }
});
