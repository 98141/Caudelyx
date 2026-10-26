import {randomUUID} from 'node:crypto';
import {fundedSetup} from '../operations/fixture.js';
import {s06Profile} from './profile.js';
import type {PaymentIntent} from '../../src/modules/payments/models.js';
import {today} from '../../src/modules/finance/service.js';
export const code=(value:string)=>(e:unknown)=>e instanceof Error&&'code'in e&&e.code===value;
export async function setup(group:Awaited<ReturnType<typeof s06Profile>>,options:{legacy?:boolean}={}){
 const f=await fundedSetup({...group,fixture:()=>group.fixture(options)}),pay=f.identity.payments;
 const account=async(label:string,accountClass='ASSET',kind='GENERAL')=>{
  const payload={code:label,name:'Cuenta sintética '+label,currency:'COP',accountClass,kind},r=await f.runtime.finance.mutate(f.a.issued.context,'createAccount',f.org,payload,randomUUID());return r.data as {id:string;version:number};
 };
 type Actor=typeof f.a;
 const state=async()=>{const r=await pay!.read(f.a.issued.context,'getPaymentsState',f.org);return r.data as {paymentsBookETag:string;operationsBookETag:string};};
 const mutate=async(operation:string,payload:Record<string,unknown>,id?:string,actor=f.a,key=randomUUID())=>{
  const versions=await state(),purpose=pay? (await import('../../src/modules/payments/contract.js')).paymentContract().purpose(operation,payload):'';
  const command={organizationId:f.org,idempotencyKey:key,expectedETag:versions.paymentsBookETag,operationId:operation,resourceId:id??null,payload};await f.proof(actor,purpose,command,id);
  return await pay!.mutate(actor.issued.context,operation,f.org,payload,key,versions.paymentsBookETag,id);
 };
 const prepare=async(command:Record<string,unknown>,actor=f.a,key=randomUUID())=>{
  const versions=await state(),preview=await pay!.preview(actor.issued.context,f.org,{executionKey:key,expectedPaymentsETag:versions.paymentsBookETag,command}),p=preview.data as {token:string;plan:unknown};
  const operation=command['kind']==='REGISTER'?'registerPayment':command['kind']==='APPROVE'?'approvePayment':'executePaymentReversal',id=command['kind']==='REGISTER'?undefined:String(command[command['kind']==='APPROVE'?'paymentId':'originalEventId']),payload={command,previewToken:p.token};
  const purpose=(await import('../../src/modules/payments/contract.js')).paymentContract().purpose(operation,payload),proofCommand={organizationId:f.org,idempotencyKey:key,expectedETag:versions.paymentsBookETag,operationId:operation,resourceId:id??null,payload};
  const execute=async()=>{await f.proof(actor,purpose,proofCommand,id);return await pay!.mutate(actor.issued.context,operation,f.org,payload,key,versions.paymentsBookETag,id);};
  return{execute,operation,purpose,payload,key,etag:versions.paymentsBookETag,id,preview:p,proofCommand};
 };
 const member=async(role:string)=>{
  const actor=await f.newActor(),payload={email:actor.email,roleIds:[role]};await f.proof(f.a,'MEMBER_INVITE',payload,f.org);await f.runtime.organizations.invite(f.a.issued.context,payload);await f.identity.dispatchMail();
  const mail=[...f.messages.notificationInbox.values()].find(m=>m.kind==='INVITATION'&&m.payload['email']===actor.email);
  if(!mail)throw Error('Missing own invitation');await f.runtime.organizations.accept(actor.issued.context,{mode:'CONFIRM',token:mail.payload['token']},randomUUID());return actor;
 };
 const intent=async(loan:Awaited<ReturnType<typeof f.loan>>,destination:string,amount='300000.00',actor=f.a,method:'CASH'|'BANK'='BANK'):Promise<PaymentIntent>=>{
  const position=await f.position(loan.id),a=await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,destination),binding=method==='CASH'?await pay!.read(f.a.issued.context,'getCustodyBinding',f.org,actor.issued.context.subjectId!):null;
  return{method,borrowerId:loan.borrowerId,amount,currency:'COP',destinationAccountId:destination,destinationAccountETag:a.etag!,custodianId:method==='CASH'?actor.issued.context.subjectId!:null,bindingETag:binding?.etag??null,observedDate:today(f.now()),observedAt:new Date(f.now()).toISOString(),receiptReference:'SYN-'+randomUUID(),supportReference:'SYN-S06',targets:[{loanId:loan.id,positionETag:position.etag!,amount,mode:'REGULAR'}],excessDisposition:'CREDIT'};
 };
 const bind=async(actor:Actor,cash:string,held:string)=>{
  const cashRead=await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,cash),h=await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,held);
  return await mutate('setCustodyBinding',{custodianId:actor.issued.context.subjectId!,accountId:cash,accountETag:cashRead.etag!,heldLiabilityAccountId:held,heldLiabilityAccountETag:h.etag!,resourceETag:`"${actor.issued.context.subjectId}:binding:0"`,supportReference:'SYN-BIND'});
 };
 const profile=async()=>{const h=await account('HELD','LIABILITY'),r=await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,h.id);await mutate('setHeldFundsProfile',{configurationKind:'HELD_FUNDS_PROFILE',heldLiabilityAccountId:h.id,heldLiabilityAccountETag:r.etag!,resourceETag:`"${f.org}:held-profile:0"`,supportReference:'SYN-HELD'});return h.id;};
 const readPayment=async(id:string)=>await pay!.read(f.a.issued.context,'getPayment',f.org,id);
 const reverse=async(eventId:string,paymentId:string|null)=>{
  const r=await mutate('requestPaymentReversal',{resourceETag:`"${eventId}:1"`,reason:'Corrección sintética',supportReference:'SYN-REVERSE'},eventId),request=await pay!.read(f.a.issued.context,'getLoanEventReversalRequest',f.org,(r.data as {entityId:string}).entityId),v=await state();return await prepare({kind:'EXECUTE_REVERSAL',paymentId,originalEventId:eventId,resourceETag:request.etag!,reversalRequestId:eventId,effectiveDate:today(f.now()),expectedOperationsETag:v.operationsBookETag,supportReference:'SYN-REVERSE'});
 };
 return{...f,pay,state,mutatePayment:mutate,preparePayment:prepare,member,intent,accountS06:account,bind,heldProfile:profile,readPayment,reverse};
}
