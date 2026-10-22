// S01-P05-REVAL-v3 independent UI/UX tests (Claude) on P04-v3-INTEGRADO: real Chromium against the running local stack
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
const UI = 'https://localhost:3001', PASSWORD = 'independent P05 REVAL v3 synthetic passphrase 75319';
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

type Page = import('@playwright/test').Page;
type Browser = import('@playwright/test').Browser;
const newContext = (browser: Browser, width = 1280) => browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 900 }, locale: 'es-CO' }); // synthetic self-signed CA only
async function pageFacts(page: Page) {
  return await page.evaluate(() => ({
    url: location.href, storage: localStorage.length + sessionStorage.length, overflow: document.documentElement.scrollWidth - window.innerWidth,
    focused: document.activeElement?.tagName ?? '', h1: document.querySelector('h1')?.textContent ?? '',
    currentStep: document.querySelector('ol.steps li[aria-current="step"]')?.textContent ?? null,
    submits: [...document.querySelectorAll('main button[type="submit"]')].filter(b => (b as HTMLElement).offsetParent !== null).map(b => b.textContent),
    purposeSelector: document.body.innerText.includes('Propósito del código'),
    // A control that lets the user skip/postpone MFA (the copy "No se puede omitir" is not a control).
    skipOption: [...document.querySelectorAll('main button, main a')].some(e => /omitir|saltar este paso|más tarde|ahora no/i.test(e.textContent ?? '')),
  }));
}
async function registerViaUi(page: Page, email: string) {
  await page.goto(`${UI}/#/registro`); await page.getByRole('heading', { name: 'Crea tu cuenta' }).waitFor();
  const step1 = await pageFacts(page);
  await page.getByLabel('Correo').fill(email); await page.getByLabel('Nombre visible').fill('Persona onboarding');
  await page.getByLabel('Acepto la política sintética local.').check();
  await page.getByRole('button', { name: 'Enviar registro' }).click();
  await page.getByRole('link', { name: 'Confirmar correo y crear contraseña' }).waitFor({ timeout: 20000 });
  return step1;
}

test('P05v3-UX-01 real onboarding Crear cuenta -> Confirmar -> Proteger (TOTP) -> Continuar: one primary action per step, focus, no purpose selector, nothing persisted in URL/storage', { timeout: 300000 }, async () => {
  const ch = await channel(), browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
  try {
    const observed = new Map<string, unknown>(), defects: string[] = [];
    const context = await newContext(browser), page = await context.newPage();
    const urls: string[] = []; page.on('request', r => urls.push(r.url()));
    const email = `p05v3_ux1_${randomUUID()}@example.test`;
    observed.set('step1', await registerViaUi(page, email));
    await page.getByRole('link', { name: 'Confirmar correo y crear contraseña' }).click();
    await page.getByLabel('Código de activación').waitFor();
    observed.set('step2', await pageFacts(page));
    const token = await ch.mail(email, 'ACTIVATION');
    await page.getByLabel('Código de activación').fill(token); await page.getByLabel('Contraseña nueva').fill(PASSWORD);
    await page.getByRole('button', { name: 'Activar' }).click();
    await page.getByRole('heading', { name: 'Proteger cuenta' }).waitFor({ timeout: 20000 });
    observed.set('step3', await pageFacts(page));
    await page.getByLabel('Etiqueta').fill('Mi app');
    await page.getByRole('button', { name: 'Preparar factor' }).click();
    const output = page.locator('.secret output'); await output.waitFor();
    const shown = await page.locator('.secret').innerText();
    const uri = await output.innerText(); const secret = new URL(uri).searchParams.get('secret'); assert.ok(secret);
    observed.set('TOTP material shown', { onlyUri: !shown.replace(uri, '').includes(secret), uriScheme: uri.slice(0, 10), base32KeyShownSeparately: shown.replace(uri, '').includes(secret), hasQr: (await page.locator('canvas, img[alt*="QR" i], svg[aria-label*="QR" i]').count()) > 0 });
    await page.getByLabel('Código TOTP actual').fill(await generate({ secret, epoch: Math.floor(Date.now() / 1000) }));
    await page.getByRole('button', { name: 'Confirmar TOTP' }).click();
    await page.getByRole('link', { name: 'Continuar a la organización' }).waitFor({ timeout: 20000 });
    observed.set('step4', await pageFacts(page));
    const uriGone = !(await page.locator('.secret output').count()) || !(await page.locator('.secret').innerText()).includes('otpauth');
    await page.getByRole('link', { name: 'Continuar a la organización' }).click();
    await page.getByRole('heading', { name: 'Crear la organización' }).waitFor({ timeout: 20000 });
    const leak = urls.some(u => u.includes(token) || u.includes(secret)) || (await pageFacts(page)).url.includes(token);
    observed.set('final', { ...(await pageFacts(page)), urlOrRequestLeak: leak, uriClearedAfterConfirm: uriGone });
    const s1 = observed.get('step1') as Awaited<ReturnType<typeof pageFacts>>, s2 = observed.get('step2') as Awaited<ReturnType<typeof pageFacts>>, s3 = observed.get('step3') as Awaited<ReturnType<typeof pageFacts>>;
    for (const [n, f] of [['1', s1], ['2', s2], ['3', s3]] as const) {
      if (f.purposeSelector) defects.push(`step ${n}: technical purpose selector visible`);
      if (f.submits.length !== 1) defects.push(`step ${n}: ${f.submits.length} visible submit actions (${f.submits.join(' | ')})`);
      if (f.focused !== 'H1') defects.push(`step ${n}: focus on ${f.focused}, not h1`);
      if (f.storage !== 0) defects.push(`step ${n}: storage used`);
    }
    if (s3.skipOption) defects.push('step 3 offers to skip MFA');
    if (leak) defects.push('code or TOTP secret in URL/request');
    const shownInfo = observed.get('TOTP material shown') as { base32KeyShownSeparately: boolean; hasQr: boolean };
    if (!shownInfo.base32KeyShownSeparately && !shownInfo.hasQr) defects.push('UX: TOTP setup shows only an otpauth URI (no separate Base32 key / QR) for manual entry');
    console.log(JSON.stringify({ evidence: 'P05v3-UX-01', observed: Object.fromEntries(observed), defects }));
    await context.close();
    assert.deepEqual(defects, []);
  } finally { await browser.close(); await ch.close(); }
});

test('P05v3-UX-02 invalid code, network down, factor before INITIAL and organization before factor never show success', { timeout: 300000 }, async () => {
  const ch = await channel(), browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
  try {
    const observed = new Map<string, unknown>();
    const context = await newContext(browser), page = await context.newPage();
    const email = `p05v3_ux2_${randomUUID()}@example.test`;
    await registerViaUi(page, email);
    await page.goto(`${UI}/#/verificar`); await page.getByLabel('Código de activación').waitFor();
    await page.getByLabel('Código de activación').fill('A'.repeat(43)); await page.getByLabel('Contraseña nueva').fill(PASSWORD);
    await page.getByRole('button', { name: 'Activar' }).click();
    await page.locator('[role="alert"], .alert').first().waitFor({ timeout: 15000 });
    observed.set('invalid code', { hash: new URL(page.url()).hash, alert: (await page.locator('main').innerText()).match(/código[^.]*\.|no[^.]*\./i)?.[0] ?? null, protectVisible: await page.getByRole('heading', { name: 'Proteger cuenta' }).count() });
    // network down
    await page.route('**/api/v1/**', route => route.abort('internetdisconnected'));
    const token = await ch.mail(email, 'ACTIVATION');
    await page.getByLabel('Código de activación').fill(token); await page.getByLabel('Contraseña nueva').fill(PASSWORD);
    await page.getByRole('button', { name: 'Activar' }).click(); await page.waitForTimeout(1500);
    observed.set('network down', { hash: new URL(page.url()).hash, protectVisible: await page.getByRole('heading', { name: 'Proteger cuenta' }).count(), mainText: (await page.locator('main').innerText()).slice(0, 220) });
    await page.unroute('**/api/v1/**');
    // Same (still valid) code now works: nothing was consumed by the failed attempts.
    await page.getByRole('button', { name: 'Activar' }).click();
    await page.getByRole('heading', { name: 'Proteger cuenta' }).waitFor({ timeout: 20000 });
    observed.set('retry after network restored', 'reached Proteger cuenta');
    await context.close();
    // Lost context: login again (L) -> Proteger cuenta before INITIAL -> MFA_REQUIRED guidance; organization stays closed.
    const c2 = await newContext(browser), p2 = await c2.newPage();
    await p2.goto(`${UI}/#/ingresar`); await p2.getByLabel('Correo').fill(email); await p2.getByLabel('Contraseña').fill(PASSWORD);
    await p2.getByRole('button', { name: 'Continuar' }).click(); await p2.waitForURL(/#\/verificar/, { timeout: 20000 });
    const resume = await pageFacts(p2); const resumeHash = new URL(resume.url).hash;
    await p2.goto(`${UI}/#/seguridad`); await p2.getByRole('heading', { name: 'Proteger cuenta' }).waitFor();
    await p2.getByLabel('Etiqueta').fill('Antes de INITIAL'); await p2.getByRole('button', { name: 'Preparar factor' }).click();
    const guidance = await p2.getByRole('link', { name: 'pide un código nuevo' }).waitFor({ timeout: 15000 }).then(() => true, () => false);
    await p2.goto(`${UI}/#/organizacion`); await p2.waitForTimeout(800);
    const orgClosed = (await p2.locator('main').innerText()).includes('Hace falta una sesión comprobada');
    observed.set('lost context', { resumeHash, resumePurposeSelector: resume.purposeSelector, factorBeforeInitialGuidance: guidance, organizationClosedWithoutFactor: orgClosed });
    // Resume with INITIAL bound to THIS L, then protect the account.
    await p2.goto(`${UI}/#/verificar`); await p2.getByRole('button', { name: 'Solicitar código de primer factor' }).click();
    const initial = await ch.mail(email, 'INITIAL_MFA_PROOF');
    await p2.getByLabel('Código de activación').fill(initial); await p2.getByRole('button', { name: 'Activar' }).click();
    await p2.getByRole('heading', { name: 'Proteger cuenta' }).waitFor({ timeout: 20000 });
    await p2.getByLabel('Etiqueta').fill('Retoma'); await p2.getByRole('button', { name: 'Preparar factor' }).click();
    const uri = await p2.locator('.secret output').innerText(), secret = new URL(uri).searchParams.get('secret'); assert.ok(secret);
    await p2.getByLabel('Código TOTP actual').fill(await generate({ secret, epoch: Math.floor(Date.now() / 1000) })); await p2.getByRole('button', { name: 'Confirmar TOTP' }).click();
    const resumed = await p2.getByRole('link', { name: 'Continuar a la organización' }).waitFor({ timeout: 20000 }).then(() => true, () => false);
    observed.set('resume via new INITIAL bound to this L', resumed);
    await c2.close();
    console.log(JSON.stringify({ evidence: 'P05v3-UX-02', observed: Object.fromEntries(observed) }));
    const inv = observed.get('invalid code') as { hash: string; protectVisible: number }, net = observed.get('network down') as { hash: string; protectVisible: number }, lost = observed.get('lost context') as Record<string, unknown>;
    assert.equal(inv.protectVisible, 0); assert.equal(inv.hash, '#/verificar'); assert.equal(net.protectVisible, 0); assert.equal(net.hash, '#/verificar');
    assert.equal(lost['resumeHash'], '#/verificar'); assert.equal(lost['resumePurposeSelector'], false); assert.equal(lost['factorBeforeInitialGuidance'], true); assert.equal(lost['organizationClosedWithoutFactor'], true);
    assert.equal(resumed, true);
  } finally { await browser.close(); await ch.close(); }
});

test('P05v3-UX-03 passkey unsupported/cancelled is reported honestly (no success); widths 360-1440 and 200% zoom on each step; keyboard reaches the primary action', { timeout: 300000 }, async () => {
  const ch = await channel(), browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
  try {
    const observed = new Map<string, unknown>(), defects: string[] = [];
    const ca = await readFile('.runtime/tls/cert.pem');
    const toStep3 = async (page: Page) => {
      const email = `p05v3_ux3_${randomUUID()}@example.test`, c = new DevClient(ca, '127.0.0.9'); await c.refresh();
      assert.equal((await c.call('POST', '/auth/register', { email, displayName: 'Passkey UX', privacyPolicyVersion: 'synthetic-v1', acceptTerms: true })).status, 202);
      const token = await ch.mail(email, 'ACTIVATION');
      await page.goto(`${UI}/#/verificar`); await page.getByLabel('Código de activación').fill(token); await page.getByLabel('Contraseña nueva').fill(PASSWORD);
      await page.getByRole('button', { name: 'Activar' }).click(); await page.getByRole('heading', { name: 'Proteger cuenta' }).waitFor({ timeout: 20000 });
    };
    for (const [name, script] of [
      ['unsupported (no PublicKeyCredential)', () => { Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true }); Object.defineProperty(navigator, 'credentials', { value: undefined, configurable: true }); }],
      ['user cancels (NotAllowedError)', () => { const c = navigator.credentials; c.create = () => Promise.reject(new DOMException('cancel', 'NotAllowedError')); }],
    ] as const) {
      const context = await newContext(browser); await context.addInitScript(script); const page = await context.newPage();
      await toStep3(page);
      const offered = await page.locator('select option[value="WEBAUTHN"]').count();
      await page.getByLabel('Etiqueta').fill('Passkey'); await page.getByLabel('Tipo').selectOption('WEBAUTHN');
      await page.getByRole('button', { name: 'Preparar factor' }).click(); await page.waitForTimeout(1500);
      const text = await page.locator('main').innerText();
      const result = { passkeyOptionOffered: offered > 0, success: await page.getByRole('link', { name: 'Continuar a la organización' }).count() > 0, message: (text.match(/No se pudo[^.\n]*|cancel[^.\n]*|no (?:es |está )?(?:compatible|disponible)[^.\n]*/i)?.[0] ?? '(none)') };
      observed.set(name, result);
      if (result.success) defects.push(`${name}: success shown`);
      if (name.startsWith('unsupported') && result.passkeyOptionOffered) defects.push('UX: passkey offered although the browser cannot create one (copy claims it is only offered when possible)');
      await context.close();
    }
    // Widths and zoom on the three onboarding screens.
    const layout: Record<string, unknown>[] = [];
    for (const width of [360, 390, 640, 768, 1024, 1440]) {
      const context = await newContext(browser, width), page = await context.newPage();
      for (const hash of ['#/registro', '#/verificar']) {
        await page.goto(`${UI}/${hash}`); await page.locator('h1').waitFor(); await page.waitForLoadState('networkidle');
        const f = await pageFacts(page); layout.push({ width: width === 640 ? '1280@200%' : width, hash, overflow: f.overflow });
        if (f.overflow > 0) defects.push(`overflow ${f.overflow}px at ${width} on ${hash}`);
      }
      await context.close();
    }
    observed.set('layout', layout);
    // Keyboard: from the focused h1, Tab reaches the first field and the primary action, Enter submits.
    const kc = await newContext(browser), kp = await kc.newPage(); await kp.goto(`${UI}/#/registro`); await kp.locator('h1').waitFor();
    const order: string[] = [];
    for (let i = 0; i < 8; i++) { await kp.keyboard.press('Tab'); order.push(await kp.evaluate(() => (document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? document.activeElement?.tagName ?? '').trim().slice(0, 40))); }
    observed.set('keyboard tab order from h1 on registro', order); await kc.close();
    if (!order.some(o => o.includes('Enviar registro'))) defects.push('keyboard: primary action not reached within 8 Tabs from h1');
    console.log(JSON.stringify({ evidence: 'P05v3-UX-03', observed: Object.fromEntries(observed), defects }));
    assert.deepEqual(defects.filter(d => !d.startsWith('UX:')), []);
    assert.deepEqual(defects, []);
  } finally { await browser.close(); await ch.close(); }
});

test('P05v3-UI01 manager outside page 1: delayed A09 shows no authority while A11 is done; failed A09 shows no actions and keeps session; then normal management + page 2', { timeout: 900000 }, async () => {
  const ca = await readFile('.runtime/tls/cert.pem'), ch = await channel(), browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
  try {
    const observed = new Map<string, unknown>();
    const sources = ['127.0.0.5', '127.0.0.6', '127.0.0.7', '127.0.0.8'];
    const tEmail = `p05v3_t_${randomUUID()}@example.test`, tc = new DevClient(ca, s(sources.at(0))); await tc.refresh();
    assert.equal((await tc.call('POST', '/auth/register', { email: tEmail, displayName: 'Titular V3', privacyPolicyVersion: 'synthetic-v1', acceptTerms: true })).status, 202);
    const t = await activateRecorded(ch, tc, tEmail); assert.ok(t, a25Failures.join('|'));
    const cmd = { name: 'Org V3-UI01', timezone: 'America/Bogota', currency: 'COP' };
    await stepUp(t, 'ORGANIZATION_CREATE', undefined, cmd);
    const org = await t.c.call('POST', '/organizations', cmd, { 'Idempotency-Key': randomUUID() }); assert.equal(org.status, 201); await t.c.refresh();
    const orgId = s((org.data['organization'] as Record<string, unknown>)['id']); const people: Person[] = [t];
    for (let n = 0; n < 21; n++) {
      const email = `p05v3_m${n}_${randomUUID()}@example.test`;
      await stepUp(t, 'MEMBER_INVITE', orgId, { email, roleIds: ['L'] });
      assert.equal((await t.c.call('POST', '/organization/invitations', { email, roleIds: ['L'] })).status, 202);
      const token = await ch.invitation(email), c = new DevClient(ca, s(sources.at(1 + (n % 3)))); await c.refresh();
      assert.equal((await c.call('POST', '/auth/invitations/accept', { mode: 'PREPARE', token, displayName: `Persona ${n}`, privacyPolicyVersion: 'synthetic-v1', acceptTerms: true })).status, 202);
      const p = await activateRecorded(ch, c, email); if (!p) continue;
      assert.equal((await c.call('POST', '/auth/invitations/accept', { mode: 'CONFIRM', token })).status, 200); await c.refresh(); people.push(p);
    }
    observed.set('A25 setup failures', [...a25Failures]);
    const items = (await t.c.call('GET', '/organization/members?limit=50')).data['items'] as { userId: string; version: string }[];
    const targetId = s(items.map(i => i.userId).sort().at(20)), target = people.find(p => p.userId === targetId); assert.ok(target);
    if (target !== t) {
      await stepUp(t, 'MEMBER_ROLE_CHANGE', targetId, { roleIds: ['A'] });
      assert.equal((await t.c.call('PATCH', `/organization/members/${targetId}/roles`, { roleIds: ['A'] }, { 'If-Match': s(items.find(i => i.userId === targetId)?.version) })).status, 200);
      const l = new DevClient(ca, s(sources.at(1))); await l.refresh();
      assert.equal((await l.call('POST', '/auth/login', { email: target.email, password: PASSWORD })).status, 200); await l.refresh();
      target.c.cookies.clear(); for (const [k, v] of l.cookies) target.c.cookies.set(k, v); target.c.csrf = l.csrf; await passkey(target, 'LOGIN');
    }
    const secret = await addTotp(target);
    const visible = async (page: Page) => ({ invite: await page.getByRole('heading', { name: 'Invitar' }).count(), suspend: await page.getByRole('button', { name: 'Suspender' }).count(),
      cards: await page.locator('section.card .cards article.card').count(), pending: await page.getByText('Comprobando tu acceso').count() });
    // Delayed A09 (4s) while A11 resolves.
    const { context, page } = await (async () => { await new Promise(r => setTimeout(r, 31000 - (Date.now() % 30000)));
      const cx = await newContext(browser), pg = await cx.newPage();
      await pg.route('**/api/v1/organization', async route => { if (route.request().method() === 'GET') await new Promise(r => setTimeout(r, 4000)); await route.continue(); });
      await pg.goto(`${UI}/#/ingresar`); await pg.getByLabel('Correo').fill(target.email); await pg.getByLabel('Contraseña').fill(PASSWORD);
      await pg.getByRole('button', { name: 'Continuar' }).click(); await pg.getByLabel('Código TOTP vigente').fill(await generate({ secret, epoch: Math.floor(Date.now() / 1000) }));
      await pg.getByRole('button', { name: 'Verificar factor' }).click(); await pg.waitForURL(/#\/organizacion/); return { context: cx, page: pg }; })();
    await page.waitForTimeout(1500);
    const during = await visible(page);
    await page.getByRole('heading', { name: 'Invitar' }).waitFor({ timeout: 20000 }).catch(() => undefined);
    await page.waitForFunction(() => document.querySelectorAll('section.card .cards article.card').length >= 20, undefined, { timeout: 20000 }).catch(() => undefined);
    const after = await visible(page);
    const more = page.getByRole('button', { name: 'Cargar más personas' }); let page2 = 0;
    if (await more.count()) { await more.focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(2500); page2 = await page.locator('section.card .cards').first().locator(':scope > article.card').count(); }
    observed.set('delayed A09', { during, after, membersAfterPage2: page2, total: items.length });
    // Failed A09 (503 injected in browser only): no authority shown, error visible, session kept.
    await page.unroute('**/api/v1/organization');
    await page.route('**/api/v1/organization', async route => { if (route.request().method() === 'GET') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'x' }, requestId: 'p05v3' }) }); else await route.continue(); });
    await page.reload(); await page.waitForTimeout(3000);
    const failed = { ...(await visible(page)), errorShown: (await page.locator('main').innerText()).includes('No se puede mostrar la gestión') || (await page.locator('[role="alert"]').count()) > 0,
      meStatus: await page.evaluate(async () => (await fetch('/api/v1/auth/me', { credentials: 'include' })).status) };
    observed.set('failed A09', failed);
    await context.close();
    console.log(JSON.stringify({ evidence: 'P05v3-UI01', observed: Object.fromEntries(observed) }));
    assert.equal(during.invite, 0); assert.equal(during.suspend, 0); assert.equal(during.cards, 0);
    assert.ok(after.invite >= 1); assert.ok(after.suspend >= 1); assert.equal(page2, items.length);
    assert.equal(failed.invite, 0); assert.equal(failed.suspend, 0); assert.ok(failed.errorShown); assert.equal(failed.meStatus, 200);
  } finally { await browser.close(); await ch.close(); }
});
