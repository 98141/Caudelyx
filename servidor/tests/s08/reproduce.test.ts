import {test} from 'node:test';
import assert from 'node:assert/strict';
import {s08Profile} from './profile.js';
import {cashSetup} from '../s07/fixture.js';
test('H-S7-P05-01 request must accept discrepancy without claiming exact return',{timeout:240000},async()=>{
 const group=await s08Profile();try{const f=await cashSetup(group);const result=await(await f.request()).execute();const id=String((result.data as {entityId:string}).entityId);
 await f.act('dispatchCashDelivery',id,f.c);await f.act('receiveCashDelivery',id,f.o);await f.count(id,'230000.00');
 assert.equal((await f.delivery(id)).state,'DISCREPANCY');
 const requested=await f.act('requestCashDeliveryReturn',id,f.c);
 assert.equal(requested.status,201);assert.equal((await f.delivery(id)).state,'RETURN_REQUIRED');
 }finally{await group.dispose();}
});
