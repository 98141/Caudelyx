// MEJ-5 independent component review (Claude): session clocks, redirects, warning/keep-alive without polling,
// logout confirmed/unconfirmed, global 401 vs puntual MFA_INVALID, H04/H08/H11. Synthetic data; fetch is mocked here.
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../src/app/App';
import { AuthProvider } from '../../../src/shared/auth';
import { call, resetSessionMemory } from '../../../src/shared/api';
import { captureActivationLink, clearActivationLink } from '../../../src/shared/activation-link';
import { publishFlash, clearFlash } from '../../../src/shared/flash';
import { LocalMailboxHint } from '../../../src/shared/ui';
import { AccountCombobox } from '../../../src/shared/account-combobox';
import { useState } from 'react';
import { deadlineState, grantActive, shouldSendActivity, ACTIVITY_DEBOUNCE_MS, WARNING_MS } from '../../../src/shared/session-activity';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const iso = (ms: number) => new Date(ms).toISOString();
function me(now: number, idleIn = 3600000, extra: Record<string, unknown> = {}) {
  return { sessionContext: 'W', authState: 'WORKING', userId: 'u-a', roleIds: ['T'], organizationId: 'o-a',
    profile: { displayName: 'Revisora A', email: 'a@example.test', emailVerified: true, createdAt: iso(now - 86400000), hasFactor: true, version: '"v"' },
    session: { serverNow: iso(now), idleExpiresAt: iso(now + idleIn), absoluteExpiresAt: iso(now + 43200000), balanceVerifiedUntil: null }, ...extra };
}
type Route = (path: string, init?: RequestInit) => Response | undefined;
function stub(identity: unknown, extra: Route = () => undefined) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-r5' } });
    if (path.endsWith('/auth/me')) return identity === null ? json({ error: { code: 'AUTH_INVALID' } }, 401) : json({ data: identity });
    return extra(path, init) ?? json({ error: { code: 'ROUTE_NOT_FOUND' } }, 404);
  });
  vi.stubGlobal('fetch', fn); return fn;
}
const calls = (fn: ReturnType<typeof stub>, needle: string) => fn.mock.calls.filter(c => String(c[0]).includes(needle));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetSessionMemory(); clearActivationLink(); clearFlash(); try { sessionStorage.clear(); } catch { /* jsdom */ } window.location.hash = ''; });

describe('K1 plazos del cliente (independiente de UI)', () => {
  it('aviso a 120 s, vencido en el instante exacto, desfase de reloj del servidor y ventana de saldo estricta', () => {
    const t0 = Date.UTC(2026, 9, 25, 12), clock = { meta: { serverNow: iso(t0), idleExpiresAt: iso(t0 + 300000), absoluteExpiresAt: iso(t0 + 43200000), balanceVerifiedUntil: iso(t0 + 60000) }, receivedAt: 1000 };
    expect(WARNING_MS).toBe(120000); expect(ACTIVITY_DEBOUNCE_MS).toBe(60000);
    expect(deadlineState(clock, 1000 + 300000 - 120001).warning).toBe(false);
    expect(deadlineState(clock, 1000 + 300000 - 120000).warning).toBe(true);
    expect(deadlineState(clock, 1000 + 300000 - 1).expired).toBe(false);
    expect(deadlineState(clock, 1000 + 300000).expired).toBe(true);
    expect(grantActive(clock, 1000 + 59999)).toBe(true); expect(grantActive(clock, 1000 + 60000)).toBe(false);
    expect(shouldSendActivity(0, 5)).toBe(true); expect(shouldSendActivity(1000, 1000 + 59999)).toBe(false); expect(shouldSendActivity(1000, 61000)).toBe(true);
  });
});

describe('K2–K5 sesión, aviso, salida y errores globales', () => {
  it('K2 W activa en #/ingresar va a Inicio; nunca formulario público junto al menú privado', async () => {
    window.location.hash = '#/ingresar';
    stub(me(Date.now()));
    render(<AuthProvider><App /></AuthProvider>);
    await waitFor(() => expect(window.location.hash).toBe('#/inicio'));
    expect(screen.queryByRole('button', { name: 'Iniciar sesión' })).toBeNull();
    expect(await screen.findByText('Hola, Revisora A')).toBeInTheDocument();
  });

  it('K3 aviso 2 min antes, «Seguir conectado» renueva por actividad real, sin polling', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.location.hash = '#/perfil';
    const fn = stub(me(Date.now(), 110000), path => path.endsWith('/auth/session/activity') ? json({ data: { session: me(Date.now(), 3600000).session } }) : undefined);
    render(<AuthProvider><App /></AuthProvider>);
    expect(await screen.findByText(/La sesión de trabajo está por vencer/)).toBeInTheDocument();
    const before = fn.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(fn.mock.calls.length).toBe(before);
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole('button', { name: 'Seguir conectado' }));
    // Observed: the click also fires pointerdown (interaction activity) + forced stayConnected → 2 POSTs within ms (MEJ-5 observation).
    await waitFor(() => expect(calls(fn, '/auth/session/activity').length).toBeGreaterThanOrEqual(1));
    expect(calls(fn, '/auth/session/activity').length).toBeLessThanOrEqual(2);
    console.log('MEJ5_K3_ACTIVITY_POSTS ' + calls(fn, '/auth/session/activity').length);
    await waitFor(() => expect(screen.queryByText(/La sesión de trabajo está por vencer/)).toBeNull());
  });

  it('K3b sin interacción la sesión vence en pantalla y se limpia sin esperar otro clic', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.location.hash = '#/perfil';
    const fn = stub(me(Date.now(), 20000));
    render(<AuthProvider><App /></AuthProvider>);
    await screen.findByText('Hola, Revisora A');
    const before = fn.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(40000); });
    await waitFor(() => expect(window.location.hash).toBe('#/ingresar'));
    expect(screen.getByText(/La sesión venció/)).toBeInTheDocument();
    expect(screen.queryByText('Hola, Revisora A')).toBeNull();
    expect(calls(fn, '/auth/session/activity').length).toBe(0); expect(fn.mock.calls.length - before).toBeLessThanOrEqual(0);
  });

  it('K4 salida confirmada limpia y redirige; salida no confirmada no rehidrata al recargar', async () => {
    window.location.hash = '#/perfil';
    let fail = false;
    const fn = stub(me(Date.now()), path => path.endsWith('/auth/logout') ? (fail ? json({ error: { code: 'SERVICE_UNAVAILABLE' } }, 503) : new Response(null, { status: 204 })) : undefined);
    const first = render(<AuthProvider><App /></AuthProvider>);
    await userEvent.click(await screen.findByRole('button', { name: 'Cerrar sesión' }));
    await waitFor(() => expect(window.location.hash).toBe('#/ingresar'));
    expect(screen.queryByText('Hola, Revisora A')).toBeNull(); expect(calls(fn, '/auth/logout').length).toBe(1);
    first.unmount(); resetSessionMemory();
    window.location.hash = '#/perfil'; fail = true;
    const second = render(<AuthProvider><App /></AuthProvider>);
    await userEvent.click(await screen.findByRole('button', { name: 'Cerrar sesión' }));
    expect(await screen.findByText(/No se pudo confirmar el cierre en el servidor/)).toBeInTheDocument();
    expect(window.location.hash).toContain('salida=pendiente'); expect(sessionStorage.getItem('caudelyx-logout-pending')).toBe('1');
    expect(screen.queryByText('Hola, Revisora A')).toBeNull();
    second.unmount(); resetSessionMemory();
    const meCallsBefore = calls(fn, '/auth/me').length;
    render(<AuthProvider><App /></AuthProvider>);
    expect(await screen.findByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
    expect(calls(fn, '/auth/me').length).toBe(meCallsBefore);
    expect(screen.queryByText('Hola, Revisora A')).toBeNull();
  });

  it('K5 401 de sesión cierra la vista; 401 MFA_INVALID puntual no cierra una W sana', async () => {
    window.location.hash = '#/perfil';
    stub(me(Date.now()), path => path.endsWith('/auth/step-up/verify') ? json({ error: { code: 'MFA_INVALID' } }, 401) : path.includes('/financial/accounts') ? json({ error: { code: 'AUTH_INVALID' } }, 401) : undefined);
    render(<AuthProvider><App /></AuthProvider>);
    await screen.findByText('Hola, Revisora A');
    await expect(call('POST', '/auth/step-up/verify', { intentId: 'x', method: 'TOTP', code: '000000' })).rejects.toMatchObject({ code: 'MFA_INVALID' });
    await new Promise(r => setTimeout(r, 50));
    expect(screen.getByText('Hola, Revisora A')).toBeInTheDocument();
    await expect(call('GET', '/organizations/o-a/financial/accounts')).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    await waitFor(() => expect(screen.queryByText('Hola, Revisora A')).toBeNull());
    expect(window.location.hash).toBe('#/ingresar'); expect(screen.getByText(/La sesión ya no es válida/)).toBeInTheDocument();
  });
});

describe('K9 combobox accesible', () => {
  it('teclado: escribir, ↓/Enter elige; Escape cierra sin elegir', async () => {
    const user = userEvent.setup(); const chosen: string[] = [];
    const options = [{ id: 'a1', code: 'BANK_R5', name: 'Banco revisora', kindLabel: 'Banco', statusLabel: 'Activa' }, { id: 'a2', code: 'CASH_R5', name: 'Caja revisora', kindLabel: 'Caja', statusLabel: 'Activa' }];
    function Host() { const [v, setV] = useState(''); const [q, setQ] = useState(''); return <AccountCombobox label="cuenta 1" options={options.filter(o => !q || o.code.includes(q))} value={v} onChange={id => { chosen.push(id); setV(id); }} query={q} onQuery={setQ} loading={false} />; }
    render(<Host />);
    const box = screen.getByRole('combobox', { name: 'cuenta 1' });
    await user.click(box); await user.type(box, 'CASH'); await user.keyboard('{Enter}');
    expect(chosen).toEqual(['a2']); expect((box as HTMLInputElement).value).toMatch(/CASH_R5/);
    await user.click(box); await user.keyboard('{Escape}'); expect(chosen).toEqual(['a2']);
  });
});

describe('K6–K8 pendientes AJ', () => {
  it('K6 H04: cuenta pendiente legada sin contraseña (422) ofrece restablecer, no una alta nueva', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/activar?purpose=ACTIVATION&token=' + 'B'.repeat(43);
    captureActivationLink();
    stub(null, path => path.endsWith('/auth/email-verifications/confirm') ? json({ error: { code: 'INPUT_INVALID' } }, 422) : undefined);
    render(<AuthProvider><App /></AuthProvider>);
    await user.click(await screen.findByRole('button', { name: /Activar/ }));
    const reset = await screen.findAllByRole('link', { name: /Restablecer/ });
    expect(reset.some(a => a.getAttribute('href') === '#/restablecer')).toBe(true);
  });

  it('K7 H08: el aviso «Factor registrado» sobrevive a cambiar de pantalla', async () => {
    window.location.hash = '#/perfil';
    stub(me(Date.now()));
    render(<AuthProvider><App /></AuthProvider>);
    await screen.findByText('Hola, Revisora A');
    act(() => publishFlash('Factor registrado'));
    window.location.hash = '#/inicio'; window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(await screen.findByText('Factor registrado')).toBeInTheDocument();
  });

  it('K8 H11: la pista del buzón solo aparece con modo local explícito', () => {
    const off = render(<LocalMailboxHint email="a@example.test" />); expect(off.container.textContent).toBe(''); off.unmount();
    vi.stubEnv('VITE_CAUDELYX_MODE', 'local-synthetic');
    const on = render(<LocalMailboxHint email="a@example.test" />); expect(on.container.textContent).toMatch(/mailbox/);
  });
});
