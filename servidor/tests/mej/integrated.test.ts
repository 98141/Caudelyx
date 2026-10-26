import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,appendFile,lstat,realpath,rm,mkdir,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {BSON} from 'mongodb';
import {generate} from 'otplib';
import {profile,setup,fundedSetup,password,errorCode} from './fixture.js';
import {initialBalances} from '../../src/modules/finance/initial-balances.js';
import {today} from '../../src/modules/finance/service.js';
import type {OpeningFile,Snapshot} from '../../src/modules/opening/models.js';
import type {PublicPosition} from '../../src/modules/lending/operations-models.js';
const evidence=resolve('../../Construccion/Sprints/MEJ/Evidencias');

test('MEJ4 integración real de servidor, restore, fences y cliente HTTPS',{timeout:420000},async t=>{
 const group=await profile();
 await t.test('GET first and repeated positions/installments/versions never write domain, ledger or evidence',async()=>{
  const f=await fundedSetup(group),loan=await f.loan({principal:'2000000.00'});
  const names=(await f.database.db.listCollections().toArray()).map(x=>x.name).filter(n=>/^(financial_|loan_|borrower_|lending_|opening_)/.test(n));
  const state=async()=>{const h=createHash('sha256');for(const name of names.sort())h.update(name+BSON.EJSON.stringify(await f.database.db.collection(name).find().sort({_id:1}).toArray(),{relaxed:false}));return h.digest('hex');};
  const before=await state(),lastSeen=(await f.sessions.contexts.findOne({_id:f.a.issued.context._id}))!.lastSeenAt,writes:string[]=[];
  const listener=(event:{commandName:string;command:Record<string,unknown>})=>{if(['insert','update','delete','findAndModify'].includes(event.commandName))writes.push(String(event.command[event.commandName]));};f.database.client.on('commandStarted',listener);
  try{for(let n=0;n<2;n++){await f.ops.read(f.a.issued.context,'listLoanPositions',f.org);await f.ops.read(f.a.issued.context,'getLoanPosition',f.org,loan.id);await f.ops.read(f.a.issued.context,'listLoanInstallments',f.org,loan.id);await f.ops.read(f.a.issued.context,'listLoanScheduleVersions',f.org,loan.id);}}finally{f.database.client.off('commandStarted',listener);}
  assert.equal(await state(),before);assert.equal((await f.sessions.contexts.findOne({_id:f.a.issued.context._id}))!.lastSeenAt,lastSeen);assert.deepEqual(writes.filter(n=>/^(financial_|loan_|borrower_|lending_|opening_)/.test(n)),[]);
  await f.disburse(loan); const active=await state(); writes.length=0;f.database.client.on('commandStarted',listener);
  try{for(let n=0;n<2;n++){await f.ops.read(f.a.issued.context,'getLoanPosition',f.org,loan.id);await f.ops.read(f.a.issued.context,'listLoanInstallments',f.org,loan.id);await f.ops.read(f.a.issued.context,'listLoanScheduleVersions',f.org,loan.id);}}finally{f.database.client.off('commandStarted',listener);}
  assert.equal(await state(),active);assert.deepEqual(writes.filter(n=>/^(financial_|loan_|borrower_|lending_|opening_)/.test(n)),[]);
 });
 await t.test('two processes: advanced opening commit and simple initial balance share the empty-book fence',async()=>{
  const f=await setup(group),equity=(await f.runtime.finance.mutate(f.a.issued.context,'createAccount',f.org,{code:'E',name:'Patrimonio',currency:'COP',accountClass:'EQUITY',kind:'GENERAL'},randomUUID())).data as {id:string},support=randomUUID();
  const snapshot:Snapshot={cutoffDate:'2020-01-01',supports:[{id:support,reference:'SYN-MEJ4',asOfDate:'2020-01-01',declaration:'OWNER_CHECKED'}],references:[],components:[{id:randomUUID(),category:'CASH',accountId:f.account,amount:'100.00',supportIds:[support]},{id:randomUUID(),category:'EQUITY',accountId:equity.id,amount:'100.00',equityKind:'CONTRIBUTED',supportIds:[support]}],historicalInterest:[],informationalHistory:[]};
  let opening:OpeningFile|undefined;for(const operation of ['createOpening','validateOpening','approveOpening']){const payload=operation==='createOpening'?{snapshot}:operation==='validateOpening'?{policyVersion:'S03-OPENING-0.1'}:{validationId:opening!.validation!.id,validationFingerprint:opening!.validation!.fingerprint};const result=await f.runtime.opening.mutate(f.a.issued.context,operation,f.org,payload,randomUUID(),opening?.id,opening?`"${opening.id}:${opening.version}"`:undefined);opening=(operation==='validateOpening'?(result.data as {opening:OpeningFile}).opening:result.data) as OpeningFile;}
  const key=randomUUID(),payload={validationId:opening!.validation!.id,validationFingerprint:opening!.validation!.fingerprint},etag=`"${opening!.id}:${opening!.version}"`;await f.proof(f.a,'OPENING_COMMIT',{organizationId:f.org,idempotencyKey:key,payload,expectedETag:etag},opening!.id);
  const keys=Object.fromEntries(['mail','totp','journal','cursor'].map(name=>[name,Reflect.get(f.keys,name).toString('base64')])),peer=await group.peer({keys,now:f.now(),config:f.config});
  try{const [advanced,simple]=await Promise.allSettled([f.runtime.opening.mutate(f.a.issued.context,'commitOpening',f.org,payload,key,opening!.id,etag),peer.execute({operation:'initialBalances',token:f.a.issued.token,organizationId:f.org,payload:{effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN',description:'Race',items:[{accountId:f.account,amount:'1.00'}]},key:randomUUID()})]);assert.equal(advanced.status,'fulfilled');assert.equal(simple.status,'fulfilled');if(simple.status==='fulfilled')assert.equal(simple.value['type'],'error');assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),1);}finally{await peer.close();}
 });
 await t.test('complete SI restore preserves journal/marker; a pre-SI snapshot cannot reopen under a newer external cut',async()=>{
  const f=await setup(group),input={effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN',description:'Restore SI',items:[{accountId:f.account,amount:'125.50'}]},key=randomUUID(),old=await f.restore.snapshot();
  await initialBalances(f.runtime.finance,f.a.issued.context,f.org,input,key);const complete=await f.restore.snapshot(),token=f.a.issued.token;await f.restore.beginRestore(complete);await f.restore.reconcile({approved:true,reviewId:'OWN-MEJ4-FULL'});assert.equal(await f.sessions.find(token,'TENANT'),null);
  f.a.issued=(await f.identity.login('TENANT',randomUUID(),f.a.email,password)).issued;
  assert.equal((await initialBalances(f.runtime.finance,f.a.issued.context,f.org,input,key)).status,200);assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),1);await assert.rejects(initialBalances(f.runtime.finance,f.a.issued.context,f.org,{...input,sourceId:randomUUID()},randomUUID()),errorCode('INITIAL_BALANCE_UNAVAILABLE'));
  await f.restore.beginRestore(old);await assert.rejects(f.restore.reconcile({approved:true,reviewId:'OWN-MEJ4-INCOMPLETE'}));assert.equal(f.restore.isOpen(),false);await assert.rejects(f.identity.login('TENANT',randomUUID(),f.a.email,password),errorCode('SERVICE_UNAVAILABLE'));
 });
 await t.test('two-process SI versus normal posting and empty-book S5 serialize without a second initialization',async()=>{
  for(const mode of ['financePost','previewAndDisburse']){
   const f=await setup(group,'2026-10-31T12:00:00-05:00'),account=async(code:string,accountClass:string)=>(await f.runtime.finance.mutate(f.a.issued.context,'createAccount',f.org,{code,name:'Sintética '+code,currency:'COP',accountClass,kind:'GENERAL'},randomUUID())).data as {id:string};
   const equity=await account('EQ','EQUITY'),normal={currency:'COP',effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN-RACE',description:'Aporte normal',lines:[{accountId:f.account,debit:'10.00',credit:'0.00'},{accountId:equity.id,debit:'0.00',credit:'10.00'}]};await f.proof(f.a,'FINANCE_JOURNAL_POST',{organizationId:f.org,idempotencyKey:randomUUID(),payload:normal});
   let request:Record<string,unknown>|undefined;
   if(mode==='previewAndDisburse'){
    const ids:Record<string,string>={},versions:Record<string,string>={};for(const [field,code,kind] of [['principalAccountId','P','ASSET'],['interestReceivableAccountId','I','ASSET'],['interestIncomeAccountId','Y','INCOME'],['borrowerCreditAccountId','C','LIABILITY']]){const a=await account(code!,kind!);ids[field!]=a.id;versions[field!]=(await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,a.id)).etag!;}
    const borrower=(await f.borrower()).data as {id:string},q=(await f.quote(borrower.id,{principal:'50.00',effectiveDate:'2026-09-30',firstDueDate:'2026-10-31'})).data as {id:string;fingerprint:string},binding={quoteId:q.id,quoteFingerprint:q.fingerprint},draft=await f.mutate('createLoanDraft',binding),d=draft.data as {id:string},confirmed=await f.mutate('confirmLoanTerms',{...binding,termsVersion:1},{id:d.id,etag:draft.etag!});
    request={kind:'DISBURSE',loanId:d.id,loanETag:confirmed.etag!,fundingAccountETag:(await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,f.account)).etag!,accountProfile:ids,accountVersions:versions,effectiveDate:today(f.now()),supportReference:'SYN-RACE-S5'};
   }
   assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),0);
   const keys=Object.fromEntries(['mail','totp','journal','cursor'].map(name=>[name,Reflect.get(f.keys,name).toString('base64')])),peer=await group.peer({keys,now:f.now(),config:f.config});
   try{const input={effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN-RACE-SI',description:'Carga inicial',items:[{accountId:f.account,amount:'125.50'}]},results=await Promise.allSettled([initialBalances(f.runtime.finance,f.a.issued.context,f.org,input,randomUUID()),peer.execute({operation:mode,token:f.a.issued.token,organizationId:f.org,payload:normal,request,key:randomUUID()})]);
    const si=results[0]!,other=results[1]!;assert.equal(other.status,'fulfilled');const effect=other.value['type']==='result';if(mode==='financePost')assert.ok(effect);else assert.equal(si.status,'fulfilled');
    const journals=await f.runtime.finance.journals.find({organizationId:f.org}).sort({recordedAt:1}).toArray(),initial=journals.filter(j=>j.source.type==='INITIAL_BALANCE');assert.equal(initial.length,si.status==='fulfilled'?1:0);assert.equal(journals.length,initial.length+(effect?1:0));if(initial.length)assert.equal(journals[0]!._id,initial[0]!._id);
    // A normal posting or funded S5 command may follow SI in the serialized order; it cannot make SI occur after the first journal.
    await assert.rejects(initialBalances(f.runtime.finance,f.a.issued.context,f.org,{...input,sourceId:randomUUID()},randomUUID()),errorCode('INITIAL_BALANCE_UNAVAILABLE'));
   }finally{await peer.close();}
  }
 });
 await t.test('missing external SI security evidence closes restore instead of reopening the initial exception',async()=>{
  const f=await setup(group);await initialBalances(f.runtime.finance,f.a.issued.context,f.org,{effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN',description:'Missing mirror',items:[{accountId:f.account,amount:'1.00'}]},randomUUID());const snapshot=await f.restore.snapshot();
  const mirror=f.database.client.db(f.database.db.databaseName+'_external_security').collection('events'),last=await mirror.findOne({},{sort:{_id:-1}});assert.ok(last);await mirror.deleteOne({_id:last._id});await f.restore.beginRestore(snapshot);await assert.rejects(f.restore.reconcile({approved:true,reviewId:'OWN-MEJ4-MISSING-MIRROR'}));assert.equal(f.restore.isOpen(),false);
 });
 await t.test('first-factor CAS and shared account attempt limits survive fresh W contexts',async()=>{
  const f=await group.fixture(),reg=await f.signup(),one=(await f.identity.confirmEmail(reg.issued.context,{purpose:'ACTIVATION',token:reg.token})).issued,two=(await f.identity.login('TENANT',randomUUID(),reg.email,password)).issued;
  const a=await f.runtime.totp.enroll(one.context,'CAS uno',password),b=await f.runtime.totp.enroll(two.context,'CAS dos',password),secretA=new URL(a.provisioningUri).searchParams.get('secret')!,secretB=new URL(b.provisioningUri).searchParams.get('secret')!;
  const confirmations=await Promise.allSettled([f.runtime.totp.confirm(one.context,a.enrollmentId,await generate({secret:secretA,epoch:Math.floor(f.now()/1000)})),f.runtime.totp.confirm(two.context,b.enrollmentId,await generate({secret:secretB,epoch:Math.floor(f.now()/1000)}))]);assert.equal(confirmations.filter(x=>x.status==='fulfilled').length,1);assert.equal(await f.sessions.factors.countDocuments({subjectId:one.context.subjectId!,state:'ACTIVE'}),1);
  f.clock.value+=900001; // Isolate attempt-limit window from the deliberately rejected CAS enrollment.
  const active=(await f.sessions.factors.findOne({subjectId:one.context.subjectId!,state:'ACTIVE'}))!,secret=active._id===a.enrollmentId?secretA:secretB,current=await generate({secret,epoch:Math.floor(f.now()/1000)}),invalid=current==='000000'?'000001':'000000';
  for(let n=0;n<11;n++){f.clock.value+=1;const context=(await f.identity.login('TENANT',randomUUID(),reg.email,password)).issued.context,prepared=await f.identity.work!.prepare(context,{purpose:'PASSWORD_CHANGE',method:'TOTP'});await assert.rejects(f.identity.work!.verify(context,{intentId:prepared.intentId,method:'TOTP',code:invalid}),errorCode(n<10?'MFA_INVALID':'RATE_LIMITED'));}
 });
 await t.test('all financial roles/realm restrictions use current authority even with a stored money grant',async()=>{
  const f=await fundedSetup(group);for(const roles of [['T'],['A'],['O'],['C'],['P'],['L'],['SA'],['T','SA']]){
   await f.identity.identities.updateOne({_id:f.a.issued.context.subjectId!},{$set:{roles}});
   const action=()=>f.runtime.finance.read(f.a.issued.context,'listAccounts',f.org);
   if(roles.length===1&&roles[0]==='T')assert.equal((await action()).status,200);else await assert.rejects(action(),errorCode('ACCESS_DENIED'));
  }
  await assert.rejects(f.runtime.finance.read({...f.a.issued.context,realm:'PLATFORM'},'listAccounts',f.org));
 });
 await t.test('activation60min and RESET10min stay purpose-bound; unconfirmed cleanup/rejection retains tombstones',async()=>{
  const f=await group.fixture(),a=await f.signup(),b=await f.signup(),hash=a.subject.passwordHash;f.clock.value+=3599999;
  const publicContext=await f.sessions.issue('TENANT','P',null),confirmed=await f.identity.confirmEmail(publicContext.context,{purpose:'ACTIVATION',token:a.token});assert.equal(Reflect.get(confirmed.data,'nextAction'),'LOGIN');assert.equal((await f.identity.identities.findOne({_id:a.subject._id}))!.passwordHash,hash);
  f.clock.value+=1;const boundaryPublic=await f.sessions.issue('TENANT','P',null);await assert.rejects(f.identity.confirmEmail(boundaryPublic.context,{purpose:'ACTIVATION',token:b.token}),errorCode('TOKEN_INVALID'));
  const anon=await f.sessions.issue('TENANT','P',null);await f.identity.requestEmail('TENANT',randomUUID(),'RESET',b.email,anon.context);await f.identity.dispatchMail();const reset=[...f.messages.inbox.values()].find(m=>m.subjectId===b.subject._id&&m.purpose==='RESET')!;assert.ok(reset);
  f.clock.value+=599999;await f.identity.reset(anon.context,{mode:'PREVIEW',token:reset.token},randomUUID());f.clock.value+=1;const fresh=await f.sessions.issue('TENANT','P',null);await assert.rejects(f.identity.reset(fresh.context,{mode:'PREVIEW',token:reset.token},randomUUID()),errorCode('TOKEN_INVALID'));
  const rejected=await f.signup(),p=await f.sessions.issue('TENANT','P',null);await f.identity.onboarding.reject(p.context,rejected.token);assert.equal(await f.identity.identities.findOne({_id:rejected.subject._id}),null);assert.ok(await f.database.db.collection<{_id:string}>('onboarding_tombstones').findOne({_id:rejected.subject._id}));
  f.clock.value+=7*86400000;await f.identity.onboarding.expire();assert.equal(await f.identity.identities.findOne({_id:b.subject._id}),null);assert.ok(await f.database.db.collection<{_id:string}>('onboarding_tombstones').findOne({_id:b.subject._id}));
 });
 await t.test('built UI and backend together: real Playwright journey, screenshots and authoritative economic result',{timeout:300000},async()=>{
  const f=await fundedSetup(group),seed=await f.loan({principal:'1000.00'});await f.disburse(seed);const loan=await f.loan({principal:'2000000.00'}),b=await f.signup(),confirmed=await f.identity.confirmEmail(b.issued.context,{purpose:'ACTIVATION',token:b.token});
  for(const [actor,name] of [[f.a.issued.context,'Titular Alfa'],[confirmed.issued.context,'Titular Beta']] as const){const subject=(await f.identity.identities.findOne({_id:actor.subjectId!}))!;await f.identity.onboarding.profile(actor,{displayName:name},subject.profileVersion??subject.version);}
  f.clock.value+=30000;await readFile(resolve('../cliente/dist/index.html'));const ownHttps=f.https as (withClient?:boolean)=>ReturnType<typeof f.https>,https=await ownHttps(true),release=group.hold();
  const receipt=async(event:Record<string,unknown>)=>appendFile(join(evidence,'MEJ-4-RESOURCES.jsonl'),JSON.stringify({task:'MEJ-4',at:new Date().toISOString(),ownerPid:process.pid,resource:'OWN_PLAYWRIGHT_RUNNER',...event})+'\n');
  const browserTemp=join(group.folder,'browser-temp');
  await receipt({event:'runner-reserved-before-create',port:https.port,folder:group.folder,browserTemp,controlBudgetBytes:67108864});await mkdir(browserTemp);

  const child=spawn(process.execPath,[resolve('../cliente/node_modules/@playwright/test/cli.js'),'test','-c','playwright.mej-integration.config.ts'],{cwd:resolve('../cliente'),windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,TEMP:browserTemp,TMP:browserTemp,TMPDIR:browserTemp,MEJ4_BASE_URL:'https://localhost:'+https.port,MEJ4_FOLDER:group.folder,MEJ4_CONTEXT:JSON.stringify({a:{email:f.a.email,password,secret:f.a.secret},b:{email:b.email,password},loanId:loan.id,date:today(f.now()),epoch:Math.floor(f.now()/1000)})}});
  let output='';child.stdout.on('data',(chunk:Buffer)=>{output+=chunk.toString();});child.stderr.on('data',(chunk:Buffer)=>{output+=chunk.toString();});await receipt({event:'runner-created',pid:child.pid});
  try{const [code]=await once(child,'exit');await writeFile(join(evidence,'MEJ-4-E2E.log'),output);assert.equal(code,0,'Own E2E failed; see MEJ-4-E2E.log');assert.equal(((await f.position(loan.id)).data as PublicPosition).principalOutstanding,'1710000.00');const subject=(await f.identity.identities.findOne({_id:confirmed.issued.context.subjectId!}))!;assert.equal(subject.hasEverConfirmedFactor,true);assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:subject.organizationId!,'source.type':'INITIAL_BALANCE'}),1);
  }finally{
    if(child.exitCode===null)throw Error('Own runner has not stopped; retain lease and block cleanup');
    const rows=(await readFile(join(evidence,'MEJ-4-RESOURCES.jsonl'),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line) as {runnerPid?:number;browserPids?:number[]});
    const pids=[...new Set(rows.filter(row=>row.runnerPid===child.pid).flatMap(row=>row.browserPids??[]))];assert.ok(pids.length,'Own CDP process inventory missing');
    const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}};
    for(let n=0;n<20&&pids.some(alive);n++)await new Promise(r=>setTimeout(r,100));assert.deepEqual(pids.filter(alive),[],'Own browser processes remain');
    async function bytes(path:string):Promise<number>{let count=0;for(const item of await readdir(path,{withFileTypes:true})){const file=join(path,item.name),stat=await lstat(file);if(stat.isSymbolicLink())throw Error('Linked browser control');count+=item.isDirectory()?await bytes(file):stat.size;}return count;}
    let measured=0;
    for(const folder of [join(group.folder,'playwright'),browserTemp])try{
      if(resolve(await realpath(folder))!==resolve(folder)||(await lstat(folder)).isSymbolicLink())throw Error('Unknown Playwright control');measured+=await bytes(folder);await rm(folder,{recursive:true,force:false,maxRetries:3});
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    await receipt({event:'browser-cleanup-verified',browserPids:pids,remainingBrowserPids:[],measuredControlBytes:measured,overBudget:measured>67108864});assert.ok(measured<=67108864,'Own browser budget exceeded');
    release();await receipt({event:'runner-cleanup-complete',pid:child.pid,exitCode:child.exitCode});
  }
 });
});
