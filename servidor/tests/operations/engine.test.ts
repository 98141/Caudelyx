import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {operate} from '../../src/modules/lending/operations-engine.js';
import {installmentFromRow,type EngineLoan,type Intent,type Profile,type Target} from '../../src/modules/lending/operations-models.js';
import type {Terms,Loan,Row} from '../../src/modules/lending/models.js';
import {recalculateFuture} from '../../src/modules/lending/calculator.js';
import {operationsContract} from '../../src/modules/lending/operations-contract.js';
interface Case {id:string;input:{principal:string;installmentCount:number;periodicRate24:string;method:Terms['method'];dueDates:string[]};schedule:Row[];alreadyAccrued?:{loan:string;interest:string;installmentNumber:number;dueDate:string;scheduleVersion:number}[];otherLoan?:{id:string;principal:string;schedule:Row[]};receipt?:{amount:string;targets:{loan:string;amount:string;mode:Target['mode']}[];excessDisposition:'CREDIT'|'REJECT'};creditApplication?:{amount:string;targets:{loan:string;amount:string;mode:Target['mode']}[]};steps:{kind:string;effectiveDate:string;clock:string;postings:{account:string;debit:string;credit:string}[];scheduleRevision?:{schedule:Row[]}}[]}
const data=JSON.parse(readFileSync('../../Construccion/Sprints/S05/Contratos/REFERENCE_CASES_S05.json','utf8')) as {numericCases:Case[];structuralExamples:{schema:string;valid:boolean;value:unknown}[]};
const profile:Profile={principalAccountId:'PRINCIPAL',interestReceivableAccountId:'INTEREST_RECEIVABLE',interestIncomeAccountId:'INTEREST_INCOME',borrowerCreditAccountId:'BORROWER_CREDIT'};
const borrower=new Map([['00000000-0000-4000-8000-000000000001',{id:'00000000-0000-4000-8000-000000000001',code:'SYN-001',name:'Persona sintética'}]]);
function state(c:Case,id='L1',principal=c.input.principal,rows=c.schedule):EngineLoan{
  const terms:Terms={borrowerId:'00000000-0000-4000-8000-000000000001',plannedFundingAccountId:'00000000-0000-4000-8000-000000000003',principal,effectiveDate:'2026-09-30',firstDueDate:'2026-10-31',installmentCount:rows.length,method:c.input.method,frequency:'MONTH',rate:{type:'EFFECTIVE',unit:'MONTH',value:c.input.periodicRate24.slice(0,c.input.periodicRate24.indexOf('.')+13)},calendarConvention:'PERIODIC_FIXED',holidayAdjustment:'NO_SHIFT',policyVersion:'S04-LOCAL-CO-0.1',jurisdiction:'CO',usage:'LOCAL_SYNTHETIC'};
  const loan:Loan={_id:id,organizationId:'ORG',ownerId:'ORG',borrowerId:'00000000-0000-4000-8000-000000000001',status:'TERMS_CONFIRMED',version:2,termsVersion:1,terms,quoteId:'Q',quoteFingerprint:'f',calculation:{schedule:rows,totals:{principal,interest:'0.00',payment:principal},periodicRate24:c.input.periodicRate24,basePayment:null,finalPaymentAdjustment:'0.00',policyVersion:'S04-LOCAL-CO-0.1',mathVersion:'CALCULATION-S04-0.1',calendarVersion:'S04-CALENDAR-0.1'},confirmation:{actorId:'T',confirmedAt:'2026-10-24T00:00:00Z',quoteId:'Q',quoteFingerprint:'f',termsVersion:1},createdAt:'2026-10-24T00:00:00Z',updatedAt:'2026-10-24T00:00:00Z'};
  return{loan,position:{_id:id,organizationId:'ORG',loanId:id,borrowerId:'00000000-0000-4000-8000-000000000001',version:1,termsVersion:1,scheduleVersion:1,status:'ACTIVE',originalPrincipal:principal,principalOutstanding:principal,fundingEventId:'F',createdAt:loan.createdAt},rows:rows.map(r=>installmentFromRow(r,id,'ORG',1,loan.createdAt)),accruals:(c.alreadyAccrued??[]).map(a=>({...a,_id:'A',organizationId:'ORG',loanId:id,eventId:'A',createdAt:loan.createdAt})),applications:[]};
}
for(const c of data.numericCases.filter(c=>c.id!=='RC01-DISBURSE-10M'))test(c.id+' golden postings and future revisions',()=>{
  let states=[state(c)],credit='0.00';if(c.otherLoan)states.push(state(c,c.otherLoan.id,c.otherLoan.principal,c.otherLoan.schedule));
  for(const[stepIndex,step]of c.steps.entries()){
    const common={effectiveDate:step.effectiveDate,supportReference:'SYN-UNIT'};let intent:Intent;
    if(step.kind==='ACCRUE')intent={...common,kind:'ACCRUE',loanId:'L1',positionETag:'"L1:1"',throughDate:step.effectiveDate};
    else{const source=step.kind==='RECEIPT'?c.receipt!:c.creditApplication!,targets=source.targets.map(t=>({loanId:t.loan,positionETag:'"L1:1"',amount:t.amount,mode:t.mode}));intent=step.kind==='RECEIPT'?{...common,kind:'RECEIPT',borrowerId:'00000000-0000-4000-8000-000000000001',destinationAccountId:'CASH',destinationAccountETag:'"CASH:1"',receivedAmount:source.amount,targets,excessDisposition:c.receipt!.excessDisposition,receiptReference:'SYN-'+stepIndex}:{...common,kind:'APPLY_CREDIT',borrowerId:'00000000-0000-4000-8000-000000000001',creditETag:'"B1:1"',amount:source.amount,targets};}
    const original=JSON.stringify(states),result=operate(intent,states,profile,credit,borrower,'EVENT',step.clock);
    assert.equal(JSON.stringify(states),original,'pure engine must not mutate inputs');
    assert.deepEqual(result.plan.postings,step.postings.map(p=>({accountId:p.account,debit:p.debit,credit:p.credit})).sort((a,b)=>a.accountId.localeCompare(b.accountId)));
    if(step.scheduleRevision){assert.deepEqual(result.plan.scheduleRevisions[0]!.futureInstallments.map(r=>({date:r.dueDate,principal:r.principal,interest:r.interest,payment:r.payment})),step.scheduleRevision.schedule.map(r=>({date:r.date,principal:r.principal,interest:r.interest,payment:r.payment})));}
    states=result.states;credit=result.plan.creditChange?.after??credit;
  }
});
test('partial below interest, limits, excess and off-date extra leave inputs unchanged',()=>{
  const c=data.numericCases.find(c=>c.id==='RC07-EXTRA-CP')!,s=state(c),base:Intent={kind:'RECEIPT',borrowerId:'00000000-0000-4000-8000-000000000001',destinationAccountId:'CASH',destinationAccountETag:'"CASH:1"',receivedAmount:'5.00',targets:[{loanId:'L1',positionETag:'"L1:1"',amount:'5.00',mode:'REGULAR'}],excessDisposition:'REJECT',receiptReference:'SYN-1',effectiveDate:'2026-10-31',supportReference:'SYN'};
  const r=operate(base,[s],profile,'0.00',borrower,'E','2026-10-31T00:00:00Z');assert.equal(r.plan.allocations.length,1);assert.equal(r.plan.allocations[0]!.component,'INTEREST');assert.equal(r.states[0]!.position.principalOutstanding,'1000.00');
  const before=JSON.stringify(s);
  for(const intent of [{...base,targets:Array.from({length:11},()=>base.targets[0]!)},{...base,receivedAmount:'5000.00',targets:[{...base.targets[0]!,amount:'5000.00'}]},{...base,effectiveDate:'2026-10-30',targets:[{...base.targets[0]!,mode:'EXTRA_PRINCIPAL' as const}]}])assert.throws(()=>operate(intent,[s],profile,'0.00',borrower,'E','2026-10-31T00:00:00Z'));
  assert.equal(JSON.stringify(s),before);
});
test('future calculation preserves Jan30 anchor rather than inheriting Feb29 clamp',()=>{
  const c=data.numericCases.find(c=>c.id==='RC07-EXTRA-CP')!,t=state(c).loan.terms;
  const r=recalculateFuture({...t,effectiveDate:'2028-01-30',firstDueDate:'2028-02-29'},'650.00',['2028-03-30','2028-04-30']);assert.deepEqual(r.schedule.map(r=>r.date),['2028-03-30','2028-04-30']);
});
test('all approved S05 structural examples',()=>{
  const contract=operationsContract();for(const e of data.structuralExamples){if(e.valid)assert.doesNotThrow(()=>contract.validate(e.schema,e.value));else assert.throws(()=>contract.validate(e.schema,e.value));}
});

import {maxEvidenceDepth,assertEvidenceDepth} from '../../src/modules/lending/evidence-v2.js';
test('treap depth budget128 accepts boundary and fails closed for129/invalid metadata',()=>{assert.equal(maxEvidenceDepth,128);assert.doesNotThrow(()=>assertEvidenceDepth(128));for(const depth of [129,0,-1,1.5,NaN])assert.throws(()=>assertEvidenceDepth(depth),(e:unknown)=>e instanceof Error&&'code'in e&&e.code==='INTEGRITY_MISMATCH'&&'status'in e&&e.status===503);});
