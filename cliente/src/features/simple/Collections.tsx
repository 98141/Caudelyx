import { useEffect, useState } from 'react';
import {useAuth} from '../../shared/auth';
import { call } from '../../shared/api';
import { ApiError } from '../../shared/contracts';
import { parseLocalCop,todayBogota } from '../../shared/money';
import { ensureStepUp } from '../../shared/step-up';
import { ErrorText, Field, onSubmit } from '../../shared/ui';
import { useSimple } from './context';
import {formatPreviewCop} from './model';
import { usePortfolio } from './Loans';
import { createSlot, keyFor,releaseSlot } from './memory';
import type { PreviewDocument, ReceiptDocument } from './types';
import { ScopeBar } from './Month';
import { bookUrl, msGet, postKnown,postNativeKnown } from './transport';
import { cutQuery } from './transport';
import { CashSelect, GrantNote, More, PreviewBox,useBorrowerLabels } from './widgets';

const creditSlot = createSlot();
const cashSlot = createSlot();

export function CollectionsScreen() {
  const portfolio = usePortfolio();
  const simple = useSimple();
  return (
    <section className="simple-wrap" data-screen="cobros">
      <h1 id="page-title" tabIndex={-1}>¿Quién me pagó y cuánto?</h1>
      <ScopeBar />
      {simple.scope !== 'BUSINESS' ? <p>Los cobros mensuales de este contrato son del libro de negocio.</p> : null}
      <ErrorText error={portfolio.error} />
      <p>Tras confirmar, el saldo se vuelve a consultar al servidor. Un pago pendiente no reduce la deuda confirmada.</p>
      {simple.scope === 'BUSINESS' && simple.bookId ? (
        <>
          <PaymentsList />
          <CreditForm rows={portfolio.page?.rows ?? []} />
          <CashForm rows={portfolio.page?.rows ?? []} />
        </>
      ) : null}
    </section>
  );
}

function CreditForm({ rows }: { rows: Array<{ id: string; borrowerId: string }> }) {
  const simple = useSimple();
  const [loanId, setLoanId] = useState('');
  const [amount, setAmount] = useState('');
  const [support, setSupport] = useState('');
  const [preview, setPreview] = useState<PreviewDocument | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const loan = rows.find(row => row.id === loanId);
  useEffect(() => { setPreview(null); setAfter(null); }, [simple.cutSerial]);
  return (
    <form className="simple-form" onSubmit={onSubmit(async () => {
      if (!simple.bookId || !simple.bookEtag || !loan) throw new ApiError(428, 'ETAG_REQUIRED', null, 'Elige el préstamo y actualiza el corte.');
      const canonical = parseLocalCop(amount);
      if (!canonical || !support.trim()) throw new ApiError(422, 'INPUT_INVALID', null, 'Faltan importe o soporte.');
      const position = await msGet<unknown>(bookUrl(simple.bookId, `monthly-loans/${loan.id}`, cutQuery({ month: simple.month, effectiveDate: simple.effectiveDate, knownAt: simple.knownAt })));
      const credit = await call<unknown>('GET', `/organizations/${simple.organizationId}/loan-operations/credits/${loan.borrowerId}`);
      if (!position.etag || !credit.etag) throw new ApiError(428, 'ETAG_REQUIRED', null, 'Falta la versión del préstamo o de la cuenta de crédito.');
      const intent = { expectedBookETag: simple.bookEtag, effectiveDate: simple.effectiveDate, borrowerId: loan.borrowerId, amount: canonical, expectedCreditETag: credit.etag, expectedLoanETag: position.etag, supportReference: support.trim() };
      const key = keyFor(creditSlot, JSON.stringify(intent));
      if (!preview) {
        const result = await postKnown<PreviewDocument>(creditSlot, key, bookUrl(simple.bookId, `monthly-loans/${loan.id}/credit-application-previews`), { ...intent, executionKey: key }, position.etag, undefined, 'keep');
        setPreview(result.data);
        return;
      }
      if (preview.status !== 'READY' || Date.parse(preview.expiresAt) <= Date.now()) throw new ApiError(412, 'PRECONDITION_FAILED', null, 'La vista previa no sigue válida. Pide otra con la misma clave.');
      await ensureStepUp({ purpose: 'MS_MONTHLY_CREDIT_APPLY', resourceId: loan.id, command: { operationId: 'msCommitCreditApplication', bookId: simple.bookId, payload: { executionKey: key, previewToken: preview.previewToken, requestHash: preview.requestHash } }, summary: 'Usar crédito a favor no añade caja; el servidor muestra el interés satisfecho y el capital reducido.' });
      await postKnown<ReceiptDocument>(creditSlot, key, bookUrl(simple.bookId, `monthly-loans/${loan.id}/credit-applications`), { executionKey: key, previewToken: preview.previewToken, requestHash: preview.requestHash }, position.etag, undefined, 'finish');
      const next = await msGet<{ principalOutstanding: { value: string | null } }>(bookUrl(simple.bookId, `monthly-loans/${loan.id}`, cutQuery({ month: simple.month, effectiveDate: simple.effectiveDate, knownAt: simple.knownAt })));
      setAfter(next.data.principalOutstanding?.value ?? null);
      setPreview(null);
    }, setPending, setError)}>
      <h2>Aplicar crédito a favor</h2>
      <p>Usa un saldo a favor ya reconocido. No entra caja nueva; puede satisfacer interés y reducir capital según la vista previa.</p>
      <GrantNote />
      <ErrorText error={error} />
      <LoanSelect rows={rows} value={loanId} onChange={value => { setLoanId(value); setPreview(null); }} />
      <Field label="Importe"><input inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value); setPreview(null); }} required /></Field>
      <Field label="Fecha"><input type="date" value={simple.effectiveDate} onChange={event => simple.setEffectiveDate(event.target.value)} required /></Field>
      <Field label="Soporte"><input value={support} onChange={event => { setSupport(event.target.value); setPreview(null); }} required /></Field>
      {preview ? <PreviewBox preview={preview} /> : null}
      <button type="submit" disabled={pending}>{preview ? 'Confirmar crédito' : 'Ver interés, capital y crédito'}</button>
      {after !== null ? <p role="status">Capital después, según el servidor: {after} COP.</p> : null}
      {after === null && preview === null && error === null ? null : null}
    </form>
  );
}

interface NativePaymentPreview{token:string;expiresAt:string;paymentsBookETag:string;plan:{allocations:{component:string;amount:string}[];creditAdded:string;heldFundsAdded:string};key:string;command:unknown;paymentId?:string}
function CashForm({ rows }: { rows: Array<{ id: string; borrowerId: string }> }) {
  const {me}=useAuth();
  const simple = useSimple();
  const [loanId, setLoanId] = useState('');
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [method, setMethod] = useState('');
  const [mode, setMode] = useState('');
  const [excess, setExcess] = useState('');
  const [support, setSupport] = useState('');
  const [receipt, setReceipt] = useState('');
  const [custodian, setCustodian] = useState('');
  const [preview, setPreview] = useState<PreviewDocument | null>(null);
  const [nativeAfter,setNativeAfter]=useState<string|null>(null);
  const [nativePreview,setNativePreview]=useState<NativePaymentPreview|null>(null),[nativeSaved,setNativeSaved]=useState<{status:string;effectiveDate:string|null}|null>(null);
  const [saved, setSaved] = useState<ReceiptDocument | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const loan = rows.find(row => row.id === loanId);
  useEffect(() => { setPreview(null);setNativePreview(null);setNativeAfter(null); }, [simple.cutSerial]);
  return (
    <form className="simple-form" onSubmit={onSubmit(async () => {
      if(nativePreview){
       if(Date.parse(nativePreview.expiresAt)<=Date.now()&&!nativePreview.paymentId)throw new ApiError(412,'PRECONDITION_FAILED',null,'La vista previa venció. Recaptura los mismos datos antes de confirmar.');
       let id=nativePreview.paymentId;
       if(!id){const body={command:nativePreview.command,previewToken:nativePreview.token};await ensureStepUp({purpose:'PAYMENT_REGISTER_DIRECT',summary:'Registrar el interés, el principal y el excedente mostrados, por S06.',command:{organizationId:simple.organizationId,operationId:'registerPayment',resourceId:null,idempotencyKey:nativePreview.key,expectedETag:nativePreview.paymentsBookETag,payload:body}});const r=await postNativeKnown<{entityId:string}>(cashSlot,nativePreview.key,`/organizations/${simple.organizationId}/payments`,body,nativePreview.paymentsBookETag,'keep');id=r.data.entityId;setNativePreview({...nativePreview,paymentId:id});}
       const confirmed=await call<{status:string;effectiveDate:string|null}>('GET',`/organizations/${simple.organizationId}/payments/${id}`);setNativeSaved(confirmed.data);const latest=await call<{principalOutstanding:string}>('GET',`/organizations/${simple.organizationId}/loan-operations/positions/${loanId}`);setNativeAfter(latest.data.principalOutstanding);releaseSlot(cashSlot);setNativePreview(null);setAmount('');simple.refreshCut();return;
      }
      if (!simple.bookId || !simple.bookEtag || !loan) throw new ApiError(428, 'ETAG_REQUIRED', null, 'Elige el préstamo y actualiza el corte.');
      const canonical = parseLocalCop(amount);
      if (!canonical || !accountId || !method || !mode || !excess || !support.trim() || !receipt.trim() || !custodian) {
        throw new ApiError(422, 'INPUT_INVALID', null, 'Faltan importe, destino, medio, variante, excedente, soporte o referencia. No se elige crédito de excedente por defecto.');
      }
      const position = await call<unknown>('GET', `/organizations/${simple.organizationId}/loan-operations/positions/${loan.id}`);
      const account = await call<unknown>('GET', `/organizations/${simple.organizationId}/financial/accounts/${accountId}`);
      if (!position.etag || !account.etag) throw new ApiError(428, 'ETAG_REQUIRED', null, 'Falta la versión del préstamo o de la cuenta.');
      const binding=custodian==='none'?null:await call<unknown>('GET',`/organizations/${simple.organizationId}/custody-bindings/${custodian}`);
      if(custodian!=='none'&&!binding?.etag)throw new ApiError(428,'ETAG_REQUIRED',null,'Falta el vínculo de custodia vigente.');
      const directIntent = {
        method, borrowerId: loan.borrowerId, amount: canonical, currency: 'COP', destinationAccountId: accountId, destinationAccountETag: account.etag,
        custodianId: custodian === 'none' ? null : custodian, bindingETag: binding?.etag??null, observedDate: simple.effectiveDate, observedAt: simple.knownAt,
        receiptReference: receipt.trim(), supportReference: support.trim(),
        targets: [{ loanId: loan.id, positionETag: position.etag, amount: canonical, mode }],
        excessDisposition: excess,
      };
      if(simple.effectiveDate===todayBogota()){
       const state=await call<{paymentsBookETag:string}>('GET',`/organizations/${simple.organizationId}/payments/state`),command={kind:'REGISTER',mode:'DIRECT',effectiveDate:simple.effectiveDate,intent:directIntent},key=keyFor(cashSlot,JSON.stringify(command));const r=await postNativeKnown<Omit<NativePaymentPreview,'key'|'command'>>(cashSlot,key,`/organizations/${simple.organizationId}/payment-previews`,{executionKey:key,expectedPaymentsETag:state.data.paymentsBookETag,command},undefined,'keep');setNativePreview({...r.data,key,command});return;
      }
      const intent = { kind: 'LOAN_PAYMENT', loanId: loan.id, effectiveDate: simple.effectiveDate, originReference: receipt.trim(), supportReference: support.trim(), expectedBookETag: simple.bookEtag, directIntent };
      const key = keyFor(cashSlot, JSON.stringify(intent));
      if (!preview) {
        const result = await postKnown<PreviewDocument>(cashSlot, key, bookUrl(simple.bookId, 'history-previews'), { ...intent, executionKey: key }, simple.bookEtag, undefined, 'keep');
        setPreview(result.data);
        return;
      }
      if (preview.status !== 'READY' || Date.parse(preview.expiresAt) <= Date.now()) throw new ApiError(412, 'PRECONDITION_FAILED', null, 'La vista previa del abono no sigue válida.');
      await ensureStepUp({ purpose: 'MS_HISTORY_COMMIT', resourceId: loan.id, command: { operationId: 'msCommitHistory', bookId: simple.bookId, payload: { executionKey: key, previewToken: preview.previewToken, requestHash: preview.requestHash } }, summary: mode === 'SETTLEMENT' ? 'Cancelar entre fechas cobra el ciclo que muestre la vista previa.' : 'Registrar el abono con el interés y el capital de la vista previa.' });
      const result = await postKnown<ReceiptDocument>(cashSlot, key, bookUrl(simple.bookId, 'history-commits'), { executionKey: key, previewToken: preview.previewToken, requestHash: preview.requestHash }, simple.bookEtag, undefined, 'finish');
      setSaved(result.data);
      setAmount('');
      simple.refreshCut();
      setPreview(null);
    }, setPending, setError)}>
      <h2>Abono en efectivo o banco</h2>
      <p>La cancelación entre fechas muestra el interés y el capital del ciclo antes de guardar. Un excedente no se vuelve crédito si no lo eliges.</p>
      <ErrorText error={error} />
      <LoanSelect rows={rows} value={loanId} onChange={value => { setLoanId(value); setPreview(null);setNativePreview(null); }} />
      <Field label="Importe"><input inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value); setPreview(null);setNativePreview(null); }} required /></Field>
      <Field label="Fecha"><input type="date" value={simple.effectiveDate} onChange={event => { simple.setEffectiveDate(event.target.value); setPreview(null);setNativePreview(null); }} required /></Field>
      <Field label="Medio">
        <select value={method} onChange={event => { setMethod(event.target.value); setPreview(null);setNativePreview(null); }} required>
          <option value="">Selecciona</option>
          <option value="CASH">Efectivo</option>
          <option value="BANK">Banco</option>
        </select>
      </Field>
      <CashSelect base={`/organizations/${simple.organizationId}/financial`} value={accountId} onChange={value => { setAccountId(value); setPreview(null);setNativePreview(null); }} label="Cuenta destino" />
      <Field label="Variante">
        <select value={mode} onChange={event => { setMode(event.target.value); setPreview(null);setNativePreview(null); }} required>
          <option value="">Selecciona</option>
          <option value="REGULAR">Abono del ciclo</option>
          <option value="EXTRA_PRINCIPAL">Abono extra a capital</option>
          <option value="SETTLEMENT">Cancelación entre fechas</option>
        </select>
      </Field>
      <More label="Más opciones del abono">
      <Field label="Si sobra dinero">
        <select value={excess} onChange={event => { setExcess(event.target.value); setPreview(null);setNativePreview(null); }} required>
          <option value="">Selecciona</option>
          <option value="REJECT">No dejarlo como crédito</option>
          <option value="CREDIT">Dejarlo como crédito a favor, no como capital</option>
        </select>
      </Field>
      <Field label="Referencia del recibo"><input value={receipt} onChange={event => { setReceipt(event.target.value); setPreview(null);setNativePreview(null); }} required /></Field>
      <Field label="Soporte"><input value={support} onChange={event => { setSupport(event.target.value); setPreview(null);setNativePreview(null); }} required /></Field>
      <Field label="Custodio">
        <select value={custodian} onChange={event => { setCustodian(event.target.value); setPreview(null);setNativePreview(null); }} required>
          <option value="">Selecciona</option>
          <option value="none">Sin custodio</option>
          {me?.userId?<option value={me.userId}>Yo, con vínculo de custodia vigente</option>:null}
        </select>
      </Field>
      </More>
      {mode === 'SETTLEMENT' ? <p>La cancelación usa la regla del ciclo completo. El interés y el capital son los de la vista previa, no un cálculo de esta pantalla.</p> : null}
      {nativePreview?<div className="simple-preview" role="status"><p>Vista previa S06, válida hasta {nativePreview.expiresAt}.</p>{nativePreview.plan.allocations.map((a,i)=><p key={i}>{a.component==='INTEREST'?'Interés':'Capital'} {formatPreviewCop(a.amount)}.</p>)}<p>Crédito nuevo {formatPreviewCop(nativePreview.plan.creditAdded)}. Protección de custodia {formatPreviewCop(nativePreview.plan.heldFundsAdded)}.</p></div>:preview ? <PreviewBox preview={preview} /> : null}
      <button type="submit" disabled={pending}>{nativePreview?.paymentId?'Consultar recibo':nativePreview||preview ? 'Confirmar abono' : 'Ver interés, capital y crédito'}</button>
      {nativeAfter!==null?<p role="status">Capital después, según el servidor: {formatPreviewCop(nativeAfter)}.</p>:null}
      {nativeSaved?<p role="status">Recibo {nativeSaved.status==='CONFIRMED'?'confirmado':nativeSaved.status==='PENDING'?'pendiente':nativeSaved.status} del {nativeSaved.effectiveDate??'sin fecha confirmada'}. La posición se consulta al servidor.</p>:null}
      {saved ? <p role="status">Recibo {saved.status === 'CONFIRMED' ? 'confirmado' : saved.status === 'PENDING_APPROVAL' ? 'pendiente' : 'provisional'} del {saved.effectiveDate}. No es el total del libro.</p> : null}
    </form>
  );
}

function LoanSelect({ rows, value, onChange }: { rows: Array<{ id: string; borrowerId: string }>; value: string; onChange: (value: string) => void }) {
  const names=useBorrowerLabels(rows.map(r=>r.borrowerId));
  return (
    <Field label="Préstamo" hint="Si hay varios, elige uno. No se toma el primero.">
      <select value={value} onChange={event => onChange(event.target.value)} required>
        <option value="">Selecciona</option>
        {rows.map(row => <option key={row.id} value={row.id}>{names[row.borrowerId]??'Consultando cliente…'} · {row.id.slice(0, 8)}</option>)}
      </select>
    </Field>
  );
}

interface PaymentRow{id:string;status:string;effectiveDate:string|null;intent:{amount:string;method:string}}
function PaymentsList(){
 const s=useSimple(),[items,setItems]=useState<PaymentRow[]>([]),[cursor,setCursor]=useState<string|null>(null),[next,setNext]=useState<string|null>(null),[error,setError]=useState<unknown>(null);
 useEffect(()=>{const ac=new AbortController();let live=true;setItems([]);setError(null);void call<{items:PaymentRow[];nextCursor:string|null}>('GET',`/organizations/${s.organizationId}/payments?limit=20${cursor?'&cursor='+encodeURIComponent(cursor):''}`,undefined,{signal:ac.signal}).then(r=>{if(live){setItems(r.data.items);setNext(r.data.nextCursor);}}).catch(e=>{if(live)setError(e);});return()=>{live=false;ac.abort();};},[s.organizationId,s.knownAt,cursor]);
 return <section><h2>Pagos registrados</h2><p>Registros actuales del negocio, no el corte histórico de Mi mes. Se muestran hasta20por página; pendiente y confirmado se distinguen.</p><ErrorText error={error}/><div className="simple-table-wrap"><table className="simple-table"><caption>Pagos de esta página; no hay suma de otras páginas.</caption><thead><tr><th>Fecha efectiva</th><th>Importe recibido</th><th>Medio</th><th>Estado</th></tr></thead><tbody>{items.map(r=><tr key={r.id}><td>{r.effectiveDate??'Sin confirmar'}</td><td>{formatPreviewCop(r.intent.amount)}</td><td>{r.intent.method==='BANK'?'Banco':'Efectivo'}</td><td>{r.status==='CONFIRMED'?'Confirmado':r.status==='PENDING'?'Pendiente':r.status==='REVERSED'?'Reversado':r.status}</td></tr>)}</tbody></table></div>{!items.length?<p>Sin pagos registrados en esta página.</p>:null}{next?<button onClick={()=>setCursor(next)}>Más pagos</button>:null}{cursor?<button onClick={()=>setCursor(null)}>Primera página de pagos</button>:null}</section>;
}
