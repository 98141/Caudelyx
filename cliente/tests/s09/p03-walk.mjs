import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { p03Profile } from './p03-profile.mjs';

const started = Date.now();
const evidence = fileURLToPath(new URL('../../../../Construccion/Sprints/S09/Evidencias/', import.meta.url));
const steps = [];
const group = await p03Profile();
let browser;
try {
  const f = await group.fixture();
  steps.push({ step: 'group-ready', at: new Date().toISOString(), groupId: group.groupId });
  const a = await f.actor();
  const org = (await f.runtime.organizations.create(a.issued.context, { name: 'Organización sintética S09', currency: 'COP', timezone: 'America/Bogota' }, randomUUID())).data.organization.id;
  const account = async (code, accountClass, kind) => (await f.runtime.finance.mutate(a.issued.context, 'createAccount', org, { code, name: 'Cuenta sintética ' + code, currency: 'COP', accountClass, kind }, randomUUID())).data;
  const bank = await account('BANK_S09', 'ASSET', 'BANK');
  const equity = await account('EQUITY_S09', 'EQUITY', 'GENERAL');
  const capital = { currency: 'COP', effectiveDate: '2026-10-28', sourceId: randomUUID(), supportReference: 'SYN-S09-CAPITAL', description: 'Capital sintético S09', lines: [{ accountId: bank.id, debit: '20000000.00', credit: '0.00' }, { accountId: equity.id, debit: '0.00', credit: '20000000.00' }] };
  const key = randomUUID();
  await f.proof(a, 'FINANCE_JOURNAL_POST', { organizationId: org, idempotencyKey: key, payload: capital });
  await f.runtime.finance.mutate(a.issued.context, 'postJournal', org, capital, key);
  await f.restore.flush();
  const owner = async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const o = JSON.parse(await readFile(join(group.folder, 'owner.json'), 'utf8'));
    return o.pid === process.pid && o.runId === group.runId && o.names[0] === f.database.db.databaseName;
  };
  const { ProjectionRuntime } = await import('../../../../Caudelyx/servidor/dist-s09-backend/src/modules/reporting/projection/service.js');
  await f.runtime.obligations.prepareOwned(owner);
  const projection = await ProjectionRuntime.createOwned(f.identity, f.keys.cursor, owner);
  f.identity.reporting.projection = projection;
  await f.runtime.obligations.activateOwned(owner);
  steps.push({ step: 'seed-ready', organizationId: org });
  const https = await f.https();
  const origin = 'https://localhost:' + https.port;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: '__Host-caudelyx-session', value: a.issued.token, url: origin + '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  await page.goto(origin + '/#/obligaciones', { waitUntil: 'networkidle' });
  await page.getByLabel('Descripción').fill('Papel sintético');
  await page.getByRole('textbox', { name: 'Importe', exact: true }).fill('10000');
  await page.getByLabel('Soporte').fill('SYN-GASTO');
  await page.getByRole('button', { name: 'Registrar gasto' }).click();
  await page.getByText('Pendiente de pago.').waitFor({ timeout: 20000 });
  steps.push({ step: 'expense-planned' });
  await page.getByRole('button', { name: 'Personal' }).click();
  await page.getByRole('button', { name: 'Abrir libro personal' }).click();
  await page.getByText('Libro personal abierto.').waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'Ver consolidado privado' }).click();
  await page.getByRole('heading', { name: 'Consolidado privado' }).waitFor({ timeout: 20000 });
  steps.push({ step: 'personal-consolidation' });
  await page.getByRole('button', { name: 'Ver obligaciones' }).click();
  await page.getByLabel('Nombre').fill('Deuda sintética');
  await page.getByLabel('Referencia de la contraparte').fill('SYN-ACREEDOR');
  await page.getByRole('textbox', { name: 'Principal', exact: true }).fill('10000');
  await page.getByLabel('Valor decimal de la tasa').fill('0.00');
  await page.getByLabel('Fecha de referencia del calendario').fill('2026-09-28');
  await page.getByLabel('Interés de la cuota').fill('0');
  await page.getByLabel('Seguro').fill('0');
  await page.getByLabel('Cargos').fill('0');
  await page.getByLabel('Total declarado').fill('10000');
  await page.getByLabel('Soporte').fill('SYN-DEUDA');
  await page.getByRole('button', { name: 'Registrar obligación' }).click();
  await page.getByText('Deuda sintética').waitFor({ timeout: 30000 });
  await page.getByText(/Principal declarado 10\.000 COP/).waitFor({ timeout: 5000 });
  steps.push({ step: 'liability-official' });
  await page.screenshot({ path: join(evidence, 'S09-P03-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(evidence, 'S09-P03-mobile.png'), fullPage: true });
  steps.push({ step: 'screenshots', nativeZoom: 'not-available', viewportMobile: 390 });
  await writeFile(join(evidence, 'S09-P03-WALK.json'), JSON.stringify({ status: 'PASS', organizationId: org, https: https.port, durationMs: Date.now() - started, groupId: group.groupId, steps }, null, 2));
} catch (error) {
  const page = browser ? browser.contexts()[0]?.pages()[0] : undefined;
  if (page) {
    await page.screenshot({ path: join(evidence, 'S09-P03-failure.png'), fullPage: true }).catch(() => {});
    steps.push({ step: 'failed-text', text: (await page.locator('body').innerText().catch(() => '')).slice(0, 1500) });
  }
  steps.push({ step: 'failed', reason: String(error).slice(0, 500) });
  await writeFile(join(evidence, 'S09-P03-WALK.json'), JSON.stringify({ status: 'FAIL', durationMs: Date.now() - started, groupId: group.groupId, steps }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await group.dispose();
}
