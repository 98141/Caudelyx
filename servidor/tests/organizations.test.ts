import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { fixture,totpActor,stepUp } from './helpers/fixture.js';
import { OrganizationsService } from '../src/modules/organizations/service.js';
import { RecoveryService } from '../src/modules/recovery/service.js';
import type { Context } from '../src/modules/identity/models.js';

test('real member administration hides recovery, counts only live S and enforces tenant/hierarchy before ETag',{timeout:120000},async()=>{
  const f=await fixture();try{
    const admin=await totpActor(f),org=new OrganizationsService(f.identity,randomBytes(32));await org.initialize();
    const recovery=new RecoveryService(f.identity,f.lifecycle),organizationId=randomUUID(),epoch=randomUUID();
    await org.organizations.insertOne({_id:organizationId,name:'Synthetic',timezone:'America/Bogota',currency:'COP',status:'ACTIVE',version:'"org-v1"',authEpoch:epoch});
    await f.identity.identities.updateOne({_id:admin.issued.context.subjectId!},{$set:{organizationId,state:'ACTIVE',roles:['T']}});
    await f.sessions.contexts.updateOne({_id:admin.issued.context._id},{$set:{organizationEpoch:epoch}});
    const adminContext={...admin.issued.context,organizationEpoch:epoch};
    const email=`${randomUUID()}@example.test`,anonymous=await f.sessions.issue('TENANT','P',null);
    await f.identity.register('TENANT','member',{email,displayName:'Synthetic member',privacyPolicyVersion:'synthetic-v1'});await f.identity.dispatchMail();
    const pendingMember=await f.identity.identities.findOne({email});assert.ok(pendingMember);
    const mail=[...f.messages.inbox.values()].find(value=>value.subjectId===pendingMember._id);assert.ok(mail);
    const initial=await f.identity.confirmEmail(anonymous.context,{purpose:'ACTIVATION',token:mail.token,newPassword:f.password});
    const member=await totpActor({...f,initial:initial.issued,email});
    await f.identity.identities.updateOne({_id:member.issued.context.subjectId!},{$set:{organizationId,state:'ACTIVE',roles:['O']}});
    await f.sessions.contexts.updateOne({_id:member.issued.context._id},{$set:{organizationEpoch:epoch}});
    const memberContext={...member.issued.context,organizationEpoch:epoch};
    const memberRow=await f.identity.identities.findOne({_id:memberContext.subjectId!});assert.ok(memberRow);
    const before=await org.members(adminContext);
    const proof=await stepUp(f,memberContext,member.secret,'RECOVERY_CODES_REGENERATE');
    const codes=await recovery.regenerate(proof.context);
    const login=await f.identity.login('TENANT','member-recovery',email,f.password);
    const started=await recovery.start(login.issued.context,codes.codes[0]!,'member-recovery');
    const during=await org.members(adminContext);assert.deepEqual(during,before);
    const roleProof=await stepUp(f,adminContext,admin.secret,'MEMBER_ROLE_CHANGE',memberRow._id,{roleIds:['O','L']});
    const changed=await org.roles(roleProof.context,memberRow._id,{roleIds:['O','L']},memberRow.version);assert.deepEqual(Object.keys(changed.data).sort(),['roleIds','userId','version']);memberRow.version=changed.etag;
    const projected=(await org.members(roleProof.context)).items.find(m=>m.userId===memberRow._id);assert.ok(projected);assert.equal(projected.status,'ACTIVE');assert.equal('expiresAt'in projected,false);
    const revokeProof=await stepUp(f,roleProof.context,admin.secret,'MEMBER_SESSIONS_REVOKE',memberRow._id);
    const result=await org.memberCommand(revokeProof.context,memberRow._id,'REVOKE',memberRow.version);
    assert.equal('revokedCount'in result.data?result.data.revokedCount:-1,0);
    const recoveryContext=await f.sessions.contexts.findOne({_id:started.issued.context._id});assert.ok(recoveryContext);
    assert.equal(recoveryContext.kind,'E_RECOVERY'); // Context is not included in revokedCount.
    const freshAdmin=await f.sessions.contexts.findOne({_id:revokeProof.context._id});assert.ok(freshAdmin);
    await assert.rejects(org.memberCommand(freshAdmin,memberRow._id,'SUSPEND',undefined),error=>error instanceof Error&&'status'in error&&error.status===428);
    await assert.rejects(org.memberCommand(freshAdmin,memberRow._id,'SUSPEND','"stale"'),error=>error instanceof Error&&'status'in error&&error.status===412);
    await assert.rejects(org.memberCommand(freshAdmin,adminContext.subjectId!,'SUSPEND',undefined),error=>error instanceof Error&&'status'in error&&error.status===403);
    const otherOrg=randomUUID();await f.identity.identities.updateOne({_id:memberRow._id},{$set:{organizationId:otherOrg}});
    await assert.rejects(org.memberCommand(freshAdmin,memberRow._id,'SUSPEND',undefined),error=>error instanceof Error&&'status'in error&&error.status===404);
    assert.equal(await f.database.db.collection('audit_events').countDocuments({action:'MEMBER_REVOKE'}),1);
    assert.equal((await org.members(freshAdmin as Context)).items.length,1);
    const orgProof=await stepUp(f,freshAdmin,admin.secret,'ORGANIZATION_SESSIONS_REVOKE',organizationId);
    const revoked=await org.revokeOrganization(orgProof.context,'"org-v1"');assert.equal(revoked.revokedCount,1);assert.equal(await f.sessions.find(orgProof.token,'TENANT'),null);
  }finally{await f.close();}
});
