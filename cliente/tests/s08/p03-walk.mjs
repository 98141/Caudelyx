/* Browser walk for S08-P03 against this package's own Mongo group. Not an economic unit mock. */
import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { p03Profile } from './p03-profile.mjs';
import { cashSetup } from '../../../servidor/dist-s08-projection/tests/s07/fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const evidence = resolve(here, '../../../../Construccion/Sprints/S08/Evidencias');
const { chromium } = await import(pathToFileURL(resolve(here, '../../node_modules/playwright/index.mjs')).href);
const started = Date.now();
const steps = [];
function mark(name, extra = {}) { steps.push({ name, at: new Date().toISOString(), ...extra }); }
function cookie(token, origin) {
  return [{ name: '__Host-caudelyx-session', value: token, url: origin + '/', secure: true, httpOnly: true, sameSite: 'Lax' }];
}

const group = await p03Profile();
let browser;
try {
  mark('group-ready');
  const f = await cashSetup(group, true, true);
  mark('seed-cash', { organization: f.org, paymentId: f.paymentId });
  const https = await f.https(true);
  const origin = 'https://localhost:' + https.port;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  await context.addCookies(cookie(f.a.issued.token, origin));
  const page = await context.newPage();
  page.on('response', response => {
    if (response.status() >= 400) void response.text().then(body => console.log('HTTP', response.status(), response.url(), body.slice(0, 240))).catch(() => {});
  });
  await page.clock.install({ time: new Date(f.now()) });
  await page.goto(origin + '/#/informes', { waitUntil: 'domcontentloaded' });
  await page.clock.setFixedTime(new Date(f.now()));
  await page.getByLabel('Desde').fill('2026-10-01');
  await page.getByLabel('Hasta').fill('2026-10-31');
  await page.getByLabel('Corte').fill('2026-10-31');
  await page.getByRole('button', { name: 'Consultar el tablero' }).click();
  await page.getByRole('heading', { name: 'Principal vivo' }).waitFor();
  mark('dashboard');
  await page.getByRole('button', { name: 'Ver el reporte' }).click();
  const portfolio = page.getByRole('table', { name: 'Cartera' });
  await portfolio.waitFor();
  await portfolio.getByRole('button').click();
  await page.getByRole('button', { name: 'Ver movimientos de este préstamo' }).click();
  await page.getByRole('table', { name: 'Movimientos' }).waitFor();
  mark('movements');
  await page.screenshot({ path: resolve(evidence, 'S08-P03-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(evidence, 'S08-P03-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  const requested = await (await f.request('250000.00')).execute();
  const deliveryId = requested.data.entityId;
  await f.act('dispatchCashDelivery', deliveryId, f.c);
  await f.act('receiveCashDelivery', deliveryId, f.o);
  await f.count(deliveryId, '230000.00', f.o);
  mark('counted-230');
  await page.clock.setFixedTime(new Date(f.now()));
  await page.goto(origin + '/#/cobranza', { waitUntil: 'domcontentloaded' });
  await page.getByRole('cell', { name: 'Con diferencia', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Abrir', exact: true }).click();
  await page.getByText(/Diferencia entre las dos cifras del servidor/).waitFor();
  await page.getByLabel('Soporte').first().fill('SYN-RETORNO');
  await page.getByRole('button', { name: 'Solicitar retorno' }).click();
  await page.getByText('Solicitud registrada; devolución pendiente. Cerrar esta pantalla no libera el efectivo.').waitFor();
  await page.getByText('Estado: Retorno pendiente').waitFor();
  const blocked = page.getByRole('button', { name: 'Confirmar retorno completo' });
  if (await blocked.isEnabled()) throw Error('Finalize was enabled before the return was received and counted');
  await page.getByText(/La finalización espera que el retorno esté recibido/).waitFor();
  const after = await f.delivery(deliveryId);
  const stored = await f.database.db.collection('cash_deliveries').findOne({ _id: deliveryId });
  if (after.state !== 'RETURN_REQUIRED' || after.amount !== '250000.00' || stored?.lastCount !== '230000.00' || stored?.returnFrom !== 'DISCREPANCY') {
    throw Error('Return request changed the delivery figures ' + JSON.stringify({ state: after.state, amount: after.amount, lastCount: stored?.lastCount, returnFrom: stored?.returnFrom }));
  }
  mark('return-requested', { state: after.state, amount: after.amount, lastCount: stored.lastCount, returnFrom: stored.returnFrom });
  await page.screenshot({ path: resolve(evidence, 'S08-P03-return.png'), fullPage: true });
  await writeFile(resolve(evidence, 'S08-P03-WALK.json'), JSON.stringify({
    organization: f.org, httpsPort: https.port, durationMs: Date.now() - started, steps,
    nativeZoom: 'not-available', viewportMobile: 390,
  }, null, 2));
} catch (error) {
  if (browser) {
    const pages = browser.contexts().flatMap(item => item.pages());
    if (pages[0]) await pages[0].screenshot({ path: resolve(evidence, 'S08-P03-failure.png'), fullPage: true }).catch(() => {});
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await group.dispose();
}
