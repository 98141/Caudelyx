import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {s13Profile,world} from './fixture.js';
import {definition,historicalSeed,recordExample} from './oracle.js';
import {today,day} from '../../src/modules/obligations/calendar.js';
import {hash} from '../../src/modules/simulation/codec.js';
import {authority} from '../../src/modules/simulation/authority.js';
import type {Capture} from '../../src/modules/simulation/sources.js';
import type {Data} from '../../src/modules/simulation/models.js';
import {originals as economic} from '../../src/modules/obligations/catalog.js';
import {originals as legacy,collections} from '../../src/modules/reporting/projection/catalog.js';
test('native S3/S11 history, regular S6 payment and reversal preserve accrued interest, HELD and missing terms',{timeout:180000},async()=>{
 const group=await s13Profile();try{
 const f=await world(group),simulation=f.runtime.simulation;
 const names=[...new Set([...economic,...legacy,...Object.values(collections).filter(n=>!n.endsWith('barriers')),'s09_projection_heads','s09_projection_manifests','transaction_fence'])].sort();
 const digest=async()=>hash(await Promise.all(names.map(async name=>[name,await f.database.db.collection(name).find({}).sort({_id:1}).toArray()])));

   const h=await historicalSeed(f),ps={organizationId:h.organizationId},call=async(op:string,input:Data={},p:Record<string,string>=ps)=>{const r=await simulation.execute(h.actor.issued.context,op,input,p,{},randomUUID());await recordExample(op,input,p,r);return r;},base=await call('captureBaseBusinessSimulation',{asOf:today(f.now()),currency:'COP'}),baseId=String(base.data['id']),before=await digest();
   const payload=await f.database.client.withSession(async s=>{const a=await authority(f.identity,h.actor.issued.context,ps,s),r=await simulation.store.get('s12_bases',baseId,a,s);return await simulation.store.unchunks<Capture>(a,baseId,r['chunks'] as {ids:string[];digest:string},s);});
   assert.equal(payload.base.books[0]!.principalOutstanding,'200.00');assert.equal(payload.base.books[0]!.recognizedInterest,'30.00');assert.equal(payload.base.books[0]!.held,'50.00');assert.equal(payload.base.books[0]!.assetCost,null,'unlinked historical property is not fabricated as zero cost');
   for(const type of ['LOAN_DUE','LOAN_OVERDUE','LIABILITY_DUE','CONCENTRATION','CUSTODY_PENDING','RECONCILIATION_PENDING'])assert.ok(payload.facts.some(f=>f.type===type),'native source predicate '+type);
   assert.equal((base.data['cashBook'] as Data)['value'],'130.00');assert.equal((base.data['available'] as Data)['value'],'80.00');
   const d=definition();d.baseId=baseId;d.baseToken=String(base.data['baseToken']);for(const a of d.assumptions)a.dateOverrides=payload.base.books.flatMap(b=>b.flows.filter(v=>v.date<=payload.base.asOf).map(v=>({sourceKey:v.sourceKey,collectionDate:day(payload.base.asOf,1),recoveryDate:null})));
   d.alternatives[2]={kind:'NEW_LOAN',configured:true,budget:'1.00',reserveReleases:[],principal:'1.00',date:day(payload.base.asOf,1),cashSourceFlowId:null,terms:{kind:'NATIVE_VERSION',sourceId:h.loanId,sourceVersion:1}};for(const a of d.alternatives)a.budget='1.00';
   const scenario=await call('createScenarioBusinessSimulation',{name:'Historia sin términos oficiales',...d}),run=await call('startRunBusinessSimulation',{scenarioId:scenario.data['id'],scenarioVersion:1,baseToken:d.baseToken,mode:'STANDARD',sensitivity:null,evaluateAlerts:true}),rp={...ps,runId:String(run.data['id'])};
   let current=run;for(let i=0;i<40&&current.data['state']!=='SUCCEEDED';i++){await new Promise<void>(r=>setTimeout(r,200));current=await call('getRunBusinessSimulation',{},rp);assert.notEqual(current.data['state'],'FAILED',JSON.stringify(current));}
   assert.equal(current.data['state'],'SUCCEEDED');const result=await call('getResultsBusinessSimulation',{},rp),outcomes=result.data['outcomes'] as Data[],o=outcomes.find(o=>o['scenarioKind']==='BASE'&&o['alternativeKind']==='HOLD_CASH')!,metrics=o['metrics'] as Record<string,{value:string|null}>;
   assert.equal(metrics['cashFinal']!.value,'210.00');assert.equal(metrics['availableFinal']!.value,'160.00');assert.equal(metrics['recognizedInterest']!.value,'0.00');assert.equal(metrics['expectedInterest']!.value,'30.00');assert.equal(metrics['netWorthBook']!.value,'460.00','recognized interest is not accrued as income again after receipt compensation');
   assert.equal(outcomes.find(o=>o['alternativeKind']==='NEW_LOAN')!['simulability'],'NOT_SIMULABLE');assert.equal(await digest(),before);
   // Use a real captured principal source ID. Saving verifies references but does
   // not demand hypothetical funding in all three assumptions.
   const source=payload.base.books[0]!.flows.find(v=>v.direction==='IN'&&v.classification==='PRINCIPAL'&&v.amount!==null&&Number(v.amount)>0);assert.ok(source);const principal=source.amount!,loanDate=day(payload.base.asOf,2),branch=definition({kind:'NEW_LOAN',configured:true,budget:principal,reserveReleases:[],principal,date:loanDate,cashSourceFlowId:source.id,terms:{kind:'DECLARED_HYPOTHESIS',sourceReference:'SYN-NATIVE-H02',principalOpening:principal,installments:[{number:1,dueDate:day(payload.base.asOf,20),principal,interest:'0.00',insurance:'0.00',fees:'0.00',total:principal}]}});
   branch.baseId=baseId;branch.baseToken=String(base.data['baseToken']);for(const a of branch.assumptions)a.dateOverrides=payload.base.books.flatMap(b=>b.flows.filter(v=>v.direction==='IN').map(v=>({sourceKey:v.sourceKey,collectionDate:day(payload.base.asOf,1),recoveryDate:null})));branch.assumptions[0]!.collectionFraction='0.500000';
   const mixed=await call('createScenarioBusinessSimulation',{name:'Fuente nativa con rama prudente insuficiente',...branch}),started=await call('startRunBusinessSimulation',{scenarioId:mixed.data['id'],scenarioVersion:1,baseToken:branch.baseToken,mode:'STANDARD',sensitivity:null,evaluateAlerts:false}),mixedParams={...ps,runId:String(started.data['id'])};let mixedStatus=started;
   for(let i=0;i<60&&mixedStatus.data['state']!=='SUCCEEDED';i++){await new Promise<void>(r=>setTimeout(r,100));mixedStatus=await call('getRunBusinessSimulation',{},mixedParams);assert.notEqual(mixedStatus.data['state'],'FAILED');}assert.equal(mixedStatus.data['state'],'SUCCEEDED');
   const mixedResults=await call('getResultsBusinessSimulation',{},mixedParams),all=mixedResults.data['outcomes'] as Data[];assert.equal(all.length,12);const insufficient=all.find(o=>o['scenarioKind']==='PRUDENT'&&o['alternativeKind']==='NEW_LOAN')!;assert.deepEqual(insufficient['reasons'],['INSUFFICIENT_SOURCE']);assert.equal(insufficient['simulability'],'NOT_SIMULABLE');assert.equal(insufficient['coverage'],'UNAVAILABLE');assert.equal(insufficient['firstDeficitDate'],null);for(const metric of Object.values(insufficient['metrics'] as Record<string,{value:unknown;knownPartial:unknown}>)){assert.equal(metric.value,null);assert.equal(metric.knownPartial,null);}for(const kind of ['BASE','FAVORABLE'])assert.notEqual(all.find(o=>o['scenarioKind']===kind&&o['alternativeKind']==='NEW_LOAN')!['simulability'],'NOT_SIMULABLE');
   const invalid=structuredClone(branch);invalid.alternatives[2]!.cashSourceFlowId=randomUUID();await assert.rejects(()=>call('createScenarioBusinessSimulation',{name:'Referencia inexistente',...invalid}));
   const duplicate=structuredClone(branch),event={id:randomUUID(),date:loanDate,kind:'REINVESTMENT' as const,amount:principal,cashSourceFlowId:source.id,sourceReference:'SYN',economicClass:'PRINCIPAL_RECOVERY' as const};duplicate.assumptions[0]!.capitalEvents=[event,{...event,id:randomUUID()}];await assert.rejects(()=>call('createScenarioBusinessSimulation',{name:'Asignación duplicada real',...duplicate}),(e:unknown)=>e instanceof Error&&'code'in e&&e.code==='DOUBLE_ALLOCATION');assert.equal(await digest(),before);
 }finally{await group.dispose();}
});
