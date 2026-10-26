// MEJ-4 adapted version by Codex; original read-only: lending/p04-components
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { SettingsScreen } from '../../../src/features/settings/Settings';
import { LoansScreen } from '../../../src/features/lending/Loans';
import { percentToRate, rateToPercent } from '../../../src/features/lending/rate';

const api = vi.hoisted(() => ({ call: vi.fn(), reauthenticate: vi.fn() }));
vi.mock('../../../src/shared/api', () => api);
vi.mock('../../../src/shared/auth', () => ({ useAuth: () => ({ me: { authState: 'ACTIVE', organizationId: 'org', userId: 'actor' } }) }));
const borrower = { id: 'borrower', borrowerCode: 'P001', status: 'ACTIVE', version: 1, profileVersion: 1, profile: { displayName: 'Persona sintética', schemaVersion: 1, extras: {} } };
const terms = { borrowerId: 'borrower', plannedFundingAccountId: 'account', principal: '100.00', effectiveDate: '2024-01-31', firstDueDate: '2024-02-29', installmentCount: 2, method: 'CONSTANT_PRINCIPAL', frequency: 'MONTH', rate: { type: 'EFFECTIVE', unit: 'MONTH', value: '0.000000000000' }, note: 'Nota sintética conservada', documents: [{ reference: 'SYN-001', label: 'Soporte sintético', kind: 'OTHER' }] };
const calculation = { schedule: [{ k: 1, date: '2024-02-29', openingPrincipal: '100.00', principal: '50.00', interest: '0.00', payment: '50.00', closingPrincipal: '50.00' }, { k: 2, date: '2024-03-31', openingPrincipal: '50.00', principal: '50.00', interest: '0.00', payment: '50.00', closingPrincipal: '0.00' }], totals: { principal: '100.00', interest: '0.00', payment: '100.00' }, periodicRate24: '0.000000000000000000000000', basePayment: null, finalPaymentAdjustment: '0.00', policyVersion: 'S04-LOCAL-CO-0.1', mathVersion: 'CALCULATION-S04-0.1', calendarVersion: 'S04-CALENDAR-0.1' };
const loan = { id: 'loan', status: 'DRAFT', version: 1, termsVersion: 1, borrowerId: 'borrower', quoteId: 'quote', quoteFingerprint: 'ab'.repeat(32), terms, calculation };
const quote = { id: 'quote', fingerprint: loan.quoteFingerprint, expiresAt: '2199-01-01T00:00:00Z', ...calculation };
const policy = { policyVersion: calculation.policyVersion, jurisdiction: 'CO', usage: 'LOCAL_SYNTHETIC', methods: ['CONSTANT_PRINCIPAL'], frequencies: ['MONTH'], realUseAllowed: false, quoteTtlSeconds: 900 };
const response = (data: unknown, etag = '"v1"') => ({ data, etag });
beforeEach(() => {
  vi.clearAllMocks();
  api.call.mockImplementation(async (method: string, path: string, payload?: unknown) => {
    if (path.includes('lending-policy')) return response(policy);
    if (path.includes('borrower-field-schemas/current')) return response({ schemaVersion: 1, fields: [] });
    if (path.includes('borrowers?')) return response({ items: [borrower], nextCursor: 'borrowers-next' });
    if (path.includes('/borrowers/borrower')) return response(borrower);
    if (path.includes('/accounts?')) return response({ items: [{ id: 'account', code: 'CASH', name: 'Caja sintética', status: 'ACTIVE', accountClass: 'ASSET', kind: 'CASH' }], nextCursor: null });
    if (path.endsWith('/accounts/account')) return response({ id: 'account', code: 'CASH', name: 'Caja sintética', status:'ACTIVE', accountClass:'ASSET', kind:'CASH', currency:'COP',version:1 });
    if (path.includes('/loans?')) return response({ items: [loan], nextCursor: 'loans-next' });
    if (path.includes('/loans/loan/versions')) return response({ items: [{ termsVersion: 1, terms, calculation }], nextCursor: null });
    if (path.endsWith('/loans/loan')) return response(loan);
    if (path.endsWith('/loan-quotes/quote')) return response(quote);
    if (method === 'POST' && path.endsWith('/borrower-field-schemas')) {
      expect(payload).toMatchObject({ changeReason: 'Catálogo sintético', fields: [{ key: 'zona', label: 'Zona', type: 'TEXT', deprecated: false }] });
      return response({ schemaVersion: 2, fields: (payload as { fields: unknown[] }).fields });
    }
    throw new Error('Unexpected P04 request ' + method + ' ' + path);
  });
});

it('UI01: publica catálogo en Configuración con motivo y ETag, sin R', async () => {
  render(<SettingsScreen />);
  const user = userEvent.setup();
  await screen.findByText(/Versión publicada 1/);
  await user.type(screen.getByLabelText('Clave del campo'), 'zona');
  await user.type(screen.getByLabelText('Nombre del campo'), 'Zona');
  await user.type(screen.getByLabelText('Motivo'), 'Catálogo sintético');
  await user.click(screen.getByRole('button', { name: 'Publicar' }));
  expect(api.reauthenticate).not.toHaveBeenCalled();
  expect((await screen.findAllByText('Zona')).length).toBeGreaterThan(0);
});

it('UI02: expone cursores de préstamos y prestatarios conservando la selección', async () => {
  render(<LoansScreen />);
  await screen.findByRole('option', { name: 'P001 · Persona sintética' });
  expect(screen.getByRole('button', { name: 'Más prestatarios' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Más préstamos' })).toBeEnabled();
});

it('UI03: abre términos exactos y su historia sin volver a cotizar', async () => {
  render(<LoansScreen />);
  await userEvent.click(await screen.findByRole('button', { name: 'P001 · Persona sintética · 100 COP · Borrador · versión 1' }));
  await screen.findByRole('heading', { name: 'Historial de términos' });
  expect(screen.getByLabelText('Capital')).toHaveValue('100');
  await userEvent.click(screen.getByRole('button',{name:'Siguiente'}));
  expect(screen.getByLabelText('Tasa en porcentaje')).toHaveValue('0');
  expect(screen.getByLabelText('Fecha de inicio')).toHaveValue('2024-01-31');
  await userEvent.click(screen.getByRole('button',{name:'Anterior'}));
  expect(screen.getByLabelText('Prestatario')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Confirmar términos' })).toBeDisabled();
  expect(api.call.mock.calls.some(([method, path]) => method === 'POST' && String(path).endsWith('/loan-quotes'))).toBe(false);
});

it('UI04: nuevo borrador elimina la cotización consumida y la confirmación previa', async () => {
  render(<LoansScreen />);
  await userEvent.click(await screen.findByRole('button', { name: 'P001 · Persona sintética · 100 COP · Borrador · versión 1' }));
  await screen.findByRole('heading', { name: 'Historial de términos' });
  await userEvent.click(screen.getByRole('checkbox', { name: /Confirmo estos términos/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Preparar un borrador nuevo' }));
  expect(screen.getByLabelText('Capital')).toHaveValue('');
  expect(screen.queryByRole('checkbox', { name: /Confirmo estos términos/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Historial de términos' })).not.toBeInTheDocument();
});

it('UI04: una nueva simulación de un borrador exige guardar antes de confirmar', async () => {
  const original = api.call.getMockImplementation()!;
  api.call.mockImplementation(async (method: string, path: string, ...args: unknown[]) => {
    if (method === 'POST' && path.endsWith('/loan-quotes')) return response({ ...quote, id: 'unsaved', fingerprint: 'cd'.repeat(32) });
    return original(method, path, ...args);
  });
  render(<LoansScreen />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'P001 · Persona sintética · 100 COP · Borrador · versión 1' }));
  await screen.findByRole('heading', { name: 'Historial de términos' });
  await user.click(screen.getByRole('checkbox', { name: /Confirmo estos términos/ }));
  await user.clear(screen.getByLabelText('Capital')); await user.type(screen.getByLabelText('Capital'), '120');
  await user.click(screen.getByRole('button',{name:'Siguiente'}));await user.click(screen.getByRole('button',{name:'Siguiente'}));
  await user.click(screen.getByRole('button', { name: 'Ver cronograma' }));
  await screen.findByRole('button', { name: 'Reemplazar términos' });
  expect(api.call).toHaveBeenCalledWith('POST', expect.stringContaining('/loan-quotes'), expect.objectContaining({ terms: expect.objectContaining({ note: terms.note, documents: terms.documents }) }), expect.anything());
  expect(screen.queryByRole('checkbox', { name: /Confirmo estos términos/ })).not.toBeInTheDocument();
  expect(api.call.mock.calls.some(([, path]) => String(path).endsWith('/confirmation'))).toBe(false);
});

it('UI03: una carga demorada bloquea la edición hasta recuperar todos los términos', async () => {
  const original = api.call.getMockImplementation()!;
  let finish!: (result: ReturnType<typeof response>) => void;
  const delayed = new Promise<ReturnType<typeof response>>(resolve => { finish = resolve; });
  api.call.mockImplementation(async (method: string, path: string, ...args: unknown[]) => {
    if (method === 'GET' && path.endsWith('/loans/loan')) return await delayed;
    return original(method, path, ...args);
  });
  render(<LoansScreen />);
  await userEvent.click(await screen.findByRole('button', { name: 'P001 · Persona sintética · 100 COP · Borrador · versión 1' }));
  expect(screen.getByLabelText('Capital')).toBeDisabled();
  expect(screen.queryByRole('heading', { name: 'Historial de términos' })).not.toBeInTheDocument();
  finish(response(loan));
  await screen.findByRole('heading', { name: 'Historial de términos' });
  await vi.waitFor(() => expect(screen.getByLabelText('Capital')).toBeEnabled());
  expect(screen.getByLabelText('Capital')).toHaveValue('100');
});

it('la tasa recuperada conserva sus doce decimales, incluidos cero y los límites', () => {
  for (const value of ['0.000000000000', '0.000000000001', '0.123456789012', '0.999999999999', '1.000000000000']) {
    expect(percentToRate(rateToPercent(value))).toBe(value);
  }
  expect(() => rateToPercent('0.1')).toThrow();
});

// Unit boundary only. Actual factor/HTTP authority is exercised by MEJ4 HTTPS/E2E.
vi.mock('../../../src/shared/step-up', () => ({ensureStepUp: vi.fn().mockResolvedValue(undefined), StepUpProvider: ({children}: {children: unknown}) => children}));
