import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { call } from '../../src/shared/api';
import { AuthProvider, useAuth } from '../../src/shared/auth';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function session(authState: string, extra: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    authState,
    sessionContext: authState === 'WORKING' || authState === 'WORKING_NO_ORG' ? 'W' : 'S',
    userId: 'user-fixture',
    profile: { displayName: 'Ana Fixture', email: 'ana@example.test', emailVerified: true },
    session: {
      serverNow: new Date(now).toISOString(),
      idleExpiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
      absoluteExpiresAt: new Date(now + 12 * 60 * 60 * 1000).toISOString(),
    },
    ...extra,
  };
}

function installFetch(handler: (path: string, init?: RequestInit) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
    return handler(path, init);
  }));
}

function Probe() {
  const { me } = useAuth();
  return (
    <button type="button" onClick={() => void call('POST', '/organizations/org-fixture/financial/journals', {}).catch(() => undefined)}>
      {me?.profile?.displayName ?? 'nadie'}
    </button>
  );
}

describe('MEJ-3 acceso', () => {
  beforeEach(() => {
    window.location.hash = '#/ingresar';
  });

  it('la hidratación no muestra el formulario y el menú privado a la vez', async () => {
    let release: (value: Response) => void = () => undefined;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    installFetch(path => path.endsWith('/auth/me') ? pending as unknown as Response : json({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'req-fixture' }, 404));
    render(<AuthProvider><App /></AuthProvider>);
    expect(screen.getByRole('status')).toHaveTextContent(/Cargando sesión/i);
    expect(screen.queryByRole('button', { name: 'Iniciar sesión' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Secciones' })).toBeNull();
    release(json({ error: { code: 'AUTH_INVALID', message: 'sin sesión' }, requestId: 'req-fixture' }, 401));
    expect(await screen.findByRole('button', { name: 'Iniciar sesión' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Secciones' })).toBeNull();
  });

  it('la contraseña con sesión W abre Inicio', async () => {
    installFetch(path => {
      if (path.endsWith('/auth/me')) return json({ data: session('WORKING', { organizationId: 'org-fixture' }), requestId: 'req-fixture' });
      return json({ data: { items: [] }, requestId: 'req-fixture' });
    });
    render(<AuthProvider><App /></AuthProvider>);
    expect(await screen.findByRole('heading', { name: 'Inicio' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Secciones' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Iniciar sesión' })).toBeNull();
  });

  it('un cierre remoto fallido no rehidrata la cuenta', async () => {
    const user = userEvent.setup();
    installFetch(path => {
      if (path.endsWith('/auth/logout')) return json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'no' }, requestId: 'req-fixture' }, 503);
      if (path.endsWith('/auth/me')) return json({ data: session('WORKING', { organizationId: 'org-fixture' }), requestId: 'req-fixture' });
      return json({ data: { items: [] }, requestId: 'req-fixture' });
    });
    render(<AuthProvider><App /></AuthProvider>);
    await screen.findByRole('heading', { name: 'Inicio' });
    await user.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    expect(await screen.findByText(/No se pudo confirmar el cierre/i)).toBeInTheDocument();
    expect(screen.queryByText('Hola, Ana Fixture')).toBeNull();
    expect(window.location.hash).toContain('salida=pendiente');
  });

  it('401 de factor no cierra la sesión y 401 de sesión sí', async () => {
    const user = userEvent.setup();
    let factor = true;
    installFetch(path => {
      if (path.endsWith('/auth/me')) return json({ data: session('WORKING', { organizationId: 'org-fixture' }), requestId: 'req-fixture' });
      if (path.includes('/financial/journals')) {
        const code = factor ? 'MFA_INVALID' : 'AUTH_INVALID';
        return json({ error: { code, message: code }, requestId: 'req-fixture' }, 401);
      }
      return json({ data: { items: [] }, requestId: 'req-fixture' });
    });
    render(<AuthProvider><Probe /></AuthProvider>);
    expect(await screen.findByRole('button', { name: 'Ana Fixture' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ana Fixture' }));
    expect(await screen.findByRole('button', { name: 'Ana Fixture' })).toBeInTheDocument();
    factor = false;
    await user.click(screen.getByRole('button', { name: 'Ana Fixture' }));
    expect(await screen.findByRole('button', { name: 'nadie' })).toBeInTheDocument();
  });
});
