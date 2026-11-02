/* eslint-disable security/detect-non-literal-fs-filename -- Read-only fixed own BUILD-STATE path; all evidence writes pass the exclusive P02 guard. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {base,definition,flow,uid} from './oracle.js';
import {evaluate} from '../../src/modules/simulation/engine.js';
import {isolated} from '../../src/modules/simulation/process.js';
import {AppError} from '../../src/shared/errors.js';
import {s13Profile,world,password} from './fixture.js';
import {today,day} from '../../src/modules/obligations/calendar.js';
import type {Data} from '../../src/modules/simulation/models.js';
import {hash} from '../../src/modules/simulation/codec.js';
import {originals as economic} from '../../src/modules/obligations/catalog.js';
import {originals as legacy,collections} from '../../src/modules/reporting/projection/catalog.js';
const {writeOwn,projectRoot}=await import(new URL('../../../scripts/s13-p04-guard.mjs',import.meta.url).href) as typeof import('../../scripts/s13-p04-guard.mjs');
const measurements:Data[]=[];
async function readCapacity(f:Awaited<ReturnType<typeof world>>){
 const ps={organizationId:f.org},date=today(f.now()),future=day(date,1),due=day(date,370),rate={kind:'NONE_DECLARED',source:'SYNTHETIC_DECLARED',sourceReference:'SYN',validFrom:date,observedOn:date,unit:'ANNUAL_FRACTION',convention:'ANNUAL_SIMPLE_ACT_365',decimalValue:'0.00',combine:'NONE'},debtAccount=await f.account('P04_CAP_DEBT','LIABILITY');
 const debt=await f.mutate('businessCreateLiability',{kind:'BANK_LOAN',label:'Banco sintético capacidad',counterpartyReference:'SYN',principal:'100.00',rate,schedule:{kind:'OFFICIAL_DECLARED',validFrom:date,referenceDate:date,sourceReference:'SYN',principalOpening:'100.00',rateVersionIds:[],installments:[{number:1,dueDate:due,principal:'100.00',interest:'0.00',insurance:'0.00',fees:'0.00',total:'100.00'}]},prepaymentPermissions:['REDUCE_INSTALLMENT'],supportReference:'SYN'},ps),liabilityId=String((debt.data as Data)['id']);
 await f.mutate('businessActivateLiability',{effectiveDate:date,recognitionKind:'CASH_RECEIPT',principalAccountId:debtAccount.id,destinationAccountId:f.bank.id,legalOwnerReference:'SYN',funding:[{kind:'DIRECT_CREDIT',amount:'100.00'}],supportReference:'SYN'}, {...ps,liabilityId},debt.etag);
 await f.mutate('businessCreateExpenseRule',{frequency:'DAILY',startDate:future,endDate:day(date,366),monthEndPolicy:'CLAMP_TO_LAST_DAY',description:'Gasto diario sintético',category:'SERVICES',amountMode:'FIXED',amount:'0.01',supportReference:'SYN'},ps);
 const api=await f.https();api.client.cookies.set('__Host-caudelyx-session',f.a.issued.token);await api.client.refreshCsrf();await f.restore.flush();
 const names=[...new Set([...economic,...legacy,...Object.values(collections).filter(n=>!n.endsWith('barriers')),'s09_projection_heads','s09_projection_manifests','transaction_fence'])],digest=async()=>hash(await Promise.all(names.map(async n=>[n,await f.database.db.collection(n).find({}).sort({_id:1}).toArray()]))),before=await digest(),root='/api/v1/organizations/'+f.org+'/simulation-s12';
 const post=async(path:string,body:Data)=>{const r=await api.client.call('POST',root+path,body,{'Idempotency-Key':randomUUID()});assert.ok([201,202].includes(r.status),JSON.stringify(r.body));return r.body.data!;};
 const b=await post('/bases',{asOf:date,currency:'COP'}),d=definition({kind:'ASSET_PURCHASE',configured:true,budget:'10.00',reserveReleases:[],date:future,grossCost:'10.00',ownCash:'10.00',ownDebt:'0.00',directCreditor:true,ownershipFraction:'1.000000',estimatedGrossValue:'12.00',vacancyFraction:'0.000000',rentSchedule:[],costSchedule:[]});d.baseId=String(b['id']);d.baseToken=String(b['baseToken']);d.horizonDays=366;
 d.alternatives[1]={kind:'DEBT_PREPAYMENT',configured:true,budget:'10.00',reserveReleases:[],date:future,liabilityId,prepaymentMode:'REDUCE_INSTALLMENT',terms:{kind:'DECLARED_HYPOTHESIS',sourceReference:'SYN',principalOpening:'90.00',installments:[{number:1,dueDate:due,principal:'90.00',interest:'0.00',insurance:'0.00',fees:'0.00',total:'90.00'}]}};
 d.alternatives[2]={kind:'NEW_LOAN',configured:true,budget:'10.00',reserveReleases:[],date:future,principal:'10.00',cashSourceFlowId:null,terms:{kind:'DECLARED_HYPOTHESIS',sourceReference:'SYN',principalOpening:'10.00',installments:[{number:1,dueDate:day(date,10),principal:'10.00',interest:'1.00',insurance:'0.00',fees:'0.00',total:'11.00'}]}};
 const scenario=await post('/scenarios',{name:'Capacidad366dias12alternativas',...d}),run=await post('/runs',{scenarioId:scenario['id'],scenarioVersion:1,baseToken:d.baseToken,mode:'STANDARD',sensitivity:null,evaluateAlerts:false});let state='QUEUED';
 for(let i=0;i<60&&['QUEUED','RUNNING'].includes(state);i++){const r=await api.client.call('GET',root+'/runs/'+run['id']);assert.equal(r.status,200);state=String(r.body.data!['state']);if(['QUEUED','RUNNING'].includes(state))await new Promise<void>(r=>setTimeout(r,100));}assert.equal(state,'SUCCEEDED');
 const start=performance.now(),rssBefore=process.memoryUsage().rss,seen=new Set<string>();let cursor:string|null=null,pages=0,bytes=0,maxPageMs=0,total=0;
 do{const stamp=performance.now(),r=await api.client.call('GET',root+'/runs/'+run['id']+'/results?limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):''));maxPageMs=Math.max(maxPageMs,performance.now()-stamp);assert.equal(r.status,200,JSON.stringify(r.body));const data=r.body.data!;total=Number(data['totalRows']);for(const row of data['items'] as Data[]){const key=String(row['outcomeId'])+':'+row['date'];assert.equal(seen.has(key),false);seen.add(key);}bytes+=Buffer.byteLength(JSON.stringify(r.body));cursor=data['nextCursor'] as string|null;pages++;assert.ok(pages<=44);
 }while(cursor);
 assert.equal(total,4392);assert.equal(seen.size,4392);assert.equal(pages,44);assert.equal(await digest(),before);
 const result={case:'native HTTPS consumer366days12outcomes44pages',pages,totalRows:total,uniqueRows:seen.size,responseBytes:bytes,durationMs:performance.now()-start,maxPageMs,rssBefore,rssAfter:process.memoryUsage().rss,parentPeakRSS:process.resourceUsage().maxRSS*1024,economicDigest:before,noEconomicMutation:true,memoryScope:'API host/fixture parent, distinct from isolated256MiB worker; no p95 or hard OS quota claimed'};measurements.push(result);await writeOwn(join(projectRoot,'Construccion/Sprints/S13/Evidencias/S13-P04-CAPACITY-READ.json'),JSON.stringify({state:'PASS',...result},null,2)+'\n');
}
test('bounded isolated worker:366days/12outcomes, expansion ceiling, revocation/cancel before publication',{timeout:60000},async()=>{
 const b=base(Array.from({length:2000},(_,i)=>flow(10000+i,day('2026-11-01',i%366),'OUT','0.01')),{cashBook:'10000.00',available:'10000.00',ownDebt:'100.00'}),d=definition({kind:'NEW_LOAN',budget:'10.00',configured:true,reserveReleases:[],date:'2026-11-01',principal:'10.00',cashSourceFlowId:null,terms:{kind:'DECLARED_HYPOTHESIS',sourceReference:'SYN',principalOpening:'10.00',installments:[{number:1,dueDate:'2026-12-01',principal:'10.00',interest:'1.00',insurance:'0.00',fees:'0.00',total:'11.00'}]}});
 d.horizonDays=366;
 b.books[0]!.terms=[{id:uid(900),version:1,kind:'LIABILITY',bookId:b.targetBookId,principalOpening:'100.00',installments:[{number:1,dueDate:'2026-12-01',principal:'100.00',interest:'1.00',insurance:'0.00',fees:'0.00',total:'101.00'}],prepaymentPermissions:['REDUCE_INSTALLMENT'],supported:true,reason:null}];
 b.books[0]!.flows.push(flow(900,'2026-12-01','OUT','100.00','DEBT_PRINCIPAL'));
 d.alternatives[1]={kind:'DEBT_PREPAYMENT',budget:'10.00',configured:true,reserveReleases:[],liabilityId:uid(900),date:'2026-11-01',prepaymentMode:'REDUCE_INSTALLMENT',terms:{kind:'DECLARED_HYPOTHESIS',sourceReference:'SYN',principalOpening:'90.00',installments:[{number:1,dueDate:'2026-12-01',principal:'90.00',interest:'0.90',insurance:'0.00',fees:'0.00',total:'90.90'}]}};
 d.alternatives[3]={kind:'ASSET_PURCHASE',budget:'10.00',configured:true,reserveReleases:[],date:'2026-11-01',grossCost:'10.00',ownCash:'10.00',ownDebt:'0.00',directCreditor:true,ownershipFraction:'1.000000',estimatedGrossValue:'12.00',vacancyFraction:'0.000000',rentSchedule:[],costSchedule:[]};
 let checks=0;const start=performance.now(),r=await isolated(b,d,'capacity',null,async()=>{checks++;});
 assert.equal(r.value.outcomes.length,12);assert.equal(r.value.days.length,4392);assert.ok(r.metrics.peakRSS<=268435456);assert.ok(r.metrics.durationMs<=10000);assert.ok(r.value.metrics.expandedFlows<=50000);assert.ok(Buffer.byteLength(JSON.stringify(r.value))<=16777216);assert.ok(checks>=2);
 assert.ok(r.metrics.workerPid);assert.throws(()=>process.kill(r.metrics.workerPid!,0),(e:unknown)=>e instanceof Error&&'code'in e&&e.code==='ESRCH');
 measurements.push({case:'366/12/2000sources',...r.metrics,parentDurationMs:performance.now()-start,expandedFlows:r.value.metrics.expandedFlows,resultBytes:Buffer.byteLength(JSON.stringify(r.value)),checks,childExitAwaited:true});
 const tooLarge=structuredClone(b);tooLarge.books[0]!.flows=Array.from({length:50001},(_,i)=>flow(30000+i,'2026-11-01','OUT','0.01'));
 assert.throws(()=>evaluate(tooLarge,d,{seed:'limit'}),(e:unknown)=>e instanceof AppError&&e.code==='SIMULATION_SCOPE_TOO_LARGE');
 for(const code of ['ACCESS_DENIED','RUN_STATE_CONFLICT']){
  let n=0;const start=performance.now();await assert.rejects(()=>isolated(b,d,'rejected',null,async()=>{if(++n>1)throw new AppError(403,code);}), (e:unknown)=>e instanceof AppError&&e.code===code);
  measurements.push({case:code,checks:n,durationMs:performance.now()-start,noResultPublished:true});
 }
 await writeOwn(join(projectRoot,'Construccion/Sprints/S13/Evidencias/S13-P04-CAPACITY-WORKER.json'),JSON.stringify({state:'PASS_COMPONENT_WORKER',sourceKey:JSON.parse(await readFile(join(projectRoot,'Construccion/Sprints/S13/Evidencias/S13-P04-BUILD-STATE.json'),'utf8')).key,measurements},null,2)+'\n');
});
test('native transactional global queue8, one active actor-scope, cancel/revoke never publish',{timeout:420000},async()=>{
 const group=await s13Profile();try{
  const f=await world(group),service=f.runtime.simulation,actors=[];await readCapacity(f);const previousResults=await f.database.db.collection('s12_results').countDocuments();
  // Native actors and assignments are seeded before evaluating S12 admission.
  for(let i=0;i<9;i++){const a=await f.actor();await f.runtime.organizations.create(a.issued.context,{name:'Titular sintético cola '+i,currency:'COP',timezone:'America/Bogota'},randomUUID());const book=await f.mutate('createPersonalBook',{currency:'COP'},{},undefined,randomUUID(),a);actors.push({a,params:{bookId:String((book.data as Data)['id'])}});}
  const control=service as unknown as {pumping:boolean};control.pumping=true;const runs:{a:typeof f.a;params:{bookId:string};id:string;etag:string|undefined}[]=[];
  let firstRequest:Data|undefined;
  try{
   for(const[i,item]of actors.entries()){
    const call=async(op:string,input:Data={})=>await service.execute(item.a.issued.context,op,input,item.params,{},randomUUID()),b=await call('captureBasePersonalSimulation',{asOf:today(f.now()),currency:'COP'}),d={...definition(),baseId:b.data['id'],baseToken:b.data['baseToken']},scenario=await call('createScenarioPersonalSimulation',{name:'Cola sintética '+i,...d}),request={scenarioId:scenario.data['id'],scenarioVersion:1,baseToken:b.data['baseToken'],mode:'STANDARD',sensitivity:null,evaluateAlerts:false};
    if(i===0)firstRequest=request;
    if(i===8){await assert.rejects(()=>call('startRunPersonalSimulation',request),(e:unknown)=>e instanceof AppError&&e.code==='RATE_LIMITED');break;}
    const run=await call('startRunPersonalSimulation',request);assert.equal(run.data['state'],'QUEUED');runs.push({...item,id:String(run.data['id']),etag:run.etag});
    if(i===0)await assert.rejects(()=>call('startRunPersonalSimulation',request),(e:unknown)=>e instanceof AppError&&e.code==='RUN_STATE_CONFLICT');
   }
   assert.equal(await f.database.db.collection('s12_runs').countDocuments({state:'QUEUED'}),8);assert.equal(await f.database.db.collection('s12_results').countDocuments(),previousResults);
   for(const run of runs){const r=await service.execute(run.a.issued.context,'cancelRunPersonalSimulation',{}, {...run.params,runId:run.id},{},randomUUID(),run.etag);assert.equal(r.data['state'],'CANCELLED');}
   assert.equal(await f.database.db.collection('s12_results').countDocuments(),previousResults);
   const owner=actors[0]!,revokedRun=await service.execute(owner.a.issued.context,'startRunPersonalSimulation',firstRequest!,owner.params,{},randomUUID());
   await f.identity.revokeSessions(owner.a.issued.context,owner.a.issued.context.managementId);
   control.pumping=false;await (service as unknown as {pump:()=>Promise<void>}).pump();
   assert.equal(await f.database.db.collection('s12_results').countDocuments(),previousResults);
   await assert.rejects(()=>service.execute(owner.a.issued.context,'getRunPersonalSimulation',{}, {...owner.params,runId:String(revokedRun.data['id'])}),(e:unknown)=>e instanceof AppError&&e.code==='AUTH_INVALID');
   owner.a.issued=(await f.identity.login('TENANT',randomUUID(),owner.a.email,password)).issued;
   const durable=await service.execute(owner.a.issued.context,'getRunPersonalSimulation',{}, {...owner.params,runId:String(revokedRun.data['id'])});assert.equal(durable.data['state'],'QUEUED','no credential was persisted to execute revoked queued work');
   measurements.push({case:'native global admission',queued:8,ninth:'RATE_LIMITED',sameActor:'RUN_STATE_CONFLICT',cancelled:8,results:0,pumpPause:'Explicit test interleaving only, no production hook'});
  }finally{control.pumping=false;}
  await writeOwn(join(projectRoot,'Construccion/Sprints/S13/Evidencias/S13-P04-CAPACITY-NATIVE.json'),JSON.stringify({state:'PASS_COMPONENT_NATIVE',sourceKey:JSON.parse(await readFile(join(projectRoot,'Construccion/Sprints/S13/Evidencias/S13-P04-BUILD-STATE.json'),'utf8')).key,measurements:measurements.filter(m=>m['case']==='native global admission'),groupId:group.runId},null,2)+'\n');
 }finally{await group.dispose();}
});
