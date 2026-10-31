import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, DiscardedRequest } from '../../shared/contracts';
import { ensureStepUp } from '../../shared/step-up';
import { Alert, ErrorText } from '../../shared/ui';
import { OPENING_POLICY_VERSION, CATEGORY_LABEL, STATUS_LABEL, type Snapshot } from '../opening/draft';
import { knownLabel } from './copy';
import { viewCall } from './intent';
import { claimKey, isUncertain, markUncertain, releaseHeld } from './memory';
import type { ImportRecord, Preview } from './types';

interface Opening {
 id: string; status: string; snapshot: Snapshot;
 validation: { id: string; fingerprint: string; report: { issues: unknown[]; totals: { balanceDifference: string; ledgerDifference: string } } } | null;
 commit: { journalId: string } | null;
}
interface Intent { purpose: string; path: string; payload: object; expected?: string; resourceId?: string; key: string }

export function ImportOpening({ organizationId, record, preview, onCommitted }: {
 organizationId: string; record: ImportRecord; preview: Preview; onCommitted: () => Promise<void>;
}) {
 const [opening, setOpening] = useState<Opening | null>(null), [etag, setEtag] = useState<string | null>(null);
 const [pending, setPending] = useState(false), [approved, setApproved] = useState(false), [confirmed, setConfirmed] = useState(false);
 const [error, setError] = useState<unknown>(null), [uncertain, setUncertain] = useState(false);
 const held = useRef<Intent | null>(null), fence = useMemo(() => ({ active: true }), []), request = viewCall(fence);
 useEffect(() => { fence.active = true; return () => { fence.active = false; }; }, [fence]);
 const base = `/organizations/${organizationId}/financial/opening-files`, snapshot = preview.openingSnapshot as Snapshot;
 const validation = opening?.validation;
 const balanced = validation && validation.report.issues.length === 0 && validation.report.totals.balanceDifference === '0.00' && validation.report.totals.ledgerDifference === '0.00';

 async function send(intent: Intent) {
  await ensureStepUp({ purpose: intent.purpose, resourceId: intent.resourceId,
   command: { organizationId, idempotencyKey: intent.key, payload: intent.payload, ...(intent.expected ? { expectedETag: intent.expected } : {}) },
   summary: intent.purpose === 'OPENING_COMMIT' ? 'Confirmar una única apertura con los saldos revisados.' : 'Continuar la apertura importada, sin publicar todavía el asiento.' });
  if (!fence.active) throw new DiscardedRequest();
  const result = await request<Opening | { opening: Opening }>('POST', intent.path, intent.payload, { idempotencyKey: intent.key, ifMatch: intent.expected });
  const next = 'opening' in result.data ? result.data.opening : result.data;
  setOpening(next); setEtag(result.etag); setUncertain(false); held.current = null; releaseHeld();
  if (next.status === 'POSTED') await onCommitted();
 }
 async function execute(purpose: string, suffix: string, payload: object, resourceId?: string) {
  setPending(true); setError(null);
  try {
   if (held.current) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', null, 'Primero consulta o reintenta la solicitud pendiente.');
   const path = resourceId ? `${base}/${resourceId}/${suffix}` : base;
   const expected = resourceId ? etag ?? undefined : undefined;
   const key = claimKey(JSON.stringify([purpose, path, expected, payload]));
   held.current = { purpose, path, payload: structuredClone(payload), resourceId, expected, key };
   await send(held.current);
  } catch (caught) {
   if (!fence.active) return;
   if (isUncertain(caught)) { markUncertain(); setUncertain(true); }
   else { held.current = null; releaseHeld(); }
   setError(caught);
  } finally { if (fence.active) setPending(false); }
 }
 async function retry() {
  if (!held.current) return;
  setPending(true); setError(null);
  try { await send(held.current); } catch (caught) { if (fence.active) setError(caught); }
  finally { if (fence.active) setPending(false); }
 }
 async function consult() {
  if (!opening) return;
  setPending(true); setError(null);
  try {
   const current = await request<Opening>('GET', `${base}/${opening.id}`);
   setOpening(current.data); setEtag(current.etag);
   if (current.data.status === 'POSTED') { held.current = null; releaseHeld(); setUncertain(false); await onCommitted(); }
  } catch (caught) { if (fence.active) setError(caught); }
  finally { if (fence.active) setPending(false); }
 }
 const binding = validation ? { validationId: validation.id, validationFingerprint: validation.fingerprint } : null;
 return <section aria-labelledby="apertura-importada">
  <h3 id="apertura-importada">Confirmación de apertura importada</h3>
  <p>Revisa el corte y los saldos. Guardar, validar y aprobar preparan la apertura; solo el último paso publica el asiento. El libro debe seguir siendo elegible.</p>
  <p>Corte: {snapshot.cutoffDate}. Activos {preview.totals.assets}. Pasivos {preview.totals.liabilities}. Patrimonio {preview.totals.equity}. Diferencia {preview.totals.difference}.</p>
  <div className="exchange-table"><table><caption>Componentes de la apertura revisada</caption><thead><tr><th>Tipo</th><th>Cuenta</th><th>Importe</th></tr></thead><tbody>{snapshot.components.map((value, i) => {
   const row = value as { category: string; accountId: string; amount: string };
   return <tr key={i}><td>{knownLabel(CATEGORY_LABEL,row.category,'Componente')}</td><td>{row.accountId}</td><td>{row.amount}</td></tr>;
  })}</tbody></table></div>
  <ul aria-label="Soportes de la apertura">{snapshot.supports.map((value,i)=>{const row=value as {reference:string;asOfDate:string;declaration:string};return <li key={i}>{row.reference} · {row.asOfDate} · {row.declaration === 'OWNER_CHECKED' ? 'Comprobado por el titular' : 'Declarado'}</li>;})}</ul>
  <button type="button" disabled={pending || !!opening || uncertain} onClick={() => void execute('OPENING_CREATE', '', { snapshot })}>Guardar apertura importada</button>
  {opening ? <>
   <p role="status">Apertura {knownLabel(STATUS_LABEL,opening.status,'Estado no reconocido')}. {opening.commit ? `Asiento ${opening.commit.journalId}` : 'Sin asiento publicado.'}</p>
   <button type="button" disabled={pending || uncertain || !['DRAFT', 'VALIDATED'].includes(opening.status)} onClick={() => void execute('OPENING_VALIDATE', 'validations', { policyVersion: OPENING_POLICY_VERSION }, opening.id)}>Validar apertura importada</button>
   <label><input type="checkbox" checked={approved} disabled={pending || uncertain} onChange={e => setApproved(e.target.checked)} /> Revisé las cuentas, el corte y los soportes de la apertura.</label>
   <button type="button" disabled={pending || uncertain || !approved || !balanced || opening.status !== 'VALIDATED'} onClick={() => binding && void execute('OPENING_APPROVE', 'approval', binding, opening.id)}>Aprobar apertura importada</button>
   <label><input type="checkbox" checked={confirmed} disabled={pending || uncertain} onChange={e => setConfirmed(e.target.checked)} /> Confirmo publicar una única apertura por estos saldos.</label>
   <button type="button" disabled={pending || uncertain || !confirmed || opening.status !== 'APPROVED' || !binding} onClick={() => binding && void execute('OPENING_COMMIT', 'commit', { ...binding, importBridge: { importId: record.id, previewId: preview.id, semanticHash: preview.semanticHash, openingId: opening.id, validationId: binding.validationId, openingFingerprint: binding.validationFingerprint } }, opening.id)}>Contabilizar apertura importada</button>
   <button type="button" disabled={pending} onClick={() => void consult()}>Consultar apertura importada</button>
  </> : null}
  {uncertain ? <><Alert tone="pending">El resultado es incierto. El reintento conserva la misma solicitud y clave.</Alert><button type="button" disabled={pending} onClick={() => void retry()}>Reintentar solicitud de apertura</button></> : null}
  <ErrorText error={error instanceof DiscardedRequest ? null : error} />
 </section>;
}
