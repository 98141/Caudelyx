import {test}from'node:test';
import assert from'node:assert/strict';
import {randomUUID,randomBytes}from'node:crypto';
import {fixture,totpActor,stepUp,additionalActor}from'./helpers/fixture.js';
import {OrganizationsService}from'../src/modules/organizations/service.js';
type F=Awaited<ReturnType<typeof fixture>>;
type Actor=Awaited<ReturnType<typeof totpActor>>;
async function makeOwner(f:F,org:OrganizationsService,actor:Actor){
 const command={name:'Synthetic organization',timezone:'America/Bogota',currency:'COP'};
 actor.issued=await stepUp(f,actor.issued.context,actor.secret,'ORGANIZATION_CREATE',undefined,command);
 const created=await org.create(actor.issued.context,command,randomUUID());return{actor,id:created.data.organization.id};
}
async function invite(f:F,org:OrganizationsService,owner:{actor:Actor;id:string},email:string,roleIds=['O']){
 owner.actor.issued=await stepUp(f,owner.actor.issued.context,owner.actor.secret,'MEMBER_INVITE',owner.id,{email,roleIds});
 const result=await org.invite(owner.actor.issued.context,{email,roleIds});assert.equal(result.code,'GENERIC_ACCOUNT_ACTION');
 await f.identity.dispatchMail();const row=await org.invitations.findOne({organizationId:owner.id,email,status:'PENDING'});assert.ok(row);
 const delivered=[...f.messages.notificationInbox.values()].find(n=>n.kind==='INVITATION'&&n.subjectId===row._id);assert.ok(delivered);assert.ok(delivered.payload['token']);return delivered.payload['token'];
}
const preparation=(token:string)=>({mode:'PREPARE',token,privacyPolicyVersion:'synthetic-v1',acceptTerms:true});

test('invitation runtime: encrypted token, PREPARE activation without password, real MFA, atomic CONFIRM/replay and session affiliation',{timeout:120000},async()=>{
 const f=await fixture();try{
  const org=new OrganizationsService(f.identity,randomBytes(32));await org.initialize();const owner=await makeOwner(f,org,await totpActor(f));
  const email=`${randomUUID()}@example.test`,token=await invite(f,org,owner,email,['O','L']);
  assert.ok(!(JSON.stringify(await f.messages.notifications.find({kind:'INVITATION'}).toArray())).includes(token));
  const anonymous=await f.sessions.issue('TENANT','P',null);
  assert.equal((await org.accept(anonymous.context,preparation(token),'prepare')).status,202);
  const pending=await f.identity.identities.findOne({email});assert.ok(pending);assert.equal(pending.passwordHash,null);assert.equal(pending.organizationId,null);
  assert.equal((await org.invitations.findOne({email}))?.status,'PENDING');
  const invitee=await additionalActor(f,email);
  const login=await f.identity.login('TENANT','login-no-factor',email,f.password);
  await assert.rejects(org.accept(login.issued.context,{mode:'CONFIRM',token},'no-factor'));
  const races=await Promise.allSettled([org.accept(invitee.issued.context,{mode:'CONFIRM',token},'accept'),org.accept(invitee.issued.context,{mode:'CONFIRM',token},'accept')]);
  assert.equal(races.filter(r=>r.status==='fulfilled').length,1);
  const identity=await f.identity.identities.findOne({email});assert.ok(identity);assert.equal(identity.organizationId,owner.id);assert.deepEqual(identity.roles,['L','O']);
  assert.equal((await f.sessions.find(invitee.issued.token,'TENANT'))?.kind,'S');
  assert.equal((await org.read(invitee.issued.context)).data.id,owner.id);
  await assert.rejects(org.accept(invitee.issued.context,{mode:'CONFIRM',token},'replay'));
  assert.equal(await f.database.db.collection('audit_events').countDocuments({action:'INVITATION_ACCEPTED'}),1);
 }finally{await f.close();}
});

test('authority loss invalidates issued invitations; recipient PREPARE stays neutral and verified credentials unchanged',{timeout:120000},async()=>{
 const f=await fixture();try{
  const org=new OrganizationsService(f.identity,randomBytes(32));await org.initialize();const root=await makeOwner(f,org,await totpActor(f));
  const admin=await additionalActor(f),token=await invite(f,org,root,admin.email,['A']);await org.accept(admin.issued.context,{mode:'CONFIRM',token},'admin-accept');
  const victimEmail=`${randomUUID()}@example.test`,pendingToken=await invite(f,org,{actor:admin,id:root.id},victimEmail);
  const target=await f.identity.identities.findOne({email:admin.email});assert.ok(target);const hash=target.passwordHash;
  root.actor.issued=await stepUp(f,root.actor.issued.context,root.actor.secret,'MEMBER_ROLE_CHANGE',target._id,{roleIds:['O']});
  await org.roles(root.actor.issued.context,target._id,{roleIds:['O']},target.version);
  assert.equal((await org.invitations.findOne({email:victimEmail}))?.status,'REVOKED');
  const anonymous=await f.sessions.issue('TENANT','P',null);assert.equal((await org.accept(anonymous.context,preparation(pendingToken),'neutral')).status,202);
  assert.equal(await f.identity.identities.findOne({email:victimEmail}),null);
  assert.equal((await f.identity.identities.findOne({_id:target._id}))?.passwordHash,hash);
  await assert.rejects(org.invite(admin.issued.context,{email:`${randomUUID()}@example.test`,roleIds:['A']}));
 }finally{await f.close();}
});

test('two organizations race for one MFA identity: one affiliation wins, and24h invite expiry is exact',{timeout:120000},async()=>{
 const f=await fixture();try{
  const org=new OrganizationsService(f.identity,randomBytes(32));await org.initialize();const one=await makeOwner(f,org,await totpActor(f)),two=await makeOwner(f,org,await additionalActor(f));
  const target=await additionalActor(f),first=await invite(f,org,one,target.email),second=await invite(f,org,two,target.email);
  // Same email may have one pending invitation per organization; tokens never cross tenant authorization.
  const secondRow=await org.invitations.findOne({organizationId:two.id,email:target.email});assert.ok(secondRow);
  const note=[...f.messages.notificationInbox.values()].find(n=>n.subjectId===secondRow._id);assert.ok(note?.payload['token']);
  const races=await Promise.allSettled([org.accept(target.issued.context,{mode:'CONFIRM',token:first},'first'),org.accept(target.issued.context,{mode:'CONFIRM',token:note.payload['token']},'second')]);
  assert.equal(races.filter(r=>r.status==='fulfilled').length,1);assert.equal(await org.invitations.countDocuments({email:target.email,status:'ACCEPTED'}),1);
  const pending=await org.invitations.findOne({email:target.email,status:'PENDING'});assert.ok(pending);f.clock.value=pending.expiresAt;
  const anonymous=await f.sessions.issue('TENANT','P',null);const before=await f.messages.messages.countDocuments();
  const expiredToken=[...f.messages.notificationInbox.values()].find(n=>n.subjectId===pending._id)?.payload['token'];assert.ok(expiredToken);assert.notEqual(first,second);
  assert.equal((await org.accept(anonymous.context,preparation(expiredToken),'expired')).status,202);assert.equal(await f.messages.messages.countDocuments(),before);
 }finally{await f.close();}
});

test('acceptance rollback preserves invitation and strong session; revoked authorization wins before ETag',{timeout:120000},async()=>{
 const f=await fixture();try{
  const org=new OrganizationsService(f.identity,randomBytes(32));await org.initialize();const root=await makeOwner(f,org,await totpActor(f));
  const admin=await additionalActor(f),token=await invite(f,org,root,admin.email,['A']);
  await f.database.db.command({collMod:'audit_events',validator:{$expr:{$ne:['$action','INVITATION_ACCEPTED']}}});
  try{await assert.rejects(org.accept(admin.issued.context,{mode:'CONFIRM',token},'rollback'));}finally{await f.database.db.command({collMod:'audit_events',validator:{}});}
  assert.equal((await f.identity.identities.findOne({email:admin.email}))?.organizationId,null);assert.equal((await org.invitations.findOne({email:admin.email}))?.status,'PENDING');
  assert.equal((await f.sessions.find(admin.issued.token,'TENANT'))?.kind,'S');
  await org.accept(admin.issued.context,{mode:'CONFIRM',token},'retry');
  admin.issued=await stepUp(f,admin.issued.context,admin.secret,'ORGANIZATION_EDIT',root.id,{name:'No longer authorized'});
  const target=await f.identity.identities.findOne({email:admin.email});assert.ok(target);
  root.actor.issued=await stepUp(f,root.actor.issued.context,root.actor.secret,'MEMBER_ROLE_CHANGE',target._id,{roleIds:['O']});await org.roles(root.actor.issued.context,target._id,{roleIds:['O']},target.version);
  await assert.rejects(org.edit(admin.issued.context,{name:'No longer authorized'},undefined),e=>e instanceof Error&&'status'in e&&e.status===401);
  assert.equal((await org.organizations.findOne({_id:root.id}))?.name,'Synthetic organization');
 }finally{await f.close();}
});

test('revokedCount excludes an MFA-issued S whose security version is stale, not merely expired/revoked rows',{timeout:120000},async()=>{
 const f=await fixture();try{
  const org=new OrganizationsService(f.identity,randomBytes(32));await org.initialize();const root=await makeOwner(f,org,await totpActor(f));
  const member=await additionalActor(f),token=await invite(f,org,root,member.email);await org.accept(member.issued.context,{mode:'CONFIRM',token},'join');
  const row=await f.identity.identities.findOne({email:member.email});assert.ok(row);
  // Deliberately stale persisted session fixture: session was genuinely issued by MFA, not a mocked S provider.
  await f.sessions.contexts.updateOne({_id:member.issued.context._id},{$set:{authEpoch:randomUUID()}});
  root.actor.issued=await stepUp(f,root.actor.issued.context,root.actor.secret,'MEMBER_SESSIONS_REVOKE',row._id);
  const result=await org.memberCommand(root.actor.issued.context,row._id,'REVOKE',row.version);assert.equal('revokedCount'in result.data?result.data.revokedCount:-1,0);
 }finally{await f.close();}
});
