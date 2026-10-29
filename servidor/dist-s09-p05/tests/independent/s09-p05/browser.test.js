/* eslint-disable security/detect-object-injection -- Own synthetic labels and own digit string indexing only. */
// S09-P05 own browser journey (Claude) on the integrated candidate UI (cliente/dist-s09-p04, read-only) served by the real HTTPS app of
// the reviewer group, Playwright Chromium 1228 (not the author's Chrome channel). Figures shown are compared with the API response of
// the same request and that response with the own raw-data oracle; the UI is not economic proof nor accessibility certification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { s09ReviewProfile } from './review-profile.js';
import { world, evidence, info, idOf, rate, schedule } from './review-fixtures.js';
import { consolidation } from './oracle.js';
const EV = resolve('../../Construccion/Sprints/S09/Evidencias'), D = '2026-10-28';
const cop = (v) => { const neg = v.startsWith('-'), [w, d] = v.replace('-', '').split('.'); let g = ''; for (let i = 0; i < w.length; i++)
    g += (i > 0 && (w.length - i) % 3 === 0 ? '.' : '') + w[i]; return (neg ? '-' : '') + (d === '00' ? g : g + ',' + d) + ' COP'; };
test('S09-P05 navegador propio: obligaciones personales, consolidado, colaborador, móvil y teclado', { timeout: 1200000 }, async () => {
    const group = await s09ReviewProfile(), o = {}, fail = [];
    const expect = (at, got, want) => { const g = JSON.stringify(got), w = JSON.stringify(want); o['check ' + at] = g === w ? 'PASS' : { got, want }; if (g !== w)
        fail.push(`${at}: ${g} ≠ ${w}`); };
    const { chromium } = await import(pathToFileURL(resolve('../cliente/node_modules/playwright/index.mjs')).href);
    let browser;
    try {
        const x = await world(group), P = { bookId: x.book.id }, B = { organizationId: x.org }, subject = x.a.issued.context.subjectId;
        const ok = async (label, fn) => { const r = await x.settle(fn); if (![200, 201].includes(r.status))
            throw Error(`${label}: ${x.st(r)}`); return r; };
        const bank = (await x.personal('U_BANK', 'ASSET', 'BANK')).id, debt = (await x.personal('U_DEBT', 'LIABILITY')).id, exp = (await x.personal('U_EXP', 'EXPENSE')).id, pay = (await x.personal('U_PAY', 'LIABILITY')).id, due = (await x.personal('U_DUE', 'ASSET')).id, bDue = (await x.account('U_BDUE', 'LIABILITY')).id;
        const loan = await ok('loan', () => x.mutate('personalCreateLiability', { kind: 'BANK_LOAN', label: 'Crédito UI revisión', counterpartyReference: 'SYN-R09-UI', principal: '1000000.00', rate, schedule: schedule([[D, '200000.00', '30000.00', '10000.00'], ['2026-11-28', '800000.00']]), prepaymentPermissions: [], supportReference: 'SYN-R09-UI' }, P)), lp = { ...P, liabilityId: idOf(loan) };
        await ok('activate', () => x.mutate('personalActivateLiability', { effectiveDate: D, recognitionKind: 'CASH_RECEIPT', principalAccountId: debt, destinationAccountId: bank, legalOwnerReference: 'SYN-R09-OWNER', funding: [{ kind: 'DIRECT_CREDIT', amount: '1000000.00' }], supportReference: 'SYN-R09-UI-ACT' }, lp, loan.etag));
        const env = await x.read('getPersonalLiabilityEnvelope', lp), sv = String(info(env)['schedule']['id']);
        await ok('240k', () => x.mutate('personalRecognizeAndPayLiability', { scheduleVersionId: sv, effectiveDate: D, amount: '240000.00', cashAccountId: bank, allocations: [{ installmentNumber: 1, component: 'PRINCIPAL', amount: '200000.00', accountId: debt }, { installmentNumber: 1, component: 'INTEREST', amount: '30000.00', accountId: pay }, { installmentNumber: 1, component: 'INSURANCE', amount: '10000.00', accountId: pay }], componentRecognitions: [{ installmentNumber: 1, component: 'INTEREST', amount: '30000.00', expenseAccountId: exp, payableAccountId: pay }, { installmentNumber: 1, component: 'INSURANCE', amount: '10000.00', expenseAccountId: exp, payableAccountId: pay }], supportReference: 'SYN-R09-UI-240' }, lp, env.etag));
        const elig = await ok('FULL100', () => x.mutate('declareOwnEligibility', { right: 'FULL_OWNERSHIP', percentage: '100.00', validFrom: D, supportReference: 'SYN-R09-UI-100' }, B));
        const pb = await x.read('getOwnPersonalBook'), bb = await x.read('getBusinessBook', B);
        await ok('cruce 100k', () => x.mutate('postInterbookRelationship', { kind: 'INTERBOOK_LOAN', businessOrganizationId: x.org, businessBookETag: bb.etag, personalBookETag: pb.etag, eligibilityVersionId: idOf(elig), effectiveDate: D, amount: '100000.00', fromScope: 'PERSONAL', personalCashAccountId: bank, businessCashAccountId: x.bank.id, personalContraAccountId: due, businessContraAccountId: bDue, supportReference: 'SYN-R09-UI-REL' }));
        const C = await x.member(['C']), mine = consolidation(await x.dump(), x.book.id, x.org, subject, D);
        const https = await x.https(true), origin = 'https://localhost:' + https.port;
        browser = await chromium.launch({ executablePath: 'C:/Users/Asus ExpertBook/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe', headless: true });
        o['browser'] = browser.version();
        const open = async (actor, width = 1280) => { const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 900 }, locale: 'es-CO' }); await ctx.addCookies([{ name: '__Host-caudelyx-session', value: actor.issued.token, url: origin + '/', secure: true, httpOnly: true, sameSite: 'Lax' }]); const page = await ctx.newPage(); page.setDefaultTimeout(20000); await page.clock.setFixedTime(new Date(x.now())); return { ctx, page }; };
        const view = async (page, button, suffix) => { const r = page.waitForResponse(z => z.request().method() === 'GET' && new URL(z.url()).pathname.endsWith(suffix)); await page.getByRole('button', { name: button, exact: true }).click(); const resp = await r; return { status: resp.status(), body: await resp.json() }; };
        const text = async (page) => await page.locator('body').innerText();
        // ---- T: personal obligations and private consolidation = API = own oracle
        const t = await open(x.a);
        await t.page.goto(origin + '/#/obligaciones', { waitUntil: 'networkidle' });
        await t.page.getByRole('heading', { name: 'Gastos y obligaciones' }).waitFor();
        o['título'] = await t.page.title();
        await t.page.getByRole('button', { name: 'Personal', exact: true }).click();
        const lr = await view(t.page, 'Ver obligaciones', '/liabilities'), items = lr.body['data']['items'] ?? [];
        await t.page.getByRole('heading', { name: 'Gastos y obligaciones' }).waitFor();
        const tl = await text(t.page);
        expect('T obligaciones: API 200 y principal 800.000 visible', [lr.status, items.map(i => i['principalOutstanding']), tl.includes('Principal reconocido pendiente ' + cop('800000.00'))], [200, ['800000.00'], true]);
        const cr = await view(t.page, 'Ver consolidado privado', '/private-consolidation'), cd = cr.body['data'];
        await t.page.getByRole('heading', { name: 'Consolidado privado' }).waitFor();
        const tc = await text(t.page);
        expect('T consolidado API = oráculo', [cd['personalTotals'], cd['gross'], cd['net'], (cd['eliminations'] ?? []).map(e => e['amount'])], [mine.personal, mine.gross, mine.net, mine.eliminations.map(e => e.amount)]);
        const shown = ['assets', 'liabilities', 'cashAvailable'].flatMap(k => [['Activos', 'Pasivos', 'Efectivo disponible'][['assets', 'liabilities', 'cashAvailable'].indexOf(k)] + ': ' + cop(mine.net[k])]);
        expect('T consolidado UI muestra neto del oráculo y eliminación 100.000', [shown.every(s => tc.includes(s)), tc.includes(cop('100000.00'))], [true, true]);
        await t.page.screenshot({ path: resolve(EV, 'S09-P05-desktop.png'), fullPage: true });
        // keyboard: Tab reaches the scope buttons and Enter activates
        await t.page.getByRole('button', { name: 'Personal', exact: true }).focus();
        await t.page.keyboard.press('Tab');
        const focused = await t.page.evaluate(() => document.activeElement?.innerText ?? '');
        o['teclado foco tras Personal'] = focused;
        expect('teclado: Tab mueve el foco a un control con nombre', focused.trim().length > 0, true);
        // ---- mobile 360
        const m = await open(x.a, 360);
        await m.page.goto(origin + '/#/obligaciones', { waitUntil: 'networkidle' });
        await m.page.getByRole('button', { name: 'Personal', exact: true }).click();
        await view(m.page, 'Ver consolidado privado', '/private-consolidation');
        const dims = await m.page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
        expect('móvil 360 sin scroll horizontal', dims[0] <= dims[1], true);
        o['móvil dims'] = dims;
        await m.page.screenshot({ path: resolve(EV, 'S09-P05-mobile.png'), fullPage: true });
        // ---- collaborator C: no personal data of T in UI or network
        const c = await open(C);
        const seen = [];
        await c.page.goto(origin + '/#/obligaciones', { waitUntil: 'networkidle' });
        await c.page.getByRole('heading', { name: 'Gastos y obligaciones' }).waitFor();
        await c.page.getByRole('button', { name: 'Personal', exact: true }).click();
        await c.page.getByRole('heading', { name: 'Gastos y obligaciones' }).waitFor();
        seen.push(await text(c.page));
        const cv = await c.page.waitForResponse(z => new URL(z.url()).pathname.includes('/api/'), { timeout: 3000 }).then(r => r.status()).catch(() => 'sin petición');
        o['C primera respuesta'] = cv;
        const cText = seen.join('\n'), markers = [x.book.id, idOf(loan), cop('800000.00'), 'Crédito UI revisión'];
        expect('C no ve datos PERSONAL de T en UI', markers.filter(mk => cText.includes(mk)), []);
        o['C texto'] = cText.slice(0, 400);
        for (const s of [t, m, c])
            await s.ctx.close();
        evidence('S09-BROWSER', { observed: o, failures: fail });
        assert.deepEqual(fail, [], 'browser mismatches');
        console.log('S09_P05_BROWSER_PASS');
    }
    catch (e) {
        evidence('S09-BROWSER-PARCIAL', { observed: o, failures: fail, error: String(e).slice(0, 400) });
        throw e;
    }
    finally {
        await browser?.close();
        await group.dispose();
    }
});
//# sourceMappingURL=browser.test.js.map