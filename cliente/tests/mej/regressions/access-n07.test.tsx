// MEJ-4 adapted version by Codex; original read-only: access/n07-activation
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../src/app/App';
import { AuthProvider } from '../../../src/shared/auth';
import { resetSessionMemory } from '../../../src/shared/api';
import { captureActivationLink, clearActivationLink, peekActivation } from '../../../src/shared/activation-link';
import type { Me } from '../../../src/shared/contracts';

const TOKEN = 'N'.repeat(43);
const PASSWORD = 'synthetic initial password N07 12345';
const provisional: Me = { authState: 'EMAIL_REQUIRED', profile: { displayName: 'Persona N07', email: 'n07@example.test', emailVerified: false } };
const verified: Me = { authState: 'MFA_ENROLLMENT', nextAction: 'ENROLL_FIRST_FACTOR', profile: { displayName: 'Persona N07', email: 'n07@example.test', emailVerified: true } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function cleanSurface() {
  expect(document.body.innerHTML.includes(TOKEN)).toBe(false);
  expect(window.location.href.includes(TOKEN)).toBe(false);
  expect(localStorage.length + sessionStorage.length).toBe(0);
}

function mount(linkFailure: 'token' | 'network' | 'service' | 'auth' | 'invite' = 'token', legacyFails = false, initial = false) {
  resetSessionMemory();
  clearActivationLink();
  let me = initial ? { authState: 'MFA_ENROLLMENT' as const } : provisional;
  window.history.replaceState(null, '', `/#/activar?purpose=${initial ? 'INITIAL_MFA_PROOF' : 'ACTIVATION'}&token=${TOKEN}`);
  captureActivationLink();
  const submissions: { body: Record<string, unknown>; credentials: RequestCredentials | undefined; csrf: string | null }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'current-P-csrf' } });
    if (path.endsWith('/auth/me')) return json({ data: me });
    if (path.endsWith('/auth/email-verifications/confirm')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      submissions.push({ body, credentials: init?.credentials, csrf: new Headers(init?.headers).get('X-CSRF-Token') });
      if (body.mode === 'LINK' || initial) {
        if (linkFailure === 'network') throw new TypeError('Synthetic network failure');
        if (linkFailure === 'invite') return json({ error: { code: 'INPUT_INVALID', message: 'El servidor pidió la contraseña de la invitación.' } }, 422);
        const status = linkFailure === 'service' ? 503 : 401;
        const code = linkFailure === 'service' ? 'SERVICE_UNAVAILABLE' : linkFailure === 'auth' ? 'AUTH_INVALID' : 'TOKEN_INVALID';
        return json({ error: { code } }, status);
      }
      if (legacyFails) return json({ error: { code: 'TOKEN_INVALID' } }, 401);
      me = verified;
      return json({ data: verified });
    }
    return json({ error: { code: 'NOT_FOUND' } }, 404);
  }));
  render(<AuthProvider><App /></AuthProvider>);
  return submissions;
}

afterEach(() => {
  clearActivationLink();
  resetSessionMemory();
  window.history.replaceState(null, '', '/#/ingresar');
  vi.unstubAllGlobals();
});

describe('N07 alternativa de activación en la misma P', () => {
  it('LINK 422 INPUT_INVALID ofrece legado con el mismo token; éxito lleva a Proteger', async () => {
    const user = userEvent.setup();
    const submissions = mount('invite');
    await user.click(await screen.findByRole('button', { name: 'Activar cuenta' }));
    expect(await screen.findByText(/primera contraseña de una invitación/i)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(peekActivation()?.status).toBe('ready');
    cleanSurface();
    await user.click(screen.getByRole('button', { name: 'Crear contraseña inicial' }));
    await user.type(screen.getByLabelText('Contraseña nueva'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Activar con contraseña inicial' }));
    expect(await screen.findByRole('heading', { name: 'Proteger mi cuenta' })).toBeInTheDocument();
    expect(submissions.map(s => s.body)).toEqual([
      { purpose: 'ACTIVATION', mode: 'LINK', token: TOKEN },
      { purpose: 'ACTIVATION', token: TOKEN, newPassword: PASSWORD },
    ]);
    expect(submissions.every(s => s.credentials === 'include' && s.csrf === 'current-P-csrf')).toBe(true);
    expect(vi.mocked(fetch).mock.calls.some(c => /\/auth\/(logout|login)$/.test(String(c[0])))).toBe(false);
    expect(peekActivation()).toBeNull();
    cleanSurface();
  });

  it('abrir otro enlace reinicia la alternativa y usa el nuevo token en LINK', async () => {
    const user = userEvent.setup();
    const submissions = mount('invite');
    await user.click(await screen.findByRole('button', { name: 'Activar cuenta' }));
    await user.click(await screen.findByRole('button', { name: 'Crear contraseña inicial' }));
    await user.type(screen.getByLabelText('Contraseña nueva'), PASSWORD);
    const nextToken = 'Q'.repeat(43);
    await act(async () => {
      window.history.replaceState(null, '', `/#/activar?purpose=ACTIVATION&token=${nextToken}`);
      captureActivationLink();
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByRole('button', { name: 'Activar cuenta' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Contraseña nueva')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Activar cuenta' }));
    expect(submissions[1]?.body).toEqual({ purpose: 'ACTIVATION', mode: 'LINK', token: nextToken });
    expect(document.body.innerHTML.includes(nextToken) || window.location.href.includes(nextToken)).toBe(false);
    cleanSurface();
  });

  it('legado 401 ofrece RESET, borra token y no anuncia éxito', async () => {
    const user = userEvent.setup();
    mount('invite', true);
    await user.click(await screen.findByRole('button', { name: 'Activar cuenta' }));
    await user.click(await screen.findByRole('button', { name: 'Crear contraseña inicial' }));
    await user.type(screen.getByLabelText('Contraseña nueva'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Activar con contraseña inicial' }));
    expect(await screen.findByText('El código no es válido o ya no está disponible.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Restablecer' })).toHaveAttribute('href', '#/restablecer');
    expect(screen.queryByRole('heading', { name: 'Proteger mi cuenta' })).toBeNull();
    expect(screen.queryByLabelText('Contraseña nueva')).toBeNull();
    expect(peekActivation()).toBeNull();
    cleanSurface();
  });

  it.each(['network', 'service', 'auth'] as const)('LINK %s mantiene error/reintento sin abrir legado', async failure => {
    const user = userEvent.setup();
    const submissions = mount(failure);
    await user.click(await screen.findByRole('button', { name: 'Activar cuenta' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Crear contraseña inicial' })).toBeNull();
    expect(screen.queryByLabelText('Contraseña nueva')).toBeNull();
    expect(peekActivation()?.status).toBe('ready');
    cleanSurface();
    await user.click(screen.getByRole('button', { name: 'Activar cuenta' }));
    expect(submissions).toHaveLength(2);
    expect(submissions.every(s => s.body.mode === 'LINK')).toBe(true);
    cleanSurface();
  });

  it('INITIAL 401 no se convierte en activación por legado', async () => {
    const user = userEvent.setup();
    const submissions = mount('token', false, true);
    await user.click(await screen.findByRole('button', { name: 'Confirmar enlace' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Crear contraseña inicial' })).toBeNull();
    expect(submissions[0]?.body).toEqual({ purpose: 'INITIAL_MFA_PROOF', token: TOKEN });
    cleanSurface();
  });
});
