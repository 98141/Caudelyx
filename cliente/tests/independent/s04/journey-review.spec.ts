// S04-P05 independent browser journey (Claude) on the REAL root launcher (scripts/dev.mjs) in the reserved profile
// (UI 5381 -> API 5481, platform 5382; own group 0ab952f9c56cf678d2a28eee created/dropped by p05-profile).
// Registration -> terminal mailbox (memory only) -> LINK -> passkey (Chromium virtual authenticator with UV) -> org ->
// accounts -> borrowers (homonym warning) -> quote (server == own oracle) -> save -> wrong R -> confirm -> DB cross-check.
// Node-only modules are loaded dynamically so this file does not change the client app typecheck.
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'synthetic P05 S04 browser passphrase 2468';
const RUN_ID = '0ab952f9c56cf678d2a28eee';
const nodeProcess = (globalThis as unknown as { process: { env: Record<string, string | undefined>; execPath: string; cwd(): string; chdir(d: string): void } }).process;
const here = (relative: string) => new URL(relative, import.meta.url);
type Group = { dispose(reason?: string): Promise<void> };
let group: Group | undefined;
let runner: { send(m: string): void; exitCode: number | null; on(e: string, f: (m: unknown) => void): void; once(e: string, f: (c: unknown) => void): void; stdout: { resume(): void } | null; stderr: { resume(): void } | null; kill(): void } | undefined;
const evidence = (name: string, data: Record<string, unknown>) => console.log(JSON.stringify({ evidence: name, ...data }));
async function path(relative: string): Promise<string> { const url = await import('node:url' as string) as { fileURLToPath(u: URL): string }; return url.fileURLToPath(here(relative)); }
function environment() {
  const e: Record<string, string | undefined> = { ...nodeProcess.env, CAUDELYX_MODE: 'local-synthetic', CAUDELYX_DEV_TEST_ID: RUN_ID, CAUDELYX_DEV_UI_PORT: '5381', CAUDELYX_DEV_API_PORT: '5481', CAUDELYX_DEV_PLATFORM_PORT: '5382' };
  for (const k of ['MONGODB_URI', 'MONGODB_DATABASE', 'CAUDELYX_DEV_SMOKE']) delete e[k];
  return e;
}
async function startStack() {
  const cp = await import('node:child_process' as string) as { spawn(cmd: string, args: string[], o: Record<string, unknown>): NonNullable<typeof runner> };
  runner = cp.spawn(nodeProcess.execPath, ['scripts/dev.mjs'], { cwd: await path('../../../../'), env: environment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  runner.stdout?.resume(); runner.stderr?.resume(); // never echoed
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('own stack readiness timeout')), 120000);
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
/** Own-group DB read (never another database): exact name from the reserved profile. */
async function ownDb<T>(fn: (db: { collection(n: string): { countDocuments(f?: object): Promise<number>; find(f?: object): { toArray(): Promise<Record<string, unknown>[]> } } }) => Promise<T>): Promise<T> {
  const mod = await import(new URL('../../../../servidor/node_modules/mongodb/lib/index.js', import.meta.url).href) as { MongoClient: new (u: string, o: object) => { connect(): Promise<void>; db(n: string): never; close(): Promise<void> } };
  const c = new mod.MongoClient('mongodb://127.0.0.1:27017/?replicaSet=rs0', { appName: 'S04_P05_E2E_READ', serverSelectionTimeoutMS: 3000 });
  await c.connect(); try { return await fn(c.db('caudelyx_s02_test_' + RUN_ID)); } finally { await c.close(); }
}
/** Fills the password of the group with `legend`; the virtual passkey answers the factor (TOTP left empty). */
async function proof(page: Page, legend: string, pass = PASSWORD) {
  const g = page.getByRole('group', { name: legend, exact: true });
  await g.getByLabel('Contraseña actual', { exact: true }).fill(pass);
}
async function confirm(page: Page, button: string, suffix: string, method = 'POST') {
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: button, exact: true }) });
  await form.getByLabel('Contraseña actual').fill(PASSWORD);
  const reply = page.waitForResponse(r => new URL(r.url()).pathname.endsWith(suffix) && r.request().method() === method);
  await form.getByRole('button', { name: button, exact: true }).click();
  const r = await reply; expect([200, 201]).toContain(r.status());
  await expect(page.getByRole('button', { name: 'Enviando…', exact: true })).toHaveCount(0); return r;
}

test.beforeAll(async () => {
  const cwd = nodeProcess.cwd(); nodeProcess.chdir(await path('../../../../servidor/'));
  try { const mod = await import(here('../../../../servidor/dist/tests/independent/s04/p05-profile.js').href) as { reviewProfile(): Promise<Group> }; group = await mod.reviewProfile(); }
  finally { nodeProcess.chdir(cwd); }
  try { await startStack(); } catch (e) { try { await stopStack(); } finally { await group!.dispose('setup-error'); } throw e; }
});
test.afterAll(async () => {
  try { await stopStack(); } finally {
    const cwd = nodeProcess.cwd(); nodeProcess.chdir(await path('../../../../servidor/'));
    try { await group?.dispose('end'); } finally { nodeProcess.chdir(cwd); }
  }
});

test('P05-S4-UI journey: real auth + passkey, borrowers, quote == own oracle, one command per double click, wrong R no effect, no ledger, H04, widths', async ({ page }) => {
  page.setDefaultTimeout(20000);
  const observed = new Map<string, unknown>(), sent: { method: string; path: string }[] = [];
  page.on('request', r => { if (/\/(loan-quotes|loans|borrowers)/.test(r.url()) && r.method() !== 'GET') sent.push({ method: r.method(), path: new URL(r.url()).pathname.replace(/[0-9a-f-]{36}/g, '{id}') }); });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const email = `p05s4ui_${Date.now()}@example.test`;
  await page.goto('/#/registro');
  await page.getByLabel('Correo').fill(email); await page.getByLabel('Nombre visible').fill('Persona P05 S4');
  await page.getByLabel('Contraseña').fill(PASSWORD); await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page).toHaveURL(/#\/perfil$/);
  let code = await mailboxCode(email);
  await page.goto(`/#/activar?purpose=ACTIVATION&token=${code}`); code = '';
  await page.getByRole('button', { name: 'Activar cuenta', exact: true }).click();
  await expect(page.getByText(/Correo confirmado/).first()).toBeVisible();
  // First factor (AJ-ONB current flow, consumed as-is): password again + passkey of this device.
  await page.goto('/#/seguridad');
  await page.getByLabel('Contraseña actual', { exact: true }).fill(PASSWORD);
  await page.locator('select').filter({ has: page.locator('option[value="WEBAUTHN"]') }).first().selectOption('WEBAUTHN');
  const enrolled = page.waitForResponse(r => r.url().endsWith('/auth/mfa/webauthn/registration/verify'));
  await page.getByRole('button', { name: 'Preparar factor' }).click(); expect((await enrolled).status()).toBe(201);
  if (await page.getByText(/Vuelve a ingresar/).count()) {
    await page.goto('/#/ingresar'); await page.getByLabel('Correo', { exact: true }).fill(email); await page.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
    const passkey = page.getByRole('button', { name: /passkey/i }).first(); if (await passkey.count()) await passkey.click();
  }
  observed.set('onboarding consumed', { headings: await page.getByRole('heading').allTextContents() });
  await page.goto('/#/organizacion'); await expect(page.getByRole('heading', { name: 'Crear la organización' })).toBeVisible(); await page.getByLabel('Nombre').fill('Cartera P05 S4');
  await confirm(page, 'Crear organización', '/organizations');
  await page.getByRole('link', { name: 'Abrir el libro de cuentas' }).click();
  await expect(page.getByRole('button', { name: 'Crear cuenta contable' })).toBeVisible();
  for (const [c, name, kind, cls] of [['CASH_P05', 'Caja sintética P05', 'CASH', 'ASSET'], ['EQ_P05', 'Patrimonio sintético P05', 'GENERAL', 'EQUITY']] as const) {
    await page.getByRole('textbox', { name: 'Código', exact: true }).fill(c); await page.getByRole('textbox', { name: 'Nombre', exact: true }).fill(name);
    await page.getByRole('combobox', { name: 'Tipo', exact: true }).selectOption(kind);
    if (kind === 'GENERAL') await page.getByRole('combobox', { name: 'Clase', exact: true }).selectOption(cls);
    await confirm(page, 'Crear cuenta contable', '/accounts');
  }
  // Borrowers: two homonyms through the real screen (password + passkey per command).
  await page.goto('/#/prestatarios');
  await expect(page.getByRole('heading', { name: 'Prestatarios', exact: true })).toBeVisible();
  const created: string[] = [];
  for (const [c, n] of [['P05_UI_A', 'María José Pérez'], ['P05_UI_B', 'maría  josé pérez']] as const) {
    await page.getByLabel('Código', { exact: true }).fill(c); await page.getByLabel('Nombre', { exact: true }).fill(n);
    await proof(page, 'Confirmar el guardado de la ficha');
    const reply = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/borrowers') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Crear ficha', exact: true }).dblclick();
    const r = await reply; expect(r.status()).toBe(201); created.push(String(((await r.json()) as { data: { id: string } }).data.id));
    await expect(page.getByRole('button', { name: 'Enviando…', exact: true })).toHaveCount(0);
    if (c === 'P05_UI_A') await page.getByRole('button', { name: 'Nueva ficha', exact: true }).click();
  }
  observed.set('borrower create POSTs after two double clicks', sent.filter(s => s.method === 'POST' && s.path.endsWith('/borrowers')).length);
  observed.set('homonym warning visible', await page.getByText(/P05_UI_A · María José Pérez/).count());
  // Loans: quote through the UI, compared with the own oracle in Node.
  await page.goto('/#/prestamos');
  await page.getByLabel('Prestatario').selectOption({ label: 'P05_UI_B · maría josé pérez' }).catch(async () => { await page.getByLabel('Prestatario').selectOption(created[1]!); });
  await page.getByRole('button', { name: 'Elegir CASH_P05 para Cuenta prevista de desembolso', exact: true }).click();
  await page.getByLabel('Capital', { exact: true }).fill('2.500,75'); await page.getByLabel('Modalidad').selectOption('LEVEL_PAYMENT');
  await page.getByLabel('Frecuencia de la cuota').selectOption('SEMIMONTH'); await page.getByLabel('Clase de tasa').selectOption('EFFECTIVE');
  await page.getByLabel('Unidad de la tasa').selectOption('YEAR'); await page.getByLabel('Tasa en porcentaje', { exact: true }).fill('26,5');
  await page.getByLabel('Fecha de inicio', { exact: true }).fill('2024-01-15'); await page.getByLabel('Fecha de la primera cuota', { exact: true }).fill('2024-01-31');
  await page.getByLabel('Número de cuotas', { exact: true }).fill('12');
  const quoted = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/loan-quotes') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Ver cronograma', exact: true }).dblclick();
  const qr = await quoted; expect(qr.status()).toBe(201);
  const wire = qr.request().postDataJSON() as { terms: Record<string, unknown> }, quote = ((await qr.json()) as { data: Record<string, unknown> & { id: string; fingerprint: string; schedule: { payment: string; date: string }[] } }).data;
  const oracleMod = await import(here('../../../../servidor/dist/tests/independent/s04/oracle.js').href) as { oracle(t: unknown): { value?: Record<string, unknown>; error?: string } };
  const mine = oracleMod.oracle(wire.terms);
  const equal = JSON.stringify({ schedule: quote['schedule'], totals: quote['totals'], periodicRate24: quote['periodicRate24'], basePayment: quote['basePayment'], finalPaymentAdjustment: quote['finalPaymentAdjustment'] }) === JSON.stringify(mine.value);
  const schedule = page.getByRole('region', { name: 'Cronograma simulado' });
  await expect(schedule.getByRole('cell', { name: '2024-01-31', exact: true })).toBeVisible();
  observed.set('quote', { wire: { principal: wire.terms['principal'], rate: wire.terms['rate'], frequency: wire.terms['frequency'] }, equalsOwnOracle: equal, payments: quote.schedule.slice(0, 2).map(r => r.payment), lastDate: quote.schedule.at(-1)?.date,
    postsAfterDoubleClick: sent.filter(s => s.path.endsWith('/loan-quotes')).length, firstPaymentShown: await schedule.getByRole('cell', { name: `${quote.schedule[0]!.payment.replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')} COP`, exact: true }).count() });
  expect(equal).toBe(true);
  // Save draft: double click -> one POST.
  await proof(page, 'Guardar los términos de esta simulación');
  const saved = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/loans') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Guardar borrador de términos', exact: true }).dblclick();
  const sr = await saved; expect(sr.status()).toBe(201); const loan = ((await sr.json()) as { data: { id: string; status: string } }).data;
  await expect(page.getByRole('button', { name: 'Enviando…', exact: true })).toHaveCount(0);
  const box = page.getByRole('checkbox', { name: /Confirmo estos términos/ });
  observed.set('save', { status: sr.status(), loanStatus: loan.status, loanPosts: sent.filter(s => s.method === 'POST' && s.path.endsWith('/loans')).length, confirmPreChecked: await box.isChecked(), confirmDisabledBeforeConsent: await page.getByRole('button', { name: 'Confirmar términos', exact: true }).isDisabled() });
  // Wrong password: A32 rejects, no confirmation POST, loan stays DRAFT.
  await box.check(); await proof(page, 'Confirmar términos', 'contraseña equivocada sintetica 000');
  const a32 = page.waitForResponse(r => r.url().endsWith('/auth/reauthenticate'));
  await page.getByRole('button', { name: 'Confirmar términos', exact: true }).click();
  const wrong = await a32; await expect(page.getByRole('alert').first()).toBeVisible();
  const afterWrong = await ownDb(async db => (await db.collection('lending_loans').find({ _id: loan.id }).toArray())[0]?.['status']);
  observed.set('wrong R', { a32: wrong.status(), confirmationPosts: sent.filter(s => s.path.endsWith('/confirmation')).length, loanStatus: afterWrong });
  expect(wrong.status()).toBeGreaterThanOrEqual(400); expect(sent.filter(s => s.path.endsWith('/confirmation')).length).toBe(0);
  // Correct confirmation.
  if (!await box.isChecked()) await box.check();
  await proof(page, 'Confirmar términos');
  const conf = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/confirmation') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Confirmar términos', exact: true }).click();
  const cr = await conf; expect(cr.status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Enviando…', exact: true })).toHaveCount(0);
  // DB cross-check in the OWN group: no journal, book marker, disbursement field; one confirmed loan.
  const db = await ownDb(async d => ({ journals: await d.collection('financial_journals').countDocuments(), bookMarkers: await d.collection('financial_books').countDocuments({ openingId: { $exists: true } }),
    loans: (await d.collection('lending_loans').find().toArray()).map(l => ({ status: l['status'], termsVersion: l['termsVersion'], forbidden: ['isDisbursed', 'outstandingBalance', 'disbursedAt'].filter(k => k in l) })),
    quotes: await d.collection('lending_quotes').countDocuments(), lendingAudits: await d.collection('audit_events').countDocuments({ action: /^LENDING_/ }) }));
  observed.set('own DB after confirmation', db);
  expect(db.journals).toBe(0); expect(db.loans).toEqual([{ status: 'TERMS_CONFIRMED', termsVersion: 1, forbidden: [] }]);
  // H04: saved list, labels, UUIDs as main text.
  const listButtons = await page.locator('section').filter({ has: page.getByRole('heading', { name: 'Términos guardados' }) }).getByRole('button').allTextContents();
  const uuidMain = await page.evaluate(() => [...document.querySelectorAll('main *')].filter(e => e.children.length === 0 && /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(e.textContent ?? '')).map(e => (e.className || e.tagName) + ': ' + (e.textContent ?? '').replace(/[0-9a-f-]{36}/gi, '<uuid>').slice(0, 70)));
  observed.set('H04', { savedLoanButtons: listButtons.filter(t => /versión/.test(t)), uuidLeafTexts: uuidMain, borrowerLabelShown: await page.getByText('P05_UI_B · maría josé pérez').count(), accountLabelShown: await page.getByText('CASH_P05 · Caja sintética P05').count() });
  // Keyboard, widths, CSS zoom (not native zoom), storage/URL.
  await page.keyboard.press('Control+Home'); await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.tagName);
  const widths: Record<string, boolean> = {};
  for (const width of [360, 390, 768, 1024, 1440]) { await page.setViewportSize({ width, height: 900 }); widths[String(width)] = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1); }
  await page.evaluate(() => { document.body.style.zoom = '2'; }); widths['css zoom 200% @1440'] = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1); await page.evaluate(() => { document.body.style.zoom = ''; });
  observed.set('a11y/layout', { firstTabFocus: focused, overflowByWidth: widths, storage: await page.evaluate(() => localStorage.length + sessionStorage.length), tokenInUrl: /token|code=/.test(page.url()) });
  evidence('P05-S4-UI', { observed: Object.fromEntries(observed) });
  expect(Object.entries(widths).filter(([k]) => !k.startsWith('css')).every(([, v]) => v === false)).toBe(true);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});
