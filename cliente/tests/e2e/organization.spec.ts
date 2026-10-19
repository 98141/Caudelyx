import { expect, test } from '@playwright/test';
import { enrollTotp, freshTotp, PASSWORD, registerAndActivate } from './fixtures';

test('crea una organización real y conserva 412/428', async ({ page }) => {
  const email = `p03_org_${Date.now()}@example.test`;
  await registerAndActivate(page, email);
  const secret = await enrollTotp(page);
  await page.goto('/#/organizacion');
  await page.getByLabel('Nombre').fill('Organizacion sintetica');
  await page.getByLabel('Contraseña actual').fill(PASSWORD);
  let created = false;
  for (let attempt = 0; attempt < 2 && !created; attempt += 1) {
    await page.getByLabel('Código TOTP vigente').fill(await freshTotp(secret));
    await page.getByRole('button', { name: 'Crear organización' }).click();
    created = await page.getByRole('heading', { name: 'Organizacion sintetica' }).waitFor({ timeout: 20000 }).then(() => true, () => false);
  }
  expect(created).toBe(true);
  await expect(page.getByText('Este es tu usuario.')).toBeVisible();
  await expect(page.getByText(/recuperación/i)).toHaveCount(0);

  let stale = { missing: 0, reauth: 0, verify: 0, conflict: 0 };
  for (let attempt = 0; attempt < 2 && stale.verify !== 200; attempt += 1) {
    stale = await page.evaluate(async ({ password, code }) => {
    const csrf = await fetch('/api/v1/auth/csrf', { credentials: 'include' }).then(response => response.json()) as { data: { csrfToken: string } };
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.data.csrfToken };
    const missing = await fetch('/api/v1/organization', { method: 'PATCH', credentials: 'include', headers, body: JSON.stringify({ name: 'No aplicada' }) });
    const reauth = await fetch('/api/v1/auth/reauthenticate', { method: 'POST', credentials: 'include', headers, body: JSON.stringify({ password, purpose: 'ORGANIZATION_EDIT', resourceId: (await fetch('/api/v1/auth/me', { credentials: 'include' }).then(response => response.json()) as { data: { organizationId: string } }).data.organizationId, command: { name: 'No aplicada' } }) });
    const organizationId = (await fetch('/api/v1/organization', { credentials: 'include' }).then(response => response.json()) as { data: { id: string } }).data.id;
    const verify = await fetch('/api/v1/auth/mfa/challenges/verify', { method: 'POST', credentials: 'include', headers, body: JSON.stringify({ method: 'TOTP', purpose: 'ORGANIZATION_EDIT', resourceId: organizationId, code }) });
    const rotated = await fetch('/api/v1/auth/csrf', { credentials: 'include' }).then(response => response.json()) as { data: { csrfToken: string } };
    const conflict = await fetch('/api/v1/organization', { method: 'PATCH', credentials: 'include', headers: { ...headers, 'X-CSRF-Token': rotated.data.csrfToken, 'If-Match': '"version-que-no-existe"' }, body: JSON.stringify({ name: 'No aplicada' }) });
      return { missing: missing.status, reauth: reauth.status, verify: verify.status, conflict: conflict.status };
    }, { password: PASSWORD, code: await freshTotp(secret) });
  }
  expect(stale.missing).toBe(428);
  expect(stale.reauth).toBe(200);
  expect(stale.verify).toBe(200);
  expect(stale.conflict).toBe(412);
  await expect(page.getByRole('heading', { name: 'Organizacion sintetica' })).toBeVisible();
});
