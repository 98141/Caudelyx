import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportingScreen } from '../../src/features/lending/Reporting';
import { AuthProvider } from '../../src/shared/auth';
import type { Me } from '../../src/shared/contracts';

const orgId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const loanId = '77777777-7777-4777-8777-777777777777';

function person(roles: string[]): Me {
  return { authState: 'ACTIVE', userId: actorId, organizationId: orgId, roleIds: roles, profile: { displayName: 'Persona sintética', email: 'persona@example.test', emailVerified: true } };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const meta = {
  currency: 'COP', timezone: 'America/Bogota', asOf: '2026-10-31', recordedThrough: '2026-10-31T17:00:00.000Z',
  from: '2026-10-01', to: '2026-10-31', capturedAt: '2026-10-31T17:00:00.000Z', expiresAt: '2026-10-31T17:05:00.000Z',
  snapshotToken: 'corte-sintetico', scopeKind: 'BUSINESS',
  coverage: { status: 'INCOMPLETE', populationCount: null, unclassifiablePrincipal: '100.00', reasons: ['OPENING_WITHOUT_SCHEDULE'] },
};

function indicator(id: string, kind: string, status: string, value: string | null, extra: Record<string, unknown> = {}) {
  return { id, kind, unit: kind === 'RATIO' ? 'PERCENT' : 'COP', status, value, gross: null, compensations: null, net: null, reasons: status === 'UNAVAILABLE' ? ['MISSING_OBLIGATIONS_S09'] : [], ...extra };
}

function install(role: string, stale = false) {
  let dashboards = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
    if (path.endsWith('/auth/me')) return json({ data: person([role]), requestId: 'req-fixture' });
    if (path.includes('/reporting/policy')) return json({ data: { indicatorIds: ['PRINCIPAL_OUTSTANDING'], reportKinds: role === 'T' ? ['PORTFOLIO', 'MOVEMENTS'] : ['PORTFOLIO'], realUseAllowed: false }, requestId: 'req-fixture' });
    if (path.includes('/reporting/dashboard')) {
      dashboards += 1;
      if (stale && dashboards > 1) return json({ error: { code: 'REPORT_SNAPSHOT_STALE' }, requestId: 'req-fixture' }, 409);
      if (role === 'C') return json({ data: { meta: { ...meta, scopeKind: 'ASSIGNED_PORTFOLIO' }, assignedMetrics: [indicator('PRINCIPAL_OUTSTANDING', 'STOCK', 'COMPLETE', '500000.00')], ownActivityMetrics: [indicator('CUSTODY_CONFIRMED', 'STOCK', 'COMPLETE', '300000.00')] }, requestId: 'req-fixture' });
      return json({ data: { meta, organizationMetrics: [indicator('PRINCIPAL_OUTSTANDING', 'STOCK', 'COMPLETE', '2000000.00'), indicator('PAR30', 'RATIO', 'INCOMPLETE', null), indicator('OBLIGATIONS_COVERAGE', 'RATIO', 'UNAVAILABLE', null), indicator('INTEREST_RECEIVED', 'FLOW', 'COMPLETE', '100000.00', { gross: '100000.00', compensations: '0.00', net: '100000.00' })] }, requestId: 'req-fixture' });
    }
    if (path.includes('/reporting/reports/PORTFOLIO')) return json({ data: { meta, reportKind: 'PORTFOLIO', filterScope: '{}', totalRows: 1, nextCursor: null, items: [{ id: loanId, loanId, borrower: { code: 'P001', name: 'Ana sintética' }, principal: '2000000.00', state: 'ACTIVE' }] }, requestId: 'req-fixture' });
    if (path.includes(`/reporting/loans/${loanId}`)) return json({ data: { meta, position: { id: loanId, loanId, borrower: { code: 'P001', name: 'Ana sintética' } }, indicators: [indicator('PRINCIPAL_OUTSTANDING', 'STOCK', 'COMPLETE', '2000000.00')] }, requestId: 'req-fixture' });
    if (path.includes('/reporting/reports/MOVEMENTS')) return json({ data: { meta, reportKind: 'MOVEMENTS', filterScope: '{}', totalRows: 1, nextCursor: null, items: [{ id: 'mov-1', loanId, effectiveDate: '2026-10-31', amount: '2000000.00', state: 'CONFIRMED' }] }, requestId: 'req-fixture' });
    return json({ error: { code: 'NOT_FOUND' }, requestId: 'req-fixture' }, 404);
  }));
}

describe('informes', () => {
  afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); });

  it('muestra existencias, relaciones incompletas y no fabrica un cero', async () => {
    install('T');
    const user = userEvent.setup();
    render(<AuthProvider><ReportingScreen /></AuthProvider>);
    await user.click(await screen.findByRole('button', { name: 'Consultar el tablero' }));
    expect(await screen.findByRole('heading', { name: 'Organización' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Principal vivo' })).toBeInTheDocument();
    expect(screen.getByText('2.000.000 COP')).toBeInTheDocument();
    expect(screen.getByText('No computable')).toBeInTheDocument();
    expect(screen.getByText('No disponible')).toBeInTheDocument();
    expect(screen.getByText(/Cobertura incompleta/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /excel|pdf|csv/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ver el reporte' }));
    await user.click(await screen.findByRole('button', { name: 'Ver P001' }));
    expect(await screen.findByText(/Mismo corte/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ver movimientos de este préstamo' }));
    expect(await screen.findByRole('table', { name: 'Movimientos' })).toBeInTheDocument();
  });

  it('separa la cartera asignada de la custodia propia', async () => {
    install('C');
    const user = userEvent.setup();
    render(<AuthProvider><ReportingScreen /></AuthProvider>);
    await user.click(await screen.findByRole('button', { name: 'Consultar el tablero' }));
    expect(await screen.findByRole('heading', { name: 'Cartera asignada' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Actividad y custodia propias' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Organización' })).not.toBeInTheDocument();
    expect(screen.getByText('500.000 COP')).toBeInTheDocument();
    expect(screen.getByText('300.000 COP')).toBeInTheDocument();
  });

  it('descarta las cifras cuando el corte queda obsoleto', async () => {
    install('T', true);
    const user = userEvent.setup();
    render(<AuthProvider><ReportingScreen /></AuthProvider>);
    await user.click(await screen.findByRole('button', { name: 'Consultar el tablero' }));
    expect(await screen.findByText('2.000.000 COP')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Consultar el tablero' }));
    expect(await screen.findByText(/Las cifras anteriores no siguen vigentes/)).toBeInTheDocument();
    expect(screen.queryByText('2.000.000 COP')).not.toBeInTheDocument();
  });

  it('traduce el ámbito y la naturaleza vigentes', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json({ data: person(['T']), requestId: 'req-fixture' });
      if (path.includes('/reporting/policy')) return json({ data: { indicatorIds: ['PRINCIPAL_OUTSTANDING'], reportKinds: ['MOVEMENTS'], realUseAllowed: false }, requestId: 'req-fixture' });
      if (path.includes('/reporting/dashboard')) return json({ data: { meta: { ...meta, scopeKind: 'ORGANIZATION' }, organizationMetrics: [indicator('PRINCIPAL_OUTSTANDING', 'STOCK', 'COMPLETE', '1000.00')] }, requestId: 'req-fixture' });
      if (path.includes('/reporting/reports/MOVEMENTS')) return json({ data: { meta: { ...meta, scopeKind: 'ASSIGNED_AND_OWN' }, reportKind: 'MOVEMENTS', filterScope: '{}', totalRows: 1, nextCursor: null, items: [{ id: 'mov-1', nature: 'APPLY_CREDIT', amount: '1000.00', sign: 1 }] }, requestId: 'req-fixture' });
      return json({ error: { code: 'NOT_FOUND' }, requestId: 'req-fixture' }, 404);
    }));
    const user = userEvent.setup();
    render(<AuthProvider><ReportingScreen /></AuthProvider>);
    await user.click(await screen.findByRole('button', { name: 'Consultar el tablero' }));
    expect(await screen.findByText(/Organización\./)).toBeInTheDocument();
    expect(screen.queryByText('Ámbito no reconocido')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ver el reporte' }));
    expect(await screen.findByText(/Cartera asignada y actividad propia/)).toBeInTheDocument();
    expect(screen.getByText(/Aplicación de crédito/)).toBeInTheDocument();
  });
});
