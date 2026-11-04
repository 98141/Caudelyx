// MS-P05 independent oracle (Claude). Expected values are written from the approved P01 rules
// (MS-D1/2/4, MS-A1/2/8/9) and hand arithmetic; the sealed engine is only the subject under test.
// Pure in-process: imports the sealed compiled output, no DB, ports, services or file writes except the own result file.
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
const E=await import(new URL('../../dist-ms-p04-r2/src/modules/lending/ms-engine.js',import.meta.url).href);
const results=[];
const check=(id,expected,observed)=>{const pass=JSON.stringify(expected)===JSON.stringify(observed);results.push({id,expected,observed,pass});return pass;};
const code=fn=>{try{fn();return 'NO_ERROR';}catch(e){return e.code??String(e.message);}};
// Oracle money: exact rational P*r with HALF_UP to cents, computed from the decimal strings.
const oracleInterest=(principal,rate)=>{const p=BigInt(principal.replace('.','')),r=BigInt(rate.replace('.','')),den=10n**12n,q=(2n*p*r+den)/(2n*den);return `${q/100n}.${String(q%100n).padStart(2,'0')}`;};
const profile={principalAccountId:'acc-P',interestReceivableAccountId:'acc-I',interestIncomeAccountId:'acc-Y',borrowerCreditAccountId:'acc-C'};
const terms=(principal,effectiveDate,firstDueDate,rate='0.030000000000',anchor={mode:'DAY_OF_MONTH',day:Number(effectiveDate.slice(-2))})=>({modality:'MONTHLY_OPEN_V1',borrowerId:'b1',principal,monthlyRate:rate,effectiveDate,firstDueDate,anchor,cashAccountId:'acc-CASH',mappingVersion:'m:1',supportReference:'SYN',usage:'LOCAL_SYNTHETIC'});
const fresh=(principal,eff,due,rate)=>E.newMonthlyState('loan-1','book-1',terms(principal,eff,due,rate),profile,eff+'T15:00:00.000Z','ev-0');
const pay=(state,id,date,amount,extra={})=>E.applyMonthlyPayment(state,{id,effectiveDate:date,recordedAt:date+'T15:00:00.000Z',amount,cashAccountId:'acc-CASH',mode:'REGULAR',excess:'REJECT',source:'CASH',creditAvailable:'0.00',paymentId:null,...extra});
const net=postings=>Object.fromEntries(postings.map(l=>[l.accountId,l.debit!=='0.00'?'+'+l.debit:'-'+l.credit]));

test('O1 interest HALF_UP to cents matches exact rational oracle; bounds and 0%',()=>{
 for(const [p,r] of [['1000000.00','0.030000000000'],['2000000.00','0.030000000000'],['1970000.00','0.030000000000'],['16.50','0.030000000000'],['16.49','0.030000000000'],['0.01','0.500000000000'],['3333.33','0.030000000000'],['1000000.01','0.030000000000'],['999999999999.99','0.033333333333'],['1000000000000.00','1.000000000000'],['5000000.00','0.000000000000'],['123456.78','0.012345678901']])
  assert.ok(check(`O1 ${p}@${r}`,oracleInterest(p,r),E.monthlyInterest(p,r)));
 assert.ok(check('O1 hand 1M@3%','30000.00',E.monthlyInterest('1000000.00','0.030000000000')));
 assert.ok(check('O1 hand 16.50@3% half-up','0.50',E.monthlyInterest('16.50','0.030000000000')));
 for(const [label,fn,exp] of [['rate>100%',()=>E.msRate('1.000000000001'),'INPUT_INVALID'],['rate 11dp',()=>E.msRate('0.03000000000'),'INPUT_INVALID'],['-0.00',()=>E.msCents('-0.00'),'INPUT_INVALID'],['exponent',()=>E.msCents('1e5'),'INPUT_INVALID'],
  ['principal>1e12',()=>E.validateMonthlyTerms(terms('1000000000000.01','2026-11-01','2026-12-01')),'INPUT_INVALID'],['principal 0',()=>E.validateMonthlyTerms(terms('0.00','2026-11-01','2026-12-01')),'INPUT_INVALID']])
  assert.ok(check('O1 reject '+label,exp,code(fn)));
});

test('O2 calendar: original anchor with clamp, explicit EOM, leap years, rollover, irregular blocked',()=>{
 const due=(eff,mode,ords,day)=>ords.map(k=>E.msDue({effectiveDate:eff,anchor:mode==='EOM'?{mode:'END_OF_MONTH'}:{mode:'DAY_OF_MONTH',day:day??Number(eff.slice(-2))}},k));
 assert.ok(check('O2 31-01 day31',['2026-02-28','2026-03-31','2026-04-30','2026-05-31'],due('2026-01-31','DAY',[1,2,3,4])));
 assert.ok(check('O2 30-01 day30 (D4 A)',['2026-02-28','2026-03-30'],due('2026-01-30','DAY',[1,2])));
 assert.ok(check('O2 leap 2028',['2028-02-29','2028-03-31'],due('2028-01-31','DAY',[1,2])));
 assert.ok(check('O2 day29 across leap/non-leap',['2027-01-29','2027-02-28','2027-03-29'],due('2026-12-29','DAY',[1,2,3])));
 assert.ok(check('O2 day29 leap Feb',['2028-02-29'],due('2028-01-29','DAY',[1])));
 assert.ok(check('O2 EOM 30-04',['2026-05-31','2026-06-30','2027-02-28'],due('2026-04-30','EOM',[1,2,10])));
 assert.ok(check('O2 day30 from 30-04 (not EOM)',['2026-05-30'],due('2026-04-30','DAY',[1])));
 assert.ok(check('O2 rollover + 12th',['2027-01-15','2027-10-15'],due('2026-11-15','DAY',[2,11])));
 assert.ok(check('O2 irregular first due (25-11→10-12)','IRREGULAR_PERIOD_UNSUPPORTED',code(()=>E.validateMonthlyTerms(terms('500000.00','2026-11-25','2026-12-10')))));
 assert.ok(check('O2 EOM on non-last day','IRREGULAR_PERIOD_UNSUPPORTED',code(()=>E.validateMonthlyTerms(terms('500000.00','2026-01-30','2026-02-28','0.030000000000',{mode:'END_OF_MONTH'})))));
 assert.ok(check('O2 anchor day differs from start','IRREGULAR_PERIOD_UNSUPPORTED',code(()=>E.validateMonthlyTerms(terms('500000.00','2026-11-01','2026-12-05','0.030000000000',{mode:'DAY_OF_MONTH',day:5})))));
});

test('O3 payment order, partial, no capitalization, mid-cycle principal, boundary base (D1/D2/A1/A2)',()=>{
 // 2M @3% from 01-11: two unpaid cycles stay 60k each, never 61.8k.
 let s=fresh('2000000.00','2026-11-01','2026-12-01');
 let a=E.accrueMonthly(s,'2027-01-02','2027-01-02T15:00:00.000Z');
 assert.ok(check('O3 no capitalization bases',[['2000000.00','60000.00'],['2000000.00','60000.00'],['2000000.00','60000.00']],a.state.periods.map(p=>[p.principalBase,p.interest])));
 const pos=E.monthlyPosition(a.state,'2027-01-02');
 assert.ok(check('O3 overdue 2 cycles',{overdue:'120000.00',count:2,oldest:'2026-12-01',principalOverdue:'0.00'},{overdue:pos.interestOverdue,count:pos.overduePeriodCount,oldest:pos.oldestUnpaidDueDate,principalOverdue:pos.principalOverdue}));
 const p100=pay(a.state,'f1','2027-01-05','100000.00');
 assert.ok(check('O3 oldest interest first',[{ordinal:1,amount:'60000.00'},{ordinal:2,amount:'40000.00'}],p100.fact.interest));
 assert.ok(check('O3 capital intact on partial','2000000.00',p100.principalOutstanding));
 // Partial 20k on 60k after due: 40k still overdue, capital intact; accrual and receipt net in one plan.
 s=fresh('2000000.00','2026-11-01','2026-12-01');
 const p20=pay(s,'f2','2026-12-05','20000.00');
 assert.ok(check('O3 partial 20k ledger net',{'acc-CASH':'+20000.00','acc-I':'+40000.00','acc-Y':'-60000.00'},net(p20.postings)));
 assert.ok(check('O3 partial overdue left','40000.00',E.monthlyPosition(p20.state,'2026-12-05').interestOverdue));
 // 90k on due date: 60k interest + 30k capital; next base sealed with boundary-day fact → 1.97M → 59.1k.
 s=fresh('2000000.00','2026-11-01','2026-12-01');
 const p90=pay(s,'f3','2026-12-01','90000.00');
 assert.ok(check('O3 90k split',{interest:'60000.00',principal:'30000.00'},{interest:p90.interestApplied,principal:p90.principalApplied}));
 const next=E.accrueMonthly(p90.state,'2026-12-02','2026-12-02T15:00:00.000Z').state.periods[1];
 assert.ok(check('O3 next base after boundary payment',['1970000.00','59100.00','2026-12-01','2027-01-01'],[next.principalBase,next.interest,next.startDate,next.dueDate]));
 // A2: 1M, abono 200k on 16-11 → current cycle keeps 30k, next 24k.
 s=fresh('1000000.00','2026-11-01','2026-12-01');
 const ab=pay(s,'f4','2026-11-16','200000.00');
 const st=E.accrueMonthly(ab.state,'2026-12-02','2026-12-02T15:00:00.000Z').state;
 assert.ok(check('O3 A2 mid-cycle abono',[['1000000.00','30000.00'],['800000.00','24000.00']],st.periods.map(p=>[p.principalBase,p.interest])));
 assert.ok(check('O3 REGULAR never pays future interest',[],ab.fact.interest));
});

test('O4 settlement A1, payoff on boundary, excess, credit, 0% and rate version',()=>{
 let s=fresh('1000000.00','2026-11-01','2026-12-01');
 assert.ok(check('O4 regular payoff mid-cycle requires settlement preview','SETTLEMENT_PREVIEW_REQUIRED',code(()=>pay(s,'g1','2026-11-16','1030000.00'))));
 assert.ok(check('O4 settlement without full cycle interest','SETTLEMENT_AMOUNT_INSUFFICIENT',code(()=>pay(s,'g2','2026-11-16','1000000.00',{mode:'SETTLEMENT'}))));
 const set=pay(s,'g3','2026-11-16','1030000.00',{mode:'SETTLEMENT'});
 assert.ok(check('O4 settlement 16 days = 1.030.000',{status:'SETTLED',interest:'30000.00',principal:'1000000.00',net:{'acc-CASH':'+1030000.00','acc-P':'-1000000.00','acc-Y':'-30000.00'}},{status:set.state.status,interest:set.interestApplied,principal:set.principalApplied,net:net(set.postings)}));
 const boundary=pay(s,'g4','2026-12-01','1030000.00');
 assert.ok(check('O4 payoff on due date settles without next cycle',['SETTLED',1],[boundary.state.status,E.accrueMonthly(boundary.state,'2027-02-05','2027-02-05T15:00:00.000Z').state.periods.length]));
 assert.ok(check('O4 excess rejected by default','EXCESS_NOT_ALLOWED',code(()=>pay(s,'g5','2026-12-01','1040000.00'))));
 const cr=pay(s,'g6','2026-12-01','1040000.00',{excess:'CREDIT'});
 assert.ok(check('O4 explicit credit is liability, not income',{creditAdded:'10000.00',C:'-10000.00',Y:'-30000.00'},{creditAdded:cr.creditAdded,C:net(cr.postings)['acc-C'],Y:net(cr.postings)['acc-Y']}));
 const z=fresh('5000000.00','2026-11-01','2026-12-01','0.000000000000'),za=E.accrueMonthly(z,'2026-12-02','2026-12-02T15:00:00.000Z');
 assert.ok(check('O4 0% advances periods without postings',{periods:2,interest:'0.00',postings:0},{periods:za.state.periods.length,interest:za.state.periods[0].interest,postings:za.postings.length}));
 const v=E.versionMonthlyRate(fresh('1000000.00','2026-11-01','2026-12-01'),'0.020000000000','2026-12-01','2026-11-20'),va=E.accrueMonthly(v,'2027-01-02','2027-01-02T15:00:00.000Z').state.periods;
 assert.ok(check('O4 future rate version only from next cycle',['30000.00','20000.00','20000.00'],va.map(p=>p.interest)));
 assert.ok(check('O4 rate version off-boundary rejected','IRREGULAR_PERIOD_UNSUPPORTED',code(()=>E.versionMonthlyRate(fresh('1000000.00','2026-11-01','2026-12-01'),'0.020000000000','2026-12-15','2026-11-20'))));
});

test('O5 reversal (S06 compensation) of a settled loan: R2 exact expectations',()=>{
 const s=fresh('1000000.00','2026-11-01','2026-12-01');
 const set=pay(s,'h1','2026-11-16','1030000.00',{mode:'SETTLEMENT'});
 // Control kept from P05: in-cycle reversal reopens and the next cycle accrues on 1M.
 const inCycle=E.compensateMonthly(set.state,'h1','r1','2026-11-20','2026-11-20T15:00:00.000Z','acc-CASH');
 const inCycleNext=E.accrueMonthly(inCycle.state,'2026-12-02','2026-12-02T15:00:00.000Z').state;
 check('O5 control in-cycle reversal reopens with next cycle',{status:'ACTIVE',principal:'1000000.00',periods:[['1000000.00','30000.00']]},{status:inCycle.state.status,principal:inCycle.principalOutstanding,periods:inCycleNext.periods.slice(1).map(p=>[p.principalBase,p.interest])});
 // R2: the P05 subject (reversal dated 05-12, after the 01-12 frontier) must be rejected exactly, before any compensation.
 const before=JSON.stringify(set.state);
 check('O5 late reversal of settlement rejected exactly','REVERSAL_DEPENDENCY',code(()=>E.compensateMonthly(set.state,'h1','r2','2026-12-05','2026-12-05T15:00:00.000Z','acc-CASH')));
 check('O5 rejected reversal leaves source state untouched (atomic)',before,JSON.stringify(set.state));
 check('O5 frontier+1 day is already late','REVERSAL_DEPENDENCY',code(()=>E.compensateMonthly(set.state,'h1','r2b','2026-12-02','2026-12-02T15:00:00.000Z','acc-CASH')));
 // Frontier day itself is allowed and the next cycles are fixed on the restored 1M (no omitted period, no retroactive rate).
 const onFrontier=E.compensateMonthly(set.state,'h1','r2c','2026-12-01','2026-12-01T15:00:00.000Z','acc-CASH'),fr=E.accrueMonthly(onFrontier.state,'2027-01-02','2027-01-02T15:00:00.000Z').state;
 check('O5d settlement reversed on the frontier day reopens and accrues every later cycle',{status:'ACTIVE',principal:'1000000.00',periods:[['2026-12-01','2027-01-01','1000000.00','30000.00'],['2027-01-01','2027-02-01','1000000.00','30000.00']]},{status:onFrontier.state.status,principal:onFrontier.principalOutstanding,periods:fr.periods.slice(1).map(p=>[p.startDate,p.dueDate,p.principalBase,p.interest])});
 const frPos=E.monthlyPosition(fr,'2027-01-02');
 check('O5d after reopening: principal 1M and exactly three cycles, none omitted or duplicated',{principal:'1000000.00',periods:3},{principal:frPos.principal,periods:fr.periods.length});
 // Regular payoff exactly on the due date (P05 O5b subject).
 const b=pay(s,'h2','2026-12-01','1030000.00');const beforeB=JSON.stringify(b.state);
 check('O5b late reversal of boundary payoff rejected exactly','REVERSAL_DEPENDENCY',code(()=>E.compensateMonthly(b.state,'h2','r3','2026-12-05','2026-12-05T15:00:00.000Z','acc-CASH')));
 check('O5b rejected reversal leaves source state untouched (atomic)',beforeB,JSON.stringify(b.state));
 const bSame=E.compensateMonthly(b.state,'h2','r3b','2026-12-01','2026-12-01T15:00:00.000Z','acc-CASH'),bNext=E.accrueMonthly(bSame.state,'2027-01-02','2027-01-02T15:00:00.000Z');
 check('O5e boundary payoff reversed the same day reopens and fixes later cycles on 1M',{status:'ACTIVE',later:[['2026-12-01','1000000.00','30000.00'],['2027-01-01','1000000.00','30000.00']]},{status:bSame.state.status,later:bNext.state.periods.slice(1).map(p=>[p.startDate,p.principalBase,p.interest])});
 // Kept from P05: a non-settling payment reversed after the next base was fixed is rejected (dependency rule unchanged).
 const part=pay(s,'h3','2026-11-16','200000.00'),fixed=E.accrueMonthly(part.state,'2026-12-02','2026-12-02T15:00:00.000Z').state;
 check('O5c reversal after dependent base fixed is rejected','REVERSAL_DEPENDENCY',code(()=>E.compensateMonthly(fixed,'h3','r4','2026-12-05','2026-12-05T15:00:00.000Z','acc-CASH')));
 // The new rule must not over-reject: a partial principal payment (loan not paid off) reversed after the frontier,
 // with no later base fixed yet, stays under the pre-existing dependency rule only.
 let partial;try{const late=E.compensateMonthly(part.state,'h3','r5','2026-12-05','2026-12-05T15:00:00.000Z','acc-CASH'),later=E.accrueMonthly(late.state,'2027-01-02','2027-01-02T15:00:00.000Z').state;partial={reversal:'ACCEPTED',status:late.state.status,principal:late.principalOutstanding,later:later.periods.slice(1).map(p=>[p.startDate,p.principalBase])};}catch(e){partial={reversal:'REJECTED',code:e.code};}
 results.push({id:'O5f partial payment reversed after frontier is not caught by the payoff rule',expected:'ACCEPTED and ACTIVE (rule scoped to payoff)',observed:partial,pass:partial.reversal==='ACCEPTED'&&partial.status==='ACTIVE'});
 // Interest-only payment on an ACTIVE loan is not a payoff either.
 const io=pay(s,'h4','2026-12-01','30000.00');let ioOut;try{const r=E.compensateMonthly(io.state,'h4','r6','2026-12-05','2026-12-05T15:00:00.000Z','acc-CASH');ioOut={reversal:'ACCEPTED',status:r.state.status};}catch(e){ioOut={reversal:'REJECTED',code:e.code};}
 results.push({id:'O5g interest-only payment reversal is not treated as payoff',expected:'ACCEPTED, or REVERSAL_DEPENDENCY only from the pre-existing rule',observed:ioOut,pass:ioOut.reversal==='ACCEPTED'||ioOut.code==='REVERSAL_DEPENDENCY'});
});

test('O6 distribution A8, savings A9, month summary by book and E/K cuts',()=>{
 assert.ok(check('O6 510k 50/50',['255000.00','255000.00'],E.distributeMonthly('510000.00',['0.500000','0.500000'],'3255000.00','510000.00')));
 assert.ok(check('O6 one cent residual to last non-zero',['0.00','0.01'],E.distributeMonthly('0.01',['0.500000','0.500000'],'1.00','1.00')));
 assert.ok(check('O6 thirds',['33.33','33.33','33.34'],E.distributeMonthly('100.00',['0.333333','0.333333','0.333334'],'100.00','100.00')));
 assert.ok(check('O6 trailing zero destination',['50.00','50.00','0.00'],E.distributeMonthly('100.00',['0.500000','0.500000','0.000000'],'100.00','100.00')));
 assert.ok(check('O6 not above free cash','INSUFFICIENT_AVAILABLE_FUNDS',code(()=>E.distributeMonthly('510000.00',['0.500000','0.500000'],'500000.00','510000.00'))));
 assert.ok(check('O6 not above surplus','INSUFFICIENT_AVAILABLE_FUNDS',code(()=>E.distributeMonthly('600000.00',['0.500000','0.500000'],'3255000.00','510000.00'))));
 assert.ok(check('O6 fractions must sum 1','INPUT_INVALID',code(()=>E.distributeMonthly('100.00',['0.500000','0.400000'],'100.00','100.00'))));
 const six=['2026-11-15','2026-12-15','2027-01-15','2027-02-15','2027-03-15','2027-04-15'];
 assert.ok(check('O6 3M over six opportunities',{shortfall:'3000000.00',amounts:Array(6).fill('500000.00')},(({shortfall,amounts})=>({shortfall,amounts}))(E.monthlySavings('3000000.00','0.00',six,'2027-05-15'))));
 assert.ok(check('O6 100/3 floor then rest',['33.33','33.33','33.34'],E.monthlySavings('100.00','0.00',six.slice(0,3),'2027-05-15').amounts));
 assert.ok(check('O6 opportunity on due date excluded',5,E.monthlySavings('3000000.00','0.00',[...six.slice(1),'2027-05-15'],'2027-05-15').dates.length));
 assert.ok(check('O6 goal without months = required now',{requiredNow:'3000000.00',dates:[]},(({requiredNow,dates})=>({requiredNow,dates}))(E.monthlySavings('3000000.00','0.00',[],'2027-05-15'))));
 assert.ok(check('O6 reserve covers quota',{shortfall:'0.00'},{shortfall:E.monthlySavings('3000000.00','3000000.00',six,'2027-05-15').shortfall}));
 // Reference November by book: business interest 240k is moved to personal by one relationship (two legs).
 const k='2026-11-30T12:00:00.000Z',f=(id,bookId,date,kind,amount,extra={})=>({id,bookId,effectiveDate:date,knownAt:'2026-11-'+date.slice(-2)+'T15:00:00.000Z',kind,amount,...extra});
 const flows=[f('i1','B','2026-11-01','INTEREST_CASH','150000.00'),f('i2','B','2026-11-01','INTEREST_CASH','90000.00'),f('pr','B','2026-11-01','PRINCIPAL_RECOVERY','1000000.00'),
  f('w-b','B','2026-11-02','FUNDING_TRANSFER','-240000.00',{relationshipId:'rel1'}),f('w-p','P','2026-11-02','FUNDING_TRANSFER','240000.00',{relationshipId:'rel1'}),
  f('sal','P','2026-11-03','EXTERNAL_INCOME','2500000.00'),f('e1','P','2026-11-04','EXPENSE_PAID','700000.00'),f('e2','P','2026-11-05','EXPENSE_PAID','180000.00'),f('e3','P','2026-11-06','EXPENSE_PAID','500000.00'),
  f('d1','P','2026-11-10','DEBT_PAID','200000.00'),f('d2','P','2026-11-10','DEBT_PAID','150000.00'),f('sv','P','2026-11-15','DEBT_RESERVATION','500000.00'),
  f('dec','P','2026-12-01','EXTERNAL_INCOME','9000000.00')];
 const pick=r=>({income:r.income,expenses:r.expenses,debt:r.debt,savings:r.savings,base:r.baseSurplus});
 assert.ok(check('O6 consolidated reference (no second 240k, principal not income)',{income:'2740000.00',expenses:'1380000.00',debt:'350000.00',savings:'500000.00',base:'510000.00'},pick(E.summarizeMonthly(flows,['B','P'],'2026-11','2026-11-30',k,true))));
 assert.ok(check('O6 personal book alone',{income:'2500000.00',expenses:'1380000.00',debt:'350000.00',savings:'500000.00',base:'510000.00'},pick(E.summarizeMonthly(flows,['P'],'2026-11','2026-11-30',k))));
 assert.ok(check('O6 business book alone nets to zero after transfer','0.00',E.summarizeMonthly(flows,['B'],'2026-11','2026-11-30',k).baseSurplus));
 // Counterexample: December income cannot cover November outflows; K cut hides facts not yet known.
 assert.ok(check('O6 E cut excludes later expense','2040000.00',E.summarizeMonthly(flows,['B','P'],'2026-11','2026-11-04',k,true).baseSurplus));
 assert.ok(check('O6 K cut shows what was known then','2740000.00',E.summarizeMonthly(flows,['B','P'],'2026-11','2026-11-30','2026-11-03T23:00:00.000Z',true).income));
 assert.ok(check('O6 half relationship rejected in consolidated','CONSOLIDATION_INCOMPLETE',code(()=>E.summarizeMonthly(flows.filter(x=>x.id!=='w-b'),['B','P'],'2026-11','2026-11-30',k,true))));
 assert.ok(check('O6 duplicate source rejected','INTEGRITY_MISMATCH',code(()=>E.summarizeMonthly([...flows,flows[0]],['B','P'],'2026-11','2026-11-30',k,true))));
 const dist=E.summarizeMonthly([...flows,f('ds','P','2026-11-20','DISTRIBUTION','510000.00')],['B','P'],'2026-11','2026-11-30',k,true);
 assert.ok(check('O6 after distribution remaining 0',{distributed:'510000.00',remaining:'0.00',deficit:'0.00'},{distributed:dist.distributedSurplus,remaining:dist.remainingSurplus,deficit:dist.distributionDeficit}));
 // History guard: posterior income does not finance earlier outflow; range and closed periods.
 const h=(x)=>code(()=>E.assertMonthlyHistory({effectiveDate:'2026-10-10',today:'2026-11-03',cutoffDate:'2026-09-30',closedPeriods:[],duplicate:false,affectedFacts:1,incompatible:false,availabilityByDate:['100.00'],...x}));
 assert.ok(check('O6 history negative intermediate availability','INSUFFICIENT_AVAILABLE_FUNDS',h({availabilityByDate:['100.00','-50.00','500.00']})));
 assert.ok(check('O6 history >366 days','HISTORY_RANGE_UNSUPPORTED',h({effectiveDate:'2025-11-01',cutoffDate:null})));
 assert.ok(check('O6 history future','HISTORY_RANGE_UNSUPPORTED',h({effectiveDate:'2026-11-04'})));
 assert.ok(check('O6 history closed period','PERIOD_CLOSED',h({closedPeriods:[{from:'2026-10-01',to:'2026-10-31'}]})));
 assert.ok(check('O6 history duplicate','SOURCE_ALREADY_USED',h({duplicate:true})));
 assert.ok(check('O6 history unknown closure fails closed','PERIOD_CLOSURE_UNAVAILABLE',h({closedPeriods:null})));
 let before;try{before=E.assertMonthlyHistory({effectiveDate:'2026-09-15',today:'2026-11-03',cutoffDate:'2026-09-30',closedPeriods:null,duplicate:false,affectedFacts:1,incompatible:false,availabilityByDate:[]});}catch(e){before=e.code;}
 assert.ok(check('O6 history at/before cutoff informational','INFORMATIONAL',before));
});

test.after(()=>{writeFileSync(new URL('./ms-p05-r2-oracle-result.json',import.meta.url),JSON.stringify({task:'MS-P05-R2',engine:'Caudelyx/servidor/dist-ms-p04-r2/src/modules/lending/ms-engine.js',at:new Date().toISOString(),total:results.length,failed:results.filter(r=>!r.pass).map(r=>r.id),results},null,2)+'\n');});
