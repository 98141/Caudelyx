// S04-P05 independent component review (Claude) of the S04-P04 lending screens. API is mocked at the module boundary;
// server amounts are deliberately INCONSISTENT sentinels so any client-side recomputation would show. Spanish UI only.
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { LoansScreen } from '../../../src/features/lending/Loans';
import { BorrowersScreen } from '../../../src/features/lending/Borrowers';
import { ApiError } from '../../../src/shared/contracts';
import { percentToRate, principalFromLocal } from '../../../src/features/lending/rate';

const api = vi.hoisted(() => ({ call: vi.fn(), reauthenticate: vi.fn() }));
vi.mock('../../../src/shared/api', () => api);
vi.mock('../../../src/shared/auth', () => ({ useAuth: () => ({ me: { authState: 'ACTIVE', organizationId: 'org', userId: 'actor' } }) }));
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const person = (n: number) => ({ id: id(n), borrowerCode: `P05_${String(n).padStart(3, '0')}`, status: 'ACTIVE', version: 1, profileVersion: 1, possibleDuplicate: false, duplicateCandidates: [], profile: { displayName: `Persona sintética ${n}`, schemaVersion: 1, extras: {} } });
const policy = { policyVersion: 'S04-LOCAL-CO-0.1', jurisdiction: 'CO', usage: 'LOCAL_SYNTHETIC', methods: ['CONSTANT_PRINCIPAL', 'LEVEL_PAYMENT', 'INTEREST_ONLY'], frequencies: ['DAY', 'WEEK', 'FIFTEEN_DAYS', 'SEMIMONTH', 'MONTH'], legalStatus: 'NOT_REVIEWED_FOR_REAL_USE', realUseAllowed: false, quoteTtlSeconds: 900 };
// Sentinel: totals do NOT equal the row sums on purpose (server is the only truth; UI must not "fix" it).
const quote = { id: id(900), fingerprint: 'ab'.repeat(32), expiresAt: '2199-01-01T00:00:00Z', periodicRate24: '0.010000000000000000000000', basePayment: null, finalPaymentAdjustment: '0.00',
  policyVersion: 'S04-LOCAL-CO-0.1', mathVersion: 'CALCULATION-S04-0.1', calendarVersion: 'S04-CALENDAR-0.1', totals: { principal: '1000.50', interest: '7.77', payment: '1008.27' },
  schedule: [{ k: 1, date: '2024-02-29', openingPrincipal: '1000.50', principal: '500.25', interest: '1.11', payment: '501.36', closingPrincipal: '500.25' }, { k: 2, date: '2024-03-31', openingPrincipal: '500.25', principal: '500.25', interest: '2.22', payment: '502.47', closingPrincipal: '0.00' }] };
const loan = (status = 'DRAFT', termsVersion = 1) => ({ id: id(700), status, version: 1, termsVersion, borrowerId: id(21), quoteId: quote.id, quoteFingerprint: quote.fingerprint });
let calls: { method: string; path: string; payload?: unknown }[] = [];
let failSave: ApiError | null = null;
const page1 = Array.from({ length: 20 }, (_, k) => person(k + 1)), page2 = [person(21), person(22)];
beforeEach(() => {
  vi.clearAllMocks(); calls = []; failSave = null;
  api.reauthenticate.mockResolvedValue({ data: {} });
  api.call.mockImplementation(async (method: string, path: string, payload?: unknown) => {
    calls.push({ method, path, payload });
    if (path.endsWith('/lending-policy')) return { data: policy, etag: null };
    if (path.includes('/borrowers?') && path.includes('cursor=')) return { data: { items: page2, nextCursor: null }, etag: null };
    if (path.includes('/borrowers?')) return { data: { items: page1, nextCursor: 'page-2' }, etag: null };
    if (/\/borrowers\/[0-9a-f-]{36}$/.test(path)) { const n = Number(path.slice(-3)); return { data: person(n), etag: '"b:1"' }; }
    if (path.includes('/financial/accounts?')) return { data: { items: [{ id: id(500), code: 'CASH_P05', name: 'Caja sintética P05', status: 'ACTIVE', accountClass: 'ASSET', kind: 'CASH', currency: 'COP', version: 1 }], nextCursor: null }, etag: null };
    if (path.endsWith(`/financial/accounts/${id(500)}`)) return { data: { id: id(500), code: 'CASH_P05', name: 'Caja sintética P05' }, etag: '"a:1"' };
    if (path.includes('/loans?')) return { data: { items: [loan(), { ...loan('TERMS_CONFIRMED', 2), id: id(701), borrowerId: id(2) }], nextCursor: null }, etag: null };
    if (method === 'POST' && path.endsWith('/loan-quotes')) { await new Promise(r => setTimeout(r, 30)); return { data: quote, etag: null }; }
    if (method === 'POST' && path.endsWith('/loans')) { await new Promise(r => setTimeout(r, 30)); if (failSave) throw failSave; return { data: loan(), etag: '"l:1"' }; }
    if (path.includes('/loans/') && path.includes('/versions')) return { data: { items: [], nextCursor: null }, etag: null };
    if (path.endsWith('/borrower-field-schemas/current')) return { data: { schemaVersion: 1, fields: [] }, etag: '"org:1"' };
    throw new Error('Unexpected request ' + method + ' ' + path);
  });
});
async function fill(user: ReturnType<typeof userEvent.setup>, o: { rate?: string; principal?: string } = {}) {
  await screen.findByRole('option', { name: 'P05_001 · Persona sintética 1' });
  await user.click(screen.getByRole('button', { name: 'Más prestatarios' }));
  await screen.findByRole('option', { name: 'P05_021 · Persona sintética 21' });
  await user.selectOptions(screen.getByLabelText('Prestatario'), id(21));
  await user.click(await screen.findByRole('button', { name: 'Elegir CASH_P05 para Cuenta prevista de desembolso' }));
  await user.type(screen.getByLabelText('Capital'), o.principal ?? '1.000,50');
  await user.selectOptions(screen.getByLabelText('Modalidad'), 'CONSTANT_PRINCIPAL');
  await user.selectOptions(screen.getByLabelText('Frecuencia de la cuota'), 'MONTH');
  await user.selectOptions(screen.getByLabelText('Clase de tasa'), 'EFFECTIVE');
  await user.selectOptions(screen.getByLabelText('Unidad de la tasa'), 'MONTH');
  if (o.rate !== '') await user.type(screen.getByLabelText('Tasa en porcentaje'), o.rate ?? '1,5');
  fireEvent.change(screen.getByLabelText('Fecha de inicio'), { target: { value: '2024-01-31' } });
  fireEvent.change(screen.getByLabelText('Fecha de la primera cuota'), { target: { value: '2024-02-29' } });
  await user.type(screen.getByLabelText('Número de cuotas'), '2');
}
const evidence = (name: string, data: unknown) => console.log(JSON.stringify({ evidence: name, ...(data as object) }));

it('P05-S4-UI1 exact es-CO wire values, server totals shown verbatim (no client math), no default when a condition is missing', async () => {
  render(<LoansScreen />); const user = userEvent.setup();
  await fill(user, { rate: '' });
  await user.click(screen.getByRole('button', { name: 'Ver cronograma' }));
  await new Promise(r => setTimeout(r, 100));
  const blockedBy = screen.queryByText(/Faltan condiciones o el formato no es válido/) ? 'client message' : (screen.getByLabelText('Tasa en porcentaje') as HTMLInputElement).validity.valueMissing ? 'native required constraint' : 'unknown';
  expect(calls.filter(c => c.path.endsWith('/loan-quotes')).length).toBe(0);
  await user.type(screen.getByLabelText('Tasa en porcentaje'), '1,5');
  const go = screen.getByRole('button', { name: 'Ver cronograma' }); await user.dblClick(go);
  const section = await screen.findByRole('region', { name: 'Cronograma simulado' });
  const posts = calls.filter(c => c.method === 'POST' && c.path.endsWith('/loan-quotes'));
  const terms = (posts[0]!.payload as { terms: Record<string, unknown> }).terms;
  expect(terms['principal']).toBe('1000.50'); expect(terms['rate']).toEqual({ type: 'EFFECTIVE', value: '0.015000000000', unit: 'MONTH' }); expect(terms['installmentCount']).toBe(2);
  expect(terms['calendarConvention']).toBe('PERIODIC_FIXED'); expect(terms['holidayAdjustment']).toBe('NO_SHIFT'); expect(terms).not.toHaveProperty('usage', 'REAL');
  expect(within(section).getByText('Capital 1.000,50 COP. Interés 7,77 COP. Cuotas 1.008,27 COP.')).toBeTruthy(); // server sentinel, not 3,33
  expect(within(section).getAllByText('500,25 COP').length).toBeGreaterThan(0);
  expect(section.textContent).not.toMatch(UUID);
  evidence('P05-S4-UI1', { missingRateBlockedBy: blockedBy, quotePostsAfterDoubleClick: posts.length, wire: { principal: terms['principal'], rate: terms['rate'] }, serverTotalsShown: 'Interés 7,77 COP (sentinel, rows sum 3,33)' });
  expect(posts.length).toBeLessThanOrEqual(2);
  if (posts.length === 2) expect(posts[0]!.payload).toEqual(posts[1]!.payload);
});

it('P05-S4-UI2 save: one R + one command on double click; confirmation never pre-checked and reset by any edit; stale 409 shows Spanish copy without retry', async () => {
  render(<LoansScreen />); const user = userEvent.setup();
  await fill(user); await user.click(screen.getByRole('button', { name: 'Ver cronograma' }));
  await screen.findByRole('region', { name: 'Cronograma simulado' });
  const save = within(screen.getByRole('group', { name: 'Guardar los términos de esta simulación' }));
  await user.type(save.getByLabelText('Contraseña actual'), 'Frase sintetica de prueba P05');
  await user.type(save.getByLabelText('Código TOTP vigente'), '123456');
  await user.dblClick(screen.getByRole('button', { name: 'Guardar borrador de términos' }));
  const confirmBox = await screen.findByRole('checkbox', { name: /Confirmo estos términos/ });
  const drafts = calls.filter(c => c.method === 'POST' && c.path.endsWith('/loans'));
  expect(drafts.length).toBe(1); expect(api.reauthenticate).toHaveBeenCalledTimes(1);
  expect(api.reauthenticate.mock.calls[0]![0]).toMatchObject({ purpose: 'LOAN_DRAFT_CREATE', command: { payload: { quoteId: quote.id, quoteFingerprint: quote.fingerprint } } });
  expect((confirmBox as HTMLInputElement).checked).toBe(false);
  expect(screen.getByRole('button', { name: 'Confirmar términos' })).toBeDisabled();
  await user.click(confirmBox); expect(screen.getByRole('button', { name: 'Confirmar términos' })).toBeEnabled();
  // Any condition edit invalidates the simulation and the consent.
  await user.type(screen.getByLabelText('Número de cuotas'), '0');
  expect(screen.queryByRole('checkbox', { name: /Confirmo estos términos/ })).toBeNull();
  expect(await screen.findByText('La simulación anterior quedó obsoleta. Pide el cronograma otra vez.')).toBeTruthy();
  evidence('P05-S4-UI2', { draftPosts: drafts.length, reauth: api.reauthenticate.mock.calls.length, checkboxDefault: false, resetOnEdit: true });
});

it('P05-S4-UI3 QUOTE_STALE on save: Spanish actionable message, simulation discarded, exactly one command (no automatic retry/confirmation)', async () => {
  render(<LoansScreen />); const user = userEvent.setup();
  failSave = new ApiError(409, 'QUOTE_STALE', null, 'La simulación ya no corresponde a los datos actuales. Vuelve a pedir el cronograma. No se guardó.');
  await fill(user); await user.click(screen.getByRole('button', { name: 'Ver cronograma' }));
  await screen.findByRole('region', { name: 'Cronograma simulado' });
  const save = within(screen.getByRole('group', { name: 'Guardar los términos de esta simulación' }));
  await user.type(save.getByLabelText('Contraseña actual'), 'Frase sintetica de prueba P05'); await user.type(save.getByLabelText('Código TOTP vigente'), '123456');
  await user.click(screen.getByRole('button', { name: 'Guardar borrador de términos' }));
  expect(await screen.findByText('La simulación ya no corresponde a los datos actuales. Vuelve a pedir el cronograma. No se guardó.')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Cronograma simulado' })).toBeNull();
  expect(calls.filter(c => c.method === 'POST' && c.path.endsWith('/loans')).length).toBe(1);
  expect(calls.some(c => c.path.includes('/confirmation'))).toBe(false);
});

it('P05-S4-UI4 H04 labels: borrower chosen on page 2 stays selected with code · name; account shown as code · name; saved-loans list content characterized', async () => {
  render(<LoansScreen />); const user = userEvent.setup();
  await fill(user);
  expect((screen.getByLabelText('Prestatario') as HTMLSelectElement).value).toBe(id(21));
  expect(screen.getAllByText('P05_021 · Persona sintética 21').length).toBeGreaterThan(0);
  expect((await screen.findAllByText('CASH_P05 · Caja sintética P05')).length).toBeGreaterThan(0);
  const list = screen.getByRole('heading', { name: 'Términos guardados' }).parentElement!;
  const items = within(list).getAllByRole('button').filter(b => /versión/.test(b.textContent ?? '')).map(b => b.textContent);
  const bodyText = document.body.textContent ?? '';
  const where = [...document.querySelectorAll('body *')].filter(e => e.children.length === 0 && UUID.test(e.textContent ?? '')).map(e => `${e.tagName.toLowerCase()}: ${(e.textContent ?? '').replace(UUID, '<uuid>').slice(0, 80)}`);
  evidence('P05-S4-UI4', { savedLoanButtons: items, borrowerNamedInSavedList: items.some(t => /P05_|Persona/.test(t ?? '')), uuidVisible: UUID.test(bodyText), uuidShownIn: where });
  // H04: a UUID may only appear as the secondary technical detail of the selected account card, never as main text.
  expect(where.every(w => w.startsWith('p: Identificador <uuid>.'))).toBe(true);
  expect(screen.getByText(/Identificador/).className).toContain('muted');
});

it('P05-S4-UI5 borrowers: duplicate/homonym candidates as code · name, Spanish conflict text, no raw ids', async () => {
  api.call.mockImplementation(async (method: string, path: string) => {
    calls.push({ method, path });
    if (path.endsWith('/borrower-field-schemas/current')) return { data: { schemaVersion: 1, fields: [] }, etag: '"org:1"' };
    if (path.includes('/borrowers?')) return { data: { items: [{ ...person(1), possibleDuplicate: true, duplicateCandidates: [{ id: id(2), borrowerCode: 'P05_002', displayName: 'Persona sintética 1' }] }], nextCursor: null }, etag: null };
    if (/\/borrowers\/[0-9a-f-]{36}$/.test(path)) return { data: { ...person(1), possibleDuplicate: true, duplicateCandidates: [{ id: id(2), borrowerCode: 'P05_002', displayName: 'Persona sintética 1' }] }, etag: '"b:1"' };
    if (path.includes('/versions')) return { data: { items: [], nextCursor: null }, etag: null };
    if (method === 'POST' && path.endsWith('/borrowers')) throw new ApiError(409, 'BORROWER_CODE_CONFLICT', null, 'Ese código ya existe en esta organización. No se creó otra ficha.');
    throw new Error('Unexpected request ' + method + ' ' + path);
  });
  render(<BorrowersScreen />); const user = userEvent.setup();
  const open = await screen.findByRole('button', { name: /P05_001 · Persona sintética 1/ }); await user.click(open);
  expect((await screen.findAllByText(/P05_002 · Persona sintética 1/)).length).toBeGreaterThan(0);
  expect(document.body.textContent ?? '').not.toMatch(UUID);
});

it('P05-S4-UI6 rate/principal parsing is exact and never rounds (counterexamples)', () => {
  const r = { '1': percentToRate('1'), '12,5': percentToRate('12,5'), '0': percentToRate('0'), '100': percentToRate('100'), '0,0000000001': percentToRate('0,0000000001'),
    '0,00000000001 (11 dec)': percentToRate('0,00000000001'), '100,1': percentToRate('100,1'), '-1': percentToRate('-1'), '1e2': percentToRate('1e2'), '1.5': percentToRate('1.5') };
  const p = { '1.000,50': principalFromLocal('1.000,50'), '0,01': principalFromLocal('0,01'), '0,001': principalFromLocal('0,001'), '1.000.000.000.000': principalFromLocal('1.000.000.000.000'), '1.000.000.000.000,01': principalFromLocal('1.000.000.000.000,01'), '-5': principalFromLocal('-5'), '0': principalFromLocal('0') };
  expect(r['1']).toBe('0.010000000000'); expect(r['12,5']).toBe('0.125000000000'); expect(r['0']).toBe('0.000000000000'); expect(r['100']).toBe('1.000000000000'); expect(r['0,0000000001']).toBe('0.000000000001');
  expect(r['0,00000000001 (11 dec)']).toBeNull(); expect(r['100,1']).toBeNull(); expect(r['-1']).toBeNull(); expect(r['1e2']).toBeNull();
  expect(p['1.000,50']).toBe('1000.50'); expect(p['0,01']).toBe('0.01'); expect(p['0,001']).toBeNull(); expect(p['1.000.000.000.000']).toBe('1000000000000.00'); expect(p['1.000.000.000.000,01']).toBeNull(); expect(p['-5']).toBeNull(); expect(p['0']).toBeNull();
  evidence('P05-S4-UI6', { rate: r, principal: p });
});
