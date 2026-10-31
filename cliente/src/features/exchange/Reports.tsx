import { useEffect, useMemo, useState } from 'react';
import { ApiError, DiscardedRequest } from '../../shared/contracts';
import { todayBogota } from '../../shared/money';
import { Alert, ErrorText, Field, onSubmit } from '../../shared/ui';
import { COVERAGE_LABEL, REPORT_LABEL, SCOPE_LABEL, columnGroup, knownLabel, showCell } from './copy';
import { claimKey, heldUncertain, isUncertain, markUncertain, releaseHeld } from './memory';
import { viewCall } from './intent';
import { downloadExport } from './transport';
import type { Cell, ExportFormat, ExportRecord, Policy, ReportPage, ReportSnapshot } from './types';

const UUID = /^[0-9a-f-]{36}$/;

function Cells({ cells, caption }: { cells: Cell[]; caption: string }) {
  if (cells.length === 0) return <p>{caption}: el servidor no envió cifras.</p>;
  return (
    <div className="exchange-table">
      <table>
        <caption>{caption}</caption>
        <thead><tr><th>Grupo</th><th>Columna</th><th>Estado</th><th>Valor del servidor</th></tr></thead>
        <tbody>
          {cells.map(cell => (
            <tr key={`${caption}-${cell.columnId}`}>
              <td>{columnGroup(cell.columnId)}</td>
              <td>{cell.columnId}</td>
              <td>{knownLabel(COVERAGE_LABEL, cell.status, 'Estado no reconocido')}</td>
              <td>{showCell(cell)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Reports({ root, policy }: { root: string; policy: Policy }) {
  const fence = useMemo(() => ({ active: true, root }), [root]), request = viewCall(fence);
  useEffect(() => { fence.active = true; return () => { fence.active = false; }; }, [fence]);
  const today = todayBogota();
  const [kind, setKind] = useState(policy.reportKinds[0] ?? '');
  const [asOf, setAsOf] = useState(today);
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [ageBand, setAgeBand] = useState('');
  const [loanId, setLoanId] = useState('');
  const [snapshot, setSnapshot] = useState<ReportSnapshot | null>(null);
  const [page, setPage] = useState<ReportPage | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [format, setFormat] = useState<ExportFormat>(policy.formats[0] ?? 'CSV');
  const [job, setJob] = useState<ExportRecord | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  function invalidate() { setSnapshot(null); setPage(null); setCursor(null); setJob(null); setNotice(null); }
  function failed(caught: unknown) {
    if (!fence.active || caught instanceof DiscardedRequest) return;
    if (caught instanceof ApiError && [401, 403, 404, 409, 412].includes(caught.status)) invalidate();
    setError(caught);
  }
  async function refreshJob() {
    if (!job) return;
    const current = await request<ExportRecord>('GET', `${root}/exports/${job.id}`);
    setJob(current.data);
    setNotice('Estado del mismo archivo actualizado. No se creó otra exportación.');
  }
  function query(): string {
    const params = new URLSearchParams({ asOf, from, to });
    if (ageBand) params.set('ageBand', ageBand);
    if (loanId) params.set('loanId', loanId);
    return params.toString();
  }

  async function loadSnapshot() {
    if (loanId && !UUID.test(loanId)) throw new ApiError(422, 'INPUT_INVALID', null, 'El identificador del préstamo no tiene el formato admitido. No se consultó.');
    invalidate();
    const result = await request<ReportSnapshot>('GET', `${root}/reports/${kind}/snapshot?${query()}`);
    setSnapshot(result.data);
    const rows = await request<ReportPage>('GET', `${root}/reports/${kind}/rows?snapshotToken=${encodeURIComponent(result.data.meta.snapshotToken)}&limit=20`);
    setPage(rows.data);
    setCursor(rows.data.nextCursor);
  }

  async function more() {
    if (!snapshot || !cursor) return;
    const rows = await request<ReportPage>('GET', `${root}/reports/${kind}/rows?snapshotToken=${encodeURIComponent(snapshot.meta.snapshotToken)}&limit=20&cursor=${encodeURIComponent(cursor)}`);
    setPage(current => current ? { ...rows.data, items: [...current.items, ...rows.data.items] } : rows.data);
    setCursor(rows.data.nextCursor);
  }

  async function exportFile() {
    if (!snapshot) throw new ApiError(409, 'IMPORT_STATE_CONFLICT', null, 'Primero consulta el corte. No se generó un archivo.');
    const body = { reportKind: kind, snapshotToken: snapshot.meta.snapshotToken, format };
    const signature = JSON.stringify(body);
    const key = claimKey(signature);
    try {
      const created = await request<ExportRecord>('POST', `${root}/exports`, body, { idempotencyKey: key });
      let current = created.data;
      let etag = created.etag;
      for (let attempt = 0; attempt < 5 && (current.state === 'QUEUED' || current.state === 'RUNNING'); attempt += 1) {
        const again = await request<ExportRecord>('GET', `${root}/exports/${current.id}`);
        current = again.data;
        etag = again.etag ?? etag;
      }
      setJob(current); releaseHeld();
      if (current.state !== 'SUCCEEDED' || !etag) {
        setNotice('El archivo no está listo. Consulta el mismo trabajo. No se creó otra clave.');
        return;
      }
      releaseHeld();
      setNotice(`Archivo ${current.state === 'SUCCEEDED' ? 'listo' : current.state}. Vence ${current.file?.expiresAt ?? current.meta.expiresAt}. El conjunto tiene ${current.totalRows} filas.`);
    } catch (caught) {
      if (!fence.active || caught instanceof DiscardedRequest) throw caught;
      if (isUncertain(caught)) markUncertain();
      else if (!(caught instanceof ApiError) || ![409, 412, 428].includes(caught.status)) releaseHeld();
      throw caught;
    }
  }

  async function save() {
    if (!job?.file || job.state !== 'SUCCEEDED') throw new ApiError(409, 'IMPORT_STATE_CONFLICT', null, 'No hay un archivo listo para descargar.');
    const again = await request<ExportRecord>('GET', `${root}/exports/${job.id}`);
    if (!again.etag || again.data.state !== 'SUCCEEDED') throw new ApiError(409, 'REPORT_SNAPSHOT_EXPIRED', null, 'El archivo ya no está disponible. No se descargó.');
    const key = claimKey(`download:${job.id}:${again.etag}`);
    try {
      await downloadExport(`${root}/exports/${job.id}/downloads`, { ifMatch: again.etag, idempotencyKey: key }, () => fence.active);
      releaseHeld();
      setNotice('La descarga usó el nombre privado que devolvió el servidor. Revisa el archivo fuera de esta pantalla: los bytes no demuestran que el PDF se vea ni que el libro cuadre.');
    } catch (caught) {
      if (!fence.active || caught instanceof DiscardedRequest) throw caught;
      if (isUncertain(caught)) markUncertain();
      else releaseHeld();
      throw caught;
    }
  }

  async function cancel() {
    if (!job) return;
    const current = await request<ExportRecord>('GET', `${root}/exports/${job.id}`);
    if (!current.etag) throw new ApiError(428, 'ETAG_REQUIRED', null, 'Falta la versión del archivo. No se canceló.');
    const key = claimKey(`cancel-export:${job.id}:${current.etag}`);
    try {
      const result = await request<ExportRecord>('POST', `${root}/exports/${job.id}/cancellations`, { reason: 'Cancelacion solicitada en esta sesion.' }, { idempotencyKey: key, ifMatch: current.etag });
      releaseHeld();
      setJob(result.data);
      setNotice('Cancelación registrada según el estado que devolvió el servidor.');
    } catch (caught) {
      if (!fence.active || caught instanceof DiscardedRequest) throw caught;
      if (isUncertain(caught)) markUncertain();
      else releaseHeld();
      throw caught;
    }
  }

  return (
    <section aria-labelledby="reportes-s11">
      <h2 id="reportes-s11">Reportes y descargas</h2>
      <p className="exchange-note">El total del conjunto lo envía el servidor. Esta pantalla no suma la página visible ni oculta filas incompletas. Principal, interés, caja, estimación, reservas y porción excluida se muestran separados.</p>
      <form onSubmit={onSubmit(async () => { await loadSnapshot(); }, setPending, failed)}>
        <Field label="Reporte">
          <select value={kind} disabled={pending || heldUncertain()} onChange={event => { setKind(event.target.value); invalidate(); }}>
            {policy.reportKinds.map(item => <option key={item} value={item}>{knownLabel(REPORT_LABEL, item, 'Reporte no reconocido')}</option>)}
          </select>
        </Field>
        <Field label="Corte"><input type="date" value={asOf} disabled={pending || heldUncertain()} onChange={event => { setAsOf(event.target.value); invalidate(); }} required /></Field>
        <Field label="Desde"><input type="date" value={from} disabled={pending || heldUncertain()} onChange={event => { setFrom(event.target.value); invalidate(); }} required /></Field>
        <Field label="Hasta"><input type="date" value={to} disabled={pending || heldUncertain()} onChange={event => { setTo(event.target.value); invalidate(); }} required /></Field>
        <Field label="Antigüedad" hint="Vacío significa no filtrar.">
          <select value={ageBand} disabled={pending || heldUncertain()} onChange={event => { setAgeBand(event.target.value); invalidate(); }}>
            <option value="">Sin filtro</option>
            <option value="ALL">Todas</option>
            <option value="DUE_TODAY">Vence hoy</option>
            <option value="D01_30">1 a 30 días</option>
            <option value="D31_60">31 a 60 días</option>
            <option value="D61_90">61 a 90 días</option>
            <option value="D91_PLUS">Más de 90 días</option>
          </select>
        </Field>
        <Field label="Préstamo" hint="Opcional. Solo el identificador, sin buscar datos ajenos.">
          <input value={loanId} disabled={pending || heldUncertain()} onChange={event => { setLoanId(event.target.value.trim()); invalidate(); }} autoComplete="off" spellCheck={false} />
        </Field>
        <button className="primary" type="submit" disabled={pending || !kind} aria-busy={pending}>Consultar corte</button>
      </form>
      <ErrorText error={error instanceof DiscardedRequest ? null : error} />
      {notice ? <Alert tone="info">{notice}</Alert> : null}
      {snapshot ? (
        <>
          <p>Ámbito {knownLabel(SCOPE_LABEL, snapshot.meta.scope, 'Ámbito no reconocido')}. {knownLabel(COVERAGE_LABEL, snapshot.meta.coverage.status, 'Cobertura no reconocida')}. {snapshot.meta.denominatorScope === 'FILTERED_UNIVERSE' ? 'Universo filtrado.' : 'Universo autorizado.'} Filas del conjunto: {snapshot.totalRows}. La consulta vence {snapshot.meta.expiresAt}.</p>
          <Cells cells={snapshot.totals} caption="Totales del conjunto" />
        </>
      ) : null}
      {page ? (
        <>
          <p>Página acumulada en pantalla: {page.items.length} de {page.totalRows}. Esas filas no reemplazan el total del conjunto.</p>
          <Cells cells={page.pageTotals} caption="Totales solo de la última página" />
          <div className="exchange-table">
            <table>
              <caption>Filas recibidas</caption>
              <thead><tr><th>Fila</th><th>Grupo</th><th>Columna</th><th>Estado</th><th>Valor</th></tr></thead>
              <tbody>
                {page.items.map(row => row.cells.map(cell => (
                  <tr key={`${row.id}-${cell.columnId}`}>
                    <td>{row.id}</td>
                    <td>{columnGroup(cell.columnId)}</td>
                    <td>{cell.columnId}</td>
                    <td>{knownLabel(COVERAGE_LABEL, cell.status, 'Estado no reconocido')}</td>
                    <td>{showCell(cell)}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
          {cursor ? <button type="button" disabled={pending} onClick={() => { setError(null); setPending(true); void more().catch(failed).finally(() => setPending(false)); }}>Traer la página siguiente</button> : <p>No hay otra página.</p>}
          <div className="exchange-actions">
            <Field label="Formato">
              <select value={format} disabled={pending || heldUncertain()} onChange={event => { setFormat(event.target.value as ExportFormat); setJob(null); setNotice(null); }}>
                {policy.formats.map(item => <option key={item} value={item}>{item}</option>)}
              </select>
            </Field>
            <button type="button" disabled={pending} onClick={() => { setError(null); setPending(true); void exportFile().catch(failed).finally(() => setPending(false)); }}>Preparar archivo</button>
            <button type="button" disabled={pending || job?.state !== 'SUCCEEDED'} onClick={() => { setError(null); setPending(true); void save().catch(failed).finally(() => setPending(false)); }}>Descargar</button>
            <button type="button" disabled={pending || !job} onClick={() => { setError(null); setPending(true); void refreshJob().catch(failed).finally(() => setPending(false)); }}>Consultar archivo</button>
            <button type="button" disabled={pending || !job || job.state === 'CANCELLED' || job.state === 'EXPIRED'} onClick={() => { setError(null); setPending(true); void cancel().catch(failed).finally(() => setPending(false)); }}>Cancelar archivo</button>
          </div>
          {job ? <p role="status">Trabajo {job.id.slice(0, 8)}… {knownLabel({ QUEUED: 'En cola', RUNNING: 'En proceso', SUCCEEDED: 'Listo', FAILED: 'No se completó', CANCELLED: 'Cancelado', EXPIRED: 'Vencido' }, job.state, 'Estado no reconocido')}.{job.state === 'RUNNING' || job.state === 'QUEUED' ? <progress aria-label="Progreso del archivo" /> : null}</p> : null}
        </>
      ) : null}
    </section>
  );
}
