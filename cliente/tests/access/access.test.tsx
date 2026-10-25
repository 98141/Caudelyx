import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { RegisterForm, ResetForm } from '../../src/features/access/Access';
import { AuthProvider } from '../../src/shared/auth';
import { A19_WARNING } from '../../src/shared/contracts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetch(handler: (path: string, init?: RequestInit) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
    if (path.endsWith('/auth/me')) return json({ error: { code: 'AUTH_INVALID', message: 'El servicio no está disponible.' }, requestId: 'req-fixture' }, 401);
    return handler(path, init);
  }));
  vi.spyOn(Storage.prototype, 'setItem');
}

describe('acceso con fixture de navegador', () => {
  beforeEach(() => {
    window.location.hash = '#/registro';
    installFetch(() => json({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'req-fixture' }, 404));
  });

  it('el registro pide la contraseña, no la guarda y no anuncia una sesión', async () => {
    const user = userEvent.setup();
    installFetch((path) => path.endsWith('/auth/register')
      ? json({ data: { code: 'GENERIC_ACCOUNT_ACTION' }, requestId: 'req-fixture' }, 202)
      : json({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'req-fixture' }, 404));
    render(<AuthProvider><RegisterForm /></AuthProvider>);
    await user.type(screen.getByLabelText('Correo'), 'fixture@example.test');
    await user.type(screen.getByLabelText('Nombre visible'), 'Persona fixture');
    const typed = 'fixture-password-local-01 ';
    await user.click(screen.getByLabelText('Contraseña'));
    await user.paste(typed);
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));
    expect(await screen.findByText(/El alta no abrió el perfil en este navegador/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Mi cuenta' })).toBeNull();
    expect(screen.queryByText(/sesión de negocio abierta/i)).toBeNull();
    expect(screen.queryByText(/cuenta creada/i)).toBeNull();
    const registerCall = vi.mocked(fetch).mock.calls.find(call => String(call[0]).endsWith('/auth/register'));
    const body = JSON.parse(String(registerCall?.[1]?.body)) as { mode?: string; password?: string };
    expect(body.mode).toBe('PROFILE');
    expect(body.password).toBe(typed);
    expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).endsWith('/auth/login'))).toBe(false);
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue(typed)).toBeNull();
  });

  it('sin red no confirma el registro', async () => {
    const user = userEvent.setup();
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
    render(<AuthProvider><RegisterForm /></AuthProvider>);
    await user.type(screen.getByLabelText('Correo'), 'offline@example.test');
    await user.type(screen.getByLabelText('Nombre visible'), 'Sin red');
    await user.type(screen.getByLabelText('Contraseña'), 'fixture-password-local-01');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no se guardó nada/i);
    expect(screen.queryByText(/solicitud recibida/i)).toBeNull();
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
  });

  it('muestra el aviso A19 exacto antes de confirmar el restablecimiento', async () => {
    const user = userEvent.setup();
    installFetch((path, init) => {
      if (!path.endsWith('/auth/password-reset/confirm')) return json({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'req-fixture' }, 404);
      const body = JSON.parse(String(init?.body)) as { mode: string };
      if (body.mode === 'PREVIEW') return json({ data: { warningRequired: true, warningMessage: A19_WARNING }, requestId: 'req-fixture' });
      return json({ data: { nextAction: 'LOGIN' }, requestId: 'req-fixture' });
    });
    render(<AuthProvider><ResetForm /></AuthProvider>);
    await user.type(screen.getByLabelText('Código de restablecimiento'), 'A'.repeat(43));
    await user.click(screen.getByRole('button', { name: 'Previsualizar aviso' }));
    expect(await screen.findByText(A19_WARNING)).toBeInTheDocument();
  });

  it('la contraseña sola deja el reto MFA y no abre organización', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/ingresar';
    installFetch((path) => path.endsWith('/auth/login')
      ? json({ data: { authState: 'MFA_REQUIRED', nextAction: 'MFA_CHALLENGE' }, requestId: 'req-fixture' })
      : json({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'req-fixture' }, 404));
    render(<AuthProvider><App /></AuthProvider>);
    await user.type(await screen.findByLabelText('Correo'), 'factor@example.test');
    await user.type(screen.getByLabelText('Contraseña'), 'synthetic-local-passphrase-01');
    await user.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    expect(await screen.findByText(/no hay sesión de negocio/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Organización' })).toBeNull();
  });

  it('muestra el acceso social deshabilitado y no llama a un proveedor', async () => {
    window.location.hash = '#/ingresar';
    render(<AuthProvider><App /></AuthProvider>);
    const google = await screen.findByRole('button', { name: /Continuar con Google/i });
    const facebook = screen.getByRole('button', { name: /Continuar con Facebook/i });
    expect(google).toBeDisabled();
    expect(facebook).toBeDisabled();
    expect(google).toHaveTextContent('Próximamente');
    expect(facebook).toHaveTextContent('Próximamente');
    expect(screen.getByRole('heading', { name: 'Bienvenido de nuevo' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Regístrate' })).toHaveAttribute('href', '#/registro');
    expect(screen.getByRole('link', { name: 'Olvidé la contraseña' })).toHaveAttribute('href', '#/restablecer');
    expect(screen.getByText('Cifras de demostración. No son datos de una cartera real.')).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(call => /google|facebook/i.test(String(call[0])))).toBe(false);
  });
});
