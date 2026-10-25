import { createDecipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { enrollTotp, freshTotp, openActivation, PASSWORD } from './fixtures';

const here = dirname(fileURLToPath(import.meta.url));
const evidenceDir = resolve(here, '../../../../Construccion/Sprints/S02/Evidencias');
const serverRoot = resolve(here, '../../../servidor');

function unseal(value: string, key: Buffer): string {
  const bytes = Buffer.from(value, 'base64url');
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
}

async function activationToken(email: string): Promise<string> {
  const testId = process.env.CAUDELYX_DEV_TEST_ID ?? '';
  const descriptor = JSON.parse(await readFile(resolve(serverRoot, '.runtime/installed-tests', testId, 'descriptor.json'), 'utf8')) as { mongoUri: string; databaseName: string; keyringFile: string };
  const keys = JSON.parse(await readFile(descriptor.keyringFile, 'utf8')) as { mail: string };
  const mailKey = Buffer.from(keys.mail, 'base64url');
  const mongo = await import(pathToFileURL(resolve(serverRoot, 'node_modules/mongodb/lib/index.js')).href) as { MongoClient: new (uri: string) => { connect(): Promise<void>; close(): Promise<void>; db(name: string): { collection(name: string): { findOne(query: Record<string, unknown>): Promise<Record<string, unknown> | null>; find(query: Record<string, unknown>): { sort(order: Record<string, number>): { limit(count: number): { next(): Promise<Record<string, unknown> | null> } } } } } } };
  const client = new mongo.MongoClient(descriptor.mongoUri);
  await client.connect();
  try {
    const db = client.db(descriptor.databaseName);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const identity = await db.collection('identities').findOne({ email, realm: 'TENANT' });
      const message = identity ? await db.collection('synthetic_mail').find({ subjectId: identity['_id'], purpose: 'ACTIVATION' }).sort({ expiresAt: -1 }).limit(1).next() : null;
      if (message?.['encryptedToken']) return unseal(String(message['encryptedToken']), mailKey);
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
    }
    throw new Error('Activation token was not available');
  } finally { await client.close(); }
}

async function confirm(page: Page, secret: string, button: string, path: string): Promise<void> {
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: button, exact: true }) });
  let status = 0;
  for (let attempt = 0; attempt < 2 && status !== 200 && status !== 201; attempt += 1) {
    await form.getByLabel('Contraseña actual').fill(PASSWORD);
    await form.getByLabel('Código TOTP vigente').fill(await freshTotp(secret));
    const response = page.waitForResponse(item => item.url().endsWith(path) && item.request().method() === 'POST', { timeout: 30000 });
    await form.getByRole('button', { name: button, exact: true }).click();
    status = (await response).status();
  }
  expect(status === 200 || status === 201).toBe(true);
}

test('conecta cuentas, saldo, transferencia y reversión', async ({ page }) => {
  test.setTimeout(420000);
  const email = `s02p03_${Date.now()}@example.test`;
  let transferAmount = '';
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/transfers')) transferAmount = String((request.postDataJSON() as { amount?: string }).amount ?? '');
  });
  await page.goto('/#/registro');
  await expect(page.getByText(/npm run mailbox -- --email/)).toBeVisible();
  await page.getByLabel('Correo').fill(email);
  await page.getByLabel('Nombre visible').fill('Persona sintetica');
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page.getByRole('heading', { name: 'Mi cuenta', exact: true })).toBeVisible();
  await expect(page.getByText(/npm run mailbox -- --email/)).toBeVisible();
  await openActivation(page, 'ACTIVATION', await activationToken(email));
  await page.getByRole('button', { name: 'Activar cuenta' }).click();
  const secret = await enrollTotp(page);
  await page.goto('/#/organizacion');
  await page.getByLabel('Nombre').fill('Organizacion sintetica');
  await confirm(page, secret, 'Crear organización', '/organizations');
  await expect(page.getByRole('heading', { name: 'Organizacion sintetica' })).toBeVisible();
  await page.getByRole('link', { name: 'Abrir el libro de cuentas' }).click();
  await expect(page.getByRole('heading', { name: 'Finanzas' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Crear cuenta contable' })).toBeVisible();
  for (const width of [360, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: resolve(evidenceDir, `S02-P03-UI-${width}.png`), fullPage: false });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflow).toBe(false);
  }
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);
  await page.evaluate(() => { document.documentElement.style.zoom = '1'; });

  async function account(code: string, name: string, kind: string, accountClass: string) {
    await page.getByRole('textbox', { name: 'Código', exact: true }).fill(code);
    await page.getByRole('textbox', { name: 'Nombre', exact: true }).fill(name);
    await page.getByRole('combobox', { name: 'Tipo', exact: true }).selectOption(kind);
    if (kind === 'GENERAL') await page.getByRole('combobox', { name: 'Clase', exact: true }).selectOption(accountClass);
    await confirm(page, secret, 'Crear cuenta contable', '/accounts');
    await expect(page.getByRole('heading', { name: `${code} · ${name}` })).toBeVisible();
  }
  await account('BANK_01', 'Banco', 'BANK', 'ASSET');
  await account('CASH_01', 'Caja', 'CASH', 'ASSET');
  await account('EQUITY_01', 'Patrimonio', 'GENERAL', 'EQUITY');

  const journal = page.getByRole('region', { name: 'Asiento' });
  await journal.getByRole('group', { name: 'Línea 1' }).getByLabel('Cuenta').selectOption({ label: 'BANK_01 · Banco' });
  await journal.getByRole('group', { name: 'Línea 1' }).getByLabel('Importe').fill('100');
  await journal.getByRole('group', { name: 'Línea 2' }).getByLabel('Cuenta').selectOption({ label: 'EQUITY_01 · Patrimonio' });
  await journal.getByRole('group', { name: 'Línea 2' }).getByLabel('Lado').selectOption('credit');
  await journal.getByRole('group', { name: 'Línea 2' }).getByLabel('Importe').fill('100');
  await journal.getByRole('textbox', { name: 'Soporte', exact: true }).fill('SOPORTE-100');
  await journal.getByRole('textbox', { name: 'Descripción', exact: true }).fill('Aporte sintetico');
  await confirm(page, secret, 'Contabilizar asiento', '/journal-entries');
  await expect(page.getByRole('heading', { name: 'Asiento manual', level: 3 })).toBeVisible();

  await page.getByLabel('Fecha de corte').fill(await page.locator('input[type="date"]').first().inputValue());
  await page.getByRole('button', { name: 'Consultar saldo' }).click();
  await expect(page.getByText('BANK_01 · Banco: 100 COP')).toBeVisible();
  await expect(page.getByText('EQUITY_01 · Patrimonio: 100 COP')).toBeVisible();

  const transfer = page.getByRole('region', { name: 'Transferencia' });
  await transfer.getByLabel('Cuenta de origen').selectOption({ label: 'BANK_01 · Banco' });
  await transfer.getByLabel('Cuenta de destino').selectOption({ label: 'CASH_01 · Caja' });
  await transfer.getByLabel('Importe').fill('25,50');
  await expect(transfer.getByText('Se enviará 25.50 COP.')).toBeVisible();
  await transfer.getByRole('textbox', { name: 'Soporte', exact: true }).fill('SOPORTE-TR');
  await transfer.getByRole('textbox', { name: 'Descripción', exact: true }).fill('Traslado sintetico');
  await confirm(page, secret, 'Transferir', '/transfers');
  await expect(page.getByRole('heading', { name: 'Transferencia', level: 3 })).toBeVisible();
  expect(transferAmount).toBe('25.50');
  await page.getByRole('button', { name: 'Consultar saldo' }).click();
  await expect(page.getByText('BANK_01 · Banco: 74,50 COP')).toBeVisible();
  await expect(page.getByText('CASH_01 · Caja: 25,50 COP')).toBeVisible();

  await page.getByRole('heading', { name: 'Transferencia', level: 3 }).locator('xpath=..').getByRole('button', { name: 'Revertir este asiento' }).click();
  await page.getByLabel('Motivo de la reversión').fill('Compensacion sintetica');
  await page.getByLabel('Soporte de la reversión').fill('SOPORTE-REV');
  await confirm(page, secret, 'Crear compensación', '/reversals');
  await expect(page.getByRole('heading', { name: 'Reversión' })).toBeVisible();
  await page.getByRole('button', { name: 'Consultar saldo' }).click();
  await expect(page.getByText('BANK_01 · Banco: 100 COP')).toBeVisible();
  await expect(page.getByText(': 0 COP saldo del libro')).toBeVisible();
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});
