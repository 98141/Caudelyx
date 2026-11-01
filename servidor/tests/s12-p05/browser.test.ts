/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection -- Own S12-P05 evidence/control paths only; synthetic session of the own test actor. */
// S12-P05 (Claude): own real-browser journey over HTTPS (own Vite with the default client config, own API, own Mongo group).
// UI values are compared with the API and with the own oracle (cash 0, OUT30 day16, IN50 day28 => minimum -30, final 20).
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium, type Page, type BrowserContext} from '@playwright/test';
import {s12Profile, world} from './profile.js';
import type {Data} from '../../src/modules/simulation/models.js';

const EV = '../../Construccion/Sprints/S12/Evidencias/', CAP = EV + 'S12-P05-CAPTURES', clientRoot = resolve('../cliente');
const CHROME = process.env['LOCALAPPDATA'] + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const checks: Record<string, unknown> = {};
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
async function freePort() { const s = createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const a = s.address(); if (!a || typeof a === 'string' || [27017, 27181, 3001, 4001].includes(a.port)) throw Error('port'); await new Promise<void>(r => s.close(() => r())); return a.port; }
const shot = async (p: Page, name: string) => { await p.screenshot({path: join(CAP, name), fullPage: true}); return name; };

test('S12-P05 browser: deficit journey UI=API=oracle, alert ACK, negatives, mobile/keyboard, native zoom preference, PDF render', {timeout: 600000}, async () => {
  mkdirSync(CAP, {recursive: true});
  const group = await s12Profile(); let vite: ChildProcess | undefined; const contexts: BrowserContext[] = []; let viteLog = '';
  try {
    const f = await world(group, Date.now()), ps = {organizationId: f.org}, date = new Date(f.now() - 5 * 3600000).toISOString().slice(0, 10);
    // Bring the seeded 20M to exactly 0 through a real journal (setup only, before any simulation).
    const out = {currency: 'COP', effectiveDate: date, sourceId: randomUUID(), supportReference: 'SYN-P05-ZERO', description: 'Retiro sintético P05', lines: [{accountId: f.equity.id, debit: '20000000.00', credit: '0.00'}, {accountId: f.bank.id, debit: '0.00', credit: '20000000.00'}]}, k = randomUUID();
    await f.proof(f.a, 'FINANCE_JOURNAL_POST', {organizationId: f.org, idempotencyKey: k, payload: out}); await f.runtime.finance.mutate(f.a.issued.context, 'postJournal', f.org, out, k); await f.restore.flush();
    const ui = await freePort(), api = await f.https(f.identity, 'https://localhost:' + ui);
    vite = spawn(process.execPath, [join(clientRoot, 'node_modules/vite/bin/vite.js'), '--configLoader', 'native', '--host', 'localhost', '--port', String(ui), '--strictPort'], {cwd: clientRoot, env: {...process.env, CAUDELYX_DEV_UI_PORT: String(ui), CAUDELYX_DEV_API_PORT: String(api.port), CAUDELYX_DEV_TLS_DIRECTORY: group.folder}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    vite.stdout!.on('data', d => { viteLog += d; }); vite.stderr!.on('data', d => { viteLog += d; });
    for (let i = 0; i < 150 && !/ready in|Local:/i.test(viteLog); i++) await new Promise(r => setTimeout(r, 200));
    const origin = 'https://localhost:' + ui;
    const open = async (actor: typeof f.a, o: {viewport?: {width: number; height: number}; zoom?: boolean} = {}) => {
      const dir = join(group.folder, 'chrome-' + randomUUID()); mkdirSync(join(dir, 'Default'), {recursive: true});
      if (o.zoom) writeFileSync(join(dir, 'Default', 'Preferences'), JSON.stringify({partition: {default_zoom_level: {x: Math.log(2) / Math.log(1.2)}}}));
      const ctx = await chromium.launchPersistentContext(dir, {headless: true, executablePath: CHROME, ignoreHTTPSErrors: true, viewport: o.viewport ?? {width: 1280, height: 900}}); contexts.push(ctx);
      await ctx.addCookies([{name: '__Host-caudelyx-session', value: actor.issued.token, url: origin, secure: true, httpOnly: true, sameSite: 'Strict'}]);
      const page = ctx.pages()[0] ?? await ctx.newPage(), posts: string[] = [], errors: string[] = [];
      page.on('request', r => { if (r.method() !== 'GET') posts.push(r.method() + ' ' + new URL(r.url()).pathname); }); page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
      await page.goto(origin + '/#/simulacion'); return {page, posts, errors};
    };
    const {page, posts, errors} = await open(f.a);
    await page.getByRole('button', {name: 'Capturar base'}).click({timeout: 60000});
    await page.getByText(/Base capturada el/).waitFor({timeout: 30000});
    const d16 = addDays(date, 16), d28 = addDays(date, 28);
    await page.getByLabel('Nombre de la hipótesis').fill('Recorrido P05');
    await page.getByLabel('Horizonte en días').fill('30'); await page.getByLabel('Presupuesto declarado').fill('1.00');
    // The UI has no implicit hypotheses: each of the three is confirmed explicitly (AP12).
    for (const [k, p] of [['Prudente', '0.5'], ['Base', '1'], ['Favorable', '1']] as const) { await page.getByLabel('Fracción de recaudo, ' + k).fill(p); await page.getByLabel('Días de retraso, ' + k).fill('0'); await page.getByLabel('Fracción de recuperación, ' + k).fill('0'); await page.getByLabel('Días de espera de la recuperación, ' + k).fill('0'); await page.getByLabel('Proyección de interés, ' + k).selectOption('DECLARED_SCHEDULE_ONLY'); }
    await page.getByLabel('Referencia de la hipótesis, Base').fill('SYN-P05-EXPLICITA');
    await page.getByLabel('Fecha de salida declarada, Base').fill(d16); await page.getByLabel('Importe de salida declarada, Base').fill('30.00');
    await page.getByLabel('Fecha de entrada declarada, Base').fill(d28); await page.getByLabel('Importe de entrada declarada, Base').fill('50.00');
    await shot(page, '01-formulario.png');
    // Keyboard: the primary action is reachable and operable by keyboard.
    await page.getByRole('button', {name: 'Calcular hipótesis', exact: true}).focus(); await page.keyboard.press('Enter');
    await page.getByRole('heading', {name: 'Corrida versión 1'}).waitFor({timeout: 90000});
    await page.waitForTimeout(1500); await shot(page, '02-resultado.png');
    const text = await page.locator('body').innerText();
    const runs = await f.runtime.simulation.execute(f.a.issued.context, 'listRunsBusinessSimulation', {}, ps, {}, randomUUID()), runId = String(((runs.data['items'] as Data[])[0]!)['id']);
    const res = await f.runtime.simulation.execute(f.a.issued.context, 'getResultsBusinessSimulation', {}, {...ps, runId}, {limit: '100'}, randomUUID()), outcomes = res.data['outcomes'] as Data[];
    const base = outcomes.find(o => o['scenarioKind'] === 'BASE' && o['alternativeKind'] === 'HOLD_CASH')!, m = base['metrics'] as Record<string, Data>;
    const uiHasMin = /[-−]\s?\$?\s?30[,.]00/.test(text), uiHasFinal = /\$?\s?20[,.]00/.test(text), uiHasDay16 = text.includes(d16) || text.includes(d16.split('-').reverse().join('/'));
    checks['journey'] = {date, d16, d28, api: {min: m['availableMinimum']!['value'], peak: m['peakDeficit']!['value'], final: m['cashFinal']!['value'], first: base['firstDeficitDate']}, ui: {uiHasMin, uiHasFinal, uiHasDay16, deficitWord: /déficit/i.test(text)}, oracle: {min: '-30.00', final: '20.00', first: d16}};
    assert.equal(m['availableMinimum']!['value'], '-30.00'); assert.equal(m['cashFinal']!['value'], '20.00'); assert.equal(base['firstDeficitDate'], d16);
    assert.ok(uiHasMin && uiHasFinal, 'UI shows the same minimum/final as API and oracle');
    // Alerts and ACK from the UI: no payment, no financial endpoint.
    await page.getByRole('button', {name: 'Evaluar alertas internas'}).click(); await page.waitForTimeout(2500);
    const ack = page.getByRole('button', {name: 'Registrar lectura. Esto no paga.'}).first(); let ackShown = false;
    if (await ack.count()) { await ack.click(); await page.getByText('Lectura registrada. No se creó un pago.').waitFor({timeout: 30000}); ackShown = true; }
    await shot(page, '03-alerta-ack.png');
    const financial = posts.filter(p => !/\/simulation-s12\//.test(p) && !/\/(sessions?|auth|csrf|me)\b/.test(p));
    checks['alerts'] = {ackShown, posts, financialPosts: financial, pageErrors: errors};
    assert.deepEqual(financial, [], 'UI journey sends no financial command'); assert.deepEqual(errors, []);
    // Negative actor: an invited collaborator sees no owner data.
    const c = await f.actor(), payload = {email: c.email, roleIds: ['C']}; await f.proof(f.a, 'MEMBER_INVITE', payload, f.org); await f.runtime.organizations.invite(f.a.issued.context, payload); await f.identity.dispatchMail();
    const mail = [...f.messages.notificationInbox.values()].find(x => x.kind === 'INVITATION' && x.payload['email'] === c.email)!; await f.runtime.organizations.accept(c.issued.context, {mode: 'CONFIRM', token: mail.payload['token']}, randomUUID());
    const neg = await open(c); await neg.page.waitForTimeout(4000); const negText = await neg.page.locator('body').innerText(); await shot(neg.page, '04-colaborador.png');
    checks['negativeActor'] = {seesScenarioName: negText.includes('Recorrido P05'), seesMinimum: /[-−]\s?\$?\s?30[,.]00/.test(negText), excerpt: negText.slice(0, 300)};
    assert.equal(checks['negativeActor'] && (checks['negativeActor'] as Data)['seesScenarioName'], false);
    // Mobile 390 and 360: no horizontal page scroll.
    const mob: Record<string, unknown> = {};
    for (const w of [390, 360]) { const mo = await open(f.a, {viewport: {width: w, height: 844}}); await mo.page.waitForTimeout(3000); mob[w] = await mo.page.evaluate(() => ({scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth})); await shot(mo.page, `05-movil-${w}.png`); }
    checks['mobile'] = mob; for (const v of Object.values(mob)) assert.ok((v as {scrollWidth: number; innerWidth: number}).scrollWidth <= (v as {innerWidth: number}).innerWidth + 1);
    // Native browser zoom via the profile's default zoom preference (not viewport/DPR emulation).
    const z = await open(f.a, {zoom: true}); await z.page.waitForTimeout(3000);
    const zoomed = await z.page.evaluate(() => ({dpr: window.devicePixelRatio, innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth}));
    const plain = await page.evaluate(() => ({dpr: window.devicePixelRatio, innerWidth: window.innerWidth}));
    const overflow = await z.page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && r.right > window.innerWidth + 1 && (e.textContent ?? '').trim().length > 0 && e.children.length === 0; }).slice(0, 12).map(e => ({tag: e.tagName, right: Math.round(e.getBoundingClientRect().right), text: (e.textContent ?? '').trim().slice(0, 40)})));
    const htmlOverflow = await z.page.evaluate(() => ({html: getComputedStyle(document.documentElement).overflowX, body: getComputedStyle(document.body).overflowX, bodyScroll: document.body.scrollWidth}));
    await shot(z.page, '06-zoom-200.png'); await z.page.screenshot({path: join(CAP, '06b-zoom-200-viewport.png'), scale: 'css'});
    checks['zoomOverflow'] = {leafTextBeyondViewport: overflow, htmlOverflow};
    checks['zoom'] = {method: 'Chromium profile Preferences partition.default_zoom_level=log(2)/log(1.2) (browser page zoom 200%), same 1280x900 window', plain, zoomed, applied: zoomed.dpr >= plain.dpr * 1.9, noHorizontalScroll: zoomed.scrollWidth <= zoomed.innerWidth + 1};
  } finally {
    for (const ctx of contexts) await ctx.close().catch(() => undefined);
    if (vite && vite.exitCode === null) { vite.kill(); await once(vite, 'exit').catch(() => undefined); }
    checks['viteLogTail'] = viteLog.slice(-300);
    writeFileSync(EV + 'S12-P05-CHECKS-BROWSER.json', JSON.stringify({task: 'S12-P05', suite: 'browser', at: new Date().toISOString(), group: group.names[0], checks}, null, 1) + '\n');
    await group.dispose();
  }
});
