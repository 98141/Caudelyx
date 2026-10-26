import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaymentsScreen } from '../../src/features/lending/Payments';
import { AuthProvider } from '../../src/shared/auth';
import { purposeClass, type Me } from '../../src/shared/contracts';

const orgId = '11111111-1111-4111-8111-111111111111';
const otherOrg = '11111111-1111-4111-8111-111111111112';
const actorId = '22222222-2222-4222-8222-222222222222';
const registrarId = '22222222-2222-4222-8222-222222222223';
const borrowerA = '55555555-5555-4555-8555-555555555555';
const borrowerB = '55555555-5555-4555-8555-555555555556';
const loanA = '77777777-7777-4777-8777-777777777777';
const loanB = '77777777-7777-4777-8777-777777777778';
const loanC = '77777777-7777-4777-8777-777777777779';
const accountCash = '33333333-3333-4333-8333-333333333333';
const accountBank = '33333333-3333-4333-8333-333333333334';
const payPending = '88888888-8888-4888-8888-888888888888';
const payConfirmed = '88888888-8888-4888-8888-888888888889';
const payUnknown = '88888888-8888-4888-8888-888888888880';

const titular: Me = { authState: 'ACTIVE', userId: actorId, organizationId: orgId, roleIds: ['T'], profile: { displayName: 'Titular sintético', email: 'titular@example.test', emailVerified: true } };
let session: Me = titular;

function json(body: unknown, status = 200, etag?: string): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (etag) headers.set('ETag', etag);
  return new Response(JSON.stringify(body), { status, headers });
}

function intent(borrowerId: string, loanId: string, accountId: string, method: 'CASH' | 'BANK', amount: string, reference: string) {
  return {
    method, borrowerId, amount, currency: 'COP', destinationAccountId: accountId, destinationAccountETag: `"${accountId}:1"`,
    custodianId: method === 'CASH' ? registrarId : null, bindingETag: method === 'CASH' ? '"binding:1"' : null,
    observedDate: '2026-10-26', observedAt: '2026-10-26T15:00:00.000Z', receiptReference: reference, supportReference: 'SOP-1',
    targets: [{ loanId, positionETag: `"${loanId}:1"`, amount, mode: 'REGULAR' }], excessDisposition: 'REJECT',
  };
}

function payment(id: string, status: string, approvalState: string, custodyState: string, reconciliationState: string, body: ReturnType<typeof intent>, approvalMode = 'SUPERVISED') {
  return {
    id, registrarId, intent: body, approvalMode, status, approvalState, approvalOrigin: 'S06', reconciliationState, custodyState,
    heldFundsState: 'NONE', decidedBy: null, eventId: status === 'CONFIRMED' ? '99999999-9999-4999-8999-999999999999' : null,
    reversalEventId: null, observedDate: body.observedDate, effectiveDate: status === 'CONFIRMED' ? '2026-10-26' : null,
    recordedAt: '2026-10-26T15:00:00.000Z', currentReconciliationLinkId: null, reversalRequestId: null,
  };
}

const contexts = [
  { borrowerId: borrowerA, borrowerCode: 'P001', borrowerName: 'Ana sintética', loanId: loanA, loanReference: 'A-1', principalOutstanding: '1000.00', dueAmount: '100.00', positionETag: `"${loanA}:1"`, permittedDestinationId: accountCash, permittedBindingETag: '"binding:1"', permittedDestinationAccountETag: `"${accountCash}:1"`, permittedDestinationLabel: 'Efectivo del registrador', permittedMethod: 'CASH' },
  { borrowerId: borrowerA, borrowerCode: 'P001', borrowerName: 'Ana sintética', loanId: loanB, loanReference: 'A-2', principalOutstanding: '50.00', dueAmount: '0.00', positionETag: `"${loanB}:1"`, permittedDestinationId: accountBank, permittedBindingETag: null, permittedDestinationAccountETag: `"${accountBank}:1"`, permittedDestinationLabel: 'Banco organización', permittedMethod: 'BANK' },
  { borrowerId: borrowerB, borrowerCode: 'P002', borrowerName: 'Ana sintética', loanId: loanC, loanReference: 'B-1', principalOutstanding: '80.00', dueAmount: '0.00', positionETag: `"${loanC}:1"`, permittedDestinationId: accountBank, permittedBindingETag: null, permittedDestinationAccountETag: `"${accountBank}:1"`, permittedDestinationLabel: 'Banco organización', permittedMethod: 'BANK' },
];

const listed = [
  payment(payPending, 'PENDING', 'PENDING', 'PROVISIONAL', 'NOT_APPLICABLE', intent(borrowerA, loanA, accountCash, 'CASH', '300000.00', 'REC-PEND')),
  payment(payConfirmed, 'CONFIRMED', 'APPROVED', 'NOT_APPLICABLE', 'PENDING', intent(borrowerA, loanB, accountBank, 'BANK', '1500.50', 'REC-CONF'), 'SUPERVISED'),
  payment(payUnknown, 'ARCHIVED', 'PENDING', 'PROVISIONAL', 'PENDING', intent(borrowerB, loanC, accountBank, 'BANK', '80.00', 'REC-UNK')),
];

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

function install(handler: (path: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
    if (path.endsWith('/auth/me')) return json({ data: session, requestId: 'req-fixture' });
    return handler(path, init);
  }));
}

function routes(path: string, init?: RequestInit): Response {
  if (path.endsWith('/payments/policy')) return json({ data: { version: 'S06-LOCAL-CO-0.1', usage: 'LOCAL_SYNTHETIC', realUseAllowed: false, currency: 'COP', previewTTLSeconds: 300, directRoles: ['T'], registerRoles: ['T', 'O', 'C'], approveRoles: ['T', 'P'], segregation: 'SUPERVISED_DIFFERENT_ACTOR' }, requestId: 'req-fixture' });
  if (path.endsWith('/payments/state')) return json({ data: { organizationId: orgId, paymentsBookETag: `"${orgId}:payments:1"`, operationsBookETag: `"${orgId}:ops:1"`, policyRevision: 'S06-LOCAL-CO-0.1' }, requestId: 'req-fixture' });
  if (path.includes('/payments?')) return json({ data: { items: listed, nextCursor: null }, requestId: 'req-fixture' });
  if (path.includes('/registration-contexts')) return json({ data: { items: contexts, nextCursor: null }, requestId: 'req-fixture' });
  if (path.endsWith(`/payments/${payPending}`)) return json({ data: listed[0], requestId: 'req-fixture' }, 200, `"${payPending}:1"`);
  if (path.endsWith(`/payments/${payConfirmed}`)) return json({ data: listed[1], requestId: 'req-fixture' }, 200, `"${payConfirmed}:2"`);
  if (path.endsWith(`/payments/${payUnknown}`)) return json({ data: listed[2], requestId: 'req-fixture' }, 200, `"${payUnknown}:1"`);
  if (path.includes('/installments')) return json({ data: { items: [{ loanId: loanA, number: 1, dueDate: '2026-10-31', principal: '100.00', interest: '10.00', payment: '110.00', status: 'UNPAID' }], nextCursor: null }, requestId: 'req-fixture' });
  if(path.endsWith(`/cash-custody/${payPending}`))return json({data:{id:payPending,paymentId:payPending,amountHeld:'300000.00',state:'PROVISIONAL',responsibleId:registrarId},requestId:'req-fixture'},200,'"custody:1"');
  if (path.includes('/cash-custody')) return json({ data: { items: [], nextCursor: null }, requestId: 'req-fixture' });
  if (path.includes('/loan-event-reversal-requests/')) return json({ error: { code: 'RESOURCE_NOT_FOUND' }, requestId: 'req-fixture' }, 404);
  if (path.includes('/bank-declarations')) return json({ data: { items: [], nextCursor: null }, requestId: 'req-fixture' });
  if (path.includes('/financial/accounts')) return json({ data: { items: [], nextCursor: null }, requestId: 'req-fixture' });
  if (path.endsWith('/payment-previews') && init?.method === 'POST') {
    return json({ data: { token: 'preview-token', expiresAt: '2026-10-26T16:00:00.000Z', paymentsBookETag: `"${orgId}:payments:1"`, operationsBookETag: `"${orgId}:ops:1"`, plan: { effectiveDate: '2026-10-26', postings: [], allocations: [{ loanId: loanA, scheduleVersion: 1, installmentNumber: 1, component: 'INTEREST', amount: '10.00' }], creditAdded: '0.00', creditApplied: '0.00', heldFundsAdded: '0.00', custodyDelta: 'PROVISIONAL', snapshotHash: 'ab'.repeat(32) } }, requestId: 'req-fixture' });
  }
  return json({ error: { code: 'RESOURCE_NOT_FOUND' }, requestId: 'req-fixture' }, 404);
}

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); session = titular; });

describe('pagos S06', () => {
  it('separa prestatarios homónimos, préstamos y los cuatro estados', async () => {
    install(routes);
    render(<AuthProvider><PaymentsScreen /></AuthProvider>);
    expect(await screen.findByRole('button', { name: /P001 · Ana sintética · A-1/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /P001 · Ana sintética · A-2/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /P002 · Ana sintética · B-1/ })).toBeInTheDocument();
    const confirmed = screen.getByRole('button', { name: /REC-CONF/ }).closest('tr');
    expect(confirmed).toBeTruthy();
    expect(within(confirmed as HTMLElement).getByText('Confirmado')).toBeInTheDocument();
    expect(within(confirmed as HTMLElement).getByText('Pendiente de conciliar')).toBeInTheDocument();
    expect(within(confirmed as HTMLElement).queryByText('Conciliado')).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Prestatario, código o nombre'), 'P002');
    expect(screen.queryByRole('button', { name: /P001 · Ana sintética · A-1/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /P002 · Ana sintética · B-1/ })).toBeInTheDocument();
  });

  it('el pendiente de efectivo no dice que la deuda bajó ni que la caja propia es custodia', async () => {
    install(routes);
    render(<AuthProvider><PaymentsScreen /></AuthProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /REC-PEND/ }));
    expect(await screen.findByText(/La deuda no está reducida/)).toBeInTheDocument();
    expect(screen.getAllByText(/No es la caja propia de la organización/).length).toBeGreaterThan(0);
    expect(screen.getByRole('columnheader', { name: 'Número' })).toBeInTheDocument();
  });

  it('un estado desconocido no ofrece acciones y un aprobador no se selecciona solo', async () => {
    install(routes);
    render(<AuthProvider><PaymentsScreen /></AuthProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /REC-UNK/ }));
    expect(await screen.findByText('Estado no reconocido. No hay acciones.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pedir el plan de aprobación' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Borrar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /asiento/i })).not.toBeInTheDocument();
  });

  it('oculta el registro a quien solo aprueba y no aprueba el propio registro', async () => {
    session = { ...titular, userId: registrarId, roleIds: ['P'] };
    install((path, init) => {
      if (path.includes('/registration-contexts')) return json({ error: { code: 'ACCESS_DENIED' }, requestId: 'req-fixture' }, 403);
      return routes(path, init);
    });
    render(<AuthProvider><PaymentsScreen /></AuthProvider>);
    expect(await screen.findByText('No tienes permiso para registrar un pago.')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /REC-PEND/ }));
    expect(await screen.findByText('No puedes aprobar este registro.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pedir el plan de aprobación' })).not.toBeInTheDocument();
  });

  it('conserva la clave si la respuesta se pierde y no crea otra ante un conflicto', async () => {
    const keys: string[] = [];
    install((path, init) => {
      if (path.endsWith('/payments') && init?.method === 'POST') {
        keys.push(header(init, 'Idempotency-Key') ?? '');
        const status = keys.length === 1 ? 503 : 409;
        const code = status === 503 ? 'SERVICE_UNAVAILABLE' : 'IDEMPOTENCY_CONFLICT';
        return json({ error: { code }, requestId: 'req-fixture' }, status);
      }
      return routes(path, init);
    });
    render(<AuthProvider><PaymentsScreen /></AuthProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: /P001 · Ana sintética · préstamo A-1/ }));
    await user.type(screen.getByLabelText('Importe para P001 · A-1'), '300000');
    await user.type(screen.getByLabelText('Importe del recibo'), '300000');
    await user.type(screen.getByLabelText('Referencia'), 'REC-UI');
    await user.type(screen.getByLabelText('Soporte'), 'SOP-UI');
    await user.click(screen.getByRole('button', { name: 'Pedir el plan' }));
    await user.click(await screen.findByRole('checkbox', { name: /Confirmo este plan del servidor/ }));
    await user.click(screen.getByRole('button', { name: 'Confirmar el registro' }));
    expect(await screen.findByText(/La respuesta no confirmó el resultado/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reintentar el mismo comando' }));
    expect(await screen.findByText(/La clave de reintento no corresponde/)).toBeInTheDocument();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]?.length).toBeGreaterThan(10);
  });

  it('el registro directo no se envía sin la confirmación compartida', async () => {
    const posts: string[] = [];
    install((path, init) => {
      if (init?.method === 'POST' && path.endsWith('/payments')) posts.push(path);
      return routes(path, init);
    });
    render(<AuthProvider><PaymentsScreen /></AuthProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: /préstamo A-1/ }));
    await user.selectOptions(screen.getByLabelText('Modo de registro'), 'DIRECT');
    await user.type(screen.getByLabelText('Importe para P001 · A-1'), '10');
    await user.type(screen.getByLabelText('Importe del recibo'), '10');
    await user.type(screen.getByLabelText('Referencia'), 'REC-DIR');
    await user.type(screen.getByLabelText('Soporte'), 'SOP-DIR');
    await user.click(screen.getByRole('button', { name: 'Pedir el plan' }));
    await user.click(await screen.findByRole('checkbox', { name: /Confirmo este plan del servidor/ }));
    await user.click(screen.getByRole('button', { name: 'Confirmar el registro' }));
    expect(await screen.findByText('No se pudo abrir la confirmación.')).toBeInTheDocument();
    expect(posts).toHaveLength(0);
  });

  it('el filtro de prestatario recibe el teclado sin cambiar de foco', async () => {
    install(routes);
    render(<AuthProvider><PaymentsScreen /></AuthProvider>);
    const filter = await screen.findByLabelText('Prestatario, código o nombre');
    filter.focus();
    const user = userEvent.setup();
    await user.keyboard('P001');
    expect(filter).toHaveFocus();
    expect(filter).toHaveValue('P001');
    expect(screen.getByRole('columnheader', { name: 'Estado del pago' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Conciliación' })).toBeInTheDocument();
  });

  it('clasifica los propósitos nuevos sin pedir código en el trabajo ordinario', () => {
    expect(purposeClass('PAYMENT_REGISTER_DIRECT')).toBe('BALANCE_60M');
    expect(purposeClass('PAYMENT_APPROVE_CONFIRM')).toBe('BALANCE_60M');
    expect(purposeClass('PAYMENT_REVERSAL_EXECUTE')).toBe('BALANCE_60M');
    expect(purposeClass('CUSTODY_BINDING_SET')).toBe('SECURITY_ONE_SHOT');
    expect(purposeClass('PAYMENT_REGISTRATION_SCOPE_SET')).toBe('SECURITY_ONE_SHOT');
    expect(purposeClass('PAYMENT_REGISTER')).toBeNull();
    expect(purposeClass('RECONCILIATION_LINK')).toBeNull();
  });

  it('conserva el borrador al repetir la pantalla y lo retira si cambia la organización', async () => {
    install(routes);
    const first = render(<AuthProvider><PaymentsScreen /></AuthProvider>);
    const user = userEvent.setup();
    const reference = await screen.findByLabelText('Referencia');
    await user.type(reference, 'BORRADOR');
    await waitFor(() => expect(sessionStorage.getItem('caudelyx.s06.payments.draft')).toContain('BORRADOR'));
    first.unmount();
    const second = render(<AuthProvider><PaymentsScreen /></AuthProvider>);
    await waitFor(() => expect(screen.getByLabelText('Referencia')).toHaveValue('BORRADOR'));
    second.unmount();
    session = { ...titular, organizationId: otherOrg };
    render(<AuthProvider><PaymentsScreen /></AuthProvider>);
    expect(await screen.findByLabelText('Referencia')).toHaveValue('');
  });
});

// P04 regression: detail respects current API scopes, without broadening backend access.
describe('P04 role-scoped detail',()=>{
 it('P opens its pending decision without issuing privileged S5/custody requests',async()=>{
  session={...titular,userId:actorId,roleIds:['P']};const requests:string[]=[];install((path,init)=>{requests.push(path);return routes(path,init);});
  render(<AuthProvider><PaymentsScreen /></AuthProvider>);
  await userEvent.click(await screen.findByRole('button',{name:/REC-PEND/}));
  expect(await screen.findByRole('button',{name:'Pedir el plan de aprobación'})).toBeInTheDocument();
  expect(screen.getByLabelText('Soporte de la acción')).toBeInTheDocument();
  expect(requests.some(x=>x.includes('/loan-operations/positions/')||x.includes('/cash-custody'))).toBe(false);
 });
 it('a known commit with a failed refresh is not an uncertain new command',async()=>{
  let committed=false;install((path,init)=>{if(committed&&path.endsWith('/payments/state'))return json({error:{code:'SERVICE_UNAVAILABLE'},requestId:'fixture'},503);if(path.endsWith(`/payments/${payPending}/cancel`)&&init?.method==='POST'){committed=true;return json({data:{entityType:'PAYMENT',entityId:payPending,paymentsBookETag:'"book:2"',operationsBookETag:'"ops:1"',replayed:false},requestId:'fixture'},201);}return routes(path,init);});
  render(<AuthProvider><PaymentsScreen /></AuthProvider>);await userEvent.click(await screen.findByRole('button',{name:/REC-PEND/}));
  await userEvent.type(await screen.findByLabelText('Motivo de la acción'),'Corrección');await userEvent.type(screen.getByLabelText('Soporte de la acción'),'SYN');
  await userEvent.click(screen.getByRole('button',{name:'Cancelar el pendiente'}));
  expect(await screen.findByText('El comando se confirmó. No se pudo actualizar la vista; usa Refrescar.')).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Reintentar el mismo comando'})).not.toBeInTheDocument();
  const stored=JSON.parse(sessionStorage.getItem('caudelyx.s06.payments.draft')!);expect(stored.frozen).toBeNull();expect(stored.executionKey).toBeNull();
 });
});
