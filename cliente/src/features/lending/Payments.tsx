import { useEffect, useRef, useState } from 'react';
import { AccountPicker } from '../finance/account-picker';
import { call as apiCall } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { ApiError, DiscardedRequest, inOrganization, purposeClass } from '../../shared/contracts';
import { parseLocalCop, todayBogota } from '../../shared/money';
import { ensureStepUp } from '../../shared/step-up';
import { Alert, Empty, ErrorText, Field, Submit, onSubmit } from '../../shared/ui';
import {
  APPROVAL_STATUS, CUSTODY_DELTA, CUSTODY_STATUS, EMPTY_FILTERS, INSTALLMENT, PART, PAYMENT_STATUS, RECONCILIATION_STATUS,
  accountText, borrowerText, canApprove, canCancel, canConfigure, canDirect, canReconcile, canRegister,
  custodyExplanation, label, loanText, matches, money, paymentKnown, roleSet, rowName, type PaymentFilters, type PaymentIntent,
  type PaymentRecord, type RegistrationContext,
} from './payments-copy';
import { clearDraft, ownerKey, readDraft, writeDraft, type DraftOwner } from './payments-draft';

interface BookState { organizationId: string; paymentsBookETag: string; operationsBookETag: string; policyRevision: string }
interface Policy { version: string; usage: string; realUseAllowed: false; currency: 'COP' }
interface Page<T> { items: T[]; nextCursor: string | null }
interface PlanLine { loanId: string; installmentNumber: number; component: string; amount: string }
interface Plan { effectiveDate: string; postings: { accountId: string; debit: string; credit: string }[]; allocations: PlanLine[]; creditAdded: string; creditApplied: string; heldFundsAdded: string; custodyDelta: string; snapshotHash: string }
interface Preview { token: string; expiresAt: string; paymentsBookETag: string; operationsBookETag: string; plan: Plan }
interface CommandResult { entityType: string; entityId: string; paymentsBookETag: string; operationsBookETag: string; replayed: boolean }
interface InstallmentRow { loanId: string; number: number; dueDate: string; principal: string; interest: string; payment: string; status: string }
interface Custody { id: string; paymentId: string; amountHeld: string; state: string; responsibleId: string }
interface BankRow { id: string; accountId: string; amount: string; valueDate: string; reference: string; statementReference: string; lineReference: string; state: string; activeLinkId: string | null }
interface Reversal { id: string; originalEventId: string; originalKind: string; state: string; requestedAt: string; reason: string }
interface Frozen { operation: string; payload: Record<string, unknown>; resourceId: string | null; etag: string }

const PAGE_CAP = 5;

function contextKey(row: RegistrationContext): string {
  return `${row.loanId}|${row.permittedDestinationId}|${row.permittedMethod}`;
}

export function PaymentsScreen() {
  const {me,phase}=useAuth();
  useEffect(()=>{if(phase==='anonymous')clearDraft();},[phase]);
  if(!me||!inOrganization(me)||phase!=='ready')return <section className="panel"><h1>Pagos</h1><p>Hace falta una sesión activa de la organización.</p></section>;
  return <PaymentsWorkspace key={`${me.userId}|${me.organizationId}|${[...(me.roleIds??[])].sort().join(',')}`} />;
}
function PaymentsWorkspace() {
  const { me, phase } = useAuth();
  const organizationId = me?.organizationId ?? '';
  const actorId = me?.userId ?? '';
  const ready = inOrganization(me) && phase === 'ready';
  const roles = roleSet(me?.roleIds);
  const owner: DraftOwner = { userId: actorId, organizationId, roles: [...roles].sort().join(',') };
  const base = `/organizations/${organizationId}`;
  const active=useRef(true),controller=useRef(new AbortController()),openSequence=useRef(0);
  useEffect(()=>{active.current=true;controller.current=new AbortController();return()=>{active.current=false;controller.current.abort();};},[]);
  async function call<T>(method:string,path:string,body?:unknown,extra?:{ifMatch?:string;idempotencyKey?:string}){
    if(!active.current)throw new DiscardedRequest();
    return await apiCall<T>(method,path,body,{...extra,signal:controller.current.signal});
  }
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [book, setBook] = useState<BookState | null>(null);
  const [items, setItems] = useState<PaymentRecord[]>([]);
  const [contexts, setContexts] = useState<RegistrationContext[]>([]);
  const [filters, setFilters] = useState<PaymentFilters>(EMPTY_FILTERS);
  const [payment, setPayment] = useState<PaymentRecord | null>(null);
  const [paymentEtag, setPaymentEtag] = useState<string | null>(null);
  const [installments, setInstallments] = useState<InstallmentRow[]>([]);
  const [custody, setCustody] = useState<Custody | null>(null);
  const [banks, setBanks] = useState<BankRow[]>([]);
  const [reversal, setReversal] = useState<Reversal | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [targetAmounts, setTargetAmounts] = useState<Record<string, string>>({});
  const [targetModes, setTargetModes] = useState<Record<string, 'REGULAR' | 'EXTRA_PRINCIPAL'>>({});
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [support, setSupport] = useState('');
  const [excess, setExcess] = useState<'CREDIT' | 'REJECT'>('REJECT');
  const [mode, setMode] = useState<'DIRECT' | 'SUPERVISED'>('SUPERVISED');
  const [observedDate, setObservedDate] = useState(todayBogota());
  const [reason, setReason] = useState('');
  const [bankAccount, setBankAccount] = useState('');
  const [bankEtag, setBankEtag] = useState<string | null>(null);
  const [bankAmount, setBankAmount] = useState('');
  const [bankDate, setBankDate] = useState(todayBogota());
  const [bankName, setBankName] = useState('');
  const [statementRef, setStatementRef] = useState('');
  const [lineRef, setLineRef] = useState('');
  const [bankReference, setBankReference] = useState('');
  const [chosenBank, setChosenBank] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewCommand, setPreviewCommand] = useState<Record<string, unknown> | null>(null);
  const [custodyEtag, setCustodyEtag] = useState<string | null>(null);
  const [reversalEtag, setReversalEtag] = useState<string | null>(null);
  const [previewKind, setPreviewKind] = useState<'REGISTER' | 'APPROVE' | 'EXECUTE_REVERSAL' | null>(null);
  const [consent, setConsent] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [heldAccount, setHeldAccount] = useState('');
  const [heldEtag, setHeldEtag] = useState<string | null>(null);
  const [custodianId, setCustodianId] = useState('');
  const [cashAccount, setCashAccount] = useState('');
  const [scopeActive,setScopeActive]=useState(true);
  const [recipient,setRecipient]=useState('');
  const [cashEtag, setCashEtag] = useState<string | null>(null);
  const books = useRef<BookState | null>(null);
  const keyRef = useRef<string | null>(null);
  const frozen = useRef<string | null>(null);
  const previousOwner = useRef('');
  const sawSession = useRef(false);
  const [draftReady, setDraftReady] = useState(false);
  const scopeId = useRef(crypto.randomUUID());

  function executionKey(): string {
    keyRef.current ??= crypto.randomUUID();
    return keyRef.current;
  }
  function edit(apply: () => void) {
    if (frozen.current) {
      setNotice('La respuesta anterior no está confirmada. No se cambia la clave ni el cuerpo ya enviado.');
      return;
    }
    setPreview(null);
    setPreviewCommand(null);
    setConsent(false);
    setPreviewKind(null);
    apply();
  }

  async function pages<T>(path: string): Promise<T[]> {
    const collected: T[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < PAGE_CAP; page += 1) {
      const params = new URLSearchParams({ limit: '100' });
      if (cursor) params.set('cursor', cursor);
      const result = await call<Page<T>>('GET', `${path}?${params.toString()}`);
      collected.push(...result.data.items);
      cursor = result.data.nextCursor;
      if (!cursor) break;
    }
    return collected;
  }

  async function load() {
    const state = await call<BookState>('GET', `${base}/payments/state`);
    books.current = state.data;
    setBook(state.data);
    const current = await call<Policy>('GET', `${base}/payments/policy`);
    if (current.data.realUseAllowed !== false) throw new ApiError(403, 'REAL_USE_NOT_ALLOWED', current.requestId, 'La política no permite uso real. No se mostraron pagos.');
    setPolicy(current.data);
    setItems(await pages<PaymentRecord>(`${base}/payments`));
    try {
      setContexts(canRegister(roles)?await pages<RegistrationContext>(`${base}/payments/registration-contexts`):[]);
    } catch (caught) {
      if (!(caught instanceof ApiError) || caught.status !== 403) throw caught;
      setContexts([]);
    }
  }

  async function openPayment(id: string) {
    const sequence=++openSequence.current;
    const result=await call<PaymentRecord>('GET',`${base}/payments/${id}`);
    const rows:InstallmentRow[]=[];let found:Custody|null=null,heldEtag:string|null=null,request:Reversal|null=null,requestEtag:string|null=null;
    if(roles.has('T'))for(const target of result.data.intent.targets)rows.push(...await pages<InstallmentRow>(`${base}/loan-operations/positions/${target.loanId}/installments`));
    if(result.data.intent.method==='CASH'&&['T','O','C'].some(r=>roles.has(r))){const held=await call<Custody>('GET',`${base}/cash-custody/${id}`);found=held.data;heldEtag=held.etag;}
    if(roles.has('T')&&result.data.reversalRequestId){const r=await call<Reversal>('GET',`${base}/loan-event-reversal-requests/${result.data.reversalRequestId}`);request=r.data;requestEtag=r.etag;}
    const declarations=canReconcile(roles)&&result.data.intent.method==='BANK'?await pages<BankRow>(`${base}/bank-declarations`):[];
    if(!active.current||sequence!==openSequence.current)throw new DiscardedRequest();
    setPayment(result.data);setPaymentEtag(result.etag);setInstallments(rows);setCustody(found);setCustodyEtag(heldEtag);setReversal(request);setReversalEtag(requestEtag);setBanks(declarations);
  }

  useEffect(() => {
    if (phase === 'anonymous') {
      if (sawSession.current) {
        clearDraft();
        setDraftReady(false);
      }
      return;
    }
    sawSession.current = true;
  }, [phase]);

  useEffect(() => {
    if (!ready || !actorId) return;
    const current = ownerKey(owner);
    if (previousOwner.current && previousOwner.current !== current) {
      clearDraft();
      setDraftReady(false);
      setItems([]);
      setContexts([]);
      setPayment(null);
      setPreview(null);
      setPreviewCommand(null);
      setConsent(false);
      setNotice(null);
      setUncertain(false);
      setAmount('');
      setReference('');
      setSupport('');
      setReason('');
      setSelected([]);
      setTargetAmounts({});
      keyRef.current = null;
      frozen.current = null;
      scopeId.current = crypto.randomUUID();
    }
    previousOwner.current = current;
    const saved = readDraft(owner);
    if (saved) {
      setAmount(saved.fields.amount ?? '');
      setReference(saved.fields.reference ?? '');
      setSupport(saved.fields.support ?? '');
      setExcess(saved.fields.excess === 'CREDIT' ? 'CREDIT' : 'REJECT');
      setMode(saved.fields.mode === 'DIRECT' ? 'DIRECT' : 'SUPERVISED');
      setObservedDate(saved.fields.observedDate || todayBogota());
      setReason(saved.fields.reason ?? '');
      setSelected(saved.fields.selected ? saved.fields.selected.split(',').filter(Boolean) : []);
      setTargetAmounts(saved.fields.targetAmounts ? JSON.parse(saved.fields.targetAmounts) as Record<string, string> : {});
      setTargetModes(saved.fields.targetModes ? JSON.parse(saved.fields.targetModes) as Record<string,'REGULAR'|'EXTRA_PRINCIPAL'> : {});
      setFilters(saved.fields.filters ? JSON.parse(saved.fields.filters) as PaymentFilters : EMPTY_FILTERS);
      keyRef.current = saved.executionKey;
      frozen.current = saved.frozen;
      setUncertain(Boolean(saved.frozen));
    }
    setDraftReady(true);
  }, [ready, actorId, organizationId, owner.roles]);

  useEffect(() => {
    if (!draftReady || !ready || !actorId) return;
    writeDraft({
      owner,
      executionKey: keyRef.current,
      frozen: frozen.current,
      fields: {
        amount, reference, support, excess, mode, observedDate, reason,
        selected: selected.join(','),
        targetAmounts: JSON.stringify(targetAmounts),targetModes:JSON.stringify(targetModes),filters:JSON.stringify(filters),
      },
    });
  }, [draftReady, ready, actorId, amount, reference, support, excess, mode, observedDate, reason, selected, targetAmounts,targetModes,filters,uncertain]);

  useEffect(() => {
    if (!ready) return;
    let live = true;
    setError(null);
    void load().catch(caught => { if (live) setError(caught); });
    return () => { live = false; };
  }, [ready, organizationId, owner.roles]);

  function chosenRows(): RegistrationContext[] {
    return contexts.filter(row => selected.includes(contextKey(row)));
  }

  function intent(): PaymentIntent {
    const rows = chosenRows();
    const first = rows[0];
    if (!first || rows.some(row => row.borrowerId !== first.borrowerId || row.permittedMethod !== first.permittedMethod || row.permittedDestinationId !== first.permittedDestinationId)) {
      throw new ApiError(422, 'INPUT_INVALID', null, 'Elige préstamos del mismo prestatario, con el mismo medio y el mismo destino. No se armó el registro.');
    }
    const canonical = parseLocalCop(amount);
    if (!canonical || canonical === '0.00') throw new ApiError(422, 'INPUT_INVALID', null, 'Falta el importe del recibo. No se calculó uno en la pantalla.');
    if (!reference.trim() || !support.trim()) throw new ApiError(422, 'INPUT_INVALID', null, 'Faltan la referencia o el soporte. No se registró.');
    const targets = rows.map(row => {
      const targetAmount = parseLocalCop(targetAmounts[row.loanId] ?? '');
      if (!targetAmount || targetAmount === '0.00') throw new ApiError(422, 'INPUT_INVALID', null, 'Falta el importe de un préstamo. No se repartió en la pantalla.');
      return { loanId: row.loanId, positionETag: row.positionETag, amount: targetAmount, mode: targetModes[row.loanId] ?? 'REGULAR' as const };
    });
    const direct = mode === 'DIRECT' && canDirect(roles);
    if (mode === 'DIRECT' && !direct) throw new ApiError(403, 'ACCESS_DENIED', null, 'El registro directo solo lo pide un titular. No se envió.');
    return {
      method: first.permittedMethod,
      borrowerId: first.borrowerId,
      amount: canonical,
      currency: 'COP',
      destinationAccountId: first.permittedDestinationId,
      destinationAccountETag: first.permittedDestinationAccountETag,
      custodianId: first.permittedMethod === 'CASH' ? actorId : null,
      bindingETag: first.permittedMethod === 'CASH' ? first.permittedBindingETag : null,
      observedDate,
      observedAt: new Date().toISOString(),
      receiptReference: reference.trim().normalize('NFC'),
      supportReference: support.trim().normalize('NFC'),
      targets,
      excessDisposition: excess,
    };
  }

  async function ask(kind: 'REGISTER' | 'APPROVE' | 'EXECUTE_REVERSAL') {
    if (frozen.current) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', null, 'Hay un comando sin confirmar. No se pide otro plan ni otra clave.');
    if (!books.current) throw new ApiError(428, 'ETAG_REQUIRED', null, 'Falta la versión del libro de pagos. No se pidió el plan.');
    const today = todayBogota();
    let command: Record<string, unknown>;
    if (kind === 'REGISTER') command = { kind, mode: mode === 'DIRECT' && canDirect(roles) ? 'DIRECT' : 'SUPERVISED', effectiveDate: today, intent: intent() };
    else if (kind === 'APPROVE') {
      if (!payment || !paymentEtag) throw new ApiError(422, 'INPUT_INVALID', null, 'No hay un pago pendiente seleccionado. No se pidió la aprobación.');
      command = { kind, paymentId: payment.id, resourceETag: paymentEtag, effectiveDate: today, expectedOperationsETag: books.current.operationsBookETag };
    } else {
      if (!payment?.eventId || !reversal) throw new ApiError(422, 'INPUT_INVALID', null, 'No hay una solicitud de reverso. No se pidió la compensación.');
      const current = await call<Reversal>('GET', `${base}/loan-event-reversal-requests/${payment.eventId}`);
      command = { kind, paymentId: payment.id, resourceETag: current.etag, originalEventId: payment.eventId, reversalRequestId: reversal.id, effectiveDate: today, expectedOperationsETag: books.current.operationsBookETag, supportReference: support.trim().normalize('NFC') || 'soporte' };
    }
    const result = await call<Preview>('POST', `${base}/payment-previews`, { executionKey: executionKey(), expectedPaymentsETag: books.current.paymentsBookETag, command });
    setPreviewCommand(command);
    setPreview(result.data);
    setPreviewKind(kind);
    setConsent(false);
    setNotice(null);
  }

  async function send(operation: string, payload: Record<string, unknown>, resourceId: string | null) {
    const saved: Frozen | null = frozen.current ? JSON.parse(frozen.current) as Frozen : null;
    const body = saved?.payload ?? payload;
    const id = saved ? saved.resourceId : resourceId;
    const op = saved?.operation ?? operation;
    const bookEtag = saved?.etag ?? books.current?.paymentsBookETag;
    if (!bookEtag) throw new ApiError(428, 'ETAG_REQUIRED', null, 'Falta la versión del libro de pagos. No se envió.');
    const purpose = op === 'registerPayment'
      ? ((body.command as { mode?: string }).mode === 'DIRECT' ? 'PAYMENT_REGISTER_DIRECT' : 'PAYMENT_REGISTER')
      : purposeOf(op);
    if (!purpose) throw new ApiError(422, 'INPUT_INVALID', null, 'Estado no reconocido. No hay acciones.');
    const key = executionKey();
    const command = { organizationId, idempotencyKey: key, expectedETag: bookEtag, operationId: op, resourceId: id, payload: body };
    if (purposeClass(purpose)) {
      await ensureStepUp({ purpose, ...(id ? { resourceId: id } : {}), command, summary: 'Confirmar la acción de pago. Preparar el plan no la ejecuta.' });
    }
    frozen.current=JSON.stringify({operation:op,payload:body,resourceId:id,etag:bookEtag} satisfies Frozen);
    const persist=()=>writeDraft({owner,executionKey:keyRef.current,frozen:frozen.current,fields:{amount,reference,support,excess,mode,observedDate,reason,selected:selected.join(','),targetAmounts:JSON.stringify(targetAmounts),targetModes:JSON.stringify(targetModes),filters:JSON.stringify(filters)}});
    persist();
    let result;
    try{result=await call<CommandResult>('POST',actionPath(base,op,id),body,{ifMatch:bookEtag,idempotencyKey:key});}
    catch(caught){
      if(caught instanceof ApiError&&(caught.status===0||caught.status===503||caught.code==='IDEMPOTENCY_CONFLICT'))setUncertain(true);
      else if(caught instanceof ApiError){frozen.current=null;keyRef.current=null;setUncertain(false);setPreview(null);setPreviewCommand(null);setPreviewKind(null);setConsent(false);persist();}
      throw caught;
    }
    frozen.current=null;keyRef.current=null;setUncertain(false);setPreview(null);setPreviewCommand(null);setPreviewKind(null);setConsent(false);persist();
    setNotice(result.data.replayed?'El servidor ya tenía este comando. No se envió otro.':'El servidor confirmó el comando. Esto no habilita un cobro real.');
    try{
      await load();
      if(['approvePayment','rejectPayment'].includes(op)&&roles.has('P')&&!roles.has('T')){setPayment(null);setPaymentEtag(null);setInstallments([]);}
      else {const opened=result.data.entityType==='PAYMENT'?result.data.entityId:payment?.id;if(opened)await openPayment(opened);}
    }catch(caught){if(caught instanceof DiscardedRequest)throw caught;setNotice('El comando se confirmó. No se pudo actualizar la vista; usa Refrescar.');}
  }

  async function consult() {
    if (!keyRef.current) throw new ApiError(422, 'INPUT_INVALID', null, 'No hay una clave de comando en esta pantalla.');
    try {
      await call('GET', `${base}/payments/commands/${keyRef.current}`);
      frozen.current = null;
      keyRef.current = null;
      setUncertain(false);
      setPreview(null);
      setPreviewCommand(null);
      setConsent(false);
      setNotice('El servidor ya tiene este comando. No se envió otro.');
      await load();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 404) {
        setNotice('No hay un comando comprometido con esta clave para este actor. Eso no demuestra que no haya una operación en curso.');
        return;
      }
      throw caught;
    }
  }

  async function resourceETag(path:string,fallback:string){
    try{return (await call('GET',`${base}/${path}`)).etag??fallback;}
    catch(caught){if(caught instanceof ApiError&&caught.status===404)return fallback;throw caught;}
  }
  async function configureScope(){
    const loanId=chosenRows()[0]?.loanId;
    if(!custodianId||!loanId)throw new ApiError(422,'INPUT_INVALID',null,'Elige un cobrador y un préstamo.');
    const rows=await pages<{id:string;registrarId:string;loanId:string}>(`${base}/payment-registration-scopes`),existing=rows.find(x=>x.registrarId===custodianId&&x.loanId===loanId),id=existing?.id??scopeId.current;
    const tag=await resourceETag(`payment-registration-scopes/${id}`,`"${id}:0"`);
    await send('setPaymentRegistrationScope',{scopeId:id,registrarId:custodianId,loanId,scope:'PAYMENT_REGISTER_ONLY',active:scopeActive,resourceETag:tag,supportReference:support.trim()},null);
    scopeId.current=crypto.randomUUID();
  }
  async function rememberAccount(id: string, assign: (etag: string | null) => void) {
    assign(null);
    if (!id) return;
    const result = await call('GET', `${base}/financial/accounts/${id}`);
    assign(result.etag);
  }

  const visible = items.filter(item => matches(item, contexts, filters));
  const blocked = payment ? !paymentKnown(payment) : false;
  const registerRows = chosenRows();
  const registerMethod = registerRows[0]?.permittedMethod;

  return (
    <section className="panel">
      <h1>Pagos</h1>
      <Alert tone="info">Entorno local sintético. Confirmar un plan no autoriza un cobro real. El estado confirmado no se muestra como conciliado.</Alert>
      {policy ? <p>Política {policy.version}. Moneda {policy.currency}. Uso {policy.usage}.</p> : null}
      {book ? <p>Versión del libro de pagos disponible para el siguiente comando.</p> : null}
      <ErrorText error={error} />
      {notice ? <Alert tone="pending">{notice}</Alert> : null}
      <form onSubmit={onSubmit(async () => { await load(); if (payment) await openPayment(payment.id); }, setPending, setError)}>
        <h2>Filtros de la página cargada</h2>
        <p>La consulta solo trae páginas. Estos filtros no inventan otra búsqueda en el servidor.</p>
        <Field label="Prestatario, código o nombre"><input value={filters.borrower} onChange={event => setFilters(current => ({ ...current, borrower: event.target.value }))} /></Field>
        <Field label="Préstamo"><input value={filters.loan} onChange={event => setFilters(current => ({ ...current, loan: event.target.value }))} /></Field>
        <Field label="Cuenta"><input value={filters.account} onChange={event => setFilters(current => ({ ...current, account: event.target.value }))} /></Field>
        <Field label="Importe"><input value={filters.amount} inputMode="decimal" onChange={event => setFilters(current => ({ ...current, amount: event.target.value }))} /></Field>
        <Field label="Fecha observada"><input type="date" value={filters.date} onChange={event => setFilters(current => ({ ...current, date: event.target.value }))} /></Field>
        <Field label="Estado del pago"><StatusSelect value={filters.paymentStatus} options={PAYMENT_STATUS} onChange={value => setFilters(current => ({ ...current, paymentStatus: value }))} /></Field>
        <Field label="Estado de la aprobación"><StatusSelect value={filters.approvalState} options={APPROVAL_STATUS} onChange={value => setFilters(current => ({ ...current, approvalState: value }))} /></Field>
        <Field label="Estado de la custodia"><StatusSelect value={filters.custodyState} options={CUSTODY_STATUS} onChange={value => setFilters(current => ({ ...current, custodyState: value }))} /></Field>
        <Field label="Estado de la conciliación"><StatusSelect value={filters.reconciliationState} options={RECONCILIATION_STATUS} onChange={value => setFilters(current => ({ ...current, reconciliationState: value }))} /></Field>
        <Submit pending={pending}>Refrescar</Submit>
      </form>
      <div className="schedule">
        <table>
          <caption>Pagos de esta organización</caption>
          <thead>
            <tr>
              <th scope="col">Prestatario</th>
              <th scope="col">Préstamo</th>
              <th scope="col">Cuenta</th>
              <th scope="col">Importe</th>
              <th scope="col">Fecha</th>
              <th scope="col">Estado del pago</th>
              <th scope="col">Aprobación</th>
              <th scope="col">Custodia</th>
                <th scope="col">Conciliación</th>
                <th scope="col">Abrir</th>
              </tr>
          </thead>
          <tbody>
            {visible.map(item => (
              <tr key={item.id}>
                <td>{borrowerText(item, contexts)}</td>
                <td>{loanText(item, contexts)}</td>
                <td>{accountText(item, contexts)}</td>
                <td>{money(item.intent.amount)}</td>
                <td>{item.observedDate}</td>
                <td>{label(PAYMENT_STATUS, item.status)}</td>
                <td>{label(APPROVAL_STATUS, item.approvalState)}</td>
                <td>{label(CUSTODY_STATUS, item.custodyState)}</td>
                <td>{label(RECONCILIATION_STATUS, item.reconciliationState)}</td>
                <td><button type="button" onClick={() => void openPayment(item.id).catch(setError)}>{rowName(item, contexts)}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {visible.length === 0 ? <Empty>No hay pagos en esta página para ese filtro.</Empty> : null}

      {payment ? (
        <section aria-label="Detalle del pago">
          <h2>Detalle</h2>
          {blocked ? <Alert tone="error">Estado no reconocido. No hay acciones.</Alert> : null}
          <p>{borrowerText(payment, contexts)}. {loanText(payment, contexts)}. {accountText(payment, contexts)}.</p>
          <p>Referencia {payment.intent.receiptReference}. Soporte {payment.intent.supportReference}. Importe {money(payment.intent.amount)}. Fecha observada {payment.observedDate}.</p>
          <p>Pago: {label(PAYMENT_STATUS, payment.status)}. Aprobación: {label(APPROVAL_STATUS, payment.approvalState)}. Custodia: {label(CUSTODY_STATUS, payment.custodyState)}. Conciliación: {label(RECONCILIATION_STATUS, payment.reconciliationState)}.</p>
          <p>{custodyExplanation(payment)}</p>
          <Field label="Soporte de la acción"><input value={support} maxLength={160} onChange={event=>edit(()=>setSupport(event.target.value))} /></Field>
          <Field label="Motivo de la acción"><input value={reason} maxLength={500} onChange={event=>edit(()=>setReason(event.target.value))} /></Field>
          {payment.approvalOrigin === 'LEGACY_NOT_RECORDED' ? <p>Este hecho es anterior. No tiene una aprobación de este libro.</p> : null}
          {custody ? <p>Custodia registrada: {money(custody.amountHeld)} en estado {label(CUSTODY_STATUS, custody.state)}. No es la caja propia de la organización.</p> : null}
          <div className="schedule">
            <table>
              <caption>Cuotas del servidor</caption>
              <thead><tr><th scope="col">Número</th><th scope="col">Vencimiento</th><th scope="col">Capital</th><th scope="col">Interés</th><th scope="col">Importe</th><th scope="col">Estado</th></tr></thead>
              <tbody>
                {installments.map(row => (
                  <tr key={`${row.loanId}-${row.number}`}>
                    <td>{row.number}</td><td>{row.dueDate}</td><td>{money(row.principal)}</td><td>{money(row.interest)}</td><td>{money(row.payment)}</td><td>{INSTALLMENT[row.status] ?? 'Estado no reconocido'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!blocked && payment.status === 'PENDING' && payment.approvalMode === 'SUPERVISED' ? (
            <div>
              <p>La decisión no se marca sola. Hace falta otro titular o un aprobador distinto de quien registró.</p>
              {canApprove(roles, payment.registrarId, actorId) ? (
                <form onSubmit={onSubmit(() => ask('APPROVE'), setPending, setError)}>
                  <Submit pending={pending}>Pedir el plan de aprobación</Submit>
                </form>
              ) : <p>No puedes aprobar este registro.</p>}
              {canApprove(roles, payment.registrarId, actorId) ? (
                <form onSubmit={onSubmit(() => send('rejectPayment', { resourceETag: paymentEtag, reason: reason.trim(), supportReference: support.trim() }, payment.id), setPending, setError)}>
                  <Field label="Motivo del rechazo"><input value={reason} maxLength={500} onChange={event => edit(() => setReason(event.target.value))} /></Field>
                  <Submit pending={pending}>Rechazar el pendiente</Submit>
                </form>
              ) : null}
              {canCancel(roles, payment.registrarId, actorId) ? (
                <form onSubmit={onSubmit(() => send('cancelPayment', { resourceETag: paymentEtag, reason: reason.trim(), supportReference: support.trim() }, payment.id), setPending, setError)}>
                  <Submit pending={pending}>Cancelar el pendiente</Submit>
                </form>
              ) : null}
            </div>
          ) : null}
          {!blocked && custody && payment.custodyState === 'RETURN_REQUIRED' && canCancel(roles, payment.registrarId, actorId) ? (
            <form onSubmit={onSubmit(() => send('returnProvisionalCash', { resourceETag: paymentEtag, custodyETag: custodyEtag, amount: payment.intent.amount, returnedAt: new Date().toISOString(), recipientReference: recipient.trim(), reason: reason.trim(), supportReference: support.trim() }, custody.id), setPending, setError)}>
              <Field label="Referencia de quien recibe el efectivo"><input required value={recipient} maxLength={160} onChange={event=>edit(()=>setRecipient(event.target.value))} /></Field>
              <p>El retorno declara la devolución del efectivo. No crea un asiento ni reduce la deuda otra vez.</p>
              <Submit pending={pending}>Declarar el retorno del efectivo</Submit>
            </form>
          ) : null}
          {!blocked && canReconcile(roles) && payment.eventId && payment.status === 'CONFIRMED' ? (
            <form onSubmit={onSubmit(() => send('requestPaymentReversal', { resourceETag: reversalEtag ?? `"${payment.eventId}:1"`, reason: reason.trim(), supportReference: support.trim() }, payment.eventId), setPending, setError)}>
              <h2>Solicitar reverso</h2>
              <p>El hecho original permanece. Esta solicitud no lo borra ni arma un asiento a mano.</p>
              <Field label="Motivo del reverso"><input value={reason} maxLength={500} onChange={event => edit(() => setReason(event.target.value))} /></Field>
              <Submit pending={pending}>Solicitar la compensación</Submit>
            </form>
          ) : null}
          {!blocked && reversal ? (
            <section aria-label="Reverso">
              <h2>Reverso</h2>
              <p>Original {{RECEIPT:'Recibo',APPLY_CREDIT:'Aplicación de saldo a favor'}[reversal.originalKind]??'Operación'} del {reversal.requestedAt}. Motivo: {reversal.reason}. Estado de la solicitud: {{REQUESTED:'Solicitada',EXECUTED:'Ejecutada',REJECTED:'Rechazada'}[reversal.state]??'Estado no reconocido'}.</p>
              <p>La compensación, si el servidor la admite, enlaza este original. No hay botón para borrarlo.</p>
              {canReconcile(roles) && payment.status === 'REVERSAL_REQUESTED' && reversal.state === 'REQUESTED' ? (
                <>
                  <form onSubmit={onSubmit(() => ask('EXECUTE_REVERSAL'), setPending, setError)}><Submit pending={pending}>Pedir el plan de compensación</Submit></form>
                  <form onSubmit={onSubmit(() => send('rejectPaymentReversal', { resourceETag: reversalEtag, reason: reason.trim(), supportReference: support.trim() }, reversal.originalEventId), setPending, setError)}>
                    <Submit pending={pending}>Rechazar la solicitud de reverso</Submit>
                  </form>
                </>
              ) : null}
            </section>
          ) : null}
          {!blocked && canReconcile(roles) && payment.intent.method === 'BANK' && (payment.status === 'CONFIRMED' || payment.status === 'REVERSAL_REQUESTED') ? (
            <section aria-label="Conciliación">
              <h2>Conciliación manual</h2>
              <p>Una declaración no es un extracto del banco. Vincular no contabiliza otro ingreso. El importe, la fecha y la referencia se muestran como llegaron.</p>
              <form onSubmit={onSubmit(async () => {
                const canonical = parseLocalCop(bankAmount);
                if (!canonical || !bankEtag || !bankAccount) throw new ApiError(422, 'INPUT_INVALID', null, 'Faltan la cuenta, su versión o el importe declarado. No se creó la declaración.');
                await send('createBankDeclaration', { accountId: bankAccount, accountETag: bankEtag, currency: 'COP', direction: 'INCOMING', amount: canonical, valueDate: bankDate, reference: bankReference.trim(), source: 'MANUAL_DECLARATION', declaredBankName: bankName.trim(), statementReference: statementRef.trim(), lineReference: lineRef.trim(), supportReference: support.trim() }, null);
              }, setPending, setError)}>
                <AccountPicker base={`${base}/financial`} label="Cuenta bancaria de la organización" accountClass="ASSET" kinds={['BANK']} status="ACTIVE" value={bankAccount} onChange={id => { setBankAccount(id); void rememberAccount(id, setBankEtag).catch(setError); }} />
                <Field label="Importe declarado"><input value={bankAmount} inputMode="decimal" onChange={event => edit(() => setBankAmount(event.target.value))} /></Field>
                <Field label="Fecha del movimiento"><input type="date" value={bankDate} onChange={event => edit(() => setBankDate(event.target.value))} /></Field>
                <Field label="Referencia declarada"><input value={bankReference} maxLength={80} onChange={event => edit(() => setBankReference(event.target.value))} /></Field>
                <Field label="Nombre declarado del banco"><input value={bankName} maxLength={100} onChange={event => edit(() => setBankName(event.target.value))} /></Field>
                <Field label="Referencia del extracto"><input value={statementRef} maxLength={80} onChange={event => edit(() => setStatementRef(event.target.value))} /></Field>
                <Field label="Línea declarada"><input value={lineRef} maxLength={80} onChange={event => edit(() => setLineRef(event.target.value))} /></Field>
                <Submit pending={pending}>Declarar el movimiento</Submit>
              </form>
              <Field label="Declaración para vincular">
                <select value={chosenBank} onChange={event => setChosenBank(event.target.value)}>
                  <option value="">Elige una declaración</option>
                  {banks.filter(item => item.state === 'AVAILABLE').map(item => (
                    <option key={item.id} value={item.id}>{money(item.amount)} · {item.valueDate} · {item.reference} · {item.statementReference} · {item.lineReference}</option>
                  ))}
                </select>
              </Field>
              {payment.currentReconciliationLinkId ? <p>Hay un vínculo vigente. No se ofrece otro hasta desvincular.</p> : null}
              {!payment.currentReconciliationLinkId && payment.reconciliationState === 'PENDING' ? (
                <form onSubmit={onSubmit(async () => {
                  const declaration = banks.find(item => item.id === chosenBank);
                  if (!declaration || !paymentEtag) throw new ApiError(422, 'INPUT_INVALID', null, 'Falta la declaración o la versión del pago. No se vinculó.');
                  const read = await call<BankRow>('GET', `${base}/bank-declarations/${declaration.id}`);
                  await send('linkReconciliation', { paymentId: payment.id, paymentETag: paymentEtag, bankDeclarationId: declaration.id, bankDeclarationETag: read.etag, supportReference: support.trim() }, null);
                }, setPending, setError)}>
                  <Submit pending={pending}>Vincular uno a uno</Submit>
                </form>
              ) : null}
              {payment.currentReconciliationLinkId ? (
                <form onSubmit={onSubmit(async () => {
                  const declaration = banks.find(item => item.activeLinkId === payment.currentReconciliationLinkId) ?? banks.find(item => item.id === chosenBank);
                  if (!declaration || !paymentEtag) throw new ApiError(422, 'INPUT_INVALID', null, 'Falta el vínculo visible. No se desvinculó.');
                  const read = await call<BankRow>('GET', `${base}/bank-declarations/${declaration.id}`);
                  await send('unlinkReconciliation', { paymentId: payment.id, paymentETag: paymentEtag, bankDeclarationId: declaration.id, bankDeclarationETag: read.etag, linkId: payment.currentReconciliationLinkId, reason: reason.trim(), supportReference: support.trim() }, null);
                }, setPending, setError)}>
                  <Submit pending={pending}>Desvincular</Submit>
                </form>
              ) : null}
              <form onSubmit={onSubmit(() => send('disposeReconciliation', { paymentId: payment.id, resourceETag: paymentEtag, state: 'DISCREPANCY', reason: reason.trim(), supportReference: support.trim() }, null), setPending, setError)}>
                <Submit pending={pending}>Marcar diferencia</Submit>
              </form>
              <form onSubmit={onSubmit(() => send('disposeReconciliation', { paymentId: payment.id, resourceETag: paymentEtag, state: 'INVESTIGATION', reason: reason.trim(), supportReference: support.trim() }, null), setPending, setError)}>
                <Submit pending={pending}>Pasar a revisión</Submit>
              </form>
            </section>
          ) : null}
        </section>
      ) : null}

      {canRegister(roles) ? (
        <form onSubmit={onSubmit(() => ask('REGISTER'), setPending, setError)}>
          <h2>Registrar cobro</h2>
          <p>El destino sale del contexto autorizado. No se elige la caja propia como si fuera la custodia del cobrador.</p>
          {canDirect(roles) ? (
            <Field label="Modo de registro">
              <select value={mode} onChange={event => edit(() => setMode(event.target.value as 'DIRECT' | 'SUPERVISED'))}>
                <option value="SUPERVISED">Supervisado, otro titular o aprobador decide</option>
                <option value="DIRECT">Directo del titular</option>
              </select>
            </Field>
          ) : <p>Tu registro queda supervisado. No se envía como directo ni se aprueba solo.</p>}
          <fieldset>
            <legend>Préstamos que puedes registrar</legend>
            {contexts.map(row => (
              <label className="checks" key={contextKey(row)}>
                <input type="checkbox" checked={selected.includes(contextKey(row))} onChange={event => edit(() => setSelected(current => event.target.checked ? [...current, contextKey(row)] : current.filter(item => item !== contextKey(row))))} />
                {row.borrowerCode} · {row.borrowerName} · préstamo {row.loanReference} · saldo {money(row.principalOutstanding)} · {row.permittedDestinationLabel} · {row.permittedMethod === 'CASH' ? 'efectivo' : 'transferencia'}
              </label>
            ))}
          </fieldset>
          {registerMethod === 'CASH' ? <p>Efectivo: la deuda no baja al registrarlo. El dinero queda en custodia provisional del registrador.</p> : null}
          {registerMethod === 'BANK' ? <p>Transferencia: no pasa por custodia de cobrador. Registrarla no la concilia.</p> : null}
          {registerRows.map(row => (
            <div key={row.loanId}>
              <Field label={`Importe para ${row.borrowerCode} · ${row.loanReference}`}><input value={targetAmounts[row.loanId] ?? ''} inputMode="decimal" onChange={event => edit(() => setTargetAmounts(current => ({ ...current, [row.loanId]: event.target.value })))} /></Field>
              <Field label={`Modo para ${row.loanReference}`}>
                <select value={targetModes[row.loanId] ?? 'REGULAR'} onChange={event => edit(() => setTargetModes(current => ({ ...current, [row.loanId]: event.target.value as 'REGULAR' | 'EXTRA_PRINCIPAL' })))}>
                  <option value="REGULAR">Cobro ordinario</option>
                  <option value="EXTRA_PRINCIPAL">Abono extraordinario a capital</option>
                </select>
              </Field>
            </div>
          ))}
          <Field label="Importe del recibo"><input value={amount} inputMode="decimal" onChange={event => edit(() => setAmount(event.target.value))} /></Field>
          <Field label="Fecha observada"><input type="date" value={observedDate} max={todayBogota()} onChange={event => edit(() => setObservedDate(event.target.value))} /></Field>
          <Field label="Referencia"><input value={reference} maxLength={80} onChange={event => edit(() => setReference(event.target.value))} /></Field>
          <Field label="Soporte"><input value={support} maxLength={160} onChange={event => edit(() => setSupport(event.target.value))} /></Field>
          <Field label="Si sobra dinero">
            <select value={excess} onChange={event => edit(() => setExcess(event.target.value as 'CREDIT' | 'REJECT'))}>
              <option value="REJECT">Rechazar el excedente</option>
              <option value="CREDIT">Dejarlo como saldo a favor</option>
            </select>
          </Field>
          <Submit pending={pending}>Pedir el plan</Submit>
        </form>
      ) : <p>No tienes permiso para registrar un pago.</p>}

      {preview && previewKind ? (
        <section aria-label="Plan del servidor">
          <h2>Plan del servidor</h2>
          <Alert tone="info">Plan sin efecto. Vence {new Date(preview.expiresAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}. No es un cobro, una aprobación ni un reverso.</Alert>
          <p>Fecha contable {preview.plan.effectiveDate}. Custodia según el servidor: {CUSTODY_DELTA[preview.plan.custodyDelta] ?? 'Efecto no reconocido'}.</p>
          <p>Crédito agregado {money(preview.plan.creditAdded)}. Crédito aplicado {money(preview.plan.creditApplied)}. Fondos retenidos agregados {money(preview.plan.heldFundsAdded)}.</p>
          <ul>
            {preview.plan.allocations.map((line, index) => <li key={`${line.loanId}-${line.installmentNumber}-${index}`}>Número de cuota {line.installmentNumber}. {PART[line.component] ?? 'Componente no reconocido'}. Importe {money(line.amount)}.</li>)}
          </ul>
          <ul>
            {preview.plan.postings.map(line => <li key={`${line.accountId}-${line.debit}-${line.credit}`}>Cuenta del plan. Débito {money(line.debit)}. Crédito {money(line.credit)}.</li>)}
          </ul>
          <form onSubmit={onSubmit(() => {
            if (!consent || !previewKind || !previewCommand) throw new ApiError(422, 'INPUT_INVALID', null, 'Falta confirmar el plan. No se envió.');
            const wrapped = { command: previewCommand, previewToken: preview.token };
            if (previewKind === 'REGISTER') return send('registerPayment', wrapped, null);
            if (previewKind === 'APPROVE') return send('approvePayment', wrapped, String(previewCommand.paymentId));
            if (previewKind === 'EXECUTE_REVERSAL') return send('executePaymentReversal', wrapped, String(previewCommand.originalEventId));
            throw new ApiError(422, 'INPUT_INVALID', null, 'El plan ya no corresponde a una acción conocida. No se envió.');
          }, setPending, setError)}>
            <label className="checks"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /> Confirmo este plan del servidor. No elige un aprobador ni marca la decisión por mí.</label>
            <Submit pending={pending} disabled={!consent}>{previewKind === 'REGISTER' ? 'Confirmar el registro' : previewKind === 'APPROVE' ? 'Confirmar la aprobación' : 'Confirmar la compensación'}</Submit>
          </form>
        </section>
      ) : null}
      {uncertain ? (
        <div>
          <Alert tone="pending">La respuesta no confirmó el resultado. La misma clave se conserva. No se prepara otra.</Alert>
          <button type="button" disabled={pending} onClick={() => { if (pending) return; setPending(true); void consult().catch(setError).finally(() => setPending(false)); }}>Consultar el comando</button>
          <button type="button" disabled={pending} onClick={() => { if (pending) return; setPending(true); void send('registerPayment', {}, null).catch(setError).finally(() => setPending(false)); }}>Reintentar el mismo comando</button>
        </div>
      ) : null}

      {canConfigure(roles) ? (
        <details>
          <summary>Configuración del titular</summary>
          <p>El perfil de fondos retenidos y la custodia son de la organización. No convierten un permiso en un rol ni aprueban un pago.</p>
          <form onSubmit={onSubmit(async() => send('setHeldFundsProfile', { configurationKind: 'HELD_FUNDS_PROFILE', heldLiabilityAccountId: heldAccount, heldLiabilityAccountETag: heldEtag, resourceETag: await resourceETag('held-funds-profile',`"${organizationId}:held-profile:0"`), supportReference: support.trim() }, null), setPending, setError)}>
            <AccountPicker base={`${base}/financial`} label="Pasivo de fondos retenidos" accountClass="LIABILITY" kinds={['GENERAL']} status="ACTIVE" value={heldAccount} onChange={id => { setHeldAccount(id); void rememberAccount(id, setHeldEtag).catch(setError); }} />
            <Submit pending={pending} disabled={!heldAccount||!heldEtag}>Guardar el perfil de fondos retenidos</Submit>
          </form>
          <form onSubmit={onSubmit(async () => {
            if (!custodianId || !cashEtag || !heldEtag) throw new ApiError(422, 'INPUT_INVALID', null, 'Faltan el custodio o las versiones de las cuentas. No se guardó el vínculo.');
            await send('setCustodyBinding', { custodianId, accountId: cashAccount, accountETag: cashEtag, heldLiabilityAccountId: heldAccount, heldLiabilityAccountETag: heldEtag, resourceETag: await resourceETag(`custody-bindings/${custodianId}`,`"${custodianId}:binding:0"`), supportReference: support.trim() }, null);
          }, setPending, setError)}>
            <Field label="Identificador del custodio"><input value={custodianId} onChange={event => edit(() => setCustodianId(event.target.value.trim()))} /></Field>
            <AccountPicker base={`${base}/financial`} label="Cuenta de efectivo del custodio" accountClass="ASSET" kinds={['CASH']} status="ACTIVE" value={cashAccount} onChange={id => { setCashAccount(id); void rememberAccount(id, setCashEtag).catch(setError); }} />
            <Submit pending={pending} disabled={!custodianId||!cashAccount||!cashEtag||!heldEtag}>Guardar el vínculo de custodia</Submit>
          </form>
          <form onSubmit={onSubmit(configureScope,setPending,setError)}>
            <label className="checks"><input type="checkbox" checked={scopeActive} onChange={event=>edit(()=>setScopeActive(event.target.checked))} /> Permitir registro del cobrador en el préstamo elegido</label>
            <Submit pending={pending} disabled={!custodianId||!registerRows[0]}>Guardar el alcance de registro</Submit>
          </form>
        </details>
      ) : null}
    </section>
  );
}

function StatusSelect({ value, options, onChange }: { value: string; options: Record<string, string>; onChange: (value: string) => void }) {
  return (
    <select value={value} onChange={event => onChange(event.target.value)}>
      <option value="">Todos</option>
      {Object.entries(options).map(([key, text]) => <option key={key} value={key}>{text}</option>)}
    </select>
  );
}

function purposeOf(operation: string): string {
  const purposes: Record<string, string> = {
    approvePayment: 'PAYMENT_APPROVE_CONFIRM',
    rejectPayment: 'PAYMENT_REJECT',
    cancelPayment: 'PAYMENT_CANCEL',
    returnProvisionalCash: 'CUSTODY_PROVISIONAL_RETURN',
    requestPaymentReversal: 'PAYMENT_REVERSAL_REQUEST',
    rejectPaymentReversal: 'PAYMENT_REVERSAL_REJECT',
    executePaymentReversal: 'PAYMENT_REVERSAL_EXECUTE',
    createBankDeclaration: 'BANK_DECLARATION_CREATE',
    voidBankDeclaration: 'BANK_DECLARATION_VOID',
    linkReconciliation: 'RECONCILIATION_LINK',
    unlinkReconciliation: 'RECONCILIATION_UNLINK',
    disposeReconciliation: 'RECONCILIATION_DISPOSITION',
    setHeldFundsProfile: 'CUSTODY_BINDING_SET',
    setCustodyBinding: 'CUSTODY_BINDING_SET',
    setPaymentRegistrationScope: 'PAYMENT_REGISTRATION_SCOPE_SET',
  };
  return purposes[operation] ?? '';
}

function actionPath(base: string, operation: string, resourceId: string | null): string {
  if (operation === 'registerPayment') return `${base}/payments`;
  if (operation === 'approvePayment') return `${base}/payments/${resourceId}/approve`;
  if (operation === 'rejectPayment') return `${base}/payments/${resourceId}/reject`;
  if (operation === 'cancelPayment') return `${base}/payments/${resourceId}/cancel`;
  if (operation === 'returnProvisionalCash') return `${base}/cash-custody/${resourceId}/return`;
  if (operation === 'requestPaymentReversal') return `${base}/loan-events/${resourceId}/reversal-requests`;
  if (operation === 'rejectPaymentReversal') return `${base}/loan-events/${resourceId}/reversal-rejection`;
  if (operation === 'executePaymentReversal') return `${base}/loan-events/${resourceId}/reversals`;
  if (operation === 'createBankDeclaration') return `${base}/bank-declarations`;
  if (operation === 'voidBankDeclaration') return `${base}/bank-declarations/${resourceId}/void`;
  if (operation === 'linkReconciliation') return `${base}/reconciliation-links`;
  if (operation === 'unlinkReconciliation') return `${base}/reconciliation-unlinks`;
  if (operation === 'disposeReconciliation') return `${base}/reconciliation-dispositions`;
  if (operation === 'setHeldFundsProfile') return `${base}/held-funds-profile`;
  if (operation === 'setCustodyBinding') return `${base}/custody-bindings`;
  if (operation === 'setPaymentRegistrationScope') return `${base}/payment-registration-scopes`;
  return `${base}/payments`;
}
