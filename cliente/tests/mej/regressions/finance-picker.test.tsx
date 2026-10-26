// MEJ-4 adapted version by Codex; original read-only: finance/account-picker
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AccountPicker } from '../../../src/features/finance/account-picker';

const outside = '22222222-2222-4222-8222-222222222222';

function account(index: number) {
  return {
    id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
    code: `C${index}`,
    name: `Cuenta ${index}`,
    accountClass: 'ASSET',
    kind: 'BANK',
    status: 'ACTIVE',
    version: 1,
    currency: 'COP',
  };
}

function Harness() {
  const [value, setValue] = useState('');
  return <AccountPicker base="/organizations/11111111-1111-4111-8111-111111111111/financial" label="banco" value={value} onChange={setValue} />;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ETag: '"22222222-2222-4222-8222-222222222222:1"' } });
}

describe('selector de cuentas', () => {
  it('elige una cuenta de otra página y la conserva al volver y al filtrar', async () => {
    const urls: string[] = [];
    const first = Array.from({ length: 20 }, (_, index) => account(index + 1));
    const second = [{ ...account(21), id: outside, code: 'BANK_FUERA', name: 'Banco de la segunda' }];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (url.endsWith(`/accounts/${outside}`)) return json({ data: second[0], requestId: 'req-fixture' });
      if (url.includes('cursor=page-2')) return json({ data: { items: second, nextCursor: null }, requestId: 'req-fixture' });
      if (url.includes('cursor=')) return json({ error: { code: 'INPUT_INVALID' }, requestId: 'req-fixture' }, 422);
      return json({ data: { items: first, nextCursor: 'page-2' }, requestId: 'req-fixture' });
    }));
    const user = userEvent.setup();
    render(<Harness />);
    expect(await optionFor('banco', 'C1')).toBeInTheDocument();
    expect(screen.queryByText('Banco de la segunda')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'banco: cuentas siguientes' }));
    await user.click(await optionFor('banco', 'BANK_FUERA'));
    expect(await screen.findByText(/Elegida: BANK_FUERA/)).toBeInTheDocument();
    expect(screen.getAllByText(/Banco de la segunda/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'banco: cuentas anteriores' }));
    expect(await optionFor('banco', 'C1')).toBeInTheDocument();
    expect(screen.getAllByText(/Banco de la segunda/).length).toBeGreaterThan(0);
    await user.type(screen.getByRole('combobox', {name:'banco'}), 'no-esta');
    expect(screen.getByText('Sin cuentas elegibles en esta página. Si hay siguientes, la cuenta puede estar más adelante.')).toBeInTheDocument();
    expect(screen.getAllByText(/Banco de la segunda/).length).toBeGreaterThan(0);
    expect(urls.filter(url => url.includes('/accounts')).every(url => !url.includes('search=') && (url.includes('limit=20') || url.endsWith(`/accounts/${outside}`)))).toBe(true);
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('muestra la cuenta retirada y no la deja seleccionada en silencio', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (url.endsWith(`/accounts/${outside}`)) return json({ error: { code: 'RESOURCE_NOT_FOUND' }, requestId: 'req-fixture' }, 404);
      return json({ data: { items: [{ ...account(1), id: outside, code: 'RETIRADA', name: 'Cuenta retirada' }], nextCursor: null }, requestId: 'req-fixture' });
    }));
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(await optionFor('banco', 'RETIRADA'));
    expect(await screen.findByText(/La selección se retiró/)).toBeInTheDocument();
    expect(screen.getByText('Todavía no hay cuenta seleccionada para banco.')).toBeInTheDocument();
  });

  it('no ofrece general ni una cuenta inactiva cuando el uso pide caja o banco activa', async () => {
    const bank = account(2);
    const general = { ...account(3), id: '33333333-3333-4333-8333-333333333333', code: 'GEN_01', name: 'Puente', kind: 'GENERAL' };
    const inactive = { ...account(4), id: '44444444-4444-4444-8444-444444444444', code: 'BANK_OFF', name: 'Banco inactivo', status: 'INACTIVE' };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      return json({ data: { items: [general, inactive, bank], nextCursor: null }, requestId: 'req-fixture' });
    }));
    render(<AccountPicker base="/organizations/11111111-1111-4111-8111-111111111111/financial" label="origen" value="" accountClass="ASSET" kinds={['CASH', 'BANK']} status="ACTIVE" onChange={() => undefined} />);
    expect(await optionFor('origen', 'C2')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /GEN_01/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /BANK_OFF/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'General' })).not.toBeInTheDocument();
  });

  it('retira la selección si la cuenta deja de estar activa', async () => {
    const changes: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req-fixture' });
      if (url.endsWith(`/accounts/${outside}`)) return json({ data: { ...account(1), id: outside, code: 'BANK_OFF', name: 'Banco inactivo', status: 'INACTIVE' }, requestId: 'req-fixture' });
      return json({ data: { items: [], nextCursor: null }, requestId: 'req-fixture' });
    }));
    render(<AccountPicker base="/organizations/11111111-1111-4111-8111-111111111111/financial" label="origen" value={outside} status="ACTIVE" onChange={id => changes.push(id)} />);
    expect(await screen.findByText(/ya no cumple la condición elegida/)).toBeInTheDocument();
    expect(changes).toEqual(['']);
  });
});

async function optionFor(label: string, code: string) {
  await userEvent.click(await screen.findByRole('combobox', {name:label}));
  return await screen.findByRole('option', {name: new RegExp('^'+code+' ·')});
}
