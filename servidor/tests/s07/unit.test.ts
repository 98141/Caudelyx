import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validatePortions,denominations,countedState,physicalMovement} from '../../src/modules/collections/engine.js';
import {collectionClasses,isCollectionPurpose,collectionOperations} from '../../src/modules/collections/contract.js';
import type {Delivery} from '../../src/modules/collections/models.js';
test('S07 exact portion sums, unique origins and denominations',()=>{
 const id=randomUUID(),portion={sourcePaymentId:id,sourceCustodyETag:'"'+id+':1"',amount:'250000.00'};
 assert.doesNotThrow(()=>validatePortions([portion],'250000.00'));
 assert.throws(()=>validatePortions([portion,portion],'500000.00'));
 assert.throws(()=>validatePortions([portion],'250000.01'));
 assert.doesNotThrow(()=>denominations([{unitCents:5000000,quantity:5}],25000000n));
 assert.throws(()=>denominations([{unitCents:5000000,quantity:4}],25000000n));
 assert.throws(()=>denominations([{unitCents:5000,quantity:1},{unitCents:5000,quantity:1}],10000n));
 assert.throws(()=>denominations([{unitCents:5000,quantity:1.5}],7500n));
});
test('S07 correction/count guards and disputed physical bridge',()=>{
 const d={state:'RECEIVED_FOR_REVIEW',amount:'250000.00',sourceAccountId:randomUUID(),destinationAccountId:randomUUID(),receivedAt:'2026-10-31T17:00:00Z',lastCount:'230000.00',investigated:false} as Delivery;
 assert.equal(countedState(d,'230000.00'),'DISCREPANCY');assert.equal(countedState(d,'250000.00'),'COUNTED');
 assert.deepEqual(physicalMovement(d),{amount:25000000n,source:d.sourceAccountId,destination:d.destinationAccountId,at:'DESTINATION',observed:23000000n,missing:2000000n,surplus:0n});
 d.investigated=true;d.state='INVESTIGATION';assert.equal(countedState(d,'250000.00'),'INVESTIGATION');
 d.state='CONFIRMED';assert.throws(()=>countedState(d,'250000.00'));assert.equal(physicalMovement(d),null);
});
test('S07 purpose allowlist has no wildcard or privilege fallback',()=>{
 assert.equal(collectionOperations.size,39);assert.equal(Object.keys(collectionClasses).length,22);
 assert.equal(collectionClasses['CASH_STATION_SET'],'SECURITY_ONE_SHOT');
 assert.equal(collectionClasses['CASH_DELIVERY_CONFIRM'],'BALANCE_60M');
 assert.equal(collectionClasses['CASH_DELIVERY_COMPENSATION_CONFIRM'],'BALANCE_60M');
 assert.equal(collectionClasses['CASH_DELIVERY_RECEIVE'],'WORK_ONLY');
 assert.equal(isCollectionPurpose('CASH_DELIVERY_ARBITRARY'),false);
 assert.equal(isCollectionPurpose('__proto__'),false);
});
