import { useEffect, useRef, useState } from 'react';
import { call } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { ApiError, messageFor, purposeClass } from '../../shared/contracts';
import { cents, formatCop, parseLocalCop, todayBogota } from '../../shared/money';
import { ensureStepUp } from '../../shared/step-up';
import { Alert, Empty, ErrorText, Field, onSubmit } from '../../shared/ui';
import { WealthOperations } from './WealthOperations';

const PREFIX = 'caudelyx.s10.wealth.';
type ScopeKind = 'BUSINESS' | 'PERSONAL';
type Row = Record<string, unknown>;
interface Meta { scope?: string; coverage?: string; reasons?: string[] }

const CLASSES = ['APARTMENT', 'HOUSE', 'LAND', 'VEHICLE', 'MACHINERY', 'EQUIPMENT', 'BUSINESS_INTEREST', 'OTHER_DECLARED'] as const;
const CLASS_LABEL: Record<string, string> = {
  APARTMENT: 'Apartamento', HOUSE: 'Casa', LAND: 'Lote', VEHICLE: 'Vehículo', MACHINERY: 'Maquinaria',
  EQUIPMENT: 'Equipo', BUSINESS_INTEREST: 'Participación', OTHER_DECLARED: 'Otra, declarada',
};
const ORIGINS: Record<string, string> = {
  PURCHASE: 'Compra', CONTRIBUTION: 'Aporte', INHERITANCE: 'Herencia', DONATION: 'Donación',
  CONSTRUCTION: 'Construcción', EXCHANGE: 'Permuta', OPENING: 'Apertura', OTHER_DECLARED: 'Otro origen declarado',
};
const METHODS: Record<string, string> = {
  DECLARED_COMPARABLE: 'Comparable declarado', OWNER_ESTIMATE: 'Estimado del titular', APPRAISAL_REFERENCE: 'Referencia de avalúo',
};
const REASONS: Record<string, string> = {
  OWNERSHIP_NOT_DECLARED: 'La titularidad no está declarada. No se calcula la porción.',
  NO_VALUATION_AT_CUT: 'No hay estimado en este corte. No se muestra cero.',
  PROVENANCE_UNKNOWN: 'Hay una fuente declarada como incierta. No se completa.',
  UNVALUED_ASSET_AT_CUT: 'Falta el estimado de un activo. El consolidado no lo inventa.',
  VALUATION_ELIMINATION_ALLOCATION_UNAVAILABLE: 'No se pudo separar el estimado de una eliminación. Queda incompleto.',
};

function cash(value: unknown): string {
  if (value === null || value === undefined) return 'Sin dato del servidor';
  if (typeof value !== 'string') return 'Sin dato del servidor';
  const shown = formatCop(value);
  return shown ? `${shown} COP` : value;
}

function moneyOrThrow(label: string, value: string): string {
  const canonical = parseLocalCop(value);
  if (!canonical || (cents(canonical) ?? -1n) <= 0n) throw new ApiError(422, 'INPUT_INVALID', null, `${label} debe ser un importe en pesos, mayor que cero.`);
  return canonical;
}

export function WealthScreen() {
  const { me, phase } = useAuth();
  useEffect(() => {
    if (phase !== 'anonymous') return;
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(PREFIX)) sessionStorage.removeItem(key);
  }, [phase]);
  if (phase !== 'ready' || !me?.userId) return <section className="panel desk"><h1>Fondos y activos</h1><Empty>Entra con tu sesión. No se muestran fondos ni activos de otro actor.</Empty></section>;
  const owner = `${me.userId}|${me.organizationId ?? ''}|${[...(me.roleIds ?? [])].sort().join(',')}`;
  return <Workspace key={owner} owner={owner} />;
}

function Workspace({ owner }: { owner: string }) {
  const { me } = useAuth();
  const isT = (me?.roleIds ?? []).includes('T') && !(me?.roleIds ?? []).includes('SA') && Boolean(me?.organizationId);
  const today = todayBogota();
  const [scope, setScope] = useState<ScopeKind>(isT ? 'BUSINESS' : 'PERSONAL');
  const [bookId, setBookId] = useState<string | null>(null);
  const [bookTag, setBookTag] = useState<string | null>(null);
  const [personalState, setPersonalState] = useState<'unknown' | 'open' | 'absent'>('unknown');
  const [items, setItems] = useState<Row[]>([]);
  const [position, setPosition] = useState<Row | null>(null);
  const [availability, setAvailability] = useState<Row | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const ticket = useRef(0);
  const bookSequence = useRef(0);
  const idempotency = useRef<string | null>(null);
  const holdKey = useRef(false);
  const uncertain = useRef<{ signature: string; key: string; payload: Row; expected?: string } | null>(null);
  const base = scope === 'BUSINESS' ? `/organizations/${me?.organizationId}/wealth-s10` : bookId ? `/me/personal/books/${bookId}/wealth-s10` : null;

  useEffect(() => {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(PREFIX) && !key.startsWith(`${PREFIX}${owner}|`)) sessionStorage.removeItem(key);
  }, [owner]);

  useEffect(() => {
    const mine = ++bookSequence.current;
    setItems([]); setPosition(null); setAvailability(null); setMeta(null); setBookTag(null);
    void (async () => {
      try {
        const personal = await call<Row>('GET', '/me/personal/book');
        if (mine !== bookSequence.current) return;
        setBookId(String((personal.data as Row).id ?? '') || null);
        setPersonalState(personal.data ? 'open' : 'absent');
      } catch (caught) {
        if (mine !== bookSequence.current) return;
        setBookId(null);
        setPersonalState(caught instanceof ApiError && caught.status === 404 ? 'absent' : 'unknown');
        if (!(caught instanceof ApiError) || caught.status !== 404) setError(caught);
      }
    })();
    return () => { bookSequence.current += 1; };
  }, [owner]);

  function changeScope(next: ScopeKind) {
    if (next === 'BUSINESS' && !isT) return;
    ticket.current += 1;
    if (pending) return;
    setScope(next); setBookTag(null); setItems([]); setPosition(null); setAvailability(null); setMeta(null); setNotice(null); setError(null);
    idempotency.current = null; holdKey.current = false; uncertain.current = null;
  }

  async function send(operation: string, purpose: string, path: string, payload: Row, resourceId?: string, expected?: string) {
    const { bookETag: ignored, ...intent } = payload; void ignored;
    const signature = JSON.stringify({ operation, path, intent });
    if (uncertain.current && uncertain.current.signature !== signature) throw new ApiError(409, 'INPUT_INVALID', null, 'Hay una confirmación pendiente. Reintenta la misma operación antes de cambiar sus datos.');
    const key = uncertain.current?.key ?? crypto.randomUUID();
    if (uncertain.current) { payload = uncertain.current.payload; expected = uncertain.current.expected; }
    idempotency.current = key;
    const pathParameters: Record<string,string> = {};
    for (const [segment, name] of [['organizations','organizationId'],['books','bookId'],['funds','fundId'],['assets','assetId'],['expenses','expenseId'],['events',path.includes('/funds/')?'fundEventId':'assetEventId']]) { const match=path.match(new RegExp('/'+segment+'/([0-9a-f-]{36})(?:/|$)')); if(match)pathParameters[name!]=match[1]!; }
    const command: Row = {
      operationId: operation, idempotencyKey: key, payload, pathParameters,
      ...(path.startsWith('/organizations/') && me?.organizationId ? { organizationId: me.organizationId } : {}),
      ...(bookId && path.includes(`/books/${bookId}/`) ? { bookId } : {}),
      ...(expected ? { expectedETag: expected } : {}),
    };
    try {
      if (purposeClass(purpose) !== null) await ensureStepUp({ purpose, command, resourceId, summary: 'Confirmas un movimiento de saldo. Reservar un fondo no crea dinero.' });
      uncertain.current = { signature, key, payload, expected };
      const result = await call<Row>('POST', path, payload, { idempotencyKey: key, ifMatch: expected });
      if (result.status !== 200 && result.status !== 201) {
        holdKey.current = true;
        throw new ApiError(result.status, 'SERVICE_UNAVAILABLE', result.requestId, messageFor('SERVICE_UNAVAILABLE', result.status));
      }
      idempotency.current = null; holdKey.current = false; uncertain.current = null;
      return result;
    } catch (caught) {
      if (caught instanceof ApiError && (caught.status === 0 || caught.status === 503)) holdKey.current = true;
      else { idempotency.current = null; holdKey.current = false; uncertain.current = null; }
      throw caught;
    }
  }

  async function refreshBook() {
    if (!base) return null;
    const result = await call<Row>('GET', `${base}/book?asOf=${today}`);
    setBookTag(result.etag);
    return result.etag;
  }

  async function load(kind: 'funds' | 'assets' | 'positions' | 'availability' | 'wealth', accountId?: string) {
    if (kind !== 'wealth' && !base) throw new ApiError(404, 'RESOURCE_NOT_FOUND', null, 'No hay un libro personal abierto.');
    const query = kind === 'availability'
      ? `${base}/availability?asOf=${today}&accountId=${encodeURIComponent(accountId ?? '')}`
      : kind === 'wealth' ? `/me/private-wealth?asOf=${today}`
      : kind === 'positions' ? `${base}/positions?asOf=${today}`
      : `${base}/${kind}?asOf=${today}&limit=20`;
    const mine = ++ticket.current;
    setItems([]); setPosition(null); setAvailability(null); setMeta(null);
    const result = await call<Row>('GET', query);
    if (mine !== ticket.current) return;
    const pageMeta = (result.meta ?? null) as Meta | null;
    setMeta(pageMeta);
    setError(null);
    if (kind === 'availability') { setAvailability(result.data); setPosition(null); setItems([]); }
    else if (kind === 'positions' || kind === 'wealth') { setPosition(result.data); setAvailability(null); setItems([]); }
    else { setItems(((result.data as Row).items as Row[] | undefined) ?? []); setPosition(null); setAvailability(null); }
    if (pageMeta?.coverage === 'INCOMPLETE' || (pageMeta?.reasons?.length ?? 0) > 0) setNotice('El servidor marcó datos incompletos. No se completan ni se suman dos veces.');
  }

  const prefix = scope === 'BUSINESS' ? 'business' : 'personal';
  return (
    <section className="panel desk">
      <h1>Fondos y activos</h1>
      <p>El disponible libre lo entrega el servidor. Una reserva virtual no es un traslado y un estimado no es efectivo ni rentabilidad realizada.</p>
      <div className="report-head" role="group" aria-label="Ámbito">
        {isT ? <button type="button" disabled={pending} aria-pressed={scope === 'BUSINESS'} onClick={() => changeScope('BUSINESS')}>Negocio</button> : <Alert tone="info">Este ámbito de negocio no está en tu rol. No se consultan sus fondos ni sus activos.</Alert>}
        <button type="button" disabled={pending} aria-pressed={scope === 'PERSONAL'} onClick={() => changeScope('PERSONAL')}>Personal</button>
      </div>
      {scope === 'PERSONAL' && personalState === 'absent' ? <Alert tone="info">El libro personal no está habilitado en esta sesión. Ábrelo en Gastos y obligaciones; esta pantalla no lo copia del negocio.</Alert> : null}
      <div className="report-head">
        <button type="button" disabled={!base || pending} onClick={() => { setError(null); setPending(true); void load('funds').catch(setError).finally(() => setPending(false)); }}>Ver fondos</button>
        <button type="button" disabled={!base || pending} onClick={() => { setError(null); setPending(true); void load('assets').catch(setError).finally(() => setPending(false)); }}>Ver activos</button>
        <button type="button" disabled={!base || pending} onClick={() => { setError(null); setPending(true); void load('positions').catch(setError).finally(() => setPending(false)); }}>Ver posición</button>
        {scope === 'PERSONAL' ? <button type="button" disabled={pending} onClick={() => { setError(null); setPending(true); void load('wealth').catch(setError).finally(() => setPending(false)); }}>Ver consolidado privado</button> : null}
      </div>
      <ErrorText error={error} />
      {error instanceof ApiError && (error.status === 503 || error.status === 0) && uncertain.current ? <Alert tone="error">No se confirmó la operación. Puedes reintentar con la misma clave.</Alert> : null}
      {notice ? <Alert tone="info">{notice}</Alert> : null}
      {meta ? <p>{meta.scope === 'PRIVATE_CONSOLIDATED' ? 'Consolidado privado.' : meta.scope === 'PERSONAL' ? 'Ámbito personal.' : 'Ámbito de negocio.'} {meta.coverage === 'COMPLETE' ? 'Cobertura completa.' : 'Cobertura incompleta.'} {(meta.reasons ?? []).map(reason => REASONS[reason] ?? 'El servidor señaló un motivo que esta pantalla no reconoce.').join(' ')}</p> : null}
      {base ? <FundForms key={"fund:"+owner+scope} base={base} today={today} owner={owner} scope={scope} prefix={prefix} bookTag={bookTag} refreshBook={refreshBook} pending={pending} setPending={setPending} setError={setError} send={send} onDone={message => { setNotice(message); void load('funds').catch(setError); }} /> : null}
      {base ? <AvailabilityForm pending={pending} setPending={setPending} setError={setError} onLoad={accountId => load('availability', accountId)} /> : null}
      {availability ? <AvailabilityView row={availability} /> : null}
      {base ? <AssetForms key={"asset:"+owner+scope} base={base} today={today} prefix={prefix} bookTag={bookTag} refreshBook={refreshBook} pending={pending} setPending={setPending} setError={setError} send={send} onDone={message => { setNotice(message); void load('assets').catch(setError); }} /> : null}
      {base ? <WealthOperations key={"operation:"+owner+scope} base={base} today={today} prefix={prefix} pending={pending} setPending={setPending} setError={setError} send={send} onDone={message => { setBookTag(null); setNotice(message); void load('positions').catch(setError); }} /> : null}
      <Listing items={items} />
      {position ? <PositionView row={position} /> : null}
    </section>
  );
}

function FundForms({ base, today, owner, scope, prefix, refreshBook, pending, setPending, setError, send, onDone }: {
  base: string; today: string; owner: string; scope: ScopeKind; prefix: string; bookTag: string | null;
  refreshBook: () => Promise<string | null>; pending: boolean; setPending: (v: boolean) => void; setError: (e: unknown) => void;
  send: (operation: string, purpose: string, path: string, payload: Row, resourceId?: string, expected?: string) => Promise<{ data: Row; etag: string | null }>;
  onDone: (message: string) => void;
}) {
  const draftKey = `${PREFIX}${owner}|${scope}|fund`;
  const stored = readDraft(draftKey);
  const [label, setLabel] = useState(stored.label ?? '');
  const [purpose, setPurpose] = useState(stored.purpose || 'SAVINGS');
  const [mode, setMode] = useState(stored.mode || 'VIRTUAL');
  const [accountId, setAccountId] = useState('');
  const [support, setSupport] = useState(stored.support ?? '');
  const [fundId, setFundId] = useState('');
  const [etag, setEtag] = useState('');
  const [amount, setAmount] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => { sessionStorage.setItem(draftKey, JSON.stringify({ label, purpose, support, mode })); }, [draftKey, label, purpose, support, mode]);
  return (
    <>
      <form onSubmit={onSubmit(async () => {
        if (!label.trim() || !support.trim() || !accountId.trim()) throw new ApiError(422, 'INPUT_INVALID', null, 'Indica el nombre, la cuenta de respaldo y el soporte.');
        const result = await send(`${prefix}CreateFund`, 'FUND_CREATE', `${base}/funds`, { mode, label: label.trim(), purpose, backingAccountId: accountId.trim(), supportReference: support.trim() });
        setFundId(String((result.data as Row).id ?? ''));
        setEtag(result.etag ?? '');
        onDone(mode === 'VIRTUAL' ? 'Fondo virtual registrado. Reservar después no crea dinero.' : 'Fondo enlazado registrado. Solo un traslado confirmado mueve efectivo.');
      }, setPending, setError)}>
        <h2>{mode === 'VIRTUAL' ? 'Fondo virtual' : 'Fondo enlazado a cuenta'}</h2>
        <Field label="Tipo de fondo"><select value={mode} onChange={event => setMode(event.target.value)}><option value="VIRTUAL">Reserva virtual</option><option value="ACCOUNT_LINKED">Fondo enlazado a cuenta real</option></select></Field>
        <p>Crear el fondo solo lo nombra. No mueve efectivo ni aumenta el disponible.</p>
        <Field label="Nombre"><input value={label} onChange={event => setLabel(event.target.value)} required /></Field>
        <Field label="Destino"><select value={purpose} onChange={event => setPurpose(event.target.value)}><option value="SAVINGS">Ahorro</option><option value="LOAN_CAPITAL">Capital de préstamo</option><option value="ASSET_PURCHASE">Compra de activo</option><option value="OTHER_DECLARED">Otro, declarado</option></select></Field>
        <Field label="Cuenta de respaldo"><input value={accountId} onChange={event => setAccountId(event.target.value)} required /></Field>
        <Field label="Soporte"><input value={support} onChange={event => setSupport(event.target.value)} required /></Field>
        <button type="submit" disabled={pending}>Registrar fondo</button>
      </form>
      <form onSubmit={onSubmit(async () => {
        const canonical = moneyOrThrow('Reserva', amount);
        const tag = await refreshBook();
        if (!fundId || !etag || !tag) throw new ApiError(428, 'ETAG_REQUIRED', null, messageFor('ETAG_REQUIRED', 428));
        if (!preview) { setPreview(`${cash(canonical)} el ${today}. Es una reserva sobre disponible libre, no un traslado ni dinero nuevo.`); return; }
        await send(`${prefix}AllocateFund`, 'FUND_ALLOCATE', `${base}/funds/${fundId}/allocations`, { bookETag: tag, effectiveDate: today, amount: canonical, supportReference: support.trim() }, fundId, etag);
        setPreview(null);
        onDone('El servidor registró la reserva. El disponible visible es el de la consulta, no el del formulario.');
      }, setPending, setError)}>
        <h2>Reservar en el fondo</h2>
        <Field label="Fondo"><input value={fundId} onChange={event => { setFundId(event.target.value); setPreview(null); }} /></Field>
        <Field label="Versión del fondo"><input value={etag} onChange={event => { setEtag(event.target.value); setPreview(null); }} /></Field>
        <Field label="Importe a reservar"><input inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value); setPreview(null); }} /></Field>
        {preview ? <p>Vista previa: {preview}</p> : null}
        <button type="submit" disabled={pending}>{preview ? 'Confirmar reserva' : 'Revisar reserva'}</button>
      </form>
    </>
  );
}

function AvailabilityForm({ pending, setPending, setError, onLoad }: { pending: boolean; setPending: (v: boolean) => void; setError: (e: unknown) => void; onLoad: (accountId: string) => Promise<void> }) {
  const [accountId, setAccountId] = useState('');
  return (
    <form onSubmit={onSubmit(async () => { if (!accountId.trim()) throw new ApiError(422, 'INPUT_INVALID', null, 'Indica la cuenta.'); await onLoad(accountId.trim()); }, setPending, setError)}>
      <h2>Disponible de la cuenta</h2>
      <Field label="Cuenta"><input value={accountId} onChange={event => setAccountId(event.target.value)} required /></Field>
      <button type="submit" disabled={pending}>Consultar disponible</button>
    </form>
  );
}

function AvailabilityView({ row }: { row: Row }) {
  return (
    <div className="metric-grid">
      <article className="metric-card"><h3>Efectivo confirmado</h3><p>{cash(row.confirmedCash)}</p></article>
      <article className="metric-card"><h3>Protegido por custodia</h3><p>{cash(row.legacyProtected)}</p></article>
      <article className="metric-card"><h3>Reservado en fondos</h3><p>{cash(row.fundReserved)}</p></article>
      <article className="metric-card"><h3>Libre</h3><p>{cash(row.free)}</p><p>Es el disponible del servidor, no el saldo bruto.</p></article>
    </div>
  );
}

function AssetForms({ base, today, prefix, bookTag, refreshBook, pending, setPending, setError, send, onDone }: {
  base: string; today: string; prefix: string; bookTag: string | null; refreshBook: () => Promise<string | null>;
  pending: boolean; setPending: (v: boolean) => void; setError: (e: unknown) => void;
  send: (operation: string, purpose: string, path: string, payload: Row, resourceId?: string, expected?: string) => Promise<{ data: Row; etag: string | null }>;
  onDone: (message: string) => void;
}) {
  const [assetClass, setAssetClass] = useState('APARTMENT');
  const [label, setLabel] = useState('');
  const [ownerRef, setOwnerRef] = useState('');
  const [percentage, setPercentage] = useState('');
  const [accountId, setAccountId] = useState('');
  const [support, setSupport] = useState('');
  const [assetId, setAssetId] = useState('');
  const [etag, setEtag] = useState('');
  const [estimate, setEstimate] = useState('');
  const [method, setMethod] = useState('OWNER_ESTIMATE');
  const [source, setSource] = useState('');
  return (
    <>
      <form onSubmit={onSubmit(async () => {
        if (!label.trim() || !ownerRef.trim() || !accountId.trim() || !support.trim()) throw new ApiError(422, 'INPUT_INVALID', null, 'Indica el nombre, el titular, la cuenta y el soporte.');
        const result = await send(`${prefix}CreateAssetDraft`, 'ASSET_DRAFT_CREATE', `${base}/assets`, {
          assetClass, otherClassDescription: assetClass === 'OTHER_DECLARED' ? label.trim() : null, label: label.trim(), origin: 'PURCHASE',
          legalOwnerReference: ownerRef.trim(), ownershipPercentage: percentage.trim() || null, grossCostDeclared: null,
          assetAccountId: accountId.trim(), supportReferences: [support.trim()], locationGeneral: null,
        });
        setAssetId(String((result.data as Row).id ?? ''));
        setEtag(result.etag ?? '');
        onDone('Borrador registrado. Todavía no es una compra ni un costo reconocido.');
      }, setPending, setError)}>
        <h2>Borrador de activo</h2>
        <p>El costo reconocido aparece cuando el servidor registra la adquisición. Esta pantalla no repite una compra ya hecha.</p>
        <Field label="Clase"><select value={assetClass} onChange={event => setAssetClass(event.target.value)}>{CLASSES.map(item => <option key={item} value={item}>{CLASS_LABEL[item]}</option>)}</select></Field>
        <Field label="Nombre del activo"><input value={label} onChange={event => setLabel(event.target.value)} required /></Field>
        <Field label="Titular declarado"><input value={ownerRef} onChange={event => setOwnerRef(event.target.value)} required /></Field>
        <Field label="Porcentaje" hint="Texto 100.00 o 40.00. Vacío significa no declarado."><input value={percentage} onChange={event => setPercentage(event.target.value)} /></Field>
        <Field label="Cuenta del activo"><input value={accountId} onChange={event => setAccountId(event.target.value)} required /></Field>
        <Field label="Soporte del activo"><input value={support} onChange={event => setSupport(event.target.value)} required /></Field>
        <button type="submit" disabled={pending}>Registrar borrador</button>
      </form>
      <form onSubmit={onSubmit(async () => {
        if (!assetId || !etag) throw new ApiError(428, 'ETAG_REQUIRED', null, messageFor('ETAG_REQUIRED', 428));
        const value = moneyOrThrow('Estimado', estimate);
        if (!source.trim() || !support.trim()) throw new ApiError(422, 'INPUT_INVALID', null, 'Indica la fuente y el soporte del estimado.');
        const current = await call<Row>('GET', `${base}/assets/${assetId}?asOf=${today}`);
        await send(`${prefix}RecordAssetValuation`, 'ASSET_VALUATION_RECORD', `${base}/assets/${assetId}/valuations`, { valuationDate: today, grossEstimatedValue: value, method, sourceReference: source.trim(), supportReference: support.trim() }, assetId, current.etag ?? undefined);
        onDone('Estimado registrado. No es efectivo ni rentabilidad realizada.');
      }, setPending, setError)}>
        <h2>Estimado</h2>
        <Field label="Activo"><input value={assetId} onChange={event => setAssetId(event.target.value)} /></Field>
        <Field label="Versión del activo"><input value={etag} onChange={event => setEtag(event.target.value)} /></Field>
        <Field label="Valor estimado bruto"><input inputMode="decimal" value={estimate} onChange={event => setEstimate(event.target.value)} /></Field>
        <Field label="Método"><select value={method} onChange={event => setMethod(event.target.value)}>{Object.entries(METHODS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></Field>
        <Field label="Fuente del estimado"><input value={source} onChange={event => setSource(event.target.value)} /></Field>
        <button type="submit" disabled={pending}>Registrar estimado</button>
      </form>
      <p>La renta y la baja usan el evento real del servidor. No hay cotización externa ni un segundo gasto desde esta pantalla.</p>
      <button type="button" disabled={pending || !bookTag} onClick={() => { setError(null); setPending(true); void refreshBook().catch(setError).finally(() => setPending(false)); }}>Leer versión del libro</button>
    </>
  );
}

function Listing({ items }: { items: Row[] }) {
  if (items.length === 0) return null;
  return (
    <ul>
      {items.map(item => {
        const valuation = item.valuation as Row | null | undefined;
        return (
          <li key={String(item.id)}>
            <p>{String(item.label ?? 'Registro del servidor')}</p>
            {item.mode ? <p>{item.mode === 'VIRTUAL' ? 'Reserva virtual. No es un traslado.' : 'Fondo enlazado a una cuenta.'} Reservado {cash(item.reserved)}.</p> : null}
            {item.recognizedCost !== undefined ? <p>Costo reconocido {cash(item.recognizedCost)}.</p> : null}
            {item.grossCostDeclared !== undefined ? <p>Costo declarado {item.grossCostDeclared === null ? 'Sin costo declarado.' : cash(item.grossCostDeclared)}.</p> : null}
            {item.ownedEstimatedValue !== undefined ? <p>{item.ownedEstimatedValue === null ? 'Sin estimado en este corte. No se usa cero.' : `Porción estimada ${cash(item.ownedEstimatedValue)}. No es rentabilidad realizada.`}</p> : null}
            {valuation ? <p>Estimado del {String(valuation.valuationDate ?? '')}, {METHODS[String(valuation.method ?? '')] ?? 'Método del servidor'}.</p> : null}
            {item.linkedPrincipal !== undefined ? <p>Deuda vinculada {cash(item.linkedPrincipal)}.</p> : null}
            {item.indicativeEquity !== undefined ? <p>{item.indicativeEquity === null ? 'Sin equidad indicativa.' : `Equidad indicativa ${cash(item.indicativeEquity)}. No es caja.`}</p> : null}
            {item.ownershipPercentage === null ? <p>Titularidad no declarada.</p> : typeof item.ownershipPercentage === 'string' ? <p>Porcentaje declarado {String(item.ownershipPercentage)}.</p> : null}
            {item.origin ? <p>Origen {ORIGINS[String(item.origin)] ?? 'Origen del servidor'}.</p> : null}
            {item.acquisitionEventId ? <p>Adquisición ya registrada. No se ofrece otra compra del mismo hecho.</p> : null}
            {item.sourceCompleteness === 'INCOMPLETE' ? <p>Fuentes incompletas.</p> : null}
            {Array.isArray(item.reasons) ? (item.reasons as string[]).map(reason => <p key={reason}>{REASONS[reason] ?? 'El servidor señaló un motivo que esta pantalla no reconoce.'}</p>) : null}
            {item.status === 'DRAFT' ? <p>Borrador.</p> : item.status === 'ACTIVE' ? <p>Activo.</p> : item.status === 'DISPOSED' ? <p>Dado de baja.</p> : null}
          </li>
        );
      })}
    </ul>
  );
}

function PositionView({ row }: { row: Row }) {
  const personal = row.personal as Row | undefined;
  const business = row.business as Row | null | undefined;
  const body = personal ?? row;
  return (
    <div className="report-layout">
      <h2>{personal ? 'Consolidado privado' : 'Posición'}</h2>
      <p>Costo, estimado, deuda y caja se muestran por separado. Un valor informativo no se suma otra vez al costo.</p>
      <div className="metric-grid">
        <article className="metric-card"><h3>Costo reconocido</h3><p>{cash(body.recognizedAssetCost)}</p></article>
        <article className="metric-card"><h3>Estimado de la porción</h3><p>{cash(body.ownedEstimatedValue)}</p></article>
        <article className="metric-card"><h3>Deuda vinculada</h3><p>{cash(body.linkedPrincipal)}</p></article>
        <article className="metric-card"><h3>Equidad indicativa</h3><p>{cash(body.indicativeEquity)}</p></article>
        <article className="metric-card"><h3>Caja disponible</h3><p>{cash(body.cashAvailable)}</p></article>
        <article className="metric-card"><h3>Rentas cobradas</h3><p>{cash(body.rentCashReceived)}</p></article>
        <article className="metric-card"><h3>Gastos vinculados pagados</h3><p>{cash(body.linkedOperatingCashPaid)}</p></article>
        <article className="metric-card"><h3>Flujo operativo neto</h3><p>{cash(body.operatingNetCash)}</p></article>
      </div>
      {typeof body.unvaluedCount === 'number' && body.unvaluedCount > 0 ? <p>{body.unvaluedCount} activos sin estimado. No entran como cero.</p> : null}
      {business ? <section aria-label="Posición del negocio elegible"><p>Negocio elegible por declaración explícita. Se muestra separado del personal.</p><PositionView row={business} /></section> : null}
      {row.ledgerGrossAssets !== undefined ? <p>Activos brutos contables: {cash(row.ledgerGrossAssets)}.</p> : null}
      {row.ledgerNetAssets !== undefined ? <p>Patrimonio contable neto: {cash(row.ledgerNetAssets)}.</p> : null}
      {row.indicativeOwnedAssets !== undefined ? <p>Activos indicativos del consolidado: {cash(row.indicativeOwnedAssets)}.</p> : null}
      {Array.isArray(row.eliminations) ? (row.eliminations as Row[]).map((item, index) => <p key={index}>Eliminación {cash(item.amount)}.</p>) : null}
    </div>
  );
}

function readDraft(key: string): Record<string, string> {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(key) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch { return {}; }
}
