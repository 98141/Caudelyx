import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {RestoreController} from '../../src/shared/restore.js';
import {ProjectionRuntime} from '../../src/modules/reporting/projection/service.js';
import {managementEvidenceMatches,managementHead} from '../../src/modules/obligations/evidence.js';
import type {Event,Data} from '../../src/modules/obligations/models.js';
import {s09Profile} from './profile.js';
import {world,rate,official,code} from './fixture.js';
test('S09 intact/incomplete restore, revoked sessions, startup integrity and tamper-and-undo',{timeout:180000},async()=>{
 const group=await s09Profile();try{
  const f=await world(group),params={bookId:f.book.id},bank=await f.personal('R_BANK','ASSET','BANK'),debt=await f.personal('R_DEBT','LIABILITY'),date='2026-10-28',id=(r:{data:unknown})=>String((r.data as Data)['id']);
  const before=await f.restore.snapshot(),created=await f.mutate('personalCreateLiability',{kind:'PRIVATE_DEBT',label:'Deuda restore',counterpartyReference:'SYN-RESTORE',principal:'1000.00',rate,schedule:official('1000.00'),prepaymentPermissions:[],supportReference:'SYN-RESTORE'},params);
  await f.mutate('personalActivateLiability',{effectiveDate:date,recognitionKind:'CASH_RECEIPT',principalAccountId:debt.id,destinationAccountId:bank.id,legalOwnerReference:'SYN-OWNER',funding:[{kind:'DIRECT_CREDIT',amount:'1000.00'}],supportReference:'SYN-ACTIVATE'},{...params,liabilityId:id(created)},created.etag);const after=await f.restore.snapshot();
  await f.restore.beginRestore(before);await assert.rejects(()=>f.restore.reconcile({approved:true,reviewId:'SYN-INCOMPLETE'}),code('SERVICE_UNAVAILABLE'));assert.equal(f.restore.isOpen(),false);
  await f.restore.beginRestore(after);await f.restore.reconcile({approved:true,reviewId:'SYN-INTACT'});assert.equal(f.restore.isOpen(),true);assert.equal(await f.sessions.findPersonal(f.a.issued.token),null);assert.equal(await managementEvidenceMatches(f.database,(await managementHead(f.database))!),true);
  await f.service.prepareOwned(f.owner);await f.service.activateOwned(f.owner);const restarted=await ProjectionRuntime.createOwned(f.identity,f.keys.cursor,f.owner);f.identity.reporting!.projection=restarted;
  const raw=f.database.client.db(f.database.db.databaseName),event=await raw.collection<Event>('s09_events_personal').findOne({kind:'LIABILITY_ACTIVATE'});assert.ok(event);await raw.collection<Event>('s09_events_personal').updateOne({_id:event._id},{$set:{amount:'999.00'}});await raw.collection<Event>('s09_events_personal').replaceOne({_id:event._id},event);await assert.rejects(()=>f.service.enter());assert.equal(await managementEvidenceMatches(f.database,(await managementHead(f.database))!),true);
  await f.service.stop();await restarted.stop();await raw.collection<Event>('s09_events_personal').deleteOne({_id:event._id});const controller=new RestoreController(f.database,join(group.folder,'gate.json'),f.keys.journal,f.keys.priority,f.keys.cursor);await controller.initialize();assert.equal(controller.isOpen(),false);console.log('S09_RESTORE_PASS intact / before monetary cut / missing originals / session revocation / tamper undo');
 }finally{await group.dispose();}
});
