import { expect, test } from '@playwright/test';
import { freshTotp } from './fixtures';
import { PAGINATION_PASSWORD, populatePagedOrganization } from './p04-v2-fixtures';

test('pagina más de 20 personas e invitaciones sin depender de la página del gestor', async ({ page }) => {
  const population = await populatePagedOrganization();
  let failMemberCursor = true;
  await page.route('**/api/v1/organization/members**', async route => {
    if (failMemberCursor && route.request().url().includes('cursor=')) {
      failMemberCursor = false;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'El servicio no está disponible.' }, requestId: 'req-ui' }),
      });
      return;
    }
    await route.continue();
  });
  await page.goto('/#/ingresar');
  await page.getByLabel('Correo').fill(population.email);
  await page.getByLabel('Contraseña').fill(PAGINATION_PASSWORD);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.getByLabel('Código TOTP vigente').fill(await freshTotp(population.secret));
  await page.getByRole('button', { name: 'Verificar factor' }).click();
  await page.waitForURL(/#\/organizacion/);
  await page.getByRole('heading', { name: 'Personas' }).waitFor();
  await expect(page.getByRole('heading', { name: 'Invitar' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Suspender' }).first()).toBeVisible();
  const section = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Personas' }) });
  const firstMembers = section.locator('.cards').nth(0).locator('> article.card h3');
  await expect(firstMembers.first()).toBeVisible();
  const before = await firstMembers.allTextContents();
  expect(before).not.toContain(population.memberOnPageTwo);
  const moreMembers = page.getByRole('button', { name: 'Cargar más personas' });
  await moreMembers.click();
  await expect(page.getByText('El servicio no está disponible.')).toBeVisible();
  await expect(firstMembers).toHaveCount(before.length);
  await page.unroute('**/api/v1/organization/members**');
  await moreMembers.click();
  await expect(page.getByRole('heading', { name: population.memberOnPageTwo })).toBeVisible();
  const invitationCards = section.locator('.cards').nth(1).locator('> article.card h3');
  const invitationsBefore = await invitationCards.allTextContents();
  expect(invitationsBefore).not.toContain(population.invitationOnPageTwo);
  await page.getByRole('button', { name: 'Cargar más invitaciones' }).click();
  await expect(page.getByRole('heading', { name: population.invitationOnPageTwo })).toBeVisible();
  const invalid = await page.evaluate(async () => {
    const response = await fetch('/api/v1/organization/members?limit=20&cursor=no-es-cursor', { credentials: 'include' });
    const body = await response.json() as { error?: { code?: string } };
    return { status: response.status, code: body.error?.code ?? '' };
  });
  expect(invalid).toEqual({ status: 422, code: 'INPUT_INVALID' });
  const card = page.locator('article.card').filter({ has: page.getByRole('button', { name: 'Suspender' }) }).first();
  await card.getByLabel('Contraseña actual').fill(PAGINATION_PASSWORD);
  await card.getByLabel('Código TOTP vigente').fill(await freshTotp(population.secret));
  await card.getByRole('button', { name: 'Suspender' }).click();
  await expect(page.getByText(/Estado resultante:/)).toBeVisible();
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});
