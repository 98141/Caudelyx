/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection -- Registered own P04 control roots, synthetic native accounts and exact browser handles only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, stat, appendFile } from 'node:fs/promises';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import { generate } from 'otplib';
import { s11Profile, world, password } from './fixture.js';
import { workbook } from './oracle.js';
import { parseWorkbook } from '../../src/modules/exchange/workbook.js';
const evidence = resolve('../../Construccion/Sprints/S11/Evidencias');
async function port() { const s = createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const a = s.address(); assert.ok(a && typeof a !== 'string'); await new Promise(r => s.close(() => r())); assert.ok(![27017, 27181, 3001, 3002, 4001].includes(a.port)); return a.port; }
async function ready(p, cert) { const deadline = Date.now() + 40000; while (Date.now() < deadline) {
    if (await new Promise(done => { const q = request({ hostname: 'localhost', port: p, path: '/', ca: cert, servername: 'localhost' }, r => { r.resume(); done(r.statusCode === 200); }); q.on('error', () => done(false)); q.end(); }))
        return;
    await new Promise(r => setTimeout(r, 200));
} throw Error('Own Vite unavailable'); }
test('native browser QA: opening bridge, two signed-in tabs, uncertain response and native zoom', { timeout: 420000 }, async () => {
    const group = await s11Profile();
    let context, vite, log = '';
    const receipt = { runId: group.runId, task: 'S11-P04', state: 'IN_PROGRESS', limitations: [] };
    const output = join(evidence, 'S11-P04-BROWSER-QA.json'), captures = join(evidence, 'S11-P04-CAPTURES');
    try {
        const f = await world(group, Date.parse('2026-10-31T12:00:00-05:00')), ui = await port(), api = await f.https(f.identity, 'https://localhost:' + ui), url = 'https://localhost:' + ui + '/#/intercambio';
        vite = spawn(process.execPath, [resolve('../cliente/node_modules/vite/bin/vite.js'), '--host', 'localhost', '--strictPort'], { cwd: resolve('../cliente'), env: { ...process.env, CAUDELYX_DEV_UI_PORT: String(ui), CAUDELYX_DEV_API_PORT: String(api.port), CAUDELYX_DEV_TLS_DIRECTORY: group.folder }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        vite.stdout.on('data', b => { log = (log + String(b)).slice(-4000); });
        vite.stderr.on('data', b => { log = (log + String(b)).slice(-4000); });
        await ready(ui, api.cert);
        await mkdir(captures, { recursive: true });
        await appendFile(join(evidence, 'S11-P04-RESOURCES.jsonl'), JSON.stringify({ event: 'browser-profile-reserved', runId: group.runId, root: join(group.folder, 'chrome-profile'), ownerPid: process.pid }) + '\n');
        context = await chromium.launchPersistentContext(join(group.folder, 'chrome-profile'), { headless: process.env['S11_NATIVE_ZOOM_DISABLED'] === '1', channel: 'chrome', viewport: null, ignoreHTTPSErrors: true, args: ['--window-size=1440,1000'] });
        await context.addCookies([{ name: '__Host-caudelyx-session', value: f.a.issued.token, url: 'https://localhost:' + ui + '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
        const page = await context.newPage();
        await page.goto(url);
        await page.getByText(/5242880 bytes/).waitFor({ timeout: 20000 });
        const title = 'S11-P04 QA ' + ui;
        await page.evaluate(t => { document.title = t; }, title);
        await page.bringToFront();
        const before = await page.evaluate(() => ({ dpr: devicePixelRatio, inner: innerWidth, outer: outerWidth, visual: visualViewport?.scale }));
        receipt['zoomBefore'] = before;
        const flag = join(group.folder, 'native-zoom.done');
        await writeFile(join(evidence, 'S11-P04-GUI-STATE.json'), JSON.stringify({ runId: group.runId, title, url, ownerPid: process.pid, folder: group.folder, flag, before }));
        process.stdout.write((process.env['S11_NATIVE_ZOOM_DISABLED'] === '1' ? 'NATIVE_ZOOM_UNAVAILABLE ' : 'GUI_QA_READY ') + JSON.stringify({ title, flag, before }) + '\n');
        const deadline = Date.now() + (process.env['S11_NATIVE_ZOOM_DISABLED'] === '1' ? 0 : 120000);
        while (Date.now() < deadline) {
            if (await stat(flag).then(() => true, () => false))
                break;
            await new Promise(r => setTimeout(r, 200));
        }
        const after = await page.evaluate(() => ({ dpr: devicePixelRatio, inner: innerWidth, outer: outerWidth, visual: visualViewport?.scale, scroll: document.documentElement.scrollWidth }));
        receipt['zoomAfter'] = after;
        if (await stat(flag).then(() => true, () => false)) {
            assert.ok(Math.abs(after.dpr / before.dpr - 2) < 0.02, JSON.stringify({ before, after }));
            receipt['nativeZoom'] = '200 percent via native Chrome keyboard, no DPR/emulation override';
            await page.screenshot({ path: join(captures, 'qa-native-zoom-200.png'), fullPage: true });
        }
        else
            receipt['limitations'].push('Native Windows helper stopped because it could not enforce current URL policy. No native zoom input or DPR substitution; 200 percent not verified.');
        const proof = async (p, actor = f.a) => { const code = p.getByLabel('Código de 6 dígitos'); if (await code.waitFor({ timeout: 1200 }).then(() => true, () => false)) {
            f.clock.value += 30000;
            await code.fill(await generate({ secret: actor.secret, epoch: Math.floor(f.now() / 1000) }));
            await p.getByRole('button', { name: /^Confirmar( y continuar)?$/ }).click();
        }
        else {
            const pass = p.getByLabel('Contraseña', { exact: true });
            if (await pass.isVisible()) {
                await pass.fill(password);
                await p.getByRole('button', { name: /Continuar/ }).last().click();
                await code.waitFor();
                f.clock.value += 30000;
                await code.fill(await generate({ secret: actor.secret, epoch: Math.floor(f.now() / 1000) }));
                await p.getByRole('button', { name: /^Confirmar( y continuar)?$/ }).click();
            }
        } };
        const prepare = async (p, name) => { await p.getByLabel('Modo', { exact: true }).selectOption('OPERATIVE'); await p.getByLabel('Espacio de nombres').fill(name); await p.getByRole('button', { name: 'Crear lote', exact: true }).click(); await p.getByText(/Lote Creado/).waitFor({ timeout: 20000 }); await p.getByLabel(/Archivo .xlsx/).setInputFiles({ name: name + '.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbook('OPERATIVE', name, { Cuentas: [{ externalKey: name, action: 'CREATE', code: name, name: 'Cuenta sintética ' + name, accountClass: 'ASSET', kind: 'BANK', currency: 'COP' }] }) }); await p.getByRole('button', { name: 'Cargar archivo', exact: true }).click(); await p.getByText(/El servidor recibió el archivo/).waitFor({ timeout: 20000 }); await p.getByRole('button', { name: 'Generar vista previa' }).click(); await p.getByText('Vista previa lista. Aún no se realizó la operación.').waitFor({ timeout: 20000 }); };
        if (process.env['S11_QA_CASE'] !== 'opening') {
            await page.getByLabel('Nombre del lote').focus();
            await page.keyboard.press('Tab');
            assert.equal(await page.getByLabel('Espacio de nombres').evaluate(e => e === document.activeElement), true);
            receipt['keyboard'] = 'Tab between actual labelled inputs';
            await prepare(page, 'QA_STALE');
            const tab = await context.newPage();
            await tab.goto(url);
            await tab.getByText(/5242880 bytes/).waitFor();
            await prepare(tab, 'QA_LOST');
            let dropped = false, retries = 0;
            let firstBody = '', firstKey = '';
            await tab.route('**/confirmations', async (route) => { if (!dropped) {
                dropped = true;
                firstBody = route.request().postData() ?? '';
                firstKey = route.request().headers()['idempotency-key'] ?? '';
                const response = await route.fetch();
                assert.equal(response.status(), 201);
                await route.abort('connectionreset');
            }
            else {
                assert.equal(route.request().postData(), firstBody);
                assert.equal(route.request().headers()['idempotency-key'], firstKey);
                retries++;
                await route.continue();
            } });
            await tab.getByRole('button', { name: 'Confirmar lote', exact: true }).click();
            await proof(tab);
            await tab.getByText(/No se confirmó el resultado/).waitFor({ timeout: 30000 });
            await tab.getByRole('button', { name: 'Confirmar lote', exact: true }).click();
            await proof(tab);
            await tab.getByText(/El servidor confirmó el lote/).waitFor({ timeout: 20000 });
            assert.equal(retries, 1);
            assert.ok(firstBody && firstKey);
            assert.equal(await f.runtime.finance.accounts.countDocuments({ organizationId: f.org, code: 'QA_LOST' }), 1);
            await page.getByRole('button', { name: 'Confirmar lote', exact: true }).click();
            await proof(page);
            await page.getByRole('alert').filter({ hasText: /vista previa.*no corresponde/i }).waitFor({ timeout: 20000 });
            assert.equal(await f.runtime.finance.accounts.countDocuments({ organizationId: f.org, code: 'QA_STALE' }), 0);
            receipt['twoTabs'] = { sameCookieContext: true, secondCommittedOnce: true, firstStaleDenied: true, responseDroppedAfterActual201: true, exactOriginalRetryBodyAndKey: true };
            await tab.close();
        }
        const b = await f.actor(), org = (await f.runtime.organizations.create(b.issued.context, { name: 'Apertura browser P04', currency: 'COP', timezone: 'America/Bogota' }, randomUUID())).data.organization.id, sample = parseWorkbook(await readFile('../../Construccion/Sprints/S11/Plantillas/v1.0.0/opening-600.xlsx')), ids = new Map();
        for (const row of sample.data['Cuentas']) {
            const created = await f.runtime.finance.mutate(b.issued.context, 'createAccount', org, { code: row['code'], name: row['name'], accountClass: row['accountClass'], kind: row['kind'], currency: 'COP' }, randomUUID()), id = String(created.data['id']);
            ids.set(String(row['existingId']), id);
            row['existingId'] = id;
            row['expectedETag'] = created.etag;
        }
        for (const rows of Object.values(sample.data))
            for (const row of rows)
                for (const [k, value] of Object.entries(row))
                    if (typeof value === 'string' && ids.has(value))
                        row[k] = ids.get(value);
        await context.clearCookies();
        await context.addCookies([{ name: '__Host-caudelyx-session', value: b.issued.token, url: 'https://localhost:' + ui + '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
        await page.reload();
        await page.getByText(/5242880 bytes/).waitFor();
        await page.getByLabel('Modo', { exact: true }).selectOption('OPENING');
        await page.getByLabel('Espacio de nombres').fill('QA_OPENING');
        await page.getByRole('button', { name: 'Crear lote', exact: true }).click();
        await page.getByText(/Lote Creado/).waitFor();
        const cutoff = String(sample.data['Control'].find(x => x['key'] === 'cutoffDate')['value']);
        await page.getByLabel(/Archivo .xlsx/).setInputFiles({ name: 'opening600.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbook('OPENING', 'QA_OPENING', sample.data, { cutoffDate: cutoff }) });
        await page.getByRole('button', { name: 'Cargar archivo', exact: true }).click();
        await page.getByText(/El servidor recibió el archivo/).waitFor();
        await page.getByRole('button', { name: 'Generar vista previa' }).click();
        await page.getByRole('heading', { name: 'Confirmación de apertura importada' }).waitFor({ timeout: 20000 });
        await page.getByRole('button', { name: 'Guardar apertura importada' }).click();
        await proof(page, b);
        await page.getByText(/Apertura Borrador/).waitFor({ timeout: 20000 });
        await page.getByRole('button', { name: 'Validar apertura importada' }).click();
        await proof(page, b);
        await page.getByText(/Apertura Validado/).waitFor({ timeout: 20000 });
        await page.getByLabel('Revisé las cuentas, el corte y los soportes de la apertura.').check();
        await page.getByRole('button', { name: 'Aprobar apertura importada' }).click();
        await proof(page, b);
        await page.getByText(/Apertura Aprobado/).waitFor({ timeout: 20000 });
        await page.getByLabel('Confirmo publicar una única apertura por estos saldos.').check();
        await page.getByRole('button', { name: 'Contabilizar apertura importada' }).click();
        await proof(page, b);
        await page.getByText(/Lote confirmado y recibo conciliado/).waitFor({ timeout: 30000 });
        const journals = await f.runtime.finance.journals.find({ organizationId: org }).toArray();
        assert.equal(journals.length, 1);
        const cents = (v) => { const [whole, fraction = ''] = v.toString().split('.'); return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')); };
        assert.equal(journals[0].lines.reduce((n, l) => n + cents(l.debit), 0n), 60000n);
        assert.equal(journals[0].lines.reduce((n, l) => n + cents(l.credit), 0n), 60000n);
        assert.equal(await f.database.db.collection('s11_imports').countDocuments({ bookId: org, state: 'COMMITTED' }), 1);
        receipt['opening600'] = { journalCount: 1, rawDebit: '600.00', rawCredit: '600.00', receiptCommitted: 1 };
        const params = { organizationId: org, reportKind: 'NET_WORTH' }, query = { asOf: '2026-10-31', from: '2026-10-01', to: '2026-10-31' }, captured = await f.identity.exchange.report(b.issued.context, params, query), meta = captured.data['meta'], reportPage = await f.identity.exchange.reportPage(b.issued.context, params, { snapshotToken: meta['snapshotToken'] }), netCells = reportPage.data['items'][0]['cells'];
        assert.equal(netCells.find(c => c['columnId'] === 'estimated')['value'], null, 'unknown S3 property estimate remains null, never zero');
        receipt['unknownEstimate'] = { value: null, coverage: meta['coverage'] };
        await page.screenshot({ path: join(captures, 'qa-opening-posted.png'), fullPage: true });
        receipt['state'] = 'PASS';
    }
    catch (error) {
        receipt['state'] = 'FAIL';
        receipt['error'] = String(error);
        receipt['viteLog'] = log;
        if (context) {
            receipt['browserTexts'] = await Promise.all(context.pages().map(p => p.locator('body').innerText().then(t => t.slice(0, 3500)).catch(() => '')));
            await context.pages().at(-1)?.screenshot({ path: join(captures, 'qa-failed-' + group.runId + '.png'), fullPage: true }).catch(() => undefined);
        }
        throw error;
    }
    finally {
        await context?.close().catch(() => undefined);
        if (vite && vite.exitCode === null) {
            vite.kill();
            await once(vite, 'exit').catch(() => undefined);
        }
        let prior = null;
        try {
            prior = JSON.parse(await readFile(output, 'utf8'));
        }
        catch { }
        await writeFile(output, JSON.stringify({ ...receipt, prior }, null, 2) + '\n');
        await group.dispose();
    }
});
//# sourceMappingURL=browser-qa.test.js.map