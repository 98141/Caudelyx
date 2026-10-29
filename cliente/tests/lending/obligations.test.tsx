import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObligationsScreen } from '../../src/features/lending/Obligations';
import { AuthProvider } from '../../src/shared/auth';
import type { Me } from '../../src/shared/contracts';

const orgId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';

function person(roles: string[], organizationId?: string): Me {
  return { authState: 'ACTIVE', userId: actorId, organizationId, roleIds: roles, profile: { displayName: 'Persona sintética', email: 'persona@example.test', emailVerified: true } };
}

function json(body: unknown, status = 200, etag?: string): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...(etag ? { ETag: etag } : {}) } });
}

describe('gastos y obligaciones', () => {
  afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); });

  it('registra un gasto presupuestado y no lo muestra pagado', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json({ data: person(['T'], orgId), requestId: 'req-fixture' });
      if (path.endsWith('/me/personal/book')) return json({ error: { code: 'RESOURCE_NOT_FOUND' }, requestId: 'req-fixture' }, 404);
      if (path.endsWith('/finance-s09/book')) return json({ data: { id: orgId, currency: 'COP', status: 'ACTIVE', version: 1 }, requestId: 'req-fixture' }, 200, '"book"');
      if (path.endsWith('/finance-s09/expenses') && init?.method === 'POST') return json({ data: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version: 1, status: 'PLANNED' }, requestId: 'req-fixture' }, 201, '"gasto"');
      if (path.includes('/finance-s09/expenses?')) return json({ data: { items: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', description: 'Papel sintético', planningStatus: 'PLANNED', settlementStatus: 'UNPAID', outstanding: '10000.00' }], nextCursor: null }, meta: { scope: 'BUSINESS', coverage: 'COMPLETE', reasons: [] }, requestId: 'req-fixture' });
      return json({ error: { code: 'NOT_FOUND' }, requestId: 'req-fixture' }, 404);
    }));
    const user = userEvent.setup();
    render(<AuthProvider><ObligationsScreen /></AuthProvider>);
    expect(await screen.findByRole('button', { name: 'Personal' })).toBeInTheDocument();
    await user.type(await screen.findByLabelText('Descripción'), 'Papel sintético');
    await user.type(screen.getByLabelText('Importe'), '10000');
    await user.type(screen.getByLabelText('Soporte'), 'SYN-GASTO');
    await user.click(screen.getByRole('button', { name: 'Registrar gasto' }));
    expect(await screen.findByText(/Pendiente de pago/)).toBeInTheDocument();
    expect(screen.queryByText(/Pagado, según el servidor/)).not.toBeInTheDocument();
    expect(calls.some(call => call.includes('/me/personal/books/') && call.includes('expenses'))).toBe(false);
  });

  it('oculta el negocio a un colaborador y no trae sus saldos', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      calls.push(path);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json({ data: person(['C'], orgId), requestId: 'req-fixture' });
      if (path.endsWith('/me/personal/book')) return json({ error: { code: 'RESOURCE_NOT_FOUND' }, requestId: 'req-fixture' }, 404);
      return json({ data: { items: [{ description: 'Saldo ajeno', outstanding: '999999.00' }] }, requestId: 'req-fixture' });
    }));
    render(<AuthProvider><ObligationsScreen /></AuthProvider>);
    expect(await screen.findByText(/no está en tu rol/)).toBeInTheDocument();
    expect(await screen.findByText(/no está habilitado en esta sesión/)).toBeInTheDocument();
    expect(screen.queryByText('Saldo ajeno')).not.toBeInTheDocument();
    expect(calls.some(path => path.includes('/organizations/'))).toBe(false);
  });

  it('muestra el consolidado incompleto sin unir relaciones', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json({ data: person(['T'], orgId), requestId: 'req-fixture' });
      if (path.endsWith('/me/personal/book')) return json({ data: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', currency: 'COP', status: 'ACTIVE', version: 1 }, requestId: 'req-fixture' }, 200, '"personal"');
      if (path.endsWith('/finance-s09/book')) return json({ data: { id: orgId, currency: 'COP', status: 'ACTIVE', version: 1 }, requestId: 'req-fixture' }, 200, '"negocio"');
      if (path.includes('/private-consolidation')) return json({
        data: { businesses: [{ organizationId: orgId, totals: {} }, { organizationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', totals: {} }], eliminations: [{ relationshipId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', kind: 'CONTRIBUTION', amount: '50.00' }], participations: [], personalTotals: {}, gross: {}, net: {} },
        meta: { scope: 'PRIVATE_CONSOLIDATED', coverage: 'INCOMPLETE', reasons: ['RELATIONSHIP_COUNTERPART_NOT_VISIBLE'] },
        requestId: 'req-fixture',
      });
      return json({ error: { code: 'NOT_FOUND' }, requestId: 'req-fixture' }, 404);
    }));
    const user = userEvent.setup();
    render(<AuthProvider><ObligationsScreen /></AuthProvider>);
    await user.click(await screen.findByRole('button', { name: 'Personal' }));
    await user.click(screen.getByRole('button', { name: 'Ver consolidado privado' }));
    expect(await screen.findByText(/Cobertura incompleta/)).toBeInTheDocument();
    expect(screen.getByText('Negocio 1')).toBeInTheDocument();
    expect(screen.getByText('Negocio 2')).toBeInTheDocument();
    expect(screen.getByText(/no tiene las dos partes visibles/)).toBeInTheDocument();
  });

  it('conserva el intento cuando el pago responde 503', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json({ data: person(['T'], orgId), requestId: 'req-fixture' });
      if (path.endsWith('/me/personal/book')) return json({ error: { code: 'RESOURCE_NOT_FOUND' }, requestId: 'req-fixture' }, 404);
      if (path.endsWith('/finance-s09/book')) return json({ data: { id: orgId, currency: 'COP', status: 'ACTIVE', version: 1 }, requestId: 'req-fixture' }, 200, '"book"');
      if (path.includes('/payments') && init?.method === 'POST') return json({ error: { code: 'SERVICE_UNAVAILABLE' }, requestId: 'req-fixture' }, 503);
      return json({ error: { code: 'NOT_FOUND' }, requestId: 'req-fixture' }, 404);
    }));
    const user = userEvent.setup();
    render(<AuthProvider><ObligationsScreen /></AuthProvider>);
    await user.type(await screen.findByLabelText('Gasto'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    await user.type(screen.getByLabelText('Versión'), '"gasto"');
    await user.type(screen.getByLabelText('Importe del pago'), '10000');
    await user.type(screen.getByLabelText('Cuenta de efectivo o banco'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    await user.type(screen.getByLabelText('Soporte'), 'SYN-PAGO');
    await user.click(screen.getByRole('button', { name: 'Revisar pago' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar pago' }));
    expect(await screen.findByText(/No se confirmó la operación/)).toBeInTheDocument();
    expect(screen.getByLabelText('Importe del pago')).toHaveValue('10000');
  });
});
