import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { AuthProvider } from '../../src/shared/auth';
import { resetSessionMemory } from '../../src/shared/api';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const uri = 'otpauth://totp/Caudelyx:b@example.test?secret=FIXTURESECRET&issuer=Caudelyx';
const confirmed = {
  authState: 'MFA_ENROLLMENT',
  nextAction: 'ENROLL_FIRST_FACTOR',
  sessionContext: 'B',
  profile: { displayName: 'Persona B', email: 'b@example.test', emailVerified: true, hasFactor: false, version: '"perfil-b"' },
};

afterEach(() => {
  resetSessionMemory();
  vi.unstubAllGlobals();
});

describe('QR local del primer factor', () => {
  it('pide la contraseña, dibuja solo la URI recibida y la borra al salir', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/seguridad';
    const posted: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' } });
      if (path.endsWith('/auth/me')) return json({ data: confirmed });
      if (path.endsWith('/auth/mfa/totp/enrollments') && init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)));
        return json({ data: { enrollmentId: 'enroll-b', provisioningUri: uri } }, 201);
      }
      return json({ error: { code: 'NOT_FOUND' } }, 404);
    }));
    const view = render(<AuthProvider><App /></AuthProvider>);
    await user.type(await screen.findByLabelText('Contraseña actual'), 'fixture-password-local-01');
    await user.click(screen.getByRole('button', { name: 'Preparar factor' }));
    expect(await screen.findByText('FIXTURESECRET')).toBeInTheDocument();
    expect(posted).toEqual([{ label: 'Factor sintético', password: 'fixture-password-local-01' }]);
    const image = screen.queryByRole('img', { name: /Código QR de la misma cuenta/ });
    if (image) expect(image.getAttribute('src')).toMatch(/^data:image\//);
    else expect(screen.getByText(/No se pudo dibujar el QR en este navegador/)).toBeInTheDocument();
    const urls = vi.mocked(fetch).mock.calls.map(call => String(call[0]));
    expect(urls.some(url => /qrserver|chart\.googleapis|quickchart|goqr/i.test(url))).toBe(false);
    expect(document.body.innerHTML.includes('https://')).toBe(false);
    view.unmount();
    expect(screen.queryByText('FIXTURESECRET')).toBeNull();
    expect(document.body.innerHTML.includes(uri)).toBe(false);
  });
});
