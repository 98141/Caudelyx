/* Browser walk for S07-P03 against this package's own Mongo group. Not an economic unit mock. */
import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { p03Profile } from './p03-profile.mjs';
import { cashSetup } from '../../../servidor/dist-s07/tests/s07/fixture.js';
const { generate } = await import(pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../../../servidor/node_modules/otplib/dist/index.js')).href);

const here = dirname(fileURLToPath(import.meta.url));
const evidence = resolve(here, '../../../../Construccion/Sprints/S07/Evidencias');
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
  await context.addCookies(cookie(f.c.issued.token, origin));
  const page = await context.newPage();
  page.on('request', request => {
    if (request.method() !== 'GET' && request.url().includes('/actions')) console.log('ACTION', request.postData());
  });
  page.on('response', response => {
    if (response.request().method() !== 'GET' && response.status() >= 400) {
      void response.text().then(body => console.log('HTTP', response.status(), response.url(), body.slice(0, 300))).catch(() => {});
    }
  });
  await page.clock.install({ time: new Date('2026-10-31T17:00:00Z') });
  await page.goto(origin + '/#/cobranza', { waitUntil: 'domcontentloaded' });
  await page.clock.setFixedTime(new Date('2026-10-31T17:00:00.000Z'));
  console.log('page-now', await page.evaluate(() => new Date().toISOString()));
  await page.getByRole('heading', { name: 'Cobranza y caja' }).waitFor();
  await page.getByText('Confirmado en el sitio', { exact: true }).waitFor();
  await page.getByLabel('Soporte').fill('SOP-S07');
  await page.getByRole('button', { name: 'Abrir la jornada' }).click();
  await page.getByText(/Jornada abierta/).waitFor();
  await page.getByLabel('Préstamo de la gestión').selectOption({ index: 1 });
  await page.getByLabel('Nota').fill('Pasó a dejar el efectivo');
  await page.getByRole('cell').first().waitFor();
  await page.getByRole('button', { name: 'Registrar la gestión' }).click();
  await page.getByText('Pasó a dejar el efectivo').waitFor();
  mark('journey-note');
  await page.getByLabel('Caja de destino').selectOption({ index: 1 });
  await page.getByLabel('Lote confirmado').selectOption({ index: 1 });
  await page.getByLabel('Importe a entregar').fill('250000');
  await page.getByRole('button', { name: 'Pedir el plan de entrega' }).click();
  await page.getByText('Plan sin efecto.').waitFor();
  await page.getByRole('checkbox', { name: /Confirmo este plan del servidor/ }).check();
  await page.getByRole('button', { name: 'Solicitar la entrega' }).click();
  await page.getByRole('button', { name: 'Despachar' }).waitFor();
  const dispatched = page.waitForResponse(response => response.url().includes('/dispatch') && response.ok());
  await page.getByRole('button', { name: 'Despachar' }).click();
  await dispatched;
  mark('dispatched-250');
  await page.screenshot({ path: resolve(evidence, 'S07-P03-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(evidence, 'S07-P03-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  const receiverContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  await receiverContext.addCookies(cookie(f.o.issued.token, origin));
  const receiver = await receiverContext.newPage();
  await receiver.clock.install({ time: new Date('2026-10-31T17:00:00Z') });
  await receiver.goto(origin + '/#/cobranza', { waitUntil: 'domcontentloaded' });
  await receiver.clock.setFixedTime(new Date('2026-10-31T17:00:00.000Z'));
  await receiver.getByRole('heading', { name: 'Cobranza y caja' }).waitFor();
  await receiver.getByRole('cell', { name: 'En tránsito' }).waitFor();
  await receiver.getByRole('button', { name: 'Abrir', exact: true }).click();
  await receiver.getByLabel('Soporte').fill('SOP-S07');
  await receiver.getByRole('button', { name: 'Recibir para conteo' }).click();
  await receiver.getByLabel('Importe contado').waitFor();
  await receiver.getByLabel('Importe contado').fill('250000');
  await receiver.getByRole('button', { name: 'Registrar el conteo' }).click();
  await receiver.getByText('Contada').first().waitFor();
  mark('counted');

  const titularContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  await titularContext.addCookies(cookie(f.a.issued.token, origin));
  const titular = await titularContext.newPage();
  await titular.clock.install({ time: new Date('2026-10-31T17:00:00Z') });
  await titular.goto(origin + '/#/cobranza', { waitUntil: 'domcontentloaded' });
  await titular.clock.setFixedTime(new Date('2026-10-31T17:00:00.000Z'));
  await titular.getByRole('cell', { name: 'Contada' }).waitFor();
  await titular.getByRole('button', { name: 'Abrir', exact: true }).click();
  await titular.getByLabel('Soporte').fill('SOP-S07');
  await titular.getByRole('button', { name: 'Pedir el plan de confirmación' }).click();
  await titular.getByText('Plan sin efecto.').waitFor();
  await titular.getByRole('checkbox', { name: /Confirmo este plan del servidor/ }).check();
  await titular.getByRole('button', { name: 'Confirmar la entrega' }).click();
  const codeField = titular.getByLabel('Código de 6 dígitos');
  const confirmed = titular.getByText('Estado: Confirmada');
  await Promise.race([codeField.waitFor(), confirmed.waitFor()]);
  if (await codeField.isVisible().catch(() => false)) {
    f.clock.value += 30000;
    await codeField.fill(await generate({ secret: f.a.secret, epoch: Math.floor(f.now() / 1000) }));
    await titular.getByRole('button', { name: 'Confirmar', exact: true }).click();
    await confirmed.waitFor();
  }
  mark('confirmed');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Copiar lo esperado del servidor' }).click();
  await page.getByRole('button', { name: 'Declarar el arqueo' }).click();
  await page.getByText(/Arqueo declarado/).waitFor();
  mark('counted-close');
  await writeFile(resolve(evidence, 'S07-P03-WALK.json'), JSON.stringify({ runId: f.org, organization: f.org, httpsPort: https.port, durationMs: Date.now() - started, steps, nativeZoom: 'not-available', viewportMobile: 390 }, null, 2));
} catch (error) {
  if (browser) {
    const pages = browser.contexts().flatMap(item => item.pages());
    const current = pages.at(-1);
    if (current) {
      await current.screenshot({ path: resolve(evidence, 'S07-P03-failure.png'), fullPage: true }).catch(() => {});
      console.log(await current.locator('body').innerText().catch(() => ''));
    }
  }
  throw error;
} finally {
  await browser?.close().catch(() => {});
  await group.dispose();
}
