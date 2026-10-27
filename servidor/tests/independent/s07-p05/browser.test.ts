/* eslint-disable security/detect-object-injection -- Own synthetic labels/ids only. */
// S07-P05 own browser journey (Claude) on the integrated candidate UI (cliente/dist-s07-p04) served by the real HTTPS app of
// the reviewer group. Money checks read the own group's ledger/positions and compare with the own oracle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { s07Profile } from './review-profile.js';
import { world, mm, toC, type Group } from './review-fixtures.js';
import { S7Book, c, m, terms } from './oracle.js';

const evidence = (name: string, d: Record<string, unknown>) => console.log(JSON.stringify({ evidence: name, ...d }));
type Resp = { url(): string; status(): number; ok(): boolean; json(): Promise<Record<string, unknown>>; text(): Promise<string>; request(): { method(): string } };
type Loc = { click(): Promise<void>; fill(v: string): Promise<void>; check(): Promise<void>; selectOption(v: unknown): Promise<unknown>; waitFor(o?: Record<string, unknown>): Promise<void>; count(): Promise<number>; first(): Loc; innerText(): Promise<string>; focus(): Promise<void>; evaluate<T>(f: (e: Element) => T): Promise<T>; filter(o: Record<string, unknown>): Loc; getByRole(r: string, o?: Record<string, unknown>): Loc };
type Page = { goto(u: string, o?: Record<string, unknown>): Promise<unknown>; reload(o?: Record<string, unknown>): Promise<unknown>; getByRole(r: string, o?: Record<string, unknown>): Loc; getByLabel(l: string | RegExp, o?: Record<string, unknown>): Loc; locator(s: string): Loc; waitForResponse(f: (r: Resp) => boolean): Promise<Resp>; evaluate<T>(f: () => T): Promise<T>; setViewportSize(s: { width: number; height: number }): Promise<void>; screenshot(o: Record<string, unknown>): Promise<unknown>; setDefaultTimeout(n: number): void; clock: { setFixedTime(d: Date): Promise<void> }; keyboard: { type(t: string): Promise<void> }; waitForURL(u: string): Promise<void>; on(e: string, f: (r: Resp) => void): void };
type Ctx = { addCookies(c: unknown[]): Promise<void>; newPage(): Promise<Page> };

test('P07-UI own browser journey on the integrated candidate', { timeout: 1800000 }, async () => {
  const group: Group = await s07Profile(), o: Record<string, unknown> = {};
  const { chromium } = await import(pathToFileURL(resolve('../cliente/node_modules/playwright/index.mjs')).href) as { chromium: { launch(o: Record<string, unknown>): Promise<{ version(): string; newContext(o: Record<string, unknown>): Promise<Ctx>; close(): Promise<void> }> } };
  const { generate } = await import('otplib');
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const w = await world(group), f = w.f, T0 = w.today(), book = new S7Book('HELD'), P = await f.member('P'), bank = (await f.accountS06('BANK_UI7', 'ASSET', 'BANK')).id;
    book.fund('FUND', c('20000000.00')); book.addLoan(f.l.id, f.l.borrowerId, terms() as never); book.disburse(f.l.id, 'FUND');
    book.register(f.paymentId, { method: 'CASH', mode: 'SUPERVISED', borrower: f.l.borrowerId, amount: c('300000.00'), account: 'CASH_C', targets: [{ loan: f.l.id, amount: c('300000.00'), mode: 'REGULAR' }], excess: 'CREDIT', registrar: 'C', custodian: 'C' }, T0);
    book.approve(f.paymentId, 'T', T0); book.lot(f.paymentId, 'CASH_C', c('300000.00'));
    const label = new Map([[f.cash.id, 'CASH_C'], [f.central.id, 'CENTRAL']]), C = f.c.issued.context.subjectId!, O = f.o.issued.context.subjectId!;
    const https = await (f.https as unknown as (withClient: boolean) => Promise<{ port: number }>)(true), origin = 'https://localhost:' + https.port;
    browser = await chromium.launch({ executablePath: 'C:/Users/Asus ExpertBook/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe', headless: true }); o['browser'] = browser.version();
    const pages: Record<string, Page> = {}, ctxs: Record<string, Ctx> = {}, actors: Record<string, typeof f.a> = { T: f.a, O: f.o, C: f.c, P };
    const open = async (role: string) => { const ctx = await browser!.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, locale: 'es-CO' }); await ctx.addCookies([{ name: '__Host-caudelyx-session', value: actors[role]!.issued.token, url: origin + '/', secure: true, httpOnly: true, sameSite: 'Lax' }]); const page = await ctx.newPage(); page.setDefaultTimeout(20000); ctxs[role] = ctx; pages[role] = page; return page; };
    const sync = async () => { for (const p of Object.values(pages)) await p.clock.setFixedTime(new Date(f.now())); };
    const idle = async (page: Page) => { await page.locator('[aria-busy="true"]').first().waitFor({ state: 'hidden' }); };
    const go = async (role: string, route = 'cobranza') => { const page = pages[role] ?? await open(role); await page.clock.setFixedTime(new Date(f.now())); await page.goto(origin + '/#/' + route); await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByRole('heading', { name: route === 'pagos' ? 'Pagos' : 'Cobranza y caja', exact: true }).waitFor(); return page; };
    const ready = async (role: string) => { const page = await go(role); await page.getByRole('button', { name: 'Actualizar datos' }).waitFor(); await page.getByLabel('Soporte', { exact: true }).fill('SYN-P05-UI7'); await idle(page); return page; };
    const post = async (page: Page, name: string, path: string) => { await sync(); const done = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(path)); await page.getByRole('button', { name, exact: true }).click(); const r = await done; await idle(page); return { status: r.status(), body: await r.json() }; };
    const select = async (role: string, id: string) => { const page = await ready(role); await page.locator('tbody tr').filter({ hasText: id.slice(0, 8) }).getByRole('button', { name: 'Abrir', exact: true }).click(); await page.getByRole('region', { name: 'Entrega seleccionada', exact: true }).getByRole('heading').waitFor(); return page; };
    const stepUp = async (page: Page, actor: typeof f.a) => { await page.getByRole('dialog').waitFor(); f.clock.value += 30000; await sync(); await page.getByLabel('Código de 6 dígitos').fill(await generate({ secret: actor.secret, epoch: Math.floor(f.now() / 1000) })); await page.getByRole('dialog').getByRole('button', { name: 'Confirmar', exact: true }).click(); };
    const pos = async (who: string) => await w.position(who === 'C' ? C : O, who === 'C' ? f.cash.id : f.central.id);
    // 1. C requests 250k from the confirmed lot and dispatches.
    const cp = await ready('C'); await cp.getByLabel('Caja de destino').selectOption({ index: 1 }); await cp.getByLabel('Lote confirmado').selectOption({ index: 1 }); await cp.getByLabel('Importe a entregar').fill('250000');
    const before = new Set((await w.db.collection('cash_deliveries').find({ organizationId: w.org }).toArray()).map(d => String(d['_id'])));
    o['plan'] = (await post(cp, 'Pedir el plan de entrega', '/cash-delivery-previews')).status; await cp.getByRole('checkbox', { name: /Confirmo este plan/ }).check(); o['request'] = (await post(cp, 'Solicitar la entrega', '/cash-deliveries')).status;
    const did = String((await w.db.collection('cash_deliveries').find({ organizationId: w.org }).toArray()).find(d => !before.has(String(d['_id'])))!['_id']); book.request(did, 'CASH_C', 'CENTRAL', [{ lot: f.paymentId, amount: c('250000.00') }]);
    o['dispatch'] = (await post(cp, 'Despachar', '/dispatch')).status; book.dispatch(did);
    // 2. O receives and counts 230 → discrepancy (no ledger).
    let op = await select('O', did); o['receive'] = (await post(op, 'Recibir para conteo', '/receive')).status; book.receive(did);
    await op.getByLabel('Importe contado').fill('230000'); o['count 230'] = (await post(op, 'Registrar el conteo', '/counts')).status; book.count(did, c('230000.00'));
    o['positions at discrepancy'] = { C: { server: await pos('C'), oracle: book.position('CASH_C') }, O: { server: await pos('O'), oracle: book.position('CENTRAL') } };
    // 3. T investigates; O recounts 250; C ratifies; T resolves with the ratified count.
    let tp = await select('T', did); await tp.getByLabel('Motivo de la acción').fill('Diferencia sintética'); o['investigate'] = (await post(tp, 'Abrir investigación de la diferencia', '/investigation')).status;
    op = await select('O', did); await op.getByLabel('Importe contado').fill('250000'); o['recount 250'] = (await post(op, 'Registrar el conteo', '/counts')).status; book.count(did, c('250000.00'));
    const cp2 = await select('C', did); o['ratify'] = (await post(cp2, 'Ratificar el conteo', '/sender-acknowledgments')).status;
    tp = await select('T', did); o['resolve'] = (await post(tp, 'Resolver con el conteo ratificado', '/correction')).status;
    // 4. T confirms with the in-UI step-up; one posting == oracle; positions == oracle.
    await f.sessions.contexts.updateOne({ _id: f.a.issued.context._id }, { $unset: { balanceGrant: '' } });
    tp = await select('T', did); await post(tp, 'Pedir el plan de confirmación', '/cash-delivery-previews'); await tp.getByRole('checkbox', { name: /Confirmo este plan/ }).check();
    const j0 = await w.journals(); const confirmed = tp.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/confirm') && r.status() !== 403); await tp.getByRole('button', { name: 'Confirmar la entrega', exact: true }).click(); await stepUp(tp, f.a); const cr = await confirmed; await idle(tp);
    const posting = book.confirmDelivery(did), d = await w.delivery(did), jr = await w.db.collection('financial_journals').findOne({ _id: d.journalId as never });
    const t2 = new Map<string, bigint>(); for (const l of (jr?.['lines'] ?? []) as { accountId: string; debit: unknown; credit: unknown }[]) t2.set(l.accountId, (t2.get(l.accountId) ?? 0n) + toC(l.debit) - toC(l.credit));
    o['confirm'] = { status: cr.status(), journalsAdded: await w.journals() - j0, server: [...t2].map(([a, v]) => ({ account: label.get(a), debit: v > 0n ? mm(v) : '0.00', credit: v < 0n ? mm(-v) : '0.00' })).sort((a, b) => String(a.account).localeCompare(String(b.account))), oracle: posting.map(p => ({ account: p.account, debit: m(p.debit), credit: m(p.credit) })).sort((a, b) => a.account.localeCompare(b.account)) };
    o['positions after confirm'] = { C: { server: await pos('C'), oracle: book.position('CASH_C') }, O: { server: await pos('O'), oracle: book.position('CENTRAL') } };
    // 5. H-S6-P05-01 in the UI: O pending BANK, T direct on the same loan, P approves the pending with the current plan.
    const pend = await w.settle(async () => (await f.preparePayment({ kind: 'REGISTER', mode: 'SUPERVISED', effectiveDate: w.today(), intent: { ...await f.intent(f.l, bank, '7000.00', f.o), receiptReference: 'UI7-PEND-' + did.slice(0, 6) } }, f.o)).execute());
    const direct = await w.settle(async () => (await f.preparePayment({ kind: 'REGISTER', mode: 'DIRECT', effectiveDate: w.today(), intent: await f.intent(f.l, bank, '1000.00') })).execute());
    const pp = await go('P', 'pagos'); await pp.getByRole('button', { name: /UI7-PEND/ }).click(); await pp.getByRole('button', { name: 'Pedir el plan de aprobación', exact: true }).click(); await idle(pp);
    const planAlert = (await pp.getByRole('alert').count()) ? await pp.getByRole('alert').first().innerText() : '';
    await pp.getByRole('checkbox', { name: /Confirmo este plan/ }).check(); const ap = pp.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/approve') && r.status() !== 403);
    await pp.getByRole('button', { name: 'Confirmar la aprobación', exact: true }).click(); await stepUp(pp, P); const apr = await ap; await idle(pp);
    o['H01 in UI'] = { pending: w.st(pend), interveningDirect: w.st(direct), alertBeforeApprove: planAlert.slice(0, 160), approve: apr.status(), status: ((await f.readPayment(String(pend.data?.['entityId']))).data as { status: string }).status };
    // 6. 360px reflow, keyboard focus, logout clearing two tabs of T.
    tp = await go('T'); await tp.setViewportSize({ width: 360, height: 800 }); o['360px'] = await tp.evaluate(() => ({ width: innerWidth, docScroll: document.documentElement.scrollWidth, main: (document.querySelector('main')?.scrollWidth ?? 0) <= (document.querySelector('main')?.clientWidth ?? 0) + 1 }));
    await tp.screenshot({ path: resolve('../../Construccion/Sprints/S07/Evidencias/S07-P05-mobile.png'), fullPage: false }); await tp.setViewportSize({ width: 1280, height: 900 });
    await tp.getByLabel('Soporte', { exact: true }).focus(); await tp.keyboard.type('X'); o['keyboard focus kept'] = await tp.getByLabel('Soporte', { exact: true }).evaluate(e => e === document.activeElement);
    await tp.screenshot({ path: resolve('../../Construccion/Sprints/S07/Evidencias/S07-P05-VISUAL.png'), fullPage: false });
    const t2p = await ctxs['T']!.newPage(); await t2p.clock.setFixedTime(new Date(f.now())); await t2p.goto(origin + '/#/cobranza'); await t2p.getByRole('heading', { name: 'Cobranza y caja', exact: true }).waitFor();
    await tp.getByRole('button', { name: /Salir|Cerrar sesión/ }).first().click(); await tp.waitForURL('**/#/ingresar*');
    o['logout two tabs'] = { storageKeys: await tp.evaluate(() => Object.keys(sessionStorage).filter(k => k.includes('caudelyx'))), draftsLeft: await tp.evaluate(() => Object.keys(sessionStorage).filter(k => k.includes('draft')).length), otherTab: await (async () => { try { await t2p.waitForURL('**/#/ingresar*'); return true; } catch { return false; } })() };
    evidence('P07-UI', { observed: o });
    for (const k of ['positions at discrepancy', 'positions after confirm']) { const v = o[k] as { C: { server: unknown; oracle: unknown }; O: { server: unknown; oracle: unknown } }; assert.deepEqual(v.C.server, v.C.oracle, k + ' C'); assert.deepEqual(v.O.server, v.O.oracle, k + ' O'); }
    const cf = o['confirm'] as { status: number; journalsAdded: number; server: unknown; oracle: unknown }; assert.deepEqual([cf.status, cf.journalsAdded], [201, 1]); assert.deepEqual(cf.server, cf.oracle);
    assert.deepEqual([(o['H01 in UI'] as { approve: number }).approve, (o['H01 in UI'] as { status: string }).status], [201, 'CONFIRMED']);
    assert.equal((o['360px'] as { docScroll: number }).docScroll <= 360, true); assert.equal((o['logout two tabs'] as { otherTab: boolean }).otherTab, true); assert.equal((o['logout two tabs'] as { draftsLeft: number }).draftsLeft, 0);
  } finally { evidence('P07-UI-partial', { observed: o }); await browser?.close(); await group.dispose(); }
});
