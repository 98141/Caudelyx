import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {wealthContract,wealthClasses,isPersonalWealthCommand} from '../../src/modules/wealth/contract.js';
import {purposeClass,workContract} from '../../src/modules/sessions/work-policy.js';
import {authorizePurpose,normalizeCommand} from '../../src/shared/commands.js';
test('S10 approved 53 operations, 65 schemas and 16 purposes stay closed',()=>{
 const c=wealthContract();assert.equal(c.operations.size,53);assert.equal(Object.keys(c.document.components.schemas).length,65);assert.equal(Object.keys(wealthClasses).length,16);
 for(const [purpose,category]of Object.entries(wealthClasses)){assert.equal(purposeClass(purpose),category);assert.throws(()=>authorizePurpose('PLATFORM',purpose));}
 const bookId=randomUUID(),payload={mode:'VIRTUAL',label:'Ahorro',purpose:'SAVINGS',backingAccountId:randomUUID(),supportReference:'SYN'},command={operationId:'personalCreateFund',bookId,idempotencyKey:randomUUID(),pathParameters:{bookId},payload};
 c.validate('personalCreateFund',payload);assert.throws(()=>c.validate('personalCreateFund',{...payload,ownerId:randomUUID()}));assert.throws(()=>c.validate('personalCreateFund',{...payload,mode:'CUSTODY'}));
 assert.equal(isPersonalWealthCommand('FUND_CREATE',command),true);assert.deepEqual(normalizeCommand('FUND_CREATE',command,s=>s),command);workContract().validate('StepUpPrepare',{purpose:'FUND_CREATE',method:'TOTP',command});
 assert.throws(()=>c.command('FUND_CREATE',{...command,pathParameters:{bookId,organizationId:randomUUID()}}));
 assert.throws(()=>c.validate('Acquisition',{effectiveDate:'2026-10-29',ownedConsideration:200,funding:[]}));
});
