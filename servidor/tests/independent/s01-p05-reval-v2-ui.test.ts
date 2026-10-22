// S01-P05-REVAL-v2 independent UI tests (Claude) on P04-v2: real Chromium against the running local stack
// (Vite https://localhost:3001 -> API 127.0.0.1:4001, dev:local replica set). Setup traffic goes straight to the
// real API from distinct loopback source addresses (no quota changed). Tokens are read in memory from the
// synthetic encrypted channel (Mongo + ignored keyring), never printed or saved. Screenshots: clean public screen only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:https';
import { readFile } from 'node:fs/promises';
import { createHash, generateKeyPairSync, randomUUID, randomBytes, sign } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { chromium } from '@playwright/test';
import { generate } from 'otplib';
import { unseal } from '../../src/shared/crypto.js';

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
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();
class SoftPasskey {
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  readonly id = randomBytes(32);
  counter = 0;
  constructor(readonly origin: string, readonly rpId = 'localhost') {}
  private client(type: string, challenge: string) { return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false })); }
  registration(challenge: string) {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    const cose = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(String(jwk.x), 'base64url')], [-3, Buffer.from(String(jwk.y), 'base64url')]]));
    const len = Buffer.alloc(2); len.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([sha(this.rpId), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, this.id, cose]);
    return { id: this.id.toString('base64url'), rawId: this.id.toString('base64url'), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: this.client('webauthn.create', challenge).toString('base64url'),
        attestationObject: cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]])).toString('base64url') } };
  }
  assertion(challenge: string) {
    const count = Buffer.alloc(4); count.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([sha(this.rpId), Buffer.from([0x05]), count]), clientData = this.client('webauthn.get', challenge);
    return { id: this.id.toString('base64url'), rawId: this.id.toString('base64url'), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: clientData.toString('base64url'), authenticatorData: authData.toString('base64url'),
        signature: sign('sha256', Buffer.concat([authData, sha(clientData)]), this.keys.privateKey).toString('base64url') } };
  }
}
const UI = 'https://localhost:3001', PASSWORD = 'independent P05 REVAL v2 synthetic passphrase 86420';
const CHROMIUM = 'C:/Users/Asus ExpertBook/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
interface Reply { status: number; data: Record<string, unknown>; headers: import('node:http').IncomingHttpHeaders }
class DevClient {
  readonly cookies = new Map<string, string>(); csrf = '';
  constructor(readonly ca: Buffer, readonly source: string) {}
  call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: 4001, localAddress: this.source, path: `/api/v1${path}`, method, ca: this.ca, servername: 'localhost', agent: false,
        headers: { Host: 'localhost:3001', Origin: UI, Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '), 'X-CSRF-Token': this.csrf,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra } }, res => {
        const chunks: Buffer[] = []; res.on('data', c => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          for (const v of res.headers['set-cookie'] ?? []) { const pair = v.split(';')[0] ?? ''; const i = pair.indexOf('='); if (i > 0) this.cookies.set(pair.slice(0, i), pair.slice(i + 1)); }
          const raw = Buffer.concat(chunks).toString('utf8'); const parsed = raw ? JSON.parse(raw) as { data?: Record<string, unknown> } : {};
          resolve({ status: res.statusCode ?? 0, data: parsed.data ?? {}, headers: res.headers });
        });
      });
      req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end();
    });
  }
  async refresh() { const r = await this.call('GET', '/auth/csrf'); assert.equal(r.status, 200); this.csrf = String(r.data['csrfToken']); }
}
const s = (v: unknown): string => { assert.equal(typeof v, 'string'); return v as string; };
async function channel() {
  const link = JSON.parse(await readFile('.runtime/local-connection.json', 'utf8')) as { mongoUri: string; databaseName: string };
  const keys = JSON.parse(await readFile('.runtime/synthetic-keys.json', 'utf8')) as { mail: string };
  const client = new MongoClient(link.mongoUri); await client.connect();
  const db = client.db(link.databaseName), key = Buffer.from(keys.mail, 'base64url');
  const mail = async (email: string, purpose: string): Promise<string> => {
    for (let n = 0; n < 50; n++) {
      const subject = await db.collection<{ _id: string }>('identities').findOne({ email, realm: 'TENANT' });
      const row = subject ? await db.collection('synthetic_mail').find({ subjectId: subject._id, purpose }).sort({ expiresAt: -1 }).limit(1).next() : null;
      if (row) return unseal(String(row['encryptedToken']), key);
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('synthetic mail not found');
  };
  const invitation = async (email: string): Promise<string> => {
    for (let n = 0; n < 50; n++) {
      for (const row of await db.collection('synthetic_notifications').find({ kind: 'INVITATION' }).toArray()) {
        const payload = JSON.parse(unseal(String(row['encryptedPayload']), key)) as Record<string, string>;
        if (payload['email'] === email && payload['token']) return payload['token'];
      }
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('synthetic invitation not found');
  };
  return { db, mail, invitation, close: () => client.close() };
}
type Channel = Awaited<ReturnType<typeof channel>>;
interface Person { c: DevClient; key: SoftPasskey; email: string; userId: string }
async function passkey(p: Person, purpose: string, resourceId?: string) {
  const target = { purpose, ...(resourceId ? { resourceId } : {}) };
  const o = await p.c.call('POST', '/auth/mfa/webauthn/authentication/options', target); assert.equal(o.status, 200, `A26 ${purpose}`);
  const r = await p.c.call('POST', '/auth/mfa/challenges/verify', { ...target, method: 'WEBAUTHN', ceremonyId: s(o.data['ceremonyId']), credential: p.key.assertion(s((o.data['publicKey'] as Record<string, unknown>)['challenge'])) });
  assert.equal(r.status, 200, `A27 ${purpose}`); await p.c.refresh();
}
async function stepUp(p: Person, purpose: string, resourceId?: string, command?: Record<string, unknown>) {
  const r = await p.c.call('POST', '/auth/reauthenticate', { password: PASSWORD, purpose, ...(resourceId ? { resourceId } : {}), ...(command ? { command } : {}) });
  assert.equal(r.status, 200, `A32 ${purpose}`); await passkey(p, purpose, resourceId);
}

const a25Failures: string[] = [];
async function activateRecorded(ch: Channel, c: DevClient, email: string): Promise<Person | null> {
  const token = await ch.mail(email, 'ACTIVATION');
  assert.equal((await c.call('POST', '/auth/email-verifications/confirm', { purpose: 'ACTIVATION', token, newPassword: PASSWORD })).status, 200, 'A04'); await c.refresh();
  const key = new SoftPasskey(UI), o = await c.call('POST', '/auth/mfa/webauthn/registration/options', { label: 'Passkey REVAL v2' }); assert.equal(o.status, 200);
  const r = await c.call('POST', '/auth/mfa/webauthn/registration/verify', { ceremonyId: s(o.data['ceremonyId']), credential: key.registration(s((o.data['publicKey'] as Record<string, unknown>)['challenge'])) });
  if (r.status !== 201) { a25Failures.push(`${email.slice(0, 18)}…: ${r.status}`); return null; }
  await c.refresh(); const me = await c.call('GET', '/auth/me'); return { c, key, email, userId: s(me.data['userId']) };
}
async function addTotp(target: Person): Promise<string> {
  await stepUp(target, 'MFA_ENROLL', undefined, { methodType: 'TOTP', label: 'UI REVAL' });
  const e = await target.c.call('POST', '/auth/mfa/totp/enrollments', { label: 'UI REVAL' }); assert.equal(e.status, 201);
  const secret = new URL(s(e.data['provisioningUri'])).searchParams.get('secret'); assert.ok(secret);
  assert.equal((await target.c.call('POST', `/auth/mfa/totp/enrollments/${s(e.data['enrollmentId'])}/confirm`, { code: await generate({ secret, epoch: Math.floor(Date.now() / 1000) }) })).status, 200);
  return secret;
}
async function uiLogin(browser: import('@playwright/test').Browser, email: string, secret: string, width = 1280) {
  await new Promise(r => setTimeout(r, 31000 - (Date.now() % 30000)));
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 900 }, locale: 'es-CO' }); // synthetic self-signed CA only
  const page = await context.newPage(); await page.goto(`${UI}/#/ingresar`);
  await page.getByLabel('Correo').fill(email); await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByLabel('Código TOTP vigente').fill(await generate({ secret, epoch: Math.floor(Date.now() / 1000) }));
  await page.getByRole('button', { name: 'Verificar factor' }).click();
  await page.waitForURL(/#\/organizacion/); await page.getByRole('heading', { name: 'Personas' }).waitFor();
  return { context, page };
}

test('P05v2-UI-01 public screen at 360/390/768/1024/1440 (REVAL-v2 screenshots only): no overflow, Spanish, no storage', { timeout: 120000 }, async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
  try {
    const observed = new Map<string, unknown>();
    for (const width of [360, 390, 768, 1024, 1440]) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 900 }, locale: 'es-CO' }); // synthetic self-signed CA only
      const page = await context.newPage(); await page.goto(`${UI}/#/ingresar`); await page.getByRole('heading', { name: 'Ingresar' }).waitFor();
      await page.waitForLoadState('networkidle'); await page.getByText('Cargando sesión').waitFor({ state: 'detached' });
      const m = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - window.innerWidth, lang: document.documentElement.lang, storage: localStorage.length + sessionStorage.length }));
      observed.set(`w${width}`, m); assert.ok(m.overflow <= 0); assert.equal(m.lang, 'es'); assert.equal(m.storage, 0);
      await page.screenshot({ path: `../../Construccion/Sprints/S01/Evidencias/S01-P05-REVAL-v2-UI-${width}.png`, fullPage: true });
      await context.close();
    }
    console.log(JSON.stringify({ evidence: 'P05v2-UI-01', observed: Object.fromEntries(observed) }));
  } finally { await browser.close(); }
});

test('P05v2-UI-02 H-01 independent: manager outside page 1, >20 members and >20 invitations, both cursors by mouse/keyboard, 390px, non-manager 403 keeps session', { timeout: 900000 }, async () => {
  const ca = await readFile('.runtime/tls/cert.pem'), ch = await channel();
  const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
  try {
    const observed = new Map<string, unknown>(), defects: string[] = [];
    const sources = ['127.0.0.5', '127.0.0.6', '127.0.0.7', '127.0.0.8'];
    const tEmail = `p05v2_t_${randomUUID()}@example.test`, tc = new DevClient(ca, s(sources.at(0))); await tc.refresh();
    assert.equal((await tc.call('POST', '/auth/register', { email: tEmail, displayName: 'Titular REVAL', privacyPolicyVersion: 'synthetic-v1', acceptTerms: true })).status, 202);
    const t = await activateRecorded(ch, tc, tEmail); assert.ok(t, `titular A25: ${a25Failures.join(' | ')}`);
    const cmd = { name: 'Org REVAL v2', timezone: 'America/Bogota', currency: 'COP' };
    await stepUp(t, 'ORGANIZATION_CREATE', undefined, cmd);
    const org = await t.c.call('POST', '/organizations', cmd, { 'Idempotency-Key': randomUUID() }); assert.equal(org.status, 201); await t.c.refresh();
    const orgId = s((org.data['organization'] as Record<string, unknown>)['id']);
    const people: Person[] = [t];
    for (let n = 0; n < 21; n++) {
      const email = `p05v2_m${n}_${randomUUID()}@example.test`;
      await stepUp(t, 'MEMBER_INVITE', orgId, { email, roleIds: [n === 0 ? 'O' : 'L'] });
      assert.equal((await t.c.call('POST', '/organization/invitations', { email, roleIds: [n === 0 ? 'O' : 'L'] })).status, 202);
      const token = await ch.invitation(email), c = new DevClient(ca, s(sources.at(1 + (n % 3)))); await c.refresh();
      assert.equal((await c.call('POST', '/auth/invitations/accept', { mode: 'PREPARE', token, displayName: `Persona ${n}`, privacyPolicyVersion: 'synthetic-v1', acceptTerms: true })).status, 202);
      const p = await activateRecorded(ch, c, email); if (!p) continue;
      assert.equal((await c.call('POST', '/auth/invitations/accept', { mode: 'CONFIRM', token })).status, 200); await c.refresh(); people.push(p);
    }
    observed.set('A25 setup failures (IG-01 signal)', [...a25Failures]);
    for (let n = 0; n < 22; n++) {
      const email = `p05v2_inv${n}_${randomUUID()}@example.test`;
      await stepUp(t, 'MEMBER_INVITE', orgId, { email, roleIds: ['C'] });
      assert.equal((await t.c.call('POST', '/organization/invitations', { email, roleIds: ['C'] })).status, 202);
    }
    const all = await t.c.call('GET', '/organization/members?limit=50'), items = all.data['items'] as { userId: string; version: string; displayName: string }[];
    observed.set('members', items.length); assert.ok(items.length >= 21, `need >=21 members; A25 failures: ${a25Failures.join(' | ')}`);
    const sorted = items.map(i => i.userId).sort(), targetId = s(sorted.at(20)), target = people.find(p => p.userId === targetId); assert.ok(target);
    if (target !== t) {
      const v = items.find(i => i.userId === targetId)?.version; assert.ok(v);
      await stepUp(t, 'MEMBER_ROLE_CHANGE', targetId, { roleIds: ['A'] });
      assert.equal((await t.c.call('PATCH', `/organization/members/${targetId}/roles`, { roleIds: ['A'] }, { 'If-Match': v })).status, 200);
      const l = new DevClient(ca, s(sources.at(1))); await l.refresh();
      assert.equal((await l.call('POST', '/auth/login', { email: target.email, password: PASSWORD })).status, 200); await l.refresh();
      target.c.cookies.clear(); for (const [k, v2] of l.cookies) target.c.cookies.set(k, v2); target.c.csrf = l.csrf; await passkey(target, 'LOGIN');
    }
    const a09 = await target.c.call('GET', '/organization'); observed.set('A09 actorRoleIds of target', a09.data['actorRoleIds']);
    const secret = await addTotp(target);
    // Desktop: management visible, both cursors work, no duplicates, keyboard activation.
    let { context, page } = await uiLogin(browser, target.email, secret);
    const personas = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Personas' }) });
    const names = () => personas.locator('.cards').nth(0).locator(':scope > article.card h3').allTextContents();
    await page.getByRole('heading', { name: 'Invitar' }).waitFor({ timeout: 15000 }).catch(() => defects.push('Invitar hidden for manager outside page 1'));
    const first = await names();
    const moreMembers = page.getByRole('button', { name: 'Cargar más personas' });
    await moreMembers.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(n => [...document.querySelectorAll('section.card .cards')][0]?.querySelectorAll(':scope > article.card').length !== n, first.length, { timeout: 20000 }).catch(() => defects.push('page 2 of members not loaded by keyboard'));
    const afterMembers = await names();
    const moreInv = page.getByRole('button', { name: 'Cargar más invitaciones' });
    const invBefore = await page.getByRole('button', { name: 'Revocar invitación' }).count();
    if (await moreInv.count()) { await moreInv.click(); await page.waitForFunction(n => [...document.querySelectorAll('button')].filter(b => b.textContent === 'Revocar invitación').length > n, invBefore, { timeout: 20000 }).catch(() => defects.push('page 2 of invitations not loaded')); }
    else defects.push('no "Cargar más invitaciones" with >20 invitations');
    const invAfter = await page.getByRole('button', { name: 'Revocar invitación' }).count();
    const desk = { firstPage: first.length, afterMore: afterMembers.length, unique: new Set(afterMembers).size, membersButtonGone: (await moreMembers.count()) === 0, invBefore, invAfter,
      suspendButtons: await page.getByRole('button', { name: 'Suspender' }).count(), storage: await page.evaluate(() => localStorage.length + sessionStorage.length) };
    observed.set('desktop', desk);
    if (desk.afterMore !== items.length || desk.unique !== desk.afterMore) defects.push(`members after page 2: ${desk.afterMore}/${items.length}, unique ${desk.unique}`);
    if (desk.suspendButtons === 0) defects.push('member actions hidden');
    await context.close();
    // Mobile 390px: same manager, no horizontal overflow on the organization page.
    ({ context, page } = await uiLogin(browser, target.email, secret, 390));
    await page.getByRole('heading', { name: 'Invitar' }).waitFor({ timeout: 15000 }).catch(() => defects.push('Invitar hidden at 390px'));
    await page.waitForFunction(() => ([...document.querySelectorAll('section.card .cards')][0]?.querySelectorAll(':scope > article.card').length ?? 0) >= 20, undefined, { timeout: 20000 }).catch(() => defects.push('members list not loaded at 390px'));
    const mobile = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - window.innerWidth, pager: [...document.querySelectorAll('button')].some(b => b.textContent === 'Cargar más personas') }));
    observed.set('mobile390', mobile); if (mobile.overflow > 0) defects.push('horizontal overflow at 390px on organization page'); if (!mobile.pager) defects.push('no members pager at 390px');
    await context.close();
    // Non-manager O: management denied (403 message), session kept.
    const o = people.find(p => p !== t && p !== target && p.userId !== targetId && items.some(i => i.userId === p.userId));
    if (o) {
      const roles = (await o.c.call('GET', '/organization')).data['actorRoleIds'] as string[];
      if (!roles.includes('T') && !roles.includes('A')) {
        const oSecret = await addTotp(o); ({ context, page } = await uiLogin(browser, o.email, oSecret));
        const denied = await page.getByText('La gestión respondió sin permiso. La sesión sigue abierta.').waitFor({ timeout: 15000 }).then(() => true, () => false);
        const invite = await page.getByRole('heading', { name: 'Invitar' }).count();
        const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me', { credentials: 'include' })).status);
        observed.set('non-manager', { roles, denied, inviteForm: invite, meAfter: me }); if (!denied || invite !== 0 || me !== 200) defects.push('non-manager 403 handling');
        await context.close();
      }
    }
    console.log(JSON.stringify({ evidence: 'P05v2-UI-02', observed: Object.fromEntries(observed), defects }));
    assert.deepEqual(defects, []);
  } finally { await browser.close(); await ch.close(); }
});
