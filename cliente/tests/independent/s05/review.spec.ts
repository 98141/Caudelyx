// S05-P05-v2 independent browser journey (Claude) on the REAL root launcher (scripts/dev.mjs) in the reserved profile
// (UI 5391 -> API 5491, platform 5392; own group a2f0795c4990bcb883a92572 created/dropped by review-profile).
// Onboarding (current AJ flow, consumed as-is) -> passkey (virtual authenticator) -> org -> accounts -> S2 funding journal
// -> borrower -> S4 terms (past due dates, real clock) -> S5 disburse -> accrue -> partial receipt -> credit application,
// each with preview, consent, password+passkey R. Money is cross-checked against the OWN oracle and the OWN group's DB.
import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'synthetic P05 S05 browser passphrase 9753';
const RUN_ID = 'a2f0795c4990bcb883a92572';
const nodeProcess = (globalThis as unknown as { process: { env: Record<string, string | undefined>; execPath: string; cwd(): string; chdir(d: string): void } }).process;
const here = (relative: string) => new URL(relative, import.meta.url);
type Group = { dispose(reason?: string): Promise<void> };
let group: Group | undefined;
let runner: { send(m: string): void; exitCode: number | null; on(e: string, f: (m: unknown) => void): void; once(e: string, f: (c: unknown) => void): void; stdout: { resume(): void } | null; stderr: { resume(): void } | null; kill(): void } | undefined;
const evidence = (name: string, data: Record<string, unknown>) => console.log(JSON.stringify({ evidence: name, ...data }));
async function path(relative: string): Promise<string> { const url = await import('node:url' as string) as { fileURLToPath(u: URL): string }; return url.fileURLToPath(here(relative)); }
function environment() {
  const e: Record<string, string | undefined> = { ...nodeProcess.env, CAUDELYX_MODE: 'local-synthetic', CAUDELYX_DEV_TEST_ID: RUN_ID, CAUDELYX_DEV_UI_PORT: '5391', CAUDELYX_DEV_API_PORT: '5491', CAUDELYX_DEV_PLATFORM_PORT: '5392' };
  for (const k of ['MONGODB_URI', 'MONGODB_DATABASE', 'CAUDELYX_DEV_SMOKE']) delete e[k];
  return e;
}
async function startStack() {
  const cp = await import('node:child_process' as string) as { spawn(cmd: string, args: string[], o: Record<string, unknown>): NonNullable<typeof runner> };
  runner = cp.spawn(nodeProcess.execPath, ['scripts/dev.mjs'], { cwd: await path('../../../../'), env: environment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  runner.stdout?.resume(); runner.stderr?.resume();
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
    try { const code = (JSON.parse(out) as { messages: { purpose: string; code: string }[] }).messages.find(m => m.purpose === 'ACTIVATION')?.code; if (code) return code; } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('synthetic mailbox unavailable');
}
async function ownDb<T>(fn: (db: { collection(n: string): { countDocuments(f?: object): Promise<number>; find(f?: object): { toArray(): Promise<Record<string, unknown>[]> } } }) => Promise<T>): Promise<T> {
  const mod = await import(new URL('../../../../servidor/node_modules/mongodb/lib/index.js', import.meta.url).href) as { MongoClient: new (u: string, o: object) => { connect(): Promise<void>; db(n: string): never; close(): Promise<void> } };
  const c = new mod.MongoClient('mongodb://127.0.0.1:27017/?replicaSet=rs0', { appName: 'S05_P05_E2E_READ', serverSelectionTimeoutMS: 3000 });
  await c.connect(); try { return await fn(c.db('caudelyx_s02_test_' + RUN_ID)); } finally { await c.close(); }
}
async function confirm(page: Page, button: string, suffix: string, method = 'POST') {
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: button, exact: true }) });
  await form.getByLabel('Contraseña actual').fill(PASSWORD);
  const reply = page.waitForResponse(r => new URL(r.url()).pathname.endsWith(suffix) && r.request().method() === method);
  await form.getByRole('button', { name: button, exact: true }).click();
  const r = await reply; expect([200, 201], `${button} ${r.status()}`).toContain(r.status());
  await expect(page.getByRole('button', { name: 'Enviando…', exact: true })).toHaveCount(0); return r;
}
/** Preview -> consent -> password (+ virtual passkey) -> command; returns the command reply. */
async function planAndConfirm(page: Page, ask: string, confirmLabel: string, suffix: string, opts: { doubleClick?: boolean } = {}) {
  const pv = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/loan-operation-previews'));
  await page.getByRole('button', { name: ask, exact: true }).click(); const previewReply = await pv; expect(previewReply.status(), 'preview').toBe(200);
  const plan = page.getByRole('region', { name: 'Plan del servidor' });
  const box = plan.getByRole('checkbox'); const preChecked = await box.isChecked(); const disabledBefore = await plan.getByRole('button', { name: confirmLabel, exact: true }).isDisabled();
  await box.check(); await plan.getByLabel('Contraseña actual').fill(PASSWORD);
  const cmd = page.waitForResponse(r => new URL(r.url()).pathname.endsWith(suffix) && r.request().method() === 'POST');
  if (opts.doubleClick) await plan.getByRole('button', { name: confirmLabel, exact: true }).dblclick(); else await plan.getByRole('button', { name: confirmLabel, exact: true }).click();
  const r = await cmd; await expect(page.getByText('El servidor confirmó el comando. Esto no habilita un préstamo real.')).toBeVisible();
  return { reply: r, preview: await previewReply.json() as { data: { plan: { allocations: { component: string; amount: string; installmentNumber: number }[]; postings: { accountId: string; debit: string; credit: string }[] } } }, preChecked, disabledBefore };
}

test.beforeAll(async () => {
  const cwd = nodeProcess.cwd(); nodeProcess.chdir(await path('../../../../servidor/'));
  try { const mod = await import(here('../../../../servidor/dist/tests/independent/s05/review-profile.js').href) as { reviewProfile(): Promise<Group> }; group = await mod.reviewProfile(); }
  finally { nodeProcess.chdir(cwd); }
  try { await startStack(); } catch (e) { try { await stopStack(); } finally { await group!.dispose('setup-error'); } throw e; }
});
test.afterAll(async () => {
  try { await stopStack(); } finally { const cwd = nodeProcess.cwd(); nodeProcess.chdir(await path('../../../../servidor/')); try { await group?.dispose('end'); } finally { nodeProcess.chdir(cwd); } }
});

test('P05-S5-UI journey: disburse -> accrue -> partial receipt, server == own oracle == own DB; consent/R/double click; H05; widths', async ({ page }) => {
  page.setDefaultTimeout(20000);
  const observed = new Map<string, unknown>(), sent: { method: string; path: string }[] = [];
  page.on('request', r => { if (/\/loan-operations\//.test(r.url()) && r.method() === 'POST') sent.push({ method: r.method(), path: new URL(r.url()).pathname.replace(/[0-9a-f-]{36}/g, '{id}') }); });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const email = `p05s5ui_${Date.now()}@example.test`;
  await page.goto('/#/registro');
  await page.getByLabel('Correo').fill(email); await page.getByLabel('Nombre visible').fill('Persona P05 S5');
  await page.getByLabel('Contraseña').fill(PASSWORD); await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  let code = await mailboxCode(email);
  await page.goto(`/#/activar?purpose=ACTIVATION&token=${code}`); code = '';
  await page.getByRole('button', { name: 'Activar cuenta', exact: true }).click();
  await expect(page.getByText(/Correo confirmado/).first()).toBeVisible();
  await page.goto('/#/seguridad');
  await page.getByLabel('Contraseña actual', { exact: true }).first().fill(PASSWORD);
  await page.locator('select').filter({ has: page.locator('option[value="WEBAUTHN"]') }).first().selectOption('WEBAUTHN');
  const enrolled = page.waitForResponse(r => r.url().endsWith('/auth/mfa/webauthn/registration/verify'));
  await page.getByRole('button', { name: 'Preparar factor' }).click(); expect((await enrolled).status()).toBe(201);
  if (await page.getByText(/Vuelve a ingresar/).count()) {
    await page.goto('/#/ingresar'); await page.getByLabel('Correo', { exact: true }).fill(email); await page.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  }
  await page.goto('/#/organizacion'); await expect(page.getByRole('heading', { name: 'Crear la organización' })).toBeVisible(); await page.getByLabel('Nombre').fill('Cartera P05 S5');
  await confirm(page, 'Crear organización', '/organizations');
  await page.getByRole('link', { name: 'Abrir el libro de cuentas' }).click();
  await expect(page.getByRole('button', { name: 'Crear cuenta contable' })).toBeVisible();
  const ids: Record<string, string> = {};
  for (const [c, name, kind, cls] of [['BANK_S5', 'Banco sintético S5', 'BANK', 'ASSET'], ['P_S5', 'Capital por cobrar S5', 'GENERAL', 'ASSET'], ['I_S5', 'Interés por cobrar S5', 'GENERAL', 'ASSET'], ['Y_S5', 'Ingreso por interés S5', 'GENERAL', 'INCOME'], ['C_S5', 'Saldo a favor S5', 'GENERAL', 'LIABILITY'], ['EQ_S5', 'Patrimonio S5', 'GENERAL', 'EQUITY']] as const) {
    await page.getByRole('textbox', { name: 'Código', exact: true }).fill(c); await page.getByRole('textbox', { name: 'Nombre', exact: true }).fill(name);
    await page.getByRole('combobox', { name: 'Tipo', exact: true }).selectOption(kind);
    if (kind === 'GENERAL') await page.getByRole('combobox', { name: 'Clase', exact: true }).selectOption(cls);
    ids[c] = String(((await (await confirm(page, 'Crear cuenta contable', '/accounts')).json()) as { data: { id: string } }).data.id);
  }
  // S2 funding journal through the real finance UI.
  const journal = page.getByRole('region', { name: 'Asiento', exact: true });
  await expect(journal.getByText('Cargando cuentas de línea 1…')).toHaveCount(0); await page.waitForTimeout(1500);
  observed.set('journal picker lists accounts created in this visit (before reload)', await journal.getByRole('button', { name: 'Elegir BANK_S5 para línea 1', exact: true }).count());
  await page.reload(); await expect(journal.getByText('Cargando cuentas de línea 1…')).toHaveCount(0);
  for (const [index, account, side] of [[1, 'BANK_S5', 'debit'], [2, 'EQ_S5', 'credit']] as const) { const line = journal.getByRole('group', { name: `Línea ${index}` }); await line.getByRole('button', { name: `Elegir ${account} para línea ${index}`, exact: true }).click(); await line.getByLabel('Lado').selectOption(side); await line.getByLabel('Importe').fill('2.500.000'); }
  await journal.getByRole('textbox', { name: 'Soporte', exact: true }).fill('P05-S5-APORTE'); await journal.getByRole('textbox', { name: 'Descripción', exact: true }).fill('Aporte sintético P05 S5');
  await confirm(page, 'Contabilizar asiento', '/journal-entries');
  // Borrower and S4 terms with due dates already reached (real clock): monthly anchor = today's day, three months back.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date()), [y, mo, d] = today.split('-').map(Number) as [number, number, number];
  test.skip(d > 28, 'anchor day >28 would need month-end handling; rerun on another day');
  const shift = (k: number) => { const t = new Date(Date.UTC(y, mo - 1 + k, d)); return t.toISOString().slice(0, 10); };
  const eff = shift(-3), first = shift(-2);
  await page.goto('/#/prestatarios'); await expect(page.getByRole('heading', { name: 'Prestatarios', exact: true })).toBeVisible();
  await page.getByLabel('Código', { exact: true }).fill('P05_S5_UI'); await page.getByLabel('Nombre', { exact: true }).fill('Persona cartera S5');
  await page.getByRole('group', { name: 'Confirmar el guardado de la ficha', exact: true }).getByLabel('Contraseña actual', { exact: true }).fill(PASSWORD);
  const bReply = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/borrowers') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Crear ficha', exact: true }).click(); expect((await bReply).status()).toBe(201);
  await page.goto('/#/prestamos');
  await page.getByLabel('Prestatario').selectOption({ label: 'P05_S5_UI · Persona cartera S5' });
  await page.getByRole('button', { name: 'Elegir BANK_S5 para Cuenta prevista de desembolso', exact: true }).click();
  await page.getByLabel('Capital', { exact: true }).fill('2.000.000'); await page.getByLabel('Modalidad').selectOption('CONSTANT_PRINCIPAL');
  await page.getByLabel('Frecuencia de la cuota').selectOption('MONTH'); await page.getByLabel('Clase de tasa').selectOption('EFFECTIVE');
  await page.getByLabel('Unidad de la tasa').selectOption('MONTH'); await page.getByLabel('Tasa en porcentaje', { exact: true }).fill('3');
  await page.getByLabel('Fecha de inicio', { exact: true }).fill(eff); await page.getByLabel('Fecha de la primera cuota', { exact: true }).fill(first);
  await page.getByLabel('Número de cuotas', { exact: true }).fill('4');
  const qReply = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/loan-quotes') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Ver cronograma', exact: true }).click(); const quote = (await (await qReply).json()) as { data: { terms: Record<string, unknown> } };
  await page.getByRole('group', { name: 'Guardar los términos de esta simulación', exact: true }).getByLabel('Contraseña actual', { exact: true }).fill(PASSWORD);
  const lReply = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/loans') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Guardar borrador de términos', exact: true }).click(); const loanId = String(((await (await lReply).json()) as { data: { id: string } }).data.id);
  await page.getByRole('checkbox', { name: /Confirmo estos términos/ }).check();
  await page.getByRole('group', { name: 'Confirmar términos', exact: true }).getByLabel('Contraseña actual', { exact: true }).fill(PASSWORD);
  const cReply = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/confirmation'));
  await page.getByRole('button', { name: 'Confirmar términos', exact: true }).click(); expect((await cReply).status()).toBe(200);
  // Own oracle for the same terms (computed in Node, never in the page).
  const oracleMod = await import(here('../../../../servidor/dist/tests/independent/s05/economic-oracle.js').href) as { Book: new () => { fund(a: string, v: bigint): void; addLoan(i: string, b: string, t: unknown): void; disburse(i: string, a: string): { postings: { account: string; debit: bigint; credit: bigint }[] }; accrue(i: string, th: string, td: string): { postings: unknown[] }; collect(k: string, b: string, a: bigint, t: unknown[], td: string, o: unknown): { applications: { component: string; amount: bigint; k: number }[] }; balances: Map<string, bigint>; credit: Map<string, bigint> }; c(s: string): bigint; m(v: bigint): string };
  const book = new oracleMod.Book(); book.fund('CASH', oracleMod.c('2500000.00')); book.addLoan(loanId, 'B', quote.data.terms); book.disburse(loanId, 'CASH');
  // S5 operations screen.
  await page.goto('/#/operaciones');
  const item = page.getByRole('button', { name: 'P05_S5_UI · Persona cartera S5 · 2.000.000 COP · Sin desembolso · versión 0' });
  observed.set('H05 list item before disbursement', await item.waitFor({ state: 'visible' }).then(() => 1, () => 0));
  await item.click(); await expect(page.getByRole('region', { name: 'Detalle de la posición' })).toBeVisible();
  await page.getByLabel('Referencia de soporte').fill('SYN-UI-S5');
  for (const [field, c2] of [['Cuenta de capital por cobrar', 'P_S5'], ['Cuenta de interés por cobrar', 'I_S5'], ['Cuenta de ingreso por interés', 'Y_S5'], ['Cuenta de saldo a favor', 'C_S5']] as const) await page.getByRole('button', { name: `Elegir ${c2} para ${field}`, exact: true }).click();
  observed.set('ineligible offered for capital account', await page.getByRole('button', { name: /Elegir (EQ_S5|BANK_S5|Y_S5) para Cuenta de capital por cobrar/ }).count());
  const dis = await planAndConfirm(page, 'Pedir el plan de desembolso', 'Confirmar desembolso', '/disbursements', { doubleClick: true });
  observed.set('disburse', { status: dis.reply.status(), consentPreChecked: dis.preChecked, confirmDisabledBeforeConsent: dis.disabledBefore, posts: sent.filter(s => s.path.endsWith('/disbursements')).length });
  // Wrong password: A32 rejects, no accrual command reaches the server.
  await page.getByLabel('Reconocer hasta').fill(today);
  const pvA = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/loan-operation-previews')); await page.getByRole('button', { name: 'Pedir el plan de devengo', exact: true }).click(); await pvA;
  const planA = page.getByRole('region', { name: 'Plan del servidor' }); await planA.getByRole('checkbox').check(); await planA.getByLabel('Contraseña actual').fill('contraseña equivocada sintetica 0000');
  const a32 = page.waitForResponse(r => r.url().endsWith('/auth/reauthenticate')); await planA.getByRole('button', { name: 'Confirmar devengo', exact: true }).click(); const wrong = await a32;
  observed.set('wrong password', { a32: wrong.status(), accrualPosts: sent.filter(s => s.path.endsWith('/accruals')).length });
  await planA.getByLabel('Contraseña actual').fill(PASSWORD);
  const accCmd = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/accruals') && r.request().method() === 'POST');
  await planA.getByRole('button', { name: 'Confirmar devengo', exact: true }).click(); expect((await accCmd).status()).toBe(201);
  await expect(page.getByText('El servidor confirmó el comando. Esto no habilita un préstamo real.')).toBeVisible();
  const accOracle = book.accrue(loanId, today, today);
  // Partial receipt 1.000.000 REGULAR: interest of every due row first, then due principal by age.
  await page.getByRole('button', { name: 'Elegir BANK_S5 para Cuenta que recibe el cobro', exact: true }).click(); await expect(page.getByText('La cuenta de cobro tiene versión para el plan.')).toBeVisible();
  await page.getByLabel('Importe recibido').fill('1.000.000'); await page.getByLabel('Importe para el préstamo 1').fill('1.000.000'); await page.getByLabel('Referencia del cobro').fill('REC-UI-S5-1');
  const rec = await planAndConfirm(page, 'Pedir el plan de cobro', 'Confirmar cobro', '/receipts');
  const recOracle = book.collect('RECEIPT', 'B', oracleMod.c('1000000.00'), [{ loan: loanId, amount: oracleMod.c('1000000.00'), mode: 'REGULAR' }], today, { account: 'CASH', excess: 'REJECT' });
  const serverApps = rec.preview.data.plan.allocations.map(a => `${a.installmentNumber}:${a.component}:${a.amount}`), oracleApps = recOracle.applications.map(a => `${a.k}:${a.component}:${oracleMod.m(a.amount)}`);
  observed.set('receipt allocations', { server: serverApps, oracle: oracleApps, equal: JSON.stringify(serverApps) === JSON.stringify(oracleApps) });
  expect(serverApps).toEqual(oracleApps);
  // Own DB cross-check: ledger balances of the five accounts == own oracle; one OPERATION journal per money event.
  const db = await ownDb(async dbx => { const totals = new Map<string, bigint>(); const toC = (v: unknown) => { const t = String(v), [w = '0', f = ''] = t.replace('-', '').split('.'); const n = BigInt(w) * 100n + BigInt((f + '00').slice(0, 2)); return t.startsWith('-') ? -n : n; };
    for (const j of await dbx.collection('financial_journals').find({}).toArray()) for (const l of j['lines'] as { accountId: string; debit: unknown; credit: unknown }[]) totals.set(l.accountId, (totals.get(l.accountId) ?? 0n) + toC(l.debit) - toC(l.credit));
    return { BANK: totals.get(ids['BANK_S5']!) ?? 0n, P: totals.get(ids['P_S5']!) ?? 0n, I: totals.get(ids['I_S5']!) ?? 0n, Y: totals.get(ids['Y_S5']!) ?? 0n, C: totals.get(ids['C_S5']!) ?? 0n, events: await dbx.collection('loan_events').countDocuments({}), opJournals: await dbx.collection('financial_journals').countDocuments({ 'source.type': 'LOAN_OPERATION' }) }; });
  const expected = { BANK: book.balances.get('CASH')!, P: book.balances.get('PRINCIPAL')!, I: book.balances.get('INTEREST_RECEIVABLE') ?? 0n, Y: book.balances.get('INTEREST_INCOME') ?? 0n, C: book.balances.get('BORROWER_CREDIT') ?? 0n };
  const fmt = (o2: Record<string, bigint>) => Object.fromEntries(Object.entries(o2).map(([k, v]) => [k, oracleMod.m(v)]));
  observed.set('own DB vs oracle', { db: fmt({ BANK: db.BANK, P: db.P, I: db.I, Y: db.Y, C: db.C }), oracle: fmt(expected), events: db.events, operationJournals: db.opJournals, accrualPostings: accOracle.postings.length });
  for (const k of ['BANK', 'P', 'I', 'Y', 'C'] as const) expect(oracleMod.m(db[k]), k).toBe(oracleMod.m(expected[k]));
  // Detail shows server figures (from the oracle) with Spanish labels.
  const detail = page.getByRole('region', { name: 'Detalle de la posición' });
  await expect(detail.getByText(`Capital pendiente ${new Intl.NumberFormat('es-CO').format(Number(oracleMod.m(book.balances.get('PRINCIPAL')!)))} COP`)).toBeVisible();
  // Layout, keyboard, CSS zoom, storage, URL.
  await page.keyboard.press('Control+Home'); await page.keyboard.press('Tab');
  const widths: Record<string, boolean> = {};
  for (const width of [360, 390, 768, 1024, 1440]) { await page.setViewportSize({ width, height: 900 }); widths[String(width)] = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1); }
  await page.evaluate(() => { document.body.style.zoom = '2'; }); widths['css zoom 200%'] = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1); await page.evaluate(() => { document.body.style.zoom = ''; });
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.screenshot({ path: await path('../../../../../Construccion/Sprints/S05/Evidencias/S05-P05-v2-VISUAL.png'), fullPage: true });
  const uuidMain = await page.evaluate(() => [...document.querySelectorAll('main *')].filter(e => e.children.length === 0 && !e.closest('details') && /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(e.textContent ?? '')).map(e => (e.className || e.tagName) + ': ' + (e.textContent ?? '').replace(/[0-9a-f-]{36}/gi, '<uuid>').slice(0, 90)));
  observed.set('a11y/layout', { overflow: widths, storage: await page.evaluate(() => localStorage.length + sessionStorage.length), tokenInUrl: /token|code=/.test(page.url()), uuidOutsideDetails: uuidMain });
  evidence('P05-S5-UI', { observed: Object.fromEntries(observed) });
  expect(sent.filter(s => s.path.endsWith('/disbursements')).length).toBe(1);
  expect(Object.entries(widths).filter(([k]) => !k.startsWith('css')).every(([, v]) => v === false)).toBe(true);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});
