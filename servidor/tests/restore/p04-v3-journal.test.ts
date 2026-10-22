/* eslint-disable security/detect-non-literal-fs-filename -- Own controller fixture paths, never user input. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import { fixture, totpActor } from '../helpers/fixture.js';
import { captureSecurityState, reconstructSecurityState, securitySections, type SecurityEvidence, type SecurityState } from '../../src/shared/evidence.js';
import { AuditWriter } from '../../src/shared/audit.js';
import { RestoreController } from '../../src/shared/restore.js';

function normalized(state: SecurityState) {
  // eslint-disable-next-line security/detect-object-injection -- Fixed section keys in test normalization.
  return JSON.parse(JSON.stringify(Object.fromEntries(securitySections.map(k => [k,[...state[k]].sort((a,b)=>a._id.localeCompare(b._id))]))));
}

test('v3 transactional deltas reconstruct exact state, include tombstones, rollback atomically and checkpoint after projection reset', {timeout:120000}, async()=>{
  const f=await fixture();
  try {
    await totpActor(f);
    const audit=new AuditWriter(f.database), rows=f.database.db.collection<{_id:number;state:SecurityEvidence}>('security_evidence_outbox');
    const check=async()=>{ const events=await rows.find({}).sort({_id:1}).toArray(); const actual=await f.database.transaction(s=>captureSecurityState(f.database,s));
      assert.deepEqual(normalized(reconstructSecurityState(events)),normalized(actual)); return events; };
    await check();
    const factor=await f.sessions.factors.findOne({state:'ACTIVE'}); assert.ok(factor);
    await f.database.transaction(async session=>{
      await f.sessions.factors.deleteOne({_id:factor._id},{session});
      await audit.append({realm:'TENANT',subjectId:factor.subjectId,actorId:factor.subjectId,action:'SYNTHETIC_TOMBSTONE_PROBE',outcome:'SUCCESS'},session);
    });
    assert.ok((await check()).at(-1)?.state.removed?.factors.includes(factor._id));
    const before=JSON.stringify(await rows.find({}).sort({_id:1}).toArray());
    await assert.rejects(f.database.transaction(async session=>{await audit.append({realm:'TENANT',subjectId:factor.subjectId,actorId:factor.subjectId,action:'SYNTHETIC_ROLLBACK_PROBE',outcome:'SUCCESS'},session);throw Error('injected transaction rollback');}));
    assert.equal(JSON.stringify(await rows.find({}).sort({_id:1}).toArray()),before);
    await f.database.transaction(async session=>{
      await f.database.db.collection('security_evidence_projection').deleteMany({},{session});
      await audit.append({realm:'TENANT',subjectId:factor.subjectId,actorId:factor.subjectId,action:'SYNTHETIC_CHECKPOINT_PROBE',outcome:'SUCCESS'},session);
    });
    assert.equal((await check()).at(-1)?.state.reset,true);
    console.log('Delta reconstruction/tombstones/rollback/checkpoint: real replica-set transactions PASS.');
  } finally { await f.close(); }
});

test('v3 peer flush serializes; orphan lock closes current/restarted realm and removal alone never reopens it', {timeout:120000}, async()=>{
  const f=await fixture({controlledRestore:true});
  try {
    const restore=f.restore; assert.ok(restore);
    const peer=new RestoreController(f.database,restore.gatePath,restore.key); await peer.initialize();
    await Promise.all([restore.flush(),peer.flush()]); assert.equal(restore.isOpen(),true); assert.equal(peer.isOpen(),true);
    await writeFile(restore.fileJournal.path+'.lock','');
    const cold=new RestoreController(f.database,restore.gatePath,restore.key);await cold.initialize();assert.equal(cold.isOpen(),false);
    await assert.rejects(restore.flush()); assert.equal(restore.isOpen(),false);
    const restarted=new RestoreController(f.database,restore.gatePath,restore.key);await restarted.initialize();assert.equal(restarted.isOpen(),false);
    await unlink(restore.fileJournal.path+'.lock'); await restore.flush(); assert.equal(restore.isOpen(),false);
    await restore.reconcile({approved:true,reviewId:'SYNTHETIC-OPERATOR-CONTROL-NOT-A-REAL-APPROVAL'}); assert.equal(restore.isOpen(),true);
    console.log('Orphan lock: durable closed realm; operator cleanup alone does not reopen; explicit reconcile checked.');
  } finally { await f.close(); }
});
