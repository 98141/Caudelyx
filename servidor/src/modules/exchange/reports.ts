/* eslint-disable security/detect-object-injection -- Closed report/column/metric catalogs, typed current source projections and exact decimal aggregation. */
import type {ClientSession} from 'mongodb';
import type {Context} from '../identity/models.js';
import type {IdentityService} from '../identity/service.js';
import {AppError} from '../../shared/errors.js';
import {loadSources} from '../reporting/sources.js';
import {reconstruct,validDate,ageMatches,atCut,inPeriod,type ReportData} from '../reporting/engine.js';
import {ASSIGNED,OWN,type Cut,type Data,type ReportKind,type Sources} from '../reporting/models.js';
import {cents,money,storedCents} from '../finance/money.js';
import {signedCents,wealthTable} from '../wealth/models.js';
import {View} from '../wealth/queries.js';
import {ledgerSources} from '../wealth/sources.js';
import {table,type Row,type Event,type Expense,type Liability} from '../obligations/models.js';
import {expensePosition} from '../obligations/expenses.js';
import {liabilityPosition,effectiveTerms} from '../obligations/liabilities.js';
import {consolidated} from '../obligations/queries.js';
import type {AuthorityState} from './authority.js';
import {exchangeContract} from './contract.js';
import type {ReportCell,ReportRow,Scope} from './models.js';
const countColumns=new Set(['dpd','number','scheduleVersion']);
const textColumns=new Set(['loanId','borrowerId','borrowerCode','borrowerName','origin','ageBand','metricId','eventId','recordedAt','effectiveDate','method','reversalOfId','accountId','responsibleId','paymentId','state','liabilityId','kind','scheduleKind','dueDate','expenseId','planningStatus','fundId','mode','assetId','assetClass','valueDate','sourceKey','rootId','nature','settlementMode','provenanceKind','asOf']);
const aggregates:Record<string,string[]>={PORTFOLIO:['principal','overduePrincipal','overdueInterest'],PORTFOLIO_OVERDUE:['principal','overduePrincipal','overdueInterest'],AGEING:['principal','overduePrincipal'],INSTALLMENTS:['principal','interest','principalPaid','interestPaid'],MOVEMENTS:['principal','interest','amount'],CASH:['book','reserved','available','provisional','confirmed','committed'],COLLECTORS:['registered','confirmed','delivered','custody'],CONCENTRATION:['principal'],OBLIGATIONS:['principal','interest','insurance','fees','paid','outstanding'],EXPENSES:['planned','recognized','paid','compensations','net'],SAVINGS:['allocated','released','transferred','reserved'],ASSETS:['recognizedCost','grossCostDeclared','estimatedGross','estimatedOwn','ownDebt','indicativeEquity'],FUNDING_USES:['amount','cashFlow']};
const reason=(value:unknown)=>typeof value==='string'&&exchangeContract().valid('Reason',value)?value:'MISSING_HISTORY';
export const reportColumnType=(key:string):ReportCell['type']=>key==='existingLink'?'BOOLEAN':countColumns.has(key)?'COUNT':key==='percent'||key==='ownershipPercentage'?'PERCENT':textColumns.has(key)?key==='recordedAt'?'INSTANT':key.endsWith('Date')||key==='asOf'?'DATE':'TEXT':'MONEY';
function cell(key:string,v:unknown,status?:ReportCell['status'],why='NONE'):ReportCell{
 const type=reportColumnType(key);
 let value:ReportCell['value']=v===undefined||v===null?null:typeof v==='bigint'?money(v):typeof v==='boolean'||typeof v==='number'||typeof v==='string'?v:String(v);
 if(type==='MONEY'||type==='PERCENT'){if(typeof value!=='string'||!exchangeContract().valid('SignedMoney',value))value=null;}
 if(type==='COUNT'&&(typeof value!=='number'||!Number.isSafeInteger(value)))value=null;
 const result:ReportCell={columnId:key,type,unit:type==='MONEY'?'COP':type==='PERCENT'?'PERCENT':type==='COUNT'?'COUNT':'NONE',value,status:status??(value===null?'UNAVAILABLE':'COMPLETE'),reason:reason(why)};
 if(result.status!=='COMPLETE')result.value=null;if(result.reason==='MISSING_HISTORY'&&why==='NONE')result.reason='NONE';if(value===null&&result.reason==='NONE')result.reason='MISSING_HISTORY';return result;
}
export function reportRows(kind:string,rows:Data[],cut:Cut):ReportRow[]{
 const columns=exchangeContract().document['x-report-columns'][kind];if(!columns)throw new AppError(422,'INPUT_INVALID');
 return rows.map((r,i)=>{const ref=r['_informationalId']?['INFORMATIONAL',r['_informationalId']]:r['assetId']?['ASSET',r['assetId']]:r['fundId']?['FUND',r['fundId']]:r['liabilityId']?['LIABILITY',r['liabilityId']]:r['eventId']?['EVENT',r['eventId']]:r['loanId']?['SCHEDULE',r['loanId']]:['AGGREGATE',null];return{id:String(r['id']??r['loanId']??r['assetId']??r['liabilityId']??r['expenseId']??r['fundId']??r['metricId']??i),cells:columns.map(k=>cell(k,r[k],(r['_statuses'] as Record<string,ReportCell['status']>|undefined)?.[k],String((r['_reasons'] as Data|undefined)?.[k]??'NONE'))),sourceRefs:[{kind:ref[0],id:ref[1],cut}]};});
}
export function reportTotals(kind:string,rows:ReportRow[]){
 return(aggregates[kind]??[]).map(k=>{const input=kind==='CASH'&&['book','reserved','available'].includes(k)?[...new Map(rows.map(r=>[r.cells.find(c=>c.columnId==='accountId')?.value,r])).values()]:rows,values=input.map(r=>r.cells.find(c=>c.columnId===k)).filter(c=>c?.status!=='NOT_APPLICABLE');if(values.some(c=>!c||c.value===null||c.status!=='COMPLETE'))return cell(k,null,'INCOMPLETE','PARTIAL_COVERAGE');return cell(k,money(values.reduce((n,c)=>n+signedCents(String(c!.value)),0n)));});
}
export function s8Rows(kind:ReportKind,data:ReportData,source:Sources,cut:Cut,borrowerFilter=false):Data[]{
 const borrowerByLoan=new Map([...source.loans,...(source.historicalOrigins??[])].map(l=>[l._id,l.borrowerId]));
 const base=kind==='CONCENTRATION'&&borrowerFilter?data.concentrationAll:data.rows[kind];
 return base.map(raw=>{
  const r:Data={...raw},borrower=r['borrower'] as Data|undefined;r['borrowerCode']=borrower?.['code'];r['borrowerName']=borrower?.['name'];r['borrowerId']=borrower?.['id']??borrowerByLoan.get(String(r['loanId']));
  if(['PORTFOLIO','INSTALLMENTS'].includes(kind)&&r['origin']===undefined)r['origin']=r['state']==='UNCLASSIFIABLE'?'OPENING_UNCLASSIFIABLE':'ORIGINATED_S04';
  if(kind==='CASH')r['book']=r['bookBalance'];
  if(kind==='MOVEMENTS'){
   r['eventId']=r['id'];r['reversalOfId']=r['originalId']??null;
   if(r['sign']===-1)for(const k of ['principal','interest','amount'])if(typeof r[k]==='string')r[k]=money(-signedCents(String(r[k])));
   const event=source.events.find(e=>e._id===r['id']);if(event?.loanIds.length===1){r['loanId']=event.loanIds[0];r['borrowerId']=borrowerByLoan.get(event.loanIds[0]!);}
  }
  if(kind==='RECONCILIATION'){r['method']='BANK';r['difference']=null;}
  if(kind==='COLLECTORS'){
   for(const k of ['registered','confirmed']){const m=r[k] as Data;r[k]=m?.['value'];}
   const cash=data.rows.CASH.filter(c=>c['responsibleId']===r['responsibleId']);r['custody']=cash.some(c=>c['confirmed']===null)?null:money(cash.reduce((n,c)=>n+signedCents(String(c['confirmed']??'0.00')),0n));
   const xs=source.deliveries.filter(d=>d['senderId']===r['responsibleId']&&d['state']==='CONFIRMED'&&inPeriod(String(d['effectiveDate']),cut)&&source.journals.some(j=>j._id===d['journalId']&&atCut(j.effectiveDate,source.unitKnownAt?.[j._id]??j.recordedAt,cut)));r['delivered']=money(xs.reduce((n,d)=>n+(d['kind']==='FORWARD'?1n:-1n)*signedCents(String(d['amount'])),0n));
  }
  return r;
 });
}
async function historical<T extends Row>(identity:IdentityService,scope:Scope,name:string,s:ClientSession,known:string){
 const store=identity.obligations!.store,now=await store.all<T>(name,scope,s),old=await store.all<Row>(table(scope.kind,'history'),scope,s),versions=[...now,...old.filter(r=>r['entityTable']===name).map(r=>r['payload'] as T)],map=new Map<string,T>();for(const r of versions)if(r.recordedAt<=known&&(!map.has(r._id)||map.get(r._id)!.version<r.version))map.set(r._id,r);return[...map.values()];
}
export async function captureReport(identity:IdentityService,context:Context,auth:AuthorityState,kind:string,cut:Cut,filters:Data,s:ClientSession):Promise<{rows:ReportRow[];totals:ReportCell[];coverage:Data}>{
 const started=performance.now(),budget=()=>{if(performance.now()-started>10000)throw new AppError(503,'REPORT_BUDGET_EXCEEDED');},m=identity.obligations!,scope=auth.scope;let rows:Data[]=[],incomplete=false;
 const s8=['PORTFOLIO','PORTFOLIO_OVERDUE','AGEING','PAR30','INSTALLMENTS','MOVEMENTS','INTEREST','PRINCIPAL','CASH','RECONCILIATION','COLLECTORS','CONCENTRATION'];
 if(scope.kind==='BUSINESS'&&s8.includes(kind)){
  const a=auth.business!,p=identity.reporting?.projection,baseKind=['PORTFOLIO_OVERDUE','AGEING'].includes(kind)?'PORTFOLIO':kind,metricView=['PAR30','INTEREST','PRINCIPAL'].includes(kind),source=await p?.load(a,cut,s,metricView?'getReportingDashboard':'listReportingRows',metricView?undefined:baseKind)??await loadSources(identity,scope.bookId,a,s,started);await p?.bind(source,a,s);const data=reconstruct(source,cut,a,budget);incomplete=data.coverage.status!=='COMPLETE';
  if(['INTEREST','PRINCIPAL','PAR30'].includes(kind)){
   const permitted=a.isT?null:new Set([...(a.isC?ASSIGNED:[]),...(a.isC||a.isO?OWN:[])]);
   for(const[id,metric]of data.metrics)if((kind==='PAR30'?id==='PAR30':kind==='INTEREST'?id.startsWith('INTEREST_'):id.startsWith('PRINCIPAL_'))&&(!permitted||permitted.has(id))){rows.push({id,metricId:id,amount:metric.value,gross:metric.gross,compensations:metric.compensations,net:metric.net,numerator:metric.numerator,denominator:metric.denominator,percent:metric.value,_statuses:{amount:metric.status,percent:metric.status},_reasons:{amount:metric.reasons[0]??'NONE',percent:metric.reasons[0]??'NONE'}});}
  }else{
   const base:ReportKind=['PORTFOLIO_OVERDUE','AGEING'].includes(kind)?'PORTFOLIO':kind as ReportKind;
   if(filters['loanId']&&!data.loans.has(String(filters['loanId'])))throw new AppError(404,'RESOURCE_NOT_FOUND');
   if(filters['borrowerId']&&!source.borrowers.some(b=>b._id===filters['borrowerId']&&(a.isT||[...data.loans.values()].some(v=>(v.row['borrower'] as Data)?.['id']===b._id))))throw new AppError(404,'RESOURCE_NOT_FOUND');
   if(filters['accountId']&&!source.accounts.some(x=>x._id===filters['accountId']))throw new AppError(404,'RESOURCE_NOT_FOUND');
   if(filters['responsibleId']&&(!a.isT&&filters['responsibleId']!==a.actorId||a.isT&&!await identity.identities.findOne({_id:String(filters['responsibleId']),organizationId:scope.bookId},{session:s})))throw new AppError(404,'RESOURCE_NOT_FOUND');
   rows=s8Rows(base,data,source,cut,filters['borrowerId']!==undefined);
   if(kind==='PORTFOLIO_OVERDUE')rows=rows.filter(r=>Number(r['dpd'])>0);
   if(kind==='AGEING')rows=rows.map(r=>({...r,ageBand:Number(r['dpd'])===0?'DUE_TODAY':Number(r['dpd'])<=30?'D01_30':Number(r['dpd'])<=60?'D31_60':Number(r['dpd'])<=90?'D61_90':'D91_PLUS'}));
  }
 }else{
  const events=(await m.store.all<Event>(table(scope.kind,'events'),scope,s)).filter(e=>e.effectiveDate<=cut.asOf&&e.unitKnownAt<=cut.recordedThrough),view=await new View(identity.wealth!,scope,s,cut.asOf,cut.recordedThrough).load();
  for(const[key,name]of [['assetId',wealthTable(scope.kind,'assets')],['liabilityId',table(scope.kind,'liabilities')],['fundId',wealthTable(scope.kind,'funds')]] as const)if(filters[key])await m.store.get<Row>(name,String(filters[key]),scope,s);
  if(filters['accountId'])await m.ledger.account(scope,String(filters['accountId']),s);
  if(kind==='OBLIGATIONS'){
   for(const raw of await historical<Liability>(identity,scope,table(scope.kind,'liabilities'),s,cut.recordedThrough)){
    const c=m.context(context,scope,s,{}, {},[],[]),l=await effectiveTerms(c,raw,cut.asOf,cut.recordedThrough),xs=events.filter(e=>e.entityId===l._id),position=liabilityPosition(xs);if(!position.activated&&l.schedule.kind!=='PROJECTED')continue;
    for(const quota of l.schedule.installments){if(quota.dueDate<cut.from||quota.dueDate>cut.to)continue;const paid=xs.filter(e=>e.kind==='LIABILITY_PAY'&&e.components['scheduleVersionId']===l.schedule.id&&!xs.some(r=>r.reversalOfId===e._id)).flatMap(e=>e.allocations).filter(a=>a.installmentNumber===quota.number).reduce((n,a)=>n+cents(a.amount),0n),outstanding=cents(quota.total)-paid;if(outstanding<0n)throw new AppError(503,'SOURCE_INCONSISTENT');rows.push({id:l._id+':'+l.schedule.id+':'+quota.number,liabilityId:l._id,state:l.status,kind:l.kind,scheduleKind:l.schedule.kind,scheduleVersion:l.schedule.version,number:quota.number,dueDate:quota.dueDate,principal:quota.principal,interest:quota.interest,insurance:quota.insurance,fees:quota.fees,paid:money(paid),outstanding:money(outstanding),...(l.schedule.kind==='PROJECTED'?{_statuses:{outstanding:'UNAVAILABLE'},_reasons:{outstanding:'PROJECTED_ONLY'}}:{})});}
   }
  }else if(kind==='EXPENSES'){
   for(const expense of await historical<Expense>(identity,scope,table(scope.kind,'expenses'),s,cut.recordedThrough)){if(expense.dueDate<cut.from||expense.dueDate>cut.to)continue;const xs=events.filter(e=>e.entityId===expense._id),p=expensePosition(xs),gross=xs.filter(e=>e.kind==='EXPENSE_RECOGNIZE').reduce((n,e)=>n+cents(e.amount),0n);rows.push({id:expense._id,expenseId:expense._id,dueDate:expense.dueDate,planningStatus:expense.planningStatus,planned:expense.amount??null,recognized:money(gross),paid:money(p.paid),compensations:money(gross-p.recognized),net:money(p.recognized)});}
  }else if(kind==='SAVINGS'){
   const fs=await identity.wealth!.fundEvents(scope,s);for(const fund of view.funds){const xs=fs.filter(e=>e.entityId===fund._id&&inPeriod(e.effectiveDate,cut)&&e.unitKnownAt<=cut.recordedThrough),sum=(eventKind:string)=>money(xs.filter(e=>e.kind===eventKind).reduce((n,e)=>n+cents(e.amount),0n));rows.push({id:fund._id,fundId:fund._id,state:fund.status,mode:fund.mode,accountId:fund.backingAccountId,allocated:sum('FUND_ALLOCATE'),released:sum('FUND_RELEASE'),transferred:sum('FUND_TRANSFER'),reserved:money(view.reserves.get(fund._id)??0n)});}
  }else if(kind==='ASSETS'){
   for(const asset of view.assets){const a=view.asset(asset),valuation=a['valuation'] as Data|null;rows.push({id:asset._id,assetId:asset._id,state:a['status'],assetClass:a['assetClass'],origin:a['origin'],recognizedCost:a['recognizedCost'],grossCostDeclared:a['grossCostDeclared'],ownershipPercentage:a['ownershipPercentage'],estimatedGross:valuation?.['grossEstimatedValue']??null,estimatedOwn:a['ownedEstimatedValue'],ownDebt:a['linkedPrincipal'],indicativeEquity:a['indicativeEquity'],valueDate:valuation?.['valuationDate']??null});}
  }else if(kind==='FUNDING_USES'){
   for(const r of await m.store.all<Row>('s11_informational_history',scope,s))if(inPeriod(String(r['date']),cut)&&String(r['unitKnownAt'])<=cut.recordedThrough)rows.push({id:r._id,_informationalId:r._id,rootId:r['importId'],effectiveDate:r['date'],sourceKey:r['externalKey'],nature:'INFORMATIONAL',settlementMode:'NOT_APPLICABLE',provenanceKind:'DECLARED',amount:null,cashFlow:null,existingLink:false,_statuses:{amount:'NOT_APPLICABLE',cashFlow:'NOT_APPLICABLE'},_reasons:{amount:'DECLARED_NOT_VERIFIED',cashFlow:'DECLARED_NOT_VERIFIED'}});const xs=await historical<Row>(identity,scope,wealthTable(scope.kind,'asset_funding'),s,cut.recordedThrough);for(const r of xs){const event=view.events.find(e=>e._id===r['sourceEventId']);if(!event||event.effectiveDate<cut.from||event.effectiveDate>cut.to)continue;const details=r['details'] as Data|undefined,nature=r['nature']??details?.['nature'],settlement=r['settlementMode']??details?.['settlementMode'],cashFlow=event.kind==='ASSET_EXISTING_LINK'||nature==='EXISTING_JOURNAL_LINK'||nature==='PENDING_CLASSIFICATION'?'0.00':settlement==='FROM_ACCOUNT'||settlement==='CONSUME_RESERVATION'||event.kind==='EXTERNAL_FUNDS'?r['amount']:'0.00';rows.push({id:r._id,assetId:r['assetId'],rootId:r['sourceEventId'],effectiveDate:event.effectiveDate,sourceKey:r._id,nature,settlementMode:settlement,provenanceKind:r['provenanceKind'],amount:r['amount'],cashFlow,existingLink:event.kind==='ASSET_EXISTING_LINK'});}
  }else if(kind==='CASH'){
   const accounts=await m.store.all<Row>('s09_personal_accounts',scope,s);for(const a of accounts.filter(a=>['CASH','BANK'].includes(String(a['kind'])))){const c=await view.availability(a._id);rows.push({id:a._id,accountId:a._id,book:c.confirmedCash,reserved:money(cents(c.legacyProtected)+cents(c.fundReserved)),available:c.free,provisional:'0.00',confirmed:'0.00',committed:'0.00'});}
  }else if(['NET_WORTH','NET_WORTH_EVOLUTION','PERSONAL_SUMMARY'].includes(kind)){
   const cuts:string[]=[];if(kind==='NET_WORTH_EVOLUTION'){
    let year=Number(cut.from.slice(0,4)),month=Number(cut.from.slice(5,7));while(true){const end=new Date(Date.UTC(year,month,0)).toISOString().slice(0,10);if(end>=cut.asOf)break;if(end>=cut.from)cuts.push(end);if(++month===13){month=1;year++;}if(cuts.length>=24)throw new AppError(422,'REPORT_SCOPE_TOO_LARGE');}cuts.push(cut.asOf);
   }else cuts.push(cut.asOf);
   for(const date of cuts){
    budget();const totals=await m.ledger.totals(scope,s,date,cut.recordedThrough),v=date===cut.asOf?view:await new View(identity.wealth!,scope,s,date,cut.recordedThrough).load(),p=await v.positions(),base=totals.assets-totals.liabilities;
    const claims=(await historical<Row>(identity,scope,wealthTable(scope.kind,'source_claims'),s,cut.recordedThrough)).filter(c=>c['status']==='CLAIMED'&&v.events.some(e=>e._id===c['sourceEventId'])),source=await ledgerSources(identity.wealth!,scope,s);
    let missing=false;
    if('opening'in source)for(const raw of source.opening){const o=raw as unknown as import('../opening/models.js').OpeningRow;if(o.status!=='POSTED'||!o.commit||o.snapshot.cutoffDate>date||o.commit.recordedAt>cut.recordedThrough)continue;for(const c of o.snapshot.components.filter(c=>['BASIC_ASSET','BASIC_INVESTMENT'].includes(c.category)))if(claims.filter(r=>r['componentId']===c.id).reduce((n,r)=>n+cents(String(r['amount'])),0n)<cents(c.amount))missing=true;}
    for(const stub of await historical<Row>(identity,scope,table(scope.kind,'asset_stubs'),s,cut.recordedThrough)){const event=events.find(e=>e._id===stub['sourceEventId']);if(event&&event.effectiveDate<=date&&!events.some(e=>e.reversalOfId===event._id)&&!v.assets.some(a=>a._id===stub['wealthAssetId']&&a.acquisitionEventId===stub['wealthRootId']&&v.asset(a)['status']==='ACTIVE')&&!claims.some(c=>c['sourceKind']==='EXISTING_S09'&&c['sourceId']===stub._id))missing=true;}
    const estimate=missing||p.ownedEstimatedValue===null?null:cents(p.ownedEstimatedValue),sub=estimate===null?null:estimate-cents(p.recognizedAssetCost);
    if(estimate===null)incomplete=true;
    if(kind==='PERSONAL_SUMMARY'){
     const reserved=money([...v.reserves.values()].reduce((n,x)=>n+x,0n)),expenseRows=await historical<Expense>(identity,scope,table(scope.kind,'expenses'),s,cut.recordedThrough),positions=expenseRows.map(e=>expensePosition(events.filter(x=>x.entityId===e._id)));
     rows.push({id:'CASH',metricId:'CASH',amount:money(source.journals.filter(j=>j.effectiveDate<=date&&j.recordedAt<=cut.recordedThrough).reduce((n,j)=>n+j.lines.filter(l=>source.accounts.some(a=>a._id===l.accountId&&['CASH','BANK'].includes(a.kind))).reduce((v,l)=>v+storedCents(l.debit)-storedCents(l.credit),0n),0n)),reserved,available:p.cashAvailable});
     for(const [id,amount] of [['EXPENSE_RECOGNIZED',money(positions.reduce((n,x)=>n+x.recognized,0n))],['EXPENSE_PAID',money(positions.reduce((n,x)=>n+x.paid,0n))],['LIABILITIES',money(totals.liabilities)],['FUNDS_RESERVED',reserved],['ASSETS_COST',p.recognizedAssetCost],['ASSETS_ESTIMATED',estimate===null?null:money(estimate)],['NET_WORTH',money(base)]])rows.push({id,metricId:id,amount,reserved:null,available:null});
    }else rows.push({id:date,asOf:date,metricId:'NET_WORTH',base:money(base),estimated:estimate===null?null:money(base+sub!),substitution:sub===null?null:money(sub),ownDebt:p.linkedPrincipal,net:money(base),_reasons:estimate===null?{estimated:'MISSING_ESTIMATE',substitution:'MISSING_ESTIMATE'}:{}});
   }
  }else if(kind==='CONSOLIDATED_SUMMARY'){
   const c=await consolidated(m,context,scope,s,cut.asOf,cut.recordedThrough),d=c.data,gross=d.gross,net=d.net,personal=d.personalTotals;incomplete=c.reasons.length>0;
   for(const metric of ['assets','liabilities','equity','income','expense','cashAvailable']){const g=String(gross[metric as keyof typeof gross]),n=String(net[metric as keyof typeof net]),p=String(personal[metric as keyof typeof personal]);rows.push({id:metric,metricId:metric,personal:p,business:money(signedCents(g)-signedCents(p)),gross:g,eliminations:money(signedCents(g)-signedCents(n)),net:incomplete?null:n,excludedParticipation:null});}
  }else throw new AppError(422,'INPUT_INVALID');
 }
 const allowedFilters:Record<string,string[]>={PORTFOLIO:['loanId','borrowerId','state','ageBand'],PORTFOLIO_OVERDUE:['loanId','borrowerId','state','ageBand'],AGEING:['loanId','borrowerId','ageBand'],INSTALLMENTS:['loanId','borrowerId','state','ageBand'],MOVEMENTS:['loanId','borrowerId','method'],CASH:['accountId','responsibleId'],RECONCILIATION:['method','state'],COLLECTORS:['responsibleId'],CONCENTRATION:['borrowerId'],PAR30:[],INTEREST:[],PRINCIPAL:[],OBLIGATIONS:['liabilityId','state'],EXPENSES:['state'],SAVINGS:['fundId','accountId','state'],ASSETS:['assetId','state'],FUNDING_USES:['assetId'],NET_WORTH:[],NET_WORTH_EVOLUTION:[],PERSONAL_SUMMARY:[],CONSOLIDATED_SUMMARY:[]};
 if(Object.keys(filters).some(k=>!(allowedFilters[kind]??[]).includes(k)))throw new AppError(422,'INPUT_INVALID');
 for(const[k,v]of Object.entries(filters)){if(k==='ageBand')rows=rows.filter(r=>ageMatches(r,v));else rows=rows.filter(r=>(k==='state'&&kind==='EXPENSES'?r['planningStatus']:r[k])===v);}
 const key=(r:Data)=>kind==='AGEING'?String(r['ageBand'])+'|'+r['loanId']:kind==='CASH'?String(r['accountId'])+'|'+r['responsibleId']:kind==='INSTALLMENTS'||kind==='OBLIGATIONS'?String(r['dueDate'])+'|'+(r['loanId']??r['liabilityId'])+'|'+String(r['scheduleVersion']).padStart(8,'0')+'|'+String(r['number']).padStart(8,'0'):kind==='MOVEMENTS'?String(r['effectiveDate'])+'|'+r['recordedAt']:String(r['dueDate']??r['asOf']??r['effectiveDate']??r['borrowerCode']??r['metricId']??r['id']??'');
 if(kind!=='CONCENTRATION')rows.sort((a,b)=>key(a).localeCompare(key(b))||String(a['id']).localeCompare(String(b['id'])));
 if(rows.length>50000)throw new AppError(422,'REPORT_SCOPE_TOO_LARGE');budget();const output=reportRows(kind,rows,cut),totals=reportTotals(kind,output);
 return{rows:output,totals,coverage:{status:incomplete?'INCOMPLETE':'COMPLETE',reasons:incomplete?['PARTIAL_COVERAGE']:[],populationCount:rows.length,evaluableCount:rows.length,unclassifiableCount:incomplete?null:0,coveredPrincipal:null,unclassifiablePrincipal:null}};
}
export function cutFrom(query:Data,now:number,knowledgeMax=now):Cut{
 const asOf=String(query['asOf']??''),from=String(query['from']??''),to=String(query['to']??''),known=query['recordedThrough']===undefined?new Date(knowledgeMax).toISOString():String(query['recordedThrough']);
 const current=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
 if(!validDate(asOf)||!validDate(from)||!validDate(to)||from>to||to>asOf||asOf>current||!Number.isFinite(Date.parse(known))||new Date(known).toISOString()!==known||Date.parse(known)>knowledgeMax)throw new AppError(422,'INPUT_INVALID');return{asOf,recordedThrough:known,from,to};
}
