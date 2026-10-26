import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {generate} from 'otplib';
import {appendFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {generateRegistrationOptions,verifyRegistrationResponse,type RegistrationResponseJSON,type AuthenticationResponseJSON} from '@simplewebauthn/server';
import type {Factor,Identity} from '../../src/modules/identity/models.js';
import {ApiClient} from '../helpers/client.js';
import {profile,setup,password} from './fixture.js';
import {today} from '../../src/modules/finance/service.js';

test('MEJ HTTPS: aliases, closed schemas, cookies, code window and mailbox rendering',async t=>{
  const group=await profile();
  await t.test('B pending returns EMAIL_NOT_VERIFIED for mixed-case business routes without data',async()=>{
    const f=await group.fixture(),a=await f.signup(),{client}=await f.https();client.cookies.set('__Host-caudelyx-session',a.issued.token);client.csrf=a.issued.csrf;
    const org=randomUUID();
    for(const prefix of ['/api/v1/organizations/','/API/V1/ORGANIZATIONS/','/api/v1/Organizations/']){
      const r=await client.call('GET',prefix+org+'/FINANCIAL/accounts');assert.equal(r.status,403);assert.equal(r.body.error?.code,'EMAIL_NOT_VERIFIED');assert.equal(r.body.data,undefined);
    }
    for(const suffix of ['/BORROWERS','/LOANS','/LOAN-OPERATIONS/BOOK','/FINANCIAL/OPENINGS']){const r=await client.call('GET','/API/V1/ORGANIZATIONS/'+org+suffix);assert.equal(r.status,403);assert.equal(r.body.error?.code,'EMAIL_NOT_VERIFIED');}
    const invalid=await client.call('POST','/api/v1/auth/session/activity',{now:Date.now()});assert.equal(invalid.status,422);
  });
  await t.test('A42/A43 over TLS rotates W and permits two postings without another code, not security',async()=>{
    const f=await setup(group),{client}=await f.https();client.cookies.set('__Host-caudelyx-session',f.a.issued.token);client.csrf=f.a.issued.csrf;
    const capital=(await f.runtime.finance.mutate(f.a.issued.context,'createAccount',f.org,{code:'E',name:'Patrimonio',accountClass:'EQUITY',kind:'GENERAL',currency:'COP'},randomUUID())).data as {id:string};
    const posting={currency:'COP',effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN',description:'TLS',lines:[{accountId:f.account,debit:'10.00',credit:'0.00'},{accountId:capital.id,debit:'0.00',credit:'10.00'}]},key=randomUUID();
    const command={organizationId:f.org,idempotencyKey:key,payload:posting};
    const badCsrf=await client.call('POST','/api/v1/auth/step-up/intents',{purpose:'FINANCE_JOURNAL_POST',method:'TOTP',command},{'X-CSRF-Token':'wrong'});assert.equal(badCsrf.status,400);
    const prepared=await client.call('POST','/api/v1/auth/step-up/intents',{purpose:'FINANCE_JOURNAL_POST',method:'TOTP',command});assert.equal(prepared.status,200);
    f.clock.value+=30000;
    const result=await client.call('POST','/api/v1/auth/step-up/verify',{intentId:prepared.body.data?.['intentId'],method:'TOTP',code:await generate({secret:f.a.secret,epoch:Math.floor(f.now()/1000)})});assert.equal(result.status,200);assert.equal(result.body.data?.['verifiedClass'],'BALANCE_60M');
    assert.ok((result.headers['set-cookie']??[]).every(v=>v.includes('Secure')&&v.includes('HttpOnly')&&v.includes('SameSite=Lax')&&!v.includes('Domain=')));
    await client.refreshCsrf();
    assert.equal((await client.call('POST',`/api/v1/organizations/${f.org}/financial/journal-entries`,posting,{'Idempotency-Key':key})).status,201);
    assert.equal((await client.call('POST',`/api/v1/organizations/${f.org}/financial/journal-entries`,{...posting,sourceId:randomUUID()},{'Idempotency-Key':randomUUID()})).status,201);
    const security=await client.call('POST','/api/v1/auth/mfa/recovery-codes/regenerate');assert.equal(security.status,403);
    const search=await client.call('GET',`/api/v1/organizations/${f.org}/financial/accounts?q=patrimonio`);assert.equal(search.status,200);assert.equal((search.body.data?.['items'] as unknown[]).length,1);
    const query=await client.call('GET',`/api/v1/organizations/${f.org}/financial/accounts?unknown=1`);assert.equal(query.status,422);
  });
  await t.test('W aliases, literal bounded search, cursor binding and TOTP time/replay fail closed',async()=>{
    const f=await setup(group),{client}=await f.https();client.cookies.set('__Host-caudelyx-session',f.a.issued.token);client.csrf=f.a.issued.csrf;
    await f.runtime.finance.mutate(f.a.issued.context,'createAccount',f.org,{code:'A2',name:'Otra cuenta',currency:'COP',accountClass:'ASSET',kind:'BANK'},randomUUID());
    const path=`/API/V1/ORGANIZATIONS/${f.org}/FINANCIAL/ACCOUNTS`;
    for(const suffix of ['/BORROWERS','/LOANS','/LOAN-OPERATIONS/BOOK'])assert.equal((await client.call('GET',`/API/V1/ORGANIZATIONS/${f.org}`+suffix)).status,200);
    for(const prefix of ['/api/v1/organizations/','/API/V1/ORGANIZATIONS/'])assert.equal((await client.call('POST',prefix+f.org+'/financial/accounts',{extra:'x'.repeat(100000)})).status,413);
    assert.equal((await client.call('GET',path)).status,200);assert.equal((await client.call('DELETE',path)).status,405);
    assert.equal((await client.call('GET','/API/V1/AUTH/SESSION/ACTIVITY')).status,405);
    assert.equal(((await client.call('GET',path+'?q=.*')).body.data?.['items'] as unknown[]).length,0);
    assert.equal((await client.call('GET',path+'?q='+('a'.repeat(101)))).status,422);
    const page=await client.call('GET',path+'?limit=1'),cursor=page.body.data?.['nextCursor'];assert.equal(typeof cursor,'string');
    assert.equal((await client.call('GET',path+'?limit=1&q=otra&cursor='+encodeURIComponent(String(cursor)))).status,422);
    const intent=await client.call('POST','/api/v1/auth/step-up/intents',{purpose:'PASSWORD_CHANGE',method:'TOTP'});assert.equal(intent.status,200);
    f.clock.value+=30000;
    for(const offset of [-30000,30000]){
      const invalid=await client.call('POST','/api/v1/auth/step-up/verify',{intentId:intent.body.data?.['intentId'],method:'TOTP',code:await generate({secret:f.a.secret,epoch:Math.floor((f.now()+offset)/1000)})});assert.equal(invalid.status,401);assert.equal(invalid.body.error?.code,'MFA_INVALID');
    }
    const code=await generate({secret:f.a.secret,epoch:Math.floor(f.now()/1000)}),valid=await client.call('POST','/api/v1/auth/step-up/verify',{intentId:intent.body.data?.['intentId'],method:'TOTP',code});assert.equal(valid.status,200);await client.refreshCsrf();
    const again=await client.call('POST','/api/v1/auth/step-up/intents',{purpose:'PASSWORD_CHANGE',method:'TOTP'});
    assert.equal((await client.call('POST','/api/v1/auth/step-up/verify',{intentId:again.body.data?.['intentId'],method:'TOTP',code})).status,401);
    assert.equal((await client.call('GET','/api/v1/auth/me')).status,200);
  });
  await t.test('both read-only mailbox renderers expose No fui yo, correct direct/legacy flags without connecting',async()=>{
    for(const script of ['mailbox-local.mjs','mailbox-installed.mjs']){
      const renderer=await import(new URL('../../../scripts/'+script,import.meta.url).href) as {activationItem:(identity:unknown,message:unknown,token:string,origin:URL)=>Record<string,unknown>};
      const m={purpose:'ACTIVATION',expiresAt:Date.now()+60000,activationNotice:'Confirma solo si fuiste tú',rejectionAction:'REJECT_UNCONFIRMED_ACCOUNT'},origin=new URL('https://localhost:12345');
      const direct=renderer.activationItem({registrationSource:'DIRECT',passwordHash:'synthetic-hash'},m,'synthetic-token',origin);
      assert.equal(direct['requiresPasswordSetup'],false);assert.match(String(direct['rejectionUrl']),/#\/rechazar\?purpose=REJECT/);assert.equal(direct['activationNotice'],m.activationNotice);
      const invited=renderer.activationItem({registrationSource:'INVITATION',passwordHash:null},m,'synthetic-token',origin);assert.equal(invited['requiresPasswordSetup'],true);
      assert.match(String(invited['activationUrl']),/legacy=1/);
    }
  });
  await t.test('real virtual WebAuthn: W first factor, one-shot UV assertion and PLATFORM two-passkey isolation',async()=>{
    const f=await group.fixture(),reg=await f.signup(),confirmed=await f.identity.confirmEmail(reg.issued.context,{purpose:'ACTIVATION',token:reg.token}),https=await f.https();
    const release=group.hold(),receipt=async(event:Record<string,unknown>)=>appendFile('../../Construccion/Sprints/MEJ/Evidencias/MEJ-2-RESOURCES.jsonl',JSON.stringify({task:'MEJ-2',at:new Date().toISOString(),ownerPid:process.pid,resource:'OWN_VIRTUAL_WEBAUTHN_BROWSER',port:https.port,...event})+'\n');
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
      const verified=await f.identity.work!.verify(actor,{intentId:intent.intentId,method:'WEBAUTHN',credential:assertion});
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
});
