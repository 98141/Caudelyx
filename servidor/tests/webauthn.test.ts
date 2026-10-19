import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'node:https';
import { once } from 'node:events';
import {generateRegistrationOptions,verifyRegistrationResponse,type RegistrationResponseJSON,type AuthenticationResponseJSON} from '@simplewebauthn/server';
import {randomUUID,randomBytes}from'node:crypto';
import type{Identity,Factor}from'../src/modules/identity/models.js';
import {attachRuntime}from'../src/shared/runtime.js';
import {ApiClient}from'./helpers/client.js';
import { fixture } from './helpers/fixture.js';
import { testCertificate } from './helpers/tls.js';
import { createApp } from '../src/app.js';
import { WebAuthnService } from '../src/modules/webauthn/service.js';

test('real Chromium virtual WebAuthn: UV enrollment, signed login, origin mismatch and one-use challenge', { timeout: 120000 }, async () => {
  const f = await fixture(), tls = await testCertificate();
  const config = { mongoUri: '', databaseName: '', port: 0, tenantOrigin: 'https://localhost:0', platformOrigin: 'https://127.0.0.1:0' };
  const server = createServer(tls, createApp({ identity: f.identity, config })).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  config.tenantOrigin = `https://localhost:${address.port}`; config.platformOrigin = `https://127.0.0.1:${address.port}`;
  const origins = { TENANT: config.tenantOrigin, PLATFORM: config.platformOrigin };
  const web = new WebAuthnService(f.lifecycle, origins);
  const browser = await chromium.launch({ executablePath: 'C:/Users/Asus ExpertBook/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe', headless: true });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true }); // Only the generated self-signed fixture.
    const page = await context.newPage(), cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'usb',
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(config.tenantOrigin + '/api/v1/auth/csrf');
    const options = await web.enroll(f.initial.context, 'Passkey sintética');
    const response = await page.evaluate(async (value: unknown) => {
      const options = value as PublicKeyCredentialCreationOptionsJSON;
      const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(options);
      const credential = await navigator.credentials.create({ publicKey }) as PublicKeyCredential;
      return credential.toJSON();
    }, options.publicKey) as RegistrationResponseJSON;
    const enrolled = await web.confirm(f.initial.context, options.ceremonyId, response);
    assert.equal(enrolled.issued?.context.kind, 'S');
    assert.equal((await f.sessions.find(enrolled.issued?.token, 'TENANT'))?.kind, 'S');
    await assert.rejects(web.confirm(f.initial.context, options.ceremonyId, response));
    const login = await f.identity.login('TENANT', 'webauthn-login', f.email, f.password);
    const challenge = await web.options(login.issued.context, 'LOGIN', null);
    const assertion = await page.evaluate(async (value: unknown) => {
      const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(value as PublicKeyCredentialRequestOptionsJSON);
      const credential = await navigator.credentials.get({ publicKey }) as PublicKeyCredential;
      return credential.toJSON();
    }, challenge.publicKey) as AuthenticationResponseJSON;
    origins.TENANT = 'https://wrong-origin.invalid';
    await assert.rejects(web.authenticate(login.issued.context, challenge.ceremonyId, assertion, 'LOGIN', null));
    origins.TENANT = config.tenantOrigin;
    const loggedIn = await web.authenticate(login.issued.context, challenge.ceremonyId, assertion, 'LOGIN', null);
    assert.equal(loggedIn.issued.context.kind, 'S');
    const replays = await Promise.allSettled([web.authenticate(login.issued.context, challenge.ceremonyId, assertion, 'LOGIN', null),
      web.authenticate(login.issued.context, challenge.ceremonyId, assertion, 'LOGIN', null)]);
    assert.ok(replays.every(result => result.status === 'rejected'));
    assert.equal(await f.sessions.factors.countDocuments({ type: 'WEBAUTHN', state: 'ACTIVE' }), 1);
  } finally {
    await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close();
  }
});

test('PLATFORM real HTTPS signed passkeys: two-credential fixture, no tenant/TOTP intent, valid factor-bound R and minimum two retained',{timeout:120000},async()=>{
 const f=await fixture(),tls=await testCertificate();
 const config={mongoUri:f.uri,databaseName:f.database.db.databaseName,port:0,tenantOrigin:'https://localhost:0',platformOrigin:'https://127.0.0.1:0'};
 // Listen only after fixing origins; handler delegates once local runtime is attached.
 const server=createServer(tls).listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();assert.ok(address&&typeof address!=='string');config.tenantOrigin=`https://localhost:${address.port}`;config.platformOrigin=`https://platform.localhost:${address.port}`;
 await attachRuntime(f.identity,{version:1,mail:f.mailKey,totp:f.totpKey,journal:randomBytes(32),cursor:randomBytes(32)},config);
 server.on('request',createApp({identity:f.identity,config}));
 const browser=await chromium.launch({executablePath:'C:/Users/Asus ExpertBook/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',headless:true});
 try{
  const context=await browser.newContext({ignoreHTTPSErrors:true}),page=await context.newPage(),cdp=await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');const authenticator=await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'usb',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  await page.goto(config.platformOrigin+'/api/v1/auth/csrf');
  const original=await f.identity.identities.findOne({email:f.email});assert.ok(original);
  const subject:Identity={...original,_id:randomUUID(),realm:'PLATFORM',email:'synthetic-platform@example.test',roles:['SA'],state:'AUTHENTICATED_NO_ORG',factorCount:2,hasEverConfirmedFactor:true,credentialVersion:randomUUID(),authEpoch:randomUUID(),authzVersion:randomUUID()};
  await f.identity.identities.insertOne(subject);const factors:Factor[]=[];
  // Explicit operator test fixture only: real browser-generated keys, no public PLATFORM bootstrap endpoint.
  for(let n=0;n<2;n++){
   const options=await generateRegistrationOptions({rpName:'Caudelyx',rpID:'platform.localhost',userName:subject.email,userID:new TextEncoder().encode(subject._id),supportedAlgorithmIDs:[-7,-257],attestationType:'none',authenticatorSelection:{userVerification:'required',residentKey:'discouraged'}});
   const response=await page.evaluate(async(value:unknown)=>{const publicKey=PublicKeyCredential.parseCreationOptionsFromJSON(value as PublicKeyCredentialCreationOptionsJSON);return(await navigator.credentials.create({publicKey})as PublicKeyCredential).toJSON();},options)as RegistrationResponseJSON;
   const verified=await verifyRegistrationResponse({response,expectedChallenge:options.challenge,expectedOrigin:config.platformOrigin,expectedRPID:'platform.localhost',requireUserVerification:true,requireUserPresence:true,supportedAlgorithmIDs:[-7,-257]});assert.ok(verified.verified);
   const credential=verified.registrationInfo.credential;
   factors.push({_id:randomUUID(),subjectId:subject._id,realm:'PLATFORM',type:'WEBAUTHN',label:`Synthetic platform key${n}`,state:'ACTIVE',confirmed:true,contextId:'synthetic-operator-provision',recoveryId:null,expiresAt:f.now()+300000,version:`"${randomUUID()}"`,createdAt:f.now(),lastUsedAt:null,credentialId:credential.id,publicKey:Buffer.from(credential.publicKey).toString('base64url'),counter:credential.counter});
  }await f.sessions.factors.insertMany(factors);
  const client=new ApiClient(address.port,tls.cert,'platform.localhost');await client.refreshCsrf();
  const login=await client.call('POST','/api/v1/auth/login',{email:subject.email,password:f.password});assert.equal(login.status,200,JSON.stringify(login.body));await client.refreshCsrf();
  const verify=async(purpose:string,resourceId?:string,authClient=client)=>{
   const body={purpose,...(resourceId?{resourceId}:{})},options=await authClient.call('POST','/api/v1/auth/mfa/webauthn/authentication/options',body);assert.equal(options.status,200,JSON.stringify(options.body));
   const assertion=await page.evaluate(async(value:unknown)=>{const publicKey=PublicKeyCredential.parseRequestOptionsFromJSON(value as PublicKeyCredentialRequestOptionsJSON);return(await navigator.credentials.get({publicKey})as PublicKeyCredential).toJSON();},options.body.data?.['publicKey'])as AuthenticationResponseJSON;
   const result=await authClient.call('POST','/api/v1/auth/mfa/challenges/verify',{...body,method:'WEBAUTHN',ceremonyId:options.body.data?.['ceremonyId'],credential:assertion});assert.equal(result.status,200,JSON.stringify(result.body));await authClient.refreshCsrf();return assertion.id;
  };
  const credentialId=await verify('LOGIN');assert.ok(client.cookies.get('__Host-caudelyx-platform-session'));
  for(const input of [{purpose:'ORGANIZATION_CREATE',command:{name:'No',timezone:'America/Bogota',currency:'COP'}},{purpose:'ORGANIZATION_EDIT',resourceId:randomUUID(),command:{name:'No'}},{purpose:'MFA_ENROLL',command:{methodType:'TOTP',label:'No'}}]){
   const denied=await client.call('POST','/api/v1/auth/reauthenticate',{password:f.password,...input});assert.equal(denied.status,403,JSON.stringify(denied.body));assert.equal(denied.body.error?.code,'ACCESS_DENIED');
  }
  assert.equal(await f.sessions.factors.countDocuments({subjectId:subject._id,state:{$ne:'ACTIVE'}}),0);
  const strong=await f.sessions.find(client.cookies.get('__Host-caudelyx-platform-session'),'PLATFORM');assert.ok(strong);assert.equal(strong.reauth,null);
  const target=factors.find(factor=>factor.credentialId!==credentialId);assert.ok(target);
  assert.equal((await client.call('POST','/api/v1/auth/reauthenticate',{password:f.password,purpose:'MFA_REMOVE',resourceId:target._id})).status,200);
  await verify('MFA_REMOVE',target._id);
  assert.equal((await client.call('DELETE',`/api/v1/auth/mfa/methods/${target._id}`,undefined,{'If-Match':target.version})).status,409);
  assert.equal(await f.sessions.factors.countDocuments({subjectId:subject._id,state:'ACTIVE',type:'WEBAUTHN'}),2);
  assert.equal((await client.call('POST','/api/v1/auth/password-reset/request',{email:subject.email})).status,403);
  assert.equal((await client.call('POST','/api/v1/organizations',{name:'No',timezone:'America/Bogota',currency:'COP'},{'Idempotency-Key':randomUUID()})).status,403);
  assert.equal((await client.call('POST','/api/v1/auth/reauthenticate',{password:f.password,purpose:'RECOVERY_CODES_REGENERATE'})).status,200);await verify('RECOVERY_CODES_REGENERATE');
  const unused=await client.call('POST','/api/v1/auth/mfa/recovery-codes/regenerate');assert.equal(unused.status,200,JSON.stringify(unused.body));assert.equal((unused.body.data?.['codes'] as string[]).length,10);
  assert.equal((await client.call('POST','/api/v1/auth/mfa/recovery/start',{recoveryCode:(unused.body.data?.['codes'] as string[])[0]})).status,403);
  assert.equal((await client.call('POST','/api/v1/auth/reauthenticate',{password:f.password,purpose:'MFA_ENROLL',command:{methodType:'WEBAUTHN',label:'Third platform key'}})).status,200);
  await verify('MFA_ENROLL');
  const enrollment=await client.call('POST','/api/v1/auth/mfa/webauthn/registration/options',{label:'Third platform key'});assert.equal(enrollment.status,200,JSON.stringify(enrollment.body));
  await cdp.send('WebAuthn.removeVirtualAuthenticator',{authenticatorId:authenticator.authenticatorId});await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'usb',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  const registration=await page.evaluate(async(value:unknown)=>{const publicKey=PublicKeyCredential.parseCreationOptionsFromJSON(value as PublicKeyCredentialCreationOptionsJSON);return(await navigator.credentials.create({publicKey})as PublicKeyCredential).toJSON();},enrollment.body.data?.['publicKey'])as RegistrationResponseJSON;
  const added=await client.call('POST','/api/v1/auth/mfa/webauthn/registration/verify',{ceremonyId:enrollment.body.data?.['ceremonyId'],credential:registration});assert.equal(added.status,201,JSON.stringify(added.body));assert.equal(added.body.data?.['nextAction'],'LOGIN');
  assert.equal(await f.sessions.factors.countDocuments({subjectId:subject._id,state:'ACTIVE',type:'WEBAUTHN'}),3);assert.equal(client.cookies.get('__Host-caudelyx-platform-session'),'');
  await client.refreshCsrf();assert.equal((await client.call('POST','/api/v1/auth/login',{email:subject.email,password:f.password})).status,200);
  await client.refreshCsrf();await verify('LOGIN');const firstToken=client.cookies.get('__Host-caudelyx-platform-session');assert.ok(firstToken);
  for(let n=0;n<2;n++){
   f.clock.value+=1000;const extra:ApiClient=new ApiClient(address.port,tls.cert,'platform.localhost');await extra.refreshCsrf();assert.equal((await extra.call('POST','/api/v1/auth/login',{email:subject.email,password:f.password})).status,200);await extra.refreshCsrf();await verify('LOGIN',undefined,extra);
  }
  assert.equal(await f.sessions.contexts.countDocuments({subjectId:subject._id,kind:'S',revoked:false}),2);assert.equal(await f.sessions.find(firstToken,'PLATFORM'),null);
 }finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
});
