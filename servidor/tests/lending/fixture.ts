import {randomUUID} from 'node:crypto';
import {generate} from 'otplib';
import type {lendingProfile} from '../helpers/lending-profile.js';
import {purposes} from '../../src/modules/lending/contract.js';
import type {Terms,Profile,Result} from '../../src/modules/lending/models.js';
export type Group=Awaited<ReturnType<typeof lendingProfile>>;
export type Fixture=Awaited<ReturnType<Group['fixture']>>;
export type Actor=Awaited<ReturnType<Fixture['actor']>>;
export interface View {id:string;version:number;profileVersion:number;termsVersion:number;status:string;fingerprint:string;quoteId:string;quoteFingerprint:string;terms:Terms;profile:Profile;confirmation:unknown;possibleDuplicate:boolean;duplicateCandidates:unknown[];expiresAt:string}
export const view=(r:Result)=>r.data as View;
export async function setup(group:Group){
  const f=await group.fixture(),a=await f.actor();
  const tenant=async(actor:Actor)=>{
    const payload={name:'Organización sintética S04',currency:'COP',timezone:'America/Bogota'};await f.proof(actor,'ORGANIZATION_CREATE',payload);
    const org=(await f.runtime.organizations.create(actor.issued.context,payload,randomUUID())).data.organization.id;
    const accountPayload={code:'CASH_S04',name:'Caja sintética S04',currency:'COP',accountClass:'ASSET',kind:'CASH'},key=randomUUID();
    await f.proof(actor,'FINANCE_ACCOUNT_CREATE',{organizationId:org,idempotencyKey:key,payload:accountPayload});
    const account=(await f.runtime.finance.mutate(actor.issued.context,'createAccount',org,accountPayload,key)).data as {id:string};
    return{actor,org,account:account.id};
  };
  const own=await tenant(a);
  const mutate=async(operation:string,payload:Record<string,unknown>,options:{id?:string;etag?:string;key?:string;actor?:Actor;org?:string;noProof?:boolean}={})=>{
    const actor=options.actor??a,org=options.org??own.org,key=options.key??randomUUID(),command={organizationId:org,idempotencyKey:key,payload,...(options.etag?{expectedETag:options.etag}:{})};
    const purpose=purposes.get(operation);if(purpose&&!options.noProof)await f.proof(actor,purpose,command,options.id);
    return await f.runtime.lending.mutate(actor.issued.context,operation,org,payload,key,options.id,options.etag);
  };
  const borrower=async(code='SYN_'+randomUUID().slice(0,8).toUpperCase(),profile:Profile={displayName:'Persona sintética',schemaVersion:1,extras:{}})=>await mutate('createBorrower',{borrowerCode:code,profile});
  const terms=(borrowerId:string,delta:Partial<Terms>={}):Terms=>({borrowerId,plannedFundingAccountId:own.account,principal:'1000.00',effectiveDate:'2024-01-31',firstDueDate:'2024-02-29',installmentCount:3,method:'LEVEL_PAYMENT',frequency:'MONTH',rate:{type:'EFFECTIVE',unit:'MONTH',value:'0.010000000000'},calendarConvention:'PERIODIC_FIXED',holidayAdjustment:'NO_SHIFT',policyVersion:'S04-LOCAL-CO-0.1',jurisdiction:'CO',usage:'LOCAL_SYNTHETIC',...delta});
  const quote=async(borrowerId:string,delta:Partial<Terms>={})=>await mutate('createLoanQuote',{terms:terms(borrowerId,delta)});
  const login=async(actor:Actor)=>{
    const first=await f.identity.login('TENANT',randomUUID(),actor.email,'Frase de prueba sintetica larga 9871236450');f.clock.value+=30000;
    return{...actor,issued:(await f.runtime.totp.authenticate(first.issued.context,await generate({secret:actor.secret,epoch:Math.floor(f.now()/1000)}),'LOGIN',null)).issued};
  };
  return{...f,a,...own,newActor:f.actor,tenant,mutate,borrower,terms,quote,login,read:async(operation:string,id?:string,query:Record<string,unknown>={},version?:string)=>await f.runtime.lending.read(a.issued.context,operation,own.org,id,query,version)};
}
