import {randomUUID} from 'node:crypto';
import {cents,money} from '../finance/money.js';
import {table,type Event,type Liability,type Line} from '../obligations/models.js';
import {signedCents,wealthTable,fields,body,type Asset,type Data,type Row,type Claim,type WealthContext,type WealthEvent} from './models.js';
import {fail,positive,effective,consume,persistEvent,bumpFund,stageFundEffects} from './funds.js';
import {claim,sourceRow,createDebt,activateDebt,existingDebt,principal,ledgerSources} from './sources.js';
const currentBody=(row:Asset)=>body(row);
export async function assetCommand(c:WealthContext,action:string):Promise<Asset>{
 const p=c.payload,store=c.system.management.store,name=wealthTable(c.scope.kind,'assets');
 if(action==='CreateAssetDraft'){
  await c.system.management.ledger.account(c.scope,String(p['assetAccountId']),c.s,{accountClass:'ASSET',kind:['GENERAL']});
  return await store.put(name,{_id:randomUUID(),...fields(c),version:1,...p,recognizedCost:'0.00',status:'DRAFT',liabilityIds:[],acquisitionEventId:null},c.s) as Asset;
 }
 const row=await store.get<Asset>(name,c.params['assetId']!,c.scope,c.s);c.entityId=row._id;c.details={before:currentBody(row),assetAccountId:row.assetAccountId};
 if(action==='ReplaceAssetMetadata')return await store.put(name,{...currentBody(row),...p,version:row.version+1},c.s) as Asset;
 if(action==='CancelAssetDraft'){
  if(row.status!=='DRAFT')fail(409,'INVALID_STATE');return await store.put(name,{...currentBody(row),status:'CANCELLED',version:row.version+1},c.s) as Asset;
 }
 if(action==='ReverseAssetEvent')return await reverse(c,row);
 const date=effective(c,String(p['effectiveDate']??p['valuationDate']));
 if(action==='AcquireAsset'||action==='LinkExistingAsset'){
  if(row.status!=='DRAFT')fail(409,'INVALID_STATE');
  if(row.ownershipPercentage===null)fail(409,'OWNERSHIP_INCOMPLETE');
  const debts:string[]=[],created:{debt:Liability;account:string}[]=[];
  if(action==='AcquireAsset'){
   if(row.origin!=='PURCHASE')fail(422,'INPUT_INVALID');
   const costs=(p['capitalizedCosts'] as Data[]).reduce((n,x)=>n+positive(x['amount']),0n),total=positive(p['ownedConsideration'])+costs,funding=p['funding'] as Data[];
   if(funding.reduce((n,x)=>n+positive(x['amount']),0n)!==total)fail(422,'COMPONENT_MISMATCH');
   c.amount=money(total);c.eventKind='ASSET_ACQUIRE';c.details['costDelta']=c.amount;
   const lines:Line[]=[{accountId:row.assetAccountId,debit:c.amount,credit:'0.00'}];
   for(const item of funding){
    const nature=String(item['nature']),amount=String(item['amount']);
    if(nature==='DIRECT_NEW_DEBT'){
     const debt=await createDebt(c,item['liabilityDefinition'] as Data,String(item['principalAccountId']),amount);created.push(debt);debts.push(debt.debt._id);lines.push({accountId:debt.account,debit:'0.00',credit:amount});
    }else{
     const account=String(item['accountId']);await c.system.management.ledger.account(c.scope,account,c.s,{accountClass:'ASSET',kind:['CASH','BANK']});
     if(nature==='RELEASED_SAVINGS')await consume(c,String(item['fundId']),account,amount);
     if(nature==='EXISTING_DEBT_LINK')debts.push((await existingDebt(c,item))._id);
     if(nature==='EXISTING_CASH'&&item['sourceJournalId']){
      const source=await ledgerSources(c.system,c.scope,c.s),j=source.journals.find(j=>j._id===item['sourceJournalId']);if(!j||j.reversalOfId||source.journals.some(x=>x.reversalOfId===j._id)||!j.lines.some(l=>l.accountId===account&&l.debit.toString()!=='0'))fail(409,'SOURCE_INCONSISTENT');
     }
     lines.push({accountId:account,debit:'0.00',credit:amount});
    }
    await sourceRow(c,item,nature==='DIRECT_NEW_DEBT'?'DIRECT_DEBT':nature==='RELEASED_SAVINGS'?'SAVINGS':nature==='EXISTING_DEBT_LINK'?'EXISTING_DEBT':'CASH');
   }
   c.details['createdLiabilities']=created.map(d=>d.debt._id);await persistEvent(c);
   const id=await c.post('ASSET_ACQUIRE',c.amount,lines);
   for(const d of created)await activateDebt(c,d.debt,d.account,id,'ASSET_PURCHASE');
   if(created.length){const first=created[0]!,activation=await store.get<Liability>(table(c.scope.kind,'liabilities'),first.debt._id,c.scope,c.s),stub=await store.put(table(c.scope.kind,'asset_stubs'),{_id:randomUUID(),...fields(c),version:1,liabilityId:first.debt._id,liabilityIds:created.map(d=>d.debt._id),legalOwnerReference:row.legalOwnerReference,date,cost:c.amount,accountId:row.assetAccountId,sourceEventId:activation.activationEventId,fundingLines:funding,wealthRootId:c.unitId,wealthAssetId:row._id},c.s);c.details['s09StubId']=stub._id;}
   await claim(c,{sourceKind:'SELF',sourceId:c.unitId,journalId:id,lineIndex:0,amount:c.amount});
  }else{
   c.eventKind='ASSET_EXISTING_LINK';const claims=p['sourceClaims'] as Data[];c.amount=money(claims.reduce((n,x)=>n+positive(x['amount']),0n));c.details['costDelta']=c.amount;
   for(const item of claims){await claim(c,item);if(item['sourceKind']==='EXISTING_S09'){const stub=await store.get<Row>(table(c.scope.kind,'asset_stubs'),String(item['sourceId']),c.scope,c.s);if(stub['liabilityId']&&!(p['liabilityIds'] as string[]).includes(String(stub['liabilityId'])))fail(409,'SOURCE_INCONSISTENT');}await sourceRow(c,{...item,reference:item['supportReference']},item['sourceKind']==='EXISTING_S09'?'S09':item['sourceKind']==='OPENING_S03'?'OPENING':'JOURNAL');}
   const others=await store.all<Asset>(name,c.scope,c.s);for(const id of p['liabilityIds'] as string[]){const debt=await store.get<Liability>(table(c.scope.kind,'liabilities'),id,c.scope,c.s);if(!debt.activationEventId)fail(409,'SOURCE_INCONSISTENT');if(others.some(a=>a._id!==row._id&&a.status==='ACTIVE'&&a.liabilityIds.includes(id)))fail(409,'SOURCE_CONFLICT');debts.push(id);}
  }
  return await store.put(name,{...currentBody(row),version:row.version+1,status:'ACTIVE',recognizedCost:c.amount,liabilityIds:[...new Set(debts)],acquisitionEventId:c.unitId},c.s) as Asset;
 }
 if(row.status!=='ACTIVE')fail(409,'INVALID_STATE');
 const assetEvents=(await c.system.events(c.scope,c.s)).filter(e=>e.entityId===row._id),acquisition=assetEvents.find(e=>e._id===row.acquisitionEventId);
 if(!acquisition||date<acquisition.effectiveDate)fail(409,'INVALID_STATE');
 if(action==='RecordAssetValuation'){
  c.eventKind='ASSET_VALUATION';c.details['valuation']={...p};await store.put(wealthTable(c.scope.kind,'asset_valuations'),{_id:c.unitId,...fields(c),version:1,assetId:row._id,...p,sourceEventId:c.unitId},c.s);
 }else if(action==='LinkAssetExpense'){
  c.eventKind='ASSET_EXPENSE_LINK';c.amount=String(p['amount']);
  const event=await store.get<Event>(table(c.scope.kind,'events'),String(p['sourceEventId']),c.scope,c.s),events=await store.all<Event>(table(c.scope.kind,'events'),c.scope,c.s),links=await store.all<Row>(wealthTable(c.scope.kind,'asset_flow_links'),c.scope,c.s);
  if(event.entityId!==p['expenseId']||event.kind!=='EXPENSE_PAY'||event.amount!==c.amount||event.effectiveDate!==date||events.some(e=>e.reversalOfId===event._id)||links.some(l=>l['sourceEventId']===event._id&&l['status']==='ACTIVE'))fail(409,'SOURCE_CONFLICT');
  c.details['expenseEventId']=event._id;await store.put(wealthTable(c.scope.kind,'asset_flow_links'),{_id:c.unitId,...fields(c),version:1,assetId:row._id,sourceEventId:event._id,amount:c.amount,status:'ACTIVE'},c.s);
 }else if(action==='ReceiveAssetRent'){
  c.eventKind='ASSET_RENT_RECEIVE';c.amount=String(p['amount']);
  await c.system.management.ledger.account(c.scope,String(p['cashAccountId']),c.s,{accountClass:'ASSET',kind:['CASH','BANK']});await c.system.management.ledger.account(c.scope,String(p['incomeAccountId']),c.s,{accountClass:'INCOME',kind:['GENERAL']});
  await c.post(c.eventKind,c.amount,[{accountId:String(p['cashAccountId']),debit:c.amount,credit:'0.00'},{accountId:String(p['incomeAccountId']),debit:'0.00',credit:c.amount}]);
 }else if(action==='DisposeAsset'){
  if(assetEvents.some(e=>e.effectiveDate>date))fail(409,'REVERSAL_DEPENDENCY');
  if(await principal(c,row.liabilityIds,date,'9999-12-31T23:59:59.999Z')!==0n)fail(409,'REVERSAL_DEPENDENCY');
  const price=positive(p['ownedSalePrice']),cost=cents(row.recognizedCost),fees=cents(String(p['saleCosts'])),gain=price-cost;c.eventKind='ASSET_DISPOSE';c.amount=money(price);c.details['costDelta']=money(-cost);c.details['saleCosts']=money(fees);
  for(const[id,accountClass,kind]of [[p['cashAccountId'],'ASSET',['CASH','BANK']],[p['gainAccountId'],'INCOME',['GENERAL']],[p['lossAccountId'],'EXPENSE',['GENERAL']],[p['costsExpenseAccountId'],'EXPENSE',['GENERAL']]] as [unknown,string,string[]][])await c.system.management.ledger.account(c.scope,String(id),c.s,{accountClass,kind});
  const disposed=await store.put(name,{...currentBody(row),version:row.version+1,status:'DISPOSED',recognizedCost:'0.00'},c.s) as Asset;await persistEvent(c);
  const lines:Line[]=[{accountId:String(p['cashAccountId']),debit:money(price),credit:'0.00'},{accountId:row.assetAccountId,debit:'0.00',credit:money(cost)}];
  if(gain>0n)lines.push({accountId:String(p['gainAccountId']),debit:'0.00',credit:money(gain)});else if(gain<0n)lines.push({accountId:String(p['lossAccountId']),debit:money(-gain),credit:'0.00'});
  await c.post(c.eventKind,c.amount,lines);if(fees>0n)await c.post(c.eventKind,money(fees),[{accountId:String(p['costsExpenseAccountId']),debit:money(fees),credit:'0.00'},{accountId:String(p['cashAccountId']),debit:'0.00',credit:money(fees)}]);return disposed;
 }else fail(422,'INPUT_INVALID');
 return await store.put(name,{...currentBody(row),version:row.version+1},c.s) as Asset;
}
async function reverse(c:WealthContext,row:Asset){
 const store=c.system.management.store,event=await store.get<WealthEvent>(wealthTable(c.scope.kind,'asset_events'),c.params['assetEventId']!,c.scope,c.s),events=(await c.system.events(c.scope,c.s)).filter(e=>e.entityId===row._id),date=effective(c);
 if(event.entityId!==row._id||event.reversalOfId||event.effectiveDate>date)fail(409,'REVERSAL_DEPENDENCY');if(events.some(e=>e.reversalOfId===event._id))fail(409,'ALREADY_REVERSED');
 const reversed=new Set(events.map(e=>e.reversalOfId));
 if(events.some(e=>e.unitKnownAt>event.unitKnownAt&&e.reversalOfId===null&&!reversed.has(e._id)))fail(409,'REVERSAL_DEPENDENCY');
 c.eventKind='REVERSAL';c.reversalOfId=event._id;c.amount=event.amount;c.deltas=event.deltas.map(d=>({...d,delta:money(-signedCents(d.delta))}));c.details={originalType:event.kind,assetAccountId:row.assetAccountId,costDelta:money(-signedCents(String(event.details['costDelta']??'0.00')))};
 for(const delta of c.deltas)if(signedCents(delta.delta)>0n){const fund=await store.get<import('./models.js').Fund>(wealthTable(c.scope.kind,'funds'),delta.fundId,c.scope,c.s);if(fund.status!=='ACTIVE')fail(409,'REVERSAL_DEPENDENCY');}
 for(const id of new Set(c.deltas.map(d=>d.fundId)))await bumpFund(c,id);
 await stageFundEffects(c);
 const all=await store.all<Event>(table(c.scope.kind,'events'),c.scope,c.s),created=event.details['createdLiabilities'] as string[]|undefined;
 for(const id of created??[]){const dependent=all.filter(e=>e.entityId===id&&!event.ledgerEventIds.includes(e._id));if(dependent.length)fail(409,'REVERSAL_DEPENDENCY');}
 if(event.kind==='ASSET_ACQUIRE'||event.kind==='ASSET_EXISTING_LINK'){
  for(const cl of await store.all<Claim>(wealthTable(c.scope.kind,'source_claims'),c.scope,c.s))if(cl.sourceEventId===event._id&&cl.status==='CLAIMED')await store.put(wealthTable(c.scope.kind,'source_claims'),{...body(cl),status:'RELEASED',version:cl.version+1},c.s);
 }
 let next:Data={...currentBody(row),version:row.version+1};
 if(['ASSET_ACQUIRE','ASSET_EXISTING_LINK','ASSET_DISPOSE'].includes(event.kind)){const before=event.details['before'] as Data;if(!before)fail(503,'INTEGRITY_MISMATCH');next={...before,version:row.version+1};}
 const result=await store.put(wealthTable(c.scope.kind,'assets'),next as Row,c.s) as Asset;if(signedCents(String(c.details['costDelta']??'0.00'))<=0n)await persistEvent(c);
 for(const id of [...event.journalIds].reverse()){const original=all.find(e=>e.journalIds.includes(id)&&!e.components['wealthInternal']);if(!original)fail(503,'SOURCE_INCONSISTENT');const inverse=await c.system.management.ledger.inverse(c.scope,id,randomUUID(),date,String(c.payload['supportReference']),c.s);await c.base.post(row._id,'ASSET_REVERSAL',date,original.amount,[],[],{wealthRootId:c.unitId},original._id,inverse);}
 for(const id of created??[]){const debt=await store.get<Liability>(table(c.scope.kind,'liabilities'),id,c.scope,c.s),activation=all.find(e=>e._id===debt.activationEventId);if(!activation)fail(503,'INTEGRITY_MISMATCH');
  const compensation=await store.put(table(c.scope.kind,'events'),{...fields(c),_id:randomUUID(),version:1,entityId:id,kind:'REVERSAL',effectiveDate:date,unitKnownAt:new Date(c.system.identity.now()).toISOString(),amount:debt.principal,allocations:[],journalIds:[],reversalOfId:activation._id,components:{wealthRootId:c.unitId,wealthInternal:true}},c.s);c.base.eventIds.push(compensation._id);
  await store.put(table(c.scope.kind,'liabilities'),{...body(debt),version:debt.version+1,status:'DRAFT',principalAccountId:null,activationEventId:null},c.s);
 }
 if(event.kind==='ASSET_EXPENSE_LINK'){const link=await store.get<Row>(wealthTable(c.scope.kind,'asset_flow_links'),event._id,c.scope,c.s);await store.put(wealthTable(c.scope.kind,'asset_flow_links'),{...body(link),status:'REVERSED',version:link.version+1},c.s);}
 return result;
}
