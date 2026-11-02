import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer as probe } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page } from '@playwright/test';
import { AppError } from '../../src/shared/errors.js';
import { today } from '../../src/modules/obligations/calendar.js';
import { s13Profile, world } from './fixture.js';

const repoRoot = resolve(process.cwd(), '../..');
const captureDir = join(repoRoot, 'Construccion/Sprints/S13/Evidencias/S13-P03-CAPTURES');
const receiptPath = join(repoRoot, 'Construccion/Sprints/S13/Evidencias/S13-P03-JOURNEY.json');
const clientRoot = resolve(process.cwd(), '../cliente');
const blocked = new Set([27017, 27181, 3001, 3002, 4001]);

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year!, (month ?? 1) - 1, (day ?? 1) + days)).toISOString().slice(0, 10);
}

async function reservePort(): Promise<number> {
  const server = probe().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = address && typeof address !== 'string' ? address.port : 0;
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  if (!port || blocked.has(port)) throw Error('Protected test port');
  return port;
}

function waitForVite(port: number, cert: Buffer): Promise<void> {
  const deadline = Date.now() + 40000;
  return new Promise((resolveReady, reject) => {
    const ping = () => {
      const req = httpsRequest({ hostname: 'localhost', port, path: '/', method: 'GET', ca: cert, servername: 'localhost' }, res => { res.resume(); resolveReady(); });
      req.on('error', () => { if (Date.now() > deadline) reject(Error('Vite did not listen')); else setTimeout(ping, 400); });
      req.end();
    };
    ping();
  });
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(captureDir, name), fullPage: true });
  return name;
}

async function fillFractions(page: Page) {
  for (const [kind, collection] of [['Prudente', '0.5'], ['Base', '0.8'], ['Favorable', '1']] as const) {
    await page.getByLabel(`Fracción de recaudo, ${kind}`).fill(collection);
    await page.getByLabel(`Días de retraso, ${kind}`).fill('0');
    await page.getByLabel(`Fracción de recuperación, ${kind}`).fill('0');
    await page.getByLabel(`Días de espera de la recuperación, ${kind}`).fill('0');
    await page.getByLabel(`Proyección de interés, ${kind}`).selectOption('DECLARED_SCHEDULE_ONLY');
  }
}

test('S13-P03 shows the linked purchase and a real deficit on its own API group', { timeout: 480000 }, async () => {
  const totalStarted = performance.now();
  const bogota = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const purchaseDate = addDays(bogota, 1);
  const outDate = addDays(bogota, 16);
  const inDate = addDays(bogota, 28);
  const receipt: Record<string, unknown> = { task: 'S13-P03', startedAt: new Date().toISOString(), asOf: bogota, purchaseDate, outDate, inDate, captures: [], financialPosts: [], negatives: {}, limits: [], zoom: {} };
  const group = await s13Profile();
  let browser: Browser | undefined;
  let vite: ChildProcess | undefined;
  let page: Page | undefined;
  let viteLog = '';
  const financial: string[] = [];
  try {
    const f = await world(group, Date.parse(bogota + 'T23:20:00-05:00'));
    assert.equal(today(f.now()), bogota);
    const uiPort = await reservePort();
    const api = await f.https('https://localhost:' + uiPort);
    if (api.port === uiPort || blocked.has(api.port)) throw Error('Protected API port');
    vite = spawn('node', [join(clientRoot, 'node_modules/vite/bin/vite.js'), '--host', 'localhost', '--strictPort'], {
      cwd: clientRoot,
      env: { ...process.env, CAUDELYX_DEV_UI_PORT: String(uiPort), CAUDELYX_DEV_API_PORT: String(api.port), CAUDELYX_DEV_TLS_DIRECTORY: f.folder },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    vite.stdout?.on('data', chunk => { viteLog = (viteLog + String(chunk)).slice(-2000); });
    vite.stderr?.on('data', chunk => { viteLog = (viteLog + String(chunk)).slice(-2000); });
    const viteStarted = performance.now();
    await waitForVite(uiPort, api.cert);
    receipt['viteMs'] = Math.round(performance.now() - viteStarted);
    receipt['ports'] = { ui: uiPort, api: api.port };
    await mkdir(captureDir, { recursive: true });
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ name: '__Host-caudelyx-session', value: f.a.issued.token, url: 'https://localhost:' + uiPort + '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
    page = await context.newPage();
    page.on('pageerror', error => { receipt['pageError'] = String(error).slice(0, 300); });
    page.on('request', request => {
      if (request.method() === 'GET' || request.method() === 'HEAD' || request.method() === 'OPTIONS') return;
      const path = new URL(request.url()).pathname;
      if (path.includes('/simulation-s12/') || path.startsWith('/api/v1/auth/')) return;
      financial.push(request.method() + ' ' + path);
    });
    await page.goto('https://localhost:' + uiPort + '/#/simulacion', { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Simulación' }).waitFor({ timeout: 20000 });
    await page.getByText(/Uso real permitido: no/).waitFor();
    await page.getByText(/no habilita piloto externo/i).waitFor();
    assert.equal(await page.getByRole('button', { name: /aplicar|desplegar/i }).count(), 0);
    await page.setViewportSize({ width: 360, height: 800 });
    const captures = [await shot(page, '01-ambito-360.png')];
    await page.setViewportSize({ width: 390, height: 844 });
    captures.push(await shot(page, '02-ambito-390.png'));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.keyboard.press('Tab');
    receipt['keyboardFocus'] = await page.evaluate(() => document.activeElement?.tagName ?? 'none');
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
      const scale = await page.evaluate(() => window.visualViewport?.scale ?? null);
      receipt['zoom'] = { method: 'CDP Emulation.setPageScaleFactor 2', visualViewportScale: scale, nativeOsZoom: false };
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }).catch(() => undefined);
    } catch (error) {
      receipt['zoom'] = { method: 'CDP Emulation.setPageScaleFactor 2', error: String(error).slice(0, 300), nativeOsZoom: false };
    }
    const sameSession = await context.newPage();
    await sameSession.goto('https://localhost:' + uiPort + '/#/simulacion', { waitUntil: 'domcontentloaded' });
    await sameSession.getByRole('heading', { name: 'Simulación' }).waitFor({ timeout: 20000 });
    const stranger = await browser.newContext({ ignoreHTTPSErrors: true });
    const otherPage = await stranger.newPage();
    await otherPage.goto('https://localhost:' + uiPort + '/#/simulacion', { waitUntil: 'domcontentloaded' });
    await otherPage.getByRole('button', { name: 'Iniciar sesión' }).waitFor({ timeout: 15000 });
    assert.equal(await otherPage.getByRole('button', { name: 'Capturar base' }).count(), 0);
    await stranger.close();
    receipt['secondContext'] = 'login-without-cookie';
    receipt['secondTab'] = 'same-context-page-opened';
    await page.getByRole('button', { name: 'Capturar base' }).click();
    await page.getByText(/Base capturada el/).waitFor({ timeout: 20000 });
    await page.getByLabel('Nombre de la hipótesis').fill('Compra vinculada sintetica');
    await page.getByLabel('Horizonte en días').fill('30');
    await page.getByLabel('Presupuesto declarado').fill('80000000.00');
    await fillFractions(page);
    await page.getByRole('checkbox', { name: 'Configurar Compra de activo' }).check();
    await page.getByLabel('Fecha, Compra de activo').fill(purchaseDate);
    await page.getByLabel('Costo bruto de compra').fill('200000000.00');
    await page.getByLabel('Caja propia para la compra').fill('80000000.00');
    await page.getByLabel('Deuda propia para la compra').fill('120000000.00');
    await page.getByLabel('Fracción de propiedad').fill('1');
    await page.getByLabel('Fracción de vacancia').fill('0');
    await page.getByLabel('Valor bruto estimado').fill('220000000.00');
    await page.getByRole('checkbox', { name: /Acreedor paga directamente/ }).uncheck();
    await page.getByRole('button', { name: 'Calcular hipótesis' }).click();
    await page.getByRole('heading', { name: 'Corrida versión 1' }).waitFor({ timeout: 60000 });
    const purchase = page.getByRole('listitem').filter({ hasText: 'Base, Compra de activo' }).first();
    await purchase.waitFor({ timeout: 20000 });
    await purchase.getByText(/no se sustituye por cero/).waitFor();
    assert.equal(await purchase.getByText(/Primer déficit de la hipótesis:/).count(), 0);
    await page.getByLabel('Resultado que se lee en la lista').selectOption({ label: 'Base / Compra de activo' });
    await page.getByRole('row', { name: /Deuda/ }).getByText('120000000.00').waitFor();
    await page.getByRole('row', { name: /Caja mínima de la hipótesis/ }).getByText('0.00').waitFor();
    await page.getByRole('row', { name: /Déficit máximo de la hipótesis/ }).getByText('0.00').waitFor();
    await page.getByRole('row', { name: /Patrimonio de libro/ }).getByText('80000000.00').waitFor();
    await page.getByRole('row', { name: /Valor indicativo/ }).getByText('100000000.00').waitFor();
    await page.getByRole('listitem').filter({ hasText: 'No simulable' }).first().waitFor();
    captures.push(await shot(page, '03-compra.png'));
    assert.equal(await sameSession.getByText('120000000.00').count(), 0);
    f.clock.value += 61000;
    await page.getByLabel('Fecha de salida declarada, Base').fill(outDate);
    await page.getByLabel('Importe de salida declarada, Base').fill('80000001.00');
    await page.getByLabel('Fecha de entrada declarada, Base').fill(inDate);
    await page.getByLabel('Importe de entrada declarada, Base').fill('30000000.00');
    await page.getByLabel('Referencia de la hipótesis, Base').fill('SIN-SOPORTE-OFICIAL');
    await page.getByRole('button', { name: 'Crear otra versión' }).click();
    await page.getByRole('listitem').filter({ hasText: `Primer déficit de la hipótesis: ${outDate}` }).first().waitFor({ timeout: 60000 });
    captures.push(await shot(page, '04-deficit.png'));
    const collaborator = await f.actor();
    const invite = { email: collaborator.email, roleIds: ['C'] };
    await f.proof(f.a, 'MEMBER_INVITE', invite, f.org);
    await f.runtime.organizations.invite(f.a.issued.context, invite);
    await f.identity.dispatchMail();
    const mail = [...f.messages.notificationInbox.values()].find(item => item.kind === 'INVITATION' && item.payload['email'] === collaborator.email);
    assert.ok(mail);
    await f.runtime.organizations.accept(collaborator.issued.context, { mode: 'CONFIRM', token: String(mail.payload['token']) }, randomUUID());
    await assert.rejects(() => f.runtime.simulation.execute(collaborator.issued.context, 'captureBaseBusinessSimulation', { asOf: bogota, currency: 'COP' }, { organizationId: f.org }, {}, randomUUID()), (error: unknown) => error instanceof AppError && (error.status === 403 || error.status === 404));
    (receipt['negatives'] as Record<string, string>)['collaborator'] = 'denied';
    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await sameSession.getByRole('button', { name: 'Iniciar sesión' }).waitFor({ timeout: 15000 });
    assert.equal(await sameSession.getByText('120000000.00').count(), 0);
    receipt['secondTab'] = 'logout-cleared-the-other-page';
    receipt['financialPosts'] = financial;
    assert.deepEqual(financial, []);
    receipt['captures'] = captures;
    receipt['h02Live'] = 'not-executed: this group has no captured principal inflow to reference; the branch sentence is covered by the identified unit test';
    receipt['limits'] = ['CDP page scale is not the operating-system 200% zoom.', 'Viewports 360 and 390 are layout checks.', 'A context without the cookie is not a second tab.', 'The owner did not run a manual task.', 'MEJ manual remains without a report.'];
    receipt['status'] = 'passed';
    receipt['totalMs'] = Math.round(performance.now() - totalStarted);
  } catch (error) {
    receipt['status'] = 'failed';
    receipt['error'] = String(error).slice(0, 800);
    if (page) await shot(page, 'fallo.png').catch(() => undefined);
    throw error;
  } finally {
    receipt['viteLog'] = viteLog.slice(-800);
    if (browser) await browser.close().catch(() => undefined);
    if (vite && vite.exitCode === null) {
      vite.kill();
      await once(vite, 'exit').catch(() => undefined);
    }
    await group.dispose();
    receipt['finishedAt'] = new Date().toISOString();
    await mkdir(join(receiptPath, '..'), { recursive: true });
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  }
});
