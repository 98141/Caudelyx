// S01-P05-REVAL-v4 independent browser tests (Claude) on candidate P04-v4-INTEGRADO, against the real local stack
// (Vite https://localhost:3001 -> API 4001, scripts/dev-local.mjs). Activation links are read from the synthetic encrypted
// channel (Mongo + ignored keyring) and only kept in memory. Evidence stores booleans/statuses, never codes, keys or tokens.
// No screenshot is taken here (secret-bearing screens); clean public captures come from the reserved copy of the onboarding spec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { generate } from 'otplib';
import { unseal } from '../../src/shared/crypto.js';

const UI = 'https://localhost:3001', PASSWORD = 'independent P05 REVAL v4 synthetic passphrase 86420';
const CHROMIUM = 'C:/Users/Asus ExpertBook/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const evidence = (name: string, data: Record<string, unknown>) => console.log(JSON.stringify({ evidence: name, ...data }));
async function channel() {
  const link = JSON.parse(await readFile('.runtime/local-connection.json', 'utf8')) as { mongoUri: string; databaseName: string };
  const keys = JSON.parse(await readFile('.runtime/synthetic-keys.json', 'utf8')) as { mail: string };
  const client = new MongoClient(link.mongoUri); await client.connect();
  const db = client.db(link.databaseName), key = Buffer.from(keys.mail, 'base64url');
  const mail = async (email: string, differentFrom = ''): Promise<string> => {
    for (let n = 0; n < 100; n++) {
      const subject = await db.collection<{ _id: string }>('identities').findOne({ email, realm: 'TENANT' });
      const rows = subject ? await db.collection('synthetic_mail').find({ subjectId: subject._id, purpose: 'ACTIVATION' }).sort({ expiresAt: -1 }).toArray() : [];
      const latest = rows[0] ? unseal(String(rows[0]['encryptedToken']), key) : ''; if (latest && latest !== differentFrom) return latest;
      await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(differentFrom ? 'no new synthetic mail after resend' : 'synthetic mail not found');
  };
  return { mail, close: () => client.close() };
}
const newContext = (browser: Browser, width = 1280) => browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 900 }, locale: 'es-CO' }); // synthetic self-signed CA only
/** Watches every request of a context; keeps booleans only. */
function watch(context: BrowserContext, secret: () => string[]) {
  const seen = { tokenInUrl: false, tokenInReferer: false, confirmGets: 0, confirmPosts: 0 };
  context.on('request', req => {
    const url = req.url(), ref = req.headers()['referer'] ?? '';
    for (const s of secret()) { if (s && url.includes(s)) seen.tokenInUrl = true; if (s && ref.includes(s)) seen.tokenInReferer = true; }
    if (url.includes('/email-verifications/confirm')) { if (req.method() === 'GET') seen.confirmGets++; if (req.method() === 'POST') seen.confirmPosts++; }
  });
  return seen;
}
// Before any app script: record (as booleans) whether the token was still in the address bar at first render / first API call.
const RENDER_PROBE = `(() => {
  const w = window; w.__p05 = { renderHadToken: null, fetchHadToken: null };
  const f = w.fetch; w.fetch = function (...a) { if (w.__p05.fetchHadToken === null) w.__p05.fetchHadToken = location.href.includes('token='); return f.apply(this, a); };
  new MutationObserver((m, o) => { const root = document.getElementById('root'); if (root && root.childElementCount) { w.__p05.renderHadToken = location.href.includes('token='); o.disconnect(); } }).observe(document, { subtree: true, childList: true });
  const mode = new URLSearchParams(location.search).get('pk');
  if (mode === 'none') Object.defineProperty(w, 'PublicKeyCredential', { configurable: true, value: undefined });
  else if (mode) Object.defineProperty(navigator.credentials, 'create', { configurable: true, value: () => Promise.reject(new DOMException('synthetic', mode)) });
})();`;
async function facts(page: Page) {
  return await page.evaluate(() => ({ hash: location.hash, search: location.search, storage: localStorage.length + sessionStorage.length,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, probe: (window as unknown as { __p05?: unknown }).__p05 ?? null }));
}
async function register(page: Page, email: string, name: string) {
  await page.goto(`${UI}/#/registro`); await page.getByRole('heading', { name: 'Crea tu cuenta' }).waitFor();
  await page.getByLabel('Correo').fill(email); await page.getByLabel('Nombre visible').fill(name);
  await page.getByLabel('Contraseña').fill(PASSWORD); await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await page.getByText('Activa tu cuenta para continuar').waitFor({ timeout: 20000 });
}
const linkUrl = (token: string, extra = '') => `${UI}/${extra}#/activar?purpose=ACTIVATION&token=${token}`;
const visible = async (page: Page, text: string) => (await page.getByText(text).count()) > 0;
async function totpWithManualKey(page: Page) {
  await page.getByRole('button', { name: 'Preparar factor' }).click();
  await page.locator('p.manual-key').waitFor();
  const manual = (await page.locator('p.manual-key').textContent() ?? '').replace(/\s/g, '');
  await page.getByLabel('Código TOTP actual').fill(await generate({ secret: manual, epoch: Math.floor(Date.now() / 1000) }));
  await page.getByRole('button', { name: 'Confirmar TOTP' }).click();
  await page.getByRole('link', { name: 'Continuar a la organización' }).waitFor({ timeout: 20000 });
  return manual.length;
}

test('P05v4-UI-01 0.11 onboarding in one browser: Crear cuenta -> private profile -> link opened in a new tab (fragment cleaned before render/network) -> Activar cuenta -> TOTP with the MANUAL Base32 key only -> organización; widths/200%/keyboard; key cleared', { timeout: 300000 }, async () => {
  const ch = await channel(), browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
  try {
    const observed = new Map<string, unknown>(); let token = '';
    const context = await newContext(browser); await context.addInitScript(RENDER_PROBE); const seen = watch(context, () => [token]);
    const page = await context.newPage(), email = `p05v4_ui01_${Date.now()}@example.test`;
    await register(page, email, 'Persona v4');
    observed.set('profile shows introduced data', await visible(page, 'Nombre: Persona v4') && await visible(page, `Correo: ${email}`));
    observed.set('profile at 360/640 overflow', await (async () => { const o: boolean[] = []; for (const w of [360, 640]) { await page.setViewportSize({ width: w, height: 900 }); o.push((await facts(page)).overflow); } await page.setViewportSize({ width: 1280, height: 900 }); return o; })());
    token = await ch.mail(email);
    const tab = await context.newPage(); await tab.goto(linkUrl(token)); await tab.getByRole('button', { name: 'Activar cuenta' }).waitFor();
    const opened = await facts(tab);
    observed.set('after open: hash / storage / token at first render / token at first fetch', [opened.hash, opened.storage, opened.probe]);
    observed.set('confirm requests before click (GET, POST)', [seen.confirmGets, seen.confirmPosts]);
    await tab.getByRole('button', { name: 'Activar cuenta' }).click();
    await tab.getByRole('heading', { name: 'Proteger mi cuenta' }).waitFor({ timeout: 20000 });
    const keyboard: string[] = []; await tab.getByRole('heading', { name: 'Proteger mi cuenta' }).focus();
    for (let i = 0; i < 6; i++) { await tab.keyboard.press('Tab'); keyboard.push(await tab.evaluate(() => (document.activeElement?.textContent || (document.activeElement as HTMLInputElement | null)?.type) ?? '')); }
    observed.set('keyboard reaches Preparar factor', keyboard.some(k => k.includes('Preparar factor')));
    await tab.getByRole('button', { name: 'Preparar factor' }).click(); await tab.locator('p.manual-key').waitFor();
    const layout: Record<string, unknown> = {};
    for (const w of [360, 390, 640, 768, 1024, 1440]) {
      await tab.setViewportSize({ width: w, height: 900 });
      layout[String(w)] = await tab.evaluate(() => { const k = document.querySelector('p.manual-key') as HTMLElement | null; return { pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, keyClipped: k ? k.scrollWidth > k.clientWidth + 1 : null }; });
    }
    observed.set('manual key screen layout per width (640 = 1280 at 200%)', layout);
    observed.set('manual key present with account/issuer, no QR', await visible(tab, 'Clave manual') && await visible(tab, 'Cuenta:') && await visible(tab, 'Emisor:') && (await tab.locator('img, canvas, svg[aria-label*="QR" i]').count()) === 0);
    await tab.goto(`${UI}/#/organizacion`); await tab.goto(`${UI}/#/perfil`); await tab.getByRole('heading', { name: 'Proteger mi cuenta' }).waitFor();
    observed.set('manual key gone after leaving the screen', await tab.locator('p.manual-key').count());
    observed.set('manual key length used (Base32 chars)', await totpWithManualKey(tab));
    observed.set('after confirm: manual key / output count', [await tab.locator('p.manual-key').count(), await tab.locator('output').count()]);
    await tab.getByRole('link', { name: 'Continuar a la organización' }).click();
    observed.set('organización screen', await tab.getByRole('heading', { name: 'Crear la organización' }).waitFor({ timeout: 20000 }).then(() => true, () => false));
    observed.set('final storage', (await facts(tab)).storage); observed.set('token in any request URL / Referer', [seen.tokenInUrl, seen.tokenInReferer]); observed.set('confirm GET requests total', seen.confirmGets);
    evidence('P05v4-UI-01', { observed: Object.fromEntries(observed) });
    assert.equal(observed.get('profile shows introduced data'), true);
    assert.deepEqual(opened.probe, { renderHadToken: false, fetchHadToken: false }); assert.equal(opened.hash, '#/activar'); assert.equal(opened.storage, 0);
    assert.deepEqual(observed.get('confirm requests before click (GET, POST)'), [0, 0]); assert.equal(observed.get('manual key gone after leaving the screen'), 0);
    assert.deepEqual(observed.get('after confirm: manual key / output count'), [0, 0]); assert.equal(observed.get('organización screen'), true);
    assert.deepEqual(observed.get('token in any request URL / Referer'), [false, false]); assert.equal(seen.confirmGets, 0); assert.equal(observed.get('final storage'), 0);
    for (const v of Object.values(layout)) assert.deepEqual(v, { pageOverflow: false, keyClipped: false });
  } finally { await browser.close(); await ch.close(); }
});

test('P05v4-UI-02 link edge cases: malformed %/UTF-8, duplicate/unknown keys, query leak, other route, successive opens in two tabs, offline click, replay in another browser; never a false success', { timeout: 300000 }, async () => {
  const ch = await channel(), browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
  try {
    const observed = new Map<string, unknown>(); let token = '';
    const context = await newContext(browser); await context.addInitScript(RENDER_PROBE); const seen = watch(context, () => [token]);
    const page = await context.newPage(), email = `p05v4_ui02_${Date.now()}@example.test`;
    await register(page, email, 'Persona bordes'); token = await ch.mail(email);
    const invalidCase = async (url: string) => {
      const p = await context.newPage(); const posts = seen.confirmPosts; await p.goto(url); await p.getByRole('heading', { name: 'Activar' }).waitFor(); await p.getByText('Cargando sesión').waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined); await p.waitForTimeout(300);
      const f = await facts(p); const r = { invalidShown: await visible(p, 'Este enlace no se puede usar'), activarButton: await p.getByRole('button', { name: 'Activar cuenta' }).count(), hashHasToken: f.hash.includes('token'), searchHasToken: f.search.includes('token'), posts: seen.confirmPosts - posts };
      await p.close(); return r;
    };
    observed.set('malformed percent', await invalidCase(`${UI}/#/activar?purpose=ACTIVATION&token=%E0%A4%A`));
    observed.set('malformed UTF-8 in token', await invalidCase(`${UI}/#/activar?purpose=ACTIVATION&token=${token.slice(0, 40)}%C3%28A`));
    observed.set('duplicate token key', await invalidCase(`${linkUrl(token)}&token=${token}`));
    observed.set('unknown key', await invalidCase(`${linkUrl(token)}&x=1`));
    const leakFlagsBeforeQueryCase = [seen.tokenInUrl, seen.tokenInReferer];
    observed.set('query leak', await invalidCase(linkUrl(token, `?token=${token}`)));
    observed.set('token in request URL / Referer BEFORE the deliberate query-leak case', leakFlagsBeforeQueryCase); seen.tokenInUrl = false; seen.tokenInReferer = false;
    const other = await context.newPage(); await other.goto(`${UI}/#/perfil?purpose=ACTIVATION&token=${token}`); await other.getByRole('heading', { name: 'Perfil' }).waitFor();
    observed.set('other route keeps token in address bar', (await facts(other)).hash.includes('token')); await other.close();
    // Successive opens of the same valid link in two tabs; first click offline, then the other tab online.
    const t1 = await context.newPage(), t2 = await context.newPage();
    await t1.goto(linkUrl(token)); await t2.goto(linkUrl(token)); await t1.getByRole('button', { name: 'Activar cuenta' }).waitFor(); await t2.getByRole('button', { name: 'Activar cuenta' }).waitFor();
    await context.setOffline(true); await t1.getByRole('button', { name: 'Activar cuenta' }).click(); await t1.waitForTimeout(1500);
    observed.set('offline click: error shown / Proteger shown', [await t1.getByRole('alert').count() > 0, await t1.getByRole('heading', { name: 'Proteger mi cuenta' }).count()]);
    await context.setOffline(false);
    await t2.getByRole('button', { name: 'Activar cuenta' }).click();
    observed.set('second tab online activates', await t2.getByRole('heading', { name: 'Proteger mi cuenta' }).waitFor({ timeout: 20000 }).then(() => true, () => false));
    await t1.getByRole('button', { name: 'Activar cuenta' }).click().catch(() => undefined); await t1.waitForTimeout(1500);
    observed.set('first tab retry after the other tab consumed: Proteger heading / error', [await t1.getByRole('heading', { name: 'Proteger mi cuenta' }).count(), await t1.getByRole('alert').count() > 0, (await t1.textContent('main'))?.includes('Factor registrado') ?? false]);
    const foreign = await newContext(browser), fp = await foreign.newPage(); await fp.goto(linkUrl(token));
    const legacyOffered = await fp.getByRole('button', { name: 'Crear contraseña inicial' }).waitFor({ timeout: 10000 }).then(() => true, () => false);
    if (legacyOffered) { await fp.getByRole('button', { name: 'Crear contraseña inicial' }).click(); await fp.getByLabel('Contraseña nueva').fill(PASSWORD); await fp.getByRole('button', { name: 'Activar con contraseña inicial' }).click(); await fp.waitForTimeout(1500); }
    observed.set('replay in another browser: legacy offered / error / Proteger', [legacyOffered, await fp.getByRole('alert').count() > 0, await fp.getByRole('heading', { name: 'Proteger mi cuenta' }).count()]);
    await foreign.close();
    observed.set('token in request URL / Referer AFTER the query-leak case (later pages); confirm GETs', [seen.tokenInUrl, seen.tokenInReferer, seen.confirmGets]);
    evidence('P05v4-UI-02', { observed: Object.fromEntries(observed) });
    for (const k of ['malformed percent', 'malformed UTF-8 in token', 'duplicate token key', 'unknown key', 'query leak']) assert.deepEqual(observed.get(k), { invalidShown: true, activarButton: 0, hashHasToken: false, searchHasToken: false, posts: 0 }, k);
    assert.deepEqual(observed.get('offline click: error shown / Proteger shown'), [true, 0]); assert.equal(observed.get('second tab online activates'), true);
    assert.deepEqual(observed.get('first tab retry after the other tab consumed: Proteger heading / error'), [0, true, false]);
    assert.equal((observed.get('replay in another browser: legacy offered / error / Proteger') as unknown[])[2], 0);
    assert.deepEqual(observed.get('token in request URL / Referer BEFORE the deliberate query-leak case'), [false, false]);
    assert.deepEqual(observed.get('token in request URL / Referer AFTER the query-leak case (later pages); confirm GETs'), [false, false, 0]);
  } finally { await browser.close(); await ch.close(); }
});

test('P05v4-UI-03 REAL clock: link opened between 5 and 10 minutes after Crear cuenta (intent still shown as EMAIL_REQUIRED): what the user can do, resend, header logout path, and state after the 10-minute intent expiry', { timeout: 1200000 }, async () => {
  const ch = await channel(), browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
  try {
    const observed = new Map<string, unknown>(), timeline: string[] = [];
    const a = await newContext(browser), b = await newContext(browser), pa = await a.newPage(), pb = await b.newPage();
    const ea = `p05v4_ui03a_${Date.now()}@example.test`, eb = `p05v4_ui03b_${Date.now()}@example.test`;
    const t0 = Date.now(); const at = () => `${Math.round((Date.now() - t0) / 1000)}s`;
    await register(pa, ea, 'Ventana A'); await register(pb, eb, 'Ventana B');
    const ta = await ch.mail(ea), tb = await ch.mail(eb);
    await new Promise(r => setTimeout(r, Math.max(0, t0 + 310000 - Date.now())));
    // A: open the link in the same browser at ~5:10 and click the only action offered.
    const la = await a.newPage(); await la.goto(linkUrl(ta)); await la.getByRole('button', { name: 'Activar cuenta' }).waitFor();
    await la.getByRole('button', { name: 'Activar cuenta' }).click(); await la.waitForTimeout(2000);
    const text = (await la.textContent('main')) ?? '';
    observed.set('A ~5:10 click Activar cuenta: Proteger / message', [await la.getByRole('heading', { name: 'Proteger mi cuenta' }).count(), text.includes('El código no es válido o ya no está disponible.') ? 'TOKEN_INVALID copy' : text.slice(0, 80)]);
    observed.set('A ~5:10 actions offered on that screen', await la.locator('main button, main a').allTextContents());
    timeline.push(`${at()} A LINK failed`);
    await pa.reload(); await pa.getByRole('heading', { name: 'Perfil' }).waitFor();
    observed.set('A profile still EMAIL_REQUIRED after failure', await visible(pa, 'Activa tu cuenta para continuar'));
    await pa.getByRole('button', { name: 'Reenviar enlace de activación' }).click(); await pa.getByText('Solicitud recibida').waitFor({ timeout: 20000 });
    const ta2 = await ch.mail(ea, ta).catch(() => ta); observed.set('A resend produced a new link', ta2 !== ta); const la2 = await a.newPage(); await la2.goto(linkUrl(ta2)); await la2.getByRole('button', { name: 'Activar cuenta' }).click(); await la2.waitForTimeout(2000);
    observed.set('A resent link ~5:30: Proteger', await la2.getByRole('heading', { name: 'Proteger mi cuenta' }).count()); timeline.push(`${at()} A resent link failed=${await la2.getByRole('heading', { name: 'Proteger mi cuenta' }).count() === 0}`);
    // B: same window, but the user uses the header "Cerrar sesión" and reopens the link.
    const lb = await b.newPage(); await lb.goto(linkUrl(tb)); await lb.getByRole('button', { name: 'Activar cuenta' }).click(); await lb.waitForTimeout(2000);
    await lb.getByRole('button', { name: 'Cerrar sesión' }).click(); await lb.waitForTimeout(1000);
    const lb2 = await b.newPage(); await lb2.goto(linkUrl(tb));
    const legacyB = await lb2.getByRole('button', { name: 'Crear contraseña inicial' }).waitFor({ timeout: 10000 }).then(() => true, () => false);
    if (legacyB) { await lb2.getByRole('button', { name: 'Crear contraseña inicial' }).click(); await lb2.getByLabel('Contraseña nueva').fill(PASSWORD); await lb2.getByRole('button', { name: 'Activar con contraseña inicial' }).click(); }
    observed.set('B after header logout: legacy offered / Proteger', [legacyB, await lb2.getByRole('heading', { name: 'Proteger mi cuenta' }).waitFor({ timeout: 20000 }).then(() => 1, () => 0)]);
    timeline.push(`${at()} B recovered via logout=${legacyB}`);
    // A: wait until the 10-minute intent/P expiry, then reopen the resent link.
    await new Promise(r => setTimeout(r, Math.max(0, t0 + 615000 - Date.now())));
    await pa.reload(); await pa.waitForTimeout(1500);
    observed.set('A profile after ~10:15', { emailRequired: await visible(pa, 'Activa tu cuenta para continuar'), anonymous: await visible(pa, 'No hay un perfil en este navegador') });
    const la3 = await a.newPage(); await la3.goto(linkUrl(ta2));
    const legacyA = await la3.getByRole('button', { name: 'Crear contraseña inicial' }).waitFor({ timeout: 10000 }).then(() => true, () => false);
    if (legacyA) { await la3.getByRole('button', { name: 'Crear contraseña inicial' }).click(); await la3.getByLabel('Contraseña nueva').fill(PASSWORD); await la3.getByRole('button', { name: 'Activar con contraseña inicial' }).click(); }
    observed.set('A after intent expiry with resent link: legacy offered / Proteger', [legacyA, await la3.getByRole('heading', { name: 'Proteger mi cuenta' }).waitFor({ timeout: 20000 }).then(() => 1, () => 0)]);
    timeline.push(`${at()} A recovered after expiry=${legacyA}`);
    evidence('P05v4-UI-03', { observed: Object.fromEntries(observed), timeline,
      note: 'Assertions encode the user expectation (a usable path from the EMAIL_REQUIRED screen inside its own validity). A failure here is a finding, not a harness error.' });
    assert.equal((observed.get('A ~5:10 click Activar cuenta: Proteger / message') as unknown[])[0], 1, 'link opened at 5:10 while the profile still says EMAIL_REQUIRED must activate or lead to a working path on that screen');
  } finally { await browser.close(); await ch.close(); }
});

test('P05v4-UI-04 N05 passkey unavailable / NotSupportedError / NotAllowedError / AbortError: clear alternative, no false success, no logout; TOTP manual key still completes', { timeout: 300000 }, async () => {
  const ch = await channel(), browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
  try {
    const observed = new Map<string, unknown>();
    const context = await newContext(browser); await context.addInitScript(RENDER_PROBE);
    const page = await context.newPage(), email = `p05v4_ui04_${Date.now()}@example.test`;
    await register(page, email, 'Persona passkey'); const token = await ch.mail(email);
    await page.goto(linkUrl(token)); await page.getByRole('button', { name: 'Activar cuenta' }).click(); await page.getByRole('heading', { name: 'Proteger mi cuenta' }).waitFor({ timeout: 20000 });
    for (const mode of ['none', 'NotSupportedError', 'NotAllowedError', 'AbortError', 'SecurityError']) {
      await page.goto(`${UI}/?pk=${mode}#/perfil`); await page.getByRole('heading', { name: 'Proteger mi cuenta' }).waitFor();
      const options = await page.getByLabel('Tipo').locator('option').allTextContents();
      let message = '';
      if (options.some(o => o.startsWith('Passkey'))) {
        await page.getByLabel('Tipo').selectOption('WEBAUTHN'); await page.getByRole('button', { name: 'Preparar factor' }).click();
        await page.getByRole('alert').first().waitFor({ timeout: 10000 }).catch(() => undefined); message = (await page.getByRole('alert').allTextContents()).join(' | ');
      } else message = (await page.textContent('main'))?.includes('Este navegador no puede crear una passkey. Usa la app autenticadora.') ? 'hint: unavailable, use TOTP' : '';
      observed.set(mode, { options, message, stillProtect: await page.getByRole('heading', { name: 'Proteger mi cuenta' }).count(), falseSuccess: await visible(page, 'Factor registrado') || await page.getByRole('link', { name: 'Continuar a la organización' }).count() > 0,
        loggedOut: await visible(page, 'No hay un perfil en este navegador'), totpOffered: options.includes('TOTP') });
    }
    await page.goto(`${UI}/#/perfil`); await page.getByRole('heading', { name: 'Proteger mi cuenta' }).waitFor();
    observed.set('TOTP via manual key after passkey failures', await totpWithManualKey(page).then(() => 'OK', e => String(e).slice(0, 60)));
    evidence('P05v4-UI-04', { observed: Object.fromEntries(observed) });
    for (const mode of ['none', 'NotSupportedError', 'NotAllowedError', 'AbortError', 'SecurityError']) {
      const r = observed.get(mode) as { message: string; stillProtect: number; falseSuccess: boolean; loggedOut: boolean; totpOffered: boolean };
      assert.ok(r.message.length > 0, `${mode} message`); assert.equal(r.stillProtect, 1); assert.equal(r.falseSuccess, false); assert.equal(r.loggedOut, false); assert.equal(r.totpOffered, true);
    }
    assert.ok(!(observed.get('none') as { options: string[] }).options.some(o => o.startsWith('Passkey')));
    assert.equal(observed.get('TOTP via manual key after passkey failures'), 'OK');
  } finally { await browser.close(); await ch.close(); }
});
