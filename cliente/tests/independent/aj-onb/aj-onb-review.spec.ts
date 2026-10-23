// AJ-ONB-5 independent browser journey (Claude): alta → B → confirmar en otro navegador → contraseña → QR = URI → TOTP → S → R → organización.
// Synthetic data only; the TOTP secret never leaves memory except to the own loopback fixture control. No screenshots/traces.
import { test, expect, type Page } from '@playwright/test';

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const PASSWORD = 'Frase sintetica navegador revisora 5521';
const evidence = (name: string, data: Record<string, unknown>) => console.log('AJ5_EVIDENCE ' + JSON.stringify({ evidence: name, ...data }));
async function control(action: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const response = await fetch(env['AJ5_CONTROL']!, { method: 'POST', headers: { 'x-fixture-owner': env['AJ5_NONCE']!, 'content-type': 'application/json' }, body: JSON.stringify({ action, ...body }) });
  if (!response.ok) throw Error('Own fixture control failed: ' + action);
  return await response.json() as Record<string, unknown>;
}
const nav = (page: Page) => page.getByRole('navigation', { name: 'Secciones' });
async function noHorizontalScroll(page: Page): Promise<boolean> { return await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth); }

test('AJ-ONB-5 recorrido real con QR y negocio', async ({ page, browser, baseURL }) => {
  const origin = new URL(baseURL!).origin, email = 'r5-e2e-' + Date.now() + '@example.test';
  const requests: string[] = [], consoleTexts: string[] = [];
  page.context().on('request', r => requests.push(r.url()));
  page.on('console', m => consoleTexts.push(m.text()));

  await page.goto('/#/registro');
  await page.getByLabel('Correo', { exact: true }).fill(email);
  await page.getByLabel('Nombre visible').fill('Revisora E2E');
  await page.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page.getByRole('heading', { name: 'Perfil' })).toBeVisible();
  await expect(nav(page).getByText('Hola, Revisora E2E')).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Ingresar' })).toHaveCount(0);
  await expect(nav(page).getByRole('link', { name: 'Crear cuenta' })).toHaveCount(0);
  await expect(nav(page).getByRole('link', { name: 'Organización' })).toHaveCount(0);
  await expect(page.getByText('Correo sin confirmar', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 });
  const profile360 = await noHorizontalScroll(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const before = await control('inspect', { email });

  const token = String((await control('mail', { email, purpose: 'ACTIVATION' }))['token']);
  const other = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'es-CO' });
  const second = await other.newPage();
  const secondRequests: string[] = [];
  other.on('request', r => secondRequests.push(r.url()));
  await second.goto('/#/activar?purpose=ACTIVATION&token=' + token);
  await expect(second.getByRole('button', { name: 'Activar cuenta' })).toBeVisible();
  const strippedUrl = !second.url().includes(token);
  await second.getByRole('button', { name: 'Activar cuenta' }).click();
  await expect(second.getByText('Correo confirmado ✓')).toBeVisible();
  await expect(nav(second).getByRole('link', { name: 'Ingresar' })).toBeVisible();
  // The fragment never travels in HTTP; only the part before '#' (path/query) is visible to servers, proxies and logs.
  const tokenInHttp = secondRequests.some(u => (u.split('#')[0] ?? '').includes(token));
  await other.close();
  const after = await control('inspect', { email });
  expect(after['emailVerified']).toBe(true);
  expect(after['hash']).toBe(before['hash']);

  await page.reload();
  await page.goto('/#/perfil');
  await expect(page.getByText('Correo confirmado', { exact: true })).toBeVisible();
  await page.getByLabel('Contraseña actual').fill(PASSWORD);
  await page.getByRole('button', { name: 'Preparar factor' }).click();
  const image = page.getByRole('img', { name: /Código QR de la misma cuenta/ });
  await expect(image).toBeVisible();
  const src = await image.getAttribute('src') ?? '';
  const uri = (await page.locator('output').first().textContent()) ?? '';
  const parsed = new URL(uri), secret = parsed.searchParams.get('secret') ?? '';
  const manual = (await page.locator('.manual-key').textContent()) ?? '';
  const qrcode = await import('qrcode' as string) as { toString(text: string, o: Record<string, unknown>): Promise<string> };
  const expectedSvg = await qrcode.toString(uri, { type: 'svg', margin: 2, width: 240, errorCorrectionLevel: 'M', color: { dark: '#0f172a', light: '#ffffff' } });
  const qrEqualsUri = decodeURIComponent(src.slice('data:image/svg+xml;charset=utf-8,'.length)) === expectedSvg;
  expect(qrEqualsUri).toBe(true);
  expect(manual).toBe(secret);
  expect(decodeURIComponent(parsed.pathname)).toContain(email);
  await page.setViewportSize({ width: 360, height: 800 });
  const qr360 = await noHorizontalScroll(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByLabel('Código TOTP actual').fill(String((await control('code', { secret }))['code']));
  await page.getByRole('button', { name: 'Confirmar TOTP' }).click();
  // First run: «Factor registrado» was never visible: refresh() turns the session into S and unmounts FirstFactorSetup with its notice.
  await expect(nav(page).getByRole('link', { name: 'Organización' })).toBeVisible({ timeout: 15000 });
  const factorNoticeVisible = await page.getByText(/Factor registrado/).isVisible();
  await expect(page.getByRole('link', { name: 'Continuar a la organización' })).toBeVisible();
  await expect(page.getByRole('img', { name: /Código QR/ })).toHaveCount(0);
  const secretGoneAfterConfirm = !(await page.content()).includes(secret);

  await control('tick', { ms: 30000 });
  await page.goto('/#/organizacion');
  await page.getByLabel('Nombre', { exact: true }).fill('Organización revisora');
  await page.getByLabel('Contraseña actual').fill(PASSWORD);
  await page.getByLabel('Código TOTP vigente').fill(String((await control('code', { secret }))['code']));
  await page.getByRole('button', { name: 'Crear organización' }).click();
  await expect(page.getByText(/Organización creada/)).toBeVisible();

  const storage = await page.evaluate(() => [localStorage.length, sessionStorage.length]);
  expect(storage).toEqual([0, 0]);
  const external = requests.filter(u => !u.startsWith(origin + '/') && !u.startsWith('data:'));
  expect(external).toEqual([]);
  expect(consoleTexts.some(t => t.includes(secret) || t.includes('otpauth') || t.includes(token))).toBe(false);
  await nav(page).getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(nav(page).getByRole('link', { name: 'Ingresar' })).toBeVisible();
  const secretGoneAfterLogout = !(await page.content()).includes(secret);
  evidence('journey', { factorNoticeVisible, profile360, qr360, strippedUrl, tokenInHttp, qrEqualsUri, manualEqualsUri: manual === secret, secretGoneAfterConfirm, secretGoneAfterLogout,
    storage, externalRequests: external.length, requests: requests.length, consoleMessages: consoleTexts.length });
  expect(tokenInHttp).toBe(false);
  expect(strippedUrl).toBe(true);
});
