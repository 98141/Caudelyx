import test from 'node:test';
import assert from 'node:assert/strict';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {rename,lstat} from 'node:fs/promises';
import {MongoClient} from 'mongodb';
import {generate} from 'otplib';
import {loadConfig} from '../../src/shared/config.js';
import {Database} from '../../src/shared/database.js';
import {PersistentDemo,activatePersistentModules,persistentDemoAdmitted,loadPersistentKeys} from '../../src/shared/persistent-demo.js';
import {RestoreController} from '../../src/shared/restore.js';
import {IdentityService} from '../../src/modules/identity/service.js';
import {Sessions} from '../../src/modules/sessions/service.js';
import {SyntheticMessaging} from '../../src/modules/messaging/service.js';
import {PasswordHasher} from '../../src/modules/identity/password.js';
import {attachRuntime} from '../../src/shared/runtime.js';
import {purposeClass} from '../../src/modules/sessions/work-policy.js';
import {managementContract} from '../../src/modules/obligations/contract.js';
import {wealthContract} from '../../src/modules/wealth/contract.js';
import {today} from '../../src/modules/finance/service.js';
import {setupMonthly,msTag,data} from '../ms-p04-r2/helpers.js';
import {nativeLoan} from '../ms-p04-r2/native-seed.js';
import {workbook} from '../s11-p02/oracle.js';
const definition=()=>({horizonDays:30,assumptions:['PRUDENT','BASE','FAVORABLE'].map(kind=>({kind,collectionFraction:'1.000000',delayDays:0,recoveryFraction:'0.000000',recoveryDelayDays:0,interestProjection:'DECLARED_SCHEDULE_ONLY',dateOverrides:[],capitalEvents:[]})),alternatives:['HOLD_CASH','DEBT_PREPAYMENT','NEW_LOAN','ASSET_PURCHASE'].map(kind=>kind==='HOLD_CASH'?{kind,budget:'0.00',configured:true,reserveReleases:[]}:{kind,budget:'0.00',configured:false,reason:'NOT_CONFIGURED'})});
import type {Data} from '../../src/modules/obligations/models.js';

type NativeInput=Pick<Parameters<typeof nativeLoan>[0],'runtime'|'now'|'a'|'org'|'bank'|'account'|'restore'>;
const seedNative=nativeLoan as (f:NativeInput,profile?:Parameters<typeof nativeLoan>[1])=>ReturnType<typeof nativeLoan>;
type MonthlyInput=Pick<Parameters<typeof setupMonthly>[0],'runtime'|'now'|'a'|'org'|'bank'|'account'>;
const seedMonthly=setupMonthly as (f:MonthlyInput,options?:Parameters<typeof setupMonthly>[1])=>ReturnType<typeof setupMonthly>;
const monthlyTag=msTag as (f:Pick<MonthlyInput,'runtime'|'now'|'a'|'org'>)=>ReturnType<typeof msTag>;
const password='F06 Synthetic Secret Passphrase 27!';
test('authenticated persistent demo: real admission/modules, finance, imports, simulation, monthly and restart',{timeout:360000},async t=>{
 const config=loadConfig(process.env),keyring=process.env['KEYRING_FILE']!,control=dirname(keyring),keys=await loadPersistentKeys(keyring);
 const absent=join(control,'must-not-generate.json');await assert.rejects(loadPersistentKeys(absent),/ENOENT/);await assert.rejects(lstat(absent),/ENOENT/);
 const clock={value:Math.floor(Date.now()/30000)*30000+1000},now=()=>clock.value;
 let database:Database|undefined,demo:PersistentDemo|undefined;
 const open=async()=>{
  database=new Database(config.mongoUri,config.databaseName,config.mongoOptions);demo=await PersistentDemo.open(database,config,keys,control,keyring);
  const live=demo;await database.connect();
  const restore=new RestoreController(database,join(control,'gate.json'),keys.journal,keys.priority,keys.cursor);await restore.initialize();
  const sessions=new Sessions(database,now),messages=new SyntheticMessaging(database,keys.mail,now),identity=new IdentityService(database,sessions,messages,new PasswordHasher(),()=>restore.isOpen()&&live.live(),now);await identity.initialize();
  const runtime=await attachRuntime(identity,keys,config,{exchangePrivateRoot:join(control,'private')});await activatePersistentModules(identity,keys,()=>live.verify());await live.ready();
  return{database,restore,sessions,messages,identity,runtime,clock,now,keys};
 };
 const close=async(f:Awaited<ReturnType<typeof open>>)=>{await f.database.projectionShutdown?.();delete f.database.projectionShutdown;await f.restore.flush();await demo?.close();await f.database.close();demo=undefined;database=undefined;};
 try{
  const f=await open();
  if(process.env['F06_REOPEN_ONLY']==='1'){
   assert.equal(f.restore.isOpen(),true);assert.equal(f.runtime.monthly.active,true);assert.equal(f.identity.reporting!.projection!.ready,true);
   assert.equal(await f.runtime.finance.journals.countDocuments(),Number(process.env['F06_EXPECTED_JOURNALS']));await close(f);return;
  }
  await t.test('TLS/SCRAM enforced and duplicate runtime lease denied',async()=>{
   assert.equal(f.runtime.monthly.active,true);assert.equal(f.runtime.obligations.active,true);assert.equal(f.runtime.simulation.store.active,true);assert.equal(f.identity.reporting!.projection!.ready,true);
   const anonymous=new MongoClient(config.mongoUri,{tls:true,tlsCAFile:config.mongoOptions!.tlsCAFile!,serverSelectionTimeoutMS:3000});try{await anonymous.connect();await assert.rejects(anonymous.db(config.databaseName).collection('identities').findOne({}));}finally{await anonymous.close();}
   const second=new Database(config.mongoUri,config.databaseName,config.mongoOptions);try{await assert.rejects(PersistentDemo.open(second,config,keys,control,keyring),/LEASE_BUSY/);}finally{await second.close();}
   const insecure=new Database(config.mongoUri,config.databaseName);try{await assert.rejects(PersistentDemo.open(insecure,config,keys,control,keyring),/ACTUAL_CONNECTION_INVALID/);}finally{await insecure.close();}
   assert.equal(persistentDemoAdmitted(f.database),true);
  });
  const actor=async()=>{
   const anonymous=await f.sessions.issue('TENANT','P',null),email=randomUUID()+'@example.test';
   const registered=await f.identity.register('TENANT',randomUUID(),{email,displayName:'Persona sintética F06',privacyPolicyVersion:'synthetic-v1',password},anonymous.context);
   if(!registered.issued)throw Error('Basic session missing');await f.identity.dispatchMail();const subject=(await f.identity.identities.findOne({email}))!,mail=[...f.messages.inbox.values()].find(m=>m.subjectId===subject._id&&m.purpose==='ACTIVATION');if(!mail)throw Error('Synthetic activation missing');
   const confirmed=await f.identity.confirmEmail(registered.issued.context,{purpose:'ACTIVATION',token:mail.token}),enrollment=await f.runtime.totp.enroll(confirmed.issued.context,'F06 TOTP',password),secret=new URL(enrollment.provisioningUri).searchParams.get('secret')!;
   const completed=await f.runtime.totp.confirm(confirmed.issued.context,enrollment.enrollmentId,await generate({secret,epoch:Math.floor(now()/1000)}));if(!completed.issued)throw Error('Strong session missing');return{email,secret,issued:completed.issued};
  };
  type Actor=Awaited<ReturnType<typeof actor>>;
  const proof=async(a:Actor,purpose:string,command?:Data,resourceId?:string)=>{
   const kind=purposeClass(purpose),current=await f.sessions.contexts.findOne({_id:a.issued.context._id});
   if(kind==='WORK_ONLY'||kind==='BALANCE_60M'&&current?.balanceGrant&&current.balanceGrant.expiresAt>now())return;
   const prepared=await f.identity.work!.prepare(a.issued.context,{purpose,method:'TOTP',...(command?{command}:{}),...(resourceId?{resourceId}:{})});clock.value+=30000;
   a.issued=(await f.identity.work!.verify(a.issued.context,{intentId:prepared.intentId,method:'TOTP',code:await generate({secret:a.secret,epoch:Math.floor(now()/1000)})},a.issued.token)).issued;
  };
  const a=await actor(),org=(await f.runtime.organizations.create(a.issued.context,{name:'Organización sintética F06',currency:'COP',timezone:'America/Bogota'},randomUUID())).data.organization.id;
  const account=async(code:string,accountClass='ASSET',kind='GENERAL')=>(await f.runtime.finance.mutate(a.issued.context,'createAccount',org,{code,name:'Cuenta sintética '+code,currency:'COP',accountClass,kind},randomUUID())).data as{id:string;version:number};
  const bank=await account('F06_BANK','ASSET','BANK'),equity=await account('F06_CAPITAL','EQUITY'),date=today(now());
  await t.test('MFA, roles, balanced money and idempotency',async()=>{
   const payload={currency:'COP',effectiveDate:date,sourceId:randomUUID(),supportReference:'SYN-F06',description:'Capital sintético',lines:[{accountId:bank.id,debit:'20000000.00',credit:'0.00'},{accountId:equity.id,debit:'0.00',credit:'20000000.00'}]},key=randomUUID();
   await proof(a,'FINANCE_JOURNAL_POST',{organizationId:org,idempotencyKey:key,payload});const first=await f.runtime.finance.mutate(a.issued.context,'postJournal',org,payload,key),replay=await f.runtime.finance.mutate(a.issued.context,'postJournal',org,payload,key);assert.deepEqual(first.data,replay.data);
   const other=await actor();await f.runtime.organizations.create(other.issued.context,{name:'Otra organización sintética',currency:'COP',timezone:'America/Bogota'},randomUUID());await assert.rejects(f.runtime.finance.read(other.issued.context,'readAccount',org,bank.id));
  });
  if(process.env['F06_SEED_ONLY']==='1'){assert.ok(((await f.database.db.collection<{_id:string;fence:number}>('demo_runtime_control').findOne({_id:'lease'}))?.fence??0)>0);await close(f);return;}
  const params={organizationId:org};
  const mutate=async(operation:string,payload:Data,ps:Record<string,string>=params,expected?:string,key=randomUUID())=>{
   const purpose=managementContract().operations.get(operation)!.definition['x-purpose']!,command={operationId:operation,idempotencyKey:key,organizationId:org,pathParameters:ps,payload,...(expected?{expectedETag:expected}:{})};await proof(a,purpose,command,ps['expenseId']??ps['fundId']);return f.runtime.obligations.mutate(a.issued.context,operation,payload,ps,key,expected);
  };
  await t.test('enterprise expense and real fund allocation',async()=>{
   const expense=await mutate('businessCreateExpense',{nominalDate:date,dueDate:date,description:'Servicio sintético',category:'SERVICES',amountMode:'FIXED',amount:'100.00',supportReference:'SYN-F06'}),expenseAccount=await account('F06_EXPENSE','EXPENSE'),payable=await account('F06_PAYABLE','LIABILITY');
   await mutate('businessRecognizeAndPayExpense',{amount:'100.00',effectiveDate:date,expenseAccountId:expenseAccount.id,payableAccountId:payable.id,cashAccountId:bank.id,supportReference:'SYN-F06'},{...params,expenseId:String((expense.data as Data)['id'])},expense.etag);
   const wealth=f.runtime.wealth,call=async(op:string,p:Data,ps:Record<string,string>=params,tag?:string)=>{const key=randomUUID(),purpose=wealthContract().operations.get(op)!.definition['x-purpose']!;await proof(a,purpose,{operationId:op,idempotencyKey:key,organizationId:org,pathParameters:ps,payload:p,...(tag?{expectedETag:tag}:{})},ps['fundId']);return wealth.mutate(a.issued.context,op,p,ps,key,tag);};
   const fund=await call('businessCreateFund',{mode:'VIRTUAL',label:'Reserva sintética',purpose:'SAVINGS',backingAccountId:bank.id,supportReference:'SYN-F06'}),scope={kind:'BUSINESS' as const,bookId:org,ownerId:org,organizationId:org},bookETag=await f.database.client.withSession(s=>wealth.bookTag(scope,s));
   await call('businessAllocateFund',{bookETag,effectiveDate:date,amount:'50.00',supportReference:'SYN-F06'},{...params,fundId:String((fund.data as Data)['id'])},fund.etag);
  });
  await t.test('real import preview/confirmation and actual CSV XLSX PDF exports',async()=>{
   const service=f.identity.exchange!,input={label:'Catálogo F06',namespace:'SYN-F06',mode:'OPERATIVE',templateVersion:'1.0.0',mappingVersion:'S11-MAP-1'},created=await service.createImport(a.issued.context,'createBusinessImport',input,params,randomUUID()),ps={...params,importId:String(created.data['id'])};
   const upload=await service.upload(a.issued.context,ps,randomUUID(),created.etag,workbook('OPERATIVE','SYN-F06',{Cuentas:[{externalKey:'F06_IMPORTED',action:'CREATE',code:'F06_IMPORTED',name:'Importada sintética',accountClass:'ASSET',kind:'BANK',currency:'COP'}]}));
   await service.preparePreview(a.issued.context,ps,randomUUID(),upload.etag);const current=await service.readImport(a.issued.context,ps,'getBusinessImport'),preview=await service.readImport(a.issued.context,ps,'getBusinessImportPreview');assert.equal(preview.data['canConfirm'],true);
   const bookETag=await f.database.client.withSession(s=>f.runtime.wealth.bookTag({kind:'BUSINESS',bookId:org,ownerId:org,organizationId:org},s)),payload={previewId:preview.data['id'],semanticHash:preview.data['semanticHash'],bookETag},key=randomUUID();
   await proof(a,'IMPORT_CONFIRM',{operationId:'confirmBusinessImport',organizationId:org,pathParameters:ps,payload,idempotencyKey:key,expectedETag:current.etag},ps.importId);const result=await service.confirm(a.issued.context,ps,payload,key,current.etag);assert.equal(result.data['effectCount'],1);
   assert.deepEqual((await service.confirm(a.issued.context,ps,payload,key,current.etag)).data,result.data);
   const report=await service.report(a.issued.context,{...params,reportKind:'CASH'},{asOf:date,from:date,to:date});
   for(const format of ['CSV','XLSX','PDF']){const output=await service.createExport(a.issued.context,params,{reportKind:'CASH',snapshotToken:(report.data['meta'] as Data)['snapshotToken'],format},randomUUID()),download=await service.download(a.issued.context,{...params,exportId:String(output.data['id'])},randomUUID(),false,output.etag);assert.ok(download.bytes.length>0);}
  });
  let monthly:Awaited<ReturnType<typeof seedMonthly>>;
  await t.test('native finite loan and monthly draft share the legitimate book profile',async()=>{const world={...f,a,org,bank,equity,account,proof};monthly=await seedMonthly(world,{principal:'1000.00'});const native=await seedNative(world,monthly.profile);assert.ok(native.loanId);});
  await t.test('real simulation worker and alerts preserve financial journal count',async()=>{
   const service=f.runtime.simulation,call=async(op:string,p:Data={},ps:Record<string,string>=params,q:Data={})=>service.execute(a.issued.context,op,p,ps,q,randomUUID()),before=await f.runtime.finance.journals.countDocuments(),base=await call('captureBaseBusinessSimulation',{asOf:date,currency:'COP'}),d={...definition(),baseId:String(base.data['id']),baseToken:String(base.data['baseToken'])},scenario=await call('createScenarioBusinessSimulation',{name:'Escenario sintético F06',...d}),run=await call('startRunBusinessSimulation',{scenarioId:scenario.data['id'],scenarioVersion:1,baseToken:d.baseToken,mode:'STANDARD',sensitivity:null,evaluateAlerts:false}),ps={...params,runId:String(run.data['id'])};
   let state='QUEUED';const until=Date.now()+30000;while(!['SUCCEEDED','FAILED'].includes(state)&&Date.now()<until){await new Promise(r=>setTimeout(r,100));state=String((await call('getRunBusinessSimulation',{},ps)).data['state']);}assert.equal(state,'SUCCEEDED');
   await call('evaluateAlertsBusinessSimulation',{kind:'FACT',baseId:d.baseId,baseToken:d.baseToken,thresholds:{dueWithinDays:7,concentrationThreshold:'25.00'}});assert.equal(await f.runtime.finance.journals.countDocuments(),before);
  });
  await t.test('monthly activation, actual mandate worker and no duplicate financial effect',async()=>{
   const world={...f,a,org,bank,equity,account,proof},m=monthly!,key=randomUUID(),q=await m.ms.mutate(a.issued.context,'msPreviewActivation',{executionKey:key,effectiveDate:date,expectedBookETag:await monthlyTag(world),expectedLoanETag:m.draft.etag,mandateConsent:true,originReference:'SYN-F06'},m.lp,key,m.draft.etag);
   await m.ms.mutate(a.issued.context,'msCommitActivation',{executionKey:key,previewToken:data(q)['previewToken'],requestHash:data(q)['requestHash']},m.lp,key,m.draft.etag);
   const before=await f.runtime.finance.journals.countDocuments();clock.value=Date.parse(m.terms.firstDueDate+'T12:00:00Z');await m.ms.worker.runOnce();const count=await f.runtime.finance.journals.countDocuments();assert.ok(count>before,'Monthly accrual must post a real journal');await m.ms.worker.runOnce();assert.equal(await f.runtime.finance.journals.countDocuments(),count);
  });
  const journalCount=await f.runtime.finance.journals.countDocuments();await close(f);
  await t.test('existing encrypted deployment refuses missing durable gate',async()=>{
   const gate=join(control,'gate.json'),held=join(control,'gate.f06-held');await rename(gate,held);
   const blocked=new Database(config.mongoUri,config.databaseName,config.mongoOptions);try{await assert.rejects(PersistentDemo.open(blocked,config,keys,control,keyring),/ENOENT/);}finally{await blocked.close();await rename(held,gate);}
  });
  await t.test('same signed persistent profile reopens all observers after restart',async()=>{const restarted=await open();assert.equal(restarted.restore.isOpen(),true);assert.equal(restarted.runtime.monthly.active,true);assert.equal(await restarted.runtime.finance.journals.countDocuments(),journalCount);await close(restarted);});
 }finally{if(database){await database.projectionShutdown?.().catch(()=>{});await demo?.close().catch(()=>{});await database.close();}}
});
