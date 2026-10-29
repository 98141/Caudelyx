import {test} from 'node:test';
import assert from 'node:assert/strict';
import {managementContract} from '../../src/modules/obligations/contract.js';
test('S09 exact candidate contract rejects forged scope and money numbers before DB',()=>{
 const c=managementContract();assert.equal(c.operations.size,62);assert.throws(()=>c.validate('createPersonalBook',{currency:'COP',ownerId:'forged'}));
 const body={nominalDate:'2026-10-28',dueDate:'2026-10-30',description:'Sintético',category:'SERVICES',amountMode:'FIXED',amount:'100000.00',supportReference:'SYN'};
 c.validate('personalCreateExpense',body);assert.throws(()=>c.validate('personalCreateExpense',{...body,amount:100000}));
});
