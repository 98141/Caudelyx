// MEJ-4 adapted version by Codex; original read-only: lending/operations
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationsScreen } from '../../../src/features/lending/Operations';
import { AuthProvider } from '../../../src/shared/auth';
import type { Me } from '../../../src/shared/contracts';

const orgId = '11111111-1111-4111-8111-111111111111';
const borrowerId = '55555555-5555-4555-8555-555555555555';
const otherBorrower = '55555555-5555-4555-8555-555555555556';
const loanId = '77777777-7777-4777-8777-777777777777';
const secondId = '77777777-7777-4777-8777-777777777778';
const unknownId = '77777777-7777-4777-8777-777777777779';
const fundingId = '22222222-2222-4222-8222-222222222222';
const principalId = '22222222-2222-4222-8222-222222222223';
const receivableId = '22222222-2222-4222-8222-222222222224';
const incomeId = '22222222-2222-4222-8222-222222222225';
const creditId = '22222222-2222-4222-8222-222222222226';
const active: Me = { authState: 'ACTIVE', userId: 'user-1', organizationId: orgId, profile: { displayName: 'Titular sintético', email: 'titular@example.test', emailVerified: true } };

function json(body: unknown, status = 200, etag?: string): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (etag) headers.set('ETag', etag);
  return new Response(JSON.stringify(body), { status, headers });
}

function position(id: string, code: string, name: string, principal: string, status: string, label: string, borrower = borrowerId) {
  return {
    loanId: id, borrower: { id: borrower, code, name }, currency: 'COP', version: 0, termsVersion: 1, scheduleVersion: 0,
    termsStatus: 'TERMS_CONFIRMED', status, statusLabel: label, originalPrincipal: principal, principalOutstanding: '0.00',
    duePrincipal: '0.00', originalExpectedInterest: '0.00', expectedFutureInterest: '0.00', dueUnrecognizedInterest: '0.00',
    accruedInterestTotal: '0.00', collectedInterestTotal: '0.00', accruedOutstandingInterest: '0.00',
  };
}

const listed = [
  position(loanId, 'P001', 'Ana sintética', '1000.00', 'NOT_DISBURSED', 'Sin desembolso'),
  position(secondId, 'P001', 'Ana sintética', '50.00', 'NOT_DISBURSED', 'Sin desembolso'),
  position(unknownId, 'P002', 'Luis sintético', '80.00', 'ARCHIVED', 'ARCHIVED', otherBorrower),
];
const profile = { principalAccountId: principalId, interestReceivableAccountId: receivableId, interestIncomeAccountId: incomeId, borrowerCreditAccountId: creditId };
const names: Record<string, string> = { [fundingId]: 'BANK_01', [principalId]: 'CAP_01', [receivableId]: 'INT_01', [incomeId]: 'ING_01', [creditId]: 'FAV_01' };

function install(handler: (path: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
    if (path.endsWith('/auth/me')) return json({ data: active, requestId: 'req-fixture' });
    if (path.endsWith('/auth/reauthenticate') || path.endsWith('/auth/mfa/challenges/verify')) return json({ data: { nextAction: 'READY' }, requestId: 'req-fixture' });
    return handler(path, init);
  }));
}

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

describe('operaciones de préstamo', () => {
  function routes(path: string, init?: RequestInit): Response {
    if (path.endsWith('/loan-operations/policy')) return json({ data: { version: 'S05-LOCAL-CO-0.1', usage: 'LOCAL_SYNTHETIC', realUseAllowed: false, currency: 'COP', previewTTLSeconds: 300, quoteTTLSeconds: 900, maxTargets: 10, actorQuotesPerWindow: 30, orgQuotesPerWindow: 60, windowSeconds: 60, retention: 'INDEFINITE', excludedVariants: [] }, requestId: 'req-fixture' });
    if (path.includes('/loan-operations/positions?')) return json({ data: { items: listed, nextCursor: null }, requestId: 'req-fixture' });
    if (path.endsWith(`/positions/${loanId}`)) return json({ data: listed[0], requestId: 'req-fixture' }, 200, `"${loanId}:0"`);
    if (path.endsWith(`/positions/${unknownId}`)) return json({ data: listed[2], requestId: 'req-fixture' }, 200, `"${unknownId}:0"`);
    if (path.includes('/loans/')) return json({ data: { id: loanId, status: 'TERMS_CONFIRMED', terms: { plannedFundingAccountId: fundingId, principal: '1000.00' } }, requestId: 'req-fixture' }, 200, `"${loanId}:1"`);
    if (path.endsWith('/loan-operations/book')) return json({ data: { organizationId: orgId, version: 0, profile, currency: 'COP' }, requestId: 'req-fixture' }, 200, `"${orgId}:ops:0"`);
    if (path.includes('/installments')) return json({ data: { items: [{ loanId, number: 1, dueDate: '2026-03-31', principal: '1000.00', interest: '0.00', payment: '1000.00', principalPaid: '0.00', interestPaid: '0.00', status: 'UNPAID', dueState: 'FUTURE' }], nextCursor: null }, requestId: 'req-fixture' });
    if (path.includes('/credits/')) return json({ data: { borrowerId, version: 0, balance: '0.00', currency: 'COP' }, requestId: 'req-fixture' }, 200, `"${borrowerId}:0"`);
    const accountId = Object.keys(names).find(id => path.endsWith(`/accounts/${id}`));
    if (accountId) return json({ data: { id: accountId, code: names[accountId], name: 'Cuenta sintética', accountClass: 'ASSET', kind: 'BANK', status: 'ACTIVE', version: 1, currency: 'COP' }, requestId: 'req-fixture' }, 200, `"${accountId}:1"`);
    if (path.endsWith('/loan-operation-previews') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { executionKey: string; request: { kind: string } };
      return json({ data: { previewToken: 'token-de-prueba-local-sintetico-0001', expiresAt: '2026-10-24T18:20:00.000Z', fingerprint: 'ab'.repeat(32), policyVersion: 'S05-LOCAL-CO-0.1', request: body.request, expectedBookETag: `"${orgId}:ops:0"`, fundingAccountId: fundingId, plan: { postings: [], allocations: [], accruals: [], scheduleRevisions: [], positions: [listed[0]], creditChange: null }, realUseAllowed: false }, requestId: 'req-fixture' });
    }
    return json({ error: { code: 'NOT_FOUND' }, requestId: 'req-fixture' }, 404);
  }

  it('distingue dos préstamos de la misma persona y no actúa ante un estado desconocido', async () => {
    install(routes);
    render(<AuthProvider><OperationsScreen /></AuthProvider>);
    const user = userEvent.setup();
    expect(await screen.findByRole('button', { name: /P001 · Ana sintética · 1[.]000 COP · Sin desembolso · versión 0/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /P001 · Ana sintética · 50 COP · Sin desembolso · versión 0/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: loanId })).not.toBeInTheDocument();
    const unknown = screen.getByRole('button', { name: /Luis sintético/ });
    unknown.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Estado no reconocido. No hay acciones.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pedir el plan de desembolso' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pedir el plan de devengo' })).not.toBeInTheDocument();
  });

  it('espera todas las versiones de cuentas antes de habilitar el plan', async () => {
    let complete!: (response: Response) => void;
    const pendingAccount = new Promise<Response>(resolve => { complete = resolve; });
    install((path, init) => path.endsWith(`/accounts/${creditId}`) ? pendingAccount : routes(path, init));
    render(<AuthProvider><OperationsScreen /></AuthProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /1\.000 COP/ }));
    expect(await screen.findByText('Consultando la posición y las versiones de sus cuentas…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pedir el plan de desembolso' })).not.toBeInTheDocument();
    complete(routes(`/accounts/${creditId}`));
    const plan = await screen.findByRole('button', { name: 'Pedir el plan de desembolso' });
    await waitFor(() => expect(plan).toBeEnabled());
  });

  it('retira el plan y actualiza la posición al recuperar un comando comprometido', async () => {
    let committed = false;
    install((path, init) => {
      if (path.endsWith('/disbursements') && init?.method === 'POST') {
        committed = true;
        return json({ error: { code: 'SERVICE_UNAVAILABLE' } }, 503);
      }
      if (path.includes('/loan-operations/commands/')) return json({ data: { status: 'CONFIRMED' } });
      if (committed && path.endsWith(`/positions/${loanId}`)) return json({ data: position(loanId, 'P001', 'Ana sintética', '1000.00', 'ACTIVE', 'Activo') }, 200, `"${loanId}:1"`);
      return routes(path, init);
    });
    render(<AuthProvider><OperationsScreen /></AuthProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /1\.000 COP/ }));
    await user.type(await screen.findByLabelText('Referencia de soporte'), 'SYN-RECOVERY');
    await user.click(screen.getByRole('button', { name: 'Pedir el plan de desembolso' }));
    await user.click(await screen.findByRole('checkbox', { name: /Confirmo este plan/ }));
    await user.click(screen.getByRole('button', { name: 'Confirmar desembolso' }));
    await user.click(await screen.findByRole('button', { name: 'Consultar el comando' }));
    expect(await screen.findByRole('button', { name: 'Pedir el plan de devengo' })).toBeInTheDocument();
    expect(screen.queryByText('Plan del servidor')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Confirmo este plan/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pedir el plan de desembolso' })).not.toBeInTheDocument();
  });

  it('bloquea el reparto completo si falta el importe de otro préstamo elegido', async () => {
    const first = position(loanId, 'P001', 'Ana sintética', '1000.00', 'ACTIVE', 'Activo');
    const second = position(secondId, 'P001', 'Ana sintética', '50.00', 'ACTIVE', 'Activo');
    let previews = 0;
    install((path, init) => {
      if (path.includes('/positions?')) return json({ data: { items: [first, second], nextCursor: null } });
      if (path.endsWith(`/positions/${loanId}`)) return json({ data: first }, 200, `"${loanId}:1"`);
      if (path.endsWith(`/positions/${secondId}`)) return json({ data: second }, 200, `"${secondId}:1"`);
      if (path.endsWith('/loan-operation-previews')) { previews++; return routes(path, init); }
      if (path.includes('/accounts?')) return json({ data: { items: [{ id: fundingId, code: 'BANK_01', name: 'Caja sintética', accountClass: 'ASSET', kind: 'BANK', status: 'ACTIVE', version: 1, currency: 'COP' }], nextCursor: null } });
      return routes(path, init);
    });
    render(<AuthProvider><OperationsScreen /></AuthProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /1\.000 COP/ }));
    await user.type(await screen.findByLabelText('Referencia de soporte'), 'SYN-JOINT');
    await user.click(await optionFor('Cuenta que recibe el cobro', 'BANK_01'));
    await user.type(screen.getByLabelText('Importe recibido'), '10');
    await user.type(screen.getByLabelText('Importe para el préstamo 1'), '10');
    await user.type(screen.getByLabelText('Referencia del cobro'), 'SYN-JOINT');
    await user.click(screen.getByRole('button', { name: /Agregar P001/ }));
    expect(await screen.findByLabelText('Importe para el préstamo 2')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Pedir el plan de cobro' }));
    expect(await screen.findByText(/Revisa todos los préstamos seleccionados/)).toBeInTheDocument();
    expect(previews).toBe(0);
  });

  it('pide el plan y reintenta el desembolso con la misma clave, sin cobrar', async () => {
    const keys: string[] = [];
    const purposes: string[] = [];
    install((path, init) => {
      if (path.endsWith('/loan-operations/disbursements') && init?.method === 'POST') {
        keys.push(new Headers(init.headers).get('Idempotency-Key') ?? '');
        if (keys.length === 1) return json({ error: { code: 'SERVICE_UNAVAILABLE' }, requestId: 'req-fixture' }, 503);
        return json({ data: { event: { id: '88888888-8888-4888-8888-888888888888', status: 'CONFIRMED' }, bookVersion: 1 }, requestId: 'req-fixture' }, 201, `"${orgId}:ops:1"`);
      }
      return routes(path, init);
    });
    render(<AuthProvider><OperationsScreen /></AuthProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /1\.000 COP/ }));
    expect(await screen.findByText(/2026-03-31/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Referencia de soporte'), 'SOP-S5-1');
    await user.click(screen.getByRole('button', { name: 'Pedir el plan de desembolso' }));
    expect(await screen.findByText(/Plan sin efecto/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Referencia de soporte'), 'X');
    expect(screen.queryByText(/Plan sin efecto/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pedir el plan de desembolso' }));
    expect(await screen.findByText(/Plan sin efecto/)).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Confirmar desembolso' });
    expect(confirm).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /Confirmo este plan/ }));
    await user.click(confirm);
    expect(await screen.findByText(/no está disponible/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reintentar el mismo comando' }));
    expect(await screen.findByText(/El servidor confirmó el comando/)).toBeInTheDocument();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    purposes.push(...vi.mocked(fetch).mock.calls.filter(call => String(call[0]).endsWith('/auth/reauthenticate')).map(call => JSON.parse(String(call[1]?.body)).purpose));
    expect(purposes).toEqual([]); // Real BALANCE modal is covered in the HTTPS journey; this unit checks idempotency.
    expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).includes('/loan-quotes') || String(call[0]).includes('/receipts'))).toBe(false);
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('muestra el reparto del servidor y explica el excedente rechazado', async () => {
    const activePosition = position(loanId, 'P001', 'Ana sintética', '1000.00', 'ACTIVE', 'Activo');
    install((path, init) => {
      if (path.includes('/loan-operations/positions?')) return json({ data: { items: [activePosition], nextCursor: null }, requestId: 'req-fixture' });
      if (path.endsWith(`/positions/${loanId}`)) return json({ data: activePosition, requestId: 'req-fixture' }, 200, `"${loanId}:2"`);
      if (path.endsWith('/loan-operation-previews')) return json({ error: { code: 'EXCESS_NOT_ALLOWED' }, requestId: 'req-fixture' }, 409);
      if (path.includes('/accounts?')) return json({ data: { items: [{ id: fundingId, code: 'BANK_01', name: 'Caja sintética', accountClass: 'ASSET', kind: 'BANK', status: 'ACTIVE', version: 1, currency: 'COP' }], nextCursor: null }, requestId: 'req-fixture' });
      return routes(path, init);
    });
    render(<AuthProvider><OperationsScreen /></AuthProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Activo · versión 0/ }));
    expect(await screen.findByText(/No reconoce el interés futuro/)).toBeInTheDocument();
    await user.click(await optionFor('Cuenta que recibe el cobro', 'BANK_01'));
    expect(await screen.findByText('La cuenta de cobro tiene versión para el plan.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Importe recibido'), '25,00');
    await user.type(screen.getByLabelText('Importe para el préstamo 1'), '10,00');
    await user.type(screen.getByLabelText('Referencia del cobro'), 'REC-1');
    await user.type(screen.getByLabelText('Referencia de soporte'), 'SOP-S5-2');
    await user.click(screen.getByRole('button', { name: 'Pedir el plan de cobro' }));
    expect(await screen.findByText(/El cobro deja un excedente y se pidió rechazarlo/)).toBeInTheDocument();
    expect(screen.queryByText(/El servidor confirmó el comando/)).not.toBeInTheDocument();
  });
});

// Unit boundary only. Actual factor/HTTP authority is exercised by MEJ4 HTTPS/E2E.
vi.mock('../../../src/shared/step-up', () => ({ensureStepUp: vi.fn().mockResolvedValue(undefined), StepUpProvider: ({children}: {children: unknown}) => children}));

async function optionFor(label: string, code: string) {
  await userEvent.click(await screen.findByRole('combobox', {name:label}));
  return await screen.findByRole('option', {name: new RegExp('^'+code+' ·')});
}
