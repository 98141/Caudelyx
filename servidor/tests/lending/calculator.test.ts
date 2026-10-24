import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {calculate} from '../../src/modules/lending/calculator.js';
import {periodicRate,Decimal60,rounded} from '../../src/modules/lending/decimal.js';
import type {Terms,Calculation} from '../../src/modules/lending/models.js';
import {AppError} from '../../src/shared/errors.js';
const reference=JSON.parse(readFileSync('../../Construccion/Sprints/S04/Contratos/REFERENCE_CASES_S04.json','utf8')) as {cases:{id:string;terms:Terms;expected:Calculation&{error?:string}}[]};
for(const fixture of reference.cases)test('S04 reference '+fixture.id,()=>{
  if(fixture.expected.error)assert.throws(()=>calculate(fixture.terms),(e:unknown)=>e instanceof AppError&&e.code===fixture.expected.error);
  else assert.deepEqual(calculate(fixture.terms),fixture.expected);
});
test('S04 rounding ties, significant60 context and decimal division are exact',()=>{
  assert.equal(rounded(5n,2n),2n);assert.equal(rounded(7n,2n),4n);assert.equal(rounded(-5n,2n,true),-3n);
  assert.equal(Decimal60.text('0.005').cents(),1n);assert.equal(Decimal60.text('-0.005').cents(),-1n);
  assert.equal(new Decimal60(10n**60n+5n,-60).c,10n**59n); // 61digits halfway, even.
  assert.equal(new Decimal60(10n**60n+15n,-60).c,10n**59n+2n);
  const third=new Decimal60(1n).div(new Decimal60(3n));assert.equal(third.c.toString(),'3'.repeat(60));assert.equal(third.e,-60);
});
test('S04 exact periodic identity and rational equivalence, extreme nominal m366',()=>{
  for(const unit of ['DAY','WEEK','FIFTEEN_DAYS','SEMIMONTH','MONTH'])assert.equal(periodicRate({type:'EFFECTIVE',unit,value:'0.123456789012'},unit),'0.123456789012000000000000');
  assert.equal(periodicRate({type:'NOMINAL_ANNUAL',unit:'YEAR',value:'0.120000000000',compoundingPeriodsPerYear:12},'MONTH'),'0.010000000000000000000000');
  const i=periodicRate({type:'NOMINAL_ANNUAL',unit:'YEAR',value:'1.000000000000',compoundingPeriodsPerYear:366},'WEEK');assert.match(i,/^0\.\d{24}$/);
});
test('S04 unsupported/missing terms never get inferred defaults or active status',()=>{
  const base=reference.cases[0]!.terms;
  for(const delta of [{principal:1000},{principal:'-0.00'},{principal:'1000000000000.01'},{installmentCount:361},{rate:{type:'EFFECTIVE',unit:'MONTH',value:'0.01'}},{rate:{type:'NOMINAL_ANNUAL',unit:'YEAR',value:'0.120000000000'}},{isDisbursed:true},{graceDays:1},{financialScope:'PERSONAL'}])assert.throws(()=>calculate({...base,...delta} as Terms),AppError);
  assert.throws(()=>calculate({...base,usage:'REAL'}),(e:unknown)=>e instanceof AppError&&e.status===403&&e.code==='REAL_USE_NOT_ALLOWED');
  assert.throws(()=>calculate({...base,jurisdiction:'US'}),(e:unknown)=>e instanceof AppError&&e.code==='POLICY_UNSUPPORTED');
});
