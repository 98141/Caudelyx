import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ApiClient } from '../helpers/client.js';
import type { OnboardingFixture } from '../helpers/aj-onb-profile.js';
import { password } from '../helpers/aj-onb-profile.js';

export async function checkHttp(f:OnboardingFixture){
  const {client,port,cert}=await f.https();await client.refreshCsrf();
  const email=randomUUID()+'@example.test';
  const registered=await client.call('POST','/api/v1/auth/register',{email,displayName:'Persona HTTP',password,privacyPolicyVersion:'synthetic-v1',acceptTerms:true});
  assert.equal(registered.status,200);assert.equal(registered.body.data?.['sessionContext'],'B');
  assert(client.cookies.get('__Host-caudelyx-session'));
  assert((registered.headers['set-cookie']??[]).some(c=>c.includes('HttpOnly')&&c.includes('Secure')&&c.includes('SameSite=Lax')));
  await client.refreshCsrf();const me=await client.call('GET','/api/v1/auth/me');assert.equal(me.status,200);
  const profile=me.body.data?.['profile'] as Record<string,unknown>;assert.equal(profile['emailVerified'],false);assert.equal(profile['hasFactor'],false);assert.equal(typeof profile['createdAt'],'string');
  const beforeProfile=(await f.identity.identities.findOne({email}))!;
  assert.equal((await client.call('PATCH','/api/v1/auth/profile',{displayName:'Otro nombre'})).status,428);
  const renamed=await client.call('PATCH','/api/v1/auth/profile',{displayName:'Otro nombre'},{'If-Match':profile['version'] as string});assert.equal(renamed.status,200);
  const afterProfile=(await f.identity.identities.findOne({email}))!;assert.notEqual(afterProfile.version,beforeProfile.version);assert.equal(afterProfile.credentialVersion,beforeProfile.credentialVersion);assert.equal(afterProfile.authzVersion,beforeProfile.authzVersion);
  assert.equal((await client.call('PATCH','/api/v1/auth/profile',{displayName:'No',email:'foreign@example.test'},{'If-Match':renamed.headers.etag!})).status,422);
  assert.equal((await client.call('PATCH','/api/v1/auth/profile',{displayName:'Obsoleto'},{'If-Match':profile['version'] as string})).status,412);
  const org=randomUUID();
  for(const [method,path,body]of [
    ['POST','/api/v1/organizations',{name:'Prueba',timezone:'America/Bogota',currency:'COP'}],
    ['GET','/api/v1/organization',undefined],
    ['POST','/api/v1/organization/invitations',{email:'invite@example.test',roleIds:['L']}],
    ['GET',`/api/v1/organizations/${org}/financial/accounts`,undefined],
    ['POST',`/api/v1/organizations/${org}/financial/accounts`,{code:'UNUSED',name:'Caja',accountClass:'ASSET',kind:'CASH',currency:'COP'}],
    ['GET',`/api/v1/organizations/${org}/financial/openings`,undefined],
  ] as const){
    const denied=await client.call(method,path,body);assert.equal(denied.status,403,method+' '+path);assert.equal(denied.body.error?.code,'EMAIL_NOT_VERIFIED',path);
  }
  const noCsrf=await client.call('POST','/api/v1/organizations',{name:'Prueba',timezone:'America/Bogota',currency:'COP'},{'X-CSRF-Token':'wrong'});assert.equal(noCsrf.status,400);
  const malformed=await client.call('POST',`/api/v1/organizations/${org}/financial/accounts`,{code:'ONLY'});assert.equal(malformed.status,422);
  await f.identity.dispatchMail();const subject=(await f.identity.identities.findOne({email}))!;
  const support=randomUUID(),snapshot={cutoffDate:'2020-01-01',supports:[{id:support,reference:'SYNTHETIC-MATRIX',asOfDate:'2020-01-01',declaration:'OWNER_CHECKED'}],references:[],components:[{id:randomUUID(),category:'BANK',accountId:randomUUID(),amount:'1.00',supportIds:[support]}],historicalInterest:[],informationalHistory:[]};
  const business=[
    ['GET','/api/v1/organization',undefined],['POST','/api/v1/organizations',{name:'Matriz',timezone:'America/Bogota',currency:'COP'}],
    ['GET','/api/v1/organization/invitations',undefined],['POST','/api/v1/organization/invitations',{email:'matrix@example.test',roleIds:['L']}],
    ['POST','/api/v1/auth/invitations/accept',{mode:'CONFIRM',token:'A'.repeat(43)}],
    ['GET',`/api/v1/organizations/${org}/financial/accounts`,undefined],
    ['POST',`/api/v1/organizations/${org}/financial/accounts`,{code:'MATRIX',name:'Caja',accountClass:'ASSET',kind:'CASH',currency:'COP'}],
    ['GET',`/api/v1/organizations/${org}/financial/openings`,undefined],['POST',`/api/v1/organizations/${org}/financial/openings`,{snapshot}],
  ] as const;
  for(const role of ['T','A','O','C','P','L','SA']){
    await f.identity.identities.updateOne({_id:subject._id},{$set:{roles:[role]}});
    for(const[method,path,body]of business){const denied=await client.call(method,path,body);assert.equal(denied.status,403,role+' '+method+' '+path);assert.equal(denied.body.error?.code,'EMAIL_NOT_VERIFIED',role+' '+path);assert.equal(denied.body.data,undefined);}
  }
  await f.identity.identities.updateOne({_id:subject._id},{$set:{roles:[]}});
  const mail=[...f.messages.inbox.values()].find(m=>m.subjectId===subject._id&&m.purpose==='ACTIVATION')!;
  const other=new ApiClient(port,cert);await other.refreshCsrf();
  assert.equal((await other.call('POST','/api/v1/auth/email-verifications/confirm',{purpose:'ACTIVATION',token:mail.token,newPassword:password})).status,422);
  const foreign=await f.signup(),foreignClient=new ApiClient(port,cert);foreignClient.cookies.set('__Host-caudelyx-session',foreign.issued.token);await foreignClient.refreshCsrf();
  assert.equal((await foreignClient.call('POST','/api/v1/auth/email-verifications/confirm',{purpose:'ACTIVATION',token:mail.token})).status,403);
  const confirm=await other.call('POST','/api/v1/auth/email-verifications/confirm',{purpose:'ACTIVATION',token:mail.token});assert.equal(confirm.status,200);assert.equal(confirm.body.data?.['emailVerified'],true);
  assert.equal((await other.call('GET','/api/v1/auth/me')).status,401); // Only a fresh anonymous P was rotated.
  for(const path of ['/api/v1/organization',`/api/v1/organizations/${org}/financial/accounts`,`/api/v1/organizations/${org}/financial/openings`]){
    const denied=await client.call('GET',path);assert.equal(denied.status,403);assert.equal(denied.body.error?.code,'MFA_REQUIRED');
  }
  for(const role of ['T','A','O','C','P','L','SA']){
    await f.identity.identities.updateOne({_id:subject._id},{$set:{roles:[role]}});
    for(const[method,path,body]of business){const denied=await client.call(method,path,body);assert.equal(denied.status,403,role+' '+method+' '+path);assert.equal(denied.body.error?.code,'MFA_REQUIRED',role+' '+path);assert.equal(denied.body.data,undefined);}
  }
  await f.identity.identities.updateOne({_id:subject._id},{$set:{roles:[]}});
  const platform=new ApiClient(port,cert,'platform.localhost');platform.cookies.set('__Host-caudelyx-session',client.cookies.get('__Host-caudelyx-session')!);
  assert.equal((await platform.call('GET','/api/v1/auth/me')).status,401);
  assert.equal((await platform.call('GET',`/api/v1/organizations/${org}/financial/accounts`)).status,403);
  const anonymous=new ApiClient(port,cert);await anonymous.refreshCsrf();assert.equal((await anonymous.call('GET','/api/v1/organization')).status,401);
  assert.equal((await client.call('POST','/api/v1/auth/reauthenticate',{password,purpose:'ORGANIZATION_CREATE',command:{name:'No B',timezone:'America/Bogota',currency:'COP'}})).status,403);
  const methods=await client.call('GET','/api/v1/auth/mfa/methods');assert.equal(methods.status,200);
  assert.equal((await client.call('POST','/api/v1/auth/mfa/totp/enrollments',{label:'HTTP'})).status,401);
  assert.equal((await client.call('POST','/api/v1/auth/mfa/totp/enrollments',{label:'HTTP',password})).status,201);
  const duplicate=new ApiClient(port,cert);await duplicate.refreshCsrf();
  const exists=await duplicate.call('POST','/api/v1/auth/register',{email,displayName:'No sobrescribir',password,privacyPolicyVersion:'synthetic-v1',acceptTerms:true});assert.equal(exists.status,409);assert.equal(exists.body.error?.code,'ACCOUNT_ALREADY_EXISTS');
  assert(!duplicate.cookies.get('__Host-caudelyx-session'));
  const unwanted=await f.signup(),rejector=new ApiClient(port,cert);await rejector.refreshCsrf();
  const landing=await rejector.call('GET','/api/v1/auth/registrations/reject');assert.notEqual(landing.status,204);assert(await f.identity.identities.findOne({_id:unwanted.subject._id}));
  assert.equal((await rejector.call('POST','/api/v1/auth/password-reset/request',{email:unwanted.email})).status,202);await f.identity.dispatchMail();
  const resetToken=[...f.messages.inbox.values()].find(m=>m.subjectId===unwanted.subject._id&&m.purpose==='RESET')!.token;
  assert.equal((await rejector.call('POST','/api/v1/auth/registrations/reject',{token:resetToken})).status,401);
  assert.equal((await rejector.call('POST','/api/v1/auth/registrations/reject',{token:unwanted.token})).status,204);assert.equal(await f.identity.identities.findOne({_id:unwanted.subject._id}),null);
  await f.database.db.collection('financial_journals').countDocuments().then(count=>assert.equal(count,0));
  await f.database.close();assert.equal((await client.call('GET','/api/v1/auth/me')).status,503);assert.equal((await client.call('GET',`/api/v1/organizations/${org}/financial/accounts`)).status,503);
}
