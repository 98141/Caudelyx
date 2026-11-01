import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {s12Profile,world} from './fixture.js';
import {definition,historicalSeed,recordExample} from './oracle.js';
import {today,day} from '../../src/modules/obligations/calendar.js';
import {hash} from '../../src/modules/simulation/codec.js';
import {authority} from '../../src/modules/simulation/authority.js';
import type {Capture} from '../../src/modules/simulation/sources.js';
import type {Data} from '../../src/modules/simulation/models.js';
import {originals as economic} from '../../src/modules/obligations/catalog.js';
import {originals as legacy,collections} from '../../src/modules/reporting/projection/catalog.js';
test('native S3/S11 history, regular S6 payment and reversal preserve accrued interest, HELD and missing terms',{timeout:180000},async()=>{
 const group=await s12Profile();try{
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
 }finally{await group.dispose();}
});
