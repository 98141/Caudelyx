/* eslint-disable security/detect-object-injection -- Own synthetic labels and own digit string indexing only. */
// S10-P05 own browser journey (Claude) on the integrated candidate UI (cliente/dist-s10-p04, read-only) served by the real HTTPS app of the
// reviewer group, Playwright Chromium 1228 (the author used the Chrome channel). Private wealth cards are compared with the API response of
// the same request and that response with the own raw-data oracle; the UI is not economic proof nor accessibility certification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { s10ReviewProfile } from './review-profile.js';
import { world, evidence, idOf, rate, official, type World } from './review-fixtures.js';
import { totals, show } from './oracle.js';
import type { Data } from '../../src/modules/obligations/models.js';

type Resp = { url(): string; status(): number; json(): Promise<Record<string, unknown>>; request(): { method(): string } };
type Loc = { click(): Promise<void>; waitFor(o?: Record<string, unknown>): Promise<void>; innerText(): Promise<string>; focus(): Promise<void>; isDisabled(): Promise<boolean> };
type Page = { goto(u: string, o?: Record<string, unknown>): Promise<unknown>; getByRole(r: string, o?: Record<string, unknown>): Loc; locator(s: string): Loc; waitForResponse(f: (r: Resp) => boolean, o?: Record<string, unknown>): Promise<Resp>; evaluate<T>(f: () => T): Promise<T>; screenshot(o: Record<string, unknown>): Promise<unknown>; title(): Promise<string>; keyboard: { press(k: string): Promise<void> }; setDefaultTimeout(n: number): void; clock: { setFixedTime(d: Date): Promise<void> } };
type Ctx = { addCookies(c: unknown[]): Promise<void>; newPage(): Promise<Page>; close(): Promise<void> };
const EV = resolve('../../Construccion/Sprints/S10/Evidencias'), D = '2026-10-28';
const cop = (v: string) => { const neg = v.startsWith('-'), [w, d] = v.replace('-', '').split('.'); let g = ''; for (let i = 0; i < w!.length; i++) g += (i > 0 && (w!.length - i) % 3 === 0 ? '.' : '') + w![i]; return (neg ? '-' : '') + (d === '00' ? g : g + ',' + d) + ' COP'; };

test('S10-P05 navegador propio: patrimonio privado = API = oráculo, colaborador sin datos, móvil y teclado', { timeout: 1200000 }, async () => {
  const group = await s10ReviewProfile(), o: Record<string, unknown> = {}, fail: string[] = [];
  const expect = (at: string, got: unknown, want: unknown) => { const g = JSON.stringify(got), w = JSON.stringify(want); o['check ' + at] = g === w ? 'PASS' : { got, want }; if (g !== w) fail.push(`${at}: ${g} ≠ ${w}`); };
  const { chromium } = await import(pathToFileURL(resolve('../cliente/node_modules/playwright/index.mjs')).href) as { chromium: { launch(o: Record<string, unknown>): Promise<{ version(): string; newContext(o: Record<string, unknown>): Promise<Ctx>; close(): Promise<void> }> } };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const x: World = await world(group), P = { bookId: x.book.id };
    const ok = async (label: string, fn: () => Promise<{ status: number; data?: unknown; etag?: string }>) => { const r = await x.settle(fn); if (![200, 201].includes(r.status)) throw Error(`${label}: ${x.st(r)}`); return r; };
    const ptag = async () => String((await x.wealthRead('personalGetWealthBook', P)).etag), asset = async (id: string) => await x.wealthRead('personalGetAsset', { ...P, assetId: id });
    const wallet = (await x.personal('U_WALLET', 'ASSET', 'BANK')).id, cap = (await x.personal('U_CAP', 'EQUITY')).id, prop = (await x.personal('U_PROP', 'ASSET')).id, debt = (await x.personal('U_DEBT', 'LIABILITY')).id, inc = (await x.personal('U_RENT', 'INCOME')).id;
    await ok('aporte', async () => x.wealthMutate('personalRecordExternalFunds', { bookETag: await ptag(), effectiveDate: D, amount: '81000000.00', cashAccountId: wallet, provenanceKind: 'DECLARED', supportReference: 'SYN-R10-UI', nature: 'OWNER_CAPITAL_CONTRIBUTION', equityAccountId: cap, contributorReference: 'SYN-R10' }, P));
    const draft = async (label: string, gross: string) => idOf(await ok('borrador', () => x.wealthMutate('personalCreateAssetDraft', { assetClass: 'HOUSE', otherClassDescription: null, label, origin: 'PURCHASE', legalOwnerReference: 'SYN-R10', ownershipPercentage: '100.00', grossCostDeclared: gross, assetAccountId: prop, supportReferences: ['SYN-R10'], locationGeneral: null }, P)));
    const h = await draft('Casa UI revisión', '200000000.00');
    await ok('adquirir 200M', async () => x.wealthMutate('personalAcquireAsset', { bookETag: await ptag(), effectiveDate: D, ownedConsideration: '200000000.00', capitalizedCosts: [], funding: [{ nature: 'EXISTING_CASH', settlementMode: 'FROM_ACCOUNT', accountId: wallet, sourceJournalId: null, amount: '80000000.00', provenanceKind: 'DECLARED', reference: 'SYN' }, { nature: 'DIRECT_NEW_DEBT', settlementMode: 'DIRECT_SELLER', principalAccountId: debt, liabilityDefinition: { kind: 'BANK_LOAN', label: 'Hipoteca UI', counterpartyReference: 'SYN', principal: '120000000.00', rate, schedule: official('120000000.00', '2026-11-28'), prepaymentPermissions: [], supportReference: 'SYN' }, amount: '120000000.00', provenanceKind: 'SUPPORTED_REFERENCE', reference: 'SYN' }], supportReference: 'SYN-R10-UI' }, { ...P, assetId: h }, (await asset(h)).etag));
    await ok('estimar 220M', async () => x.wealthMutate('personalRecordAssetValuation', { valuationDate: D, grossEstimatedValue: '220000000.00', method: 'OWNER_ESTIMATE', sourceReference: 'SYN', supportReference: 'SYN' }, { ...P, assetId: h }, (await asset(h)).etag));
    await ok('renta 2M', async () => x.wealthMutate('personalReceiveAssetRent', { bookETag: await ptag(), effectiveDate: D, amount: '2000000.00', cashAccountId: wallet, incomeAccountId: inc, supportReference: 'SYN' }, { ...P, assetId: h }, (await asset(h)).etag));
    const u = await draft('Equipo UI sin estimado', '1000000.00');
    await ok('adquirir 1M sin estimado', async () => x.wealthMutate('personalAcquireAsset', { bookETag: await ptag(), effectiveDate: D, ownedConsideration: '1000000.00', capitalizedCosts: [], funding: [{ nature: 'EXISTING_CASH', settlementMode: 'FROM_ACCOUNT', accountId: wallet, sourceJournalId: null, amount: '1000000.00', provenanceKind: 'DECLARED', reference: 'SYN' }], supportReference: 'SYN' }, { ...P, assetId: u }, (await asset(u)).etag));
    const C = await x.member(['C']), mine = show(totals(await x.dump(), 'PERSONAL', x.book.id, D)); o['oráculo PERSONAL'] = mine;
    const https = await (x.https as unknown as (withClient: boolean) => Promise<{ port: number }>)(true), origin = 'https://localhost:' + https.port;
    browser = await chromium.launch({ executablePath: 'C:/Users/Asus ExpertBook/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe', headless: true }); o['browser'] = browser.version();
    const open = async (actor: typeof x.a, width = 1280) => { const ctx = await browser!.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 900 }, locale: 'es-CO' }); await ctx.addCookies([{ name: '__Host-caudelyx-session', value: actor.issued.token, url: origin + '/', secure: true, httpOnly: true, sameSite: 'Lax' }]); const page = await ctx.newPage(); page.setDefaultTimeout(20000); await page.clock.setFixedTime(new Date(x.now())); return { ctx, page }; };
    const text = async (page: Page) => await page.locator('body').innerText();
    const consolidated = async (page: Page) => { await page.goto(origin + '/#/patrimonio', { waitUntil: 'networkidle' }); await page.getByRole('heading', { name: 'Fondos y activos', exact: true }).waitFor(); await page.getByRole('button', { name: 'Personal', exact: true }).click();
      const r = page.waitForResponse(z => z.request().method() === 'GET' && new URL(z.url()).pathname.endsWith('/me/private-wealth')); await page.getByRole('button', { name: 'Ver consolidado privado', exact: true }).click(); const resp = await r; const body = await resp.json(); await page.getByRole('heading', { name: 'Consolidado privado', exact: true }).waitFor(); return { status: resp.status(), data: body['data'] as Data }; };
    // ---- T: private wealth cards = API = oracle
    const t = await open(x.a), cr = await consolidated(t.page), pw = cr.data, pers = pw['personal'] as Record<string, string | null>, tt = await text(t.page);
    o['API privateWealth'] = pw; o['título'] = await t.page.title();
    expect('API: activos brutos contables = oráculo; caja = oráculo', [cr.status, pw['ledgerGrossAssets'], pers['cashAvailable']], [200, mine.assets, mine.cash]);
    expect('API: costo 201M, rentas 2M, 1 activo sin estimado', [pers['recognizedAssetCost'], pers['rentCashReceived'], pers['unvaluedCount']], ['201000000.00', '2000000.00', 1]);
    const cards: [string, string | null][] = [['Costo reconocido', pers['recognizedAssetCost']!], ['Estimado de la porción', pers['ownedEstimatedValue'] ?? null], ['Deuda vinculada', pers['linkedPrincipal']!], ['Equidad indicativa', pers['indicativeEquity'] ?? null], ['Caja disponible', pers['cashAvailable']!], ['Rentas cobradas', pers['rentCashReceived']!]];
    const rendered = Object.fromEntries(await t.page.evaluate(() => [...document.querySelectorAll('.metric-card')].map(a => [a.querySelector('h3')?.textContent ?? '', a.querySelector('p')?.textContent ?? '']))) as Record<string, string>; o['UI tarjetas'] = rendered;
    const shown = cards.filter(([label, v]) => rendered[label] !== (v === null ? 'Sin dato del servidor' : cop(v))).map(([l]) => l);
    expect('UI tarjetas = API (incluido "Sin dato del servidor" si null)', shown, []); expect('UI activos brutos contables = API', tt.includes('Activos brutos contables: ' + cop(String(pw['ledgerGrossAssets'])) + '.'), true);
    expect('UI advierte activo sin estimado (no entra como cero)', tt.includes('1 activos sin estimado. No entran como cero.'), true);
    await t.page.screenshot({ path: resolve(EV, 'S10-P05-desktop.png'), fullPage: true });
    await t.page.getByRole('button', { name: 'Personal', exact: true }).focus(); await t.page.keyboard.press('Tab');
    const focused = await t.page.evaluate(() => (document.activeElement as HTMLElement | null)?.innerText ?? ''); o['teclado foco tras Personal'] = focused; expect('teclado: Tab mueve el foco a un control con nombre', focused.trim().length > 0, true);
    // ---- mobile 360
    const m = await open(x.a, 360); await consolidated(m.page); const dims = await m.page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]); o['móvil dims'] = dims;
    expect('móvil 360 sin scroll horizontal', dims[0]! <= dims[1]!, true); await m.page.screenshot({ path: resolve(EV, 'S10-P05-mobile.png'), fullPage: true });
    // ---- collaborator C
    const c = await open(C); await c.page.goto(origin + '/#/patrimonio', { waitUntil: 'networkidle' }); await c.page.getByRole('heading', { name: 'Fondos y activos', exact: true }).waitFor(); await c.page.getByRole('button', { name: 'Personal', exact: true }).click();
    const ct = await text(c.page), markers = [x.book.id, h, u, 'Casa UI revisión', cop('201000000.00'), cop('220000000.00')];
    expect('C no ve datos PERSONAL de T en la UI', markers.filter(mk => ct.includes(mk)), []); o['C posición deshabilitada'] = await c.page.getByRole('button', { name: 'Ver posición', exact: true }).isDisabled().catch(() => 'n/a');
    for (const s of [t, m, c]) await s.ctx.close();
    evidence('S10-BROWSER', { observed: o, failures: fail });
    assert.deepEqual(fail, [], 'browser mismatches');
    console.log('S10_P05_BROWSER_PASS');
  } catch (e) { evidence('S10-BROWSER-PARCIAL', { observed: o, failures: fail, error: String(e).slice(0, 500) }); throw e; } finally { await browser?.close(); await group.dispose(); }
});
