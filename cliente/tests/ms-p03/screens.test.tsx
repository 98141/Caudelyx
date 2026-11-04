import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { AuthProvider } from '../../src/shared/auth';
import type { Me } from '../../src/shared/contracts';

const orgId = '11111111-1111-4111-8111-111111111111';

function metric(value: string | null, status: 'COMPLETE' | 'UNAVAILABLE') {
  return { value, status, reasons: status === 'UNAVAILABLE' ? ['SOURCE_MISSING'] : [], sourceRefs: [] };
}

const cuts = {
  effectiveDate: '2026-11-03', knownAt: '2026-11-03T14:00:00.000Z', sourceVector: 'ab'.repeat(32),
  mappingVersion: 'map-1', contractVersion: '1.0.0', currency: 'COP', timezone: 'America/Bogota',
};

const monthly = {
  bookId: orgId, scope: 'BUSINESS', month: '2026-11', cuts,
  principal: metric('9000000.00', 'COMPLETE'),
  availableToLend: metric('3255000.00', 'COMPLETE'),
  cash: metric('4010000.00', 'COMPLETE'),
  reserved: metric('755000.00', 'COMPLETE'),
  free: metric('3255000.00', 'COMPLETE'),
  interestExpected: metric('270000.00', 'COMPLETE'),
  interestCashCollected: metric(null, 'UNAVAILABLE'),
  otherIncome: metric(null, 'UNAVAILABLE'),
  fundingTransfers: metric(null, 'UNAVAILABLE'),
  paidExpenses: metric(null, 'UNAVAILABLE'),
  paidDebtInstallments: metric(null, 'UNAVAILABLE'),
  debtSavings: metric(null, 'UNAVAILABLE'),
  baseSurplus: metric(null, 'UNAVAILABLE'),
  distributedSurplus: metric(null, 'UNAVAILABLE'),
  remainingSurplus: metric(null, 'UNAVAILABLE'),
};

function json(body: unknown, status = 200, etag?: string): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (etag) headers.set('ETag', etag);
  return new Response(JSON.stringify(body), { status, headers });
}

function install(me: Me) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-ms-p03' });
    if (path.endsWith('/auth/me')) return json({ data: me, requestId: 'req-ms-p03' });
    if (path.includes('/me/personal/book')) return json({ error: { code: 'NOT_FOUND' }, requestId: 'req-ms-p03' }, 404);
    if (path.includes('/modo-simple/') && path.includes('/monthly') && !path.includes('monthly-loans')) return json(monthly, 200, '"book-etag"');
    if (path.includes('/monthly-loans')) return json({ rows: [], totalCount: 0, nextCursor: null, totalsScope: 'FULL_FILTER', principalTotal: metric(null, 'UNAVAILABLE'), interestExpectedTotal: metric(null, 'UNAVAILABLE'), cuts }, 200, '"book-etag"');
    if (path.includes('/savings-plan')) return json({ bookId: orgId, cuts, startMonth: '2026-11', horizonMonths: 12, rows: [], totalCount: 0, nextCursor: null, totalsScope: 'FULL_FILTER', totalShortfall: metric(null, 'UNAVAILABLE') });
    if (path.includes('/debt-plans') || path.includes('/mappings/')) return json({ rows: [], totalCount: 0, nextCursor: null });
    if (path.includes('/expenses') || path.includes('/funds') || path.includes('/accounts')) return json({ data: { items: [], nextCursor: null }, requestId: 'req-ms-p03' });
    return json({ error: { code: 'NOT_FOUND' }, requestId: 'req-ms-p03' }, 404);
  }));
}

const titular: Me = {
  authState: 'ACTIVE', userId: 'user-1', organizationId: orgId, roleIds: ['T'],
  profile: { displayName: 'Titular sintético', email: 'titular@example.test', emailVerified: true },
};

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('navegación de modo simple', () => {
  it('muestra las siete entradas y conserva el préstamo avanzado con otro nombre accesible', async () => {
    window.location.hash = '#/modo-simple/mes';
    install(titular);
    render(<AuthProvider><App /></AuthProvider>);
    expect(await screen.findByRole('heading', { name: '¿Cómo va este mes?' })).toBeInTheDocument();
    for (const name of ['Mi mes', 'Préstamos, modo simple', 'Cobros, modo simple', 'Mis deudas', 'Gastos, modo simple', 'Caja y apartados', 'Plan de ahorro', 'Seguridad y recuperación']) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument();
    }
    expect(screen.getByText('Modo simple')).toBeInTheDocument();
    expect(screen.getByText('Módulos')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Préstamos' })).toHaveAttribute('href', '#/prestamos');
    expect(await screen.findAllByText('270.000 COP')).toHaveLength(2);
    expect(screen.getAllByText('No disponible').length).toBeGreaterThan(0);
    expect(screen.getByText('No hay sobra por repartir informada. No se usa cero.')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Consolidado, solo consulta' })).toBeInTheDocument();
  });

  it('no ofrece el consolidado a soporte', async () => {
    window.location.hash = '#/modo-simple/mes';
    install({ ...titular, roleIds: ['SA'] });
    render(<AuthProvider><App /></AuthProvider>);
    expect(await screen.findByRole('heading', { name: '¿Cómo va este mes?' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Consolidado, solo consulta' })).not.toBeInTheDocument();
  });
});
