import { expect, test } from '@playwright/test';
import { enrollTotp, freshTotp, PASSWORD, registerAndActivate } from './fixtures';

test('TOTP real, sesión operativa y recuperación restringida', async ({ page }) => {
  const email = `p03_security_${Date.now()}@example.test`;
  await registerAndActivate(page, email);
  const secret = await enrollTotp(page);
  await page.goto('/#/seguridad');
  await expect(page.getByText('Sesión web')).toBeVisible();

  await page.getByRole('navigation', { name: 'Secciones' }).getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page.getByRole('link', { name: 'Organización' })).toHaveCount(0);
  await page.goto('/#/ingresar');
  await page.reload();
  await page.getByLabel('Correo').fill(email);
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByText('no hay sesión de negocio')).toBeVisible();
  await page.getByLabel('Código de recuperación').fill('AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDD');
  await page.getByRole('button', { name: 'Iniciar recuperación restringida' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Organización' })).toHaveCount(0);

  await page.getByLabel('Código TOTP vigente').fill(await freshTotp(secret));
  await page.getByRole('button', { name: 'Verificar factor' }).click();
  await expect(page.getByText('Sesión comprobada, sin organización')).toBeVisible();
});
