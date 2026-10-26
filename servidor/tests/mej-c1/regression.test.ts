import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {appendFile,readFile,writeFile,readdir,lstat,realpath,rm,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {generate} from 'otplib';
import {chromium} from '@playwright/test';
import {generateRegistrationOptions,verifyRegistrationResponse,type RegistrationResponseJSON,type AuthenticationResponseJSON} from '@simplewebauthn/server';
import type {Factor,Identity} from '../../src/modules/identity/models.js';
import {mejProfile,password} from '../helpers/mej-c1-profile.js';
import {ApiClient} from '../helpers/client.js';
import {setup,fundedSetup} from '../operations/fixture.js';
import {sessionMeta,WorkContract} from '../../src/modules/sessions/work-policy.js';
import {today} from '../../src/modules/finance/service.js';
const ev=resolve('../../Construccion/Sprints/MEJ/Evidencias');
let own:ReturnType<typeof mejProfile>|undefined;
after(async()=>{if(own)await(await own).dispose();});
test('MEJ-C1 auth, roles, UI real y regresiones focales',{timeout:420000},async t=>{
 const group=await(own=mejProfile());
 await t.test('F3 B a31min conserva EMAIL_NOT_VERIFIED y vence exactamente60min',async()=>{
  const f=await group.fixture(),a=await f.signup(),{client}=await f.https();client.cookies.set('__Host-caudelyx-session',a.issued.token);client.csrf=a.issued.csrf;const start=f.now();f.clock.value=start+31*60000;
  assert.equal((await client.call('GET','/api/v1/auth/me')).status,200);let guard=await client.call('GET','/api/v1/organization');assert.equal(guard.status,403);assert.equal(guard.body.error?.code,'EMAIL_NOT_VERIFIED');f.clock.value=start+3599999;guard=await client.call('GET','/api/v1/organization');assert.equal(guard.body.error?.code,'EMAIL_NOT_VERIFIED');f.clock.value++;assert.equal((await client.call('GET','/api/v1/auth/me')).status,401);assert.equal((await client.call('POST','/api/v1/auth/session/activity',{})).status,401);
 });
 await t.test('F4 autorización anterior al factor, F9 WORK/LOGIN cerrados',async()=>{
  const f=await group.fixture(),a=await f.signup(),confirmed=await f.identity.confirmEmail(a.issued.context,{purpose:'ACTIVATION',token:a.token}),actor=confirmed.issued.context;await f.runtime.organizations.create(actor,{name:'C1 sin factor',currency:'COP',timezone:'America/Bogota'},randomUUID());
  const subject=(await f.identity.identities.findOne({_id:actor.subjectId!}))!;await f.identity.identities.updateOne({_id:subject._id},{$set:{roles:['O']}});const issued=(await f.identity.login('TENANT',randomUUID(),a.email,password)).issued,{client}=await f.https();client.cookies.set('__Host-caudelyx-session',issued.token);client.csrf=issued.csrf;
  const r=await client.call('POST','/api/v1/auth/step-up/intents',{purpose:'MEMBER_INVITE',method:'TOTP',resourceId:subject.organizationId,command:{email:'guest-c1@example.test',roleIds:['L']}});assert.equal(r.status,403);assert.equal(r.body.error?.code,'ACCESS_DENIED');assert.ok(!(await f.sessions.contexts.findOne({_id:issued.context._id}))?.reauth);
  for(const purpose of ['LOGIN','ORGANIZATION_CREATE'])assert.equal((await client.call('POST','/api/v1/auth/step-up/intents',{purpose,method:'TOTP'})).status,422);
 });
 await t.test('F2 TLS respuesta perdida, CSRF invalidado, grant fijo, replay, seguridad y revocación',async()=>{
  const f=await setup(group),{client}=await f.https();client.cookies.set('__Host-caudelyx-session',f.a.issued.token);client.csrf=f.a.issued.csrf;
  const capital=(await f.runtime.finance.mutate(f.a.issued.context,'createAccount',f.org,{code:'C1_EQ',name:'Capital C1',accountClass:'EQUITY',kind:'GENERAL',currency:'COP'},randomUUID())).data as {id:string};const payload={currency:'COP',effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN-C1',description:'Prueba exacta',lines:[{accountId:f.account,debit:'10.00',credit:'0.00'},{accountId:capital.id,debit:'0.00',credit:'10.00'}]},key=randomUUID(),url=`/api/v1/organizations/${f.org}/financial/journal-entries`;
  const prepare=async(purpose:string,command?:Record<string,unknown>)=>{const p=await client.call('POST','/api/v1/auth/step-up/intents',{purpose,method:'TOTP',...(command?{command}:{})});assert.equal(p.status,200);f.clock.value+=30000;return{intentId:p.body.data?.['intentId'],method:'TOTP',code:await generate({secret:f.a.secret,epoch:Math.floor(f.now()/1000)})};};
  const verify=await prepare('FINANCE_JOURNAL_POST',{organizationId:f.org,idempotencyKey:key,payload}),token=client.cookies.get('__Host-caudelyx-session')!,oldCsrf=client.csrf;
  // Separate client receives/discards the entire A43 response; original cookie+CSRF remain untouched.
  const lost=new ApiClient(client.port,client.cert);lost.cookies.set('__Host-caudelyx-session',token);lost.csrf=oldCsrf;const committed=await lost.call('POST','/api/v1/auth/step-up/verify',verify);assert.equal(committed.status,200);assert.equal(committed.headers['set-cookie'],undefined);assert.equal(client.cookies.get('__Host-caudelyx-session')===token,true);
  const before=await f.runtime.finance.journals.countDocuments({organizationId:f.org}),me=await client.call('GET','/api/v1/auth/me');assert.equal(me.status,200);assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),before);const metadata=me.body.data?.['session'] as {balanceVerifiedUntil:string};assert.ok(metadata.balanceVerifiedUntil);const until=metadata.balanceVerifiedUntil;
  assert.equal((await client.call('POST',url,payload,{'Idempotency-Key':key})).body.error?.code,'CSRF_INVALID');await client.refreshCsrf();assert.equal((await client.call('POST',url,payload,{'Idempotency-Key':key})).status,201);assert.equal((await client.call('POST',url,payload,{'Idempotency-Key':key})).status,200);assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),before+1);
  const noProof=await client.call('POST','/api/v1/auth/mfa/recovery-codes/regenerate');assert.equal(noProof.status,403);assert.equal(noProof.body.error?.code,'R_REQUIRED');
  const security=await prepare('RECOVERY_CODES_REGENERATE');assert.equal((await client.call('POST','/api/v1/auth/step-up/verify',security)).status,200);await client.refreshCsrf();assert.equal((await client.call('POST','/api/v1/auth/mfa/recovery-codes/regenerate')).status,200);assert.equal((await client.call('POST','/api/v1/auth/mfa/recovery-codes/regenerate')).body.error?.code,'R_REQUIRED');assert.equal(((await client.call('GET','/api/v1/auth/me')).body.data?.['session'] as {balanceVerifiedUntil:string}).balanceVerifiedUntil,until);
  f.clock.value+=1800000;assert.equal((await client.call('POST','/api/v1/auth/session/activity',{})).status,200);f.clock.value=Date.parse(until)-1;const extra={...payload,sourceId:randomUUID()};assert.equal((await client.call('POST',url,extra,{'Idempotency-Key':randomUUID()})).status,201);f.clock.value++;assert.equal((await client.call('POST',url,{...payload,sourceId:randomUUID()},{'Idempotency-Key':randomUUID()})).body.error?.code,'R_REQUIRED');assert.equal(((await client.call('GET','/api/v1/auth/me')).body.data?.['session'] as {balanceVerifiedUntil:unknown}).balanceVerifiedUntil,null);
  const expired=await prepare('PASSWORD_CHANGE');assert.equal((await client.call('POST','/api/v1/auth/step-up/verify',expired)).status,200);await client.refreshCsrf();f.clock.value+=300000;assert.equal((await client.call('POST','/api/v1/auth/password/change',{newPassword:password+' C1'})).body.error?.code,'R_REQUIRED');
  const change=await prepare('PASSWORD_CHANGE');assert.equal((await client.call('POST','/api/v1/auth/step-up/verify',change)).status,200);await client.refreshCsrf();assert.equal((await client.call('POST','/api/v1/auth/password/change',{newPassword:password+' C1'})).status,204);assert.equal((await client.call('GET','/api/v1/auth/me')).status,401);
  await client.refreshCsrf();assert.equal((await client.call('POST','/api/v1/auth/login',{email:f.a.email,password:password+' C1'})).status,200);assert.equal(client.cookies.get('__Host-caudelyx-session')===token,false);await client.refreshCsrf();assert.equal((await client.call('POST','/api/v1/auth/logout')).status,204);assert.equal((await client.call('GET','/api/v1/auth/me')).status,401);
 });
 await t.test('F2 schema A43 aborta consumo antes de commit y permite reintentar el mismo OTP',async()=>{
  const f=await setup(group),{client}=await f.https();client.cookies.set('__Host-caudelyx-session',f.a.issued.token);client.csrf=f.a.issued.csrf;const p=await client.call('POST','/api/v1/auth/step-up/intents',{purpose:'RECOVERY_CODES_REGENERATE',method:'TOTP'});f.clock.value+=30000;const input={intentId:p.body.data?.['intentId'],method:'TOTP',code:await generate({secret:f.a.secret,epoch:Math.floor(f.now()/1000)})};const original=WorkContract.prototype.validate;let fired=false;
  WorkContract.prototype.validate=function(name,value,response=false){if(name==='StepUpVerified'&&response&&!fired){fired=true;throw Error('OWN-C1-SCHEMA');}return original.call(this,name,value,response);};let failed;try{failed=await client.call('POST','/api/v1/auth/step-up/verify',input);}finally{WorkContract.prototype.validate=original;}assert.equal(failed.status,503);assert.equal(failed.headers['set-cookie'],undefined);assert.equal((await client.call('GET','/api/v1/auth/me')).status,200);assert.equal((await client.call('POST','/api/v1/auth/step-up/verify',input)).status,200);
 });
 await t.test('F5 metadata oculta grant vencido; expiración no se extiende por consulta',async()=>{
  const f=await setup(group);await f.proof(f.a,'RECOVERY_CODES_REGENERATE');const c=f.a.issued.context;c.balanceGrant={factorId:c.factorId!,organizationId:f.org,expiresAt:f.now()+1000};assert.ok(sessionMeta(c,f.now()+999).balanceVerifiedUntil);assert.equal(sessionMeta(c,f.now()+1000).balanceVerifiedUntil,null);assert.equal(sessionMeta(c,f.now()+1001).balanceVerifiedUntil,null);
 });
  await t.test('real virtual WebAuthn: W first factor, one-shot UV assertion and PLATFORM two-passkey isolation',async()=>{
    const f=await group.fixture(),reg=await f.signup(),confirmed=await f.identity.confirmEmail(reg.issued.context,{purpose:'ACTIVATION',token:reg.token}),https=await f.https();
    const release=group.hold(),receipt=async(event:Record<string,unknown>)=>appendFile('../../Construccion/Sprints/MEJ/Evidencias/MEJ-C1-RESOURCES.jsonl',JSON.stringify({task:'MEJ-C1',at:new Date().toISOString(),ownerPid:process.pid,resource:'OWN_VIRTUAL_WEBAUTHN_BROWSER',port:https.port,...event})+'\n');
    await receipt({event:'browser-reserved-before-create'});
    let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
    try{
      browser=await chromium.launch({executablePath:'C:/Users/Asus ExpertBook/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',headless:true});
      await receipt({event:'browser-created',connected:browser.isConnected()});
      const context=await browser.newContext({ignoreHTTPSErrors:true}),page=await context.newPage(),cdp=await context.newCDPSession(page);
      await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'usb',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
      await page.goto(f.config.tenantOrigin+'/api/v1/auth/csrf');
      const options=await f.runtime.webauthn.enroll(confirmed.issued.context,'Virtual propia',password);
      const credential=await page.evaluate(async(value:unknown)=>{
        const publicKey=PublicKeyCredential.parseCreationOptionsFromJSON(value as PublicKeyCredentialCreationOptionsJSON);
        return(await navigator.credentials.create({publicKey}) as PublicKeyCredential).toJSON();
      },options.publicKey) as RegistrationResponseJSON;
      const registered=await f.runtime.webauthn.confirm(confirmed.issued.context,options.ceremonyId,credential);assert.equal(registered.issued?.context.kind,'W');
      const actor=registered.issued!.context,intent=await f.identity.work!.prepare(actor,{purpose:'RECOVERY_CODES_REGENERATE',method:'WEBAUTHN'});
      const assertion=await page.evaluate(async(value:unknown)=>{
        const publicKey=PublicKeyCredential.parseRequestOptionsFromJSON(value as PublicKeyCredentialRequestOptionsJSON);
        return(await navigator.credentials.get({publicKey}) as PublicKeyCredential).toJSON();
      },intent.publicKey) as AuthenticationResponseJSON;
      for(const invalid of ['origin','challenge','uv','rp']){
        const bad=structuredClone(assertion);
        if(invalid==='origin'||invalid==='challenge'){
          const json=JSON.parse(Buffer.from(bad.response.clientDataJSON,'base64url').toString('utf8')) as Record<string,unknown>;
          if(invalid==='origin')json['origin']='https://other.example.test';else json['challenge']='wrong-challenge';
          bad.response.clientDataJSON=Buffer.from(JSON.stringify(json)).toString('base64url');
        }else{
          const bytes=Buffer.from(bad.response.authenticatorData,'base64url');if(invalid==='uv')bytes[32]=bytes[32]!&~4;else bytes[0]=bytes[0]!^1;bad.response.authenticatorData=bytes.toString('base64url');
        }
        await assert.rejects(f.identity.work!.verify(actor,{intentId:intent.intentId,method:'WEBAUTHN',credential:bad}));
      }
      const verified=await f.identity.work!.verify(actor,{intentId:intent.intentId,method:'WEBAUTHN',credential:assertion},registered.issued!.token);assert.equal(verified.issued.token===registered.issued!.token,true);
      assert.equal(verified.data.verifiedClass,'SECURITY_ONE_SHOT');assert.equal((await f.runtime.recovery.regenerate(verified.issued.context)).codes.length,10);
      await assert.rejects(f.identity.work!.verify(actor,{intentId:intent.intentId,method:'WEBAUTHN',credential:assertion}));

      await page.goto(f.config.platformOrigin+'/api/v1/auth/csrf');
      const base=(await f.identity.identities.findOne({_id:actor.subjectId!}))!,subject:Identity={...base,_id:randomUUID(),realm:'PLATFORM',email:'platform-mej@example.test',organizationId:null,roles:['SA'],state:'AUTHENTICATED_NO_ORG',factorCount:2,hasEverConfirmedFactor:true,credentialVersion:randomUUID(),authEpoch:randomUUID(),authzVersion:randomUUID()};
      await f.identity.identities.insertOne(subject);
      for(let n=0;n<2;n++){
        const o=await generateRegistrationOptions({rpName:'Caudelyx',rpID:'platform.localhost',userName:subject.email,userID:new TextEncoder().encode(subject._id),supportedAlgorithmIDs:[-7,-257],attestationType:'none',authenticatorSelection:{userVerification:'required',residentKey:'discouraged'}});
        const response=await page.evaluate(async(value:unknown)=>{
          const publicKey=PublicKeyCredential.parseCreationOptionsFromJSON(value as PublicKeyCredentialCreationOptionsJSON);
          return(await navigator.credentials.create({publicKey}) as PublicKeyCredential).toJSON();
        },o) as RegistrationResponseJSON;
        const result=await verifyRegistrationResponse({response,expectedChallenge:o.challenge,expectedOrigin:f.config.platformOrigin,expectedRPID:'platform.localhost',requireUserVerification:true,requireUserPresence:true,supportedAlgorithmIDs:[-7,-257]});assert.ok(result.registrationInfo);
        const key=result.registrationInfo.credential,factor:Factor={_id:randomUUID(),subjectId:subject._id,realm:'PLATFORM',type:'WEBAUTHN',label:'Virtual '+n,state:'ACTIVE',contextId:'MEJ-OWN-PROVISION',recoveryId:null,expiresAt:f.now()+300000,confirmed:true,version:'"'+randomUUID()+'"',createdAt:f.now(),lastUsedAt:null,credentialId:key.id,publicKey:Buffer.from(key.publicKey).toString('base64url'),counter:key.counter};
        await f.sessions.factors.insertOne(factor);
      }
      const platform=new ApiClient(https.port,https.cert,'platform.localhost');await platform.refreshCsrf();
      const login=await platform.call('POST','/api/v1/auth/login',{email:subject.email,password});assert.equal(login.status,200);assert.equal(login.body.data?.['authState'],'MFA_REQUIRED');await platform.refreshCsrf();
      const challenge=await platform.call('POST','/api/v1/auth/mfa/webauthn/authentication/options',{purpose:'LOGIN'});assert.equal(challenge.status,200);
      const signed=await page.evaluate(async(value:unknown)=>{
        const publicKey=PublicKeyCredential.parseRequestOptionsFromJSON(value as PublicKeyCredentialRequestOptionsJSON);
        return(await navigator.credentials.get({publicKey}) as PublicKeyCredential).toJSON();
      },challenge.body.data?.['publicKey']) as AuthenticationResponseJSON;
      const completed=await platform.call('POST','/api/v1/auth/mfa/challenges/verify',{method:'WEBAUTHN',purpose:'LOGIN',ceremonyId:challenge.body.data?.['ceremonyId'],credential:signed});assert.equal(completed.status,200);
      assert.equal((await f.sessions.find(platform.cookies.get('__Host-caudelyx-platform-session'),'PLATFORM'))?.kind,'S');
      assert.equal((await platform.call('POST','/api/v1/auth/step-up/intents',{purpose:'PASSWORD_CHANGE',method:'TOTP'})).status,403);
    }finally{try{await browser?.close();}finally{release();await receipt({event:'browser-cleanup-complete',connected:browser?.isConnected()??false});}}
  });
 await t.test('R1/F2 interfaz compilada HTTPS con actividad, código y datos reales',{timeout:240000},async()=>{
 const f=await fundedSetup(group),seed=await f.loan({principal:'1000.00'});await f.disburse(seed);const loan=await f.loan({principal:'2000000.00'}),b=await f.signup();await f.identity.confirmEmail(b.issued.context,{purpose:'ACTIVATION',token:b.token});f.clock.value+=30000;
 await readFile(resolve('../cliente/dist/index.html'));const serve=f.https as (withClient?:boolean)=>ReturnType<typeof f.https>;const endpoint=await serve(true),release=group.hold(),receipt=async(event:Record<string,unknown>)=>appendFile(join(ev,'MEJ-C1-RESOURCES.jsonl'),JSON.stringify({task:'MEJ-C1',at:new Date().toISOString(),resource:'OWN_PLAYWRIGHT',...event})+'\n');
 const temp=join(group.folder,'browser-temp');await receipt({event:'before-runner',folder:group.folder,temp,port:endpoint.port,budget:67108864});await mkdir(temp);
 const child=spawn(process.execPath,[resolve('../cliente/node_modules/@playwright/test/cli.js'),'test','-c','playwright.mej-c1.config.ts'],{cwd:resolve('../cliente'),windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,TEMP:temp,TMP:temp,TMPDIR:temp,MEJC1_BASE_URL:f.config.tenantOrigin,MEJC1_FOLDER:group.folder,MEJC1_CONTEXT:JSON.stringify({a:{email:f.a.email,password,secret:f.a.secret},b:{email:b.email,password},loanId:loan.id,date:today(f.now()),epoch:Math.floor(f.now()/1000)})}});let output='';child.stdout.on('data',(x:Buffer)=>output+=x.toString());child.stderr.on('data',(x:Buffer)=>output+=x.toString());await receipt({event:'runner-created',pid:child.pid});
 try{const [code]=await once(child,'exit');await writeFile(join(ev,'MEJ-C1-E2E.log'),output);assert.equal(code,0,'See own E2E log');const position=(await f.position(loan.id)).data as {principalOutstanding:string};assert.equal(position.principalOutstanding,'1710000.00');assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org,supportReference:'SYN-C1-JOURNAL'}),1);
 }finally{
  if(child.exitCode===null)throw Error('Own browser runner still active');
  async function bytes(path:string):Promise<number>{let n=0;for(const entry of await readdir(path,{withFileTypes:true})){const file=join(path,entry.name),stat=await lstat(file);if(stat.isSymbolicLink())throw Error('Linked own control');n+=entry.isDirectory()?await bytes(file):stat.size;}return n;}
  let measured=0;for(const folder of [join(group.folder,'playwright'),temp])try{if(resolve(await realpath(folder))!==resolve(folder))throw Error('Unknown browser control');measured+=await bytes(folder);await rm(folder,{recursive:true,force:false,maxRetries:3});}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  await receipt({event:'runner-cleanup',pid:child.pid,exitCode:child.exitCode,measuredControlBytes:measured,overBudget:measured>67108864});release();assert.ok(measured<=67108864);
 }
 });
});
