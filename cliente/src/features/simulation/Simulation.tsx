import { useEffect, useMemo, useRef, useState } from 'react';
import { call } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { ApiError, DiscardedRequest, type Me } from '../../shared/contracts';
import { todayBogota } from '../../shared/money';
import { Alert, ErrorText, Field, Panel, onSubmit } from '../../shared/ui';
import { ALERT_CLASS_LABEL, ALTERNATIVE_LABEL, KIND_LABEL, METRIC_LABEL, POSITION_LABEL, showMetric } from './copy';
import { buildVersion, sameComparison, versionProblem, type VersionInput } from './model';
import { claimKey, clearSimulationMemory, isUncertain, markUncertain, releaseHeld } from './memory';
import { KINDS, emptyHypothesis, type AlertItem, type BaseRecord, type Comparison, type HypothesisDraft, type Outcome, type Policy, type ResultsPage, type RunRecord, type ScenarioKind, type ScopeKind, type StoredRun } from './types';
import {AlternativeFields,initialAlternatives} from './AlternativeFields';

function rootOf(scope: ScopeKind, organizationId: string | undefined, bookId: string | null): string | null {
  if (scope === 'BUSINESS' && organizationId) return `/organizations/${organizationId}/simulation-s12`;
  if (scope === 'PERSONAL' && bookId) return `/me/personal/books/${bookId}/simulation-s12`;
  if (scope === 'CONSOLIDATED' && bookId) return `/me/personal/books/${bookId}/simulation-s12/consolidated`;
  return null;
}

function outcomeText(outcome: Outcome): string {
  const deficit = outcome.firstDeficitDate ?? 'el servidor no señaló un primer déficit';
  const state:Record<string,string>={COMPLETE:'completa',INCOMPLETE:'incompleta',UNAVAILABLE:'no disponible',NOT_APPLICABLE:'no corresponde',SIMULABLE:'Simulable',PARTIALLY_SIMULABLE:'Parcialmente simulable',NOT_SIMULABLE:'No simulable'};
  return `${KIND_LABEL[outcome.scenarioKind] ?? outcome.scenarioKind}, ${ALTERNATIVE_LABEL[outcome.alternativeKind] ?? outcome.alternativeKind}. Cobertura ${state[outcome.coverage]??outcome.coverage}. ${state[outcome.simulability]??outcome.simulability}. Primer déficit: ${deficit}. ${outcome.reasons.join(', ')}`;
}

export function SimulationScreen() {
  const { me, phase } = useAuth();
  if (phase !== 'ready' || !me) return <p role="status">Cargando la sesión…</p>;
  if (me.roleIds?.includes('SA')) {
    return (
      <Panel title="Simulación" id="page-title">
        <Alert tone="info">Esta superficie no está disponible para administración de plataforma. No se consultan libros personales ni alertas de otro titular.</Alert>
      </Panel>
    );
  }
  const identity = `${me.userId ?? ''}|${me.organizationId ?? ''}|${[...(me.roleIds ?? [])].sort().join(',')}`;
  return <Wizard key={identity} me={me} />;
}

function Wizard({ me }: { me: Me }) {
  const [scope, setScope] = useState<ScopeKind>(me.organizationId ? 'BUSINESS' : 'PERSONAL');
  const [bookId, setBookId] = useState<string | null>(null);
  const [personalState, setPersonalState] = useState<'unknown' | 'open' | 'absent'>('unknown');
  const [consolidated, setConsolidated] = useState(false);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [base, setBase] = useState<BaseRecord | null>(null);
  const [name, setName] = useState('');
  const [horizonDays, setHorizonDays] = useState('');
  const [budget, setBudget] = useState('');
  const [hypotheses, setHypotheses] = useState<Record<ScenarioKind, HypothesisDraft>>({ PRUDENT: emptyHypothesis(), BASE: emptyHypothesis(), FAVORABLE: emptyHypothesis() });
  const [alternatives,setAlternatives]=useState(initialAlternatives);
  const [scenario, setScenario] = useState<{ id: string; etag: string; baseId: string } | null>(null);
  const [runs, setRuns] = useState<StoredRun[]>([]);
  const [selectedOutcome, setSelectedOutcome] = useState('');
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [pending, setPending] = useState(false);
  const [job,setJob]=useState<string|null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const eventIds = useRef<Record<string, string>>({});
  const root = rootOf(scope, me.organizationId, bookId);
  const epoch=useRef(0);
  function clearPrivate(){setBase(null);setScenario(null);setRuns([]);setComparison(null);setAlerts([]);setSelectedOutcome('');setJob(null);setName('');setBudget('');setHorizonDays('');setHypotheses({PRUDENT:emptyHypothesis(),BASE:emptyHypothesis(),FAVORABLE:emptyHypothesis()});setAlternatives(initialAlternatives());setNotice(null);clearSimulationMemory();eventIds.current={};}
  function changeScope(next:ScopeKind){epoch.current++;clearPrivate();setPending(false);setError(null);setScope(next);}
  const renderEpoch=epoch.current;
  const guardedPending=(value:boolean)=>{if(epoch.current===renderEpoch)setPending(value);};
  const fence = useMemo(() => ({ active: true }), []);
  useEffect(() => { fence.active = true; return () => { fence.active = false; }; }, [fence]);

  async function request<T>(method: string, path: string, body?: unknown, extra?: { ifMatch?: string; idempotencyKey?: string }): Promise<{ data: T; etag: string | null }> {
    if (!fence.active||epoch.current!==renderEpoch) throw new DiscardedRequest();
    const started=epoch.current;
    try{const result = await call<T>(method, path, body, extra);
     if (!fence.active||started!==epoch.current) throw new DiscardedRequest();
     return result;
    }catch(caught){if(!fence.active||started!==epoch.current)throw new DiscardedRequest();if(caught instanceof ApiError&&[401,403].includes(caught.status)&&root&&path.startsWith(root)&&(scope==='CONSOLIDATED'||!path.includes('/consolidated/'))){epoch.current++;clearPrivate();setPolicy(null);setPending(false);}throw caught;}
  }

  function failed(caught: unknown) {
    if (!fence.active || caught instanceof DiscardedRequest) return;
    if (isUncertain(caught)) markUncertain();
    else if (!(caught instanceof ApiError) || ![409, 412, 428].includes(caught.status)) releaseHeld();
    setError(caught);
  }

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const personal = await request<{ id?: string }>('GET', '/me/personal/book');
        if (!live) return;
        setBookId(personal.data.id ?? null);
        setPersonalState(personal.data.id ? 'open' : 'absent');
      } catch {
        if (!live) return;
        setBookId(null);
        setPersonalState('absent');
      }
    })();
    return () => { live = false; };
  }, [me.userId, me.organizationId]);

  useEffect(() => {
    let live = true;
    setBase(null); setScenario(null); setRuns([]); setComparison(null); setAlerts([]); setPolicy(null); setSelectedOutcome('');
    clearSimulationMemory();
    eventIds.current = {};
    if (scope === 'CONSOLIDATED' && bookId) {
      void request<Policy>('GET', `/me/personal/books/${bookId}/simulation-s12/consolidated/policy`).then(result => {
        if (!live) return;
        setConsolidated(true);
        setPolicy(result.data);
      }).catch(caught => {
        if (!live) return;
        setConsolidated(false);
        if (!(caught instanceof ApiError) || (caught.status !== 403 && caught.status !== 404)) setError(caught);
      });
      return () => { live = false; };
    }
    if (!root) return () => { live = false; };
    void request<Policy>('GET', `${root}/policy`).then(result => { if (live) setPolicy(result.data); }).catch(caught => { if (live) setError(caught); });
    return () => { live = false; };
  }, [root, scope]);

  useEffect(() => {
    if (!bookId) return;
    let live = true;
    void request<Policy>('GET', `/me/personal/books/${bookId}/simulation-s12/consolidated/policy`).then(() => { if (live) setConsolidated(true); }).catch(() => { if (live) setConsolidated(false); });
    return () => { live = false; };
  }, [bookId]);

  function draft(): VersionInput {
    return { asOf: base?.asOf ?? todayBogota(), name, horizonDays, budget, hypotheses,alternatives, creating: !scenario || scenario.baseId !== base?.id, eventIds: eventIds.current };
  }

  function rememberEvents() {
    for (const kind of KINDS) {
      for (const side of ['out', 'in'] as const) {
        const slot = `${kind}:${side}`;
        const row = hypotheses[kind];
        const signature = side === 'out' ? `${row.capitalOutDate}|${row.capitalOutAmount}|${row.sourceReference}` : `${row.capitalInDate}|${row.capitalInAmount}|${row.sourceReference}`;
        if (eventIds.current[`${slot}:signature`] !== signature || !eventIds.current[slot]) {
          eventIds.current[slot] = crypto.randomUUID();
          eventIds.current[`${slot}:signature`] = signature;
        }
      }
    }
  }

  async function capture() {
    if (!root || !policy) throw new ApiError(403, 'ACCESS_DENIED', null, 'Este ámbito no admite capturar una base.');
    const body = { asOf: todayBogota(), currency: 'COP' as const };
    const result = await request<BaseRecord>('POST', `${root}/bases`, body, { idempotencyKey: claimKey(JSON.stringify(['base', root, body])) });
    releaseHeld();
    const previous = base;
    setBase(result.data);
    setComparison(null);
    if (previous && previous.id !== result.data.id) setNotice('La base cambió. Las corridas anteriores quedan aparte y no se mezclan.');
    else setNotice('Base capturada. Una hipótesis futura no es dinero disponible hoy.');
  }

  async function loadResults(run: RunRecord, horizon: number): Promise<StoredRun> {
    if (!root) throw new DiscardedRequest();
    const first = await request<ResultsPage>('GET', `${root}/runs/${run.id}/results?limit=100`);
    let items = first.data.items;
    let cursor = first.data.nextCursor;
    let pages = 1;
    while (cursor && pages < 44) {
      const next = await request<ResultsPage>('GET', `${root}/runs/${run.id}/results?limit=100&cursor=${encodeURIComponent(cursor)}`);
      items = items.concat(next.data.items);
      cursor = next.data.nextCursor;
      pages += 1;
    }
    return {
      id: run.id, scenarioVersion: run.scenarioVersion, baseId: run.baseId, sourceDigest: first.data.sourceDigest,
      horizonDays: horizon, freshness: first.data.freshness, outcomes: first.data.outcomes, items, totalRows: first.data.totalRows, incomplete: cursor !== null,
    };
  }

  async function calculate() {
    if (!root || !base || !policy) throw new ApiError(409, 'RUN_STATE_CONFLICT', null, 'Falta la base. No se calculó.');
    rememberEvents();
    const creating = !scenario || scenario.baseId !== base.id;
    const body = buildVersion({ ...draft(), creating, baseId: base.id, baseToken: base.baseToken, asOf: base.asOf });
    if (!body) throw new ApiError(422, 'INPUT_INVALID', null, versionProblem({ ...draft(), creating, asOf: base.asOf }) ?? 'La hipótesis no está completa.');
    let scenarioId = scenario?.id;
    let versionNumber = 1;
    if (creating) {
      const created = await request<{ id: string; currentVersion: number }>('POST', `${root}/scenarios`, { name: name.trim(), ...body }, { idempotencyKey: claimKey(JSON.stringify(['scenario', root, name.trim(), body])) });
      scenarioId = created.data.id;
      versionNumber = created.data.currentVersion;
      setScenario({ id: created.data.id, etag: created.etag ?? '', baseId: base.id });
    } else if (scenario) {
      const created = await request<{ number: number }>('POST', `${root}/scenarios/${scenario.id}/versions`, body, { idempotencyKey: claimKey(JSON.stringify(['version', scenario.id, body])), ifMatch: scenario.etag });
      versionNumber = created.data.number;
      const refreshed = await request<{ id: string }>('GET', `${root}/scenarios/${scenario.id}`);
      setScenario({ id: scenario.id, etag: refreshed.etag ?? scenario.etag, baseId: base.id });
    }
    const started = await request<RunRecord>('POST', `${root}/runs`, { scenarioId, scenarioVersion: versionNumber, baseToken: base.baseToken, mode: 'STANDARD', sensitivity: null, evaluateAlerts: false }, { idempotencyKey: claimKey(JSON.stringify(['run', scenarioId, versionNumber, base.baseToken])) });
    releaseHeld();
    let current = started.data;
    setJob(current.id);
    for (let attempt = 0; attempt < 40 && (current.state === 'QUEUED' || current.state === 'RUNNING'); attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 250));
      if (!fence.active) throw new DiscardedRequest();
      current = (await request<RunRecord>('GET', `${root}/runs/${current.id}`)).data;
    }
    setJob(null);
    if(current.state==='CANCELLED'){setNotice('Corrida cancelada. No se publicó un resultado.');return;}
    if (current.state !== 'SUCCEEDED') throw new ApiError(409, 'RUN_STATE_CONFLICT', null, `La corrida quedó en ${current.state}${current.errorCode ? `: ${current.errorCode}` : ''}. No se inventó un resultado.`);
    const stored = await loadResults(current, body.horizonDays);
    setRuns(currentRuns => [...currentRuns.filter(item => item.id !== stored.id), stored]);
    const preferred = stored.outcomes.find(item => item.scenarioKind === 'BASE' && item.alternativeKind === 'HOLD_CASH');
    setSelectedOutcome(preferred?.id ?? stored.outcomes[0]?.id ?? '');
    setComparison(null);
    setNotice(`Corrida versión ${stored.scenarioVersion} lista. Los importes salen del servidor.`);
  }

  async function refresh() {
    if (!root) return;
    const latest = runs.at(-1);
    if (!latest) return;
    const stored = await loadResults({ ...latest, scenarioId: scenario?.id ?? '', state: 'SUCCEEDED', errorCode: null, retryable: false }, latest.horizonDays);
    setRuns(current => current.map(item => item.id === stored.id ? stored : item));
    setNotice(stored.freshness === 'HISTORICAL_STALE' ? 'La base ya no es la de hoy. Estas cifras quedan como historia.' : 'Resultados actualizados.');
  }
  async function cancel(){if(!root||!job)return;const current=await request<RunRecord>('GET',`${root}/runs/${job}`);if(!current.etag)throw new ApiError(428,'ETAG_REQUIRED',null,'Falta la versión actual de la corrida.');await request('POST',`${root}/runs/${job}/cancellations`,{},{idempotencyKey:claimKey('cancel:'+job),ifMatch:current.etag});releaseHeld();setNotice('Cancelación registrada. No mueve dinero.');}

  async function compare() {
    if (!root || !base) return;
    const candidates = runs.filter(item => sameComparison(item, { baseId: base.id, sourceDigest: base.sourceDigest, horizonDays: Number(horizonDays) }));
    const chosen = candidates.slice(-2);
    if (chosen.length < 2) throw new ApiError(409, 'COMPARISON_BASE_MISMATCH', null, 'Hacen falta dos corridas de la misma base y el mismo horizonte.');
    const outcomeIds = chosen.flatMap(item => {
      return item.outcomes.filter(outcome=>outcome.scenarioKind==='BASE').map(outcome=>outcome.id);
    });
    if (outcomeIds.length < 2) throw new ApiError(409, 'COMPARISON_BASE_MISMATCH', null, 'No hay resultados comparables sobre la misma base.');
    const body = { runIds: chosen.map(item => item.id), outcomeIds };
    const result = await request<Comparison>('POST', `${root}/comparisons`, body, { idempotencyKey: claimKey(JSON.stringify(['compare', body])) });
    releaseHeld();
    setComparison(result.data);
    setNotice(result.data.winner === null ? 'El servidor no señaló una alternativa mejor.' : 'El servidor devolvió una marca que esta pantalla no convierte en una orden.');
  }

  async function evaluate() {
    if (!root || !policy) return;
    const latest = [...runs].reverse().find(item => item.baseId === base?.id);
    if (!base) throw new ApiError(409, 'RUN_STATE_CONFLICT', null, 'Captura una base para evaluar hechos.');
    const thresholds = policy.defaultAlertThresholds;
    const body = latest?{kind:'SCENARIO' as const,runId:latest.id,thresholds}:{kind:'FACT' as const,baseId:base.id,baseToken:base.baseToken,thresholds};
    await request('POST', `${root}/alert-evaluations`, body, { idempotencyKey: claimKey(JSON.stringify(['alerts', body])) });
    releaseHeld();
    const listed = await request<{ items: AlertItem[] }>('GET', `${root}/alerts?limit=20`);
    setAlerts(listed.data.items);
    setNotice('Evaluación interna hecha. Registrar lectura no paga ni mueve dinero.');
  }

  async function acknowledge(alertId: string) {
    if (!root) return;
    const detail = await request<AlertItem>('GET', `${root}/alerts/${alertId}`);
    if (!detail.etag) throw new ApiError(428, 'ETAG_REQUIRED', null, 'Falta la versión de la alerta. No se registró la lectura.');
    const result = await request<AlertItem>('POST', `${root}/alerts/${alertId}/acknowledgements`, {}, { idempotencyKey: claimKey(`ack:${alertId}`), ifMatch: detail.etag });
    releaseHeld();
    setAlerts(current => current.map(item => item.id === alertId ? result.data : item));
    setNotice('Lectura registrada. No se creó un pago.');
  }

  const creating = !scenario || scenario.baseId !== base?.id;
  const problem = base ? versionProblem({ ...draft(), creating, asOf: base.asOf }) : 'Captura la base antes de calcular.';
  const comparable = base ? runs.filter(item => sameComparison(item, { baseId: base.id, sourceDigest: base.sourceDigest, horizonDays: Number(horizonDays) })) : [];
  const activeRun = runs.find(item => item.outcomes.some(outcome => outcome.id === selectedOutcome)) ?? runs.at(-1);
  const activeOutcome = activeRun?.outcomes.find(item => item.id === selectedOutcome);
  const visibleDays = activeRun && activeOutcome ? activeRun.items.filter(item => item.outcomeId === activeOutcome.id) : [];

  function updateHypothesis(kind: ScenarioKind, patch: Partial<HypothesisDraft>) {
    setHypotheses(current => ({ ...current, [kind]: { ...current[kind], ...patch } }));
  }

  return (
    <div className="simulation-surface">
    <Panel title="Simulación" id="page-title">
      <p className="exchange-note">Simulación. No crea pagos, reservas, préstamos ni compras. Una hipótesis futura no es dinero disponible hoy.</p>
      <fieldset>
        <legend>Ámbito</legend>
        <div className="exchange-actions">
          {me.organizationId ? <label><input type="radio" name="ambito-simulacion" checked={scope === 'BUSINESS'} onChange={() => changeScope('BUSINESS')} /> Organización</label> : null}
          <label><input type="radio" name="ambito-simulacion" checked={scope === 'PERSONAL'} onChange={() => changeScope('PERSONAL')} disabled={personalState !== 'open'} /> Personal del titular</label>
          {consolidated ? <label><input type="radio" name="ambito-simulacion" checked={scope === 'CONSOLIDATED'} onChange={() => changeScope('CONSOLIDATED')} /> Consolidado privado</label> : null}
        </div>
      </fieldset>
      {scope === 'PERSONAL' && personalState === 'absent' ? <Alert tone="info">No hay libro personal en esta sesión. Esta pantalla no lo copia del negocio.</Alert> : null}
      {policy ? <p>Política {policy.simulationPolicy}. Alertas {policy.alertPolicy}. Uso que devolvió el servidor: {policy.usage}. Uso real permitido: {policy.realUseAllowed ? 'sí' : 'no'}. Horizonte máximo {policy.horizonMaxDays} días. Frescura {policy.freshnessSeconds} segundos. Umbral de vencimiento {policy.defaultAlertThresholds.dueWithinDays} días. Umbral de concentración {policy.defaultAlertThresholds.concentrationThreshold}. No es una tasa de mercado.</p> : <p role="status">Cargando la política…</p>}
      <div className="exchange-actions">
        <button type="button" disabled={pending || !policy || !root} onClick={() => { setError(null); guardedPending(true); void capture().catch(failed).finally(() => guardedPending(false)); }}>Capturar base</button>
      </div>
      {base ? (
        <div className="exchange-table">
          <table>
            <caption>Base capturada el {base.asOf}. Conocida el {base.knownAt}. Política {base.policyVersion}. Cobertura {base.coverage}. Fuentes {base.sourceRefs.length}.</caption>
            <thead><tr><th scope="col">Concepto de la base</th><th scope="col">Valor del servidor</th></tr></thead>
            <tbody>
              {(['cashBook', 'available', 'reserved', 'held', 'custodyProvisional', 'custodyConfirmed', 'committed'] as const).map(key => (
                <tr key={key}><th scope="row">{POSITION_LABEL[key]}</th><td>{showMetric(base[key])}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p>Todavía no hay base. No se muestra un cero en su lugar.</p>}
      <form onSubmit={onSubmit(calculate, guardedPending, failed)}>
        <Field label="Nombre de la hipótesis"><input value={name} maxLength={120} disabled={!creating} onChange={event => setName(event.target.value)} /></Field>
        <Field label="Horizonte en días" hint="Entre 1 y 366. No es una fecha de mercado."><input inputMode="numeric" value={horizonDays} onChange={event => setHorizonDays(event.target.value)} /></Field>
        <Field label="Presupuesto declarado" hint="El mismo importe para las cuatro alternativas. No reserva dinero."><input value={budget} onChange={event => setBudget(event.target.value)} /></Field>
        {KINDS.map(kind => (
          <fieldset key={kind}>
            <legend>Hipótesis {KIND_LABEL[kind]}</legend>
            <Field label={`Fracción de recaudo, ${KIND_LABEL[kind]}`}><input value={hypotheses[kind].collectionFraction} onChange={event => updateHypothesis(kind, { collectionFraction: event.target.value })} /></Field>
            <Field label={`Días de retraso, ${KIND_LABEL[kind]}`}><input inputMode="numeric" value={hypotheses[kind].delayDays} onChange={event => updateHypothesis(kind, { delayDays: event.target.value })} /></Field>
            <Field label={`Fracción de recuperación, ${KIND_LABEL[kind]}`}><input value={hypotheses[kind].recoveryFraction} onChange={event => updateHypothesis(kind, { recoveryFraction: event.target.value })} /></Field>
            <Field label={`Días de espera de la recuperación, ${KIND_LABEL[kind]}`}><input inputMode="numeric" value={hypotheses[kind].recoveryDelayDays} onChange={event => updateHypothesis(kind, { recoveryDelayDays: event.target.value })} /></Field>
            <Field label={`Proyección de interés, ${KIND_LABEL[kind]}`}>
              <select value={hypotheses[kind].interestProjection} onChange={event => updateHypothesis(kind, { interestProjection: event.target.value as HypothesisDraft['interestProjection'] })}>
                <option value="">Elige la proyección de interés</option>
                <option value="DECLARED_SCHEDULE_ONLY">Solo calendario declarado</option>
                <option value="SUPPORTED_SOURCE_TERMS">Términos de una fuente soportada</option>
              </select>
            </Field>
            <Field label={`Fecha de salida declarada, ${KIND_LABEL[kind]}`}><input type="date" value={hypotheses[kind].capitalOutDate} onChange={event => updateHypothesis(kind, { capitalOutDate: event.target.value })} /></Field>
            <Field label={`Importe de salida declarada, ${KIND_LABEL[kind]}`}><input value={hypotheses[kind].capitalOutAmount} onChange={event => updateHypothesis(kind, { capitalOutAmount: event.target.value })} /></Field>
            <Field label={`Fecha de entrada declarada, ${KIND_LABEL[kind]}`}><input type="date" value={hypotheses[kind].capitalInDate} onChange={event => updateHypothesis(kind, { capitalInDate: event.target.value })} /></Field>
            <Field label={`Importe de entrada declarada, ${KIND_LABEL[kind]}`}><input value={hypotheses[kind].capitalInAmount} onChange={event => updateHypothesis(kind, { capitalInAmount: event.target.value })} /></Field>
            <Field label={`Referencia de la hipótesis, ${KIND_LABEL[kind]}`} hint="No es un término oficial ni un movimiento registrado."><input value={hypotheses[kind].sourceReference} maxLength={256} onChange={event => updateHypothesis(kind, { sourceReference: event.target.value })} /></Field>
            <fieldset><legend>Recaudo de cuotas vencidas, {KIND_LABEL[kind]}</legend><p>Una cuota sin fecha de cobro explícita permanece incompleta. La referencia corresponde a su fuente actual.</p>{(hypotheses[kind].dateOverrides??[]).map((d,i)=><div key={i}><Field label={`Referencia de cuota ${i+1}, ${KIND_LABEL[kind]}`}><input value={d.sourceKey} onChange={e=>updateHypothesis(kind,{dateOverrides:hypotheses[kind].dateOverrides!.map((v,j)=>j===i?{...v,sourceKey:e.target.value}:v)})}/></Field><Field label={`Fecha de recaudo cuota ${i+1}, ${KIND_LABEL[kind]}`}><input type="date" value={d.collectionDate} onChange={e=>updateHypothesis(kind,{dateOverrides:hypotheses[kind].dateOverrides!.map((v,j)=>j===i?{...v,collectionDate:e.target.value}:v)})}/></Field><Field label={`Fecha de recuperación cuota ${i+1}, ${KIND_LABEL[kind]}`} hint="Opcional, nunca anterior al recaudo."><input type="date" value={d.recoveryDate??''} onChange={e=>updateHypothesis(kind,{dateOverrides:hypotheses[kind].dateOverrides!.map((v,j)=>j===i?{...v,recoveryDate:e.target.value||null}:v)})}/></Field><button type="button" onClick={()=>updateHypothesis(kind,{dateOverrides:hypotheses[kind].dateOverrides!.filter((_,j)=>j!==i)})}>Quitar fecha de cuota {i+1}, {KIND_LABEL[kind]}</button></div>)}<button type="button" onClick={()=>updateHypothesis(kind,{dateOverrides:[...hypotheses[kind].dateOverrides??[],{sourceKey:'',collectionDate:'',recoveryDate:null}]})}>Añadir fecha de recaudo, {KIND_LABEL[kind]}</button></fieldset>
            <label><input type="checkbox" checked={!!hypotheses[kind].reinvestment} onChange={e=>updateHypothesis(kind,{reinvestment:e.target.checked?{id:crypto.randomUUID(),date:'',amount:'',cashSourceFlowId:'',sourceReference:''}:undefined})}/> Reinversión explícita, {KIND_LABEL[kind]}</label>
            {hypotheses[kind].reinvestment?(['date','amount','cashSourceFlowId','sourceReference'] as const).map(key=><Field key={key} label={`${{date:'Fecha de reinversión',amount:'Importe de reinversión',cashSourceFlowId:'Fuente del recaudo a reinvertir',sourceReference:'Declaración de reinversión'}[key]}, ${KIND_LABEL[kind]}`} hint="Debe coincidir con el nuevo préstamo; no se suma el recaudo dos veces."><input type={key==='date'?'date':'text'} value={hypotheses[kind].reinvestment![key]} onChange={e=>updateHypothesis(kind,{reinvestment:{...hypotheses[kind].reinvestment!,[key]:e.target.value}})}/></Field>):null}
          </fieldset>
        ))}
        <AlternativeFields value={alternatives} base={base} onChange={setAlternatives}/>
        <p className="exchange-note">Renta, costos y valor estimado declarados son hipótesis. Un valor no disponible no se declara en cero.</p>
        {problem ? <p role="status">{problem}</p> : null}
        <button type="submit" disabled={pending || !base || problem !== null}>{creating ? 'Calcular hipótesis' : 'Crear otra versión'}</button>
        {job?<button type="button" onClick={()=>{void cancel().catch(failed);}}>Cancelar corrida</button>:null}
      </form>
      <div className="exchange-actions">
        <button type="button" disabled={pending || comparable.length < 2} onClick={() => { setError(null); guardedPending(true); void compare().catch(failed).finally(() => guardedPending(false)); }}>Comparar estas corridas</button>
        <button type="button" disabled={pending || runs.length === 0} onClick={() => { setError(null); guardedPending(true); void refresh().catch(failed).finally(() => guardedPending(false)); }}>Actualizar resultados</button>
        <button type="button" disabled={pending || !policy || !base} onClick={() => { setError(null); guardedPending(true); void evaluate().catch(failed).finally(() => guardedPending(false)); }}>Evaluar alertas internas</button>
      </div>
      {runs.map(run => (
        <section key={run.id} aria-label={`Corrida versión ${run.scenarioVersion}`}>
          <h2>Corrida versión {run.scenarioVersion}</h2>
          {base && run.baseId !== base.id ? <Alert tone="info">Esta corrida es de otra base. No se mezcla con la base actual.</Alert> : null}
          <p>{run.freshness === 'HISTORICAL_STALE' ? 'La base ya no es la de hoy. Estas cifras quedan como historia.' : 'Frescura vigente respecto de la captura usada por el servidor.'} {run.incomplete ? 'La lista está incompleta. No se ocultó el faltante.' : `Días devueltos ${run.items.length} de ${run.totalRows}.`}</p>
          <ul>
            {run.outcomes.map(outcome => <li key={outcome.id}>{outcomeText(outcome)}</li>)}
          </ul>
        </section>
      ))}
      {activeRun && activeOutcome ? (
        <>
          <Field label="Resultado que se lee en la lista">
            <select value={selectedOutcome} onChange={event => setSelectedOutcome(event.target.value)}>
              {activeRun.outcomes.map(outcome => <option key={outcome.id} value={outcome.id}>{KIND_LABEL[outcome.scenarioKind]} / {ALTERNATIVE_LABEL[outcome.alternativeKind]}</option>)}
            </select>
          </Field>
          <div className="exchange-table simulation-table">
            <table>
              <caption>Lectura textual del resultado. {outcomeText(activeOutcome)}</caption>
              <thead><tr><th scope="col">Concepto</th><th scope="col">Valor del servidor</th></tr></thead>
              <tbody>
                {Object.entries(METRIC_LABEL).map(([key, label]) => <tr key={key}><th scope="row">{label}</th><td>{showMetric(activeOutcome.metrics[key])}</td></tr>)}
              </tbody>
            </table>
          </div>
          <div className="exchange-table simulation-table">
            <table>
              <caption>Flujo por fecha del resultado elegido. El día posterior no financia un déficit anterior.</caption>
              <thead><tr><th scope="col">Fecha</th><th scope="col">Mínimo del día</th><th scope="col">Entradas</th><th scope="col">Salidas</th><th scope="col">Mínimo por libro</th></tr></thead>
              <tbody>
                {visibleDays.map(day => <tr key={day.date}><th scope="row">{day.date}</th><td>{showMetric(day.minimumIntraday)}</td><td>{showMetric(day.cashIn)}</td><td>{showMetric(day.cashOut)}</td><td>{day.bookBreakdown.map(book => `${book.bookId}: ${showMetric(book.minimum)}`).join('; ') || 'Sin desglose'}</td></tr>)}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      {comparison ? (
        <section aria-label="Comparación">
          <h2>Comparación</h2>
          <p>Base {comparison.baseId}. {comparison.winner === null ? 'El servidor no señaló una alternativa mejor.' : 'Hay una marca del servidor que esta pantalla no aplica.'}</p>
          <ul>{comparison.outcomes.map(outcome => <li key={outcome.id}>{outcomeText(outcome)}</li>)}</ul>
        </section>
      ) : null}
      <section aria-label="Alertas internas">
        <h2>Alertas internas</h2>
        {alerts.length === 0 ? <p>No hay alertas cargadas en esta sesión.</p> : (
          <ul>
            {alerts.map(alert => (
              <li key={alert.id}>
                <p>{ALERT_CLASS_LABEL[alert.class] ?? alert.class}. Tipo {alert.type}. Estado {alert.state}. Frescura {alert.freshness}. Fecha {alert.effectiveDate}. Importe {showMetric(alert.amount)}. Fuentes {alert.sourceRefs.length}.</p>
                <button type="button" disabled={pending || alert.state !== 'ACTIVE'||alert.freshness!=='CURRENT'} onClick={() => { setError(null); guardedPending(true); void acknowledge(alert.id).catch(failed).finally(() => guardedPending(false)); }}>Registrar lectura. Esto no paga.</button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <ErrorText error={error instanceof DiscardedRequest ? null : error} />
      {notice ? <Alert tone="info">{notice}</Alert> : null}
    </Panel>
    </div>
  );
}
