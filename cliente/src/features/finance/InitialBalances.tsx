import { useEffect, useRef, useState } from 'react';
import { AccountPicker } from './account-picker';
import { call } from '../../shared/api';
import { ApiError } from '../../shared/contracts';
import { cents, formatCop, fromCents, parseLocalCop, todayBogota } from '../../shared/money';
import { Alert, ErrorText, Field, Submit, onSubmit } from '../../shared/ui';

interface Row { accountId: string; amount: string }
interface OpeningFile { id: string; status: string }

export function InitialBalances({ base, organizationId, onRecorded }: { base: string; organizationId: string; onRecorded: () => Promise<void> }) {
  const [eligibility, setEligibility] = useState<'loading' | 'open' | 'used' | 'opening' | 'unknown'>('loading');
  const [review, setReview] = useState(false);
  const [date, setDate] = useState(todayBogota());
  const [support, setSupport] = useState('');
  const [description, setDescription] = useState('Saldo inicial');
  const [rows, setRows] = useState<Row[]>([{ accountId: '', amount: '' }]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const binding = useRef<{content: string; sourceId: string; key: string} | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const journals = await call<{ items: unknown[] }>('GET', `${base}/journal-entries?limit=1`);
        if (!live) return;
        if (journals.data.items.length > 0) { setEligibility('used'); return; }
        const openings = await call<{ items: OpeningFile[] }>('GET', `${base}/opening-files?limit=20`);
        if (!live) return;
        const active = openings.data.items.some(item => item.status === 'DRAFT' || item.status === 'VALIDATED' || item.status === 'APPROVED');
        setEligibility(active ? 'opening' : 'open');
      } catch {
        if (live) setEligibility('unknown');
      }
    })();
    return () => { live = false; };
  }, [base, done]);

  const parsed = rows.map(row => parseLocalCop(row.amount));
  const total = parsed.reduce<bigint>((sum, amount) => sum + (amount && amount !== '0.00' ? cents(amount) ?? 0n : 0n), 0n);
  const items = rows.flatMap((row, index) => {
    const amount = parsed[index];
    if (!row.accountId || !amount || amount === '0.00') return [];
    return [{ accountId: row.accountId, amount }];
  });

  if (done) return <Alert tone="ok">Saldo inicial registrado. El servidor confirmó el asiento. Un saldo nuevo se registra con un asiento normal.</Alert>;
  if (eligibility === 'used') return <Alert tone="info">El saldo inicial de este libro ya no está disponible. Un saldo nuevo se registra con un asiento normal.</Alert>;
  if (eligibility === 'loading') return <p role="status">Comprobando si el libro admite saldo inicial…</p>;
  if (eligibility === 'unknown') return <Alert tone="error">No se pudo confirmar con el servidor si el libro está vacío. No se ofrece el saldo inicial.</Alert>;
  if (eligibility === 'opening') return <Alert tone="pending">Hay una apertura avanzada en curso. Continúa o cancela ese expediente. No se borra desde aquí.</Alert>;

  return (
    <section className="capture" aria-labelledby="saldo-inicial">
      <h2 id="saldo-inicial">Registrar saldo inicial</h2>
      <p>Registra el dinero que ya tienes; no es un pago recibido ni una ganancia.</p>
      <ErrorText error={error} />
      {!review ? (
        <form onSubmit={onSubmit(async () => {
          if (rows.some((row, index) => (row.amount.trim() || row.accountId) && (!parsed[index] || parsed[index] !== '0.00' && !row.accountId))) throw new ApiError(422, 'INPUT_INVALID', null, 'Revisa todas las cuentas e importes; no se omiten filas inválidas.');
          if (new Set(items.map(item => item.accountId)).size !== items.length) throw new ApiError(422, 'INPUT_INVALID', null, 'Cada cuenta se registra una sola vez.');
          if (items.length === 0) throw new ApiError(422, 'INPUT_INVALID', null, 'Agrega al menos una cuenta con importe mayor que cero.');
          setReview(true);
        }, setPending, setError)}>
          <Field label="Fecha"><input type="date" value={date} max={todayBogota()} onChange={event => setDate(event.target.value)} required /></Field>
          <Field label="Soporte"><input value={support} onChange={event => setSupport(event.target.value)} maxLength={200} required /></Field>
          <Field label="Descripción"><input value={description} onChange={event => setDescription(event.target.value)} maxLength={200} required /></Field>
          {rows.map((row, index) => (
            <div key={index} className="split">
              <AccountPicker base={base} label={`cuenta ${index + 1}`} value={row.accountId} accountClass="ASSET" kinds={['CASH', 'BANK']} status="ACTIVE" onChange={accountId => setRows(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, accountId } : item))} />
              <Field label="Monto"><input value={row.amount} inputMode="decimal" onChange={event => setRows(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, amount: event.target.value } : item))} /></Field>
              <button type="button" onClick={() => setRows(current => current.filter((_, itemIndex) => itemIndex !== index))} disabled={rows.length === 1}>Quitar fila</button>
            </div>
          ))}
          <button type="button" onClick={() => setRows(current => current.length >= 99 ? current : [...current, { accountId: '', amount: '' }])}>Añadir fila</button>
          <Submit pending={pending}>Revisar</Submit>
          <button type="button" onClick={() => { setRows([{ accountId: '', amount: '' }]); setReview(false); setError(null); }}>Cancelar</button>
        </form>
      ) : (
        <form onSubmit={onSubmit(async () => {
          const command = { effectiveDate: date, supportReference: support.trim(), description: description.trim(), items };
          const content = JSON.stringify(command);
          if (binding.current?.content !== content) binding.current = {content, sourceId: crypto.randomUUID(), key: crypto.randomUUID()};
          const payload = {...command, sourceId: binding.current.sourceId};
          await call('POST', `/organizations/${organizationId}/financial/initial-balances`, payload, { idempotencyKey: binding.current.key });
          setDone(true);
          setReview(false);
          await onRecorded();
        }, setPending, setError)}>
          <p>Contrapartida: Capital inicial. Total {formatCop(fromCents(total)) ?? fromCents(total)} COP.</p>
          <ul>{items.map(item => <li key={item.accountId}>{item.amount} COP</li>)}</ul>
          <Submit pending={pending}>Registrar</Submit>
          <button type="button" onClick={() => setReview(false)}>Volver</button>
        </form>
      )}
    </section>
  );
}
