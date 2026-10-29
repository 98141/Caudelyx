import {reconstruct} from '../../src/modules/reporting/engine.js';
import type {Sources,Authority} from '../../src/modules/reporting/models.js';
import {decimal} from '../../src/modules/finance/money.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {occurrences,schedule} from '../../src/modules/obligations/calendar.js';
import {liabilityPosition} from '../../src/modules/obligations/liabilities.js';
import type {Rule,Schedule,Rate,Event} from '../../src/modules/obligations/models.js';
const rule=(delta:Partial<Rule>)=>({...delta} as Rule);
test('S09 recurrence all frequencies, original month anchor, leap, fifteen days and two dates differ',()=>{
 const start='2027-01-31';assert.deepEqual(occurrences(rule({startDate:start,frequency:'MONTHLY',monthDay:31}),'2027-01-01','2027-04-30'),['2027-01-31','2027-02-28','2027-03-31','2027-04-30']);
 assert.deepEqual(occurrences(rule({startDate:'2024-02-29',frequency:'ANNUAL',monthDay:29}),'2025-01-01','2028-12-31'),['2025-02-28','2026-02-28','2027-02-28','2028-02-29']);
 assert.deepEqual(occurrences(rule({startDate:'2026-10-01',frequency:'FORTNIGHTLY'}),'2026-10-01','2026-10-31'),['2026-10-01','2026-10-16','2026-10-31']);
 assert.deepEqual(occurrences(rule({startDate:'2026-10-01',frequency:'TWICE_MONTHLY',twiceMonthlyDays:[1,15]}),'2026-10-01','2026-10-31'),['2026-10-01','2026-10-15']);
 for(const frequency of ['DAILY','WEEKLY','QUARTERLY','SEMIANNUAL'])assert.ok(occurrences(rule({startDate:'2026-01-01',frequency,...(['QUARTERLY','SEMIANNUAL'].includes(frequency)?{monthDay:1}:{})}),'2026-01-01','2026-01-20').length);
 assert.deepEqual(occurrences(rule({startDate:'2026-10-01',frequency:'CUSTOM',customDates:['2026-10-03','2026-10-19']}),'2026-10-01','2026-10-31'),['2026-10-03','2026-10-19']);
 assert.throws(()=>occurrences(rule({startDate:'2026-10-01',frequency:'CUSTOM',customDates:['2026-10-03','2026-10-03']}),'2026-10-01','2026-10-31'));
});
test('S09 annual simple variable source 365k * (.10+.02) *30/365 =3600 exact, no official conversion',()=>{
 const source={id:'synthetic',version:1,kind:'PROJECTED',validFrom:'2026-10-01',referenceDate:'2026-10-01',sourceReference:'SYN',principalOpening:'365000.00',rateVersionIds:[],projectionMethod:'EQUAL_PRINCIPAL',installments:[{number:1,dueDate:'2026-10-31',principal:'365000.00',interest:'0.00',insurance:'0.00',fees:'0.00',total:'365000.00'}]} as Schedule;
 const rate={kind:'VARIABLE',source:'SYNTHETIC_DECLARED',sourceReference:'SYN',validFrom:'2026-10-01',observedOn:'2026-10-01',unit:'ANNUAL_FRACTION',convention:'ANNUAL_SIMPLE_ACT_365',decimalValue:'0.10',spread:'0.02',combine:'ADD'} as Rate;
 const result=schedule(source,rate,'365000.00');assert.equal(result.installments[0]!.interest,'3600.00');assert.equal(result.installments[0]!.total,'368600.00');assert.equal(result.kind,'PROJECTED');
 assert.throws(()=>schedule(source,{...rate,convention:'UNKNOWN'},'365000.00'));
});
test('S09 effective annual fraction and principal remainder use exact decimal arithmetic',()=>{
 const source={id:'synthetic',version:1,kind:'PROJECTED',validFrom:'2026-01-01',referenceDate:'2026-01-01',sourceReference:'SYN',principalOpening:'1000.00',rateVersionIds:[],projectionMethod:'EQUAL_PRINCIPAL',installments:[{number:1,dueDate:'2027-01-01',principal:'1000.00',interest:'0.00',insurance:'0.00',fees:'0.00',total:'1000.00'}]} as Schedule;
 const rate={kind:'FIXED',validFrom:'2026-01-01',observedOn:'2026-01-01',unit:'ANNUAL_FRACTION',convention:'ANNUAL_EFFECTIVE_ACT_365',decimalValue:'0.12',combine:'NONE'} as Rate;
 assert.equal(schedule(source,rate,'1000.00').installments[0]!.interest,'120.00');
});
test('S09 principal debt and recognized expenses do not count receipt as income or principal payment as expense',()=>{
 const event=(delta:Partial<Event>)=>({...delta,components:delta.components??{},allocations:delta.allocations??[]} as Event);
 const activation=event({_id:'a',kind:'LIABILITY_ACTIVATE',components:{principalAdded:'1000000.00'},reversalOfId:null}),recognize=event({_id:'r',kind:'LIABILITY_COMPONENT_RECOGNIZE',components:{scheduleVersionId:'s'},allocations:[{installmentNumber:1,component:'INTEREST',amount:'30000.00',accountId:'I'},{installmentNumber:1,component:'INSURANCE',amount:'10000.00',accountId:'S'}],reversalOfId:null}),payment=event({_id:'p',kind:'LIABILITY_PAY',components:{scheduleVersionId:'s'},allocations:[{installmentNumber:1,component:'PRINCIPAL',amount:'200000.00',accountId:'P'},...recognize.allocations],reversalOfId:null});
 const p=liabilityPosition([activation,recognize,payment]);assert.equal(p.principal,80000000n);assert.equal(p.components,0n);
 assert.equal(liabilityPosition([activation,recognize,payment,event({_id:'rev',kind:'LIABILITY_EVENT_REVERSE',reversalOfId:'p'})]).principal,100000000n);
});

test('S09 S8 paired K excludes both journal and original/compensation in millisecond gaps',()=>{
 const e='11111111-1111-4111-8111-111111111111',j='22222222-2222-4222-8222-222222222222',comp='33333333-3333-4333-8333-333333333333',reverse='44444444-4444-4444-8444-444444444444',date='2026-10-28',stamp=(n:number)=>'2026-10-28T17:00:00.00'+n+'Z',line=(accountId:string,debit:string,credit:string)=>({accountId,debit:decimal(debit),credit:decimal(credit)});
 const source={loans:[],borrowers:[],positions:[],installments:[],schedules:[],events:[{_id:e,kind:'RECEIPT',effectiveDate:date,recordedAt:stamp(0),journalId:j,loanIds:[],plan:{postings:[{accountId:'bank',debit:'100.00',credit:'0.00'}],allocations:[],accruals:[],creditChange:null}}],compensations:[{_id:comp,originalEventId:e,effectiveDate:date,createdAt:stamp(2),journalId:reverse}],snapshots:[],payments:[],paymentTransitions:[],custody:[],held:[],deliveries:[],facts:[],actions:[],journeys:[],stations:[],bindings:[],reconciliation:[],opening:[],accounts:[{_id:'bank',accountClass:'ASSET',kind:'BANK',createdAt:stamp(0)},{_id:'debt',accountClass:'LIABILITY',kind:'GENERAL',createdAt:stamp(0)}],journals:[{_id:j,effectiveDate:date,recordedAt:stamp(1),lines:[line('bank','100.00','0.00'),line('debt','0.00','100.00')]},{_id:reverse,effectiveDate:date,recordedAt:stamp(3),lines:[line('debt','100.00','0.00'),line('bank','0.00','100.00')]}],profile:null,currentDate:date,dataThrough:stamp(3),unitKnownAt:{[e]:stamp(1),[j]:stamp(1),[comp]:stamp(3),[reverse]:stamp(3)}} as unknown as Sources,authority:Authority={actorId:'synthetic',roles:['T'],isT:true,isC:false,isO:false,isP:false,scopeKind:'ORGANIZATION',binding:'synthetic',organizationId:'synthetic',loanIds:[]};
 const at=(n:number)=>reconstruct(source,{asOf:date,from:date,to:date,recordedThrough:stamp(n)},authority),metric=(n:number,key:string)=>at(n).metrics.get(key)!.value;
 assert.equal(metric(0,'RECEIPTS_CONFIRMED'),'0.00');assert.equal(metric(0,'LIQUIDITY_BOOK'),'0.00');assert.equal(metric(1,'RECEIPTS_CONFIRMED'),'100.00');assert.equal(metric(1,'LIQUIDITY_BOOK'),'100.00');assert.equal(metric(2,'RECEIPTS_CONFIRMED'),'100.00');assert.equal(metric(2,'LIQUIDITY_BOOK'),'100.00');assert.equal(metric(3,'RECEIPTS_CONFIRMED'),'0.00');assert.equal(metric(3,'LIQUIDITY_BOOK'),'0.00');assert.equal(at(2).rows.MOVEMENTS.length,1);assert.equal(at(3).rows.MOVEMENTS.length,2);
});
