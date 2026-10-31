import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../shared/auth';
import { ApiError, DiscardedRequest, StepUpCancelled, type Me } from '../../shared/contracts';
import { todayBogota } from '../../shared/money';
import { ensureStepUp } from '../../shared/step-up';
import { Alert, ErrorText, Field, Panel, onSubmit } from '../../shared/ui';
import { ISSUE_LABEL, MODE_LABEL, SEVERITY_LABEL, SHEETS, STATE_LABEL, knownLabel, safeFileLabel } from './copy';
import { claimKey, clearExchangeMemory, heldUncertain, heldSignature, isUncertain, markUncertain, releaseHeld } from './memory';
import { ImportOpening } from './ImportOpening';
import { bytesHash, viewCall } from './intent';
import { Reports } from './Reports';
import { saveBytes, templateBytes, uploadWorkbook } from './transport';
import { MAPPING_VERSION, TEMPLATE_VERSION, type HistoricalProfileInput, type ImportMode, type ImportRecord, type JobRecord, type Policy, type Preview, type PreviewTotals, type Receipt, type ScopeKind } from './types';

const EMPTY_PROFILE: HistoricalProfileInput = {
  externalKey: '', principalAccountId: '', interestReceivableAccountId: '', interestIncomeAccountId: '', borrowerCreditAccountId: '',
  principalAccountETag: '', interestReceivableAccountETag: '', interestIncomeAccountETag: '', borrowerCreditAccountETag: '',
};

function rootOf(scope: ScopeKind, organizationId: string | undefined, bookId: string | null): string | null {
  if (scope === 'BUSINESS' && organizationId) return `/organizations/${organizationId}/exchange-s11`;
  if (scope === 'PERSONAL' && bookId) return `/me/personal/books/${bookId}/exchange-s11`;
  if (scope === 'CONSOLIDATED') return '/me/exchange-s11';
  return null;
}

function moneyLine(totals: PreviewTotals): string {
  return `Activos ${totals.assets}. Pasivos ${totals.liabilities}. Patrimonio ${totals.equity}. Débito ${totals.debit}. Crédito ${totals.credit}. Diferencia ${totals.difference}. Principal ${totals.principal}. Interés reconocido ${totals.recognizedInterest}. Interés informativo ${totals.informationalInterest}.`;
}

function profilePayload(row: HistoricalProfileInput) {
  return {
    externalKey: row.externalKey.trim(),
    accountProfile: {
      principalAccountId: row.principalAccountId.trim(),
      interestReceivableAccountId: row.interestReceivableAccountId.trim(),
      interestIncomeAccountId: row.interestIncomeAccountId.trim(),
      borrowerCreditAccountId: row.borrowerCreditAccountId.trim(),
    },
    accountVersions: {
      principalAccountId: row.principalAccountETag.trim(),
      interestReceivableAccountId: row.interestReceivableAccountETag.trim(),
      interestIncomeAccountId: row.interestIncomeAccountETag.trim(),
      borrowerCreditAccountId: row.borrowerCreditAccountETag.trim(),
    },
  };
}

function profileStarted(row: HistoricalProfileInput): boolean {
  return Object.values(row).some(value => value.trim() !== '');
}

function profileComplete(row: HistoricalProfileInput): boolean {
  return Object.values(row).every(value => value.trim() !== '');
}

export function ExchangeScreen() {
  const { me, phase } = useAuth();
  if (phase !== 'ready' || !me) return <p role="status">Cargando la sesión…</p>;
  if (me.roleIds?.includes('SA')) {
    return (
      <Panel title="Importar y exportar" id="page-title">
        <Alert tone="info">Esta superficie no está disponible para administración de plataforma. No se consultan libros personales ni consolidados.</Alert>
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
  const [mode, setMode] = useState<ImportMode>('OPERATIVE');
  const [namespace, setNamespace] = useState('sintetico');
  const [label, setLabel] = useState('Lote sintético');
  const [fileLabel, setFileLabel] = useState('');
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [record, setRecord] = useState<ImportRecord | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [stored, setStored] = useState<ImportRecord[]>([]);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [profiles, setProfiles] = useState<HistoricalProfileInput[]>([{ ...EMPTY_PROFILE }]);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const root = rootOf(scope, me.organizationId, bookId);
  const fence = useMemo(() => ({ active: true, root }), [root]);
  const request = useMemo(() => viewCall(fence), [fence]);
  const fileRead = useRef(0);
  const confirmIntent = useRef<{ payload: { previewId: string; semanticHash: string; bookETag: string }; etag: string } | null>(null);
  useEffect(() => { fence.active = true; return () => { fence.active = false; }; }, [fence]);
  const importing = scope !== 'CONSOLIDATED' && (policy?.importModes.length ?? 0) > 0;

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const personal = await request<{ id?: string }>('GET', '/me/personal/book');
        if (!live) return;
        setBookId(personal.data.id ?? null);
        setPersonalState(personal.data.id ? 'open' : 'absent');
      } catch (caught) {
        if (!live) return;
        setBookId(null);
        setPersonalState(caught instanceof ApiError && caught.status === 404 ? 'absent' : 'unknown');
      }
    })();
    return () => { live = false; };
  }, [request]);

  useEffect(() => {
    let live = true;
    void request<Policy>('GET', '/me/exchange-s11/policy').then(() => { if (live) setConsolidated(true); }).catch(() => { if (live) setConsolidated(false); });
    return () => { live = false; };
  }, [request]);

  useEffect(() => {
    let live = true;
    setStored([]); setPolicy(null); setRecord(null); setPreview(null); setReceipt(null); setBytes(null); setEtag(null);
    clearExchangeMemory(); confirmIntent.current = null;
    if (scope === 'CONSOLIDATED') {
      void request<Policy>('GET', '/me/exchange-s11/policy').then(result => {
        if (!live) return;
        setConsolidated(true);
        setPolicy(result.data);
      }).catch(caught => {
        if (!live) return;
        setConsolidated(false);
        setPolicy(null);
        if (!(caught instanceof ApiError) || (caught.status !== 403 && caught.status !== 404)) setError(caught);
      });
      return () => { live = false; };
    }
    if (!root) return () => { live = false; };
    void request<Policy>('GET', `${root}/policy`).then(result => {
      if (!live) return;
      setPolicy(result.data);
      const first = result.data.importModes[0];
      if (first) setMode(first);
    }).catch(caught => { if (live) setError(caught); });
    return () => { live = false; };
  }, [root, scope, request]);

  function failed(caught: unknown) {
    if (!fence.active || caught instanceof DiscardedRequest) return;
    if (caught instanceof ApiError && [401, 403, 404].includes(caught.status)) { setRecord(null); setPreview(null); setReceipt(null); setBytes(null); setFileLabel(''); setEtag(null); confirmIntent.current = null; releaseHeld(); }
    setError(caught);
  }

  function invalidate() {
    setPreview(null); setReceipt(null); setRecord(null); setEtag(null);
    if (!heldUncertain()) { releaseHeld(); confirmIntent.current = null; }
  }

  async function guarded<T>(signature: string, work: (key: string) => Promise<T>): Promise<T> {
    const key = claimKey(signature), wasUncertain = heldUncertain();
    try {
      const result = await work(key);
      if (!fence.active) throw new DiscardedRequest();
      releaseHeld();
      return result;
    } catch (caught) {
      if (!fence.active || caught instanceof DiscardedRequest) throw caught;
      if (caught instanceof StepUpCancelled && wasUncertain) throw caught;
      if (isUncertain(caught)) markUncertain();
      else if (!(caught instanceof ApiError) || ![409, 412, 428].includes(caught.status) || ['IMPORT_PREVIEW_STALE','IMPORT_PREVIEW_EXPIRED','PRECONDITION_FAILED'].includes(caught.code)) { releaseHeld(); confirmIntent.current = null; }
      throw caught;
    }
  }

  async function createLot() {
    if (!root || !importing) throw new ApiError(403, 'ACCESS_DENIED', null, 'Este ámbito no admite importar.');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(namespace)) throw new ApiError(422, 'INPUT_INVALID', null, 'El espacio de nombres no es válido. No se creó el lote.');
    const body = { label: label.trim(), namespace, mode, templateVersion: TEMPLATE_VERSION, mappingVersion: MAPPING_VERSION };
    const result = await guarded(JSON.stringify(['create', root, body]), key => request<ImportRecord>('POST', `${root}/imports`, body, { idempotencyKey: key }));
    setRecord(result.data); setEtag(result.etag); setPreview(null); setReceipt(null);
    setNotice('Lote creado. Todavía no hay una operación económica.');
  }

  async function upload() {
    if (!root || !record || !etag || !bytes || !policy) throw new ApiError(409, 'IMPORT_STATE_CONFLICT', null, 'Falta el lote o el archivo. No se cargó.');
    if (bytes.byteLength > policy.maxUploadBytes) throw new ApiError(413, 'FILE_LIMIT_EXCEEDED', null, 'El archivo supera el límite visible del contrato. No se cargó.');
    const result = await guarded(JSON.stringify(['upload', record.id, await bytesHash(bytes), etag]), async key => uploadWorkbook(`${root}/imports/${record.id}/content`, bytes, { ifMatch: etag, idempotencyKey: key }));
    const current = await request<ImportRecord>('GET', `${root}/imports/${record.id}`);
    setRecord(current.data); setEtag(result.etag ?? current.etag); setPreview(null); setReceipt(null);
    setNotice('El servidor recibió el archivo. La vista previa todavía no es una operación realizada.');
  }

  async function previewLot() {
    if (!root || !record || !etag) throw new ApiError(409, 'IMPORT_STATE_CONFLICT', null, 'No hay un archivo vigente para previsualizar.');
    const started = profiles.some(profileStarted);
    if (mode === 'HISTORICAL_LINK' && started && profiles.filter(profileStarted).some(row => !profileComplete(row))) {
      throw new ApiError(422, 'INPUT_INVALID', null, 'Completa las cuatro cuentas y sus versiones, o déjalas vacías para que el servidor señale el faltante. No se inventaron cuentas.');
    }
    const body = mode === 'HISTORICAL_LINK' && started ? { historicalProfiles: profiles.filter(profileStarted).map(profilePayload) } : {};
    const result = await guarded(JSON.stringify(['preview', record.id, etag, body]), key => request<JobRecord>('POST', `${root}/imports/${record.id}/previews`, body, { idempotencyKey: key, ifMatch: etag }));
    let job = result.data;
    for (let attempt = 0; attempt < 5 && (job.state === 'QUEUED' || job.state === 'RUNNING'); attempt += 1) {
      const again = await request<JobRecord>('GET', `${root}/jobs/${job.id}`);
      job = again.data;
    }
    if (job.state === 'FAILED') throw new ApiError(409, job.errorCode ?? 'SOURCE_CONFLICT', null, 'El trabajo no produjo una vista previa. Consulta el estado y corrige el archivo.');
    const current = await request<ImportRecord>('GET', `${root}/imports/${job.resourceId}`);
    setRecord(current.data); setEtag(current.etag ?? result.etag);
    if (!current.data.previewId) {
      setPreview(null);
      setNotice(`Estado ${knownLabel(STATE_LABEL, current.data.state, 'no reconocido')}. No hay una vista previa confirmable.`);
      return;
    }
    const shown = await request<Preview>('GET', `${root}/imports/${current.data.id}/preview?previewId=${encodeURIComponent(current.data.previewId)}&limit=20`);
    setPreview(shown.data); confirmIntent.current = null;
    setNotice(shown.data.canConfirm ? 'Vista previa lista. Aún no se realizó la operación.' : 'La vista previa tiene observaciones. No está lista para confirmar.');
  }

  async function confirmLot() {
    if (!root || !record || !etag || !preview || !me.organizationId && scope === 'BUSINESS') throw new ApiError(409, 'IMPORT_STATE_CONFLICT', null, 'No hay una vista previa vigente.');
    if (record.mode === 'OPENING') throw new ApiError(409, 'IMPORT_STATE_CONFLICT', null, 'La apertura no se contabiliza desde este botón. El servidor conserva esa confirmación en la pantalla de apertura. Esta vista previa no es el asiento.');
    if (!preview.canConfirm || preview.errorCount > 0 || preview.deferredCount > 0) throw new ApiError(409, 'IMPORT_STATE_CONFLICT', null, 'Hay errores o diferidos. No se confirmó.');
    const bookPath = scope === 'PERSONAL' && bookId ? `/me/personal/books/${bookId}/wealth-s10/book?asOf=${todayBogota()}` : `/organizations/${me.organizationId}/wealth-s10/book?asOf=${todayBogota()}`;
    if (!confirmIntent.current) {
      const book = await request<unknown>('GET', bookPath);
      if (!book.etag) throw new ApiError(428, 'ETAG_REQUIRED', null, 'Falta la versión del libro. No se confirmó.');
      confirmIntent.current = { payload: { previewId: preview.id, semanticHash: preview.semanticHash, bookETag: book.etag }, etag };
    }
    const { payload, etag: originalETag } = confirmIntent.current;
    const operationId = scope === 'PERSONAL' ? 'confirmPersonalImport' : 'confirmBusinessImport';
    const pathParameters = scope === 'PERSONAL' && bookId ? { bookId, importId: record.id } : { organizationId: me.organizationId ?? '', importId: record.id };
    await guarded(JSON.stringify(['confirm', record.id, payload, originalETag]), async key => {
      const command = { operationId, idempotencyKey: key, pathParameters, payload, expectedETag: originalETag, ...(scope === 'PERSONAL' ? { bookId } : { organizationId: me.organizationId }) };
      await ensureStepUp({ purpose: 'IMPORT_CONFIRM', resourceId: record.id, command, summary: 'Confirmas el lote con el permiso de saldo ya definido. No otorga roles ni convierte un dato declarado en verificado.' });
      const result = await request<Receipt>('POST', `${root}/imports/${record.id}/confirmations`, payload, { idempotencyKey: key, ifMatch: originalETag });
      setReceipt(result.data); setPreview(null); confirmIntent.current = null; releaseHeld();
      const current = await request<ImportRecord>('GET', `${root}/imports/${record.id}`);
      setRecord(current.data); setEtag(current.etag);
      setNotice('El servidor confirmó el lote. Revisa el recibo y el estado; esta pantalla no recalcula saldos.');
    });
  }

  async function consult() {
    if (!root || !record) return;
    const current = await request<ImportRecord>('GET', `${root}/imports/${record.id}`);
    setRecord(current.data); setEtag(current.etag);
    const held = heldSignature() ?? '';
    if (['INVALID','CANCELLED','EXPIRED'].includes(current.data.state) || current.data.state === 'UPLOADED' && held.startsWith('["upload",') || current.data.state === 'READY' && held.startsWith('["preview",')) { releaseHeld(); confirmIntent.current = null; }
    if (current.data.receiptId) {
      const proof = await request<Receipt>('GET', `${root}/imports/${record.id}/receipt`);
      setReceipt(proof.data); setPreview(null); confirmIntent.current = null; releaseHeld();
      setNotice('Lote confirmado y recibo conciliado. No se reenvió la operación.'); return;
    }
    if (current.data.previewId) {
      try {
        const shown = await request<Preview>('GET', `${root}/imports/${current.data.id}/preview?previewId=${encodeURIComponent(current.data.previewId)}&limit=20`);
        setPreview(shown.data);
      } catch (caught) {
        setPreview(null);
        throw caught;
      }
    }
    setNotice(`Estado consultado: ${knownLabel(STATE_LABEL, current.data.state, 'no reconocido')}. No se reenvió el lote.`);
  }

  async function moreIssues() {
    if (!root || !record || !preview?.nextCursor) return;
    const id = preview.id;
    const next = await request<Preview>('GET', `${root}/imports/${record.id}/preview?previewId=${encodeURIComponent(id)}&limit=20&cursor=${encodeURIComponent(preview.nextCursor)}`);
    setPreview(current => current?.id === id ? { ...next.data, items: [...current.items, ...next.data.items] } : current);
  }
  async function listStored() {
    if (!root) return;
    const result = await request<{ items: ImportRecord[] }>('GET', `${root}/imports?limit=20`);
    setStored(result.data.items);
  }
  async function loadStored(id: string) {
    if (!root || heldUncertain()) return;
    const result = await request<ImportRecord>('GET', `${root}/imports/${id}`);
    const current = result.data;
    setRecord(current); setEtag(result.etag); setMode(current.mode); setNamespace(current.namespace);
    setPreview(null); setReceipt(null); setBytes(null); setFileLabel(''); confirmIntent.current = null; releaseHeld();
    if (current.receiptId) {
      setReceipt((await request<Receipt>('GET', `${root}/imports/${id}/receipt`)).data);
      setNotice('Recibo guardado recuperado. No se reenvió el lote.');
    } else if (current.mode === 'HISTORICAL_LINK') {
      setProfiles([{ ...EMPTY_PROFILE }]);
      setNotice('Lote recuperado. Selecciona explícitamente las cuentas por origen y genera una nueva vista previa antes de confirmar.');
    } else if (current.previewId) {
      setPreview((await request<Preview>('GET', `${root}/imports/${id}/preview?previewId=${encodeURIComponent(current.previewId)}&limit=20`)).data);
      setNotice('Vista previa guardada recuperada con su vigencia actual.');
    }
  }
  async function cancel() {
    if (!root || !record || !etag) return;
    await guarded(JSON.stringify(['cancel', record.id, etag]), async key => {
      const result = await request<ImportRecord>('POST', `${root}/imports/${record.id}/cancellations`, { reason: 'Cancelacion solicitada en esta sesion.' }, { idempotencyKey: key, ifMatch: etag });
      setRecord(result.data); setEtag(result.etag); setPreview(null);
      setNotice('El servidor canceló el lote no confirmado.');
    });
  }

  const limit = policy?.maxUploadBytes ?? 5242880;
  return (
    <Panel title="Importar y exportar" id="page-title">
      <Alert tone="pending">Uso local sintético. No habilitado para datos reales. Importar no otorga roles, no cambia la fórmula y no convierte un dato declarado en verificado. No habilita operaciones diferidas de activos.</Alert>
      <fieldset>
        <legend>Ámbito</legend>
        <div className="exchange-steps">
          {me.organizationId ? <label><input type="radio" name="ambito" checked={scope === 'BUSINESS'} onChange={() => setScope('BUSINESS')} /> Organización</label> : null}
          <label><input type="radio" name="ambito" checked={scope === 'PERSONAL'} onChange={() => setScope('PERSONAL')} disabled={personalState !== 'open'} /> Personal del titular</label>
          {consolidated || scope === 'CONSOLIDATED' ? <label><input type="radio" name="ambito" checked={scope === 'CONSOLIDATED'} onChange={() => setScope('CONSOLIDATED')} /> Consolidado privado</label> : null}
        </div>
      </fieldset>
      {scope === 'PERSONAL' && personalState === 'absent' ? <Alert tone="info">No hay libro personal en esta sesión. Ábrelo en Gastos y obligaciones. Esta pantalla no lo copia del negocio.</Alert> : null}
      {policy ? (
        <>
          <h2>Instrucciones de importación</h2>
          <ul className="exchange-note">
            <li>Versión de plantilla {TEMPLATE_VERSION}. Mapeo {MAPPING_VERSION}. Filas máximas {policy.maxRows}. Archivo máximo {limit} bytes (5 MiB). La vista previa dura {policy.previewTTLSeconds} segundos.</li>
            <li>Hojas: {SHEETS.join(', ')}. Fechas ISO. Importes con dos decimales y sin fórmula. El corte y los soportes salen del archivo; esta pantalla no los completa.</li>
            <li>Un archivo con error no se da por importado. Reemplazar el archivo, el modo, el espacio de nombres o la versión invalida la confirmación anterior.</li>
          </ul>
          {policy.templates && policy.templates.length > 0 ? (
            <div className="exchange-actions">
              {policy.templates.map(item => (
                <button key={item.id} type="button" onClick={async () => { try { const value = await templateBytes(item); if (!fence.active) return; saveBytes(item.filename, item.mediaType, value, 'template'); setNotice(`Plantilla ${item.templateVersion} descargada desde el servidor.`); } catch { setError(new ApiError(422, 'FILE_TYPE_REJECTED', null, 'La plantilla recibida no se pudo guardar con un nombre seguro.')); } }}>
                  Descargar {item.filename}
                </button>
              ))}
            </div>
          ) : <p>Este ámbito no recibe plantillas de importación.</p>}
        </>
      ) : <p role="status">Consultando la política del ámbito…</p>}
      {importing && policy ? (
        <form onSubmit={onSubmit(createLot, setPending, failed)}>
          <h2>Lote</h2>
          <Field label="Nombre del lote"><input value={label} disabled={pending || heldUncertain()} onChange={event => { setLabel(event.target.value); invalidate(); }} maxLength={120} required /></Field>
          <Field label="Espacio de nombres"><input value={namespace} disabled={pending || heldUncertain()} onChange={event => { setNamespace(event.target.value); invalidate(); }} required spellCheck={false} /></Field>
          <Field label="Modo">
            <select value={mode} disabled={pending || heldUncertain()} onChange={event => { setMode(event.target.value as ImportMode); invalidate(); }}>
              {policy.importModes.map(item => <option key={item} value={item}>{knownLabel(MODE_LABEL, item, 'Modo no reconocido')}</option>)}
            </select>
          </Field>
          <button className="primary" type="submit" disabled={pending} aria-busy={pending}>Crear lote</button>
        </form>
      ) : null}
      {importing ? <section aria-label="Lotes guardados">
        <button type="button" disabled={pending || heldUncertain()} onClick={() => { setPending(true); setError(null); void listStored().catch(failed).finally(() => setPending(false)); }}>Consultar lotes guardados</button>
        {stored.map(item => <p key={item.id}>{item.namespace} · {knownLabel(STATE_LABEL, item.state, 'Estado no reconocido')} <button type="button" disabled={pending || heldUncertain()} onClick={() => { setPending(true); setError(null); void loadStored(item.id).catch(failed).finally(() => setPending(false)); }}>Recuperar lote {item.id.slice(0, 8)}</button></p>)}
      </section> : null}
      {mode === 'HISTORICAL_LINK' && importing ? (<section><h2>Perfiles por origen histórico</h2>{profiles.map((profile, index) => (
        <fieldset key={index} disabled={pending || heldUncertain()}>
          <legend>Cuentas del enlace histórico</legend>
          <p>El servidor no infiere ingresos ni crédito. Indica las cuatro cuentas y la versión que ya existen, o déjalas vacías.</p>
          {([
            ['externalKey', 'Clave externa'],
            ['principalAccountId', 'Cuenta de principal'],
            ['interestReceivableAccountId', 'Cuenta de interés por cobrar'],
            ['interestIncomeAccountId', 'Cuenta de ingreso por interés'],
            ['borrowerCreditAccountId', 'Cuenta de crédito del prestatario'],
            ['principalAccountETag', 'Versión de principal'],
            ['interestReceivableAccountETag', 'Versión de interés por cobrar'],
            ['interestIncomeAccountETag', 'Versión de ingreso por interés'],
            ['borrowerCreditAccountETag', 'Versión de crédito del prestatario'],
          ] as const).map(([key, text]) => (
            <Field key={key} label={text}>
              <input value={profile[key]} onChange={event => { setProfiles(current => current.map((row, i) => i === index ? { ...row, [key]: event.target.value } : row)); invalidate(); }} autoComplete="off" spellCheck={false} />
            </Field>
          ))}
        </fieldset>))}<button type="button" disabled={pending || heldUncertain() || profiles.length >= 100} onClick={() => { setProfiles(rows => [...rows, { ...EMPTY_PROFILE }]); invalidate(); }}>Agregar otro origen histórico</button></section>
      ) : null}
      {record ? (
        <>
          <p role="status">Lote {knownLabel(STATE_LABEL, record.state, 'Estado no reconocido')}. Vence {record.expiresAt}. {record.mode === 'OPENING' ? 'La apertura no se contabiliza en este paso.' : null}</p>
          <Field label={`Archivo .xlsx, máximo ${limit} bytes`} hint={fileLabel ? `Seleccionado: ${fileLabel}` : 'Ningún archivo en memoria.'}>
            <input type="file" disabled={pending || heldUncertain()} accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={event => {
              const readId = ++fileRead.current;
              const file = event.target.files?.[0];
              event.currentTarget.value = '';
              if (!file) return;
              if (file.size > limit) {
                setBytes(null); setFileLabel(''); setPreview(null);
                setError(new ApiError(413, 'FILE_LIMIT_EXCEEDED', null, 'El archivo supera el límite visible del contrato. No se cargó.'));
                return;
              }
              void file.arrayBuffer().then(buffer => {
                if (!fence.active || readId !== fileRead.current) return;
                setBytes(new Uint8Array(buffer));
                setFileLabel(safeFileLabel(file.name));
                setPreview(null); setReceipt(null);
                setError(null);
              }).catch(() => setError(new ApiError(422, 'FILE_TYPE_REJECTED', null, 'No se pudo leer el archivo en esta sesión. No se cargó.')));
            }} />
          </Field>
          <div className="exchange-actions">
            <button type="button" disabled={pending || !bytes} onClick={() => { setError(null); setPending(true); void upload().catch(failed).finally(() => setPending(false)); }}>Cargar archivo</button>
            <button type="button" disabled={pending || !etag} onClick={() => { setError(null); setPending(true); void previewLot().catch(failed).finally(() => setPending(false)); }}>Generar vista previa</button>
            <button type="button" disabled={pending} onClick={() => { setError(null); setPending(true); void consult().catch(failed).finally(() => setPending(false)); }}>Consultar estado</button>
            <button type="button" disabled={pending || record.state === 'COMMITTED' || record.state === 'CANCELLED'} onClick={() => { setError(null); setPending(true); void cancel().catch(failed).finally(() => setPending(false)); }}>Cancelar lote</button>
          </div>
        </>
      ) : null}
      {preview ? (
        <section aria-labelledby="vista-previa-s11">
          <h2 id="vista-previa-s11">Vista previa, no es una operación realizada</h2>
          <p>{moneyLine(preview.totals)} Filas {preview.totalRows}. Errores {preview.errorCount}. Advertencias {preview.warningCount}. Diferidos {preview.deferredCount}. Comandos {preview.commandCount}. Vence {preview.expiresAt}.</p>
          {(preview.informationalHistory ?? []).map(item => <p key={item.id}>{item.date}. {item.description}. Queda como antecedente declarado.</p>)}
          <div className="exchange-table">
            <table>
              <caption>Observaciones por hoja, fila y celda</caption>
              <thead><tr><th>Hoja</th><th>Fila</th><th>Celda</th><th>Gravedad</th><th>Detalle</th></tr></thead>
              <tbody>
                {preview.items.map(issue => (
                  <tr key={`${issue.sheet}-${issue.cell}-${issue.code}`}>
                    <td>{issue.sheet}</td><td>{issue.row}</td><td>{issue.cell}</td>
                    <td>{knownLabel(SEVERITY_LABEL, issue.severity, 'Gravedad no reconocida')}</td>
                    <td>{knownLabel(ISSUE_LABEL, issue.code, 'El servidor señaló un código que esta pantalla no reconoce.')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.nextCursor ? <button type="button" disabled={pending} onClick={() => { setError(null); setPending(true); void moreIssues().catch(failed).finally(() => setPending(false)); }}>Ver más observaciones</button> : null}
          <button type="button" disabled={pending || !preview.canConfirm || record?.mode === 'OPENING' || preview.errorCount > 0 || preview.deferredCount > 0} onClick={() => { setError(null); setPending(true); void confirmLot().catch(failed).finally(() => setPending(false)); }}>
            Confirmar lote
          </button>
          {record?.mode === 'OPENING' && preview.canConfirm && preview.openingSnapshot && me.organizationId ? <ImportOpening key={preview.id} organizationId={me.organizationId} record={record} preview={preview} onCommitted={consult} /> : null}
          {!preview.canConfirm ? <Alert tone="pending">No se puede confirmar mientras el servidor reporte errores o diferidos.</Alert> : null}
        </section>
      ) : null}
      {receipt ? <p>Recibo {receipt.state}. Efectos {receipt.effectCount}. {moneyLine(receipt.totals)} El recibo no marca los soportes como verificados.</p> : null}
      {heldUncertain() ? <Alert tone="error">No se confirmó el resultado. Consulta el estado. El reintento usa la misma clave y el mismo cuerpo.</Alert> : null}
      <ErrorText error={error instanceof DiscardedRequest ? null : error} />
      {notice ? <Alert tone="info">{notice}</Alert> : null}
      {policy && root && policy.reportKinds.length > 0 ? <Reports key={root} root={root} policy={policy} /> : null}
    </Panel>
  );
}
