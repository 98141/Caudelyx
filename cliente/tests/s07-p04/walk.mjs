import assert from 'node:assert/strict';
import {writeFile,appendFile,readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
const client=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),server=resolve(client,'../servidor'),evidence=resolve(client,'../../Construccion/Sprints/S07/Evidencias');
process.chdir(server);
const {chromium}=await import(pathToFileURL(resolve(client,'node_modules/playwright/index.mjs')).href);
const {generate}=await import(pathToFileURL(resolve(server,'node_modules/otplib/dist/index.js')).href);
const {cashSetup}=await import(pathToFileURL(resolve(server,'dist-s07-p04/tests/s07-p04/fixture.js')).href);
const {s07Profile}=await import(pathToFileURL(resolve(server,'dist-s07-p04/tests/s07-p04/profile.js')).href);
const group=await s07Profile(),steps=[],started=Date.now();let browser;
const value=r=>r.data;
async function saveEvidence(data){let prior;try{prior=JSON.parse(await readFile(resolve(evidence,'S07-P04-BROWSER.json'),'utf8'));}catch{}const history=prior?[...(prior.history??[]),Object.fromEntries(Object.entries(prior).filter(([k])=>k!=='history'))]:[];await writeFile(resolve(evidence,'S07-P04-BROWSER.json'),JSON.stringify({...data,history},null,2));}
const mark=(name,extra={})=>{steps.push({name,atUTC:new Date().toISOString(),...extra});console.log('P04_BROWSER',name);};
const journalLines=async f=>{const map={};for(const j of await f.runtime.finance.journals.find({organizationId:f.org}).toArray())for(const l of j.lines)map[l.accountId]=(map[l.accountId]??0n)+BigInt(l.debit.toString().replace('.',''))-BigInt(l.credit.toString().replace('.',''));return Object.fromEntries(Object.entries(map).map(([id,c])=>[id,String(c)]));};
try{
 const f=await cashSetup(group,false,true),pActor=await f.member('P'),https=await f.https(true),origin='https://localhost:'+https.port;
 browser=await chromium.launch({channel:'chrome',headless:true});
 const actors={C:f.c,O:f.o,T:f.a,P:pActor},contexts={},pages={};
 const cookies=actor=>[{name:'__Host-caudelyx-session',value:actor.issued.token,url:origin+'/',secure:true,httpOnly:true,sameSite:'Lax'}];
 for(const [role,actor]of Object.entries(actors)){
  contexts[role]=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1280,height:900}});
  await contexts[role].addCookies(cookies(actor));
  const page=pages[role]=await contexts[role].newPage();
  page.on('pageerror',error=>console.log('BROWSER_PAGE_ERROR',role,error.message));
  page.on('response',response=>{if(response.request().method()==='POST'&&response.status()>=400)console.log('BROWSER_POST',role,response.status(),new URL(response.url()).pathname);});
  await page.clock.install({time:new Date(f.now())});
 }
 const sync=async()=>{for(const page of Object.values(pages))await page.clock.setFixedTime(new Date(f.now()));};
 const go=async(role,route='cobranza')=>{await contexts[role].addCookies(cookies(actors[role]));const page=pages[role];await page.clock.setFixedTime(new Date(f.now()));await page.goto(origin+'/#/'+route);await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('heading',{name:route==='pagos'?'Pagos':'Cobranza y caja',exact:true}).waitFor();return page;};
 const idle=async page=>await page.locator('[aria-busy="true"]').first().waitFor({state:'hidden'});
 const collectionReady=async role=>{const page=await go(role);await page.getByRole('button',{name:'Actualizar datos'}).waitFor();await page.getByLabel('Soporte',{exact:true}).fill('SYN-P04');await idle(page);return page;};
 const postClick=async(page,name,path)=>{await sync();const done=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith(path));await page.getByRole('button',{name,exact:true}).click();const response=await done;assert.ok(response.ok(),name+':'+response.status()+' '+await response.text());await idle(page);return await response.json();};
 const selectDelivery=async(role,id)=>{const page=await collectionReady(role);await page.locator('tbody tr').filter({hasText:id.slice(0,8)}).getByRole('button',{name:'Abrir',exact:true}).click();await page.getByRole('region',{name:'Entrega seleccionada',exact:true}).getByRole('heading').waitFor();return page;};
 const positions=async subject=>value(await f.readCollections('getCashPosition',subject)).items;
 const idsBefore=async()=>new Set((await f.database.db.collection('cash_deliveries').find({organizationId:f.org}).toArray()).map(d=>d._id));
 if(process.env.P04_LOGOUT_ONLY==='1'){
  const checks=JSON.parse(await readFile(resolve(evidence,'S07-P04-CHECKS.json'),'utf8')),previous=JSON.parse(await readFile(resolve(evidence,'S07-P04-BROWSER.json'),'utf8'));
  const prefix=[...(previous.history??[]),previous].find(row=>row.error?.includes('outside of the viewport')&&row.steps.some(s=>s.name==='H03-browser-discrepancy-investigation-pending-link-zero-new-journals'));assert.ok(prefix,'Valid financial prefix is required');
  for(const row of checks.browserPrefixMapping.sourceSnapshot){if(row.path==='Caudelyx/cliente/tests/s07-p04/walk.mjs')continue;const bytes=await readFile(resolve(client,'../..',row.path));const layoutDelta=checks.layoutOnlyDelta?.rows.find(d=>d.path===row.path);if(layoutDelta)assert.equal(layoutDelta.beforeSHA256,row.sha256);assert.equal(createHash('sha256').update(bytes).digest('hex'),layoutDelta?.afterSHA256??row.sha256,row.path);}
  const c=await collectionReady('C');await c.getByLabel('Préstamo de la gestión').selectOption({index:1});await c.getByLabel('Nota',{exact:true}).fill('BORRADOR_PRIVADO_P04');await c.getByLabel('Nota',{exact:true}).focus();await c.keyboard.press('Tab');assert.notEqual(await c.evaluate(()=>document.activeElement?.tagName),'BODY');
  await c.screenshot({path:resolve(evidence,'S07-P04-desktop.png'),fullPage:true});await c.setViewportSize({width:360,height:800});await c.getByRole('heading',{name:'Custodia',exact:true}).scrollIntoViewIfNeeded();const mobileLayout=await c.locator('main').evaluate(m=>({width:m.clientWidth,scroll:m.scrollWidth}));assert.ok(mobileLayout.scroll<=mobileLayout.width+1,JSON.stringify(mobileLayout));assert.ok(await c.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await c.screenshot({path:resolve(evidence,'S07-P04-mobile.png'),fullPage:true});
  const paymentPage=await go('T','pagos');const paymentRecord=value(await f.readPayment(f.paymentId));await paymentPage.getByRole('button',{name:new RegExp(paymentRecord.intent.receiptReference)}).waitFor();await paymentPage.setViewportSize({width:360,height:800});const paymentsMobileLayout=await paymentPage.locator('main').evaluate(m=>({width:m.clientWidth,scroll:m.scrollWidth}));assert.ok(paymentsMobileLayout.scroll<=paymentsMobileLayout.width+1,JSON.stringify(paymentsMobileLayout));
  const second=await contexts.C.newPage();await second.clock.install({time:new Date(f.now())});await second.goto(origin+'/#/cobranza');await second.getByRole('heading',{name:'Cobranza y caja',exact:true}).waitFor();
  await c.getByRole('button',{name:'Abrir menú',exact:true}).click();await c.getByRole('button',{name:'Cerrar sesión',exact:true}).click();await second.waitForURL('**/#/ingresar**');
  assert.equal(await c.evaluate(()=>sessionStorage.getItem('caudelyx.s07.collections.draft')),null);assert.equal(await second.evaluate(()=>sessionStorage.getItem('caudelyx.s07.collections.draft')),null);
  mark('keyboard-360px-mobile-menu-two-tabs-logout-private-draft-cleared');
  await saveEvidence({task:'S07-P04',result:'PASS',scope:'COMPOSITE_BY_IMPACT',mobileLayout,paymentsMobileLayout,layoutOnlyDelta:checks.layoutOnlyDelta,runId:group.runId,organization:f.org,steps:[...prefix.steps,...steps],seconds:(Date.now()-started)/1000,reusedPrefixSeconds:checks.browserPrefixMapping.run.seconds,reusedPrefixRun:'browser-r4',reusedPrefixSourceFingerprint:checks.browserPrefixMapping.verifiedCurrentFingerprint,nativeZoom:'NOT_AVAILABLE_IN_HEADLESS_CHROME;360px is reflow only',runtimeSourcesUnchangedFromValidatedPrefix:true,independentReview:false});
 }else{
 // Browser approval by P: pending synthetic cash registered via real domain API in fixture.
 const pp=await go('P','pagos'),cash=value(await f.readPayment(f.paymentId));
 await pp.getByRole('button',{name:new RegExp(cash.intent.receiptReference)}).click();
 await pp.getByLabel('Soporte de la acción',{exact:true}).fill('SYN-P04');
 await postClick(pp,'Pedir el plan de aprobación','/payment-previews');
 await pp.getByRole('checkbox',{name:/Confirmo este plan/}).check();
 // P has no balance grant yet: verification is a real browser dialog.
 const pendingApproval=pp.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/approve'));
 await pp.getByRole('button',{name:'Confirmar la aprobación',exact:true}).click();
 await pp.getByRole('dialog').waitFor();f.clock.value+=30000;await sync();
 await pp.getByLabel('Código de 6 dígitos').fill(await generate({secret:pActor.secret,epoch:Math.floor(f.now()/1000)}));
 await pp.getByRole('dialog').getByRole('button',{name:'Confirmar',exact:true}).click();
 assert.equal((await pendingApproval).status(),201);await idle(pp);
 assert.equal(value(await f.position(f.l.id)).principalOutstanding,'1760000.00');
 mark('P-real-code-approval-cash300',{paymentId:f.paymentId});
 const c=await collectionReady('C');
 await postClick(c,'Abrir la jornada','/collection-journeys');
 await c.getByLabel('Préstamo de la gestión').selectOption({index:1});
 await c.getByLabel('Tipo de gestión').selectOption('PROMISE');
 await c.getByLabel('Importe prometido').fill('50000');await c.getByLabel('Fecha prometida').fill('2026-11-01');
 await c.getByLabel('Nota',{exact:true}).fill('Promesa sintética P04');
 const beforeNote=await f.runtime.finance.journals.countDocuments({organizationId:f.org});
 await postClick(c,'Registrar la gestión','/actions');assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),beforeNote);
 mark('C-journey-promise-no-ledger');
 // Partial250: request/physical actors; real lost response AFTER server commit.
 await c.getByLabel('Caja de destino').selectOption({index:1});await c.getByLabel('Lote confirmado').selectOption({index:1});await c.getByLabel('Importe a entregar').fill('250000');
 const existing=await idsBefore();await postClick(c,'Pedir el plan de entrega','/cash-delivery-previews');await c.getByRole('checkbox',{name:/Confirmo este plan/}).check();
 await postClick(c,'Solicitar la entrega','/cash-deliveries');
 const delivery=(await f.database.db.collection('cash_deliveries').find({organizationId:f.org}).toArray()).find(d=>!existing.has(d._id));assert.ok(delivery);
 await postClick(c,'Despachar','/dispatch');
 const o=await selectDelivery('O',delivery._id);await postClick(o,'Recibir para conteo','/receive');await o.getByLabel('Importe contado').fill('250000');await postClick(o,'Registrar el conteo','/counts');
 await f.sessions.contexts.updateOne({_id:f.a.issued.context._id},{$unset:{balanceGrant:''}});
 const t=await selectDelivery('T',delivery._id);await postClick(t,'Pedir el plan de confirmación','/cash-delivery-previews');await t.getByRole('checkbox',{name:/Confirmo este plan/}).check();
 const confirmPath='/api/v1/organizations/'+f.org+'/cash-deliveries/'+delivery._id+'/confirm';let sent;
 await contexts.T.route('**'+confirmPath,async route=>{sent={body:route.request().postData(),key:route.request().headers()['idempotency-key'],etag:route.request().headers()['if-match']};const response=await route.fetch();assert.equal(response.status(),201);await route.abort('connectionreset');},{times:1});
 await t.getByRole('button',{name:'Confirmar la entrega',exact:true}).click();await t.getByRole('dialog').waitFor();f.clock.value+=30000;await sync();
 await t.getByLabel('Código de 6 dígitos').fill(await generate({secret:f.a.secret,epoch:Math.floor(f.now()/1000)}));await t.getByRole('dialog').getByRole('button',{name:'Confirmar',exact:true}).click();
 await t.getByRole('button',{name:'Reintentar el mismo comando',exact:true}).waitFor();
 const committedCount=await f.runtime.finance.journals.countDocuments({organizationId:f.org});
 await t.reload();await t.getByRole('button',{name:'Reintentar el mismo comando',exact:true}).waitFor();let retry;
 t.once('request',()=>{});const capture=request=>{if(new URL(request.url()).pathname===confirmPath&&request.method()==='POST')retry={body:request.postData(),key:request.headers()['idempotency-key'],etag:request.headers()['if-match']};};t.on('request',capture);
 await postClick(t,'Reintentar el mismo comando','/confirm');t.off('request',capture);assert.deepEqual(retry,sent);assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),committedCount);
 let ps=await positions(f.c.issued.context.subjectId);assert.equal(ps[0].retainedAtOrigin,'50000.00');assert.equal(ps[0].available,'0.00');
 const central=(await positions(f.o.issued.context.subjectId)).find(x=>x.accountId===f.central.id);assert.equal(central.available,'250000.00');assert.equal((await journalLines(f))[f.central.id],'25000000');
 mark('partial250-of300-lost-response-reload-same-key-body-etag',{deliveryId:delivery._id,sourceRetained:'50000.00',centralAvailable:'250000.00',journalCount:committedCount});
 // Full compensation via approved server plan and real physical declarations on browser.
 await selectDelivery('T',delivery._id);const old=await idsBefore();await postClick(t,'Pedir plan de compensación completa','/cash-delivery-previews');await t.getByRole('checkbox',{name:/Confirmo este plan/}).check();await postClick(t,'Solicitar compensación','/compensations');
 const comp=(await f.database.db.collection('cash_deliveries').find({organizationId:f.org}).toArray()).find(d=>!old.has(d._id));assert.ok(comp);
 await selectDelivery('O',comp._id);await postClick(o,'Despachar','/dispatch');
 await selectDelivery('C',comp._id);await postClick(c,'Recibir para conteo','/receive');await c.getByLabel('Importe contado').fill('250000');await postClick(c,'Registrar el conteo','/counts');
 await selectDelivery('T',comp._id);await postClick(t,'Pedir el plan de confirmación','/cash-delivery-previews');await t.getByRole('checkbox',{name:/Confirmo este plan/}).check();await postClick(t,'Confirmar compensación','/compensation-confirmation');
 assert.equal((await positions(f.c.issued.context.subjectId))[0].retainedAtOrigin,'300000.00');assert.equal((await journalLines(f))[f.central.id],'0');mark('full-compensation250-physical-return');
 // Discrepancy230 vs250: API request seed, subsequent browser investigation/recount/ack/correction/return.
 const next=value(await(await f.request()).execute()).entityId;await f.act('dispatchCashDelivery',next,f.c);await f.act('receiveCashDelivery',next,f.o);
 await selectDelivery('O',next);await o.getByLabel('Importe contado').fill('230000');await postClick(o,'Registrar el conteo','/counts');
 await selectDelivery('T',next);assert.equal(await t.getByRole('button',{name:'Pedir el plan de confirmación',exact:true}).count(),0);await postClick(t,'Abrir investigación de la diferencia','/investigation');
 await selectDelivery('O',next);await o.getByLabel('Importe contado').fill('250000');await postClick(o,'Registrar el conteo','/counts');
 await selectDelivery('C',next);await postClick(c,'Ratificar el conteo','/sender-acknowledgments');
 await selectDelivery('T',next);await postClick(t,'Resolver con el conteo ratificado','/correction');await postClick(t,'Solicitar retorno físico','/return-requests');
 await selectDelivery('O',next);await o.getByLabel('Importe de la entrega al declarar retorno').fill('250000');await postClick(o,'Declarar despacho de retorno','/return-facts');
 await selectDelivery('C',next);await c.getByLabel('Importe de la entrega al declarar retorno').fill('250000');await postClick(c,'Declarar recepción del retorno','/return-facts');await postClick(c,'Declarar conteo del retorno','/return-facts');
 await selectDelivery('T',next);await postClick(t,'Confirmar retorno completo','/return-confirmation');
 assert.equal((await positions(f.c.issued.context.subjectId))[0].retainedAtOrigin,'300000.00');mark('discrepancy230-recount250-ack-correction-and-real-return');
 // Arqueo and exact journey closure.
 await collectionReady('C');await c.getByRole('button',{name:'Copiar lo esperado del servidor',exact:true}).click();await postClick(c,'Declarar el arqueo','/cash-closes');
 const finalize=c.getByRole('button',{name:/^Finalizar arqueo /});const doneClose=c.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/finalize'));await finalize.click();assert.equal((await doneClose).status(),201);await idle(c);
 await postClick(c,'Cerrar jornada propia','/close');assert.equal((await f.database.db.collection('collection_journeys').findOne({organizationId:f.org,ownerId:f.c.issued.context.subjectId})).status,'CLOSED');mark('cash-close-and-journey-finalized-without-release');

 // UI bank registration twice; direct API receipt intervenes; current approval plans preserve original intent.
 const bank=await f.accountS06('BANK_P04','ASSET','BANK'),loan2=await f.loan({principal:'2000000.00'});await f.disburse(loan2);const scope2=randomUUID();
 await f.mutatePayment('setPaymentRegistrationScope',{scopeId:scope2,registrarId:f.c.issued.context.subjectId,loanId:loan2.id,scope:'PAYMENT_REGISTER_ONLY',active:true,resourceETag:'"'+scope2+':0"',supportReference:'SYN-P04'});
 const contextRows=value(await f.pay.read(f.c.issued.context,'listPaymentContexts',f.org)).items,bankContext=contextRows.find(x=>x.loanId===loan2.id&&x.permittedDestinationId===bank.id);assert.ok(bankContext);
 const references=['SYN-P04-PENDING-1','SYN-P04-PENDING-2'],pending=[];
 for(const reference of references){
  const pc=await go('C','pagos');
  const form=pc.locator('form').filter({has:pc.getByRole('heading',{name:'Registrar cobro',exact:true})});
  const destination=form.getByRole('checkbox',{name:new RegExp(bankContext.loanReference+'.*BANK_P04')});await destination.check();
  await form.getByLabel(new RegExp('Importe para')).fill('100000');await form.getByLabel('Importe del recibo',{exact:true}).fill('100000');
  await form.getByLabel('Referencia',{exact:true}).fill(reference);await form.getByLabel('Soporte',{exact:true}).fill('SYN-P04');
  await postClick(pc,'Pedir el plan','/payment-previews');await pc.getByRole('checkbox',{name:/Confirmo este plan/}).check();
  await postClick(pc,'Confirmar el registro','/payments');
  const row=await f.database.db.collection('payments').findOne({organizationId:f.org,'intent.receiptReference':reference});assert.equal(row.status,'PENDING');pending.push({_id:row._id,intent:JSON.stringify(row.intent)});
 }
 const direct=await f.preparePayment({kind:'REGISTER',mode:'DIRECT',effectiveDate:'2026-10-31',intent:await f.intent(loan2,bank.id,'50000.00',f.a)});await direct.execute();
 for(const [index,role]of ['P','T'].entries()){
  const page=await go(role,'pagos');await page.getByRole('button',{name:new RegExp(references[index])}).click();await page.getByLabel('Soporte de la acción',{exact:true}).fill('SYN-P04');
  await postClick(page,'Pedir el plan de aprobación','/payment-previews');await page.getByText(/versiones vigentes/).first().waitFor();await page.getByRole('checkbox',{name:/Confirmo este plan/}).check();
  await postClick(page,'Confirmar la aprobación','/approve');
  assert.equal(JSON.stringify((await f.database.db.collection('payments').findOne({_id:pending[index]._id})).intent),pending[index].intent);
 }
 assert.equal(value(await f.position(loan2.id)).principalOutstanding,'1810000.00');mark('H01-browser-two-pending-intermediate-current-plans-immutable-intents');
 // Exact bank declaration seeded through the domain API; review sequence and link through the UI create no journal.
 const approved=value(await f.readPayment(pending[1]._id)),account=await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,bank.id);
 await f.mutatePayment('createBankDeclaration',{accountId:bank.id,accountETag:account.etag,currency:'COP',direction:'INCOMING',amount:'100000.00',valueDate:approved.intent.observedDate,reference:references[1],source:'MANUAL_DECLARATION',declaredBankName:'Banco sintético',statementReference:'SYN-P04',lineReference:'1',supportReference:'SYN-P04'});
 await go('T','pagos');await t.getByRole('button',{name:new RegExp(references[1])}).click();await t.getByLabel('Soporte de la acción',{exact:true}).fill('SYN-P04');await t.getByLabel('Motivo de la acción',{exact:true}).fill('Revisión bancaria sintética');
 const ledgerBeforeReview=await f.runtime.finance.journals.countDocuments({organizationId:f.org});
 await postClick(t,'Marcar diferencia','/reconciliation-dispositions');assert.equal(await t.getByRole('button',{name:'Vincular uno a uno',exact:true}).count(),0);
 await postClick(t,'Pasar a revisión','/reconciliation-dispositions');assert.equal(await t.getByRole('button',{name:'Vincular uno a uno',exact:true}).count(),0);
 await postClick(t,'Volver a pendiente de conciliar','/reconciliation-dispositions');await t.getByLabel('Declaración para vincular').selectOption({index:1});await postClick(t,'Vincular uno a uno','/reconciliation-links');
 assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),ledgerBeforeReview);assert.equal(value(await f.readPayment(pending[1]._id)).reconciliationState,'RECONCILED');mark('H03-browser-discrepancy-investigation-pending-link-zero-new-journals');

 // Actual second tenant and foreign/private reference checks over HTTPS.
 const other=await f.tenant(await f.newActor());await contexts.C.request.get(origin+'/api/v1/organizations/'+other.org+'/cash-positions').then(r=>assert.ok([403,404].includes(r.status())));
 const outsider=await f.member('O'),foreignContext=await browser.newContext({ignoreHTTPSErrors:true});await foreignContext.addCookies(cookies(outsider));assert.equal((await foreignContext.request.get(origin+'/api/v1/organizations/'+f.org+'/cash-deliveries/'+next)).status(),404);
 assert.equal((await contexts.P.request.get(origin+'/api/v1/organizations/'+f.org+'/cash-positions')).status(),403);await foreignContext.close();mark('real-second-tenant-P-role-and-unrelated-O-denied');
 // Responsive, keyboard and two-tab logout/draft isolation. Native browser zoom unavailable in this headless surface.
 await collectionReady('C');await c.getByLabel('Nota',{exact:true}).fill('BORRADOR_PRIVADO_P04');await c.getByLabel('Nota',{exact:true}).focus();await c.keyboard.press('Tab');assert.notEqual(await c.evaluate(()=>document.activeElement?.tagName),'BODY');
 await c.screenshot({path:resolve(evidence,'S07-P04-desktop.png'),fullPage:true});await c.setViewportSize({width:360,height:800});assert.ok(await c.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await c.screenshot({path:resolve(evidence,'S07-P04-mobile.png'),fullPage:true});
 const second=await contexts.C.newPage();await second.clock.install({time:new Date(f.now())});await second.goto(origin+'/#/cobranza');await second.getByRole('heading',{name:'Cobranza y caja',exact:true}).waitFor();await c.getByRole('button',{name:'Abrir menú',exact:true}).click();await c.getByRole('button',{name:'Cerrar sesión',exact:true}).click();await second.waitForURL('**/#/ingresar**');
 assert.equal(await c.evaluate(()=>sessionStorage.getItem('caudelyx.s07.collections.draft')),null);assert.equal(await second.getByText('BORRADOR_PRIVADO_P04',{exact:true}).count(),0);mark('keyboard-360px-two-tabs-logout-private-draft-cleared');
 await saveEvidence({task:'S07-P04',result:'PASS',runId:group.runId,organization:f.org,steps,seconds:(Date.now()-started)/1000,nativeZoom:'NOT_AVAILABLE_IN_HEADLESS_CHROME; viewport360 is reflow only',independentReview:false});
}
}catch(error){console.log('P04_BROWSER_FAILURE',error?.stack??String(error));if(browser)for(const context of browser.contexts())for(const page of context.pages())console.log((await page.locator('body').innerText().catch(()=>'' )).slice(0,1800));await saveEvidence({task:'S07-P04',result:'FAIL',steps,error:String(error),seconds:(Date.now()-started)/1000});throw error;}
finally{await browser?.close();await group.dispose();}

