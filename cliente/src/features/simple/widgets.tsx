import { useEffect, useState, type ReactNode } from 'react';
import { call } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import {useSimple} from './context';
import {borrowerLabel} from '../../shared/labels';
import { grantActive } from '../../shared/session-activity';
import { ErrorText, Field } from '../../shared/ui';
import { formatPreviewCop, metricText } from './model';
import type { Metric, PreviewDocument } from './types';

export function Money({ metric }: { metric: Metric }) {
  const text = metricText(metric);
  const tone = metric.status === 'COMPLETE' ? 'ok' : metric.status === 'NOT_APPLICABLE' ? 'info' : 'pending';
  return <span className={`simple-state simple-${tone}`}>{text}</span>;
}
export function localDateTime(value:string){const d=new Date(value);return Number.isFinite(d.valueOf())?new Intl.DateTimeFormat('es-CO',{timeZone:'America/Bogota',dateStyle:'medium',timeStyle:'short'}).format(d):'Fecha no disponible';}

export function GrantNote() {
  const { clock } = useAuth();
  const until = clock?.meta.balanceVerifiedUntil;
  if (!until) return <p>No hay una autorización de dinero vigente. Un movimiento de saldo pedirá confirmación. El código no se guarda y el plazo no se alarga.</p>;
  const active = grantActive(clock);
  return <p>{active ? 'Autorización de dinero válida hasta ' : 'La autorización de dinero venció '}{localDateTime(until)}. Un movimiento de saldo la usa si sigue vigente. El código no se guarda.</p>;
}

export function PreviewBox({ preview }: { preview: PreviewDocument }) {
  const expired = Date.parse(preview.expiresAt) <= Date.now();
  return (
    <div className="simple-preview" role="status">
      <p>{preview.status === 'READY' ? 'Vista previa lista.' : 'Vista previa bloqueada.'} {expired ? 'Venció. Hay que pedirla de nuevo, con confirmación y la misma clave.' : `Válida hasta ${localDateTime(preview.expiresAt)}.`}</p>
      <p>Interés {formatPreviewCop(preview.interest)}. Capital {formatPreviewCop(preview.principal)}. Crédito {formatPreviewCop(preview.credit)}.</p>
      <p>Cambio de caja {formatPreviewCop(preview.cashDelta)}. Cambio apartado {formatPreviewCop(preview.reservedDelta)}.</p>
      <p>El saldo nuevo no viene en esta vista. Aparece al confirmar, en la posición que devuelva el servidor. No se calcula aquí.</p>
      {preview.reasons.length ? <p>Motivos: {preview.reasons.join(', ')}.</p> : null}
      <p>{preview.postings.length} líneas informadas. No aumentan el dinero que tienes.</p>
    </div>
  );
}

export function More({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <fieldset className="simple-more">
      <legend>
        <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? `Cerrar ${label}` : label}</button>
      </legend>
      {open ? children : <p>Opciones cerradas. Un dato exigido para guardar dinero sigue pendiente hasta abrirlo.</p>}
    </fieldset>
  );
}

const CASH_KINDS = ['CASH', 'BANK'] as const;

export function CashSelect({ base, value, onChange, label = 'Cuenta', kinds = CASH_KINDS }: { base: string; value: string; onChange: (id: string) => void; label?: string; kinds?: readonly string[] }) {
  const [items, setItems] = useState<Array<{ id: string; code: string; name: string; kind: string; status: string }>>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const ac = new AbortController();
    void call<{ items: Array<{ id: string; code: string; name: string; kind: string; status: string }>; nextCursor: string | null }>('GET', `${base}/accounts?limit=20`, undefined, { signal: ac.signal }).then(result => {
      setItems((result.data.items ?? []).filter(item => item.status === 'ACTIVE' && kinds.includes(item.kind)));
      setMore(Boolean(result.data.nextCursor));
    }).catch(setError);
    return () => ac.abort();
  }, [base, kinds]);
  return (
    <Field label={label} hint={more ? 'Total de esta página de cuentas. Si no está aquí, búscalo en Finanzas. No se elige una cuenta oculta.' : 'Caja o banco de este libro.'}>
      <select value={value} onChange={event => onChange(event.target.value)} required>
        <option value="">Selecciona</option>
        {items.map(item => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}
      </select>
      <ErrorText error={error} />
    </Field>
  );
}

export function useBorrowerLabels(ids:string[]){
 const s=useSimple(),signature=[...new Set(ids)].sort().join('|'),[labels,setLabels]=useState<Record<string,string>>({});
 useEffect(()=>{const ac=new AbortController();let live=true;setLabels({});if(s.scope!=='BUSINESS'||!s.organizationId)return()=>{live=false;ac.abort();};void Promise.all(signature.split('|').filter(Boolean).map(async id=>{try{const r=await call<{borrowerCode:string;profile:{displayName:string}}>('GET',`/organizations/${s.organizationId}/borrowers/${id}`,undefined,{signal:ac.signal});return[id,borrowerLabel(r.data.borrowerCode,r.data.profile.displayName)] as const;}catch{return[id,'Nombre no disponible'] as const;}})).then(rows=>{if(live)setLabels(Object.fromEntries(rows));});return()=>{live=false;ac.abort();};},[s.organizationId,s.scope,signature]);return labels;
}

export function FundSelect({base,value,onChange}:{base:string;value:string;onChange:(id:string)=>void}){
 const s=useSimple(),[funds,setFunds]=useState<{id:string;label:string;status:string}[]>([]),[error,setError]=useState<unknown>(null);useEffect(()=>{const ac=new AbortController();let live=true;setFunds([]);void call<{items:{id:string;label:string;status:string}[]}>('GET',`${base}/funds?asOf=${s.effectiveDate}&limit=100`,undefined,{signal:ac.signal}).then(r=>{if(live)setFunds(r.data.items.filter(f=>f.status==='ACTIVE'));}).catch(e=>{if(live)setError(e);});return()=>{live=false;ac.abort();};},[base,s.effectiveDate]);return <Field label="Apartado" hint="El apartado exclusivo de esta cuota; el servidor comprueba el vínculo y la reserva."><select value={value} onChange={e=>onChange(e.target.value)} required><option value="">Selecciona</option>{funds.map(f=><option key={f.id} value={f.id}>{f.label}</option>)}</select><ErrorText error={error}/></Field>;
}
