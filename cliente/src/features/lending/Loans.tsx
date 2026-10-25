import { useEffect, useRef, useState } from 'react';
import { AccountPicker } from '../finance/account-picker';
import { call, reauthenticate } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { ApiError, isStrong } from '../../shared/contracts';
import { accountLabel, borrowerLabel } from '../../shared/labels';
import { bindCommand, formatCop, releaseCommand, type CommandBinding } from '../../shared/money';
import { Alert, Empty, ErrorText, Field, Panel, StepFields, Submit, onSubmit } from '../../shared/ui';
import { percentToRate, principalFromLocal, rateToPercent } from './rate';

interface Policy { policyVersion: string; jurisdiction: string; usage: string; methods: string[]; frequencies: string[]; legalStatus: string; realUseAllowed: false; quoteTtlSeconds: number }
interface Borrower { id: string; borrowerCode: string; status: string; profile: { displayName: string } }
interface Row { k: number; date: string; openingPrincipal: string; principal: string; interest: string; payment: string; closingPrincipal: string }
interface Totals { principal: string; interest: string; payment: string }
interface Quote {
  id: string; expiresAt: string; fingerprint: string; schedule: Row[]; totals: Totals;
  periodicRate24: string; basePayment: string | null; finalPaymentAdjustment: string;
  policyVersion: string; mathVersion: string; calendarVersion: string;
}
interface Terms { borrowerId: string; plannedFundingAccountId: string; principal: string; effectiveDate: string; firstDueDate: string; installmentCount: number; method: string; frequency: string; rate: { type: string; unit: string; value: string; compoundingPeriodsPerYear?: number }; note?: string; documents?: { reference: string; label: string; kind: string }[] }
interface Version { termsVersion: number; terms: Terms; calculation: Omit<Quote, 'id' | 'expiresAt' | 'fingerprint'>; changeReason?: string }
interface Loan { id: string; status: 'DRAFT' | 'TERMS_CONFIRMED' | 'CANCELLED'; version: number; termsVersion: number; borrowerId: string; quoteFingerprint: string; quoteId?: string; terms?: Terms; calculation?: Version['calculation'] }
interface Page<T> { items: T[]; nextCursor?: string | null }

const METHOD: Record<string, string> = { CONSTANT_PRINCIPAL: 'Capital uniforme', LEVEL_PAYMENT: 'Cuota nivelada', INTEREST_ONLY: 'Solo intereses' };
const FREQUENCY: Record<string, string> = { DAY: 'Día', WEEK: 'Semana', FIFTEEN_DAYS: 'Quince días', SEMIMONTH: 'Quincena', MONTH: 'Mes', YEAR: 'Año' };
const STATUS: Record<Loan['status'], string> = { DRAFT: 'Borrador', TERMS_CONFIRMED: 'Términos confirmados', CANCELLED: 'Cancelado' };
const blank = { borrowerId: '', accountId: '', principal: '', method: '', frequency: '', rateType: '', rateUnit: '', rate: '', periods: '', effective: '', firstDue: '', count: '', reason: '' };

function money(value: string): string {
  return formatCop(value) ? `${formatCop(value)} COP` : value;
}

function command(organizationId: string, key: string, payload: unknown, etag?: string) {
  return { organizationId, idempotencyKey: key, payload, ...(etag ? { expectedETag: etag } : {}) };
}

export function LoansScreen() {
  const { me } = useAuth();
  const organizationId = me?.organizationId ?? '';
  const base = `/organizations/${organizationId}`;
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [borrowers, setBorrowers] = useState<Borrower[]>([]);
  const [borrowerName, setBorrowerName] = useState('Prestatario no disponible');
  const [accountName, setAccountName] = useState('');
  const [form, setForm] = useState(blank);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [borrowerCursor, setBorrowerCursor] = useState<string | null>(null);
  const [loanCursor, setLoanCursor] = useState<string | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [versionCursor, setVersionCursor] = useState<string | null>(null);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [loan, setLoan] = useState<Loan | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [confirmReady, setConfirmReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [password, setPassword] = useState('');
  const [stepCode, setStepCode] = useState('');
  const shownQuote = useRef<Quote | null>(null);
  const quoteKey = useRef<CommandBinding | null>(null);
  const saveKey = useRef<CommandBinding | null>(null);
  const selection = useRef(0);
  const strong = isStrong(me);

  function edit(patch: Partial<typeof blank>) {
    if (shownQuote.current) setNotice('La simulación anterior quedó obsoleta. Pide el cronograma otra vez.');
    shownQuote.current = null;
    setForm(current => ({ ...current, ...patch }));
    setQuote(null);
    setConfirmReady(false);
    releaseCommand(quoteKey);
  }

  useEffect(() => {
    if (!strong || !organizationId) return;
    void call<Policy>('GET', `${base}/lending-policy`).then(result => setPolicy(result.data)).catch(setError);
    void call<Page<Borrower>>('GET', `${base}/borrowers?limit=20&status=ACTIVE`).then(result => { setBorrowers(result.data.items); setBorrowerCursor(result.data.nextCursor ?? null); }).catch(setError);
    void call<Page<Loan>>('GET', `${base}/loans?limit=20`).then(result => { setLoans(result.data.items); setLoanCursor(result.data.nextCursor ?? null); }).catch(setError);
  }, [strong, organizationId, base]);

  useEffect(() => {
    const found = borrowers.find(item => item.id === form.borrowerId);
    if (found) { setBorrowerName(borrowerLabel(found.borrowerCode, found.profile.displayName)); return; }
    if (!form.borrowerId) { setBorrowerName('Elige un prestatario'); return; }
    let live = true;
    void call<Borrower>('GET', `${base}/borrowers/${form.borrowerId}`).then(result => {
      if (live) setBorrowerName(borrowerLabel(result.data.borrowerCode, result.data.profile.displayName));
    }).catch(() => { if (live) setBorrowerName('Prestatario no disponible'); });
    return () => { live = false; };
  }, [form.borrowerId, borrowers, base]);

  useEffect(() => {
    if (!form.accountId) { setAccountName(''); return; }
    let live = true;
    void accountLabel(`${base}/financial`, form.accountId).then(label => { if (live) setAccountName(label); });
    return () => { live = false; };
  }, [form.accountId, base]);

  async function loadVersions(id: string, next?: string, request = selection.current) {
    const result = await call<Page<Version>>('GET', `${base}/loans/${id}/versions?limit=20${next ? '&cursor=' + encodeURIComponent(next) : ''}`);
    if (request !== selection.current) return;
    setVersions(result.data.items); setVersionCursor(result.data.nextCursor ?? null);
  }
  async function loadLoans(next?: string) {
    const result = await call<Page<Loan>>('GET', `${base}/loans?limit=20${next ? '&cursor=' + encodeURIComponent(next) : ''}`);
    setLoans(result.data.items); setLoanCursor(result.data.nextCursor ?? null);
  }
  async function loadBorrowers(next: string) {
    const result = await call<Page<Borrower>>('GET', `${base}/borrowers?limit=20&status=ACTIVE&cursor=${encodeURIComponent(next)}`);
    setBorrowers(current => [...new Map([...current, ...result.data.items].map(item => [item.id, item])).values()]);
    setBorrowerCursor(result.data.nextCursor ?? null);
  }
  function reset() {
    selection.current++;
    shownQuote.current = null; setLoan(null); setEtag(null); setQuote(null); setConfirmReady(false);
    setForm(blank); setVersions([]); setVersionCursor(null); setNotice(null); setPassword(''); setStepCode('');
    releaseCommand(saveKey); releaseCommand(quoteKey);
  }
  async function openLoan(id: string) {
    const request = ++selection.current;
    setPending(true); setVersions([]); setVersionCursor(null); setError(null);
    try {
    const result = await call<Loan>('GET', `${base}/loans/${id}`);
    if (request !== selection.current) return;
    const saved = result.data;
    setLoan(saved); setEtag(result.etag); setConfirmReady(false); setQuote(null); shownQuote.current = null;
    setPassword(''); setStepCode(''); releaseCommand(saveKey); releaseCommand(quoteKey);
    if (saved.terms) {
      const t = saved.terms;
      setForm({ ...blank, borrowerId: t.borrowerId, accountId: t.plannedFundingAccountId, principal: formatCop(t.principal) ?? '', method: t.method, frequency: t.frequency, rateType: t.rate.type, rateUnit: t.rate.unit, rate: rateToPercent(t.rate.value), periods: String(t.rate.compoundingPeriodsPerYear ?? ''), effective: t.effectiveDate, firstDue: t.firstDueDate, count: String(t.installmentCount) });
      if (saved.quoteId && saved.calculation) {
        const stored = await call<Quote>('GET', `${base}/loan-quotes/${saved.quoteId}`);
        if (request !== selection.current) return;
        shownQuote.current = stored.data; setQuote(stored.data);
      }
    }
    await loadVersions(id, undefined, request);
    } finally { if (request === selection.current) setPending(false); }
  }
  async function saved(result: { data: Loan; etag: string | null }) {
    setLoan(result.data); setEtag(result.etag); setConfirmReady(false); releaseCommand(saveKey);
    await loadLoans(); await loadVersions(result.data.id);
  }
  function stale(caught: unknown) {
    if (caught instanceof ApiError && ['QUOTE_STALE', 'QUOTE_EXPIRED', 'QUOTE_BINDING_MISMATCH', 'QUOTE_ALREADY_USED'].includes(caught.code)) {
      shownQuote.current = null; setQuote(null); setConfirmReady(false);
      setNotice('La simulación anterior quedó obsoleta. Pide el cronograma otra vez.');
    }
  }

  function terms() {
    if (!policy) throw new ApiError(422, 'POLICY_UNSUPPORTED', null, 'La política todavía no llegó. No se simula con valores supuestos.');
    const principal = principalFromLocal(form.principal);
    const rate = percentToRate(form.rate);
    const count = Number(form.count);
    if (!form.borrowerId || !form.accountId || !principal || !rate || !form.method || !form.frequency || !form.rateType || !form.rateUnit || !form.effective || !form.firstDue || !Number.isInteger(count) || count < 1 || count > 360) {
      throw new ApiError(422, 'INPUT_INVALID', null, 'Faltan condiciones o el formato no es válido. No se inventó ningún valor.');
    }
    const rateBody = form.rateType === 'NOMINAL_ANNUAL'
      ? { type: 'NOMINAL_ANNUAL', value: rate, unit: 'YEAR', compoundingPeriodsPerYear: Number(form.periods) }
      : { type: 'EFFECTIVE', value: rate, unit: form.rateUnit };
    if (form.rateType === 'NOMINAL_ANNUAL' && (!Number.isInteger(Number(form.periods)) || Number(form.periods) < 1 || Number(form.periods) > 366)) {
      throw new ApiError(422, 'INPUT_INVALID', null, 'La tasa nominal pide los períodos de capitalización. No hay un número supuesto.');
    }
    return {
      borrowerId: form.borrowerId,
      plannedFundingAccountId: form.accountId,
      principal,
      effectiveDate: form.effective,
      firstDueDate: form.firstDue,
      installmentCount: count,
      method: form.method,
      frequency: form.frequency,
      rate: rateBody,
      calendarConvention: 'PERIODIC_FIXED',
      holidayAdjustment: 'NO_SHIFT',
      policyVersion: policy.policyVersion,
      jurisdiction: policy.jurisdiction,
      usage: policy.usage,
      ...(loan?.terms?.note !== undefined ? { note: loan.terms.note } : {}),
      ...(loan?.terms?.documents !== undefined ? { documents: loan.terms.documents } : {}),
    };
  }

  async function prove(purpose: string, payload: unknown, resourceId?: string, match?: string) {
    const binding = bindCommand(saveKey, JSON.stringify([purpose, resourceId ?? '', match ?? '', payload]));
    await reauthenticate({ password, purpose, ...(resourceId ? { resourceId } : {}), command: command(organizationId, binding.idempotencyKey, payload, match), code: stepCode });
    setPassword(''); setStepCode('');
    return binding.idempotencyKey;
  }

  if (!strong || !organizationId) return <Panel title="Préstamos" id="page-title"><p>Hace falta una sesión de la organización. No se consulta ni se simula un préstamo.</p></Panel>;

  return (
    <Panel title="Préstamos" id="page-title">
      <Alert tone="pending">Simulación y términos locales. Guardar no desembolsa, no cobra y no crea saldo.</Alert>
      {policy ? <p>Política {policy.policyVersion}. Vigencia de la cotización: {policy.quoteTtlSeconds} segundos. {policy.legalStatus === 'NOT_REVIEWED_FOR_REAL_USE' || policy.realUseAllowed === false ? 'Esta política no autoriza un préstamo real.' : ''}</p> : <p role="status">Cargando la política…</p>}
      <ErrorText error={error} />
      {pending ? <p role="status">Procesando la selección o el comando…</p> : null}
      <button type="button" disabled={pending} onClick={reset}>Preparar un borrador nuevo</button>
      <form onSubmit={onSubmit(async () => {
        const payload = { terms: terms() };
        const binding = bindCommand(quoteKey, JSON.stringify(payload));
        const result = await call<Quote>('POST', `${base}/loan-quotes`, payload, { idempotencyKey: binding.idempotencyKey });
        shownQuote.current = result.data;
        setQuote(result.data);
        setNotice(null);
        setConfirmReady(false);
      }, setPending, setError)}>
        <fieldset disabled={pending}>
        <legend>Condiciones para cotizar</legend>
        <Field label="Prestatario">
          <select value={form.borrowerId} required disabled={!!loan} onChange={event => edit({ borrowerId: event.target.value })}>
            <option value="">Elige</option>
            {form.borrowerId && !borrowers.some(item => item.id === form.borrowerId) ? <option value={form.borrowerId}>{borrowerName}</option> : null}
            {borrowers.map(item => <option key={item.id} value={item.id}>{borrowerLabel(item.borrowerCode, item.profile.displayName)}</option>)}
          </select>
        </Field>
        {borrowerCursor ? <button type="button" onClick={() => void loadBorrowers(borrowerCursor).catch(setError)}>Más prestatarios</button> : null}
        <p>{borrowerName}</p>
        <AccountPicker base={`${base}/financial`} label="Cuenta prevista de desembolso" value={form.accountId} accountClass="ASSET" kinds={['CASH', 'BANK']} status="ACTIVE" onChange={accountId => edit({ accountId })} />
        {accountName ? <p>{accountName}</p> : null}
        <Field label="Capital" hint="Pesos colombianos, por ejemplo 1.000,50. No hay un capital de ejemplo."><input value={form.principal} inputMode="decimal" required onChange={event => edit({ principal: event.target.value })} /></Field>
        <Field label="Modalidad">
          <select value={form.method} required onChange={event => edit({ method: event.target.value })}>
            <option value="">Elige</option>
            {(policy?.methods ?? []).filter(method => METHOD[method]).map(method => <option key={method} value={method}>{METHOD[method]}</option>)}
          </select>
        </Field>
        <Field label="Frecuencia de la cuota">
          <select value={form.frequency} required onChange={event => edit({ frequency: event.target.value })}>
            <option value="">Elige</option>
            {(policy?.frequencies ?? []).filter(item => FREQUENCY[item]).map(item => <option key={item} value={item}>{FREQUENCY[item]}</option>)}
          </select>
        </Field>
        <Field label="Clase de tasa">
          <select value={form.rateType} required onChange={event => edit({ rateType: event.target.value, rateUnit: event.target.value === 'NOMINAL_ANNUAL' ? 'YEAR' : '' })}>
            <option value="">Elige</option>
            <option value="EFFECTIVE">Efectiva</option>
            <option value="NOMINAL_ANNUAL">Nominal anual</option>
          </select>
        </Field>
        <Field label="Unidad de la tasa">
          <select value={form.rateUnit} required disabled={form.rateType === 'NOMINAL_ANNUAL'} onChange={event => edit({ rateUnit: event.target.value })}>
            <option value="">Elige</option>
            {(form.rateType === 'NOMINAL_ANNUAL' ? ['YEAR'] : ['DAY', 'WEEK', 'FIFTEEN_DAYS', 'SEMIMONTH', 'MONTH', 'YEAR']).map(unit => <option key={unit} value={unit}>{FREQUENCY[unit]}</option>)}
          </select>
        </Field>
        <Field label="Tasa en porcentaje" hint="Por ejemplo 12 o 12,5. Cero se escribe 0. No hay una tasa guardada de antemano."><input value={form.rate} inputMode="decimal" required onChange={event => edit({ rate: event.target.value })} /></Field>
        {form.rateType === 'NOMINAL_ANNUAL' ? <Field label="Períodos de capitalización al año"><input value={form.periods} inputMode="numeric" required onChange={event => edit({ periods: event.target.value })} /></Field> : null}
        <Field label="Fecha de inicio"><input type="date" value={form.effective} required onChange={event => edit({ effective: event.target.value })} /></Field>
        <Field label="Fecha de la primera cuota"><input type="date" value={form.firstDue} required onChange={event => edit({ firstDue: event.target.value })} /></Field>
        <Field label="Número de cuotas"><input value={form.count} inputMode="numeric" required onChange={event => edit({ count: event.target.value })} /></Field>
        <p className="muted">Calendario fijo y sin mover festivos, como admite esta política. La cotización es una simulación: no hay saldo ni desembolso.</p>
        <Submit pending={pending} disabled={!policy || loan?.status === 'CANCELLED'}>Ver cronograma</Submit>
        </fieldset>
      </form>
      {notice ? <Alert tone="pending">{notice}</Alert> : null}
      {quote ? (
        <section aria-label="Cronograma simulado">
          <h2>Simulación</h2>
          <Alert tone="info">Simulación. No hay saldo ni desembolso. Vence {new Date(quote.expiresAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}.</Alert>
          <p>Política {quote.policyVersion}. Cálculo {quote.mathVersion}. Calendario {quote.calendarVersion}. Ajuste de la última cuota {money(quote.finalPaymentAdjustment)}.</p>
          <p>Capital {money(quote.totals.principal)}. Interés {money(quote.totals.interest)}. Cuotas {money(quote.totals.payment)}.</p>
          <div className="schedule">
            <table>
              <thead><tr><th>Cuota</th><th>Fecha</th><th>Saldo inicial</th><th>Capital</th><th>Interés</th><th>Cuota</th><th>Saldo final</th></tr></thead>
              <tbody>{quote.schedule.map(row => (
                <tr key={row.k}><td>{row.k}</td><td>{row.date}</td><td>{money(row.openingPrincipal)}</td><td>{money(row.principal)}</td><td>{money(row.interest)}</td><td>{money(row.payment)}</td><td>{money(row.closingPrincipal)}</td></tr>
              ))}</tbody>
            </table>
          </div>
          {(!loan || (loan.status !== 'CANCELLED' && loan.quoteFingerprint !== quote.fingerprint)) ? <form onSubmit={onSubmit(async () => {
            const replacing = loan && loan.status !== 'CANCELLED';
            const payload = replacing
              ? { quoteId: quote.id, quoteFingerprint: quote.fingerprint, changeReason: form.reason.trim() }
              : { quoteId: quote.id, quoteFingerprint: quote.fingerprint };
            const purpose = replacing ? 'LOAN_TERMS_REPLACE' : 'LOAN_DRAFT_CREATE';
            try {
              const key = await prove(purpose, payload, replacing ? loan.id : undefined, replacing ? etag ?? undefined : undefined);
              const result = replacing
                ? await call<Loan>('PUT', `${base}/loans/${loan.id}/terms`, payload, { ifMatch: etag ?? undefined, idempotencyKey: key })
                : await call<Loan>('POST', `${base}/loans`, payload, { idempotencyKey: key });
              await saved(result);
            } catch (caught) {
              stale(caught);
              throw caught;
            }
          }, setPending, setError)}>
            {loan && loan.status !== 'CANCELLED' ? <Field label="Motivo del cambio de términos"><input value={form.reason} maxLength={240} required onChange={event => setForm(current => ({ ...current, reason: event.target.value }))} /></Field> : null}
            <StepFields legend="Guardar los términos de esta simulación" password={password} code={stepCode} setPassword={setPassword} setCode={setStepCode} />
            <Submit pending={pending}>{loan && loan.status !== 'CANCELLED' ? 'Reemplazar términos' : 'Guardar borrador de términos'}</Submit>
          </form> : null}
          {loan?.status === 'DRAFT' && loan.quoteId === quote.id && loan.quoteFingerprint === quote.fingerprint ? (
            <form onSubmit={onSubmit(async () => {
              const payload = { quoteId: quote.id, quoteFingerprint: quote.fingerprint, termsVersion: loan.termsVersion };
              try {
              const key = await prove('LOAN_TERMS_CONFIRM', payload, loan.id, etag ?? undefined);
              const result = await call<Loan>('POST', `${base}/loans/${loan.id}/confirmation`, payload, { ifMatch: etag ?? undefined, idempotencyKey: key });
              await saved(result);
              } catch (caught) { stale(caught); throw caught; }
            }, setPending, setError)}>
              <label className="checks"><input type="checkbox" checked={confirmReady} onChange={event => setConfirmReady(event.target.checked)} /> Confirmo estos términos. Esto no desembolsa ni cobra.</label>
              <StepFields legend="Confirmar términos" password={password} code={stepCode} setPassword={setPassword} setCode={setStepCode} />
              <Submit pending={pending} disabled={!confirmReady}>Confirmar términos</Submit>
            </form>
          ) : null}
        </section>
      ) : <Empty>Todavía no hay un cronograma de esta simulación.</Empty>}
      <section>
        <h2>Términos guardados</h2>
        {loans.length === 0 ? <Empty>No hay préstamos guardados en esta organización.</Empty> : (
          <ul>{loans.map(item => {
            const person = borrowers.find(entry => entry.id === item.borrowerId);
            const who = person ? borrowerLabel(person.borrowerCode, person.profile.displayName) : 'Prestatario no está en esta página';
            const amount = item.terms?.principal ? money(item.terms.principal) : 'importe no incluido';
            const caption = `${who} · ${amount} · ${STATUS[item.status] ?? 'Estado no reconocido'} · versión ${item.termsVersion}`;
            return <li key={item.id}><button type="button" disabled={pending} title={item.id} onClick={() => void openLoan(item.id).catch(setError)}>{caption}</button></li>;
          })}</ul>
        )}
        {loanCursor ? <button type="button" onClick={() => void loadLoans(loanCursor).catch(setError)}>Más préstamos</button> : null}
        {loan ? <p>{STATUS[loan.status]}. Versión de términos {loan.termsVersion}. Huella de la cotización conservada. No es un desembolso.</p> : null}
        {loan && loan.status !== 'CANCELLED' ? (
          <form onSubmit={onSubmit(async () => {
            const payload = { reason: form.reason.trim() };
            const key = await prove('LOAN_CANCEL', payload, loan.id, etag ?? undefined);
            const result = await call<Loan>('POST', `${base}/loans/${loan.id}/cancellation`, payload, { ifMatch: etag ?? undefined, idempotencyKey: key });
            await saved(result);
          }, setPending, setError)}>
            <Field label="Motivo de la cancelación"><input value={form.reason} maxLength={240} required onChange={event => setForm(current => ({ ...current, reason: event.target.value }))} /></Field>
            <StepFields legend="Cancelar los términos" password={password} code={stepCode} setPassword={setPassword} setCode={setStepCode} />
            <Submit pending={pending}>Cancelar términos</Submit>
          </form>
        ) : null}
        {loan && versions.length ? <section aria-label="Historial de términos">
          <h2>Historial de términos</h2>
          {versions.map(version => <details key={version.termsVersion}><summary>Versión {version.termsVersion}: {METHOD[version.terms.method] ?? version.terms.method} · capital {money(version.terms.principal)}</summary>
            <p>{version.changeReason ?? 'Alta inicial'}. Tasa declarada {rateToPercent(version.terms.rate.value)} % por {FREQUENCY[version.terms.rate.unit]}. Política {version.calculation.policyVersion}. Cálculo {version.calculation.mathVersion}. Calendario {version.calculation.calendarVersion}.</p>
            <p>Capital {money(version.calculation.totals.principal)}. Interés {money(version.calculation.totals.interest)}. Cuotas {money(version.calculation.totals.payment)}.</p>
            <div className="schedule"><table><thead><tr><th>Cuota</th><th>Fecha</th><th>Capital</th><th>Interés</th><th>Cuota</th><th>Saldo final</th></tr></thead><tbody>{version.calculation.schedule.map(row => <tr key={row.k}><td>{row.k}</td><td>{row.date}</td><td>{money(row.principal)}</td><td>{money(row.interest)}</td><td>{money(row.payment)}</td><td>{money(row.closingPrincipal)}</td></tr>)}</tbody></table></div>
          </details>)}
          {versionCursor ? <button type="button" onClick={() => void loadVersions(loan.id, versionCursor).catch(setError)}>Más versiones de términos</button> : null}
        </section> : null}
      </section>
    </Panel>
  );
}
