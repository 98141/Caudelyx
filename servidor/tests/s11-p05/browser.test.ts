/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection -- Own group folder, own S11-P05 evidence paths and server-derived UUID filenames validated by regex. */
// S11-P05 (Claude): own browser journey (Playwright bundled Chromium 1228; the author used the Chrome channel) against the candidate
// UI source served by Vite with the reviewer group's TLS, API = real HTTPS app of the same group. Own scenario: formula file
// rejected -> cell-level errors -> correction -> TOTP confirm -> CASH report -> CSV/XLSX/PDF downloads checked against an own
// raw-ledger oracle. UI is not economic proof; accessibility is spot-checked only (keyboard focus, 390 px layout).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {spawn, execFileSync, type ChildProcess} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {readFile, writeFile} from 'node:fs/promises';
import {createServer as probe} from 'node:net';
import {request as httpsRequest} from 'node:https';
import {once} from 'node:events';
import {join, resolve} from 'node:path';
import {generate} from 'otplib';
import {chromium, type Browser, type Page} from '@playwright/test';
import {s11Profile, world} from './profile.js';
import {workbook, parts, zip, cents, money} from './book.js';
import {today} from '../../src/modules/obligations/calendar.js';
import type {Data} from '../../src/modules/exchange/models.js';

const EV = resolve('../../Construccion/Sprints/S11/Evidencias'), OUT = join(EV, 'S11-P05-DOWNLOADS'), CAP = join(EV, 'S11-P05-CAPTURES'), client = resolve('../cliente');
const blocked = new Set([27017, 27181, 3001, 3002, 4001]);
const reserve = async () => { const s = probe().listen(0, '127.0.0.1'); await once(s, 'listening'); const a = s.address(), port = a && typeof a !== 'string' ? a.port : 0; await new Promise<void>(r => s.close(() => r())); if (!port || blocked.has(port)) throw Error('Protected port'); return port; };
const waitUp = (port: number, ca: Buffer) => new Promise<void>((ok, ko) => { const end = Date.now() + 45000; const ping = () => { const q = httpsRequest({hostname: 'localhost', port, path: '/', ca, servername: 'localhost'}, r => { r.resume(); ok(); }); q.on('error', () => Date.now() > end ? ko(Error('vite not up')) : setTimeout(ping, 400)); q.end(); }; ping(); });
const CHECKS: Record<string, unknown> = {};

test('S11-P05 browser: error -> correction -> confirm -> CASH -> three downloads = raw ledger oracle; collaborator, 390 px, keyboard', {timeout: 600000}, async () => {
  const group = await s11Profile(); let browser: Browser | undefined, vite: ChildProcess | undefined, viteLog = '';
  mkdirSync(OUT, {recursive: true}); mkdirSync(CAP, {recursive: true});
  try {
    const f = await world(group, Date.parse('2026-10-31T12:00:00-05:00')), ui = await reserve(), api = await f.https(f.identity, 'https://localhost:' + ui);
    vite = spawn(process.execPath, [join(client, 'node_modules/vite/bin/vite.js'), '--host', 'localhost', '--strictPort'], {cwd: client, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, CAUDELYX_DEV_UI_PORT: String(ui), CAUDELYX_DEV_API_PORT: String(api.port), CAUDELYX_DEV_TLS_DIRECTORY: group.folder}});
    vite.stdout?.on('data', c => { viteLog = (viteLog + String(c)).slice(-1500); }); vite.stderr?.on('data', c => { viteLog = (viteLog + String(c)).slice(-1500); });
    await waitUp(ui, api.cert);
    const formula = join(group.folder, 'p05-formula.xlsx'), wrong = join(group.folder, 'p05-errores.xlsx'), good = join(group.folder, 'p05-correcto.xlsx');
    const fp = parts('OPERATIVE', 'p05ui', {Cuentas: [{externalKey: 'UI1', action: 'CREATE', code: 'P05_UI', name: 'Cuenta UI P05', accountClass: 'ASSET', kind: 'BANK', currency: 'COP'}]});
    const sheetName = [...fp.keys()].find(k => fp.get(k)!.toString().includes('P05_UI'))!; fp.set(sheetName, Buffer.from(fp.get(sheetName)!.toString().replace(/<c r="F2" t="inlineStr">[\s\S]*?<\/c>/, '<c r="F2"><f>1+1</f><v>2</v></c>')));
    await writeFile(formula, zip(fp));
    await writeFile(wrong, workbook('OPERATIVE', 'p05ui', {Cuentas: [{externalKey: 'UI1', action: 'CREATE', code: 'P05_UI', name: 'Cuenta UI P05', accountClass: 'XYZ', kind: 'BANK', currency: 'USD'}]}));
    await writeFile(good, workbook('OPERATIVE', 'p05ui', {Cuentas: [{externalKey: 'UI1', action: 'CREATE', code: 'P05_UI', name: 'Cuenta UI P05', accountClass: 'ASSET', kind: 'BANK', currency: 'COP'}]}));
    // No install: the bundled build expected by Playwright 1.64.1 (1248) is absent; use the already present Chromium 1228.
    browser = await chromium.launch({headless: true, executablePath: resolve(process.env['LOCALAPPDATA'] ?? '', 'ms-playwright/chromium-1228/chrome-win64/chrome.exe')});
    CHECKS['browser'] = 'chromium ' + browser.version();
    const ctx = await browser.newContext({ignoreHTTPSErrors: true, viewport: {width: 1280, height: 900}, acceptDownloads: true});
    await ctx.addCookies([{name: '__Host-caudelyx-session', value: f.a.issued.token, url: 'https://localhost:' + ui + '/', httpOnly: true, secure: true, sameSite: 'Lax'}]);
    const page: Page = await ctx.newPage(); const errors: string[] = []; page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
    await page.goto('https://localhost:' + ui + '/#/intercambio', {waitUntil: 'domcontentloaded'});
    await page.getByRole('heading', {name: 'Importar y exportar'}).waitFor({timeout: 30000});
    await page.getByLabel('Modo').selectOption({label: 'Operación'}); await page.getByLabel('Espacio de nombres').fill('p05ui');
    await page.getByRole('button', {name: 'Crear lote'}).click(); await page.getByText(/Lote Creado/).waitFor({timeout: 20000});
    // 1. Formula file: server rejects the upload; the UI shows a Spanish error and no preview/confirm.
    await page.getByLabel(/Archivo .xlsx/).setInputFiles(formula);
    const up1 = page.waitForResponse(r => r.url().includes('/content') && r.request().method() === 'POST', {timeout: 30000});
    await page.getByRole('button', {name: 'Cargar archivo'}).click(); const r1 = await up1;
    await page.waitForTimeout(800);
    const body = await page.locator('main').innerText();
    CHECKS['formula'] = {status: r1.status(), code: ((await r1.json().catch(() => ({}))) as {error?: {code?: string}}).error?.code, visibleError: /contenido activo|No se ejecutó|no se cargó|rechaz/i.test(body), confirmEnabled: await page.getByRole('button', {name: 'Confirmar lote'}).isEnabled().catch(() => false)};
    await page.screenshot({path: join(CAP, '01-formula-rechazada.png'), fullPage: true});
    assert.equal(r1.status(), 422); assert.equal(CHECKS['formula'] && (CHECKS['formula'] as Data)['confirmEnabled'], false);
    // 2. Cell errors are listed per sheet/row/cell; confirm stays disabled.
    await page.getByRole('button', {name: 'Consultar estado'}).click().catch(() => undefined);
    await page.getByLabel(/Archivo .xlsx/).setInputFiles(wrong);
    const up2 = page.waitForResponse(r => r.url().includes('/content') && r.request().method() === 'POST', {timeout: 30000});
    await page.getByRole('button', {name: 'Cargar archivo'}).click(); const r2 = await up2;
    if (!r2.ok()) { await page.getByRole('button', {name: 'Consultar estado'}).click(); }
    CHECKS['wrongUpload'] = r2.status();
    const pv2 = page.waitForResponse(r => r.url().includes('/previews') && r.request().method() === 'POST', {timeout: 30000});
    await page.getByRole('button', {name: 'Generar vista previa'}).click(); await pv2;
    await page.getByRole('heading', {name: 'Vista previa, no es una operación realizada'}).waitFor({timeout: 20000});
    const table = page.getByRole('table', {name: 'Observaciones por hoja, fila y celda'}), tableText = await table.innerText();
    CHECKS['cellErrors'] = {rows: await table.getByRole('row').count(), mentionsCuentas: tableText.includes('Cuentas'), mentionsCell: /G2|I2/.test(tableText), confirmDisabled: await page.getByRole('button', {name: 'Confirmar lote'}).isDisabled()};
    await page.screenshot({path: join(CAP, '02-errores-por-celda.png'), fullPage: true});
    assert.equal((CHECKS['cellErrors'] as Data)['confirmDisabled'], true); assert.ok(Number((CHECKS['cellErrors'] as Data)['rows']) > 1);
    // 3. Correction, preview, TOTP-protected confirmation.
    await page.getByRole('button', {name: 'Consultar estado'}).click(); await page.getByText(/Estado consultado/).waitFor({timeout: 20000});
    await page.getByLabel(/Archivo .xlsx/).setInputFiles(good);
    const up3 = page.waitForResponse(r => r.url().includes('/content') && r.request().method() === 'POST', {timeout: 30000});
    await page.getByRole('button', {name: 'Cargar archivo'}).click(); assert.equal((await up3).ok(), true);
    const pv3 = page.waitForResponse(r => r.url().includes('/previews') && r.request().method() === 'POST', {timeout: 30000});
    await page.getByRole('button', {name: 'Generar vista previa'}).click(); assert.equal((await pv3).ok(), true);
    const before = await f.database.db.collection('financial_accounts').countDocuments({organizationId: f.org});
    await page.getByRole('button', {name: 'Confirmar lote'}).click({timeout: 30000});
    const totp = page.getByLabel('Código de 6 dígitos');
    if (await totp.waitFor({timeout: 8000}).then(() => true, () => false)) { f.clock.value += 30000; await totp.fill(await generate({secret: f.a.secret, epoch: Math.floor(f.now() / 1000)})); await page.getByRole('button', {name: /^Confirmar( y continuar)?$/}).click(); }
    await page.getByText(/Lote Confirmado|Recibo/).first().waitFor({timeout: 30000});
    const after = await f.database.db.collection('financial_accounts').countDocuments({organizationId: f.org});
    CHECKS['confirm'] = {accountsDelta: after - before}; assert.equal(after - before, 1);
    await page.screenshot({path: join(CAP, '03-confirmado.png'), fullPage: true});
    // 4. CASH report + three downloads.
    f.clock.value += 61000;
    await page.getByLabel('Reporte', {exact: true}).selectOption({label: 'Caja'}); await page.getByRole('button', {name: 'Consultar corte'}).click();
    await page.getByText(/Filas del conjunto:/).waitFor({timeout: 30000});
    const uiRows = Number(/Filas del conjunto:\s*(\d+)/.exec(await page.getByText(/Filas del conjunto:/).innerText())?.[1]);
    await page.screenshot({path: join(CAP, '04-caja.png'), fullPage: true});
    const files: Record<string, string> = {};
    for (const format of ['CSV', 'XLSX', 'PDF'] as const) {
      f.clock.value += 61000; // product rate window (10 ops/60 s) on the synthetic clock; snapshot token (300 s) still valid
      const previous = await page.getByText(/^Trabajo /).textContent().catch(() => '');
      await page.getByLabel('Formato').selectOption(format); await page.getByRole('button', {name: 'Preparar archivo'}).click();
      await page.waitForFunction(seen => { const line = [...document.querySelectorAll('p')].map(n => n.textContent ?? '').find(t => t.startsWith('Trabajo ') && t.includes('Listo')); return Boolean(line) && line !== seen; }, previous, {timeout: 60000});
      const [d] = await Promise.all([page.waitForEvent('download', {timeout: 20000}), page.getByRole('button', {name: 'Descargar', exact: true}).click()]);
      assert.match(d.suggestedFilename(), /^caudelyx-export-[0-9a-f-]{36}\.(csv|xlsx|pdf)$/);
      const path = join(OUT, 'ui-' + d.suggestedFilename()); await d.saveAs(path); files[format] = path;
      CHECKS['download-' + format] = {file: 'S11-P05-DOWNLOADS/ui-' + d.suggestedFilename(), sha256: createHash('sha256').update(await readFile(path)).digest('hex')};
    }
    // Own oracle: each bank-like account "book" balance = sum(debit - credit) of its raw journal lines.
    const lines = (await f.database.db.collection('financial_journals').find({organizationId: f.org}).toArray()).flatMap(j => j['lines'] as Data[]);
    const balance = (id: string) => money(lines.filter(l => l['accountId'] === id).reduce((n, l) => n + cents(String(l['debit'])) - cents(String(l['credit'])), 0n));
    const read = JSON.parse(execFileSync('python', ['-I', 'tests/s11-p05/readers.py', files['CSV']!, files['XLSX']!, files['PDF']!], {encoding: 'utf8', maxBuffer: 64 << 20})) as {csv: {rows: string[][]; unprotectedDangerous: string[]}; xlsx: {sheets: Record<string, (string | number | null)[][]>; formulaParts: string[]}; pdf: {pages: number; activeTokens: string[]; text: string[]}};
    const head = read.csv.rows[0]!, rows = read.csv.rows.filter(r => r[0] === 'ROW'), xhead = read.xlsx.sheets['Datos']![0] as string[], xrows = read.xlsx.sheets['Datos']!.filter(r => r[0] === 'ROW');
    const decode = (v: unknown) => typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v;
    const csvBook = rows.map(r => ({account: decode(r[head.indexOf('accountId')]), book: r[head.indexOf('book')]})), xBook = xrows.map(r => ({account: decode(r[xhead.indexOf('accountId')]), book: r[xhead.indexOf('book')]}));
    const oracle = csvBook.map(r => ({account: r.account, oracle: balance(String(r.account))})), pdfText = read.pdf.text.join('\n');
    CHECKS['report'] = {uiRows, csvRows: rows.length, xlsxRows: xrows.length, csvBook, xBook, oracle, pdfPages: read.pdf.pages, pdfActive: read.pdf.activeTokens, xlsxFormulas: read.xlsx.formulaParts, pdfHasAllBooks: csvBook.every(r => pdfText.includes(String(r.book)))};
    assert.equal(rows.length, uiRows); assert.equal(xrows.length, uiRows); assert.ok(uiRows >= 1);
    for (const [i, r] of csvBook.entries()) { assert.equal(r.book, oracle[i]!.oracle, 'CSV book = raw ledger'); assert.equal(String(xBook[i]!.book), r.book, 'XLSX = CSV'); }
    assert.deepEqual(read.pdf.activeTokens, []); assert.deepEqual(read.xlsx.formulaParts, []); assert.equal((CHECKS['report'] as Data)['pdfHasAllBooks'], true);
    // 5. 390 px layout and keyboard focus (spot check, not certification).
    await page.setViewportSize({width: 390, height: 844}); await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => ({doc: document.documentElement.scrollWidth, view: document.documentElement.clientWidth}));
    await page.screenshot({path: join(CAP, '05-movil-390.png'), fullPage: true});
    await page.setViewportSize({width: 1280, height: 900}); await page.locator('body').click({position: {x: 2, y: 2}});
    const focus: string[] = []; for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); focus.push(await page.evaluate(() => { const n = document.activeElement; return n ? n.tagName + ':' + (n.getAttribute('aria-label') ?? n.textContent ?? '').trim().slice(0, 30) : 'none'; })); }
    CHECKS['layout'] = {overflow, focus, pageErrors: errors};
    assert.ok(overflow.doc <= overflow.view + 1, 'no document-level horizontal scroll at 390 px'); assert.ok(focus.some(x => /^(BUTTON|A|INPUT|SELECT)/.test(x)));
    // 6. Collaborator C: no import controls and no template downloads.
    const c = await f.actor(), invite = {email: c.email, roleIds: ['C']}; await f.proof(f.a, 'MEMBER_INVITE', invite, f.org); await f.runtime.organizations.invite(f.a.issued.context, invite); await f.identity.dispatchMail();
    const mail = [...f.messages.notificationInbox.values()].find(m => m.kind === 'INVITATION' && m.payload['email'] === c.email)!; await f.runtime.organizations.accept(c.issued.context, {mode: 'CONFIRM', token: mail.payload['token']}, randomUUID());
    const cctx = await browser.newContext({ignoreHTTPSErrors: true}); await cctx.addCookies([{name: '__Host-caudelyx-session', value: c.issued.token, url: 'https://localhost:' + ui + '/', httpOnly: true, secure: true, sameSite: 'Lax'}]);
    const cp = await cctx.newPage(); await cp.goto('https://localhost:' + ui + '/#/intercambio', {waitUntil: 'domcontentloaded'}); await cp.getByRole('heading', {name: 'Importar y exportar'}).waitFor({timeout: 30000}); await cp.waitForTimeout(1500);
    const createEnabled = await cp.getByRole('button', {name: 'Crear lote'}).isEnabled().catch(() => false), templates = await cp.getByRole('button', {name: /Descargar caudelyx-import/}).count(), ctext = await cp.locator('main').innerText();
    CHECKS['collaborator'] = {createEnabled, templates, leaksAccountName: ctext.includes('Cuenta UI P05')};
    await cp.screenshot({path: join(CAP, '06-colaborador.png'), fullPage: true}); await cctx.close();
    assert.equal(createEnabled, false); assert.equal(templates, 0); assert.equal(ctext.includes('Cuenta UI P05'), false);
    CHECKS['today'] = today(f.now());
  } finally {
    await browser?.close().catch(() => undefined);
    if (vite && vite.exitCode === null) { vite.kill(); await once(vite, 'exit').catch(() => undefined); }
    await group.dispose();
    writeFileSync(join(EV, 'S11-P05-CHECKS-BROWSER.json'), JSON.stringify({task: 'S11-P05', suite: 'browser', runId: group.runId, viteTail: viteLog.slice(-600), at: new Date().toISOString(), checks: CHECKS}, null, 1) + '\n');
  }
});
