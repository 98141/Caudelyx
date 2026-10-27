import { useEffect, useRef, useState } from 'react';
import { AccountPicker } from '../finance/account-picker';
import { call as apiCall, currentSessionEpoch } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { ApiError, inOrganization, purposeClass } from '../../shared/contracts';
import { parseLocalCop, todayBogota } from '../../shared/money';
import { ensureStepUp } from '../../shared/step-up';
import { Alert, Empty, ErrorText, Field, Submit, onSubmit } from '../../shared/ui';
import { money } from './payments-copy';

const DRAFT_KEY = 'caudelyx.s07.collections.draft';
const BUCKETS = [
  ['confirmedOnSite', 'Confirmado en el sitio'],
  ['provisionalOnSite', 'Provisional en el sitio'],
  ['returnRequiredOnSite', 'Pendiente de retorno'],
  ['heldOnSite', 'Fondos retenidos en el sitio'],
  ['inTransit', 'En tránsito'],
  ['receivedUnposted', 'Recibido sin contabilizar'],
  ['unlocatedDisputed', 'No ubicado o en disputa'],
  ['unidentifiedSurplus', 'Sobrante sin identificar'],
] as const;
const DELIVERY_STATE: Record<string, string> = {
  REQUESTED: 'Solicitada',
  IN_TRANSIT: 'En tránsito',
  RECEIVED_FOR_REVIEW: 'Recibida para conteo',
  COUNTED: 'Contada',
  DISCREPANCY: 'Con diferencia',
  INVESTIGATION: 'En revisión',
  CORRECTED: 'Corregida',
  CONFIRMED: 'Confirmada',
  RETURN_REQUIRED: 'Retorno pendiente',
  RETURN_IN_TRANSIT: 'Retorno en tránsito',
  RETURN_RECEIVED: 'Retorno recibido',
  CANCELLED: 'Cancelada',
};
const ACTION_KIND: Record<string, string> = {
  VISIT: 'Visita',
  CONTACT: 'Contacto',
  PROMISE: 'Promesa',
  NOTE: 'Nota',
};
const PURPOSE: Record<string, string> = {
  openCollectionJourney: 'COLLECTION_JOURNEY_OPEN',
  closeCollectionJourney: 'COLLECTION_JOURNEY_CLOSE',
  recordCollectionAction: 'COLLECTION_ACTION_RECORD',
  requestCashDelivery: 'CASH_DELIVERY_REQUEST',
  dispatchCashDelivery: 'CASH_DELIVERY_DISPATCH',
  receiveCashDelivery: 'CASH_DELIVERY_RECEIVE',
  countCashDelivery: 'CASH_DELIVERY_COUNT',
  confirmCashDelivery: 'CASH_DELIVERY_CONFIRM',
  createCashClose: 'CASH_CLOSE_CREATE',
  correctCollectionAction:'COLLECTION_ACTION_CORRECT', setCashStation:'CASH_STATION_SET', finalizeCashClose:'CASH_CLOSE_FINALIZE',
  investigateCashDelivery:'CASH_DELIVERY_INVESTIGATE', acknowledgeCashDeliveryCount:'CASH_DELIVERY_ACK', correctCashDelivery:'CASH_DELIVERY_CORRECT',
  cancelCashDelivery:'CASH_DELIVERY_CANCEL', requestCashDeliveryReturn:'CASH_DELIVERY_RETURN_REQUEST', recordCashDeliveryReturnFact:'CASH_DELIVERY_RETURN_FACT', confirmCashDeliveryReturn:'CASH_DELIVERY_RETURN_CONFIRM',
  requestCashDeliveryCompensation:'CASH_DELIVERY_COMPENSATION_REQUEST', confirmCashDeliveryCompensation:'CASH_DELIVERY_COMPENSATION_CONFIRM',
};

interface Page<T> { items: T[]; nextCursor?: string | null }
interface Buckets { confirmedOnSite: string; provisionalOnSite: string; returnRequiredOnSite: string; heldOnSite: string; inTransit: string; receivedUnposted: string; unlocatedDisputed: string; unidentifiedSurplus: string }
interface PortfolioItem { loanId: string; loanReference: string; borrowerCode: string; borrowerName: string; principalOutstanding: string; dueAmount: string }
interface Journey { id: string; status: string; workDate: string; openedAt: string; ownerId: string; version:number }
interface ActionRow { id: string; kind: string; note: string; loanId: string; promisedAmount: string | null; ownerId:string; journeyId:string; supersedesActionId:string|null; version:number }
interface Station { stationId: string; stationETag: string; accountId: string; accountLabel: string; receiverId: string; receiverName: string; active: boolean }
interface Position { responsibleId: string; accountId: string; accountETag: string; bindingETag: string | null; ledgerBalance: string; retainedAtOrigin: string; committed: string; uncommitted: string; available: string; held: string; deliveredNet: string; physical: Buckets }
interface CustodyLot { id: string; paymentId: string; accountId: string; amountHeld: string; state: string }
interface Delivery { id: string; state: string; amount: string; senderId: string; receiverId: string; countId: string | null; version: number; recordedAt: string; kind:string; originalDeliveryId:string|null; compensatingDeliveryId:string|null; sourceAccountId:string; destinationAccountId:string; receivedAt:string|null; lastCount:string|null; senderAckId:string|null }
interface CashClose { id: string; subjectId:string; accountId:string; journeyId:string|null; state: string; countStatus: string; expected: Buckets; counted: Buckets | null; pendingRefs: { kind: string; resourceId: string }[] }
interface Preview { state:{collectionsBookETag:string}; token: string; expiresAt: string; plan: { effectiveDate: string; before: Position[]; after: Position[]; currentPreconditions?: unknown[] } }
interface Frozen { operation:string; payload:Record<string,unknown>; resourceId:string|null; etag:string; key:string }
interface Draft { frozen?:Frozen|null; owner: string; key: string; note: string; amount: string; support: string; loanId: string }

function emptyBuckets(): Buckets {
  return { confirmedOnSite: '0.00', provisionalOnSite: '0.00', returnRequiredOnSite: '0.00', heldOnSite: '0.00', inTransit: '0.00', receivedUnposted: '0.00', unlocatedDisputed: '0.00', unidentifiedSurplus: '0.00' };
}
function readDraft(owner: string): Draft | null {
  try {const raw=sessionStorage.getItem(DRAFT_KEY);if(!raw)return null;const draft=JSON.parse(raw) as Draft;
    if(draft.owner!==owner){sessionStorage.removeItem(DRAFT_KEY);return null;}return draft;
  }catch{sessionStorage.removeItem(DRAFT_KEY);return null;}
}

export function CollectionsScreen() {
  const { me, phase } = useAuth();
  useEffect(()=>{if(phase==='anonymous')sessionStorage.removeItem(DRAFT_KEY);},[phase]);
  const ready = phase === 'ready' && inOrganization(me);
  if (!ready || !me?.organizationId || !me.userId) return <section className="panel desk"><h1>Cobranza y caja</h1><Empty>Entra a una organización para ver la cartera y la caja.</Empty></section>;
  return <CollectionsWorkspace key={`${me.userId}|${me.organizationId}|${[...(me.roleIds ?? [])].sort().join(',')}`} />;
}

function CollectionsWorkspace() {
  const { me } = useAuth();
  const organizationId = me?.organizationId ?? '';
  const actorId = me?.userId ?? '';
  const roles = me?.roleIds ?? [];
  const titular = roles.includes('T');
  const worker = roles.some(role => role === 'T' || role === 'O' || role === 'C');
  const owner = `${actorId}|${organizationId}|${[...roles].sort().join(',')}`;
  const base = `/organizations/${organizationId}`;
  const [portfolio, setPortfolio] = useState<PortfolioItem[]>([]);
  const [journeys, setJourneys] = useState<Journey[]>([]);
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [lots, setLots] = useState<CustodyLot[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [closes, setCloses] = useState<CashClose[]>([]);
  const [loanId, setLoanId] = useState('');
  const [note, setNote] = useState('');
  const [kind, setKind] = useState('NOTE');
  const [promiseAmount,setPromiseAmount]=useState(''),[promiseDate,setPromiseDate]=useState(todayBogota()),[actionId,setActionId]=useState('');
  const [facts,setFacts]=useState<{id:string;kind:string;amount:string|null;actorId:string;occurredAt:string}[]>([]);
  const [closePosition,setClosePosition]=useState(''),[closeMode,setCloseMode]=useState('EXACT'),[missingCount,setMissingCount]=useState(false);
  const [members,setMembers]=useState<{userId:string;displayName:string;roleIds:string[];version:string}[]>([]);
  const [stationConfig,setStationConfig]=useState(''),[stationAccount,setStationAccount]=useState(''),[stationAccountTag,setStationAccountTag]=useState(''),[stationReceiver,setStationReceiver]=useState('');
  const newStation=useRef(crypto.randomUUID());
  const sessionEpoch=useRef(currentSessionEpoch());
  const active=useRef(true),controller=useRef(new AbortController()),sending=useRef(false);
  useEffect(()=>{active.current=true;controller.current=new AbortController();return()=>{active.current=false;controller.current.abort();};},[]);
  const [stationId, setStationId] = useState('');
  const [lotId, setLotId] = useState('');
  const [amount, setAmount] = useState('');
  const [support, setSupport] = useState('');
  const [reason, setReason] = useState('Conteo declarado en la jornada');
  const [deliveryId, setDeliveryId] = useState('');
  const [counted, setCounted] = useState<Buckets>(emptyBuckets());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewCommand, setPreviewCommand] = useState<Record<string, unknown> | null>(null);
  const [previewKind, setPreviewKind] = useState<'REQUEST' | 'CONFIRM' | 'COMPENSATE_REQUEST' | 'COMPENSATE_CONFIRM' | null>(null);
  const [consent, setConsent] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [domainClosed, setDomainClosed] = useState(false);
  const [ready, setReady] = useState(false);
  const book = useRef('');
  const keyRef = useRef<string>(crypto.randomUUID());
  const frozen = useRef<Frozen | null>(null);
  const sawSession = useRef(false);

  function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, headers?: { ifMatch?: string; idempotencyKey?: string }) {
    if(!active.current)throw new ApiError(0,'DISCARDED',null,'La pantalla cambió.');
    return apiCall<T>(method, path, body, {...headers,signal:controller.current.signal});
  }

  async function pages<T>(path:string,limit='100'):Promise<T[]>{
    const rows:T[]=[];let cursor:string|null=null;
    do{const result:{data:Page<T>}=await call<Page<T>>('GET',path+(path.includes('?')?'&':'?')+new URLSearchParams({limit,...(cursor?{cursor}:{})}));rows.push(...result.data.items);cursor=result.data.nextCursor??null;}while(cursor);
    return rows;
  }
  function invalidate(){if(frozen.current||sending.current)return false;setPreview(null);setPreviewCommand(null);setPreviewKind(null);setConsent(false);return true;}
  function supportValue(){if(!support.trim())throw new ApiError(422,'INPUT_INVALID',null,'Indica el soporte antes de continuar.');return support.trim();}
  function save(){if(!active.current||controller.current.signal.aborted||sessionEpoch.current!==currentSessionEpoch())return;sessionStorage.setItem(DRAFT_KEY,JSON.stringify({owner,key:keyRef.current,note,amount,support,loanId,frozen:frozen.current}));}
  async function load() {
    const state = await call<{ collectionsBookETag: string }>('GET', `${base}/collections/state`);
    book.current = state.data.collectionsBookETag;
    const [folio, journeyPage, actionPage, stationPage, positionPage, lotPage, deliveryPage, closePage] = await Promise.all([
      pages<PortfolioItem>(`${base}/collection-portfolio`),
      pages<Journey>(`${base}/collection-journeys`),
      pages<ActionRow>(`${base}/collection-actions`),
      pages<Station>(`${base}/cash-stations`),
      pages<Position>(`${base}/cash-positions`),
      pages<CustodyLot>(`${base}/cash-custody`),
      pages<Delivery>(`${base}/cash-deliveries`),
      pages<CashClose>(`${base}/cash-closes`),
    ]);
    setPortfolio(folio);
    setJourneys(journeyPage);
    setActions(actionPage);
    setStations(stationPage.filter(item => item.active));
    setPositions(titular ? positionPage : positionPage.filter(item => item.responsibleId === actorId));
    setLots(lotPage);
    setDeliveries(deliveryPage);
    setCloses(closePage);
    if(titular)setMembers(await pages('/organization/members','50'));
    setDomainClosed(false);
  }

  useEffect(() => {
    if (!worker) return;
    const saved = readDraft(owner);
    if (saved) {
      keyRef.current = saved.key;
      setNote(saved.note);
      setAmount(saved.amount);
      setSupport(saved.support);
      setLoanId(saved.loanId);
      if(saved.frozen){frozen.current=saved.frozen;setUncertain(true);}
    }
    setReady(true);
    let live = true;
    void load().catch(caught => { if (live) setError(caught); if (caught instanceof ApiError && caught.status === 503) setDomainClosed(true); });
    return () => { live = false; };
  }, [owner, worker]);

  useEffect(() => {
    if (!ready||!active.current||sessionEpoch.current!==currentSessionEpoch()) return;
    const draft: Draft = { owner, key: keyRef.current, note, amount, support, loanId, frozen:frozen.current };
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  }, [ready, owner, note, amount, support, loanId]);

  useEffect(() => {
    if (actorId) sawSession.current = true;
    else if (sawSession.current) sessionStorage.removeItem(DRAFT_KEY);
  }, [actorId]);

  const openJourney = journeys.find(item => item.status === 'OPEN' && item.ownerId===actorId) ?? null;
  const delivery = deliveries.find(item => item.id === deliveryId) ?? null;
  const ownPosition = positions.find(item => `${item.responsibleId}|${item.accountId}`===closePosition) ?? positions.find(item => item.responsibleId === actorId) ?? null;

  async function resourceEtag(path: string): Promise<string> {
    const read = await call<unknown>('GET', path);
    if (!read.etag) throw new ApiError(428, 'ETAG_REQUIRED', null, 'Falta la versión del recurso. No se envió.');
    return read.etag;
  }

  async function send(operation:string,payload:Record<string,unknown>,resourceId:string|null){
    if(sending.current)return;sending.current=true;
    try{
      if(domainClosed)throw new ApiError(503,'SERVICE_UNAVAILABLE',null,'Actualiza la disponibilidad antes de reintentar. No se envió.');
      const request:Frozen=frozen.current??{operation,payload,resourceId,etag:book.current,key:keyRef.current};
      const purpose=PURPOSE[request.operation];if(!purpose||!request.etag)throw new ApiError(422,'INPUT_INVALID',null,'Acción o versión no reconocida.');
      const command={organizationId,idempotencyKey:request.key,expectedETag:request.etag,operationId:request.operation,resourceId:request.resourceId,payload:request.payload};
      if(purposeClass(purpose))await ensureStepUp({purpose,...(request.resourceId?{resourceId:request.resourceId}:{}),command,summary:'Confirmar la acción de caja. El plan no la ejecuta.'});
      frozen.current=request;save();
      const result=await call<{replayed?:boolean;entityId?:string}>('POST',actionPath(base,request.operation,request.resourceId),request.payload,{ifMatch:request.etag,idempotencyKey:request.key});
      frozen.current=null;keyRef.current=crypto.randomUUID();save();setUncertain(false);setPreview(null);setPreviewCommand(null);setPreviewKind(null);setConsent(false);
      setNotice(result.data.replayed?'El servidor ya tenía este comando. No se duplicó.':'El servidor confirmó el comando. Cerrar esta pantalla no libera el efectivo.');
      if(result.data.entityId&&['requestCashDelivery','confirmCashDelivery','requestCashDeliveryCompensation','confirmCashDeliveryCompensation'].includes(request.operation))setDeliveryId(result.data.entityId);
      await load();
    }catch(caught){
      if(caught instanceof ApiError){
        if([0,503].includes(caught.status)||caught.code==='IDEMPOTENCY_CONFLICT'){setUncertain(Boolean(frozen.current));if(caught.status===503)setDomainClosed(true);}
        else{frozen.current=null;save();setUncertain(false);setPreview(null);setConsent(false);}
      }
      throw caught;
    }finally{sending.current=false;}
  }
  async function refresh(){setError(null);try{await load();}catch(caught){setPortfolio([]);setPositions([]);setDeliveries([]);setActions([]);setCloses([]);setError(caught);if(caught instanceof ApiError&&caught.status===503)setDomainClosed(true);}}
  async function fact(operation:string,extra:Record<string,unknown>={}){
    if(!delivery)return;const tag=await resourceEtag(`${base}/cash-deliveries/${delivery.id}`);
    await send(operation,{resourceETag:tag,occurredAt:new Date().toISOString(),reason:reason.trim(),supportReference:supportValue(),...extra},delivery.id);
  }
  async function ack(operation:string){if(!delivery?.countId)return;await send(operation,{resourceETag:await resourceEtag(`${base}/cash-deliveries/${delivery.id}`),countId:delivery.countId,countETag:`"${delivery.countId}:1"`,reason:reason.trim(),supportReference:supportValue()},delivery.id);}
  function run(work:()=>Promise<void>){setPending(true);setError(null);void work().catch(setError).finally(()=>setPending(false));}
  async function selectDelivery(id:string){if(frozen.current)return;setDeliveryId(id);setPreview(null);setConsent(false);setFacts(await pages(`${base}/cash-deliveries/${id}/facts`));}

  async function ask(next: 'REQUEST' | 'CONFIRM' | 'COMPENSATE_REQUEST' | 'COMPENSATE_CONFIRM') {
    if (frozen.current) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', null, 'Hay un comando sin confirmar. No se pide otro plan ni otra clave.');
    let command: Record<string, unknown>;
    if (next === 'REQUEST') {
      const station = stations.find(item => item.stationId === stationId);
      const lot = lots.find(item => item.id === lotId);
      const canonical = parseLocalCop(amount);
      const position = positions.find(item => item.accountId === lot?.accountId && item.responsibleId === actorId);
      if (!station || !lot || !position || !canonical) throw new ApiError(422, 'INPUT_INVALID', null, 'Faltan la caja, el lote o el importe. No se pidió el plan.');
      const custodyEtag = await resourceEtag(`${base}/cash-custody/${lot.id}`);
      command = { kind: 'REQUEST', stationId: station.stationId, stationETag: station.stationETag, sourceAccountId: position.accountId, sourceAccountETag: position.accountETag, bindingETag: position.bindingETag, journeyId: openJourney?.id ?? null, amount: canonical, portions: [{ sourcePaymentId: lot.paymentId, sourceCustodyETag: custodyEtag, amount: canonical }], supportReference: support.trim() };
    } else if(next==='COMPENSATE_REQUEST'){
      if(!delivery)return;command={kind:next,originalDeliveryId:delivery.id,resourceETag:await resourceEtag(`${base}/cash-deliveries/${delivery.id}`),reason:reason.trim(),supportReference:supportValue()};
    } else {
      if (!delivery?.countId) throw new ApiError(422, 'INPUT_INVALID', null, 'Falta el conteo de la entrega. No se pidió la confirmación.');
      const deliveryEtag = await resourceEtag(`${base}/cash-deliveries/${delivery.id}`);
      command = { kind: next, deliveryId: delivery.id, resourceETag: deliveryEtag, countId: delivery.countId, countETag: `"${delivery.countId}:1"`, effectiveDate: todayBogota(), supportReference: supportValue() };
    }
    const result = await call<Preview>('POST', `${base}/cash-delivery-previews`, { executionKey: keyRef.current, command });
    book.current=result.data.state.collectionsBookETag;
    setPreview(result.data);
    setPreviewCommand(command);
    setPreviewKind(next);
    setConsent(false);
    setNotice(null);
  }

  async function recordNote() {
    if (!openJourney) throw new ApiError(422, 'INPUT_INVALID', null, 'No hay una jornada abierta. No se guardó la gestión.');
    if (!loanId || !note.trim() || !support.trim()) throw new ApiError(422, 'INPUT_INVALID', null, 'Faltan el préstamo, la nota o el soporte. No se guardó.');
    const journeyEtag = await resourceEtag(`${base}/collection-journeys/${openJourney.id}`);
    await send('recordCollectionAction', { resourceETag: journeyEtag, loanId, kind, occurredAt: new Date().toISOString(), note: note.trim(), supportReference: support.trim(), promisedAmount: kind==='PROMISE'?parseLocalCop(promiseAmount):null, promisedDate:kind==='PROMISE'?promiseDate:null }, openJourney.id);
  }

  async function declareClose() {
    if (!ownPosition) throw new ApiError(422, 'INPUT_INVALID', null, 'No hay una posición propia para arquear. No se declaró.');
    const declared = emptyBuckets();
    for (const [key] of BUCKETS) {
      const raw = counted[key].trim();
      const canonical = /^(0|[1-9]\d{0,15})\.\d{2}$/.test(raw) ? raw : parseLocalCop(raw);
      if (!canonical) throw new ApiError(422, 'INPUT_INVALID', null, 'Falta un importe contado. No se declaró el arqueo.');
      declared[key] = canonical;
    }
    await send('createCashClose', {
      accountId: ownPosition.accountId, accountETag: ownPosition.accountETag, subjectId: ownPosition.responsibleId, journeyId: journeys.find(j=>j.ownerId===ownPosition.responsibleId&&j.status==='OPEN')?.id ?? null,
      observedAt: new Date().toISOString(), counted: missingCount?null:declared, countStatus: missingCount?'MISSING':'DECLARED', denominations: [], supersedesCloseId: null, reason: reason.trim(), supportReference: supportValue(),
    }, null);
  }

  return (
    <section className="panel desk" aria-busy={pending}>
      <h1>Cobranza y caja</h1>
      <Alert tone="info">Entorno local sintético. Una nota o una promesa no es un pago. Cerrar la jornada o esta pantalla no libera el efectivo.</Alert>
      <ErrorText error={error} />
      <Field label="Motivo de la acción"><input maxLength={160} value={reason} onChange={e=>{if(invalidate())setReason(e.target.value);}} /></Field>
      <button type="button" disabled={pending} onClick={()=>run(refresh)}>Actualizar datos</button>
      {error instanceof ApiError&&error.status===412?<p>La versión cambió. Actualiza los datos y pide un plan nuevo; no se cambió la intención.</p>:null}
      {domainClosed || (error instanceof ApiError && error.code === 'SERVICE_UNAVAILABLE') ? <p>El dominio no está disponible. Esta pantalla no lo reabre ni lo da por corregido.</p> : null}
      {notice ? <Alert tone="pending">{notice}</Alert> : null}
      {!worker ? <Empty>Este rol no opera la cobranza ni la caja.</Empty> : null}

      {worker && !domainClosed ? (
        <div className="desk-split">
          <div>
            <h2>Cartera autorizada</h2>
            {portfolio.length === 0 ? <Empty>No hay préstamos asignados en esta página.</Empty> : (
              <div className="schedule">
                <table>
                  <thead><tr><th>Código</th><th>Nombre</th><th>Préstamo</th><th>Saldo</th><th>Vencido</th></tr></thead>
                  <tbody>
                    {portfolio.map(item => (
                      <tr key={item.loanId}>
                        <td>{item.borrowerCode}</td><td>{item.borrowerName}</td><td>{item.loanReference}</td><td>{money(item.principalOutstanding)}</td><td>{money(item.dueAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <form onSubmit={onSubmit(recordNote, setPending, setError)}>
            <h2 className="span">Gestión de la jornada</h2>
            <p className="span">La nota queda en la jornada. No reduce la deuda ni aparece como saldo cobrado.</p>
            <Field label="Préstamo de la gestión">
              <select value={loanId} onChange={event => {if(invalidate())setLoanId(event.target.value);}}>
                <option value="">Elige el préstamo</option>
                {portfolio.map(item => <option key={item.loanId} value={item.loanId}>{item.borrowerCode} · {item.borrowerName} · {item.loanReference}</option>)}
              </select>
            </Field>
            <Field label="Tipo de gestión">
              <select value={kind} onChange={event => {if(invalidate())setKind(event.target.value);}}>
                <option value="NOTE">Nota</option>
                <option value="VISIT">Visita</option>
                <option value="CONTACT">Contacto</option><option value="PROMISE">Promesa</option>
              </select>
            </Field>
            {kind==='PROMISE'?<><Field label="Importe prometido"><input value={promiseAmount} onChange={e=>{if(invalidate())setPromiseAmount(e.target.value);}} /></Field><Field label="Fecha prometida"><input type="date" value={promiseDate} onChange={e=>{if(invalidate())setPromiseDate(e.target.value);}} /></Field></>:null}
            <Field label="Nota"><input value={note} maxLength={1000} onChange={event => {if(invalidate())setNote(event.target.value);}} /></Field>
            <Field label="Soporte"><input value={support} maxLength={160} onChange={event => {if(invalidate())setSupport(event.target.value);}} /></Field>
            {!openJourney ? <button type="button" disabled={pending || uncertain || !book.current} onClick={() => { setPending(true); void send('openCollectionJourney', { supportReference: support.trim() || 'jornada' }, null).catch(setError).finally(() => setPending(false)); }}>Abrir la jornada</button> : <p className="span">Jornada abierta del {openJourney.workDate}. Cerrarla no entrega el dinero.</p>}
            <Submit pending={pending} disabled={!openJourney||uncertain}>Registrar la gestión</Submit>
          </form>
        </div>
      ) : null}

      {worker && !domainClosed ? (
        <section aria-label="Custodia">
          <h2>Custodia</h2>
          <p>Cada cifra sale de la proyección del servidor. El saldo del libro no es el efectivo disponible de la persona. No se muestra una suma global ni el plan de cuentas bancarias.</p>
          {positions.length === 0 ? <Empty>No hay una posición de caja para este acceso.</Empty> : positions.map(position => (
            <article className="bucket-grid" key={`${position.responsibleId}-${position.accountId}`}>
              <p className="span">Tenedor {position.responsibleId === actorId ? 'tú' : 'otra persona autorizada'}. Reservado en origen {money(position.retainedAtOrigin)}. Comprometido {money(position.committed)}. Libre según el servidor {money(position.available)}. Fondos retenidos {money(position.held)}.</p>
              <p className="bucket"><span>Saldo del libro</span><strong>{money(position.ledgerBalance)}</strong></p>
              {BUCKETS.map(([key, label]) => <p className="bucket" key={key}><span>{label}</span><strong>{money(position.physical[key])}</strong></p>)}
            </article>
          ))}
        </section>
      ) : null}

      {actions.length > 0 ? (
        <section aria-label="Gestiones">
          <h2>Gestiones registradas</h2>
          <ul>{actions.map(item => <li key={item.id}>{ACTION_KIND[item.kind] ?? 'Gestión no reconocida'}. {item.note}. No es un pago{item.promisedAmount ? ` ni el saldo cobrado. Promesa declarada ${money(item.promisedAmount)}` : ''}.</li>)}</ul>
        </section>
      ) : null}

      {worker && !domainClosed ? (
        <form onSubmit={onSubmit(() => ask('REQUEST'), setPending, setError)}>
          <h2 className="span">Entrega de efectivo</h2>
          <p className="span">El importe puede ser parcial. El plan no mueve el dinero. El éxito aparece solo cuando el servidor confirma el comando.</p>
          <Field label="Caja de destino">
            <select value={stationId} onChange={event => {if(invalidate())setStationId(event.target.value);}}>
              <option value="">Elige la caja</option>
              {stations.map(item => <option key={item.stationId} value={item.stationId}>{item.receiverName} · {item.accountLabel}</option>)}
            </select>
          </Field>
          <Field label="Lote confirmado">
            <select value={lotId} onChange={event => {if(invalidate())setLotId(event.target.value);}}>
              <option value="">Elige el efectivo</option>
              {lots.filter(item => item.state === 'CONFIRMED_HELD').map(item => <option key={item.id} value={item.id}>Registro original {money(item.amountHeld)}; remanente según el plan</option>)}
            </select>
          </Field>
          <Field label="Importe a entregar"><input value={amount} inputMode="decimal" onChange={event => {if(invalidate())setAmount(event.target.value);}} /></Field>
          <Submit pending={pending} disabled={uncertain}>Pedir el plan de entrega</Submit>
        </form>
      ) : null}

      {preview && previewCommand && !domainClosed ? (
        <section aria-label="Plan de entrega">
          <h2>Plan del servidor</h2>
          <Alert tone="info">Plan sin efecto. Vence {new Date(preview.expiresAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}. No traslada el efectivo.</Alert>
          <p>Fecha {preview.plan.effectiveDate}. {preview.plan.currentPreconditions ? 'Incluye las versiones vigentes.' : 'Sin versiones vigentes reconocidas.'}</p>
          <div className="schedule"><table><caption>Posiciones previstas por el servidor</caption><thead><tr><th>Momento</th><th>Responsable y cuenta</th><th>Libro</th><th>Reservado en origen</th><th>Libre</th></tr></thead><tbody>{(['before','after'] as const).flatMap(moment=>preview.plan[moment].map(p=><tr key={`${moment}-${p.responsibleId}-${p.accountId}`}><td>{moment==='before'?'Antes':'Después'}</td><td>{p.responsibleId} · {p.accountId}</td><td>{money(p.ledgerBalance)}</td><td>{money(p.retainedAtOrigin)}</td><td>{money(p.available)}</td></tr>))}</tbody></table></div>
          <form onSubmit={onSubmit(async () => {
            if (!consent || !previewKind) throw new ApiError(422, 'INPUT_INVALID', null, 'Falta confirmar el plan. No se envió.');
            return send(({REQUEST:'requestCashDelivery',CONFIRM:'confirmCashDelivery',COMPENSATE_REQUEST:'requestCashDeliveryCompensation',COMPENSATE_CONFIRM:'confirmCashDeliveryCompensation'})[previewKind], {command:previewCommand,previewToken:preview.token},previewKind==='REQUEST'?null:String(previewKind==='COMPENSATE_REQUEST'?previewCommand.originalDeliveryId:previewCommand.deliveryId));
          }, setPending, setError)}>
            <label className="checks span"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /> Confirmo este plan del servidor.</label>
            <Submit pending={pending} disabled={!consent||uncertain||domainClosed}>{{REQUEST:'Solicitar la entrega',CONFIRM:'Confirmar la entrega',COMPENSATE_REQUEST:'Solicitar compensación',COMPENSATE_CONFIRM:'Confirmar compensación'}[previewKind??'REQUEST']}</Submit>
          </form>
        </section>
      ) : null}

      {delivery && !domainClosed ? (
        <section aria-label="Entrega seleccionada">
          <h2>Entrega {money(delivery.amount)}</h2>
          <p>Estado: {DELIVERY_STATE[delivery.state] ?? 'Estado no reconocido. No hay acciones.'}</p>
          {DELIVERY_STATE[delivery.state] && delivery.state === 'REQUESTED' && delivery.senderId === actorId ? <button type="button" disabled={pending||uncertain||domainClosed} onClick={() => { setPending(true); void resourceEtag(`${base}/cash-deliveries/${delivery.id}`).then(etag => send('dispatchCashDelivery', { resourceETag: etag, occurredAt: new Date().toISOString(), reason: reason.trim(), supportReference: support.trim() || 'despacho' }, delivery.id)).catch(setError).finally(() => setPending(false)); }}>Despachar</button> : null}
          {delivery.state === 'IN_TRANSIT' && delivery.receiverId === actorId ? <button type="button" disabled={pending||uncertain||domainClosed} onClick={() => { setPending(true); void resourceEtag(`${base}/cash-deliveries/${delivery.id}`).then(etag => send('receiveCashDelivery', { resourceETag: etag, occurredAt: new Date().toISOString(), reason: reason.trim(), supportReference: support.trim() || 'recepcion' }, delivery.id)).catch(setError).finally(() => setPending(false)); }}>Recibir para conteo</button> : null}
          {['RECEIVED_FOR_REVIEW','DISCREPANCY','INVESTIGATION','CORRECTED'].includes(delivery.state) && delivery.receiverId === actorId ? (
            <form onSubmit={onSubmit(async () => {
              const canonical = parseLocalCop(amount);
              if (!canonical) throw new ApiError(422, 'INPUT_INVALID', null, 'Falta el importe contado. No se registró el conteo.');
              const etag = await resourceEtag(`${base}/cash-deliveries/${delivery.id}`);
              await send('countCashDelivery', { resourceETag: etag, amount: canonical, occurredAt: new Date().toISOString(), denominations: [], reason: reason.trim(), supportReference: support.trim() || 'conteo' }, delivery.id);
            }, setPending, setError)}>
              <Field label="Importe contado"><input value={amount} inputMode="decimal" onChange={event => {if(invalidate())setAmount(event.target.value);}} /></Field>
              <Submit pending={pending} disabled={uncertain||domainClosed}>Registrar el conteo</Submit>
            </form>
          ) : null}
          {['COUNTED','CORRECTED'].includes(delivery.state) && titular ? <button type="button" disabled={pending||uncertain||domainClosed} onClick={() => { setPending(true); void ask(delivery.kind==='COMPENSATION'?'COMPENSATE_CONFIRM':'CONFIRM').catch(setError).finally(() => setPending(false)); }}>Pedir el plan de confirmación</button> : null}
          {delivery.state === 'DISCREPANCY' ? <p>Hay diferencia. No se confirma ni se libera el dinero. La revisión corresponde al titular.</p> : null}
          <p>Origen {delivery.sourceAccountId}; destino {delivery.destinationAccountId}. Remitente {delivery.senderId}; receptor {delivery.receiverId}. {delivery.kind==='COMPENSATION'?'Retorno compensatorio completo de la entrega original.':''}</p>
          {delivery.state==='DISCREPANCY'&&titular?<button type="button" disabled={pending||uncertain} onClick={()=>run(()=>fact('investigateCashDelivery'))}>Abrir investigación de la diferencia</button>:null}
          {delivery.state==='INVESTIGATION'&&delivery.countId&&delivery.senderId===actorId?<button type="button" disabled={pending||uncertain} onClick={()=>run(()=>ack('acknowledgeCashDeliveryCount'))}>Ratificar el conteo</button>:null}
          {delivery.state==='INVESTIGATION'&&titular?<button type="button" disabled={pending||uncertain||!delivery.senderAckId} onClick={()=>run(()=>ack('correctCashDelivery'))}>Resolver con el conteo ratificado</button>:null}
          {delivery.state==='REQUESTED'&&(titular||delivery.senderId===actorId)?<button type="button" disabled={pending||uncertain} onClick={()=>run(()=>fact('cancelCashDelivery'))}>Cancelar antes de la salida</button>:null}
          {['IN_TRANSIT','RECEIVED_FOR_REVIEW','COUNTED','CORRECTED'].includes(delivery.state)&&(titular||delivery.senderId===actorId)?<button type="button" disabled={pending||uncertain} onClick={()=>run(()=>fact('requestCashDeliveryReturn'))}>Solicitar retorno físico</button>:null}
          {delivery.state.startsWith('RETURN_')?<div><p>Declara únicamente un hecho físico ya ocurrido. Solicitar retorno no acredita haber recibido ni contado el dinero.</p>
            {[['RECEIVER_NON_RECEIPT','Declarar que no recibí el efectivo',delivery.receiverId],['RECEIVER_RETURN_DISPATCHED','Declarar despacho de retorno',delivery.receiverId],['SOURCE_RECALLED','Declarar recuperación antes de recibir',delivery.senderId],['SOURCE_RECEIVED','Declarar recepción del retorno',delivery.senderId],['SOURCE_COUNT','Declarar conteo del retorno',delivery.senderId]].filter(([, ,actor])=>actor===actorId).map(([kind,label])=><button type="button" key={kind} disabled={pending||uncertain} onClick={()=>run(()=>fact('recordCashDeliveryReturnFact',{kind,amount:parseLocalCop(amount)}))}>{label}</button>)}
            <Field label="Importe de la entrega al declarar retorno"><input value={amount} onChange={e=>{if(invalidate())setAmount(e.target.value);}} inputMode="decimal" /></Field>
            {titular?<button type="button" disabled={pending||uncertain} onClick={()=>run(()=>fact('confirmCashDeliveryReturn'))}>Confirmar retorno completo</button>:null}
          </div>:null}
          {delivery.state==='CONFIRMED'&&delivery.kind==='FORWARD'&&!delivery.compensatingDeliveryId&&titular?<button type="button" disabled={pending||uncertain} onClick={()=>run(()=>ask('COMPENSATE_REQUEST'))}>Pedir plan de compensación completa</button>:null}
          <button type="button" disabled={pending||uncertain||domainClosed} onClick={()=>run(()=>selectDelivery(delivery.id))}>Consultar hechos de la entrega</button>
          <ul>{facts.map(f=><li key={f.id}>{({DISPATCH:'Salida declarada',RECEIVE:'Recepción declarada',COUNT:'Conteo',INVESTIGATION:'Investigación',SENDER_ACK:'Ratificación del remitente',CORRECTION:'Resolución',RETURN_REQUEST:'Solicitud de retorno',RETURN_FACT:'Hecho de retorno',CANCEL:'Cancelación'} as Record<string,string>)[f.kind]??'Hecho físico registrado'}: {f.amount===null?'sin importe':money(f.amount)}; actor {f.actorId}; {new Date(f.occurredAt).toLocaleString('es-CO')}.</li>)}</ul>

        </section>
      ) : null}

      {deliveries.length > 0 && !domainClosed ? (
        <div className="schedule">
          <table>
            <thead><tr><th>Referencia</th><th>Importe</th><th>Estado</th><th>Acciones</th></tr></thead>
            <tbody>
              {deliveries.map(item => (
                <tr key={item.id}><td>{item.id.slice(0,8)}</td><td>{money(item.amount)}</td><td>{DELIVERY_STATE[item.state] ?? 'Estado no reconocido'}</td><td><button type="button" disabled={pending||uncertain} onClick={() => run(()=>selectDelivery(item.id))}>Abrir</button></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {ownPosition && !domainClosed ? (
        <form onSubmit={onSubmit(declareClose, setPending, setError)}>
          <h2 className="span">Arqueo</h2>
          <Field label="Posición a arquear"><select value={closePosition||`${ownPosition.responsibleId}|${ownPosition.accountId}`} onChange={e=>{if(invalidate()){setClosePosition(e.target.value);setCounted(emptyBuckets());}}}>{positions.filter(p=>titular||p.responsibleId===actorId).map(p=><option key={`${p.responsibleId}|${p.accountId}`} value={`${p.responsibleId}|${p.accountId}`}>{p.responsibleId===actorId?'Propia':p.responsibleId.slice(0,8)} · {p.accountId.slice(0,8)}</option>)}</select></Field>
          {titular?<label><input type="checkbox" checked={missingCount} onChange={e=>{if(invalidate())setMissingCount(e.target.checked);}} /> Cierre administrativo sin conteo físico</label>:null}
          <p className="span">Lo contado se declara aparte de lo esperado, de lo entregado y de lo conciliado. Declararlo no borra la responsabilidad ni devuelve fondos retenidos.</p>
          {BUCKETS.map(([key, label]) => (
            <Field key={key} label={`${label}. Esperado ${money(ownPosition.physical[key])}`}>
              <input value={counted[key]} inputMode="decimal" onChange={event => invalidate() && setCounted(current => ({ ...current, [key]: event.target.value }))} />
            </Field>
          ))}
          <button type="button" disabled={pending||uncertain} onClick={() => setCounted(ownPosition.physical)}>Copiar lo esperado del servidor</button>
          <Field label="Motivo"><input value={reason} maxLength={160} onChange={event => {if(invalidate())setReason(event.target.value);}} /></Field>
          <Submit pending={pending} disabled={uncertain||domainClosed}>Declarar el arqueo</Submit>
        </form>
      ) : null}

      {!domainClosed?<section aria-label="Arqueos y cierre"><h2>Arqueos y cierre de jornada</h2>
        <Field label="Modo de cierre"><select value={closeMode} onChange={e=>{if(invalidate())setCloseMode(e.target.value);}}><option value="EXACT">Exacto, sin pendientes</option><option value="WITH_PENDING">Con pendientes explícitos</option></select></Field>
        {closes.map(item=><article key={item.id}><p>Arqueo {item.countStatus==='DECLARED'?'declarado': 'sin conteo físico'}. Estado {({OPEN:'Abierto',CLOSED:'Cerrado',CLOSED_WITH_PENDING:'Cerrado con pendientes'} as Record<string,string>)[item.state]??'No reconocido'}. {item.pendingRefs.length} pendientes conservados.</p>
          {item.state==='OPEN'&&(titular||item.subjectId===actorId)?<button type="button" disabled={pending||uncertain} onClick={()=>run(async()=>{await send('finalizeCashClose',{resourceETag:await resourceEtag(`${base}/cash-closes/${item.id}`),mode:closeMode,reason:reason.trim(),supportReference:supportValue()},item.id);})}>Finalizar arqueo {item.id.slice(0,8)}</button>:null}
        </article>)}
        {journeys.filter(j=>j.status==='OPEN'&&(titular||j.ownerId===actorId)).map(j=><button type="button" key={j.id} disabled={pending||uncertain} onClick={()=>run(async()=>{const close=closes.filter(c=>c.journeyId===j.id&&c.state!=='OPEN').at(-1);await send('closeCollectionJourney',{resourceETag:await resourceEtag(`${base}/collection-journeys/${j.id}`),cashCloseId:close?.id??null,cashCloseETag:close?await resourceEtag(`${base}/cash-closes/${close.id}`):null,mode:closeMode,reason:reason.trim(),supportReference:supportValue()},j.id);})}>Cerrar jornada {j.ownerId===actorId?'propia':j.ownerId.slice(0,8)}</button>)}
      </section>:null}
      {openJourney&&!domainClosed?<form onSubmit={onSubmit(async()=>{const action=actions.find(a=>a.id===actionId);if(!action)return;await send('correctCollectionAction',{resourceETag:await resourceEtag(`${base}/collection-actions/${action.id}`),occurredAt:new Date().toISOString(),note:note.trim(),promisedAmount:action.kind==='PROMISE'?parseLocalCop(promiseAmount):null,promisedDate:action.kind==='PROMISE'?promiseDate:null,reason:reason.trim(),supportReference:supportValue()},action.id);},setPending,setError)}><h2>Corregir una gestión conservando su historia</h2>
        <Field label="Gestión a corregir"><select value={actionId} onChange={e=>{if(invalidate())setActionId(e.target.value);}}><option value="">Elige el hecho</option>{actions.filter(a=>a.ownerId===actorId&&a.journeyId===openJourney.id&&!actions.some(b=>b.supersedesActionId===a.id)).map(a=><option key={a.id} value={a.id}>{ACTION_KIND[a.kind]} · {a.note}</option>)}</select></Field>
        <p>Usa la nota, el motivo y, para promesas, el importe y la fecha del formulario de gestión. El hecho previo se conserva.</p><Submit pending={pending} disabled={uncertain||!actionId}>Registrar corrección de gestión</Submit>
      </form>:null}
      {titular&&!domainClosed?<form onSubmit={onSubmit(async()=>{const member=members.find(m=>m.userId===stationReceiver);if(!member||!stationAccountTag)return;const id=stationConfig||newStation.current,old=stations.find(st=>st.stationId===id);await send('setCashStation',{stationId:id,resourceETag:old?.stationETag??`"${id}:0"`,accountId:stationAccount,accountETag:stationAccountTag,receiverId:member.userId,receiverETag:member.version,active:true,supportReference:supportValue()},null);},setPending,setError)}><h2>Configurar receptor y caja central</h2>
        <p>Solo el titular configura. Receptor y remitente declaran hechos distintos. El titular confirma el traslado. Las asignaciones del cobrador se configuran en <a href="#/pagos">Pagos</a>.</p>
        <Field label="Configuración de caja"><select value={stationConfig} onChange={e=>{if(invalidate())setStationConfig(e.target.value);}}><option value="">Nueva caja</option>{stations.map(st=><option key={st.stationId} value={st.stationId}>{st.accountLabel} · {st.receiverName}</option>)}</select></Field>
        <AccountPicker base={`${base}/financial`} label="Cuenta de caja central" accountClass="ASSET" kinds={['CASH']} status="ACTIVE" value={stationAccount} onChange={id=>{if(!invalidate())return;setStationAccount(id);setStationAccountTag('');void resourceEtag(`${base}/financial/accounts/${id}`).then(setStationAccountTag).catch(setError);}} />
        <Field label="Receptor configurado"><select value={stationReceiver} onChange={e=>{if(invalidate())setStationReceiver(e.target.value);}}><option value="">Elige T u O</option>{members.filter(m=>m.roleIds.some(r=>['T','O'].includes(r))).map(m=><option key={m.userId} value={m.userId}>{m.displayName}</option>)}</select></Field>
        <Submit pending={pending} disabled={uncertain||!stationAccountTag||!stationReceiver}>Guardar caja y receptor</Submit>
      </form>:null}

      {uncertain ? (
        <div>
          <Alert tone="pending">La respuesta no confirmó el resultado. La misma clave se conserva. No se prepara otra.</Alert>
          <button type="button" disabled={pending} onClick={() => { setPending(true); void call('GET', `${base}/collection-commands/${keyRef.current}`).then(async()=>{frozen.current=null;keyRef.current=crypto.randomUUID();save();setUncertain(false);setPreview(null);setConsent(false);setNotice('El servidor confirmó el comando consultado. No se volvió a enviar.');await load();}).catch(setError).finally(() => setPending(false)); }}>Consultar el comando</button>
          <button type="button" disabled={pending||domainClosed} onClick={() => { if (!frozen.current) return; setPending(true); void send('requestCashDelivery', {}, null).catch(setError).finally(() => setPending(false)); }}>Reintentar el mismo comando</button>
        </div>
      ) : null}
    </section>
  );
}

function actionPath(base: string, operation: string, id: string | null): string {
  if (operation === 'openCollectionJourney') return `${base}/collection-journeys`;
  if (operation === 'closeCollectionJourney') return `${base}/collection-journeys/${id}/close`;
  if (operation === 'recordCollectionAction') return `${base}/collection-journeys/${id}/actions`;
  if (operation === 'requestCashDelivery') return `${base}/cash-deliveries`;
  if (operation === 'dispatchCashDelivery') return `${base}/cash-deliveries/${id}/dispatch`;
  if (operation === 'receiveCashDelivery') return `${base}/cash-deliveries/${id}/receive`;
  if (operation === 'countCashDelivery') return `${base}/cash-deliveries/${id}/counts`;
  if (operation === 'confirmCashDelivery') return `${base}/cash-deliveries/${id}/confirm`;
  if (operation === 'createCashClose') return `${base}/cash-closes`;
  if(operation==='setCashStation')return `${base}/cash-stations`;
  if(operation==='correctCollectionAction')return `${base}/collection-actions/${id}/corrections`;
  if(operation==='finalizeCashClose')return `${base}/cash-closes/${id}/finalize`;
  const suffix:Record<string,string>={investigateCashDelivery:'investigation',acknowledgeCashDeliveryCount:'sender-acknowledgments',correctCashDelivery:'correction',cancelCashDelivery:'cancel',requestCashDeliveryReturn:'return-requests',recordCashDeliveryReturnFact:'return-facts',confirmCashDeliveryReturn:'return-confirmation',requestCashDeliveryCompensation:'compensations',confirmCashDeliveryCompensation:'compensation-confirmation'};
  if(suffix[operation])return `${base}/cash-deliveries/${id}/${suffix[operation]}`;
  throw new ApiError(422, 'INPUT_INVALID', null, 'La acción no tiene una ruta conocida. No se envió.');
}
