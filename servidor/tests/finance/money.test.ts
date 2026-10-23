import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { balanced,cents,money,decimal,storedCents,MAX_CENTS } from '../../src/modules/finance/money.js';
import { financeContract,canonical,financePurposes } from '../../src/modules/finance/contract.js';
import { FrozenContract } from '../../src/shared/contract.js';

test('exact COP centavos, Decimal128 roundtrip and approved range without Number rounding',()=>{
  assert.equal(money(cents('0.10')+cents('0.20')),'0.30');assert.equal(money(MAX_CENTS),'9999999999999999.99');
  assert.equal(storedCents(decimal('9999999999999999.99')),MAX_CENTS);assert.equal(money(0n),'0.00');assert.equal(money(-1n),'-0.01');
  for(const invalid of ['1.005','1e3','01.00','1,00','1.999','-0.00','10000000000000000.00'])assert.throws(()=>cents(invalid));
  assert.throws(()=>money(MAX_CENTS+1n));
});
test('double entry validates sides, totals and unbalanced entries',()=>{
  balanced([{debit:'0.10',credit:'0.00'},{debit:'0.20',credit:'0.00'},{debit:'0.00',credit:'0.30'}]);
  assert.throws(()=>balanced([{debit:'0.10',credit:'0.00'},{debit:'0.00',credit:'0.11'}]),{code:'UNBALANCED_ENTRY'});
  assert.throws(()=>balanced([{debit:'0.00',credit:'0.00'}]));
});
test('closed additive A32 retains S1; financial enums reach factor challenge schemas',()=>{
  const contract=new FrozenContract(),org=randomUUID(),key=randomUUID();
  contract.validate('A32',{password:'synthetic password long enough',purpose:'ORGANIZATION_CREATE',command:{name:'Org',currency:'COP',timezone:'America/Bogota'}});
  for(const purpose of financePurposes) {
    contract.validate('A26',{purpose,...(['FINANCE_ACCOUNT_UPDATE','FINANCE_JOURNAL_REVERSE'].includes(purpose)?{resourceId:randomUUID()}:{})});
    contract.validate('A27',{purpose,method:'TOTP',code:'123456',...(['FINANCE_ACCOUNT_UPDATE','FINANCE_JOURNAL_REVERSE'].includes(purpose)?{resourceId:randomUUID()}:{})});
  }
  const request={password:'synthetic password long enough',purpose:'FINANCE_ACCOUNT_CREATE',command:{organizationId:org,idempotencyKey:key,payload:{code:'BANK',name:'Banco',accountClass:'ASSET',kind:'BANK',currency:'COP'}}};
  contract.validate('A32',request);assert.throws(()=>contract.validate('A32',{...request,command:{...request.command,ownerId:org}}));
  assert.throws(()=>contract.validate('A32',{...request,purpose:'FINANCE_ANYTHING'}));
  financeContract().validate('createAccount',request.command.payload);
  assert.throws(()=>financeContract().validate('createAccount',{...request.command.payload,balance:'1.00'}));
  assert.throws(()=>financeContract().validate('createAccount',{...request.command.payload,accountClass:'INCOME'}));
  assert.deepEqual(canonical({b:' e\u0301 ',a:org.toUpperCase()}),{a:org,b:'é'});
});
