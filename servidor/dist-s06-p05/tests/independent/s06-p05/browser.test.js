/* eslint-disable security/detect-object-injection, security/detect-non-literal-regexp -- Own synthetic labels/ids only. */
// S06-P05 own browser journey (Claude) on the integrated candidate UI (cliente/dist-s06-p04) served by the real HTTPS app of
// the reviewer group. Every money check reads the own group's ledger/domain and compares with the own oracle; UI text is
// only checked for labels/feedback. Synthetic data only; screenshots never show secrets (codes are typed, not displayed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { s06Profile, password } from './review-profile.js';
import { world, mm, toC } from './review-fixtures.js';
import { S6Book, c, m, terms as oracleTerms } from './oracle.js';
const evidence = (name, d) => console.log(JSON.stringify({ evidence: name, ...d }));
test('P06-UI own browser journey on the integrated candidate', { timeout: 1800000 }, async () => {
    const group = await s06Profile(), o = {};
    const { chromium } = await import(pathToFileURL(resolve('../cliente/node_modules/playwright/index.mjs')).href);
    const { generate } = await import('otplib');
    let browser;
    try {
        const w = await world(group), f = w.f, T = f.a, book = new S6Book('HELD');
        const C = await f.member('C'), O = await f.member('O'), P = await f.member('P');
        const bank = (await f.accountS06('BANK_UI', 'ASSET', 'BANK')).id, cashC = (await f.accountS06('CASH_C_UI', 'ASSET', 'CASH')).id, cashO = (await f.accountS06('CASH_O_UI', 'ASSET', 'CASH')).id, held = await f.heldProfile();
        await f.bind(C, cashC, held);
        await f.bind(O, cashO, held);
        const L1 = await f.loan({ principal: '2000000.00' }), L2 = await f.loan({ principal: '2000000.00' }, L1.borrowerId);
        await f.disburse(L1);
        await f.disburse(L2);
        const T0 = w.today();
        book.fund('FUND', c('20000000.00'));
        for (const l of [L1, L2]) {
            book.addLoan(l.id, l.borrowerId, oracleTerms());
            book.disburse(l.id, 'FUND');
        }
        await w.scope(C.issued.context.subjectId, L1.id, true);
        const label = new Map([[f.profile.principalAccountId, 'PRINCIPAL'], [f.profile.interestReceivableAccountId, 'INTEREST_RECEIVABLE'], [f.profile.interestIncomeAccountId, 'INTEREST_INCOME'], [f.profile.borrowerCreditAccountId, 'BORROWER_CREDIT'], [held, 'HELD'], [bank, 'BANK'], [cashC, 'CASH_C'], [cashO, 'CASH_O'], [f.account, 'FUND']]);
        const journalOf = async (id) => { const j = await w.db.collection('financial_journals').findOne({ _id: id }); const t = new Map(); for (const l of (j?.['lines'] ?? []))
            t.set(l.accountId, (t.get(l.accountId) ?? 0n) + toC(l.debit) - toC(l.credit)); return [...t].filter(([, v]) => v !== 0n).map(([a, v]) => ({ account: label.get(a) ?? '?', debit: v > 0n ? mm(v) : '0.00', credit: v < 0n ? mm(-v) : '0.00' })).sort((a, b) => a.account.localeCompare(b.account)); };
        const oracleRows = (p) => p.map(x => ({ account: x.account, debit: m(x.debit), credit: m(x.credit) })).sort((a, b) => a.account.localeCompare(b.account));
        const https = await f.https(true), origin = 'https://localhost:' + https.port;
        browser = await chromium.launch({ executablePath: 'C:/Users/Asus ExpertBook/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe', headless: true });
        o['browser'] = browser.version();
        const api = [];
        const open = async (actor, viaLogin = false) => {
            const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, locale: 'es-CO' });
            if (actor && !viaLogin)
                await ctx.addCookies([{ name: '__Host-caudelyx-session', value: actor.issued.token, url: origin + '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
            const page = await ctx.newPage();
            page.setDefaultTimeout(20000);
            await page.clock.setFixedTime(new Date(f.now()));
            page.on('response', r => { const u = new URL(r.url()); if (u.pathname.includes('/api/v1/'))
                api.push(`${r.request().method()} ${u.pathname.replace(/[0-9a-f-]{36}/g, '{id}')} ${r.status()}`); });
            return { ctx, page };
        };
        const idle = async (page) => { await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).some(b => b.textContent?.trim() === 'Enviando…')); };
        const click = async (page, name, suffix) => { const pr = page.waitForResponse(async (r) => new URL(r.url()).pathname.endsWith(suffix) && r.request().method() === 'POST' && !(r.status() === 400 && (await r.json()).error?.code === 'CSRF_INVALID')); await page.getByRole('button', { name, exact: true }).click(); const r = await pr; await idle(page); return { status: r.status(), body: await r.json() }; };
        const stepUp = async (page, actor) => { await page.getByLabel('Código de 6 dígitos').waitFor(); f.clock.value += 30000; await page.getByLabel('Código de 6 dígitos').fill(await generate({ secret: actor.secret, epoch: Math.floor(f.now() / 1000) })); await page.getByRole('button', { name: 'Confirmar', exact: true }).click(); };
        const register = async (page, accountCode, loanId, reference, amount, mode = 'SUPERVISED') => {
            await page.getByRole('checkbox', { name: new RegExp(loanId.slice(0, 8) + '.*' + accountCode) }).check();
            await page.getByLabel(/^Importe para /).first().fill(amount);
            await page.getByLabel('Importe del recibo', { exact: true }).fill(amount);
            await page.getByLabel('Referencia', { exact: true }).fill(reference);
            await page.getByLabel('Soporte', { exact: true }).fill('SYN-P05-UI');
            if (mode === 'DIRECT')
                await page.getByLabel('Modo de registro').selectOption('DIRECT');
            await page.getByRole('button', { name: 'Pedir el plan', exact: true }).click();
            await page.getByRole('checkbox', { name: /Confirmo este plan del servidor/ }).check();
        };
        const goPayments = async (page) => { await page.goto(origin + '/#/pagos'); await page.getByRole('heading', { name: 'Pagos', exact: true }).waitFor(); await page.getByRole('button', { name: 'Refrescar', exact: true }).waitFor(); };
        // ---- 1. C registers CASH 300k (assigned loan): pending, no debt/ledger change.
        const Cs = await open(C);
        await goPayments(Cs.page);
        const j0 = await w.journals(), pos0 = await w.position(L1.id);
        await register(Cs.page, 'CASH_C_UI', L1.id, 'UI-CASH-300', '300000');
        const r1 = await click(Cs.page, 'Confirmar el registro', '/payments');
        const p1 = String(r1.body.data['entityId']);
        book.register(p1, { method: 'CASH', mode: 'SUPERVISED', borrower: L1.borrowerId, amount: c('300000.00'), account: 'CASH_C', targets: [{ loan: L1.id, amount: c('300000.00'), mode: 'REGULAR' }], excess: 'CREDIT', registrar: 'C', custodian: 'C' }, T0);
        o['1 C pending'] = { status: r1.status, journalsUnchanged: await w.journals() === j0, principalUnchanged: (await w.position(L1.id))['principalOutstanding'] === pos0['principalOutstanding'], custody: (await w.readPay(p1)).custodyState, approveOfferedToC: await Cs.page.getByRole('button', { name: 'Pedir el plan de aprobación', exact: true }).count() };
        // ---- 2. P approves with the in-UI step-up (BALANCE_60M): one posting == oracle.
        const Ps = await open(P);
        await goPayments(Ps.page);
        await Ps.page.getByRole('button', { name: /UI-CASH-300/ }).click();
        await Ps.page.getByRole('button', { name: 'Pedir el plan de aprobación', exact: true }).click();
        await Ps.page.getByRole('checkbox', { name: /Confirmo este plan del servidor/ }).check();
        const ap = Ps.page.waitForResponse(r => new URL(r.url()).pathname.endsWith(`/payments/${p1}/approve`) && r.request().method() === 'POST' && r.status() !== 400 && r.status() !== 403);
        await Ps.page.getByRole('button', { name: 'Confirmar la aprobación', exact: true }).click();
        await stepUp(Ps.page, P);
        const apr = await ap;
        await idle(Ps.page);
        const s2 = book.approve(p1, 'P', T0), pay1 = await w.readPay(p1), ev1 = await w.db.collection('loan_events').findOne({ _id: pay1.eventId });
        o['2 P approves'] = { status: apr.status(), server: await journalOf(String(ev1['journalId'])), oracle: oracleRows(s2.postings), principal: (await w.position(L1.id))['principalOutstanding'], custody: pay1.custodyState, detailText: (await Ps.page.getByRole('region', { name: 'Detalle del pago' }).count()) ? (await Ps.page.getByRole('region', { name: 'Detalle del pago' }).innerText()).slice(0, 400) : 'detail hidden after decision' };
        // ---- 3. C registers 100, P rejects, C declares the physical return: no posting at any step.
        await Cs.page.getByRole('button', { name: 'Refrescar', exact: true }).click();
        await idle(Cs.page);
        await register(Cs.page, 'CASH_C_UI', L1.id, 'UI-CASH-REJECT', '100');
        const r3 = await click(Cs.page, 'Confirmar el registro', '/payments');
        const p3 = String(r3.body.data['entityId']);
        const j3 = await w.journals();
        await Ps.page.getByRole('button', { name: 'Refrescar', exact: true }).click();
        await idle(Ps.page);
        await Ps.page.getByRole('button', { name: /UI-CASH-REJECT/ }).click();
        await Ps.page.getByLabel('Motivo de la acción').fill('No aceptado');
        await Ps.page.getByLabel('Soporte de la acción').fill('SYN-P05-UI');
        const rej = await click(Ps.page, 'Rechazar el pendiente', `/payments/${p3}/reject`);
        await Cs.page.getByRole('button', { name: 'Refrescar', exact: true }).click();
        await idle(Cs.page);
        await Cs.page.getByLabel('Referencia de quien recibe el efectivo').fill('Pagador sintético');
        await Cs.page.getByLabel('Motivo de la acción').fill('Devolución física');
        const ret = await click(Cs.page, 'Declarar el retorno del efectivo', `/cash-custody/${p3}/return`);
        o['3 reject + return'] = { reject: rej.status, ret: ret.status, custody: (await w.readPay(p3)).custodyState, journalsUnchanged: await w.journals() === j3 };
        // ---- 4. T logs in through the UI (W), DIRECT BANK 100k on L2 with the response lost: retry same command → one posting.
        const Ts = await open(null, true);
        await Ts.page.goto(origin + '/#/ingresar');
        await Ts.page.getByLabel('Correo', { exact: true }).fill(T.email);
        await Ts.page.getByLabel('Contraseña', { exact: true }).fill(password);
        await Ts.page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
        await Ts.page.getByRole('link', { name: /Pagos/ }).first().waitFor();
        await goPayments(Ts.page);
        await register(Ts.page, 'BANK_UI', L2.id, 'UI-BANK-LOST', '100000', 'DIRECT');
        const jBefore = await w.journals();
        let committed;
        await Ts.page.route('**/api/v1/organizations/*/payments', async (route) => { if (route.request().method() !== 'POST')
            return await route.continue(); const r = await route.fetch(); committed = (await r.json())['data']; await route.abort('failed'); }, { times: 1 });
        await Ts.page.getByRole('button', { name: 'Confirmar el registro', exact: true }).click();
        if (await Ts.page.getByLabel('Código de 6 dígitos').count() || true) {
            try {
                await stepUp(Ts.page, T);
            }
            catch { /* grant already present */ }
        }
        await Ts.page.getByRole('button', { name: 'Reintentar el mismo comando', exact: true }).waitFor();
        const uncertain = (await Ts.page.getByRole('region', { name: 'Plan del servidor' }).count()) ? (await Ts.page.getByRole('region', { name: 'Plan del servidor' }).innerText()).slice(0, 300) : '';
        const stored = await Ts.page.evaluate(() => sessionStorage.getItem('caudelyx.s06.payments.draft'));
        await Ts.page.reload();
        const replayP = Ts.page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/payments'));
        await Ts.page.getByRole('button', { name: 'Reintentar el mismo comando', exact: true }).click();
        const replay = await replayP;
        await idle(Ts.page);
        const p4 = String(committed?.['entityId']);
        const s4 = book.register(p4, { method: 'BANK', mode: 'DIRECT', borrower: L2.borrowerId, amount: c('100000.00'), account: 'BANK', targets: [{ loan: L2.id, amount: c('100000.00'), mode: 'REGULAR' }], excess: 'CREDIT', registrar: 'T', custodian: null }, T0);
        const pay4 = await w.readPay(p4), ev4 = await w.db.collection('loan_events').findOne({ _id: pay4.eventId });
        o['4 DIRECT lost response'] = { committedBeforeLoss: Boolean(committed), uncertainFeedback: uncertain, draftPersistedForRetry: Boolean(stored), replayStatus: replay.status(), sameKey: JSON.parse(stored ?? '{}')['executionKey'] === replay.request().headers()['idempotency-key'], journalsAdded: await w.journals() - jBefore, server: await journalOf(String(ev4['journalId'])), oracle: oracleRows(s4.postings) };
        // ---- 5. Declare + link 1:1 (no posting); 6. compensation refused while linked, unlink, compensate == oracle.
        await Ts.page.getByRole('combobox', { name: 'Cuenta bancaria de la organización', exact: true }).fill('BANK_UI');
        await Ts.page.getByRole('option', { name: /BANK_UI/ }).click();
        await Ts.page.getByLabel('Importe declarado').fill('100000');
        await Ts.page.getByLabel('Fecha del movimiento').fill(String(pay4['intent'].observedDate));
        await Ts.page.getByLabel('Referencia declarada').fill('UI-BANK-LOST');
        await Ts.page.getByLabel('Nombre declarado del banco').fill('Banco sintético');
        await Ts.page.getByLabel('Referencia del extracto').fill('EXT-UI');
        await Ts.page.getByLabel('Línea declarada').fill('1');
        await Ts.page.getByLabel('Soporte de la acción').fill('SYN-P05-UI');
        const jDecl = await w.journals(), decl = await click(Ts.page, 'Declarar el movimiento', '/bank-declarations');
        await Ts.page.getByLabel('Declaración para vincular').selectOption(String(decl.body.data['entityId']));
        const lk = await click(Ts.page, 'Vincular uno a uno', '/reconciliation-links');
        o['5 declare + link'] = { declare: decl.status, link: lk.status, reconciliation: (await w.readPay(p4)).reconciliationState, journalsAdded: await w.journals() - jDecl };
        await Ts.page.getByLabel('Motivo de la acción').fill('Corrección sintética');
        const req = await click(Ts.page, 'Solicitar la compensación', `/loan-events/${pay4.eventId}/reversal-requests`);
        const planWhileLinked = Ts.page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/payment-previews'));
        await Ts.page.getByRole('button', { name: 'Pedir el plan de compensación', exact: true }).click();
        const pwl = await planWhileLinked;
        await idle(Ts.page);
        const linkedMsg = (await Ts.page.getByRole('alert').count()) ? (await Ts.page.getByRole('alert').first().innerText()).slice(0, 200) : '';
        const un = await click(Ts.page, 'Desvincular', '/reconciliation-unlinks');
        await Ts.page.getByRole('button', { name: 'Pedir el plan de compensación', exact: true }).click();
        await Ts.page.getByRole('checkbox', { name: /Confirmo este plan del servidor/ }).check();
        const cmp = await click(Ts.page, 'Confirmar la compensación', `/loan-events/${pay4.eventId}/reversals`);
        const s6 = book.reverse(book.payments.get(p4).eventSeq, T0), comp = await w.db.collection('loan_compensations').findOne({ originalEventId: pay4.eventId });
        o['6 compensation'] = { request: req.status, previewWhileLinked: `${pwl.status()} ${String((await pwl.json()).error?.code ?? '')}`, messageWhileLinked: linkedMsg, unlink: un.status, compensate: cmp.status, server: comp ? await journalOf(String(comp['journalId'])) : null, oracle: oracleRows(s6.postings), principal: (await w.position(L2.id))['principalOutstanding'], held: (await w.held()).map(h => h['amount']) };
        // ---- 7. Pending supervised payment overtaken by another event on the same loan (H-S6-P05-01 reproduction in the UI).
        const Os = await open(O);
        await goPayments(Os.page);
        await register(Os.page, 'BANK_UI', L1.id, 'UI-O-STALE', '5000');
        const r7 = await click(Os.page, 'Confirmar el registro', '/payments');
        const p7 = String(r7.body.data['entityId']);
        const other = await w.register(await f.intent(L1, bank, '1000.00'), 'DIRECT');
        await Ps.page.getByRole('button', { name: 'Refrescar', exact: true }).click();
        await idle(Ps.page);
        await Ps.page.getByRole('button', { name: /UI-O-STALE/ }).click();
        const pv7 = Ps.page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/payment-previews'));
        await Ps.page.getByRole('button', { name: 'Pedir el plan de aprobación', exact: true }).click();
        const pr7 = await pv7;
        await idle(Ps.page);
        const msg7 = (await Ps.page.getByRole('alert').count()) ? (await Ps.page.getByRole('alert').first().innerText()).slice(0, 200) : '';
        await Ps.page.getByRole('button', { name: 'Refrescar', exact: true }).click();
        await idle(Ps.page);
        await Ps.page.getByRole('button', { name: /UI-O-STALE/ }).click();
        const pv7b = Ps.page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/payment-previews'));
        await Ps.page.getByRole('button', { name: 'Pedir el plan de aprobación', exact: true }).click();
        const pr7b = await pv7b;
        await idle(Ps.page);
        o['7 stale pending after other event'] = { otherDirect: w.st(other), approvalPreview: `${pr7.status()} ${String((await pr7.json()).error?.code ?? '')}`, uiMessage: msg7, afterRefreshPreview: `${pr7b.status()} ${String((await pr7b.json()).error?.code ?? '')}`, paymentStatus: (await w.readPay(p7)).status };
        // ---- 8. Layout / keyboard / logout clearing drafts in two tabs.
        await Ts.page.setViewportSize({ width: 360, height: 780 });
        o['8 mobile 360'] = await Ts.page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
        await Ts.page.screenshot({ path: resolve('../../Construccion/Sprints/S06/Evidencias/S06-P05-mobile.png'), fullPage: false });
        await Ts.page.setViewportSize({ width: 1280, height: 800 });
        await Ts.page.getByLabel('Prestatario, código o nombre').focus();
        await Ts.page.keyboard.type('P05');
        o['8 keyboard focus kept'] = await Ts.page.getByLabel('Prestatario, código o nombre').evaluate(e => e === document.activeElement);
        await Ts.page.screenshot({ path: resolve('../../Construccion/Sprints/S06/Evidencias/S06-P05-VISUAL.png'), fullPage: false });
        const Ts2 = await Ts.ctx.newPage();
        await Ts2.clock.setFixedTime(new Date(f.now()));
        await goPayments(Ts2);
        await Ts2.getByLabel('Referencia', { exact: true }).fill('BORRADOR-P05');
        await Ts.page.getByRole('button', { name: /Salir|Cerrar sesión/ }).first().click();
        await Ts.page.waitForURL('**/#/ingresar*');
        o['8 logout'] = { draftAfter: await Ts.page.evaluate(() => sessionStorage.getItem('caudelyx.s06.payments.draft')), otherTabRedirected: await (async () => { try {
                await Ts2.waitForURL('**/#/ingresar*');
                return true;
            }
            catch {
                return false;
            } })() };
        // Whole ledger of touched accounts vs oracle.
        const lg = await w.ledger(), whole = {};
        for (const [id, name] of label)
            whole[name] = { server: mm(lg.get(id) ?? 0n), oracle: m(book.balances.get(name) ?? 0n) };
        // The O 5,000 pending and the API DIRECT 1,000 on L1 are outside the oracle: account for the 1,000 confirmed receipt.
        o['whole ledger vs oracle (before the API 1,000 receipt adjustment)'] = whole;
        o['api'] = api.length;
        evidence('P06-UI', { observed: o });
        assert.deepEqual([o['1 C pending']['journalsUnchanged'], o['1 C pending']['principalUnchanged'], o['1 C pending']['custody']], [true, true, 'PROVISIONAL']);
        assert.deepEqual(o['2 P approves'].server, o['2 P approves'].oracle);
        assert.deepEqual([o['3 reject + return']['custody'], o['3 reject + return']['journalsUnchanged']], ['RETURNED', true]);
        const d4 = o['4 DIRECT lost response'];
        assert.deepEqual([d4['replayStatus'], d4['sameKey'], d4['journalsAdded']], [200, true, 1]);
        assert.deepEqual(d4['server'], d4['oracle']);
        assert.deepEqual([o['5 declare + link']['reconciliation'], o['5 declare + link']['journalsAdded']], ['RECONCILED', 0]);
        assert.deepEqual(o['6 compensation'].server, o['6 compensation'].oracle);
        assert.ok((o['8 mobile 360'].scroll) <= 360);
    }
    finally {
        await browser?.close();
        await group.dispose();
    }
});
//# sourceMappingURL=browser.test.js.map