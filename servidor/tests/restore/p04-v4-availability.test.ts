/* eslint-disable security/detect-non-literal-fs-filename -- Exact controller-owned fixture paths, never HTTP input. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { BSON, type Document } from 'mongodb';
import { fixture, totpActor } from '../helpers/fixture.js';
import { RestoreController } from '../../src/shared/restore.js';

test('v4 locked open gate: retry watermark without reopening; joint Mongo rollback while watermark pending still closes at restart', { timeout: 120000 }, async () => {
  const f = await fixture({ controlledRestore: true });
  try {
    const r = f.restore; assert.ok(r);
    const snapshot = await r.snapshot();
    const external = f.database.client.db(`${f.database.db.databaseName}_external_security`);
    const oldEvents = await external.collection('events').find({}).toArray();
    const oldHead = await external.collection('head').findOne({ _id: 'security' } as Document); assert.ok(oldHead);
    const gateBefore = await readFile(r.gatePath);
    const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$f=[IO.File]::Open('${r.gatePath.replaceAll("'", "''")}','Open','Read','Read'); Write-Output HELD; Start-Sleep -Seconds 3; $f.Close()`],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const exited = once(holder, 'exit');
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Windows gate holder not ready')), 15000);
        holder.once('error', error => { clearTimeout(timeout); reject(error); });
        holder.stdout.on('data', bytes => { if (String(bytes).includes('HELD')) { clearTimeout(timeout); resolve(); } });
      });
      await totpActor(f);
      await r.flush();
      assert.equal(r.pendingWatermark, true);
      assert.equal(r.isOpen(), true);
      assert.deepEqual(await readFile(r.gatePath), gateBefore, 'authentic old gate retained exactly');
      const leftovers = (await readdir(dirname(r.gatePath))).filter(p => p.startsWith(basename(r.gatePath) + '.') && p.endsWith('.tmp'));
      assert.equal(leftovers.length, 0, 'own uncommitted temp file removed');
    } finally { await exited; }

    // Simulate a provider restoring BOTH Mongo databases, without changing the
    // external file. The gate still carries the older watermark in this window.
    await f.database.client.withSession(session => session.withTransaction(async () => {
      for (const [name, encoded] of Object.entries(snapshot.collections)) {
        await f.database.db.collection(name).deleteMany({}, { session });
        const docs = BSON.EJSON.parse(encoded) as Document[];
        if (docs.length) await f.database.db.collection(name).insertMany(docs, { session });
      }
      await external.collection('events').deleteMany({}, { session });
      if (oldEvents.length) await external.collection('events').insertMany(oldEvents, { session });
      await external.collection('head').replaceOne({ _id: oldHead._id }, oldHead, { session });
    }));
    const cold = new RestoreController(f.database, r.gatePath, r.key);
    await cold.initialize();
    assert.equal(cold.isOpen(), false, 'pending watermark cannot hide joint Mongo rollback');
    await assert.rejects(cold.reconcile({ approved: true, reviewId: 'SYNTHETIC-ROLLBACK-MUST-NOT-OPEN' }));
  } finally { await f.close(); }
});

test('v4 two separate Node server processes share a >64KiB signed journal: password logins and strong-session probes remain available during both dispatchers', {timeout:180000},async()=>{
 const {randomBytes,randomUUID}=await import('node:crypto');
 const {createServer:createProbe}=await import('node:net');
 const {readFile,writeFile,mkdir,stat,unlink}=await import('node:fs/promises');
 const {resolve}=await import('node:path');
 const {captureSecurityState}=await import('../../src/shared/evidence.js');
 const {testCertificate}=await import('../helpers/tls.js'),{ApiClient}=await import('../helpers/client.js');
 const f=await fixture({controlledRestore:true}),children:import('node:child_process').ChildProcess[]=[];
 const runtime=resolve('.runtime'),keyPath=resolve(runtime,`v4-process-${randomUUID()}.keys.json`);
 const keyFile=resolve(runtime,'tls/key.pem'),certFile=resolve(runtime,'tls/cert.pem');
 let previousKey:Buffer|null=null,previousCert:Buffer|null=null,changedKey=false,changedCert=false,keyringWritten=false;
 let stopProbe=false,prober:Promise<void>|undefined;
 const stopChild=async(child:import('node:child_process').ChildProcess)=>{
  if(!child.pid||child.exitCode!==null)return;const exited=once(child,'exit');
  if(child.connected)child.send?.('LOCAL_SYNTHETIC_SHUTDOWN',error=>{if(error)child.kill();});else child.kill();
  const timeout=setTimeout(()=>child.kill(),15000);try{await exited;}finally{clearTimeout(timeout);}
 };
 try{
  const optionalRead=async(file:string)=>{try{return await readFile(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}};
  previousKey=await optionalRead(keyFile);previousCert=await optionalRead(certFile);
  const r=f.restore;assert.ok(r);const actor=await totpActor(f);await r.flush();
  // Explicit synthetic full-state checkpoints for volume/legacy compatibility;
  // not claimed as normal user traffic, and never fabricated acceptance evidence.
  const state=await f.database.transaction(session=>captureSecurityState(f.database,session));
  let sequence=(await f.database.db.collection<{_id:string;value:number}>('security_sequence').findOne({_id:'security'}))?.value??0;
  const first=sequence,count=Math.ceil(128*1024/Buffer.byteLength(JSON.stringify(state)))+1;
  await f.database.transaction(async session=>{
   const rows=Array.from({length:count},()=>({_id:++sequence,eventId:randomUUID(),state}));
   await f.database.db.collection<{_id:number;eventId:string;state:typeof state}>('security_evidence_outbox').insertMany(rows,{session});
   await f.database.db.collection('audit_events').insertMany(rows.map(row=>({eventId:row.eventId,sequence:row._id,realm:'TENANT',action:'SYNTHETIC_PROCESS_CHECKPOINT',subjectId:actor.issued.context.subjectId,actorId:actor.issued.context.subjectId,outcome:'SUCCESS',createdAt:new Date()})),{session});
   await f.database.db.collection<{_id:string;value:number}>('security_sequence').updateOne({_id:'security'},{$set:{value:sequence}},{session});
  });
  await r.flush();const journalBytesBefore=(await stat(r.fileJournal.path)).size;assert.ok(journalBytesBefore>64*1024);
  const tls=await testCertificate();await mkdir(resolve(runtime,'tls'),{recursive:true});
  changedKey=true;await writeFile(keyFile,tls.key);changedCert=true;await writeFile(certFile,tls.cert);
  await writeFile(keyPath,JSON.stringify({version:1,mail:f.mailKey.toString('base64url'),totp:f.totpKey.toString('base64url'),journal:r.key.toString('base64url'),cursor:randomBytes(32).toString('base64url')}),{flag:'wx',mode:0o600});
  keyringWritten=true;
  const port=async()=>{const probe=createProbe().listen(0,'127.0.0.1');await once(probe,'listening');const address=probe.address();assert.ok(address&&typeof address!=='string');const value=address.port;await new Promise<void>(done=>probe.close(()=>done()));return value;};
  const [api1,api2,platform1,platform2]=[await port(),await port(),await port(),await port()] as const;
  assert.equal(new Set([api1,api2,platform1,platform2]).size,4);
  class HostedClient extends ApiClient{
   override async call(method:string,route:string,body?:unknown,headers:Record<string,string>={}){return await super.call(method,route,body,{Host:`localhost:${api1}`,Origin:`https://localhost:${api1}`,...headers});}
  }
  let dispatchErrors=0;
  for(const [api,platform]of [[api1,platform1],[api2,platform2]] as const){
   const env={...process.env,CAUDELYX_MODE:'local-synthetic',MONGODB_URI:f.uri,MONGODB_DATABASE:f.database.db.databaseName,PORT:String(api),TENANT_ORIGIN:`https://localhost:${api1}`,PLATFORM_ORIGIN:`https://platform.localhost:${platform}`,KEYRING_FILE:keyPath};
   const child=spawn(process.execPath,['dist/src/server.js'],{env,windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});children.push(child);
   let startupError:Error|undefined;child.once('error',error=>{startupError=error;});
   child.stderr?.on('data',bytes=>{if(String(bytes).includes('SYNTHETIC_DISPATCH_RETRY_PENDING'))dispatchErrors++;});
   const ready=new HostedClient(api,tls.cert);let online=false;
   for(let n=0;n<150&&!online;n++){if(startupError)throw startupError;if(child.exitCode!==null)throw new Error('Own server process exited before readiness');try{await ready.refreshCsrf();online=true;}catch{await new Promise<void>(done=>setTimeout(done,100));}}
   assert.equal(online,true,'real Node server ready');
  }
  assert.ok(children[0]?.pid!==children[1]?.pid);
  const probes=[new HostedClient(api1,tls.cert),new HostedClient(api2,tls.cert)];
  for(const c of probes)c.cookies.set('__Host-caudelyx-session',actor.issued.token);
  const probeStatuses:number[]=[],loginStatuses:number[]=[],profileStatuses:number[]=[];
  prober=(async()=>{let n=0;while(!stopProbe){const c=probes[n++%2]!;probeStatuses.push((await c.call('GET','/api/v1/auth/me')).status);await new Promise<void>(done=>setTimeout(done,25));}})();
  for(let n=0;n<24;n++){
   const c=new HostedClient(n%2?api2:api1,tls.cert);await c.refreshCsrf();
   const response=await c.call('POST','/api/v1/auth/login',{email:f.email,password:f.password});loginStatuses.push(response.status);
   if(response.status===200){await c.refreshCsrf();profileStatuses.push((await c.call('GET','/api/v1/auth/me')).status);}
  }
  await new Promise<void>(done=>setTimeout(done,1500));stopProbe=true;await prober;
  console.log(JSON.stringify({evidence:'v4-real-processes',nodePids:children.map(c=>c.pid),journalBytesBefore,syntheticLegacyCheckpoints:sequence-first,loginStatuses,profileStatuses,probes:probeStatuses.length,probeNon200:probeStatuses.filter(s=>s!==200).length,dispatchErrors}));
  assert.ok(loginStatuses.every(s=>s===200));assert.equal(profileStatuses.length,24);assert.ok(profileStatuses.every(s=>s===200));
  assert.ok(probeStatuses.length>0);assert.ok(probeStatuses.every(s=>s===200));assert.equal(dispatchErrors,0);
 }finally{
  stopProbe=true;await prober?.catch(()=>undefined);for(const child of children)await stopChild(child);
  await f.close();
  for(const [file,previous,changed]of [[keyFile,previousKey,changedKey],[certFile,previousCert,changedCert]]as const){if(!changed)continue;if(previous)await writeFile(file,previous);else await unlink(file).catch(()=>undefined);}
  const r=f.restore;
  for(const file of [...(keyringWritten?[keyPath]:[]),...(r?[r.gatePath,r.fileJournal.path,r.fileJournal.path+'.receipts.json',r.fileJournal.path+'.lock']:[])]){
   assert.equal(dirname(file),runtime);await unlink(file).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});
  }
 }
});

test('v4 ordinary peer refresh never makes forged or truncated external evidence available', { timeout: 120000 }, async () => {
  const f = await fixture({ controlledRestore: true });
  try {
    const r = f.restore; assert.ok(r); await r.flush();
    const peer = new RestoreController(f.database, r.gatePath, r.key); await peer.initialize();
    await totpActor(f); await r.flush();
    assert.equal(await f.identity.isRealmOpen('TENANT'), true);
    const { writeFile } = await import('node:fs/promises');
    const good = await readFile(r.fileJournal.path);
    await writeFile(r.fileJournal.path, good.subarray(0, good.length - 1));
    assert.equal(await f.identity.isRealmOpen('TENANT'), false);
    await assert.rejects(f.database.transaction(async () => undefined));
    assert.equal(peer.isOpen(), false);
  } finally { await f.close(); }
});
