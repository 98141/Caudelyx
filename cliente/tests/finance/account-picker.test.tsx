import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AccountPicker } from '../../src/features/finance/account-picker';

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
    expect(await screen.findByRole('button', { name: 'Elegir C1 para banco' })).toBeInTheDocument();
    expect(screen.queryByText('Banco de la segunda')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'banco: cuentas siguientes' }));
    await user.click(await screen.findByRole('button', { name: 'Elegir BANK_FUERA para banco' }));
    expect(await screen.findByRole('heading', { name: 'Seleccionada para banco' })).toBeInTheDocument();
    expect(screen.getAllByText(/Banco de la segunda/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'banco: cuentas anteriores' }));
    expect(await screen.findByRole('button', { name: 'Elegir C1 para banco' })).toBeInTheDocument();
    expect(screen.getAllByText(/Banco de la segunda/).length).toBeGreaterThan(0);
    await user.type(screen.getByLabelText('Buscar banco en esta página'), 'no-esta');
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
    await user.click(await screen.findByRole('button', { name: 'Elegir RETIRADA para banco' }));
    expect(await screen.findByText(/La selección se retiró/)).toBeInTheDocument();
    expect(screen.getByText('Todavía no hay cuenta seleccionada para banco.')).toBeInTheDocument();
  });
});
