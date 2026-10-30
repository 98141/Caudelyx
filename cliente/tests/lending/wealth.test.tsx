import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WealthScreen } from '../../src/features/lending/Wealth';
import { AuthProvider } from '../../src/shared/auth';
import type { Me } from '../../src/shared/contracts';

const orgId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const bankId = '33333333-3333-4333-8333-333333333333';

function person(roles: string[], organizationId?: string): Me {
  return { authState: 'ACTIVE', userId: actorId, organizationId, roleIds: roles, profile: { displayName: 'Persona sintética', email: 'persona@example.test', emailVerified: true } };
}
function json(body: unknown, status = 200, etag?: string): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...(etag ? { ETag: etag } : {}) } });
}

describe('fondos y activos', () => {
  afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); });

  it('separa el libre del reservado y no trata el estimado como caja', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json({ data: person(['T'], orgId), requestId: 'req-fixture' });
      if (path.endsWith('/me/personal/book')) return json({ error: { code: 'RESOURCE_NOT_FOUND' }, requestId: 'req-fixture' }, 404);
      if (path.includes('/availability')) return json({ data: { accountId: bankId, confirmedCash: '20000000.00', legacyProtected: '0.00', fundReserved: '20000000.00', free: '0.00', fundAvailableToConsume: '20000000.00' }, meta: { scope: 'BUSINESS', coverage: 'COMPLETE', reasons: [] }, requestId: 'req-fixture' });
      if (path.includes('/positions')) return json({ data: { recognizedAssetCost: '200000000.00', ownedEstimatedValue: '220000000.00', linkedPrincipal: '120000000.00', indicativeEquity: '100000000.00', cashAvailable: '1000000.00', rentCashReceived: '1000000.00', unvaluedCount: 0 }, meta: { scope: 'BUSINESS', coverage: 'COMPLETE', reasons: [] }, requestId: 'req-fixture' });
      if (path.includes('/assets?')) return json({ data: { items: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', label: 'Apartamento sintético', recognizedCost: '200000000.00', grossCostDeclared: '200000000.00', ownedEstimatedValue: '88000000.00', ownershipPercentage: '40.00', linkedPrincipal: '30000000.00', indicativeEquity: '58000000.00', valuation: { valuationDate: '2026-10-29', method: 'OWNER_ESTIMATE' }, sourceCompleteness: 'INCOMPLETE', reasons: ['PROVENANCE_UNKNOWN'], status: 'ACTIVE', acquisitionEventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }], nextCursor: null }, meta: { scope: 'BUSINESS', coverage: 'INCOMPLETE', reasons: ['PROVENANCE_UNKNOWN'] }, requestId: 'req-fixture' });
      return json({ error: { code: 'NOT_FOUND' }, requestId: 'req-fixture' }, 404);
    }));
    const user = userEvent.setup();
    render(<AuthProvider><WealthScreen /></AuthProvider>);
    await user.type(await screen.findByRole('textbox', { name: /^Cuenta$/ }), bankId);
    await user.click(screen.getByRole('button', { name: 'Consultar disponible' }));
    expect(await screen.findAllByText('20.000.000 COP')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Libre' }).parentElement).toHaveTextContent('0 COP');
    expect(screen.getByText(/no el saldo bruto/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ver posición' }));
    expect(await screen.findByRole('heading', { name: 'Costo reconocido' })).toBeInTheDocument();
    expect(screen.getByText('200.000.000 COP')).toBeInTheDocument();
    expect(screen.getByText('220.000.000 COP')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Caja disponible' }).parentElement).toHaveTextContent('1.000.000 COP');
    await user.click(screen.getByRole('button', { name: 'Ver activos' }));
    expect(await screen.findByText(/Porcentaje declarado/)).toHaveTextContent('40.00');
    expect(screen.getByText(/No es rentabilidad realizada/)).toBeInTheDocument();
    expect(screen.getAllByText(/fuente declarada como incierta/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Adquisición ya registrada/)).toBeInTheDocument();
  });

  it('no consulta el negocio de un colaborador', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      calls.push(path);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json({ data: person(['C'], orgId), requestId: 'req-fixture' });
      if (path.endsWith('/me/personal/book')) return json({ error: { code: 'RESOURCE_NOT_FOUND' }, requestId: 'req-fixture' }, 404);
      return json({ data: { items: [{ label: 'Activo ajeno', recognizedCost: '999.00' }] }, requestId: 'req-fixture' });
    }));
    render(<AuthProvider><WealthScreen /></AuthProvider>);
    expect(await screen.findByText(/no está en tu rol/)).toBeInTheDocument();
    expect(screen.queryByText('Activo ajeno')).not.toBeInTheDocument();
    expect(calls.some(path => path.includes('/organizations/'))).toBe(false);
  });

  it('conserva la reserva cuando la confirmación no se abre', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json({ data: person(['T'], orgId), requestId: 'req-fixture' });
      if (path.endsWith('/me/personal/book')) return json({ error: { code: 'RESOURCE_NOT_FOUND' }, requestId: 'req-fixture' }, 404);
      if (path.endsWith('/wealth-s10/book')) return json({ data: { id: orgId }, requestId: 'req-fixture' }, 200, '"s10-book:11111111-1111-4111-8111-111111111111:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
      return json({ error: { code: 'NOT_FOUND' }, requestId: 'req-fixture' }, 404);
    }));
    const user = userEvent.setup();
    render(<AuthProvider><WealthScreen /></AuthProvider>);
    await user.type(await screen.findByLabelText('Fondo'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    await user.type(screen.getByLabelText('Versión del fondo'), '"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:1"');
    await user.type(screen.getByLabelText('Importe a reservar'), '20000000');
    await user.type(screen.getByRole('textbox', { name: /^Soporte$/ }), 'SYN');
    await user.click(screen.getByRole('button', { name: 'Revisar reserva' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar reserva' }));
    expect(await screen.findByText(/No se confirmó la operación/)).toBeInTheDocument();
    expect(screen.getByLabelText('Importe a reservar')).toHaveValue('20000000');
  });
});
