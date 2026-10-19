import { expect, test, type Page, type BrowserContext } from '@playwright/test';
import { PASSWORD, readSyntheticToken, registerAndActivate } from '../e2e/fixtures';

async function authenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'usb', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } });
}

async function passkey(page: Page) {
  await page.getByLabel('Tipo').selectOption('WEBAUTHN');
  await page.getByLabel('Etiqueta', { exact: true }).fill('Passkey sintética P04');
  await page.getByRole('button', { name: 'Preparar factor', exact: true }).click();
  await expect(page.getByText('Sesión comprobada, sin organización')).toBeVisible();
}

async function login(page: Page, email: string) {
  await page.goto('/#/ingresar');
  await page.getByLabel('Correo', { exact: true }).fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Comprobar passkey' })).toBeVisible();
  await page.getByRole('button', { name: 'Comprobar passkey' }).click();
  await expect(page.getByText('Sesión de organización activa.')).toBeVisible();
}

test('UI/API real: solo passkeys, command/R, invitación, afiliación actualizada, rol revoca y 403 conserva sesión', async ({ page, context, browser }) => {
  const ownerEmail = `p04_owner_${Date.now()}@example.test`;
  const memberEmail = `p04_member_${Date.now()}@example.test`;
  const organizationName = 'Organización <img src=x onerror=alert(1)>';
  await authenticator(context, page);
  await registerAndActivate(page, ownerEmail);
  await passkey(page);
  await page.goto('/#/organizacion');
  await page.getByLabel('Nombre', { exact: true }).fill(organizationName);
  await page.getByLabel('Contraseña actual', { exact: true }).fill(PASSWORD);
  // Blank optional TOTP explicitly selects the browser passkey; no TOTP factor exists.
  await page.getByRole('button', { name: 'Crear organización', exact: true }).click();
  await expect(page.getByRole('heading', { name: organizationName, exact: true })).toBeVisible();
  await expect(page.locator('img')).toHaveCount(0);
  const invite = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Invitar', exact: true }) });
  await invite.getByLabel('Correo', { exact: true }).fill(memberEmail);
  await invite.getByLabel('Contraseña actual', { exact: true }).fill(PASSWORD);
  await invite.getByLabel('Consultor', { exact: true }).uncheck();
  await invite.getByLabel('Operador', { exact: true }).check();
  await invite.getByRole('button', { name: 'Enviar invitación', exact: true }).click();
  await expect(page.getByText('Invitación aceptada para envío.')).toBeVisible();
  const token = await readSyntheticToken('INVITATION', memberEmail);
  const recipient = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const member = await recipient.newPage();
    await authenticator(recipient, member);
    await registerAndActivate(member, memberEmail);
    await passkey(member);
    await member.goto('/#/invitacion');
    const confirm = member.locator('form').filter({ has: member.getByRole('heading', { name: 'Confirmar', exact: true }) });
    await confirm.getByLabel('Código de invitación', { exact: true }).fill(token);
    await confirm.getByRole('button', { name: 'Confirmar invitación', exact: true }).click();
    await expect(member.getByText('Sesión de organización activa.')).toBeVisible();
    await member.goto('/#/organizacion');
    await expect(member.getByText('La gestión respondió sin permiso. La sesión sigue abierta.')).toBeVisible();
    const checks = await member.evaluate(async () => {
      const me = await fetch('/api/v1/auth/me').then(r => r.json());
      const listing = await fetch('/api/v1/organization/members');
      const after = await fetch('/api/v1/auth/me');
      return { state: me.data.authState, listing: listing.status, after: after.status };
    });
    expect(checks).toEqual({ state: 'ACTIVE', listing: 403, after: 200 });

    await page.reload();
    const card = page.locator('article.card').filter({ has: page.getByText(memberEmail, { exact: true }) })
      .filter({ has: page.getByRole('button', { name: 'Cambiar roles', exact: true }) });
    await expect(card).toBeVisible();
    expect(await card.getByRole('checkbox', { name: 'Titular', exact: true }).count()).toBe(0);
    await card.getByLabel('Operador', { exact: true }).uncheck();
    await card.getByLabel('Consultor', { exact: true }).check();
    await card.getByLabel('Contraseña actual', { exact: true }).fill(PASSWORD);
    await card.getByRole('button', { name: 'Cambiar roles', exact: true }).click();
    await expect(page.getByText('Roles enviados con la versión de la persona.')).toBeVisible();
    const revoked = await member.evaluate(async () => (await fetch('/api/v1/auth/me')).status);
    expect(revoked).toBe(401);
    await login(member, memberEmail);
    await expect(member.getByText('La gestión respondió sin permiso. La sesión sigue abierta.')).toBeVisible();
    const storage = await member.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }));
    expect(storage).toEqual({ local: 0, session: 0 });
  } finally { await recipient.close(); }

  await page.getByRole('navigation', { name: 'Secciones' }).getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await login(page, ownerEmail);
  await expect(page.getByRole('heading', { name: organizationName, exact: true })).toBeVisible();
});

test('responsive propio: cinco anchos, foco de teclado, zoom y ausencia de almacenamiento', async ({ page }) => {
  await page.goto('/#/ingresar');
  await expect(page.getByRole('heading', { name: 'Ingresar', exact: true })).toBeVisible();
  for (const width of [360, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  }
  await expect(page.getByRole('heading', { name: 'Ingresar', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Correo', { exact: true })).toBeFocused();
  await page.getByRole('link', { name: 'Saltar al contenido' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await page.evaluate(() => { document.body.style.zoom = '2'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});
