/* eslint-disable security/detect-non-literal-fs-filename -- Fixed evidence directory with closed validated S09-P04 or S09-P05 alphanumeric prefix; no HTTP path input. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {Document} from 'mongodb';
import {s09Profile} from './profile.js';
import {world,rate,official} from './fixture.js';
import {signRow,managementEvidenceMatches,managementHead} from '../../src/modules/obligations/evidence.js';
import {decimal} from '../../src/modules/finance/money.js';
import {ProjectionRuntime} from '../../src/modules/reporting/projection/service.js';
import {booksTable,type Book,type Row,type Scope} from '../../src/modules/obligations/models.js';
const evidencePrefix=process.env['S09_EVIDENCE_PREFIX']??'S09-P04';if(evidencePrefix!=='S09-P04'&&!/^S09-P05-[a-zA-Z0-9]{1,24}$/.test(evidencePrefix))throw Error('Invalid independent evidence namespace');
const preflight=process.env['S09_STRESS_PREFLIGHT']==='1',batches=preflight?1:20,population=batches*50;
test('S09 affected PERSONAL current reads '+population+' liabilities / '+population*10+' events / '+population*50+' journal lines / two readers, BUSINESS exclusion',{timeout:600000},async()=>{
 const group=await s09Profile(),wall=performance.now();try{
  const f=await world(group),bank=await f.personal('S_BANK','ASSET','BANK'),debt=await f.personal('S_DEBT','LIABILITY'),expense=await f.personal('S_EXPENSE','EXPENSE'),payable=await f.personal('S_PAYABLE','LIABILITY'),scope:Scope={kind:'PERSONAL',bookId:f.book.id,ownerId:f.a.issued.context.subjectId!};
  await f.service.stop();await f.projection.stop();f.clock.open=false;const seedStart=performance.now(),base=f.now();let tick=0;
  const fixtureRate={...rate,kind:'FIXED',unit:'PERIOD_FRACTION',convention:'PERIODIC_EFFECTIVE',decimalValue:'0.09',periodDefinition:'2026-09-28..2026-10-28'};
  for(let batch=0;batch<batches;batch++)await f.database.transaction(async s=>{
   f.service.store.tracking.begin(s);try{
    const groups=new Map<string,Row[]>(),add=(name:string,body:Document&{_id:string})=>{const row=signRow(f.database,name,{...body,bookId:scope.bookId,ownerId:scope.ownerId,domainKind:'PERSONAL'}),xs=groups.get(name)??[];xs.push(row);groups.set(name,xs);return row;};
    for(let k=0;k<50;k++){
     const entity=randomUUID(),scheduleId=randomUUID(),activation=randomUUID(),at=new Date(base+(++tick)).toISOString(),schedule={...official('1000.00','2026-10-28','90.00'),id:scheduleId,version:1},body={_id:entity,bookId:scope.bookId,ownerId:scope.ownerId,domainKind:'PERSONAL',kind:'BANK_LOAN',label:'Sintética '+String(batch*50+k).padStart(4,'0'),counterpartyReference:'SYN-EXTERNAL',principal:'1000.00',rate:fixtureRate,schedule,prepaymentPermissions:[],supportReference:'SYN-STRESS',principalAccountId:debt.id,recognitionKind:'CASH_RECEIPT',activationEventId:activation};
     add('s09_liability_versions_personal',{_id:scheduleId,version:1,recordedAt:at,liabilityId:entity,validFrom:'2026-10-28',rate:fixtureRate,schedule,prepaymentPermissions:[],supportReference:'SYN-STRESS'});
     for(let n=0;n<10;n++){
      const eventId=n===0?activation:randomUUID(),journalId=randomUUID(),stamp=new Date(base+(++tick)).toISOString(),amount=n===0?'1000.00':'10.00',lines=n===0?[{accountId:bank.id,debit:decimal('400.00'),credit:decimal('0.00')},{accountId:bank.id,debit:decimal('600.00'),credit:decimal('0.00')},...['250.00','250.00','500.00'].map(credit=>({accountId:debt.id,debit:decimal('0.00'),credit:decimal(credit)}))]:[...Array.from({length:4},()=>({accountId:expense.id,debit:decimal('2.50'),credit:decimal('0.00')})),{accountId:payable.id,debit:decimal('0.00'),credit:decimal('10.00')}];
      add('s09_personal_journals',{_id:journalId,version:1,recordedAt:stamp,effectiveDate:'2026-10-28',sourceKind:'MANAGEMENT_OPERATION',sourceId:eventId,supportReference:'SYN-STRESS',reversalOfId:null,lines});
      add('s09_events_personal',{_id:eventId,version:1,recordedAt:stamp,entityId:entity,kind:n===0?'LIABILITY_ACTIVATE':'LIABILITY_COMPONENT_RECOGNIZE',effectiveDate:'2026-10-28',unitKnownAt:stamp,amount,journalIds:[journalId],allocations:n===0?[]:[{installmentNumber:1,component:'INTEREST',amount:'10.00',accountId:payable.id}],reversalOfId:null,components:n===0?{principalAdded:'1000.00',recognitionKind:'CASH_RECEIPT'}:{scheduleVersionId:scheduleId}});
      const payload=signRow(f.database,'s09_liabilities_personal',{...body,version:n+1,status:n===0?'DRAFT':'ACTIVE',recordedAt:stamp});add('s09_history_personal',{_id:'s09_liabilities_personal:'+entity+':'+(n+1),version:1,recordedAt:stamp,entityTable:'s09_liabilities_personal',entityId:entity,payload});
     }
     add('s09_liabilities_personal',{...body,version:11,status:'ACTIVE',recordedAt:new Date(base+(++tick)).toISOString()});
    }
    for(const[name,rows]of groups){await f.database.db.collection<Row>(name).insertMany(rows,{session:s});for(const row of rows)f.service.store.tracking.capture(s,name,null,row);}
    const book=await f.service.store.get<Book>(booksTable,scope.bookId,scope,s);await f.service.store.put(booksTable,{...book,version:book.version+1000,monetaryRevision:book.monetaryRevision+500,recordedAt:new Date(base+tick+1).toISOString()},s,false);await f.service.store.finish(s);await f.identity.audit.append({realm:'TENANT',actorId:scope.ownerId,subjectId:scope.ownerId,action:'SYNTHETIC_OWNED_STRESS_SEED',outcome:'SUCCESS'},s);
   }finally{f.service.store.tracking.end(s);}
  });
  f.clock.value=base+tick+100;const seedMs=performance.now()-seedStart;await group.phase('large-seed',seedMs);const verifyStart=performance.now();assert.equal(await managementEvidenceMatches(f.database,(await managementHead(f.database))!),true);assert.equal(await f.database.db.collection('s09_liabilities_personal').countDocuments(),population);assert.equal(await f.database.db.collection('s09_events_personal').countDocuments(),population*10);assert.equal((await f.database.db.collection('s09_personal_journals').aggregate([{$unwind:'$lines'},{$count:'lines'}]).toArray())[0]?.['lines'],population*50);
  const totals=await f.database.client.withSession(s=>f.service.ledger.totals(scope,s,'2026-10-28','9999-12-31T23:59:59.999Z'));assert.deepEqual(totals,{assets:BigInt(population)*100000n,liabilities:BigInt(population)*109000n,equity:0n,income:0n,expense:BigInt(population)*9000n,cashAvailable:BigInt(population)*100000n});
  f.clock.open=true;await f.service.prepareOwned(f.owner);await f.service.activateOwned(f.owner);const projection=await ProjectionRuntime.createOwned(f.identity,f.keys.cursor,f.owner);f.identity.reporting!.projection=projection;await f.restore.flush();const verifyMs=performance.now()-verifyStart;await group.phase('large-verification',verifyMs);
  const samples:number[]=[],errors:string[]=[];for(let pair=0;pair<5;pair++)await Promise.all([0,1].map(async()=>{const start=performance.now();try{const result=await f.read('listPersonalLiabilities',{bookId:f.book.id},{asOf:'2026-10-28',limit:100});assert.equal((result.data as {items:unknown[]}).items.length,Math.min(population,100));samples.push(performance.now()-start);}catch(e){errors.push(e instanceof Error?e.message:String(e));}}));
  const business=await f.runtime.reporting!.read(f.a.issued.context,'getReportingDashboard',f.org,undefined,{asOf:'2026-10-28',from:'2026-10-01',to:'2026-10-28'});assert.equal(business.status,200);assert.equal(await f.database.db.collection('financial_journals').countDocuments({'source.type':'MANAGEMENT_OPERATION'}),0);
  const ordered=[...samples].sort((a,b)=>a-b),p50=ordered[Math.ceil(ordered.length*.5)-1]??null,p95=ordered[Math.ceil(ordered.length*.95)-1]??null,result={task:evidencePrefix,dimensions:{liabilities:population,events:population*10,journalLines:population*50,readers:2,page:100},seedMs,verifyMs,samples,errors,p50,p95,targetMs:2000,requestBudgetMs:10000,wallMs:performance.now()-wall,seedPolicy:'Owned offline fixture gate, signed original rows + real balanced Decimal128 journals, tracked atomic manifests, immutable history; full root/manifest verification before opening. No MFA weakening or production migration.'};await writeFile(resolve('../../Construccion/Sprints/S09/Evidencias/'+evidencePrefix+'-STRESS'+(preflight?'-PREFLIGHT':'')+'.json'),JSON.stringify(result,null,2)+'\n');console.log('S09_STRESS',JSON.stringify(result));assert.equal(errors.length,0);assert.equal(samples.length,10);assert.ok(p95!==null&&p95<=2000,'p95 exceeds unchanged 2s target');
 }finally{await group.dispose();}
});
