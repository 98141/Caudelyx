// S03-P05 independent component checks (Claude) of the opening wizard and the paged account picker.
// HTTP is a recorded fixture ONLY to drive UI interaction; financial truth is verified against the real backend elsewhere.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpeningWizard } from '../../../src/features/opening/Opening';
import { AccountPicker } from '../../../src/features/finance/account-picker';
import { AuthProvider } from '../../../src/shared/auth';

const org = '31111111-1111-4111-8111-111111111111', opening = '3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', bank = '32222222-2222-4222-8222-222222222222';
const support = '3ccccccc-cccc-4ccc-8ccc-cccccccccccc', validation = { id: '3bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', fingerprint: 'cd'.repeat(32) };
const base = `/organizations/${org}/financial`;
const json = (body: unknown, status = 200, etag?: string) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...(etag ? { ETag: etag } : {}) } });
const bankAccount = { id: bank, code: 'BANK_P5', name: 'Banco P05', accountClass: 'ASSET', kind: 'BANK', status: 'ACTIVE', version: 1, currency: 'COP' };
// Client-side draft adds up to 100.00; the server report says something else on purpose.
const snapshot = { cutoffDate: '2026-10-20', supports: [{ id: support, reference: 'SOP-P05', asOfDate: '2026-10-20', declaration: 'DECLARED' }], references: [],
  components: [{ id: '3ddddddd-dddd-4ddd-8ddd-dddddddddddd', category: 'BANK', accountId: bank, amount: '100.00', supportIds: [support] }], historicalInterest: [], informationalHistory: [] };
const serverReport = (issues: { code: string; path: string; relatedIds: string[] }[] = []) => ({ issues, proposedLines: [],
  totals: { assets: '777.00', liabilities: '0.00', equity: '776.99', debit: '777.00', credit: '776.99', balanceDifference: issues.length ? '0.01' : '0.00', ledgerDifference: issues.length ? '0.01' : '0.00', principal: '0.00', recognizedInterest: '0.00', informationalInterest: '0.00' } });
const file = (status: string, report = serverReport()) => ({ id: opening, version: 4, contentVersion: 1, status, financialScope: 'BUSINESS', currency: 'COP', snapshot, predecessorId: null,
  validation: status === 'DRAFT' ? null : { ...validation, validatedAt: '2026-10-23T00:00:00.000Z', contentVersion: 1, policyVersion: 'S03-OPENING-0.1', dependencyDigest: 'ef'.repeat(32), report },
  approval: status === 'APPROVED' ? { actorId: 'actor', approvedAt: '2026-10-23T00:00:00.000Z', validationId: validation.id, validationFingerprint: validation.fingerprint } : null, commit: null, cancellation: null });

interface Seen { method: string; path: string }
function renderWizard(current: ReturnType<typeof file>, mutation: (path: string, method: string) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? 'GET'; seen.push({ method, path });
    if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-p05' }, requestId: 'req' });
    if (path.endsWith('/auth/me')) return json({ data: { authState: 'ACTIVE', userId: 'user-p05', organizationId: org }, requestId: 'req' });
    if (path.endsWith('/auth/reauthenticate') || path.endsWith('/auth/mfa/challenges/verify')) return mutation(path, method);
    if (path.includes('/accounts/')) return json({ data: bankAccount, requestId: 'req' }, 200, `"${bank}:1"`);
    if (path.includes('/accounts')) return json({ data: { items: [bankAccount], nextCursor: null }, requestId: 'req' });
    if (method === 'GET' && (path.endsWith('/opening-files') || path.includes('/opening-files?'))) return json({ data: { items: [{ id: opening, status: current.status, version: current.version, cutoffDate: snapshot.cutoffDate, updatedAt: '2026-10-23T00:00:00.000Z' }], nextCursor: null }, requestId: 'req' });
    if (method === 'GET' && path.endsWith(`/opening-files/${opening}`)) return json({ data: current, requestId: 'req' }, 200, `"${opening}:${current.version}"`);
    return mutation(path, method);
  }));
  render(<AuthProvider><OpeningWizard organizationId={org} base={base} /></AuthProvider>);
  return seen;
}
const ok = (path: string) => path.endsWith('/auth/reauthenticate') || path.endsWith('/auth/mfa/challenges/verify') ? json({ data: { nextAction: 'READY' }, requestId: 'req' }) : null;
const formOf = (button: string) => screen.getByRole('button', { name: button }).closest('form')!;

afterEach(() => { vi.unstubAllGlobals(); });

describe('P05 S3 asistente: envío, autoridad del servidor y confirmaciones', () => {
  it('doble clic en «Confirmar apertura en el libro» envía UN solo comando con su R; la confirmación no viene marcada', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(r => { release = r; });
    const seen = renderWizard(file('APPROVED'), async path => ok(path) ?? (await gate, json({ data: { ...file('APPROVED'), status: 'POSTED', version: 5, commit: { journalId: '3eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', recordedAt: '2026-10-23T00:00:00.000Z', ledgerLineMap: [] } }, requestId: 'req' }, 201, `"${opening}:5"`)));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Reanudar 2026-10-20' }));
    const confirm = await screen.findByRole('checkbox', { name: /Confirmo el corte, los soportes/ });
    expect(confirm).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Confirmar apertura en el libro' })).toBeDisabled();
    await user.click(confirm);
    await user.type(within(formOf('Confirmar apertura en el libro')).getByLabelText('Código TOTP vigente'), '123456');
    await user.type(within(formOf('Confirmar apertura en el libro')).getByLabelText('Contraseña actual'), 'synthetic P05 password 1234');
    const button = screen.getByRole('button', { name: 'Confirmar apertura en el libro' }), form = formOf('Confirmar apertura en el libro');
    fireEvent.click(button); fireEvent.click(button); fireEvent.submit(form);
    expect(screen.queryByRole('button', { name: 'Confirmar apertura en el libro' })).toBeNull(); // pending state renames/locks the action
    release();
    // The fixture's later GET keeps the file APPROVED; what matters here is what was SENT while pending.
    await screen.findByRole('button', { name: 'Confirmar apertura en el libro' });
    expect(seen.filter(s => s.method === 'POST' && s.path.endsWith('/commit'))).toHaveLength(1);
    expect(seen.filter(s => s.path.endsWith('/auth/reauthenticate'))).toHaveLength(1);
  });

  it('muestra los totales del informe del servidor (no suma el borrador) y no aprueba con incidencias aunque se marque', async () => {
    const seen = renderWizard(file('VALIDATED', serverReport([{ code: 'BALANCE_DIFFERENCE', path: '/totals/balanceDifference', relatedIds: [] }])), path => ok(path) ?? json({ error: { code: 'OPENING_STATE_CONFLICT' }, requestId: 'req' }, 409));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Reanudar 2026-10-20' }));
    const region = await screen.findByRole('region', { name: 'Conciliación del servidor' });
    expect(within(region).getByText(/salen de la respuesta, no de un cálculo de esta pantalla/)).toBeInTheDocument();
    expect(within(region).getByText('Activos 777 COP (777.00)')).toBeInTheDocument();
    expect(within(region).getByText(/^Diferencia de balance 0,01 COP/)).toBeInTheDocument();
    const approve = screen.queryByRole('checkbox', { name: /Apruebo el expediente validado/ });
    if (approve) { expect(approve).not.toBeChecked(); await user.click(approve); }
    const button = screen.queryByRole('button', { name: 'Aprobar apertura' });
    if (button) { await user.type(within(formOf('Aprobar apertura')).getByLabelText('Contraseña actual'), 'synthetic P05 password 1234'); await user.click(button); }
    await waitFor(() => expect(seen.filter(s => s.path.endsWith('/approval'))).toHaveLength(0));
    expect(seen.filter(s => s.path.endsWith('/auth/reauthenticate'))).toHaveLength(0);
  });

  it('409 OPENING_VALIDATION_STALE en el commit explica la recuperación en español y no anuncia éxito', async () => {
    const seen = renderWizard(file('APPROVED'), path => ok(path) ?? json({ error: { code: 'OPENING_VALIDATION_STALE' }, requestId: 'req' }, 409));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Reanudar 2026-10-20' }));
    await user.click(await screen.findByRole('checkbox', { name: /Confirmo el corte, los soportes/ }));
    await user.type(within(formOf('Confirmar apertura en el libro')).getByLabelText('Código TOTP vigente'), '123456');
    await user.type(within(formOf('Confirmar apertura en el libro')).getByLabelText('Contraseña actual'), 'synthetic P05 password 1234');
    await user.click(screen.getByRole('button', { name: 'Confirmar apertura en el libro' }));
    expect(await screen.findByText(/La validación quedó desactualizada. No hubo efecto./)).toBeInTheDocument();
    expect(seen.filter(x => x.method === 'POST' && x.path.endsWith('/commit'))).toHaveLength(1);
    expect(screen.queryByText(/El servidor confirmó la apertura al corte/)).toBeNull();
  });

  it('si la reautenticación falla no se envía el commit ni se muestra éxito', async () => {
    const seen = renderWizard(file('APPROVED'), path => path.endsWith('/auth/reauthenticate') ? json({ error: { code: 'AUTH_INVALID' }, requestId: 'req' }, 401) : json({ data: {}, requestId: 'req' }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Reanudar 2026-10-20' }));
    await user.click(await screen.findByRole('checkbox', { name: /Confirmo el corte, los soportes/ }));
    await user.type(within(formOf('Confirmar apertura en el libro')).getByLabelText('Código TOTP vigente'), '123456');
    await user.type(within(formOf('Confirmar apertura en el libro')).getByLabelText('Contraseña actual'), 'synthetic P05 wrong password 9');
    await user.click(screen.getByRole('button', { name: 'Confirmar apertura en el libro' }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(seen.filter(s => s.path.endsWith('/commit'))).toHaveLength(0);
    expect(screen.queryByText(/El servidor confirmó la apertura al corte/)).toBeNull();
  });
});

describe('P05 S3 selector paginado (F04.4)', () => {
  it('elige en la página 2, conserva la ficha al volver a la 1 y un cursor inválido (422) reinicia sin éxito parcial', async () => {
    const general = Array.from({ length: 20 }, (_, i) => ({ id: `4${String(i).padStart(7, '0')}-1111-4111-8111-111111111111`, code: `G${String(i).padStart(2, '0')}`, name: 'General', accountClass: 'ASSET', kind: 'GENERAL', status: 'ACTIVE', version: 1, currency: 'COP' }));
    let calls = 0, failNext = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf' }, requestId: 'req' });
      if (url.endsWith('/auth/me')) return json({ data: { authState: 'ACTIVE', userId: 'u', organizationId: org }, requestId: 'req' });
      if (url.includes(`/accounts/${bank}`)) return json({ data: bankAccount, requestId: 'req' }, 200, `"${bank}:1"`);
      calls++;
      const params = new URL(url, 'https://localhost').searchParams;
      expect(params.get('limit')).toBe('20'); expect([...params.keys()].every(k => ['limit', 'cursor'].includes(k))).toBe(true);
      if (params.get('cursor') && failNext) return json({ error: { code: 'INPUT_INVALID' }, requestId: 'req' }, 422);
      return params.get('cursor') ? json({ data: { items: [bankAccount], nextCursor: null }, requestId: 'req' }) : json({ data: { items: general, nextCursor: 'opaque-p05' }, requestId: 'req' });
    }));
    const changes: string[] = [];
    const { rerender } = render(<AuthProvider><AccountPicker base={base} label="Banco" value="" accountClass="ASSET" kinds={['BANK']} onChange={id => changes.push(id)} /></AuthProvider>);
    const user = userEvent.setup();
    expect(await screen.findByText(/Sin cuentas elegibles en esta página/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Banco: cuentas siguientes' }));
    await user.click(await screen.findByRole('button', { name: 'Elegir BANK_P5 para Banco' }));
    expect(changes).toEqual([bank]);
    rerender(<AuthProvider><AccountPicker base={base} label="Banco" value={bank} accountClass="ASSET" kinds={['BANK']} onChange={id => changes.push(id)} /></AuthProvider>);
    await user.click(screen.getByRole('button', { name: 'Banco: cuentas anteriores' }));
    const card = await screen.findByRole('heading', { name: 'Seleccionada para Banco' });
    expect(within(card.closest('article')!).getByText('BANK_P5 · Banco P05')).toBeInTheDocument();
    failNext = true;
    await user.click(screen.getByRole('button', { name: 'Banco: cuentas siguientes' }));
    expect(await screen.findByText('La página pedida no es válida. Se vuelve a la primera, sin tratarlo como un resultado.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Seleccionada para Banco' })).toBeInTheDocument();
    expect(changes).toEqual([bank]);
    expect(calls).toBeGreaterThanOrEqual(4);
  });
});
