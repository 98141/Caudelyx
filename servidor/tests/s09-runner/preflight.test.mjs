/* eslint-disable security/detect-non-literal-fs-filename -- Read-only fixed approved artifact paths inside the project; no user supplied filesystem path. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..');
const load=async n=>JSON.parse(await fs.readFile(path.join(root,n),'utf8'));
const prefix='Construccion/Sprints/S09/';
test('approved P01 policies are frozen while prebackend independent review remains explicit',async()=>{
  const g=await load(prefix+'Evidencias/S09-P01-v1-GATES.json');
  assert.equal(g.policiesApproved,true);assert.equal(g.contractFrozen,true);
  assert.equal(g.prebackendIndependentReview,'NOT_RECEIVED');assert.equal(g.readyForFinancialBackend,false);
});
test('compile every approved candidate schema without product imports or Mongo',async()=>{
  const d=await load(prefix+'Contratos/P01-v1/openapi-expenses-s09.json');
  assert.equal(d['x-policy-approved'],true);assert.equal(d['x-runtime-validated'],false);
  const a=new Ajv({strict:false,validateFormats:true});formats(a);
  a.addSchema({$id:'urn:s09:approved',components:{schemas:d.components.schemas}});
  for(const n of Object.keys(d.components.schemas))a.compile({$ref:'urn:s09:approved#/components/schemas/'+n});
  const validate=a.compile({$ref:'urn:s09:approved#/components/schemas/ExpenseCreate'});
  const expense={nominalDate:'2026-10-28',dueDate:'2026-10-30',description:'Servicio sintético',category:'SERVICES',amountMode:'FIXED',amount:'100000.00',supportReference:'SYNTHETIC-PREFLIGHT'};
  assert.equal(validate(expense),true);assert.equal(validate({...expense,ownerId:'forged'}),false);assert.equal(validate({...expense,amount:100000}),false);
  const rule=a.compile({$ref:'urn:s09:approved#/components/schemas/RuleCreate'});
  const fields={frequency:'CUSTOM',startDate:'2026-10-28',monthEndPolicy:'CLAMP_TO_LAST_DAY',description:'Sintético',category:'SERVICES',amountMode:'VARIABLE',supportReference:'SYNTHETIC'};
  assert.equal(rule(fields),false);assert.equal(rule({...fields,customDates:['2026-10-28']}),true);assert.equal(rule({...fields,customDates:['2026-10-28','2026-10-28']}),false);
});
test('reference journals balance in exact cents; designed financial cases are not runtime PASS',async()=>{
  const cases=await load(prefix+'Contratos/P01-v1/REFERENCE_CASES_S09.json');
  const cents=v=>{assert.match(v,/^(0|[1-9][0-9]{0,15})\.[0-9]{2}$/);return BigInt(v.replace('.',''));};
  for(const c of cases.cases){
    assert.equal(c.status,'APPROVED_REFERENCE_NOT_RUNTIME_TEST');
    for(const j of c.actions)assert.equal(j.lines.reduce((n,l)=>n+cents(l.debit)-cents(l.credit),0n),0n);
  }
  const l=cases.cases.find(c=>c.id==='L02A');assert.equal(l.expected.principalLiability,'800000.00');assert.equal(l.expected.totalExpense,'40000.00');
  assert.equal(cases.cases.find(c=>c.id==='C03').expected.shortfallOn2026_10_30,'50000.00');
});
