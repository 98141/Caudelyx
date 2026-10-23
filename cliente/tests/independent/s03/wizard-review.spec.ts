// S03-P05 independent browser journey (Claude) on the REAL root launcher in the reserved profile (UI 5371 -> API 5471).
// Registration -> terminal mailbox (memory only) -> LINK -> passkey (Chromium virtual authenticator with UV) -> organization
// -> accounts -> opening wizard with NEGATIVE equity typed in es-CO -> double submits -> wrong R -> validate/approve/commit.
// Node-only modules are loaded dynamically so this file does not change the client app typecheck.
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'synthetic P05 S03 browser passphrase 1357';
const nodeProcess = (globalThis as unknown as { process: { env: Record<string, string | undefined>; execPath: string } }).process;
const here = (relative: string) => new URL(relative, import.meta.url);
let profile: { directory: string; dispose(): Promise<void> } | undefined;
let runner: { send(m: string): void; exitCode: number | null; on(e: string, f: (m: unknown) => void): void; once(e: string, f: (c: unknown) => void): void; stdout: { resume(): void } | null; stderr: { resume(): void } | null; kill(): void } | undefined;
const evidence = (name: string, data: Record<string, unknown>) => console.log(JSON.stringify({ evidence: name, ...data }));
async function path(relative: string): Promise<string> { const url = await import('node:url' as string) as { fileURLToPath(u: URL): string }; return url.fileURLToPath(here(relative)); }
function environment() {
  const e: Record<string, string | undefined> = { ...nodeProcess.env, CAUDELYX_MODE: 'local-synthetic', CAUDELYX_DEV_TEST_ID: nodeProcess.env['CAUDELYX_TEST_RUN_ID'], CAUDELYX_DEV_UI_PORT: '5371', CAUDELYX_DEV_API_PORT: '5471', CAUDELYX_DEV_PLATFORM_PORT: '5372' };
  for (const k of ['MONGODB_URI', 'MONGODB_DATABASE', 'CAUDELYX_DEV_SMOKE']) delete e[k];
  return e;
}
async function startStack() {
  const cp = await import('node:child_process' as string) as { spawn(cmd: string, args: string[], o: Record<string, unknown>): NonNullable<typeof runner> };
  runner = cp.spawn(nodeProcess.execPath, ['scripts/dev.mjs'], { cwd: await path('../../../../'), env: environment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  runner.stdout?.resume(); runner.stderr?.resume(); // never echoed
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('own stack readiness timeout')), 90000);
    runner!.on('message', m => { if (m === 'S02_INSTALLED_READY') { clearTimeout(timer); ok(); } });
    runner!.once('exit', c => { clearTimeout(timer); fail(new Error('own stack exited ' + String(c))); });
  });
}
async function stopStack() {
  if (!runner || runner.exitCode !== null) return;
  const child = runner; await new Promise<void>(done => { const t = setTimeout(() => { child.kill(); done(); }, 30000); child.once('exit', () => { clearTimeout(t); done(); }); child.send('LOCAL_DEV_STOP'); });
  runner = undefined;
}
async function mailboxCode(email: string): Promise<string> {
  const cp = await import('node:child_process' as string) as { execFile(c: string, a: string[], o: Record<string, unknown>, cb: (e: unknown, out: string) => void): void };
  const server = await path('../../../../servidor/');
  for (let n = 0; n < 30; n++) {
    const out = await new Promise<string>(done => cp.execFile(nodeProcess.execPath, ['scripts/mailbox-installed.mjs', '--email', email], { cwd: server, env: environment(), windowsHide: true }, (_e, o) => done(o ?? '')));
    try { const code = (JSON.parse(out) as { messages: { purpose: string; code: string }[] }).messages.find(m => m.purpose === 'ACTIVATION')?.code; if (code) return code; } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('synthetic mailbox unavailable');
}
/** Fills the password of the form that owns `button`; passkey (virtual) answers the factor. */
async function confirm(page: Page, button: string, suffix: string, method = 'POST', expected = [200, 201]) {
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: button, exact: true }) });
  await form.getByLabel('Contraseña actual').fill(PASSWORD);
  const reply = page.waitForResponse(r => r.url().endsWith(suffix) && r.request().method() === method);
  await form.getByRole('button', { name: button, exact: true }).click();
  const r = await reply; expect(expected).toContain(r.status());
  await expect(page.getByRole('button', { name: 'Enviando…', exact: true })).toHaveCount(0); return r;
}

test.beforeAll(async () => {
  const module = await import(here('../../../../servidor/dist/tests/helpers/local-test-profile.js').href) as { localTestProfile(): Promise<NonNullable<typeof profile>> };
  profile = await module.localTestProfile();
  try { await startStack(); } catch (e) { try { await stopStack(); } finally { await profile.dispose(); } throw e; }
});
test.afterAll(async () => { try { await stopStack(); } finally { await profile?.dispose(); } });

test('P05-S3-UI wizard: negative equity typed in es-CO, double submit of save/commit sends one command each, wrong R has no effect, confirmations never pre-checked, server totals, keyboard and widths', async ({ page }) => {
  page.setDefaultTimeout(15000);
  const observed = new Map<string, unknown>(), sent: { method: string; path: string }[] = [];
  page.on('request', r => { if (/\/opening-files/.test(r.url()) && r.method() !== 'GET') sent.push({ method: r.method(), path: new URL(r.url()).pathname.replace(/[0-9a-f-]{36}/g, '{id}') }); });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const email = `p05s3ui_${Date.now()}@example.test`;
  await page.goto('/#/registro');
  await page.getByLabel('Correo').fill(email); await page.getByLabel('Nombre visible').fill('Persona P05 S3');
  await page.getByLabel('Contraseña').fill(PASSWORD); await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page.getByRole('heading', { name: 'Perfil', exact: true })).toBeVisible();
  let code = await mailboxCode(email);
  await page.goto(`/#/activar?purpose=ACTIVATION&token=${code}`); code = '';
  await page.getByRole('button', { name: 'Activar cuenta', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Proteger mi cuenta' })).toBeVisible();
  await page.getByRole('combobox', { name: /Tipo/ }).selectOption('WEBAUTHN');
  const enrolled = page.waitForResponse(r => r.url().endsWith('/auth/mfa/webauthn/registration/verify'));
  await page.getByRole('button', { name: 'Preparar factor' }).click(); expect((await enrolled).status()).toBe(201);
  await page.goto('/#/organizacion'); await page.getByLabel('Nombre').fill('Libro P05 S3');
  const org = String(((await (await confirm(page, 'Crear organización', '/organizations')).json()) as { data: { organization: { id: string } } }).data.organization.id);
  await page.getByRole('link', { name: 'Abrir el libro de cuentas' }).click();
  await expect(page.getByRole('button', { name: 'Crear cuenta contable' })).toBeVisible();
  for (const [codeName, name, kind, accountClass] of [['BANK_D', 'Banco déficit', 'BANK', 'ASSET'], ['LIAB_D', 'Pasivo déficit', 'GENERAL', 'LIABILITY'], ['EQ_D', 'Patrimonio déficit', 'GENERAL', 'EQUITY']] as const) {
    await page.getByRole('textbox', { name: 'Código', exact: true }).fill(codeName); await page.getByRole('textbox', { name: 'Nombre', exact: true }).fill(name);
    await page.getByRole('combobox', { name: 'Tipo', exact: true }).selectOption(kind);
    if (kind === 'GENERAL') await page.getByRole('combobox', { name: 'Clase', exact: true }).selectOption(accountClass);
    await confirm(page, 'Crear cuenta contable', '/accounts');
  }
  const t = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
  const C = new Date(Date.parse(t + 'T12:00:00Z') - 3 * 86400000).toISOString().slice(0, 10);
  const op = page.getByRole('region', { name: 'Apertura manual', exact: true });
  // Keyboard: the wizard's first field and its primary navigation are reachable.
  await op.getByLabel('Fecha de corte de la apertura').focus(); await page.keyboard.press('Tab');
  let reached = false; for (let i = 0; i < 15 && !reached; i++) { reached = await page.evaluate(() => document.activeElement?.textContent === 'Siguiente'); if (!reached) await page.keyboard.press('Tab'); }
  observed.set('keyboard reaches Siguiente', reached);
  await op.getByLabel('Fecha de corte de la apertura').fill(C); await op.getByRole('button', { name: 'Siguiente', exact: true }).click();
  observed.set('aria-current step', await op.locator('li[aria-current="step"]').textContent());
  await op.getByRole('button', { name: 'Agregar soporte', exact: true }).click();
  await op.getByLabel('Referencia del soporte').fill('P05-S3-SOPORTE'); await op.getByLabel('Fecha del soporte').fill(C); await op.getByLabel('Declaración').selectOption('OWNER_CHECKED');
  await op.getByRole('button', { name: 'Siguiente', exact: true }).click();
  await op.getByRole('button', { name: 'Agregar referencia histórica', exact: true }).click();
  const ref = op.locator('fieldset').filter({ has: page.getByLabel('Tipo de referencia') }).last();
  await ref.getByLabel('Tipo de referencia').selectOption('OBLIGATION'); await ref.getByLabel('Referencia externa').fill('P05-S3-OBL');
  await ref.getByLabel('Contraparte de la obligación').fill('Acreedor sintético'); await ref.getByLabel('Fecha de la obligación').fill(C);
  await ref.getByRole('checkbox', { name: 'P05-S3-SOPORTE', exact: true }).check();
  await op.getByRole('button', { name: 'Siguiente', exact: true }).click();
  for (const [category, label, accountCode, amount, extra] of [['BANK', 'Banco', 'BANK_D', '50', ''], ['LIABILITY', 'Pasivo', 'LIAB_D', '100', 'ref'], ['EQUITY', 'Patrimonio declarado', 'EQ_D', '-50', 'OTHER_DECLARED']] as const) {
    await op.getByRole('button', { name: 'Agregar componente', exact: true }).click();
    const group = op.locator('fieldset').filter({ has: page.getByLabel('Categoría del componente') }).last();
    await group.getByLabel('Categoría del componente').selectOption(category);
    await expect(group.getByText(`Cargando cuentas de ${label}…`, { exact: true })).toBeHidden();
    await group.getByRole('button', { name: `Elegir ${accountCode} para ${label}`, exact: true }).click();
    await group.getByLabel(category === 'EQUITY' ? 'Importe de patrimonio' : 'Importe del componente').fill(amount);
    if (extra === 'ref') await group.getByLabel('Referencia del componente').selectOption({ label: 'P05-S3-OBL' });
    if (category === 'EQUITY') await group.getByLabel('Clase de patrimonio').selectOption(extra);
    await group.getByRole('checkbox', { name: 'P05-S3-SOPORTE', exact: true }).check();
  }
  await op.getByRole('button', { name: 'Siguiente', exact: true }).click(); await op.getByRole('button', { name: 'Siguiente', exact: true }).click();
  // Double submit of the create: one POST only.
  const saveForm = page.locator('form').filter({ has: page.getByRole('button', { name: 'Guardar borrador de apertura', exact: true }) });
  await saveForm.getByLabel('Contraseña actual').fill(PASSWORD);
  const created = page.waitForResponse(r => r.url().endsWith('/opening-files') && r.request().method() === 'POST');
  await saveForm.getByRole('button', { name: 'Guardar borrador de apertura', exact: true }).dblclick();
  const createdReply = await created; await expect(page.getByRole('button', { name: 'Enviando…', exact: true })).toHaveCount(0);
  const body = createdReply.request().postDataJSON() as { snapshot: { components: { amount: string }[] } };
  observed.set('create', { status: createdReply.status(), wireAmounts: body.snapshot.components.map(c => c.amount), createPosts: sent.filter(s => s.method === 'POST' && s.path.endsWith('/opening-files')).length });
  const openingId = String(((await createdReply.json()) as { data: { id: string } }).data.id);
  const validated = await confirm(page, 'Validar con el servidor', `/opening-files/${openingId}/validations`);
  const report = ((await validated.json()) as { data: { report: { issues: unknown[]; totals: Record<string, string> } } }).data.report;
  const conciliation = page.getByRole('region', { name: 'Conciliación del servidor' });
  observed.set('server report', { issues: report.issues.length, assets: report.totals['assets'], liabilities: report.totals['liabilities'], equity: report.totals['equity'], debit: report.totals['debit'], credit: report.totals['credit'],
    shownEquity: await conciliation.getByText('Patrimonio -50 COP (-50.00)', { exact: true }).count() });
  const approveBox = op.getByRole('checkbox', { name: /Apruebo el expediente validado/ });
  observed.set('approve checkbox pre-checked', await approveBox.isChecked());
  observed.set('approve button disabled before consent', await page.getByRole('button', { name: 'Aprobar apertura', exact: true }).isDisabled());
  // Wrong password: no approval, state unchanged.
  await approveBox.check();
  const approveForm = page.locator('form').filter({ has: page.getByRole('button', { name: 'Aprobar apertura', exact: true }) });
  await approveForm.getByLabel('Contraseña actual').fill('synthetic wrong passphrase 0000');
  const wrongR = page.waitForResponse(r => r.url().endsWith('/auth/reauthenticate'));
  await approveForm.getByRole('button', { name: 'Aprobar apertura', exact: true }).click(); const wrongReply = await wrongR;
  await expect(page.getByRole('button', { name: 'Enviando…', exact: true })).toHaveCount(0);
  const read = async (p: string) => page.evaluate(async url => { const r = await fetch(url); return { status: r.status, body: await r.json() as { data?: Record<string, unknown> } }; }, p);
  const base = `/api/v1/organizations/${org}/financial`;
  observed.set('wrong password on approve', { a32: wrongReply.status(), approvalPosts: sent.filter(s => s.path.endsWith('/approval')).length, state: (await read(`${base}/opening-files/${openingId}`)).body.data?.['status'], alert: (await page.getByRole('alert').count()) > 0 });
  await confirm(page, 'Aprobar apertura', `/opening-files/${openingId}/approval`);
  const commitBox = op.getByRole('checkbox', { name: /Confirmo el corte, los soportes/ });
  observed.set('commit checkbox pre-checked', await commitBox.isChecked());
  await commitBox.check();
  const commitForm = page.locator('form').filter({ has: page.getByRole('button', { name: 'Confirmar apertura en el libro', exact: true }) });
  await commitForm.getByLabel('Contraseña actual').fill(PASSWORD);
  const committed = page.waitForResponse(r => r.url().endsWith(`/opening-files/${openingId}/commit`) && r.request().method() === 'POST');
  await commitForm.getByRole('button', { name: 'Confirmar apertura en el libro', exact: true }).dblclick();
  const commitReply = await committed; await expect(page.getByRole('button', { name: 'Enviando…', exact: true })).toHaveCount(0);
  await expect(op.getByText(/El servidor confirmó la apertura al corte/)).toBeVisible();
  const journals = await read(`${base}/journal-entries`);
  const items = (journals.body.data?.['items'] ?? []) as { source: { type: string }; lines: { debit: string; credit: string }[] }[];
  observed.set('commit', { status: commitReply.status(), commitPosts: sent.filter(s => s.path.endsWith('/commit')).length, journals: items.length, source: items[0]?.source.type, lines: items[0]?.lines.map(l => `${l.debit}/${l.credit}`).sort() });
  const layout: Record<string, boolean> = {};
  for (const width of [360, 390, 768, 1024, 1440]) { await page.setViewportSize({ width, height: 900 }); layout[String(width)] = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1); }
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; }); layout['zoom 200% @1440'] = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  await page.evaluate(() => { document.documentElement.style.zoom = '1'; });
  observed.set('overflow by width', layout);
  observed.set('storage / URL leaks', { storage: await page.evaluate(() => localStorage.length + sessionStorage.length), tokenInUrl: page.url().includes('token=') });
  evidence('P05-S3-UI', { observed: Object.fromEntries(observed) });
  expect(observed.get('keyboard reaches Siguiente')).toBe(true);
  expect(observed.get('create')).toEqual({ status: 201, wireAmounts: ['50.00', '100.00', '-50.00'], createPosts: 1 });
  expect(observed.get('server report')).toEqual({ issues: 0, assets: '50.00', liabilities: '100.00', equity: '-50.00', debit: '100.00', credit: '100.00', shownEquity: 1 });
  expect(observed.get('approve checkbox pre-checked')).toBe(false); expect(observed.get('approve button disabled before consent')).toBe(true);
  const wrong = observed.get('wrong password on approve') as { a32: number; approvalPosts: number; state: string; alert: boolean };
  expect(wrong.a32).toBeGreaterThanOrEqual(400); expect([wrong.approvalPosts, wrong.state, wrong.alert]).toEqual([0, 'VALIDATED', true]);
  expect(observed.get('commit checkbox pre-checked')).toBe(false);
  expect(observed.get('commit')).toEqual({ status: 201, commitPosts: 1, journals: 1, source: 'OPENING', lines: ['0.00/100.00', '50.00/0.00', '50.00/0.00'] });
  for (const [k, v] of Object.entries(layout)) expect(v, k).toBe(false);
  expect(observed.get('storage / URL leaks')).toEqual({ storage: 0, tokenInUrl: false });
});
