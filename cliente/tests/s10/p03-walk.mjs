import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { p03Profile } from './p03-profile.mjs';

const started = Date.now();
const evidence = fileURLToPath(new URL('../../../../Construccion/Sprints/S10/Evidencias/', import.meta.url));
const dist = fileURLToPath(new URL('../../../../Caudelyx/servidor/dist-s10-backend/', import.meta.url));
const date = '2026-10-29';
const steps = [];
await mkdir(evidence, { recursive: true });
const group = await p03Profile();
let browser;
try {
  const f = await group.fixture();
  f.clock.value = Date.parse('2026-10-29T12:00:00-05:00');
  steps.push({ step: 'group-ready', at: new Date().toISOString(), groupId: group.groupId });
  const a = await f.actor();
  const org = (await f.runtime.organizations.create(a.issued.context, { name: 'Organización sintética S10', currency: 'COP', timezone: 'America/Bogota' }, randomUUID())).data.organization.id;
  const account = async (code, accountClass, kind) => (await f.runtime.finance.mutate(a.issued.context, 'createAccount', org, { code, name: 'Cuenta sintética ' + code, currency: 'COP', accountClass, kind }, randomUUID())).data;
  const bank = await account('BANK_S10', 'ASSET', 'BANK');
  const equity = await account('EQUITY_S10', 'EQUITY', 'GENERAL');
  const post = async (lines, description) => {
    const capital = { currency: 'COP', effectiveDate: date, sourceId: randomUUID(), supportReference: 'SYN-S10', description, lines };
    const key = randomUUID();
    await f.proof(a, 'FINANCE_JOURNAL_POST', { organizationId: org, idempotencyKey: key, payload: capital });
    await f.runtime.finance.mutate(a.issued.context, 'postJournal', org, capital, key);
  };
  await post([{ accountId: bank.id, debit: '20000000.00', credit: '0.00' }, { accountId: equity.id, debit: '0.00', credit: '20000000.00' }], 'Capital sintético S10');
  await f.restore.flush();
  const owner = async () => {
    const { readFile } = await import('node:fs/promises');
    const o = JSON.parse(await readFile(join(group.folder, 'owner.json'), 'utf8'));
    return o.pid === process.pid && o.runId === group.runId && o.names[0] === f.database.db.databaseName;
  };
  const { ProjectionRuntime } = await import(new URL('src/modules/reporting/projection/service.js', 'file:///' + dist.replaceAll('\\', '/')));
  const { wealthContract } = await import(new URL('src/modules/wealth/contract.js', 'file:///' + dist.replaceAll('\\', '/')));
  await f.runtime.obligations.prepareOwned(owner);
  await f.runtime.wealth.prepareOwned(owner);
  f.identity.reporting.projection = await ProjectionRuntime.createOwned(f.identity, f.keys.cursor, owner);
  await f.runtime.obligations.activateOwned(owner);
  const params = { organizationId: org };
  const wealth = f.runtime.wealth;
  const mutate = async (operation, payload, path = params, expected) => {
    const key = randomUUID();
    const purpose = wealthContract().operations.get(operation).definition['x-purpose'];
    const command = { operationId: operation, idempotencyKey: key, organizationId: org, pathParameters: path, payload, ...(expected ? { expectedETag: expected } : {}) };
    await f.proof(a, purpose, command, path.assetId ?? path.fundId);
    return await wealth.mutate(a.issued.context, operation, payload, path, key, expected);
  };
  const read = (operation, path = params, query = { asOf: date }) => wealth.read(a.issued.context, operation, path, query);
  const assetAccount = await account('ASSET_S10', 'ASSET', 'GENERAL');
  const debtAccount = await account('DEBT_S10', 'LIABILITY', 'GENERAL');
  const income = await account('RENT_S10', 'INCOME', 'GENERAL');
  const fund = await mutate('businessCreateFund', { mode: 'VIRTUAL', label: 'Ahorro protegido', purpose: 'ASSET_PURCHASE', backingAccountId: bank.id, supportReference: 'SYN' });
  const fundId = String(fund.data.id);
  const tag = async () => String((await read('businessGetWealthBook')).etag);
  await mutate('businessAllocateFund', { bookETag: await tag(), effectiveDate: date, amount: '20000000.00', supportReference: 'SYN' }, { ...params, fundId }, fund.etag);
  steps.push({ step: 'seed-reserve', organizationId: org, fundId });
  const https = await f.https();
  const origin = 'https://localhost:' + https.port;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: '__Host-caudelyx-session', value: a.issued.token, url: origin + '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  await page.goto(origin + '/#/patrimonio', { waitUntil: 'networkidle' });
  await page.getByRole('textbox', { name: 'Cuenta', exact: true }).fill(bank.id);
  await page.getByRole('button', { name: 'Consultar disponible' }).click();
  await page.locator('article').filter({ hasText: 'Reservado en fondos' }).getByText('20.000.000 COP').waitFor({ timeout: 20000 });
  await page.locator('article').filter({ hasText: 'Libre' }).getByText('0 COP').waitFor({ timeout: 5000 });
  steps.push({ step: 'availability-shown' });
  await page.getByRole('textbox', { name: 'Nombre', exact: true }).fill('Ahorro de pantalla');
  await page.getByLabel('Cuenta de respaldo').fill(bank.id);
  await page.getByRole('textbox', { name: 'Soporte', exact: true }).fill('SYN-UI');
  await page.getByRole('button', { name: 'Registrar fondo' }).click();
  await page.getByText('Fondo virtual registrado.').waitFor({ timeout: 20000 });
  steps.push({ step: 'ui-fund-created' });
  await post([{ accountId: bank.id, debit: '60000000.00', credit: '0.00' }, { accountId: equity.id, debit: '0.00', credit: '60000000.00' }], 'Capital adicional sintético');
  const draft = await mutate('businessCreateAssetDraft', { assetClass: 'APARTMENT', otherClassDescription: null, label: 'Apartamento sintético', origin: 'PURCHASE', legalOwnerReference: 'SYN-OWNER', ownershipPercentage: '100.00', grossCostDeclared: '200000000.00', assetAccountId: assetAccount.id, supportReferences: ['SYN'], locationGeneral: null });
  const assetId = String(draft.data.id);
  const rate = { kind: 'NONE_DECLARED', source: 'SYNTHETIC_DECLARED', sourceReference: 'SYN-ZERO-DECLARED', validFrom: '2026-10-01', observedOn: '2026-10-01', unit: 'ANNUAL_FRACTION', convention: 'ANNUAL_SIMPLE_ACT_365', decimalValue: '0.00', combine: 'NONE' };
  const principal = '120000000.00';
  const definition = { kind: 'BANK_LOAN', label: 'Crédito directo sintético', counterpartyReference: 'SYN-LENDER', principal, rate, schedule: { kind: 'OFFICIAL_DECLARED', validFrom: date, referenceDate: '2026-09-29', sourceReference: 'SYN-OFFICIAL', principalOpening: principal, rateVersionIds: [], installments: [{ number: 1, dueDate: date, principal, interest: '0.00', insurance: '0.00', fees: '0.00', total: principal }] }, prepaymentPermissions: [], supportReference: 'SYN' };
  const assetPath = { ...params, assetId };
  await mutate('businessAcquireAsset', { bookETag: await tag(), effectiveDate: date, ownedConsideration: '200000000.00', capitalizedCosts: [], funding: [{ nature: 'RELEASED_SAVINGS', settlementMode: 'CONSUME_RESERVATION', fundId, accountId: bank.id, amount: '20000000.00', provenanceKind: 'DECLARED', reference: 'SYN' }, { nature: 'EXISTING_CASH', settlementMode: 'FROM_ACCOUNT', accountId: bank.id, sourceJournalId: null, amount: '60000000.00', provenanceKind: 'UNKNOWN', reference: 'SYN-UNKNOWN' }, { nature: 'DIRECT_NEW_DEBT', settlementMode: 'DIRECT_SELLER', principalAccountId: debtAccount.id, liabilityDefinition: definition, amount: principal, provenanceKind: 'SUPPORTED_REFERENCE', reference: 'SYN' }], supportReference: 'SYN' }, assetPath, draft.etag);
  await mutate('businessRecordAssetValuation', { valuationDate: date, grossEstimatedValue: '220000000.00', method: 'OWNER_ESTIMATE', sourceReference: 'SYN', supportReference: 'SYN' }, assetPath, (await read('businessGetAsset', assetPath)).etag);
  await mutate('businessReceiveAssetRent', { bookETag: await tag(), effectiveDate: date, amount: '1000000.00', cashAccountId: bank.id, incomeAccountId: income.id, supportReference: 'SYN' }, assetPath, (await read('businessGetAsset', assetPath)).etag);
  steps.push({ step: 'seed-asset-rent' });
  await page.getByRole('button', { name: 'Ver activos' }).click();
  await page.getByText('Apartamento sintético').waitFor({ timeout: 20000 });
  await page.getByText('Fuentes incompletas.').waitFor({ timeout: 5000 });
  await page.getByText(/No es rentabilidad realizada/).waitFor({ timeout: 5000 });
  steps.push({ step: 'asset-shown' });
  await page.getByRole('button', { name: 'Ver posición' }).click();
  await page.locator('article').filter({ hasText: 'Costo reconocido' }).getByText('200.000.000 COP').waitFor({ timeout: 20000 });
  await page.locator('article').filter({ hasText: 'Estimado de la porción' }).getByText('220.000.000 COP').waitFor({ timeout: 5000 });
  await page.locator('article').filter({ hasText: 'Rentas cobradas' }).getByText('1.000.000 COP').waitFor({ timeout: 5000 });
  steps.push({ step: 'position-shown' });
  const other = await f.actor();
  const otherContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  await otherContext.addCookies([{ name: '__Host-caudelyx-session', value: other.issued.token, url: origin + '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  const otherPage = await otherContext.newPage();
  await otherPage.goto(origin + '/#/patrimonio', { waitUntil: 'networkidle' });
  await otherPage.getByText(/no está en tu rol/).waitFor({ timeout: 20000 });
  const foreign = await otherPage.locator('body').innerText();
  if (foreign.includes('200.000.000') || foreign.includes('Apartamento sintético')) throw new Error('Otro actor vio el activo del negocio.');
  steps.push({ step: 'other-owner-hidden' });
  const expand = () => page.evaluate(() => {
    for (const el of [document.documentElement, document.body, document.querySelector('#root'), document.querySelector('.app-shell'), document.querySelector('.app-body'), document.querySelector('main')]) {
      if (!el) continue;
      el.style.height = 'auto';
      el.style.maxHeight = 'none';
      el.style.overflow = 'visible';
    }
  });
  await expand();
  await page.screenshot({ path: join(evidence, 'S10-P03-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expand();
  await page.screenshot({ path: join(evidence, 'S10-P03-mobile.png'), fullPage: true });
  steps.push({ step: 'screenshots', nativeZoom: 'not-available', viewportMobile: 390 });
  await writeFile(join(evidence, 'S10-P03-WALK.json'), JSON.stringify({ status: 'PASS', organizationId: org, https: https.port, durationMs: Date.now() - started, groupId: group.groupId, runId: group.runId, steps }, null, 2));
} catch (error) {
  const page = browser ? browser.contexts()[0]?.pages()[0] : undefined;
  if (page) {
    await page.screenshot({ path: join(evidence, 'S10-P03-failure.png'), fullPage: true }).catch(() => {});
    steps.push({ step: 'failed-text', text: (await page.locator('body').innerText().catch(() => '')).slice(0, 1500) });
  }
  steps.push({ step: 'failed', reason: String(error).slice(0, 800) });
  await writeFile(join(evidence, 'S10-P03-WALK.json'), JSON.stringify({ status: 'FAIL', durationMs: Date.now() - started, groupId: group.groupId, steps }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await group.dispose();
}
