import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {monthlyInterest,msCents,msMoney,msDue,newMonthlyState,monthlyPosition,accrueMonthly,applyMonthlyPayment,compensateMonthly,versionMonthlyRate,assertMonthlyHistory,distributeMonthly,monthlySavings,summarizeMonthly,assertMonthlyPostsBalanced} from '../../src/modules/lending/ms-engine.js';
import type {MonthlyTerms,MonthlyPayment,MonthlyFlow} from '../../src/modules/lending/ms-models.js';
import {AppError} from '../../src/shared/errors.js';
import {monthlyEngineState} from '../../src/modules/lending/ms-adapter.js';
import {operate} from '../../src/modules/lending/operations-engine.js';
const profile={principalAccountId:'P',interestReceivableAccountId:'I',interestIncomeAccountId:'Y',borrowerCreditAccountId:'C'};
const terms=(principal='1000000.00',date='2026-10-01',day=1):MonthlyTerms=>({modality:'MONTHLY_OPEN_V1',borrowerId:'borrower',principal,monthlyRate:'0.030000000000',effectiveDate:date,firstDueDate:msDue({effectiveDate:date,anchor:{mode:'DAY_OF_MONTH',day}},1),anchor:{mode:'DAY_OF_MONTH',day},cashAccountId:'CASH',mappingVersion:'mapping1',supportReference:'synthetic',usage:'LOCAL_SYNTHETIC'});
const state=(principal?:string)=>newMonthlyState('loan','book',terms(principal),profile,'2026-10-01T12:00:00Z','activation');
const payment=(amount:string,date='2026-11-01',mode:MonthlyPayment['mode']='REGULAR',id='payment1'):MonthlyPayment=>({id,effectiveDate:date,recordedAt:date+'T12:00:00Z',amount,cashAccountId:'CASH',mode,excess:'REJECT',source:'CASH',creditAvailable:'0.00',paymentId:'s06-payment'});
const throws=(fn:()=>unknown,code:string)=>assert.throws(fn,e=>e instanceof AppError&&e.code===code);

test('opening carries only authenticated remaining interest; recognition posts only its unrecognized part',()=>{
 const s=state();s.origin={kind:'OPENING_LINK',eventId:'opening',cutoffDate:'2026-11-01',recognizedInterest:'10000.00'};s.periods[0]={...s.periods[0]!,interest:'20000.00',contractualInterest:'30000.00',paidBeforeOpening:'10000.00',openingRecognizedInterest:'10000.00'};
 const before=monthlyPosition(s,'2026-11-01');assert.equal(before.interestRecognized,'10000.00');assert.equal(before.interestDueUnrecognized,'10000.00');assert.equal(before.interestCashCollected,'0.00');
 const posted=accrueMonthly(s,'2026-11-01','2026-11-02T12:00:00Z');assert.equal(posted.postings.find(l=>l.accountId==='I')?.debit,'10000.00');assert.equal(monthlyPosition(posted.state,'2026-11-01').interestReceivable,'20000.00');assert.equal(monthlyPosition(posted.state,'2026-11-01','2026-11-01T18:00:00Z').interestRecognized,'10000.00');
});

test('COP is exact above IEEE754, half-up cent, zero and input boundaries',()=>{
 assert.equal(msMoney(msCents('9999999999999999.99')),'9999999999999999.99');
 assert.equal(monthlyInterest('0.50','0.010000000000'),'0.01');
 assert.equal(monthlyInterest('1000000000000.00','0.000000000001'),'1.00');
 assert.equal(monthlyInterest('1000000.00','0.000000000000'),'0.00');
 for(const s of ['1e6','-0.00','01.00','NaN'])throws(()=>msCents(s),'INPUT_INVALID');
 throws(()=>monthlyInterest('1.00','3'),'INPUT_INVALID');
});
test('original anchor restores after February and EOM remains explicit',()=>{
 const fixture=JSON.parse(readFileSync('../../Construccion/Sprints/MODO-SIMPLE/Contratos/MS_REFERENCE_CASES.json','utf8')) as {calendarCases:{anchor:string;mode:'DAY_OF_MONTH'|'END_OF_MONTH';expected:string[]}[]};
 for(const c of fixture.calendarCases){const anchor=c.mode==='END_OF_MONTH'?{mode:c.mode}:{mode:c.mode,day:Number(c.anchor.slice(-2))};assert.deepEqual(c.expected.map((_,i)=>msDue({effectiveDate:c.anchor,anchor},i+1)),c.expected);}
 throws(()=>newMonthlyState('x','book',{...terms(),firstDueDate:'2026-10-15'},profile,'2026-10-01T12:00:00Z','e'),'IRREGULAR_PERIOD_UNSUPPORTED');
});
test('partial payment satisfies oldest interest, never principal first',()=>{
 const due=accrueMonthly(state('2000000.00'),'2026-11-02','2026-11-02T09:00:00Z');
 const out=applyMonthlyPayment(due.state,payment('20000.00','2026-11-03'));
 assert.equal(out.principalOutstanding,'2000000.00');assert.equal(out.interestApplied,'20000.00');
 assert.equal(monthlyPosition(out.state,'2026-11-03').interestOverdue,'40000.00');assert.equal(monthlyPosition(out.state,'2026-11-03').overduePeriodCount,1);assertMonthlyPostsBalanced(out.postings);
});
test('reference B receipt recovers 1M principal, next period interest 60k',()=>{
 const out=applyMonthlyPayment(state('3000000.00'),payment('1090000.00'));
 assert.equal(out.interestApplied,'90000.00');assert.equal(out.principalApplied,'1000000.00');assert.equal(out.principalOutstanding,'2000000.00');
 const next=accrueMonthly(out.state,'2026-11-02','2026-11-02T09:00:00Z');assert.equal(next.state.periods[1]?.interest,'60000.00');assertMonthlyPostsBalanced(out.postings);
});
test('midcycle extra leaves locked interest intact, next base changes',()=>{
 const out=applyMonthlyPayment(state(),payment('200000.00','2026-10-16','EXTRA_PRINCIPAL'));
 assert.equal(out.interestApplied,'0.00');assert.equal(out.principalOutstanding,'800000.00');assert.equal(out.state.periods[0]?.interest,'30000.00');
 const later=accrueMonthly(out.state,'2026-11-02','2026-11-02T09:00:00Z');assert.equal(later.state.periods[1]?.interest,'24000.00');
});
test('midcycle closing requires full started cycle, regular cannot evade it',()=>{
 throws(()=>applyMonthlyPayment(state(),payment('1000000.00','2026-10-16')),'SETTLEMENT_PREVIEW_REQUIRED');
 throws(()=>applyMonthlyPayment(state(),payment('1000000.00','2026-10-16','SETTLEMENT')),'SETTLEMENT_AMOUNT_INSUFFICIENT');
 const out=applyMonthlyPayment(state(),payment('1030000.00','2026-10-16','SETTLEMENT'));
 assert.equal(out.state.status,'SETTLED');assert.equal(out.interestApplied,'30000.00');assert.equal(out.principalOutstanding,'0.00');
 assert.equal(accrueMonthly(out.state,'2026-12-31','2026-12-31T12:00:00Z').state.periods.length,1);assertMonthlyPostsBalanced(out.postings);
});
test('boundary closure never starts another cycle even when worker ran first',()=>{
 const due=accrueMonthly(state(),'2026-11-01','2026-11-01T00:01:00Z');assert.equal(due.state.periods.length,1);
 const out=applyMonthlyPayment(due.state,payment('1030000.00','2026-11-01','SETTLEMENT'));
 assert.equal(out.state.status,'SETTLED');assert.equal(out.state.periods.length,1);assert.equal(out.interestApplied,'30000.00');
});
test('late interest is simple; interest delinquency is not principal due',()=>{
 const out=accrueMonthly(state('2000000.00'),'2026-12-02','2026-12-02T12:00:00Z');
 const p=monthlyPosition(out.state,'2026-12-02');assert.equal(p.principal,'2000000.00');assert.equal(p.interestRecognized,'120000.00');assert.equal(p.principalOverdue,'0.00');assert.equal(p.overduePeriodCount,2);
});
test('bounded catchup makes progress, retry no second recognition',()=>{
 let s=state(),rounds=0;do{const out=accrueMonthly(s,'2028-01-02','2028-01-02T12:00:00Z');assert.ok(out.newAccruals.length<=12);s=out.state;rounds++;if(!out.catchupPending)break;assert.ok(rounds<4);}while(true);
 assert.equal(rounds,2);assert.equal(s.periods.filter(p=>p.recognizedAt).length,15);
 const again=accrueMonthly(s,'2028-01-02','2028-01-02T12:00:00Z');assert.equal(again.newAccruals.length,0);assert.equal(again.newPeriods.length,0);assert.deepEqual(again.state,s);
});
test('overpayment is explicit and credit application never adds cash',()=>{
 const request={...payment('1100000.00','2026-11-01','SETTLEMENT'),excess:'CREDIT' as const};
 const out=applyMonthlyPayment(state(),request);assert.equal(out.creditAdded,'70000.00');
 const credit=applyMonthlyPayment(state(),{...payment('10000.00','2026-11-01'),source:'BORROWER_CREDIT',creditAvailable:'70000.00'});
 assert.equal(credit.creditUsed,'10000.00');assert.ok(!credit.postings.some(p=>p.accountId==='CASH'));assert.equal(monthlyPosition(credit.state,'2026-11-01').interestCashCollected,'0.00');assert.equal(monthlyPosition(credit.state,'2026-11-01').interestSatisfiedByCredit,'10000.00');
});
test('compensation keeps recognition and restores principal without deleting facts',()=>{
 const paid=applyMonthlyPayment(state(),payment('130000.00'));
 const out=compensateMonthly(paid.state,'payment1','comp1','2026-11-01','2026-11-01T13:00:00Z','CASH');
 assert.equal(out.state.facts.length,2);assert.equal(out.principalOutstanding,'1000000.00');const p=monthlyPosition(out.state,'2026-11-01');assert.equal(p.interestReceivable,'30000.00');assert.equal(p.interestRecognized,'30000.00');assert.equal(p.interestCashCollected,'0.00');assertMonthlyPostsBalanced(out.postings);
 throws(()=>compensateMonthly(out.state,'payment1','comp2','2026-11-01','2026-11-01T14:00:00Z','CASH'),'ALREADY_REVERSED');
});
test('future rate version cannot rewrite a fixed cycle or change day silently',()=>{
 const s=versionMonthlyRate(state(),'0.020000000000','2026-11-01','2026-10-02');
 assert.equal(s.periods[0]?.interest,'30000.00');assert.equal(accrueMonthly(s,'2026-11-02','2026-11-02T12:00:00Z').state.periods[1]?.interest,'20000.00');
 throws(()=>versionMonthlyRate(s,'0.01','2026-11-15','2026-10-02'),'INPUT_INVALID');
 throws(()=>versionMonthlyRate(s,'0.010000000000','2026-11-15','2026-10-02'),'IRREGULAR_PERIOD_UNSUPPORTED');
});
test('economic cutoff and known-at are independent',()=>{
 const request=payment('10000.00','2026-11-01');request.recordedAt='2026-11-20T12:00:00Z';const out=applyMonthlyPayment(state(),request);
 assert.equal(monthlyPosition(out.state,'2026-11-02','2026-11-19T23:59:59Z').interestCashCollected,'0.00');assert.equal(monthlyPosition(out.state,'2026-11-02','2026-11-20T12:00:00Z').interestCashCollected,'10000.00');
});
test('adapter never backdates recognition merely because contractual interest was already due',()=>{
 const loan={_id:'loan',organizationId:'book',ownerId:'book',borrowerId:'borrower',version:1,modality:'MONTHLY_OPEN_V1' as const,status:'MONTHLY_DRAFT' as const,terms:terms(),termsVersion:1,profile,createdAt:'2026-10-01T12:00:00Z'};
 const native=monthlyEngineState(loan,'2026-10-01T12:00:00Z','activation');
 const out=operate({kind:'RECEIPT',borrowerId:'borrower',destinationAccountId:'CASH',destinationAccountETag:'"cash:1"',receivedAmount:'10000.00',targets:[{loanId:'loan',positionETag:'"loan:1"',amount:'10000.00',mode:'REGULAR'}],excessDisposition:'REJECT',receiptReference:'SYN-1',effectiveDate:'2026-11-20',supportReference:'SYN'},[native],profile,'0.00',new Map([['borrower',{id:'borrower',code:'SYN',name:'Sintético'}]]),'receipt','2026-11-20T12:00:00Z');
 const past=monthlyPosition(out.states[0]!.position.monthlyState!,'2026-11-10','2026-11-30T23:00:00Z');assert.equal(past.interestRecognized,'0.00');assert.equal(past.interestDueUnrecognized,'30000.00');assert.equal(past.interestCashCollected,'0.00');
});
test('history rejects closed/unknown/duplicates/later funding and enforces limits',()=>{
 const c={effectiveDate:'2026-11-01',today:'2026-11-02',cutoffDate:'2026-10-31',closedPeriods:[],duplicate:false,affectedFacts:1,incompatible:false,availabilityByDate:['1.00']};
 assert.equal(assertMonthlyHistory(c),'ECONOMIC');assert.equal(assertMonthlyHistory({...c,effectiveDate:'2026-10-31'}),'INFORMATIONAL');
 throws(()=>assertMonthlyHistory({...c,closedPeriods:null}),'PERIOD_CLOSURE_UNAVAILABLE');
 throws(()=>assertMonthlyHistory({...c,closedPeriods:[{from:'2026-11-01',to:'2026-11-30'}]}),'PERIOD_CLOSED');
 throws(()=>assertMonthlyHistory({...c,duplicate:true}),'SOURCE_ALREADY_USED');throws(()=>assertMonthlyHistory({...c,affectedFacts:1001}),'HISTORY_RANGE_UNSUPPORTED');throws(()=>assertMonthlyHistory({...c,availabilityByDate:['-0.01','100.00']}),'INSUFFICIENT_AVAILABLE_FUNDS');
});
test('distribution cent conservation, percentages and real availability',()=>{
 assert.deepEqual(distributeMonthly('0.01',['0.500000','0.500000'],'0.01','0.01'),['0.00','0.01']);
 assert.deepEqual(distributeMonthly('510000.00',['0.500000','0.500000','0.000000'],'510000.00','510000.00'),['255000.00','255000.00','0.00']);
 throws(()=>distributeMonthly('2.00',['1.000000'],'1.00','10.00'),'INSUFFICIENT_AVAILABLE_FUNDS');throws(()=>distributeMonthly('1.00',['0.500000'],'2.00','2.00'),'INPUT_INVALID');
});
test('saving dates are strictly before payment; final cent residue, no divide by zero',()=>{
 const out=monthlySavings('100.00','0.00',['2026-11-01','2026-12-01','2027-01-01','2027-02-01'],'2027-02-01');assert.deepEqual(out.amounts,['33.33','33.33','33.34']);
 assert.equal(monthlySavings('100.00','20.00',[],'2026-11-01').requiredNow,'80.00');throws(()=>monthlySavings('1.00','0.00',['2026-11-01','2026-11-01'],'2026-12-01'),'INPUT_INVALID');
});
test('monthly summary source flow and analytic eliminations match independent fixture',()=>{
 const data=JSON.parse(readFileSync('../../Construccion/Sprints/MODO-SIMPLE/Contratos/MS_REFERENCE_CASES.json','utf8')) as {fixture:{cashEvents:{book:string;date:string;kind:string;delta:string;interest?:string;relationship?:string;sourceUse?:string}[];expected:Record<string,string>}};
 const flows:MonthlyFlow[]=data.fixture.cashEvents.flatMap((e,i)=>{
  let kind:MonthlyFlow['kind']='OTHER',amount=e.delta;
  if(e.interest){kind='INTEREST_CASH';amount=e.interest;}else if(e.kind==='SALARY')kind='EXTERNAL_INCOME';else if(['RENT','SERVICES','FOOD'].includes(e.kind)){kind='EXPENSE_PAID';amount=amount.slice(1);}else if(e.kind.endsWith('_PRINCIPAL')){kind='DEBT_PAID';amount=amount.slice(1);}else if(e.relationship)kind='FUNDING_TRANSFER';
  return[{id:String(i),bookId:e.book,effectiveDate:e.date,knownAt:'2026-12-01T12:00:00Z',kind,amount,...(e.relationship?{relationshipId:e.relationship}:{}),...(e.sourceUse?{alreadyDistributedSource:true}:{})}];
 });
 flows.push({id:'reserve',bookId:'P',effectiveDate:'2026-11-15',knownAt:'2026-12-01T12:00:00Z',kind:'DEBT_RESERVATION',amount:'500000.00'},{id:'distributed',bookId:'P',effectiveDate:'2026-11-20',knownAt:'2026-12-01T12:00:00Z',kind:'DISTRIBUTION',amount:'510000.00'});
 const out=summarizeMonthly(flows,['B','P'],'2026-11','2026-11-30','2026-12-01T12:00:00Z',true);
 assert.equal(out.income,data.fixture.expected['INCOME']);assert.equal(out.baseSurplus,data.fixture.expected['BASE_SURPLUS']);assert.equal(out.remainingSurplus,'0.00');assert.equal(summarizeMonthly(flows,['B'],'2026-11','2026-11-30','2026-12-01T12:00:00Z').baseSurplus,'0.00');
});

test('funding an edited draft preserves its actual terms version in period and schedule',()=>{
 const s=newMonthlyState('loan','book',terms(),profile,'2026-10-01T12:00:00Z','event',3);assert.equal(s.rateVersions[0]!.version,3);assert.equal(s.periods[0]!.termsVersion,3);const next=versionMonthlyRate(s,'0.040000000000','2026-12-01','2026-11-01');assert.equal(next.rateVersions.at(-1)!.version,4);
});


test('interbook compensation preserves origin month and pairs both legs per phase',()=>{
 const row=(id:string,bookId:string,amount:string,date:string,relationshipLeg:'ORIGIN'|'REVERSAL'):MonthlyFlow=>({id,bookId,amount,effectiveDate:date,knownAt:'2027-02-10T12:00:00Z',kind:'FUNDING_TRANSFER',relationshipId:'pair',relationshipLeg});
 const rows=[row('a','P','-100.00','2027-01-01','ORIGIN'),row('b','B','100.00','2027-01-01','ORIGIN'),row('c','P','100.00','2027-02-01','REVERSAL'),row('d','B','-100.00','2027-02-01','REVERSAL')];
 assert.equal(summarizeMonthly(rows,['P'],'2027-01','2027-02-10','2027-02-10T12:00:00Z').funding,'-100.00');
 assert.equal(summarizeMonthly(rows,['P'],'2027-02','2027-02-10','2027-02-10T12:00:00Z').funding,'100.00');
 assert.equal(summarizeMonthly(rows,['P','B'],'2027-02','2027-02-10','2027-02-10T12:00:00Z',true).funding,'0.00');
 const same=rows.map(r=>({...r,effectiveDate:'2027-01-01'}));assert.equal(summarizeMonthly(same,['P','B'],'2027-01','2027-02-10','2027-02-10T12:00:00Z',true).funding,'0.00');
 throws(()=>summarizeMonthly(same.slice(0,3),['P','B'],'2027-01','2027-02-10','2027-02-10T12:00:00Z',true),'CONSOLIDATION_INCOMPLETE');
});
