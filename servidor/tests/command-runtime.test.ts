import {test}from'node:test';
import assert from'node:assert/strict';
import {randomBytes,randomUUID}from'node:crypto';
import {generate}from'otplib';
import {fixture,totpActor,stepUp}from'./helpers/fixture.js';
import {OrganizationsService}from'../src/modules/organizations/service.js';
import type{Context}from'../src/modules/identity/models.js';
const organization={name:'Synthetic organization',timezone:'America/Bogota',currency:'COP'};
const status=(n:number)=>(e:unknown)=>e instanceof Error&&'status'in e&&e.status===n;

test('real command-bound R: different payload denied without consuming; concurrent idempotent A08 creates one affiliation',{timeout:120000},async()=>{
 const f=await fixture();try{
  const org=new OrganizationsService(f.identity,randomBytes(32));await org.initialize();const actor=await totpActor(f);
  await assert.rejects(f.identity.reauthenticate(actor.issued.context,{password:f.password,purpose:'ORGANIZATION_CREATE',command:{...organization,version:'client'}}),status(422));
  const proof=await stepUp(f,actor.issued.context,actor.secret,'ORGANIZATION_CREATE',undefined,organization);
  await assert.rejects(org.create(proof.context,{...organization,name:'Changed after factor'},'synthetic-key-000001'),status(403));
  assert.equal((await f.sessions.contexts.findOne({_id:proof.context._id}))?.reauth?.consumed,false);
  const results=await Promise.all([org.create(proof.context,organization,'synthetic-key-000001'),org.create(proof.context,organization,'synthetic-key-000001')]);
  assert.deepEqual(results[0],results[1]);assert.equal(await org.organizations.countDocuments(),1);
  const subject=await f.identity.identities.findOne({_id:proof.context.subjectId!});assert.ok(subject);assert.deepEqual(subject.roles,['T']);assert.equal(subject.organizationId,results[0]!.data.organization.id);
  await assert.rejects(org.create(proof.context,{...organization,name:'Other'},'synthetic-key-000001'),status(409));
  await assert.rejects(org.create(proof.context,organization,'synthetic-key-000002'),status(409));
  assert.equal(await f.database.db.collection('audit_events').countDocuments({action:'ORGANIZATION_CREATED'}),1);
  assert.equal(await f.identity.messaging.notifications.countDocuments({kind:'ORGANIZATION_CREATED'}),1);
 }finally{await f.close();}
});

test('real A10 commit precedence: stale If-Match412 before snapshot403; valid If-Match with old snapshot403, without consuming',{timeout:120000},async()=>{
 const f=await fixture();try{
  const org=new OrganizationsService(f.identity,randomBytes(32));await org.initialize();const actor=await totpActor(f);
  const create=await stepUp(f,actor.issued.context,actor.secret,'ORGANIZATION_CREATE',undefined,organization);
  const created=await org.create(create.context,organization,'synthetic-version-key'),id=created.data.organization.id;
  const first=await stepUp(f,create.context,actor.secret,'ORGANIZATION_EDIT',id,{name:'First'});
  f.clock.value+=30000;const login=await f.identity.login('TENANT','second-edit',f.email,f.password);
  const second=await f.totp.authenticate(login.issued.context,await generate({secret:actor.secret,epoch:Math.floor(f.now()/1000)}),'LOGIN',null);
  const secondProof=await stepUp(f,second.issued.context,actor.secret,'ORGANIZATION_EDIT',id,{name:'Second'});
  const updated=await org.edit(secondProof.context,{name:'Second'},created.etag);
  await assert.rejects(org.edit(first.context,{name:'First'},created.etag),status(412));
  await assert.rejects(org.edit(first.context,{name:'First'},updated.etag),status(403));
  assert.equal((await f.sessions.contexts.findOne({_id:first.context._id}))?.reauth?.consumed,false);
  assert.equal((await org.organizations.findOne({_id:id}))?.name,'Second');
 }finally{await f.close();}
});

test('real transaction rollback keeps command R usable and commits no org/idempotency/outbox/notification',{timeout:120000},async()=>{
 const f=await fixture();try{
  const org=new OrganizationsService(f.identity,randomBytes(32));await org.initialize();const actor=await totpActor(f);
  const proof=await stepUp(f,actor.issued.context,actor.secret,'ORGANIZATION_CREATE',undefined,organization);
  await f.database.db.command({collMod:'audit_events',validator:{$expr:{$ne:['$action','ORGANIZATION_CREATED']}}});
  try{await assert.rejects(org.create(proof.context,organization,'synthetic-rollback-key'));}finally{await f.database.db.command({collMod:'audit_events',validator:{}});}
  assert.equal(await org.organizations.countDocuments(),0);assert.equal(await org.idempotency.countDocuments(),0);
  assert.equal(await f.identity.messaging.notifications.countDocuments({kind:'ORGANIZATION_CREATED'}),0);
  assert.equal((await f.sessions.contexts.findOne({_id:proof.context._id}))?.reauth?.consumed,false);
  await org.create(proof.context,organization,'synthetic-rollback-key');assert.equal(await org.organizations.countDocuments(),1);
 }finally{await f.close();}
});

test('MFA intent is server-reserved, bound to type/label and consumed once; PLATFORM rejects tenant/TOTP before intent',{timeout:120000},async()=>{
 const f=await fixture();try{
  const actor=await totpActor(f);
  for(const input of [{purpose:'ORGANIZATION_CREATE',command:organization},{purpose:'MFA_ENROLL',command:{methodType:'TOTP',label:'Denied'}}]){
   await assert.rejects(f.identity.reauthenticate({...actor.issued.context,realm:'PLATFORM'} as Context,{password:f.password,...input}),status(403));
  }
  assert.equal((await f.sessions.contexts.findOne({_id:actor.issued.context._id}))?.reauth,null);
  await assert.rejects(f.identity.reauthenticate(actor.issued.context,{password:f.password,purpose:'MFA_ENROLL',command:{methodType:'TOTP',label:'New',enrollmentIntent:randomUUID()}}),status(422));
  const proof=await stepUp(f,actor.issued.context,actor.secret,'MFA_ENROLL',undefined,{methodType:'TOTP',label:'New'});
  const current=await f.sessions.contexts.findOne({_id:proof.context._id});assert.ok(current?.reauth?.enrollmentIntent);
  await assert.rejects(f.totp.enroll(proof.context,'Substituted'),status(403));
  const enrolled=await f.totp.enroll(proof.context,'New');assert.equal(enrolled.enrollmentId,current.reauth.enrollmentIntent);
  await assert.rejects(f.totp.enroll(proof.context,'New'),status(403));
  const secret=new URL(enrolled.provisioningUri).searchParams.get('secret');assert.ok(secret);
  const result=await f.totp.confirm(proof.context,enrolled.enrollmentId,await generate({secret,epoch:Math.floor(f.now()/1000)}));
  assert.equal(result.data.nextAction,'LOGIN');assert.equal(await f.sessions.find(proof.token,'TENANT'),null);
 }finally{await f.close();}
});
