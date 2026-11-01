import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {s12Profile,world,password} from './fixture.js';
import {workbook,definition} from './oracle.js';
import {hash} from '../../src/modules/simulation/codec.js';
import {simulationContract} from '../../src/modules/simulation/contract.js';
import {originals as economic} from '../../src/modules/obligations/catalog.js';
import {originals as legacy,collections} from '../../src/modules/reporting/projection/catalog.js';
import {today,day} from '../../src/modules/obligations/calendar.js';
import type {Data} from '../../src/modules/simulation/models.js';
test('H04 and native simulator financial invariance with one guarded Mongo group',{timeout:300000},async t=>{
 const group=await s12Profile();
 try{
  const f=await world(group),service=f.identity.exchange!,params={organizationId:f.org},namespace='SYN-S12-H04';
  const preview=async(name:string)=>{
   const created=await service.createImport(f.a.issued.context,'createBusinessImport',{label:'Catálogo sintético',namespace,mode:'OPERATIVE',templateVersion:'1.0.0',mappingVersion:'S11-MAP-1'},params,randomUUID());
   const ps={...params,importId:String(created.data['id'])},bytes=workbook('OPERATIVE',namespace,{Cuentas:[{externalKey:'BANK',action:'CREATE',code:'SYN_H04',name,accountClass:'ASSET',kind:'BANK',currency:'COP'}]});
   const upload=await service.upload(f.a.issued.context,ps,randomUUID(),created.etag,bytes);
   await service.preparePreview(f.a.issued.context,ps,randomUUID(),upload.etag);
   return{ps,current:await service.readImport(f.a.issued.context,ps,'getBusinessImport'),preview:await service.readImport(f.a.issued.context,ps,'getBusinessImportPreview')};
  };
  const first=await preview('Cuenta sintética primera');assert.equal(first.preview.data['canConfirm'],true);
  const racing=await preview('Cuenta sintética competidora');assert.equal(racing.preview.data['canConfirm'],true);
  const payload={previewId:first.preview.data['id'],semanticHash:first.preview.data['semanticHash'],bookETag:await f.database.client.withSession(s=>f.wealth.bookTag({kind:'BUSINESS',bookId:f.org,ownerId:f.org,organizationId:f.org},s))},key=randomUUID();
  await f.proof(f.a,'IMPORT_CONFIRM',{operationId:'confirmBusinessImport',organizationId:f.org,pathParameters:first.ps,payload,idempotencyKey:key,expectedETag:first.current.etag},first.ps.importId);
  const peer=await group.peer({keys:f.keys,now:f.now(),enableBusiness:true,enableSimulation:true});
  try{
   const otherPayload={...payload,previewId:racing.preview.data['id'],semanticHash:racing.preview.data['semanticHash']},results=await Promise.allSettled([
    service.confirm(f.a.issued.context,first.ps,payload,key,first.current.etag),
    peer.execute({operation:'confirmBusinessImport',params:racing.ps,payload:otherPayload,key:randomUUID(),expected:racing.current.etag,token:f.a.issued.token})
   ]);
   const statuses=results.map(r=>r.status==='fulfilled'?r.value:({type:'error',code:(r.reason as {code:string}).code}));
   assert.equal(statuses.filter(r=>r['status']===201).length,1,JSON.stringify(statuses));
   assert.equal(statuses.filter(r=>['IMPORT_PREVIEW_STALE','EXTERNAL_KEY_CONFLICT','PRECONDITION_FAILED'].includes(String((r as Data)['code']))).length,1,JSON.stringify(statuses));
   assert.equal(await f.runtime.finance.accounts.countDocuments({organizationId:f.org,code:'SYN_H04'}),1);
   const winner=statuses.findIndex(r=>r['status']===201),account=await f.runtime.finance.accounts.findOne({organizationId:f.org,code:'SYN_H04'});assert.equal(account?.name,winner===0?'Cuenta sintética primera':'Cuenta sintética competidora');
  }finally{await peer.close();}
  const second=await preview('Cuenta sintética distinta');
  assert.equal(second.preview.data['canConfirm'],false);
  assert.ok((second.preview.data['items'] as Record<string,unknown>[]).some(i=>i['code']==='EXTERNAL_KEY_CONFLICT'&&i['cell']==='A2'&&i['severity']==='ERROR'));
  const simulation=f.runtime.simulation;
  const names=[...new Set([...economic,...legacy,...Object.values(collections).filter(n=>!n.endsWith('barriers')),'s09_projection_heads','s09_projection_manifests','transaction_fence'])].sort();
  const digest=async()=>hash(await Promise.all(names.map(async name=>[name,await f.database.db.collection(name).find({}).sort({_id:1}).toArray()])));
  const before=await digest();
  let commands=0;
  const saved:{value:{mutate?:unknown};original:unknown}[]=[];
  for(const service of [f.runtime.finance,f.runtime.opening,f.runtime.lending,f.runtime.operations,f.runtime.payments!,f.runtime.collections!,f.service,f.wealth]){
   const value=service as unknown as {mutate?:unknown};if(typeof value.mutate==='function'){saved.push({value,original:value.mutate});value.mutate=()=>{commands++;throw Error('SIMULATION_FINANCIAL_COMMAND_FORBIDDEN');};}
  }
  const invoke=async(operation:string,input:Data={},ps:Record<string,string>=params,query:Data={},key:string=randomUUID(),expected?:string)=>{
   const r=await simulation.execute(f.a.issued.context,operation,input,ps,query,key,expected);
   simulationContract().result(operation,r.status,{data:r.data,requestId:randomUUID()});return r;
  };
  const captured=await invoke('captureBaseBusinessSimulation',{asOf:today(f.now()),currency:'COP'}),d=definition();
  assert.equal((captured.data['cashBook'] as Data)['value'],'20000000.00');
  d.baseId=String(captured.data['id']);d.baseToken=String(captured.data['baseToken']);
  const scenario=await invoke('createScenarioBusinessSimulation',{name:'Escenario sintético',...d}),scenarioId=String(scenario.data['id']);
  const run=await invoke('startRunBusinessSimulation',{scenarioId,scenarioVersion:1,baseToken:d.baseToken,mode:'STANDARD',sensitivity:null,evaluateAlerts:false}),runId=String(run.data['id']);
  let state='QUEUED';
  for(let i=0;i<35&&!['SUCCEEDED','FAILED'].includes(state);i++){await new Promise<void>(r=>setTimeout(r,250));const status=await invoke('getRunBusinessSimulation',{}, {...params,runId});state=String(status.data['state']);if(state==='FAILED')assert.fail(JSON.stringify(status));}
  assert.equal(state,'SUCCEEDED');
  const results=await invoke('getResultsBusinessSimulation',{}, {...params,runId},{limit:'2'});
  assert.equal((results.data['outcomes'] as unknown[]).length,12);assert.equal(results.data['totalRows'],90);assert.ok(results.data['nextCursor']);
  const facts=await invoke('evaluateAlertsBusinessSimulation',{kind:'FACT',baseId:d.baseId,baseToken:d.baseToken,thresholds:{dueWithinDays:7,concentrationThreshold:'25.00'}});
  assert.equal(facts.data['created'],0);
  assert.equal(commands,0);assert.equal(await digest(),before,'S12 must not mutate any native economic or derived record/fence');
  await t.test('comparison rejects two successful runs sharing a base but having different horizons',async()=>{
   const other={...d,horizonDays:29},scenario=await invoke('createScenarioBusinessSimulation',{name:'Horizonte incompatible',...other}),started=await invoke('startRunBusinessSimulation',{scenarioId:scenario.data['id'],scenarioVersion:1,baseToken:d.baseToken,mode:'STANDARD',sensitivity:null,evaluateAlerts:false}),rp={...params,runId:String(started.data['id'])};
   let current=started;for(let i=0;i<40&&current.data['state']!=='SUCCEEDED';i++){await new Promise<void>(r=>setTimeout(r,200));current=await invoke('getRunBusinessSimulation',{},rp);assert.notEqual(current.data['state'],'FAILED');}assert.equal(current.data['state'],'SUCCEEDED');const result=await invoke('getResultsBusinessSimulation',{},rp);
   await assert.rejects(()=>invoke('compareBusinessSimulation',{runIds:[runId,rp.runId],outcomeIds:[(results.data['outcomes'] as Data[])[0]!['id'],(result.data['outcomes'] as Data[])[0]!['id']]}),(e:unknown)=>e instanceof Error&&'code'in e&&e.code==='COMPARISON_BASE_MISMATCH');assert.equal(await digest(),before);
  });
  for(const s of saved)s.value.mutate=s.original;
  await t.test('native80M cash with fund20M projects the200M purchase and220M estimate without posting',async()=>{
   const date=today(f.now()),extra={currency:'COP',effectiveDate:date,sourceId:randomUUID(),supportReference:'SYN-S12-CAPITAL',description:'Capital sintético para prueba',lines:[{accountId:f.bank.id,debit:'60000000.00',credit:'0.00'},{accountId:f.equity.id,debit:'0.00',credit:'60000000.00'}]},capitalKey=randomUUID();
   await f.proof(f.a,'FINANCE_JOURNAL_POST',{organizationId:f.org,idempotencyKey:capitalKey,payload:extra});await f.runtime.finance.mutate(f.a.issued.context,'postJournal',f.org,extra,capitalKey);
   const fund=await f.wealthMutate('businessCreateFund',{mode:'VIRTUAL',label:'Reserva sintética S12',purpose:'ASSET_PURCHASE',backingAccountId:f.bank.id,supportReference:'SYN'},params),fundId=String((fund.data as Data)['id']),fp={...params,fundId};
   const fr=await f.wealthRead('businessGetFund',fp,{asOf:date}),book=await f.wealthRead('businessGetWealthBook',params,{asOf:date});
   await f.wealthMutate('businessAllocateFund',{bookETag:book.etag,effectiveDate:date,amount:'20000000.00',supportReference:'SYN'},fp,fr.etag);
   f.clock.value+=60001;const unchanged=await digest(),base=await invoke('captureBaseBusinessSimulation',{asOf:today(f.now()),currency:'COP'});
   assert.equal((base.data['cashBook'] as Data)['value'],'80000000.00');assert.equal((base.data['available'] as Data)['value'],'60000000.00');assert.equal((base.data['reserved'] as Data)['value'],'20000000.00');
   const next=day(today(f.now()),1),version=definition({kind:'ASSET_PURCHASE',configured:true,budget:'80000000.00',date:next,reserveReleases:[{fundId,amount:'20000000.00',date:next}],grossCost:'200000000.00',ownCash:'80000000.00',ownDebt:'120000000.00',directCreditor:true,ownershipFraction:'1.000000',estimatedGrossValue:'220000000.00',vacancyFraction:'0.000000',rentSchedule:[],costSchedule:[]});
   version.baseId=String(base.data['id']);version.baseToken=String(base.data['baseToken']);
   const scenario=await invoke('createScenarioBusinessSimulation',{name:'Compra hipotética sobre reserva real',...version}),run=await invoke('startRunBusinessSimulation',{scenarioId:scenario.data['id'],scenarioVersion:1,baseToken:version.baseToken,mode:'STANDARD',sensitivity:null,evaluateAlerts:true}),rp={...params,runId:String(run.data['id'])};
   let current=run;for(let i=0;i<35&&current.data['state']!=='SUCCEEDED';i++){await new Promise<void>(r=>setTimeout(r,200));current=await invoke('getRunBusinessSimulation',{},rp);assert.notEqual(current.data['state'],'FAILED',JSON.stringify(current));}
   assert.equal(current.data['state'],'SUCCEEDED');const result=await invoke('getResultsBusinessSimulation',{},rp),outcomes=result.data['outcomes'] as Data[],o=outcomes.find(o=>o['scenarioKind']==='BASE'&&o['alternativeKind']==='ASSET_PURCHASE')!,metrics=o['metrics'] as Record<string,{value:string|null}>;
   assert.equal(metrics['cashFinal']!.value,'0.00');assert.equal(metrics['cost']!.value,'200000000.00');assert.equal(metrics['ownDebt']!.value,'120000000.00');assert.equal(metrics['netWorthBook']!.value,'80000000.00');assert.equal(metrics['netWorthIndicative']!.value,'100000000.00');
   const chosen=outcomes.filter(o=>o['scenarioKind']==='BASE'&&['HOLD_CASH','ASSET_PURCHASE'].includes(String(o['alternativeKind']))).map(o=>o['id']),comparison=await invoke('compareBusinessSimulation',{runIds:[rp.runId],outcomeIds:chosen});assert.equal(comparison.data['winner'],null);
   assert.equal(await digest(),unchanged,'native reserve/cash/roots and all economic records unchanged by alternative, alerts and comparison');
  });
  await t.test('current native expense produces one private fact alert; dedupe and ACK do not recognize or pay it',async()=>{
   const date=today(f.now());await f.mutate('businessCreateExpense',{nominalDate:date,dueDate:date,description:'Gasto sintético vencido',category:'OTHER',amountMode:'FIXED',amount:'300.00',supportReference:'SYN'},params);
   f.clock.value+=60001;const before=await digest(),base=await invoke('captureBaseBusinessSimulation',{asOf:today(f.now()),currency:'COP'}),input={kind:'FACT',baseId:base.data['id'],baseToken:base.data['baseToken'],thresholds:{dueWithinDays:7,concentrationThreshold:'25.00'}};
   const first=await invoke('evaluateAlertsBusinessSimulation',input);assert.equal(first.data['created'],1);
   const again=await invoke('evaluateAlertsBusinessSimulation',input);assert.equal(again.data['created'],0);
   const list=await invoke('listAlertsBusinessSimulation',{},params),alert=(list.data['items'] as Data[]).find(a=>a['type']==='EXPENSE_DUE');assert.ok(alert);
   const ap={...params,alertId:String(alert['id'])},detail=await invoke('getAlertBusinessSimulation',{},ap),ack=await invoke('acknowledgeAlertBusinessSimulation',{},ap,{},randomUUID(),detail.etag);assert.equal(ack.data['state'],'ACKNOWLEDGED');assert.equal(await digest(),before);
   f.clock.value+=31*86400000;await f.runtime.simulation.reconcile();f.a.issued=(await f.identity.login('TENANT',randomUUID(),f.a.email,password)).issued;
   const later=await invoke('captureBaseBusinessSimulation',{asOf:today(f.now()),currency:'COP'});await invoke('evaluateAlertsBusinessSimulation',{...input,baseId:later.data['id'],baseToken:later.data['baseToken']});
   const recurrence=await invoke('listAlertsBusinessSimulation',{},params),next=(recurrence.data['items'] as Data[]).find(a=>a['type']==='EXPENSE_DUE');assert.ok(next);assert.notEqual(next['id'],alert['id']);assert.equal(next['episode'],2);assert.equal(next['state'],'ACTIVE');
  });

 }finally{await group.dispose();}
});
