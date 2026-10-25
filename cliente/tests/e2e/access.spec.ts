import { expect, test } from '@playwright/test';
import { PASSWORD, readSyntheticToken, registerAndActivate } from './fixtures';

test('registro, contraseña inválida y activación contra la API local', async ({ page }) => {
  const email = `p03_access_${Date.now()}@example.test`;
  await page.goto('/#/ingresar');
  await expect(page.getByRole('link', { name: 'Olvidé la contraseña' })).toHaveAttribute('href', '#/restablecer');
  await page.getByLabel('Correo').fill(email);
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Organización' })).toHaveCount(0);

  await registerAndActivate(page, email);
  await expect(page.getByText('La contraseña no abre el acceso de negocio')).toBeVisible();

  await page.goto('/#/restablecer');
  await page.getByLabel('Correo').fill(email);
  await page.getByRole('button', { name: 'Solicitar código' }).click();
  await expect(page.getByText('no cambia la contraseña')).toBeVisible();
  const token = await readSyntheticToken('RESET', email);
  await page.getByLabel('Código de restablecimiento').fill(token);
  await page.getByRole('button', { name: 'Previsualizar aviso' }).click();
  await expect(page.getByText('no podrás terminar el alta')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Organización' })).toHaveCount(0);
});
