import { useEffect, useState } from 'react';
import { DiscardedRequest } from '../../shared/contracts';
import { ErrorText, Empty } from '../../shared/ui';
import { useSimple } from './context';
import { metricText, presentedDifference } from './model';
import type { SavingsPlan } from './types';
import { ScopeBar } from './Month';
import { bookUrl, concealed, cutQuery, msGet } from './transport';
import { Money } from './widgets';

export function SavingsScreen() {
  const simple = useSimple();
  const [cursor,setCursor]=useState<string|null>(null);
  useEffect(()=>setCursor(null),[simple.bookId,simple.scope,simple.month,simple.effectiveDate,simple.knownAt]);
  const [plan, setPlan] = useState<SavingsPlan | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!simple.bookId || simple.scope === 'CONSOLIDATED') { setPlan(null); return; }
    const ac = new AbortController();
    let live = true;
    setLoading(true);
    void msGet<SavingsPlan>(bookUrl(simple.bookId, 'savings-plan', cutQuery({ month: simple.month, effectiveDate: simple.effectiveDate, knownAt: simple.knownAt },cursor)), ac.signal).then(result => {
      if (live) setPlan(result.data);
    }).catch(caught => {
      if (!live || caught instanceof DiscardedRequest) return;
      setPlan(null);
      setError(concealed(caught));
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; ac.abort(); };
  }, [simple.bookId, simple.scope, simple.month, simple.effectiveDate, simple.knownAt,cursor]);
  return (
    <section className="simple-wrap" data-screen="ahorro">
      <h1 id="page-title" tabIndex={-1}>¿Cuánto aparto para llegar a cada cuota?</h1>
      <ScopeBar />
      {loading ? <p role="status">Consultando el plan…</p> : null}
      <ErrorText error={error} />
      <p>Hipótesis explícita: los próximos 12 meses, las fechas de oportunidad y el faltante salen del servidor. Un ingreso futuro no cubre un vencimiento anterior. Un apartado no se usa para dos deudas. Una sugerencia no es dinero apartado.</p>
      <p>Apartar se confirma en <a href="#/modo-simple/caja">Caja y apartados</a>. Esta pantalla no mueve dinero.</p>
      {simple.scope === 'CONSOLIDATED' ? <p>El plan se consulta por libro, no en el consolidado.</p> : null}
      {plan ? (
        <>
          <p>Inicio {plan.startMonth}. Horizonte {plan.horizonMonths} meses. Faltante del filtro {metricText(plan.totalShortfall)}. {plan.nextCursor ? `Esta página muestra ${plan.rows.length} de ${plan.totalCount}.` : `Filtro completo, ${plan.totalCount} cuotas.`}</p>
          <div className="simple-table-wrap">
            <table className="simple-table">
              <caption>Cuotas, apartado exclusivo y faltante. El total de faltante es el del filtro, no la suma de una página incompleta.</caption>
              <thead><tr><th>Vence</th><th>Cuota</th><th>Apartado exclusivo</th><th>Faltante</th><th>Diferencia</th><th>Cobertura</th></tr></thead>
              <tbody>
                {plan.rows.map(row => (
                  <tr key={`${row.liabilityId}:${row.installmentId ?? row.dueDate ?? 'sin-fecha'}`}>
                    <td>{row.dueDate ?? 'Sin fecha'}</td>
                    <td className="num"><Money metric={row.quotaTotal} /></td>
                    <td className="num"><Money metric={row.reservedExclusive} /></td>
                    <td className={`num ${row.shortfall.status === 'COMPLETE' && row.shortfall.value && row.shortfall.value !== '0.00' ? 'simple-pending' : ''}`}><Money metric={row.shortfall} /></td>
                    <td className="num">{presentedDifference(row.quotaTotal, row.reservedExclusive)}</td>
                    <td>{row.officialPaymentCoverage === 'COMPLETE' ? 'Cobertura completa' : row.officialPaymentCoverage === 'INCOMPLETE' ? 'Cobertura incompleta. Seguro o tasa desconocidos no son cero.' : 'Cobertura no disponible'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.rows.length === 0 ? <Empty>No hay cuotas en este horizonte.</Empty> : null}
          <ul aria-label="Sugerencias">
            {plan.rows.flatMap(row => row.recommendations.map((item, index) => (
              <li key={`${row.liabilityId}-${index}`}>Sugerencia para {row.dueDate ?? 'una cuota sin fecha'}: {metricText(item)}. No está ejecutada. Oportunidades: {row.opportunityDates.join(', ') || 'sin fechas'}.</li>
            )))}
          </ul>
          {plan.nextCursor?<button type="button" onClick={()=>setCursor(plan.nextCursor)}>Página siguiente del plan</button>:null}{cursor?<button type="button" onClick={()=>setCursor(null)}>Primera página del plan</button>:null}
        </>
      ) : null}
    </section>
  );
}
