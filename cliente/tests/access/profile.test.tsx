import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { AuthProvider } from '../../src/shared/auth';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'PublicKeyCredential');
});

describe('perfil y passkey', () => {
  it('el reenvío es explícito y no parte al montar', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/perfil';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json({ data: { authState: 'EMAIL_REQUIRED', profile: { displayName: 'Nueva', email: 'nueva@example.test', emailVerified: false } }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/email-verifications/request')) {
        expect(JSON.parse(String(init?.body))).toEqual({ purpose: 'ACTIVATION', email: 'nueva@example.test' });
        return json({ data: { code: 'GENERIC_ACCOUNT_ACTION' }, requestId: 'req-fixture' }, 202);
      }
      return json({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'req-fixture' }, 404);
    }));
    render(<AuthProvider><App /></AuthProvider>);
    expect(await screen.findByText('Nombre: Nueva')).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.filter(call => String(call[0]).endsWith('/auth/email-verifications/request'))).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Reenviar enlace de activación' }));
    expect(await screen.findByText(/no dice si el correo existe/i)).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.filter(call => String(call[0]).endsWith('/auth/email-verifications/request'))).toHaveLength(1);
  });

  it('la clave manual se muestra una vez y se borra al ocultarla', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/perfil';
    vi.spyOn(Storage.prototype, 'setItem');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json({ data: { authState: 'MFA_ENROLLMENT', nextAction: 'ENROLL_FIRST_FACTOR', profile: { displayName: 'Nueva', email: 'nueva@example.test', emailVerified: true } }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/mfa/totp/enrollments') && init?.method === 'POST') {
        return json({ data: { enrollmentId: 'enroll-1', provisioningUri: 'otpauth://totp/Caudelyx:nueva@example.test?secret=FIXTURESECRET&issuer=Caudelyx' }, requestId: 'req-fixture' }, 201);
      }
      return json({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'req-fixture' }, 404);
    }));
    const view = render(<AuthProvider><App /></AuthProvider>);
    await user.click(await screen.findByRole('button', { name: 'Preparar factor' }));
    expect(await screen.findByText('FIXTURESECRET')).toBeInTheDocument();
    expect(screen.getByText('Cuenta: nueva@example.test')).toBeInTheDocument();
    expect(screen.getByText('Emisor: Caudelyx')).toBeInTheDocument();
    expect(screen.getByText(/entrada manual/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ocultar y borrar de la pantalla' }));
    expect(screen.queryByText('FIXTURESECRET')).toBeNull();
    view.unmount();
    expect(screen.queryByText('FIXTURESECRET')).toBeNull();
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });

  it('sin API de passkey no ofrece crearla, y una cancelación no cierra la sesión', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/perfil';
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json({ data: { authState: 'MFA_ENROLLMENT', nextAction: 'ENROLL_FIRST_FACTOR', profile: { displayName: 'Nueva', email: 'nueva@example.test', emailVerified: true } }, requestId: 'req-fixture' });
      return json({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'req-fixture' }, 404);
    }));
    const hidden = render(<AuthProvider><App /></AuthProvider>);
    expect(await screen.findByText(/no puede crear una passkey/i)).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Passkey/ })).toBeNull();
    hidden.unmount();

    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    class Credential {}
    vi.stubGlobal('PublicKeyCredential', class extends Credential {
      static isUserVerifyingPlatformAuthenticatorAvailable() { return Promise.resolve(true); }
    });
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: { create: vi.fn().mockRejectedValue(new DOMException('cancelled', 'NotAllowedError')), get: vi.fn() },
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json({ data: { authState: 'MFA_ENROLLMENT', nextAction: 'ENROLL_FIRST_FACTOR', profile: { displayName: 'Nueva', email: 'nueva@example.test', emailVerified: true } }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/mfa/webauthn/registration/options') && init?.method === 'POST') {
        return json({ data: { ceremonyId: 'ceremony-1', publicKey: { challenge: 'AA', rp: { name: 'Caudelyx', id: 'localhost' }, user: { id: 'AA', name: 'nueva@example.test', displayName: 'Nueva' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }] } }, requestId: 'req-fixture' });
      }
      return json({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'req-fixture' }, 404);
    }));
    render(<AuthProvider><App /></AuthProvider>);
    const kind = await screen.findByLabelText('Tipo');
    fireEvent.change(kind, { target: { value: 'WEBAUTHN' } });
    expect(kind).toHaveValue('WEBAUTHN');
    await user.click(screen.getByRole('button', { name: 'Preparar factor' }));
    expect(await screen.findByText(/Se canceló la passkey/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Proteger mi cuenta' })).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).endsWith('/auth/logout'))).toBe(false);
    expect(screen.queryByText(/factor registrado/i)).toBeNull();
  });
});
