import { useEffect, useRef, useState } from 'react';
import { call } from '../../shared/api';
import { ApiError } from '../../shared/contracts';
import { Alert, Empty, ErrorText, Field } from '../../shared/ui';

export const ACCOUNT_PAGE_LIMIT = '20';

export interface AccountOption {
  id: string;
  code: string;
  name: string;
  accountClass: string;
  kind: string;
  status: string;
  version: number;
  currency: string;
}

interface Page<T> { items: T[]; nextCursor: string | null }

const CLASS_LABEL: Record<string, string> = {
  ASSET: 'Activo', LIABILITY: 'Pasivo', EQUITY: 'Patrimonio', INCOME: 'Ingreso', EXPENSE: 'Gasto',
};
const KIND_LABEL: Record<string, string> = { CASH: 'Caja', BANK: 'Banco', GENERAL: 'General' };

export function AccountPicker({ base, value, onChange, label, accountClass, kinds }: {
  base: string;
  value: string;
  onChange: (accountId: string) => void;
  label: string;
  accountClass?: string;
  kinds?: readonly string[];
}) {
  const [items, setItems] = useState<AccountOption[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [page, setPage] = useState<string | null>(null);
  const [back, setBack] = useState<(string | null)[]>([]);
  const [query, setQuery] = useState('');
  const [classFilter, setClassFilter] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [selected, setSelected] = useState<AccountOption | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const onChangeRef = useRef(onChange);
  const previousBase = useRef(base);
  onChangeRef.current = onChange;

  async function load(cursor: string | null) {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ limit: ACCOUNT_PAGE_LIMIT });
    if (cursor) params.set('cursor', cursor);
    try {
      const result = await call<Page<AccountOption>>('GET', `${base}/accounts?${params.toString()}`);
      if (request.current !== id) return;
      setItems(Array.isArray(result.data.items) ? result.data.items : []);
      setNextCursor(result.data.nextCursor ?? null);
      setPage(cursor);
    } catch (caught) {
      if (request.current !== id) return;
      if (caught instanceof ApiError && caught.status === 422 && cursor) {
        setNotice('La página pedida no es válida. Se vuelve a la primera, sin tratarlo como un resultado.');
        setBack([]);
        await load(null);
        return;
      }
      setError(caught);
    } finally {
      if (request.current === id) setLoading(false);
    }
  }

  useEffect(() => {
    if (previousBase.current !== base) {
      previousBase.current = base;
      setNotice('Cambió el libro consultado. La selección anterior se retiró.');
      setSelected(null);
      onChangeRef.current('');
    }
    setBack([]);
    void load(null);
    return () => { request.current += 1; };
  }, [base]);

  useEffect(() => {
    if (!value) {
      setSelected(null);
      return;
    }
    let cancel = false;
    void call<AccountOption>('GET', `${base}/accounts/${value}`).then(result => {
      if (cancel) return;
      if (!result.data?.id || result.data.id !== value) {
        setResolveError('La ficha devuelta no corresponde a la cuenta seleccionada.');
        return;
      }
      setSelected(result.data);
      setResolveError(null);
    }).catch(caught => {
      if (cancel) return;
      if (caught instanceof ApiError && (caught.status === 401 || caught.status === 403 || caught.status === 404)) {
        setSelected(null);
        setResolveError(caught.status === 404
          ? 'El servidor no tiene esa cuenta o ya no está disponible. La selección se retiró.'
          : caught.message);
        onChangeRef.current('');
        return;
      }
      setResolveError(caught instanceof ApiError ? caught.message : 'No se pudo leer la cuenta seleccionada.');
    });
    return () => { cancel = true; };
  }, [base, value]);

  const visible = items.filter(account => {
    if (accountClass && account.accountClass !== accountClass) return false;
    if (kinds && !kinds.includes(account.kind)) return false;
    if (classFilter && account.accountClass !== classFilter) return false;
    if (kindFilter && account.kind !== kindFilter) return false;
    const needle = query.trim().toLocaleLowerCase('es-CO');
    if (!needle) return true;
    return `${account.code} ${account.name}`.toLocaleLowerCase('es-CO').includes(needle);
  });

  return (
    <div className="stack">
      <Field label={`Buscar ${label} en esta página`} hint="La búsqueda no consulta el servidor ni descarga el libro. Solo recorre las cuentas ya visibles.">
        <input value={query} onChange={event => setQuery(event.target.value)} autoComplete="off" />
      </Field>
      <div className="split">
        <Field label={`Clase visible de ${label}`}>
          <select value={classFilter} onChange={event => setClassFilter(event.target.value)}>
            <option value="">Todas las de esta página</option>
            {Object.entries(CLASS_LABEL).map(([code, caption]) => <option key={code} value={code}>{caption}</option>)}
          </select>
        </Field>
        <Field label={`Tipo visible de ${label}`}>
          <select value={kindFilter} onChange={event => setKindFilter(event.target.value)}>
            <option value="">Todos los de esta página</option>
            {Object.entries(KIND_LABEL).map(([code, caption]) => <option key={code} value={code}>{caption}</option>)}
          </select>
        </Field>
      </div>
      {loading ? <p role="status">Cargando cuentas de {label}…</p> : null}
      <ErrorText error={error} />
      {notice ? <Alert tone="info">{notice}</Alert> : null}
      {resolveError ? <Alert tone="error">{resolveError}</Alert> : null}
      {selected ? (
        <article className="card selected-account" aria-live="polite">
          <h3>Seleccionada para {label}</h3>
          <p>{selected.code} · {selected.name}</p>
          <p>{CLASS_LABEL[selected.accountClass] ?? selected.accountClass} · {KIND_LABEL[selected.kind] ?? selected.kind} · {selected.status} · {selected.currency}</p>
          <p className="muted">Identificador {selected.id}. La ficha sigue visible al cambiar de página.</p>
        </article>
      ) : value ? <p role="status">Consultando la cuenta seleccionada…</p> : <p className="muted">Todavía no hay cuenta seleccionada para {label}.</p>}
      {items.length === 0 ? <Empty>No hay cuentas en esta página.</Empty> : null}
      {items.length > 0 && visible.length === 0 ? <Empty>Sin cuentas elegibles en esta página. Si hay siguientes, la cuenta puede estar más adelante.</Empty> : null}
      <div className="cards">
        {visible.map(account => (
          <article key={account.id} className="card">
            <h3>{account.code} · {account.name}</h3>
            <p>{CLASS_LABEL[account.accountClass] ?? account.accountClass} · {KIND_LABEL[account.kind] ?? account.kind} · {account.status}</p>
            <button type="button" aria-pressed={value === account.id} onClick={() => { setResolveError(null); onChange(account.id); }}>
              {value === account.id ? `Elegida ${account.code} para ${label}` : `Elegir ${account.code} para ${label}`}
            </button>
          </article>
        ))}
      </div>
      <div className="pager">
        <button type="button" disabled={back.length === 0 || loading} onClick={() => {
          const previous = back.at(-1) ?? null;
          setBack(current => current.slice(0, -1));
          void load(previous);
        }}>{label}: cuentas anteriores</button>
        <button type="button" disabled={!nextCursor || loading} onClick={() => {
          if (!nextCursor) return;
          setBack(current => [...current, page]);
          void load(nextCursor);
        }}>{label}: cuentas siguientes</button>
      </div>
      {nextCursor ? <p className="muted">Hay más cuentas. No se descargan solas.</p> : null}
    </div>
  );
}
