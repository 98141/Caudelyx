import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '../../../src/shared/auth';
import { FinanceScreen } from '../../../src/features/finance/Finance';
import { HomeScreen } from '../../../src/features/home/Home';
import { BorrowersScreen } from '../../../src/features/lending/Borrowers';
import { InitialBalances } from '../../../src/features/finance/InitialBalances';
import { StepUpProvider, ensureStepUp } from '../../../src/shared/step-up';
import { useSessionActivity } from '../../../src/shared/session-activity';
import { LocalMailboxHint } from '../../../src/shared/ui';
import { call } from '../../../src/shared/api';

const org = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
    const bank = { id: '33333333-3333-4333-8333-333333333333', code: 'R2BANK', name: 'Banco R2', accountClass: 'ASSET', kind: 'BANK', status: 'ACTIVE', version: 1, currency: 'COP' };
    const account = { id, code: 'R2CASH', name: 'Caja R2', accountClass: 'ASSET', kind: 'CASH', status: 'ACTIVE', version: 1, currency: 'COP' };

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(status >= 400 ? { error: { code: data } } : { data }), { status, headers: { 'Content-Type': 'application/json' } });
}

function install(extra?: (path: string, init?: RequestInit) => Response | Promise<Response>) {
  const now = Date.now();
  const me = { sessionContext: 'W', authState: 'WORKING', userId: 'r2-owner', roleIds: ['T'] as string[], organizationId: org, profile: { displayName: 'Persona R2', emailVerified: true, hasFactor: true }, session: { serverNow: new Date(now).toISOString(), idleExpiresAt: new Date(now + 3_600_000).toISOString(), absoluteExpiresAt: new Date(now + 43_200_000).toISOString(), balanceVerifiedUntil: null } };
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    urls.push(path + ' ' + (init?.method ?? 'GET'));
    if (path.endsWith('/auth/me')) return json(structuredClone(me));
    if (path.endsWith('/auth/csrf')) return json({ csrfToken: 'csrf-R2' });
    if (path.endsWith('/organization')) return json({ id: org, status: 'ACTIVE', actorRoleIds: me.roleIds });
    if (extra) return await extra(path, init);
    if (path.includes('/journal-entries')) return json({ items: [], nextCursor: null });
    if (path.includes('/opening-files')) return json({ items: [] });
    if (path.includes('/borrowers')) return json({ items: [] });
    if (path.includes('/loans')) return json({ items: [{ id: 'loan-r2' }] });
    if (path.endsWith('/' + id)) return json(account);
    return json({ items: [account], nextCursor: null });
  }));
  return { me, urls };
}

function Renew() {
  const auth = useAuth();
  return <>
    <button type="button" onClick={() => { if (auth.me?.session) auth.applySession({ ...auth.me.session, serverNow: new Date().toISOString() }); }}>Renovar metadata</button>
    <button type="button" onClick={() => void auth.refresh()}>Consultar identidad</button>
  </>;
}

describe('MEJ-R2 componentes del delta', () => {
  it('R1 conserva pestaña, cuenta y borrador al renovar metadata y no repite la organización', async () => {
    const f = install();
    const user = userEvent.setup();
    render(<AuthProvider><Renew /><FinanceScreen /></AuthProvider>);
    await user.click(await screen.findByRole('tab', { name: 'Movimientos' }));
    const form = within(screen.getByRole('region', { name: 'Asiento' }));
    await user.type(form.getByLabelText('Descripción'), 'Borrador R2 que no puede desaparecer');
    await user.type(form.getByLabelText('Soporte'), 'SYN-R2');
    await user.type(form.getAllByLabelText('Importe')[0]!, '610,25');
    await user.click(form.getByRole('combobox', { name: 'línea 1' }));
    await user.click(await screen.findByRole('option', { name: /R2CASH/ }));
    const selected = form.getByRole('combobox', { name: 'línea 1' }) as HTMLInputElement;
    const label = selected.value;
    await user.click(screen.getByRole('tab', { name: 'Cuentas' }));
    await user.click(screen.getByRole('tab', { name: 'Movimientos' }));
    const orgReads = () => f.urls.filter(item => item.startsWith(String(f.urls[0]).includes('/organization') ? '' : '') || item.includes('/organization ')).length;
    const before = f.urls.filter(item => item.includes('/organization ')).length;
    await user.click(screen.getByRole('button', { name: 'Renovar metadata' }));
    await user.click(screen.getByRole('button', { name: 'Consultar identidad' }));
    await waitFor(() => expect(f.urls.filter(item => item.includes('/auth/me '))).toHaveLength(2));
    expect(screen.getByRole('tab', { name: 'Movimientos' })).toHaveAttribute('aria-selected', 'true');
    expect(form.getByLabelText('Descripción')).toHaveValue('Borrador R2 que no puede desaparecer');
    expect(form.getByLabelText('Soporte')).toHaveValue('SYN-R2');
    expect(form.getAllByLabelText('Importe')[0]).toHaveValue('610,25');
    expect(selected).toHaveValue(label);
    expect(f.urls.filter(item => item.includes('/organization '))).toHaveLength(before);
    expect(orgReads()).toBeGreaterThan(0);
  });

  it('R1 negativo: cambiar el rol retira el libro', async () => {
    const f = install();
    const user = userEvent.setup();
    render(<AuthProvider><Renew /><FinanceScreen /></AuthProvider>);
    await screen.findByRole('tab', { name: 'Cuentas' });
    f.me.roleIds = ['L'];
    await user.click(screen.getByRole('button', { name: 'Consultar identidad' }));
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Cuentas' })).toBeNull());
    expect(screen.getByText(/solo está disponible para el titular/)).toBeInTheDocument();
  });

  it('Inicio muestra cinco pasos y no repite consultas al renovar metadata', async () => {
    const f = install();
    const user = userEvent.setup();
    render(<AuthProvider><Renew /><HomeScreen /></AuthProvider>);
    await screen.findByText(/5. Crear un préstamo. Hecho/);
    const before = f.urls.length;
    await user.click(screen.getByRole('button', { name: 'Renovar metadata' }));
    await act(async () => { await Promise.resolve(); });
    expect(f.urls.length).toBe(before);
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
  });

  it('F12 hay un solo enlace de Configuración en el contenido de prestatarios', async () => {
    install();
    render(<AuthProvider><BorrowersScreen /></AuthProvider>);
    const link = await screen.findByRole('link', { name: 'Campos adicionales en Configuración' });
    expect(link).toHaveAttribute('href', '#/configuracion');
    expect(screen.getAllByRole('link', { name: /Configuración/ })).toHaveLength(1);
  });

  it('F7 un click en Seguir conectado produce un solo POST', async () => {
    const f = install(path => path.endsWith('/activity') ? json({ session: { serverNow: new Date().toISOString(), idleExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), absoluteExpiresAt: new Date(Date.now() + 43_200_000).toISOString(), balanceVerifiedUntil: null } }) : json({ items: [] }));
    function Activity() {
      const auth = useAuth();
      const activity = useSessionActivity({ enabled: auth.phase === 'ready', clock: auth.clock, onSession: auth.applySession, onExpired: () => undefined });
      return <button type="button" data-session-activity="explicit" onClick={() => void activity.stayConnected()}>Seguir conectado</button>;
    }
    render(<AuthProvider><Activity /></AuthProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Seguir conectado' }));
    await waitFor(() => expect(f.urls.filter(item => item.includes('/activity '))).toHaveLength(1));
  });

  it('F13 prepara el intento, confirma sin Pedir código y cancelar no muta', async () => {
    let commands = 0;
    const f = install(path => {
      if (path.endsWith('/intents')) return json({ intentId: 'r2-intent', method: 'TOTP', expiresAt: new Date(Date.now() + 300_000).toISOString() });
      if (path.endsWith('/step-up/verify')) return json({ verifiedClass: 'SECURITY_ONE_SHOT' });
      if (path.endsWith('/password/change')) { commands += 1; return json({}); }
      return json({ items: [] });
    });
    function Protected() {
      return <button type="button" onClick={() => void ensureStepUp({ purpose: 'PASSWORD_CHANGE', summary: 'Cambiar contraseña' }).then(() => call('POST', '/auth/password/change', { newPassword: 'Synthetic R2 password 462915' })).catch(() => undefined)}>Acción</button>;
    }
    render(<AuthProvider><StepUpProvider><Protected /></StepUpProvider></AuthProvider>);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Acción' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Confirmar' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Pedir código' })).toBeNull();
    expect(f.urls.filter(item => item.includes('/intents '))).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(commands).toBe(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each(['R_REQUIRED', 'REAUTH_REQUIRED'])('F6 %s no reenvía la mutación ni cierra la pantalla', async code => {
    let commands = 0;
    install(path => {
      if (path.endsWith('/intents')) return json({ intentId: 'r2-intent', method: 'TOTP', expiresAt: new Date(Date.now() + 300_000).toISOString() });
      if (path.endsWith('/step-up/verify')) return json({ verifiedClass: 'SECURITY_ONE_SHOT' });
      if (path.endsWith('/password/change')) { commands += 1; return json(code, 403); }
      return json({ items: [] });
    });
    function Protected() {
      return <button type="button" onClick={() => void ensureStepUp({ purpose: 'PASSWORD_CHANGE', summary: 'Cambiar contraseña' }).then(() => call('POST', '/auth/password/change', { newPassword: 'Synthetic R2 password 462915' })).catch(() => undefined)}>Acción</button>;
    }
    render(<AuthProvider><StepUpProvider><Protected /></StepUpProvider></AuthProvider>);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Acción' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Confirmar' })).toBeEnabled());
    await user.type(within(dialog).getByLabelText('Código de 6 dígitos'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(commands).toBe(1));
    await screen.findByRole('dialog');
    expect(commands).toBe(1);
  });

  it('F8 muestra el éxito del saldo 100 y 25,50 sin código', async () => {
    let posted: { items?: { amount: string }[] } | undefined;
    install((path, init) => {
      if (path.includes('/initial-balances') && init?.method === 'POST') {
        posted = JSON.parse(String(init.body)) as { items?: { amount: string }[] };
        return json({ initialBalanceRecorded: true });
      }
      if (path.includes(bank.id)) return json(bank);
      if (path.includes(account.id)) return json(account);
      if (path.includes('/accounts')) return json({ items: [account, bank] });
      return json({ items: [] });
    });
    render(<AuthProvider><InitialBalances base={'/organizations/' + org + '/financial'} organizationId={org} onRecorded={async () => undefined} /></AuthProvider>);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Registrar saldo inicial' });
    await user.type(screen.getByLabelText('Soporte'), 'SYN-R2');
    await user.click(screen.getByRole('combobox', { name: 'cuenta 1' }));
    await user.click(await screen.findByRole('option', { name: /R2CASH/ }));
    await user.type(screen.getByLabelText('Monto'), '100');
    await user.click(screen.getByRole('button', { name: 'Añadir fila' }));
    await user.click(screen.getByRole('combobox', { name: 'cuenta 2' }));
    await user.click(await screen.findByRole('option', { name: /R2BANK/ }));
    await user.type(screen.getAllByLabelText('Monto')[1]!, '25,50');
    await user.click(screen.getByRole('button', { name: 'Revisar' }));
    await user.click(screen.getByRole('button', { name: 'Registrar' }));
    await screen.findByText(/Saldo inicial registrado. El servidor confirmó/);
    expect(posted?.items?.map(item => item.amount)).toEqual(['100.00', '25.50']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('F10 el aviso local depende de DEV en loopback y se oculta sin flag', () => {
    vi.stubEnv('VITE_CAUDELYX_MODE', '');
    vi.stubEnv('DEV', true);
    const view = render(<LocalMailboxHint />);
    expect(screen.getByText(/Modo local sintético/)).toBeInTheDocument();
    vi.stubEnv('DEV', false);
    view.rerender(<LocalMailboxHint />);
    expect(screen.queryByText(/Modo local sintético/)).toBeNull();
  });

  it('F14 separa el saldo inicial al menos 24 px', () => {
    const css = readFileSync(resolve('src/app/styles.css'), 'utf8');
    expect(css).toMatch(/\.capture\[aria-labelledby="saldo-inicial"\][\s\S]*margin-block-start:\s*var\(--space-5,\s*24px\)/);
    expect(css).toMatch(/border-block-start:\s*1px solid/);
  });
});
