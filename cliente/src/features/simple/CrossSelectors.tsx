import {useEffect,useState} from 'react';
import {call} from '../../shared/api';
import {DiscardedRequest} from '../../shared/contracts';
import {Field} from '../../shared/ui';
import {useSimple} from './context';
import {bookUrl,cutQuery,msGet,concealed} from './transport';
export interface CrossAccount{id:string;code:string;name:string;accountClass:string;kind:string}
export interface CrossRoot{id:string;effectiveDate:string;remaining:string;sourceEventIds:string[];personalContraAccountId:string;businessContraAccountId:string}
export interface CrossOptions{personalBookId:string;organizationId:string;metadataTime:'CURRENT_AUTHORITY';personalAccounts:CrossAccount[];businessAccounts:CrossAccount[];eligibilities:{id:string;validFrom:string;percentage:string}[];contributions:CrossRoot[]}
export function useCrossOptions(){
 const s=useSimple(),[options,setOptions]=useState<CrossOptions|null>(null),[error,setError]=useState<unknown>(null),[loading,setLoading]=useState(false);
 useEffect(()=>{const ac=new AbortController();let live=true;setOptions(null);setError(null);setLoading(true);void (async()=>{const p=await call<{id:string}>('GET','/me/personal/book',undefined,{signal:ac.signal});const r=await msGet<CrossOptions>(bookUrl(p.data.id,'interbook-options',cutQuery({month:s.month,effectiveDate:s.effectiveDate,knownAt:s.knownAt})),ac.signal);if(live)setOptions(r.data);})().catch(e=>{if(live&&!(e instanceof DiscardedRequest))setError(concealed(e));}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;ac.abort();};},[s.organizationId,s.owner,s.scope,s.month,s.effectiveDate,s.knownAt]);
 return{options,error,loading};
}
export function CrossAccountSelect({label,items,value,onChange}:{label:string;items:CrossAccount[];value:string;onChange:(id:string)=>void}){
 return <Field label={label}><select value={value} onChange={e=>onChange(e.target.value)} required><option value="">Selecciona</option>{items.map(a=><option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></Field>;
}
