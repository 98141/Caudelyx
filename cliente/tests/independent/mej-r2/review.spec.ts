import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';

const own = JSON.parse(process.env.MEJR2_CONTEXT ?? 'null') as { email: string; password: string } | null;
if (!own) throw new Error('No own MEJ-R2 fixture');
const evidence = resolve('../../Construccion/Sprints/MEJ/Evidencias');

async function shot(page: Page, name: string, widths: number[]) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({
      path: resolve(evidence, `MEJ-R2-${name}-${width}.png`),
      fullPage: true,
      mask: [page.locator('input[type="password"], input[autocomplete="one-time-code"], .qr-frame, .manual-key')],
    });
  }
}

test('MEJ-R2 navegador: borrador, modal, saldo y cinco pasos', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  let activity = 0;
  let organizationGets = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/auth/session/activity')) activity += 1;
    if (request.method() === 'GET' && request.url().endsWith('/organization')) organizationGets += 1;
  });
  await page.goto('/#/ingresar');
  await page.getByLabel('Correo', { exact: true }).fill(own.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(own.password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await expect(page).toHaveURL(/#\/inicio/);
  await expect(page.getByRole('listitem')).toHaveCount(5);
  await expect(page.getByText('Crear la organización')).toBeVisible();
  await expect(page.getByText('Crear una caja o un banco')).toBeVisible();
  await expect(page.getByText('Registrar el saldo inicial')).toBeVisible();
  await expect(page.getByText('Registrar un prestatario')).toBeVisible();
  await expect(page.getByText('Crear un préstamo')).toBeVisible();
  await shot(page, 'home', [360, 768, 1440]);

  await page.clock.install();
  await page.goto('/#/finanzas');
  await page.getByRole('tab', { name: 'Movimientos', exact: true }).click();
  const journal = page.getByRole('region', { name: 'Asiento', exact: true });
  await journal.getByLabel('Soporte', { exact: true }).fill('SYN-R2-DRAFT');
  await journal.getByLabel('Descripción', { exact: true }).fill('Borrador R2 que permanece');
  await journal.getByRole('combobox', { name: 'línea 1', exact: true }).click();
  await page.getByRole('option', { name: /R2CASH/ }).click();
  await journal.getByLabel('Importe', { exact: true }).nth(0).fill('10');
  await journal.getByRole('combobox', { name: 'línea 2', exact: true }).click();
  await page.getByRole('option', { name: /R2BANK/ }).click();
  await journal.getByLabel('Importe', { exact: true }).nth(1).fill('10');
  const orgBefore = organizationGets;
  await expect.poll(() => activity).toBeGreaterThan(0);
  expect(organizationGets).toBe(orgBefore);
  await expect(journal.getByLabel('Descripción', { exact: true })).toHaveValue('Borrador R2 que permanece');
  await expect(journal.getByLabel('Soporte', { exact: true })).toHaveValue('SYN-R2-DRAFT');
  await expect(page.getByRole('tab', { name: 'Movimientos', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Cuentas', exact: true }).click();
  await page.getByRole('tab', { name: 'Movimientos', exact: true }).click();
  await expect(journal.getByLabel('Descripción', { exact: true })).toHaveValue('Borrador R2 que permanece');
  await page.clock.fastForward(61_000);
  const prior = activity;
  const extended = page.waitForResponse(response => response.url().endsWith('/auth/session/activity') && response.ok());
  await journal.getByLabel('Importe', { exact: true }).nth(0).click();
  await extended;
  await expect.poll(() => activity).toBeGreaterThan(prior);
  await expect(journal.getByLabel('Descripción', { exact: true })).toHaveValue('Borrador R2 que permanece');
  await page.clock.fastForward(3_500_000);
  const stay = page.getByRole('button', { name: 'Seguir conectado', exact: true });
  await expect(stay).toBeVisible();
  const beforeStay = activity;
  const stayed = page.waitForResponse(response => response.url().endsWith('/auth/session/activity') && response.request().method() === 'POST');
  await stay.dispatchEvent('click');
  await stayed;
  await expect.poll(() => activity).toBe(beforeStay + 1);
  await expect(journal.getByLabel('Soporte', { exact: true })).toHaveValue('SYN-R2-DRAFT');
  await shot(page, 'finance', [360, 768, 1440]);

  await journal.getByRole('button', { name: 'Contabilizar asiento', exact: true }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByRole('button', { name: 'Confirmar', exact: true })).toBeEnabled();
  await expect(modal.getByRole('button', { name: 'Pedir código' })).toHaveCount(0);
  await shot(page, 'modal', [360, 768, 1440]);
  await modal.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(journal.getByLabel('Descripción', { exact: true })).toHaveValue('Borrador R2 que permanece');

  await page.getByRole('tab', { name: 'Resumen', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Registrar saldo inicial' })).toBeVisible();
  const gap = await page.locator('[aria-labelledby="saldo-inicial"]').evaluate(node => {
    const style = getComputedStyle(node);
    return { margin: Number.parseFloat(style.marginBlockStart), border: style.borderBlockStartWidth };
  });
  expect(gap.margin).toBeGreaterThanOrEqual(24);
  expect(gap.border).not.toBe('0px');
  const opening = page.locator('[aria-labelledby="saldo-inicial"]');
  await opening.getByLabel('Soporte', { exact: true }).fill('SYN-R2-INITIAL');
  await opening.getByRole('combobox', { name: 'cuenta 1', exact: true }).click();
  await page.getByRole('option', { name: /R2CASH/ }).click();
  await opening.getByLabel('Monto', { exact: true }).fill('100');
  await opening.getByRole('button', { name: 'Añadir fila', exact: true }).click();
  await opening.getByRole('combobox', { name: 'cuenta 2', exact: true }).click();
  await page.getByRole('option', { name: /R2BANK/ }).click();
  await opening.getByLabel('Monto', { exact: true }).nth(1).fill('25,50');
  await opening.getByRole('button', { name: 'Revisar', exact: true }).click();
  await shot(page, 'initial', [360, 768, 1440]);
  await opening.getByRole('button', { name: 'Registrar', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Saldo inicial registrado. El servidor confirmó el asiento. Un saldo nuevo se registra con un asiento normal.')).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await page.screenshot({ path: resolve(evidence, 'MEJ-R2-zoom200.png'), fullPage: false, mask: [page.locator('input[type="password"]')] });
  await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  await page.clock.resume();
  await page.locator('main').focus();
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.tagName ?? 'NONE');
  expect(focused).not.toBe('BODY');
  expect(failures).toEqual([]);
});
