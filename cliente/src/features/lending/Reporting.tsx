import { useEffect, useRef, useState } from 'react';
import { call } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { ApiError, inOrganization, messageFor } from '../../shared/contracts';
import { formatCop, todayBogota } from '../../shared/money';
import { Alert, Empty, ErrorText, Field, Submit, onSubmit } from '../../shared/ui';

const DRAFT_KEY = 'caudelyx.s08.reporting.draft';
const ALLOWED = new Set(['T', 'C', 'O', 'P']);
const REPORTS: [string, string][] = [
  ['PORTFOLIO', 'Cartera'],
  ['INSTALLMENTS', 'Cuotas'],
  ['MOVEMENTS', 'Movimientos'],
  ['CASH', 'Caja y custodia'],
  ['RECONCILIATION', 'Conciliación bancaria'],
  ['COLLECTORS', 'Gestiones'],
  ['CONCENTRATION', 'Concentración'],
];
const LABELS: Record<string, string> = {
  PRINCIPAL_DISBURSED: 'Principal desembolsado',
  PRINCIPAL_OUTSTANDING: 'Principal vivo',
  PRINCIPAL_LEDGER: 'Principal del libro',
  PRINCIPAL_DUE_TODAY_OR_EARLIER: 'Principal exigible',
  PRINCIPAL_OVERDUE: 'Principal vencido',
  INTEREST_OVERDUE: 'Interés vencido',
  PRINCIPAL_EXPOSED_OVERDUE: 'Principal expuesto',
  PAR30: 'Cartera en mora de más de 30 días',
  INTEREST_EXPECTED_FUTURE: 'Interés esperado',
  INTEREST_DUE_UNACCRUED: 'Interés exigible sin devengar',
  INTEREST_ACCRUED: 'Interés devengado',
  INTEREST_RECEIVABLE: 'Interés por cobrar',
  INTEREST_RECEIVED: 'Interés cobrado',
  INTEREST_SATISFIED_BY_CREDIT: 'Interés cubierto con crédito',
  PRINCIPAL_RECOVERED: 'Principal recuperado',
  RECEIPTS_CONFIRMED: 'Recaudos confirmados',
  RECEIPTS_REGISTERED: 'Recaudos registrados',
  BORROWER_CREDIT: 'Crédito del prestatario',
  HELD_FUNDS: 'Fondos retenidos',
  LIQUIDITY_BOOK: 'Caja y banco del libro',
  LIQUIDITY_RESERVED: 'Liquidez reservada',
  LIQUIDITY_AVAILABLE: 'Liquidez libre',
  CUSTODY_PROVISIONAL: 'Custodia provisional',
  CUSTODY_CONFIRMED: 'Custodia confirmada',
  CUSTODY_COMMITTED: 'Custodia comprometida',
  DELIVERED_NET: 'Entregas netas',
  BORROWER_CONCENTRATION: 'Concentración por prestatario',
  INSTALLMENT_FULFILMENT: 'Cumplimiento de cuotas',
  RETURN_ON_AVERAGE_CAPITAL: 'Retorno sobre capital promedio',
  OBLIGATIONS_COVERAGE: 'Cobertura de obligaciones',
  INTEGRAL_NET_WORTH: 'Patrimonio integral',
};
const KINDS: Record<string, string> = { STOCK: 'Existencia al corte', FLOW: 'Movimiento del período', RATIO: 'Relación' };
const SCOPES: Record<string, string> = {
  BUSINESS: 'Organización',
  ASSIGNED_PORTFOLIO: 'Cartera asignada',
  OWN_ACTIVITY: 'Actividad propia',
  AUTHORIZED_PAYMENTS: 'Pagos autorizados',
};
const REASONS: Record<string, string> = {
  OPENING_WITHOUT_SCHEDULE: 'Hay principal de apertura sin calendario verificable.',
  UNALLOCATED_PRINCIPAL: 'Hay principal contable sin préstamo atribuible.',
  NO_DENOMINATOR: 'No hay una base para la relación.',
  MISSING_COST_AND_AVERAGE_CAPITAL_POLICY: 'Falta la política de costo y capital promedio.',
  MISSING_OBLIGATIONS_S09: 'Las obligaciones de ese informe aún no existen.',
  MISSING_COMPONENTS_S09_S10: 'Faltan componentes que este informe no inventa.',
  RECONCILIATION_HISTORY_UNAVAILABLE: 'El estado bancario de ese corte no se reconstruye.',
  PHYSICAL_HISTORY_UNAVAILABLE: 'La custodia física de ese corte no se reconstruye.',
  RESERVE_HISTORY_UNAVAILABLE: 'Las reservas de ese corte no se reconstruyen.',
  HISTORY_UNAVAILABLE: 'Falta historia verificable para ese corte.',
};
const COVERAGE: Record<string, string> = { COMPLETE: 'Cobertura completa', INCOMPLETE: 'Cobertura incompleta' };

interface Coverage { status: string; populationCount: number | null; unclassifiablePrincipal: string | null; reasons: string[] }
interface Meta { currency: string; timezone: string; asOf: string; recordedThrough: string; from: string; to: string; capturedAt: string; expiresAt: string; snapshotToken: string; scopeKind: string; coverage: Coverage }
interface Indicator { id: string; kind: string; unit: string; status: string; value: string | null; gross: string | null; compensations: string | null; net: string | null; reasons: string[] }
interface Dashboard { meta: Meta; organizationMetrics?: Indicator[]; assignedMetrics?: Indicator[]; ownActivityMetrics?: Indicator[] }
interface Policy { indicatorIds: string[]; reportKinds: string[]; realUseAllowed: boolean }
interface Row { id: string; rowKind?: string; nature?: string; sign?: number; originalId?: string; interest?: string | null; credit?: string | null; principalPaid?: string | null; interestPaid?: string | null; duePrincipal?: string | null; overduePrincipal?: string | null; overdueInterest?: string | null; exposedPrincipal?: string | null; dpd?: number | null; scheduleVersion?: number | null; accountKind?: string; physicalStatus?: string; bookBalance?: string | null; reserved?: string | null; available?: string | null; provisional?: string | null; confirmed?: string | null | Indicator; committed?: string | null; held?: string | null; physical?: Record<string, string | null>; registered?: Indicator; actionsCount?: number; openJourneys?: number; pendingDeliveries?: number; coverage?: Coverage; numerator?: string | null; denominator?: string | null; borrower?: { code?: string; name?: string }; loanId?: string; reference?: string; state?: string; principal?: string | null; amount?: string | null; effectiveDate?: string | null; dueDate?: string; number?: number; percent?: string | null; group?: string }
interface Page { reportKind: string; filterScope: string; totalRows: number; items: Row[]; nextCursor: string | null; meta: Meta }
interface LoanDetail { meta: Meta; position: Row; indicators: Indicator[] }

function monthStart(day: string): string {
  return `${day.slice(0, 8)}01`;
}

function figure(item: Indicator): string {
  if (item.status === 'UNAVAILABLE') return 'No disponible';
  if (item.status === 'NO_DENOMINATOR') return 'Sin denominador';
  if (item.status !== 'COMPLETE' || item.value === null) return 'No computable';
  const shown = formatCop(item.value);
  if (!shown) return 'Cifra no reconocida';
  return item.unit === 'PERCENT' ? `${shown} %` : `${shown} COP`;
}

function cash(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'No computable';
  const shown = formatCop(value);
  return shown ? `${shown} COP` : 'Cifra no reconocida';
}

function reasonText(codes: string[]): string {
  if (codes.length === 0) return '';
  return codes.map(code => REASONS[code] ?? 'El servidor señaló un motivo que esta pantalla no reconoce.').join(' ');
}

function MetricCard({ item }: { item: Indicator }) {
  const known = Object.hasOwn(LABELS, item.id);
  const text = figure(item);
  const bar = item.kind === 'RATIO' && item.status === 'COMPLETE' && item.value !== null && formatCop(item.value);
  return (
    <article className="metric-card">
      <h3>{known ? LABELS[item.id] : 'Indicador no reconocido'}</h3>
      <p className="metric-kind">{KINDS[item.kind] ?? 'Clase no reconocida'}</p>
      <p className="metric-value">{known ? text : 'No se usa para decidir.'}</p>
      {bar ? <div className="metric-bar" role="img" aria-label={`${LABELS[item.id]} ${text}`}><span style={{ width: `${item.value}%` }} /></div> : null}
      {item.kind === 'FLOW' && item.status === 'COMPLETE' ? <p>Bruto {cash(item.gross)}. Compensaciones {cash(item.compensations)}. Neto del servidor {cash(item.net)}.</p> : null}
      {item.reasons.length > 0 ? <p>{reasonText(item.reasons)}</p> : null}
    </article>
  );
}

function MetricGroup({ title, items }: { title: string; items: Indicator[] }) {
  return (
    <section className="metric-group" aria-label={title}>
      <h2>{title}</h2>
      {items.length === 0 ? <Empty>El servidor no devolvió indicadores en este grupo.</Empty> : <div className="metric-grid">{items.map(item => <MetricCard key={item.id} item={item} />)}</div>}
    </section>
  );
}

const STATES: Record<string, string> = { ACTIVE: 'Activo', SETTLED: 'Liquidado', UNCLASSIFIABLE: 'Sin clasificación', UNPAID: 'Sin pagar', PARTIAL: 'Pago parcial', PAID: 'Pagado', CONFIRMED: 'Confirmado', REVERSED: 'Compensado', PENDING: 'Pendiente', REJECTED: 'Rechazado', CANCELLED: 'Cancelado', DISCREPANCY: 'Con diferencia', INVESTIGATION: 'En investigación', RECONCILED: 'Conciliado' };
const NATURES: Record<string, string> = { DISBURSE: 'Desembolso', ACCRUE: 'Devengo', RECEIPT: 'Cobro', CREDIT_APPLY: 'Aplicación de crédito', COMPENSATION: 'Compensación', REGISTERED_PAYMENT: 'Pago registrado', CASH_DELIVERY: 'Entrega de efectivo', CASH_DELIVERY_COMPENSATION: 'Compensación de entrega' };
function RowFigures({ item, kind }: { item: Row; kind: string }) {
  const fields: [string, string | null | undefined][] = kind === 'CASH'
    ? [['Saldo contable', item.bookBalance], ['Reservado', item.reserved], ['Disponible', item.available], ['Provisional', item.provisional], ['Custodia confirmada', typeof item.confirmed === 'string' || item.confirmed === null ? item.confirmed : undefined], ['Comprometido', item.committed], ['Retenido', item.held]]
    : kind === 'INSTALLMENTS' ? [['Principal de cuota', item.principal], ['Interés de cuota', item.interest], ['Principal pagado', item.principalPaid], ['Interés pagado', item.interestPaid]]
    : kind === 'MOVEMENTS' ? [['Importe del movimiento', item.amount], [item.nature === 'DISBURSE' ? 'Principal desembolsado' : 'Principal aplicado', item.principal], [item.nature === 'ACCRUE' ? 'Interés devengado' : 'Interés aplicado', item.interest], ['Crédito', item.credit]]
    : kind === 'PORTFOLIO' ? [['Principal vivo', item.principal], ['Principal exigible', item.duePrincipal], ['Principal vencido', item.overduePrincipal], ['Interés vencido', item.overdueInterest], ['Principal expuesto', item.exposedPrincipal]]
    : kind === 'CONCENTRATION' ? [['Principal', item.principal], ['Numerador', item.numerator], ['Denominador del ámbito', item.denominator]] : [['Importe', item.amount]];
  return <>
    {kind === 'COLLECTORS' ? <><p>Gestiones: {item.actionsCount ?? 'No disponible'}. Jornadas abiertas: {item.openJourneys ?? 'No disponible'}. Entregas pendientes: {item.pendingDeliveries ?? 'No disponible'}.</p>{item.registered ? <p>Registrado: {figure(item.registered)}</p> : null}{typeof item.confirmed === 'object' && item.confirmed ? <p>Confirmado neto: {figure(item.confirmed)}. Bruto {cash(item.confirmed.gross)}. Compensaciones {cash(item.confirmed.compensations)}.</p> : null}</> : <dl>{fields.filter(([, value]) => value !== undefined).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{cash(value)}</dd></div>)}</dl>}
    {kind === 'CASH' ? <><p>{item.accountKind === 'BANK' ? 'Banco. No representa efectivo físico.' : item.physicalStatus === 'AVAILABLE' ? 'Efectivo físico con responsable verificable.' : 'Efectivo físico no disponible.'}</p>{item.physical && item.physicalStatus === 'AVAILABLE' ? <dl>{Object.entries(item.physical).map(([key, value]) => <div key={key}><dt>{({ confirmedOnSite: 'Confirmado en sitio', provisionalOnSite: 'Provisional en sitio', returnRequiredOnSite: 'Pendiente de devolver en sitio', heldOnSite: 'Fondos retenidos en sitio', receivedUnposted: 'Recibido sin contabilizar', inTransit: 'En tránsito', unlocatedDisputed: 'Faltante en disputa', unidentifiedSurplus: 'Sobrante sin identificar' } as Record<string, string>)[key] ?? 'Componente físico del servidor'}</dt><dd>{cash(value)}</dd></div>)}</dl> : null}</> : null}
    {kind === 'MOVEMENTS' ? <p>{NATURES[item.nature ?? ''] ?? 'Movimiento del servidor'}. {item.sign === -1 ? 'Compensación: resta del bruto.' : 'Hecho original.'} {item.originalId ? 'Con vínculo al hecho original.' : ''}</p> : null}
    {kind === 'CONCENTRATION' ? <p>Participación: {item.percent == null ? 'No computable' : `${formatCop(item.percent)} %`}.</p> : null}
    {item.scheduleVersion != null ? <p>Versión de calendario: {item.scheduleVersion}.</p> : null}
    {item.dpd !== undefined ? <p>Días de mora: {item.dpd === null ? 'No computable' : item.dpd}.</p> : null}
    {item.coverage && item.coverage.status !== 'COMPLETE' ? <p>{COVERAGE[item.coverage.status] ?? 'Cobertura no disponible'}. {reasonText(item.coverage.reasons)}</p> : null}
  </>;
}

export function ReportingScreen() {
  const { me, phase } = useAuth();
  useEffect(() => { if (phase === 'anonymous') sessionStorage.removeItem(DRAFT_KEY); }, [phase]);
  const ready = phase === 'ready' && inOrganization(me);
  const roles = me?.roleIds ?? [];
  const allowed = roles.some(role => ALLOWED.has(role));
  if (!ready || !me?.organizationId || !me.userId) return <section className="panel desk"><h1>Informes</h1><Empty>Entra a una organización para consultar. Esta pantalla no cobra ni devenga.</Empty></section>;
  if (!allowed) return <section className="panel desk"><h1>Informes</h1><Alert tone="info">Este informe no está en tu rol. No se consultan cifras.</Alert></section>;
  return <ReportingWorkspace key={`${me.userId}|${me.organizationId}|${[...roles].sort().join(',')}`} />;
}

function ReportingWorkspace() {
  const { me } = useAuth();
  const organizationId = me?.organizationId ?? '';
  const owner = `${me?.userId ?? ''}|${organizationId}|${[...(me?.roleIds ?? [])].sort().join(',')}`;
  const base = `/organizations/${organizationId}/reporting`;
  const today = todayBogota();
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [asOf, setAsOf] = useState(today);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [report, setReport] = useState('PORTFOLIO');
  const [page, setPage] = useState<Page | null>(null);
  const [loan, setLoan] = useState<LoanDetail | null>(null);
  const [ageBand, setAgeBand] = useState('ALL');
  const [listLoanId, setListLoanId] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ticket = useRef(0);

  useEffect(() => {
    const saved = sessionStorage.getItem(DRAFT_KEY);
    if (!saved) return;
    try {
      const draft = JSON.parse(saved) as { owner?: string; from?: string; to?: string; asOf?: string; report?: string };
      if (draft.owner !== owner) { sessionStorage.removeItem(DRAFT_KEY); return; }
      if (draft.from) setFrom(draft.from);
      if (draft.to) setTo(draft.to);
      if (draft.asOf) setAsOf(draft.asOf);
      if (draft.report) setReport(draft.report);
    } catch { sessionStorage.removeItem(DRAFT_KEY); }
  }, [owner]);

  useEffect(() => {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ owner, from, to, asOf, report }));
  }, [owner, from, to, asOf, report]);

  useEffect(() => {
    let live = true;
    void call<Policy>('GET', `${base}/policy`).then(result => {
      if (!live) return;
      setPolicy(result.data);
      setReport(current => result.data.reportKinds.includes(current) ? current : result.data.reportKinds[0] ?? '');
    }).catch(caught => { if (live) { setPolicy(null); setError(caught); } });
    return () => { live = false; };
  }, [base]);

  function dropStale() {
    ticket.current += 1;
    setDashboard(null);
    setPage(null);
    setLoan(null);
    setListLoanId(undefined);
  }

  async function consult() {
    dropStale();
    const current = ++ticket.current;
    setError(null);
    const query = new URLSearchParams({ from, to, asOf });
    try {
      const result = await call<Dashboard>('GET', `${base}/dashboard?${query}`);
      if (current !== ticket.current) return;
      setDashboard(result.data);
      setPage(null);
      setLoan(null);
    } catch (caught) {
      if (current !== ticket.current) return;
      setDashboard(null);
      setPage(null);
      setLoan(null);
      setError(caught);
    }
  }

  async function loadReport(kind: string, cursor: string | null, loanId?: string) {
    if (!dashboard) return;
    const current = ++ticket.current;
    setError(null);
    const query = new URLSearchParams({ snapshotToken: dashboard.meta.snapshotToken, limit: '20' });
    if (cursor) query.set('cursor', cursor);
    if (loanId) query.set('loanId', loanId);
    if ((kind === 'PORTFOLIO' || kind === 'INSTALLMENTS') && ageBand !== 'ALL') query.set('ageBand', ageBand);
    try {
      const result = await call<Page>('GET', `${base}/reports/${kind}?${query}`);
      if (current !== ticket.current) return;
      if (result.data.meta.snapshotToken !== dashboard.meta.snapshotToken) {
        dropStale();
        setError(new ApiError(409, 'REPORT_SNAPSHOT_STALE', null, messageFor('REPORT_SNAPSHOT_STALE', 409)));
        return;
      }
      setPage(result.data);
      setListLoanId(loanId);
    } catch (caught) {
      if (current !== ticket.current) return;
      dropStale();
      setError(caught);
    }
  }

  async function openLoan(loanId: string) {
    if (!dashboard) return;
    const current = ++ticket.current;
    setError(null);
    try {
      const result = await call<LoanDetail>('GET', `${base}/loans/${loanId}?snapshotToken=${encodeURIComponent(dashboard.meta.snapshotToken)}`);
      if (current !== ticket.current) return;
      if (result.data.meta.snapshotToken !== dashboard.meta.snapshotToken) {
        dropStale();
        setError(new ApiError(409, 'REPORT_SNAPSHOT_STALE', null, messageFor('REPORT_SNAPSHOT_STALE', 409)));
        return;
      }
      setLoan(result.data);
    } catch (caught) {
      if (current !== ticket.current) return;
      dropStale();
      setError(caught);
    }
  }

  const meta = dashboard?.meta;
  const kinds = policy?.reportKinds ?? [];
  const coverage = meta ? COVERAGE[meta.coverage.status] ?? 'Cobertura no reconocida' : '';

  return (
    <section className="panel desk" aria-labelledby="reports-title">
      <header className="report-head">
        <h1 id="reports-title">Informes</h1>
        <p>Consulta del corte que devuelve el servidor. No cobra, no devenga y no exporta.</p>
      </header>
      <ErrorText error={error} />
      {policy && policy.realUseAllowed ? <Alert tone="error">La política no corresponde al uso local. No se muestran cifras.</Alert> : null}
      <form onSubmit={onSubmit(consult, setPending, setError)}>
        <Field label="Desde"><input type="date" value={from} onChange={event => { dropStale(); setFrom(event.target.value); }} /></Field>
        <Field label="Hasta"><input type="date" value={to} onChange={event => { dropStale(); setTo(event.target.value); }} /></Field>
        <Field label="Corte"><input type="date" value={asOf} onChange={event => { dropStale(); setAsOf(event.target.value); }} /></Field>
        <Submit pending={pending}>Consultar el tablero</Submit>
      </form>
      {meta && !policy?.realUseAllowed ? (
        <section className="report-cut" aria-label="Corte consultado">
          <p>Período {meta.from} a {meta.to}. Corte {meta.asOf}. Conocimiento {new Date(meta.recordedThrough).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}.</p>
          <p>{SCOPES[meta.scopeKind] ?? 'Ámbito no reconocido'}. {coverage}. {meta.coverage.populationCount === null ? 'La población no está completa.' : `${meta.coverage.populationCount} registros del ámbito.`} {meta.coverage.unclassifiablePrincipal ? `Principal sin clasificar ${cash(meta.coverage.unclassifiablePrincipal)}.` : ''}</p>
          {meta.coverage.reasons.length > 0 ? <p>{reasonText(meta.coverage.reasons)}</p> : null}
          <p>Moneda {meta.currency}. Zona {meta.timezone}. El corte vence {new Date(meta.expiresAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}.</p>
        </section>
      ) : null}
      {dashboard && !policy?.realUseAllowed ? (
        <div className="metric-board">
          {dashboard.organizationMetrics ? <MetricGroup title="Organización" items={dashboard.organizationMetrics} /> : null}
          {dashboard.assignedMetrics ? <MetricGroup title="Cartera asignada" items={dashboard.assignedMetrics} /> : null}
          {dashboard.ownActivityMetrics ? <MetricGroup title="Actividad y custodia propias" items={dashboard.ownActivityMetrics} /> : null}
        </div>
      ) : null}
      {dashboard && kinds.length > 0 && !policy?.realUseAllowed ? (
        <div className="report-layout">
          <section aria-label="Reporte">
            <form onSubmit={onSubmit(() => loadReport(report, null), setPending, setError)}>
              <Field label="Reporte">
                <select value={report} onChange={event => { ticket.current += 1; setReport(event.target.value); setPage(null); setLoan(null); setListLoanId(undefined); }}>
                  {REPORTS.filter(([kind]) => kinds.includes(kind)).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
                </select>
              </Field>
              {report === 'PORTFOLIO' || report === 'INSTALLMENTS' ? (
                <Field label="Antigüedad">
                  <select value={ageBand} onChange={event => { ticket.current += 1; setAgeBand(event.target.value); setPage(null); setLoan(null); setListLoanId(undefined); }}>
                    <option value="ALL">Todas</option>
                    <option value="DUE_TODAY">Vence en el corte</option>
                    <option value="D01_30">1 a 30 días</option>
                    <option value="D31_60">31 a 60 días</option>
                    <option value="D61_90">61 a 90 días</option>
                    <option value="D91_PLUS">Más de 90 días</option>
                  </select>
                </Field>
              ) : null}
              <Submit pending={pending}>Ver el reporte</Submit>
            </form>
            {page ? (
              <>
                <p>{listLoanId ? 'Solo el préstamo seleccionado. ' : 'Ámbito autorizado completo para este reporte. '}{page.totalRows} filas con el criterio de este reporte. {page.totalRows === 0 ? 'No hay filas. No se muestra cero en una cifra que el servidor no envió.' : ''}</p>
                <div className="schedule">
                  <table>
                    <caption>{REPORTS.find(([kind]) => kind === page.reportKind)?.[1] ?? 'Reporte'}</caption>
                    <thead><tr><th scope="col">Persona o referencia</th><th scope="col">Fecha</th><th scope="col">Cifras del servidor</th><th scope="col">Detalle</th></tr></thead>
                    <tbody>
                      {page.items.map(item => {
                        const person = item.borrower?.code ? `${item.borrower.code} ${item.borrower?.name ?? ''}`.trim() : item.group === 'OTHER' ? 'Resto del ámbito' : item.group === 'UNATTRIBUTABLE' ? 'Sin atribuir' : item.reference && !/^[a-f0-9-]{36}$/i.test(item.reference) ? item.reference : item.rowKind === 'CASH' ? 'Cuenta del ámbito autorizado' : item.rowKind === 'COLLECTORS' ? 'Responsable del ámbito autorizado' : 'Hecho del ámbito autorizado';
                        return (
                          <tr key={item.id}>
                            <td>{person}</td>
                            <td>{item.effectiveDate ?? item.dueDate ?? 'Stock al corte'}</td>
                            <td><RowFigures item={item} kind={page.reportKind} /></td>
                            <td>{item.loanId ? <button type="button" onClick={() => void openLoan(item.loanId!).catch(setError)}>Ver {item.borrower?.code ?? 'el préstamo'}</button> : STATES[item.state ?? ''] ?? (item.state ? 'Estado no reconocido' : '')}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {page.nextCursor ? <button type="button" disabled={pending} onClick={() => void loadReport(report, page.nextCursor, listLoanId).catch(setError)}>Siguiente página</button> : null}
              </>
            ) : null}
          </section>
          <section aria-label="Detalle del préstamo">
            <h2>Detalle</h2>
            {loan ? (
              <>
                <p>{loan.position.borrower?.code} {loan.position.borrower?.name}. Mismo corte {loan.meta.asOf}.</p>
                <div className="metric-grid">{loan.indicators.map(item => <MetricCard key={item.id} item={item} />)}</div>
                <button type="button" onClick={() => { setReport('INSTALLMENTS'); setPage(null); void loadReport('INSTALLMENTS', null, loan.position.loanId).catch(setError); }}>Ver cuotas de este préstamo</button>
                <button type="button" onClick={() => { setReport('MOVEMENTS'); setPage(null); void loadReport('MOVEMENTS', null, loan.position.loanId).catch(setError); }}>Ver movimientos de este préstamo</button>
              </>
            ) : <Empty>Elige un préstamo del reporte. El detalle usa el mismo corte.</Empty>}
          </section>
        </div>
      ) : null}
    </section>
  );
}
