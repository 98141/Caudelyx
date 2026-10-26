// MEJ-4 adapted version by Codex; original read-only: organization/p04-v2-organization
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OrganizationScreen } from '../../../src/features/organization/Organization';
import { AuthProvider, useAuth } from '../../../src/shared/auth';

function json(body: unknown, status = 200, etag?: string): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (etag) headers.set('ETag', etag);
  return new Response(JSON.stringify(body), { status, headers });
}

const me = { data: { authState: 'ACTIVE', userId: 'user-1', organizationId: 'org-1' }, requestId: 'req-fixture' };

function organization(actorRoleIds: unknown) {
  return { data: { id: 'org-1', name: 'Casa', timezone: 'America/Bogota', currency: 'COP', status: 'ACTIVE', version: '"version-1"', actorRoleIds }, requestId: 'req-fixture' };
}

function member(userId: string, displayName: string) {
  return { userId, displayName, email: `${userId}@example.test`, roleIds: ['L'], status: 'ACTIVE', version: `"${userId}-version"` };
}

describe('organización P04-v2 con fixture de navegador', () => {
  it('conserva la gestión cuando el actor no está en la página y agrega la siguiente sin duplicar', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      paths.push(path);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json(me);
      if (path.endsWith('/organization')) return json(organization(['A']), 200, '"version-1"');
      if (path.includes('/organization/members')) {
        return path.includes('cursor=')
          ? json({ data: { items: [member('user-9', 'Persona uno'), member('user-21', 'Persona de la página 2')], nextCursor: null }, requestId: 'req-fixture' })
          : json({ data: { items: [member('user-9', 'Persona uno')], nextCursor: 'cursor-2' }, requestId: 'req-fixture' });
      }
      if (path.includes('/organization/invitations')) return json({ data: { items: [], nextCursor: null }, requestId: 'req-fixture' });
      return json({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'req-fixture' }, 404);
    }));
    const user = userEvent.setup();
    render(<AuthProvider><OrganizationScreen /></AuthProvider>);
    await tab('Personas');
    await tab('Invitaciones');
    expect(await screen.findByRole('heading', { name: 'Invitar' })).toBeInTheDocument();
    await tab('Personas');
    expect(screen.getByRole('button', { name: 'Suspender' })).toBeInTheDocument();
    expect(screen.queryByText('Este es tu usuario.')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Titular' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Cargar más personas' }));
    expect(await screen.findByRole('heading', { name: 'Persona de la página 2' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Persona uno' })).toHaveLength(1);
    expect(paths.some(path => path.includes('cursor=cursor-2'))).toBe(true);
  });

  it('cierra la gestión si A09 no trae roles propios válidos, aunque la página muestre al actor como titular', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json(me);
      if (path.endsWith('/organization')) return json({ data: { id: 'org-1', name: 'Casa', timezone: 'America/Bogota', currency: 'COP', status: 'ACTIVE' }, requestId: 'req-fixture' });
      if (path.includes('/organization/members')) return json({ data: { items: [{ ...member('user-1', 'Titular'), roleIds: ['T'] }], nextCursor: null }, requestId: 'req-fixture' });
      if (path.includes('/organization/invitations')) return json({ data: { items: [], nextCursor: null }, requestId: 'req-fixture' });
      return json({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'req-fixture' }, 404);
    }));
    render(<AuthProvider><OrganizationScreen /></AuthProvider>);
    await tab('Personas');
    expect(await screen.findByText(/roles propios válidos/i)).toBeInTheDocument();
    await tab('Invitaciones');
    expect(screen.queryByRole('heading', { name: 'Invitar' })).toBeNull();
    await tab('Personas');
    expect(screen.queryByRole('button', { name: 'Suspender' })).toBeNull();
    expect(screen.getByText('Este es tu usuario.')).toBeInTheDocument();
  });

  it('separa el error de personas de las invitaciones y deshabilita la página siguiente mientras carga', async () => {
    let releaseMembers: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json(me);
      if (path.endsWith('/organization')) return json(organization(['T']), 200, '"version-1"');
      if (path.includes('/organization/members') && path.includes('cursor=')) return new Promise<Response>(resolve => { releaseMembers = resolve; });
      if (path.includes('/organization/members')) return json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'El servicio no está disponible.' }, requestId: 'req-personas' }, 503);
      if (path.includes('/organization/invitations') && !path.includes('cursor=')) return json({ data: { items: [{ id: 'inv-1', email: 'invitado@example.test', roleIds: ['L'], status: 'PENDING', expiresAt: '2026-10-20T00:00:00.000Z', version: '"inv-1"' }], nextCursor: 'cursor-inv' }, requestId: 'req-fixture' });
      if (path.includes('/organization/invitations')) return json({ error: { code: 'INPUT_INVALID', message: 'x' }, requestId: 'req-cursor' }, 422);
      return json({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'req-fixture' }, 404);
    }));
    const user = userEvent.setup();
    render(<AuthProvider><OrganizationScreen /></AuthProvider>);
    await tab('Personas');
    expect(await screen.findByText('invitado@example.test')).toBeInTheDocument();
    expect(screen.getByText(/El servicio no está disponible/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cerrar sesión' })).toBeNull();
    await tab('Invitaciones');
    await user.click(screen.getByRole('button', { name: 'Cargar más invitaciones' }));
    expect(await screen.findByText(/no cumplen el formato exigido/i)).toBeInTheDocument();
    expect(screen.getByText('invitado@example.test')).toBeInTheDocument();
    expect(releaseMembers).toBeUndefined();
  });

  it('envía la versión de la persona consultada y no repite la carga mientras está en curso', async () => {
    const headersSeen: string[] = [];
    let release: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const headers = new Headers(init?.headers);
      if (path.includes('/members/') && init?.method === 'POST') headersSeen.push(headers.get('If-Match') ?? '');
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json(me);
      if (path.endsWith('/organization')) return json(organization(['A']), 200, '"version-1"');
      if (path.includes('/organization/members') && path.includes('cursor=')) return new Promise<Response>(resolve => { release = resolve; });
      if (path.includes('/organization/members') && !path.includes('/members/')) return json({ data: { items: [member('user-9', 'Persona uno')], nextCursor: 'cursor-2' }, requestId: 'req-fixture' });
      if (path.includes('/organization/invitations')) return json({ data: { items: [], nextCursor: null }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/reauthenticate')) return json({ data: { nextAction: 'MFA_CHALLENGE' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/mfa/challenges/verify')) return json({ data: { nextAction: 'READY' }, requestId: 'req-fixture' });
      if (path.includes('/suspend')) return json({ data: { status: 'SUSPENDED', version: '"next"' }, requestId: 'req-fixture' });
      return json({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'req-fixture' }, 404);
    }));
    const user = userEvent.setup();
    render(<AuthProvider><OrganizationScreen /></AuthProvider>);
    await tab('Personas');
    const more = await screen.findByRole('button', { name: 'Cargar más personas' });
    await user.click(more);
    expect(more).toBeDisabled();
    await user.click(more);
    expect(release).toEqual(expect.any(Function));
    release?.(json({ data: { items: [member('user-21', 'Persona de la página 2')], nextCursor: null }, requestId: 'req-fixture' }));
    expect(await screen.findByRole('heading', { name: 'Persona de la página 2' })).toBeInTheDocument();
    const card = screen.getByRole('heading', { name: 'Persona uno' }).closest('article');
    if (!card) throw new Error('missing member card');
    await user.click(within(card).getByRole('button', { name: 'Suspender' }));
    expect(await screen.findByText(/Estado resultante: SUSPENDED/)).toBeInTheDocument();
    expect(headersSeen).toContain('"user-9-version"');
  });

  it('no muestra personas ni acciones mientras A09 sigue pendiente y A11 ya respondió', async () => {
    let releaseOrganization: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json(me);
      if (path.endsWith('/organization')) return new Promise<Response>(resolve => { releaseOrganization = resolve; });
      if (path.includes('/organization/members')) return json({ data: { items: [member('user-9', 'Persona diferida')], nextCursor: null }, requestId: 'req-fixture' });
      if (path.includes('/organization/invitations')) return json({ data: { items: [{ id: 'inv-1', email: 'invitado@example.test', roleIds: ['L'], status: 'PENDING', expiresAt: '2026-10-20T00:00:00.000Z', version: '"inv-1"' }], nextCursor: null }, requestId: 'req-fixture' });
      return json({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'req-fixture' }, 404);
    }));
    render(<AuthProvider><OrganizationScreen /></AuthProvider>);
    await tab('Personas');
    expect(await screen.findByText(/Comprobando tu acceso/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Persona diferida' })).toBeNull();
    await tab('Invitaciones');
    expect(screen.queryByRole('heading', { name: 'Invitar' })).toBeNull();
    await tab('Personas');
    expect(screen.queryByRole('button', { name: 'Suspender' })).toBeNull();
    expect(screen.queryByText('invitado@example.test')).toBeNull();
    releaseOrganization?.(json(organization(['A']), 200, '"version-1"'));
    expect(await screen.findByRole('heading', { name: 'Persona diferida' })).toBeInTheDocument();
    await tab('Invitaciones');
    expect(screen.getByRole('heading', { name: 'Invitar' })).toBeInTheDocument();
    await tab('Personas');
    expect(screen.getByRole('button', { name: 'Suspender' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Titular' })).toBeNull();
  });

  it('si A09 falla, no concede acciones aunque A11 ya haya listado personas', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json(me);
      if (path.endsWith('/organization')) return json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'El servicio no está disponible.' }, requestId: 'req-a09' }, 503);
      if (path.includes('/organization/members')) return json({ data: { items: [member('user-9', 'Persona sin autoridad')], nextCursor: null }, requestId: 'req-fixture' });
      if (path.includes('/organization/invitations')) return json({ data: { items: [], nextCursor: null }, requestId: 'req-fixture' });
      return json({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'req-fixture' }, 404);
    }));
    render(<AuthProvider><OrganizationScreen /></AuthProvider>);
    await tab('Personas');
    expect(await screen.findByText(/El servicio no está disponible/i)).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Persona sin autoridad' })).toBeInTheDocument();
    await tab('Invitaciones');
    expect(screen.queryByRole('heading', { name: 'Invitar' })).toBeNull();
    await tab('Personas');
    expect(screen.queryByRole('button', { name: 'Suspender' })).toBeNull();
  });

  it('un A09 de otro contexto no concede acciones del contexto nuevo', async () => {
    const releases: Array<(response: Response) => void> = [];
    let meCalls = 0;
    let organizationCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) {
        meCalls += 1;
        return json({ data: { authState: 'ACTIVE', userId: 'user-1', organizationId: meCalls === 1 ? 'org-1' : 'org-2' }, requestId: 'req-fixture' });
      }
      if (path.endsWith('/organization')) {
        organizationCalls += 1;
        return new Promise<Response>(resolve => { releases.push(resolve); });
      }
      if (path.includes('/organization/members')) return json({ data: { items: [member('user-9', 'Persona de contexto')], nextCursor: null }, requestId: 'req-fixture' });
      if (path.includes('/organization/invitations')) return json({ data: { items: [], nextCursor: null }, requestId: 'req-fixture' });
      return json({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'req-fixture' }, 404);
    }));
    const user = userEvent.setup();
    function Harness() {
      const { refresh } = useAuth();
      return <><button type="button" onClick={() => void refresh()}>Recargar sesión</button><OrganizationScreen /></>;
    }
    render(<AuthProvider><Harness /></AuthProvider>);
    await tab('Personas');
    await vi.waitFor(() => expect(organizationCalls).toBe(1));
    expect(screen.getByText(/Comprobando tu acceso/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Recargar sesión' }));
    await vi.waitFor(() => expect(organizationCalls).toBe(2));
    releases[1]?.(json({ data: { id: 'org-2', name: 'Casa nueva', timezone: 'America/Bogota', currency: 'COP', status: 'ACTIVE', version: '"version-2"', actorRoleIds: ['A'] }, requestId: 'req-fixture' }, 200, '"version-2"'));
    await tab('General');
    expect(await screen.findByRole('heading', { name: 'Casa nueva' })).toBeInTheDocument();
    await tab('Personas');
    await tab('Invitaciones');
    expect(screen.getByRole('heading', { name: 'Invitar' })).toBeInTheDocument();
    await tab('Personas');
    await tab('Invitaciones');
    expect(screen.queryByRole('checkbox', { name: 'Administrador' })).toBeNull();
    await tab('Personas');
    releases[0]?.(json(organization(['T']), 200, '"version-1"'));
    await new Promise(resolve => setTimeout(resolve, 20));
    await tab('General');
    expect(screen.getByRole('heading', { name: 'Casa nueva' })).toBeInTheDocument();
    await tab('Personas');
    await tab('General');
    expect(screen.queryByRole('heading', { name: 'Casa' })).toBeNull();
    await tab('Personas');
    await tab('Invitaciones');
    expect(screen.queryByRole('checkbox', { name: 'Administrador' })).toBeNull();
    await tab('Personas');
    expect(screen.queryByRole('checkbox', { name: 'Titular' })).toBeNull();
  });
});

// Unit boundary only. Actual factor/HTTP authority is exercised by MEJ4 HTTPS/E2E.
vi.mock('../../../src/shared/step-up', () => ({ensureStepUp: vi.fn().mockResolvedValue(undefined), StepUpProvider: ({children}: {children: unknown}) => children}));

async function tab(name: string) { await userEvent.click(await screen.findByRole('tab', {name})); }
