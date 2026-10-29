import {AppError} from '../../shared/errors.js';
import {Decimal60,rounded} from '../lending/decimal.js';
import {cents,money} from '../finance/money.js';
import type {Rule,Rate,Schedule,Installment} from './models.js';
export function validDate(value:unknown):value is string{return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;}
export const today=(now:number)=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
export const day=(date:string,n:number)=>new Date(Date.parse(date)+n*86400000).toISOString().slice(0,10);
const last=(y:number,m:number)=>new Date(Date.UTC(y,m,0)).getUTCDate();
const month=(date:string,offset:number,anchor:number|'LAST_DAY')=>{const d=new Date(date),idx=d.getUTCFullYear()*12+d.getUTCMonth()+offset,y=Math.floor(idx/12),m=idx%12+1;return String(y).padStart(4,'0')+'-'+String(m).padStart(2,'0')+'-'+String(anchor==='LAST_DAY'?last(y,m):Math.min(anchor,last(y,m))).padStart(2,'0');};
export function occurrences(rule:Rule,from:string,through:string):string[]{
 if(!validDate(from)||!validDate(through)||from>through||!validDate(rule.startDate)||rule.endDate&&(!validDate(rule.endDate)||rule.endDate<rule.startDate))throw new AppError(422,'INPUT_INVALID');
 const stop=rule.endDate&&rule.endDate<through?rule.endDate:through,start=from>rule.startDate?from:rule.startDate,result=new Set<string>();
 const add=(d:string)=>{if(d>=start&&d<=stop)result.add(d);if(result.size>366)throw new AppError(422,'INPUT_INVALID');};
 if(rule.frequency==='CUSTOM'){if(!rule.customDates?.length||new Set(rule.customDates).size!==rule.customDates.length)throw new AppError(422,'INPUT_INVALID');for(const d of rule.customDates){if(!validDate(d))throw new AppError(422,'INPUT_INVALID');add(d);}}
 else if(['DAILY','WEEKLY','FORTNIGHTLY'].includes(rule.frequency)){
  if(rule.monthDay!==undefined||rule.twiceMonthlyDays||rule.customDates)throw new AppError(422,'INPUT_INVALID');
  const step=rule.frequency==='DAILY'?1:rule.frequency==='WEEKLY'?7:15,skip=Math.max(0,Math.ceil((Date.parse(start)-Date.parse(rule.startDate))/86400000/step));
  for(let d=day(rule.startDate,skip*step);d<=stop;d=day(d,step))add(d);
 }else if(rule.frequency==='TWICE_MONTHLY'){
  if(rule.twiceMonthlyDays?.length!==2||new Set(rule.twiceMonthlyDays).size!==2||rule.monthDay!==undefined)throw new AppError(422,'INPUT_INVALID');
  for(let n=0;;n++){const first=month(rule.startDate,n,1);if(first>stop)break;for(const v of rule.twiceMonthlyDays){if(v!=='LAST_DAY'&&(!Number.isInteger(v)||v<1||v>28))throw new AppError(422,'INPUT_INVALID');add(month(rule.startDate,n,v));}if(n>12000)throw new AppError(422,'INPUT_INVALID');}
 }else{
  const step=new Map([['MONTHLY',1],['QUARTERLY',3],['SEMIANNUAL',6],['ANNUAL',12]]).get(rule.frequency),anchor=rule.monthDay;
  if(!step||anchor===undefined||anchor!=='LAST_DAY'&&(!Number.isInteger(anchor)||anchor<1||anchor>31)||month(rule.startDate,0,anchor)!==rule.startDate)throw new AppError(422,'INPUT_INVALID');
  for(let n=0;;n+=step){const d=month(rule.startDate,n,anchor);if(d>stop)break;add(d);if(n>12000)throw new AppError(422,'INPUT_INVALID');}
 }return [...result].sort();
}
const gcd=(a:bigint,b:bigint):bigint=>b?gcd(b,a%b):a;
function rate24(rate:Rate,days:number):Decimal60{
 const value=Decimal60.text(rate.decimalValue),spread=rate.spread===undefined?Decimal60.text('0'):Decimal60.text(rate.spread),r=rate.combine==='ADD'?value.add(spread):value;
 if(rate.kind==='NONE_DECLARED'&&r.c!==0n||rate.combine==='ADD'&&rate.spread===undefined||!['NONE','ADD'].includes(rate.combine))throw new AppError(422,'INPUT_INVALID');
 if(rate.convention==='ANNUAL_SIMPLE_ACT_365'&&rate.unit==='ANNUAL_FRACTION')return r.mul(Decimal60.fraction(BigInt(days),365n));
 if(rate.convention==='PERIODIC_EFFECTIVE'&&rate.unit==='PERIOD_FRACTION'&&rate.periodDefinition)return r;
 if(rate.convention!=='ANNUAL_EFFECTIVE_ACT_365'||rate.unit!=='ANNUAL_FRACTION'||days<0||days>3660)throw new AppError(422,'UNSUPPORTED_PROJECTION');
 const scale=10n**24n,to24=(x:Decimal60)=>x.e+24>=0?x.c*10n**BigInt(x.e+24):rounded(x.c,10n**BigInt(-x.e-24));
 const fraction=to24(r);if(fraction<0n)throw new AppError(422,'INPUT_INVALID');
 if(!days||!fraction)return Decimal60.text('0');
 const g=gcd(BigInt(days),365n),p=BigInt(days)/g,q=365n/g,num=(scale+fraction)**p,den=scale**p,target=num*scale**q;
 let lo=scale,hi=2n*scale;while(hi**q*den<=target)hi*=2n;
 while(hi-lo>1n){const mid=(lo+hi)/2n;if(mid**q*den<=target)lo=mid;else hi=mid;}
 const midPower=(2n*lo+1n)**q*den,exact=num*(2n*scale)**q;
 const result=lo+(midPower<exact||midPower===exact&&lo%2n===1n?1n:0n)-scale;
 return new Decimal60(result,-24);
}
export function schedule(input:Schedule,rate:Rate,principal:string):Schedule{
 if(!validDate(input.validFrom)||!validDate(input.referenceDate)||!input.installments.length||input.installments.length>1000||!validDate(rate.validFrom)||!validDate(rate.observedOn))throw new AppError(422,'INPUT_INVALID');
 const p=cents(principal);if(p<=0n)throw new AppError(422,'INPUT_INVALID');let previous=input.referenceDate,remaining=p;
 const result:Installment[]=[];
 for(let i=0;i<input.installments.length;i++){
  // eslint-disable-next-line security/detect-object-injection -- Integer loop index is bounded by this validated installment array.
  const row=input.installments[i]!;
  if(row.number!==i+1||!validDate(row.dueDate)||row.dueDate<=previous)throw new AppError(422,'INPUT_INVALID');
  let part=cents(row.principal),interest=cents(row.interest);
  if(input.kind==='PROJECTED'){
   if(!['EQUAL_PRINCIPAL','DECLARED_PRINCIPAL_SCHEDULE'].includes(input.projectionMethod??''))throw new AppError(422,'UNSUPPORTED_PROJECTION');
   if(input.projectionMethod==='EQUAL_PRINCIPAL')part=i===input.installments.length-1?remaining:p/BigInt(input.installments.length);
   if(rate.validFrom>previous||rate.validTo&&rate.validTo<row.dueDate||rate.kind==='VARIABLE'&&rate.resetDates?.some(d=>d>previous&&d<row.dueDate))throw new AppError(422,'UNSUPPORTED_PROJECTION');
   interest=new Decimal60(remaining,-2).mul(rate24(rate,(Date.parse(row.dueDate)-Date.parse(previous))/86400000)).cents();
  }
  if(part<0n||part>remaining)throw new AppError(422,'COMPONENT_MISMATCH');remaining-=part;
  const total=part+interest+cents(row.insurance)+cents(row.fees);
  if(input.kind==='OFFICIAL_DECLARED'&&cents(row.total)!==total)throw new AppError(422,'COMPONENT_MISMATCH');
  result.push({...row,principal:money(part),interest:money(interest),total:money(total)});previous=row.dueDate;
 }
 if(remaining!==0n||cents(input.principalOpening)!==p)throw new AppError(422,'COMPONENT_MISMATCH');return{...input,installments:result};
}
