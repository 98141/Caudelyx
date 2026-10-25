// S05-P05-v2 copy (Claude, author) of S02-P05 historical spec s02/finance.spec.ts sha256 cdade1964a6dcc64… (original untouched).
// Mechanical changes: own S5 group a2f0795c4990bcb883a92572 via s05/review-profile, ports 5391/5491/5392, no writes into older evidence;
// label adaptations to the integrated S5 frontend are listed in S05-P05-v2-MATRIX.json (historical provenance).
// S02-P05 independent browser journey (Claude) against the REAL root launcher in the reserved profile (UI 5331 -> API 5431).
// Registration -> terminal mailbox (memory only) -> LINK -> TOTP with the manual key -> organization -> finance with es-CO
// amounts, client/server rejections, wrong factor, transfer, compensation, balances, keyboard, widths. Every R uses a fresh
// TOTP step. Node-only modules are loaded dynamically so this file does not change the client app typecheck.
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'synthetic P05 browser passphrase 2468';
const nodeProcess = (globalThis as unknown as { process: { env: Record<string, string | undefined>; execPath: string; cwd(): string; chdir(d: string): void } }).process;
const here = (relative: string) => new URL(relative, import.meta.url);
const RUN_ID = 'a2f0795c4990bcb883a92572';
type Group = { dispose(reason?: string): Promise<void> };
let group: Group | undefined;
let runner: { send(m: string): void; exitCode: number | null; on(e: string, f: (m: unknown) => void): void; once(e: string, f: (c: unknown) => void): void; stdout: { resume(): void } | null; stderr: { resume(): void } | null; kill(): void } | undefined;
const evidence = (name: string, data: Record<string, unknown>) => console.log(JSON.stringify({ evidence: name, ...data }));
async function path(relative: string): Promise<string> { const url = await import('node:url' as string) as { fileURLToPath(u: URL): string }; return url.fileURLToPath(here(relative)); }
function environment() {
  const e: Record<string, string | undefined> = { ...nodeProcess.env, CAUDELYX_MODE: 'local-synthetic', CAUDELYX_DEV_TEST_ID: RUN_ID, CAUDELYX_DEV_UI_PORT: '5391', CAUDELYX_DEV_API_PORT: '5491', CAUDELYX_DEV_PLATFORM_PORT: '5392' };
  for (const k of ['MONGODB_URI', 'MONGODB_DATABASE', 'CAUDELYX_DEV_SMOKE']) delete e[k];
  return e;
}
async function startStack() {
  const cp = await import('node:child_process' as string) as { spawn(cmd: string, args: string[], o: Record<string, unknown>): NonNullable<typeof runner> };
  runner = cp.spawn(nodeProcess.execPath, ['scripts/dev.mjs'], { cwd: await path('../../../../'), env: environment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  runner.stdout?.resume(); runner.stderr?.resume(); // never echoed: no codes or links reach logs
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('own stack readiness timeout')), 90000);
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
    try { const code = (JSON.parse(out) as { messages: { purpose: string; code: string }[] }).messages.find(m => m.purpose === 'ACTIVATION')?.code; if (code) return code; } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('synthetic mailbox unavailable');
}
// RFC 6238 TOTP via WebCrypto (SHA-1, 30 s, 6 digits); the secret only lives in this test's memory.
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
async function stepUp(page: Page, secret: string, button: string, suffix: string, method = 'POST') {
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: button, exact: true }) });
  await form.getByLabel('Contraseña actual').fill(PASSWORD);
  await form.getByLabel('Código TOTP vigente').fill(await freshCode(secret));
  const reply = page.waitForResponse(r => r.url().endsWith(suffix) && r.request().method() === method);
  await form.getByRole('button', { name: button, exact: true }).click();
  return await reply;
}

test.beforeAll(async () => {
  const cwd = nodeProcess.cwd(); nodeProcess.chdir(await path('../../../../servidor/'));
  try { const mod = await import(here('../../../../servidor/dist/tests/independent/s05/review-profile.js').href) as { reviewProfile(): Promise<Group> }; group = await mod.reviewProfile(); }
  finally { nodeProcess.chdir(cwd); }
  try { await startStack(); } catch (e) { try { await stopStack(); } finally { await group!.dispose('setup-error'); } throw e; }
});
test.afterAll(async () => {
  try { await stopStack(); } finally { const cwd = nodeProcess.cwd(); nodeProcess.chdir(await path('../../../../servidor/')); try { await group?.dispose('end'); } finally { nodeProcess.chdir(cwd); } }
});

test('P05-UI-01 es-CO finance journey with TOTP manual key: guidance before activation, exact amounts on the wire, client/server rejections, wrong factor without effect, transfer, compensation, balances, keyboard and widths', async ({ page }) => {
  const observed = new Map<string, unknown>(), financeRequests: { method: string; path: string; body: unknown }[] = [];
  page.on('request', r => { if (/\/financial\//.test(r.url()) && r.method() !== 'GET') financeRequests.push({ method: r.method(), path: new URL(r.url()).pathname.replace(/[0-9a-f-]{36}/g, '{id}'), body: r.postDataJSON() }); });
  const email = `p05ui_${Date.now()}@example.test`;
  await page.goto('/#/registro');
  await page.getByLabel('Correo').fill(email); await page.getByLabel('Nombre visible').fill('Persona P05 UI');
  await page.getByLabel('Contraseña').fill(PASSWORD); await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page.getByRole('heading', { name: 'Mi cuenta', exact: true })).toBeVisible();
  observed.set('guidance after signup', await page.getByText('Activa tu cuenta para continuar').count() > 0);
  await page.goto('/#/finanzas');
  observed.set('finance before activation', (await page.locator('main').textContent())?.includes('El libro no se consulta sin un factor comprobado') ?? false); // S5 adaptation A5: current pre-activation copy
  let code = await mailboxCode(email);
  await page.goto(`/#/activar?purpose=ACTIVATION&token=${code}`); code = '';
  await expect(page.getByRole('button', { name: 'Activar cuenta', exact: true })).toBeVisible();
  // Same-document hash navigation: read the live location, not Playwright's last navigation record.
  observed.set('fragment removed from URL', await page.evaluate(() => !location.href.includes('token=')));
  await page.getByRole('button', { name: 'Activar cuenta', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Proteger mi cuenta' })).toBeVisible();
  // S5 adaptation A1: the first factor now asks for the current password again.
  await page.getByLabel('Contraseña actual', { exact: true }).first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Preparar factor' }).click();
  let secret = ((await page.locator('p.manual-key').textContent()) ?? '').replace(/\s/g, '');
  await page.getByLabel('Código TOTP actual').fill(await freshCode(secret));
  await page.getByRole('button', { name: 'Confirmar TOTP' }).click();
  await expect(page.getByRole('link', { name: 'Continuar a la organización' })).toBeVisible();
  await page.goto('/#/organizacion'); await page.getByLabel('Nombre', { exact: true }).fill('Libro P05 independiente');
  const orgReply = await stepUp(page, secret, 'Crear organización', '/organizations'); observed.set('org created', orgReply.status());
  await page.getByRole('link', { name: 'Abrir el libro de cuentas' }).click();
  await expect(page.getByRole('button', { name: 'Crear cuenta contable' })).toBeVisible();
  await expect(page.getByText('Cargando cuentas y asientos…')).toBeHidden();
  const ids: Record<string, string> = {};
  for (const [codeName, name, kind, accountClass] of [['BANK_P5', 'Banco', 'BANK', 'ASSET'], ['CASH_P5', 'Caja', 'CASH', 'ASSET'], ['EQ_P5', 'Patrimonio', 'GENERAL', 'EQUITY']] as const) {
    await page.getByRole('textbox', { name: 'Código', exact: true }).fill(codeName); await page.getByRole('textbox', { name: 'Nombre', exact: true }).fill(name);
    await page.getByRole('combobox', { name: 'Tipo', exact: true }).selectOption(kind);
    if (kind === 'GENERAL') await page.getByRole('combobox', { name: 'Clase', exact: true }).selectOption(accountClass);
    const reply = await stepUp(page, secret, 'Crear cuenta contable', '/accounts'); expect(reply.status()).toBe(201);
    ids[codeName] = String(((await reply.json()) as { data: { id: string } }).data.id);
  }
  const journal = page.getByRole('region', { name: 'Asiento', exact: true });
  // S5 adaptation A2: the journal/transfer account pickers (S5 frontend) list the page loaded at mount; reload after creating accounts.
  await expect(journal.getByText('Cargando cuentas de línea 1…')).toHaveCount(0); await page.waitForTimeout(1500);
  observed.set('picker lists accounts created in this visit (before reload)', await journal.getByRole('button', { name: 'Elegir BANK_P5 para línea 1', exact: true }).count());
  await page.reload(); await expect(page.getByRole('button', { name: 'Crear cuenta contable' })).toBeVisible(); await expect(journal.getByText('Cargando cuentas de línea 1…')).toHaveCount(0);
  const fillLines = async (debit: string, credit: string) => {
    for (const [index, account, side, amount] of [[1, 'BANK_P5', 'debit', debit], [2, 'EQ_P5', 'credit', credit]] as const) {
      const line = journal.getByRole('group', { name: `Línea ${index}` });
      const choose = line.getByRole('button', { name: `Elegir ${account} para línea ${index}`, exact: true }); if (await choose.count()) await choose.click(); // S5 adaptation A3
      await line.getByLabel('Lado').selectOption(side); await line.getByLabel('Importe').fill(amount);
    }
    await journal.getByRole('textbox', { name: 'Soporte', exact: true }).fill('P05-UI-APORTE'); await journal.getByRole('textbox', { name: 'Descripción', exact: true }).fill('Aporte sintético P05');
  };
  // Client-side rejections never reach the API.
  const clientRejects: Record<string, string> = {};
  for (const [label, debit, credit] of [['three decimals', '1.999,505', '1.999,505'], ['dot as decimal', '12.34', '12.34'], ['unbalanced', '1.000', '999']] as const) {
    const sent = financeRequests.length; await fillLines(debit, credit);
    await journal.getByLabel('Contraseña actual').fill(PASSWORD); await journal.getByRole('button', { name: 'Contabilizar asiento' }).click(); await page.waitForTimeout(800);
    clientRejects[label] = `${financeRequests.length === sent ? 'no request' : 'REQUEST SENT'}; ${(await journal.getByRole('alert').allTextContents()).join(' | ').slice(0, 120)}`;
  }
  observed.set('client-side rejections', clientRejects);
  await fillLines('1.999,50', '1.999,50');
  const posted = await stepUp(page, secret, 'Contabilizar asiento', '/journal-entries');
  const postedLines = (posted.request().postDataJSON() as { lines: { debit: string; credit: string }[] }).lines.map(l => `${l.debit}/${l.credit}`);
  observed.set('posted', { status: posted.status(), wireLines: postedLines });
  await expect(page.getByRole('heading', { name: 'Asiento manual', level: 3 })).toBeVisible();
  const transfer = page.getByRole('region', { name: 'Transferencia', exact: true });
  await transfer.getByRole('button', { name: 'Elegir BANK_P5 para origen', exact: true }).click(); await transfer.getByRole('button', { name: 'Elegir CASH_P5 para destino', exact: true }).click(); // S5 adaptation A4
  await transfer.getByLabel('Importe').fill('25,50'); await transfer.getByRole('textbox', { name: 'Soporte', exact: true }).fill('P05-UI-TR'); await transfer.getByRole('textbox', { name: 'Descripción', exact: true }).fill('Traslado P05');
  // Wrong factor: R is not issued, no transfer request is accepted.
  const before = financeRequests.filter(r => r.path.endsWith('/transfers')).length;
  await transfer.getByLabel('Contraseña actual').fill(PASSWORD); await transfer.getByLabel('Código TOTP vigente').fill('000000');
  await transfer.getByRole('button', { name: 'Transferir', exact: true }).click(); await page.waitForTimeout(1500);
  observed.set('wrong TOTP', { transferRequests: financeRequests.filter(r => r.path.endsWith('/transfers')).length - before, alert: (await transfer.getByRole('alert').allTextContents()).join(' | ').slice(0, 120) });
  const moved = await stepUp(page, secret, 'Transferir', '/transfers');
  observed.set('transfer', { status: moved.status(), wireAmount: (moved.request().postDataJSON() as { amount: string }).amount });
  await page.getByRole('button', { name: 'Consultar saldo' }).click();
  const region = page.getByRole('region', { name: 'Saldo por fecha' });
  const shows = async (text: string) => await expect(region).toContainText(text, { timeout: 15000 }).then(() => true, () => false);
  observed.set('balances after transfer (UI)', { bank1974: await shows('BANK_P5 · Banco: 1.974 COP'), cash2550: await shows('CASH_P5 · Caja: 25,50 COP'), equity: await shows('EQ_P5 · Patrimonio: 1.999,50 COP') });
  await page.getByRole('heading', { name: 'Transferencia', level: 3 }).locator('xpath=..').getByRole('button', { name: 'Revertir este asiento' }).click();
  await page.getByLabel('Motivo de la reversión').fill('Compensación P05'); await page.getByLabel('Soporte de la reversión').fill('P05-UI-REV');
  const rev = await stepUp(page, secret, 'Crear compensación', '/reversals'); observed.set('reversal', rev.status());
  await expect(page.getByRole('heading', { name: 'Reversión', level: 3 })).toBeVisible();
  await page.getByRole('button', { name: 'Consultar saldo' }).click();
  observed.set('balances after compensation (UI)', { bank: await shows('BANK_P5 · Banco: 1.999,50 COP'), cashZero: await shows('CASH_P5 · Caja: 0 COP') });
  observed.set('original still listed with its reversal', await page.getByRole('heading', { name: 'Transferencia', level: 3 }).count() === 1 && await page.getByRole('heading', { name: 'Reversión', level: 3 }).count() === 1);
  // Keyboard: the primary account action is reachable with Tab from the page title.
  await page.locator('#page-title').focus(); let reached = false;
  for (let i = 0; i < 80 && !reached; i++) { await page.keyboard.press('Tab'); reached = await page.evaluate(() => document.activeElement?.textContent === 'Crear cuenta contable'); }
  observed.set('keyboard reaches Crear cuenta contable', reached);
  const layout: Record<string, boolean> = {};
  for (const width of [360, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    layout[String(width)] = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    if (width === 390 || width === 1440) {
      const filled = await page.evaluate(() => [...document.querySelectorAll('input[type=password]')].some(i => (i as HTMLInputElement).value !== ''));
      expect(filled).toBe(false);
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  }
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  layout['zoom 200% @1440'] = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  await page.evaluate(() => { document.documentElement.style.zoom = '1'; });
  observed.set('horizontal overflow by width', layout);
  observed.set('storage', await page.evaluate(() => localStorage.length + sessionStorage.length));
  observed.set('finance mutations sent', financeRequests.map(r => `${r.method} ${r.path}`));
  secret = '';
  evidence('P05-UI-01', { observed: Object.fromEntries(observed) });
  expect(observed.get('guidance after signup')).toBe(true); expect(observed.get('finance before activation')).toBe(true); expect(observed.get('fragment removed from URL')).toBe(true);
  expect(observed.get('org created')).toBe(201);
  for (const v of Object.values(clientRejects)) expect(v.startsWith('no request')).toBe(true);
  expect(observed.get('posted')).toEqual({ status: 201, wireLines: ['1999.50/0.00', '0.00/1999.50'] });
  expect((observed.get('wrong TOTP') as { transferRequests: number }).transferRequests).toBe(0);
  expect(observed.get('transfer')).toEqual({ status: 201, wireAmount: '25.50' });
  expect(observed.get('balances after transfer (UI)')).toEqual({ bank1974: true, cash2550: true, equity: true });
  expect(observed.get('reversal')).toBe(201); expect(observed.get('balances after compensation (UI)')).toEqual({ bank: true, cashZero: true });
  expect(observed.get('original still listed with its reversal')).toBe(true); expect(observed.get('keyboard reaches Crear cuenta contable')).toBe(true);
  for (const [k, v] of Object.entries(layout)) expect(v, k).toBe(false);
  expect(observed.get('storage')).toBe(0);
});
