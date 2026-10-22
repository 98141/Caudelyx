import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {once} from 'node:events';
import {randomBytes,randomUUID} from 'node:crypto';
import {generate} from 'otplib';
import {fixture} from './helpers/fixture.js';
import {testCertificate} from './helpers/tls.js';
import {ApiClient} from './helpers/client.js';
import {createApp} from '../src/app.js';
import {attachRuntime} from '../src/shared/runtime.js';

test('PROFILE real HTTPS: closed schemas, CSRF, restricted own profile, no GET activation, wrong subject, real factor and no platform downgrade', {timeout:120000},async()=>{
 const f=await fixture(),tls=await testCertificate();
 const server=createServer(tls);server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const address=server.address();assert.ok(address&&typeof address!=='string');const port=address.port;
  const config={mongoUri:f.uri,databaseName:f.database.db.databaseName,port,tenantOrigin:`https://localhost:${port}`,platformOrigin:`https://platform.localhost:${port}`};
  await attachRuntime(f.identity,{version:1,mail:f.mailKey,totp:f.totpKey,journal:randomBytes(32),cursor:randomBytes(32)},config);
  server.on('request',createApp({identity:f.identity,config}));
  const c=new ApiClient(port,tls.cert),foreign=new ApiClient(port,tls.cert),platform=new ApiClient(port,tls.cert,'platform.localhost');
  await c.refreshCsrf();await foreign.refreshCsrf();await platform.refreshCsrf();
  const email=`${randomUUID()}@example.test`,password='synthetic HTTP profile password 123456789';
  const registration={mode:'PROFILE',email,password,displayName:'Persona HTTPS',privacyPolicyVersion:'synthetic-v1',acceptTerms:true};
  assert.equal((await c.call('POST','/api/v1/auth/register',{...registration,password:undefined})).status,422);
  assert.equal((await platform.call('POST','/api/v1/auth/register',registration)).status,403);
  assert.equal((await c.call('POST','/api/v1/auth/register',registration)).status,202);
  const logged=await c.call('POST','/api/v1/auth/login',{email,password});assert.equal(logged.status,401,'pending account cannot become an enumeration oracle');
  assert.ok(!c.cookies.get('__Host-caudelyx-session'));
  const before=await c.call('GET','/api/v1/auth/me');assert.equal(before.status,200);assert.equal(before.body.data?.['authState'],'EMAIL_REQUIRED');
  assert.equal((before.body.data?.['profile'] as {emailVerified:boolean}).emailVerified,false);
  assert.notEqual((await c.call('GET','/api/v1/organization')).status,200);
  assert.equal((await c.call('POST','/api/v1/auth/mfa/totp/enrollments',{label:'Prematuro'})).status,401);
  await f.identity.dispatchMail();const subject=await f.identity.identities.findOne({email});assert.ok(subject);
  const mail=[...f.messages.inbox.values()].find(m=>m.subjectId===subject._id&&m.purpose==='ACTIVATION');assert.ok(mail);
  const activation={purpose:'ACTIVATION',mode:'LINK',token:mail.token};
  assert.notEqual((await c.call('GET','/api/v1/auth/email-verifications/confirm')).status,200);
  assert.equal((await foreign.call('POST','/api/v1/auth/email-verifications/confirm',activation)).status,401);
  assert.equal((await c.call('POST','/api/v1/auth/email-verifications/confirm',activation,{'X-CSRF-Token':'incorrect'})).status,400);
  assert.equal((await c.call('POST','/api/v1/auth/email-verifications/confirm',{...activation,newPassword:password})).status,422);
  assert.equal((await c.call('POST','/api/v1/auth/email-verifications/confirm',activation)).status,200);await c.refreshCsrf();
  const activated=await c.call('GET','/api/v1/auth/me');assert.equal(activated.body.data?.['authState'],'MFA_ENROLLMENT');
  assert.equal(activated.body.data?.['nextAction'],'ENROLL_FIRST_FACTOR');
  assert.equal((activated.body.data?.['profile'] as {emailVerified:boolean}).emailVerified,true);
  const en=await c.call('POST','/api/v1/auth/mfa/totp/enrollments',{label:'App HTTPS'});assert.equal(en.status,201);
  const uri=en.body.data?.['provisioningUri'];assert.equal(typeof uri,'string');const secret=new URL(String(uri)).searchParams.get('secret');assert.ok(secret);
  const code=await generate({secret,epoch:Math.floor(f.now()/1000)});
  const verified=await c.call('POST',`/api/v1/auth/mfa/totp/enrollments/${String(en.body.data?.['enrollmentId'])}/confirm`,{code});assert.equal(verified.status,200);await c.refreshCsrf();
  assert.ok(c.cookies.get('__Host-caudelyx-session'));
  assert.equal((await c.call('GET','/api/v1/auth/me')).body.data?.['authState'],'AUTHENTICATED_NO_ORG');
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
});

test('PROFILE privacy over real HTTPS: existing/new emails have indistinguishable registration/profile/login and no pre-email privilege; existing identity is untouched',{timeout:120000},async()=>{
 const f=await fixture(),tls=await testCertificate(),server=createServer(tls).listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const address=server.address();assert.ok(address&&typeof address!=='string');const port=address.port;
  const config={mongoUri:f.uri,databaseName:f.database.db.databaseName,port,tenantOrigin:`https://localhost:${port}`,platformOrigin:`https://platform.localhost:${port}`};
  await attachRuntime(f.identity,{version:1,mail:f.mailKey,totp:f.totpKey,journal:randomBytes(32),cursor:randomBytes(32)},config);server.on('request',createApp({identity:f.identity,config}));
  const existing=await f.identity.identities.findOne({email:f.email});assert.ok(existing);const originalHash=existing.passwordHash,originalName=existing.displayName;
  const password='synthetic private registration password 24680',observed:{register:number;code:unknown;login:number;profileState:unknown;name:unknown;factor:number;organization:number;webauthn:number;recovery:number}[]=[];
  for(const email of [f.email,`${randomUUID()}@example.test`]){
   const c=new ApiClient(port,tls.cert);await c.refreshCsrf();
   const registered=await c.call('POST','/api/v1/auth/register',{mode:'PROFILE',email,password,displayName:'Entrada privada',privacyPolicyVersion:'synthetic-v1',acceptTerms:true});
   const profile=await c.call('GET','/api/v1/auth/me');assert.equal(profile.status,200);
   const own=profile.body.data?.['profile'] as {displayName:string;email:string;emailVerified:boolean};assert.equal(own.email,email);assert.equal(own.emailVerified,false);
   assert.deepEqual(Object.keys(profile.body.data??{}).sort(),['authState','profile']);
   const login=await c.call('POST','/api/v1/auth/login',{email,password});
   const factor=await c.call('POST','/api/v1/auth/mfa/totp/enrollments',{label:'No privilegio'});
   const organization=await c.call('POST','/api/v1/organizations',{name:'No crear',timezone:'America/Bogota',currency:'COP'},{'Idempotency-Key':randomUUID()});
   const webauthn=await c.call('POST','/api/v1/auth/mfa/webauthn/authentication/options',{purpose:'LOGIN'});
   const recovery=await c.call('POST','/api/v1/auth/mfa/recovery/start',{recoveryCode:'A'.repeat(32)});
   observed.push({register:registered.status,code:registered.body.data?.['code'],login:login.status,profileState:profile.body.data?.['authState'],name:own.displayName,factor:factor.status,organization:organization.status,webauthn:webauthn.status,recovery:recovery.status});
  }
  assert.deepEqual(observed[0],observed[1],'public composition must not reveal whether the email already exists');
  assert.equal(observed[0]?.register,202);assert.equal(observed[0]?.login,401);assert.equal(observed[0]?.name,'Entrada privada');
  assert.ok(observed.every(r=>[r.factor,r.organization,r.webauthn,r.recovery].every(status=>status>=400)));
  const after=await f.identity.identities.findOne({_id:existing._id});assert.ok(after);assert.ok(after.passwordHash===originalHash);assert.equal(after.displayName,originalName);
  console.log(JSON.stringify({evidence:'profile-privacy-no-enumeration',existingAndNew:observed,containsEmailsOrSecrets:false}));
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await f.close();}
});

test('PROFILE manual runtime: terminal activation link, restart with persistent password, bound resumption link and actual TOTP; CLI never consumes or logs the proof', {timeout:180000},async()=>{
 const {spawn,execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const {readFile}=await import('node:fs/promises'),{createServer:createProbe}=await import('node:net');
 const exec=promisify(execFile),profile=`test-${randomUUID()}`;
 const probe=createProbe().listen(0,'127.0.0.1');await once(probe,'listening');const address=probe.address();assert.ok(address&&typeof address!=='string');
 const mongoPort=address.port;await new Promise<void>(r=>probe.close(()=>r()));assert.notEqual(mongoPort,27017);
 const env:NodeJS.ProcessEnv={...process.env,CAUDELYX_MODE:'local-synthetic',CAUDELYX_DEV_TEST_PROFILE:profile,CAUDELYX_DEV_TEST_MONGO_PORT:String(mongoPort)};delete env['MONGODB_URI'];
 let child:import('node:child_process').ChildProcess|undefined;
 const stop=async()=>{if(!child||child.exitCode!==null)return;const exited=once(child,'exit');child.send?.('LOCAL_DEV_STOP');await exited;child=undefined;};
 class ManualClient extends ApiClient{
  override async call(method:string,route:string,body?:unknown,headers:Record<string,string>={}){
   return await super.call(method,route,body,{Host:'localhost:3001',Origin:'https://localhost:3001',...headers});
  }
 }
 const start=async()=>{
  child=spawn(process.execPath,['scripts/manual-local.mjs'],{env,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
  await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Manual profile startup timeout')),30000);
   child!.once('error',e=>{clearTimeout(timeout);reject(e);});child!.once('exit',()=>{clearTimeout(timeout);reject(new Error('Manual profile exited before ready'));});
   child!.on('message',m=>{if(m==='LOCAL_RUNTIME_READY'){clearTimeout(timeout);resolve();}});
  });
  return new ManualClient(4001,await readFile('.runtime/tls/cert.pem'));
 };
 const email=`profile_${randomUUID()}@example.test`,password='synthetic persistent profile password 24680';
 const mailbox=async(purpose:string)=>{
  for(let n=0;n<30;n++){
   const output=await exec(process.execPath,['scripts/mailbox-local.mjs','--email',email],{env,windowsHide:true});
   const messages=(JSON.parse(output.stdout) as {messages:{purpose:string;code:string;activationUrl:string;requiresPasswordSetup:boolean}[]}).messages;
   const message=messages.find(m=>m.purpose===purpose);if(message)return message;
   await new Promise<void>(r=>setTimeout(r,100));
  }throw new Error('Synthetic activation message not delivered');
 };
 try{
  let api=await start();await api.refreshCsrf();
  assert.equal((await api.call('POST','/api/v1/auth/register',{mode:'PROFILE',email,password,displayName:'Persona manual moderna',privacyPolicyVersion:'synthetic-v1',acceptTerms:true})).status,202);
  assert.equal((await api.call('GET','/api/v1/auth/me')).body.data?.['authState'],'EMAIL_REQUIRED');
  const message=await mailbox('ACTIVATION'),link=new URL(message.activationUrl);
  assert.equal(link.origin,'https://localhost:3001');assert.equal(link.search,'');assert.equal(message.requiresPasswordSetup,false);
  const proof=new URLSearchParams(link.hash.split('?')[1]);assert.ok(proof.get('token')===message.code);assert.equal(proof.get('purpose'),'ACTIVATION');
  const again=await mailbox('ACTIVATION');assert.ok(again.code===message.code,'CLI does not consume proof');
  const pendingCookies=[...api.cookies];await stop();api=await start();for(const[k,v]of pendingCookies)api.cookies.set(k,v);await api.refreshCsrf();
  assert.equal((await api.call('GET','/api/v1/auth/me')).body.data?.['authState'],'EMAIL_REQUIRED','private registration request survives manual restart');
  assert.equal((await api.call('POST','/api/v1/auth/email-verifications/confirm',{purpose:'ACTIVATION',mode:'LINK',token:message.code})).status,200);
  await stop();api=await start();await api.refreshCsrf();
  assert.equal((await api.call('POST','/api/v1/auth/login',{email,password})).body.data?.['authState'],'MFA_ENROLLMENT');await api.refreshCsrf();
  assert.equal((await api.call('GET','/api/v1/auth/me')).body.data?.['nextAction'],undefined,'L does not claim first-factor readiness');
  assert.equal((await api.call('POST','/api/v1/auth/email-verifications/request',{purpose:'INITIAL_MFA_PROOF'})).status,202);
  const resume=await mailbox('INITIAL_MFA_PROOF');
  assert.equal((await api.call('POST','/api/v1/auth/email-verifications/confirm',{purpose:'INITIAL_MFA_PROOF',token:resume.code})).status,200);await api.refreshCsrf();
  assert.equal((await api.call('GET','/api/v1/auth/me')).body.data?.['nextAction'],'ENROLL_FIRST_FACTOR');
  const en=await api.call('POST','/api/v1/auth/mfa/totp/enrollments',{label:'App manual moderna'});assert.equal(en.status,201);
  const secret=new URL(String(en.body.data?.['provisioningUri'])).searchParams.get('secret');assert.ok(secret);
  const factor=await api.call('POST',`/api/v1/auth/mfa/totp/enrollments/${String(en.body.data?.['enrollmentId'])}/confirm`,{code:await generate({secret})});assert.equal(factor.status,200);
  await api.refreshCsrf();assert.equal((await api.call('GET','/api/v1/auth/me')).body.data?.['authState'],'AUTHENTICATED_NO_ORG');
  const mongoLog=await readFile(`.runtime/manual-${profile}/mongo.log`,'utf8');
  assert.equal(mongoLog.includes(message.code),false);assert.equal(mongoLog.includes(resume.code),false);assert.equal(mongoLog.includes(password),false);
 }finally{await stop();await exec(process.execPath,['scripts/manual-local.mjs','--reset'],{env,windowsHide:true});}
});
