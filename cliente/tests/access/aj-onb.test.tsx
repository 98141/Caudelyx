import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { AuthProvider } from '../../src/shared/auth';
import { captureActivationLink, clearActivationLink } from '../../src/shared/activation-link';
import { resetSessionMemory } from '../../src/shared/api';

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const basic = {
  authState: 'PENDING_EMAIL',
  sessionContext: 'B',
  profile: {
    displayName: 'Persona B',
    email: 'persona.b@example.test',
    emailVerified: false,
    createdAt: '2026-10-23T20:00:00.000Z',
    hasFactor: false,
    version: '"perfil-b"',
  },
};

afterEach(() => {
  clearActivationLink();
  resetSessionMemory();
  vi.unstubAllGlobals();
});

describe('AJ-ONB menú, alta, perfil, rechazo y restablecimiento', () => {
  it('con sesión B oculta Ingresar y Crear cuenta y saluda', async () => {
    window.location.hash = '#/perfil';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' } });
      if (path.endsWith('/auth/me')) return json({ data: basic });
      return json({ error: { code: 'NOT_FOUND' } }, 404);
    }));
    render(<AuthProvider><App /></AuthProvider>);
    const nav = await screen.findByRole('navigation', { name: 'Secciones' });
    expect(await screen.findByText('Hola, Persona B')).toBeInTheDocument();
    expect(nav.querySelector('a[href="#/ingresar"]')).toBeNull();
    expect(nav.querySelector('a[href="#/registro"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument();
    expect(screen.getByText('Correo sin confirmar')).toBeInTheDocument();
    expect(screen.getByText('Falta segundo factor')).toBeInTheDocument();
    expect(screen.getByText(/Fecha de alta/)).toBeInTheDocument();
    expect(screen.queryByText('Sesión de organización activa.')).toBeNull();
    expect(screen.getByText('Esta sesión no abre organizaciones ni finanzas.')).toBeInTheDocument();
  });

  it('un alta 200 con sesión B abre el perfil y oculta el menú público', async () => {
    const user = userEvent.setup();
    let registered = false;
    window.location.hash = '#/registro';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' } });
      if (path.endsWith('/auth/me')) {
        if (!registered) return json({ error: { code: 'AUTH_INVALID' } }, 401);
        return json({ data: basic });
      }
      if (path.endsWith('/auth/register')) {
        registered = true;
        return json({ data: { authState: 'PENDING_EMAIL', nextAction: 'VERIFY_EMAIL', sessionContext: 'B' } });
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404);
    }));
    render(<AuthProvider><App /></AuthProvider>);
    await user.type(await screen.findByLabelText('Correo'), 'nueva.b@example.test');
    await user.type(screen.getByLabelText('Nombre visible'), 'Persona B');
    await user.type(screen.getByLabelText('Contraseña'), 'fixture-password-local-01');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));
    expect(await screen.findByRole('heading', { name: 'Mi cuenta' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Secciones' });
    expect(nav.querySelector('a[href="#/ingresar"]')).toBeNull();
    expect(nav.querySelector('a[href="#/registro"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument();
  });

  it('409 no abre sesión y muestra el mensaje aprobado', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/registro';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' } });
      if (path.endsWith('/auth/me')) return json({ error: { code: 'AUTH_INVALID' } }, 401);
      if (path.endsWith('/auth/register')) return json({ error: { code: 'ACCOUNT_ALREADY_EXISTS' } }, 409);
      if (path.endsWith('/auth/login')) return json({ error: { code: 'NOT_FOUND' } }, 404);
      return json({ error: { code: 'NOT_FOUND' } }, 404);
    }));
    render(<AuthProvider><App /></AuthProvider>);
    await user.type(await screen.findByLabelText('Correo'), 'existe@example.test');
    await user.type(screen.getByLabelText('Nombre visible'), 'Persona');
    await user.type(screen.getByLabelText('Contraseña'), 'fixture-password-local-01');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));
    expect(await screen.findByText('Ya existe una cuenta con ese correo. Ingresa o restablece la contraseña.')).toBeInTheDocument();
    const loginLinks = screen.getAllByRole('link', { name: 'Ingresar' });
    expect(loginLinks.length).toBeGreaterThan(0);
    expect(loginLinks.every(link => link.getAttribute('href') === '#/ingresar')).toBe(true);
    expect(screen.getByRole('link', { name: 'Restablecer la contraseña' })).toHaveAttribute('href', '#/restablecer');
    expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).endsWith('/auth/login'))).toBe(false);
    expect(screen.queryByRole('heading', { name: 'Mi cuenta' })).toBeNull();
  });

  it('guarda el nombre propio con la versión recibida', async () => {
    window.location.hash = '#/perfil';
    const patches: { body: unknown; match: string | null }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' } });
      if (path.endsWith('/auth/me')) return json({ data: basic });
      if (path.endsWith('/auth/profile') && init?.method === 'PATCH') {
        patches.push({ body: JSON.parse(String(init.body)), match: new Headers(init.headers).get('If-Match') });
        return json({ data: { ...basic.profile, displayName: 'Persona nueva' } });
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404);
    }));
    render(<AuthProvider><App /></AuthProvider>);
    await userEvent.click(await screen.findByRole('button', { name: 'Editar información' }));
    const field = await screen.findByLabelText('Nombre completo');
    fireEvent.change(field, { target: { value: 'Persona nueva' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(patches).toEqual([{ body: { displayName: 'Persona nueva' }, match: '"perfil-b"' }]);
  });

  it('No fui yo no se envía al abrir y el POST no usa GET', async () => {
    const user = userEvent.setup();
    const token = 'R'.repeat(43);
    window.history.replaceState(null, '', `/#/rechazar?purpose=REJECT&token=${token}`);
    captureActivationLink();
    const methods: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/auth/registrations/reject')) {
        methods.push(init?.method ?? 'GET');
        expect(JSON.parse(String(init?.body))).toEqual({ token });
        return new Response(null, { status: 204 });
      }
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' } });
      if (path.endsWith('/auth/me')) return json({ error: { code: 'AUTH_INVALID' } }, 401);
      return json({ error: { code: 'NOT_FOUND' } }, 404);
    }));
    render(<AuthProvider><App /></AuthProvider>);
    expect(await screen.findByRole('button', { name: 'No fui yo' })).toBeInTheDocument();
    expect(methods).toEqual([]);
    expect(window.location.href.includes(token)).toBe(false);
    await user.click(screen.getByRole('button', { name: 'No fui yo' }));
    expect(await screen.findByText(/La solicitud quedó anulada/)).toBeInTheDocument();
    expect(methods).toEqual(['POST']);
  });

  it('la vista previa sin aviso de bloqueo no confirma por GET', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/restablecer';
    const calls: { method: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' } });
      if (path.endsWith('/auth/me')) return json({ error: { code: 'AUTH_INVALID' } }, 401);
      if (path.endsWith('/auth/password-reset/confirm')) {
        calls.push({ method: init?.method ?? 'GET', body: JSON.parse(String(init?.body)) });
        return json({ data: { warningRequired: false, warningMessage: null } });
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404);
    }));
    render(<AuthProvider><App /></AuthProvider>);
    await user.type(await screen.findByLabelText('Código de restablecimiento'), 'T'.repeat(43));
    await user.click(screen.getByRole('button', { name: 'Previsualizar aviso' }));
    expect(await screen.findByText(/El servidor no pidió el aviso de bloqueo/)).toBeInTheDocument();
    expect(calls).toEqual([{ method: 'POST', body: { mode: 'PREVIEW', token: 'T'.repeat(43) } }]);
    expect(calls.some(call => call.method === 'GET')).toBe(false);
  });

  it('organización y finanzas en B no consultan negocio', async () => {
    window.location.hash = '#/organizacion';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' } });
      if (path.endsWith('/auth/me')) return json({ data: basic });
      if (path.includes('/organization') || path.includes('/financial')) return json({ data: { name: 'No debe leerse' } });
      return json({ error: { code: 'NOT_FOUND' } }, 404);
    }));
    const view = render(<AuthProvider><App /></AuthProvider>);
    expect(await screen.findByRole('heading', { name: 'Protege tu cuenta' })).toBeInTheDocument();
    expect(screen.queryByText('No debe leerse')).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).includes('/organization') || String(call[0]).includes('/financial'))).toBe(false);
    view.unmount();
    window.location.hash = '#/finanzas';
    render(<AuthProvider><App /></AuthProvider>);
    expect(await screen.findByRole('heading', { name: 'Protege tu cuenta' })).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).includes('/organization') || String(call[0]).includes('/financial'))).toBe(false);
  });
});
