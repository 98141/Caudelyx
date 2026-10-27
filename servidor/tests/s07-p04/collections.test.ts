import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {BSON} from 'mongodb';
import {s07Profile,assertOwnUri} from './profile.js';
import {cashSetup,code} from './fixture.js';
import {today} from '../../src/modules/finance/service.js';
import {domainCollections} from '../../src/modules/lending/evidence-v2.js';
import {ApiClient} from '../helpers/client.js';
import {accountBalance} from '../../src/modules/collections/funds.js';
import type {Buckets} from '../../src/modules/collections/models.js';
type Data=Record<string,unknown>;
async function digest(f:Awaited<ReturnType<typeof cashSetup>>){
 const h=createHash('sha256');
 for(const name of [...domainCollections,'financial_journals','financial_books','financial_evidence_head','identities','organizations','audit_events','outbox','security_evidence_outbox','security_evidence_projection','security_sequence']){
  h.update(name);h.update(BSON.EJSON.stringify(await f.database.db.collection(name).find({}).sort({_id:1}).toArray(),{relaxed:false}));
 }return h.digest('hex');
}
const value=(r:{data:unknown})=>r.data as Data;
test('P04 integrated S07 owned Mongo and HTTPS collections integration',{timeout:900000},async t=>{
 const group=await s07Profile();
 const scenario=async(name:string,run:()=>Promise<void>)=>{if(!process.env['S07_FOCUS']||name.includes(process.env['S07_FOCUS']!))await t.test(name,run);};
 try{
  await scenario('economy opening/cash300/transfer250/remaining50, legacy writers and lost HTTPS response',async()=>{
   const f=await cashSetup(group,false,true),own=f.c.issued.context.subjectId!,receiver=f.o.issued.context.subjectId!;
   const position=async(subject:string)=>((await f.readCollections('getCashPosition',subject)).data as {items:Data[]}).items;
   let rows=await position(own);assert.equal(rows[0]!['ledgerBalance'],'0.00');assert.equal((rows[0]!['physical'] as Buckets).provisionalOnSite,'300000.00');
   await assert.rejects(f.request(),code('STATE_CONFLICT'));await f.approveCash();
   assert.equal(((await f.position(f.l.id)).data as Data)['principalOutstanding'],'1760000.00');
   const portfolio=await f.readCollections('listCollectionPortfolio',undefined,f.c);assert.equal((value(portfolio)['items'] as Data[]).length,1);
   const journey=value(await f.mutateCollections('openCollectionJourney',{supportReference:'SYN'},undefined,f.c));
   const j=await f.readCollections('getCollectionJourney',String(journey['entityId']),f.c),beforeNote=await f.runtime.finance.journals.countDocuments({organizationId:f.org});
   await f.mutateCollections('recordCollectionAction',{resourceETag:j.etag,loanId:f.l.id,kind:'PROMISE',occurredAt:new Date(f.now()).toISOString(),note:'Promesa de prueba sin asiento',supportReference:'SYN',promisedAmount:'50000.00',promisedDate:'2026-11-01'},String(journey['entityId']),f.c);
   assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),beforeNote);
   const request=await f.request(),readOnlyBefore=await digest(f);
   assert.equal(await digest(f),readOnlyBefore);const first=value(await request.execute()),id=String(first['entityId']);
   await assert.rejects(f.request('100000.00'),code('DELIVERY_FUNDS_COMMITTED'));
   const payment=value(await f.readPayment(f.paymentId));
   await assert.rejects(f.database.transaction(s=>f.pay!.economic.reverse(f.org,String(payment['eventId']),today(f.now()),randomUUID(),s)),code('REVERSAL_DEPENDENCY'));
   const transfer={currency:'COP',effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN',description:'No gastar reservado',fromAccountId:f.cash.id,toAccountId:f.account,amount:'1.00'},transferKey=randomUUID();
   await f.proof(f.a,'FINANCE_TRANSFER',{organizationId:f.org,idempotencyKey:transferKey,payload:transfer});
   await assert.rejects(f.runtime.finance.mutate(f.a.issued.context,'createTransfer',f.org,transfer,transferKey),code('ACCOUNT_OVERDRAFT'));
   const l2=await f.loan({principal:'100000.00',plannedFundingAccountId:f.cash.id}),funding=await f.fundingRequest(l2);funding.fundingAccountETag=(await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,f.cash.id)).etag!;
   const disbursement=await f.make(funding);await assert.rejects(disbursement.execute(),code('ACCOUNT_OVERDRAFT'));
   await f.act('dispatchCashDelivery',id,f.c);await f.act('receiveCashDelivery',id,f.o);await f.count(id);
   const prepared=await f.confirm(id),journalBefore=await f.runtime.finance.journals.countDocuments({organizationId:f.org});
   await f.proof(f.a,prepared.purpose,prepared.proofCommand,id);
   const backend=await f.https(),client=backend.client;client.cookies.set('__Host-caudelyx-session',f.a.issued.token);await client.refreshCsrf();
   const path='/api/v1/organizations/'+f.org+'/cash-deliveries/'+id+'/confirm';
   const proxy=await Reflect.apply(f.proxy,undefined,[backend,path]) as {port:number;cert:Buffer},lost=new ApiClient(proxy.port,proxy.cert);
   lost.cookies.set('__Host-caudelyx-session',f.a.issued.token);lost.csrf=client.csrf;
   await assert.rejects(lost.call('POST',path,prepared.payload,{'If-Match':prepared.etag,'Idempotency-Key':prepared.key,Origin:'https://localhost:'+backend.port}));
   assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),journalBefore+1);
   const command=await client.call('GET','/api/v1/organizations/'+f.org+'/collection-commands/'+prepared.key);assert.equal(command.status,200);
   const replay=await client.call('POST',path,prepared.payload,{'If-Match':prepared.etag,'Idempotency-Key':prepared.key});assert.equal(replay.status,200,JSON.stringify(replay.body));assert.equal(replay.body.data?.['replayed'],true);
   assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),journalBefore+1);
   rows=await position(own);assert.equal(rows[0]!['ledgerBalance'],'50000.00');assert.equal(rows[0]!['retainedAtOrigin'],'50000.00');assert.equal(rows[0]!['available'],'0.00');
   const central=(await position(receiver)).find(r=>r['accountId']===f.central.id)!;assert.equal(central['ledgerBalance'],'250000.00');assert.equal(central['available'],'250000.00');assert.equal((central['physical'] as Buckets).confirmedOnSite,'250000.00');
   const journal=await f.runtime.finance.journals.findOne({_id:String(command.body.data?.['journalId'])});assert.equal(journal?.source.type,'CASH_DELIVERY');
   const readJournal=await client.call('GET','/api/v1/organizations/'+f.org+'/financial/journal-entries/'+journal!._id);assert.equal(readJournal.status,200,JSON.stringify(readJournal.body));
   assert.equal((readJournal.body.data?.['source'] as Data)['type'],'CASH_DELIVERY');
   const reverse={effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN',reason:'No manual domain reverse'},reverseKey=randomUUID();
   await f.proof(f.a,'FINANCE_JOURNAL_REVERSE',{organizationId:f.org,idempotencyKey:reverseKey,payload:reverse,expectedETag:'"'+journal!._id+':1"'},journal!._id);
   await assert.rejects(f.runtime.finance.mutate(f.a.issued.context,'reverseJournal',f.org,reverse,reverseKey,journal!._id,'"'+journal!._id+':1"'),code('DOMAIN_REVERSAL_FORBIDDEN'));
   assert.equal(((await f.position(f.l.id)).data as Data)['principalOutstanding'],'1760000.00');
   const badCsrf=await client.call('POST','/api/v1/organizations/'+f.org+'/collection-journeys',{supportReference:'SYN'},{'Idempotency-Key':randomUUID(),'If-Match':(await f.collectionsState()).collectionsBookETag,'X-CSRF-Token':'wrong'});assert.equal(badCsrf.status,400);
   const getBefore=await digest(f);
   for(const route of ['/collections/policy','/collections/state','/collection-portfolio','/collection-journeys','/collection-actions','/cash-stations','/cash-positions','/cash-deliveries','/cash-deliveries/'+id,'/cash-deliveries/'+id+'/facts','/cash-closes']){
    const response=await client.call('GET','/api/v1/organizations/'+f.org+route);assert.equal(response.status,200,route+' '+JSON.stringify(response.body));
   }assert.equal(await digest(f),getBefore);
  });
  await scenario('differences exact correction, immutable facts and close with pending',async()=>{
   const f=await cashSetup(group),id=String(value(await(await f.request()).execute())['entityId']);
   await f.act('dispatchCashDelivery',id,f.c);await f.act('receiveCashDelivery',id,f.o);await f.count(id,'230000.00');
   await assert.rejects(f.confirm(id),code('STATE_CONFLICT'));let d=await f.delivery(id);assert.equal(d.state,'DISCREPANCY');
   const source=((await f.readCollections('getCashPosition',f.c.issued.context.subjectId!)).data as {items:Data[]}).items[0]!;
   assert.equal((source['physical'] as Buckets).confirmedOnSite,'50000.00');assert.equal((source['physical'] as Buckets).unlocatedDisputed,'20000.00');assert.equal(source['retainedAtOrigin'],'300000.00');
   const journey=value(await f.mutateCollections('openCollectionJourney',{supportReference:'SYN'},undefined,f.c)),journeyId=String(journey['entityId']);
   const account=await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,f.cash.id);
   const close=value(await f.mutateCollections('createCashClose',{accountId:f.cash.id,accountETag:account.etag,subjectId:f.c.issued.context.subjectId,journeyId,observedAt:new Date(f.now()).toISOString(),counted:source['physical'],countStatus:'DECLARED',denominations:[],supersedesCloseId:null,reason:'Arqueo con diferencia pendiente',supportReference:'SYN'},undefined,f.c)),closeId=String(close['entityId']);
   await assert.rejects(f.mutateCollections('finalizeCashClose',{resourceETag:close['resourceETag'],mode:'EXACT',reason:'No ocultar diferencia',supportReference:'SYN'},closeId,f.c),code('CASH_CLOSE_PENDING'));
   const closed=value(await f.mutateCollections('finalizeCashClose',{resourceETag:close['resourceETag'],mode:'WITH_PENDING',reason:'Conservar diferencia',supportReference:'SYN'},closeId,f.c));
   await f.mutateCollections('closeCollectionJourney',{resourceETag:journey['resourceETag'],cashCloseId:closeId,cashCloseETag:closed['resourceETag'],mode:'WITH_PENDING',reason:'Fin de jornada con pendientes',supportReference:'SYN'},journeyId,f.c);
   assert.equal((value(await f.readCollections('getCollectionJourney',journeyId,f.c)))['status'],'CLOSED_WITH_PENDING');
   await f.act('investigateCashDelivery',id);await f.count(id,'250000.00');d=await f.delivery(id);
   await f.mutateCollections('acknowledgeCashDeliveryCount',{resourceETag:'"'+id+':'+d.version+'"',countId:d.countId,countETag:'"'+d.countId+':1"',reason:'Ratificado por remitente',supportReference:'SYN'},id,f.c);d=await f.delivery(id);
   await f.mutateCollections('correctCashDelivery',{resourceETag:'"'+id+':'+d.version+'"',countId:d.countId,countETag:'"'+d.countId+':1"',reason:'Resolución con conteo y ratificación',supportReference:'SYN'},id);
   await(await f.confirm(id)).execute();const facts=value(await f.readCollections('listCashDeliveryFacts',id))['items'] as Data[];assert.equal(facts.filter(x=>x['kind']==='COUNT').length,2);assert.deepEqual(facts.filter(x=>x['kind']==='COUNT').map(x=>x['amount']).sort(),['230000.00','250000.00']);
  });
  await scenario('returns, complete compensation, held reserve and bank without custody',async()=>{
   const f=await cashSetup(group),before=await f.runtime.finance.journals.countDocuments({organizationId:f.org});
   let id=String(value(await(await f.request()).execute())['entityId']);await f.act('dispatchCashDelivery',id,f.c);
   await assert.rejects(f.act('cancelCashDelivery',id,f.c),code('STATE_CONFLICT'));await f.act('requestCashDeliveryReturn',id,f.c);
   const ret=async(deliveryId:string,kind:string,actor=f.c,amount='250000.00')=>{const d=await f.delivery(deliveryId);return await f.mutateCollections('recordCashDeliveryReturnFact',{resourceETag:'"'+deliveryId+':'+d.version+'"',kind,amount,occurredAt:new Date(f.now()).toISOString(),reason:'Hecho de retorno real',supportReference:'SYN'},deliveryId,actor);};
   await ret(id,'RECEIVER_NON_RECEIPT',f.o);await ret(id,'SOURCE_RECALLED');await ret(id,'SOURCE_COUNT');await f.act('confirmCashDeliveryReturn',id);
   assert.equal((await f.delivery(id)).state,'CANCELLED');assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),before);
   id=String(value(await(await f.request()).execute())['entityId']);await f.act('dispatchCashDelivery',id,f.c);await f.act('receiveCashDelivery',id,f.o);await f.count(id);await f.act('requestCashDeliveryReturn',id);
   await ret(id,'RECEIVER_RETURN_DISPATCHED',f.o);await ret(id,'SOURCE_RECEIVED');await ret(id,'SOURCE_COUNT');await f.act('confirmCashDeliveryReturn',id);
   const full=String(value(await(await f.request('300000.00')).execute())['entityId']);await f.act('dispatchCashDelivery',full,f.c);await f.act('receiveCashDelivery',full,f.o);await f.count(full,'300000.00');await(await f.confirm(full)).execute();
   const forward=await f.delivery(full),comp=value(await(await f.prepareCollections({kind:'COMPENSATE_REQUEST',originalDeliveryId:full,resourceETag:'"'+full+':'+forward.version+'"',reason:'Retorno completo',supportReference:'SYN'})).execute()),compId=String(comp['entityId']);
   await f.act('dispatchCashDelivery',compId,f.o);await f.act('receiveCashDelivery',compId,f.c);await f.count(compId,'300000.00',f.c);await(await f.confirm(compId,true)).execute();
   assert.equal((await f.delivery(full)).compensatingDeliveryId,compId);
   const p=value(await f.readPayment(f.paymentId)),reverse=await f.reverse(String(p['eventId']),f.paymentId);await reverse.execute();
   const source=((await f.readCollections('getCashPosition',f.c.issued.context.subjectId!)).data as {items:Data[]}).items[0]!;
   assert.equal(source['ledgerBalance'],'300000.00');assert.equal(source['held'],'300000.00');assert.equal(source['retainedAtOrigin'],'0.00');assert.equal(source['available'],'0.00');
   await assert.rejects(f.request(),code('STATE_CONFLICT'));
   const bank=await f.accountS06('BANK_NO_CUSTODY','ASSET','BANK'),l=await f.loan();await f.disburse(l);
   const receipt=value(await(await f.preparePayment({kind:'REGISTER',mode:'DIRECT',effectiveDate:today(f.now()),intent:await f.intent(l,bank.id)})).execute());
   assert.equal(await f.database.db.collection('cash_custody').countDocuments({paymentId:receipt['entityId']}),0);
  });
  await scenario('security scoped reads, revoked assignments, CAS and denied foreign references',async()=>{
   const f=await cashSetup(group),j=value(await f.mutateCollections('openCollectionJourney',{supportReference:'SYN'},undefined,f.c)),jid=String(j['entityId']);
   const before=await digest(f);
   await assert.rejects(f.mutateCollections('openCollectionJourney',{supportReference:'SYN'},undefined,f.c),code('STATE_CONFLICT'));assert.equal(await digest(f),before);
   const pending=(await f.request()),id=String(value(await pending.execute())['entityId']),d=await f.delivery(id);
   await assert.rejects(f.collections.mutate(f.o.issued.context,'dispatchCashDelivery',f.org,{resourceETag:'"'+id+':'+d.version+'"',occurredAt:new Date(f.now()).toISOString(),reason:'No suplantar remitente',supportReference:'SYN'},randomUUID(),(await f.collectionsState()).collectionsBookETag,id),code('ACCESS_DENIED'));
   const other=await f.member('O');await assert.rejects(f.readCollections('getCashDelivery',id,other),code('RESOURCE_NOT_FOUND'));
   await assert.rejects(f.collections.read(f.c.issued.context,'getCashDelivery',randomUUID(),id),code('ACCESS_DENIED'));
   const scope=await f.pay!.read(f.a.issued.context,'getPaymentRegistrationScope',f.org,f.scopeId);
   await f.mutatePayment('setPaymentRegistrationScope',{scopeId:f.scopeId,registrarId:f.c.issued.context.subjectId,loanId:f.l.id,scope:'PAYMENT_REGISTER_ONLY',active:false,resourceETag:scope.etag,supportReference:'SYN'});
   const portfolio=value(await f.readCollections('listCollectionPortfolio',undefined,f.c))['items'] as Data[];assert.equal(portfolio.length,0);
   await assert.rejects(f.mutateCollections('recordCollectionAction',{resourceETag:j['resourceETag'],loanId:f.l.id,kind:'NOTE',occurredAt:new Date(f.now()).toISOString(),note:'Sin asignación no gestionar',supportReference:'SYN',promisedAmount:null,promisedDate:null},jid,f.c),code('ACCESS_DENIED'));
   assert.equal((value(await f.readCollections('getCashDelivery',id,f.c)))['id'],id);const ownPositions=value(await f.readCollections('getCashPosition',f.c.issued.context.subjectId!,f.c))['items'] as Data[];assert.equal(typeof ownPositions[0]!['accountETag'],'string');assert.equal(typeof ownPositions[0]!['bindingETag'],'string');await(await f.request('50000.00')).execute();
   await f.act('dispatchCashDelivery',id,f.c);await assert.rejects(f.collections.mutate(f.c.issued.context,'cancelCashDelivery',f.org,{resourceETag:'"'+id+':1"',occurredAt:new Date(f.now()).toISOString(),reason:'ETag viejo',supportReference:'SYN'},randomUUID(),(await f.collectionsState()).collectionsBookETag,id),code('PRECONDITION_FAILED'));
   const basic=await f.signup();await assert.rejects(f.collections.read(basic.issued.context,'getCollectionsState',f.org));
   const platform=await f.identity.sessions.issue('PLATFORM','P',null);await assert.rejects(f.collections.read(platform.context,'getCollectionsState',f.org));
   const json=await f.database.transaction(async s=>await accountBalance(f.database,f.org,f.cash.id,s));assert.equal(json,30000000n);
  });
  await scenario('journey across midnight, append-only corrections, surplus and suspended custodian administration',async()=>{
   const f=await cashSetup(group),j=value(await f.mutateCollections('openCollectionJourney',{supportReference:'SYN'},undefined,f.c)),jid=String(j['entityId']);
   const action=value(await f.mutateCollections('recordCollectionAction',{resourceETag:j['resourceETag'],loanId:f.l.id,kind:'NOTE',occurredAt:new Date(f.now()).toISOString(),note:'Hecho inicial',supportReference:'SYN',promisedAmount:null,promisedDate:null},jid,f.c)),aid=String(action['entityId']),original=await f.database.db.collection('collection_actions').findOne({_id:aid as never});
   const before=await f.runtime.finance.journals.countDocuments({organizationId:f.org});f.clock.value+=13*60*60000;
   for(const actor of [f.a,f.c,f.o])actor.issued=await f.sessions.issue('TENANT','W',(await f.identity.identities.findOne({_id:actor.issued.context.subjectId!}))!);
   const current=value(await f.readCollections('getCollectionJourney',jid,f.c));assert.equal(current['status'],'OPEN');assert.equal(current['workDate'],String(j['workDate']??'2026-10-31'));
   const corrected=value(await f.mutateCollections('correctCollectionAction',{resourceETag:action['resourceETag'],occurredAt:new Date(f.now()).toISOString(),note:'Corrección posterior conservando hecho inicial',promisedAmount:null,promisedDate:null,reason:'Precisión',supportReference:'SYN'},aid,f.c));
   assert.equal(value(await f.readCollections('getCollectionAction',String(corrected['entityId']),f.c))['supersedesActionId'],aid);assert.deepEqual(await f.database.db.collection('collection_actions').findOne({_id:aid as never}),original);
   const id=String(value(await(await f.request()).execute())['entityId']);await f.act('dispatchCashDelivery',id,f.c);await assert.rejects(f.count(id,'250000.00',f.c),code('ACCESS_DENIED'));await f.act('receiveCashDelivery',id,f.o);await f.count(id,'270000.00');
   await assert.rejects(f.confirm(id),code('STATE_CONFLICT'));const receiver=(value(await f.readCollections('getCashPosition',f.o.issued.context.subjectId!))['items'] as Data[]).find(p=>p['accountId']===f.central.id)!;assert.equal((receiver['physical'] as Buckets).unidentifiedSurplus,'20000.00');assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),before);
   const member=(await f.identity.identities.findOne({_id:f.c.issued.context.subjectId!}))!;await f.proof(f.a,'MEMBER_SUSPEND',undefined,member._id);await f.runtime.organizations.memberCommand(f.a.issued.context,member._id,'SUSPEND',member.version);
   await assert.rejects(f.readCollections('getCollectionJourney',jid,f.c));assert.equal(value(await f.readCollections('getCashDelivery',id))['senderId'],member._id);
   const account=await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,f.cash.id),close=value(await f.mutateCollections('createCashClose',{accountId:f.cash.id,accountETag:account.etag,subjectId:member._id,journeyId:jid,observedAt:new Date(f.now()).toISOString(),counted:null,countStatus:'MISSING',denominations:[],supersedesCloseId:null,reason:'Custodio suspendido, falta conteo físico',supportReference:'SYN'})),cid=String(close['entityId']);
   await assert.rejects(f.mutateCollections('finalizeCashClose',{resourceETag:close['resourceETag'],mode:'EXACT',reason:'Sin conteo',supportReference:'SYN'},cid),code('CASH_CLOSE_PENDING'));
   const closed=value(await f.mutateCollections('finalizeCashClose',{resourceETag:close['resourceETag'],mode:'WITH_PENDING',reason:'Responsabilidad conservada',supportReference:'SYN'},cid));
   const latest=await f.readCollections('getCollectionJourney',jid);await f.mutateCollections('closeCollectionJourney',{resourceETag:latest.etag,cashCloseId:cid,cashCloseETag:closed['resourceETag'],mode:'WITH_PENDING',reason:'Cierre administrativo sin conteo ficticio',supportReference:'SYN'},jid);
   const source=(value(await f.readCollections('getCashPosition',member._id))['items'] as Data[])[0]!;assert.equal(source['retainedAtOrigin'],'300000.00');assert.equal(source['available'],'0.00');assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),before);
  });
  await scenario('atomic failures of every confirm boundary, allocation/fact writes and multi-process replay',async()=>{
   const f=await cashSetup(group),original=f.database.db.collection.bind(f.database.db);
   const inject=async(table:string,method:string,run:()=>Promise<unknown>)=>{
    const before=await digest(f);let hit=false;const cached=[f.runtime.finance.journals,f.identity.identities].filter(col=>col.collectionName===table),restores=cached.map(col=>{const previous=Reflect.get(col,method);Reflect.set(col,method,async()=>{hit=true;throw Error('S07_INJECT_'+table);});return()=>Reflect.set(col,method,previous);});
    f.database.db.collection=((name:string,...options:unknown[])=>{
     const col=Reflect.apply(original,f.database.db,[name,...options]);return new Proxy(col,{get(target,p){const v=Reflect.get(target,p);if(name===table&&p===method)return async()=>{hit=true;throw Error('S07_INJECT_'+table);};return typeof v==='function'?v.bind(target):v;}});
    }) as typeof f.database.db.collection;
    try{await assert.rejects(run(),e=>e instanceof Error&&e.message==='S07_INJECT_'+table);assert.equal(hit,true,table);}finally{f.database.db.collection=original;for(const restore of restores)restore();}
    assert.equal(await digest(f),before,table+' rollback');process.stdout.write(JSON.stringify({boundary:table,method,injected:hit,rollbackDigestUnchanged:true})+'\n');
   };
   await inject('collection_journeys','insertOne',()=>f.mutateCollections('openCollectionJourney',{supportReference:'SYN-rollback'},undefined,f.c));
   const journey=value(await f.mutateCollections('openCollectionJourney',{supportReference:'SYN-rollback'},undefined,f.c)),jid=String(journey['entityId']);
   await inject('collection_actions','insertOne',()=>f.mutateCollections('recordCollectionAction',{resourceETag:journey['resourceETag'],loanId:f.l.id,kind:'NOTE',occurredAt:new Date(f.now()).toISOString(),note:'No parcial',supportReference:'SYN',promisedAmount:null,promisedDate:null},jid,f.c));
   const account=await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,f.cash.id),position=(value(await f.readCollections('getCashPosition',f.c.issued.context.subjectId!))['items'] as Data[])[0]!;
   await inject('cash_close_records','insertOne',()=>f.mutateCollections('createCashClose',{accountId:f.cash.id,accountETag:account.etag,subjectId:f.c.issued.context.subjectId,journeyId:jid,observedAt:new Date(f.now()).toISOString(),counted:position['physical'],countStatus:'DECLARED',denominations:[],supersedesCloseId:null,reason:'No parcial',supportReference:'SYN'},undefined,f.c));
   const station=await f.readCollections('getCashStation',f.stationId),central=await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,f.central.id),receiver=(await f.identity.identities.findOne({_id:f.o.issued.context.subjectId!}))!,stationKey=randomUUID(),stationState=await f.collectionsState(),stationPayload={stationId:f.stationId,resourceETag:station.etag,accountId:f.central.id,accountETag:central.etag,receiverId:receiver._id,receiverETag:receiver.version,active:true,supportReference:'SYN-rollback'};
   await f.proof(f.a,'CASH_STATION_SET',{organizationId:f.org,idempotencyKey:stationKey,expectedETag:stationState.collectionsBookETag,operationId:'setCashStation',resourceId:null,payload:stationPayload});
   await inject('cash_stations','replaceOne',()=>f.collections.mutate(f.a.issued.context,'setCashStation',f.org,stationPayload,stationKey,stationState.collectionsBookETag));
   // Journey writes changed the global book after the earlier preview; prepare anew.
   const freshRequest=await f.request();
   await inject('cash_delivery_allocations','insertOne',freshRequest.execute);const id=String(value(await freshRequest.execute())['entityId']);
   await inject('cash_delivery_facts','insertOne',()=>f.act('dispatchCashDelivery',id,f.c));await f.act('dispatchCashDelivery',id,f.c);await f.act('receiveCashDelivery',id,f.o);await f.count(id);
   const confirm=await f.confirm(id);await f.proof(f.a,confirm.purpose,confirm.proofCommand,id);
   for(const [table,method]of [['cash_deliveries','replaceOne'],['financial_books','updateOne'],['financial_journals','insertOne'],['financial_evidence_head','updateOne'],['collection_books','replaceOne'],['collection_transitions','insertOne'],['collection_commands','insertOne'],['identities','updateOne'],['organizations','updateOne'],['lending_merkle_nodes','bulkWrite'],['lending_merkle_orgs','replaceOne'],['lending_domain_state','replaceOne'],['audit_events','insertOne'],['outbox','insertOne'],['security_sequence','findOneAndUpdate'],['security_evidence_outbox','insertOne'],['security_evidence_projection','updateOne']])await inject(table!,method!,confirm.execute);
   await f.restore.flush();const serialized=Object.fromEntries(Object.entries(f.keys).filter(([,v])=>Buffer.isBuffer(v)).map(([k,v])=>[k,(v as Buffer).toString('base64')]));
   const peer=await group.peer({keys:serialized,now:f.now(),config:f.config});
   try{
    const before=await f.runtime.finance.journals.countDocuments({organizationId:f.org});
    const results=await Promise.all([confirm.execute(),peer.execute({token:f.a.issued.token,operation:confirm.operation,organizationId:f.org,payload:confirm.payload,key:confirm.key,etag:confirm.etag,resourceId:id})]);
    assert.deepEqual(results.map(r=>Number(r.status)).sort(),[200,201]);assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),before+1);
    await assert.rejects(f.collections.mutate(f.a.issued.context,confirm.operation,f.org,{...confirm.payload,previewToken:'changed'},confirm.key,confirm.etag,id),code('IDEMPOTENCY_CONFLICT'));
   }finally{await peer.close();}
  });
  await scenario('profile guards and failed setup close all own consumers',async()=>{
   for(const uri of ['mongodb://127.0.0.1:27017/?replicaSet=caudelyx-manual','mongodb://127.0.0.1:27181/?replicaSet=caudelyx-manual','mongodb://example.test:50000/?replicaSet=caudelyx-manual'])assert.throws(()=>assertOwnUri(uri));
   await assert.rejects(group.fixture({failSetup:true}),/Injected own partial setup/);const release=group.hold();try{await assert.rejects(group.dispose(),/Own fixture lease/);}finally{release();}
  });
 }finally{await group.dispose();}
});
