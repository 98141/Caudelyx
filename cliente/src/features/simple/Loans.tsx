import { useEffect, useState } from 'react';
import { call } from '../../shared/api';
import { ApiError, DiscardedRequest } from '../../shared/contracts';
import { parseLocalCop } from '../../shared/money';
import { borrowerLabel } from '../../shared/labels';
import { ensureStepUp } from '../../shared/step-up';
import { Empty, ErrorText, Field, onSubmit } from '../../shared/ui';
import { useSimple } from './context';
import { createSlot, keyFor } from './memory';
import { metricText, percentToRate, rateLabel } from './model';
import type { MappingList, MonthlyPortfolio, PreviewDocument, ReceiptDocument } from './types';
import { ScopeBar } from './Month';
import { bookUrl, concealed, cutQuery, msGet, postKnown } from './transport';
import { CashSelect, GrantNote, Money, More, PreviewBox,useBorrowerLabels } from './widgets';
import {IntegrationSetup,LoanControls} from './IntegrationSetup';

const draftSlot = createSlot();
const activateSlot = createSlot();

export function usePortfolio() {
  const simple = useSimple();
  const [page, setPage] = useState<MonthlyPortfolio | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => { setCursor(null); }, [simple.bookId, simple.month, simple.effectiveDate, simple.knownAt, simple.scope]);
  useEffect(() => {
    if (simple.scope !== 'BUSINESS' || !simple.bookId) { setPage(null); return; }
    const ac = new AbortController();
    let live = true;
    setLoading(true);
    setError(null);
    const query = cutQuery({ month: simple.month, effectiveDate: simple.effectiveDate, knownAt: simple.knownAt }, cursor);
    void msGet<MonthlyPortfolio>(bookUrl(simple.bookId, 'monthly-loans', query), ac.signal).then(result => {
      if (live) setPage(result.data);
    }).catch(caught => {
      if (!live || caught instanceof DiscardedRequest) return;
      setPage(null);
      setError(concealed(caught));
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; ac.abort(); };
  }, [simple.scope, simple.bookId, simple.month, simple.effectiveDate, simple.knownAt, cursor]);
  return { page, cursor, setCursor, error, loading };
}

export function LoansScreen() {
  const simple = useSimple();
  const portfolio = usePortfolio();
  return (
    <section className="simple-wrap" data-screen="prestamos">
      <h1 id="page-title" tabIndex={-1}>¿A quién presté y cuánto me deben?</h1>
      <ScopeBar />
      {simple.scope !== 'BUSINESS' ? <p>La cartera mensual de este contrato es del libro de negocio. Este ámbito no crea préstamos ni muestra la cartera de otro libro.</p> : null}
      {portfolio.loading ? <p role="status">Consultando préstamos…</p> : null}
      <ErrorText error={simple.viewError} />
      <ErrorText error={portfolio.error} />
      {portfolio.page ? <PortfolioTable page={portfolio.page} cursor={portfolio.cursor} onCursor={portfolio.setCursor} /> : null}
      {simple.scope === 'BUSINESS' && simple.bookId ? <><IntegrationSetup/><DraftForm/><LoanControls rows={portfolio.page?.rows??[]}/></> : null}
    </section>
  );
}

function PortfolioTable({ page, cursor, onCursor }: { page: MonthlyPortfolio; cursor: string | null; onCursor: (value: string | null) => void }) {
  const names=useBorrowerLabels(page.rows.map(r=>r.borrowerId));
  return (
    <>
      <div className="simple-table-wrap">
        <table className="simple-table">
          <caption>{page.nextCursor ? `Filas de esta página, ${page.rows.length} de ${page.totalCount}. El total de capital es el del filtro completo, no la suma visible.` : `Filtro completo, ${page.totalCount} préstamos.`}</caption>
          <thead>
            <tr><th>Cliente</th><th>Capital</th><th>Tasa</th><th>Interés esperado</th><th>Interés cobrado</th><th>Interés por crédito</th><th>Fecha</th><th>Atraso</th><th>Estado</th></tr>
          </thead>
          <tbody>
            {page.rows.map(row => (
              <tr key={row.id}>
                <td>{names[row.borrowerId]??'Consultando cliente…'}</td>
                <td className="num"><Money metric={row.principalOutstanding} /></td>
                <td className="num">{rateLabel(row.monthlyRate)}</td>
                <td className="num"><Money metric={row.interestExpected} /></td>
                <td className="num"><Money metric={row.interestCashCollected} /></td>
                <td className="num"><Money metric={row.interestSatisfiedByCredit} /></td>
                <td>{row.oldestUnpaidDueDate ?? 'Sin fecha de atraso'}</td>
                <td>{row.overduePeriodCount === null ? 'No disponible' : row.overduePeriodCount === 0 ? 'Sin atraso' : `${row.overduePeriodCount} ciclos`}</td>
                <td>{row.status === 'ACTIVE' ? 'Activo' : 'Saldado'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>Total de capital del filtro: {metricText(page.principalTotal)}. Total de interés esperado del filtro: {metricText(page.interestExpectedTotal)}. La tasa y el día no se totalizan.</p>
      {page.rows.length === 0 ? <Empty>No hay préstamos mensuales en este corte.</Empty> : null}
      {cursor ? <button type="button" onClick={() => onCursor(null)}>Volver a la primera página</button> : null}
      {page.nextCursor ? <button type="button" onClick={() => onCursor(page.nextCursor)}>Página siguiente</button> : null}
    </>
  );
}

function DraftForm() {
  const simple = useSimple();
  const [borrowers, setBorrowers] = useState<Array<{ id: string; borrowerCode: string; profile: { displayName: string } }>>([]);
  const [mappings, setMappings] = useState<MappingList | null>(null);
  const [borrowerId, setBorrowerId] = useState('');
  const [principal, setPrincipal] = useState('');
  const [rate, setRate] = useState('');
  const [firstDue, setFirstDue] = useState('');
  const [accountId, setAccountId] = useState('');
  const [anchorMode, setAnchorMode] = useState('');
  const [anchorDay, setAnchorDay] = useState('');
  const [mappingVersion, setMappingVersion] = useState('');
  const [support, setSupport] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [draftId, setDraftId] = useState('');
  const [loanEtag, setLoanEtag] = useState<string | null>(null);
  useEffect(() => {
    if (!simple.bookId) return;
    const ac = new AbortController();
    void call<{ items: Array<{ id: string; borrowerCode: string; profile: { displayName: string } }> }>('GET', `/organizations/${simple.organizationId}/borrowers?limit=20&status=ACTIVE`, undefined, { signal: ac.signal }).then(result => setBorrowers(result.data.items ?? [])).catch(() => setBorrowers([]));
    void msGet<MappingList>(bookUrl(simple.bookId, 'mappings/versions', cutQuery({ month: simple.month, effectiveDate: simple.effectiveDate, knownAt: simple.knownAt })), ac.signal).then(result => setMappings(result.data)).catch(() => setMappings(null));
    return () => ac.abort();
  }, [simple.bookId, simple.organizationId, simple.month, simple.effectiveDate, simple.knownAt]);
  return (
    <>
      <form className="simple-form" onSubmit={onSubmit(async () => {
        if (!simple.bookId) throw new ApiError(422, 'INPUT_INVALID', null, 'No hay libro de negocio.');
        const money = parseLocalCop(principal);
        const monthlyRate = percentToRate(rate);
        if (!borrowerId || !money || !monthlyRate || !accountId || !mappingVersion || !support.trim() || !anchorMode) {
          throw new ApiError(422, 'INPUT_INVALID', null, 'Faltan cliente, valor, tasa, fecha, cuenta, ancla, mapeo o soporte. No se completa ninguno por defecto.');
        }
        if (anchorMode === 'DAY_OF_MONTH' && !/^(?:[1-9]|[12]\d|3[01])$/.test(anchorDay)) throw new ApiError(422, 'INPUT_INVALID', null, 'Indica el día del mes, del 1 al 31.');
        const body = {
          modality: 'MONTHLY_OPEN_V1',
          borrowerId,
          principal: money,
          monthlyRate,
          effectiveDate: simple.effectiveDate,
          firstDueDate: firstDue,
          anchor: anchorMode === 'END_OF_MONTH' ? { mode: 'END_OF_MONTH' } : { mode: 'DAY_OF_MONTH', day: Number(anchorDay) },
          cashAccountId: accountId,
          mappingVersion,
          supportReference: support.trim(),
          usage: 'LOCAL_SYNTHETIC',
        };
        const key = keyFor(draftSlot, JSON.stringify(body));
        const result = await postKnown<{ id: string }>(draftSlot, key, bookUrl(simple.bookId, 'monthly-loans'), body, undefined, undefined, 'finish');
        setDraftId(result.data.id);
        setLoanEtag(result.etag);
        simple.refreshCut();
      }, setPending, setError)}>
        <h2>Nuevo préstamo mensual</h2>
        <p>Modalidad mensual abierta, uso local sintético. No es una tasa legal ni un préstamo con cuotas fijas.</p>
        <ErrorText error={error} />
        <Field label="Cliente" hint="Nombre o código ya registrado.">
          <select value={borrowerId} onChange={event => setBorrowerId(event.target.value)} required>
            <option value="">Selecciona</option>
            {borrowers.map(item => <option key={item.id} value={item.id}>{borrowerLabel(item.borrowerCode, item.profile.displayName)}</option>)}
          </select>
        </Field>
        <Field label="Valor" hint="Dinero que entregaste. Ejemplo 2.000.000."><input inputMode="decimal" value={principal} onChange={event => setPrincipal(event.target.value)} required /></Field>
        <Field label="Interés mensual" hint="Por cada millón, 30.000 por ciclo al 3 %. Es un ejemplo sintético, no una tasa legal. El campo no trae un 3 escrito."><input inputMode="decimal" value={rate} onChange={event => setRate(event.target.value)} required /></Field>
        <Field label="Fecha en que ocurre"><input type="date" value={simple.effectiveDate} onChange={event => simple.setEffectiveDate(event.target.value)} required /></Field>
        <Field label="Primera fecha de cobro"><input type="date" value={firstDue} onChange={event => setFirstDue(event.target.value)} required /></Field>
        <CashSelect base={`/organizations/${simple.organizationId}/financial`} value={accountId} onChange={setAccountId} />
        <More label="Más opciones del préstamo">
          <Field label="Ancla del ciclo">
            <select value={anchorMode} onChange={event => setAnchorMode(event.target.value)} required>
              <option value="">Selecciona</option>
              <option value="DAY_OF_MONTH">Un día del mes</option>
              <option value="END_OF_MONTH">Fin de mes</option>
            </select>
          </Field>
          {anchorMode === 'DAY_OF_MONTH' ? <Field label="Día"><input inputMode="numeric" value={anchorDay} onChange={event => setAnchorDay(event.target.value)} required /></Field> : null}
          <Field label="Mapeo de cuentas" hint="Sale del servidor. Si no hay uno, no se inventa.">
            <select value={mappingVersion} onChange={event => setMappingVersion(event.target.value)} required>
              <option value="">Selecciona</option>
              {(mappings?.rows ?? []).map(row => <option key={`${row.id}:${row.version}`} value={`${row.id}:${row.version}`}>Versión {row.version}</option>)}
            </select>
          </Field>
          <Field label="Soporte"><input value={support} onChange={event => setSupport(event.target.value)} required /></Field>
        </More>
        <button type="submit" disabled={pending}>Guardar borrador</button>
        {draftId ? <p role="status">Borrador guardado. Todavía no salió el dinero. Puedes activarlo abajo.</p> : null}
      </form>
      {draftId && simple.bookId ? <Activate loanId={draftId} loanEtag={loanEtag} bookId={simple.bookId} bookEtag={simple.bookEtag} support={support} /> : null}
    </>
  );
}

function Activate({ loanId, loanEtag, bookId, bookEtag, support }: { loanId: string; loanEtag: string | null; bookId: string; bookEtag: string | null; support: string }) {
  const simple = useSimple();
  const [consent, setConsent] = useState('');
  const [preview, setPreview] = useState<PreviewDocument | null>(null);
  const [receipt, setReceipt] = useState<ReceiptDocument | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => { setPreview(null); }, [simple.cutSerial]);
  return (
    <form className="simple-form" onSubmit={onSubmit(async () => {
      if (!loanEtag || !bookEtag) throw new ApiError(428, 'ETAG_REQUIRED', null, 'Falta la versión del borrador o del libro.');
      if (consent !== 'yes' && consent !== 'no') throw new ApiError(422, 'INPUT_INVALID', null, 'Indica si aceptas el mandato. No queda marcado solo.');
      const intent = { expectedBookETag: bookEtag, effectiveDate: simple.effectiveDate, expectedLoanETag: loanEtag, mandateConsent: consent === 'yes', originReference: support.trim() };
      if (!support.trim()) throw new ApiError(422, 'INPUT_INVALID', null, 'Falta el soporte del borrador.');
      const key = keyFor(activateSlot, JSON.stringify(intent));
      if (!preview) {
        const result = await postKnown<PreviewDocument>(activateSlot, key, bookUrl(bookId, `monthly-loans/${loanId}/activation-previews`), { ...intent, executionKey: key }, loanEtag, undefined, 'keep');
        setPreview(result.data);
        return;
      }
      if (preview.status !== 'READY' || Date.parse(preview.expiresAt) <= Date.now()) throw new ApiError(412, 'PRECONDITION_FAILED', null, 'La vista previa no se puede confirmar. Pide otra.');
      await ensureStepUp({ purpose: 'MS_MONTHLY_ACTIVATE', resourceId: loanId, command: { operationId: 'msCommitActivation', bookId, payload: { executionKey: key, previewToken: preview.previewToken, requestHash: preview.requestHash } }, summary: 'Activar el préstamo entrega el dinero.' });
      const result = await postKnown<ReceiptDocument>(activateSlot, key, bookUrl(bookId, `monthly-loans/${loanId}/activations`), { executionKey: key, previewToken: preview.previewToken, requestHash: preview.requestHash }, loanEtag, undefined, 'finish');
      setReceipt(result.data);
      simple.refreshCut();
      setPreview(null);
    }, setPending, setError)}>
      <h2>Activar borrador</h2>
      <GrantNote />
      <ErrorText error={error} />
      <Field label="Mandato de interés">
        <select value={consent} onChange={event => { setConsent(event.target.value); setPreview(null); }} required>
          <option value="">Selecciona</option>
          <option value="yes">Acepto el mandato de este préstamo</option>
          <option value="no">Sin mandato automático</option>
        </select>
      </Field>
      {preview ? <PreviewBox preview={preview} /> : null}
      <button type="submit" disabled={pending||!loanEtag||!bookEtag}>{preview ? 'Confirmar entrega' : 'Ver la entrega antes de guardar'}</button>
      {receipt ? <p role="status">Estado {receipt.status === 'CONFIRMED' ? 'confirmado' : receipt.status === 'PENDING_APPROVAL' ? 'pendiente de aprobación' : 'provisional'}. No es un éxito silencioso si no está confirmado.</p> : null}
    </form>
  );
}
