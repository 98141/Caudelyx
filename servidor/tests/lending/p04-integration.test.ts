/* eslint-disable security/detect-non-literal-fs-filename -- Exact registered P04 controls only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile, access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { BSON } from 'mongodb';
import { generate } from 'otplib';
import { lendingProfile, assertOwnUri, password } from './p04-profile.js';
import { purposes } from '../../src/modules/lending/contract.js';
import type { Terms } from '../../src/modules/lending/models.js';
import { ApiClient } from '../helpers/client.js';

const root=resolve('..'),evidence=resolve('../../Construccion/Sprints/S04/Evidencias');
type Group=Awaited<ReturnType<typeof lendingProfile>>;
type Fixture=Awaited<ReturnType<Group['fixture']>>;
const ownHeaders={Host:'localhost:47131',Origin:'https://localhost:47131'};
const economic=async(f:Fixture)=>{
  const hash=createHash('sha256');
  for(const name of ['financial_accounts','financial_books','financial_journals','financial_idempotency','financial_evidence_head','opening_files','opening_references','opening_validations','opening_idempotency']){
    hash.update(name);hash.update(BSON.EJSON.stringify(await f.database.db.collection(name).find().sort({_id:1}).toArray(),{relaxed:false}));
  }return hash.digest('hex');
};
async function setup(group:Group){
  const f=await group.fixture(),a=await f.actor();
  const payload={name:'Integración sintética P04',currency:'COP',timezone:'America/Bogota'};
  await f.proof(a,'ORGANIZATION_CREATE',payload);
  const org=(await f.runtime.organizations.create(a.issued.context,payload,randomUUID())).data.organization.id;
  const accountPayload={code:'CASH_P04',name:'Caja sintética P04',currency:'COP',accountClass:'ASSET',kind:'CASH'},key=randomUUID();
  await f.proof(a,'FINANCE_ACCOUNT_CREATE',{organizationId:org,idempotencyKey:key,payload:accountPayload});
  const account=((await f.runtime.finance.mutate(a.issued.context,'createAccount',org,accountPayload,key)).data as {id:string}).id;
  const mutate=async(op:string,body:Record<string,unknown>,id?:string,etag?:string)=>{
    const key=randomUUID(),purpose=purposes.get(op);
    if(purpose)await f.proof(a,purpose,{organizationId:org,idempotencyKey:key,payload:body,...(etag?{expectedETag:etag}:{})},id);
    return await f.runtime.lending.mutate(a.issued.context,op,org,body,key,id,etag);
  };
  const borrower=async(code:string)=>await mutate('createBorrower',{borrowerCode:code,profile:{displayName:'Persona sintética '+code,schemaVersion:1,extras:{}}});
  const terms=(borrowerId:string,delta:Partial<Terms>={}):Terms=>({borrowerId,plannedFundingAccountId:account,principal:'1000.00',effectiveDate:'2024-01-31',firstDueDate:'2024-02-29',installmentCount:3,method:'CONSTANT_PRINCIPAL',frequency:'MONTH',rate:{type:'EFFECTIVE',unit:'MONTH',value:'0.010000000000'},calendarConvention:'PERIODIC_FIXED',holidayAdjustment:'NO_SHIFT',policyVersion:'S04-LOCAL-CO-0.1',jurisdiction:'CO',usage:'LOCAL_SYNTHETIC',...delta});
  return{...f,a,org,account,mutate,borrower,terms};
}
async function ready(url:string,cert:Buffer){
  return await new Promise<boolean>(done=>{const req=request(url,{ca:cert,servername:'localhost',timeout:500},r=>{r.resume();r.once('end',()=>done(r.statusCode===200));});req.on('error',()=>done(false));req.on('timeout',()=>req.destroy());req.end();});
}
async function stop(child:ChildProcess,ipc?:string){
  if(child.exitCode!==null)return;
  const end=once(child,'exit');if(ipc&&child.connected)child.send(ipc);else child.kill();
  const timer=setTimeout(()=>child.kill(),15000);try{await end;}finally{clearTimeout(timer);}
}

test('P04 installed Mongo integration, browser and persistent launcher',{timeout:480000},async t=>{
  const group=await lendingProfile(),children:ChildProcess[]=[];
  const shutdown=async()=>{for(const child of children.splice(0).reverse())await stop(child,child.connected?'LOCAL_DEV_STOP':undefined);await group.dispose();};
  const signal=()=>{void shutdown().catch(()=>{process.exitCode=1;});};process.once('SIGINT',signal);process.once('SIGTERM',signal);
  try{
    await t.test('AT16: exact profile, lease denial, partial setup and programmatic cancellation',async()=>{
      for(const uri of ['mongodb://remote.invalid:27017','mongodb://127.0.0.1:27181','mongodb://127.0.0.1:27017/caudelyx_dev'])assert.throws(()=>assertOwnUri(uri));
      const release=group.hold();await assert.rejects(group.dispose(),/lease/);release();
      await assert.rejects(group.fixture({failSetup:true}),/partial setup/);
      const abort=new AbortController(),f=await group.fixture();
      await f.database.db.collection('p04_abort_marker').insertOne({synthetic:true});abort.abort();
      try{abort.signal.throwIfAborted();}catch{await group.closeConsumers();await group.receipt({event:'programmatic-cancellation-consumers-closed'});}
    });
    const f=await setup(group),server=await f.https();
    const before=await economic(f);
    await t.test('AT08/13/15: real HTTP catalogue rejection, tenant denial and financial invariance',async()=>{
      const client=server.client;client.cookies.set('__Host-caudelyx-session',f.a.issued.token);
      const csrf=await client.call('GET','/api/v1/auth/csrf',undefined,ownHeaders);assert.equal(csrf.status,200);client.csrf=csrf.body.data?.['csrfToken'] as string;
      const invalid=await client.call('POST',`/api/v1/organizations/${f.org}/borrower-field-schemas`,{fields:[]},{...ownHeaders,'If-Match':`"${f.org}:1"`,'Idempotency-Key':randomUUID()});
      assert.equal(invalid.status,422);assert.equal(invalid.body.error?.code,'INPUT_INVALID');
      const other=await f.actor();const foreign=new ApiClient(server.port,server.cert);foreign.cookies.set('__Host-caudelyx-session',other.issued.token);
      const denied=await foreign.call('GET',`/api/v1/organizations/${f.org}/loans`,undefined,ownHeaders);assert.ok([403,404].includes(denied.status));
      assert.equal(await economic(f),before);
    });
    await t.test('AT04/08/09/15: actual pagination data with immutable saved schedules and zero ledger',async()=>{
      for(let i=1;i<=21;i++){
        const b=(await f.borrower('P'+String(i).padStart(3,'0'))).data as {id:string};
        const q=(await f.mutate('createLoanQuote',{terms:f.terms(b.id)})).data as {id:string;fingerprint:string};
        await f.mutate('createLoanDraft',{quoteId:q.id,quoteFingerprint:q.fingerprint});
      }
      const page=(await f.runtime.lending.read(f.a.issued.context,'listLoans',f.org,undefined,{limit:20})).data as {items:unknown[];nextCursor:string};
      assert.equal(page.items.length,20);assert.ok(page.nextCursor);
      const next=(await f.runtime.lending.read(f.a.issued.context,'listLoans',f.org,undefined,{limit:20,cursor:page.nextCursor})).data as {items:unknown[]};assert.equal(next.items.length,1);
      assert.equal(await economic(f),before);
    });
    const controlToken=randomBytes(24).toString('hex');let finalSession=f.a.issued.token,finalLoan='';
    const control=createServer((req,res)=>{
      if(req.headers['x-p04-owner']!==controlToken){res.writeHead(403).end();return;}
      const run=async()=>{
        if(req.url==='/session'){res.end(JSON.stringify({token:f.a.issued.token,org:f.org,account:f.account,password}));return;}
        if(req.url==='/tick'){f.clock.value+=30000;res.end(JSON.stringify({code:await generate({secret:f.a.secret,epoch:Math.floor(f.now()/1000)})}));return;}
        if(req.url==='/complete'){
          const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk as Uint8Array));
          const body=JSON.parse(Buffer.concat(chunks).toString()) as {token:string;loan:string};finalSession=body.token;finalLoan=body.loan;
          const stored=await f.database.db.collection('lending_loans').findOne({_id:finalLoan} as never);
          assert.equal(stored?.['termsVersion'],2);assert.equal(stored?.['status'],'TERMS_CONFIRMED');
          assert.equal(await economic(f),before);
          await f.restore.flush();
          await group.receipt({event:'browser-economic-invariance',sha256:before,termsVersion:2,status:'TERMS_CONFIRMED'});
          res.end(JSON.stringify({ok:true}));return;
        }
        res.writeHead(404).end();
      };
      void run().catch(()=>res.writeHead(500).end(JSON.stringify({error:'P04_CONTROL_ASSERTION'})));
    });
    await group.receipt({event:'control-reserved-before-listen',host:'127.0.0.1',port:0,ownerPid:process.pid});
    control.listen(0,'127.0.0.1');await once(control,'listening');const address=control.address();assert.ok(address&&typeof address!=='string');
    await group.receipt({event:'control-created',port:address.port,ownerPid:process.pid});
    const env={...process.env,CAUDELYX_MODE:'local-synthetic',CAUDELYX_DEV_TEST_ID:'5a6d7b4091824bc6a5e3f014',MONGODB_URI:group.uri,MONGODB_DATABASE:group.names[0],CAUDELYX_DEV_UI_PORT:'47131',CAUDELYX_DEV_API_PORT:'47132',CAUDELYX_DEV_PLATFORM_PORT:'47133',CAUDELYX_DEV_TLS_DIRECTORY:join(group.folder,'tls')};
    try{
      const vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','localhost','--port','47131','--strictPort'],{cwd:join(root,'cliente'),env,windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(vite);
      await group.receipt({event:'own-vite-created',pid:vite.pid,port:47131});
      const deadline=Date.now()+20000;while(!await ready('https://localhost:47131',server.cert)){if(Date.now()>deadline||vite.exitCode!==null)throw Error('Own Vite readiness failure');await new Promise(r=>setTimeout(r,200));}
      await t.test('AT01-12/15/17: integrated browser lifecycle, pagination, calendars, histories and accessibility',async()=>{
        const browser=spawn(process.execPath,['node_modules/@playwright/test/cli.js','test','--config','tests/integration/p04.config.ts'],{cwd:join(root,'cliente'),windowsHide:true,env:{...env,P04_URL:'https://localhost:47131',P04_CONTROL:`http://127.0.0.1:${address.port}`,P04_OWNER:controlToken,P04_OUTPUT:group.folder,P04_VISUAL:join(evidence,'S04-P04-VISUAL.png')},stdio:['ignore','pipe','pipe']});
        children.push(browser);browser.stdout?.on('data',b=>process.stdout.write(b));browser.stderr?.on('data',b=>process.stderr.write(b));
        await group.receipt({event:'own-browser-runner-created',pid:browser.pid});
        const [code]=await once(browser,'exit');assert.equal(code,0);assert.ok(finalLoan);
      });
    }finally{for(const child of children.splice(0).reverse())await stop(child);await new Promise<void>(r=>control.close(()=>r()));await f.restore.flush();await group.closeConsumers();}
    await t.test('AT16: npm run dev actual HTTPS smoke followed by native persistence restart',{skip:!finalLoan},async()=>{
      const smoke=spawn(process.execPath,[join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),'run','dev'],{cwd:root,env:{...env,CAUDELYX_DEV_SMOKE:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(smoke);
      let smokeOutput='';smoke.stdout?.on('data',b=>{smokeOutput+=String(b);});smoke.stderr?.on('data',b=>{smokeOutput+=String(b);});
      await group.receipt({event:'npm-run-dev-created',pid:smoke.pid,ports:[47131,47132,47133]});
      const [code]=await once(smoke,'exit');assert.equal(code,0,smokeOutput.slice(-500));assert.match(smokeOutput,/S02 LOCAL SINTÉTICO/);
      await group.receipt({event:'npm-run-dev-https-ready-and-exited',pid:smoke.pid,exitCode:code});
      const native=spawn(process.execPath,['scripts/dev.mjs'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});children.push(native);
      await group.receipt({event:'native-persistence-created',pid:native.pid});
      let output='',nativeReady=false;native.on('message',m=>{if(m==='S02_INSTALLED_READY')nativeReady=true;});native.stdout?.on('data',b=>{output+=String(b);});native.stderr?.on('data',b=>{output+=String(b);});
      const deadline=Date.now()+45000;while(!nativeReady){if(Date.now()>deadline||native.exitCode!==null)throw Error('Own native startup failure '+output.slice(-500));await new Promise(r=>setTimeout(r,200));}
      const client=new ApiClient(47132,await readFile(join(group.folder,'tls/cert.pem')));client.cookies.set('__Host-caudelyx-session',finalSession);
      const read=await client.call('GET',`/api/v1/organizations/${f.org}/loans/${finalLoan}`,undefined,ownHeaders);
      assert.equal(read.status,200);assert.equal(read.body.data?.['termsVersion'],2);assert.equal(read.body.data?.['status'],'TERMS_CONFIRMED');
      await stop(native,'LOCAL_DEV_STOP');await group.receipt({event:'native-persistence-verified-and-stopped',pid:native.pid,termsVersion:2});
      await assert.rejects(access(join(group.folder,'runner.lock')));
    });
  }finally{process.removeListener('SIGINT',signal);process.removeListener('SIGTERM',signal);await shutdown();}
});
