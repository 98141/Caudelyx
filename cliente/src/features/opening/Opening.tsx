import { useEffect, useRef, useState } from 'react';
import { AccountPicker } from '../finance/account-picker';
import { call, reauthenticate } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { ApiError, type ApiSuccess } from '../../shared/contracts';
import { bindCommand, parseLocalCop, parseSignedCop, releaseCommand, todayBogota, type CommandBinding } from '../../shared/money';
import { Alert, Empty, ErrorText, Field, StepFields, Submit } from '../../shared/ui';
import {
  CATEGORY_LABEL, ISSUE_TEXT, OPENING_POLICY_VERSION, REFERENCE_LABEL, STATUS_LABEL, STEPS, accountEligibility,
  draftFromSnapshot, emptyComponent, emptyDraft, emptyHistory, emptyInterest, emptyReference, emptySupport,
  errorsFor, presentCop, snapshotFromDraft, type ComponentCategory, type ComponentDraft, type EquityKind,
  type HistoryDraft, type InterestDraft, type OpeningDraft, type ReferenceDraft, type ReferenceType,
  type Snapshot, type StepId, type SupportDraft,
} from './draft';

interface Issue { code: string; path: string; relatedIds: string[] }
interface ProposedLine { accountId: string; debit: string; credit: string; componentIds: string[]; interestIds: string[] }
interface Totals {
  assets: string; liabilities: string; equity: string; debit: string; credit: string;
  balanceDifference: string; ledgerDifference: string; principal: string; recognizedInterest: string; informationalInterest: string;
}
interface Report { issues: Issue[]; totals: Totals; proposedLines: ProposedLine[] }
interface Validation { id: string; validatedAt: string; contentVersion: number; fingerprint: string; report: Report }
interface OpeningFile {
  id: string; version: number; contentVersion: number; status: string; financialScope: string; currency: string;
  snapshot: Snapshot; predecessorId: string | null; validation: Validation | null;
  approval: { approvedAt: string; validationId: string; validationFingerprint: string } | null;
  commit: { journalId: string; recordedAt: string; ledgerLineMap: { lineIndex: number; accountId: string }[] } | null;
  cancellation: { reason: string; cancelledAt: string } | null;
}
interface ValidationResult { opening: OpeningFile; report: Report; validation: Validation | null }
interface Listed { id: string; status: string; version: number; cutoffDate: string; updatedAt: string }
interface Page<T> { items: T[]; nextCursor: string | null }

const EDITABLE = new Set(['DRAFT', 'VALIDATED', 'APPROVED']);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function sameSnapshot(left: Snapshot, right: Snapshot): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function heldMessage(error: unknown): string | null {
  if (error instanceof ApiError && (error.status === 401 || error.code === 'AUTH_INVALID')) {
    return 'La sesión no se comprobó. El borrador sigue en esta pantalla y el comando no se reintentó.';
  }
  return null;
}

function FieldAlert({ text }: { text?: string }) {
  if (!text) return null;
  return <p role="alert">{text}</p>;
}

function SupportChecks({ legend, supports, selected, onChange, disabled }: {
  legend: string; supports: SupportDraft[]; selected: string[]; onChange: (ids: string[]) => void; disabled: boolean;
}) {
  return (
    <fieldset className="checks">
      <legend>{legend}</legend>
      {supports.length === 0 ? <p>Primero agrega un soporte en su paso.</p> : supports.map(support => (
        <label key={support.id}>
          <input type="checkbox" checked={selected.includes(support.id)} disabled={disabled} onChange={event => onChange(event.target.checked ? [...selected, support.id] : selected.filter(id => id !== support.id))} />
          <span>{support.reference || 'Soporte sin referencia'}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function OpeningWizard({ organizationId, base }: { organizationId: string; base: string }) {
  const { phase } = useAuth();
  const [draft, setDraft] = useState<OpeningDraft>(emptyDraft);
  const [step, setStep] = useState<StepId>('corte');
  const [file, setFile] = useState<OpeningFile | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [items, setItems] = useState<Listed[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [page, setPage] = useState<string | null>(null);
  const [back, setBack] = useState<(string | null)[]>([]);
  const [listError, setListError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [held, setHeld] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [approveReady, setApproveReady] = useState(false);
  const [commitReady, setCommitReady] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [review, setReview] = useState(false);
  const [password, setPassword] = useState('');
  const [stepCode, setStepCode] = useState('');
  const flight = useRef(false);
  const scopes = useRef<Record<string, CommandBinding | null>>({});
  const readOnly = file?.status === 'POSTED' || file?.status === 'CANCELLED';
  const built = snapshotFromDraft(draft, Boolean(file));
  const stepErrors = errorsFor(draft, step, Boolean(file));
  const dirty = file ? !sameSnapshot(built.snapshot, file.snapshot) : true;
  const shownReport = report ?? file?.validation?.report ?? null;
  const balanced = file?.status === 'VALIDATED' && Boolean(file.validation) && Boolean(shownReport)
    && shownReport!.issues.length === 0 && shownReport!.totals.balanceDifference === '0.00' && shownReport!.totals.ledgerDifference === '0.00' && !dirty;

  async function loadList(cursor: string | null) {
    const params = new URLSearchParams({ limit: '20' });
    if (cursor) params.set('cursor', cursor);
    const result = await call<Page<Listed>>('GET', `${base}/opening-files?${params.toString()}`);
    setItems(result.data.items);
    setNextCursor(result.data.nextCursor);
    setPage(cursor);
  }

  useEffect(() => {
    let cancel = false;
    void loadList(null).catch(caught => { if (!cancel) setListError(caught); });
    return () => { cancel = true; };
  }, [base]);

  function patch(recipe: (current: OpeningDraft) => OpeningDraft) {
    setApproveReady(false);
    setCommitReady(false);
    setDraft(recipe);
  }

  function applyFile(next: OpeningFile, nextEtag: string | null, nextReport: Report | null) {
    const resumed = draftFromSnapshot(next.snapshot, draft.changeReason);
    if (resumed) setDraft(resumed);
    setApproveReady(false);
    setCommitReady(false);
    setItems(current => current.map(item => item.id === next.id ? { ...item, status: next.status, version: next.version, cutoffDate: next.snapshot.cutoffDate } : item));
    setFile(next);
    setEtag(nextEtag);
    setReport(nextReport ?? next.validation?.report ?? null);
  }

  async function refreshFile(id: string, fallback: OpeningFile, fallbackEtag: string | null, fallbackReport: Report | null) {
    try {
      const fresh = await call<OpeningFile>('GET', `${base}/opening-files/${id}`);
      applyFile(fresh.data, fresh.etag, fresh.data.validation?.report ?? fallbackReport);
    } catch (caught) {
      applyFile(fallback, fallbackEtag, fallbackReport);
      setHeld(heldMessage(caught));
      if (!heldMessage(caught)) setError(caught);
    }
  }

  async function run(purpose: string, task: () => Promise<void>) {
    if (flight.current) return;
    flight.current = true;
    setPending(true);
    setError(null);
    setHeld(null);
    try {
      await task();
      setPassword('');
      setStepCode('');
      releaseCommand({ current: scopes.current[purpose] ?? null });
      scopes.current[purpose] = null;
    } catch (caught) {
      const session = heldMessage(caught);
      if (session) setHeld(session);
      setError(caught);
    } finally {
      flight.current = false;
      setPending(false);
    }
  }

  async function command<T>(purpose: string, path: string, method: string, payload: unknown, resourceId?: string, ifMatch?: string): Promise<ApiSuccess<T>> {
    const scope = { current: scopes.current[purpose] ?? null };
    const binding = bindCommand(scope, JSON.stringify([purpose, ifMatch ?? '', payload]));
    scopes.current[purpose] = scope.current;
    const body = { organizationId, idempotencyKey: binding.idempotencyKey, payload, ...(ifMatch ? { expectedETag: ifMatch } : {}) };
    await reauthenticate({ password, purpose, command: body, code: stepCode, ...(resourceId ? { resourceId } : {}) });
    return call<T>(method, path, payload, { idempotencyKey: binding.idempotencyKey, ...(ifMatch ? { ifMatch } : {}) });
  }

  async function save() {
    setReview(true);
    const replacing = Boolean(file);
    const { snapshot, errors } = snapshotFromDraft(draft, replacing);
    if (Object.keys(errors).length > 0) { setError(new Error('Revisa los campos marcados. No se envió el expediente.')); return; }
    if (file && !EDITABLE.has(file.status)) return;
    if (file && !etag) { setError(new Error('Falta la versión del expediente. No se envió.')); return; }
    const payload = replacing
      ? { snapshot, changeReason: draft.changeReason.trim().normalize('NFC') }
      : { snapshot, ...(draft.predecessorId ? { predecessorId: draft.predecessorId.trim().toLowerCase() } : {}) };
    await run(replacing ? 'OPENING_REPLACE' : 'OPENING_CREATE', async () => {
      const result = file
        ? await command<OpeningFile>('OPENING_REPLACE', `${base}/opening-files/${file.id}`, 'PUT', payload, file.id, etag ?? undefined)
        : await command<OpeningFile>('OPENING_CREATE', `${base}/opening-files`, 'POST', payload);
      await refreshFile(result.data.id, result.data, result.etag, null);
      await loadList(null).catch(caught => setListError(caught));
    });
  }

  async function validate() {
    if (!file || !etag || !['DRAFT', 'VALIDATED'].includes(file.status) || dirty || Object.keys(built.errors).some(key => key !== 'changeReason')) return;
    await run('OPENING_VALIDATE', async () => {
      const result = await command<ValidationResult>('OPENING_VALIDATE', `${base}/opening-files/${file.id}/validations`, 'POST', { policyVersion: OPENING_POLICY_VERSION }, file.id, etag);
      await refreshFile(result.data.opening.id, result.data.opening, result.etag, result.data.report);
    });
  }

  async function approve() {
    if (!file || !etag || !file.validation || !balanced) return;
    await run('OPENING_APPROVE', async () => {
      const result = await command<OpeningFile>('OPENING_APPROVE', `${base}/opening-files/${file.id}/approval`, 'POST', {
        validationId: file.validation!.id, validationFingerprint: file.validation!.fingerprint,
      }, file.id, etag);
      await refreshFile(result.data.id, result.data, result.etag, shownReport);
    });
  }

  async function commit() {
    if (!file || !etag || file.status !== 'APPROVED' || !file.validation || dirty) return;
    await run('OPENING_COMMIT', async () => {
      const result = await command<OpeningFile>('OPENING_COMMIT', `${base}/opening-files/${file.id}/commit`, 'POST', {
        validationId: file.validation!.id, validationFingerprint: file.validation!.fingerprint,
      }, file.id, etag);
      await refreshFile(result.data.id, result.data, result.etag, shownReport);
    });
  }

  async function cancel() {
    if (!file || !etag || !EDITABLE.has(file.status)) return;
    const reason = draft.changeReason.trim().normalize('NFC');
    if (!reason) { setError(new Error('La cancelación necesita un motivo. No se envió.')); return; }
    await run('OPENING_CANCEL', async () => {
      const result = await command<OpeningFile>('OPENING_CANCEL', `${base}/opening-files/${file.id}/cancellation`, 'POST', { reason }, file.id, etag);
      await refreshFile(result.data.id, result.data, result.etag, null);
      await loadList(null).catch(caught => setListError(caught));
    });
  }

  async function resume(id: string) {
    setError(null);
    setHeld(null);
    try {
      const result = await call<OpeningFile>('GET', `${base}/opening-files/${id}`);
      const resumed = draftFromSnapshot(result.data.snapshot);
      if (!resumed) { setError(new Error('El expediente no tiene un contenido legible.')); return; }
      setApproveReady(false);
      setCommitReady(false);
      setDraft(resumed);
      setFile(result.data);
      setEtag(result.etag);
      setReport(result.data.validation?.report ?? null);
      setStep('resumen');
      if (!result.etag) setError(new Error('La consulta no devolvió la versión necesaria.'));
    } catch (caught) {
      setHeld(heldMessage(caught));
      setError(caught);
    }
  }

  function go(next: StepId) {
    const current = STEPS.findIndex(item => item[0] === step);
    const target = STEPS.findIndex(item => item[0] === next);
    if (target > current) {
      setAttempted(true);
      if (Object.keys(stepErrors).length > 0) return;
    }
    setAttempted(false);
    setStep(next);
  }

  const visibleErrors = attempted ? stepErrors : {};
  const index = STEPS.findIndex(item => item[0] === step);
  return (
    <section className="card" aria-labelledby="apertura-titulo">
      <h2 id="apertura-titulo">Apertura manual</h2>
      <p>Ámbito disponible: negocio (BUSINESS). La moneda es COP. Esta pantalla no calcula el saldo ni arma el asiento; eso lo informa el servidor.</p>
      {phase === 'loading' ? <p role="status">Comprobando la sesión…</p> : null}
      {held ? <Alert tone="pending">{held}</Alert> : null}
      <ErrorText error={listError} />
      <ErrorText error={error} />
      <div className="cards">
        {items.length === 0 ? <Empty>No hay expedientes en esta página.</Empty> : items.map(item => (
          <article key={item.id} className="card">
            <h3>Corte {item.cutoffDate}</h3>
            <p>Estado del expediente: {item.status} ({STATUS_LABEL[item.status] ?? item.status}). Versión {item.version}.</p>
            <button type="button" onClick={() => void resume(item.id)}>Reanudar {item.cutoffDate}</button>
          </article>
        ))}
      </div>
      <div className="pager">
        <button type="button" disabled={back.length === 0} onClick={() => {
          const previous = back.at(-1) ?? null;
          setBack(current => current.slice(0, -1));
          void loadList(previous).catch(setListError);
        }}>Expedientes anteriores</button>
        <button type="button" disabled={!nextCursor} onClick={() => {
          if (!nextCursor) return;
          setBack(current => [...current, page]);
          void loadList(nextCursor).catch(setListError);
        }}>Expedientes siguientes</button>
      </div>
      {file ? <p>Expediente {file.id}. Estado {file.status} ({STATUS_LABEL[file.status] ?? file.status}). Versión {file.version}. Contenido {file.contentVersion}. Ámbito {file.financialScope}. Moneda {file.currency}.</p> : <p>Todavía no hay un expediente guardado. Lo que escribas permanece en esta pantalla hasta guardar o salir de Finanzas.</p>}
      {file?.status === 'CANCELLED' ? (
        <div className="stack">
          <p>Este expediente está cancelado{file.cancellation ? `: ${file.cancellation.reason}` : ''}. No se reabre ni se copian sus cifras.</p>
          <button type="button" onClick={() => {
            setDraft({ ...emptyDraft(), predecessorId: file.id });
            setFile(null); setEtag(null); setReport(null); setStep('corte');
          }}>Preparar expediente nuevo con este antecedente</button>
        </div>
      ) : null}
      <ol className="steps">
        {STEPS.map(([id, label], position) => (
          <li key={id} aria-current={step === id ? 'step' : undefined}>
            <button type="button" disabled={position > index + 1} onClick={() => go(id)}>{label}</button>
          </li>
        ))}
      </ol>
      {step === 'corte' ? (
        <div className="stack">
          <Field label="Fecha de corte de la apertura" hint="Corte inclusivo, calendario de Bogotá, sin fecha futura.">
            <input type="date" value={draft.cutoffDate} max={todayBogota()} disabled={readOnly} onChange={event => patch(current => ({ ...current, cutoffDate: event.target.value }))} required />
          </Field>
          <FieldAlert text={visibleErrors.cutoff} />
          {!file ? (
            <Field label="Antecedente cancelado" hint="Opcional. Solo el identificador de un expediente cancelado del mismo libro. No copia sus saldos.">
              <input value={draft.predecessorId} disabled={readOnly} onChange={event => patch(current => ({ ...current, predecessorId: event.target.value }))} autoComplete="off" />
            </Field>
          ) : null}
          <FieldAlert text={visibleErrors.predecessorId} />
        </div>
      ) : null}
      {step === 'soportes' ? (
        <div className="stack">
          <FieldAlert text={visibleErrors.supports} />
          {draft.supports.map(support => (
            <fieldset key={support.id}>
              <legend>Soporte declarado</legend>
              <Field label="Referencia del soporte"><input value={support.reference} disabled={readOnly} maxLength={120} onChange={event => patch(current => ({ ...current, supports: update(current.supports, support.id, { reference: event.target.value }) }))} /></Field>
              <FieldAlert text={visibleErrors[`support:${support.id}:reference`]} />
              <Field label="Fecha del soporte"><input type="date" value={support.asOfDate} max={draft.cutoffDate || todayBogota()} disabled={readOnly} onChange={event => patch(current => ({ ...current, supports: update(current.supports, support.id, { asOfDate: event.target.value }) }))} /></Field>
              <FieldAlert text={visibleErrors[`support:${support.id}:date`]} />
              <Field label="Declaración"><select value={support.declaration} disabled={readOnly} onChange={event => patch(current => ({ ...current, supports: update(current.supports, support.id, { declaration: event.target.value as SupportDraft['declaration'] }) }))}><option value="DECLARED">Declarado</option><option value="OWNER_CHECKED">Revisado por el titular</option></select></Field>
              <Field label="Nota del soporte"><input value={support.note} disabled={readOnly} maxLength={240} onChange={event => patch(current => ({ ...current, supports: update(current.supports, support.id, { note: event.target.value }) }))} /></Field>
              <FieldAlert text={visibleErrors[`support:${support.id}:note`]} />
              {readOnly ? null : <button type="button" onClick={() => patch(current => ({ ...current, supports: current.supports.filter(item => item.id !== support.id) }))}>Quitar soporte</button>}
            </fieldset>
          ))}
          {readOnly || draft.supports.length >= 100 ? null : <button type="button" onClick={() => patch(current => ({ ...current, supports: [...current.supports, emptySupport()] }))}>Agregar soporte</button>}
        </div>
      ) : null}
      {step === 'referencias' ? (
        <div className="stack">
          <p>Un préstamo histórico no es un desembolso ni un recaudo de esta operación. El principal se declara después como cartera.</p>
          <FieldAlert text={visibleErrors.references} />
          {draft.references.map(reference => (
            <ReferenceEditor key={reference.id} reference={reference} draft={draft} errors={visibleErrors} readOnly={readOnly} patch={patch} />
          ))}
          {readOnly || draft.references.length >= 100 ? null : <button type="button" onClick={() => patch(current => ({ ...current, references: [...current.references, emptyReference()] }))}>Agregar referencia histórica</button>}
        </div>
      ) : null}
      {step === 'componentes' ? (
        <div className="stack">
          <p>El importe queda en el componente. No hay un saldo editable ni una cuenta de ajuste.</p>
          <FieldAlert text={visibleErrors.components} />
          {draft.components.map(component => (
            <ComponentEditor key={component.id} component={component} draft={draft} errors={visibleErrors} readOnly={readOnly} base={base} patch={patch} />
          ))}
          {readOnly || draft.components.length >= 100 ? null : <button type="button" onClick={() => patch(current => ({ ...current, components: [...current.components, emptyComponent()] }))}>Agregar componente</button>}
        </div>
      ) : null}
      {step === 'historicos' ? (
        <div className="stack">
          <p>El antecedente informativo no tiene importe y no entra al libro. El interés informativo tampoco se contabiliza.</p>
          {draft.interests.map(interest => (
            <InterestEditor key={interest.id} interest={interest} draft={draft} errors={visibleErrors} readOnly={readOnly} base={base} patch={patch} />
          ))}
          {readOnly || draft.interests.length >= 100 ? null : <button type="button" onClick={() => patch(current => ({ ...current, interests: [...current.interests, emptyInterest()] }))}>Agregar interés histórico</button>}
          {draft.history.map(item => (
            <HistoryEditor key={item.id} item={item} draft={draft} errors={visibleErrors} readOnly={readOnly} patch={patch} />
          ))}
          {readOnly || draft.history.length >= 100 ? null : <button type="button" onClick={() => patch(current => ({ ...current, history: [...current.history, emptyHistory()] }))}>Agregar antecedente</button>}
        </div>
      ) : null}
      {step === 'resumen' ? (
        <div className="stack">
          <h3>Resumen previo</h3>
          <p>Corte {draft.cutoffDate || 'sin fecha'}. Ámbito BUSINESS. Soportes {draft.supports.length}. Referencias {draft.references.length}. Componentes {draft.components.length}. Intereses {draft.interests.length}. Antecedentes {draft.history.length}.</p>
          <ul>
            {draft.references.map(reference => <li key={reference.id}>{REFERENCE_LABEL[reference.type]} {reference.externalReference || 'sin referencia'}. {reference.type === 'HISTORICAL_LOAN' ? 'No se desembolsará ni se recaudará otra vez.' : 'No crea un movimiento del período.'}</li>)}
            {draft.components.map(component => <li key={component.id}>{CATEGORY_LABEL[component.category]} {component.amount || 'sin importe'}.</li>)}
            {draft.history.map(item => <li key={item.id}>Antecedente {item.date}: {item.description}. Sin importe económico.</li>)}
          </ul>
          {file && EDITABLE.has(file.status) ? (
            <Field label="Motivo del cambio" hint="Obligatorio para guardar de nuevo. Si el expediente estaba validado o aprobado, guardar lo devuelve a borrador.">
              <input value={draft.changeReason} maxLength={240} onChange={event => patch(current => ({ ...current, changeReason: event.target.value }))} />
            </Field>
          ) : null}
          {review ? <FieldAlert text={built.errors.changeReason} /> : null}
          {review && Object.keys(built.errors).length > 0 ? <Alert tone="error">Hay campos por corregir antes de guardar. No se calculó un balance para ocultarlos.</Alert> : null}
          {readOnly ? null : (
            <form onSubmit={event => { event.preventDefault(); void save(); }}>
              <StepFields legend="Confirmar el guardado del expediente" password={password} code={stepCode} setPassword={setPassword} setCode={setStepCode} />
              <Submit pending={pending}>Guardar borrador de apertura</Submit>
            </form>
          )}
          {file?.status === 'POSTED' && file.commit ? (
            <div role="status">
              <p>El servidor confirmó la apertura al corte {file.snapshot.cutoffDate}. Asiento {file.commit.journalId}. Registrado {new Date(file.commit.recordedAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}.</p>
              <p>Es un asiento de apertura. No es un desembolso ni un recaudo del período. Líneas vinculadas: {file.commit.ledgerLineMap.length}.</p>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="wizard-actions">
        <button type="button" disabled={index === 0} onClick={() => go(STEPS[index - 1]![0])}>Paso atrás</button>
        {index < STEPS.length - 1 ? <button type="button" onClick={() => go(STEPS[index + 1]![0])}>Siguiente</button> : null}
      </div>
      <section className="card" aria-labelledby="conciliacion-titulo">
        <h3 id="conciliacion-titulo">Conciliación del servidor</h3>
        {!file ? <p>Guarda el expediente antes de pedir la conciliación.</p> : null}
        {file && dirty ? <Alert tone="pending">Hay cambios sin guardar. Validar usaría la copia del servidor, así que primero hay que guardar.</Alert> : null}
        {file && ['DRAFT', 'VALIDATED'].includes(file.status) && !readOnly ? (
          <form onSubmit={event => { event.preventDefault(); void validate(); }}>
            <StepFields legend="Confirmar la validación" password={password} code={stepCode} setPassword={setPassword} setCode={setStepCode} />
            <Submit pending={pending} disabled={dirty || Object.keys(built.errors).some(key => key !== 'changeReason')}>Validar con el servidor</Submit>
          </form>
        ) : null}
        {file?.status === 'APPROVED' ? <p>Para validar de nuevo un expediente aprobado, vuelve a guardarlo con un motivo. Esto invalida la aprobación previa.</p> : null}
        {shownReport ? <Reconciliation report={shownReport} status={file?.status ?? ''} /> : <p>No hay un informe vigente del servidor.</p>}
        {balanced ? (
          <form onSubmit={event => { event.preventDefault(); void approve(); }}>
            <label className="checks"><input type="checkbox" checked={approveReady} onChange={event => setApproveReady(event.target.checked)} /> <span>Apruebo el expediente validado. Este paso todavía no contabiliza.</span></label>
            <StepFields legend="Confirmar la aprobación" password={password} code={stepCode} setPassword={setPassword} setCode={setStepCode} />
            <Submit pending={pending} disabled={!approveReady}>Aprobar apertura</Submit>
          </form>
        ) : <p>La aprobación espera un expediente VALIDATED, sin cambios locales y sin diferencias informadas por el servidor.</p>}
        {file?.status === 'APPROVED' && file.validation && !dirty ? (
          <form onSubmit={event => { event.preventDefault(); void commit(); }}>
            <label className="checks"><input type="checkbox" checked={commitReady} onChange={event => setCommitReady(event.target.checked)} /> <span>Confirmo el corte, los soportes y que los préstamos históricos no se desembolsan ni se recaudan otra vez.</span></label>
            <StepFields legend="Confirmar la apertura en el libro" password={password} code={stepCode} setPassword={setPassword} setCode={setStepCode} />
            <Submit pending={pending} disabled={!commitReady}>Confirmar apertura en el libro</Submit>
          </form>
        ) : <p>La confirmación espera un expediente APPROVED vigente. No hay confirmación automática.</p>}
        {file && EDITABLE.has(file.status) ? (
          <form onSubmit={event => { event.preventDefault(); void cancel(); }}>
            <Field label="Motivo de la cancelación"><input value={draft.changeReason} maxLength={240} onChange={event => patch(current => ({ ...current, changeReason: event.target.value }))} /></Field>
            <StepFields legend="Confirmar la cancelación" password={password} code={stepCode} setPassword={setPassword} setCode={setStepCode} />
            <Submit pending={pending}>Cancelar expediente</Submit>
          </form>
        ) : null}
      </section>
    </section>
  );
}

function update<T extends { id: string }>(items: T[], id: string, patch: Partial<T>): T[] {
  return items.map(item => item.id === id ? { ...item, ...patch } : item);
}

function ReferenceEditor({ reference, draft, errors, readOnly, patch }: {
  reference: ReferenceDraft; draft: OpeningDraft; errors: Record<string, string>; readOnly: boolean;
  patch: (recipe: (current: OpeningDraft) => OpeningDraft) => void;
}) {
  const borrowers = draft.references.filter(item => item.type === 'BORROWER' && item.id !== reference.id);
  return (
    <fieldset>
      <legend>{REFERENCE_LABEL[reference.type]}</legend>
      {reference.type === 'HISTORICAL_LOAN' ? <p>Préstamo histórico. No es un desembolso ni un recaudo de esta operación.</p> : null}
      <Field label="Tipo de referencia">
        <select value={reference.type} disabled={readOnly} onChange={event => patch(current => ({ ...current, references: update(current.references, reference.id, { type: event.target.value as ReferenceType }) }))}>
          {(Object.keys(REFERENCE_LABEL) as ReferenceType[]).map(type => <option key={type} value={type}>{REFERENCE_LABEL[type]}</option>)}
        </select>
      </Field>
      <Field label="Referencia externa"><input value={reference.externalReference} disabled={readOnly} maxLength={80} onChange={event => patch(current => ({ ...current, references: update(current.references, reference.id, { externalReference: event.target.value }) }))} /></Field>
      <FieldAlert text={errors[`reference:${reference.id}:external`]} />
      {reference.type === 'BORROWER' ? <Field label="Nombre visible"><input value={reference.displayName} disabled={readOnly} maxLength={80} onChange={event => patch(current => ({ ...current, references: update(current.references, reference.id, { displayName: event.target.value }) }))} /></Field> : null}
      <FieldAlert text={errors[`reference:${reference.id}:displayName`]} />
      {reference.type === 'HISTORICAL_LOAN' ? (
        <>
          <Field label="Contraparte del préstamo"><select value={reference.borrowerId} disabled={readOnly} onChange={event => patch(current => ({ ...current, references: update(current.references, reference.id, { borrowerId: event.target.value }) }))}><option value="">Elegir</option>{borrowers.map(item => <option key={item.id} value={item.id}>{item.displayName || item.externalReference}</option>)}</select></Field>
          <Field label="Fecha de originación"><input type="date" value={reference.originationDate} max={draft.cutoffDate || todayBogota()} disabled={readOnly} onChange={event => patch(current => ({ ...current, references: update(current.references, reference.id, { originationDate: event.target.value }) }))} /></Field>
        </>
      ) : null}
      <FieldAlert text={errors[`reference:${reference.id}:borrower`]} />
      {reference.type === 'OBLIGATION' ? (
        <>
          <Field label="Contraparte de la obligación"><input value={reference.counterpartyLabel} disabled={readOnly} maxLength={80} onChange={event => patch(current => ({ ...current, references: update(current.references, reference.id, { counterpartyLabel: event.target.value }) }))} /></Field>
          <Field label="Fecha de la obligación"><input type="date" value={reference.incurredDate} max={draft.cutoffDate || todayBogota()} disabled={readOnly} onChange={event => patch(current => ({ ...current, references: update(current.references, reference.id, { incurredDate: event.target.value }) }))} /></Field>
        </>
      ) : null}
      <FieldAlert text={errors[`reference:${reference.id}:counterparty`]} />
      {reference.type === 'BASIC_ASSET' || reference.type === 'BASIC_INVESTMENT' ? (
        <>
          <Field label="Categoría de la referencia"><input value={reference.category} disabled={readOnly} maxLength={40} onChange={event => patch(current => ({ ...current, references: update(current.references, reference.id, { category: event.target.value }) }))} /></Field>
          <Field label="Fecha de adquisición"><input type="date" value={reference.acquisitionDate} max={draft.cutoffDate || todayBogota()} disabled={readOnly} onChange={event => patch(current => ({ ...current, references: update(current.references, reference.id, { acquisitionDate: event.target.value }) }))} /></Field>
        </>
      ) : null}
      <FieldAlert text={errors[`reference:${reference.id}:category`]} />
      <FieldAlert text={errors[`reference:${reference.id}:date`]} />
      <Field label="Origen informado" hint="Texto informativo. No suma dinero ni asigna fondos."><input value={reference.fundingReference} disabled={readOnly} maxLength={120} onChange={event => patch(current => ({ ...current, references: update(current.references, reference.id, { fundingReference: event.target.value }) }))} /></Field>
      <SupportChecks legend="Soportes de la referencia" supports={draft.supports} selected={reference.supportIds} disabled={readOnly} onChange={supportIds => patch(current => ({ ...current, references: update(current.references, reference.id, { supportIds }) }))} />
      <FieldAlert text={errors[`reference:${reference.id}:support`]} />
      {readOnly ? null : <button type="button" onClick={() => patch(current => ({ ...current, references: current.references.filter(item => item.id !== reference.id) }))}>Quitar referencia</button>}
    </fieldset>
  );
}

function ComponentEditor({ component, draft, errors, readOnly, base, patch }: {
  component: ComponentDraft; draft: OpeningDraft; errors: Record<string, string>; readOnly: boolean; base: string;
  patch: (recipe: (current: OpeningDraft) => OpeningDraft) => void;
}) {
  const eligibility = accountEligibility(component.category);
  const canonicalAmount = component.category === 'EQUITY' ? parseSignedCop(component.amount) : parseLocalCop(component.amount);
  const expected = component.category === 'PRINCIPAL_RECEIVABLE' ? 'HISTORICAL_LOAN' : component.category === 'LIABILITY' ? 'OBLIGATION' : component.category;
  const references = draft.references.filter(item => item.type === expected);
  const needsReference = component.category !== 'CASH' && component.category !== 'BANK' && component.category !== 'EQUITY';
  return (
    <fieldset>
      <legend>{CATEGORY_LABEL[component.category]}</legend>
      <Field label="Categoría del componente">
        <select value={component.category} disabled={readOnly} onChange={event => patch(current => ({ ...current, components: update(current.components, component.id, { category: event.target.value as ComponentCategory }) }))}>
          {(Object.keys(CATEGORY_LABEL) as ComponentCategory[]).map(category => <option key={category} value={category}>{CATEGORY_LABEL[category]}</option>)}
        </select>
      </Field>
      <p className="muted">Si la cuenta elegida no corresponde a la categoría, el servidor la rechaza. Cambiar la categoría no vacía la selección.</p>
      <AccountPicker base={base} label={CATEGORY_LABEL[component.category]} value={component.accountId} accountClass={eligibility.accountClass} kinds={eligibility.kinds} onChange={accountId => patch(current => ({ ...current, components: update(current.components, component.id, { accountId }) }))} />
      <FieldAlert text={errors[`component:${component.id}:account`]} />
      <Field label={component.category === 'EQUITY' ? 'Importe de patrimonio' : 'Importe del componente'} hint="Ejemplo: 1.999 o 1.999,50. El patrimonio también admite negativo, como -50,00.">
        <input value={component.amount} disabled={readOnly} inputMode="decimal" autoComplete="off" onChange={event => patch(current => ({ ...current, components: update(current.components, component.id, { amount: event.target.value }) }))} />
      </Field>
      <p className="muted">{canonicalAmount ? `Se enviará ${canonicalAmount} COP.` : 'El importe todavía no tiene el formato del contrato.'}</p>
      <FieldAlert text={errors[`component:${component.id}:amount`]} />
      {component.category === 'EQUITY' ? (
        <Field label="Clase de patrimonio">
          <select value={component.equityKind} disabled={readOnly} onChange={event => patch(current => ({ ...current, components: update(current.components, component.id, { equityKind: event.target.value as EquityKind }) }))}>
            <option value="CONTRIBUTED">Aportes</option>
            <option value="HISTORICAL_RESULTS">Resultados históricos</option>
            <option value="OTHER_DECLARED">Otro patrimonio declarado</option>
          </select>
        </Field>
      ) : null}
      {needsReference ? (
        <Field label="Referencia del componente">
          <select value={component.referenceId} disabled={readOnly} onChange={event => patch(current => ({ ...current, components: update(current.components, component.id, { referenceId: event.target.value }) }))}>
            <option value="">Elegir</option>
            {references.map(item => <option key={item.id} value={item.id}>{item.externalReference || item.displayName}</option>)}
          </select>
        </Field>
      ) : null}
      <FieldAlert text={errors[`component:${component.id}:reference`]} />
      <SupportChecks legend="Soportes del componente" supports={draft.supports} selected={component.supportIds} disabled={readOnly} onChange={supportIds => patch(current => ({ ...current, components: update(current.components, component.id, { supportIds }) }))} />
      <FieldAlert text={errors[`component:${component.id}:support`]} />
      {readOnly ? null : <button type="button" onClick={() => patch(current => ({ ...current, components: current.components.filter(item => item.id !== component.id) }))}>Quitar componente</button>}
    </fieldset>
  );
}

function InterestEditor({ interest, draft, errors, readOnly, base, patch }: {
  interest: InterestDraft; draft: OpeningDraft; errors: Record<string, string>; readOnly: boolean; base: string;
  patch: (recipe: (current: OpeningDraft) => OpeningDraft) => void;
}) {
  const loans = draft.references.filter(item => item.type === 'HISTORICAL_LOAN');
  const equities = draft.components.filter(item => item.category === 'EQUITY' && item.equityKind === 'HISTORICAL_RESULTS');
  const eligibility = accountEligibility('RECOGNIZED_INTEREST');
  const canonicalAmount = parseLocalCop(interest.amount);
  return (
    <fieldset>
      <legend>{interest.treatment === 'INFORMATIONAL' ? 'Interés informativo' : 'Interés reconocido en la apertura'}</legend>
      <p>{interest.treatment === 'INFORMATIONAL' ? 'Queda fuera del asiento.' : 'Se reconoce contra el patrimonio declarado. No es ingreso del período.'}</p>
      <Field label="Tratamiento del interés">
        <select value={interest.treatment} disabled={readOnly} onChange={event => patch(current => ({ ...current, interests: update(current.interests, interest.id, { treatment: event.target.value as InterestDraft['treatment'] }) }))}>
          <option value="INFORMATIONAL">Informativo, fuera del libro</option>
          <option value="RECOGNIZED_OPENING">Reconocido en la apertura</option>
        </select>
      </Field>
      <Field label="Préstamo histórico del interés"><select value={interest.loanReferenceId} disabled={readOnly} onChange={event => patch(current => ({ ...current, interests: update(current.interests, interest.id, { loanReferenceId: event.target.value }) }))}><option value="">Elegir</option>{loans.map(item => <option key={item.id} value={item.id}>{item.externalReference}</option>)}</select></Field>
      <FieldAlert text={errors[`interest:${interest.id}:loan`]} />
      <Field label="Importe del interés" hint="Mayor que cero. No se calcula una tasa."><input value={interest.amount} disabled={readOnly} inputMode="decimal" autoComplete="off" onChange={event => patch(current => ({ ...current, interests: update(current.interests, interest.id, { amount: event.target.value }) }))} /></Field>
      <p className="muted">{canonicalAmount ? `Se enviará ${canonicalAmount} COP.` : 'El importe todavía no tiene el formato del contrato.'}</p>
      <FieldAlert text={errors[`interest:${interest.id}:amount`]} />
      {interest.treatment === 'RECOGNIZED_OPENING' ? (
        <>
          <AccountPicker base={base} label="Cuenta del interés reconocido" value={interest.accountId} accountClass={eligibility.accountClass} kinds={eligibility.kinds} onChange={accountId => patch(current => ({ ...current, interests: update(current.interests, interest.id, { accountId }) }))} />
          <Field label="Declaración del reconocimiento"><input value={interest.recognitionDeclaration} disabled={readOnly} maxLength={240} onChange={event => patch(current => ({ ...current, interests: update(current.interests, interest.id, { recognitionDeclaration: event.target.value }) }))} /></Field>
          <Field label="Patrimonio de resultados históricos"><select value={interest.equityComponentId} disabled={readOnly} onChange={event => patch(current => ({ ...current, interests: update(current.interests, interest.id, { equityComponentId: event.target.value }) }))}><option value="">Elegir</option>{equities.map(item => <option key={item.id} value={item.id}>{item.amount || item.id}</option>)}</select></Field>
        </>
      ) : null}
      <FieldAlert text={errors[`interest:${interest.id}:account`]} />
      <FieldAlert text={errors[`interest:${interest.id}:declaration`]} />
      <FieldAlert text={errors[`interest:${interest.id}:equity`]} />
      <SupportChecks legend="Soportes del interés" supports={draft.supports} selected={interest.supportIds} disabled={readOnly} onChange={supportIds => patch(current => ({ ...current, interests: update(current.interests, interest.id, { supportIds }) }))} />
      <FieldAlert text={errors[`interest:${interest.id}:support`]} />
      {readOnly ? null : <button type="button" onClick={() => patch(current => ({ ...current, interests: current.interests.filter(item => item.id !== interest.id) }))}>Quitar interés</button>}
    </fieldset>
  );
}

function HistoryEditor({ item, draft, errors, readOnly, patch }: {
  item: HistoryDraft; draft: OpeningDraft; errors: Record<string, string>; readOnly: boolean;
  patch: (recipe: (current: OpeningDraft) => OpeningDraft) => void;
}) {
  return (
    <fieldset>
      <legend>Antecedente informativo</legend>
      <p>No tiene importe y no cambia la apertura.</p>
      <Field label="Fecha del antecedente"><input type="date" value={item.date} max={draft.cutoffDate || todayBogota()} disabled={readOnly} onChange={event => patch(current => ({ ...current, history: update(current.history, item.id, { date: event.target.value }) }))} /></Field>
      <Field label="Descripción del antecedente"><input value={item.description} disabled={readOnly} maxLength={240} onChange={event => patch(current => ({ ...current, history: update(current.history, item.id, { description: event.target.value }) }))} /></Field>
      <Field label="Referencia del antecedente"><select value={item.referenceId} disabled={readOnly} onChange={event => patch(current => ({ ...current, history: update(current.history, item.id, { referenceId: event.target.value }) }))}><option value="">Ninguna</option>{draft.references.map(reference => <option key={reference.id} value={reference.id}>{reference.externalReference || reference.displayName}</option>)}</select></Field>
      <FieldAlert text={errors[`history:${item.id}:date`]} />
      <FieldAlert text={errors[`history:${item.id}:description`]} />
      <FieldAlert text={errors[`history:${item.id}:reference`]} />
      <SupportChecks legend="Soportes del antecedente" supports={draft.supports} selected={item.supportIds} disabled={readOnly} onChange={supportIds => patch(current => ({ ...current, history: update(current.history, item.id, { supportIds }) }))} />
      <FieldAlert text={errors[`history:${item.id}:support`]} />
      {readOnly ? null : <button type="button" onClick={() => patch(current => ({ ...current, history: current.history.filter(entry => entry.id !== item.id) }))}>Quitar antecedente</button>}
    </fieldset>
  );
}

function Reconciliation({ report, status }: { report: Report; status: string }) {
  const totals = report.totals;
  return (
    <div className="stack">
      <p>Informe recibido para el estado {status || 'sin estado'}. Las cifras siguientes salen de la respuesta, no de un cálculo de esta pantalla.</p>
      {report.issues.length > 0 ? report.issues.map(issue => (
        <Alert key={`${issue.code}-${issue.path}`} tone="error">{ISSUE_TEXT[issue.code] ?? issue.code}. Ruta {issue.path}.{issue.relatedIds.length ? ` Referencias ${issue.relatedIds.join(', ')}.` : ''}</Alert>
      )) : <p>El servidor no reportó incidencias en este informe.</p>}
      {totals ? (
        <ul>
          <li>Activos {presentCop(totals.assets)}</li>
          <li>Pasivos {presentCop(totals.liabilities)}</li>
          <li>Patrimonio {presentCop(totals.equity)}</li>
          <li>Débitos {presentCop(totals.debit)}</li>
          <li>Créditos {presentCop(totals.credit)}</li>
          <li>Diferencia de balance {presentCop(totals.balanceDifference)}</li>
          <li>Diferencia de débitos y créditos {presentCop(totals.ledgerDifference)}</li>
          <li>Principal {presentCop(totals.principal)}</li>
          <li>Interés reconocido {presentCop(totals.recognizedInterest)}</li>
          <li>Interés informativo {presentCop(totals.informationalInterest)}</li>
        </ul>
      ) : <p>El servidor no envió totales.</p>}
      <h3>Líneas propuestas por el servidor</h3>
      <p className="muted">Todavía no son un asiento contabilizado, salvo que el expediente ya figure como POSTED.</p>
      {report.proposedLines.length === 0 ? <Empty>El servidor no propuso líneas.</Empty> : (
        <ul>{report.proposedLines.map(line => <li key={line.accountId}>Cuenta {line.accountId}: débito {presentCop(line.debit)}, crédito {presentCop(line.credit)}.</li>)}</ul>
      )}
    </div>
  );
}
