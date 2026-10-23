import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {reconcile} from '../../src/modules/opening/reconcile.js';
import {openingContract,canonicalOpening} from '../../src/modules/opening/contract.js';
import type {Snapshot} from '../../src/modules/opening/models.js';
import type {Account} from '../../src/modules/finance/models.js';

const fixture=()=>{
  const org=randomUUID(),support=randomUUID();
  const account=(accountClass:Account['accountClass'],kind:Account['kind']='GENERAL'):Account=>({_id:randomUUID(),organizationId:org,bookId:org,ownerId:org,financialScope:'BUSINESS',currency:'COP',createdAt:'2020-01-01T00:00:00Z',code:randomUUID(),name:'Sintética',status:'ACTIVE',version:1,accountClass,kind});
  const bank=account('ASSET','BANK'),equity=account('EQUITY');
  const snapshot:Snapshot={cutoffDate:'2020-01-01',supports:[{id:support,reference:'Soporte sintético',asOfDate:'2020-01-01',declaration:'OWNER_CHECKED'}],references:[],components:[{id:randomUUID(),category:'BANK',accountId:bank._id,amount:'100.00',supportIds:[support]},{id:randomUUID(),category:'EQUITY',accountId:equity._id,amount:'100.00',equityKind:'CONTRIBUTED',supportIds:[support]}],historicalInterest:[],informationalHistory:[]};
  return{org,support,account,bank,equity,snapshot,accounts:[bank,equity]};
};
test('S03 exact reconciliation, informational history never creates a posting',()=>{
  const f=fixture();const before=reconcile(f.snapshot,f.accounts,'2026-10-23');assert.equal(before.issues.length,0);assert.equal(before.totals.assets,'100.00');
  f.snapshot.informationalHistory.push({id:randomUUID(),date:'2019-01-01',description:'Desembolso anterior, solo informativo',supportIds:[f.support]});
  assert.deepEqual(reconcile(f.snapshot,f.accounts,'2026-10-23'),before);
});
test('S03 difference of one cent is explicit, never equity autocompletion',()=>{
  const f=fixture();f.snapshot.components[1]!.amount='99.99';const r=reconcile(f.snapshot,f.accounts,'2026-10-23');
  assert.equal(r.totals.balanceDifference,'0.01');assert.equal(r.totals.equity,'99.99');assert.ok(r.issues.some(i=>i.code==='BALANCE_DIFFERENCE'));
});
test('S03 supported negative equity has debit nature and balanced opening',()=>{
  const f=fixture(),liability=f.account('LIABILITY');f.accounts.push(liability);f.snapshot.components[0]!.amount='50.00';f.snapshot.components[1]!.amount='-50.00';
  const ref=randomUUID();f.snapshot.references.push({id:ref,type:'OBLIGATION',externalReference:'OB-1',counterpartyLabel:'Sintético',incurredDate:'2019-01-01',supportIds:[f.support]});f.snapshot.components.push({id:randomUUID(),category:'LIABILITY',accountId:liability._id,referenceId:ref,amount:'100.00',supportIds:[f.support]});
  const r=reconcile(f.snapshot,f.accounts,'2026-10-23');assert.equal(r.issues.length,0);assert.equal(r.totals.equity,'-50.00');assert.equal(r.totals.debit,'100.00');
});
test('S03 principal and historical interest separated, recognized requires declared historical equity',()=>{
  const f=fixture(),principal=f.account('ASSET'),interest=f.account('ASSET'),historical=f.account('EQUITY'),borrower=randomUUID(),loan=randomUUID();f.accounts.push(principal,interest,historical);
  f.snapshot.references.push({id:borrower,type:'BORROWER',externalReference:'B1',displayName:'Sintético',supportIds:[f.support]},{id:loan,type:'HISTORICAL_LOAN',externalReference:'L1',borrowerId:borrower,originationDate:'2019-01-01',supportIds:[f.support]});
  const eq=randomUUID();f.snapshot.components.push({id:randomUUID(),category:'PRINCIPAL_RECEIVABLE',accountId:principal._id,referenceId:loan,amount:'200.00',supportIds:[f.support]},{id:eq,category:'EQUITY',accountId:historical._id,equityKind:'HISTORICAL_RESULTS',amount:'220.00',supportIds:[f.support]});
  f.snapshot.historicalInterest.push({id:randomUUID(),loanReferenceId:loan,amount:'20.00',treatment:'RECOGNIZED_OPENING',accountId:interest._id,equityComponentId:eq,recognitionDeclaration:'Reconocido históricamente según declaración sintética',supportIds:[f.support]});
  let r=reconcile(f.snapshot,f.accounts,'2026-10-23');assert.equal(r.issues.length,0);assert.equal(r.totals.principal,'200.00');assert.equal(r.totals.recognizedInterest,'20.00');assert.equal(r.totals.assets,'320.00');
  f.snapshot.historicalInterest[0]!.equityComponentId=randomUUID();r=reconcile(f.snapshot,f.accounts,'2026-10-23');assert.ok(r.issues.some(i=>i.code==='INTEREST_POLICY_INVALID'));
  f.snapshot.historicalInterest=[{id:randomUUID(),loanReferenceId:loan,amount:'20.00',treatment:'INFORMATIONAL',supportIds:[f.support]}];f.snapshot.components.at(-1)!.amount='200.00';
  r=reconcile(f.snapshot,f.accounts,'2026-10-23');assert.equal(r.issues.length,0);assert.equal(r.totals.informationalInterest,'20.00');assert.equal(r.totals.recognizedInterest,'0.00');assert.equal(r.totals.assets,'300.00');
});
test('S03 references/maps/supports/duplicates/dates are enforced independently of schema',()=>{
  const f=fixture();f.snapshot.components[0]!.supportIds=[randomUUID()];f.snapshot.components.push({...f.snapshot.components[0]!,id:randomUUID()});f.bank.kind='GENERAL';f.snapshot.supports[0]!.asOfDate='2021-01-01';
  const r=reconcile(f.snapshot,f.accounts,'2026-10-23');for(const code of ['SUPPORT_REQUIRED','DUPLICATE_POSITION','ACCOUNT_MAPPING_INVALID','DATE_INVALID'])assert.ok(r.issues.some(i=>i.code===code));
  assert.ok(reconcile(f.snapshot,f.accounts,'2019-01-01',false).issues.some(i=>i.code==='BOOK_NOT_ELIGIBLE'));
});
test('S03 opposite equity positions cannot be silently netted into a valid line',()=>{
  const f=fixture();f.snapshot.components.push({...f.snapshot.components[1]!,id:randomUUID(),equityKind:'OTHER_DECLARED',amount:'-1.00'});const r=reconcile(f.snapshot,f.accounts,'2026-10-23');assert.ok(r.issues.some(i=>i.code==='ACCOUNT_MAPPING_INVALID'));assert.deepEqual(r.proposedLines,[]);
});
test('S03 proposed account limit rejects the entire posting, without partial lines',()=>{
  const f=fixture();for(let i=0;i<50;i++){const a=f.account('ASSET','BANK');f.accounts.push(a);f.snapshot.components.push({...f.snapshot.components[0]!,id:randomUUID(),accountId:a._id});}f.snapshot.components[1]!.amount='5100.00';
  const r=reconcile(f.snapshot,f.accounts,'2026-10-23');assert.ok(r.issues.some(i=>i.code==='LIMIT_EXCEEDED'));assert.deepEqual(r.proposedLines,[]);
});
test('S03 frozen schemas reject money/date/ownership/open R variants; normalization remains closed',()=>{
  const f=fixture(),contract=openingContract();contract.validate('OpeningCreate',{snapshot:f.snapshot});
  for(const money of ['1.005','-0.00',1,'1e3','10000000000000000.00']){const copy=structuredClone(f.snapshot);copy.components[0]!.amount=money as string;assert.throws(()=>contract.validate('OpeningCreate',{snapshot:copy}));}
  assert.throws(()=>contract.validate('OpeningCreate',{snapshot:f.snapshot,ownerId:f.org}));
  assert.throws(()=>contract.auth({purpose:'OPENING_COMMIT',password:'synthetic password 123',resourceId:randomUUID(),command:{organizationId:f.org,idempotencyKey:randomUUID(),payload:{approved:true},expectedETag:'"stale"'}}));
  assert.deepEqual(canonicalOpening({z:'  Café  ',a:[{id:f.org.toUpperCase()}]}),{a:[{id:f.org}],z:'Café'});
});
