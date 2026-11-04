import { useEffect, useState } from 'react';
import { call } from '../../shared/api';
import { ApiError, DiscardedRequest } from '../../shared/contracts';
import { parseLocalCop } from '../../shared/money';
import { ensureStepUp } from '../../shared/step-up';
import { Empty, ErrorText, Field, onSubmit } from '../../shared/ui';
import { useSimple } from './context';
import { createSlot, keyFor } from './memory';
import type { DebtPlanList, PreviewDocument, SavingsPlan } from './types';
import { ScopeBar } from './Month';
import { bookUrl, concealed, cutQuery, msGet, postKnown } from './transport';
import { GrantNote, More, PreviewBox,CashSelect,FundSelect } from './widgets';

const createSlotDebt = createSlot();
const paySlot = createSlot();

export function DebtsScreen() {
  const simple = useSimple();
  const [cursor,setCursor]=useState<string|null>(null);
  useEffect(()=>setCursor(null),[simple.bookId,simple.scope,simple.month,simple.effectiveDate,simple.knownAt]);
  const [plans, setPlans] = useState<DebtPlanList | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!simple.bookId || simple.scope === 'CONSOLIDATED') { setPlans(null); return; }
    const ac = new AbortController();
    let live = true;
    void msGet<DebtPlanList>(bookUrl(simple.bookId, 'debt-plans', cutQuery({ month: simple.month, effectiveDate: simple.effectiveDate, knownAt: simple.knownAt },cursor)), ac.signal).then(result => {
      if (live) setPlans(result.data);
    }).catch(caught => {
      if (!live || caught instanceof DiscardedRequest) return;
      setPlans(null);
      setError(concealed(caught));
    });
    return () => { live = false; ac.abort(); };
  }, [simple.bookId, simple.scope, simple.month, simple.effectiveDate, simple.knownAt,cursor]);
  return (
    <section className="simple-wrap" data-screen="deudas">
      <h1 id="page-title" tabIndex={-1}>¿Qué debo y cuándo pago?</h1>
      <ScopeBar />
      <ErrorText error={error} />
      <p>Anotar una deuda antigua no ingresa dinero a la caja. Una deuda informativa no se puede pagar hasta tener los componentes oficiales.</p>
      {plans ? <DebtTable list={plans} /> : null}
      {plans?.nextCursor?<button type="button" onClick={()=>setCursor(plans.nextCursor)}>Página siguiente de deudas</button>:null}
      {cursor?<button type="button" onClick={()=>setCursor(null)}>Primera página de deudas</button>:null}
      {simple.bookId && simple.scope !== 'CONSOLIDATED' ? <CreateDebt /> : null}
      {simple.bookId && simple.scope !== 'CONSOLIDATED' ? <PayInstallment /> : null}
    </section>
  );
}

function DebtTable({ list }: { list: DebtPlanList }) {
  return (
    <div className="simple-table-wrap">
      <table className="simple-table">
        <caption>{list.nextCursor ? `Esta página, ${list.rows.length} de ${list.totalCount}.` : `${list.totalCount} deudas de esta consulta.`}</caption>
        <thead><tr><th>Entidad</th><th>Saldo declarado</th><th>Cuota</th><th>Frecuencia</th><th>Próximo pago</th><th>Restantes</th><th>Pago</th></tr></thead>
        <tbody>
          {list.rows.map(row => (
            <tr key={row.id}>
              <td>{row.details.entity}</td>
              <td className="num">{row.details.declaredBalance} COP</td>
              <td className="num">{row.details.declaredQuota ?? 'Falta dato'}</td>
              <td>{row.details.frequency ?? 'Falta dato'}</td>
              <td>{row.details.nextDueDate ?? 'Falta dato'}</td>
              <td>{row.details.installmentsRemaining ?? 'Falta dato'}</td>
              <td>Cobertura incompleta. No se paga desde esta ficha.</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.rows.length === 0 ? <Empty>No hay deudas anotadas en este corte.</Empty> : null}
    </div>
  );
}

function CreateDebt() {
  const simple = useSimple();
  const [entity, setEntity] = useState('');
  const [balance, setBalance] = useState('');
  const [quotaKnown, setQuotaKnown] = useState('');
  const [quota, setQuota] = useState('');
  const [frequency, setFrequency] = useState('');
  const [due, setDue] = useState('');
  const [remaining, setRemaining] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  return (
    <form className="simple-form" onSubmit={onSubmit(async () => {
      if (!simple.bookId) throw new ApiError(422, 'INPUT_INVALID', null, 'No hay libro.');
      const declaredBalance = parseLocalCop(balance);
      if (!entity.trim() || !declaredBalance || !quotaKnown || !frequency) throw new ApiError(422, 'INPUT_INVALID', null, 'Indica la entidad, el saldo y si conoces la cuota y la frecuencia.');
      let declaredQuota: string | null = null;
      if (quotaKnown === 'yes') {
        declaredQuota = parseLocalCop(quota);
        if (!declaredQuota) throw new ApiError(422, 'INPUT_INVALID', null, 'Escribe la cuota del documento. Si no la conoces, elige esa opción. No se guarda cero.');
      }
      const body = {
        entity: entity.trim(),
        declaredBalance,
        declaredQuota,
        frequency: frequency === 'unknown' ? null : frequency,
        nextDueDate: due || null,
        installmentsRemaining: remaining ? Number(remaining) : null,
      };
      if (remaining && !/^[1-9]\d{0,2}$/.test(remaining)) throw new ApiError(422, 'INPUT_INVALID', null, 'Las cuotas restantes, si las conoces, van de 1 a 360.');
      const key = keyFor(createSlotDebt, JSON.stringify(body));
      await postKnown(createSlotDebt, key, bookUrl(simple.bookId, 'debt-plans'), body, undefined, undefined, 'finish');
      setDone(true);
      simple.refreshCut();
    }, setPending, setError)}>
      <h2>Anotar deuda</h2>
      <ErrorText error={error} />
      <Field label="Entidad"><input value={entity} onChange={event => setEntity(event.target.value)} required /></Field>
      <Field label="Saldo" hint="El saldo de tu documento. No entra a la caja."><input inputMode="decimal" value={balance} onChange={event => setBalance(event.target.value)} required /></Field>
      <Field label="¿Conoces la cuota?">
        <select value={quotaKnown} onChange={event => setQuotaKnown(event.target.value)} required>
          <option value="">Selecciona</option>
          <option value="yes">Sí, la escribo</option>
          <option value="no">No la conozco</option>
        </select>
      </Field>
      {quotaKnown === 'yes' ? <Field label="Cuota" hint="Total según tu documento."><input inputMode="decimal" value={quota} onChange={event => setQuota(event.target.value)} required /></Field> : null}
      <Field label="Frecuencia">
        <select value={frequency} onChange={event => setFrequency(event.target.value)} required>
          <option value="">Selecciona</option>
          <option value="MONTHLY">Mensual</option>
          <option value="QUARTERLY">Trimestral</option>
          <option value="SEMIANNUAL">Semestral</option>
          <option value="ANNUAL">Anual</option>
          <option value="CUSTOM">Otra</option>
          <option value="unknown">No definida</option>
        </select>
      </Field>
      <Field label="Próximo pago"><input type="date" value={due} onChange={event => setDue(event.target.value)} /></Field>
      <More label="Más opciones de la deuda">
        <Field label="Cuotas restantes" hint="Solo si el documento las dice."><input inputMode="numeric" value={remaining} onChange={event => setRemaining(event.target.value)} /></Field>
        <p>Seguro, tasa y componentes oficiales que no conozcas no se guardan como cero.</p>
      </More>
      <button type="submit" disabled={pending}>Anotar sin mover dinero</button>
      {done ? <p role="status">Quedó anotada como borrador informativo. La cobertura de pago está incompleta.</p> : null}
    </form>
  );
}

function PayInstallment() {
  const simple = useSimple();
  const [plan, setPlan] = useState<SavingsPlan | null>(null);
  const [rowId, setRowId] = useState('');
  const [known, setKnown] = useState('');
  const [principal, setPrincipal] = useState('');
  const [interest, setInterest] = useState('');
  const [insurance, setInsurance] = useState('');
  const [fees, setFees] = useState('');
  const [fundId, setFundId] = useState('');
  const [cashId, setCashId] = useState('');
  const [topUp, setTopUp] = useState('');
  const [support, setSupport] = useState('');
  const [preview, setPreview] = useState<PreviewDocument | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!simple.bookId) return;
    const ac = new AbortController();
    void msGet<SavingsPlan>(bookUrl(simple.bookId, 'savings-plan', cutQuery({ month: simple.month, effectiveDate: simple.effectiveDate, knownAt: simple.knownAt })), ac.signal).then(result => setPlan(result.data)).catch(() => setPlan(null));
    return () => ac.abort();
  }, [simple.bookId, simple.month, simple.effectiveDate, simple.knownAt]);
  const row = plan?.rows.find(item => item.installmentId === rowId);
  const payable = row?.officialPaymentCoverage === 'COMPLETE' && row.installmentId;
  return (
    <form className="simple-form" onSubmit={onSubmit(async () => {
      if (!payable || !row?.installmentId || !simple.bookId || !simple.bookEtag) throw new ApiError(422, 'MAPPING_REQUIRED', null, 'Solo se paga una cuota con cobertura oficial completa y datos conocidos.');
      if (known !== 'yes' || !topUp || !fundId || !cashId || !support.trim()) throw new ApiError(422, 'INPUT_INVALID', null, 'Confirma que conoces capital, interés, seguro y cargos. Un desconocido no es cero.');
      const parts = [principal, interest, insurance, fees].map(parseLocalCop);
      if (parts.some(item => !item)) throw new ApiError(422, 'INPUT_INVALID', null, 'Escribe los cuatro componentes. Cero solo si el documento dice cero.');
      const s09 = simple.scope === 'BUSINESS' ? `/organizations/${simple.organizationId}/finance-s09` : `/me/personal/books/${simple.bookId}/finance-s09`;
      const wealth = simple.scope === 'BUSINESS' ? `/organizations/${simple.organizationId}/wealth-s10` : `/me/personal/books/${simple.bookId}/wealth-s10`;
      const liability = await call<unknown>('GET', `${s09}/liabilities/${row.liabilityId}?asOf=${simple.effectiveDate}`);
      const fund = await call<unknown>('GET', `${wealth}/funds/${fundId}?asOf=${simple.effectiveDate}`);
      if (!liability.etag || !fund.etag) throw new ApiError(428, 'ETAG_REQUIRED', null, 'Falta la versión de la deuda o del apartado.');
      const intent = {
        liabilityId: row.liabilityId, installmentId: row.installmentId, fundId, cashAccountId: cashId, effectiveDate: simple.effectiveDate,
        principal: parts[0], interest: parts[1], insurance: parts[2], fees: parts[3], allowFreeTopUp: topUp === 'yes',
        expectedBookETag: simple.bookEtag, expectedLiabilityETag: liability.etag, expectedFundETag: fund.etag, supportReference: support.trim(),
      };
      const key = keyFor(paySlot, JSON.stringify(intent));
      if (!preview) {
        const result = await postKnown<PreviewDocument>(paySlot, key, bookUrl(simple.bookId, 'liability-payments-from-funds-previews'), { ...intent, executionKey: key }, simple.bookEtag, undefined, 'keep');
        setPreview(result.data);
        return;
      }
      if (preview.status !== 'READY' || Date.parse(preview.expiresAt) <= Date.now()) throw new ApiError(412, 'PRECONDITION_FAILED', null, 'La vista previa del pago no sigue válida.');
      await ensureStepUp({ purpose: 'MS_LIABILITY_PAY_FROM_FUND', resourceId: row.liabilityId, command: { operationId: 'msCommitLiabilityPaymentFromFund', bookId: simple.bookId, payload: { executionKey: key, previewToken: preview.previewToken, requestHash: preview.requestHash } }, summary: 'Pagar la cuota usa el apartado y, si lo elegiste, el libre.' });
      await postKnown(paySlot, key, bookUrl(simple.bookId, 'liability-payments-from-funds-commits'), { executionKey: key, previewToken: preview.previewToken, requestHash: preview.requestHash }, simple.bookEtag, undefined, 'finish');
      setPreview(null);
    }, setPending, setError)}>
      <h2>Pagar cuota oficial</h2>
      <GrantNote />
      <p>Pagar usa la cuota del plan de ahorro cuando su cobertura oficial está completa. La ficha anotada no se paga.</p>
      <ErrorText error={error} />
      <Field label="Cuota del plan">
        <select value={rowId} onChange={event => setRowId(event.target.value)}>
          <option value="">Selecciona</option>
          {(plan?.rows ?? []).map(item => <option key={String(item.installmentId)} value={item.installmentId ?? ''}>{item.dueDate ?? 'Sin fecha'} · {item.officialPaymentCoverage === 'COMPLETE' ? 'cobertura completa' : 'cobertura incompleta'}</option>)}
        </select>
      </Field>
      <More label="Más opciones del pago">
        <Field label="¿Conoces capital, interés, seguro y cargos?">
          <select value={known} onChange={event => setKnown(event.target.value)}><option value="">Selecciona</option><option value="yes">Sí</option><option value="no">No</option></select>
        </Field>
        <Field label="Capital"><input inputMode="decimal" value={principal} onChange={event => setPrincipal(event.target.value)} /></Field>
        <Field label="Interés"><input inputMode="decimal" value={interest} onChange={event => setInterest(event.target.value)} /></Field>
        <Field label="Seguro"><input inputMode="decimal" value={insurance} onChange={event => setInsurance(event.target.value)} /></Field>
        <Field label="Cargos"><input inputMode="decimal" value={fees} onChange={event => setFees(event.target.value)} /></Field>
        <FundSelect base={simple.scope==='BUSINESS'?`/organizations/${simple.organizationId}/wealth-s10`:`/me/personal/books/${simple.bookId}/wealth-s10`} value={fundId} onChange={setFundId} />
        <CashSelect base={simple.scope==='BUSINESS'?`/organizations/${simple.organizationId}/financial`:`/me/personal/books/${simple.bookId}/finance-s09`} value={cashId} onChange={setCashId} />
        <Field label="Si el apartado no alcanza">
          <select value={topUp} onChange={event => setTopUp(event.target.value)}><option value="">Selecciona</option><option value="no">Solo el apartado</option><option value="yes">Completar con libre</option></select>
        </Field>
        <Field label="Soporte"><input value={support} onChange={event => setSupport(event.target.value)} /></Field>
      </More>
      {preview ? <PreviewBox preview={preview} /> : null}
      <button type="submit" disabled={pending || !payable}>Pagar con autorización</button>
    </form>
  );
}
