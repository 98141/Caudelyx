// MEJ-4 adapted version by Codex; original read-only: finance/finance
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FinanceScreen } from '../../../src/features/finance/Finance';
import { AuthProvider } from '../../../src/shared/auth';
import { messageFor } from '../../../src/shared/contracts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const orgId = '11111111-1111-4111-8111-111111111111';

function install(roles: string[], accounts: unknown[] = [], conflict?: 'INPUT_INVALID' | 'SOURCE_CONFLICT') {
  const posts: { path: string; body: string; key: string | null }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const headers = new Headers(init?.headers);
    if (init?.method && init.method !== 'GET') posts.push({ path, body: String(init.body ?? ''), key: headers.get('Idempotency-Key') });
    if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
    if (path.endsWith('/auth/me')) return json({ data: { authState: 'ACTIVE', userId: 'user-1', organizationId: orgId }, requestId: 'req-fixture' });
    const method = init?.method ?? 'GET';
    if (path.endsWith('/organization')) return json({ data: { id: orgId, status: 'ACTIVE', actorRoleIds: roles }, requestId: 'req-fixture' });
    if (path.includes('/financial/accounts') && method === 'POST') return json({ error: { code: conflict ?? 'INPUT_INVALID' }, requestId: 'req-fixture' }, conflict ? 409 : 422);
    if (path.includes('/opening-files')) return json({ data: { items: [], nextCursor: null }, requestId: 'req-fixture' });
    if (path.includes('/financial/accounts')) return json({ data: { items: accounts, nextCursor: null }, requestId: 'req-fixture' });
    if (path.includes('/journal-entries')) return json({ data: { items: [], nextCursor: null }, requestId: 'req-fixture' });
    if (path.endsWith('/auth/reauthenticate') || path.endsWith('/auth/mfa/challenges/verify')) return json({ data: { nextAction: 'READY' }, requestId: 'req-fixture' });
    return json({ error: { code: 'NOT_FOUND' }, requestId: 'req-fixture' }, 404);
  }));
  return posts;
}

describe('libro por rol y formato', () => {
  it('oculta los controles si el rol no es titular', async () => {
    install(['L']);
    render(<AuthProvider><FinanceScreen /></AuthProvider>);
    expect(await screen.findByText(/solo está disponible para el titular/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Crear cuenta contable' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Transferir' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Apertura manual' })).not.toBeInTheDocument();
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('muestra el canónico y repite la misma clave si el mismo alta falla', async () => {
    const posts = install(['T'], [{ id: '22222222-2222-4222-8222-222222222222', code: 'BANK_01', name: 'Banco', accountClass: 'ASSET', kind: 'BANK', status: 'ACTIVE', version: 1, currency: 'COP' }]);
    const user = userEvent.setup();
    render(<AuthProvider><FinanceScreen /></AuthProvider>);
    await user.click(await screen.findByRole('tab', {name:'Movimientos'}));
    await user.type((await screen.findAllByLabelText('Importe'))[0]!, '1.999,50');
    expect(await screen.findByText('Se enviará 1999.50 COP.')).toBeInTheDocument();
    await user.click(await screen.findByRole('tab', {name:'Cuentas'}));
    await user.click(screen.getByRole('button', {name:'Crear cuenta'}));
    await user.type(screen.getByLabelText('Código'), 'bank_01');
    await user.type(screen.getByLabelText('Nombre'), 'Banco local');
    await user.click(screen.getByRole('button', { name: 'Crear cuenta contable' }));
    await screen.findByText(/no cumplen el formato/i);
    await user.click(screen.getByRole('button', { name: 'Crear cuenta contable' }));
    const created = posts.filter(post => post.path.endsWith('/financial/accounts'));
    expect(created).toHaveLength(2);
    expect(created[0]?.key).toBe(created[1]?.key);
    expect(JSON.parse(created[0]?.body ?? '{}')).toMatchObject({ code: 'BANK_01', currency: 'COP', accountClass: 'ASSET', kind: 'BANK' });
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it.each(['INPUT_INVALID', 'SOURCE_CONFLICT'] as const)('explica el 409 %s del alta sin reintentar ni cambiar 401/403', async code => {
    const posts = install(['T'], [], code);
    const user = userEvent.setup();
    render(<AuthProvider><FinanceScreen /></AuthProvider>);
    await user.click(await screen.findByRole('tab', {name:'Cuentas'}));
    await user.click(screen.getByRole('button', {name:'Crear cuenta'}));
    await user.type(await screen.findByLabelText('Código'), 'BANK_01');
    await user.type(screen.getByLabelText('Nombre'), 'Banco local');
    await user.click(screen.getByRole('button', { name: 'Crear cuenta contable' }));
    expect(await screen.findByText('No se pudo crear: el código ya existe o entró en conflicto. Revisa el código y vuelve a intentarlo.')).toBeInTheDocument();
    expect(posts.filter(post => post.path.endsWith('/financial/accounts'))).toHaveLength(1);
    expect(posts.some(post => post.path.endsWith('/auth/logout'))).toBe(false);
    expect(messageFor('AUTH_INVALID', 401)).toBe('No se pudo comprobar la identidad. Revisa los datos e inténtalo de nuevo.');
    expect(messageFor('ACCESS_DENIED', 403)).toBe('No tienes permiso para esta acción. Esto no cierra tu sesión.');
  });
});

// Unit boundary only. Actual factor/HTTP authority is exercised by MEJ4 HTTPS/E2E.
vi.mock('../../../src/shared/step-up', () => ({ensureStepUp: vi.fn().mockResolvedValue(undefined), StepUpProvider: ({children}: {children: unknown}) => children}));
