/* MS-P05-R2 independent native review (Claude). Synthetic identifiers only, private mongod, own group.
 * Subject: sealed dist-ms-p04-r2 server and cliente/dist-ms-p04-r2 client. Expectations are the reviewer's own. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
import fs from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import {generate} from 'otplib';
import {root,assertWritable,writeOwn} from './guard.mjs';
const EV=join(root,'Construccion/Sprints/MODO-SIMPLE/Evidencias');
const D=x=>(x&&typeof x==='object'&&'$numberDecimal' in x)?x.$numberDecimal:String(x);

test('MS-P05-R2 native: H01 worker/S06, H02-H03 real UI withdrawal, H04 native zoom',{timeout:900000},async t=>{
 // node:test does not reject the parent when a subtest fails; propagate so result/failure evidence are truthful.
 const sub=async(name,fn)=>{let failure;await t.test(name,async()=>{try{await fn();}catch(e){failure=e;throw e;}});if(failure)throw failure;};
 const obs=[],phases=[];let mongo,group,browser,page,result='FAIL';const mark=(name,t0)=>phases.push({phase:name,durationMs:Math.round(performance.now()-t0)});
 try{
  // Run 1 used a private mongod (mongo.mjs) and was refused by prepareOwned (port 27017 is fixed in product).
  // Run 2: owner authorized one own exact group on the shared 27017 service (04-11-2026); the fixture keeps its guards.
  let t0;
  const F=await import('./harness/fixture.js'),H=await import('./harness/helpers.js');
  const {paymentContract}=await import('../../dist-ms-p04-r2/src/modules/payments/contract.js');
  const {monthlyContract}=await import('../../dist-ms-p04-r2/src/modules/lending/ms-contract.js');
  const {booksTable,etag}=await import('../../dist-ms-p04-r2/src/modules/obligations/models.js');
  t0=performance.now();group=await F.msProfile();const f=await F.world(group,Date.parse('2026-11-01T10:00:00-05:00'));mark('group-and-world',t0);
  t0=performance.now();
  const m=await H.setupMonthly(f,{principal:'1000000.00'}),pay=f.runtime.payments,ctx=()=>f.a.issued.context;
  const advance=async d=>{f.clock.value=Date.parse(d+'T10:00:00-05:00');f.a.issued=(await f.identity.login('TENANT',randomUUID(),f.a.email,F.password)).issued;};
  const loans=[m.loanId];const tags=[m.draft.etag];
  for(let i=0;i<2;i++){const d=await m.ms.mutate(ctx(),'msCreateMonthlyDraft',m.terms,m.params,randomUUID());loans.push(String(H.data(d)['id']));tags.push(d.etag);}
  for(let i=0;i<3;i++){const key=randomUUID(),params={bookId:f.org,loanId:loans[i]},q=await m.ms.mutate(ctx(),'msPreviewActivation',{executionKey:key,effectiveDate:'2026-11-01',expectedBookETag:await H.msTag(f),expectedLoanETag:tags[i],mandateConsent:true,originReference:'SYN-R2-'+i},params,key,tags[i]);await m.ms.mutate(ctx(),'msCommitActivation',{executionKey:key,previewToken:H.data(q)['previewToken'],requestHash:H.data(q)['requestHash']},params,key,tags[i]);}
  const [L1,L2,L3]=loans;
  const payState=async()=>H.data(await pay.read(ctx(),'getPaymentsState',f.org));
  const proofTimes=[];
  const execute=async command=>{const v=await payState(),key=randomUUID(),q=await pay.preview(ctx(),f.org,{executionKey:key,expectedPaymentsETag:v['paymentsBookETag'],command}),payload={command,previewToken:H.data(q)['token']},operation=command['kind']==='REGISTER'?'registerPayment':'executePaymentReversal',id=command['kind']==='EXECUTE_REVERSAL'?String(command['originalEventId']):undefined;const previewAt=f.now();await f.proof(f.a,paymentContract().purpose(operation,payload),{organizationId:f.org,idempotencyKey:key,expectedETag:v['paymentsBookETag'],operationId:operation,resourceId:id??null,payload},id);const commitAt=f.now();if(id)proofTimes.push({key,previewAt,commitAt});const r=await pay.mutate(ctx(),operation,f.org,payload,key,String(v['paymentsBookETag']),id);await f.restore.flush();return r;};
  const {today:financeToday}=await import('../../dist-ms-p04-r2/src/modules/finance/service.js');
  const register=async(loanId,mode,amount='1030000.00')=>{const p=await f.runtime.operations.read(ctx(),'getLoanPosition',f.org,loanId),account=await f.runtime.finance.read(ctx(),'readAccount',f.org,f.bank.id),today=financeToday(f.now());const r=await execute({kind:'REGISTER',mode:'DIRECT',effectiveDate:today,intent:{method:'BANK',borrowerId:m.borrowerId,amount,currency:'COP',destinationAccountId:f.bank.id,destinationAccountETag:account.etag,custodianId:null,bindingETag:null,observedDate:today,observedAt:new Date(f.now()).toISOString(),receiptReference:'SYN-R2-'+randomUUID(),supportReference:'SYN',targets:[{loanId,positionETag:p.etag,amount,mode}],excessDisposition:'REJECT'}});const id=String(H.data(r)['entityId']),row=await f.database.db.collection('payments').findOne({_id:id});return{id,eventId:String(row['eventId'])};};
  const reversalCommand=async(paid,date)=>{const payload={resourceETag:'"'+paid.eventId+':1"',reason:'Corrección sintética R2',supportReference:'SYN-R2'},v=await payState(),key=randomUUID();await f.proof(f.a,paymentContract().purpose('requestPaymentReversal',payload),{organizationId:f.org,idempotencyKey:key,expectedETag:v['paymentsBookETag'],operationId:'requestPaymentReversal',resourceId:paid.eventId,payload},paid.eventId);await pay.mutate(ctx(),'requestPaymentReversal',f.org,payload,key,String(v['paymentsBookETag']),paid.eventId);const req=await pay.read(ctx(),'getLoanEventReversalRequest',f.org,paid.eventId),v2=await payState();return{kind:'EXECUTE_REVERSAL',paymentId:paid.id,originalEventId:paid.eventId,reversalRequestId:paid.eventId,resourceETag:req.etag,expectedOperationsETag:v2['operationsBookETag'],effectiveDate:date,supportReference:'SYN'};};
  const held=await f.account('R2_HELD','LIABILITY'),heldView=await f.runtime.finance.read(ctx(),'readAccount',f.org,held.id),heldPayload={configurationKind:'HELD_FUNDS_PROFILE',heldLiabilityAccountId:held.id,heldLiabilityAccountETag:heldView.etag,resourceETag:'"'+f.org+':held-profile:0"',supportReference:'SYN'},hs=await payState(),hk=randomUUID();await f.proof(f.a,paymentContract().purpose('setHeldFundsProfile',heldPayload),{organizationId:f.org,idempotencyKey:hk,expectedETag:hs['paymentsBookETag'],operationId:'setHeldFundsProfile',resourceId:null,payload:heldPayload});await pay.mutate(ctx(),'setHeldFundsProfile',f.org,heldPayload,hk,String(hs['paymentsBookETag']));await f.restore.flush();
  const pos=async id=>(await f.runtime.operations.positions.findOne({loanId:id}));
  const mandate=async id=>(await f.database.db.collection('ms_mandates').findOne({loanId:id}))?.['status'];
  const runWorker=async()=>{for(let i=0;i<3;i++)await m.ms.worker.runOnce();};
  const digest=async()=>createHash('sha256').update(JSON.stringify(await Promise.all(['financial_journals','loan_positions','loan_compensations','ms_mandates'].map(n=>f.database.db.collection(n).find({}).sort({_id:1}).toArray())))).digest('hex');
  mark('seed-loans',t0);

  t0=performance.now();
  await sub('H01 native: settlement, worker at frontier, in-cycle / frontier-day reversals reopen; late reversal rejected atomically',async()=>{
   await advance('2026-11-16');const p1=await register(L1,'SETTLEMENT'),p3=await register(L3,'SETTLEMENT');
   assert.equal((await pos(L1)).monthlyState.status,'SETTLED');assert.equal((await pos(L3)).monthlyState.status,'SETTLED');
   await advance('2026-11-20');const p2=await register(L2,'SETTLEMENT');
   await advance('2026-11-25');await execute(await reversalCommand(p2,'2026-11-25'));
   const l2=await pos(L2),comp2=l2.monthlyState.facts.filter(x=>x.kind==='COMPENSATION').at(-1),pt=proofTimes.at(-1);
   assert.equal(l2.monthlyState.status,'ACTIVE');assert.equal(l2.principalOutstanding,'1000000.00');
   assert.ok(pt.commitAt>pt.previewAt,'MFA must advance the clock between preview and commit');
   assert.equal(comp2.recordedAt,new Date(pt.commitAt).toISOString(),'K of the compensation is the real commit instant');
   await advance('2026-12-01');await runWorker();
   const s1=await pos(L1),s2=await pos(L2),s3=await pos(L3);
   const mandates={L1:await mandate(L1),L2:await mandate(L2),L3:await mandate(L3)};
   assert.deepEqual(mandates,{L1:'ACTIVE',L2:'ACTIVE',L3:'ACTIVE'},'Settled loans keep the original consent ACTIVE (not COMPLETED)');
   assert.equal(s1.monthlyState.periods.length,1);assert.equal(s3.monthlyState.periods.length,1);
   // Engine fixes the next cycle only once the date is past the frontier (ms-engine.ts:90): on 12-01 L2 still has one period.
   assert.equal(s2.monthlyState.periods.length,1);
   await execute(await reversalCommand(p3,'2026-12-01'));assert.equal((await pos(L3)).monthlyState.status,'ACTIVE');
   await advance('2026-12-02');await runWorker();
   assert.deepEqual((await pos(L2)).monthlyState.periods.slice(1).map(p=>[p.startDate,p.principalBase,p.interest]),[['2026-12-01','1000000.00','30000.00']]);
   const r3=await pos(L3);assert.deepEqual(r3.monthlyState.periods.slice(1).map(p=>[p.startDate,p.dueDate,p.principalBase,p.interest]),[['2026-12-01','2027-01-01','1000000.00','30000.00']]);assert.equal(await mandate(L3),'ACTIVE');
   await advance('2026-12-05');const cmd=await reversalCommand(p1,'2026-12-05'),before=await digest();
   const v=await payState();await assert.rejects(pay.preview(ctx(),f.org,{executionKey:randomUUID(),expectedPaymentsETag:v['paymentsBookETag'],command:cmd}),{code:'REVERSAL_DEPENDENCY'});
   assert.equal(await digest(),before,'late reversal preview changes no journal, position, compensation or mandate');
   const after1=await pos(L1);assert.equal(after1.monthlyState.status,'SETTLED');assert.equal(after1.principalOutstanding,'0.00');
   obs.push({case:'H01_NATIVE',settledLateReversal:'REVERSAL_DEPENDENCY',economicDigestUnchanged:true,inCycleReversal:{status:'ACTIVE',nextPeriod:['2026-12-01','1000000.00','30000.00'],compensationRecordedAt:comp2.recordedAt,previewAt:new Date(pt.previewAt).toISOString(),commitAt:new Date(pt.commitAt).toISOString()},frontierDayReversal:{status:'ACTIVE',nextPeriod:r3.monthlyState.periods[1]&&[r3.monthlyState.periods[1].startDate,r3.monthlyState.periods[1].principalBase,r3.monthlyState.periods[1].interest]},mandatesAfterFrontierWorker:mandates});
  });
  mark('h01-native',t0);

  t0=performance.now();
  const bank=await f.personal('P_BANK','ASSET','BANK'),equity=await f.personal('P_EQUITY','EQUITY'),investment=await f.personal('P_APORTE'),expense=await f.personal('P_EXPENSE','EXPENSE'),P={bookId:f.book.id},ps={kind:'PERSONAL',bookId:f.book.id,ownerId:ctx().subjectId};
  await m.ms.mutate(ctx(),'msVersionMapping',{effectiveFrom:'2026-12-05',cashAccountIds:[bank.id],categories:[{labelId:randomUUID(),label:'Otros',category:'OTHER',expenseAccountId:expense.id}],supportReference:'SYN'},P,randomUUID(),await H.msTag(f,f.book.id));
  await f.wealthMutate('personalRecordExternalFunds',{bookETag:await f.database.client.withSession(async s=>await f.wealth.bookTag(ps,s)),effectiveDate:'2026-12-05',cashAccountId:bank.id,nature:'OWNER_CAPITAL_CONTRIBUTION',amount:'1000.00',equityAccountId:equity.id,contributorReference:'SYN-OWNER',provenanceKind:'SUPPORTED_REFERENCE',supportReference:'SYN'},P);
  const q=()=>({month:'2026-12',effectiveDate:'2026-12-05',knownAt:new Date(f.now()).toISOString()});
  const before0=await m.ms.read(ctx(),'msGetInterbookOptions',P,q());
  assert.deepEqual(H.data(before0)['eligibilities'],[],'no eligibility before the declaration: empty, never a default');
  const eligible=String(H.data(await f.mutate('declareOwnEligibility',{right:'FULL_OWNERSHIP',percentage:'100.00',validFrom:'2026-12-05',supportReference:'SYN'},{organizationId:f.org}))['id']);f.clock.value+=1000;
  await sub('H02 options reader: owner scoped, GET without effects, BUSINESS and another actor denied',async()=>{
   const j=await f.runtime.finance.journals.countDocuments(),pj=await f.database.db.collection('s09_personal_journals').countDocuments(),dg=await digest();
   const r=await m.ms.read(ctx(),'msGetInterbookOptions',P,q());monthlyContract().result('msGetInterbookOptions',r.data);const o=H.data(r);
   assert.equal(o['metadataTime'],'CURRENT_AUTHORITY');assert.equal(o['organizationId'],f.org);assert.equal(o['personalBookId'],f.book.id);
   assert.deepEqual(o['eligibilities'].map(e=>[e.id,e.percentage]),[[eligible,'100.00']]);assert.deepEqual(o['contributions'],[]);
   assert.ok(o['personalAccounts'].length<=100&&o['businessAccounts'].length<=100);
   await assert.rejects(m.ms.read(ctx(),'msGetInterbookOptions',m.params,q()),{code:'ACCESS_DENIED'});
   const other=await f.actor();await assert.rejects(m.ms.read(other.issued.context,'msGetInterbookOptions',P,q()));
   assert.equal(await f.runtime.finance.journals.countDocuments(),j);assert.equal(await f.database.db.collection('s09_personal_journals').countDocuments(),pj);assert.equal(await digest(),dg);
   obs.push({case:'H02_OPTIONS',result:'PASS',emptyEligibilityBeforeDeclaration:true,businessScopeDenied:true,otherActorDenied:true,journalDelta:0});
  });
  mark('h02-options',t0);

  t0=performance.now();
  await sub('H02/H03 real Chrome contribution and withdrawal selected by visible name; negatives; H04 native zoom 200%',async()=>{
   const h=await f.https(),origin='https://localhost:'+h.port,profile=join(group.folder,'browser-profile');
   await group.record({event:'browser-reserved-before-create',profile,ownerPid:process.pid,channel:'chrome',headless:true,budgetBytes:125829120});
   browser=await chromium.launchPersistentContext(profile,{channel:'chrome',headless:true,ignoreHTTPSErrors:true,viewport:null,args:['--window-size=1440,1000','--disk-cache-size=1048576','--media-cache-size=1048576']});
   await browser.addCookies([{name:'__Host-caudelyx-session',value:f.a.issued.token,url:origin,secure:true,httpOnly:true,sameSite:'Strict'}]);
   page=browser.pages()[0]??await browser.newPage();await page.clock.install({time:new Date(f.now())});page.setDefaultTimeout(20000);
   const go=async route=>{const target=origin+'/#/modo-simple/'+route;if(page.url()===target)await page.goto(origin+'/#/modo-simple/mes');await page.goto(target);await expect(page.locator('[data-screen="'+route+'"]')).toBeVisible();await page.waitForLoadState('networkidle');};
   const form=()=>page.locator('form').filter({has:page.getByRole('heading',{name:'Aporte o retiro entre personal y negocio',exact:true})});
   const shot=async(name,full=true)=>{const p=join(EV,'MS-P05-R2-'+name+'.png');await assertWritable(p);await page.screenshot({path:p,fullPage:full});return p;};
   const sent=[];
   const submit=async fr=>{const pending=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/me/interbook-relationships'),{timeout:20000});void pending.catch(()=>undefined);await fr.getByRole('button',{name:'Confirmar cruce',exact:true}).click();const dialog=page.getByRole('dialog');if(await dialog.isVisible().catch(()=>false)){await dialog.getByLabel('Código de 6 dígitos',{exact:true}).fill(await generate({secret:f.a.secret,epoch:Math.floor(f.now()/1000)}));await dialog.getByRole('button',{name:'Confirmar',exact:true}).click();}const res=await pending;sent.push({url:res.url(),status:res.status(),body:res.request().postDataJSON(),headers:await res.request().allHeaders()});return{status:res.status(),json:await res.json().catch(()=>null)};};
   // Selection by what a person sees (code · name / sentence), never by internal id.
   const fill=async(fr,kind,amount,support)=>{await fr.getByLabel('Naturaleza',{exact:true}).selectOption({label:kind==='CONTRIBUTION'?'Aporte del personal al negocio':'Retiro al personal, contra un aporte ya registrado'});if(kind==='WITHDRAWAL'){const sel=fr.getByLabel('Aporte original',{exact:true});await expect(sel.locator('option',{hasText:'por devolver'})).toHaveCount(1,{timeout:15000}).catch(()=>undefined);const texts=await sel.locator('option').allTextContents();obs.push({case:'ROOT_OPTIONS_SEEN',amount,texts});const label=texts.find(x=>/^Aporte del .*por devolver/.test(x));assert.ok(label,'root option visible by date and balance: '+JSON.stringify(texts));await sel.selectOption({label});}
    await fr.getByLabel('Importe',{exact:true}).fill(amount);const more=fr.getByRole('button',{name:'Más opciones del cruce',exact:true});if(await more.isVisible().catch(()=>false))await more.click();
    for(const[l,v]of [['Banco o caja personal','P_BANK · Personal sintética P_BANK'],['Banco o caja del negocio','BANK_S09 · Cuenta sintética BANK_S09'],['Cuenta del aporte personal','P_APORTE · Personal sintética P_APORTE'],['Cuenta del capital del negocio','EQUITY_S09 · Cuenta sintética EQUITY_S09'],['Titularidad del negocio','Propiedad total, vigente desde 2026-12-05']]){const field=fr.getByLabel(l,{exact:true});assert.equal(await field.evaluate(n=>n.tagName),'SELECT',l+' must be a selector');await field.selectOption({label:v});}
    await fr.getByLabel('Soporte',{exact:true}).fill(support);await fr.getByRole('button',{name:'Revisar cruce',exact:true}).click();};
   await go('caja');let fr=form();
   // H03: no free-text internal id fields and no accounting jargon in the cross form.
   const fieldsClosed=await fr.locator('input,select,textarea').evaluateAll(ns=>ns.map(n=>[n.tagName,n.closest('label')?.textContent?.trim().slice(0,40)??n.getAttribute('aria-label')]));
   const formText=await fr.innerText();
   const consPre=H.data(await m.ms.read(ctx(),'msGetConsolidatedMonthlyView',{},q()));obs.push({case:'CONSOLIDATED_BEFORE_CONTRIBUTION',totalCash:consPre.totalCash?.value??null,books:consPre.books.map(b=>[b.scope,b.cash?.value??null])});
   await fill(fr,'CONTRIBUTION','1000','SYN-UI-R2-APORTE');const c=await submit(fr);assert.ok([200,201].includes(c.status),JSON.stringify(c.json));await expect(fr.getByRole('status').filter({hasText:'Cruce confirmado'})).toBeVisible();
   const rootRow=await f.database.db.collection('s09_relationships').findOne({personalBookId:f.book.id,kind:'CONTRIBUTION',rootRelationshipId:null});assert.equal(rootRow['remaining'],'1000.00');
   const fieldsOpen=await form().locator('input,select,textarea').evaluateAll(ns=>ns.map(n=>({tag:n.tagName,type:n.getAttribute('type'),label:n.closest('label')?.textContent?.trim().slice(0,60)??null})));
   const cons=async()=>H.data(await m.ms.read(ctx(),'msGetConsolidatedMonthlyView',{},q()));
   const biz=async()=>H.data(await m.ms.read(ctx(),'msGetMonthlyView',m.params,q()));
   const consBefore=await cons(),bizBefore=await biz();
   await go('mes');await go('caja');fr=form();
   const j0=await f.runtime.finance.journals.countDocuments(),pj0=await f.database.db.collection('s09_personal_journals').countDocuments();
   await fill(fr,'WITHDRAWAL','240','SYN-UI-R2-RETIRO');await shot('caja-retiro-1440');const w=await submit(fr);assert.ok([200,201].includes(w.status),JSON.stringify(w.json));await expect(fr.getByRole('status').filter({hasText:'Cruce confirmado'})).toBeVisible();
   const req=sent.at(-1).body;assert.equal(req.kind,'WITHDRAWAL');assert.deepEqual(req.originalEventIds,rootRow['sourceEventIds']);assert.equal(req.amount,'240.00');
   assert.deepEqual([req.personalCashAccountId,req.businessCashAccountId,req.personalContraAccountId,req.businessContraAccountId,req.eligibilityVersionId],[bank.id,f.bank.id,investment.id,f.equity.id,eligible]);
   assert.ok(sent.at(-1).headers['x-csrf-token'],'browser request carries CSRF');
   const rootAfter=await f.database.db.collection('s09_relationships').findOne({_id:rootRow['_id']}),wd=await f.database.db.collection('s09_relationships').findOne({rootRelationshipId:rootRow['_id'],kind:'WITHDRAWAL'});
   assert.equal(rootAfter['remaining'],'760.00');assert.equal(wd['amount'],'240.00');
   assert.equal(await f.runtime.finance.journals.countDocuments(),j0+1);assert.equal(await f.database.db.collection('s09_personal_journals').countDocuments(),pj0+1);
   const bj=await f.runtime.finance.journals.findOne({_id:String(wd['businessJournalId'])}),pjr=await f.database.db.collection('s09_personal_journals').findOne({_id:wd['personalJournalId']});
   const lines=ls=>ls.map(l=>[l.accountId,D(l.debit),D(l.credit)]).sort((a,b)=>a[0].localeCompare(b[0]));
   assert.deepEqual(lines(bj.lines),[[f.equity.id,'240.00','0.00'],[f.bank.id,'0.00','240.00']].sort((a,b)=>a[0].localeCompare(b[0])));
   assert.deepEqual(lines(pjr['lines']),[[bank.id,'240.00','0.00'],[investment.id,'0.00','240.00']].sort((a,b)=>a[0].localeCompare(b[0])));
   const consAfter=await cons(),bizAfter=await biz(),val=x=>x?.value??null;
   const perBook=c=>({totalCash:val(c.totalCash),totalFree:val(c.totalFree),totalReserved:val(c.totalReserved),books:c.books.map(b=>({scope:b.scope,cash:val(b.cash),free:val(b.free),reserved:val(b.reserved),fundingTransfers:val(b.fundingTransfers),otherIncome:val(b.otherIncome),baseSurplus:val(b.baseSurplus)})),baseSurplus:val(c.baseSurplus),eliminated:c.eliminatedRelationships?.length??null,cutKnownAt:c.cuts?.knownAt});
   const ledgerCash=async()=>({businessBank:await f.runtime.finance.journals.aggregate([{$match:{organizationId:f.org}},{$unwind:'$lines'},{$match:{'lines.accountId':f.bank.id}},{$group:{_id:null,d:{$sum:'$lines.debit'},c:{$sum:'$lines.credit'}}}]).toArray().then(r=>r[0]?D(r[0].d)+' / '+D(r[0].c):null),personalBank:await f.database.db.collection('s09_personal_journals').aggregate([{$unwind:'$lines'},{$match:{'lines.accountId':bank.id}},{$group:{_id:null,d:{$sum:'$lines.debit'},c:{$sum:'$lines.credit'}}}]).toArray().then(r=>r[0]?D(r[0].d)+' / '+D(r[0].c):null)});
   const timing={K:consAfter.cuts?.knownAt,businessJournal:{recordedAt:bj.recordedAt,unitKnownAt:bj.unitKnownAt??null},personalJournal:{recordedAt:pjr['recordedAt'],unitKnownAt:pjr['unitKnownAt']??null},relationship:{recordedAt:wd['recordedAt']??null,unitKnownAt:wd['unitKnownAt']??null},rootRelationship:{unitKnownAt:rootAfter['unitKnownAt']??null}};
   f.clock.value+=1000;const consLater=await cons();
   obs.push({case:'CONSOLIDATED_CASH_CHECK',expected:'totalCash unchanged by an internal business→personal withdrawal at any single cut',before:perBook(consBefore),after:perBook(consAfter),afterK_plus_1s:perBook(consLater),timing,ledgerDebitCreditAfter:await ledgerCash(),passSameK:val(consAfter.totalCash)===val(consBefore.totalCash),passLaterK:val(consLater.totalCash)===val(consBefore.totalCash)});
   assert.equal(val(bizAfter.otherIncome),val(bizBefore.otherIncome),'withdrawal is not income');assert.equal(val(bizAfter.interestCashCollected),val(bizBefore.interestCashCollected));
   obs.push({case:'H02_REAL_UI_WITHDRAWAL',status:w.status,originalContribution:'1000.00',withdrawn:'240.00',remaining:rootAfter['remaining'],request:req,originalEventIdsMatchRoot:true,businessLines:lines(bj.lines),personalLines:lines(pjr['lines']),journalDelta:{business:1,personal:1},consolidatedCash:{before:val(consBefore.totalCash),after:val(consAfter.totalCash)},businessOtherIncome:{before:val(bizBefore.otherIncome),after:val(bizAfter.otherIncome)}});
   obs.push({case:'H03_FORM_FIELDS',closed:fieldsClosed,open:fieldsOpen,jargon:{contrapartida:/contrapartida/i.test(formText),versionDeElegibilidad:/versi[oó]n de elegibilidad/i.test(formText)}});
   assert.ok(!fieldsOpen.some(x=>x.tag==='INPUT'&&/cuenta|elegib|titular|aporte original|contrapartida/i.test(x.label??'')),'no typed ids');
   // UI negative: more than the remaining balance (760) is refused, nothing posted.
   await go('mes');await go('caja');fr=form();const j1=await f.runtime.finance.journals.countDocuments();
   await fill(fr,'WITHDRAWAL','761','SYN-UI-R2-EXCESO');const x=await Promise.race([submit(fr),new Promise(r=>setTimeout(()=>r({status:'NO_REQUEST_CLIENT_BLOCKED',json:null}),15000))]);assert.ok(x.status==='NO_REQUEST_CLIENT_BLOCKED'||x.status>=400,'excess must be refused');await page.waitForTimeout(500);
   const errText=(await fr.innerText()).split('\n').filter(s=>/no |error|saldo|soporte|exced|disponible|aporte/i.test(s)).slice(0,5);
   assert.equal(await f.runtime.finance.journals.countDocuments(),j1);assert.equal((await f.database.db.collection('s09_relationships').findOne({_id:rootRow['_id']}))['remaining'],'760.00');
   // Replays from the real browser session: no CSRF header; stale book ETags.
   const template=sent.find(s=>s.body.kind==='WITHDRAWAL'&&s.body.amount==='240.00');const j2=await f.runtime.finance.journals.countDocuments(),pj2=await f.database.db.collection('s09_personal_journals').countDocuments();
   const replay=await page.evaluate(async({url,body})=>{const r=await fetch(url,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({...body,amount:'1.00'})});return{status:r.status,body:await r.json().catch(()=>null)};},{url:template.url,body:template.body});
   assert.ok(replay.status>=400&&replay.status<500,"no-CSRF replay refused");
   const bs={kind:'BUSINESS',bookId:f.org,ownerId:f.org,organizationId:f.org},cur=await f.database.client.withSession(async s=>({personalBookETag:etag(await f.service.store.get(booksTable,f.book.id,ps,s)),businessBookETag:etag(await f.service.store.get(booksTable,f.org,bs,s))}));
   const base={kind:'WITHDRAWAL',fromScope:'BUSINESS',businessOrganizationId:f.org,eligibilityVersionId:eligible,effectiveDate:'2026-12-05',amount:'1.00',personalCashAccountId:bank.id,businessCashAccountId:f.bank.id,personalContraAccountId:investment.id,businessContraAccountId:f.equity.id,originalEventIds:rootRow['sourceEventIds'],supportReference:'SYN-R2-NEG'};
   const neg={};
   const code=async p=>{try{await p;return'NO_ERROR';}catch(e){return e.code??String(e);}};
   neg.staleETags=await code(f.mutate('postInterbookRelationship',{...base,personalBookETag:template.body.personalBookETag,businessBookETag:template.body.businessBookETag}));
   neg.unknownRoot=await code(f.mutate('postInterbookRelationship',{...base,...cur,originalEventIds:[randomUUID(),randomUUID()]}));
   neg.exceedRemaining=await code(f.mutate('postInterbookRelationship',{...base,...cur,amount:'760.01'}));
   const other=await f.actor();neg.otherActor=await code(f.mutate('postInterbookRelationship',{...base,...cur},{},undefined,randomUUID(),other));
   assert.equal(await f.runtime.finance.journals.countDocuments(),j2,'negatives post nothing');assert.equal(await f.database.db.collection('s09_personal_journals').countDocuments(),pj2);assert.equal((await f.database.db.collection('s09_relationships').findOne({_id:rootRow['_id']}))['remaining'],'760.00');
   for(const k of ['staleETags','unknownRoot','exceedRemaining','otherActor'])assert.notEqual(neg[k],'NO_ERROR',k);
   obs.push({case:'H02_NEGATIVES',uiExcess761:{status:x.status,code:x.json?.error?.code??x.json?.code??null,visibleText:errText},noCsrfReplay:{status:replay.status,code:replay.body?.error?.code??replay.body?.code??null},native:neg,journalDelta:0,remainingAfter:'760.00'});
   // 360 px view of the withdrawal form.
   await page.setViewportSize({width:360,height:800});await go('caja');fr=form();await fr.getByLabel('Naturaleza',{exact:true}).selectOption({label:'Retiro al personal, contra un aporte ya registrado'});await fr.getByRole('button',{name:'Más opciones del cruce',exact:true}).click();
   const overflow360=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);await fr.scrollIntoViewIfNeeded();await shot('caja-retiro-360');
   // H04 visible technical text on the seven screens (1440).
   await page.setViewportSize({width:1440,height:1000});const texts={};
   for(const route of ['mes','prestamos','cobros','deudas','gastos','caja','ahorro']){await go(route);const s=await page.locator('main').innerText().catch(async()=>await page.locator('body').innerText());texts[route]={isoTimestamp:(s.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[^\s]*/g)??[]).slice(0,3),conocidoEl:/Conocido el/.test(s),contratoVisible:/contrato \d/i.test(s),contrapartida:/contrapartida/i.test(s),fechaDelCorte:/Fecha del corte/.test(s)};}
   obs.push({case:'H04_VISIBLE_TEXT_1440',screens:texts});
   // H04 native browser zoom 200% (Chrome settings, not CSS/DPR emulation); walk the cross form with keyboard.
   const zoom=await browser.newPage();await zoom.goto('chrome://settings/appearance');const control=zoom.locator('select').filter({has:zoom.locator('option',{hasText:'200%'})});await control.selectOption({label:'200%'});
   const native=await browser.newCDPSession(page);await native.send('Emulation.clearDeviceMetricsOverride');const win=await native.send('Browser.getWindowForTarget');await native.send('Browser.setWindowBounds',{windowId:win.windowId,bounds:{width:1440,height:1000}});
   await go('caja');const metrics=await page.evaluate(()=>({innerWidth,outerWidth,innerHeight,dpr:devicePixelRatio,visualScale:visualViewport?.scale}));assert.equal(metrics.innerWidth*2,metrics.outerWidth,'native 200% halves the CSS viewport');
   fr=form();await fr.getByLabel('Naturaleza',{exact:true}).selectOption({label:'Retiro al personal, contra un aporte ya registrado'});await fr.getByRole('button',{name:'Más opciones del cruce',exact:true}).click();
   await fr.getByLabel('Naturaleza',{exact:true}).focus();const walk=[];
   for(let i=0;i<14;i++){const el=await page.evaluate(()=>{const a=document.activeElement;if(!a)return null;const r=a.getBoundingClientRect(),label=a.closest('label')?.firstChild?.textContent?.trim()??a.textContent?.trim()?.slice(0,40);return{tag:a.tagName,label,inView:r.top>=0&&r.bottom<=innerHeight+1&&r.left>=0&&r.right<=innerWidth+1,width:Math.round(r.width),clipped:a.scrollWidth>a.clientWidth+1&&a.tagName!=='SELECT',outline:getComputedStyle(a).outlineStyle+' '+getComputedStyle(a).outlineWidth};});walk.push(el);if(!el||!fr)break;await page.keyboard.press('Tab');}
   const pageOverflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
   const shots=[];await fr.getByLabel('Naturaleza',{exact:true}).scrollIntoViewIfNeeded();shots.push(await shot('zoom200-caja-01',false));
   for(const[i,l]of [[2,'Banco o caja personal'],[3,'Titularidad del negocio']]){await fr.getByLabel(l,{exact:true}).scrollIntoViewIfNeeded();shots.push(await shot('zoom200-caja-0'+i,false));}
   await fr.getByRole('button',{name:'Revisar cruce',exact:true}).scrollIntoViewIfNeeded();shots.push(await shot('zoom200-caja-04',false));
   await control.selectOption({label:'100%'});await zoom.close();
   obs.push({case:'H04_NATIVE_ZOOM_200',metrics,overflow360,pageOverflowAt200:pageOverflow,keyboardWalk:walk,screenshots:shots.map(p=>p.slice(root.length+1).replaceAll('\\','/'))});
   await browser.close();browser=undefined;
  });
  mark('ui-browser',t0);
  result='PASS';
 }catch(error){
  obs.push({case:'FAILURE',error:String(error).slice(0,2000),stack:String(error?.stack??'').slice(0,1500)});
  if(page){for(let n=1;n<=3;n++){const p=join(EV,'MS-P05-R2-failure-'+n+'.png');const exists=await fs.lstat(p).then(()=>true,()=>false);if(!exists){await assertWritable(p);await page.screenshot({path:p,fullPage:true,mask:[page.locator('input[autocomplete=one-time-code]'),page.locator('input[type=password]')]}).catch(()=>undefined);break;}}}
  throw error;
 }finally{
  const t0=performance.now();
  await browser?.close().catch(()=>undefined);
  let cleanup={};
  try{if(group)await group.dispose();cleanup.group='DISPOSED';}catch(e){cleanup.group='FAILED:'+String(e).slice(0,300);}
  cleanup.sharedService='NOT_STOPPED_NOT_MODIFIED_BY_DESIGN';
  mark('cleanup',t0);
  await writeOwn(join(EV,'MS-P05-R2-NATIVE.json'),JSON.stringify({task:'MS-P05-R2',result,subject:{server:'Caudelyx/servidor/dist-ms-p04-r2',client:'Caudelyx/cliente/dist-ms-p04-r2'},mongo:mongo?{port:mongo.port,privateGroup:mongo.id}:null,group:group?{folder:group.folder.slice(root.length+1).replaceAll('\\','/'),names:group.names}:null,phases,cleanup,observations:obs,AT12:'NO_EJECUTADA',realUseAllowed:false},null,2)+'\n');
 }
});
