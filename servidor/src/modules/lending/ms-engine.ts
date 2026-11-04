/* eslint-disable security/detect-object-injection -- Distribution indices are integers bounded by a validated array of at most three destinations. */
import {AppError} from '../../shared/errors.js';
import type {MonthlyTerms,MonthlyState,MonthlyPeriod,MonthlyFact,MonthlyPlan,MonthlyPayment,MonthlyPost,HistoryCheck,MonthlyFlow} from './ms-models.js';
import type {Profile} from './operations-models.js';

const MAX=999999999999999999n, RATE=1000000000000n, FRACTION=1000000n;
const fail=(code:string,status=409):never=>{throw new AppError(status,code);};
export function msCents(value:string):bigint{
 if(!/^-?(?:0|[1-9]\d{0,15})\.\d{2}$/.test(value)||value==='-0.00')fail('INPUT_INVALID',422);
 const negative=value.startsWith('-'),text=negative?value.slice(1):value;
 const n=BigInt(text.replace('.',''));if(n>MAX)fail('MONEY_OVERFLOW',422);return negative?-n:n;
}
export function msMoney(n:bigint):string{
 const a=n<0n?-n:n;if(a>MAX)fail('MONEY_OVERFLOW',422);
 return(n<0n?'-':'')+(a/100n)+'.'+(a%100n).toString().padStart(2,'0');
}
const positive=(v:string)=>{const n=msCents(v);if(n<=0n)fail('INPUT_INVALID',422);return n;};
const sum=(xs:string[])=>xs.reduce((n,x)=>n+msCents(x),0n);
export function msRate(rate:string):bigint{
 if(!/^(?:0\.\d{12}|1\.000000000000)$/.test(rate))fail('INPUT_INVALID',422);return BigInt(rate.replace('.',''));
}
export const monthlyInterest=(principal:string,rate:string)=>{
 const p=msCents(principal);if(p<0n)fail('INPUT_INVALID',422);
 return msMoney((p*msRate(rate)+RATE/2n)/RATE);
};
export function msDate(date:string):Date{
 if(!/^(?:20|21)\d\d-\d\d-\d\d$/.test(date))fail('INPUT_INVALID',422);
 const result=new Date(date+'T00:00:00.000Z');if(!Number.isFinite(result.valueOf())||result.toISOString().slice(0,10)!==date)fail('INPUT_INVALID',422);return result;
}
export function msDue(terms:Pick<MonthlyTerms,'effectiveDate'|'anchor'>,ordinal:number):string{
 if(!Number.isInteger(ordinal)||ordinal<1||ordinal>2400)fail('INPUT_INVALID',422);
 const start=msDate(terms.effectiveDate),month=start.getUTCMonth()+ordinal;
 const last=new Date(Date.UTC(start.getUTCFullYear(),month+1,0));
 const day=terms.anchor.mode==='END_OF_MONTH'?last.getUTCDate():terms.anchor.day;
 if(day===undefined||!Number.isInteger(day)||day<1||day>31)fail('INPUT_INVALID',422);
 const result=new Date(Date.UTC(start.getUTCFullYear(),month,Math.min(day!,last.getUTCDate()))).toISOString().slice(0,10);
 msDate(result);return result;
}
export function validateMonthlyTerms(t:MonthlyTerms){
 if(t.modality!=='MONTHLY_OPEN_V1'||t.usage!=='LOCAL_SYNTHETIC')fail('REAL_USE_NOT_ALLOWED',403);
 if(positive(t.principal)>100000000000000n)fail('INPUT_INVALID',422);msRate(t.monthlyRate);
 const date=msDate(t.effectiveDate),last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();
 if(t.anchor.mode==='END_OF_MONTH'?(t.anchor.day!==undefined||date.getUTCDate()!==last):t.anchor.mode!=='DAY_OF_MONTH'||t.anchor.day!==date.getUTCDate())fail('IRREGULAR_PERIOD_UNSUPPORTED',422);
 if(msDue(t,1)!==t.firstDueDate)fail('IRREGULAR_PERIOD_UNSUPPORTED',422);
 if(!t.supportReference.trim()||!t.mappingVersion.trim())fail('INPUT_INVALID',422);
}
function visibleFacts(state:MonthlyState,effective:string,known='9999-12-31T23:59:59.999Z'){
 return state.facts.filter(f=>f.effectiveDate<=effective&&f.recordedAt<=known);
}
export function monthlyPrincipal(state:MonthlyState,effective:string,known?:string){
 let p=msCents(state.terms.principal);
 for(const f of visibleFacts(state,effective,known))p+=f.kind==='COMPENSATION'?msCents(f.principal):-msCents(f.principal);
 if(p<0n)fail('INTEGRITY_MISMATCH',503);return p;
}
const paid=(facts:MonthlyFact[],ordinal:number)=>facts.reduce((n,f)=>n+(f.kind==='COMPENSATION'?-1n:1n)*sum(f.interest.filter(a=>a.ordinal===ordinal).map(a=>a.amount)),0n);
export function monthlyPosition(state:MonthlyState,effective:string,known='9999-12-31T23:59:59.999Z'){
 msDate(effective);const facts=visibleFacts(state,effective,known),periods=state.periods.filter(p=>p.fixedAt<=known);
 let due=0n,overdue=0n,recognized=0n,cash=0n,credit=0n,unrecognized=0n,count=0;let oldest:string|null=null;
 for(const p of periods){
  const remaining=msCents(p.interest)-paid(facts,p.ordinal);if(remaining<0n)fail('INTEGRITY_MISMATCH',503);
  const opening=state.origin.cutoffDate!==null&&state.origin.cutoffDate<=effective?msCents(p.openingRecognizedInterest??'0.00'):0n;
  if(p.dueDate<=effective){due+=remaining;if(!p.recognizedAt||p.recognizedAt>known||p.recognitionDate!>effective){const openingLeft=opening-paid(facts,p.ordinal);unrecognized+=remaining-(openingLeft>0n?openingLeft:0n);}}
  if(p.dueDate<effective&&remaining>0n){overdue+=remaining;count++;if(oldest===null||p.dueDate.localeCompare(oldest)<0)oldest=p.dueDate;}
  recognized+=opening;if(p.recognizedAt&&p.recognizedAt<=known&&p.recognitionDate!<=effective)recognized+=msCents(p.interest)-opening;
 }
 for(const f of facts){const amount=sum(f.interest.map(a=>a.amount));if(f.kind==='CREDIT_APPLICATION')credit+=amount;else if(f.kind==='PAYMENT')cash+=amount;else{const source=state.facts.find(x=>x.id===f.reverses);if(!source)fail('INTEGRITY_MISMATCH',503);if(source!.kind==='CREDIT_APPLICATION')credit-=amount;else cash-=amount;}}
 return{principal:msMoney(monthlyPrincipal(state,effective,known)),principalOverdue:'0.00',interestDue:msMoney(due),interestOverdue:msMoney(overdue),interestDueUnrecognized:msMoney(unrecognized),interestRecognized:msMoney(recognized),interestCashCollected:msMoney(cash),interestSatisfiedByCredit:msMoney(credit),interestReceivable:msMoney(recognized-cash-credit),overduePeriodCount:count,oldestUnpaidDueDate:oldest};
}
export function newMonthlyState(id:string,book:string,terms:MonthlyTerms,profile:Profile,at:string,originEvent:string,termsVersion=1):MonthlyState{
 validateMonthlyTerms(terms);if(new Set(Object.values(profile)).size!==4)fail('ACCOUNT_PROFILE_CONFLICT');
 return{id,organizationId:book,bookId:book,borrowerId:terms.borrowerId,version:1,terms:structuredClone(terms),profile:structuredClone(profile),rateVersions:[{version:termsVersion,effectiveFrom:terms.effectiveDate,rate:terms.monthlyRate}],periods:[{ordinal:1,startDate:terms.effectiveDate,dueDate:terms.firstDueDate,principalBase:terms.principal,rate:terms.monthlyRate,termsVersion,interest:monthlyInterest(terms.principal,terms.monthlyRate),fixedAt:at,recognizedAt:null,recognitionDate:null}],facts:[],status:'ACTIVE',origin:{kind:'DISBURSEMENT',eventId:originEvent,cutoffDate:null,recognizedInterest:'0.00'},createdAt:at};
}
function planFor(source:MonthlyState):MonthlyPlan{
 return{state:structuredClone(source),postings:[],newAccruals:[],newPeriods:[],fact:null,principalOutstanding:'0.00',interestApplied:'0.00',principalApplied:'0.00',creditAdded:'0.00',creditUsed:'0.00',catchupPending:false};
}
function post(plan:MonthlyPlan,accountId:string,delta:bigint){if(delta===0n)return;plan.postings.push({accountId,debit:delta>0n?msMoney(delta):'0.00',credit:delta<0n?msMoney(-delta):'0.00'});}
function finish(plan:MonthlyPlan,date:string){
 const amounts=new Map<string,bigint>();for(const l of plan.postings)amounts.set(l.accountId,(amounts.get(l.accountId)??0n)+msCents(l.debit)-msCents(l.credit));
 plan.postings=[...amounts].filter(([,v])=>v!==0n).sort(([a],[b])=>a.localeCompare(b)).map(([accountId,n])=>({accountId,debit:n>0n?msMoney(n):'0.00',credit:n<0n?msMoney(-n):'0.00'}));
 if(plan.postings.reduce((n,l)=>n+msCents(l.debit)-msCents(l.credit),0n)!==0n)fail('INTEGRITY_MISMATCH',503);
 const position=monthlyPosition(plan.state,date);plan.principalOutstanding=position.principal;
 if(position.principal==='0.00'&&position.interestReceivable==='0.00'&&position.interestDue==='0.00')plan.state.status='SETTLED';else plan.state.status='ACTIVE';
 return plan;
}
function ensurePeriods(plan:MonthlyPlan,date:string,at:string,maxPeriods=12){
 const s=plan.state;let added=0;
 while(s.periods.length){
  const previous=s.periods.at(-1)!,start=previous.dueDate;
  // Boundary-day receipts must run before fixing the next cycle's base.
  if(start>=date)break;
  const p=monthlyPrincipal(s,start);if(p===0n)break;
  if(added>=maxPeriods){plan.catchupPending=true;break;}
  const rate=s.rateVersions.filter(v=>v.effectiveFrom<=start).sort((a,b)=>a.effectiveFrom.localeCompare(b.effectiveFrom)||a.version-b.version).at(-1)!;
  const ordinal=previous.ordinal+1,period:MonthlyPeriod={ordinal,startDate:start,dueDate:msDue(s.terms,ordinal),principalBase:msMoney(p),rate:rate.rate,termsVersion:rate.version,interest:monthlyInterest(msMoney(p),rate.rate),fixedAt:at,recognizedAt:null,recognitionDate:null};
  s.periods.push(period);plan.newPeriods.push(ordinal);added++;
 }
}
function recognize(plan:MonthlyPlan,period:MonthlyPeriod,date:string,at:string){
 if(period.recognizedAt)return;
 period.recognizedAt=at;period.recognitionDate=date;plan.newAccruals.push(period.ordinal);
 const amount=msCents(period.interest)-msCents(period.openingRecognizedInterest??'0.00');post(plan,plan.state.profile.interestReceivableAccountId,amount);post(plan,plan.state.profile.interestIncomeAccountId,-amount);
}
export function accrueMonthly(source:MonthlyState,through:string,at:string,maxPeriods=12):MonthlyPlan{
 msDate(through);if(!Number.isInteger(maxPeriods)||maxPeriods<1||maxPeriods>12)fail('INPUT_INVALID',422);
 const plan=planFor(source);ensurePeriods(plan,through,at,maxPeriods);
 let recognized=0;for(const period of plan.state.periods){if(period.dueDate>through||period.recognizedAt)continue;if(recognized>=maxPeriods){plan.catchupPending=true;break;}recognize(plan,period,period.dueDate,at);recognized++;}
 if(plan.newAccruals.length||plan.newPeriods.length)plan.state.version++;
 return finish(plan,through);
}
export function applyMonthlyPayment(source:MonthlyState,p:MonthlyPayment):MonthlyPlan{
 msDate(p.effectiveDate);const gross=positive(p.amount),plan=planFor(source),s=plan.state;
 if(s.status!=='ACTIVE'||p.effectiveDate<s.terms.effectiveDate||s.facts.some(f=>f.id===p.id))fail('INVALID_STATE');
 ensurePeriods(plan,p.effectiveDate,p.recordedAt);if(plan.catchupPending)fail('ACCRUAL_CATCHUP_REQUIRED');
 if(s.facts.some(f=>f.effectiveDate>p.effectiveDate)||s.periods.some(v=>v.startDate>=p.effectiveDate&&v.ordinal>1))fail('HISTORY_DEPENDENCY_CONFLICT');
 const facts=visibleFacts(s,p.effectiveDate);let left=gross;const allocations:{ordinal:number;amount:string}[]=[];
 for(const period of s.periods.filter(v=>v.dueDate<=p.effectiveDate).sort((a,b)=>a.ordinal-b.ordinal)){
  recognize(plan,period,period.dueDate,p.recordedAt);const need=msCents(period.interest)-paid(facts,period.ordinal),take=left<need?left:need;
  if(take>0n){allocations.push({ordinal:period.ordinal,amount:msMoney(take)});left-=take;}
 }
 const principal=monthlyPrincipal(s,p.effectiveDate),current=s.periods.find(v=>(v.ordinal===1?v.startDate<=p.effectiveDate:v.startDate<p.effectiveDate)&&v.dueDate>=p.effectiveDate);
 if(p.mode==='SETTLEMENT'&&current&&current.dueDate>p.effectiveDate){
  recognize(plan,current,p.effectiveDate,p.recordedAt);const need=msCents(current.interest)-paid(facts,current.ordinal),take=left<need?left:need;
  if(take>0n){allocations.push({ordinal:current.ordinal,amount:msMoney(take)});left-=take;}
  if(take<need)fail('SETTLEMENT_AMOUNT_INSUFFICIENT');
 }else if(left>=principal&&principal>0n&&current&&current.dueDate>p.effectiveDate)fail('SETTLEMENT_PREVIEW_REQUIRED',422);
 const appliedPrincipal=left<principal?left:principal;left-=appliedPrincipal;
 if(p.mode==='SETTLEMENT'&&appliedPrincipal!==principal)fail('SETTLEMENT_AMOUNT_INSUFFICIENT');
 if(left>0n&&(p.excess==='REJECT'||p.source==='BORROWER_CREDIT'))fail('EXCESS_NOT_ALLOWED');
 if(p.source==='BORROWER_CREDIT'&&gross>msCents(p.creditAvailable))fail('CREDIT_INSUFFICIENT');
 const interest=sum(allocations.map(a=>a.amount));
 const fact:MonthlyFact={id:p.id,kind:p.source==='CASH'?'PAYMENT':'CREDIT_APPLICATION',effectiveDate:p.effectiveDate,recordedAt:p.recordedAt,principal:msMoney(appliedPrincipal),interest:allocations,creditAdded:msMoney(left),creditUsed:p.source==='BORROWER_CREDIT'?p.amount:'0.00',amount:p.amount,reverses:null,paymentId:p.paymentId};
 s.facts.push(fact);s.version++;plan.fact=fact;plan.interestApplied=msMoney(interest);plan.principalApplied=msMoney(appliedPrincipal);plan.creditAdded=msMoney(left);plan.creditUsed=fact.creditUsed;
 post(plan,p.source==='CASH'?p.cashAccountId:s.profile.borrowerCreditAccountId,gross);
 post(plan,s.profile.interestReceivableAccountId,-interest);post(plan,s.profile.principalAccountId,-appliedPrincipal);post(plan,s.profile.borrowerCreditAccountId,-left);
 return finish(plan,p.effectiveDate);
}
export function compensateMonthly(source:MonthlyState,factId:string,reversalId:string,date:string,at:string,counterAccount:string):MonthlyPlan{
 msDate(date);const plan=planFor(source),s=plan.state,original=s.facts.find(f=>f.id===factId&&f.kind!=='COMPENSATION');
 if(!original)fail('RESOURCE_NOT_FOUND',404);if(date<original!.effectiveDate||s.facts.some(f=>f.reverses===factId))fail('ALREADY_REVERSED');
 const index=s.facts.findIndex(f=>f.id===factId);
 // A payoff stops the calendar. Reopening after that calendar's next frontier
 // would leave a zero-principal boundary that can never advance again.
 const paidOff=msCents(original!.principal)>0n&&monthlyPrincipal(s,original!.effectiveDate)===0n;
 const nextBoundary=s.periods.find(p=>p.dueDate>=original!.effectiveDate)?.dueDate;
 if(paidOff&&(!nextBoundary||date>nextBoundary))fail('REVERSAL_DEPENDENCY');
 if(s.facts.slice(index+1).some(f=>f.kind!=='COMPENSATION')||s.periods.some(p=>p.startDate>=original!.effectiveDate&&p.fixedAt>original!.recordedAt))fail('REVERSAL_DEPENDENCY');
 const f:MonthlyFact={...structuredClone(original!),id:reversalId,kind:'COMPENSATION',effectiveDate:date,recordedAt:at,reverses:factId};s.facts.push(f);s.version++;plan.fact=f;
 post(plan,s.profile.principalAccountId,msCents(f.principal));post(plan,s.profile.interestReceivableAccountId,sum(f.interest.map(a=>a.amount)));post(plan,s.profile.borrowerCreditAccountId,msCents(f.creditAdded)-msCents(f.creditUsed));
 if(original!.kind==='PAYMENT')post(plan,counterAccount,-msCents(f.amount));
 return finish(plan,date);
}
export function versionMonthlyRate(source:MonthlyState,rate:string,effectiveFrom:string,today:string){
 msRate(rate);msDate(effectiveFrom);msDate(today);if(effectiveFrom<=today||source.status!=='ACTIVE')fail('FUTURE_VERSION_CONFLICT');
 const index=source.periods.at(-1)!.ordinal;let boundary=false;for(let i=index;i<=index+120;i++){const d=msDue(source.terms,i);if(d===effectiveFrom){boundary=true;break;}if(d>effectiveFrom)break;}
 if(!boundary||source.periods.some(p=>p.startDate>=effectiveFrom))fail('IRREGULAR_PERIOD_UNSUPPORTED',422);
 const s=structuredClone(source);s.rateVersions.push({version:Math.max(...s.rateVersions.map(v=>v.version))+1,effectiveFrom,rate});s.version++;return s;
}
export function assertMonthlyHistory(c:HistoryCheck):'INFORMATIONAL'|'ECONOMIC'{
 const date=msDate(c.effectiveDate),today=msDate(c.today);
 if(c.cutoffDate!==null&&c.effectiveDate<=c.cutoffDate)return'INFORMATIONAL';
 if(date>today||(today.valueOf()-date.valueOf())/86400000>366||c.affectedFacts>1000)fail('HISTORY_RANGE_UNSUPPORTED',422);
 if(c.closedPeriods===null)fail('PERIOD_CLOSURE_UNAVAILABLE');
 for(const p of c.closedPeriods!)if(c.effectiveDate>=p.from&&c.effectiveDate<=p.to)fail('PERIOD_CLOSED');
 if(c.duplicate)fail('SOURCE_ALREADY_USED');if(c.incompatible)fail('HISTORY_DEPENDENCY_CONFLICT');
 if(c.availabilityByDate.some(x=>msCents(x)<0n))fail('INSUFFICIENT_AVAILABLE_FUNDS');return'ECONOMIC';
}
export function distributeMonthly(amount:string,fractions:string[],available:string,surplus:string):string[]{
 const n=positive(amount);if(n>msCents(available)||n>msCents(surplus))fail('INSUFFICIENT_AVAILABLE_FUNDS');
 if(fractions.length<1||fractions.length>3||fractions.some(v=>!/^(?:0\.\d{6}|1\.000000)$/.test(v)))fail('INPUT_INVALID',422);
 const parts=fractions.map(v=>BigInt(v.replace('.','')));if(parts.reduce((a,z)=>a+z,0n)!==FRACTION)fail('INPUT_INVALID',422);
 const last=parts.findLastIndex(v=>v>0n),out=parts.map(()=>0n);let used=0n;
 for(let i=0;i<parts.length;i++){const x=i===last?n-used:n*parts[i]!/FRACTION;out[i]=x;used+=x;}
 return out.map(msMoney);
}
export function monthlySavings(quota:string,reserved:string,dates:string[],due:string){
 msDate(due);if(msCents(quota)<0n||msCents(reserved)<0n)fail('INPUT_INVALID',422);
 for(const d of dates)msDate(d);if(new Set(dates).size!==dates.length||dates.length>366)fail('INPUT_INVALID',422);
 const opportunities=dates.filter(d=>d<due).sort(),shortfall=msCents(quota)>msCents(reserved)?msCents(quota)-msCents(reserved):0n;
 if(!opportunities.length)return{shortfall:msMoney(shortfall),dates:[],amounts:[],requiredNow:msMoney(shortfall)};
 const amount=shortfall/BigInt(opportunities.length),amounts=opportunities.map((_,i)=>msMoney(i===opportunities.length-1?shortfall-amount*BigInt(i):amount));
 return{shortfall:msMoney(shortfall),dates:opportunities,amounts,requiredNow:'0.00'};
}
export function summarizeMonthly(flows:MonthlyFlow[],bookIds:string[],month:string,effective:string,known:string,consolidated=false){
 if(!/^(?:20|21)\d\d-(?:0[1-9]|1[0-2])$/.test(month))fail('INPUT_INVALID',422);msDate(effective);
 const rows=flows.filter(f=>bookIds.includes(f.bookId)&&f.effectiveDate.startsWith(month)&&f.effectiveDate<=effective&&f.knownAt<=known);
 if(new Set(rows.map(r=>r.id)).size!==rows.length)fail('INTEGRITY_MISMATCH',503);
 if(consolidated){for(const id of new Set(rows.filter(r=>r.relationshipId).map(r=>r.relationshipId!)))for(const phase of ['ORIGIN','REVERSAL'] as const){const legs=rows.filter(r=>r.relationshipId===id&&(r.relationshipLeg??'ORIGIN')===phase);if(legs.length&&(legs.length!==2||sum(legs.map(x=>x.amount))!==0n))fail('CONSOLIDATION_INCOMPLETE');}}
 const total=(kind:MonthlyFlow['kind'])=>sum(rows.filter(f=>f.kind===kind&&!f.alreadyDistributedSource).map(f=>f.amount));
 const income=total('INTEREST_CASH')+total('EXTERNAL_INCOME'),funding=total('FUNDING_TRANSFER'),expenses=total('EXPENSE_PAID'),debt=total('DEBT_PAID'),savings=total('DEBT_RESERVATION'),distributed=total('DISTRIBUTION');
 const base=income+funding-expenses-debt-savings,remaining=base-distributed;
 return{income:msMoney(income),funding:msMoney(funding),expenses:msMoney(expenses),debt:msMoney(debt),savings:msMoney(savings),baseSurplus:msMoney(base),distributedSurplus:msMoney(distributed),remainingSurplus:msMoney(remaining>0n?remaining:0n),distributionDeficit:msMoney(remaining<0n?-remaining:0n)};
}
export function assertMonthlyPostsBalanced(lines:MonthlyPost[]){if(lines.reduce((n,l)=>n+msCents(l.debit)-msCents(l.credit),0n)!==0n)fail('INTEGRITY_MISMATCH',503);}
