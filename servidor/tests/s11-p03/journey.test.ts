import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as probe } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { generate } from 'otplib';
import { chromium, type Browser, type Page } from '@playwright/test';
import { AppError } from '../../src/shared/errors.js';
import { today } from '../../src/modules/obligations/calendar.js';
import { s11Profile, world } from './fixture.js';
import { workbook } from '../s11-p02/oracle.js';

const repoRoot = resolve(process.cwd(), '../..');
const captureDir = join(repoRoot, 'Construccion/Sprints/S11/Evidencias/S11-P03-CAPTURES');
const receiptPath = join(repoRoot, 'Construccion/Sprints/S11/Evidencias/S11-P03-JOURNEY.json');
const negativeBook = join(repoRoot, 'Construccion/Sprints/S11/Plantillas/v1.0.0/negative-cases.xlsx');
const clientRoot = resolve(process.cwd(), '../cliente');
const blocked = new Set([27017, 27181, 3001, 3002, 4001]);

async function reservePort(): Promise<number> {
  const server = probe().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = address && typeof address !== 'string' ? address.port : 0;
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (!port || blocked.has(port)) throw Error('Protected test port');
  return port;
}

function waitForVite(port: number, cert: Buffer): Promise<void> {
  const deadline = Date.now() + 40000;
  return new Promise((resolve, reject) => {
    const ping = () => {
      const req = httpsRequest({ hostname: 'localhost', port, path: '/', method: 'GET', ca: cert, servername: 'localhost' }, res => { res.resume(); resolve(); });
      req.on('error', () => { if (Date.now() > deadline) reject(Error('Vite did not listen')); else setTimeout(ping, 400); });
      req.end();
    };
    ping();
  });
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(captureDir, name), fullPage: true });
  return name;
}

test('S11-P03 walks the local exchange screen against its own API group', { timeout: 480000 }, async () => {
  const totalStarted = performance.now();
  const receipt: Record<string, unknown> = { task: 'S11-P03', startedAt: new Date().toISOString(), captures: [], downloads: [], negatives: {}, limits: [] };
  const group = await s11Profile();
  let browser: Browser | undefined;
  let vite: ChildProcess | undefined;
  let page: Page | undefined;
  let viteLog = '';
  try {
    const f = await world(group);
    const uiPort = await reservePort();
    const api = await f.https('https://localhost:' + uiPort);
    if (api.port === uiPort || blocked.has(api.port)) throw Error('Protected API port');
    vite = spawn('node', [join(clientRoot, 'node_modules/vite/bin/vite.js'), '--host', 'localhost', '--strictPort'], {
      cwd: clientRoot,
      env: { ...process.env, CAUDELYX_DEV_UI_PORT: String(uiPort), CAUDELYX_DEV_API_PORT: String(api.port), CAUDELYX_DEV_TLS_DIRECTORY: f.folder },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    vite.stdout?.on('data', chunk => { viteLog = (viteLog + String(chunk)).slice(-2000); });
    vite.stderr?.on('data', chunk => { viteLog = (viteLog + String(chunk)).slice(-2000); });
    const viteStarted = performance.now();
    await waitForVite(uiPort, api.cert);
    receipt['viteMs'] = Math.round(performance.now() - viteStarted);
    receipt['ports'] = { ui: uiPort, api: api.port };
    await mkdir(captureDir, { recursive: true });
    const corrected = join(f.folder, 'corrected.xlsx');
    await writeFile(corrected, workbook('OPERATIVE', 'sintetico', { Cuentas: [{ externalKey: 'BANK_S11_UI', action: 'CREATE', code: 'S11_UI_BANK', name: 'Cuenta sintética UI', accountClass: 'ASSET', kind: 'BANK', currency: 'COP' }] }));
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    await context.addCookies([{ name: '__Host-caudelyx-session', value: f.a.issued.token, url: 'https://localhost:' + uiPort + '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
    page = await context.newPage();
    page.on('pageerror', error => { receipt['pageError'] = String(error).slice(0, 300); });
    await page.goto('https://localhost:' + uiPort + '/#/intercambio', { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Importar y exportar' }).waitFor({ timeout: 20000 });
    await page.getByText(/5242880 bytes/).waitFor();
    await page.getByText(/no otorga roles/i).waitFor();
    await page.setViewportSize({ width: 360, height: 800 });
    receipt['captures'] = [await shot(page, '01-ambito-360.png')];
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.keyboard.press('Tab');
    receipt['keyboardFocus'] = await page.evaluate(() => { const node = document.activeElement; return node ? node.tagName + (node.getAttribute('aria-label') ?? '') : 'none'; });
    const stranger = await browser.newContext({ ignoreHTTPSErrors: true });
    const otherPage = await stranger.newPage();
    await otherPage.goto('https://localhost:' + uiPort + '/#/intercambio', { waitUntil: 'domcontentloaded' });
    await otherPage.getByRole('button', { name: 'Iniciar sesión' }).waitFor({ timeout: 15000 });
    assert.equal(await otherPage.getByRole('button', { name: 'Descargar caudelyx-import-template.xlsx' }).count(), 0);
    await stranger.close();
    receipt['secondContext'] = 'login-without-cookie';
    const [template] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Descargar caudelyx-import-template.xlsx' }).click(),
    ]);
    const templatePath = join(captureDir, 'template.xlsx');
    await template.saveAs(templatePath);
    const templateBytes = await readFile(templatePath);
    assert.equal(template.suggestedFilename(), 'caudelyx-import-template.xlsx');
    assert.equal(templateBytes.subarray(0, 2).toString('utf8'), 'PK');
    await page.getByLabel('Modo').selectOption({ label: 'Operación' });
    await page.getByRole('button', { name: 'Crear lote' }).click();
    await page.getByText(/Lote Creado/).waitFor({ timeout: 20000 });
    await page.getByLabel(/Archivo .xlsx/).setInputFiles(negativeBook);
    await page.getByText('Seleccionado: negative-cases.xlsx').waitFor();
    const negativeUpload = page.waitForResponse(res => res.url().includes('/content') && res.request().method() === 'POST', { timeout: 30000 });
    await page.getByRole('button', { name: 'Cargar archivo' }).click();
    const negativeResult = await negativeUpload;
    receipt['negativeUploadStatus'] = negativeResult.status();
    if (negativeResult.ok()) {
      const negativePreview = page.waitForResponse(res => res.url().includes('/previews') && res.request().method() === 'POST', { timeout: 30000 });
      await page.getByRole('button', { name: 'Generar vista previa' }).click();
      await negativePreview;
      const previewHeading = page.getByRole('heading', { name: 'Vista previa, no es una operación realizada' });
      const previewAlert = page.getByRole('alert');
      const negativeShown = await Promise.race([
        previewHeading.waitFor({ timeout: 15000 }).then(() => 'preview' as const),
        previewAlert.waitFor({ timeout: 15000 }).then(() => 'alert' as const),
      ]);
      if (negativeShown === 'preview') assert.equal(await page.getByRole('button', { name: 'Confirmar lote' }).isDisabled(), true);
      else receipt['negativePreview'] = await previewAlert.allInnerTexts();
    } else receipt['negativeUploadBody'] = (await negativeResult.text()).slice(0, 300);
    (receipt['captures'] as string[]).push(await shot(page, '02-archivo-con-error.png'));
    await page.getByRole('button', { name: 'Consultar estado' }).click();
    await page.getByText(/Estado consultado/).waitFor({ timeout: 20000 });
    await page.getByLabel(/Archivo .xlsx/).setInputFiles(corrected);
    await page.getByText('Seleccionado: corrected.xlsx').waitFor();
    const goodUpload = page.waitForResponse(res => res.url().includes('/content') && res.request().method() === 'POST', { timeout: 30000 });
    await page.getByRole('button', { name: 'Cargar archivo' }).click();
    assert.equal((await goodUpload).ok(), true);
    const goodPreview = page.waitForResponse(res => res.url().includes('/previews') && res.request().method() === 'POST', { timeout: 30000 });
    await page.getByRole('button', { name: 'Generar vista previa' }).click();
    assert.equal((await goodPreview).ok(), true);
    await page.getByRole('button', { name: 'Confirmar lote' }).click({ timeout: 30000 });
    const codeField = page.getByLabel('Código de 6 dígitos');
    if (await codeField.isVisible().catch(() => false) || await codeField.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
      f.clock.value += 30000;
      await codeField.fill(await generate({ secret: f.a.secret, epoch: Math.floor(f.now() / 1000) }));
      await page.getByRole('button', { name: /^Confirmar( y continuar)?$/ }).click();
    }
    await page.getByText(/Lote Confirmado|Recibo/).first().waitFor({ timeout: 30000 });
    (receipt['captures'] as string[]).push(await shot(page, '03-confirmado.png'));
    await page.getByLabel('Reporte', { exact: true }).selectOption({ label: 'Caja' });
    await page.getByRole('button', { name: 'Consultar corte' }).click();
    await page.getByText(/Filas del conjunto:/).waitFor({ timeout: 30000 });
    const summary = await page.getByText(/Filas del conjunto:/).innerText();
    const totalRows = Number(/Filas del conjunto:\s*(\d+)/.exec(summary)?.[1]);
    assert.equal(Number.isInteger(totalRows), true);
    (receipt['captures'] as string[]).push(await shot(page, '04-reporte-caja.png'));
    receipt['reportRows'] = totalRows;
    for (const format of ['CSV', 'XLSX', 'PDF'] as const) {
      if (format === 'PDF') f.clock.value += 61000;
      const previous = await page.getByText(/^Trabajo /).textContent().catch(() => '');
      await page.getByLabel('Formato').selectOption(format);
      await page.getByRole('button', { name: 'Preparar archivo' }).click();
      await page.waitForFunction(seen => {
        const line = [...document.querySelectorAll('p')].map(node => node.textContent ?? '').find(text => text.startsWith('Trabajo ') && text.includes('Listo'));
        return Boolean(line) && line !== seen;
      }, previous, { timeout: 60000 });
      const download = await Promise.all([
        page.waitForEvent('download', { timeout: 20000 }),
        page.getByRole('button', { name: 'Descargar', exact: true }).click(),
      ]).then(result => result[0]);
      const saved = join(captureDir, download.suggestedFilename());
      await download.saveAs(saved);
      const bytes = await readFile(saved);
      const nameOk = /^caudelyx-export-[0-9a-f-]{36}\.(csv|xlsx|pdf)$/.test(download.suggestedFilename());
      assert.equal(nameOk, true, download.suggestedFilename());
      if (format === 'CSV') {
        const lines = bytes.toString('utf8').split(/\r\n/).filter(line => line.length > 0);
        const dataRows = lines.filter(line => line.startsWith('"ROW"'));
        assert.equal(dataRows.length, totalRows, 'CSV data rows match the set total');
        assert.equal(lines.some(line => line.startsWith('"META"')), true);
        assert.equal(lines.some(line => line.startsWith('"TOTAL"')), true);
      } else if (format === 'XLSX') assert.equal(bytes.subarray(0, 2).toString('utf8'), 'PK');
      else assert.equal(bytes.subarray(0, 5).toString('utf8'), '%PDF-');
      (receipt['downloads'] as unknown[]).push({ format, filename: download.suggestedFilename(), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    receipt['downloadNote'] = 'Byte checks do not prove that a PDF renders or that the workbook totals are correct.';
    const service = f.identity.exchange!;
    const committed = await f.database.db.collection('s11_imports').findOne({ namespace: 'sintetico', state: 'COMMITTED' });
    assert.ok(committed);
    const collaborator = await f.actor();
    const invite = { email: collaborator.email, roleIds: ['C'] };
    await f.proof(f.a, 'MEMBER_INVITE', invite, f.org);
    await f.runtime.organizations.invite(f.a.issued.context, invite);
    await f.identity.dispatchMail();
    const mail = [...f.messages.notificationInbox.values()].find(item => item.kind === 'INVITATION' && item.payload['email'] === collaborator.email);
    assert.ok(mail);
    await f.runtime.organizations.accept(collaborator.issued.context, { mode: 'CONFIRM', token: String(mail.payload['token']) }, randomUUID());
    const collaboratorPolicy = await service.policy(collaborator.issued.context, { organizationId: f.org });
    assert.deepEqual(collaboratorPolicy.data['templates'], []);
    assert.deepEqual(collaboratorPolicy.data['importModes'], []);
    await assert.rejects(() => service.readImport(collaborator.issued.context, { organizationId: f.org, importId: String(committed['_id']) }, 'getBusinessImport'), (error: unknown) => error instanceof AppError && (error.status === 403 || error.status === 404));
    receipt['negatives'] = { ...(receipt['negatives'] as object), collaborator: 'empty-templates-and-denied' };
    const foreign = await f.actor();
    const otherOrg = (await f.runtime.organizations.create(foreign.issued.context, { name: 'Otro titular sintético', currency: 'COP', timezone: 'America/Bogota' }, randomUUID())).data.organization.id;
    await assert.rejects(() => service.readImport(foreign.issued.context, { organizationId: otherOrg, importId: String(committed['_id']) }, 'getBusinessImport'), (error: unknown) => error instanceof AppError && error.code === 'RESOURCE_NOT_FOUND');
    (receipt['negatives'] as Record<string, string>)['otherOwner'] = 'RESOURCE_NOT_FOUND';
    const params = { organizationId: f.org };
    const created = await service.createImport(f.a.issued.context, 'createBusinessImport', { label: 'Lote que vence', namespace: 'vence', mode: 'OPERATIVE', templateVersion: '1.0.0', mappingVersion: 'S11-MAP-1' }, params, randomUUID());
    const path = { ...params, importId: String(created.data['id']) };
    const uploaded = await service.upload(f.a.issued.context, path, randomUUID(), created.etag, workbook('OPERATIVE', 'vence', { Cuentas: [{ externalKey: 'BANK_VENCE', action: 'CREATE', code: 'S11_VENCE', name: 'Cuenta que no se confirma', accountClass: 'ASSET', kind: 'BANK', currency: 'COP' }] }));
    await service.preparePreview(f.a.issued.context, path, randomUUID(), uploaded.etag);
    const preview = await service.readImport(f.a.issued.context, path, 'getBusinessImportPreview');
    const current = await service.readImport(f.a.issued.context, path, 'getBusinessImport');
    const payload = { previewId: preview.data['id'], semanticHash: preview.data['semanticHash'], bookETag: await f.database.client.withSession(session => f.runtime.wealth.bookTag({ kind: 'BUSINESS', bookId: f.org, ownerId: f.org, organizationId: f.org }, session)) };
    const confirmKey = randomUUID();
    await f.proof(f.a, 'IMPORT_CONFIRM', { operationId: 'confirmBusinessImport', organizationId: f.org, pathParameters: path, payload, idempotencyKey: confirmKey, expectedETag: current.etag }, path.importId);
    f.clock.value += 301000;
    await assert.rejects(() => service.confirm(f.a.issued.context, path, payload, confirmKey, current.etag), (error: unknown) => error instanceof AppError && error.code === 'IMPORT_PREVIEW_EXPIRED');
    (receipt['negatives'] as Record<string, string>)['expiredPreview'] = 'IMPORT_PREVIEW_EXPIRED';
    receipt['serverDate'] = today(f.now());
    receipt['limits'] = ['OS zoom 200% was not driven. Viewport 360px is a layout check, not device zoom.', 'The second browser context has no cookie. It is not two tabs of the same signed-in session.', 'Downloaded bytes were checked for name, size and magic or CSV line count. They were not opened in Excel or a PDF viewer.'];
    receipt['status'] = 'passed';
  } catch (error) {
    receipt['status'] = 'failed';
    receipt['failure'] = String(error).slice(0, 800);
    receipt['viteLog'] = viteLog.slice(-800);
    if (page) {
      receipt['alerts'] = await page.getByRole('alert').allInnerTexts().catch(() => []);
      await shot(page, 'fallo.png').catch(() => undefined);
    }
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    if (vite && vite.exitCode === null) {
      vite.kill();
      await once(vite, 'exit').catch(() => undefined);
    }
    receipt['totalMs'] = Math.round(performance.now() - totalStarted);
    await mkdir(captureDir, { recursive: true });
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
    await group.dispose();
  }
});
