import { expect, test } from '@playwright/test';
import { evidenceDir, enrollTotp, openActivation, PASSWORD, readSyntheticToken, registerAndActivate } from './fixtures';

const widths = [360, 390, 768, 1024, 1440] as const;

test('pantallas limpias del registro en los anchos pedidos', async ({ page }) => {
  await page.goto('/#/registro');
  await expect(page.getByRole('heading', { name: 'Crea tu cuenta' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Crea tu cuenta' })).toBeFocused();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Ingresar' })).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Crear cuenta' })).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Verificar correo' })).toHaveCount(0);
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Restablecer contraseña' })).toHaveCount(0);
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Invitación' })).toHaveCount(0);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Correo')).toBeFocused();
  await page.getByRole('link', { name: 'Saltar al contenido' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflow).toBe(false);
    await page.screenshot({ path: `${evidenceDir}/S01-P04-v4-FRONTEND-UI-${width}.png`, fullPage: true });
  }
  await page.evaluate(() => { document.body.style.zoom = '2'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('recorrido real de registro, enlace, factor y continuación', async ({ page }) => {
  const email = `p04_onboarding_${Date.now()}@example.test`;
  await page.goto('/#/registro');
  await page.getByLabel('Correo').fill(email);
  await page.getByLabel('Nombre visible').fill('Persona de recorrido');
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page.getByRole('heading', { name: 'Mi cuenta', exact: true })).toBeVisible();
  await expect(page.getByText('Activa tu cuenta para continuar')).toBeVisible();
  await expect(page.getByText('Nombre: Persona de recorrido')).toBeVisible();
  await expect(page.getByText('no confirma que la cuenta exista')).toHaveCount(0);
  const token = await readSyntheticToken('ACTIVATION', email);
  await openActivation(page, 'ACTIVATION', 'C'.repeat(43));
  await page.getByRole('button', { name: 'Activar cuenta' }).click();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Proteger mi cuenta' })).toHaveCount(0);
  await openActivation(page, 'ACTIVATION', token);
  await page.getByRole('button', { name: 'Activar cuenta' }).click();
  await expect(page.getByRole('heading', { name: 'Proteger mi cuenta' })).toBeVisible();
  await page.goto('/#/organizacion');
  await expect(page.getByText('Hace falta una sesión comprobada con factor')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Crear organización' })).toHaveCount(0);
  await page.addInitScript(() => {
    Object.defineProperty(navigator.credentials, 'create', {
      configurable: true,
      value: () => Promise.reject(new DOMException('cancelled', 'NotAllowedError')),
    });
  });
  await page.goto('/?passkey=cancel#/perfil');
  await page.getByLabel('Tipo').selectOption('WEBAUTHN');
  await page.getByRole('button', { name: 'Preparar factor' }).click();
  await expect(page.getByText('Se canceló la passkey')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Proteger mi cuenta' })).toBeVisible();
  await page.getByLabel('Tipo').selectOption('TOTP');
  await enrollTotp(page);
  await page.getByRole('link', { name: 'Continuar a la organización' }).click();
  await expect(page.getByRole('heading', { name: 'Crear la organización' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test('no enumera correos y otro navegador conserva su intento', async ({ page, browser }) => {
  const existing = `p04_exist_${Date.now()}@example.test`;
  const fresh = `p04_fresh_${Date.now()}@example.test`;
  await registerAndActivate(page, existing);
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await page.goto('/#/registro');
  await page.getByLabel('Correo').fill(existing);
  await page.getByLabel('Nombre visible').fill('Intento distinto');
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page.getByRole('heading', { name: 'Mi cuenta', exact: true })).toBeVisible();
  await expect(page.getByText('Nombre: Intento distinto')).toBeVisible();
  await expect(page.getByText('Activa tu cuenta para continuar')).toBeVisible();
  await expect(page.getByText('Persona sintetica')).toHaveCount(0);

  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const second = await other.newPage();
    await second.goto('/#/registro');
    await second.getByLabel('Correo').fill(fresh);
    await second.getByLabel('Nombre visible').fill('Intento ajeno');
    await second.getByLabel('Contraseña').fill(PASSWORD);
    await second.getByRole('checkbox').check();
    await second.getByRole('button', { name: 'Crear cuenta' }).click();
    await expect(second.getByText('Nombre: Intento ajeno')).toBeVisible();
    await page.reload();
    await expect(page.getByText('Nombre: Intento distinto')).toBeVisible();
    await expect(page.getByText('Intento ajeno')).toHaveCount(0);
  } finally {
    await other.close();
  }
});

test('legado, otra cuenta y otro ingreso no confirman en silencio', async ({ page, browser }) => {
  await openActivation(page, 'ACTIVATION', 'D'.repeat(43));
  await page.getByRole('button', { name: 'Crear contraseña inicial' }).click();
  await page.getByLabel('Contraseña nueva').fill(PASSWORD);
  await page.getByRole('button', { name: 'Activar con contraseña inicial' }).click();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Proteger mi cuenta' })).toHaveCount(0);

  const email = `p04_legacy_${Date.now()}@example.test`;
  await page.goto('/#/registro');
  await page.getByLabel('Correo').fill(email);
  await page.getByLabel('Nombre visible').fill('Persona legado');
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page.getByRole('heading', { name: 'Mi cuenta', exact: true })).toBeVisible();
  const token = await readSyntheticToken('ACTIVATION', email);
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await openActivation(page, 'ACTIVATION', token);
  await expect(page.getByLabel('Contraseña nueva')).toHaveCount(0);
  await page.getByRole('button', { name: 'Crear contraseña inicial' }).click();
  await page.getByLabel('Contraseña nueva').fill(PASSWORD);
  await page.getByRole('button', { name: 'Activar con contraseña inicial' }).click();
  await expect(page.getByRole('heading', { name: 'Proteger mi cuenta' })).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await page.goto('/#/ingresar');
  await page.getByLabel('Correo').fill(email);
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await expect(page.getByRole('heading', { name: 'Mi cuenta', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pedir enlace de protección' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preparar factor' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await openActivation(page, 'ACTIVATION', token);
  await page.getByRole('button', { name: 'Crear contraseña inicial' }).click();
  await page.getByLabel('Contraseña nueva').fill(PASSWORD);
  await page.getByRole('button', { name: 'Activar con contraseña inicial' }).click();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Proteger mi cuenta' })).toHaveCount(0);

  const holder = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const other = await holder.newPage();
    await registerAndActivate(other, `p04_other_${Date.now()}@example.test`);
    await openActivation(other, 'ACTIVATION', token);
    await expect(other.getByText('Hay otra cuenta en este navegador')).toBeVisible();
    await expect(other.getByRole('button', { name: 'Activar cuenta' })).toHaveCount(0);
  } finally {
    await holder.close();
  }
});

test('sin red el registro no anuncia éxito', async ({ page, context }) => {
  await page.goto('/#/registro');
  await context.setOffline(true);
  await page.getByLabel('Correo').fill('sin-red@example.test');
  await page.getByLabel('Nombre visible').fill('Sin red');
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page.getByText('no se guardó nada')).toBeVisible();
  await expect(page.getByText('Solicitud recibida')).toHaveCount(0);
});
