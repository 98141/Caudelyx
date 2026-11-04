import { useEffect, useState } from 'react';
import { call } from '../../shared/api';
import { ApiError } from '../../shared/contracts';
import { cents, parseLocalCop } from '../../shared/money';
import { ensureStepUp } from '../../shared/step-up';
import { ErrorText, Field, onSubmit } from '../../shared/ui';
import { useSimple } from './context';
import { createSlot, keyFor } from './memory';
import { attentionLine, fractionGap, metricText, percentToFraction, presentedDifference } from './model';
import type { ConsolidatedView, MonthlyView, PreviewDocument } from './types';
import { bookUrl, postKnown } from './transport';
import { GrantNote, Money, PreviewBox,More,localDateTime } from './widgets';

const slot = createSlot();

function bookView(view: MonthlyView | ConsolidatedView | null, scope: string): MonthlyView | null {
  if (!view || view.scope === 'CONSOLIDATED') return null;
  return scope === view.scope ? view : null;
}

export function MonthScreen() {
  const simple = useSimple();
  const view = bookView(simple.view, simple.scope);
  const consolidated = simple.view?.scope === 'CONSOLIDATED' ? simple.view : null;
  const shown = view;
  const rows = shown ? [
    ['Capital prestado', shown.principal, 'Dinero que sigue prestado. No es ingreso.'],
    ['Disponible para prestar', shown.availableToLend, 'Lo que el servidor informa como disponible. No es la caja más los apartados.'],
    ['Interés cobrado', shown.interestCashCollected, 'Efectivo de interés ya cobrado. No incluye lo esperado.'],
    ['Interés esperado del mes', shown.interestExpectedThisMonth ?? {value:null,status:'UNAVAILABLE',reasons:['CONTRACT_FIELD_UNAVAILABLE'],sourceRefs:[]}, 'Interés de periodos con vencimiento en este mes y hasta el corte. No es dinero recibido.'],
    ['Próximo ciclo de interés', shown.interestExpected, 'Interés esperado del ciclo fijado actual. No es dinero recibido.'],
    ['Sobra de base', shown.baseSurplus, 'Sobra calculada del mes antes de repartir.'],
    ['Sobra ya repartida', shown.distributedSurplus, 'Lo que ya salió de la sobra. No vuelve a aparecer como libre.'],
    ['Sobra por repartir', shown.remainingSurplus, 'Lo que todavía se puede repartir, si el servidor lo informa.'],
  ] as const : [];
  const attention = shown ? rows.map(([label, metric]) => attentionLine(label, metric)).filter((line): line is string => Boolean(line)) : [];
  return (
    <section className="simple-wrap" data-screen="mes">
      <h1 id="page-title" tabIndex={-1}>¿Cómo va este mes?</h1>
      <CutBar />
      {simple.loading ? <p role="status">Consultando el mes…</p> : null}
      <ErrorText error={simple.viewError} />
      {simple.scope === 'CONSOLIDATED' ? <p>Consolidado, solo consulta. No reparte ni mueve dinero.</p> : null}
      {consolidated ? <ConsolidatedBooks view={consolidated} /> : null}
      {!simple.loading && !simple.view && !simple.viewError ? <p>No hay una vista de este corte.</p> : null}
      {shown ? (
        <>
          <p>Dinero {shown.scope === 'BUSINESS' ? 'del negocio' : 'personal'} · mes {shown.month} · pesos colombianos.</p>
          <details><summary>Detalles de la consulta</summary><p>Fecha incluida {shown.cuts.effectiveDate}. Información registrada hasta {localDateTime(shown.cuts.knownAt)}. Contrato {shown.cuts.contractVersion}, zona {shown.cuts.timezone}.</p></details>
          <div className="simple-grid">
            {rows.map(([label, metric, help]) => (
              <article className="card" key={label}>
                <h2>{label}</h2>
                <p className="num"><Money metric={metric} /></p>
                <p>{help}</p>
              </article>
            ))}
          </div>
          <div className="simple-table-wrap">
            <table className="simple-table">
              <caption>Esperado, real y diferencia. La diferencia solo se muestra si las dos cifras están completas.</caption>
              <thead><tr><th>Concepto</th><th>Esperado</th><th>Real</th><th>Diferencia</th></tr></thead>
              <tbody>
                <tr>
                  <th scope="row">Interés</th>
                  <td className="num"><Money metric={shown.interestExpectedThisMonth ?? {value:null,status:'UNAVAILABLE',reasons:[],sourceRefs:[]}} /></td>
                  <td className="num"><Money metric={shown.interestCashCollected} /></td>
                  <td className="num">{presentedDifference(shown.interestExpected, shown.interestCashCollected)}</td>
                </tr>
                <tr>
                  <th scope="row">Otros ingresos</th>
                  <td className="num">No disponible</td>
                  <td className="num"><Money metric={shown.otherIncome} /></td>
                  <td className="num">No disponible</td>
                </tr>
                <tr>
                  <th scope="row">Gastos pagados</th>
                  <td className="num">No disponible</td>
                  <td className="num"><Money metric={shown.paidExpenses} /></td>
                  <td className="num">No disponible</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>Caja {metricText(shown.cash)}. Apartado {metricText(shown.reserved)}. Libre {metricText(shown.free)}. El apartado ya está incluido en el dinero que tienes.</p>
          {attention.length ? <ul aria-label="Atención">{attention.map(line => <li key={line}>{line}</li>)}</ul> : <p>Sin datos incompletos en estas cifras.</p>}
          <Distribute view={shown} etag={simple.bookEtag} bookId={simple.bookId} />
        </>
      ) : null}
    </section>
  );
}

function ConsolidatedBooks({ view }: { view: ConsolidatedView }) {
  return (
    <div>
      <p>Efectivo total {metricText(view.totalCash)}. Libre {metricText(view.totalFree)}. Apartado {metricText(view.totalReserved)}. Sobra de base {metricText(view.baseSurplus)}. Acción de dinero: no.</p>
      <p>{view.eliminatedRelationships.length} relaciones eliminadas del neto. No se muestran saldos ajenos.</p>
    </div>
  );
}

function CutBar() {
  const simple = useSimple();
  return (
    <form className="simple-cut" onSubmit={event => event.preventDefault()}>
      <Field label="Ámbito">
        <select value={simple.scope} onChange={event => simple.setScope(event.target.value as typeof simple.scope)}>
          {simple.scopes.map(item => <option key={item} value={item}>{item === 'BUSINESS' ? 'Negocio' : item === 'PERSONAL' ? 'Personal' : 'Consolidado, solo consulta'}</option>)}
        </select>
      </Field>
      <Field label="Mes" hint="Cambiar el mes deja atrás los borradores de este libro.">
        <input value={simple.month} onChange={event => simple.setMonth(event.target.value)} pattern="20[0-9]{2}-(0[1-9]|1[0-2])" required />
      </Field>
      <More label="Más opciones de la consulta">
      <Field label="Ver movimientos hasta">
        <input type="date" value={simple.effectiveDate} onChange={event => simple.setEffectiveDate(event.target.value)} required />
      </Field>
      <p>Información registrada hasta {localDateTime(simple.knownAt)}.</p>
      </More>
      <button type="button" onClick={simple.refreshCut}>Actualizar información</button>
      {simple.personalState === 'absent' && simple.scope === 'PERSONAL' ? <button type="button" onClick={() => void simple.openPersonal().catch(() => undefined)}>Abrir libro personal</button> : null}
      {simple.dropped ? <p role="status">Se descartó un envío sin confirmar porque cambió el ámbito, el libro o el mes. No se reenvió.</p> : null}
    </form>
  );
}

export function ScopeBar() {
  return <CutBar />;
}

function Distribute({ view, etag, bookId }: { view: MonthlyView; etag: string | null; bookId: string | null }) {
  const remaining = view.remainingSurplus;
  const none = remaining.status === 'COMPLETE' && remaining.value !== null && cents(remaining.value) === 0n;
  const unknown = remaining.value === null || remaining.status !== 'COMPLETE';
  const [emergency, setEmergency] = useState('');
  const [lend, setLend] = useState('');
  const [free, setFree] = useState('');
  const [amount, setAmount] = useState('');
  const [fundId, setFundId] = useState('');
  const [funds, setFunds] = useState<Array<{ id: string; label?: string }>>([]);
  const [preview, setPreview] = useState<PreviewDocument | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const simple = useSimple();
  const wealthBase = simple.scope === 'PERSONAL' ? `/me/personal/books/${bookId}/wealth-s10` : `/organizations/${simple.organizationId}/wealth-s10`;
  useEffect(() => { setPreview(null); setError(null); }, [simple.cutSerial]);
  useEffect(() => {
    if (!simple.organizationId) return;
    const ac = new AbortController();
    void call<{ items: Array<{ id: string; label?: string }> }>('GET', `${wealthBase}/funds?asOf=${simple.effectiveDate}&limit=20`, undefined, { signal: ac.signal }).then(result => setFunds(result.data.items ?? [])).catch(() => setFunds([]));
    return () => ac.abort();
  }, [wealthBase, simple.effectiveDate]);
  if (unknown) return <p>No hay sobra por repartir informada. No se usa cero.</p>;
  if (none) return <p>La sobra por repartir es 0,00 COP. Repartir no queda disponible.</p>;
  const fractions = [emergency, lend, free].map(percentToFraction);
  const named = [['EMERGENCY', fractions[0]], ['LOAN_FREE', fractions[1]], ['FREE', fractions[2]]] as const;
  const chosen = named.filter((entry): entry is readonly ['EMERGENCY' | 'LOAN_FREE' | 'FREE', string] => Boolean(entry[1] && entry[1] !== '0.000000'));
  const gap = chosen.length ? fractionGap(chosen.map(entry => entry[1])) : null;
  return (
    <form className="simple-form" onSubmit={onSubmit(async () => {
      if (!bookId || !etag) throw new ApiError(428, 'ETAG_REQUIRED', null, 'Falta la versión del libro. Actualiza el corte.');
      const canonical = parseLocalCop(amount);
      const cap = cents(remaining.value ?? '');
      if (!canonical || cap === null || (cents(canonical) ?? -1n) <= 0n || cents(canonical)! > cap) {
        throw new ApiError(422, 'INPUT_INVALID', null, 'El importe debe ser mayor que cero y no mayor que la sobra informada.');
      }
      if (fractions.some(item => item === null) || gap !== 0n) throw new ApiError(422, 'INPUT_INVALID', null, 'Emergencias, prestar y libre deben sumar 100 %. No se reparte un residuo escrito a mano.');
      if (!view.cuts.mappingVersion || !view.cuts.sourceVector) throw new ApiError(422, 'MAPPING_REQUIRED', null, 'El corte no trae la versión del mapeo. No se inventa.');
      const needsFund = fractions[0] !== '0.000000';
      let emergencyEtag = '';
      if (needsFund) {
        if (!fundId) throw new ApiError(422, 'MAPPING_REQUIRED', null, 'Emergencias necesita el apartado. No se reparte sin él.');
        const fund = await call<unknown>('GET', `${wealthBase}/funds/${fundId}?asOf=${simple.effectiveDate}`);
        if (!fund.etag) throw new ApiError(428, 'ETAG_REQUIRED', null, 'Falta la versión del apartado de emergencias.');
        emergencyEtag = fund.etag;
      }
      const intent = {
        month: view.month,
        effectiveDate: simple.effectiveDate,
        amount: canonical,
        destinations: chosen.map(([kind, fraction]) => kind === 'EMERGENCY' ? { kind, fraction, fundId, expectedFundETag: emergencyEtag } : { kind, fraction }),
        mappingVersion: view.cuts.mappingVersion,
        expectedBookETag: etag,
        sourceVector: view.cuts.sourceVector,
        action: 'DISTRIBUTE',
      };
      const signature = JSON.stringify(intent);
      const key = keyFor(slot, signature);
      const body = { ...intent, executionKey: key };
      if (!preview) {
        const result = await postKnown<PreviewDocument>(slot, key, bookUrl(bookId, 'distributions-previews'), body, etag, undefined, 'keep');
        setPreview(result.data);
        return;
      }
      if (Date.parse(preview.expiresAt) <= Date.now() || preview.status !== 'READY') {
        throw new ApiError(412, 'PRECONDITION_FAILED', null, 'La vista previa venció o está bloqueada. Pide otra con el botón de recaptura. No se confirma sola.');
      }
      await ensureStepUp({ purpose: 'MS_SURPLUS_DISTRIBUTE', resourceId: bookId, command: { operationId: 'msCommitDistribution', bookId, payload: { executionKey: key, previewToken: preview.previewToken, requestHash: preview.requestHash } }, summary: 'Repartir confirma los destinos de la sobra de este libro.' });
      await postKnown(slot, key, bookUrl(bookId, 'distributions-commits'), { executionKey: key, previewToken: preview.previewToken, requestHash: preview.requestHash }, etag, undefined, 'finish');
      setPreview(null);
      setAmount('');
      simple.refreshCut();
    }, setPending, setError)}>
      <h2>Repartir</h2>
      <GrantNote />
      <ErrorText error={error} />
      <Field label="Importe a repartir" hint="No puede pasar la sobra por repartir."><input inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value); setPreview(null); }} required /></Field>
      <Field label="Emergencias %" hint="Ejemplo 50. Entre los tres deben sumar 100."><input inputMode="decimal" value={emergency} onChange={event => { setEmergency(event.target.value); setPreview(null); }} required /></Field>
      <Field label="Prestar %" hint="La parte que queda para nuevos préstamos."><input inputMode="decimal" value={lend} onChange={event => { setLend(event.target.value); setPreview(null); }} required /></Field>
      <Field label="Libre %" hint="La parte que no se aparta ni se presta."><input inputMode="decimal" value={free} onChange={event => { setFree(event.target.value); setPreview(null); }} required /></Field>
      {fractions[0] && fractions[0] !== '0.000000' ? (
        <Field label="Apartado de emergencias" hint="Solo para esa parte. No se usa el mismo apartado para otra deuda.">
          <select value={fundId} onChange={event => { setFundId(event.target.value); setPreview(null); }} required>
            <option value="">Selecciona</option>
            {funds.map(fund => <option key={fund.id} value={fund.id}>{fund.label ?? fund.id.slice(0, 8)}</option>)}
          </select>
        </Field>
      ) : null}
      <p>Porcentajes escritos: emergencias {emergency || 'sin dato'} %, prestar {lend || 'sin dato'} %, libre {free || 'sin dato'} %.</p>
      <p>Fracciones: {chosen.map(entry => `${entry[0]} ${entry[1]}`).join(', ') || 'ninguna'}.</p>
      <p>{gap === 0n ? 'Los porcentajes suman 100 %.' : 'Todavía no suman 100 %. No se envía el reparto.'} El residuo de dinero lo informa la vista previa; no se calcula el centavo aquí.</p>
      {preview ? <PreviewBox preview={preview} /> : null}
      {preview && Date.parse(preview.expiresAt) <= Date.now() ? <button type="button" disabled={pending} onClick={() => setPreview(null)}>Pedir otra vista previa con la misma clave</button> : null}
      <button type="submit" disabled={pending || gap !== 0n}>{preview ? 'Confirmar reparto' : 'Ver importes del reparto'}</button>
    </form>
  );
}
