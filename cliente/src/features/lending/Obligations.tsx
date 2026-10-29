import {ObligationActions} from './ObligationActions';
import { useEffect, useRef, useState } from 'react';
import { call } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { ApiError, DiscardedRequest, messageFor, purposeClass } from '../../shared/contracts';
import { cents, formatCop, parseLocalCop, todayBogota } from '../../shared/money';
import { ensureStepUp } from '../../shared/step-up';
import { Alert, Empty, ErrorText, Field, onSubmit } from '../../shared/ui';

const PREFIX = 'caudelyx.s09.obligations.';
type ScopeKind = 'BUSINESS' | 'PERSONAL';
type Row = Record<string, unknown>;
interface Meta { scope?: string; coverage?: string; reasons?: string[]; snapshotToken?: string; asOf?: string; currency?: string }

const CATEGORIES = ['SERVICES', 'RENT', 'SUPPLIES', 'INTEREST', 'INSURANCE', 'FEES', 'OTHER'] as const;
const CATEGORY_LABEL: Record<string, string> = {
  SERVICES: 'Servicios', RENT: 'Arriendo', SUPPLIES: 'Insumos', INTEREST: 'Interés', INSURANCE: 'Seguro', FEES: 'Cargos', OTHER: 'Otra',
};
const AGENDA: Record<string, string> = {
  PLANNED: 'Presupuestado, sin pago confirmado',
  UNPRICED: 'Sin precio declarado',
  OFFICIAL_DECLARED: 'Cuota oficial declarada',
  PROJECTED: 'Proyección, no es la cuota oficial',
};
const CROSS_LABELS:Record<string,string>={CONTRIBUTION:'por aporte',WITHDRAWAL:'por retiro',INTERBOOK_LOAN:'por préstamo entre ámbitos',REIMBURSEMENT:'por reembolso'};
const REASONS: Record<string, string> = {
  ELIGIBILITY_NOT_VISIBLE_AT_CUT:'La declaración de titularidad no es visible en este corte.',
  CURRENT_BUSINESS_NOT_AUTHORIZED: 'El negocio actual no está autorizado en este corte.',
  RELATIONSHIP_COUNTERPART_NOT_VISIBLE: 'Una relación no tiene las dos partes visibles. No se eliminó ni se completó.',
  PARTICIPATION_SEPARATE_NOT_FULLY_CONSOLIDATED: 'La participación queda aparte. No entra al neto consolidado.',
};

function cash(value: unknown): string {
  if (typeof value !== 'string') return 'Sin cifra del servidor';
  const shown = formatCop(value);
  return shown ? `${shown} COP` : value;
}

function moneyField(label: string, value: string, allowZero = false): string | null {
  const canonical = parseLocalCop(value);
  const amount = canonical ? cents(canonical) : null;
  if (!canonical || amount === null || (!allowZero && amount <= 0n) || amount < 0n) return allowZero ? `${label} debe ser un importe en pesos.` : `${label} debe ser un importe en pesos, mayor que cero.`;
  return null;
}

function canonicalMoney(value: string): string {
  const canonical = parseLocalCop(value);
  if (!canonical) throw new ApiError(422, 'INPUT_INVALID', null, messageFor('INPUT_INVALID', 422));
  return canonical;
}

export function ObligationsScreen() {
  const { me, phase } = useAuth();
  useEffect(() => {
    if (phase !== 'anonymous') return;
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(PREFIX)) sessionStorage.removeItem(key);
  }, [phase]);
  if (phase !== 'ready' || !me?.userId) return <section className="panel desk"><h1>Gastos y obligaciones</h1><Empty>Entra con tu sesión para ver el ámbito propio. No se muestran cifras de otro actor.</Empty></section>;
  const owner = `${me.userId}|${me.organizationId ?? ''}|${[...(me.roleIds ?? [])].sort().join(',')}`;
  return <Workspace key={owner} owner={owner} />;
}

function Workspace({ owner }: { owner: string }) {
  const { me } = useAuth();
  const isT = (me?.roleIds ?? []).includes('T') && !(me?.roleIds??[]).includes('SA') && Boolean(me?.organizationId);
  const today = todayBogota();
  const [scope, setScope] = useState<ScopeKind>(isT ? 'BUSINESS' : 'PERSONAL');
  const [bookId, setBookId] = useState<string | null>(null);
  const [personalEtag, setPersonalEtag] = useState<string | null>(null);
  const [businessEtag, setBusinessEtag] = useState<string | null>(null);
  const [personalState, setPersonalState] = useState<'unknown' | 'open' | 'absent'>('unknown');
  const [panel, setPanel] = useState<'expenses' | 'agenda' | 'liabilities' | 'consolidation'>('expenses');
  const [items, setItems] = useState<Row[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const ticket = useRef(0),bookSequence=useRef(0),live=useRef(true),scopeRef=useRef(scope);scopeRef.current=scope;
  useEffect(()=>{live.current=true;return()=>{live.current=false;ticket.current++;};},[]);
  const stillCurrent=()=>live.current&&scopeRef.current===scope;
  const idempotency = useRef<string | null>(null);
  const holdKey = useRef(false);
  const requestSignature=useRef<string|null>(null);
  const [nextCursor,setNextCursor]=useState<string|null>(null);
  const [cut,setCut]=useState(today);
  const [known,setKnown]=useState('');

  useEffect(() => {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(PREFIX) && !key.startsWith(`${PREFIX}${owner}|`)) sessionStorage.removeItem(key);
    }
  }, [owner]);

  const base = scope === 'BUSINESS'
    ? `/organizations/${me?.organizationId}/finance-s09`
    : bookId ? `/me/personal/books/${bookId}/finance-s09` : null;

  useEffect(() => {
    const mine = ++bookSequence.current;
    setItems([]);
    setMeta(null);
    setError(null);
    void (async () => {
      try {
        const personal = await call<Row>('GET', '/me/personal/book');
        if (mine !== bookSequence.current) return;
        const id = String((personal.data as Row).id ?? '');
        setBookId(id || null);
        setPersonalEtag(personal.etag);
        setPersonalState(id ? 'open' : 'absent');
      } catch (caught) {
        if (mine !== bookSequence.current) return;
        setBookId(null);
        setPersonalEtag(null);
        setPersonalState(caught instanceof ApiError && caught.status === 404 ? 'absent' : 'unknown');
        if (!(caught instanceof ApiError) || caught.status !== 404) setError(caught);
      }
      if (!isT || !me?.organizationId) return;
      try {
        const business = await call<Row>('GET', `/organizations/${me.organizationId}/finance-s09/book`);
        if (mine !== bookSequence.current) return;
        setBusinessEtag(business.etag);
      } catch (caught) {
        if (mine !== bookSequence.current) return;
        if (caught instanceof ApiError && caught.status === 404) setBusinessEtag(null);
        else setError(caught);
      }
    })();
    return()=>{bookSequence.current++;};
  }, [isT, me?.organizationId, owner]);

  function changeScope(next: ScopeKind) {
    if (next === 'BUSINESS' && !isT) return;
    if (next === scope) return;
    ticket.current += 1;
    setScope(next);setPanel('expenses');
    setItems([]);
    setMeta(null);
    setNotice(null);
    setError(null);
    setNextCursor(null);
  }

  async function openBook() {
    const result = await send('createPersonalBook', 'PERSONAL_BOOK_CREATE', '/me/personal/books', { currency: 'COP' });
    const id = String((result.data as Row).id ?? '');
    setBookId(id || null);
    setPersonalEtag(result.etag);
    setPersonalState(id ? 'open' : 'absent');
    setNotice('Libro personal abierto. No copia cuentas ni saldos del negocio.');
  }

  async function send(operation: string, purpose: string, path: string, payload: Row, resourceId?: string, expected?: string) {
    if(!stillCurrent())throw new DiscardedRequest();
    const signature=JSON.stringify({operation,path,payload,expected});
    if(holdKey.current&&requestSignature.current!==signature)throw new ApiError(409,'IDEMPOTENCY_CONFLICT',null,'Hay una operación sin resultado confirmado. Reintenta primero sus mismos datos.');
    requestSignature.current=signature;
    const pathParameters:Record<string,string>={};for(const [segment,name] of [['organizations','organizationId'],['books','bookId'],['expenses','expenseId'],['expense-rules','ruleId'],['liabilities','liabilityId'],['payments','paymentId'],['events','eventId'],['recognitions','eventId'],['interbook-relationships','relationshipId']]){const match=path.match(new RegExp('/'+segment+'/([0-9a-f-]{36})(?:/|$)'));if(match)pathParameters[name!]=match[1]!;}
    const key = holdKey.current && idempotency.current ? idempotency.current : crypto.randomUUID();
    idempotency.current = key;
    const command: Row = {
      operationId: operation,
      idempotencyKey: key,
      payload,pathParameters,
      ...(path.startsWith('/organizations/') && me?.organizationId ? { organizationId: me.organizationId } : {}),
      ...(bookId && path.startsWith('/me/') ? { bookId } : {}),
      ...(expected ? { expectedETag: expected } : {}),
    };
    try {
      if (purposeClass(purpose) === 'BALANCE_60M') {
        await ensureStepUp({ purpose, command, resourceId, summary: 'Confirmas un movimiento de saldo. El servidor decide el resultado.' });
      }
      if(!stillCurrent())throw new DiscardedRequest();
      const result = await call<Row>('POST', path, payload, { idempotencyKey: key, ifMatch: expected });
      if (result.status !== 200 && result.status !== 201) {
        holdKey.current = true;
        throw new ApiError(result.status, 'SERVICE_UNAVAILABLE', result.requestId, messageFor('SERVICE_UNAVAILABLE', result.status));
      }
      idempotency.current = null;
      holdKey.current = false;
      if(!stillCurrent())throw new DiscardedRequest();
      return result;
    } catch (caught) {
      if (caught instanceof ApiError && (caught.status === 0 || caught.status === 503)) holdKey.current = true;
      else if (!(caught instanceof ApiError) || caught.code !== 'STEP_UP') {
        idempotency.current = null;
        holdKey.current = false;
      }
      throw caught;
    }
  }

  async function load(kind: 'expenses' | 'agenda' | 'liabilities' | 'consolidation',cursor?:string) {
    if(!stillCurrent())return;
    setPanel(kind);setItems([]);setMeta(null);setNextCursor(null);
    setNotice(null);
    if (kind !== 'consolidation' && !base) throw new ApiError(404, 'RESOURCE_NOT_FOUND', null, 'No hay un libro personal abierto.');
    const suffix=cursor&&meta?.snapshotToken?'snapshotToken='+encodeURIComponent(meta.snapshotToken)+'&cursor='+encodeURIComponent(cursor):'asOf='+cut+(known?'&recordedThrough='+encodeURIComponent(known):'');
    const path = kind === 'consolidation'
      ? `/me/private-consolidation?${suffix}`
      : `${base}/${kind === 'expenses' ? 'expenses' : kind === 'agenda' ? 'agenda' : 'liabilities'}?${suffix}&limit=20`;
    const mine = ++ticket.current;
    try {
      const result = await call<{ items?: Row[]; nextCursor?: string | null } & Row>('GET', path);
      if (mine !== ticket.current||!stillCurrent()) return;
      const body = result.data;
      const pageMeta = (result.meta ?? null) as Meta | null;
      if (pageMeta?.coverage === 'INCOMPLETE' || (pageMeta?.reasons?.length ?? 0) > 0) setNotice('El servidor marcó datos incompletos. No se completan ni se deduplican.');
      if (kind === 'consolidation') {
        setItems([body]);
        setMeta(pageMeta ?? { scope: 'PRIVATE_CONSOLIDATED' });
      } else {
        setItems(body.items ?? []);
        setNextCursor(body.nextCursor??null);
        setMeta(pageMeta);
      }
      setError(null);
    } catch (caught) {
      if (mine !== ticket.current||!stillCurrent()) return;
      setItems([]);
      setMeta(null);
      if (caught instanceof ApiError && caught.status === 503) holdKey.current = true;
      throw caught;
    }
  }

  return (
    <section className="panel desk">
      <h1>Gastos y obligaciones</h1>
      <p>Las cifras salen del servidor. Una proyección no es una cuota oficial y un borrador no es un pago.</p>
      <div className="report-head" role="group" aria-label="Ámbito">
        {isT ? <button type="button" aria-pressed={scope === 'BUSINESS'} onClick={() => changeScope('BUSINESS')}>Negocio</button> : <Alert tone="info">Este ámbito de negocio no está en tu rol. No se consultan sus cuentas ni sus saldos.</Alert>}
        <button type="button" aria-pressed={scope === 'PERSONAL'} onClick={() => changeScope('PERSONAL')}>Personal</button>
        <p>{scope === 'PERSONAL' ? 'Personal, solo de esta sesión.' : 'Negocio de la organización actual.'} {personalState === 'absent' && scope === 'PERSONAL' ? 'No hay libro personal abierto.' : ''}</p>
      </div>
      {scope === 'PERSONAL' && personalState === 'absent' && isT ? <button type="button" disabled={pending} onClick={() => { setError(null); setPending(true); void openBook().catch(setError).finally(() => setPending(false)); }}>Abrir libro personal</button> : null}
      {scope === 'PERSONAL' && personalState === 'absent' && !isT ? <Alert tone="info">El libro personal no está habilitado en esta sesión.</Alert> : null}
      <div className="report-head">
        <button type="button" onClick={() => { setError(null); setPending(true); void load('expenses').catch(setError).finally(() => setPending(false)); }}>Ver gastos</button>
        <button type="button" onClick={() => { setError(null); setPending(true); void load('agenda').catch(setError).finally(() => setPending(false)); }}>Ver agenda</button>
        <button type="button" onClick={() => { setError(null); setPending(true); void load('liabilities').catch(setError).finally(() => setPending(false)); }}>Ver obligaciones</button>
        {scope === 'PERSONAL' ? <button type="button" onClick={() => { setError(null); setPending(true); void load('consolidation').catch(setError).finally(() => setPending(false)); }}>Ver consolidado privado</button> : null}
      </div>
      <Field label="Corte económico"><input type="date" value={cut} onChange={e=>{setCut(e.target.value);setNextCursor(null);}}/></Field>
      <Field label="Conocido hasta (opcional)"><input value={known} placeholder="AAAA-MM-DDTHH:mm:ss.sssZ" onChange={e=>{setKnown(e.target.value);setNextCursor(null);}}/></Field>
      <ErrorText error={error} />
      {error instanceof ApiError && (error.status === 503 || error.status === 0) ? <Alert tone="error">No se confirmó la operación. Puedes reintentar con la misma clave; no se crea otro pago al reconectar.</Alert> : null}
      {notice ? <Alert tone="info">{notice}</Alert> : null}
      {meta ? <p>{meta.scope === 'PRIVATE_CONSOLIDATED' ? 'Consolidado privado.' : meta.scope === 'PERSONAL' ? 'Ámbito personal.' : 'Ámbito de negocio.'} {meta.coverage === 'COMPLETE' ? 'Cobertura completa.' : 'Cobertura incompleta.'} {(meta.reasons ?? []).map(reason => REASONS[reason] ?? 'El servidor señaló un motivo que esta pantalla no reconoce.').join(' ')}</p> : null}
      {panel === 'expenses' && base ? <ExpenseForms key={owner+scope} base={base} today={today} owner={owner} scope={scope} pending={pending} setPending={setPending} setError={setError} send={send} onDone={message => { setNotice(message); void load('expenses').catch(setError); }} /> : null}
      {panel === 'agenda' && base ? <AgendaForm key={owner+scope} base={base} today={today} pending={pending} setPending={setPending} setError={setError} send={send} onDone={() => { setNotice('Agenda generada. Una ocurrencia presupuestada no es un pago confirmado.'); void load('agenda').catch(setError); }} /> : null}
      {panel === 'liabilities' && base ? <LiabilityForms key={owner+scope} base={base} today={today} pending={pending} setPending={setPending} setError={setError} send={send} onDone={message => { void load('liabilities').then(() => setNotice(message)).catch(setError); }} /> : null}
      {panel === 'consolidation' && scope === 'PERSONAL' ? <Consolidation rows={items} personalEtag={personalEtag} businessEtag={businessEtag} organizationId={me?.organizationId ?? ''} today={today} pending={pending} setPending={setPending} setError={setError} send={send} bookId={bookId} refresh={()=>load('consolidation')} /> : null}
      {base&&panel!=='consolidation'?<ObligationActions key={owner+scope+panel} base={base} today={today} panel={panel} items={items} pending={pending} setPending={setPending} setError={setError} send={send} refresh={()=>load(panel)}/>:null}
      <Listing panel={panel} items={items} />
      {nextCursor?<button disabled={pending} onClick={()=>{setPending(true);void load(panel,nextCursor).catch(setError).finally(()=>setPending(false));}}>Página siguiente</button>:null}
    </section>
  );
}

function ExpenseForms({ base, today, owner, scope, pending, setPending, setError, send, onDone }: {
  base: string; today: string; owner: string; scope: ScopeKind; pending: boolean;
  setPending: (value: boolean) => void; setError: (error: unknown) => void;
  send: (operation: string, purpose: string, path: string, payload: Row, resourceId?: string, expected?: string) => Promise<{ data: Row; status: number; etag: string | null }>;
  onDone: (message: string) => void;
}) {
  const draftKey = `${PREFIX}${owner}|${scope}|expense`;
  const stored = readDraft(draftKey);
  const [nominalDate, setNominalDate] = useState(stored.nominalDate || today);
  const [dueDate, setDueDate] = useState(stored.dueDate || today);
  const [description, setDescription] = useState(stored.description ?? '');
  const [category, setCategory] = useState(stored.category || 'SERVICES');
  const [amountMode, setAmountMode] = useState(stored.amountMode || 'FIXED');
  const [amount, setAmount] = useState(stored.amount ?? '');
  const [support, setSupport] = useState(stored.support ?? '');
  const [expenseId, setExpenseId] = useState('');
  const [etag, setEtag] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [payDate, setPayDate] = useState(today);
  const [cashAccountId, setCashAccountId] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => { sessionStorage.setItem(draftKey, JSON.stringify({ nominalDate, dueDate, description, category, amountMode, amount, support })); }, [draftKey, nominalDate, dueDate, description, category, amountMode, amount, support]);
  const prefix = scope === 'BUSINESS' ? 'business' : 'personal';
  return (
    <>
      <form onSubmit={onSubmit(async () => {
        if (!description.trim() || !support.trim()) throw new ApiError(422, 'INPUT_INVALID', null, 'Indica la descripción y el soporte.');
        const payload: Row = { nominalDate, dueDate, description: description.trim(), category, amountMode, supportReference: support.trim() };
        if (amountMode === 'FIXED') {
          const invalid = moneyField('Importe', amount);
          if (invalid) throw new ApiError(422, 'INPUT_INVALID', null, invalid);
          payload.amount = canonicalMoney(amount);
        }
        const result = await send(`${prefix}CreateExpense`, 'EXPENSE_CREATE', `${base}/expenses`, payload);
        setExpenseId(String((result.data as Row).id ?? ''));
        setEtag(result.etag ?? '');
        onDone('Gasto registrado. Sigue presupuestado hasta que el servidor confirme un pago.');
      }, setPending, setError)}>
        <h2>Gasto</h2>
        <Field label="Fecha nominal"><input type="date" value={nominalDate} onChange={event => setNominalDate(event.target.value)} required /></Field>
        <Field label="Vencimiento"><input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} required /></Field>
        <Field label="Descripción"><input value={description} onChange={event => setDescription(event.target.value)} maxLength={240} required /></Field>
        <Field label="Categoría"><select value={category} onChange={event => setCategory(event.target.value)}>{CATEGORIES.map(item => <option key={item} value={item}>{CATEGORY_LABEL[item]}</option>)}</select></Field>
        <Field label="Modalidad"><select value={amountMode} onChange={event => setAmountMode(event.target.value)}><option value="FIXED">Importe fijo</option><option value="VARIABLE">Variable, sin precio hasta declararlo</option></select></Field>
        {amountMode === 'FIXED' ? <Field label="Importe"><input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} required /></Field> : <p>Sin importe: el servidor lo dejará sin precio. No se muestra cero.</p>}
        <Field label="Soporte"><input value={support} onChange={event => setSupport(event.target.value)} maxLength={240} required /></Field>
        <button type="submit" disabled={pending}>Registrar gasto</button>
      </form>
      <form onSubmit={onSubmit(async () => {
        if (!expenseId || !etag) throw new ApiError(428, 'ETAG_REQUIRED', null, messageFor('ETAG_REQUIRED', 428));
        const invalid = moneyField('Pago', payAmount);
        if (invalid || !cashAccountId.trim()) throw new ApiError(422, 'INPUT_INVALID', null, invalid ?? 'Indica la cuenta de efectivo o banco.');
        const canonical = canonicalMoney(payAmount);
        if (!preview) { setPreview(`${cash(canonical)} el ${payDate}, cuenta indicada, soporte ${support.trim() || 'pendiente'}.`); return; }
        await send(`${prefix}PayExpense`, 'EXPENSE_PAY', `${base}/expenses/${expenseId}/payments`, { amount: canonical, effectiveDate: payDate, cashAccountId: cashAccountId.trim(), supportReference: support.trim() }, expenseId, etag);
        setPreview(null);
        onDone('El servidor confirmó el pago. El estado visible es el de la lista, no el del formulario.');
      }, setPending, setError)}>
        <h2>Pago del gasto</h2>
        <Field label="Gasto" hint="Identificador devuelto al registrarlo."><input value={expenseId} onChange={event => { setExpenseId(event.target.value); setPreview(null); }} /></Field>
        <Field label="Versión"><input value={etag} onChange={event => { setEtag(event.target.value); setPreview(null); }} /></Field>
        <Field label="Importe del pago"><input inputMode="decimal" value={payAmount} onChange={event => { setPayAmount(event.target.value); setPreview(null); }} /></Field>
        <Field label="Fecha del pago"><input type="date" value={payDate} onChange={event => { setPayDate(event.target.value); setPreview(null); }} /></Field>
        <Field label="Cuenta de efectivo o banco"><input value={cashAccountId} onChange={event => { setCashAccountId(event.target.value); setPreview(null); }} /></Field>
        {preview ? <p>Vista previa de lo que se enviará: {preview} No es un saldo calculado en el navegador.</p> : null}
        <button type="submit" disabled={pending}>{preview ? 'Confirmar pago' : 'Revisar pago'}</button>
      </form>
    </>
  );
}

function AgendaForm({ base, today, pending, setPending, setError, send, onDone }: {
  base: string; today: string; pending: boolean; setPending: (value: boolean) => void; setError: (error: unknown) => void;
  send: (operation: string, purpose: string, path: string, payload: Row, resourceId?: string, expected?: string) => Promise<{ data: Row }>;
  onDone: () => void;
}) {
  const [ruleId, setRuleId] = useState('');
  const [etag, setEtag] = useState('');
  const [from, setFrom] = useState(today);
  const [through, setThrough] = useState(today);
  const prefix = base.includes('/me/') ? 'personal' : 'business';
  return (
    <form onSubmit={onSubmit(async () => {
      if (!ruleId || !etag) throw new ApiError(428, 'ETAG_REQUIRED', null, messageFor('ETAG_REQUIRED', 428));
      await send(`${prefix}GenerateOccurrences`, 'EXPENSE_OCCURRENCES_GENERATE', `${base}/expense-rules/${ruleId}/occurrences`, { from, through }, ruleId, etag);
      onDone();
    }, setPending, setError)}>
      <h2>Generar agenda</h2>
      <p>Generar ocurrencias no registra un pago.</p>
      <Field label="Regla"><input value={ruleId} onChange={event => setRuleId(event.target.value)} required /></Field>
      <Field label="Versión de la regla"><input value={etag} onChange={event => setEtag(event.target.value)} required /></Field>
      <Field label="Desde"><input type="date" value={from} onChange={event => setFrom(event.target.value)} required /></Field>
      <Field label="Hasta"><input type="date" value={through} onChange={event => setThrough(event.target.value)} required /></Field>
      <button type="submit" disabled={pending}>Generar ocurrencias</button>
    </form>
  );
}

function LiabilityForms({ base, today, pending, setPending, setError, send, onDone }: {
  base: string; today: string; pending: boolean; setPending: (value: boolean) => void; setError: (error: unknown) => void;
  send: (operation: string, purpose: string, path: string, payload: Row) => Promise<{ data: Row }>;
  onDone: (message: string) => void;
}) {
  const [kind, setKind] = useState('PRIVATE_DEBT');
  const [label, setLabel] = useState('');
  const [counterparty, setCounterparty] = useState('');
  const [principal, setPrincipal] = useState('');
  const [rateKind, setRateKind] = useState('NONE_DECLARED');
  const [rateValue, setRateValue] = useState('');
  const [validFrom, setValidFrom] = useState(today);
  const [referenceDate, setReferenceDate] = useState('');
  const [observedOn, setObservedOn] = useState(today);
  const [unit, setUnit] = useState('ANNUAL_FRACTION');
  const [convention, setConvention] = useState('ANNUAL_SIMPLE_ACT_365');
  const [scheduleKind, setScheduleKind] = useState('OFFICIAL_DECLARED');
  const [dueDate, setDueDate] = useState(today);
  const [interest, setInterest] = useState('');
  const [insurance, setInsurance] = useState('');
  const [fees, setFees] = useState('');
  const [total, setTotal] = useState('');
  const [support, setSupport] = useState('');
  const [prepayment,setPrepayment]=useState<string[]>([]);
  const [firstPrincipal,setFirstPrincipal]=useState('');
  const [extraInstallments,setExtraInstallments]=useState<Record<string,string>[]>([]);
  const prefix = base.includes('/me/') ? 'personal' : 'business';
  return (
    <form onSubmit={onSubmit(async () => {
      const invalidPrincipal = moneyField('Principal', principal);
      if (invalidPrincipal) throw new ApiError(422, 'INPUT_INVALID', null, invalidPrincipal);
      for (const [name, value] of [['Interés', interest], ['Seguro', insurance], ['Cargos', fees]] as const) {
        const invalid = moneyField(name, value, true);
        if (invalid) throw new ApiError(422, 'INPUT_INVALID', null, invalid);
      }
      const invalidTotal = moneyField('Total', total, true);
      if (invalidTotal) throw new ApiError(422, 'INPUT_INVALID', null, invalidTotal);
      if (!rateValue.trim()) throw new ApiError(422, 'INPUT_INVALID', null, 'Indica la tasa declarada. No hay una tasa por defecto.');
      const parts = [firstPrincipal||principal, interest, insurance, fees].map(canonicalMoney);
      const sum = parts.reduce((totalCents, value) => totalCents + (cents(value) ?? 0n), 0n);
      const declared = canonicalMoney(total);
      if (cents(declared) !== sum) throw new ApiError(422, 'COMPONENT_MISMATCH', null, 'El total no coincide con principal, interés, seguro y cargos. No se envía.');
      const additional=extraInstallments.map((row,index)=>{const amounts=['principal','interest','insurance','fees','total'].map(k=>canonicalMoney(row[k]??''));if(amounts.slice(0,4).reduce((n,v)=>n+cents(v)!,0n)!==cents(amounts[4]!))throw new ApiError(422,'COMPONENT_MISMATCH',null,'Una cuota adicional no concilia sus componentes.');return{number:index+2,dueDate:row.dueDate,principal:amounts[0],interest:amounts[1],insurance:amounts[2],fees:amounts[3],total:amounts[4]};});
      const payload: Row = {
        kind, label: label.trim(), counterpartyReference: counterparty.trim(), principal: canonicalMoney(principal),
        rate: { kind: rateKind, source: 'SYNTHETIC_DECLARED', sourceReference: support.trim(), validFrom, observedOn, unit, convention, decimalValue: rateValue.trim(), combine: 'NONE' },
        schedule: { kind: scheduleKind, validFrom, referenceDate, sourceReference: support.trim(), principalOpening: canonicalMoney(principal), rateVersionIds: [], installments: [{ number: 1, dueDate, principal: parts[0], interest: parts[1], insurance: parts[2], fees: parts[3], total: declared },...additional],...(scheduleKind==='PROJECTED'?{projectionMethod:'DECLARED_PRINCIPAL_SCHEDULE'}:{}) },
        prepaymentPermissions: prepayment, supportReference: support.trim(),
      };
      await send(`${prefix}CreateLiability`, 'LIABILITY_CREATE', `${base}/liabilities`, payload);
      onDone(scheduleKind === 'PROJECTED' ? 'Obligación registrada. El calendario enviado es una proyección, no una cuota oficial.' : 'Obligación registrada con el calendario oficial declarado.');
    }, setPending, setError)}>
      <h2>Obligación</h2>
      <Field label="Tipo"><select value={kind} onChange={event => setKind(event.target.value)}><option value="BANK_LOAN">Préstamo bancario</option><option value="FINANCED_PURCHASE">Compra financiada</option><option value="CARD">Tarjeta</option><option value="PRIVATE_DEBT">Deuda particular</option></select></Field>
      <Field label="Nombre"><input value={label} onChange={event => setLabel(event.target.value)} required /></Field>
      <Field label="Referencia de la contraparte"><input value={counterparty} onChange={event => setCounterparty(event.target.value)} required /></Field>
      <Field label="Principal"><input inputMode="decimal" value={principal} onChange={event => setPrincipal(event.target.value)} required /></Field>
      <Field label="Clase de tasa"><select value={rateKind} onChange={event => setRateKind(event.target.value)}><option value="NONE_DECLARED">Sin tasa declarada distinta de cero</option><option value="FIXED">Fija</option><option value="VARIABLE">Variable</option></select></Field>
      <Field label="Valor decimal de la tasa" hint="Texto del contrato, por ejemplo 0.00. No se calcula aquí."><input value={rateValue} onChange={event => setRateValue(event.target.value)} required /></Field>
      <Field label="Vigente desde"><input type="date" value={validFrom} onChange={event => setValidFrom(event.target.value)} required /></Field>
      <Field label="Fecha de referencia del calendario" hint="Debe ser anterior al vencimiento. El servidor rechaza una cuota que no queda después de esta fecha."><input type="date" value={referenceDate} onChange={event => setReferenceDate(event.target.value)} required /></Field>
      <Field label="Observada el"><input type="date" value={observedOn} onChange={event => setObservedOn(event.target.value)} required /></Field>
      <Field label="Unidad"><select value={unit} onChange={event => setUnit(event.target.value)}><option value="ANNUAL_FRACTION">Fracción anual</option><option value="PERIOD_FRACTION">Fracción del período</option></select></Field>
      <Field label="Convención"><select value={convention} onChange={event => setConvention(event.target.value)}><option value="ANNUAL_SIMPLE_ACT_365">Simple anual ACT/365</option><option value="ANNUAL_EFFECTIVE_ACT_365">Efectiva anual ACT/365</option><option value="PERIODIC_EFFECTIVE">Efectiva del período</option></select></Field>
      <Field label="Calendario"><select value={scheduleKind} onChange={event => setScheduleKind(event.target.value)}><option value="OFFICIAL_DECLARED">Cuota oficial declarada</option><option value="PROJECTED">Proyección, no es la cuota oficial</option></select></Field>
      <Field label="Vencimiento de la cuota"><input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} required /></Field>
      <Field label="Principal de la primera cuota (opcional si es única)"><input value={firstPrincipal} inputMode="decimal" onChange={e=>setFirstPrincipal(e.target.value)}/></Field>
      <Field label="Interés de la cuota"><input inputMode="decimal" value={interest} onChange={event => setInterest(event.target.value)} required /></Field>
      <Field label="Seguro"><input inputMode="decimal" value={insurance} onChange={event => setInsurance(event.target.value)} required /></Field>
      <Field label="Cargos"><input inputMode="decimal" value={fees} onChange={event => setFees(event.target.value)} required /></Field>
      <Field label="Total declarado"><input inputMode="decimal" value={total} onChange={event => setTotal(event.target.value)} required /></Field>
      <Field label="Soporte"><input value={support} onChange={event => setSupport(event.target.value)} required /></Field>
      {extraInstallments.map((row,index)=><fieldset key={index}><legend>Cuota {index+2}</legend>{[['dueDate','Vencimiento','date'],['principal','Principal','text'],['interest','Interés','text'],['insurance','Seguro','text'],['fees','Cargos','text'],['total','Total','text']].map(([key,label,type])=><Field key={key} label={label+' cuota '+(index+2)}><input required type={type} value={row[key!]??''} onChange={e=>setExtraInstallments(rows=>rows.map((r,i)=>i===index?{...r,[key!]:e.target.value}:r))}/></Field>)}</fieldset>)}
      <button type="button" onClick={()=>setExtraInstallments(rows=>[...rows,{}])}>Añadir cuota al calendario</button>
      <Field label="Permisos declarados de abono"><select multiple value={prepayment} onChange={e=>setPrepayment(Array.from(e.target.selectedOptions,o=>o.value))}><option value="REDUCE_TERM">Reducir plazo</option><option value="REDUCE_INSTALLMENT">Reducir cuota</option></select></Field>
      <button type="submit" disabled={pending}>Registrar obligación</button>
    </form>
  );
}

function Consolidation({ rows, personalEtag, businessEtag, organizationId, today, pending, setPending, setError, send, bookId,refresh }: {
  refresh:()=>Promise<void>; rows: Row[]; personalEtag: string | null; businessEtag: string | null; organizationId: string; today: string; bookId: string | null;
  pending: boolean; setPending: (value: boolean) => void; setError: (error: unknown) => void;
  send: (operation: string, purpose: string, path: string, payload: Row) => Promise<{ data: Row }>;
}) {
  const body = rows[0] ?? {};
  const businesses = Array.isArray(body.businesses) ? body.businesses as Row[] : [];
  const eliminations = Array.isArray(body.eliminations) ? body.eliminations as Row[] : [];
  const participations = Array.isArray(body.participations) ? body.participations as Row[] : [];
  const [right, setRight] = useState('FULL_OWNERSHIP');
  const [percentage, setPercentage] = useState('');
  const [support, setSupport] = useState('');
  const [amount, setAmount] = useState('');
  const [eligibility, setEligibility] = useState('');
  const [personalCash, setPersonalCash] = useState('');
  const [businessCash, setBusinessCash] = useState('');
  const [personalContra, setPersonalContra] = useState('');
  const [businessContra, setBusinessContra] = useState('');
  return (
    <div className="report-layout">
      <h2>Consolidado privado</h2>
      <p>{personalEtag&&businessEtag?'Versiones de los libros consultadas.':'Se consultarán las versiones vigentes al confirmar un cruce.'}</p>
      {(['personalTotals','gross','net'] as const).map(key=><article key={key}><h3>{key==='personalTotals'?'Personal':key==='gross'?'Consolidado bruto':'Consolidado neto'}</h3>{Object.entries({assets:'Activos',liabilities:'Pasivos',equity:'Patrimonio',income:'Ingresos',expense:'Gastos',cashAvailable:'Efectivo disponible'}).map(([field,label])=><p key={field}>{label}: {cash((body[key] as Row|undefined)?.[field])}</p>)}</article>)}
      <p>Cada negocio y cada eliminación se muestran como los trajo el servidor. No se unen por nombre.</p>
      {businesses.length === 0 ? <Empty>Sin negocios elegibles en esta respuesta.</Empty> : businesses.map((item, index) => <article className="metric-card" key={`${String(item.organizationId)}-${index}`}><h3>Negocio {index + 1}</h3><p>Referencia {String(item.organizationId ?? 'sin referencia').slice(0, 8)}.</p></article>)}
      {eliminations.map((item, index) => <p key={`e-${index}`}>Eliminación {CROSS_LABELS[String(item.kind)]??'informada por el servidor'} {cash(item.amount)}. Relación {String(item.relationshipId ?? '').slice(0, 8)}.</p>)}
      {participations.map((item, index) => <p key={`p-${index}`}>Participación aparte {String(item.percentage ?? 'sin porcentaje')}. {REASONS[String(item.reason)]??'Participación informada por el servidor.'}</p>)}
      <form onSubmit={onSubmit(async () => {
        if (!organizationId || !bookId) throw new ApiError(428, 'ETAG_REQUIRED', null, 'Faltan las versiones de los dos libros. No se cruza.');
        if (right === 'FULL_OWNERSHIP' && percentage !== '100.00') throw new ApiError(422, 'INPUT_INVALID', null, 'La titularidad plena usa el porcentaje 100.00 declarado, no otro valor.');
        const created = await send('declareOwnEligibility', 'OWNERSHIP_DECLARE', `/organizations/${organizationId}/ownership-declarations`, { right, percentage, validFrom: today, supportReference: support.trim() });
        setEligibility(String((created.data as Row).id ?? eligibility));
      }, setPending, setError)}>
        <h2>Elegibilidad declarada</h2>
        <Field label="Derecho"><select value={right} onChange={event => setRight(event.target.value)}><option value="FULL_OWNERSHIP">Titularidad plena</option><option value="PARTICIPATION">Participación</option></select></Field>
        <Field label="Porcentaje" hint="Texto 100.00 o 40.00. No se calcula."><input value={percentage} onChange={event => setPercentage(event.target.value)} required /></Field>
        <Field label="Soporte"><input value={support} onChange={event => setSupport(event.target.value)} required /></Field>
        <button type="submit" disabled={pending}>Declarar elegibilidad</button>
      </form>
      <form onSubmit={onSubmit(async () => {
        const invalid = moneyField('Cruce', amount);
        if (invalid) throw new ApiError(422, 'INPUT_INVALID', null, invalid ?? 'Faltan las versiones de los libros.');
        const pb=await call<Row>('GET','/me/personal/book'),bb=await call<Row>('GET',`/organizations/${organizationId}/finance-s09/book`);
        await send('postInterbookRelationship', 'INTERBOOK_POST', '/me/interbook-relationships', {
          kind: 'CONTRIBUTION', businessOrganizationId: organizationId, businessBookETag: bb.etag, personalBookETag: pb.etag,
          eligibilityVersionId: eligibility.trim(), effectiveDate: today, amount: canonicalMoney(amount), fromScope: 'PERSONAL',
          personalCashAccountId: personalCash.trim(), businessCashAccountId: businessCash.trim(), personalContraAccountId: personalContra.trim(), businessContraAccountId: businessContra.trim(),
          supportReference: support.trim(),
        });await refresh();
      }, setPending, setError)}>
        <h2>Cruce de aporte</h2>
        <p>Hace falta confirmación de saldo. Las cuentas no se copian del negocio al personal.</p>
        <Field label="Versión de elegibilidad"><input value={eligibility} onChange={event => setEligibility(event.target.value)} required /></Field>
        <Field label="Importe"><input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} required /></Field>
        <Field label="Efectivo personal"><input value={personalCash} onChange={event => setPersonalCash(event.target.value)} required /></Field>
        <Field label="Efectivo del negocio"><input value={businessCash} onChange={event => setBusinessCash(event.target.value)} required /></Field>
        <Field label="Contrapartida personal"><input value={personalContra} onChange={event => setPersonalContra(event.target.value)} required /></Field>
        <Field label="Contrapartida del negocio"><input value={businessContra} onChange={event => setBusinessContra(event.target.value)} required /></Field>
        <button type="submit" disabled={pending}>Confirmar cruce</button>
      </form>
    </div>
  );
}

function Listing({ panel, items }: { panel: string; items: Row[] }) {
  if (panel === 'consolidation') return null;
  if (items.length === 0) return <Empty>Sin filas de este corte.</Empty>;
  if (panel === 'agenda') {
    return (
      <table>
        <caption>Agenda</caption>
        <thead><tr><th>Vencimiento</th><th>Clase</th><th>Importe</th></tr></thead>
        <tbody>{items.map((item, index) => <tr key={`${String(item.sourceId)}-${index}`}><td>{String(item.dueDate ?? '')}</td><td>{item.sourceKind==='EXPENSE'&&item.kind==='OFFICIAL_DECLARED'?'Gasto devengado':AGENDA[String(item.kind ?? '')] ?? 'Clase del servidor sin etiqueta de pago'}</td><td>{item.amount == null ? 'Sin precio declarado' : cash(item.amount)}</td></tr>)}</tbody>
      </table>
    );
  }
  return (
    <ul>
      {items.map(item => {
        const schedule = item.schedule as { kind?: string; principalOpening?: string } | undefined;
        return (
          <li key={String(item.id)}>
            <p>{String(item.description ?? item.label ?? 'Registro del servidor')}</p>
            <p>{item.recognitionStatus==='RECOGNIZED'?'Devengado.':item.recognitionStatus==='REVERSED'?'Devengo revertido.':item.planningStatus === 'PLANNED' ? 'Presupuestado.' : item.planningStatus === 'UNPRICED' ? 'Sin precio.' : item.planningStatus === 'CANCELLED' ? 'Cancelado.' : ''}</p>
            <p>{item.settlementStatus === 'PAID' ? 'Pagado, según el servidor.' : item.settlementStatus === 'PARTIAL' ? 'Pago parcial, según el servidor.' : item.settlementStatus === 'UNPAID' ? 'Pendiente de pago.' : ''}</p>
            {item.status === 'DRAFT' ? <p>Borrador. Todavía no hay reconocimiento.</p> : null}
            {schedule?.kind === 'PROJECTED' ? <p>Proyección, no es la cuota oficial.</p> : schedule?.kind === 'OFFICIAL_DECLARED' ? <p>Cuota oficial declarada.</p> : null}
            {typeof schedule?.principalOpening === 'string' ? <p>Principal declarado {cash(schedule.principalOpening)}.</p> : null}
            {typeof item.principalOutstanding === 'string' ? <p>Principal reconocido pendiente {cash(item.principalOutstanding)}. No es la cuota oficial ni una proyección.</p> : null}
            {typeof item.amount==='string'&&item.recognitionStatus!=='RECOGNIZED'?<p>Importe declarado {cash(item.amount)}.</p>:null}
            {typeof item.outstanding === 'string'&&item.recognitionStatus==='RECOGNIZED' ? <p>Saldo por pagar {cash(item.outstanding)}.</p> : null}
            {item.coverage === 'INCOMPLETE' ? <p>Cobertura incompleta de esta obligación. El calendario no cubre todo el principal reconocido al corte.</p> : null}
          </li>
        );
      })}
    </ul>
  );
}

function readDraft(key: string): Record<string, string> {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(key) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch { return {}; }
}
