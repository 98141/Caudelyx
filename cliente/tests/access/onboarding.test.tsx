import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { ActivateScreen } from '../../src/features/profile/Profile';
import { AuthProvider } from '../../src/shared/auth';
import { captureActivationLink, clearActivationLink } from '../../src/shared/activation-link';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const token = 'C'.repeat(43);

describe('recorrido de primer acceso con fixture de navegador', () => {
  it('tras el registro muestra el perfil del intento sin revelar si la cuenta existe', async () => {
    const user = userEvent.setup();
    let registered = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) {
        if (!registered) return json({ error: { code: 'AUTH_INVALID', message: 'x' }, requestId: 'req-fixture' }, 401);
        return json({ data: { authState: 'EMAIL_REQUIRED', profile: { displayName: 'Persona alta', email: 'alta@example.test', emailVerified: false } }, requestId: 'req-fixture' });
      }
      if (path.endsWith('/auth/register')) {
        registered = true;
        const body = JSON.parse(String(init?.body)) as { mode?: string; password?: string };
        expect(body.mode).toBe('PROFILE');
        expect(body.password).toBe('fixture-password-local-01');
        return json({ data: { code: 'GENERIC_ACCOUNT_ACTION' }, requestId: 'req-fixture' }, 202);
      }
      return json({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'req-fixture' }, 404);
    }));
    window.location.hash = '#/registro';
    render(<AuthProvider><App /></AuthProvider>);
    await user.type(await screen.findByLabelText('Correo'), 'alta@example.test');
    await user.type(screen.getByLabelText('Nombre visible'), 'Persona alta');
    await user.type(screen.getByLabelText('Contraseña'), 'fixture-password-local-01');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));
    expect(await screen.findByRole('heading', { name: 'Perfil' })).toBeInTheDocument();
    expect(screen.getByText('Activa tu cuenta para continuar.')).toBeInTheDocument();
    expect(screen.getByText('Nombre: Persona alta')).toBeInTheDocument();
    expect(screen.getByText('Correo: alta@example.test')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ya tengo cuenta: ingresar' })).toHaveAttribute('href', '#/ingresar');
    expect(screen.queryByText(/example\.test existe/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Preparar factor' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Organización' })).toBeNull();
    expect(vi.mocked(fetch).mock.calls.filter(call => String(call[0]).endsWith('/auth/email-verifications/request'))).toHaveLength(0);
    expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).endsWith('/auth/login'))).toBe(false);
  });

  it('el enlace moderno no pide otra contraseña y el intento ausente sí la pide después de confirmar', async () => {
    const user = userEvent.setup();
    clearActivationLink();
    window.history.replaceState(null, '', `/#/activar?purpose=ACTIVATION&token=${token}&legacy=1`);
    captureActivationLink();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json({ data: { authState: 'EMAIL_REQUIRED', profile: { displayName: 'Persona alta', email: 'alta@example.test', emailVerified: false } }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/email-verifications/confirm')) {
        const body = JSON.parse(String(init?.body)) as { mode?: string; newPassword?: string; token?: string };
        expect(body.mode).toBe('LINK');
        expect(body.newPassword).toBeUndefined();
        expect(body.token).toBe(token);
        return json({ data: { authState: 'MFA_ENROLLMENT', nextAction: 'ENROLL_FIRST_FACTOR' }, requestId: 'req-fixture' });
      }
      return json({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'req-fixture' }, 404);
    }));
    const view = render(<AuthProvider><ActivateScreen /></AuthProvider>);
    expect(window.location.hash).toBe('#/activar');
    expect(window.location.href.includes(token)).toBe(false);
    await user.click(await screen.findByRole('button', { name: 'Activar cuenta' }));
    expect(screen.queryByLabelText('Contraseña nueva')).toBeNull();
    view.unmount();
    clearActivationLink();

    window.history.replaceState(null, '', `/#/activar?purpose=ACTIVATION&token=${token}`);
    captureActivationLink();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json({ error: { code: 'AUTH_INVALID', message: 'x' }, requestId: 'req-fixture' }, 401);
      return json({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'req-fixture' }, 404);
    }));
    render(<AuthProvider><ActivateScreen /></AuthProvider>);
    expect(screen.queryByLabelText('Contraseña nueva')).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Crear contraseña inicial' }));
    expect(await screen.findByLabelText('Contraseña nueva')).toBeInTheDocument();
    clearActivationLink();
  });

  it('sin el alta del factor no se ofrece enrolar', async () => {
    window.location.hash = '#/seguridad';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json({ data: { authState: 'MFA_ENROLLMENT', expiresAt: '2026-10-20T20:00:00Z' }, requestId: 'req-fixture' });
      return json({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'req-fixture' }, 404);
    }));
    render(<AuthProvider><App /></AuthProvider>);
    expect(await screen.findByRole('heading', { name: 'Proteger mi cuenta' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pedir enlace de protección' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preparar factor' })).toBeNull();
    expect(screen.queryByRole('button', { name: /omitir/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Sesiones' })).toBeNull();
  });

  it('con el alta del factor se puede preparar y no se ofrece omitir', async () => {
    window.location.hash = '#/perfil';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json({ data: { authState: 'MFA_ENROLLMENT', nextAction: 'ENROLL_FIRST_FACTOR', profile: { displayName: 'Persona alta', email: 'alta@example.test', emailVerified: true } }, requestId: 'req-fixture' });
      return json({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'req-fixture' }, 404);
    }));
    render(<AuthProvider><App /></AuthProvider>);
    expect(await screen.findByRole('heading', { name: 'Proteger mi cuenta' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preparar factor' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /omitir/i })).toBeNull();
    expect(screen.queryByText(/\brealm\b/i)).toBeNull();
  });
});
