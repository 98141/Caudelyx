import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExchangeScreen } from '../../src/features/exchange/Exchange';
import { Reports } from '../../src/features/exchange/Reports';
import { claimKey, clearExchangeMemory, heldUncertain, markUncertain, releaseHeld } from '../../src/features/exchange/memory';
import { AuthProvider } from '../../src/shared/auth';
import type { Policy } from '../../src/features/exchange/types';
import type { Me } from '../../src/shared/contracts';

if (typeof File !== 'undefined' && typeof File.prototype.arrayBuffer !== 'function') {
  File.prototype.arrayBuffer = function arrayBuffer(this: File): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error ?? new Error('file-read'));
      reader.readAsArrayBuffer(this);
    });
  };
}

const orgId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const importId = '33333333-3333-4333-8333-333333333333';
const previewId = '44444444-4444-4444-8444-444444444444';

function person(roles: string[]): Me {
  return { authState: 'ACTIVE', userId: actorId, organizationId: roles.includes('SA') ? undefined : orgId, roleIds: roles, profile: { displayName: 'Persona sintética', email: 'persona@example.test', emailVerified: true } };
}

function json(body: unknown, status = 200, etag?: string): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (etag) headers.set('ETag', etag);
  return new Response(JSON.stringify(body), { status, headers });
}

const policy = {
  schemaVersion: '1.0.0', policyVersion: 'S11-EXCHANGE-1.0', usage: 'LOCAL_SYNTHETIC', realUseAllowed: false,
  reportKinds: ['CASH', 'PRINCIPAL'], formats: ['CSV', 'XLSX', 'PDF'], importModes: ['OPERATIVE', 'OPENING'],
  maxRows: 1000, maxUploadBytes: 5242880, previewTTLSeconds: 300,
  templates: [{ id: 'blank', templateVersion: '1.0.0', filename: 'caudelyx-import-template.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: 4, sha256: 'a'.repeat(64), contentBase64: btoa('xlsx') }],
} satisfies Policy;

const totals = { assets: '0.00', liabilities: '0.00', equity: '0.00', debit: '0.00', credit: '0.00', difference: '0.00', principal: '10.00', recognizedInterest: '1.00', informationalInterest: '2.00' };

function install(role = 'T') {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req' });
    if (path.endsWith('/auth/me')) return json({ data: person([role]), requestId: 'req' });
    if (path.endsWith('/me/personal/book')) return json({ error: { code: 'RESOURCE_NOT_FOUND' }, requestId: 'req' }, 404);
    if (path.endsWith('/me/exchange-s11/policy')) return json({ error: { code: 'ACCESS_DENIED' }, requestId: 'req' }, role === 'T' ? 404 : 403);
    if (path.endsWith('/exchange-s11/policy')) {
      const data = role === 'C' ? { ...policy, importModes: [], templates: [], reportKinds: ['PORTFOLIO'] } : policy;
      return json({ data, requestId: 'req' });
    }
    if (path.endsWith('/imports') && init?.method === 'POST') return json({ data: { id: importId, version: 1, contentVersion: 0, mode: 'OPERATIVE', namespace: 'sintetico', state: 'CREATED', createdAt: '2026-10-30T17:00:00.000Z', expiresAt: '2026-10-31T17:00:00.000Z', previewId: null, receiptId: null, jobId: null }, requestId: 'req' }, 201, '"s11-import:1"');
    if (path.endsWith('/content')) return json({ data: { id: importId, version: 2, contentVersion: 1, mode: 'OPERATIVE', namespace: 'sintetico', state: 'UPLOADED', createdAt: '2026-10-30T17:00:00.000Z', expiresAt: '2026-10-31T17:00:00.000Z', previewId: null, receiptId: null, jobId: null }, requestId: 'req' }, 200, '"s11-import:2"');
    if (path.endsWith('/previews')) return json({ data: { id: '55555555-5555-4555-8555-555555555555', kind: 'IMPORT_PREVIEW', state: 'SUCCEEDED', version: 1, createdAt: '2026-10-30T17:00:00.000Z', updatedAt: '2026-10-30T17:00:00.000Z', errorCode: null, resourceId: importId }, requestId: 'req' }, 202, '"s11-import:3"');
    if (path.endsWith(`/imports/${importId}`)) return json({ data: { id: importId, version: 3, contentVersion: 1, mode: 'OPERATIVE', namespace: 'sintetico', state: 'INVALID', createdAt: '2026-10-30T17:00:00.000Z', expiresAt: '2026-10-31T17:00:00.000Z', previewId, receiptId: null, jobId: null }, requestId: 'req' }, 200, '"s11-import:3"');
    if (path.includes('/preview')) {
      const hostile = ['<', 'script', '>alert(1)<', '/', 'script', '>'].join('');
      return json({
        data: {
          id: previewId, contentVersion: 1, semanticHash: 'b'.repeat(64), physicalHash: 'c'.repeat(64),
          expiresAt: '2026-10-30T17:05:00.000Z', canConfirm: false, totalRows: 2, errorCount: 1, warningCount: 0,
          deferredCount: 1, commandCount: 0, totals, nextCursor: null,
          items: [
            { sheet: 'Cuentas', row: 2, cell: 'C2', code: 'DECLARED_NOT_VERIFIED', severity: 'DEFERRED', expectedType: 'TEXT', relatedKeys: [] },
            { sheet: 'Cuentas', row: 3, cell: 'D3', code: 'INVALID_MONEY', severity: 'ERROR', expectedType: 'MONEY2', relatedKeys: [] },
          ],
          informationalHistory: [{ id: '66666666-6666-4666-8666-666666666666', date: '2026-10-30', description: hostile, referenceId: null, supportReferences: [{ reference: 'S', asOfDate: '2026-10-30', declaration: 'DECLARED' }] }],
        },
        requestId: 'req',
      });
    }
    return json({ error: { code: 'RESOURCE_NOT_FOUND' }, requestId: 'req' }, 404);
  }));
}

afterEach(() => { cleanupStorage(); vi.unstubAllGlobals(); clearExchangeMemory(); });

function cleanupStorage() {
  sessionStorage.clear();
  localStorage.clear();
}

describe('S11-P03 exchange memory', () => {
  it('reuses the same key after an uncertain response and blocks a different body', () => {
    const first = claimKey('cuerpo-a');
    markUncertain();
    expect(heldUncertain()).toBe(true);
    expect(claimKey('cuerpo-a')).toBe(first);
    expect(() => claimKey('cuerpo-b')).toThrow(/sin resultado confirmado/);
    releaseHeld();
    expect(claimKey('cuerpo-b')).not.toBe(first);
  });
});

describe('S11-P03 exchange screen', () => {
  it('shows the contract limit, keeps the draft out of browser storage and escapes hostile text', async () => {
    install();
    const user = userEvent.setup();
    const view = render(<AuthProvider><ExchangeScreen /></AuthProvider>);
    expect(await screen.findByText(/5242880 bytes/)).toBeInTheDocument();
    expect(screen.getByText(/no otorga roles/i)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Crear lote' }));
    const input = await screen.findByLabelText(/Archivo .xlsx/);
    await user.upload(input, new File([new Uint8Array([1, 2, 3, 4])], '<img src=x onerror=alert(1)>.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    expect(await screen.findByText('Seleccionado: Archivo seleccionado')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cargar archivo' }));
    await user.click(await screen.findByRole('button', { name: 'Generar vista previa' }));
    expect(await screen.findByRole('heading', { name: 'Vista previa, no es una operación realizada' })).toBeInTheDocument();
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
    expect(view.container.querySelector('script')).toBeNull();
    expect(view.container.innerHTML).not.toContain('<script>alert');
    expect(screen.getByRole('button', { name: 'Confirmar lote' })).toBeDisabled();
    expect(screen.getByText(/Principal 10.00/)).toBeInTheDocument();
    expect(screen.getByText(/Interés reconocido 1.00/)).toBeInTheDocument();
    const stored = [...Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)), ...Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))];
    expect(stored.some(key => (key ?? '').toLowerCase().includes('exchange') || (key ?? '').toLowerCase().includes('s11'))).toBe(false);
  });

  it('rejects a file above the visible limit before upload', async () => {
    install();
    const user = userEvent.setup();
    render(<AuthProvider><ExchangeScreen /></AuthProvider>);
    await screen.findByText(/5242880 bytes/);
    await user.click(screen.getByRole('button', { name: 'Crear lote' }));
    const input = await screen.findByLabelText(/Archivo .xlsx/);
    await user.upload(input, new File([new Uint8Array(5_242_881)], 'grande.xlsx'));
    expect(await screen.findByText(/supera el límite visible/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cargar archivo' })).toBeDisabled();
  });

  it('hides import actions when the policy gives the collaborator no modes', async () => {
    install('C');
    render(<AuthProvider><ExchangeScreen /></AuthProvider>);
    expect(await screen.findByRole('heading', { name: 'Reportes y descargas' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Crear lote' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Consolidado privado' })).not.toBeInTheDocument();
  });

  it('does not offer personal or consolidated data to platform administration', async () => {
    install('SA');
    render(<AuthProvider><ExchangeScreen /></AuthProvider>);
    expect(await screen.findByText(/no está disponible para administración de plataforma/)).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Personal del titular' })).not.toBeInTheDocument();
  });
});

describe('S11-P03 report presentation', () => {
  it('shows null as unavailable and keeps page totals apart from the set', async () => {
    const snapshot = {
      reportKind: 'CASH',
      meta: { policyVersion: 'S11-EXCHANGE-1.0', schemaVersion: '1.0.0', currency: 'COP', timezone: 'America/Bogota', cut: { asOf: '2026-10-30', recordedThrough: '2026-10-30T17:00:00.000Z', from: '2026-10-01', to: '2026-10-30' }, scope: 'BUSINESS', capturedAt: '2026-10-30T17:00:00.000Z', expiresAt: '2026-10-30T17:05:00.000Z', snapshotToken: 'corte', sourceVectorDigest: 'd'.repeat(64), coverage: { status: 'INCOMPLETE', reasons: ['PARTIAL_COVERAGE'] }, denominatorScope: 'AUTHORIZED_UNIVERSE' },
      totalRows: 2,
      totals: [{ columnId: 'book', status: 'COMPLETE', value: '80.00' }, { columnId: 'reserved', status: 'COMPLETE', value: '20.00' }, { columnId: 'estimated', status: 'UNAVAILABLE', value: null }, { columnId: 'excludedParticipation', status: 'NOT_APPLICABLE', value: null }],
    };
    const page = { ...snapshot, items: [{ id: 'fila-1', cells: [{ columnId: 'principal', status: 'COMPLETE', value: '80.00' }, { columnId: 'interest', status: 'COMPLETE', value: '0.00' }] }, { id: 'fila-2', cells: [{ columnId: 'principal', status: 'UNAVAILABLE', value: null }] }], pageTotals: [{ columnId: 'principal', status: 'COMPLETE', value: '80.00' }], nextCursor: null };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req' });
      if (path.includes('/snapshot')) return json({ data: snapshot, requestId: 'req' });
      if (path.includes('/rows')) return json({ data: page, requestId: 'req' });
      return json({ error: { code: 'RESOURCE_NOT_FOUND' }, requestId: 'req' }, 404);
    }));
    const user = userEvent.setup();
    render(<Reports root="/organizations/11111111-1111-4111-8111-111111111111/exchange-s11" policy={{ ...policy, reportKinds: ['CASH'], formats: ['CSV'] }} />);
    await user.click(screen.getByRole('button', { name: 'Consultar corte' }));
    expect(await screen.findByText(/Filas del conjunto:\s*2/)).toBeInTheDocument();
    expect(screen.getByText('Totales del conjunto')).toBeInTheDocument();
    expect(screen.getByText('Totales solo de la última página')).toBeInTheDocument();
    expect(screen.getAllByText('No disponible').length).toBeGreaterThan(0);
    expect(screen.getAllByText('NA').length).toBeGreaterThan(0);
    expect(screen.getByText('fila-2')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Estimación')).toBeInTheDocument());
    expect(screen.getByText('Reservas')).toBeInTheDocument();
    expect(screen.getByText('Porción excluida')).toBeInTheDocument();
  });
});
