/* eslint-disable security/detect-object-injection -- Own synthetic labels and own digit string indexing only. */
// S08-P05 own browser journey (Claude) on the integrated candidate UI (cliente/dist-s08-p04, read-only) served by the real HTTPS app of
// the reviewer group, real Chromium 1228. Figures shown are compared with the API response of the same request and that response
// with the own raw-data oracle; the UI is not taken as economic proof or accessibility certification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { s08ReviewProfile } from './review-profile.js';
import { world8, evidence } from './review-fixtures.js';
import { oracle } from './indicators.js';
const EV = resolve('../../Construccion/Sprints/S08/Evidencias');
const cop = (v) => { if (v === null)
    return null; const neg = v.startsWith('-'), [w, d] = v.replace('-', '').split('.'); let g = ''; for (let i = 0; i < w.length; i++)
    g += (i > 0 && (w.length - i) % 3 === 0 ? '.' : '') + w[i]; return (neg ? '-' : '') + (d === '00' ? g : g + ',' + d); };
test('P08-UI own browser journey on the integrated candidate', { timeout: 2400000 }, async () => {
    const group = await s08ReviewProfile(), o = {};
    const { chromium } = await import(pathToFileURL(resolve('../cliente/node_modules/playwright/index.mjs')).href);
    let browser;
    try {
        const x = await world8(group), f = x.f, P = await x.member(['P']), A = await x.member(['A']);
        const L2 = await x.newLoan();
        await x.bankReceipt(L2, '2000000.00', 'EXTRA_PRINCIPAL');
        const dq = await x.request('250000.00'), did = dq.id;
        await x.act('dispatchCashDelivery', did, f.c);
        await x.act('receiveCashDelivery', did, f.o);
        await x.count(did, '250000.00');
        await x.confirm(did);
        const dq2 = await x.request('50000.00'), d2 = dq2.id;
        await x.act('dispatchCashDelivery', d2, f.c);
        await x.act('receiveCashDelivery', d2, f.o);
        await x.count(d2, '40000.00');
        const https = await f.https(true), origin = 'https://localhost:' + https.port;
        browser = await chromium.launch({ executablePath: 'C:/Users/Asus ExpertBook/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe', headless: true });
        o['browser'] = browser.version();
        const open = async (actor, width = 1280) => { const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 900 }, locale: 'es-CO' }); await ctx.addCookies([{ name: '__Host-caudelyx-session', value: actor.issued.token, url: origin + '/', secure: true, httpOnly: true, sameSite: 'Lax' }]); const page = await ctx.newPage(); page.setDefaultTimeout(20000); await page.clock.setFixedTime(new Date(f.now())); return { ctx, page }; };
        const informes = async (page) => { await page.goto(origin + '/#/informes'); await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByRole('heading', { name: 'Informes', exact: true }).waitFor(); };
        const consult = async (page) => { const r = page.waitForResponse(z => new URL(z.url()).pathname.endsWith('/reporting/dashboard')); await page.getByRole('button', { name: 'Consultar el tablero' }).click(); const resp = await r; const body = await resp.json(); await page.getByRole('region', { name: 'Corte consultado' }).waitFor(); return { status: resp.status(), data: body['data'] }; };
        /** Card texts per group vs API values of the same response. */
        const cards = async (page, group, list) => { const region = page.getByRole('region', { name: group, exact: true }); const text = await region.innerText(); const missing = list.filter(m => { const v = m['value'], st = m['status']; const shown = st === 'UNAVAILABLE' ? 'No disponible' : st === 'NO_DENOMINATOR' ? 'Sin denominador' : v === null ? 'No computable' : cop(v) + (m['unit'] === 'PERCENT' ? ' %' : ' COP'); return !text.includes(shown); }).map(m => m['id']); return { count: list.length, missing }; };
        // ---- T desktop: dashboard vs API vs own oracle, scope label, report, drilldown, NA, stale, keyboard.
        const t = await open(f.a);
        await informes(t.page);
        o['T título/metadata'] = await t.page.title();
        const td = await consult(t.page);
        const meta = td.data['meta'];
        const exp = oracle(await x.dump(), { asOf: String(meta['asOf']), from: String(meta['from']), to: String(meta['to']), recordedThrough: String(meta['recordedThrough']) }, { kind: 'T', actor: '' });
        const tm = td.data['organizationMetrics'];
        o['T tablero'] = { status: td.status, cards: await cards(t.page, 'Organización', tm), apiVsOracle: tm.filter(m => m['value'] !== exp.metrics[String(m['id'])]).map(m => ({ id: m['id'], api: m['value'], oracle: exp.metrics[String(m['id'])] })), cut: { asOf: meta['asOf'], from: meta['from'], to: meta['to'] }, scopeText: (/(Organización|Cartera asignada|Actividad propia|Pagos autorizados|Ámbito no reconocido)/.exec(await t.page.getByRole('region', { name: 'Corte consultado' }).innerText()) ?? [null])[0] };
        o['T NA visibles'] = await t.page.getByText('No disponible').count();
        await t.page.screenshot({ path: EV + '/S08-P05-desktop.png', fullPage: true });
        const rr = t.page.waitForResponse(z => new URL(z.url()).pathname.endsWith('/reports/PORTFOLIO'));
        await t.page.getByRole('button', { name: 'Ver el reporte' }).click();
        const pr = await rr;
        const pj = (await pr.json())['data'];
        await t.page.getByRole('table').waitFor();
        o['T Cartera'] = { status: pr.status(), totalRows: pj['totalRows'], rowsShown: await t.page.locator('tbody tr').count(), text: (await t.page.locator('tbody tr').first().innerText()).replace(/\s+/g, ' ').slice(0, 300) };
        const lr = t.page.waitForResponse(z => /\/reporting\/loans\//.test(new URL(z.url()).pathname));
        await t.page.locator('tbody tr').first().getByRole('button').click();
        const lres = await lr;
        await t.page.getByRole('region', { name: 'Detalle del préstamo' }).waitFor();
        o['T detalle'] = { status: lres.status(), text: (await t.page.getByRole('region', { name: 'Detalle del préstamo' }).innerText()).replace(/\s+/g, ' ').slice(0, 400) };
        // Stale set: a write after the dashboard; next report request must not mix (409) and the screen must not keep figures as current.
        await x.bankReceipt(L2, '1000.00');
        const sr = t.page.waitForResponse(z => new URL(z.url()).pathname.endsWith('/reports/PORTFOLIO'));
        await t.page.getByRole('button', { name: 'Ver el reporte' }).click();
        const srr = await sr;
        await t.page.waitForResponse(() => true, { timeout: 1500 }).catch(() => undefined);
        o['T obsoleto'] = { status: srr.status(), body: (await srr.json())['error'], cardsStillShown: await t.page.getByRole('region', { name: 'Organización', exact: true }).count(), alert: (await t.page.locator('[role="alert"]').first().innerText().catch(() => '')).slice(0, 200) };
        await t.page.screenshot({ path: EV + '/S08-P05-stale.png', fullPage: true });
        // Keyboard: focus the date field then Tab to the submit and press Enter.
        await informes(t.page);
        await t.page.getByLabel('Corte').focus();
        await t.page.keyboard.press('Tab');
        const kr = t.page.waitForResponse(z => new URL(z.url()).pathname.endsWith('/reporting/dashboard'));
        await t.page.keyboard.press('Enter');
        o['T teclado Tab+Enter'] = (await kr).status();
        // Mobile 360 px.
        await t.page.setViewportSize({ width: 360, height: 800 });
        await t.page.reload({ waitUntil: 'domcontentloaded' });
        await t.page.getByRole('heading', { name: 'Informes', exact: true }).waitFor();
        await consult(t.page);
        o['T móvil 360'] = await t.page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
        await t.page.screenshot({ path: EV + '/S08-P05-mobile.png', fullPage: false });
        await t.ctx.close();
        // ---- C, O, P and A projections.
        const c = await open(f.c);
        await informes(c.page);
        const cd = await consult(c.page);
        o['C tablero'] = { groups: [await c.page.getByRole('region', { name: 'Cartera asignada', exact: true }).count(), await c.page.getByRole('region', { name: 'Actividad y custodia propias', exact: true }).count(), await c.page.getByRole('region', { name: 'Organización', exact: true }).count()], assigned: await cards(c.page, 'Cartera asignada', cd.data['assignedMetrics']), own: await cards(c.page, 'Actividad y custodia propias', cd.data['ownActivityMetrics']), scopeText: (/(Organización|Cartera asignada|Actividad propia|Pagos autorizados|Ámbito no reconocido)/.exec(await c.page.getByRole('region', { name: 'Corte consultado' }).innerText()) ?? [null])[0] };
        await c.ctx.close();
        const ow = await open(f.o);
        await informes(ow.page);
        await consult(ow.page);
        o['O reportes disponibles'] = await ow.page.getByLabel('Reporte').locator('option').allInnerTexts();
        await ow.ctx.close();
        const pp = await open(P);
        await informes(pp.page);
        const pd = await consult(pp.page);
        o['P tablero'] = { ids: pd.data['ownActivityMetrics'].map(m => m['id']), groups: await pp.page.getByRole('region', { name: 'Organización', exact: true }).count() };
        await pp.ctx.close();
        const aa = await open(A);
        await informes(aa.page);
        o['A sin rol'] = (await aa.page.locator('.panel').first().innerText()).replace(/\s+/g, ' ').slice(0, 200);
        await aa.ctx.close();
        // ---- discrepant return 50/40 by O in the collections UI (no "devuelto" message on request).
        const r = await open(f.o);
        await r.page.goto(origin + '/#/cobranza');
        await r.page.reload({ waitUntil: 'domcontentloaded' });
        await r.page.getByRole('heading', { name: 'Cobranza y caja', exact: true }).waitFor();
        await r.page.getByRole('button', { name: 'Actualizar datos' }).waitFor();
        await r.page.getByLabel('Soporte', { exact: true }).fill('SYN-P05-UI8');
        await r.page.locator('tbody tr').filter({ hasText: d2.slice(0, 8) }).getByRole('button', { name: 'Abrir', exact: true }).click();
        await r.page.getByRole('region', { name: 'Entrega seleccionada', exact: true }).getByRole('heading').waitFor();
        const rq = r.page.waitForResponse(z => z.request().method() === 'POST' && new URL(z.url()).pathname.endsWith('/return-requests'));
        await r.page.getByRole('button', { name: 'Solicitar retorno', exact: true }).click();
        const rqr = await rq;
        await r.page.getByText(/Solicitud registrada; devolución pendiente/).first().waitFor({ timeout: 10000 }).catch(() => undefined);
        const regionText = await r.page.getByRole('region', { name: 'Entrega seleccionada', exact: true }).innerText();
        o['O solicita retorno 50/40 (UI)'] = { status: rqr.status(), pendingMessage: /Solicitud registrada; devolución pendiente/.test(await r.page.locator('body').innerText()), saysReturned: /\bdevuelto\b/i.test(regionText.replaceAll('No es dinero devuelto.', '')), negativeNotice: regionText.includes('No es dinero devuelto.'), state: (await x.delivery(d2)).state, lastCount: (await x.delivery(d2)).lastCount };
        await r.page.screenshot({ path: EV + '/S08-P05-return.png', fullPage: true });
        await r.ctx.close();
        o['omitidos'] = ['zoom nativo 200% (sin método real en Playwright headless; no se declara por CSS)', 'lector de pantalla/certificación de accesibilidad', 'dos pestañas/logout simultáneo (cubierto por P04; no repetido)'];
    }
    finally {
        evidence('P08-UI', { observed: o });
        await browser?.close();
        await group.dispose();
    }
    const td = o['T tablero'];
    assert.equal(td.status, 200);
    assert.deepEqual(td.cards.missing, []);
    assert.deepEqual(td.apiVsOracle, []);
    assert.equal(o['T obsoleto'].status, 409);
    assert.equal(o['O solicita retorno 50/40 (UI)'].status, 201);
    assert.equal(o['O solicita retorno 50/40 (UI)'].saysReturned, false);
    const m = o['T móvil 360'];
    assert.ok(m.scrollWidth <= m.clientWidth + 1);
});
//# sourceMappingURL=browser.test.js.map