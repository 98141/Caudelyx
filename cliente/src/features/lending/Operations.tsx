import { useEffect, useRef, useState } from 'react';
import { AccountPicker } from '../finance/account-picker';
import { call, reauthenticate } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { ApiError, isStrong } from '../../shared/contracts';
import { accountLabel, borrowerLabel } from '../../shared/labels';
import { formatCop, todayBogota } from '../../shared/money';
import { Alert, Empty, ErrorText, Field, Panel, StepFields, Submit, onSubmit } from '../../shared/ui';
import { principalFromLocal } from './rate';

interface Policy { version: string; usage: string; realUseAllowed: false; currency: 'COP'; previewTTLSeconds: number }
interface Profile { principalAccountId: string; interestReceivableAccountId: string; interestIncomeAccountId: string; borrowerCreditAccountId: string }
interface Book { organizationId: string; version: number; profile: Profile | null; currency: 'COP' }
interface Position {
  loanId: string; borrower: { id: string; code: string; name: string }; currency: 'COP'; version: number;
  termsVersion: number; scheduleVersion: number; termsStatus: string; status: string; statusLabel: string;
  originalPrincipal: string; principalOutstanding: string; duePrincipal: string; originalExpectedInterest: string;
  expectedFutureInterest: string; dueUnrecognizedInterest: string; accruedInterestTotal: string;
  collectedInterestTotal: string; accruedOutstandingInterest: string;
}
interface Installment { loanId: string; number: number; dueDate: string; principal: string; interest: string; payment: string; principalPaid: string; interestPaid: string; status: string; dueState: string }
interface Credit { borrowerId: string; version: number; balance: string; currency: 'COP' }
interface LoanTerms { plannedFundingAccountId?: string; principal?: string }
interface Allocation { loanId: string; installmentNumber: number; component: string; amount: string }
interface Plan { postings: { accountId: string; debit: string; credit: string }[]; allocations: Allocation[]; accruals: { installmentNumber: number; dueDate: string; interest: string }[]; positions: Position[]; creditChange: { before: string; added: string; applied: string; after: string } | null }
interface Preview { previewToken: string; expiresAt: string; policyVersion: string; request: Intent; expectedBookETag: string; plan: Plan; realUseAllowed: false }
interface Page<T> { items: T[]; nextCursor?: string | null }
type Intent = Record<string, unknown>;
interface TargetDraft { loanId: string; amount: string; mode: 'REGULAR' | 'EXTRA_PRINCIPAL'; etag: string }

const TERMS: Record<string, string> = { DRAFT: 'Borrador', TERMS_CONFIRMED: 'Términos confirmados', CANCELLED: 'Cancelado' };
const POSITION = new Set(['NOT_DISBURSED', 'ACTIVE', 'SETTLED']);
const INSTALLMENT: Record<string, string> = { UNPAID: 'Sin cobro', PARTIAL: 'Parcial', PAID: 'Cobrada' };
const DUE: Record<string, string> = { FUTURE: 'Futura', DUE: 'Vence hoy', OVERDUE: 'Vencida' };
const PART: Record<string, string> = { INTEREST: 'Interés', DUE_PRINCIPAL: 'Capital vencido', EXTRA_PRINCIPAL: 'Abono a capital' };
const PROFILE_FIELDS: { key: keyof Profile; label: string; accountClass: string }[] = [
  { key: 'principalAccountId', label: 'Cuenta de capital por cobrar', accountClass: 'ASSET' },
  { key: 'interestReceivableAccountId', label: 'Cuenta de interés por cobrar', accountClass: 'ASSET' },
  { key: 'interestIncomeAccountId', label: 'Cuenta de ingreso por interés', accountClass: 'INCOME' },
  { key: 'borrowerCreditAccountId', label: 'Cuenta de saldo a favor', accountClass: 'LIABILITY' },
];

function money(value: string): string {
  return formatCop(value) ? `${formatCop(value)} COP` : value;
}
function known(position: Position): boolean {
  return POSITION.has(position.status);
}

export function OperationsScreen() {
  const { me } = useAuth();
  const organizationId = me?.organizationId ?? '';
  const ready = isStrong(me) && me?.authState === 'ACTIVE' && Boolean(organizationId);
  const base = `/organizations/${organizationId}`;
  const ops = `${base}/loan-operations`;
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [items, setItems] = useState<Position[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [borrowerFilter, setBorrowerFilter] = useState('');
  const [position, setPosition] = useState<Position | null>(null);
  const [positionEtag, setPositionEtag] = useState<string | null>(null);
  const [loanEtag, setLoanEtag] = useState<string | null>(null);
  const [fundingEtag, setFundingEtag] = useState<string | null>(null);
  const [fundingLabel, setFundingLabel] = useState('');
  const [bookEtag, setBookEtag] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [chosen, setChosen] = useState<Partial<Profile>>({});
  const [profileEtags, setProfileEtags] = useState<Partial<Record<keyof Profile, string>>>({});
  const [profileLabels, setProfileLabels] = useState<Partial<Record<keyof Profile, string>>>({});
  const [rows, setRows] = useState<Installment[]>([]);
  const [credit, setCredit] = useState<Credit | null>(null);
  const [creditEtag, setCreditEtag] = useState<string | null>(null);
  const [support, setSupport] = useState('');
  const [through, setThrough] = useState('');
  const [received, setReceived] = useState('');
  const [excess, setExcess] = useState<'REJECT' | 'CREDIT'>('REJECT');
  const [receiptReference, setReceiptReference] = useState('');
  const [destination, setDestination] = useState('');
  const [destinationEtag, setDestinationEtag] = useState<string | null>(null);
  const [creditAmount, setCreditAmount] = useState('');
  const [targets, setTargets] = useState<TargetDraft[]>([]);
  const [date, setDate] = useState(todayBogota());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [consent, setConsent] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [pending, setPending] = useState(false);
  const [loadingPosition, setLoadingPosition] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [password, setPassword] = useState('');
  const [stepCode, setStepCode] = useState('');
  const keyRef = useRef<string | null>(null);
  const frozen = useRef<string | null>(null);
  const [postingLabels, setPostingLabels] = useState<Record<string, string>>({});

  function executionKey(): string {
    keyRef.current ??= crypto.randomUUID();
    return keyRef.current;
  }
  function touch() {
    if (frozen.current) {
      setNotice('La respuesta anterior no está confirmada. No se cambia la clave ni el cuerpo ya enviado.');
      return;
    }
    setPreview(null);
    setConsent(false);
  }

  async function load(next: string | null) {
    const params = new URLSearchParams({ limit: '20' });
    if (next) params.set('cursor', next);
    if (borrowerFilter) params.set('borrowerId', borrowerFilter);
    if (statusFilter) params.set('status', statusFilter);
    const result = await call<Page<Position>>('GET', `${ops}/positions?${params.toString()}`);
    setItems(result.data.items);
    setCursor(result.data.nextCursor ?? null);
  }

  useEffect(() => {
    if (!ready) return;
    void call<Policy>('GET', `${ops}/policy`).then(result => setPolicy(result.data)).catch(setError);
    void load(null).catch(setError);
  }, [ready, organizationId]);

  async function accountEtag(id: string): Promise<{ etag: string | null; label: string }> {
    const result = await call<{ code?: unknown; name?: unknown }>('GET', `${base}/financial/accounts/${id}`);
    const label = typeof result.data.code === 'string' && typeof result.data.name === 'string' ? `${result.data.code} · ${result.data.name}` : await accountLabel(`${base}/financial`, id);
    return { etag: result.etag, label };
  }

  async function openPosition(loanId: string) {
    if (frozen.current) {
      setNotice('La respuesta anterior no está confirmada. No se abre otra posición ni se cambia la clave.');
      return;
    }
    touch();
    setLoadingPosition(true);
    try {
      const [found, loan, book, installments] = await Promise.all([
        call<Position>('GET', `${ops}/positions/${loanId}`),
        call<{ terms?: LoanTerms }>('GET', `${base}/loans/${loanId}`),
        call<Book>('GET', `${ops}/book`),
        call<Page<Installment>>('GET', `${ops}/positions/${loanId}/installments?limit=100`),
      ]);
      setPosition(found.data);
      setPositionEtag(found.etag);
      setLoanEtag(loan.etag);
      setBookEtag(book.etag);
      setProfile(book.data.profile);
      setRows(installments.data.items);
      const creditResult = await call<Credit>('GET', `${ops}/credits/${found.data.borrower.id}`);
      setCredit(creditResult.data);
      setCreditEtag(creditResult.etag);
      const funding = loan.data.terms?.plannedFundingAccountId ?? '';
      if (funding) {
        const read = await accountEtag(funding);
        setFundingEtag(read.etag);
        setFundingLabel(read.label);
      } else {
        setFundingEtag(null);
        setFundingLabel('La cuenta prevista no vino en el préstamo');
      }
      const tags: Partial<Record<keyof Profile, string>> = {};
      const labels: Partial<Record<keyof Profile, string>> = {};
      if (book.data.profile) {
        for (const field of PROFILE_FIELDS) {
          const read = await accountEtag(book.data.profile[field.key]);
          if (read.etag) tags[field.key] = read.etag;
          labels[field.key] = read.label;
        }
      }
      setChosen({});
      setProfileEtags(tags);
      setProfileLabels(labels);
      setTargets([{ loanId, amount: '', mode: 'REGULAR', etag: found.etag ?? '' }]);
    } catch (caught) {
      setPosition(null);
      throw caught;
    } finally {
      setLoadingPosition(false);
    }
  }

  function profileReady(): { ids: Profile; versions: Profile } | null {
    const ids: Profile = profile ?? {
      principalAccountId: chosen.principalAccountId ?? '',
      interestReceivableAccountId: chosen.interestReceivableAccountId ?? '',
      interestIncomeAccountId: chosen.interestIncomeAccountId ?? '',
      borrowerCreditAccountId: chosen.borrowerCreditAccountId ?? '',
    };
    if (Object.values(ids).some(id => !id) || new Set(Object.values(ids)).size !== 4) return null;
    const versions = {} as Profile;
    for (const field of PROFILE_FIELDS) {
      const tag = profileEtags[field.key];
      if (!tag) return null;
      versions[field.key] = tag;
    }
    return { ids, versions };
  }

  function targetBody(): { loanId: string; positionETag: string; amount: string; mode: 'REGULAR' | 'EXTRA_PRINCIPAL' }[] {
    return targets.map(target => {
      const amount = principalFromLocal(target.amount);
      if (!amount || !target.etag) throw new ApiError(422, 'INPUT_INVALID', null, 'Falta el importe o la versión de algún préstamo. Revisa todos los préstamos seleccionados.');
      return { loanId: target.loanId, positionETag: target.etag, amount, mode: target.mode };
    });
  }

  function intentFor(kind: 'DISBURSE' | 'ACCRUE' | 'RECEIPT' | 'APPLY_CREDIT'): Intent {
    if (!position || !bookEtag || !date || !support.trim()) throw new ApiError(422, 'INPUT_INVALID', null, 'Faltan la fecha, el soporte o la posición. No se inventó ningún valor.');
    if (kind === 'DISBURSE') {
      const accounts = profileReady();
      if (!loanEtag || !fundingEtag || !accounts) throw new ApiError(422, 'ACCOUNT_INELIGIBLE', null, 'Falta la versión de una cuenta o del préstamo. No se desembolsó.');
      return { kind, loanId: position.loanId, loanETag: loanEtag, fundingAccountETag: fundingEtag, accountProfile: accounts.ids, accountVersions: accounts.versions, effectiveDate: date, supportReference: support.trim() };
    }
    if (kind === 'ACCRUE') {
      if (!positionEtag || !through) throw new ApiError(422, 'INPUT_INVALID', null, 'Falta la fecha hasta la que se reconoce el interés vencido. No se devenga el futuro.');
      return { kind, loanId: position.loanId, positionETag: positionEtag, throughDate: through, effectiveDate: date, supportReference: support.trim() };
    }
    const built = targetBody();
    if (!built.length) throw new ApiError(422, 'INPUT_INVALID', null, 'Falta el importe de algún préstamo. No se aplicó un reparto local.');
    if (kind === 'RECEIPT') {
      const receivedAmount = principalFromLocal(received);
      if (!receivedAmount || !destination || !destinationEtag || !receiptReference.trim()) throw new ApiError(422, 'INPUT_INVALID', null, 'Faltan el cobro, la cuenta o la referencia. No se cobró.');
      return { kind, borrowerId: position.borrower.id, destinationAccountId: destination, destinationAccountETag: destinationEtag, receivedAmount, targets: built, excessDisposition: excess, receiptReference: receiptReference.trim(), effectiveDate: date, supportReference: support.trim() };
    }
    const amount = principalFromLocal(creditAmount);
    if (!amount || !creditEtag) throw new ApiError(422, 'INPUT_INVALID', null, 'Falta el saldo a favor o su versión. No se aplicó.');
    return { kind, borrowerId: position.borrower.id, creditETag: creditEtag, amount, targets: built, effectiveDate: date, supportReference: support.trim() };
  }

  async function ask(kind: 'DISBURSE' | 'ACCRUE' | 'RECEIPT' | 'APPLY_CREDIT') {
    if (frozen.current) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', null, 'Hay un comando sin confirmar. No se pide otro plan ni otra clave.');
    if (!bookEtag) throw new ApiError(428, 'ETAG_REQUIRED', null, 'Falta la versión del libro. No se pidió el plan.');
    const request = intentFor(kind);
    const result = await call<Preview>('POST', `${base}/loan-operation-previews`, { executionKey: executionKey(), expectedBookETag: bookEtag, request });
    setPreview(result.data);
    setConsent(false);
    setNotice(null);
    const ids = result.data.plan.postings.map(line => line.accountId).slice(0, 50);
    const labels: Record<string, string> = {};
    for (const id of ids) labels[id] = await accountLabel(`${base}/financial`, id);
    setPostingLabels(labels);
  }

  async function commit(kind: 'DISBURSE' | 'ACCRUE' | 'RECEIPT' | 'APPLY_CREDIT') {
    setError(null);
    if (!preview || !bookEtag || !position) throw new ApiError(422, 'INPUT_INVALID', null, 'No hay un plan vigente. No se confirmó.');
    const purpose = kind === 'DISBURSE' ? 'LOAN_DISBURSE' : kind === 'ACCRUE' ? 'LOAN_ACCRUE' : kind === 'RECEIPT' ? 'LOAN_RECEIPT_POST' : 'LOAN_CREDIT_APPLY';
    const path = kind === 'DISBURSE' ? 'disbursements' : kind === 'ACCRUE' ? 'accruals' : kind === 'RECEIPT' ? 'receipts' : 'credit-applications';
    const resourceId = kind === 'DISBURSE' || kind === 'ACCRUE' ? position.loanId : position.borrower.id;
    const payload = frozen.current ? JSON.parse(frozen.current) as { previewToken: string; request: Intent } : { previewToken: preview.previewToken, request: preview.request };
    const key = executionKey();
    await reauthenticate({ password, purpose, resourceId, command: { organizationId, idempotencyKey: key, payload, expectedETag: bookEtag }, code: stepCode });
    setPassword('');
    setStepCode('');
    try {
      await call('POST', `${ops}/${path}`, payload, { idempotencyKey: key, ifMatch: bookEtag });
      frozen.current = null;
      keyRef.current = null;
      setUncertain(false);
      setPreview(null);
      setConsent(false);
      setNotice('El servidor confirmó el comando. Esto no habilita un préstamo real.');
      await load(null);
      await openPosition(position.loanId);
    } catch (caught) {
      if (caught instanceof ApiError && (caught.status === 0 || caught.status === 503)) {
        frozen.current = JSON.stringify(payload);
        setUncertain(true);
      }
      if (caught instanceof ApiError && ['PREVIEW_EXPIRED', 'PREVIEW_STALE', 'PRECONDITION_FAILED'].includes(caught.code)) {
        setPreview(null);
        setConsent(false);
      }
      throw caught;
    }
  }

  async function consult() {
    setError(null);
    if (!keyRef.current) throw new ApiError(422, 'INPUT_INVALID', null, 'No hay una clave de comando en esta pantalla.');
    try {
      await call('GET', `${ops}/commands/${keyRef.current}`);
      setNotice('El servidor ya tiene este comando. No se envió otro.');
      setUncertain(false);
      frozen.current = null;
      keyRef.current = null;
      setPreview(null);
      setConsent(false);
      await load(null);
      if (position) await openPosition(position.loanId);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 404) {
        setNotice('No hay un comando comprometido con esta clave para este actor. Eso no demuestra que no haya una operación en curso.');
        return;
      }
      throw caught;
    }
  }

  if (!ready) return <Panel title="Operaciones" id="page-title"><p>Hace falta la sesión activa de la organización. No se consulta ni se mueve dinero.</p></Panel>;

  const caption = (item: Position) => `${borrowerLabel(item.borrower.code, item.borrower.name)} · ${money(item.originalPrincipal)} · ${known(item) ? item.statusLabel : 'Estado no reconocido'} · versión ${item.version}`;

  return (
    <Panel title="Operaciones" id="page-title">
      <Alert tone="pending">Entorno local sintético. {policy ? `Política ${policy.version}. ` : ''}Un plan no desembolsa, no devenga y no cobra. Esta pantalla no autoriza un préstamo real.</Alert>
      <ErrorText error={error} />
      {notice ? <Alert tone="info">{notice}</Alert> : null}
      <form onSubmit={event => { event.preventDefault(); void load(null).catch(setError); }}>
        <Field label="Estado de la posición">
          <select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
            <option value="">Todos</option>
            <option value="NOT_DISBURSED">Sin desembolso</option>
            <option value="ACTIVE">Activo</option>
            <option value="SETTLED">Liquidado</option>
          </select>
        </Field>
        <Field label="Identificador del prestatario, si se filtra"><input value={borrowerFilter} onChange={event => setBorrowerFilter(event.target.value)} /></Field>
        <Submit pending={pending}>Filtrar posiciones</Submit>
      </form>
      {items.length === 0 ? <Empty>No hay posiciones con ese criterio.</Empty> : (
        <ul>{items.map(item => <li key={item.loanId}><button type="button" disabled={pending || loadingPosition} onClick={() => void openPosition(item.loanId).catch(setError)}>{caption(item)}</button><details className="correlation"><summary>Correlación de la posición</summary><p>{item.loanId}</p></details></li>)}</ul>
      )}
      {cursor ? <button type="button" onClick={() => void load(cursor).catch(setError)}>Página siguiente</button> : null}
      {loadingPosition ? <p role="status">Consultando la posición y las versiones de sus cuentas…</p> : null}
      {position && !loadingPosition ? (
        <section aria-label="Detalle de la posición">
          <h2>{borrowerLabel(position.borrower.code, position.borrower.name)}</h2>
          <p>{known(position) ? position.statusLabel : 'Estado no reconocido'}. Términos {TERMS[position.termsStatus] ?? 'Estado de términos no reconocido'}. Versión de posición {position.version}. Versión de términos {position.termsVersion}.</p>
          <ul>
            <li>Capital original {money(position.originalPrincipal)}</li>
            <li>Capital pendiente {money(position.principalOutstanding)}</li>
            <li>Capital vencido {money(position.duePrincipal)}</li>
            <li>Interés esperado original {money(position.originalExpectedInterest)}</li>
            <li>Interés futuro esperado {money(position.expectedFutureInterest)}</li>
            <li>Interés vencido sin reconocer {money(position.dueUnrecognizedInterest)}</li>
            <li>Interés devengado {money(position.accruedInterestTotal)}</li>
            <li>Interés cobrado {money(position.collectedInterestTotal)}</li>
            <li>Interés devengado pendiente {money(position.accruedOutstandingInterest)}</li>
          </ul>
          <p className="muted">Estas cifras salen de la posición del servidor. No son un cálculo de esta pantalla.</p>
          {rows.length === 0 ? <Empty>El servidor no devolvió cuotas de la versión actual.</Empty> : (
            <div className="schedule"><table>
              <thead><tr><th>Cuota</th><th>Fecha</th><th>Capital</th><th>Interés</th><th>Cuota</th><th>Capital cobrado</th><th>Interés cobrado</th><th>Estado</th></tr></thead>
              <tbody>{rows.map(row => <tr key={row.number}><td>{row.number}</td><td>{row.dueDate}</td><td>{money(row.principal)}</td><td>{money(row.interest)}</td><td>{money(row.payment)}</td><td>{money(row.principalPaid)}</td><td>{money(row.interestPaid)}</td><td>{INSTALLMENT[row.status] ?? 'Estado no reconocido'} · {DUE[row.dueState] ?? 'Vencimiento no reconocido'}</td></tr>)}</tbody>
            </table></div>
          )}
          {known(position) ? null : <Alert tone="error">Estado no reconocido. No hay acciones.</Alert>}
          <Field label="Fecha contable" hint="El servidor solo admite hoy en Bogotá. Otra fecha se rechaza."><input type="date" value={date} onChange={event => { setDate(event.target.value); touch(); }} /></Field>
          <Field label="Referencia de soporte"><input value={support} maxLength={160} onChange={event => { setSupport(event.target.value); touch(); }} /></Field>
          {position.status === 'NOT_DISBURSED' && position.termsStatus === 'TERMS_CONFIRMED' ? (
            <form onSubmit={onSubmit(() => ask('DISBURSE'), setPending, setError)}>
              <h2>Desembolso</h2>
              <p>Cuenta de origen prevista: {fundingLabel || 'Consultando la cuenta…'}. Cambiarla exige otros términos, no esta pantalla.</p>
              {profile ? PROFILE_FIELDS.map(field => <p key={field.key}>{field.label}: {profileLabels[field.key] ?? 'Consultando la cuenta…'}</p>) : PROFILE_FIELDS.map(field => (
                <AccountPicker key={field.key} base={`${base}/financial`} label={field.label} accountClass={field.accountClass} kinds={['GENERAL']} status="ACTIVE" value={chosen[field.key] ?? ''} onChange={id => { setChosen(current => ({ ...current, [field.key]: id })); void accountEtag(id).then(read => { if (read.etag) setProfileEtags(current => ({ ...current, [field.key]: read.etag })); setProfileLabels(current => ({ ...current, [field.key]: read.label })); touch(); }); }} />
              ))}
              <Submit pending={pending} disabled={!loanEtag || !fundingEtag || !bookEtag || !profileReady()}>Pedir el plan de desembolso</Submit>
            </form>
          ) : null}
          {position.status === 'ACTIVE' ? (
            <>
              <form onSubmit={onSubmit(() => ask('ACCRUE'), setPending, setError)}>
                <h2>Devengo del interés vencido</h2>
                <p>Solo reconoce cuotas ya vencidas hasta la fecha indicada. No reconoce el interés futuro.</p>
                <Field label="Reconocer hasta"><input type="date" value={through} onChange={event => { setThrough(event.target.value); touch(); }} /></Field>
                <Submit pending={pending}>Pedir el plan de devengo</Submit>
              </form>
              <form onSubmit={onSubmit(() => ask('RECEIPT'), setPending, setError)}>
                <h2>Cobro</h2>
                <AccountPicker base={`${base}/financial`} label="Cuenta que recibe el cobro" accountClass="ASSET" kinds={['CASH', 'BANK']} status="ACTIVE" value={destination} onChange={id => { setDestination(id); setDestinationEtag(null); touch(); void accountEtag(id).then(read => setDestinationEtag(read.etag)); }} />
                {destinationEtag ? <p>La cuenta de cobro tiene versión para el plan.</p> : null}
                <Field label="Importe recibido"><input value={received} inputMode="decimal" onChange={event => { setReceived(event.target.value); touch(); }} /></Field>
                {targets.map((target, index) => (
                  <div key={target.loanId}>
                    <Field label={`Importe para el préstamo ${index + 1}`}><input value={target.amount} inputMode="decimal" onChange={event => { setTargets(current => current.map(item => item.loanId === target.loanId ? { ...item, amount: event.target.value } : item)); touch(); }} /></Field>
                    <Field label={`Modo del préstamo ${index + 1}`}>
                      <select value={target.mode} onChange={event => { setTargets(current => current.map(item => item.loanId === target.loanId ? { ...item, mode: event.target.value as TargetDraft['mode'] } : item)); touch(); }}>
                        <option value="REGULAR">Cobro ordinario</option>
                        <option value="EXTRA_PRINCIPAL">Abono extraordinario a capital</option>
                      </select>
                    </Field>
                  </div>
                ))}
                {items.filter(item => item.status === 'ACTIVE' && item.borrower.id === position.borrower.id && !targets.some(target => target.loanId === item.loanId)).map(item => (
                  <button key={item.loanId} type="button" onClick={() => void call<Position>('GET', `${ops}/positions/${item.loanId}`).then(result => { if (result.etag) setTargets(current => current.length >= 10 || current.some(target => target.loanId === item.loanId) ? current : [...current, { loanId: item.loanId, amount: '', mode: 'REGULAR', etag: result.etag ?? '' }]); touch(); }).catch(setError)}>Agregar {borrowerLabel(item.borrower.code, item.borrower.name)} · {money(item.originalPrincipal)}</button>
                ))}
                <Field label="Si sobra dinero">
                  <select value={excess} onChange={event => { setExcess(event.target.value as 'REJECT' | 'CREDIT'); touch(); }}>
                    <option value="REJECT">Rechazar el excedente</option>
                    <option value="CREDIT">Dejarlo como saldo a favor</option>
                  </select>
                </Field>
                <Field label="Referencia del cobro"><input value={receiptReference} maxLength={80} onChange={event => { setReceiptReference(event.target.value); touch(); }} /></Field>
                <Submit pending={pending}>Pedir el plan de cobro</Submit>
              </form>
              {credit && credit.balance !== '0.00' ? (
                <form onSubmit={onSubmit(() => ask('APPLY_CREDIT'), setPending, setError)}>
                  <h2>Aplicar saldo a favor</h2>
                  <p>Saldo informado por el servidor: {money(credit.balance)}. No entra caja.</p>
                  <Field label="Importe del saldo a aplicar"><input value={creditAmount} inputMode="decimal" onChange={event => { setCreditAmount(event.target.value); touch(); }} /></Field>
                  <Submit pending={pending}>Pedir el plan del saldo a favor</Submit>
                </form>
              ) : <p>No hay saldo a favor para aplicar.</p>}
            </>
          ) : null}
          {preview ? (
            <section aria-label="Plan del servidor">
              <h2>Plan del servidor</h2>
              <Alert tone="info">Plan sin efecto. Vence {new Date(preview.expiresAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}. No es un desembolso, un devengo ni un cobro.</Alert>
              <p>{received || creditAmount ? `Importe escrito ${money(received || creditAmount)}.` : 'Este plan no lleva un importe escrito de cobro.'} El reparto siguiente es el del servidor.</p>
              <ul>{preview.plan.allocations.map((line, index) => <li key={`${line.loanId}-${line.installmentNumber}-${index}`}>Cuota {line.installmentNumber}: {PART[line.component] ?? 'Componente no reconocido'} {money(line.amount)}</li>)}</ul>
              <ul>{preview.plan.accruals.map(line => <li key={`${line.installmentNumber}-${line.dueDate}`}>Devengo de la cuota {line.installmentNumber} al {line.dueDate}: {money(line.interest)}</li>)}</ul>
              <ul>{preview.plan.postings.map(line => <li key={line.accountId}>{postingLabels[line.accountId] ?? 'Consultando la cuenta…'}: débito {money(line.debit)}, crédito {money(line.credit)}</li>)}</ul>
              {preview.plan.creditChange ? <p>Saldo a favor: antes {money(preview.plan.creditChange.before)}, agregado {money(preview.plan.creditChange.added)}, aplicado {money(preview.plan.creditChange.applied)}, después {money(preview.plan.creditChange.after)}.</p> : null}
              <form onSubmit={onSubmit(() => commit(String(preview.request.kind) as 'DISBURSE' | 'ACCRUE' | 'RECEIPT' | 'APPLY_CREDIT'), setPending, setError)}>
                <label className="checks"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /> Confirmo este plan. No es una aprobación legal ni un segundo desembolso.</label>
                <StepFields legend="Confirmar el comando" password={password} code={stepCode} setPassword={setPassword} setCode={setStepCode} />
                <Submit pending={pending} disabled={!consent}>{preview.request.kind === 'DISBURSE' ? 'Confirmar desembolso' : preview.request.kind === 'ACCRUE' ? 'Confirmar devengo' : preview.request.kind === 'RECEIPT' ? 'Confirmar cobro' : 'Confirmar aplicación del saldo'}</Submit>
              </form>
            </section>
          ) : null}
          {uncertain ? (
            <div>
              <Alert tone="pending">La respuesta no confirmó el resultado. La misma clave se conserva. No se prepara otra.</Alert>
              <button type="button" disabled={pending} onClick={() => { if (pending) return; setPending(true); void consult().catch(setError).finally(() => setPending(false)); }}>Consultar el comando</button>
              <button type="button" disabled={pending} onClick={() => { if (pending) return; setPending(true); void commit(String(preview?.request.kind ?? 'DISBURSE') as 'DISBURSE' | 'ACCRUE' | 'RECEIPT' | 'APPLY_CREDIT').catch(setError).finally(() => setPending(false)); }}>Reintentar el mismo comando</button>
            </div>
          ) : null}
        </section>
      ) : null}
    </Panel>
  );
}
