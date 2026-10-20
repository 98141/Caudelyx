import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OrganizationScreen } from '../../src/features/organization/Organization';
import { AuthProvider } from '../../src/shared/auth';
import { messageFor } from '../../src/shared/contracts';

function json(body: unknown, status = 200, etag?: string): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (etag) headers.set('ETag', etag);
  return new Response(JSON.stringify(body), { status, headers });
}

const me = { data: { authState: 'ACTIVE', userId: 'user-1', organizationId: 'org-1' }, requestId: 'req-fixture' };
const organization = { data: { id: 'org-1', name: 'Casa', timezone: 'America/Bogota', currency: 'COP', status: 'ACTIVE', version: '"version-1"', actorRoleIds: ['T'] }, requestId: 'req-fixture' };
const titular = { data: { items: [{ userId: 'user-1', displayName: 'Titular', email: 'titular@example.test', roleIds: ['T'], status: 'ACTIVE', version: '"member-1"' }], nextCursor: null }, requestId: 'req-fixture' };

describe('organización con fixture de navegador', () => {
  it('prepara el comando antes del factor y reutiliza el mismo cuerpo', async () => {
    const calls: { path: string; body: string; idempotency: string | null }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ path, body: String(init?.body ?? ''), idempotency: headers.get('Idempotency-Key') });
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json({ data: { authState: 'AUTHENTICATED_NO_ORG', userId: 'user-1' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/reauthenticate')) return json({ data: { nextAction: 'MFA_CHALLENGE' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/mfa/challenges/verify')) return json({ data: { nextAction: 'READY' }, requestId: 'req-fixture' });
      if (path.endsWith('/organizations')) return json({ data: { organization: organization.data, userId: 'user-1', roleIds: ['T'] }, requestId: 'req-fixture' }, 201, '"version-1"');
      return json({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'req-fixture' }, 404);
    }));
    const user = userEvent.setup();
    render(<AuthProvider><OrganizationScreen /></AuthProvider>);
    await user.type(await screen.findByLabelText('Nombre'), 'Casa');
    await user.type(screen.getByLabelText('Contraseña actual'), 'synthetic-local-passphrase-01');
    await user.type(screen.getByLabelText('Código TOTP vigente'), '123456');
    await user.click(screen.getByRole('button', { name: 'Crear organización' }));
    await screen.findByText(/segunda organización no está permitida/i);
    const paths = calls.map(call => call.path);
    const reauth = paths.findIndex(path => path.endsWith('/auth/reauthenticate'));
    const verify = paths.findIndex(path => path.endsWith('/auth/mfa/challenges/verify'));
    const create = paths.findIndex(path => path.endsWith('/organizations'));
    expect(reauth).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(reauth);
    expect(create).toBeGreaterThan(verify);
    const command = JSON.parse(calls[reauth]?.body ?? '{}') as { command: { name: string } };
    expect(command.command).toEqual({ name: 'Casa', timezone: 'America/Bogota', currency: 'COP' });
    expect(calls[create]?.body).toBe(JSON.stringify(command.command));
    expect((calls[create]?.idempotency ?? '').length).toBeGreaterThanOrEqual(16);
  });

  it('informa 403 de gestión sin tratarlo como cierre de sesión y muestra 412', async () => {
    let denyMembers = true;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json(me);
      if (path.endsWith('/organization/members')) {
        return denyMembers
          ? json({ error: { code: 'ACCESS_DENIED', message: 'El servicio no está disponible.' }, requestId: 'req-fixture' }, 403)
          : json(titular);
      }
      if (path.endsWith('/organization/invitations')) return json({ data: { items: [], nextCursor: null }, requestId: 'req-fixture' });
      if (path.endsWith('/organization') && !path.includes('members')) return json(organization, 200, '"version-1"');
      return json({ error: { code: 'PRECONDITION_FAILED', message: 'x' }, requestId: 'req-fixture' }, 412);
    }));
    render(<AuthProvider><OrganizationScreen /></AuthProvider>);
    expect(await screen.findByText(/sin permiso/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cerrar sesión' })).toBeNull();
    expect(messageFor('PRECONDITION_REQUIRED', 428)).toMatch(/428/);
    expect(messageFor('PRECONDITION_FAILED', 412)).toMatch(/412/);
    denyMembers = false;
  });

  it('no ofrece el rol titular en el formulario', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json(me);
      if (path.endsWith('/organization/members')) return json(titular);
      if (path.endsWith('/organization/invitations')) return json({ data: { items: [], nextCursor: null }, requestId: 'req-fixture' });
      if (path.endsWith('/organization')) return json(organization, 200, '"version-1"');
      return json({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'req-fixture' }, 404);
    }));
    render(<AuthProvider><OrganizationScreen /></AuthProvider>);
    expect(await screen.findByRole('checkbox', { name: 'Administrador' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Titular' })).toBeNull();
    expect(screen.queryByText(/recuperación/i)).toBeNull();
  });
});
