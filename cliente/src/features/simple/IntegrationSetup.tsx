import {useState} from 'react';
import {ApiError} from '../../shared/contracts';
import {ensureStepUp} from '../../shared/step-up';
import {ErrorText,Field,onSubmit} from '../../shared/ui';
import {useSimple} from './context';
import {createSlot,keyFor} from './memory';
import {bookUrl,cutQuery,msGet,postKnown} from './transport';
import {CashSelect,More,PreviewBox,useBorrowerLabels} from './widgets';
import type {MonthlyPosition,PreviewDocument} from './types';
const general=['GENERAL'] as const;
const mappingSlot=createSlot(),actionSlot=createSlot();
export function IntegrationSetup(){
 const s=useSimple(),[cash,setCash]=useState(''),[principal,setPrincipal]=useState(''),[interest,setInterest]=useState(''),[income,setIncome]=useState(''),[credit,setCredit]=useState(''),[expense,setExpense]=useState(''),[support,setSupport]=useState(''),[pending,setPending]=useState(false),[error,setError]=useState<unknown>(null),[done,setDone]=useState(false);
 const [labelId]=useState(()=>crypto.randomUUID());
 const base=`/organizations/${s.organizationId}/financial`;
 return <More label="Preparar cuentas existentes"><form className="simple-form" onSubmit={onSubmit(async()=>{
  if(!s.bookId||!s.bookEtag||![cash,principal,interest,income,credit,expense,support].every(Boolean))throw new ApiError(422,'INPUT_INVALID',null,'Elige las seis cuentas y el soporte. No se crean cuentas ni se seleccionan por ti.');
  const body={effectiveFrom:s.effectiveDate,cashAccountIds:[cash],loanProfile:{principalAccountId:principal,interestReceivableAccountId:interest,interestIncomeAccountId:income,borrowerCreditAccountId:credit},categories:[{labelId,label:'Otros gastos',category:'OTHER',expenseAccountId:expense}],supportReference:support};
  const key=keyFor(mappingSlot,JSON.stringify(body));await postKnown(mappingSlot,key,bookUrl(s.bookId,'mappings/versions'),body,s.bookEtag,undefined,'finish');setDone(true);s.refreshCut();
 },setPending,setError)}><h2>Cuentas para préstamos mensuales</h2><p>Elige cuentas existentes del negocio. La fecha es la del corte. Una receta nueva tiene otra versión y no cambia operaciones anteriores.</p><ErrorText error={error}/>
 <CashSelect base={base} label="Cuenta de entrega" value={cash} onChange={setCash}/>
 <CashSelect base={base} label="Capital que me deben" kinds={general} value={principal} onChange={setPrincipal}/>
 <CashSelect base={base} label="Interés por cobrar" kinds={general} value={interest} onChange={setInterest}/>
 <CashSelect base={base} label="Ingreso por intereses" kinds={general} value={income} onChange={setIncome}/>
 <CashSelect base={base} label="Crédito a favor del cliente" kinds={general} value={credit} onChange={setCredit}/>
 <CashSelect base={base} label="Cuenta para otros gastos" kinds={general} value={expense} onChange={setExpense}/>
 <More label="Soporte de las cuentas"><Field label="Soporte del mapeo"><input value={support} onChange={e=>setSupport(e.target.value)} required/></Field></More>
 <button disabled={pending||!s.bookEtag||s.loading}>Guardar versión de cuentas</button>{done?<p role="status">Cuentas guardadas en una versión nueva.</p>:null}</form></More>;
}
export function LoanControls({rows}:{rows:MonthlyPosition[]}){
 const names=useBorrowerLabels(rows.map(r=>r.borrowerId));
 const s=useSimple(),[loanId,setLoan]=useState(''),[action,setAction]=useState(''),[support,setSupport]=useState(''),[preview,setPreview]=useState<PreviewDocument|null>(null),[pending,setPending]=useState(false),[error,setError]=useState<unknown>(null),[done,setDone]=useState('');
 return <More label="Interés y permiso automático"><form className="simple-form" onSubmit={onSubmit(async()=>{
  if(!s.bookId||!s.bookEtag||!loanId||!action||!support)throw new ApiError(422,'INPUT_INVALID',null,'Elige préstamo, acción y soporte.');
  const loan=await msGet<unknown>(bookUrl(s.bookId,`monthly-loans/${loanId}`,cutQuery({month:s.month,effectiveDate:s.effectiveDate,knownAt:s.knownAt})));if(!loan.etag)throw new ApiError(428,'ETAG_REQUIRED',null,'Actualiza la versión del préstamo.');
  if(action==='REVOKE'){
   const body={expectedLoanETag:loan.etag,supportReference:support},key=keyFor(actionSlot,JSON.stringify({loanId,body,action}));await ensureStepUp({purpose:'MS_MONTHLY_MANDATE_REVOKE',resourceId:loanId,command:{bookId:s.bookId,operationId:'msRevokeMonthlyMandate',payload:body,pathParameters:{bookId:s.bookId,loanId},idempotencyKey:key,expectedETag:loan.etag},summary:'Retirar el permiso detiene los próximos devengos automáticos. Lo ya registrado se conserva.'});await postKnown(actionSlot,key,bookUrl(s.bookId,`monthly-loans/${loanId}/mandate-revocations`),body,loan.etag,undefined,'finish');setDone('Permiso automático retirado.');
  }else{
   const body={expectedBookETag:s.bookEtag,throughDate:s.effectiveDate,expectedLoanETag:loan.etag},key=keyFor(actionSlot,JSON.stringify({loanId,body,action}));if(!preview){setPreview((await postKnown<PreviewDocument>(actionSlot,key,bookUrl(s.bookId,`monthly-loans/${loanId}/accrual-previews`),{...body,executionKey:key},loan.etag,undefined,'keep')).data);return;}
   if(preview.status!=='READY'||Date.parse(preview.expiresAt)<=Date.now())throw new ApiError(412,'PRECONDITION_FAILED',null,'Actualiza la vista previa del interés.');await ensureStepUp({purpose:'MS_MONTHLY_ACCRUE',resourceId:loanId,command:{bookId:s.bookId,operationId:'msCommitAccrual',payload:{executionKey:key,previewToken:preview.previewToken,requestHash:preview.requestHash},pathParameters:{bookId:s.bookId,loanId},idempotencyKey:key,expectedETag:loan.etag},summary:'Registrar solo el interés vencido mostrado, sin capitalizarlo.'});await postKnown(actionSlot,key,bookUrl(s.bookId,`monthly-loans/${loanId}/accruals`),{executionKey:key,previewToken:preview.previewToken,requestHash:preview.requestHash},loan.etag,undefined,'finish');setDone('Interés registrado.');setPreview(null);
  }s.refreshCut();
 },setPending,setError)}><h2>Interés y permiso automático</h2><ErrorText error={error}/><Field label="Préstamo para el interés"><select value={loanId} onChange={e=>{setLoan(e.target.value);setPreview(null);}} required><option value="">Selecciona</option>{rows.map(r=><option key={r.id} value={r.id}>{names[r.borrowerId]??'Consultando cliente…'}</option>)}</select></Field><Field label="Acción de interés"><select value={action} onChange={e=>{setAction(e.target.value);setPreview(null);}} required><option value="">Selecciona</option><option value="ACCRUE">Revisar interés vencido</option><option value="REVOKE">Retirar permiso automático</option></select></Field><Field label="Soporte de la acción"><input value={support} onChange={e=>setSupport(e.target.value)} required/></Field>{preview?<PreviewBox preview={preview}/>:null}<button disabled={pending||!s.bookEtag||s.loading}>{preview?'Confirmar interés':'Revisar acción'}</button>{done?<p role="status">{done}</p>:null}</form></More>;
}
