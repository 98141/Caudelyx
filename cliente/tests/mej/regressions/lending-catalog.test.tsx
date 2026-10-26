// MEJ-4 adapted version by Codex; original read-only: lending/lending
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../src/app/App';
import { BorrowersScreen } from '../../../src/features/lending/Borrowers';
import { LoansScreen } from '../../../src/features/lending/Loans';
import { percentToRate, principalFromLocal } from '../../../src/features/lending/rate';
import { OpeningWizard } from '../../../src/features/opening/Opening';
import { AuthProvider } from '../../../src/shared/auth';
import type { Me } from '../../../src/shared/contracts';

const orgId = '11111111-1111-4111-8111-111111111111';
const borrowerId = '55555555-5555-4555-8555-555555555555';
const accountId = '22222222-2222-4222-8222-222222222222';
const quoteId = '66666666-6666-4666-8666-666666666666';
const loanId = '77777777-7777-4777-8777-777777777777';
const openingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const referenceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const supportId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const fingerprint = 'ab'.repeat(32);
const base = `/organizations/${orgId}`;

const policy = {
  policyVersion: 'S04-LOCAL-CO-0.1', mathVersion: 'CALCULATION-S04-0.1', calendarVersion: 'S04-CALENDAR-0.1',
  jurisdiction: 'CO', usage: 'LOCAL_SYNTHETIC', legalStatus: 'NOT_REVIEWED_FOR_REAL_USE', realUseAllowed: false,
  methods: ['CONSTANT_PRINCIPAL', 'LEVEL_PAYMENT', 'INTEREST_ONLY'],
  frequencies: ['DAY', 'WEEK', 'FIFTEEN_DAYS', 'SEMIMONTH', 'MONTH'],
  minPrincipal: '0.01', maxPrincipal: '1000000000000.00', maxInstallments: 360,
  minDate: '2000-01-01', maxDate: '2199-12-31', quoteTtlSeconds: 900,
};
const borrower = {
  id: borrowerId, borrowerCode: 'P001', status: 'ACTIVE', version: 1, profileVersion: 1,
  profile: { displayName: 'Ana sintética', schemaVersion: 1, extras: {} },
  possibleDuplicate: true, duplicateCandidates: [{ id: '99999999-9999-4999-8999-999999999999', borrowerCode: 'P009', displayName: 'Ana parecida' }],
};
const account = { id: accountId, code: 'BANK_01', name: 'Banco sintético', accountClass: 'ASSET', kind: 'BANK', status: 'ACTIVE', version: 1, currency: 'COP' };
const quote = {
  id: quoteId, expiresAt: '2026-10-23T20:00:00.000Z', fingerprint,
  schedule: [
    { k: 1, date: '2026-02-29', openingPrincipal: '100.00', principal: '100.00', interest: '0.00', payment: '100.00', closingPrincipal: '0.00' },
    { k: 2, date: '2026-03-31', openingPrincipal: '0.01', principal: '0.00', interest: '0.00', payment: '-0.01', closingPrincipal: '0.00' },
  ],
  totals: { principal: '100.00', interest: '0.00', payment: '50.00' },
  periodicRate24: '0.000000000000000000000000', basePayment: '100.00', finalPaymentAdjustment: '-0.01',
  policyVersion: policy.policyVersion, mathVersion: policy.mathVersion, calendarVersion: policy.calendarVersion,
};

function json(body: unknown, status = 200, etag?: string): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (etag) headers.set('ETag', etag);
  return new Response(JSON.stringify(body), { status, headers });
}

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

function install(me: Me, handler: (path: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
    if (path.endsWith('/auth/me')) return json({ data: me, requestId: 'req-fixture' });
    if (path.endsWith('/auth/reauthenticate') || path.endsWith('/auth/mfa/challenges/verify')) return json({ data: { nextAction: 'READY' }, requestId: 'req-fixture' });
    return handler(path, init);
  }));
}

const active: Me = { authState: 'ACTIVE', userId: 'user-1', organizationId: orgId, profile: { displayName: 'Titular sintético', email: 'titular@example.test', emailVerified: true } };

function lendingRoutes(path: string): Response | null {
  if (path.includes('/lending-policy')) return json({ data: policy, requestId: 'req-fixture' });
  if (path.includes('/borrower-field-schemas/current')) return json({ data: { schemaVersion: 1, fields: [] }, requestId: 'req-fixture' }, 200, `"${orgId}:1"`);
  if (path.includes('/borrowers?')) return json({ data: { items: [borrower], nextCursor: null }, requestId: 'req-fixture' });
  if (path.endsWith(`/borrowers/${borrowerId}`)) return json({ data: borrower, requestId: 'req-fixture' }, 200, `"${borrowerId}:1"`);
  if (path.includes('/accounts?')) return json({ data: { items: [account], nextCursor: null }, requestId: 'req-fixture' });
  if (path.includes(`/accounts/${accountId}`)) return json({ data: account, requestId: 'req-fixture' });
  if (path.includes('/loans?')) return json({ data: { items: [], nextCursor: null }, requestId: 'req-fixture' });
  return null;
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('tasa y capital de presentación', () => {
  it('convierte el porcentaje escrito sin redondear y sin valor supuesto', () => {
    expect(percentToRate('0')).toBe('0.000000000000');
    expect(percentToRate('12')).toBe('0.120000000000');
    expect(percentToRate('12,5')).toBe('0.125000000000');
    expect(percentToRate('100')).toBe('1.000000000000');
    expect(percentToRate('100,1')).toBeNull();
    expect(percentToRate('')).toBeNull();
    expect(principalFromLocal('1.000,50')).toBe('1000.50');
    expect(principalFromLocal('')).toBeNull();
  });
});

describe('menú de préstamos', () => {
  it('muestra prestatarios y préstamos solo con sesión fuerte', async () => {
    window.location.hash = '#/prestatarios';
    install(active, path => lendingRoutes(path) ?? json({ error: { code: 'NOT_FOUND' }, requestId: 'req-fixture' }, 404));
    render(<AuthProvider><App /></AuthProvider>);
    expect(await screen.findByRole('link', { name: 'Prestatarios' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Préstamos' })).toBeInTheDocument();
  });

  it('no ofrece el menú ni consulta fichas si el correo sigue pendiente', async () => {
    window.location.hash = '#/prestatarios';
    const seen: string[] = [];
    install({ authState: 'PENDING_EMAIL', userId: 'user-1' }, path => {
      seen.push(path);
      return json({ error: { code: 'NOT_FOUND' }, requestId: 'req-fixture' }, 404);
    });
    render(<AuthProvider><App /></AuthProvider>);
    expect(await screen.findByText(/Correo sin confirmar/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Prestatarios' })).not.toBeInTheDocument();
    expect(seen.some(path => path.includes('/borrowers'))).toBe(false);
  });
});

describe('fichas de prestatarios', () => {
  it('lista por código y nombre y avisa un parecido sin fusionar', async () => {
    install(active, path => lendingRoutes(path) ?? json({ data: { items: [], nextCursor: null }, requestId: 'req-fixture' }));
    render(<AuthProvider><BorrowersScreen /></AuthProvider>);
    const user = userEvent.setup();
    await user.click(within(await screen.findByRole('row', {name:/P001.*Ana sintética/})).getByRole('button', {name:'Ana sintética'}));
    expect(await screen.findByText(/P009 · Ana parecida/)).toBeInTheDocument();
    expect(screen.getByText(/No se fusionaron/)).toBeInTheDocument();
    expect(screen.queryByText(borrowerId)).not.toBeInTheDocument();
  });

  it('explica el código repetido y no guarda la contraseña', async () => {
    install(active, (path, init) => {
      if (path.includes('/borrowers?')) return json({ data: { items: [], nextCursor: null }, requestId: 'req-fixture' });
      const known = lendingRoutes(path);
      if (known) return known;
      if (path.endsWith('/borrowers') && init?.method === 'POST') return json({ error: { code: 'BORROWER_CODE_CONFLICT' }, requestId: 'req-fixture' }, 409);
      return json({ error: { code: 'NOT_FOUND' }, requestId: 'req-fixture' }, 404);
    });
    render(<AuthProvider><BorrowersScreen /></AuthProvider>);
    const user = userEvent.setup();
    await screen.findByText('No hay prestatarios con ese criterio.');
    await user.click(screen.getByRole('button', {name:'Nuevo'}));
    await user.type(screen.getByLabelText('Código'), 'P001');
    await user.type(screen.getByLabelText('Nombre'), 'Ana sintética');
    await user.click(screen.getByRole('button', { name: 'Crear ficha' }));
    expect(await screen.findByText(/Ese código ya existe en esta organización/)).toBeInTheDocument();
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });
});

describe('cotización y términos', () => {
  async function fillQuote() {
    const user = userEvent.setup();
    await screen.findByRole('option', {name:'P001 · Ana sintética'});
    await user.selectOptions(screen.getByLabelText('Prestatario'), borrowerId);
    await user.type(screen.getByLabelText('Capital'), '1000,50');
    await user.click(screen.getByRole('button',{name:'Siguiente'}));
    await user.click(await optionFor('Cuenta prevista de desembolso','BANK_01'));
    await user.selectOptions(screen.getByLabelText('Modalidad'),'CONSTANT_PRINCIPAL');
    expect(screen.getByLabelText('Frecuencia de la cuota')).toHaveValue('MONTH');
    expect(screen.getByLabelText('Clase de tasa')).toHaveValue('EFFECTIVE');
    expect(screen.getByLabelText('Unidad de la tasa')).toHaveValue('MONTH');
    expect(screen.getByLabelText('Tasa en porcentaje')).toHaveValue('');
    await user.type(screen.getByLabelText('Tasa en porcentaje'),'0');
    fireEvent.change(screen.getByLabelText('Fecha de inicio'),{target:{value:'2026-01-31'}});
    expect(screen.getByLabelText('Fecha de la primera cuota')).toHaveValue('2026-02-28');
    await user.type(screen.getByLabelText('Número de cuotas'),'2');
    await user.click(screen.getByRole('button',{name:'Siguiente'}));return user;
  }

  it('muestra el cronograma del servidor, conserva el centavo y no lo trata como saldo', async () => {
    const bodies: unknown[] = [];
    install(active, (path, init) => {
      const known = lendingRoutes(path);
      if (known) return known;
      if (path.endsWith('/loan-quotes') && init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)));
        return json({ data: quote, requestId: 'req-fixture' }, 201);
      }
      return json({ error: { code: 'NOT_FOUND' }, requestId: 'req-fixture' }, 404);
    });
    render(<AuthProvider><LoansScreen /></AuthProvider>);
    const user = await fillQuote();
    await user.click(screen.getByRole('button', { name: 'Ver cronograma' }));
    expect(await screen.findByText('2026-02-29')).toBeInTheDocument();
    expect(screen.getByText('2026-03-31')).toBeInTheDocument();
    expect(screen.getByText(/Cuotas 50 COP/)).toBeInTheDocument();
    expect(screen.getAllByText(/-0,01 COP/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Simulación. No hay saldo ni desembolso/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirmar términos' })).not.toBeInTheDocument();
    const sent = bodies[0] as { terms: { principal: string; rate: { value: string }; usage: string } };
    expect(sent.terms.principal).toBe('1000.50');
    expect(sent.terms.rate.value).toBe('0.000000000000');
    expect(sent.terms.usage).toBe('LOCAL_SYNTHETIC');
    await user.click(screen.getByRole('button',{name:'Anterior'}));await user.click(screen.getByRole('button',{name:'Anterior'}));
    await user.type(screen.getByLabelText('Capital'), '1');
    expect(await screen.findByText(/La simulación anterior quedó obsoleta/)).toBeInTheDocument();
    expect(screen.queryByText('2026-02-29')).not.toBeInTheDocument();
  });

  it('reintenta el borrador con la misma clave y no confirma ni desembolsa', async () => {
    const keys: string[] = [];
    install(active, (path, init) => {
      const known = lendingRoutes(path);
      if (known) return known;
      if (path.endsWith('/loan-quotes')) return json({ data: quote, requestId: 'req-fixture' }, 201);
      if (path.endsWith('/loans') && init?.method === 'POST') {
        keys.push(header(init, 'Idempotency-Key') ?? '');
        if (keys.length === 1) return json({ error: { code: 'SERVICE_UNAVAILABLE' }, requestId: 'req-fixture' }, 503);
        return json({ data: { id: loanId, status: 'DRAFT', version: 1, termsVersion: 1, borrowerId, quoteId, quoteFingerprint: fingerprint }, requestId: 'req-fixture' }, 201, `"${loanId}:1"`);
      }
      return json({ error: { code: 'NOT_FOUND' }, requestId: 'req-fixture' }, 404);
    });
    render(<AuthProvider><LoansScreen /></AuthProvider>);
    const user = await fillQuote();
    await user.click(screen.getByRole('button', { name: 'Ver cronograma' }));
    const save = (await screen.findByRole('button', { name: 'Guardar borrador de términos' })).closest('form');
    if (!save) throw new Error('Falta el formulario de guardado');
    await user.click(within(save).getByRole('button', { name: 'Guardar borrador de términos' }));
    expect(await screen.findByText(/El servicio no está disponible/)).toBeInTheDocument();
    await user.click(within(save).getByRole('button', { name: 'Guardar borrador de términos' }));
    expect(await screen.findByText(/Borrador. Versión de términos 1/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Confirmo estos términos/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Confirmar términos' })).toBeDisabled();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    const purposes = vi.mocked(fetch).mock.calls.filter(call => String(call[0]).endsWith('/auth/reauthenticate')).map(call => JSON.parse(String(call[1]?.body)).purpose);
    expect(purposes).toEqual([]); // Approved WORK: retry preserves key without old R.
    expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).includes('/confirmation'))).toBe(false);
    expect(screen.queryByText(loanId)).not.toBeInTheDocument();
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });
});

describe('etiquetas de apertura', () => {
  it('muestra código, nombre y referencia, y no copia la ruta técnica', async () => {
    const report = {
      issues: [{ code: 'NOT_A_REAL_CODE', path: '/components/0/accountId', relatedIds: [referenceId, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'] }],
      totals: { assets: '100.00', liabilities: '0.00', equity: '100.00', debit: '100.00', credit: '100.00', balanceDifference: '0.00', ledgerDifference: '0.00', principal: '0.00', recognizedInterest: '0.00', informationalInterest: '0.00' },
      proposedLines: [{ accountId, debit: '100.00', credit: '0.00', componentIds: [], interestIds: [] }],
    };
    const snapshot = {
      cutoffDate: '2026-10-22',
      supports: [{ id: supportId, reference: 'SOP-1', asOfDate: '2026-10-22', declaration: 'DECLARED' }],
      references: [{ id: referenceId, type: 'BORROWER', externalReference: 'REF-1', displayName: 'Ana sintética', supportIds: [supportId] }],
      components: [{ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', category: 'BANK', accountId, amount: '100.00', supportIds: [supportId] }],
      historicalInterest: [], informationalHistory: [],
    };
    const file = {
      id: openingId, version: 4, contentVersion: 1, status: 'VALIDATED', financialScope: 'BUSINESS', currency: 'COP',
      snapshot, predecessorId: null,
      validation: { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', validatedAt: '2026-10-23T00:00:00.000Z', contentVersion: 1, fingerprint, report },
      approval: null, commit: null, cancellation: null,
    };
    install(active, path => {
      if (path.includes('/accounts')) return json({ data: path.includes('?') ? { items: [account], nextCursor: null } : account, requestId: 'req-fixture' });
      if (path.endsWith(`/opening-files/${openingId}`)) return json({ data: file, requestId: 'req-fixture' }, 200, `"${openingId}:4"`);
      if (path.includes('/opening-files')) return json({ data: { items: [{ id: openingId, status: 'VALIDATED', version: 4, cutoffDate: '2026-10-22', updatedAt: '2026-10-23T00:00:00.000Z' }], nextCursor: null }, requestId: 'req-fixture' });
      return json({ error: { code: 'NOT_FOUND' }, requestId: 'req-fixture' }, 404);
    });
    render(<AuthProvider><OpeningWizard organizationId={orgId} base={`${base}/financial`} /></AuthProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Reanudar 2026-10-22' }));
    expect(await screen.findByText(/No se pudo validar este dato; revisa las condiciones/)).toBeInTheDocument();
    expect(screen.getByText(/Contraparte histórica Ana sintética/)).toBeInTheDocument();
    expect(screen.getByText(/Referencia no disponible en este expediente/)).toBeInTheDocument();
    expect((await screen.findAllByText(/BANK_01 · Banco sintético/)).length).toBeGreaterThan(0);
    expect(screen.queryByText('/components/0/accountId')).not.toBeInTheDocument();
    expect(screen.queryByText(accountId)).not.toBeInTheDocument();
  });
});

// Unit boundary only. Actual factor/HTTP authority is exercised by MEJ4 HTTPS/E2E.
vi.mock('../../../src/shared/step-up', () => ({ensureStepUp: vi.fn().mockResolvedValue(undefined), StepUpProvider: ({children}: {children: unknown}) => children}));

async function optionFor(label: string, code: string) {
  await userEvent.click(await screen.findByRole('combobox', {name:label}));
  return await screen.findByRole('option', {name: new RegExp('^'+code+' ·')});
}
