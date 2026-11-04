import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Route } from '@playwright/test';

const evidence = join(dirname(fileURLToPath(import.meta.url)), '../../../../Construccion/Sprints/MODO-SIMPLE/Evidencias');
const orgId = '11111111-1111-4111-8111-111111111111';

function metric(value: string | null, status: 'COMPLETE' | 'UNAVAILABLE') {
  return { value, status, reasons: status === 'UNAVAILABLE' ? ['SOURCE_MISSING'] : [], sourceRefs: [] };
}

const cuts = {
  effectiveDate: '2026-11-03', knownAt: '2026-11-03T14:00:00.000Z', sourceVector: 'ab'.repeat(32),
  mappingVersion: 'map-1', contractVersion: '1.0.0', currency: 'COP', timezone: 'America/Bogota',
};

const monthly = {
  bookId: orgId, scope: 'BUSINESS', month: '2026-11', cuts,
  principal: metric('9000000.00', 'COMPLETE'),
  availableToLend: metric('3255000.00', 'COMPLETE'),
  cash: metric('4010000.00', 'COMPLETE'),
  reserved: metric('755000.00', 'COMPLETE'),
  free: metric('3255000.00', 'COMPLETE'),
  interestExpected: metric('270000.00', 'COMPLETE'),
  interestCashCollected: metric(null, 'UNAVAILABLE'),
  otherIncome: metric(null, 'UNAVAILABLE'),
  fundingTransfers: metric(null, 'UNAVAILABLE'),
  paidExpenses: metric(null, 'UNAVAILABLE'),
  paidDebtInstallments: metric(null, 'UNAVAILABLE'),
  debtSavings: metric(null, 'UNAVAILABLE'),
  baseSurplus: metric(null, 'UNAVAILABLE'),
  distributedSurplus: metric(null, 'UNAVAILABLE'),
  remainingSurplus: metric(null, 'UNAVAILABLE'),
};

const screens: Array<[string, string]> = [
  ['mes', '¿Cómo va este mes?'],
  ['prestamos', '¿A quién presté y cuánto me deben?'],
  ['cobros', '¿Quién me pagó y cuánto?'],
  ['deudas', '¿Qué debo y cuándo pago?'],
  ['gastos', '¿En qué se va mi dinero?'],
  ['caja', '¿Dónde está mi dinero?'],
  ['ahorro', '¿Cuánto aparto para llegar a cada cuota?'],
];

function body(payload: unknown, status = 200): { status: number; contentType: string; body: string; headers: Record<string, string> } {
  return { status, contentType: 'application/json', body: JSON.stringify(payload), headers: status === 200 ? { ETag: '"book-etag"' } : {} };
}

async function answer(route: Route, signedIn: { value: boolean }, monthlyStatus: { value: number }) {
  const url = route.request().url();
  const me = { authState: 'ACTIVE', userId: 'user-ms-p03', organizationId: orgId, roleIds: ['T'], profile: { displayName: 'Titular sintético', email: 'titular@example.test', emailVerified: true } };
  if (url.includes('/auth/logout')) {
    signedIn.value = false;
    await route.fulfill(body({ data: null, requestId: 'ms-p03' }));
    return;
  }
  if (url.includes('/auth/csrf')) {
    await route.fulfill(body({ data: { csrfToken: 'csrf-ms-p03' }, requestId: 'ms-p03' }));
    return;
  }
  if (url.includes('/auth/me')) {
    await route.fulfill(signedIn.value ? body({ data: me, requestId: 'ms-p03' }) : body({ error: { code: 'AUTH_INVALID' }, requestId: 'ms-p03' }, 401));
    return;
  }
  if (url.includes('/me/personal/book')) {
    await route.fulfill(body({ error: { code: 'NOT_FOUND' }, requestId: 'ms-p03' }, 404));
    return;
  }
  if (url.includes('/modo-simple/') && url.includes('/monthly') && !url.includes('monthly-loans')) {
    await route.fulfill(monthlyStatus.value === 200 ? body(monthly) : body({ error: { code: 'FORBIDDEN' }, requestId: 'ms-p03' }, monthlyStatus.value));
    return;
  }
  if (url.includes('/monthly-loans')) {
    await route.fulfill(body({ rows: [], totalCount: 0, nextCursor: null, totalsScope: 'FULL_FILTER', principalTotal: metric(null, 'UNAVAILABLE'), interestExpectedTotal: metric(null, 'UNAVAILABLE'), cuts }));
    return;
  }
  if (url.includes('/savings-plan')) {
    await route.fulfill(body({ bookId: orgId, cuts, startMonth: '2026-11', horizonMonths: 12, rows: [], totalCount: 0, nextCursor: null, totalsScope: 'FULL_FILTER', totalShortfall: metric(null, 'UNAVAILABLE') }));
    return;
  }
  if (url.includes('/debt-plans') || url.includes('/mappings/')) {
    await route.fulfill(body({ rows: [], totalCount: 0, nextCursor: null }));
    return;
  }
  if (url.includes('/expenses') || url.includes('/funds') || url.includes('/accounts') || url.includes('/wealth-s10/book')) {
    await route.fulfill(body({ data: { items: [], nextCursor: null }, requestId: 'ms-p03' }));
    return;
  }
  await route.fulfill(body({ error: { code: 'NOT_FOUND' }, requestId: 'ms-p03' }, 404));
}

async function install(context: BrowserContext, signedIn: { value: boolean }, monthlyStatus: { value: number }) {
  await context.route('**/api/**', route => answer(route, signedIn, monthlyStatus));
}

test('presentación de las siete pantallas con red interceptada, no integración P02', async ({ page, context }) => {
  test.slow();
  mkdirSync(evidence, { recursive: true });
  const signedIn = { value: true };
  const monthlyStatus = { value: 200 };
  const notes: Record<string, unknown> = {
    label: 'PRESENTATION_NOT_INTEGRATION',
    api: 'fetch interceptado en el navegador. No es el servidor MS-P02.',
    captures: [] as string[],
    scroll: [] as Array<{ width: number; overflow: number }>,
  };
  await install(context, signedIn, monthlyStatus);
  for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [id, title] of screens) {
      await page.goto(`/#/modo-simple/${id}`);
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
      const file = `MS-P03-${id}-${width}.png`;
      await page.screenshot({ path: join(evidence, file), fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      (notes.captures as string[]).push(file);
      (notes.scroll as Array<{ width: number; overflow: number }>).push({ width, overflow });
      expect(overflow, `${id} ${width}`).toBeLessThanOrEqual(1);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/modo-simple/mes');
  await expect(page.locator('#page-title')).toBeFocused();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
  const second = await context.newPage();
  await second.goto('/#/modo-simple/gastos');
  await expect(second.getByRole('heading', { name: '¿En qué se va mi dinero?' })).toBeVisible();
  await page.getByLabel('Ámbito').selectOption('PERSONAL');
  await expect(page.getByText('9.000.000 COP')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Abrir libro personal' })).toBeVisible();
  monthlyStatus.value = 403;
  await page.getByLabel('Ámbito').selectOption('BUSINESS');
  await expect(page.getByText('No se puede mostrar esta información. No se revelan datos de otro ámbito.')).toBeVisible();
  await expect(page.getByText('9.000.000 COP')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page.getByRole('heading', { name: 'Bienvenido de nuevo' })).toBeVisible();
  await second.reload();
  await expect(second.getByRole('heading', { name: 'Bienvenido de nuevo' })).toBeVisible();
  await expect(second.getByText('9.000.000 COP')).toHaveCount(0);
  const before = await page.evaluate(() => window.visualViewport?.scale ?? 1);
  await page.keyboard.down('Control');
  await page.keyboard.press('Equal');
  await page.keyboard.press('Equal');
  await page.keyboard.up('Control');
  const after = await page.evaluate(() => window.visualViewport?.scale ?? 1);
  notes.nativeZoom = {
    method: 'Control+Equal dos veces sobre Chrome de Playwright. No se usó CSS zoom ni deviceScaleFactor.',
    scaleBefore: before,
    scaleAfter: after,
    result: after > before ? 'ACHIEVED' : 'NOT_ACHIEVED',
    limit: 'El viewport y el DPR no sustituyen el zoom nativo. Si la escala no cambia, este punto queda sin cumplir.',
  };
  writeFileSync(join(evidence, 'MS-P03-BROWSER.json'), JSON.stringify(notes, null, 2));
  await second.close();
});
