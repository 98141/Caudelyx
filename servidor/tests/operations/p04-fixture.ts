/* eslint-disable security/detect-object-injection -- Fixed synthetic account profile fields. */
import {randomUUID} from 'node:crypto';
import {generate} from 'otplib';
import {operationsProfile as profile,assertOwnUri,password} from './p04-profile.js';
import {purposes} from '../../src/modules/lending/contract.js';
import type {Terms,Profile,Result} from '../../src/modules/lending/models.js';
export type Group=Awaited<ReturnType<typeof profile>>;
export type Fixture=Awaited<ReturnType<Group['fixture']>>;
export type Actor=Awaited<ReturnType<Fixture['actor']>>;
export interface View {id:string;version:number;profileVersion:number;termsVersion:number;status:string;fingerprint:string;quoteId:string;quoteFingerprint:string;terms:Terms;profile:Profile;confirmation:unknown;possibleDuplicate:boolean;duplicateCandidates:unknown[];expiresAt:string}
export const view=(r:Result)=>r.data as View;
async function lendingSetup(group:Group){
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

import {operationPurposes,operationKinds} from '../../src/modules/lending/operations-contract.js';
import type {Intent,Profile as OperationProfile,Plan} from '../../src/modules/lending/operations-models.js';
import {today} from '../../src/modules/finance/service.js';
import {purposes as openingPurposes} from '../../src/modules/opening/contract.js';
import type {OpeningFile,Snapshot} from '../../src/modules/opening/models.js';
export {profile,assertOwnUri,password};

export async function setup(group:Awaited<ReturnType<typeof profile>>,date?:string){
  let created:Awaited<ReturnType<typeof group.fixture>>|undefined;
  const f=await lendingSetup({...group,fixture:async(options={})=>{created=await group.fixture(options);if(date)created.clock.value=Date.parse(date);return created;}});
  return{...f,proxy:created!.proxy};
}
export async function fundedSetup(group:Awaited<ReturnType<typeof profile>>,date='2026-10-31T12:00:00-05:00',withOpening=false){
  const f=await setup(group,date),org=f.org,ops=f.runtime.operations;
  const account=async(code:string,accountClass:string)=>{
    const payload={code,name:'Cuenta sintética '+code,currency:'COP',accountClass,kind:'GENERAL'},key=randomUUID();await f.proof(f.a,'FINANCE_ACCOUNT_CREATE',{organizationId:org,idempotencyKey:key,payload});return (await f.runtime.finance.mutate(f.a.issued.context,'createAccount',org,payload,key)).data as {id:string};
  };
  const p=await account('P','ASSET'),i=await account('I','ASSET'),y=await account('Y','INCOME'),c=await account('C','LIABILITY'),e=await account('E','EQUITY');
  const support={currency:'COP',effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN-SEED',description:'Capital sintético de prueba',lines:[{accountId:f.account,debit:'20000000.00',credit:'0.00'},{accountId:e.id,debit:'0.00',credit:'20000000.00'}]},key=randomUUID();
  let opening:OpeningFile|undefined,borrowerReference:string|undefined,historicalLoanReference:string|undefined;
  if(withOpening){
    const supportId=randomUUID();borrowerReference=randomUUID();historicalLoanReference=randomUUID();
    const snapshot:Snapshot={cutoffDate:'2026-09-30',supports:[{id:supportId,reference:'SYN-OPENING',asOfDate:'2026-09-30',declaration:'OWNER_CHECKED'}],references:[{id:borrowerReference,type:'BORROWER',externalReference:'SYN-HIST-B',displayName:'Persona histórica sintética',supportIds:[supportId]},{id:historicalLoanReference,type:'HISTORICAL_LOAN',externalReference:'SYN-HIST-L',borrowerId:borrowerReference,originationDate:'2026-09-01',supportIds:[supportId]}],components:[{id:randomUUID(),category:'CASH',accountId:f.account,amount:'20000000.00',supportIds:[supportId]},{id:randomUUID(),category:'PRINCIPAL_RECEIVABLE',accountId:p.id,amount:'100.00',referenceId:historicalLoanReference,supportIds:[supportId]},{id:randomUUID(),category:'EQUITY',accountId:e.id,amount:'20000100.00',equityKind:'CONTRIBUTED',supportIds:[supportId]}],historicalInterest:[],informationalHistory:[]};
    const run=async(operation:string,payload:Record<string,unknown>)=>{const id=opening?.id,expected=id?`"${id}:${opening!.version}"`:undefined,key=randomUUID();await f.proof(f.a,openingPurposes.get(operation)!,{organizationId:org,idempotencyKey:key,payload,...(expected?{expectedETag:expected}:{})},id);const r=await f.runtime.opening.mutate(f.a.issued.context,operation,org,payload,key,id,expected);opening=(operation==='validateOpening'?(r.data as {opening:OpeningFile}).opening:r.data) as OpeningFile;};
    await run('createOpening',{snapshot});await run('validateOpening',{policyVersion:'S03-OPENING-0.1'});const binding={validationId:opening!.validation!.id,validationFingerprint:opening!.validation!.fingerprint};await run('approveOpening',binding);await run('commitOpening',binding);
  }else{await f.proof(f.a,'FINANCE_JOURNAL_POST',{organizationId:org,idempotencyKey:key,payload:support});await f.runtime.finance.mutate(f.a.issued.context,'postJournal',org,support,key);}
  const profile:OperationProfile={principalAccountId:p.id,interestReceivableAccountId:i.id,interestIncomeAccountId:y.id,borrowerCreditAccountId:c.id};
  const make=async(request:Intent,key=randomUUID())=>{
    const book=await ops.read(f.a.issued.context,'getLoanOperationsBook',org),preview=await ops.preview(f.a.issued.context,org,{executionKey:key,expectedBookETag:book.etag!,request}),data=preview.data as {previewToken:string;plan:Plan};
    const payload={previewToken:data.previewToken,request},index=[...operationKinds.values()].indexOf(request.kind),operation=[...operationKinds.keys()][index]!,purpose=operationPurposes[index]!,id=request.kind==='DISBURSE'||request.kind==='ACCRUE'?request.loanId:request.borrowerId;
    const execute=async()=>{await f.proof(f.a,purpose,{organizationId:org,idempotencyKey:key,payload,expectedETag:book.etag!},id);return await ops.mutate(f.a.issued.context,operation,org,payload,key,book.etag!);};
    return{execute,payload,key,etag:book.etag!,operation,purpose,id,preview:data};
  };
  const loan=async(delta:Partial<Terms>={},borrowerId?:string)=>{
    const b=borrowerId??view(await f.borrower()).id,q=view(await f.quote(b,{effectiveDate:'2026-09-30',firstDueDate:'2026-10-31',installmentCount:4,method:'CONSTANT_PRINCIPAL',rate:{type:'EFFECTIVE',unit:'MONTH',value:'0.030000000000'},...delta})),binding={quoteId:q.id,quoteFingerprint:q.fingerprint},draft=await f.mutate('createLoanDraft',binding),confirmed=await f.mutate('confirmLoanTerms',{...binding,termsVersion:1},{id:view(draft).id,etag:draft.etag!});return{borrowerId:b,id:view(confirmed).id,etag:confirmed.etag!,quote:q};
  };
  const fundingRequest=async(l:Awaited<ReturnType<typeof loan>>)=>{
    const funding=await f.runtime.finance.read(f.a.issued.context,'readAccount',org,f.account),versions={} as OperationProfile;
    for(const k of Object.keys(profile) as (keyof OperationProfile)[])versions[k]=(await f.runtime.finance.read(f.a.issued.context,'readAccount',org,profile[k])).etag!;
    const request:Intent={kind:'DISBURSE',loanId:l.id,loanETag:l.etag,fundingAccountETag:funding.etag!,accountProfile:profile,accountVersions:versions,effectiveDate:today(f.now()),supportReference:'SYN-DISBURSE'};return request;
  };
  const disburse=async(l:Awaited<ReturnType<typeof loan>>)=>{const command=await make(await fundingRequest(l));return{command,result:await command.execute()};};
  const position=async(id:string)=>await ops.read(f.a.issued.context,'getLoanPosition',org,id);
  return{...f,ops,profile,make,loan,fundingRequest,disburse,position,opening,borrowerReference,historicalLoanReference};
}
