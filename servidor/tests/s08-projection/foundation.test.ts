import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Binary,Long} from 'mongodb';
import {ProjectionCodec,hash,orderedPaths,transactionId,type Mutation} from '../../src/modules/reporting/projection/codec.js';
import {originals,derived,collections} from '../../src/modules/reporting/projection/catalog.js';
import {materialize,unpack} from '../../src/modules/reporting/projection/materialize.js';
import {ProjectionRuntime} from '../../src/modules/reporting/projection/service.js';
import type {IdentityService} from '../../src/modules/identity/service.js';
import type {Sources} from '../../src/modules/reporting/models.js';
import {ProjectionFragments} from '../../src/modules/reporting/projection/observer.js';

test('projection MAC purpose, complete body and BSON type are bound',()=>{
  const codec=new ProjectionCodec(Buffer.alloc(32,7)),body={organizationId:'org-a',amount:'300000.00',version:1};
  const mac=codec.seal('HEAD',body);
  assert.equal(codec.verify('HEAD',body,mac),true);
  assert.equal(codec.verify('MANIFEST',body,mac),false);
  assert.equal(codec.verify('HEAD',{...body,organizationId:'org-b'},mac),false);
  assert.equal(codec.verify('HEAD',{...body,amount:'250000.00'},mac),false);
  assert.equal(codec.verify('HEAD',{...body,hidden:true},mac),false);
  assert.equal(codec.verify('HEAD',body,'zz'),false);
  assert.equal(hash({a:1,b:2}),hash({b:2,a:1}));
  assert.notEqual(hash({value:1}),hash({value:Long.fromInt(1)}));
});
test('transaction binding and intermediate mutation paths survive cross-key reorder',()=>{
  const a:Mutation={namespace:'source',key:'a',before:'0',after:'1'},b={...a,key:'b'},a2={...a,before:'1',after:'0'};
  assert.deepEqual(orderedPaths([a,b,a2]),orderedPaths([b,a,a2]));
  assert.notEqual(hash(orderedPaths([a,b,a2])),hash(orderedPaths([a2,b,a])));
  const id=new Binary(Buffer.alloc(16,8));
  assert.notEqual(transactionId(id,1),transactionId(id,2));
  assert.notEqual(transactionId(id,1),transactionId(new Binary(Buffer.alloc(16,9)),1));
});
test('catalog covers all original evidence and keeps manifest/head special handling',()=>{
  assert.equal(originals.size,55);assert.equal(derived.size,4);
  for(const name of ['financial_books','lending_merkle_nodes','lending_merkle_orgs','cash_delivery_allocations','payment_registration_scopes'])assert.equal(originals.has(name),true);
  assert.equal(derived.has(collections.heads),false);assert.equal(derived.has(collections.manifests),false);
});
const emptySource=():Sources=>({loans:[],borrowers:[],positions:[],installments:[],schedules:[],events:[],compensations:[],snapshots:[],
  payments:[],paymentTransitions:[],custody:[],held:[],deliveries:[],facts:[],actions:[],journeys:[],stations:[],bindings:[],reconciliation:[],
  opening:[],accounts:[],journals:[],profile:null,versions:'empty-source',currentDate:'2026-10-27',
  dataThrough:'2026-10-27T12:00:00.000Z',knownThrough:'2026-10-27T12:00:00.000Z'});
test('unrepresentable compact row falls back without truncation or changing logical population',()=>{
  const source=emptySource(),small=materialize(source,'ORG','GEN');
  assert.equal(small.eligible,true);assert.equal(unpack(small.tables.get(collections.units)!,small.tables.get(collections.flows)!).versions,source.versions);
  source.actions.push({_id:'large',organizationId:'ORG',ownerId:'operator',recordedAt:'2026-10-27T11:00:00.000Z',notes:'x'.repeat(5*1024*1024)});
  const large=materialize(source,'ORG','GEN');assert.equal(large.eligible,false);
  assert.equal(large.tables.get(collections.units)!.length,0);assert.deepEqual(large.sourceCounts,{loans:0,events:0,lines:0});
  assert.equal(source.actions.length,1);assert.equal((source.actions[0]!['notes'] as string).length,5*1024*1024);
});
test('persistent owner database is rejected before ownership callback or any Mongo access',async()=>{
  let callback=false;
  const identity={database:{db:{databaseName:'caudelyx_dev'}}} as unknown as IdentityService;
  await assert.rejects(ProjectionRuntime.createOwned(identity,Buffer.alloc(32),async()=>{callback=true;return true;}),
    (error:unknown)=>error instanceof Error&&'status' in error&&error.status===403);
  assert.equal(callback,false);
});
test('fragment assembly requires a complete ordered prefix and enforces the shared byte quota',()=>{
  const first={_id:{opaque:'first'},splitEvent:{fragment:1,of:2},operationType:'update',ns:{db:'owned',coll:'source'},fullDocument:{_id:'a',value:2}};
  const second={_id:{opaque:'last'},splitEvent:{fragment:2,of:2},fullDocumentBeforeChange:{_id:'a',value:1}};
  const frames=new ProjectionFragments();assert.equal(frames.feed(first),null);
  const joined=frames.feed(second)!;assert.deepEqual((joined as unknown as Record<string,unknown>)['fullDocumentBeforeChange'],second.fullDocumentBeforeChange);
  assert.throws(()=>new ProjectionFragments().feed(second));
  const missing=new ProjectionFragments();missing.feed(first);assert.throws(()=>missing.feed({operationType:'insert'}));
  assert.throws(()=>new ProjectionFragments(()=>64*1024*1024).feed(first));
});
