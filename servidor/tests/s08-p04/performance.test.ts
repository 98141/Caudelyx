import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {s08Profile} from './profile.js';
import {benchmarkFixture} from '../s08/fixture.js';
import {ProjectionRuntime} from '../../src/modules/reporting/projection/service.js';
import type {Data} from '../../src/modules/reporting/models.js';

test('AP8 complete projected HTTPS1k/10k/50k,2readers,page100',{timeout:900000},async()=>{
  const group=await s08Profile();let projection:ProjectionRuntime|undefined;const release=group.hold();
  try{
    const setup=performance.now(),f=await benchmarkFixture(group),setupMs=performance.now()-setup;
    const init=performance.now();projection=await ProjectionRuntime.createOwned(f.identity,f.keys.cursor,async()=>{
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Exact live owned fixture control path, checked by the harness.
      const owner=JSON.parse(await readFile(join(group.folder,'owner.json'),'utf8'));
      return owner.runId===group.runId&&owner.pid===process.pid&&owner.names[0]===f.database.db.databaseName;
    });
    f.identity.reporting!.projection=projection;
    const projectionInitializationMs=performance.now()-init,web=await f.https();web.client.cookies.set('__Host-caudelyx-session',f.a.issued.token);
    process.stdout.write('PROJECTED_BENCHMARK_READY '+JSON.stringify({setupMs,projectionInitializationMs})+'\n');
    const base='/api/v1/organizations/'+f.org+'/reporting',query='?from=2026-10-01&to=2027-07-31&asOf=2027-07-31';
    const latencies:number[]=[],statuses:number[]=[];
    const call=async()=>{
      const start=performance.now(),r=await web.client.call('GET',base+'/dashboard'+query),ms=performance.now()-start;
      statuses.push(r.status);process.stdout.write('PROJECTED_BENCHMARK_REQUEST '+JSON.stringify({ms,status:r.status,code:r.body.error?.code})+'\n');
      if(r.status!==200){
        const observer=Reflect.get(projection!,'observer') as {ready:boolean;failureReason:string|null;failureDetail:string|null};
        process.stdout.write('PROJECTED_OBSERVER_DIAGNOSTIC '+JSON.stringify({ready:observer.ready,reason:observer.failureReason,detail:observer.failureDetail})+'\n');
        try{await f.identity.reporting!.read(f.a.issued.context,'getReportingDashboard',f.org,undefined,{from:'2026-10-01',to:'2027-07-31',asOf:'2027-07-31'});}
        catch(error){process.stdout.write('PROJECTED_READ_FAILURE '+(error instanceof Error?error.stack:String(error))+'\n');}
      }
      assert.equal(r.status,200,JSON.stringify(r.body));
      const metrics=r.body.data!['organizationMetrics'] as Data[];
      assert.equal(metrics.find(x=>x['id']==='PRINCIPAL_OUTSTANDING')?.['value'],f.expected.principal);
      assert.equal(metrics.find(x=>x['id']==='INTEREST_ACCRUED')?.['value'],f.expected.interestAccrued);
      latencies.push(ms);return r;
    };
    const cold=await call(),coldMs=latencies.pop();
    for(let i=0;i<5;i++)await Promise.all([call(),call()]);
    const sorted=[...latencies].sort((a,b)=>a-b),p50=sorted[Math.ceil(sorted.length*.5)-1]!,p95=sorted[Math.ceil(sorted.length*.95)-1]!;
    const token=encodeURIComponent(String((cold.body.data!['meta'] as Data)['snapshotToken']));
    const page=await web.client.call('GET',base+'/reports/PORTFOLIO?snapshotToken='+token+'&limit=100');assert.equal(page.status,200,JSON.stringify(page.body));assert.equal((page.body.data!['items'] as unknown[]).length,100);
    process.stdout.write('PROJECTED_BENCHMARK_METRICS '+JSON.stringify({counts:f.benchmarkCounts,setupMs,projectionInitializationMs,coldMs,statuses,successfulSampleCount:sorted.length,concurrency:2,pageSize:100,p50Ms:p50,p95Ms:p95,latenciesMs:latencies,memory:process.memoryUsage(),backgroundEnabled:true,node:process.version})+'\n');
    assert.ok(p95<=2000,'AP8 p95 target missed: '+p95.toFixed(1));
  }finally{await projection?.stop();release();await group.dispose();}
});
