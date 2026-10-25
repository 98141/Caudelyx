// S05-P05-v2 independent component review (Claude) of the S5 Operations screen (H-S4-05 and the O5 client protocol).
// API mocked at the module boundary; server amounts are deliberate sentinels so any client recomputation would show.
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { OperationsScreen } from '../../../src/features/lending/Operations';
import { ApiError } from '../../../src/shared/contracts';
import { todayBogota } from '../../../src/shared/money';

const api = vi.hoisted(() => ({ call: vi.fn(), reauthenticate: vi.fn() }));
vi.mock('../../../src/shared/api', () => api);
vi.mock('../../../src/shared/auth', () => ({ useAuth: () => ({ me: { authState: 'ACTIVE', organizationId: 'org', userId: 'actor' } }) }));
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pos = (n: number, status: string, statusLabel: string, extra: Record<string, unknown> = {}) => ({ loanId: id(n), borrower: { id: id(100), code: 'P05_B1', name: 'Persona sintética uno' }, currency: 'COP', version: 1, termsVersion: 1, scheduleVersion: 1, termsStatus: 'TERMS_CONFIRMED', status, statusLabel,
  originalPrincipal: n === 1 ? '1000.00' : '2500.75', principalOutstanding: '650.00', duePrincipal: '0.00', originalExpectedInterest: '20.00', expectedFutureInterest: '13.00', dueUnrecognizedInterest: '0.00', accruedInterestTotal: '10.00', collectedInterestTotal: '10.00', accruedOutstandingInterest: '0.00', ...extra });
const accounts = [['BANK_S5', 'Banco S5', 'ASSET', 'BANK'], ['P_S5', 'Capital S5', 'ASSET', 'GENERAL'], ['I_S5', 'Interés por cobrar S5', 'ASSET', 'GENERAL'], ['Y_S5', 'Ingreso S5', 'INCOME', 'GENERAL'], ['C_S5', 'Saldo a favor S5', 'LIABILITY', 'GENERAL'], ['EQ_S5', 'Patrimonio S5', 'EQUITY', 'GENERAL']].map(([code, name, accountClass, kind], k) => ({ id: id(500 + k), code, name, accountClass, kind, status: 'ACTIVE', currency: 'COP', version: 1 }));
// Sentinel plan: allocations do not add up to the posted amounts on purpose (server is the only truth).
const plan = { postings: [{ accountId: id(500), debit: '333.33', credit: '0.00' }, { accountId: id(501), debit: '0.00', credit: '111.11' }], allocations: [{ loanId: id(1), installmentNumber: 1, component: 'INTEREST', amount: '7.77' }], accruals: [], positions: [], creditChange: null };
let calls: { method: string; path: string; payload?: unknown; options?: unknown }[] = [];
let commitFailure: ApiError | null = null;
beforeEach(() => {
  vi.clearAllMocks(); calls = []; commitFailure = null;
  api.reauthenticate.mockResolvedValue({ data: {} });
  api.call.mockImplementation(async (method: string, path: string, payload?: unknown, options?: unknown) => {
    calls.push({ method, path, payload, options });
    if (path.endsWith('/loan-operations/policy')) return { data: { version: 'S05-LOCAL-CO-0.1', usage: 'LOCAL_SYNTHETIC', realUseAllowed: false, currency: 'COP', previewTTLSeconds: 300 }, etag: null };
    if (path.includes('/loan-operations/positions?')) return { data: { items: [pos(1, 'ACTIVE', 'Activo'), pos(2, 'NOT_DISBURSED', 'Sin desembolso', { principalOutstanding: '0.00' }), pos(3, 'WEIRD', 'Raro')], nextCursor: null }, etag: null };
    if (/\/loan-operations\/positions\/[0-9a-f-]{36}$/.test(path)) { const n = Number(path.slice(-3)); return { data: n === 2 ? pos(2, 'NOT_DISBURSED', 'Sin desembolso') : pos(n, 'ACTIVE', 'Activo'), etag: `"${id(n)}:1"` }; }
    if (/\/loan-operations\/positions\/.*\/installments/.test(path)) return { data: { items: [{ loanId: id(1), number: 1, dueDate: '2026-10-31', principal: '250.00', interest: '10.00', payment: '260.00', principalPaid: '250.00', interestPaid: '10.00', status: 'PAID', dueState: 'OVERDUE' }], nextCursor: null }, etag: null };
    if (/\/loans\/[0-9a-f-]{36}$/.test(path)) return { data: { terms: { plannedFundingAccountId: id(500), principal: '1000.00' } }, etag: '"loan:2"' };
    if (path.endsWith('/loan-operations/book')) return { data: { organizationId: 'org', version: 3, profile: null, currency: 'COP' }, etag: '"org:ops:3"' };
    if (path.includes('/loan-operations/credits/')) return { data: { borrowerId: id(100), version: 0, balance: '0.00', currency: 'COP' }, etag: `"${id(100)}:0"` };
    if (path.includes('/financial/accounts?')) return { data: { items: accounts, nextCursor: null }, etag: null };
    const acc = accounts.find(a => path.endsWith('/financial/accounts/' + a.id)); if (acc) return { data: acc, etag: `"${acc.id}:1"` };
    if (method === 'POST' && path.endsWith('/loan-operation-previews')) return { data: { previewToken: 'tok', expiresAt: '2199-01-01T00:00:00Z', policyVersion: 'S05-LOCAL-CO-0.1', request: (payload as { request: unknown }).request, expectedBookETag: '"org:ops:3"', plan, realUseAllowed: false }, etag: null };
    if (method === 'POST' && /\/loan-operations\/(disbursements|receipts|accruals|credit-applications)$/.test(path)) { await new Promise(r => setTimeout(r, 20)); if (commitFailure) throw commitFailure; return { data: { event: {}, bookVersion: 4 }, etag: '"org:ops:4"' }; }
    if (path.includes('/loan-operations/commands/')) return { data: { event: {} }, etag: null };
    throw new Error('Unexpected request ' + method + ' ' + path);
  });
});
const evidence = (name: string, d: unknown) => console.log(JSON.stringify({ evidence: name, ...(d as object) }));

it('P05-S5-UI1 H05 list: person code · name · principal · Spanish state · version; unknown state named as such; UUID only in the collapsed correlation detail', async () => {
  render(<OperationsScreen />);
  const first = await screen.findByRole('button', { name: 'P05_B1 · Persona sintética uno · 1.000 COP · Activo · versión 1' });
  expect(screen.getByRole('button', { name: 'P05_B1 · Persona sintética uno · 2.500,75 COP · Sin desembolso · versión 1' })).toBeTruthy();
  expect(screen.getByRole('button', { name: /Estado no reconocido/ })).toBeTruthy();
  const leaks = [...document.querySelectorAll('body *')].filter(e => e.children.length === 0 && UUID.test(e.textContent ?? '')).map(e => (e.closest('details') ? 'details' : 'MAIN') + ':' + e.tagName);
  evidence('P05-S5-UI1', { firstItem: first.textContent, uuidLeaves: leaks });
  expect(leaks.every(l => l.startsWith('details'))).toBe(true);
});

it('P05-S5-UI2 eligible accounts only (GENERAL by class for the profile, CASH/BANK for receipts); server figures shown verbatim', async () => {
  render(<OperationsScreen />); const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /2\.500,75 COP · Sin desembolso/ }));
  await screen.findByText('Desembolso');
  const offered = screen.getAllByRole('button').map(b => b.textContent ?? '').filter(t => t.startsWith('Elegir'));
  expect(offered.some(t => /Elegir P_S5 para Cuenta de capital por cobrar/.test(t))).toBe(true);
  expect(offered.some(t => /Elegir EQ_S5|Elegir BANK_S5 para Cuenta de capital/.test(t))).toBe(false);
  expect(offered.some(t => /Elegir Y_S5 para Cuenta de ingreso por interés/.test(t))).toBe(true);
  expect(offered.some(t => /Elegir P_S5 para Cuenta de ingreso por interés/.test(t))).toBe(false);
  // Active position: receipt destination picker offers only CASH/BANK.
  await user.click(screen.getByRole('button', { name: /1\.000 COP · Activo/ }));
  await screen.findByText('Cobro');
  const dest = screen.getAllByRole('button').map(b => b.textContent ?? '').filter(t => t.includes('para Cuenta que recibe el cobro'));
  expect(dest).toEqual(['Elegir BANK_S5 para Cuenta que recibe el cobro']);
  const detail = screen.getByRole('region', { name: 'Detalle de la posición' });
  expect(within(detail).getByText('Capital pendiente 650 COP')).toBeTruthy();
  expect(within(detail).getByText('Interés futuro esperado 13 COP')).toBeTruthy();
  evidence('P05-S5-UI2', { profileButtons: offered.length, receiptDestinations: dest });
});

async function prepareReceipt(user: ReturnType<typeof userEvent.setup>) {
  render(<OperationsScreen />);
  await user.click(await screen.findByRole('button', { name: /1\.000 COP · Activo/ }));
  await screen.findByText('Cobro');
  fireEvent.change(screen.getByLabelText('Fecha contable'), { target: { value: todayBogota() } });
  await user.type(screen.getByLabelText('Referencia de soporte'), 'SYN-UI');
  await user.click(screen.getByRole('button', { name: 'Elegir BANK_S5 para Cuenta que recibe el cobro' }));
  await screen.findByText('La cuenta de cobro tiene versión para el plan.');
  await user.type(screen.getByLabelText('Importe recibido'), '1.000,50');
  await user.type(screen.getByLabelText('Importe para el préstamo 1'), '1.000,50');
  await user.type(screen.getByLabelText('Referencia del cobro'), 'REC-UI-1');
  await user.click(screen.getByRole('button', { name: 'Pedir el plan de cobro' }));
  return await screen.findByRole('region', { name: 'Plan del servidor' });
}

it('P05-S5-UI3 preview: exact wire intent, server plan verbatim with account labels, consent never pre-checked and reset by any edit', async () => {
  const user = userEvent.setup(); const planRegion = await prepareReceipt(user);
  const pv = calls.find(c => c.method === 'POST' && c.path.endsWith('/loan-operation-previews'))!.payload as { executionKey: string; expectedBookETag: string; request: Record<string, unknown> };
  expect(pv.expectedBookETag).toBe('"org:ops:3"'); expect(pv.request['receivedAmount']).toBe('1000.50'); expect(pv.request['kind']).toBe('RECEIPT'); expect(pv.request['excessDisposition']).toBe('REJECT');
  expect((pv.request['targets'] as { amount: string; positionETag: string }[])[0]).toMatchObject({ amount: '1000.50', positionETag: `"${id(1)}:1"`, mode: 'REGULAR' });
  expect(within(planRegion).getByText('Cuota 1: Interés 7,77 COP')).toBeTruthy();
  expect(await within(planRegion).findByText('BANK_S5 · Banco S5: débito 333,33 COP, crédito 0 COP')).toBeTruthy();
  const box = within(planRegion).getByRole('checkbox'); expect((box as HTMLInputElement).checked).toBe(false);
  expect(within(planRegion).getByRole('button', { name: 'Confirmar cobro' })).toBeDisabled();
  await user.click(box); expect(within(planRegion).getByRole('button', { name: 'Confirmar cobro' })).toBeEnabled();
  await user.type(screen.getByLabelText('Referencia del cobro'), 'X');
  expect(screen.queryByRole('region', { name: 'Plan del servidor' })).toBeNull();
  evidence('P05-S5-UI3', { wire: { receivedAmount: pv.request['receivedAmount'], target: (pv.request['targets'] as unknown[])[0] }, resetOnEdit: true });
});

it('P05-S5-UI4 commit: one R bound to the exact command and one POST on double click; same key/If-Match as the preview', async () => {
  const user = userEvent.setup(); const planRegion = await prepareReceipt(user);
  await user.click(within(planRegion).getByRole('checkbox'));
  const step = within(screen.getByRole('group', { name: 'Confirmar el comando' }));
  await user.type(step.getByLabelText('Contraseña actual'), 'Frase sintetica de prueba P05 S5'); await user.type(step.getByLabelText('Código TOTP vigente'), '123456');
  await user.dblClick(within(planRegion).getByRole('button', { name: 'Confirmar cobro' }));
  await screen.findByText('El servidor confirmó el comando. Esto no habilita un préstamo real.');
  const posts = calls.filter(c => c.method === 'POST' && c.path.endsWith('/loan-operations/receipts')), pv = calls.find(c => c.path.endsWith('/loan-operation-previews'))!.payload as { executionKey: string };
  expect(posts.length).toBe(1); expect(api.reauthenticate).toHaveBeenCalledTimes(1);
  expect(api.reauthenticate.mock.calls[0]![0]).toMatchObject({ purpose: 'LOAN_RECEIPT_POST', resourceId: id(100), command: { idempotencyKey: pv.executionKey, expectedETag: '"org:ops:3"', payload: { previewToken: 'tok' } } });
  expect(posts[0]!.options).toMatchObject({ idempotencyKey: pv.executionKey, ifMatch: '"org:ops:3"' });
  evidence('P05-S5-UI4', { posts: posts.length, reauth: api.reauthenticate.mock.calls.length });
});

it('P05-S5-UI5 uncertain response (network): same key and frozen body on retry, command lookup offered; 412 discards the plan', async () => {
  const user = userEvent.setup(); let planRegion = await prepareReceipt(user);
  commitFailure = new ApiError(0, 'OFFLINE', null, 'Sin conexión. No se guardó nada.');
  await user.click(within(planRegion).getByRole('checkbox'));
  const fill = async () => { const step = within(screen.getByRole('group', { name: 'Confirmar el comando' })); await user.type(step.getByLabelText('Contraseña actual'), 'Frase sintetica de prueba P05 S5'); await user.type(step.getByLabelText('Código TOTP vigente'), '123456'); };
  await fill(); await user.click(within(planRegion).getByRole('button', { name: 'Confirmar cobro' }));
  expect(await screen.findByText('La respuesta no confirmó el resultado. La misma clave se conserva. No se prepara otra.')).toBeTruthy();
  // Editing is refused while the command is uncertain (no new key/body).
  await user.type(screen.getByLabelText('Referencia del cobro'), 'Z');
  expect(await screen.findByText('La respuesta anterior no está confirmada. No se cambia la clave ni el cuerpo ya enviado.')).toBeTruthy();
  commitFailure = null; await fill();
  await user.click(screen.getByRole('button', { name: 'Reintentar el mismo comando' }));
  await screen.findByText('El servidor confirmó el comando. Esto no habilita un préstamo real.');
  const posts = calls.filter(c => c.method === 'POST' && c.path.endsWith('/loan-operations/receipts'));
  expect(posts.length).toBe(2); expect(JSON.stringify(posts[1]!.payload)).toBe(JSON.stringify(posts[0]!.payload)); expect((posts[1]!.options as { idempotencyKey: string }).idempotencyKey).toBe((posts[0]!.options as { idempotencyKey: string }).idempotencyKey);
  // 412: plan discarded, Spanish message, consent reset.
  planRegion = await (async () => { await user.clear(screen.getByLabelText('Importe recibido')); await user.type(screen.getByLabelText('Importe recibido'), '10,00'); await user.clear(screen.getByLabelText('Importe para el préstamo 1')); await user.type(screen.getByLabelText('Importe para el préstamo 1'), '10,00'); await user.clear(screen.getByLabelText('Referencia del cobro')); await user.type(screen.getByLabelText('Referencia del cobro'), 'REC-UI-2'); await user.click(screen.getByRole('button', { name: 'Pedir el plan de cobro' })); return await screen.findByRole('region', { name: 'Plan del servidor' }); })();
  commitFailure = new ApiError(412, 'PRECONDITION_FAILED', null, 'Los datos cambiaron. Recarga antes de confirmar.');
  await user.click(within(planRegion).getByRole('checkbox')); await fill(); await user.click(within(planRegion).getByRole('button', { name: 'Confirmar cobro' }));
  expect(await screen.findByText('Los datos cambiaron. Recarga antes de confirmar.')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Plan del servidor' })).toBeNull();
  evidence('P05-S5-UI5', { retrySameKey: true, retrySameBody: true, editFrozen: true, discardedOn412: true });
});

it('P05-S5-UI6 the borrower filter asks the user for a raw identifier (characterized for H05)', async () => {
  render(<OperationsScreen />);
  const field = await screen.findByLabelText('Identificador del prestatario, si se filtra');
  evidence('P05-S5-UI6', { borrowerFilterIsFreeTextId: field.tagName === 'INPUT' && (field as HTMLInputElement).type !== 'search' });
  expect(field.tagName).toBe('INPUT');
});
