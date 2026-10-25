// S05-P05-v2 copy (Claude, author) of AJ-ONB-5 historical spec aj-onb/aj-onb-review.spec.ts (original untouched).
// The original ran against an own in-process fixture with a control endpoint (mail/code/tick/inspect). Here the same journey
// runs on the REAL launcher in the own S5 group (a2f0795c4990bcb883a92572, ports 5391/5491/5392): mail -> synthetic terminal
// mailbox; code -> own RFC 6238 TOTP (WebCrypto) on the real clock; tick -> wait for the next 30 s step; inspect -> own-group DB
// read of the password hash, compared by digest only (never printed). Adaptations are listed in S05-P05-v2-MATRIX.json.
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'Frase sintetica navegador revisora 5521';
const RUN_ID = 'a2f0795c4990bcb883a92572';
const nodeProcess = (globalThis as unknown as { process: { env: Record<string, string | undefined>; execPath: string; cwd(): string; chdir(d: string): void } }).process;
const here = (relative: string) => new URL(relative, import.meta.url);
type Group = { dispose(reason?: string): Promise<void> };
let group: Group | undefined;
let runner: { send(m: string): void; exitCode: number | null; on(e: string, f: (m: unknown) => void): void; once(e: string, f: (c: unknown) => void): void; stdout: { resume(): void } | null; stderr: { resume(): void } | null; kill(): void } | undefined;
const evidence = (name: string, data: Record<string, unknown>) => console.log('AJ5_EVIDENCE ' + JSON.stringify({ evidence: name, ...data }));
async function path(relative: string): Promise<string> { const url = await import('node:url' as string) as { fileURLToPath(u: URL): string }; return url.fileURLToPath(here(relative)); }
function environment() {
  const e: Record<string, string | undefined> = { ...nodeProcess.env, CAUDELYX_MODE: 'local-synthetic', CAUDELYX_DEV_TEST_ID: RUN_ID, CAUDELYX_DEV_UI_PORT: '5391', CAUDELYX_DEV_API_PORT: '5491', CAUDELYX_DEV_PLATFORM_PORT: '5392' };
  for (const k of ['MONGODB_URI', 'MONGODB_DATABASE', 'CAUDELYX_DEV_SMOKE']) delete e[k];
  return e;
}
async function startStack() {
  const cp = await import('node:child_process' as string) as { spawn(cmd: string, args: string[], o: Record<string, unknown>): NonNullable<typeof runner> };
  runner = cp.spawn(nodeProcess.execPath, ['scripts/dev.mjs'], { cwd: await path('../../../../'), env: environment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  runner.stdout?.resume(); runner.stderr?.resume();
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('own stack readiness timeout')), 120000);
    runner!.on('message', m => { if (m === 'S02_INSTALLED_READY') { clearTimeout(timer); ok(); } });
    runner!.once('exit', c => { clearTimeout(timer); fail(new Error('own stack exited ' + String(c))); });
  });
}
async function stopStack() {
  if (!runner || runner.exitCode !== null) return;
  const child = runner; await new Promise<void>(done => { const t = setTimeout(() => { child.kill(); done(); }, 30000); child.once('exit', () => { clearTimeout(t); done(); }); child.send('LOCAL_DEV_STOP'); });
  runner = undefined;
}
async function mailboxCode(email: string): Promise<string> {
  const cp = await import('node:child_process' as string) as { execFile(c: string, a: string[], o: Record<string, unknown>, cb: (e: unknown, out: string) => void): void };
  const server = await path('../../../../servidor/');
  for (let n = 0; n < 30; n++) {
    const out = await new Promise<string>(done => cp.execFile(nodeProcess.execPath, ['scripts/mailbox-installed.mjs', '--email', email], { cwd: server, env: environment(), windowsHide: true }, (_e, o) => done(o ?? '')));
    try { const code = (JSON.parse(out) as { messages: { purpose: string; code: string }[] }).messages.find(m => m.purpose === 'ACTIVATION')?.code; if (code) return code; } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('synthetic mailbox unavailable');
}
async function totpAt(secret: string, step: number): Promise<string> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = new Uint8Array(Math.floor(bits.length / 8)).map((_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2));
  const counter = new Uint8Array(8); let c = step; for (let i = 7; i >= 0; i--) { counter[i] = c & 0xff; c = Math.floor(c / 256); }
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']), counter));
  const o = (mac[19] ?? 0) & 0xf, n = (((mac[o] ?? 0) & 0x7f) << 24) | ((mac[o + 1] ?? 0) << 16) | ((mac[o + 2] ?? 0) << 8) | (mac[o + 3] ?? 0);
  return String(n % 1000000).padStart(6, '0');
}
let lastStep = 0;
async function freshCode(secret: string): Promise<string> {
  while (Math.floor(Date.now() / 30000) <= lastStep) await new Promise(r => setTimeout(r, 500));
  lastStep = Math.floor(Date.now() / 30000); return await totpAt(secret, lastStep);
}
/** Own-group identity read: emailVerified and a digest of the stored password hash (never the hash itself). */
async function inspect(email: string): Promise<{ emailVerified: unknown; hash: string }> {
  const mod = await import(new URL('../../../../servidor/node_modules/mongodb/lib/index.js', import.meta.url).href) as { MongoClient: new (u: string, o: object) => { connect(): Promise<void>; db(n: string): { collection(n: string): { findOne(f: object): Promise<Record<string, unknown> | null> } }; close(): Promise<void> } };
  const c = new mod.MongoClient('mongodb://127.0.0.1:27017/?replicaSet=rs0', { appName: 'S05_P05_AJ_READ', serverSelectionTimeoutMS: 3000 });
  await c.connect();
  try {
    const doc = await c.db('caudelyx_s02_test_' + RUN_ID).collection('identities').findOne({ email });
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(doc?.['passwordHash'] ?? ''))));
    return { emailVerified: doc?.['emailVerified'] ?? (doc?.['profile'] as Record<string, unknown> | undefined)?.['emailVerified'], hash: [...digest].map(b => b.toString(16).padStart(2, '0')).join('') };
  } finally { await c.close(); }
}
const nav = (page: Page) => page.getByRole('navigation', { name: 'Secciones' });
async function noHorizontalScroll(page: Page): Promise<boolean> { return await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth); }

test.beforeAll(async () => {
  const cwd = nodeProcess.cwd(); nodeProcess.chdir(await path('../../../../servidor/'));
  try { const mod = await import(here('../../../../servidor/dist/tests/independent/s05/review-profile.js').href) as { reviewProfile(): Promise<Group> }; group = await mod.reviewProfile(); }
  finally { nodeProcess.chdir(cwd); }
  try { await startStack(); } catch (e) { try { await stopStack(); } finally { await group!.dispose('setup-error'); } throw e; }
});
test.afterAll(async () => {
  try { await stopStack(); } finally { const cwd = nodeProcess.cwd(); nodeProcess.chdir(await path('../../../../servidor/')); try { await group?.dispose('end'); } finally { nodeProcess.chdir(cwd); } }
});

test('AJ-ONB-5 recorrido real con QR y negocio (copia S5 sobre el lanzador real)', async ({ page, browser, baseURL }) => {
  page.setDefaultTimeout(20000);
  const origin = new URL(baseURL!).origin, email = 'r5-e2e-' + Date.now() + '@example.test';
  const requests: string[] = [], consoleTexts: string[] = [];
  page.context().on('request', r => requests.push(r.url()));
  page.on('console', m => consoleTexts.push(m.text()));

  await page.goto('/#/registro');
  await page.getByLabel('Correo', { exact: true }).fill(email);
  await page.getByLabel('Nombre visible').fill('Revisora E2E');
  await page.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page.getByRole('heading', { name: 'Mi cuenta', exact: true })).toBeVisible();
  await expect(nav(page).getByText('Hola, Revisora E2E')).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Ingresar' })).toHaveCount(0);
  await expect(nav(page).getByRole('link', { name: 'Crear cuenta' })).toHaveCount(0);
  await expect(nav(page).getByRole('link', { name: 'Organización' })).toHaveCount(0);
  await expect(page.getByText('Correo sin confirmar', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 });
  const profile360 = await noHorizontalScroll(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const before = await inspect(email);

  const token = await mailboxCode(email);
  const other = await browser.newContext({ locale: 'es-CO' });
  const second = await other.newPage();
  const secondRequests: string[] = [];
  other.on('request', r => secondRequests.push(r.url()));
  await second.goto(origin + '/#/activar?purpose=ACTIVATION&token=' + token);
  await expect(second.getByRole('button', { name: 'Activar cuenta' })).toBeVisible();
  const strippedUrl = !second.url().includes(token);
  await second.getByRole('button', { name: 'Activar cuenta' }).click();
  await expect(second.getByText('Correo confirmado ✓')).toBeVisible();
  await expect(nav(second).getByRole('link', { name: 'Ingresar' })).toBeVisible();
  const tokenInHttp = secondRequests.some(u => (u.split('#')[0] ?? '').includes(token));
  await other.close();
  const after = await inspect(email);
  expect(after.emailVerified).toBe(true);
  expect(after.hash).toBe(before.hash);

  await page.reload();
  await page.goto('/#/perfil');
  await expect(page.getByText('Correo confirmado', { exact: true })).toBeVisible();
  await page.getByLabel('Contraseña actual').fill(PASSWORD);
  await page.getByRole('button', { name: 'Preparar factor' }).click();
  const image = page.getByRole('img', { name: /Código QR de la misma cuenta/ });
  await expect(image).toBeVisible();
  const src = await image.getAttribute('src') ?? '';
  const uri = (await page.locator('output').first().textContent()) ?? '';
  const parsed = new URL(uri), secret = parsed.searchParams.get('secret') ?? '';
  const manual = (await page.locator('.manual-key').textContent()) ?? '';
  const qrcode = await import('qrcode' as string) as { toString(text: string, o: Record<string, unknown>): Promise<string> };
  const expectedSvg = await qrcode.toString(uri, { type: 'svg', margin: 2, width: 240, errorCorrectionLevel: 'M', color: { dark: '#0f172a', light: '#ffffff' } });
  const qrEqualsUri = decodeURIComponent(src.slice('data:image/svg+xml;charset=utf-8,'.length)) === expectedSvg;
  expect(qrEqualsUri).toBe(true);
  expect(manual).toBe(secret);
  expect(decodeURIComponent(parsed.pathname)).toContain(email);
  await page.setViewportSize({ width: 360, height: 800 });
  const qr360 = await noHorizontalScroll(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByLabel('Código TOTP actual').fill(await freshCode(secret));
  await page.getByRole('button', { name: 'Confirmar TOTP' }).click();
  await expect(nav(page).getByRole('link', { name: 'Organización' })).toBeVisible({ timeout: 15000 });
  const factorNoticeVisible = await page.getByText(/Factor registrado/).isVisible();
  await expect(page.getByRole('link', { name: 'Continuar a la organización' })).toBeVisible();
  await expect(page.getByRole('img', { name: /Código QR/ })).toHaveCount(0);
  const secretGoneAfterConfirm = !(await page.content()).includes(secret);

  await page.goto('/#/organizacion');
  await page.getByLabel('Nombre', { exact: true }).fill('Organización revisora');
  await page.getByLabel('Contraseña actual').fill(PASSWORD);
  await page.getByLabel('Código TOTP vigente').fill(await freshCode(secret));
  await page.getByRole('button', { name: 'Crear organización' }).click();
  await expect(page.getByText(/Organización creada/)).toBeVisible();

  const storage = await page.evaluate(() => [localStorage.length, sessionStorage.length]);
  expect(storage).toEqual([0, 0]);
  const external = requests.filter(u => !u.startsWith(origin + '/') && !u.startsWith('data:'));
  expect(external).toEqual([]);
  expect(consoleTexts.some(t => t.includes(secret) || t.includes('otpauth') || t.includes(token))).toBe(false);
  await nav(page).getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(nav(page).getByRole('link', { name: 'Ingresar' })).toBeVisible();
  const secretGoneAfterLogout = !(await page.content()).includes(secret);
  evidence('journey', { factorNoticeVisible, profile360, qr360, strippedUrl, tokenInHttp, qrEqualsUri, manualEqualsUri: manual === secret, secretGoneAfterConfirm, secretGoneAfterLogout,
    storage, externalRequests: external.length, requests: requests.length, consoleMessages: consoleTexts.length });
  expect(tokenInHttp).toBe(false);
  expect(strippedUrl).toBe(true);
});
