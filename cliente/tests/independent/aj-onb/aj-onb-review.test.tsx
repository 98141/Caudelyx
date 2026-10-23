// AJ-ONB-5 independent review (Claude): QR/secret lifetime, menu truthfulness, direct URL and legacy activation UX.
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { toString as qrSvg } from 'qrcode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../src/app/App';
import { AuthProvider } from '../../../src/shared/auth';
import { resetSessionMemory } from '../../../src/shared/api';
import { captureActivationLink, clearActivationLink } from '../../../src/shared/activation-link';
import { TotpMaterial } from '../../../src/features/security/Security';

const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const uri = `otpauth://totp/Caudelyx:revisora%40example.test?secret=${secret}&issuer=Caudelyx&algorithm=SHA1&digits=6&period=30`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function Holder() {
  const [value, setValue] = useState(uri);
  const [, setTick] = useState(0);
  return value ? (
    <>
      <button type="button" onClick={() => setTick(n => n + 1)}>Repintar</button>
      <TotpMaterial uri={value} onClear={() => setValue('')} />
    </>
  ) : <p>Material retirado</p>;
}
function stubApi(me: unknown, extra: (path: string, init?: RequestInit) => Response | undefined = () => undefined) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-r5' } });
    if (path.endsWith('/auth/me')) return me === null ? json({ error: { code: 'AUTH_INVALID' } }, 401) : json({ data: me });
    return extra(path, init) ?? json({ error: { code: 'ROUTE_NOT_FOUND' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const profile = (emailVerified: boolean) => ({ displayName: 'Revisora R5', email: 'revisora@example.test', emailVerified, createdAt: '2026-10-23T20:00:00.000Z', hasFactor: false, version: '"r5"' });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetSessionMemory();
  clearActivationLink();
  window.location.hash = '';
});

describe('AJ-ONB-5 QR y secreto TOTP', () => {
  it('el QR es exactamente la codificación local de la misma URI, sin red ni almacenamiento', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('no network expected'); });
    vi.stubGlobal('fetch', fetchMock);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(<Holder />);
    const image = await screen.findByRole('img', { name: /Código QR de la misma cuenta/ });
    const src = image.getAttribute('src') ?? '';
    expect(src.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    const svg = decodeURIComponent(src.slice('data:image/svg+xml;charset=utf-8,'.length));
    const expected = await qrSvg(uri, { type: 'svg', margin: 2, width: 240, errorCorrectionLevel: 'M', color: { dark: '#0f172a', light: '#ffffff' } });
    expect(svg).toBe(expected);
    expect(/<image|href=|<script|url\(/i.test(svg)).toBe(false);
    expect(screen.getByText(secret)).toBeInTheDocument();
    expect(screen.getByText('Cuenta: revisora@example.test')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('«Ocultar y borrar» retira QR, URI y clave a la vez', async () => {
    const user = userEvent.setup();
    render(<Holder />);
    await screen.findByRole('img', { name: /Código QR/ });
    await user.click(screen.getByRole('button', { name: 'Ocultar y borrar de la pantalla' }));
    expect(screen.getByText('Material retirado')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
    expect(document.body.innerHTML.includes(secret)).toBe(false);
    expect(document.body.innerHTML.includes('otpauth')).toBe(false);
  });

  it('el borrado a los 5 min no se prorroga al repintar', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Holder />);
    await act(async () => { await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 59 * 1000); });
    expect(document.body.innerHTML.includes(secret)).toBe(true);
    act(() => { screen.getByRole('button', { name: 'Repintar' }).click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText('Material retirado')).toBeInTheDocument();
    expect(document.body.innerHTML.includes(secret)).toBe(false);
  });
});

describe('AJ-ONB-5 menú y acceso según estado real', () => {
  it('B pendiente: sin Ingresar/Crear cuenta ni secciones de negocio; saludo y cierre', async () => {
    window.location.hash = '#/perfil';
    stubApi({ authState: 'PENDING_EMAIL', sessionContext: 'B', nextAction: 'VERIFY_EMAIL', profile: profile(false) });
    render(<AuthProvider><App /></AuthProvider>);
    const nav = await screen.findByRole('navigation', { name: 'Secciones' });
    await screen.findByText('Hola, Revisora R5');
    for (const hash of ['#/ingresar', '#/registro', '#/organizacion', '#/finanzas']) expect(nav.querySelector(`a[href="${hash}"]`)).toBeNull();
    expect(nav.querySelector('a[href="#/perfil"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument();
    expect(screen.getByText('Correo sin confirmar')).toBeInTheDocument();
  });

  it('anónimo: solo Ingresar y Crear cuenta, sin saludo ni cierre', async () => {
    window.location.hash = '#/ingresar';
    stubApi(null);
    render(<AuthProvider><App /></AuthProvider>);
    const nav = await screen.findByRole('navigation', { name: 'Secciones' });
    await waitFor(() => expect(nav.querySelector('a[href="#/ingresar"]')).not.toBeNull());
    expect(nav.querySelector('a[href="#/registro"]')).not.toBeNull();
    expect(nav.querySelector('a[href="#/perfil"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cerrar sesión' })).toBeNull();
    expect(screen.queryByText(/^Hola/)).toBeNull();
  });

  it('URL directa a Organización con B pendiente no consulta negocio', async () => {
    window.location.hash = '#/organizacion';
    const fetchMock = stubApi({ authState: 'PENDING_EMAIL', sessionContext: 'B', nextAction: 'VERIFY_EMAIL', profile: profile(false) });
    render(<AuthProvider><App /></AuthProvider>);
    expect(await screen.findByText('Confirma tu correo para crear organizaciones. No se consultan datos de negocio.')).toBeInTheDocument();
    const urls = fetchMock.mock.calls.map(call => String(call[0]));
    expect(urls.some(url => /\/organization|\/financial/.test(url))).toBe(false);
  });

  it('URL directa a Finanzas con B confirmada no consulta el libro', async () => {
    window.location.hash = '#/finanzas';
    const fetchMock = stubApi({ authState: 'MFA_ENROLLMENT', sessionContext: 'B', nextAction: 'ENROLL_FIRST_FACTOR', profile: profile(true) });
    render(<AuthProvider><App /></AuthProvider>);
    expect(await screen.findByText(/El libro no se consulta sin un factor comprobado/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(call => String(call[0])).some(url => /\/financial|\/organization/.test(url))).toBe(false);
  });
});

describe('AJ-ONB-5 activación de cuenta previa a AJ (sin contraseña)', () => {
  it('reproduce: tras el 422 legado, la pantalla no ofrece restablecer la contraseña', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/activar?purpose=ACTIVATION&token=' + 'A'.repeat(43);
    captureActivationLink();
    const fetchMock = stubApi(null, path => path.endsWith('/auth/email-verifications/confirm') ? json({ error: { code: 'INPUT_INVALID' } }, 422) : undefined);
    render(<AuthProvider><App /></AuthProvider>);
    await user.click(await screen.findByRole('button', { name: 'Activar cuenta' }));
    await user.click(await screen.findByRole('button', { name: 'Crear contraseña inicial' }));
    await user.type(await screen.findByLabelText('Contraseña nueva'), 'fixture-password-local-r5');
    await user.click(screen.getByRole('button', { name: 'Activar con contraseña inicial' }));
    expect(await screen.findByText('No se activó la cuenta. Puedes empezar un alta nueva.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Restablecer/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Empezar un alta nueva' })).toHaveAttribute('href', '#/registro');
    expect(fetchMock.mock.calls.filter(call => String(call[0]).endsWith('/auth/email-verifications/confirm')).length).toBe(2);
  });
});
