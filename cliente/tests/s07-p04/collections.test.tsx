import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollectionsScreen } from '../../src/features/lending/Collections';
import { AuthProvider } from '../../src/shared/auth';
import type { Me } from '../../src/shared/contracts';

const orgId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const loanId = '77777777-7777-4777-8777-777777777777';
const accountId = '33333333-3333-4333-8333-333333333333';
const collector: Me = { authState: 'ACTIVE', userId: actorId, organizationId: orgId, roleIds: ['C'], profile: { displayName: 'Cobrador sintético', email: 'cobrador@example.test', emailVerified: true } };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function page(items: unknown): Response {
  return json({ data: { items, nextCursor: null }, requestId: 'req-fixture' });
}
const zero = { confirmedOnSite: '0.00', provisionalOnSite: '0.00', returnRequiredOnSite: '0.00', heldOnSite: '0.00', inTransit: '0.00', receivedUnposted: '0.00', unlocatedDisputed: '0.00', unidentifiedSurplus: '0.00' };

function install(failState = false,me=collector) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).split('?')[0];
    if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
    if (path.endsWith('/auth/me')) return json({ data: me, requestId: 'req-fixture' });
    if (failState) return json({ error: { code: 'SERVICE_UNAVAILABLE' }, requestId: 'req-fixture' }, 503);
    if (path.endsWith('/collections/state')) return json({ data: { organizationId: orgId, collectionsBookETag: `"${orgId}:collections:1"`, paymentsBookETag: `"${orgId}:payments:1"`, operationsBookETag: `"${orgId}:ops:1"`, financeBookETag: `"${orgId}:finance:1"` }, requestId: 'req-fixture' });
    if (path.endsWith('/collection-portfolio')) return page([{ loanId, loanReference: 'A-1', borrowerId: actorId, borrowerCode: 'P001', borrowerName: 'Ana sintética', principalOutstanding: '1000.00', dueAmount: '100.00', positionETag: `"${loanId}:1"` }]);
    if (path.endsWith('/collection-journeys')) return page([]);
    if (path.endsWith('/collection-actions')) return page([{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'NOTE', note: 'Pasó a recoger mañana', loanId, promisedAmount: null }]);
    if (path.endsWith('/cash-stations')) return page([]);
    if (path.endsWith('/cash-positions')) return page([{ responsibleId: actorId, accountId, accountETag: `"${accountId}:1"`, bindingETag: '"binding:1"', ledgerBalance: '300000.00', retainedAtOrigin: '300000.00', committed: '0.00', uncommitted: '300000.00', available: '0.00', held: '0.00', deliveredNet: '0.00', physical: { ...zero, confirmedOnSite: '300000.00' }, pendingRefs: [] }]);
    if (path.endsWith('/cash-custody')) return page([]);
    if (path.endsWith('/cash-deliveries')) return page([{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', state: 'DISCREPANCY', amount: '250000.00', senderId: actorId, receiverId: actorId, countId: null, version: 1 }]);
    if (path.endsWith('/cash-closes')) return page([]);
    return json({ error: { code: 'NOT_FOUND' }, requestId: 'req-fixture' }, 404);
  }));
}

describe('P04 cobranza integrada en componentes (mock explícito)', () => {
  afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); });

  it('separa la nota del pago y la custodia en cifras distintas', async () => {
    install();
    render(<AuthProvider><CollectionsScreen /></AuthProvider>);
    expect(await screen.findByText(/Una nota o una promesa no es un pago/)).toBeInTheDocument();
    expect(await screen.findByText(/Pasó a recoger mañana/)).toBeInTheDocument();
    expect(screen.getByText(/No es un pago/)).toBeInTheDocument();
    expect(screen.getByText('Confirmado en el sitio')).toBeInTheDocument();
    expect(screen.getByText('En tránsito')).toBeInTheDocument();
    expect(screen.getByText(/no es el efectivo disponible/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirmar la entrega' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Borrar' })).not.toBeInTheDocument();
  });

  it('no tapa un dominio cerrado como éxito ni ofrece reabrirlo', async () => {
    install(true);
    render(<AuthProvider><CollectionsScreen /></AuthProvider>);
    expect(await screen.findByText(/ni lo da por corregido/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reabrir/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/El servidor confirmó el comando/)).not.toBeInTheDocument();
  });
});

it('permite registrar promesa y ofrece recuperación de disponibilidad',async()=>{install();render(<AuthProvider><CollectionsScreen /></AuthProvider>);expect(await screen.findByRole('option',{name:'Promesa'})).toBeInTheDocument();expect(screen.getByRole('button',{name:'Actualizar datos'})).toBeInTheDocument();});

it('una respuesta 401 tardía no restaura el borrador de la sesión perdida',async()=>{install();const original=vi.mocked(fetch).getMockImplementation()!;vi.mocked(fetch).mockImplementation(async(input,init)=>String(input).endsWith('/collection-journeys')&&init?.method==='POST'?json({error:{code:'AUTH_INVALID'}},401):original(input,init));render(<AuthProvider><CollectionsScreen /></AuthProvider>);const button=await screen.findByRole('button',{name:'Abrir la jornada'});await waitFor(()=>expect(button).not.toBeDisabled());fireEvent.click(button);await waitFor(()=>expect(sessionStorage.getItem('caudelyx.s07.collections.draft')).toBeNull());});

afterEach(()=>{vi.unstubAllGlobals();sessionStorage.clear();});
it.each([412,429,503])('conserva el borrador y no reenvía automáticamente ante HTTP %s',async status=>{install();const original=vi.mocked(fetch).getMockImplementation()!;let writes=0;vi.mocked(fetch).mockImplementation(async(input,init)=>{if(String(input).endsWith('/collection-journeys')&&init?.method==='POST'){writes++;return json({error:{code:status===412?'PRECONDITION_FAILED':status===429?'RATE_LIMITED':'SERVICE_UNAVAILABLE'}},status);}return original(input,init);});render(<AuthProvider><CollectionsScreen /></AuthProvider>);const button=await screen.findByRole('button',{name:'Abrir la jornada'});await waitFor(()=>expect(button).not.toBeDisabled());fireEvent.change(screen.getByLabelText('Nota',{exact:true}),{target:{value:'BORRADOR_P04'}});fireEvent.click(button);await waitFor(()=>expect(writes).toBe(1));if(status===503){expect(await screen.findByRole('button',{name:'Consultar el comando'})).toBeInTheDocument();expect(screen.queryByText('Confirmado en el sitio')).not.toBeInTheDocument();}else{await waitFor(()=>expect(button).not.toBeDisabled());expect(screen.queryByRole('button',{name:'Reintentar el mismo comando'})).not.toBeInTheDocument();}expect(JSON.parse(sessionStorage.getItem('caudelyx.s07.collections.draft')!).note).toBe('BORRADOR_P04');expect(writes).toBe(1);});
it('configuración T consulta miembros con el límite contractual50',async()=>{install(false,{...collector,roleIds:['T']});const original=vi.mocked(fetch).getMockImplementation()!;let limit='';vi.mocked(fetch).mockImplementation(async(input,init)=>{if(String(input).includes('/organization/members')){limit=new URL(String(input),'https://localhost').searchParams.get('limit')??'';return limit==='50'?page([]):json({error:{code:'INPUT_INVALID'}},422);}return original(input,init);});render(<AuthProvider><CollectionsScreen /></AuthProvider>);await screen.findByRole('heading',{name:'Configurar receptor y caja central'});await waitFor(()=>expect(limit).toBe('50'));});
