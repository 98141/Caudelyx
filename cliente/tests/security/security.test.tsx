import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { AuthProvider } from '../../src/shared/auth';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('seguridad con fixture de navegador', () => {
  it('la recuperación restringida no ofrece organización ni guarda la semilla', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/seguridad';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/me')) return json({ data: { authState: 'RECOVERY_RESTRICTED', expiresAt: '2026-10-19T20:00:00Z' }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/mfa/methods')) return json({ data: { items: [], nextCursor: null }, requestId: 'req-fixture' });
      if (path.endsWith('/auth/mfa/totp/enrollments') && init?.method === 'POST') {
        return json({ data: { enrollmentId: 'enroll-1', provisioningUri: 'otpauth://totp/Caudelyx:fixture?secret=FIXTURESECRET', expiresAt: '2026-10-19T20:05:00Z' }, requestId: 'req-fixture' }, 201);
      }
      return json({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'req-fixture' }, 404);
    }));
    vi.spyOn(Storage.prototype, 'setItem');
    render(<AuthProvider><App /></AuthProvider>);
    expect(await screen.findByText(/no hay acceso de negocio/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Organización' })).toBeNull();
    await user.type(screen.getByLabelText('Etiqueta'), ' Fixture');
    await user.click(screen.getByRole('button', { name: 'Preparar factor' }));
    expect(await screen.findByText(/FIXTURESECRET/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ocultar y borrar de la pantalla' }));
    expect(screen.queryByText(/FIXTURESECRET/)).toBeNull();
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });
});
