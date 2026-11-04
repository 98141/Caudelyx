import { useEffect, useState,useRef } from 'react';
import { call } from '../../shared/api';
import { ApiError, DiscardedRequest } from '../../shared/contracts';
import { parseLocalCop } from '../../shared/money';
import { ensureStepUp } from '../../shared/step-up';
import { Empty, ErrorText, Field, onSubmit } from '../../shared/ui';
import { useSimple } from './context';
import { createSlot, keyFor, markUncertain, releaseSlot } from './memory';
import { pageSum,formatPreviewCop } from './model';
import { ScopeBar } from './Month';
import { concealed } from './transport';
import { CashSelect,More } from './widgets';

const noteSlot = createSlot();
const paySlot = createSlot();
const GENERAL=['GENERAL'] as const;
const CATEGORIES = ['SERVICES', 'RENT', 'SUPPLIES', 'INTEREST', 'INSURANCE', 'FEES', 'OTHER'] as const;
const CATEGORY_LABEL: Record<string, string> = {
  SERVICES: 'Servicios', RENT: 'Arriendo', SUPPLIES: 'Insumos', INTEREST: 'Interés', INSURANCE: 'Seguro', FEES: 'Cargos', OTHER: 'Otra',
};

interface ExpenseRow { id: string; description?: string; category?: string; amount?: string | null; nominalDate?: string; status?: string; amountMode?: string;recognitionStatus?:string;settlementStatus?:string;paid?:string;outstanding?:string }

export function ExpensesScreen() {
  const simple = useSimple();
  const base = simple.scope === 'BUSINESS' && simple.organizationId
    ? `/organizations/${simple.organizationId}/finance-s09`
    : simple.scope === 'PERSONAL' && simple.bookId ? `/me/personal/books/${simple.bookId}/finance-s09` : null;
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [cursor,setCursor]=useState<string|null>(null),[loading,setLoading]=useState(false);const snapshot=useRef<string|null>(null);
  useEffect(()=>{setCursor(null);snapshot.current=null;},[base,simple.effectiveDate,simple.knownAt,reload]);
  useEffect(() => {
    if (!base) { setRows([]); return; }
    if(cursor&&!snapshot.current)return;
    const ac = new AbortController();
    let live = true;setLoading(true);setError(null);
    void call<{ items?: ExpenseRow[]; nextCursor?: string | null }>('GET', `${base}/expenses?asOf=${simple.effectiveDate}&recordedThrough=${encodeURIComponent(simple.knownAt)}&limit=20${cursor?'&cursor='+encodeURIComponent(cursor):''}${snapshot.current?'&snapshotToken='+encodeURIComponent(snapshot.current):''}`, undefined, { signal: ac.signal }).then(result => {
      if (!live) return;
      snapshot.current=(result.meta as {snapshotToken?:string}|null)?.snapshotToken??null;
      setRows(result.data.items ?? []);
      setNext(result.data.nextCursor ?? null);
    }).catch(caught => {
      if (!live || caught instanceof DiscardedRequest) return;
      setRows([]);
      setError(concealed(caught));
    }).finally(()=>{if(live)setLoading(false);});
    return () => { live = false; ac.abort(); };
  }, [base, simple.effectiveDate,simple.knownAt,reload,cursor]);
  const accountsBase = simple.scope === 'BUSINESS' && simple.organizationId ? `/organizations/${simple.organizationId}/financial` : base;
  const sum = pageSum(rows.map(row => row.amount ?? null));
  return (
    <section className="simple-wrap" data-screen="gastos">
      <h1 id="page-title" tabIndex={-1}>¿En qué se va mi dinero?</h1>
      <ScopeBar />
      <ErrorText error={error} />
      {loading?<p role="status">Consultando gastos…</p>:null}
      <p>Anotar deja el gasto en la agenda, sin mover dinero. Pagar es otra acción y pide autorización vigente. Consultar no crea gastos ni marca pagos.</p>
      <div className="simple-table-wrap">
        <table className="simple-table">
          <caption>{next ? 'Total de esta página. Hay más filas.' : 'Filas de esta página, sin páginas siguientes.'}</caption>
          <thead><tr><th>Descripción</th><th>Categoría</th><th>Fecha</th><th>Importe</th><th>Pagado</th><th>Pendiente</th><th>Estado</th></tr></thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.id}>
                <td>{row.description ?? 'Sin descripción'}</td>
                <td>{CATEGORY_LABEL[row.category ?? ''] ?? row.category ?? 'Sin categoría'}</td>
                <td>{row.nominalDate ?? 'Sin fecha'}</td>
                <td className="num">{row.amount ? formatPreviewCop(row.amount) : 'Sin importe'}</td>
                <td className="num">{formatPreviewCop(row.paid)}</td><td className="num">{formatPreviewCop(row.outstanding)}</td><td>{row.settlementStatus==='PAID'?'Pagado':row.settlementStatus==='PARTIAL'?'Pago parcial':row.recognitionStatus==='RECOGNIZED'?'Pendiente de pago':row.amount?'Anotado':'Anotado, sin precio'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading&&rows.length === 0 ? <Empty>No hay gastos en esta consulta.</Empty> : <p>Suma de importes conocidos en esta página: {sum.text}. No es el total del libro.</p>}
      {next?<button type="button" onClick={()=>setCursor(next)}>Página siguiente de gastos</button>:null}{cursor?<button type="button" onClick={()=>setCursor(null)}>Primera página de gastos</button>:null}
      {base ? <NoteForm base={base} onDone={() => setReload(value => value + 1)} /> : <p>Abre el libro de este ámbito para anotar.</p>}
      {base && accountsBase ? <PayForm key={cursor??'first'} base={base} accountsBase={accountsBase} expenses={rows} onDone={() => setReload(value => value + 1)} /> : null}
    </section>
  );
}

function NoteForm({ base, onDone }: { base: string; onDone: () => void }) {
  const simple = useSimple();
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [dueDate, setDueDate] = useState(simple.effectiveDate);
  const [support, setSupport] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  return (
    <form className="simple-form" onSubmit={onSubmit(async () => {
      if (!description.trim() || !category || !support.trim()) throw new ApiError(422, 'INPUT_INVALID', null, 'Indica descripción, categoría y soporte.');
      const body = { nominalDate: simple.effectiveDate, dueDate, description: description.trim(), category, amountMode: 'VARIABLE', supportReference: support.trim() };
      const key = keyFor(noteSlot, JSON.stringify({ base, body }));
      try {
        await call('POST', `${base}/expenses`, body, { idempotencyKey: key });
        releaseSlot(noteSlot);
        onDone();
        simple.refreshCut();
      } catch (caught) {
        if (caught instanceof ApiError && (caught.status === 0 || caught.status === 503)) markUncertain(noteSlot);
        else releaseSlot(noteSlot);
        throw caught;
      }
    }, setPending, setError)}>
      <h2>Anotar</h2>
      <ErrorText error={error} />
      <Field label="Descripción"><input value={description} onChange={event => setDescription(event.target.value)} required /></Field>
      <Field label="Categoría">
        <select value={category} onChange={event => setCategory(event.target.value)} required>
          <option value="">Selecciona</option>
          {CATEGORIES.map(item => <option key={item} value={item}>{CATEGORY_LABEL[item]}</option>)}
        </select>
      </Field>
      <Field label="Fecha nominal"><input type="date" value={simple.effectiveDate} onChange={event => simple.setEffectiveDate(event.target.value)} required /></Field>
      <Field label="Vencimiento"><input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} required /></Field>
      <Field label="Soporte"><input value={support} onChange={event => setSupport(event.target.value)} required /></Field>
      <p>Sin importe. Queda anotado, no pagado.</p>
      <button type="submit" disabled={pending}>Anotar sin dinero</button>
    </form>
  );
}

function PayForm({ base, accountsBase, expenses, onDone }: { base: string; accountsBase: string; expenses:ExpenseRow[]; onDone: () => void }) {
  const simple = useSimple();
  const [expenseId, setExpenseId] = useState('');
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [support, setSupport] = useState('');
  const [expenseAccount,setExpenseAccount]=useState(''),[payableAccount,setPayableAccount]=useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  return (
    <form className="simple-form" onSubmit={onSubmit(async () => {
      const canonical = parseLocalCop(amount);
      if (!expenseId || !canonical || !accountId || !support.trim()) throw new ApiError(422, 'INPUT_INVALID', null, 'Indica el gasto, el importe, la cuenta y el soporte.');
      const current = await call<{recognitionStatus:string}>('GET', `${base}/expenses/${expenseId}?asOf=${simple.effectiveDate}`);
      if (!current.etag) throw new ApiError(428, 'ETAG_REQUIRED', null, 'Falta la versión del gasto.');
      const recognizing=current.data.recognitionStatus!=='RECOGNIZED';
      if(recognizing&&(!expenseAccount||!payableAccount))throw new ApiError(422,'INPUT_INVALID',null,'Este gasto aún no tiene reconocimiento. Abre las cuentas del gasto y elige ambas; el servidor no las inventa.');
      const body = { amount: canonical, effectiveDate: simple.effectiveDate, cashAccountId: accountId, supportReference: support.trim(),...(recognizing?{expenseAccountId:expenseAccount,payableAccountId:payableAccount}:{}) };
      const summary = `${canonical} COP el ${simple.effectiveDate}, desde la cuenta elegida.`;
      if (preview !== summary) { setPreview(summary); return; }
      const key = keyFor(paySlot, JSON.stringify({ base, expenseId, body, etag: current.etag }));
      try {
        const purpose=recognizing?'EXPENSE_RECOGNIZE_AND_PAY':'EXPENSE_PAY',operationId=(simple.scope==='PERSONAL'?'personal':'business')+(recognizing?'RecognizeAndPayExpense':'PayExpense'),scope=simple.scope==='PERSONAL'?{bookId:simple.bookId!}:{organizationId:simple.organizationId};
        await ensureStepUp({ purpose, resourceId: expenseId, command:{operationId,...scope,idempotencyKey:key,pathParameters:{...scope,expenseId},payload:body,expectedETag:current.etag}, summary: 'Reconocer y pagar queda en una sola transacción; no se registra medio efecto.' });
        await call('POST', `${base}/expenses/${expenseId}/${recognizing?'recognize-and-pay':'payments'}`, body, { idempotencyKey: key, ifMatch: current.etag });
        releaseSlot(paySlot);
        setPreview(null);
        onDone();
        simple.refreshCut();
      } catch (caught) {
        if (caught instanceof ApiError && (caught.status === 0 || caught.status === 503)) markUncertain(paySlot);
        else if (!(caught instanceof ApiError) || caught.name === 'StepUpCancelled') releaseSlot(paySlot);
        throw caught;
      }
    }, setPending, setError)}>
      <h2>Pagar</h2>
      <ErrorText error={error} />
      <Field label="Gasto anotado"><select value={expenseId} onChange={event => { setExpenseId(event.target.value); setPreview(null); }} required><option value="">Selecciona</option>{expenses.map(row=><option key={row.id} value={row.id}>{row.description ?? row.id.slice(0,8)}</option>)}</select></Field>
      <Field label="Importe"><input inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value); setPreview(null); }} required /></Field>
      <Field label="Fecha del pago"><input type="date" value={simple.effectiveDate} onChange={event => { simple.setEffectiveDate(event.target.value); setPreview(null); }} required /></Field>
      <CashSelect base={accountsBase} value={accountId} onChange={value => { setAccountId(value); setPreview(null); }} />
      <Field label="Soporte"><input value={support} onChange={event => { setSupport(event.target.value); setPreview(null); }} required /></Field>
      <More label="Cuentas del gasto sin reconocer"><p>Obligatorias si solo estaba anotado. Se reconoce y paga de forma atómica, con cuentas existentes.</p><CashSelect base={accountsBase} kinds={GENERAL} label="Cuenta de gasto" value={expenseAccount} onChange={v=>{setExpenseAccount(v);setPreview(null);}}/><CashSelect base={accountsBase} kinds={GENERAL} label="Cuenta por pagar" value={payableAccount} onChange={v=>{setPayableAccount(v);setPreview(null);}}/></More>
      {preview ? <p role="status">Se enviará {preview} No es un saldo calculado aquí.</p> : null}
      <button type="submit" disabled={pending}>{preview ? 'Confirmar pago' : 'Revisar pago'}</button>
    </form>
  );
}
