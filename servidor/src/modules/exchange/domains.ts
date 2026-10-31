/* eslint-disable security/detect-object-injection -- Closed imported domain command union and internal, server-assigned identifiers. */
import type {ClientSession} from 'mongodb';
import {randomUUID} from 'node:crypto';
import type {IdentityService} from '../identity/service.js';
import type {Context} from '../identity/models.js';
import {AppError} from '../../shared/errors.js';
import {recordFinancialEvidence} from '../finance/integrity.js';
import {loadReportingFinance} from '../finance/scoped-integrity.js';
import {liabilityCommand} from '../obligations/liabilities.js';
import {managementContract} from '../obligations/contract.js';
import {wealthContract} from '../wealth/contract.js';
import {privateAccounts,table,etag,type Row} from '../obligations/models.js';
import {wealthTable,type Asset} from '../wealth/models.js';
import {beginEvidence,type domainCollections} from '../lending/evidence-v2.js';
import {exchangeContract} from './contract.js';
import {ExchangeRepository} from './repository.js';
import type {Plan,Scope,Data,Command} from './models.js';
const fail=(code:string,status=409):never=>{throw new AppError(status,code);};
const typeFor=(c:Command)=>c.operationId==='createBorrower'?'BORROWER':c.operationId==='createLoanDraft'?'LOAN':c.operationId.includes('Account')?'ACCOUNT':c.operationId.includes('Liability')?'LIABILITY':c.operationId.includes('Fund')?'FUND':'ASSET';
const sheetFor=(type:string)=>({BORROWER:'Prestatarios',LOAN:'Prestamos',ACCOUNT:'Cuentas',LIABILITY:'Obligaciones',ASSET:'Activos',FUND:'Operaciones'} as Record<string,string>)[type]??'Operaciones';
export async function validateReferences(identity:IdentityService,context:Context,scope:Scope,plan:Plan,s:ClientSession){
 const store=identity.obligations!.store;const ids=new Set<string>();
 for(const[sheet,rows]of Object.entries(plan.normalized))for(const r of rows)if(r['action']==='LINK'){
  const id=String(r['existingId']??'');exchangeContract().validate('Id',id);let row:Data|null;
  if(sheet==='Cuentas')row=scope.kind==='BUSINESS'?await identity.finance!.accounts.findOne({_id:id,organizationId:scope.bookId,bookId:scope.bookId,ownerId:scope.ownerId},{session:s}):await store.get<Row>(privateAccounts,id,scope,s);
  else if(sheet==='Prestatarios'){if(scope.kind!=='BUSINESS')fail('RESOURCE_NOT_FOUND',404);await identity.lending!.actor(context,scope.bookId,s);row=await identity.lending!.borrowers.findOne({_id:id,organizationId:scope.bookId,ownerId:scope.ownerId},{session:s});}
  else if(sheet==='Activos')row=await store.get<Row>(wealthTable(scope.kind,'assets'),id,scope,s);
  else if(sheet==='Obligaciones')row=await store.get<Row>(table(scope.kind,'liabilities'),id,scope,s);else continue;
  if(!row)fail('RESOURCE_NOT_FOUND',404);if(!r['expectedETag'])fail('ETAG_REQUIRED',428);if(r['expectedETag']!=='"'+id+':'+row!['version']+'"')fail('PRECONDITION_FAILED',412);ids.add(id);
 }
 for(const info of plan.informationals)if(info['referenceId']&&!plan.externalRefs.some(r=>r.id===info['referenceId']&&r.type!=='INFORMATIONAL')){
  const id=String(info['referenceId']),names=scope.kind==='BUSINESS'?['financial_accounts','lending_borrowers','lending_loans','s11_historical_origins',wealthTable(scope.kind,'assets'),table(scope.kind,'liabilities')]:[privateAccounts,wealthTable(scope.kind,'assets'),table(scope.kind,'liabilities')];let found=false;
  for(const name of names)if(await identity.database.db.collection<{_id:string}>(name).findOne({_id:id,bookId:scope.bookId,ownerId:scope.ownerId},{session:s})){found=true;break;}if(!found)fail('RESOURCE_NOT_FOUND',404);
 }
 // Every external reference in advanced commands is checked by its original domain
 // validator in the same transaction. No tenant/owner fields are accepted here.
 void ids;
}
export async function applyCommands(identity:IdentityService,context:Context,scope:Scope,plan:Plan,s:ClientSession,repo:ExchangeRepository){
 const store=identity.obligations!.store,journalIds:string[]=[],changed=new Set<string>(),started=performance.now();
 await validateReferences(identity,context,scope,plan,s);if(scope.kind==='BUSINESS')await loadReportingFinance(identity.database,scope.bookId,null,s,()=>{});
 const commands=plan.commands,initialBookTag=await identity.wealth!.bookTag(scope,s);let pendingAccounts=false;
 // Every captured book fence refers to the same published prestate. Child
 // commands receive a derived fence only after that client fence is checked.
 for(const c of commands)if(c.payload['bookETag']!==undefined&&c.payload['bookETag']!==initialBookTag)fail('PRECONDITION_FAILED',412);
 for(const c of commands){
  if(performance.now()-started>10000)fail('FILE_BUDGET_EXCEEDED',503);const type=typeFor(c),sheet=sheetFor(type),assigned=plan.aliases[sheet+':'+c.externalKey]??plan.aliases['Operaciones:'+c.externalKey]??randomUUID(),key=scope.bookId+':'+plan.namespace+':'+type+':'+c.externalKey;
  const existing=(await repo.all<Row>('s11_external_refs',scope,s)).find(r=>r['identityKey']===key);if(existing)fail('EXTERNAL_KEY_CONFLICT');
  const {dependsOnKeys,...shape}=c;void dependsOnKeys;exchangeContract().validate('DomainCommand',shape);const p={...c.payload};let resultId=assigned;
  if(c.operationId==='createAccount'){const row=await identity.finance!.importAccount(context,scope.bookId,p,assigned,s);resultId=row._id;pendingAccounts=true;}
  else{
   if(pendingAccounts){await recordFinancialEvidence(identity.database,s);pendingAccounts=false;}
   if(c.operationId==='createBorrower'||c.operationId==='createLoanDraft'){if(scope.kind!=='BUSINESS')fail('ACCESS_DENIED',403);const result=await identity.lending!.importCommand(context,c.operationId,scope.bookId,p,assigned,s);resultId=(result.data as{id:string}).id;}
   else if(c.operationId==='createPersonalAccount'){
    if(scope.kind!=='PERSONAL')fail('ACCESS_DENIED',403);managementContract().validate(c.operationId,p);if(p['kind']!=='GENERAL'&&p['accountClass']!=='ASSET')fail('INPUT_INVALID',422);if((await store.all<Row>(privateAccounts,scope,s)).some(r=>r['code']===p['code']))fail('SOURCE_CONFLICT');
    resultId=(await store.put(privateAccounts,{_id:assigned,bookId:scope.bookId,ownerId:scope.ownerId,domainKind:scope.kind,version:1,...p,status:'ACTIVE'},s))._id;
   }else if(c.operationId.endsWith('CreateLiability')||c.operationId.endsWith('ActivateLiability')){
    const action=c.operationId.replace(/^(business|personal)/,''),method=action.charAt(0).toLowerCase()+action.slice(1),params:Record<string,string>={...c.pathReferences,importRootId:assigned};managementContract().validate(c.operationId,p);
    if(params['liabilityId']){const row=await store.get<Row>(table(scope.kind,'liabilities'),params['liabilityId'],scope,s);if((!changed.has(row._id)||c.expectedETag!==null)&&c.expectedETag!==etag(row))fail(c.expectedETag?'PRECONDITION_FAILED':'ETAG_REQUIRED',c.expectedETag?412:428);}
    const ctx=identity.obligations!.context(context,scope,s,p,params,[],journalIds),row=await liabilityCommand(ctx,method);resultId=row._id;
   }else{
    const spec=wealthContract().operations.get(c.operationId);if(!spec)fail('INPUT_INVALID',422);const id=c.pathReferences['assetId']??c.pathReferences['fundId'];
    if(id&&(!changed.has(id)||c.expectedETag!==null)){const row=await store.get<Row>(wealthTable(scope.kind,c.pathReferences['fundId']?'funds':'assets'),id,scope,s);if(!c.expectedETag)fail('ETAG_REQUIRED',428);if(c.expectedETag!==etag(row))fail('PRECONDITION_FAILED',412);}
    if(p['bookETag']!==undefined)p['bookETag']=await identity.wealth!.bookTag(scope,s);const result=await identity.wealth!.importCommand(context,c.operationId,p,scope,s,c.pathReferences,assigned);resultId=result.id;journalIds.push(...result.journalIds);
   }
  }
  changed.add(resultId);await repo.write('s11_external_refs',scope,s,{identityKey:key,namespace:plan.namespace,entityType:type,externalKey:c.externalKey,resourceId:resultId});
  const ref=plan.externalRefs.find(r=>r.key===c.externalKey&&r.type===type);if(ref)ref.id=resultId;else plan.externalRefs.push({key:c.externalKey,type,id:resultId});
  if(journalIds.length>100)fail('FILE_LIMIT_EXCEEDED',413);
 }
 if(pendingAccounts)await recordFinancialEvidence(identity.database,s);
 await store.touch(scope,s,commands.some(c=>wealthContract().operations.get(c.operationId)?.definition['x-mej-category']==='BALANCE_60M'||c.operationId.endsWith('ActivateLiability')));
 if(scope.kind==='BUSINESS'){
  const ids=[...new Set(journalIds)],journals=await identity.finance!.journals.find({organizationId:scope.bookId,_id:{$in:ids}},{session:s}).toArray();if(journals.reduce((n,j)=>n+j.lines.length,0)>1000)fail('FILE_LIMIT_EXCEEDED',413);
 }
 const tracked=store.tracking.active.get(s),known=new Date(Math.max(identity.now(),tracked?.latest.get(scope.bookId)??0)+1).toISOString();
 return{journalIds:[...new Set(journalIds)],effectCount:commands.length,known};
}
export async function finalizeUnit(identity:IdentityService,scope:Scope,plan:Plan,s:ClientSession){
 const store=identity.obligations!.store,tracked=store.tracking.active.get(s),known=new Date(Math.max(identity.now(),tracked?.latest.get(scope.bookId)??0)+1).toISOString(),history=new Set([table('BUSINESS','history'),table('PERSONAL','history')]);
 for(const m of new Map(tracked?.mutations.filter(m=>m.after!==null).map(m=>[m.namespace+':'+m.key,m])??[]).values())if(m.namespace!=='s09_evidence'&&!history.has(m.namespace)&&!m.namespace.includes('_history_'))await store.alignPending(m.namespace,String(m.key),scope,s,known);
 if(scope.kind==='BUSINESS'&&plan.mode==='HISTORICAL_LINK'){
  const loans=plan.links.filter(l=>l['kind']==='LOAN').map(l=>String(l['id'])),unit=await beginEvidence(identity.database,s,scope.bookId),changes=identity.database.projectionTracking.active.get(s)?.mutations??[];
  for(const name of ['loan_positions','loan_installments','loan_schedule_versions','loan_operation_books'] as (typeof domainCollections[number])[]){
   const filter={organizationId:scope.bookId,...(name==='loan_operation_books'?{_id:scope.bookId}:{loanId:{$in:loans}})},rows=await identity.database.db.collection<{_id:string;organizationId:string;createdAt:string}>(name).find(filter,{session:s}).toArray(),pending=rows.filter(row=>changes.find(m=>m.namespace===name&&String(m.key)===row._id)?.before===null);if(!pending.length)continue;
   await unit.verifyRows(name,pending,undefined,{organizationId:scope.bookId,_id:{$in:pending.map(r=>r._id)}});const next=pending.map(r=>({...r,createdAt:known,unitKnownAt:known}));
   await identity.database.db.collection<{_id:string}>(name).bulkWrite(next.map(row=>({replaceOne:{filter:{_id:row._id},replacement:row}})),{session:s});for(let i=0;i<pending.length;i++)await unit.track(name,pending[i]!,next[i]!);
  }
 }return known;
}
export async function importedAsset(identity:IdentityService,scope:Scope,id:string,s:ClientSession){return await identity.obligations!.store.get<Asset>(wealthTable(scope.kind,'assets'),id,scope,s);}
export async function registerReferences(scope:Scope,plan:Plan,s:ClientSession,repo:ExchangeRepository){
 const sourceRows=plan.normalized['Fuentes']??[],funding=sourceRows.length?await repo.store.all<Row>(wealthTable(scope.kind,'asset_funding'),scope,s):[],used=new Set<string>();
 for(const ref of plan.externalRefs){
  if(ref.type==='SOURCE'){
   const row=sourceRows.find(r=>r['externalKey']===ref.key)!,assetKey=String(row['assetKey']),assetId=assetKey.startsWith('@')?plan.aliases['Activos:'+assetKey.slice(1)]:assetKey;
   const matches=funding.filter(f=>!used.has(f._id)&&f['assetId']===assetId&&f['amount']===row['amount']&&f['reference']===row['reference']&&f['provenanceKind']===row['provenanceKind']&&((f['details'] as Data)?.['nature']??f['nature'])===row['nature']).sort((a,b)=>a._id.localeCompare(b._id));if(!matches.length)fail('SOURCE_INCONSISTENT',503);ref.id=matches[0]!._id;used.add(ref.id);
  }
  const identityKey=scope.bookId+':'+plan.namespace+':'+ref.type+':'+ref.key,old=(await repo.all<Row>('s11_external_refs',scope,s)).find(r=>r['identityKey']===identityKey);
  if(old){const pending=repo.store.tracking.active.get(s)?.mutations.some(m=>m.namespace==='s11_external_refs'&&String(m.key)===old._id&&m.before===null);if(!pending||old['resourceId']!==ref.id)fail('EXTERNAL_KEY_CONFLICT');}
  else await repo.write('s11_external_refs',scope,s,{identityKey,namespace:plan.namespace,externalKey:ref.key,entityType:ref.type,resourceId:ref.id});
 }
}
