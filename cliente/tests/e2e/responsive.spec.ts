import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { evidenceDir } from './fixtures';

const widths = [360, 390, 768, 1024, 1440] as const;

test('pantalla pública en los anchos exigidos, teclado y zoom', async ({ page }) => {
  await page.goto('/#/ingresar');
  await expect(page.getByRole('heading', { name: 'Ingresar' })).toBeVisible();
  await expect(page.getByLabel('Contraseña')).toHaveValue('');
  for (const width of widths) {
    await page.setViewportSize({ width, height: 800 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflow).toBe(false);
    await page.screenshot({ path: resolve(evidenceDir, `S01-P03-C04-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 800 });
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Saltar al contenido' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.evaluate(() => { document.body.style.zoom = '2'; });
  const zoomed = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(zoomed).toBe(false);
  await page.evaluate(() => { document.body.style.zoom = '1'; });
});
