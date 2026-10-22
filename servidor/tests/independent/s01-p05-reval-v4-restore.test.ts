/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection -- Paths are this test's own controller/journal/TLS fixtures under servidor/.runtime; keys are fixed field names. Never request input. */
// S01-P05-REVAL-v4 independent restore/availability tests (Claude) on candidate P04-v4-INTEGRADO.
// N03 runs TWO separate OS processes of the built server (dist/src/server.js) sharing MongoDB, keyring, gate and journal.
// N06/I04V4-02 inject an environmental reader (separate PowerShell process) holding the gate. No secret is printed or persisted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { readFile, writeFile, mkdir, stat, unlink, readdir, open as openFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Db, Document } from 'mongodb';
import { generate } from 'otplib';
import { fixture } from '../helpers/fixture.js';
import { testCertificate } from '../helpers/tls.js';
import { ApiClient } from '../helpers/client.js';
import { createApp } from '../../src/app.js';
import { attachRuntime } from '../../src/shared/runtime.js';
import { RestoreController } from '../../src/shared/restore.js';
import { captureSecurityState } from '../../src/shared/evidence.js';
import { unseal } from '../../src/shared/crypto.js';

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
async function login(st: Stack, email: string, password = PASSWORD) {
  const c = st.client(); await c.refreshCsrf();
  const r = await c.call('POST', '/api/v1/auth/login', { email, password }); await c.refreshCsrf();
  return { c, r };
}
const evidence = (name: string, data: Record<string, unknown>) => console.log(JSON.stringify({ evidence: name, ...data }));

// ---------- REVAL-v4 restore helpers ----------
const ownFiles = (gatePath: string) => [gatePath, gatePath + '.journal.jsonl', gatePath + '.journal.jsonl.receipts.json', gatePath + '.journal.jsonl.lock'];
async function removeOwn(gatePath: string) { for (const f of ownFiles(gatePath)) { assert.equal(dirname(f), resolve('.runtime')); await unlink(f).catch(() => undefined); } }
async function holdGate(path: string, seconds: number) {
  // Environmental condition only: a separate reader (antivirus/indexer/backup) holds the gate with FileShare.Read.
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$f=[IO.File]::Open('${path}','Open','Read','Read'); Write-Output HELD; Start-Sleep -Seconds ${seconds}; $f.Close()`], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>((ok, fail) => { const t = setTimeout(() => fail(new Error('holder not ready')), 20000); holder.stdout?.on('data', d => { if (String(d).includes('HELD')) { clearTimeout(t); ok(); } }); });
  return holder;
}
const tmpLeftovers = async (gatePath: string) => (await readdir(dirname(gatePath))).filter(n => n.startsWith((gatePath.split(/[\\/]/).pop() ?? '') + '.') && n.endsWith('.tmp')).length;
const gatePayload = async (gatePath: string) => (JSON.parse(await readFile(gatePath, 'utf8')) as { payload: { open: boolean; flushedSequence: number } }).payload;

test('P05v4-N06 routine flush while another process holds the gate: stays open with legitimate evidence (pending watermark), catches up after release, no temp leftovers, restart OK; a truly residual lock still closes durably', { timeout: 300000 }, async () => {
  const st = await stack({ controlledRestore: true }); const r = st.f.restore; assert.ok(r);
  try {
    const u = await actor(st); await r.flush();
    const holder = await holdGate(r.gatePath, 15);
    await actor(st);
    let flush = 'ok'; try { await r.flush(); } catch { flush = 'failed'; }
    const during = { holderAlive: holder.exitCode === null, flush, open: r.isOpen(), pendingWatermark: r.pendingWatermark, login: (await login(st, u.email)).r.status, newActivation: (await activated(st).then(() => 200, () => 0)) };
    await once(holder, 'exit');
    await r.flush();
    const rows = (await r.fileJournal.readVerified(true)).length, gate = await gatePayload(r.gatePath);
    const after = { open: r.isOpen(), pendingWatermark: r.pendingWatermark, gateFlushed: gate.flushedSequence, fileRows: rows, tmpLeftovers: await tmpLeftovers(r.gatePath), login: (await login(st, u.email)).r.status };
    const restarted = new RestoreController(st.f.database, r.gatePath, r.key); await restarted.initialize(); const restartedOpen = restarted.isOpen();
    await writeFile(r.fileJournal.path + '.lock', '', { flag: 'wx' });
    let residual = 'ok'; try { await r.flush(); } catch { residual = 'failed'; }
    const residualState = { flush: residual, open: r.isOpen(), gateOpen: (await gatePayload(r.gatePath)).open };
    await unlink(r.fileJournal.path + '.lock');
    const afterLockRemoved = new RestoreController(st.f.database, r.gatePath, r.key); await afterLockRemoved.initialize();
    evidence('P05v4-N06', { during, after, restartedOpen, residualState, reopenedAfterLockRemoval: afterLockRemoved.isOpen() });
    assert.equal(during.holderAlive, true); assert.equal(during.flush, 'ok'); assert.equal(during.open, true); assert.equal(during.pendingWatermark, true); assert.equal(during.login, 200); assert.equal(during.newActivation, 200);
    assert.equal(after.open, true); assert.equal(after.pendingWatermark, false); assert.equal(after.gateFlushed, after.fileRows); assert.equal(after.tmpLeftovers, 0); assert.equal(after.login, 200);
    assert.equal(restartedOpen, true); assert.equal(residualState.flush, 'failed'); assert.equal(residualState.open, false); assert.equal(residualState.gateOpen, false); assert.equal(afterLockRemoved.isOpen(), false);
  } finally { await st.close(); await removeOwn(r.gatePath); }
});

test('P05v4-N06b pending watermark + conjoint rollback of BOTH Mongo copies (primary + external) to T0 closes the realm at startup', { timeout: 300000 }, async () => {
  const st = await stack({ controlledRestore: true }); const r = st.f.restore; assert.ok(r);
  try {
    await actor(st); await r.flush();
    const main = st.f.database.db, ext = st.f.database.client.db(`${main.databaseName}_external_security`);
    const dump = async (db: Db) => { const out = new Map<string, Document[]>(); for (const c of await db.listCollections().toArray()) if (!c.name.startsWith('system.')) out.set(c.name, await db.collection(c.name).find({}).toArray()); return out; };
    const load = async (db: Db, data: Map<string, Document[]>) => { for (const c of await db.listCollections().toArray()) if (!c.name.startsWith('system.')) await db.collection(c.name).deleteMany({}); for (const [n, d] of data) if (d.length) await db.collection(n).insertMany(d); };
    const m0 = await dump(main), e0 = await dump(ext), rowsT0 = (await r.fileJournal.readVerified(true)).length;
    const holder = await holdGate(r.gatePath, 15);
    await actor(st); let flush = 'ok'; try { await r.flush(); } catch { flush = 'failed'; }
    const pendingDuring = r.pendingWatermark, holderAlive = holder.exitCode === null, rowsT1 = (await r.fileJournal.readVerified(true)).length;
    await once(holder, 'exit');
    await load(main, m0); await load(ext, e0);
    const restarted = new RestoreController(st.f.database, r.gatePath, r.key); await restarted.initialize();
    evidence('P05v4-N06b', { holderAlive, flushDuringHold: flush, pendingWatermarkDuringHold: pendingDuring, fileRowsT0: rowsT0, fileRowsAfterHold: rowsT1, gateAfterStartup: await gatePayload(r.gatePath), restartedOpenAfterConjointMongoRollback: restarted.isOpen() });
    assert.equal(holderAlive, true); assert.equal(pendingDuring, true); assert.ok(rowsT1 > rowsT0);
    assert.equal(restarted.isOpen(), false); assert.equal((await gatePayload(r.gatePath)).open, false);
  } finally { await st.close(); await removeOwn(r.gatePath); }
});

test('P05v4-I04V4-02 startup (initialize) while another process holds the gate and the watermark is pending: classify behaviour (fail-closed startup vs. unavailable) and recovery after release', { timeout: 300000 }, async () => {
  const st = await stack({ controlledRestore: true }); const r = st.f.restore; assert.ok(r);
  try {
    await actor(st); await r.flush();
    const holder = await holdGate(r.gatePath, 20);
    await actor(st); await r.flush();
    const pending = r.pendingWatermark;
    let init = 'resolved'; let openWhileHeld: boolean | null = null;
    const c1 = new RestoreController(st.f.database, r.gatePath, r.key);
    try { await c1.initialize(); openWhileHeld = c1.isOpen(); } catch (e) { init = `threw ${(e as NodeJS.ErrnoException).code ?? 'error'}`; }
    const holderAlive = holder.exitCode === null, leftovers = await tmpLeftovers(r.gatePath), runningInstanceOpen = r.isOpen();
    await once(holder, 'exit');
    const c2 = new RestoreController(st.f.database, r.gatePath, r.key); await c2.initialize();
    evidence('P05v4-I04V4-02', { pendingWatermarkBeforeStartup: pending, holderAlive, initializeWhileHeld: init, openWhileHeld, tmpLeftovers: leftovers, alreadyRunningInstanceOpen: runningInstanceOpen, openAfterRelease: c2.isOpen(),
      meaning: 'a rejected initialize aborts src/server.ts top-level await: the new process never listens (fail-closed); it never opens with unverified evidence' });
    assert.equal(holderAlive, true); assert.equal(pending, true);
    assert.equal(leftovers, 0); assert.equal(c2.isOpen(), true);
  } finally { await st.close(); await removeOwn(r.gatePath); }
});

// ---------- N03: two separate OS processes of the real server (dist/src/server.js) ----------
interface Reply { status: number; data: Record<string, unknown> }
class Proc {
  readonly cookies = new Map<string, string>(); csrf = '';
  constructor(readonly ca: Buffer, readonly hostPort: number, public port: number, readonly source: string) {}
  call(method: string, path: string, body?: unknown): Promise<Reply> {
    return new Promise((ok, fail) => {
      const req = request({ hostname: '127.0.0.1', port: this.port, localAddress: this.source, path: `/api/v1${path}`, method, ca: this.ca, servername: 'localhost', agent: false,
        headers: { Host: `localhost:${this.hostPort}`, Origin: `https://localhost:${this.hostPort}`, Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '), 'X-CSRF-Token': this.csrf,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) } }, res => {
        const chunks: Buffer[] = []; res.on('data', c => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          try {
            for (const v of res.headers['set-cookie'] ?? []) { const pair = v.split(';')[0] ?? ''; const i = pair.indexOf('='); if (i > 0) this.cookies.set(pair.slice(0, i), pair.slice(i + 1)); }
            const raw = Buffer.concat(chunks).toString('utf8'); ok({ status: res.statusCode ?? 0, data: (raw ? JSON.parse(raw) as { data?: Record<string, unknown> } : {}).data ?? {} });
          } catch (e) { fail(e as Error); }
        });
      });
      req.on('error', fail); if (body !== undefined) req.write(JSON.stringify(body)); req.end();
    });
  }
  async refresh() { const r = await this.call('GET', '/auth/csrf'); if (r.status !== 200) throw new Error(`A01 ${r.status}`); this.csrf = String(r.data['csrfToken']); }
}
async function osPair(label: string, mode: { legacyBytes: number | null; destructive: 'prefix' | 'lock' }) {
  const f = await fixture({ controlledRestore: true }); const r = f.restore; assert.ok(r);
  const runtime = resolve('.runtime'), keyPath = resolve(runtime, `p05v4-${randomUUID()}.keys.json`), keyFile = resolve(runtime, 'tls/key.pem'), certFile = resolve(runtime, 'tls/cert.pem');
  const optional = async (p: string) => { try { return await readFile(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } };
  const previousKey = await optional(keyFile), previousCert = await optional(certFile);
  const children: ChildProcess[] = []; let dispatchErrors = 0, sourceN = 1;
  const src = () => `127.0.0.${(sourceN++ % 200) + 20}`;
  const stopChild = async (child: ChildProcess) => {
    if (child.exitCode !== null) return; const exited = once(child, 'exit');
    if (child.connected) child.send('LOCAL_SYNTHETIC_SHUTDOWN', e => { if (e) child.kill(); }); else child.kill();
    const t = setTimeout(() => child.kill(), 20000); try { await exited; } finally { clearTimeout(t); }
  };
  try {
    const tls = await testCertificate(); await mkdir(resolve(runtime, 'tls'), { recursive: true }); await writeFile(keyFile, tls.key); await writeFile(certFile, tls.cert);
    await writeFile(keyPath, JSON.stringify({ version: 1, mail: f.mailKey.toString('base64url'), totp: f.totpKey.toString('base64url'), journal: r.key.toString('base64url'), cursor: randomBytes(32).toString('base64url') }), { flag: 'wx', mode: 0o600 });
    const [api1, api2, plat1, plat2] = [await freePort(), await freePort(), await freePort(), await freePort()] as [number, number, number, number];
    const origin = `https://localhost:${api1}`;
    const start = async () => {
      const t0 = performance.now();
      for (const [api, plat] of [[api1, plat1], [api2, plat2]] as const) {
        const env: NodeJS.ProcessEnv = { SystemRoot: process.env['SystemRoot'], PATH: process.env['PATH'], CAUDELYX_MODE: 'local-synthetic', MONGODB_URI: f.uri, MONGODB_DATABASE: f.database.db.databaseName,
          PORT: String(api), TENANT_ORIGIN: origin, PLATFORM_ORIGIN: `https://platform.localhost:${plat}`, KEYRING_FILE: keyPath };
        const child = spawn(process.execPath, ['dist/src/server.js'], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); children.push(child);
        child.stderr?.on('data', b => { if (String(b).includes('SYNTHETIC_DISPATCH_RETRY_PENDING')) dispatchErrors++; });
        const probe = new Proc(tls.cert, api1, api, '127.0.0.1'); let online = false;
        for (let n = 0; n < 300 && !online; n++) { if (child.exitCode !== null) throw new Error('own server process exited before readiness'); try { await probe.refresh(); online = true; } catch { await new Promise(d => setTimeout(d, 100)); } }
        assert.equal(online, true);
      }
      return Math.round(performance.now() - t0);
    };
    const stopAll = async () => { for (const c of children.splice(0)) await stopChild(c); };
    const mail = async (email: string, purpose: string) => {
      for (let n = 0; n < 300; n++) {
        const subject = await f.database.db.collection<{ _id: string }>('identities').findOne({ email, realm: 'TENANT' });
        const row = subject ? await f.database.db.collection('synthetic_mail').find({ subjectId: subject._id, purpose }).sort({ expiresAt: -1 }).limit(1).next() : null;
        if (row) return unseal(String(row['encryptedToken']), f.mailKey);
        await new Promise(d => setTimeout(d, 100));
      }
      return null;
    };
    const verify = async (c: Proc, key: SoftPasskey, purpose: string, port: number) => {
      const back = c.port; c.port = port;
      const o = await c.call('POST', '/auth/mfa/webauthn/authentication/options', { purpose });
      const v = o.status === 200 ? await c.call('POST', '/auth/mfa/challenges/verify', { purpose, method: 'WEBAUTHN', ceremonyId: String(o.data['ceremonyId']), credential: key.assertion(String((o.data['publicKey'] as Record<string, unknown>)['challenge'])) }) : o;
      if (v.status === 200) await c.refresh(); c.port = back; return v.status;
    };
    const enroll = async (regPort: number, actPort: number) => {
      const email = `${randomUUID()}@example.test`, c = new Proc(tls.cert, api1, regPort, src()); await c.refresh();
      const a02 = await c.call('POST', '/auth/register', { email, displayName: 'P05v4 N03', privacyPolicyVersion: 'synthetic-v1', acceptTerms: true });
      if (a02.status !== 202) return { step: `A02 ${a02.status}`, email, c, key: null };
      const token = await mail(email, 'ACTIVATION'); if (!token) return { step: 'NO_MAIL', email, c, key: null };
      c.port = actPort; const a04 = await c.call('POST', '/auth/email-verifications/confirm', { purpose: 'ACTIVATION', token, newPassword: PASSWORD });
      if (a04.status !== 200) return { step: `A04 ${a04.status}`, email, c, key: null };
      await c.refresh(); c.port = regPort;
      const key = new SoftPasskey(origin), o = await c.call('POST', '/auth/mfa/webauthn/registration/options', { label: 'N03' });
      const a25 = o.status === 200 ? await c.call('POST', '/auth/mfa/webauthn/registration/verify', { ceremonyId: String(o.data['ceremonyId']), credential: key.registration(String((o.data['publicKey'] as Record<string, unknown>)['challenge'])) }) : o;
      if (a25.status !== 201) return { step: `A25 ${a25.status}`, email, c, key: null };
      await c.refresh(); return { step: 'OK', email, c, key };
    };
    const strong = async (email: string, key: SoftPasskey, loginPort: number, mfaPort: number) => {
      const c = new Proc(tls.cert, api1, loginPort, src()); await c.refresh();
      const l = await c.call('POST', '/auth/login', { email, password: PASSWORD }); if (l.status !== 200) return { status: `A05 ${l.status}`, c };
      await c.refresh(); const v = await verify(c, key, 'LOGIN', mfaPort); return { status: v === 200 ? 'OK' : `A27 ${v}`, c };
    };
    await start();
    const warm: string[] = []; const bytes = async () => (await stat(r.fileJournal.path)).size;
    for (let i = 0; i < 10 || (!mode.legacyBytes && await bytes() <= 64 * 1024 && i < 60); i++) warm.push((await enroll(i % 2 ? api2 : api1, i % 2 ? api1 : api2)).step);
    let legacy = { rows: 0, restartReadyMs: 0 };
    if (mode.legacyBytes) {
      await stopAll();
      const state = JSON.parse(JSON.stringify(await f.database.transaction(s => captureSecurityState(f.database, s)))) as { identities: { _id: string }[] };
      let sequence = (await f.database.db.collection<{ _id: string; value: number }>('security_sequence').findOne({ _id: 'security' }))?.value ?? 0;
      const one = Buffer.byteLength(JSON.stringify({ _id: sequence + 1, eventId: randomUUID(), previous: 'f'.repeat(64), state, signature: 'f'.repeat(64) }) + '\n');
      const rows = Array.from({ length: Math.ceil((mode.legacyBytes - await bytes()) / one) + 1 }, () => ({ _id: ++sequence, eventId: randomUUID(), state }));
      const subject = state.identities[0]?._id ?? 'synthetic';
      await f.database.client.withSession(s => s.withTransaction(async () => {
        await f.database.db.collection('security_evidence_outbox').insertMany(rows as unknown as Document[], { session: s });
        await f.database.db.collection('audit_events').insertMany(rows.map(x => ({ eventId: x.eventId, sequence: x._id, realm: 'TENANT', action: 'P05V4_SYNTHETIC_LEGACY_CHECKPOINT', subjectId: subject, actorId: subject, outcome: 'SUCCESS', createdAt: new Date() })), { session: s });
        await f.database.db.collection<{ _id: string; value: number }>('security_sequence').updateOne({ _id: 'security' }, { $set: { value: sequence } }, { session: s });
      }));
      await r.flush(); legacy = { rows: rows.length, restartReadyMs: await start() };
    }
    const journalBytesBefore = await bytes();
    const probeUser = await enroll(api2, api1); assert.equal(probeUser.step, 'OK'); assert.ok(probeUser.key);
    const ps = await strong(probeUser.email, probeUser.key, api2, api1); assert.equal(ps.status, 'OK');
    const pa = new Proc(tls.cert, api1, api1, '127.0.0.1'), pb = new Proc(tls.cert, api1, api2, '127.0.0.1');
    for (const p of [pa, pb]) for (const [k, v] of ps.c.cookies) p.cookies.set(k, v);
    let phase = 'workload', stop = false; const probes: { phase: string; port: number; status: number }[] = [];
    const prober = (async () => { let n = 0; while (!stop) { const p = n++ % 2 ? pb : pa; probes.push({ phase, port: p.port, status: (await p.call('GET', '/auth/me')).status }); await new Promise(d => setTimeout(d, 50)); } })();
    const rounds: Record<string, unknown>[] = [];
    for (let n = 0; n < 6; n++) {
      const [x, y] = n % 2 ? [api2, api1] : [api1, api2];
      const u = await enroll(x, y); const row: Record<string, unknown> = { enroll: u.step };
      if (u.key) {
        const s1 = await strong(u.email, u.key, y, x), s2 = await strong(u.email, u.key, x, y); row['strongS1'] = s1.status; row['strongS2'] = s2.status;
        s1.c.port = x; const ra = await s1.c.call('POST', '/auth/reauthenticate', { password: PASSWORD, purpose: 'SESSION_REVOKE_ALL' });
        const rv = ra.status === 200 ? await verify(s1.c, u.key, 'SESSION_REVOKE_ALL', y) : ra.status; row['reauth'] = `${ra.status}/${rv}`;
        row['revokeAllOnX'] = (await s1.c.call('POST', '/auth/sessions/revoke-all', {})).status;
        s2.c.port = y; row['otherSessionOnY'] = (await s2.c.call('GET', '/auth/me')).status; s2.c.port = x; row['otherSessionOnX'] = (await s2.c.call('GET', '/auth/me')).status;
        const s3 = await strong(u.email, u.key, y, x), s4 = await strong(u.email, u.key, x, y); row['strongS3S4'] = `${s3.status}/${s4.status}`;
        s3.c.port = x; const a32 = await s3.c.call('POST', '/auth/reauthenticate', { password: PASSWORD, purpose: 'MFA_ENROLL', command: { methodType: 'TOTP', label: 'N03' } });
        const r27 = a32.status === 200 ? await verify(s3.c, u.key, 'MFA_ENROLL', y) : a32.status;
        s3.c.port = y; const a22 = await s3.c.call('POST', '/auth/mfa/totp/enrollments', { label: 'N03' });
        const secret = a22.status === 201 ? new URL(String(a22.data['provisioningUri'])).searchParams.get('secret') : null;
        s3.c.port = x; row['totp'] = secret ? (await s3.c.call('POST', `/auth/mfa/totp/enrollments/${String(a22.data['enrollmentId'])}/confirm`, { code: await generate({ secret, epoch: Math.floor(Date.now() / 1000) }) })).status : `A32 ${a32.status} A27 ${r27} A22 ${a22.status}`;
        s4.c.port = y; row['peerSessionAfterFactorAddOnY'] = (await s4.c.call('GET', '/auth/me')).status;
      }
      rounds.push(row);
    }
    const errorsBeforeReceipts = dispatchErrors;
    phase = 'receipts-deleted'; await unlink(r.fileJournal.path + '.receipts.json').catch(() => undefined);
    const afterDelete = (await enroll(api1, api2)).step; await new Promise(d => setTimeout(d, 1500));
    phase = 'receipts-forged'; let forged = false;
    try { const raw = await readFile(r.fileJournal.path + '.receipts.json', 'utf8'); const i = raw.lastIndexOf('"signature":"') + 13; await writeFile(r.fileJournal.path + '.receipts.json', raw.slice(0, i) + (raw[i] === 'a' ? 'b' : 'a') + raw.slice(i + 1)); forged = true; } catch { forged = false; }
    const afterForge = (await enroll(api2, api1)).step; await new Promise(d => setTimeout(d, 1500));
    stop = true; await prober;
    const errorsBeforeDestructive = dispatchErrors, rowsBeforeDestructive = (await r.fileJournal.readVerified(true)).length;
    // Destructive end: evidence integrity must win over availability on BOTH processes.
    if (mode.destructive === 'prefix') {
      const raw = await readFile(r.fileJournal.path), at = raw.indexOf('"signature":"', Math.floor(raw.length / 3)) + 13;
      const fh = await openFile(r.fileJournal.path, 'r+'); try { await fh.write(Buffer.from(raw[at] === 0x61 ? 'b' : 'a'), 0, 1, at); } finally { await fh.close(); }
    } else await writeFile(r.fileJournal.path + '.lock', '', { flag: 'wx' });
    await enroll(api1, api2).catch(() => undefined);
    const closed: Record<string, number> = {}; const t0 = Date.now();
    while (Date.now() - t0 < 30000) { closed['p1'] = (await pa.call('GET', '/auth/me')).status; closed['p2'] = (await pb.call('GET', '/auth/me')).status; if (closed['p1'] === 503 && closed['p2'] === 503) break; await new Promise(d => setTimeout(d, 500)); }
    const closedAfterMs = Date.now() - t0;
    if (mode.destructive === 'lock') { await unlink(r.fileJournal.path + '.lock'); await new Promise(d => setTimeout(d, 3000)); closed['p1AfterLockRemoved'] = (await pa.call('GET', '/auth/me')).status; closed['p2AfterLockRemoved'] = (await pb.call('GET', '/auth/me')).status; }
    const gateOpenImmediate = (await gatePayload(r.gatePath)).open; await new Promise(d => setTimeout(d, 3000)); const gateOpen = (await gatePayload(r.gatePath)).open;
    const by = (p: string) => probes.filter(x => x.phase === p);
    const summary = { nodePids: children.map(c => c.pid !== undefined), distinctProcesses: new Set(children.map(c => c.pid)).size, journalBytesBefore, legacyRows: legacy.rows, restartWithLegacyReadyMs: legacy.restartReadyMs, warmEnrollments: warm,
      rounds, afterReceiptsDeleted: afterDelete, receiptForged: forged, afterReceiptForged: afterForge, probes: Object.fromEntries(['workload', 'receipts-deleted', 'receipts-forged'].map(p => [p, { total: by(p).length, non200: by(p).filter(x => x.status !== 200).length, statuses: [...new Set(by(p).map(x => x.status))] }])),
      dispatchErrors: { beforeReceipts: errorsBeforeReceipts, beforeDestructive: errorsBeforeDestructive }, journalRowsBeforeDestructive: rowsBeforeDestructive, journalBytesFinal: await bytes(), destructive: mode.destructive, closedStatuses: closed, closedAfterMs, gateOpenWhen503Observed: gateOpenImmediate, gateOpenAfterDestructive3s: gateOpen };
    evidence(label, summary);
    assert.equal(summary.distinctProcesses, 2);
    assert.ok(warm.every(x => x === 'OK'), 'warm enrollments');
    for (const row of rounds) { assert.equal(row['enroll'], 'OK'); assert.equal(row['strongS1'], 'OK'); assert.equal(row['strongS2'], 'OK'); assert.equal(row['totp'], 200); assert.equal(row['reauth'], '200/200'); assert.equal(row['revokeAllOnX'], 204); assert.equal(row['strongS3S4'], 'OK/OK'); assert.equal(row['peerSessionAfterFactorAddOnY'], 401); assert.equal(row['otherSessionOnY'], 401); assert.equal(row['otherSessionOnX'], 401); }
    assert.equal(afterDelete, 'OK'); assert.equal(afterForge, 'OK');
    for (const p of ['workload', 'receipts-deleted', 'receipts-forged']) assert.equal(by(p).filter(x => x.status !== 200).length, 0, `probes ${p}`);
    assert.equal(errorsBeforeDestructive, 0);
    assert.equal(closed['p1'], 503); assert.equal(closed['p2'], 503); assert.equal(gateOpen, false);
    if (mode.destructive === 'lock') { assert.equal(closed['p1AfterLockRemoved'], 503); assert.equal(closed['p2AfterLockRemoved'], 503); }
    if (mode.legacyBytes) assert.ok(journalBytesBefore > mode.legacyBytes); else assert.ok(journalBytesBefore > 64 * 1024);
  } finally {
    for (const c of children.splice(0)) await stopChild(c);
    await f.close();
    for (const [file, previous] of [[keyFile, previousKey], [certFile, previousCert]] as const) { if (previous) await writeFile(file, previous); else await unlink(file).catch(() => undefined); }
    await unlink(keyPath).catch(() => undefined); await removeOwn(r.gatePath);
  }
}
test('P05v4-N03-A two OS processes of dist/src/server.js on a signed legacy journal >10MB (restart with legacy), both dispatchers active, cross enrolment/login/MFA/TOTP/revoke-all, receipts deleted/forged; in-place prefix tamper closes both', { timeout: 1200000 }, async () => { await osPair('P05v4-N03-A', { legacyBytes: 10.5 * 1024 * 1024, destructive: 'prefix' }); });
test('P05v4-N03-B two OS processes on a delta-only journal grown past 64KiB by real traffic; same cross workload; an orphan lock closes both durably', { timeout: 1200000 }, async () => { await osPair('P05v4-N03-B', { legacyBytes: null, destructive: 'lock' }); });
