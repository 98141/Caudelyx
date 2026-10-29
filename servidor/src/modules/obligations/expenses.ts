import {randomUUID} from 'node:crypto';
import {AppError} from '../../shared/errors.js';
import {cents,money} from '../finance/money.js';
import {hash} from './codec.js';
import {occurrences,day,today,validDate} from './calendar.js';
import {table,type CommandContext,type Expense,type Rule,type Event,type Row,type Data} from './models.js';
export const live=(events:Event[])=>{const reversed=new Set(events.filter(e=>e.reversalOfId).map(e=>e.reversalOfId));return events.filter(e=>!e.reversalOfId&&!reversed.has(e._id));};
export async function entityEvents(c:CommandContext,id:string){return(await c.store.all<Event>(table(c.scope.kind,'events'),c.scope,c.s)).filter(e=>e.entityId===id);}
export function expensePosition(events:Event[]){const xs=live(events),recognized=xs.filter(e=>e.kind==='EXPENSE_RECOGNIZE').reduce((n,e)=>n+cents(e.amount),0n),paid=xs.filter(e=>e.kind==='EXPENSE_PAY').reduce((n,e)=>n+cents(e.amount),0n);if(paid<0n||paid>recognized)throw new AppError(503,'SOURCE_INCONSISTENT');return{recognized,paid,outstanding:recognized-paid};}
const fields=(c:CommandContext)=>({bookId:c.scope.bookId,ownerId:c.scope.ownerId,domainKind:c.scope.kind});
const positive=(value:unknown)=>{const n=cents(String(value));if(n<=0n)throw new AppError(422,'INPUT_INVALID');return n;};
const occurrenceId=(series:string,date:string)=>{const h=hash([series,date]);return h.slice(0,8)+'-'+h.slice(8,12)+'-5'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);};
const body=(row:Row)=>{const {mac,recordedAt,...value}=row;void mac;void recordedAt;return value;};
export async function expenseCommand(c:CommandContext,action:string):Promise<Row>{
 const p=c.payload,name=table(c.scope.kind,'expenses'),ruleTable=table(c.scope.kind,'expense_rules');
 if(action==='createExpense'){
  if(!validDate(p['nominalDate'])||!validDate(p['dueDate'])||p['amountMode']==='FIXED'&&p['amount']===undefined)throw new AppError(422,'INPUT_INVALID');
  if(p['amount']!==undefined)positive(p['amount']);
  return await c.store.put(name,{_id:randomUUID(),...fields(c),...p,version:1,planningStatus:p['amount']===undefined?'UNPRICED':'PLANNED'},c.s);
 }
 if(action==='createExpenseRule'||action==='versionExpenseRule'){
  const id=action==='createExpenseRule'?randomUUID():c.params['ruleId']!,old=action==='createExpenseRule'?null:await c.store.get<Rule>(ruleTable,id,c.scope,c.s);
  const effectiveFrom=old?String(p['effectiveFrom']):String(p['startDate']);
  if(old&&(!validDate(effectiveFrom)||effectiveFrom<=today(c.identity.now())))throw new AppError(409,'FUTURE_VERSION_CONFLICT');
  const candidate={_id:id,...fields(c),...p,seriesId:id,version:(old?.version??0)+1,effectiveFrom} as Rule;
  occurrences(candidate,candidate.startDate,[candidate.endDate??day(candidate.startDate,365),day(candidate.startDate,365)].sort()[0]!);
  if(candidate.amountMode==='FIXED')positive(candidate.amount);
  if(old){
   const planned=(await c.store.all<Expense>(name,c.scope,c.s)).filter(e=>e.seriesId===id&&e.nominalDate>=effectiveFrom),dates=planned.length?occurrences(candidate,planned.map(e=>e.nominalDate).sort()[0]!,planned.map(e=>e.nominalDate).sort().at(-1)!):[];
   for(const e of planned){if((await entityEvents(c,e._id)).some(x=>x.kind==='EXPENSE_RECOGNIZE'))throw new AppError(409,'FUTURE_VERSION_CONFLICT');
    await c.store.put(name,{...body(e),version:e.version+1,planningStatus:'CANCELLED',supersededByVersion:candidate.version},c.s);
   }
   for(const date of dates){const prior=planned.find(e=>e.nominalDate===date);await c.store.put(name,{_id:occurrenceId(id,date),...fields(c),version:(prior?.version??0)+1,nominalDate:date,dueDate:date,description:candidate.description,category:candidate.category,amountMode:candidate.amountMode,...(candidate.amount!==undefined?{amount:candidate.amount}:{}),supportReference:candidate.supportReference,planningStatus:candidate.amount===undefined?'UNPRICED':'PLANNED',seriesId:id,ruleVersionId:id+':'+candidate.version},c.s);}
  }
  return await c.store.put(ruleTable,candidate,c.s);
 }
 if(action==='generateOccurrences'){
  const rule=await c.store.get<Rule>(ruleTable,c.params['ruleId']!,c.scope,c.s),history=await c.store.all<Row>(table(c.scope.kind,'history'),c.scope,c.s);
  const versions=[...history.filter(r=>r['entityTable']===ruleTable&&r['entityId']===rule._id).map(r=>r['payload'] as Rule),rule].sort((a,b)=>a.effectiveFrom.localeCompare(b.effectiveFrom));
  const existing=await c.store.all<Expense>(name,c.scope,c.s);let count=0;
  // eslint-disable-next-line security/detect-object-injection -- Both indexes are bounded by the sorted authenticated rule-version array.
  for(let i=0;i<versions.length;i++){const r=versions[i]!,from=[String(p['from']),r.effectiveFrom].sort().at(-1)!,through=versions[i+1]?[String(p['through']),day(versions[i+1]!.effectiveFrom,-1)].sort()[0]!:String(p['through']);if(from>through)continue;
   for(const date of occurrences(r,from,through)){
    if(++count>366)throw new AppError(422,'INPUT_INVALID');const id=occurrenceId(rule._id,date);if(existing.some(e=>e._id===id))continue;
    await c.store.put(name,{_id:id,...fields(c),version:1,nominalDate:date,dueDate:date,description:r.description,category:r.category,amountMode:r.amountMode,...(r.amount!==undefined?{amount:r.amount}:{}),supportReference:r.supportReference,planningStatus:r.amount===undefined?'UNPRICED':'PLANNED',seriesId:rule._id,ruleVersionId:rule._id+':'+r.version},c.s);
   }
  }return rule;
 }
 let row=await c.store.get<Expense>(name,c.params['expenseId']!,c.scope,c.s);let events=await entityEvents(c,row._id),position=expensePosition(events);
 if(action==='cancelExpense'){
  if(events.some(e=>e.kind==='EXPENSE_RECOGNIZE'))throw new AppError(409,'INVALID_STATE');return await c.store.put(name,{...body(row),version:row.version+1,planningStatus:'CANCELLED'},c.s);
 }
 const recognize=async()=>{
  if(row.planningStatus==='CANCELLED'||events.some(e=>e.kind==='EXPENSE_RECOGNIZE'))throw new AppError(409,'INVALID_STATE');
  const amount=positive(p['amount']);if(row.amountMode==='FIXED'&&row.amount!==p['amount'])throw new AppError(422,'COMPONENT_MISMATCH');
  await c.ledger.account(c.scope,String(p['expenseAccountId']),c.s,{accountClass:'EXPENSE',kind:['GENERAL']});await c.ledger.account(c.scope,String(p['payableAccountId']),c.s,{accountClass:'LIABILITY',kind:['GENERAL']});
  await c.post(row._id,'EXPENSE_RECOGNIZE',String(p['effectiveDate']),money(amount),[{accountId:String(p['expenseAccountId']),debit:money(amount),credit:'0.00'},{accountId:String(p['payableAccountId']),debit:'0.00',credit:money(amount)}],[],{payableAccountId:p['payableAccountId'],expenseAccountId:p['expenseAccountId']});
  row=await c.store.put(name,{...body(row),version:row.version+1,amount:money(amount),planningStatus:'PLANNED'},c.s) as Expense;events=await entityEvents(c,row._id);position=expensePosition(events);
 };
 const pay=async()=>{
  const amount=positive(p['amount']),recognition=live(events).find(e=>e.kind==='EXPENSE_RECOGNIZE');
  if(!recognition||amount>position.outstanding||String(p['effectiveDate'])<recognition.effectiveDate)throw new AppError(409,'INVALID_STATE');
  await c.ledger.account(c.scope,String(p['cashAccountId']),c.s,{accountClass:'ASSET',kind:['CASH','BANK']});
  await c.post(row._id,'EXPENSE_PAY',String(p['effectiveDate']),money(amount),[{accountId:String(recognition.components['payableAccountId']),debit:money(amount),credit:'0.00'},{accountId:String(p['cashAccountId']),debit:'0.00',credit:money(amount)}]);
 };
 if(action==='recognizeExpense'||action==='recognizeAndPayExpense')await recognize();
 if(action==='payExpense'||action==='recognizeAndPayExpense')await pay();
 if(action==='reverseExpensePayment'||action==='reverseExpenseRecognition'){
  const id=action==='reverseExpensePayment'?c.params['paymentId']:c.params['eventId'],original=events.find(e=>e._id===id);
  if(!original||original.kind!==(action==='reverseExpensePayment'?'EXPENSE_PAY':'EXPENSE_RECOGNIZE'))throw new AppError(404,'RESOURCE_NOT_FOUND');
  if(original.components['relationshipId'])throw new AppError(409,'DOMAIN_REVERSAL_FORBIDDEN');
  if(events.some(e=>e.reversalOfId===id))throw new AppError(409,'ALREADY_REVERSED');
  if(action==='reverseExpenseRecognition'&&position.paid!==0n)throw new AppError(409,'INVALID_STATE');
  if(String(p['effectiveDate'])<original.effectiveDate)throw new AppError(422,'INPUT_INVALID');
  const eventId=randomUUID(),j=await c.ledger.inverse(c.scope,original.journalIds[0]!,eventId,String(p['effectiveDate']),String(p['supportReference']),c.s);
  await c.post(row._id,action==='reverseExpensePayment'?'EXPENSE_PAYMENT_REVERSE':'EXPENSE_RECOGNITION_REVERSE',String(p['effectiveDate']),original.amount,[],[],{},original._id,j);
 }
 return await c.store.put(name,{...body(row),version:row.version+1},c.s);
}
export function publicExpense(row:Expense,events:Event[]):Data{
 const pos=expensePosition(events),recognition=events.some(e=>e.kind==='EXPENSE_RECOGNIZE');
 return{id:row._id,version:row.version,nominalDate:row.nominalDate,dueDate:row.dueDate,description:row.description,category:row.category,amountMode:row.amountMode,...(row.amount!==undefined?{amount:row.amount}:{}),supportReference:row.supportReference,planningStatus:row.planningStatus,recognitionStatus:pos.recognized>0n?'RECOGNIZED':recognition?'REVERSED':'UNRECOGNIZED',settlementStatus:pos.paid===0n?'UNPAID':pos.outstanding===0n?'PAID':'PARTIAL',recognized:money(pos.recognized),paid:money(pos.paid),outstanding:money(pos.outstanding),events:events.map(e=>({id:e._id,kind:e.kind,effectiveDate:e.effectiveDate,amount:e.amount,reversalOfId:e.reversalOfId}))};
}
