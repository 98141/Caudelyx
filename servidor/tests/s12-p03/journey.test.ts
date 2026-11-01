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
import { s12Profile, world } from './fixture.js';

const repoRoot = resolve(process.cwd(), '../..');
const captureDir = join(repoRoot, 'Construccion/Sprints/S12/Evidencias/S12-P03-CAPTURES');
const receiptPath = join(repoRoot, 'Construccion/Sprints/S12/Evidencias/S12-P03-JOURNEY.json');
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

test('S12-P03 walks the local simulation screen against its own API group', { timeout: 480000 }, async () => {
  const totalStarted = performance.now();
  const bogota = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const outDate = addDays(bogota, 16);
  const inDate = addDays(bogota, 28);
  const receipt: Record<string, unknown> = { task: 'S12-P03', startedAt: new Date().toISOString(), asOf: bogota, outDate, inDate, captures: [], financialPosts: [], negatives: {}, limits: [] };
  const group = await s12Profile();
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
    await page.getByText(/no es dinero disponible hoy/i).waitFor();
    assert.equal(await page.getByRole('button', { name: /aplicar/i }).count(), 0);
    await page.setViewportSize({ width: 360, height: 800 });
    const captures = [await shot(page, '01-ambito-360.png')];
    await page.setViewportSize({ width: 390, height: 844 });
    captures.push(await shot(page, '02-ambito-390.png'));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.keyboard.press('Tab');
    receipt['keyboardFocus'] = await page.evaluate(() => { const node = document.activeElement; return node ? node.tagName : 'none'; });
    const stranger = await browser.newContext({ ignoreHTTPSErrors: true });
    const otherPage = await stranger.newPage();
    await otherPage.goto('https://localhost:' + uiPort + '/#/simulacion', { waitUntil: 'domcontentloaded' });
    await otherPage.getByRole('button', { name: 'Iniciar sesión' }).waitFor({ timeout: 15000 });
    assert.equal(await otherPage.getByRole('button', { name: 'Capturar base' }).count(), 0);
    await stranger.close();
    receipt['secondContext'] = 'login-without-cookie';
    await page.getByRole('button', { name: 'Capturar base' }).click();
    await page.getByText(/Base capturada el/).waitFor({ timeout: 20000 });
    await page.getByLabel('Nombre de la hipótesis').fill('Hipotesis sintetica');
    await page.getByLabel('Horizonte en días').fill('30');
    await page.getByLabel('Presupuesto declarado').fill('0.00');
    const rows = [
      ['Prudente', '0.5', '5', '0', '0'],
      ['Base', '0.8', '0', '0', '0'],
      ['Favorable', '1', '0', '0', '0'],
    ] as const;
    for (const [kind, collection, delay, recovery, wait] of rows) {
      await page.getByLabel(`Fracción de recaudo, ${kind}`).fill(collection);
      await page.getByLabel(`Días de retraso, ${kind}`).fill(delay);
      await page.getByLabel(`Fracción de recuperación, ${kind}`).fill(recovery);
      await page.getByLabel(`Días de espera de la recuperación, ${kind}`).fill(wait);
      await page.getByLabel(`Proyección de interés, ${kind}`).selectOption('DECLARED_SCHEDULE_ONLY');
    }
    await page.getByLabel('Fecha de salida declarada, Base').fill(outDate);
    await page.getByLabel('Importe de salida declarada, Base').fill('20000001.00');
    await page.getByLabel('Fecha de entrada declarada, Base').fill(inDate);
    await page.getByLabel('Importe de entrada declarada, Base').fill('30000000.00');
    await page.getByLabel('Referencia de la hipótesis, Base').fill('SIN-SOPORTE-OFICIAL');
    await page.getByRole('button', { name: 'Calcular hipótesis' }).click();
    await page.getByRole('listitem').filter({ hasText: `Primer déficit: ${outDate}` }).first().waitFor({ timeout: 60000 });
    await page.getByRole('rowheader', { name: outDate }).waitFor();
    await page.getByRole('rowheader', { name: inDate }).waitFor();
    captures.push(await shot(page, '03-deficit.png'));
    await page.getByLabel('Días de retraso, Base').fill('5');
    await page.getByRole('button', { name: 'Crear otra versión' }).click();
    await page.getByRole('heading', { name: 'Corrida versión 2' }).waitFor({ timeout: 60000 });
    await page.getByRole('button', { name: 'Comparar estas corridas' }).click();
    await page.getByText('El servidor no señaló una alternativa mejor.').first().waitFor({ timeout: 20000 });
    captures.push(await shot(page, '04-comparacion.png'));
    await page.getByRole('button', { name: 'Evaluar alertas internas' }).click();
    await page.getByText('Advertencia hipotética').first().waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: 'Registrar lectura. Esto no paga.' }).first().click();
    await page.getByText('Lectura registrada. No se creó un pago.').waitFor({ timeout: 20000 });
    captures.push(await shot(page, '05-alerta.png'));
    const clockBeforeStale = f.clock.value;
    f.clock.value += 50 * 60 * 1000;
    await page.getByRole('button', { name: 'Actualizar resultados' }).click();
    await page.getByText('La base ya no es la de hoy. Estas cifras quedan como historia.').first().waitFor({ timeout: 20000 });
    f.clock.value = clockBeforeStale;
    await page.getByRole('radio', { name: 'Personal del titular' }).click();
    await page.getByRole('heading', { name: 'Corrida versión 1' }).waitFor({ state: 'detached', timeout: 10000 });
    await page.getByRole('button', { name: 'Capturar base' }).click();
    await page.getByText(/Base capturada el/).waitFor({ timeout: 20000 });
    assert.equal(await page.getByText('Hipotesis sintetica').count(), 0);
    receipt['financialPosts'] = financial;
    assert.deepEqual(financial, []);
    receipt['captures'] = captures;
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
    const foreign = await f.actor();
    await assert.rejects(() => f.runtime.simulation.execute(foreign.issued.context, 'listAlertsPersonalSimulation', {}, { bookId: f.book.id }, {}, ''), (error: unknown) => error instanceof AppError && (error.status === 403 || error.status === 404) && !String(error).includes(f.a.email));
    (receipt['negatives'] as Record<string, string>)['personal'] = 'hidden-from-other-actor';
    receipt['limits'] = ['OS zoom 200% was not driven. Viewports 360 and 390 are layout checks, not device zoom.', 'The second browser context has no cookie. It is not two tabs of the same signed-in session.', 'Screenshots do not include tokens or keys.'];
    receipt['status'] = 'passed';
  } catch (error) {
    receipt['status'] = 'failed';
    receipt['failure'] = String(error).slice(0, 800);
    receipt['viteLog'] = viteLog.slice(-800);
    receipt['financialPosts'] = financial;
    if (page) {
      receipt['alerts'] = await page.getByRole('alert').allInnerTexts().catch(() => []);
      receipt['body'] = (await page.locator('body').innerText().catch(() => '')).slice(0, 1500);
      await shot(page, 'fallo.png').catch(() => undefined);
    }
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    if (vite && vite.exitCode === null) {
      vite.kill();
      await once(vite, 'exit').catch(() => undefined);
    }
    let cleanup = 'not-run';
    try { await group.dispose(); cleanup = 'completed'; } catch (error) { cleanup = String(error).slice(0, 400); }
    receipt['cleanup'] = cleanup;
    receipt['totalMs'] = Math.round(performance.now() - totalStarted);
    await mkdir(captureDir, { recursive: true });
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  }
});
