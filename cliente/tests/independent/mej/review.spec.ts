// MEJ-5 independent browser journey (Claude) on the compiled client served by the own HTTPS fixture:
// login without code → Inicio → saldo inicial without code → asiento with ONE code (modal) → second asiento without
// code → screens at 360/768/1440 + CSS zoom 200 → two tabs logout sync → Back/reload → login of another person (A→B).
// Synthetic data only. TOTP codes are computed by the own fixture control; the secret never reaches this process.
import { test, expect, type Page } from '@playwright/test';

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const evidence = env['MEJ5_EVIDENCE']!;
const log = (name: string, data: unknown) => console.log('MEJ5_EVIDENCE ' + JSON.stringify({ evidence: name, data }));
async function control(action: string, body: Record<string, unknown> = {}): Promise<Record<string, string>> {
  const r = await fetch(env['MEJ5_CONTROL']!, { method: 'POST', headers: { 'x-fixture-owner': env['MEJ5_NONCE']!, 'content-type': 'application/json' }, body: JSON.stringify({ action, ...body }) });
  if (!r.ok) throw Error('own control failed ' + action); return await r.json() as Record<string, string>;
}
const WIDTHS = [360, 768, 1440] as const;
const overflow: Record<string, boolean> = {};
async function shoot(page: Page, name: string) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width === 360 ? 780 : 900 });
    await page.waitForTimeout(150);
    overflow[`${name}-${width}`] = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    await page.screenshot({ path: `${evidence}/MEJ-5-${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
async function go(page: Page, hash: string, heading: RegExp) { await page.goto('/' + hash); await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible({ timeout: 20000 }); }
async function login(page: Page, email: string, password: string) {
  await page.goto('/#/ingresar');
  await page.getByLabel('Correo', { exact: true }).fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
}
let pickRetries = 0;
const globalTimeline: string[] = [];
async function pick(page: Page, name: string, text: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const box = page.getByRole('combobox', { name, exact: true }); await box.click(); await box.fill(text);
    const option = page.getByRole('option', { name: new RegExp(text) }).first();
    try { await expect(option).toBeVisible({ timeout: 5000 }); await option.dispatchEvent('mousedown', undefined, { timeout: 3000 }); await expect(box).toHaveValue(new RegExp(text), { timeout: 3000 }); return; }
    catch { pickRetries++; await page.waitForTimeout(1500); }
  }
  throw Error('combobox selection did not stick: ' + name);
}

test.afterEach(async ({ page }, info) => { console.log('MEJ5_TIMELINE ' + JSON.stringify(globalTimeline)); if (info.status !== info.expectedStatus) console.log('MEJ5_FAILURE_SCREEN ' + JSON.stringify({ url: page.url(), text: (await page.locator('main').innerText().catch(() => '')).slice(0, 600), dialog: (await page.getByRole('dialog').innerText().catch(() => 'no dialog')).slice(0, 1200), buttons: await page.getByRole('dialog').getByRole('button').allInnerTexts().catch(() => []) })); });

test('MEJ-5 recorrido real', async ({ page, context, baseURL }) => {
  test.info().setTimeout(420000);
  page.on('pageerror', e => console.log('MEJ5_PAGEERROR ' + String(e).slice(0, 300)));
  const origin = new URL(baseURL!).origin, who = await control('who'), requests: string[] = [], consoleText: string[] = [];
  const t0 = Date.now(), timeline: string[] = [], mark = (label: string) => timeline.push(`${Date.now() - t0}ms ${label}`);
  const watched = /session\/activity|\/api\/v1\/organization$|step-up/;
  context.on('request', r => { requests.push(r.url()); if (watched.test(r.url())) { mark(r.method() + ' ' + new URL(r.url()).pathname); globalTimeline.splice(0, globalTimeline.length, ...timeline); } });
  page.on('console', m => consoleText.push(m.text()));
  const facts: Record<string, unknown> = {};

  // 1. Anonymous login screen; then password only → Inicio, no code asked.
  await page.goto('/#/ingresar'); await expect(page.getByRole('button', { name: 'Iniciar sesión' })).toBeVisible(); await shoot(page, 'login');
  await login(page, who['emailA']!, who['password']!);
  await expect(page).toHaveURL(/#\/inicio/, { timeout: 20000 });
  facts['code asked at login'] = await page.getByLabel(/Código/).count();
  await expect(page.getByText('Hola, ' + who['nameA']).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: /Inicio/ }).first()).toBeVisible(); await shoot(page, 'inicio');
  await go(page, '#/perfil', /Mi cuenta/); await shoot(page, 'perfil');
  await go(page, '#/seguridad', /Seguridad/); await shoot(page, 'seguridad');
  await go(page, '#/organizacion', /Organización/); await shoot(page, 'organizacion');

  // 2. Finanzas: summary, initial balance without code (no dialog), accounts, movements, opening.
  await go(page, '#/finanzas', /Finanzas/); await shoot(page, 'finanzas');
  const siTab = page.getByRole('heading', { name: 'Registrar saldo inicial' });
  if (!(await siTab.isVisible())) for (const tab of ['Resumen', 'Cuentas', 'Movimientos']) { await page.getByRole('tab', { name: tab }).click(); if (await siTab.isVisible()) break; }
  await expect(siTab).toBeVisible({ timeout: 20000 }); await siTab.scrollIntoViewIfNeeded(); await shoot(page, 'saldo-inicial');
  // Reproduction R-1: the first interaction posts activity; its answer reloads Finanzas and discards what was just chosen.
  mark('repro pick'); await pick(page, 'cuenta 1', 'BANK_R5'); await page.getByLabel('Monto').first().fill('123'); await page.waitForTimeout(2000);
  facts['R-1 selection 2 s after first interaction'] = await page.getByRole('combobox', { name: 'cuenta 1', exact: true }).inputValue();
  facts['R-1 amount 2 s after first interaction'] = await page.getByLabel('Monto').first().inputValue();
  mark('pick start'); await pick(page, 'cuenta 1', 'BANK_R5'); mark('pick ok'); globalTimeline.splice(0, globalTimeline.length, ...timeline); await page.getByLabel('Monto').first().fill('1.000.000'); mark('monto');
  facts['SI selection before Revisar'] = await page.getByRole('combobox', { name: 'cuenta 1', exact: true }).inputValue();
  const siSection = page.locator('section[aria-labelledby="saldo-inicial"]');
  await siSection.getByLabel('Soporte').fill('SYN-SI-E2E');
  console.log('MEJ5_SI_BEFORE ' + JSON.stringify({ value: facts['SI selection before Revisar'], text: (await siSection.innerText()).slice(0, 900) }));
  await page.getByRole('button', { name: 'Revisar' }).click(); await page.waitForTimeout(1000);
  console.log('MEJ5_SI_AFTER ' + JSON.stringify({ text: (await siSection.innerText().catch(() => '(section gone)')).slice(0, 900) }));
  await page.getByRole('button', { name: 'Registrar', exact: true }).click();
  facts['dialog during initial balance'] = await page.getByRole('dialog').count();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(/saldo inicial de este libro ya no está disponible/i).first()).toBeVisible(); facts['SI success wording'] = 'solo «ya no está disponible»';
  await page.getByRole('tab', { name: 'Cuentas' }).click(); await page.waitForTimeout(300); await shoot(page, 'cuentas');
  await page.getByRole('tab', { name: 'Movimientos' }).click(); await page.waitForTimeout(300); await shoot(page, 'movimientos');

  // 2b. Reproduction: draft text, wait 61 s (activity debounce), one click → does the view keep the draft and the tab?
  await page.getByRole('tab', { name: 'Movimientos' }).click();
  await page.getByLabel('Soporte').first().fill('BORRADOR-61S');
  await page.waitForTimeout(61000);
  await page.getByRole('heading', { name: /Finanzas/ }).first().click();
  await page.waitForTimeout(2500);
  facts['after 61 s + click: Movimientos selected'] = await page.getByRole('tab', { name: 'Movimientos' }).getAttribute('aria-selected');
  facts['after 61 s + click: draft kept'] = (await page.getByLabel('Soporte').first().inputValue().catch(() => '')) === 'BORRADOR-61S';

  // 3. Manual journal: first one opens the code modal once; the second one, inside the hour, does not.
  const journal = async (amount: string) => {
    await page.getByRole('tab', { name: 'Movimientos' }).click();
    await page.getByLabel('Soporte').first().fill('SYN-E2E'); await page.getByLabel('Descripción').first().fill('Asiento revisora');
    await pick(page, 'línea 1', 'BANK_R5'); await pick(page, 'línea 2', 'E_R5');
    const amounts = page.getByLabel('Importe'); await amounts.nth(0).fill(amount); await amounts.nth(1).fill(amount);
    const sides = page.getByLabel('Lado'); await sides.nth(0).selectOption('debit'); await sides.nth(1).selectOption('credit');
    await page.getByRole('button', { name: 'Contabilizar asiento' }).click();
  };
  await journal('10.000');
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible({ timeout: 20000 });
  facts['password field in modal'] = await dialog.getByLabel('Contraseña').count();
  await shoot(page, 'modal');
  await dialog.getByRole('button', { name: 'Pedir código' }).click();
  await expect(dialog.getByRole('button', { name: 'Confirmar', exact: true })).toBeVisible({ timeout: 20000 });
  facts['journals while modal open'] = (await control('journals', { who: 'A' }))['count'];
  await dialog.getByLabel('Código de 6 dígitos').fill((await control('code', { who: 'A' }))['code']!);
  await dialog.getByRole('button', { name: 'Confirmar', exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 20000 });
  await page.waitForTimeout(2500);
  facts['after code: journals in DB'] = (await control('journals', { who: 'A' }))['count'];
  facts['after code: Movimientos selected'] = await page.getByRole('tab', { name: 'Movimientos' }).getAttribute('aria-selected');
  facts['after code: form text kept'] = (await page.getByLabel('Soporte').first().inputValue().catch(() => '')) === 'SYN-E2E';
  facts['after code: success text'] = await page.getByText(/contabiliz|registrad|asiento/i).count();
  await journal('5.000');
  await page.waitForTimeout(1500); facts['dialog on second journal within the hour'] = await page.getByRole('dialog').count();
  expect(facts['dialog on second journal within the hour']).toBe(0);
  await page.getByRole('tab', { name: 'Apertura' }).click(); await page.waitForTimeout(300); await shoot(page, 'apertura');

  // 4. Remaining screens.
  await go(page, '#/prestatarios', /Prestatarios/); await shoot(page, 'prestatarios');
  await go(page, '#/prestamos', /Préstamos/); await shoot(page, 'prestamos');
  facts['loan defaults'] = await page.evaluate(() => [...document.querySelectorAll('select')].map(s => (s as HTMLSelectElement).selectedOptions[0]?.textContent ?? '').filter(Boolean));
  await go(page, '#/operaciones', /Operaciones/); await shoot(page, 'operaciones');
  await go(page, '#/configuracion', /Configuración/); await shoot(page, 'configuracion');
  await page.goto('/#/invitacion'); await expect(page.getByRole('heading', { name: /Invitación/ }).first()).toBeVisible(); await shoot(page, 'invitacion');
  await go(page, '#/finanzas', /Finanzas/); await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { (document.documentElement.style as unknown as { zoom: string }).zoom = '200%'; });
  await page.waitForTimeout(300); overflow['zoom200'] = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  await page.screenshot({ path: `${evidence}/MEJ-5-zoom200.png`, fullPage: true });
  await page.evaluate(() => { (document.documentElement.style as unknown as { zoom: string }).zoom = ''; });

  // 5. Two tabs: logout in one closes the other; Back/reload do not bring the private view back.
  const second = await context.newPage(); await second.goto('/#/inicio'); await expect(second.getByText('Hola, ' + who['nameA']).first()).toBeVisible({ timeout: 20000 });
  await go(page, '#/perfil', /Mi cuenta/);
  await page.getByRole('button', { name: 'Cerrar sesión' }).first().click();
  await expect(page).toHaveURL(/#\/ingresar/, { timeout: 20000 });
  await expect(second).toHaveURL(/#\/ingresar/, { timeout: 20000 });
  facts['other tab private name visible'] = await second.getByText('Hola, ' + who['nameA']).count();
  await page.goBack(); await page.waitForTimeout(800); facts['after Back: private name'] = await page.getByText('Hola, ' + who['nameA']).count();
  await page.reload(); await page.waitForTimeout(800); facts['after reload: private name'] = await page.getByText('Hola, ' + who['nameA']).count();
  facts['after reload URL'] = new URL(page.url()).hash;
  expect(facts['other tab private name visible']).toBe(0); expect(facts['after Back: private name']).toBe(0); expect(facts['after reload: private name']).toBe(0);

  // 6. Another person logs in on the same browser: no data of A anywhere.
  await login(page, who['emailB']!, who['password']!);
  await expect(page.getByText('Hola, ' + who['nameB']).first()).toBeVisible({ timeout: 20000 });
  await go(page, '#/organizacion', /Organización/);
  facts['B sees A name/org'] = await page.getByText(new RegExp(`${who['nameA']}|${who['orgA']}`)).count();
  await expect(page.getByText(who['orgB']!).first()).toBeVisible();
  expect(facts['B sees A name/org']).toBe(0);
  await second.reload(); await expect(second.getByText('Hola, ' + who['nameB']).first()).toBeVisible({ timeout: 20000 });
  facts['second tab after B login sees A'] = await second.getByText('Hola, ' + who['nameA']).count();

  // 7. Hygiene: same-origin requests only, storage holds no identity, console has no secrets.
  facts['external requests'] = requests.filter(u => !u.startsWith(origin + '/') && !u.startsWith('data:')).length;
  facts['storage'] = await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }));
  facts['console with secrets'] = consoleText.filter(t => /otpauth|secret=|csrf|password/i.test(t)).length;
  facts['combobox retries'] = pickRetries; facts['journals at end'] = (await control('journals', { who: 'A' }))['count'];
  log('facts', facts); log('overflow', overflow);
  expect(facts['external requests']).toBe(0); expect(facts['code asked at login']).toBe(0); expect(facts['dialog during initial balance']).toBe(0); expect(facts['password field in modal']).toBe(0);
});
