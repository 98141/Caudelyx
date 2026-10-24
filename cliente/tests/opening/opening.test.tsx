import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OpeningWizard } from '../../src/features/opening/Opening';
import { AuthProvider } from '../../src/shared/auth';

const orgId = '11111111-1111-4111-8111-111111111111';
const openingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const accountId = '22222222-2222-4222-8222-222222222222';
const validationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const fingerprint = 'ab'.repeat(32);
const base = `/organizations/${orgId}/financial`;

function json(body: unknown, status = 200, etag?: string): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (etag) headers.set('ETag', etag);
  return new Response(JSON.stringify(body), { status, headers });
}

const account = { id: accountId, code: 'BANK_01', name: 'Banco', accountClass: 'ASSET', kind: 'BANK', status: 'ACTIVE', version: 1, currency: 'COP' };

function snapshot() {
  return {
    cutoffDate: '2026-10-22',
    supports: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', reference: 'SOP-1', asOfDate: '2026-10-22', declaration: 'DECLARED' }],
    references: [],
    components: [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', category: 'BANK', accountId, amount: '100.00', supportIds: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'] }],
    historicalInterest: [],
    informationalHistory: [],
  };
}

function file(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: openingId, version: 2, contentVersion: 1, status, financialScope: 'BUSINESS', currency: 'COP',
    snapshot: snapshot(), predecessorId: null, validation: null, approval: null, commit: null, cancellation: null, ...extra,
  };
}

function renderWizard(handler: (path: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
    if (path.endsWith('/auth/me')) return json({ data: { authState: 'ACTIVE', userId: 'user-1', organizationId: orgId }, requestId: 'req-fixture' });
    if (path.endsWith('/auth/reauthenticate') || path.endsWith('/auth/mfa/challenges/verify')) return json({ data: { nextAction: 'READY' }, requestId: 'req-fixture' });
    return handler(path, init);
  }));
  render(<AuthProvider><OpeningWizard organizationId={orgId} base={base} /></AuthProvider>);
}

describe('asistente de apertura', () => {
  it('conserva el corte al retroceder y no lo pierde si la sesión falla al guardar', async () => {
    const posts: string[] = [];
    renderWizard((path, init) => {
      if (path.includes('/accounts')) return json({ data: path.includes('?') ? { items: [account], nextCursor: null } : account, requestId: 'req-fixture' });
      if ((init?.method ?? 'GET') === 'GET' && path.includes('/opening-files')) return json({ data: { items: [], nextCursor: null }, requestId: 'req-fixture' });
      posts.push(path);
      return json({ error: { code: 'AUTH_INVALID' }, requestId: 'req-fixture' }, 401);
    });
    const user = userEvent.setup();
    const cutoff = await screen.findByLabelText('Fecha de corte de la apertura');
    fireEvent.change(cutoff, { target: { value: '2026-10-22' } });
    await user.click(screen.getByRole('button', { name: 'Siguiente' }));
    await user.click(screen.getByRole('button', { name: 'Paso atrás' }));
    expect(screen.getByLabelText('Fecha de corte de la apertura')).toHaveValue('2026-10-22');
    await user.click(screen.getByRole('button', { name: 'Siguiente' }));
    await user.click(screen.getByRole('button', { name: 'Agregar soporte' }));
    await user.type(screen.getByLabelText('Referencia del soporte'), 'SOP-1');
    fireEvent.change(screen.getByLabelText('Fecha del soporte'), { target: { value: '2026-10-22' } });
    await user.click(screen.getByRole('button', { name: 'Siguiente' }));
    expect(screen.getByText('Un préstamo histórico no es un desembolso ni un recaudo de esta operación. El principal se declara después como cartera.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Siguiente' }));
    await user.click(screen.getByRole('button', { name: 'Agregar componente' }));
    await user.click(await screen.findByRole('button', { name: 'Elegir BANK_01 para Banco' }));
    await user.type(screen.getByLabelText('Importe del componente'), '100');
    await user.click(screen.getByRole('checkbox', { name: 'SOP-1' }));
    await user.click(screen.getByRole('button', { name: 'Siguiente' }));
    await user.click(screen.getByRole('button', { name: 'Siguiente' }));
    expect(screen.getByText(/Corte 2026-10-22/)).toBeInTheDocument();
    expect(screen.queryByText(/^Activos/)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Contraseña actual'), 'fixture-password-local-01');
    await user.type(screen.getByLabelText('Código TOTP vigente'), '123456');
    await user.click(screen.getByRole('button', { name: 'Guardar borrador de apertura' }));
    expect(await screen.findByText(/El borrador sigue en esta pantalla/)).toBeInTheDocument();
    expect(screen.getByText(/Corte 2026-10-22/)).toBeInTheDocument();
    expect(posts.filter(path => path.endsWith('/opening-files'))).toHaveLength(1);
    expect(posts.some(path => path.endsWith('/auth/logout'))).toBe(false);
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('muestra el descuadre del servidor y no habilita la aprobación', async () => {
    const report = {
      issues: [{ code: 'BALANCE_DIFFERENCE', path: '/totals/balanceDifference', relatedIds: [] }],
      totals: { assets: '100.00', liabilities: '0.00', equity: '0.00', debit: '100.00', credit: '0.00', balanceDifference: '100.00', ledgerDifference: '100.00', principal: '0.00', recognizedInterest: '0.00', informationalInterest: '0.00' },
      proposedLines: [],
    };
    renderWizard(path => {
      if (path.includes('/accounts/') && !path.includes('?')) return json({ data: account, requestId: 'req-fixture' });
      if (path.includes('/accounts?')) return json({ data: { items: [account], nextCursor: null }, requestId: 'req-fixture' });
      if (path.endsWith(`/opening-files/${openingId}`)) return json({ data: file('DRAFT'), requestId: 'req-fixture' }, 200, `"${openingId}:2"`);
      if (path.includes('/opening-files?') || path.endsWith('/opening-files')) return json({ data: { items: [{ id: openingId, status: 'DRAFT', version: 2, cutoffDate: '2026-10-22', updatedAt: '2026-10-23T00:00:00.000Z' }], nextCursor: null }, requestId: 'req-fixture' });
      if (path.endsWith('/validations')) return json({ data: { opening: file('DRAFT'), report, validation: null }, requestId: 'req-fixture' }, 200, `"${openingId}:3"`);
      return json({ error: { code: 'NOT_FOUND' }, requestId: 'req-fixture' }, 404);
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Reanudar 2026-10-22' }));
    expect(await screen.findByText(/Estado DRAFT/)).toBeInTheDocument();
    await user.type(screen.getAllByLabelText('Contraseña actual')[0]!, 'fixture-password-local-01');
    await user.type(screen.getAllByLabelText('Código TOTP vigente')[0]!, '123456');
    await user.click(screen.getByRole('button', { name: 'Validar con el servidor' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Diferencia de balance');
    expect(screen.getAllByText(/100 COP \(100.00\)/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Aprobar apertura' })).not.toBeInTheDocument();
    expect(screen.getByText(/La aprobación espera un expediente VALIDATED/)).toBeInTheDocument();
  });

  it('bloquea la confirmación si la validación quedó desactualizada y no reintenta', async () => {
    const calls: string[] = [];
    const clean = {
      issues: [],
      totals: { assets: '100.00', liabilities: '0.00', equity: '100.00', debit: '100.00', credit: '100.00', balanceDifference: '0.00', ledgerDifference: '0.00', principal: '0.00', recognizedInterest: '0.00', informationalInterest: '0.00' },
      proposedLines: [{ accountId, debit: '100.00', credit: '0.00', componentIds: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'], interestIds: [] }],
    };
    const validation = { id: validationId, validatedAt: '2026-10-23T00:00:00.000Z', contentVersion: 1, fingerprint, report: clean };
    renderWizard((path, init) => {
      if (init?.method && init.method !== 'GET') calls.push(`${init.method} ${path}`);
      if (path.includes('/accounts')) return json({ data: path.includes('?') ? { items: [account], nextCursor: null } : account, requestId: 'req-fixture' });
      if (path.endsWith(`/opening-files/${openingId}/approval`)) return json({ error: { code: 'OPENING_VALIDATION_STALE' }, requestId: 'req-fixture' }, 409);
      if (path.endsWith(`/opening-files/${openingId}`)) return json({ data: file('VALIDATED', { validation }), requestId: 'req-fixture' }, 200, `"${openingId}:4"`);
      return json({ data: { items: [{ id: openingId, status: 'VALIDATED', version: 4, cutoffDate: '2026-10-22', updatedAt: '2026-10-23T00:00:00.000Z' }], nextCursor: null }, requestId: 'req-fixture' });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Reanudar 2026-10-22' }));
    await user.click(await screen.findByRole('checkbox', { name: /Apruebo el expediente validado/ }));
    const form = screen.getByRole('button', { name: 'Aprobar apertura' }).closest('form');
    if (!form) throw new Error('Falta el formulario de aprobación');
    await user.type(form.querySelector('input[type="password"]') as HTMLInputElement, 'fixture-password-local-01');
    await user.type(form.querySelector('input[inputmode="numeric"]') as HTMLInputElement, '123456');
    await user.click(screen.getByRole('button', { name: 'Aprobar apertura' }));
    expect(await screen.findByText(/La validación quedó desactualizada/)).toBeInTheDocument();
    expect(calls.filter(call => call.includes('/approval'))).toHaveLength(1);
    expect(screen.getByText(/Estado VALIDATED/)).toBeInTheDocument();
  });

  it('confirma con los datos del asiento devuelto y no lo llama desembolso', async () => {
    const posted = file('POSTED', {
      version: 5,
      commit: { journalId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', recordedAt: '2026-10-23T15:00:00.000Z', ledgerLineMap: [{ lineIndex: 0, accountId }] },
    });
    renderWizard(path => {
      if (path.endsWith(`/opening-files/${openingId}`)) return json({ data: posted, requestId: 'req-fixture' }, 200, `"${openingId}:5"`);
      return json({ data: { items: [{ id: openingId, status: 'POSTED', version: 5, cutoffDate: '2026-10-22', updatedAt: '2026-10-23T15:00:00.000Z' }], nextCursor: null }, requestId: 'req-fixture' });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Reanudar 2026-10-22' }));
    expect(await screen.findByText(/Asiento registrado/)).toBeInTheDocument();
    expect(screen.getByText('Correlación del asiento')).toBeInTheDocument();
    expect(screen.getByText(/No es un desembolso ni un recaudo del período/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirmar apertura en el libro' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Guardar borrador de apertura' })).not.toBeInTheDocument();
  });
});
