import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BSON,Decimal128} from 'mongodb';
import {randomBytes} from 'node:crypto';
import {reconstruct,dpd,percent,validDate,recordedDate,stock} from '../../src/modules/reporting/engine.js';
import {ReportTokens} from '../../src/modules/reporting/token.js';
import {reportingContract} from '../../src/modules/reporting/contract.js';
import {bootstrapReportingFinance} from '../../src/modules/finance/scoped-integrity.js';
import type {Database} from '../../src/shared/database.js';
import type {ClientSession} from 'mongodb';
import type {Sources,Authority,Cut} from '../../src/modules/reporting/models.js';
import {assertOwnUri} from './profile.js';
import type {Loan,Borrower} from '../../src/modules/lending/models.js';
import type {Event,Position,Installment,Schedule} from '../../src/modules/lending/operations-models.js';
import {exactHash} from '../../src/modules/lending/evidence-v2.js';
const cut:Cut={asOf:'2026-10-27',from:'2026-10-01',to:'2026-10-27',recordedThrough:'2026-10-28T00:00:00.000Z'};
const auth:Authority={actorId:'T',organizationId:'ORG',roles:['T'],isT:true,isC:false,isO:false,isP:false,loanIds:[],scopeKind:'ORGANIZATION',binding:'unit'};
function fixture():Sources{
 const loans=['A','B'].map((id,i)=>({_id:id,organizationId:'ORG',borrowerId:'B'+id,status:'TERMS_CONFIRMED',terms:{principal:i?'1000000.00':'2000000.00'}} as unknown as Loan));
 const borrowers=loans.map(l=>({_id:l.borrowerId,borrowerCode:l.borrowerId,profile:{displayName:l.borrowerId},status:'INACTIVE'} as Borrower));
 const positions=loans.map(l=>({_id:l._id,loanId:l._id,borrowerId:l.borrowerId,fundingEventId:'FUND'+l._id,originalPrincipal:l.terms.principal,principalOutstanding:l.terms.principal} as Position));
 const installments=loans.map((l,i)=>({_id:l._id+':1:1',organizationId:'ORG',loanId:l._id,scheduleVersion:1,number:1,dueDate:i?'2026-11-01':'2026-09-26',principal:i?'100000.00':'1000.00',interest:'0.00',principalPaid:'0.00',interestPaid:'0.00',active:true,supersededByVersion:null,createdAt:'2026-09-01T15:00:00.000Z'} as Installment));
 const events=loans.map(l=>({_id:'FUND'+l._id,kind:'DISBURSE',loanIds:[l._id],borrowerId:l.borrowerId,effectiveDate:'2026-09-01',recordedAt:'2026-09-01T15:00:00.000Z',plan:{postings:[{accountId:'P',debit:l.terms.principal,credit:'0.00'}],allocations:[],accruals:[],scheduleRevisions:[],positions:[],creditChange:null}} as unknown as Event));
 const schedules=loans.map(l=>({_id:l._id+':1',loanId:l._id,version:1,eventId:'FUND'+l._id,createdAt:'2026-09-01T15:00:00.000Z'} as Schedule));
 return{loans,borrowers,positions,installments,schedules,events,compensations:[],snapshots:[],payments:[],custody:[],held:[],deliveries:[],facts:[],actions:[],journeys:[],stations:[],bindings:[],reconciliation:[],opening:[],accounts:[],journals:[{_id:'J',effectiveDate:'2026-09-01',recordedAt:'2026-09-01T15:00:00.000Z',lines:[{accountId:'P',debit:Decimal128.fromString('3000000.00'),credit:Decimal128.fromString('0.00')}]} as Sources['journals'][number]],profile:{_id:'ORG',organizationId:'ORG',profile:{principalAccountId:'P',interestReceivableAccountId:'I',interestIncomeAccountId:'Y',borrowerCreditAccountId:'C'}},versions:'unit',currentDate:'2026-10-28'};
}
test('PAR31 distinguishes small overdue amount from whole exposure, inactive borrower retained',()=>{
 const r=reconstruct(fixture(),cut,auth);assert.equal(r.metrics.get('PRINCIPAL_OVERDUE')?.value,'1000.00');assert.equal(r.metrics.get('PRINCIPAL_EXPOSED_OVERDUE')?.value,'2000000.00');assert.equal(r.metrics.get('PAR30')?.value,'66.67');
});
test('DPD30 excluded; partial cent still exposes whole loan; due today DPD0',()=>{
 let s=fixture();s.installments[0]!.dueDate='2026-09-27';assert.equal(reconstruct(s,cut,auth).metrics.get('PAR30')?.value,'0.00');
 s=fixture();s.events.push({...s.events[0]!,_id:'PAY',kind:'APPLY_CREDIT',effectiveDate:'2026-10-01',recordedAt:'2026-10-01T15:00:00.000Z',plan:{...s.events[0]!.plan,postings:[],allocations:[{loanId:'A',scheduleVersion:1,installmentNumber:1,component:'DUE_PRINCIPAL',amount:'999.99'}]}});s.journals[0]!.lines[0]!.debit=Decimal128.fromString('2999000.01');
 const r=reconstruct(s,cut,auth);assert.equal(r.metrics.get('PRINCIPAL_OVERDUE')?.value,'0.01');assert.equal(r.metrics.get('PRINCIPAL_EXPOSED_OVERDUE')?.value,'1999000.01');assert.equal(dpd('2026-10-27','2026-10-27'),0);
});
test('legacy bridge makes total PAR null, covered subset explicit, not invented calendar',()=>{
 const s=fixture();s.journals[0]!.lines[0]!.debit=Decimal128.fromString('4000000.00');const r=reconstruct(s,cut,auth);assert.equal(r.metrics.get('PAR30')?.value,null);assert.equal(r.coverage.principalCoveragePercent,'75.00');assert.equal(r.coverage.partialPercent,'66.67');assert.equal(r.coverage.unclassifiablePrincipal,'1000000.00');
});
test('double cut excludes later compensation and late knowledge; no accrual when reading',()=>{
 const s=fixture(),original=structuredClone(s.events[0]!);s.installments[0]!.interest='100000.00';
 s.events.push({...structuredClone(s.events[0]!),_id:'PRIOR_ACCRUAL',kind:'ACCRUE',effectiveDate:'2026-09-26',recordedAt:'2026-09-26T15:00:00.000Z',plan:{...structuredClone(s.events[0]!.plan),postings:[],accruals:[{loanId:'A',scheduleVersion:1,installmentNumber:1,dueDate:'2026-09-26',interest:'100000.00'}]}});
 original._id='RECEIPT';original.kind='RECEIPT';original.effectiveDate='2026-10-25';original.recordedAt='2026-10-25T15:00:00.000Z';original.plan={...original.plan,postings:[{accountId:'BANK',debit:'100000.00',credit:'0.00'},{accountId:'I',debit:'0.00',credit:'100000.00'}],allocations:[{loanId:'A',scheduleVersion:1,installmentNumber:1,component:'INTEREST',amount:'100000.00'}]};s.events.push(original);s.compensations.push({_id:'REV',organizationId:'ORG',originalEventId:'RECEIPT',effectiveDate:'2026-10-27',createdAt:'2026-10-27T16:00:00.000Z'});
 const before=reconstruct(s,{...cut,asOf:'2026-10-26',to:'2026-10-26'},auth);assert.equal(before.metrics.get('INTEREST_RECEIVED')?.value,'100000.00');assert.equal(before.metrics.get('INTEREST_ACCRUED')?.value,'0.00');
 const after=reconstruct(s,cut,auth);assert.equal(after.metrics.get('INTEREST_RECEIVED')?.gross,'100000.00');assert.equal(after.metrics.get('INTEREST_RECEIVED')?.net,'0.00');
 const earlier=reconstruct(s,{...cut,recordedThrough:'2026-10-25T14:59:59.999Z'},auth);assert.equal(earlier.metrics.get('INTEREST_RECEIVED')?.value,'0.00');
});
test('dates and integer HALF_UP ratio, invalid days, denominator zero',()=>{
 assert.equal(percent(200000000n,300000000n),'66.67');assert.equal(percent(0n,0n),null);assert.equal(validDate('2026-02-30'),false);assert.equal(recordedDate('2026-10-01T04:59:59.999Z'),'2026-09-30');assert.equal(recordedDate('2026-10-01T05:00:00.000Z'),'2026-10-01');
});
test('encrypted snapshot/cursor purpose binding and corruption; no PII plaintext',()=>{
 const t=new ReportTokens(randomBytes(32)),token=t.seal({actor:'private-subject',org:'private-tenant'},'snapshot');assert.equal(JSON.stringify(t.open(token,'snapshot')),JSON.stringify({actor:'private-subject',org:'private-tenant'}));assert.throws(()=>t.open(token,'cursor'));assert.throws(()=>t.open(token.slice(0,-2)+'AA','snapshot'));assert.equal(Buffer.from(token,'base64url').includes(Buffer.from('private-subject')),false);
});
test('actual P01 closed schema rejects extra properties and non-computable zero',()=>{
 const c=reportingContract();assert.throws(()=>c.validate('Indicator',{id:'PAR30',status:'NO_DENOMINATOR',value:'0.00'}));assert.throws(()=>c.validate('Policy',{arbitrary:true}));
});
test('zero denominator is unavailable ratio, not numeric zero; overflow is closed422',()=>{
 const s=fixture();s.loans=[];s.borrowers=[];s.positions=[];s.events=[];s.installments=[];s.schedules=[];s.journals[0]!.lines[0]!.debit=Decimal128.fromString('0.00');const result=reconstruct(s,cut,auth);assert.equal(result.metrics.get('PAR30')?.status,'NO_DENOMINATOR');assert.equal(result.metrics.get('PAR30')?.value,null);
 assert.throws(()=>stock('LIQUIDITY_BOOK',100000000000000000000n),(e:unknown)=>e instanceof Error&&'code'in e&&e.code==='MONEY_OVERFLOW');
});
test('initialization refuses persistent owner database before any access',async()=>{
 const db={db:{databaseName:'caudelyx_dev'}} as unknown as Database;
 await assert.rejects(bootstrapReportingFinance(db,{} as ClientSession),(e:unknown)=>e instanceof Error&&'code'in e&&e.code==='ACCESS_DENIED');
});
test('catalogue preserves unavailable ratio units and all31 IDs without invented concentration scalar',()=>{
 const r=reconstruct(fixture(),cut,auth),catalog=reportingContract().document.components.schemas['Indicator'] as {properties:{id:{enum:string[]}}};
 assert.equal(catalog.properties.id.enum.length,31);assert.deepEqual([...r.metrics.keys()].sort(),catalog.properties.id.enum.filter(id=>id!=='BORROWER_CONCENTRATION').sort());
 for(const id of ['RETURN_ON_AVERAGE_CAPITAL','OBLIGATIONS_COVERAGE']){const m=r.metrics.get(id)!;assert.equal(m.kind,'RATIO');assert.equal(m.unit,'PERCENT');assert.equal(m.status,'UNAVAILABLE');assert.equal(m.value,null);}
 assert.equal(r.metrics.get('INTEGRAL_NET_WORTH')!.unit,'COP');
 assert.equal(reconstruct(fixture(),{...cut,from:'2026-09-01'},auth).metrics.get('PRINCIPAL_DISBURSED')!.value,'3000000.00');
});
test('cured, interest-only exposure, principal-zero and paid-today settled use cut facts',()=>{
 const makePayment=(s:Sources,component:'DUE_PRINCIPAL'|'EXTRA_PRINCIPAL'|'INTEREST',value:string)=>s.events.push({...s.events[0]!,_id:'PAY'+s.events.length,kind:'APPLY_CREDIT',effectiveDate:'2026-10-01',recordedAt:'2026-10-01T15:00:00.000Z',plan:{...s.events[0]!.plan,postings:[],allocations:[{loanId:'A',scheduleVersion:1,installmentNumber:1,component,amount:value}]}});
 let s=fixture();makePayment(s,'DUE_PRINCIPAL','1000.00');s.journals[0]!.lines[0]!.debit=Decimal128.fromString('2999000.00');let r=reconstruct(s,cut,auth);assert.equal(r.loans.get('A')!.dpd,0);assert.equal(r.metrics.get('PAR30')!.value,'0.00');
 s=fixture();s.installments[0]!.principal='0.00';s.installments[0]!.interest='1000.00';r=reconstruct(s,cut,auth);assert.equal(r.loans.get('A')!.overdue,0n);assert.equal(r.metrics.get('PRINCIPAL_EXPOSED_OVERDUE')!.value,'2000000.00');
 makePayment(s,'EXTRA_PRINCIPAL','2000000.00');s.journals[0]!.lines[0]!.debit=Decimal128.fromString('1000000.00');r=reconstruct(s,cut,auth);assert.equal(r.loans.get('A')!.row['state'],'ACTIVE');assert.equal(r.metrics.get('PRINCIPAL_EXPOSED_OVERDUE')!.value,'0.00');assert.equal(r.loans.get('A')!.interestOverdue,100000n);
 s.installments[0]!.dueDate=cut.asOf;assert.equal(reconstruct(s,cut,auth).loans.get('A')!.row['state'],'ACTIVE');makePayment(s,'INTEREST','1000.00');r=reconstruct(s,cut,auth);assert.equal(r.loans.get('A')!.row['state'],'SETTLED');assert.equal(r.metrics.get('INTEREST_SATISFIED_BY_CREDIT')!.value,'1000.00');assert.equal(r.metrics.get('INTEREST_RECEIVED')!.value,'0.00');assert.equal(r.metrics.get('RECEIPTS_CONFIRMED')!.value,'0.00');
});
test('collector flow compensates on its own date; historical state and activity do not use current flags',()=>{
 const s=fixture(),e={...s.events[0]!,_id:'R',kind:'RECEIPT' as const,effectiveDate:'2026-10-10',recordedAt:'2026-10-10T15:00:00.000Z',plan:{...s.events[0]!.plan,postings:[{accountId:'BANK',debit:'300000.00',credit:'0.00'}],allocations:[]}};s.events.push(e);
 s.payments.push({_id:'PAY',organizationId:'ORG',registrarId:'C',approvalMode:'SUPERVISED',status:'REVERSED',eventId:'R',effectiveDate:'2026-10-10',recordedAt:'2026-10-09T15:00:00.000Z',intent:{amount:'300000.00',method:'BANK'}});
 s.paymentTransitions=[{_id:'TR1',organizationId:'ORG',paymentId:'PAY',version:1,operation:'registerPayment',createdAt:'2026-10-09T15:00:00.000Z'},{_id:'TR2',organizationId:'ORG',paymentId:'PAY',version:2,operation:'approvePayment',createdAt:e.recordedAt},{_id:'TR3',organizationId:'ORG',paymentId:'PAY',version:3,operation:'executePaymentReversal',createdAt:'2026-10-25T15:00:00.000Z'}];
 s.compensations.push({_id:'COMP',organizationId:'ORG',originalEventId:'R',effectiveDate:'2026-10-25',createdAt:'2026-10-25T15:00:00.000Z'});
 s.journeys.push({_id:'JOURNEY',organizationId:'ORG',ownerId:'C',status:'CLOSED',recordedAt:'2026-10-09T15:00:00.000Z',closedAt:'2026-10-25T15:00:00.000Z'});
 s.actions.push({_id:'LATE_ACTION',organizationId:'ORG',ownerId:'C',recordedAt:'2026-10-25T15:00:00.000Z'});
 let r=reconstruct(s,{...cut,asOf:'2026-10-11',to:'2026-10-11',recordedThrough:'2026-10-11T23:00:00.000Z'},auth),row=r.rows.COLLECTORS[0]!;assert.equal((row['confirmed'] as {gross:string}).gross,'300000.00');assert.equal(row['openJourneys'],1);assert.equal(row['actionsCount'],0);assert.equal(r.rows.MOVEMENTS.find(x=>x['nature']==='REGISTERED_PAYMENT')!['state'],'CONFIRMED');
 r=reconstruct(s,{...cut,from:'2026-10-20'},auth);row=r.rows.COLLECTORS[0]!;assert.equal((row['confirmed'] as {gross:string}).gross,'0.00');assert.equal((row['confirmed'] as {compensations:string}).compensations,'300000.00');assert.equal((row['confirmed'] as {net:string}).net,'-300000.00');
 row=reconstruct(s,cut,auth).rows.COLLECTORS[0]!;assert.equal((row['confirmed'] as {gross:string}).gross,'300000.00');assert.equal((row['confirmed'] as {net:string}).net,'0.00');
});
test('test profile rejects protected manual port, remote host and unknown replica profile',()=>{
 for(const uri of ['mongodb://127.0.0.1:27181/?replicaSet=rs0','mongodb://remote.example:27017/?replicaSet=rs0','mongodb://127.0.0.1:27017/?replicaSet=other'])assert.throws(()=>assertOwnUri(uri),/Protected/);
});
test('fulfilment cohort excludes extra principal and replays compensation at cut',()=>{
 const s=fixture();s.installments[0]!.dueDate='2026-10-10';s.installments[0]!.interest='1000.00';
 s.events.push({...s.events[0]!,_id:'COHORT_PAY',kind:'APPLY_CREDIT',effectiveDate:'2026-10-11',recordedAt:'2026-10-11T15:00:00.000Z',plan:{...s.events[0]!.plan,postings:[],allocations:[{loanId:'A',scheduleVersion:1,installmentNumber:1,component:'DUE_PRINCIPAL',amount:'500.00'},{loanId:'A',scheduleVersion:1,installmentNumber:1,component:'INTEREST',amount:'500.00'},{loanId:'A',scheduleVersion:1,installmentNumber:1,component:'EXTRA_PRINCIPAL',amount:'100.00'}]}});
 s.journals[0]!.lines[0]!.debit=Decimal128.fromString('2999400.00');let r=reconstruct(s,cut,auth);assert.equal(r.metrics.get('INSTALLMENT_FULFILMENT')!.numerator,'1000.00');assert.equal(r.metrics.get('INSTALLMENT_FULFILMENT')!.denominator,'2000.00');assert.equal(r.metrics.get('INSTALLMENT_FULFILMENT')!.value,'50.00');
 s.compensations.push({_id:'COHORT_COMP',organizationId:'ORG',originalEventId:'COHORT_PAY',effectiveDate:'2026-10-25',createdAt:'2026-10-25T15:00:00.000Z'});s.journals.push({...s.journals[0]!,_id:'COMP_JOURNAL',effectiveDate:'2026-10-25',recordedAt:'2026-10-25T15:00:00.000Z',lines:[{accountId:'P',debit:Decimal128.fromString('600.00'),credit:Decimal128.fromString('0.00')}]});r=reconstruct(s,cut,auth);assert.equal(r.metrics.get('INSTALLMENT_FULFILMENT')!.value,'0.00');assert.equal(reconstruct(s,{...cut,asOf:'2026-10-24',to:'2026-10-24'},auth).metrics.get('INSTALLMENT_FULFILMENT')!.value,'50.00');
});
test('optimized evidence hash is byte compatible with frozen S07-P04 for strict BSON and plain documents',async()=>{
 const reference=await import(new URL('../../../dist-s07-p04/src/modules/lending/evidence-v2.js',import.meta.url).href) as {exactHash:(v:unknown)=>string};
 const values:unknown[]=[null,undefined,true,false,'á漢字\\\"\n',0,-0,1,-1,2147483647,2147483648,-2147483649,1.25,NaN,Infinity,-Infinity,2n**63n,new Date('2026-10-27T05:00:00Z'),Decimal128.fromString('123.45'),BSON.Long.fromString('9223372036854775807'),new BSON.ObjectId('000000000000000000000001'),new BSON.Timestamp({t:7,i:2}),new BSON.Binary(Buffer.from([0,255,1])),/foo/i,{'10':'ten','2':'two',a:undefined,quoted:'\"',arr:[undefined,null,-0]},Object.assign(Object.create(null),{z:1,a:2})];
 for(let i=0;i<250;i++)values.push({namespace:'hmac-v1:synthetic',key:'rows|P|'+i,priority:'a'.repeat(64),height:i%31+1,data:{id:String(i),documentHash:'b'.repeat(64),collection:'synthetic',meta:{version:i,active:i%2===0,amount:i+'.00',recordedAt:'2026-10-27T05:00:00Z'}},left:{id:'l',hash:'c'.repeat(64),height:i%11+1,count:i*13},right:null});
 for(const[i,value]of values.entries())assert.equal(exactHash(value),reference.exactHash(value),'vector '+i);
 assert.throws(()=>exactHash(/foo/gi));assert.throws(()=>reference.exactHash(/foo/gi));
 const circular:Record<string,unknown>={};circular['self']=circular;assert.throws(()=>exactHash(circular));
});
