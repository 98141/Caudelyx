import { useEffect, useState } from 'react';
import { call } from '../../shared/api';
import { ApiError } from '../../shared/contracts';
import { parseLocalCop } from '../../shared/money';
import { ensureStepUp } from '../../shared/step-up';
import { ErrorText, Field, onSubmit } from '../../shared/ui';
import { useSimple } from './context';
import { createSlot, keyFor, markUncertain, releaseSlot, type CommandSlot } from './memory';
import { metricText,formatPreviewCop } from './model';
import {useCrossOptions,CrossAccountSelect} from './CrossSelectors';
import { ScopeBar } from './Month';
import { CashSelect, GrantNote, More } from './widgets';

const allocateSlot = createSlot();
const releaseSlotCommand = createSlot();
const transferSlot = createSlot();
const crossSlot = createSlot();

export function CashScreen() {
  const simple = useSimple();
  const view = simple.view && simple.view.scope !== 'CONSOLIDATED' ? simple.view : null;
  const consolidated = simple.view?.scope === 'CONSOLIDATED' ? simple.view : null;
  return (
    <section className="simple-wrap" data-screen="caja">
      <h1 id="page-title" tabIndex={-1}>¿Dónde está mi dinero?</h1>
      <ScopeBar />
      <ErrorText error={simple.viewError} />
      {consolidated ? <p>Efectivo {metricText(consolidated.totalCash)}. Apartado {metricText(consolidated.totalReserved)}. Libre {metricText(consolidated.totalFree)}. Solo consulta: no se suman ni se mueven.</p> : null}
      {view ? (
        <>
          <div className="simple-grid">
            <article className="card"><h2>Efectivo</h2><p className="num">{metricText(view.cash)}</p><p>Caja y banco que el servidor confirma.</p></article>
            <article className="card"><h2>Protegido y apartado</h2><p className="num">{metricText(view.reserved)}</p><p>Es el mismo dato reservado. No se suma otra vez a la caja.</p></article>
            <article className="card"><h2>Libre</h2><p className="num">{metricText(view.free)}</p><p>Lo que no está apartado.</p></article>
          </div>
          <p>El primer saldo de un libro nuevo se registra en el asistente de apertura, no como un aporte de esta pantalla. <a href="#/finanzas">Abrir el asistente de apertura</a></p>
        </>
      ) : null}
      {simple.scope !== 'CONSOLIDATED' && simple.bookId ? (
        <>
          <FundMove kind="reserve" slot={allocateSlot} />
          <FundMove kind="release" slot={releaseSlotCommand} />
          {simple.scope === 'BUSINESS' ? <TransferForm /> : <p>La transferencia real entre cuentas de negocio está en el libro de negocio. En personal, reservar o liberar no crea efectivo.</p>}
          <CrossForm />
        </>
      ) : null}
    </section>
  );
}

function FundMove({ kind, slot }: { kind: 'reserve' | 'release'; slot: CommandSlot }) {
  const simple = useSimple();
  const wealth = simple.scope === 'BUSINESS' ? `/organizations/${simple.organizationId}/wealth-s10` : `/me/personal/books/${simple.bookId}/wealth-s10`;
  const [funds, setFunds] = useState<Array<{ id: string; label?: string }>>([]);
  const [fundId, setFundId] = useState('');
  const [amount, setAmount] = useState('');
  const [support, setSupport] = useState('');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const ac = new AbortController();
    void call<{ items: Array<{ id: string; label?: string }> }>('GET', `${wealth}/funds?asOf=${simple.effectiveDate}&limit=20`, undefined, { signal: ac.signal }).then(result => setFunds(result.data.items ?? [])).catch(() => setFunds([]));
    return () => ac.abort();
  }, [wealth, simple.effectiveDate]);
  const title = kind === 'reserve' ? 'Reservar' : 'Liberar';
  return (
    <form className="simple-form" onSubmit={onSubmit(async () => {
      const canonical = parseLocalCop(amount);
      if (!fundId || !canonical || !support.trim()) throw new ApiError(422, 'INPUT_INVALID', null, 'Indica apartado, importe y soporte.');
      const fund = await call<unknown>('GET', `${wealth}/funds/${fundId}?asOf=${simple.effectiveDate}`);
      const book = await call<unknown>('GET', `${wealth}/book?asOf=${simple.effectiveDate}`);
      if (!fund.etag || !book.etag) throw new ApiError(428, 'ETAG_REQUIRED', null, 'Falta la versión del apartado o del libro.');
      const payload = { bookETag: book.etag, effectiveDate: simple.effectiveDate, supportReference: support.trim(), amount: canonical };
      const summary = `${title} ${canonical} COP del apartado elegido, el ${simple.effectiveDate}. ${kind === 'reserve' ? 'Aparta dinero que ya existe. No crea caja.' : 'Devuelve apartado a libre. No es una transferencia a otro banco.'}`;
      if (!ready) { setReady(true); return; }
      const key = keyFor(slot, JSON.stringify({ kind, fundId, payload, etag: fund.etag }));
      const purpose = kind === 'reserve' ? 'FUND_ALLOCATE' : 'FUND_RELEASE';
      const path = `${wealth}/funds/${fundId}/${kind === 'reserve' ? 'allocations' : 'releases'}`;
      try {
        const scope=simple.scope==='PERSONAL'?{bookId:simple.bookId!}:{organizationId:simple.organizationId},operationId=(simple.scope==='PERSONAL'?'personal':'business')+(kind==='reserve'?'AllocateFund':'ReleaseFund');
        await ensureStepUp({ purpose, resourceId: fundId, command:{operationId,...scope,idempotencyKey:key,pathParameters:{...scope,fundId},payload,expectedETag:fund.etag}, summary });
        await call('POST', path, payload, { idempotencyKey: key, ifMatch: fund.etag });
        releaseSlot(slot);
        setReady(false);
        simple.refreshCut();
      } catch (caught) {
        if (caught instanceof ApiError && (caught.status === 0 || caught.status === 503)) markUncertain(slot);
        else releaseSlot(slot);
        throw caught;
      }
    }, setPending, setError)}>
      <h2>{title}</h2>
      <GrantNote />
      <ErrorText error={error} />
      <Field label="Apartado">
        <select value={fundId} onChange={event => { setFundId(event.target.value); setReady(false); }} required>
          <option value="">Selecciona</option>
          {funds.map(fund => <option key={fund.id} value={fund.id}>{fund.label ?? fund.id.slice(0, 8)}</option>)}
        </select>
      </Field>
      <Field label="Importe"><input inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value); setReady(false); }} required /></Field>
      <Field label="Fecha"><input type="date" value={simple.effectiveDate} onChange={event => { simple.setEffectiveDate(event.target.value); setReady(false); }} required /></Field>
      <Field label="Soporte"><input value={support} onChange={event => { setSupport(event.target.value); setReady(false); }} required /></Field>
      {ready ? <p role="status">{kind === 'reserve' ? 'Se aparta dinero ya existente. No nace caja nueva.' : 'Se libera a disponible. No sale del libro.'}</p> : null}
      <button type="submit" disabled={pending}>{ready ? `Confirmar ${title.toLowerCase()}` : `Revisar ${title.toLowerCase()}`}</button>
    </form>
  );
}

function TransferForm() {
  const simple = useSimple();
  const base = `/organizations/${simple.organizationId}/financial`;
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [amount, setAmount] = useState('');
  const [support, setSupport] = useState('');
  const [description, setDescription] = useState('');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  return (
    <form className="simple-form" onSubmit={onSubmit(async () => {
      const canonical = parseLocalCop(amount);
      if (!canonical || !fromId || !toId || fromId === toId || !support.trim() || !description.trim()) throw new ApiError(422, 'INPUT_INVALID', null, 'Elige dos cuentas distintas, un importe, un soporte y una descripción.');
      const intent = { currency: 'COP' as const, effectiveDate: simple.effectiveDate, supportReference: support.trim(), description: description.trim(), fromAccountId: fromId, toAccountId: toId, amount: canonical };
      if (!ready) { setReady(true); return; }
      const key = keyFor(transferSlot, JSON.stringify(intent));
      const payload = { ...intent, sourceId: key };
      try {
        await ensureStepUp({ purpose: 'FINANCE_TRANSFER', resourceId: simple.organizationId, command: { organizationId: simple.organizationId, idempotencyKey: key, payload }, summary: `Transferir ${canonical} COP entre cuentas. No es un ingreso ni un gasto.` });
        await call('POST', `${base}/transfers`, payload, { idempotencyKey: key });
        releaseSlot(transferSlot);
        setReady(false);
        simple.refreshCut();
      } catch (caught) {
        if (caught instanceof ApiError && (caught.status === 0 || caught.status === 503)) markUncertain(transferSlot);
        else releaseSlot(transferSlot);
        throw caught;
      }
    }, setPending, setError)}>
      <h2>Transferencia real</h2>
      <ErrorText error={error} />
      <CashSelect base={base} value={fromId} onChange={value => { setFromId(value); setReady(false); }} label="Origen" />
      <CashSelect base={base} value={toId} onChange={value => { setToId(value); setReady(false); }} label="Destino" />
      <Field label="Importe"><input inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value); setReady(false); }} required /></Field>
      <Field label="Fecha"><input type="date" value={simple.effectiveDate} onChange={event => { simple.setEffectiveDate(event.target.value); setReady(false); }} required /></Field>
      <Field label="Soporte"><input value={support} onChange={event => { setSupport(event.target.value); setReady(false); }} required /></Field>
      <Field label="Descripción"><input value={description} onChange={event => { setDescription(event.target.value); setReady(false); }} required /></Field>
      {ready ? <p role="status">Origen y destino son cuentas reales. Naturaleza: traslado, no ingreso ni gasto ni apartado.</p> : null}
      <button type="submit" disabled={pending}>{ready ? 'Confirmar transferencia' : 'Revisar transferencia'}</button>
    </form>
  );
}

function CrossForm() {
  const simple = useSimple();
  const {options,error:optionsError,loading}=useCrossOptions();
  const [rootId,setRootId]=useState('');
  const [done,setDone]=useState(false);
  const [kind, setKind] = useState('');
  const [amount, setAmount] = useState('');
  const [personalCash, setPersonalCash] = useState('');
  const [businessCash, setBusinessCash] = useState('');
  const [personalContra, setPersonalContra] = useState('');
  const [businessContra, setBusinessContra] = useState('');
  const [eligibility, setEligibility] = useState('');
  const [support, setSupport] = useState('');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const root=options?.contributions.find(r=>r.id===rootId);
  const changed=(setter:(v:string)=>void)=>(v:string)=>{setter(v);setReady(false);setDone(false);};
  const cash=(rows:NonNullable<typeof options>['personalAccounts'])=>rows.filter(a=>a.accountClass==='ASSET'&&['CASH','BANK'].includes(a.kind));
  return (
    <form className="simple-form" onSubmit={onSubmit(async () => {
      const canonical = parseLocalCop(amount);
      if (!kind || !canonical || !personalCash || !businessCash || !personalContra || !businessContra || !eligibility.trim() || !support.trim() || !simple.organizationId || !simple.bookId) {
        throw new ApiError(422, 'INPUT_INVALID', null, 'Completa importe, cuentas, elegibilidad y soporte. El retiro no se disfraza de aporte.');
      }
      if(!options||options.organizationId!==simple.organizationId||!options.eligibilities.some(e=>e.id===eligibility))throw new ApiError(422,'INPUT_INVALID',null,'Elige la titularidad vigente del negocio.');
      if(kind==='WITHDRAWAL'&&(!root||root.personalContraAccountId!==personalContra||root.businessContraAccountId!==businessContra))throw new ApiError(422,'SUPPORT_REQUIRED',null,'Elige el aporte original y sus cuentas de origen.');
      const personal = await call<{id:string}>('GET', '/me/personal/book');
      if(personal.data.id!==options.personalBookId)throw new ApiError(412,'PRECONDITION_FAILED',null,'El libro personal cambió. Actualiza la consulta.');
      const business = await call<unknown>('GET', `/organizations/${simple.organizationId}/finance-s09/book`);
      if (!personal.etag || !business.etag) throw new ApiError(428, 'ETAG_REQUIRED', null, 'Faltan las versiones de los dos libros.');
      const fromScope = kind === 'CONTRIBUTION' ? 'PERSONAL' : 'BUSINESS';
      const payload = {
        kind, businessOrganizationId: simple.organizationId, businessBookETag: business.etag, personalBookETag: personal.etag,
        eligibilityVersionId: eligibility.trim(), effectiveDate: simple.effectiveDate, amount: canonical, fromScope,
        personalCashAccountId: personalCash, businessCashAccountId: businessCash, personalContraAccountId: personalContra, businessContraAccountId: businessContra,
        supportReference: support.trim(),
        ...(kind==='WITHDRAWAL'?{originalEventIds:root!.sourceEventIds}:{}),
      };
      if (!ready) { setReady(true); return; }
      const key = keyFor(crossSlot, JSON.stringify(payload));
      try {
        await ensureStepUp({ purpose: 'INTERBOOK_POST', resourceId: simple.organizationId, command:{operationId:'postInterbookRelationship',idempotencyKey:key,pathParameters:{},payload}, summary: kind === 'CONTRIBUTION' ? 'Aporte del personal al negocio.' : 'Retiro del negocio hacia el personal, contra un aporte ya hecho.' });
        await call('POST', '/me/interbook-relationships', payload, { idempotencyKey: key });
        releaseSlot(crossSlot);
        setReady(false);
        setDone(true);
        setAmount('');
        simple.refreshCut();
      } catch (caught) {
        if (caught instanceof ApiError && (caught.status === 0 || caught.status === 503)) markUncertain(crossSlot);
        else releaseSlot(crossSlot);
        throw caught;
      }
    }, setPending, setError)}>
      <h2>Aporte o retiro entre personal y negocio</h2>
      <ErrorText error={error} />
      <ErrorText error={optionsError}/>
      {loading?<p role="status">Consultando cuentas, aportes y titularidad…</p>:null}
      {done?<p role="status">Cruce confirmado. Puedes actualizar Mi mes para ver los dos libros.</p>:null}
      <Field label="Naturaleza">
        <select value={kind} onChange={event => { changed(setKind)(event.target.value);setRootId('');setPersonalContra('');setBusinessContra(''); }} required>
          <option value="">Selecciona</option>
          <option value="CONTRIBUTION">Aporte del personal al negocio</option>
          <option value="WITHDRAWAL">Retiro al personal, contra un aporte ya registrado</option>
        </select>
      </Field>
      {kind==='WITHDRAWAL'?<Field label="Aporte original" hint="Saldo actual que todavía puede devolverse. No es un ingreso nuevo."><select value={rootId} onChange={e=>{changed(setRootId)(e.target.value);setPersonalContra('');setBusinessContra('');}} required><option value="">Selecciona</option>{options?.contributions.map(r=><option key={r.id} value={r.id}>Aporte del {r.effectiveDate} · por devolver {formatPreviewCop(r.remaining)}</option>)}</select>{!loading&&options?.contributions.length===0?<p>No hay aportes con saldo disponible para retirar.</p>:null}</Field>:null}
      <Field label="Importe"><input inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value); setReady(false); }} required /></Field>
      <Field label="Fecha"><input type="date" value={simple.effectiveDate} onChange={event => { simple.setEffectiveDate(event.target.value); setReady(false); }} required /></Field>
      <More label="Más opciones del cruce">
        <CrossAccountSelect label="Banco o caja personal" items={cash(options?.personalAccounts??[])} value={personalCash} onChange={changed(setPersonalCash)}/>
        <CrossAccountSelect label="Banco o caja del negocio" items={cash(options?.businessAccounts??[])} value={businessCash} onChange={changed(setBusinessCash)}/>
        <CrossAccountSelect label="Cuenta del aporte personal" items={(options?.personalAccounts??[]).filter(a=>a.accountClass==='ASSET'&&a.kind==='GENERAL'&&(!root||a.id===root.personalContraAccountId))} value={personalContra} onChange={changed(setPersonalContra)}/>
        <CrossAccountSelect label="Cuenta del capital del negocio" items={(options?.businessAccounts??[]).filter(a=>a.accountClass==='EQUITY'&&a.kind==='GENERAL'&&(!root||a.id===root.businessContraAccountId))} value={businessContra} onChange={changed(setBusinessContra)}/>
        <Field label="Titularidad del negocio"><select value={eligibility} onChange={e=>changed(setEligibility)(e.target.value)} required><option value="">Selecciona</option>{options?.eligibilities.map(e=><option key={e.id} value={e.id}>Propiedad total, vigente desde {e.validFrom}</option>)}</select>{!loading&&options?.eligibilities.length===0?<p>No hay una declaración vigente de propiedad total. Revísala en Finanzas.</p>:null}</Field>
        <Field label="Soporte"><input value={support} onChange={event => { setSupport(event.target.value); setReady(false); }} required /></Field>
      </More>
      {ready ? <p role="status">{kind === 'CONTRIBUTION' ? 'Sale del personal y entra al negocio.' : 'Sale del negocio hacia el personal. No crea caja nueva.'} Las cuentas no se copian de un libro al otro.</p> : null}
      <button type="submit" disabled={pending||loading||!options}>{ready ? 'Confirmar cruce' : 'Revisar cruce'}</button>
    </form>
  );
}
