import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {readFile,writeFile,rename,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,dirname,resolve} from 'node:path';
import {createServer} from 'node:net';
import {request} from 'node:https';
import {setTimeout as delay} from 'node:timers/promises';
import {MongoClient} from 'mongodb';
import {loadConfig} from '../../src/shared/config.js';
type Event={event:string;stage:string;status:string;code?:string;observedMs?:number};
type Control={_id:string;phase?:string;expiresAt?:number;deploymentId?:string};
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

test('first boot resumes two actual interruptions, refuses early READY on bind failure, then restarts',{timeout:420000},async t=>{
  const config=loadConfig(process.env),keyring=process.env['KEYRING_FILE']!,control=dirname(keyring),resourceFile=process.env['F06_BOOT_RESOURCE_FILE']!;
  const api=Number(process.env['PORT']),platform=Number(process.env['PLATFORM_PORT']);
  const client=new MongoClient(config.mongoUri,config.mongoOptions);await client.connect();
  const db=client.db(config.databaseName),controls=db.collection<Control>('demo_runtime_control');
  const originalKey=sha(await readFile(keyring)),children:{child:ChildProcess;closed:Promise<unknown>;events:Event[]}[]=[];
  const start=async(label:string,interrupt?:string)=>{
    const resources=JSON.parse(await readFile(resourceFile,'utf8')) as {runId:string;apiProcesses?:unknown[]};
    resources.apiProcesses??=[];const row={label,command:'.runtime/f06-boot-build/src/server.js',ports:[api,platform],pid:0};resources.apiProcesses.push(row);
    await writeFile(resourceFile,JSON.stringify(resources,null,2)+'\n');
    const env={...process.env};delete env['NODE_TEST_CONTEXT'];
    const child=spawn(process.execPath,['--title=F06_BOOT_'+resources.runId,'.runtime/f06-boot-build/src/server.js'],{cwd:process.cwd(),env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
    const started=performance.now();
    const events:Event[]=[],closed=once(child,'close');children.push({child,closed,events});let buffer='',interrupted=false;
    child.stdout?.resume();
    child.stderr!.on('data',(bytes:Buffer)=>{
      buffer+=bytes.toString('utf8');let end;
      while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
        try{const value=JSON.parse(line) as Event;if(value.event==='CAUDELYX_BOOT'){
          events.push({...value,observedMs:performance.now()-started});
          if(interrupt&&value.stage===interrupt&&value.status==='START'&&!interrupted){interrupted=true;child.kill('SIGKILL');}
        }}catch{/* Fixed generic final line is not a structured event. */}
      }
    });
    row.pid=child.pid!;await writeFile(resourceFile,JSON.stringify(resources,null,2)+'\n');
    return{child,closed,events};
  };
  type Running=Awaited<ReturnType<typeof start>>;
  const waitExit=async(s:Running)=>{
    const timer=setTimeout(()=>s.child.kill('SIGKILL'),90000);
    try{return await s.closed;}finally{clearTimeout(timer);}
  };
  const waitReady=async(s:Running)=>{
    const until=Date.now()+75000;
    while(Date.now()<until){
      if(s.events.some(e=>e.stage==='COMPLETE'&&e.status==='OK'))return;
      if(s.child.exitCode!==null||s.child.signalCode!==null){const fail=s.events.find(e=>e.status==='FAIL');throw Error('BOOT_REJECTED:'+fail?.stage+':'+fail?.code);}
      await delay(100);
    }
    throw Error('BOOT_COMPLETION_TIMEOUT');
  };
  const stop=async(s:Running)=>{s.child.send('LOCAL_SYNTHETIC_SHUTDOWN');await waitExit(s);assert.equal(s.child.exitCode,0);};
  const waitLease=async()=>{
    const lease=await controls.findOne({_id:'lease'});assert.ok(lease?.expiresAt);
    assert.ok(lease.expiresAt-Date.now()<31000,'Do not alter the real lease duration');
    while(Date.now()<=lease.expiresAt+50)await delay(250);
  };
  const privateCut=async()=>({keys:sha(await readFile(keyring)),gate:sha(await readFile(join(control,'gate.json'))),journal:sha(await readFile(join(control,'gate.json.journal.jsonl')))});
  const ca=await readFile(join(control,'../tls/api/ca.pem'));
  const health=()=>new Promise<number>((resolveHealth,reject)=>{
    const req=request({hostname:'127.0.0.1',port:api,servername:'localhost',ca,path:'/internal/health/ready'},res=>{res.resume();res.once('end',()=>resolveHealth(res.statusCode??0));});req.on('error',reject);req.setTimeout(3000,()=>req.destroy(Error('HEALTH_TIMEOUT')));req.end();
  });
  let occupied:ReturnType<typeof createServer>|undefined;
  const check=async(name:string,work:()=>Promise<void>)=>{
    let failed=false;await t.test(name,async()=>{try{await work();}catch(error){failed=true;throw error;}});
    if(failed)throw Error('FOCUSED_BOOT_SUBCASE_FAILED');
  };
  try{
    let firstCut:Awaited<ReturnType<typeof privateCut>>|undefined;
    if(process.env['F06_BOOT_RESTART_ONLY']!=='1'){
    await check('abrupt interruption after runtime initialization retains genuine INITIALIZING controls',async()=>{
      const s=await start('interrupt-before-management','MODULE_MANAGEMENT_PREPARE');await waitExit(s);
      assert.ok(s.events.some(e=>e.stage==='MODULE_MANAGEMENT_PREPARE'&&e.status==='START'));
      assert.equal((await controls.findOne({_id:'identity'}))?.phase,'INITIALIZING');
      assert.equal((await readFile(join(control,'gate.json.journal.jsonl'))).length,0);
      const counts={main:(await db.listCollections().toArray()).length,mail:(await client.db(config.databaseName+'_external_mail').listCollections().toArray()).length,security:(await client.db(config.databaseName+'_external_security').listCollections().toArray()).length};
      console.log('interrupted-before-management collection counts',JSON.stringify(counts));
      assert.equal(counts.mail,0);assert.equal(counts.security,2);assert.equal(sha(await readFile(keyring)),originalKey);
      const deadline=await controls.findOne({_id:'lease'});assert.ok(deadline?.expiresAt);
    });
    firstCut=await privateCut();await waitLease();
    await check('partial protected catalog can be prepared again before observing',async()=>{
      const s=await start('interrupt-before-reporting','MODULE_REPORTING_ACTIVATE');await waitExit(s);
      assert.ok(s.events.some(e=>e.stage==='MODULE_CORE_PREPARE'&&e.status==='OK'));
      assert.equal((await controls.findOne({_id:'identity'}))?.phase,'INITIALIZING');assert.deepEqual(await privateCut(),firstCut);
    });
    await waitLease();
    }
    await check('platform bind failure is diagnosed and must not mark READY',async()=>{
      occupied=createServer().listen(platform,'127.0.0.1');await once(occupied,'listening');
      try{
        const s=await start('platform-port-occupied');await waitExit(s);
        assert.equal(s.child.exitCode,1);assert.ok(s.events.some(e=>e.stage==='PLATFORM_LISTEN'&&e.status==='FAIL'&&e.code==='EADDRINUSE'));
        assert.equal((await controls.findOne({_id:'identity'}))?.phase,'INITIALIZING');firstCut??=await privateCut();assert.deepEqual(await privateCut(),firstCut);
        assert.equal((await controls.findOne({_id:'lease'}))?.expiresAt,0);
      }finally{await new Promise<void>(r=>occupied!.close(()=>r()));occupied=undefined;}
    });
    await check('legitimate resumed boot reaches READY only after both listeners',async()=>{
      const s=await start('resumed-first-complete');await waitReady(s);assert.equal(await health(),200);
      assert.equal((await controls.findOne({_id:'identity'}))?.phase,'READY');
      const ready=s.events.findIndex(e=>e.stage==='READY'&&e.status==='OK');assert.ok(ready>s.events.findIndex(e=>e.stage==='PLATFORM_LISTEN'&&e.status==='OK'));
      await stop(s);assert.deepEqual(await privateCut(),firstCut);
    });
    await check('normal restart preserves files and existing deployment identity',async()=>{
      const identity=await controls.findOne({_id:'identity'}),s=await start('warm-restart');await waitReady(s);assert.equal(await health(),200);await stop(s);
      assert.deepEqual(await controls.findOne({_id:'identity'}),identity);assert.deepEqual(await privateCut(),firstCut);assert.equal(await db.collection('financial_journals').countDocuments(),0);
    });
    await check('missing existing journal fails closed without generating replacement',async()=>{
      const journal=join(control,'gate.json.journal.jsonl'),held=join(control,'journal.f06-held');
      assert.equal(dirname(resolve(held)),resolve(control));await rename(journal,held);
      try{const s=await start('missing-existing-journal');await waitExit(s);assert.equal(s.child.exitCode,1);assert.ok(s.events.some(e=>e.stage==='DEMO_IDENTITY'&&e.status==='FAIL'&&e.code==='ENOENT'));await assert.rejects(lstat(journal),/ENOENT/);}
      finally{await rename(held,journal);}
      assert.deepEqual(await privateCut(),firstCut);
    });
  }finally{
    await new Promise<void>(r=>{if(occupied)occupied.close(()=>r());else r();});
    for(const s of children){if(s.child.exitCode===null&&s.child.signalCode===null)s.child.kill('SIGKILL');await s.closed;}
    const resources=JSON.parse(await readFile(resourceFile,'utf8')) as Record<string,unknown>;
    resources['apiCleanup']=children.map(s=>({pid:s.child.pid,closed:true,exitCode:s.child.exitCode,signal:s.child.signalCode,events:s.events}));
    await writeFile(resourceFile,JSON.stringify(resources,null,2)+'\n');
    await client.close();
  }
});
