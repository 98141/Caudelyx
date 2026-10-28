import {test} from 'node:test';
import assert from 'node:assert/strict';
import {s08Profile} from './profile.js';
import {benchmarkFixture} from './fixture.js';
import {evidenceMetrics} from '../../src/modules/lending/evidence-v2.js';
import type {Data} from '../../src/modules/reporting/models.js';
import {Session} from 'node:inspector/promises';
import {writeFile} from 'node:fs/promises';
const cpuProfile=process.env['S08_P02_CPU_PROFILE']==='1';
const diagnostic=cpuProfile||process.env['S08_P02_DIAGNOSTIC']==='1';
test(diagnostic?'S08 DIAGNOSTIC CPU100loans/1kevents/5klines not AP8 acceptance':'S08 measured successful HTTPS1k loans/10k events/50k journal lines and2readers',{timeout:1800000},async()=>{
 const profiler=cpuProfile?new Session():null;
 let profiling=false;
 const group=await s08Profile();try{
  const start=performance.now(),f=await benchmarkFixture(group,diagnostic?100:1000),setupMs=performance.now()-start,web=await f.https();web.client.cookies.set('__Host-caudelyx-session',f.a.issued.token);
  if(profiler){profiler.connect();await profiler.post('Profiler.enable');await profiler.post('Profiler.start');profiling=true;}
  const path='/api/v1/organizations/'+f.org+'/reporting/dashboard?from=2026-10-01&to=2027-07-31&asOf=2027-07-31',latencies:number[]=[],bytes:number[]=[];
  evidenceMetrics.captureOrganizations=true;evidenceMetrics.hashCalls=0;evidenceMetrics.hashBytes=0;evidenceMetrics.documentReads=0;evidenceMetrics.indexNodesRead=0;
  const call=async()=>{const before=performance.now(),r=await web.client.call('GET',path);const ms=performance.now()-before;process.stdout.write('BENCHMARK_REQUEST '+JSON.stringify({status:r.status,ms,code:r.body.error?.code,evidence:{documentReads:evidenceMetrics.documentReads,indexNodesRead:evidenceMetrics.indexNodesRead,hashCalls:evidenceMetrics.hashCalls,hashBytes:evidenceMetrics.hashBytes}})+'\n');assert.equal(r.status,200,JSON.stringify(r.body));const metrics=r.body.data!['organizationMetrics'] as Data[];assert.equal(metrics.find(x=>x['id']==='PRINCIPAL_OUTSTANDING')?.['value'],f.expected.principal);assert.equal(metrics.find(x=>x['id']==='INTEREST_ACCRUED')?.['value'],f.expected.interestAccrued);latencies.push(ms);bytes.push(Buffer.byteLength(JSON.stringify(r.body)));return r;};
  await call();const coldMs=latencies.pop()!;
  for(let i=0;i<5;i++)await Promise.all([call(),call()]);
  const sorted=[...latencies].sort((a,b)=>a-b),p50=sorted[Math.ceil(sorted.length*.5)-1]!,p95=sorted[Math.ceil(sorted.length*.95)-1]!;
  const final=await call(),token=String((final.body.data!['meta'] as Data)['snapshotToken']);const page=await web.client.call('GET','/api/v1/organizations/'+f.org+'/reporting/reports/PORTFOLIO?snapshotToken='+encodeURIComponent(token)+'&limit=100');assert.equal(page.status,200);assert.equal((page.body.data!['items'] as unknown[]).length,100);
  const explained=await f.database.db.collection('loan_events').find({organizationId:f.org}).hint('reporting_event_cut').explain('executionStats');
  const financialExplain=await f.database.db.collection('financial_journals').find({organizationId:f.org}).hint('reporting_financial_scope').sort({_id:1}).explain('executionStats');
  process.stdout.write('BENCHMARK_METRICS '+JSON.stringify({counts:f.benchmarkCounts,setupMs,coldMs,successfulRequests:latencies.length+1,concurrency:2,pageSize:100,percentileSampleCount:sorted.length,p50Ms:p50,p95Ms:p95,latenciesMs:latencies,bytes,evidence:{documentReads:evidenceMetrics.documentReads,indexNodesRead:evidenceMetrics.indexNodesRead,hashCalls:evidenceMetrics.hashCalls,hashBytes:evidenceMetrics.hashBytes},explain:explained['executionStats'],financialExplain:financialExplain['executionStats'],node:process.version,platform:process.platform,memoryUsage:process.memoryUsage()})+'\n');
  if(diagnostic){const table=f.database.db.collection<{_id:string;organizationId:string;principalOutstanding:string}>('loan_positions'),original=await table.findOne({organizationId:f.org});assert.ok(original);try{await table.updateOne({_id:original!._id},{$set:{principalOutstanding:'1.00'}});const bad=await web.client.call('GET',path);assert.equal(bad.status,503);assert.equal(bad.body.error?.code,'INTEGRITY_MISMATCH');assert.equal((await table.findOne({_id:original!._id}))!['principalOutstanding'],'1.00');}finally{await table.replaceOne({_id:original!._id},original!);}process.stdout.write('RANGE_TAMPER_CHECK PASS without GET repair\n');}
  evidenceMetrics.captureOrganizations=false;if(!diagnostic)assert.ok(p95<=2000,'AP8 p95 target missed: '+p95.toFixed(1)+'ms');
 }finally{try{if(profiler&&profiling){const {profile}=await profiler.post('Profiler.stop');await writeFile('../../Construccion/Sprints/S08/Evidencias/S08-P02-CPU-PROFILE-02.json',JSON.stringify(profile));}}finally{if(profiling)profiler?.disconnect();evidenceMetrics.captureOrganizations=false;await group.dispose();}}
});
