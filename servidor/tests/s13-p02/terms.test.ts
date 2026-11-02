import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {s13Profile,world} from './fixture.js';
import {definition,recordExample} from './oracle.js';
import {today,day} from '../../src/modules/obligations/calendar.js';
import {originals as economic} from '../../src/modules/obligations/catalog.js';
import {originals as legacy,collections} from '../../src/modules/reporting/projection/catalog.js';
import {hash} from '../../src/modules/simulation/codec.js';
import type {Data} from '../../src/modules/simulation/models.js';
test('native confirmed S4 terms and future S9 official version are projected without quotes/posts or superseded double counting',{timeout:180000},async()=>{
 const group=await s13Profile();try{
  const f=await world(group),date=today(f.now()),ps={organizationId:f.org},future=day(date,1),lending=f.runtime.lending;
  const borrower=await lending.mutate(f.a.issued.context,'createBorrower',f.org,{borrowerCode:'SYN_S12_TERMS',profile:{displayName:'Prestatario de prueba S12',schemaVersion:1,extras:{}}},randomUUID()),terms={borrowerId:(borrower.data as Data)['id'],plannedFundingAccountId:f.bank.id,principal:'100.00',effectiveDate:future,firstDueDate:'2026-11-30',installmentCount:1,method:'CONSTANT_PRINCIPAL',frequency:'MONTH',rate:{type:'EFFECTIVE',unit:'MONTH',value:'0.030000000000'},calendarConvention:'PERIODIC_FIXED',holidayAdjustment:'NO_SHIFT',policyVersion:'S04-LOCAL-CO-0.1',jurisdiction:'CO',usage:'LOCAL_SYNTHETIC'};
  const quote=await lending.mutate(f.a.issued.context,'createLoanQuote',f.org,{terms},randomUUID()),binding={quoteId:(quote.data as Data)['id'],quoteFingerprint:(quote.data as Data)['fingerprint']},draft=await lending.mutate(f.a.issued.context,'createLoanDraft',f.org,binding,randomUUID()),loanId=String((draft.data as Data)['id']);
  await lending.mutate(f.a.issued.context,'confirmLoanTerms',f.org,{...binding,termsVersion:1},randomUUID(),loanId,draft.etag);
  const debtAccount=await f.account('S12_TERMS_DEBT','LIABILITY'),rate={kind:'NONE_DECLARED',source:'SYNTHETIC_DECLARED',sourceReference:'SYN',validFrom:date,observedOn:date,unit:'ANNUAL_FRACTION',convention:'ANNUAL_SIMPLE_ACT_365',decimalValue:'0.00',combine:'NONE'};
  const schedule=(validFrom:string,dueDate:string,interest:string,total:string)=>({kind:'OFFICIAL_DECLARED',validFrom,referenceDate:date,sourceReference:'SYN-DOCUMENT',principalOpening:'100.00',rateVersionIds:[],installments:[{number:1,dueDate,principal:'100.00',interest,insurance:'0.00',fees:'0.00',total}]});
  const debt=await f.mutate('businessCreateLiability',{kind:'BANK_LOAN',label:'Banco sintético',counterpartyReference:'SYN',principal:'100.00',rate,schedule:schedule(date,day(date,7),'10.00','110.00'),prepaymentPermissions:[],supportReference:'SYN'},ps),dp={...ps,liabilityId:String((debt.data as Data)['id'])};
  const active=await f.mutate('businessActivateLiability',{effectiveDate:date,recognitionKind:'CASH_RECEIPT',principalAccountId:debtAccount.id,destinationAccountId:f.bank.id,legalOwnerReference:'SYN',funding:[{kind:'DIRECT_CREDIT',amount:'100.00'}],supportReference:'SYN'},dp,debt.etag);
  await f.mutate('businessVersionLiabilityTerms',{effectiveFrom:future,rate,schedule:schedule(future,day(date,14),'5.00','105.00'),prepaymentPermissions:[],supportReference:'SYN-V2'},dp,active.etag);
  const names=[...new Set([...economic,...legacy,...Object.values(collections).filter(n=>!n.endsWith('barriers')),'s09_projection_heads','s09_projection_manifests','transaction_fence'])],digest=async()=>hash(await Promise.all(names.map(async n=>[n,await f.database.db.collection(n).find({}).sort({_id:1}).toArray()]))),before=await digest();
  const service=f.runtime.simulation,call=async(op:string,input:Data={},p:Record<string,string>=ps)=>{const r=await service.execute(f.a.issued.context,op,input,p,{},randomUUID());await recordExample(op,input,p,r);return r;},base=await call('captureBaseBusinessSimulation',{asOf:date,currency:'COP'}),d=definition({kind:'NEW_LOAN',configured:true,budget:'100.00',date:future,principal:'100.00',cashSourceFlowId:null,reserveReleases:[],terms:{kind:'NATIVE_VERSION',sourceId:loanId,sourceVersion:1}});
  d.horizonDays=40;d.baseId=String(base.data['id']);d.baseToken=String(base.data['baseToken']);d.assumptions[0]!.collectionFraction='0';d.assumptions[1]!.collectionFraction='0.5';d.assumptions[2]!.collectionFraction='1';
  const scenario=await call('createScenarioBusinessSimulation',{name:'Términos aprobados S4',...d}),run=await call('startRunBusinessSimulation',{scenarioId:scenario.data['id'],scenarioVersion:1,baseToken:d.baseToken,mode:'STANDARD',sensitivity:null,evaluateAlerts:false}),rp={...ps,runId:String(run.data['id'])};
  let current=run;for(let i=0;i<40&&current.data['state']!=='SUCCEEDED';i++){await new Promise<void>(r=>setTimeout(r,200));current=await call('getRunBusinessSimulation',{},rp);assert.notEqual(current.data['state'],'FAILED',JSON.stringify(current));}
  assert.equal(current.data['state'],'SUCCEEDED');const result=await call('getResultsBusinessSimulation',{},rp),outcomes=result.data['outcomes'] as Data[];
  for(const[kind,principal,interest]of [['PRUDENT','100.00','0.00'],['BASE','50.00','1.50'],['FAVORABLE','0.00','3.00']]){const o=outcomes.find(o=>o['scenarioKind']===kind&&o['alternativeKind']==='NEW_LOAN')!,metrics=o['metrics'] as Record<string,{value:string|null}>;assert.equal(o['simulability'],'SIMULABLE');assert.equal(metrics['principalOutstanding']!.value,principal);assert.equal(metrics['expectedInterest']!.value,interest);}
  const hold=outcomes.find(o=>o['scenarioKind']==='BASE'&&o['alternativeKind']==='HOLD_CASH')!,metrics=hold['metrics'] as Record<string,{value:string|null}>;assert.equal(metrics['cashFinal']!.value,'19999995.00','future105 supersedes old110, never both');assert.equal(metrics['ownDebt']!.value,'0.00');
  assert.equal(await digest(),before,'No S4 quote/loan/event/ledger/native root/fence mutation from simulation');
 }finally{await group.dispose();}
});
