import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoansScreen } from '../../src/features/lending/Loans';
import { OrganizationScreen } from '../../src/features/organization/Organization';
import { AccountCombobox } from '../../src/shared/account-combobox';
import { AuthProvider } from '../../src/shared/auth';
import { FinanceScreen } from '../../src/features/finance/Finance';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const now = Date.parse('2026-10-25T12:00:00.000Z');
const me = {
  authState: 'WORKING',
  sessionContext: 'W',
  userId: 'user-fixture',
  organizationId: 'org-fixture',
  roleIds: ['T'],
  profile: { displayName: 'Ana Fixture', email: 'ana@example.test', emailVerified: true },
  session: {
    serverNow: new Date(now).toISOString(),
    idleExpiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
    absoluteExpiresAt: new Date(now + 12 * 60 * 60 * 1000).toISOString(),
  },
};

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
    if (path.endsWith('/auth/me')) return json({ data: me, requestId: 'req-fixture' });
    if (path.includes('/lending-policy')) return json({ data: { methods: ['CONSTANT_PRINCIPAL'], frequencies: ['MONTH'], quoteTtlSeconds: 900 }, requestId: 'req-fixture' });
    if (path.includes('/borrowers')) return json({ data: { items: [{ id: 'b1', borrowerCode: 'P-1', status: 'ACTIVE', profile: { displayName: 'Persona fixture' } }] }, requestId: 'req-fixture' });
    if (path.includes('/organization/members') || path.includes('/organization/invitations')) return json({ data: { items: [] }, requestId: 'req-fixture' });
    if (path.endsWith('/organization')) return json({ data: { id: 'org-fixture', name: 'Org fixture', timezone: 'America/Bogota', currency: 'COP', status: 'ACTIVE', version: 'v1', actorRoleIds: ['T'] }, requestId: 'req-fixture', etag: 'v1' });
    if (path.includes('/accounts')) return json({ data: { items: [] }, requestId: 'req-fixture' });
    return json({ data: { items: [] }, requestId: 'req-fixture' });
  }));
}

describe('MEJ-3 pantallas', () => {
  beforeEach(() => {
    window.location.hash = '#/finanzas';
    installFetch();
  });

  it('finanzas ofrece las cuatro vistas', async () => {
    const user = userEvent.setup();
    render(<AuthProvider><FinanceScreen /></AuthProvider>);
    expect(await screen.findByRole('tab', { name: 'Resumen' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Cuentas' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Movimientos' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Apertura' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Cuentas' }));
    expect(await screen.findByRole('heading', { name: 'Cuentas' })).toBeInTheDocument();
  });

  it('el combobox elige por teclado sin mostrar el identificador', async () => {
    const user = userEvent.setup();
    const chosen: string[] = [];
    render(
      <AccountCombobox
        label="Cuenta"
        query=""
        onQuery={() => undefined}
        loading={false}
        value=""
        onChange={id => chosen.push(id)}
        options={[
          { id: '11111111-1111-1111-1111-111111111111', code: '1105', name: 'Caja', kindLabel: 'Caja', statusLabel: 'Activa' },
          { id: '22222222-2222-2222-2222-222222222222', code: '1110', name: 'Banco', kindLabel: 'Banco', statusLabel: 'Activa' },
        ]}
      />,
    );
    const box = screen.getByRole('combobox', { name: 'Cuenta' });
    box.focus();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(chosen).toEqual(['22222222-2222-2222-2222-222222222222']);
    expect(screen.queryByText(/11111111-1111/)).toBeNull();
  });

  it('el alta de préstamo tiene tres pasos y capital vacío', async () => {
    const user = userEvent.setup();
    render(<AuthProvider><LoansScreen /></AuthProvider>);
    expect(await screen.findByText('1. Prestatario y capital')).toBeInTheDocument();
    const capital = await screen.findByLabelText('Capital');
    expect(capital).toHaveValue('');
    await user.selectOptions(screen.getByLabelText('Prestatario'), 'b1');
    await user.type(capital, '1000');
    await user.click(screen.getByRole('button', { name: 'Siguiente' }));
    expect(await screen.findByLabelText('Modalidad')).toHaveValue('');
    expect(screen.getByLabelText('Tasa en porcentaje')).toHaveValue('');
  });

  it('organización separa las cuatro secciones y no pide código en el nombre', async () => {
    render(<AuthProvider><OrganizationScreen /></AuthProvider>);
    expect(await screen.findByRole('tab', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Personas' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Invitaciones' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Seguridad' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Código')).toBeNull();
  });
});
