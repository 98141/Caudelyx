import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture,totpActor,stepUp } from './helpers/fixture.js';

test('real T0 restore reconciles external history and never reopens bootstrap after first factor at T1',{timeout:120000},async()=>{
  const f=await fixture({controlledRestore:true});try{
    const controller=f.restore;assert.ok(controller);
    const snapshot=await controller.snapshot();
    await totpActor(f);await controller.flush();
    await controller.beginRestore(snapshot);
    assert.equal(controller.isOpen(),false);
    await assert.rejects(f.identity.login('TENANT','closed',f.email,f.password));
    await controller.reconcile({approved:true,reviewId:'synthetic-test-review-not-a-real-owner-approval'});
    const restored=await f.identity.identities.findOne({email:f.email});assert.ok(restored);
    assert.equal(restored.hasEverConfirmedFactor,true);assert.equal(restored.restoreBootstrapBlocked,true);
    assert.equal(restored.factorCount,0);assert.equal(restored.state,'FACTOR_LOSS_BLOCKED');
    assert.equal(await f.sessions.find(f.initial.token,'TENANT'),null);
    const login=await f.identity.login('TENANT','restored',f.email,f.password);
    await assert.rejects(f.identity.requestEmail('TENANT','initial-repair','INITIAL_MFA_PROOF',null,login.issued.context));
  }finally{await f.close();}
});
test('external evidence gap or signature tampering keeps the whole realm closed, including existing-factor login',{timeout:120000},async()=>{
  const f=await fixture({controlledRestore:true});try{
    const controller=f.restore;assert.ok(controller);await totpActor(f);
    const snapshot=await controller.snapshot();
    await f.database.transaction(async session=>{
      await f.identity.identities.updateOne({email:f.email},{$set:{authzVersion:randomUUID(),roles:['L']}},{session});
      const identity=await f.identity.identities.findOne({email:f.email},{session});assert.ok(identity);
      await f.identity.audit.append({realm:'TENANT',action:'SYNTHETIC_PERMISSION_CHANGE',actorId:identity._id,subjectId:identity._id,outcome:'SUCCESS'},session);
    });
    await controller.flush();
    await f.database.client.db(`${f.database.db.databaseName}_external_security`).collection('events').deleteOne({_id:2 as never});
    await controller.beginRestore(snapshot);
    await assert.rejects(controller.reconcile({approved:true,reviewId:'synthetic-gap-review'}));
    assert.equal(controller.isOpen(),false);
    await assert.rejects(f.identity.login('TENANT','gap-login',f.email,f.password));
    assert.equal(await f.identity.requestEmail('TENANT','gap-reset','RESET',f.email,f.initial.context).then(r=>r.code),'GENERIC_ACCOUNT_ACTION');
  }finally{await f.close();}
});
test('restore does not revive changed password or removed permission values from T0',{timeout:120000},async()=>{
  const f=await fixture({controlledRestore:true});try{
    const controller=f.restore;assert.ok(controller);const actor=await totpActor(f);
    const snapshot=await controller.snapshot();
    const proof=await stepUp(f,actor.issued.context,actor.secret,'PASSWORD_CHANGE');
    await f.identity.changePassword(proof.context,{currentPassword:f.password,newPassword:'new synthetic credential 12349876'});
    await f.database.transaction(async session=>{
      const identity=await f.identity.identities.findOne({email:f.email},{session});assert.ok(identity);
      await f.identity.identities.updateOne({_id:identity._id},{$set:{roles:['L'],suspended:true,state:'SUSPENDED',authzVersion:randomUUID()}},{session});
      await f.identity.audit.append({realm:'TENANT',action:'SYNTHETIC_SUSPEND',actorId:identity._id,subjectId:identity._id,outcome:'SUCCESS'},session);
    });
    await controller.beginRestore(snapshot);await controller.reconcile({approved:true,reviewId:'synthetic-restore-review'});
    const identity=await f.identity.identities.findOne({email:f.email});assert.equal(identity?.passwordHash,null);
    assert.equal(identity?.suspended,true);assert.deepEqual(identity?.roles,['L']);
    await assert.rejects(f.identity.login('TENANT','old-password',f.email,f.password));
    assert.equal(await f.sessions.find(actor.issued.token,'TENANT'),null);
  }finally{await f.close();}
});
