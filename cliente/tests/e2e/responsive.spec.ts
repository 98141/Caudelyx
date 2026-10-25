import { expect, test } from '@playwright/test';

const widths = [360, 390, 768, 1024, 1440] as const;

test('pantalla pública en los anchos exigidos, teclado y zoom', async ({ page }) => {
  await page.goto('/#/ingresar');
  await expect(page.getByRole('heading', { name: 'Bienvenido de nuevo' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bienvenido de nuevo' })).toBeFocused();
  await expect(page.getByLabel('Contraseña')).toHaveValue('');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Correo')).toBeFocused();
  await page.getByRole('link', { name: 'Saltar al contenido' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 800 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflow).toBe(false);
  }
  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => { document.body.style.zoom = '2'; });
  const zoomed = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(zoomed).toBe(false);
  await page.evaluate(() => { document.body.style.zoom = '1'; });
});
