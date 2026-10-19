import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/fixture.js';
import { SyntheticMessaging } from '../src/modules/messaging/service.js';
import {totpActor}from'./helpers/fixture.js';

test('synthetic mail crash after durable sink, lease expiry and second instance retry is idempotent',{timeout:90000},async()=>{
  const f=await fixture();try{
    const context=await f.sessions.issue('TENANT','P',null);
    await f.identity.requestEmail('TENANT','restart-source','RESET',f.email,context.context);
    const mail=await f.messages.messages.findOne({purpose:'RESET',delivered:false});assert.ok(mail);
    await assert.rejects(f.messages.deliver(async()=>true,()=>{throw new Error('synthetic process crash after sink');}));
    assert.equal((await f.messages.messages.findOne({_id:mail._id}))?.delivered,false);
    const restart=new SyntheticMessaging(f.database,f.mailKey,f.now);
    await restart.deliver(async()=>true);assert.equal(restart.inbox.size,0); // Lease still belongs to failed worker.
    f.clock.value+=30001;
    await Promise.all([restart.deliver(async()=>true),f.messages.deliver(async()=>true)]);
    assert.equal((await f.messages.messages.findOne({_id:mail._id}))?.delivered,true);
    const sink=f.database.client.db(`${f.database.db.databaseName}_external_mail`).collection('delivered');
    assert.equal(await sink.countDocuments({_id:mail._id as never}),1);
    const stored=await sink.findOne({_id:mail._id as never});assert.ok(stored);
    assert.equal('token' in stored,false);assert.ok(!JSON.stringify(stored).includes('a long synthetic password'));
  }finally{await f.close();}
});

test('security notifications are encrypted, durable and idempotent after sink-before-ack crash and a second worker',{timeout:90000},async()=>{
 const f=await fixture();try{
  await totpActor(f);f.messages.notificationAllowed=async()=>true;
  const note=await f.messages.notifications.findOne({kind:'MFA_FACTOR_ACTIVATED'});assert.ok(note);assert.equal('payload'in note,false);
  await assert.rejects(f.messages.deliverNotifications(()=>{throw Error('synthetic crash after sink');}));
  assert.equal((await f.messages.notifications.findOne({_id:note._id}))?.delivered,false);
  f.clock.value+=30001;const second=new SyntheticMessaging(f.database,f.mailKey,f.now);second.notificationAllowed=async()=>true;
  await Promise.all([second.deliverNotifications(),f.messages.deliverNotifications()]);
  assert.equal((await f.messages.notifications.findOne({_id:note._id}))?.delivered,true);
  assert.equal(await f.database.client.db(`${f.database.db.databaseName}_external_mail`).collection('notifications').countDocuments({_id:note._id as never}),1);
 }finally{await f.close();}
});
