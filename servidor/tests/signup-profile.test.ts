import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {generate} from 'otplib';
import {fixture} from './helpers/fixture.js';
import {AppError} from '../src/shared/errors.js';
const password='synthetic profile password 1357924680';
const denied=(code:string)=>(error:unknown)=>error instanceof AppError&&error.code===code;

async function provisional(f:Awaited<ReturnType<typeof fixture>>,email=`${randomUUID()}@example.test`,name='Persona perfil',pwd=password){
 const p=await f.sessions.issue('TENANT','P',null);
 await f.identity.register('TENANT',randomUUID(),{mode:'PROFILE',email,displayName:name,password:pwd,privacyPolicyVersion:'synthetic-v1'},p.context);
 const intent=await f.identity.registrations.findOne({_id:p.context._id});assert.ok(intent);
 return{p,intent,email};
}

test('PROFILE provisional runtime: own entered data, no real login before email, bound link establishes credential, then actual TOTP is required for S',{timeout:120000},async()=>{
 const f=await fixture();try{
  const a=await provisional(f,undefined,'  Persona perfil  ');
  let subject=await f.identity.identities.findOne({email:a.email});assert.ok(subject);const id=subject._id,oldVersion=subject.credentialVersion;
  assert.equal(subject.passwordHash,null);assert.ok(a.intent.passwordHash.startsWith('$argon2id$'));
  const profile=await f.identity.registrationProfile(a.p.context);assert.equal(profile?.authState,'EMAIL_REQUIRED');assert.equal(profile?.profile.displayName,'Persona perfil');assert.equal(profile?.profile.emailVerified,false);
  await assert.rejects(f.identity.login('TENANT',randomUUID(),a.email,password),denied('AUTH_INVALID'));
  await assert.rejects(f.totp.enroll(a.p.context,'No antes del correo'),denied('AUTH_INVALID'));
  await f.identity.requestEmail('TENANT',randomUUID(),'RESET',a.email,a.p.context);await f.identity.dispatchMail();
  assert.equal(await f.messages.proofs.countDocuments({subjectId:id,purpose:'RESET'}),0);
  const mail=[...f.messages.inbox.values()].find(m=>m.subjectId===id&&m.purpose==='ACTIVATION');assert.ok(mail);
  const input={purpose:'ACTIVATION' as const,mode:'LINK' as const,token:mail.token};
  const other=await f.sessions.issue('TENANT','P',null);
  await assert.rejects(f.identity.confirmEmail(other.context,input),denied('TOKEN_INVALID'));
  const wrong=await provisional(f);await assert.rejects(f.identity.confirmEmail(wrong.p.context,input),denied('TOKEN_INVALID'));
  const loggedOther=await f.identity.login('TENANT',randomUUID(),f.email,f.password);
  await assert.rejects(f.identity.confirmEmail(loggedOther.issued.context,input),denied('AUTH_INVALID'));
  f.clock.value+=30000;
  const initial=await f.identity.confirmEmail(a.p.context,input);
  assert.equal(initial.issued.context.kind,'E_INITIAL');assert.equal(initial.issued.context.passwordAt,a.intent.passwordAt);
  assert.ok(initial.issued.context.expiresAt<=a.intent.passwordAt+300000);assert.ok(initial.issued.context.expiresAt<=a.p.context.expiresAt);
  subject=await f.identity.identities.findOne({email:a.email});assert.ok(subject);assert.ok(subject.passwordHash===a.intent.passwordHash);assert.ok(subject.credentialVersion!==oldVersion);
  assert.equal(subject.state,'MFA_ENROLLMENT');assert.equal(await f.identity.registrationProfile(a.p.context),null);
  await assert.rejects(f.identity.confirmEmail(initial.issued.context,input));
  const enrollment=await f.totp.enroll(initial.issued.context,'App sintética'),secret=new URL(enrollment.provisioningUri).searchParams.get('secret');assert.ok(secret);
  const factor=await f.totp.confirm(initial.issued.context,enrollment.enrollmentId,await generate({secret,epoch:Math.floor(f.now()/1000)}));assert.equal(factor.issued?.context.kind,'S');
  for(const name of ['registration_intents','audit_events','outbox','security_evidence_outbox']){const stored=JSON.stringify(await f.database.db.collection(name).find({}).toArray());assert.equal(stored.includes(password),false);assert.equal(stored.includes(mail.token),false);assert.equal(stored.includes(secret),false);}
 }finally{await f.close();}
});

test('PROFILE races preserve every private browser intent; first admitted password is stable; expired/private-cookie loss uses fresh legacy initial setup without exposing account activation to other P',{timeout:120000},async()=>{
 const f=await fixture();try{
  const email=`${randomUUID()}@example.test`,otherPassword='synthetic competing password 9876543210';
  const contexts=[await f.sessions.issue('TENANT','P',null),await f.sessions.issue('TENANT','P',null)] as const;
  const results=await Promise.all(contexts.map((p,i)=>f.identity.register('TENANT',randomUUID(),{mode:'PROFILE',email,displayName:`Persona ${i}`,password:i?otherPassword:password,privacyPolicyVersion:'synthetic-v1'},p.context)));
  assert.ok(results.every(r=>r.code==='GENERIC_ACCOUNT_ACTION'));assert.equal(await f.identity.identities.countDocuments({email}),1);
  const first=await f.identity.registrations.findOne({_id:contexts[0].context._id}),second=await f.identity.registrations.findOne({_id:contexts[1].context._id});assert.ok(first&&second);
  const beforeOther=await f.identity.registrationProfile(contexts[1].context);assert.ok(beforeOther);
  const oldHash=first.passwordHash;
  await f.identity.register('TENANT',randomUUID(),{mode:'PROFILE',email,displayName:'No reemplazar',password:otherPassword,privacyPolicyVersion:'different-v1'},contexts[0].context);
  const again=await f.identity.registrations.findOne({_id:first._id});assert.ok(again);assert.ok(again.passwordHash===oldHash);assert.equal(again.displayName,first.displayName);
  const subject=await f.identity.identities.findOne({email});assert.ok(subject);assert.equal(subject.passwordHash,null);
  await f.identity.dispatchMail();const mail=[...f.messages.inbox.values()].find(m=>m.subjectId===subject._id&&m.purpose==='ACTIVATION');assert.ok(mail);
  f.clock.value=first.passwordAt+300000;
  await assert.rejects(f.identity.confirmEmail(contexts[0].context,{purpose:'ACTIVATION',mode:'LINK',token:mail.token}),denied('TOKEN_INVALID'));
  const fresh=await f.sessions.issue('TENANT','P',null),freshPassword='synthetic fresh initial password 2468013579';
  const initial=await f.identity.confirmEmail(fresh.context,{purpose:'ACTIVATION',token:mail.token,newPassword:freshPassword});assert.equal(initial.issued.context.kind,'E_INITIAL');
  assert.equal(initial.issued.context.passwordAt,f.now());
  assert.deepEqual(await f.identity.registrationProfile(contexts[1].context),beforeOther,'another P cannot observe real-account activation');
  assert.equal((await f.identity.login('TENANT',randomUUID(),email,freshPassword)).data.authState,'MFA_ENROLLMENT');
 }finally{await f.close();}
});

test('PROFILE restore before email confirmation never revives bootstrap after verification at T1, even without a first factor',{timeout:120000},async()=>{
 const f=await fixture({controlledRestore:true});try{
  const r=f.restore;assert.ok(r);const a=await provisional(f);await f.identity.dispatchMail();const subject=await f.identity.identities.findOne({email:a.email});assert.ok(subject);
  const mail=[...f.messages.inbox.values()].find(m=>m.subjectId===subject._id&&m.purpose==='ACTIVATION');assert.ok(mail);
  const snapshot=await r.snapshot();await f.identity.confirmEmail(a.p.context,{purpose:'ACTIVATION',mode:'LINK',token:mail.token});await r.flush();
  const verified=await f.identity.identities.findOne({email:a.email});assert.ok(verified);assert.ok(verified.credentialVersion!==subject.credentialVersion);assert.ok(verified.passwordHash);
  await r.beginRestore(snapshot);await r.reconcile({approved:true,reviewId:'SYNTHETIC-PROFILE-RESTORE-NOT-OWNER-APPROVAL'});
  const restored=await f.identity.identities.findOne({email:a.email});assert.ok(restored);assert.equal(restored.restoreBootstrapBlocked,true);assert.equal(await f.identity.eligible(restored),false);
  assert.equal(await f.identity.registrations.countDocuments(),0);await assert.rejects(f.identity.login('TENANT',randomUUID(),a.email,password),denied('AUTH_INVALID'));
 }finally{await f.close();}
});
