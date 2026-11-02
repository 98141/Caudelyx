import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';

import { createServer as probe } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page } from '@playwright/test';
import { AppError } from '../../src/shared/errors.js';
import { today } from '../../src/modules/obligations/calendar.js';
import {s13Profile,world} from './fixture.js';
import {nativeLoan} from './native-seed.js';
import {hash} from '../../src/modules/simulation/codec.js';
import {authority} from '../../src/modules/simulation/authority.js';
import type {Capture} from '../../src/modules/simulation/sources.js';
import type {Data} from '../../src/modules/simulation/models.js';
const {assertWritable,mkdirOwn:mkdir,writeOwn:writeFile}=await import(new URL('../../../scripts/s13-p04-guard.mjs',import.meta.url).href) as typeof import('../../scripts/s13-p04-guard.mjs');

const repoRoot = resolve(process.cwd(), '../..');
let releaseLate=()=>{};
const captureDir = join(repoRoot, 'Construccion/Sprints/S13/Evidencias/S13-P04-CAPTURES');
const receiptPath = join(repoRoot, 'Construccion/Sprints/S13/Evidencias/S13-P04-JOURNEY.json');
const clientRoot = resolve(process.cwd(), '../cliente');
const blocked = new Set([27017, 27181, 3001, 3002, 4001]);

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year!, (month ?? 1) - 1, (day ?? 1) + days)).toISOString().slice(0, 10);
}

async function reservePort(): Promise<number> {
  const server = probe().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = address && typeof address !== 'string' ? address.port : 0;
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  if (!port || blocked.has(port)) throw Error('Protected test port');
  return port;
}

function waitForVite(port: number, cert: Buffer): Promise<void> {
  const deadline = Date.now() + 40000;
  return new Promise((resolveReady, reject) => {
    const ping = () => {
      const req = httpsRequest({ hostname: 'localhost', port, path: '/', method: 'GET', ca: cert, servername: 'localhost' }, res => { res.resume(); resolveReady(); });
      req.on('error', () => { if (Date.now() > deadline) reject(Error('Vite did not listen')); else setTimeout(ping, 400); });
      req.end();
    };
    ping();
  });
}

async function shot(page: Page, name: string) {
  await assertWritable(join(captureDir,name));await page.screenshot({path:join(captureDir,name),fullPage:true});
  return name;
}

async function fillFractions(page: Page) {
  for (const [kind, collection] of [['Prudente', '0.5'], ['Base', '0.8'], ['Favorable', '1']] as const) {
    await page.getByLabel(`Fracción de recaudo, ${kind}`).fill(collection);
    await page.getByLabel(`Días de retraso, ${kind}`).fill('0');
    await page.getByLabel(`Fracción de recuperación, ${kind}`).fill('0');
    await page.getByLabel(`Días de espera de la recuperación, ${kind}`).fill('0');
    await page.getByLabel(`Proyección de interés, ${kind}`).selectOption('DECLARED_SCHEDULE_ONLY');
  }
}

test('S13-P04 shows the linked purchase and a real deficit on its own API group', { timeout: 480000 }, async () => {
  const totalStarted = performance.now();
  const bogota = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const purchaseDate = addDays(bogota, 1);
  const outDate = addDays(bogota, 16);
  const inDate = addDays(bogota, 28);
  const receipt: Record<string, unknown> = { task: 'S13-P04', startedAt: new Date().toISOString(), asOf: bogota, purchaseDate, outDate, inDate, captures: [], financialPosts: [], negatives: {}, limits: [], zoom: {} };
  const group = await s13Profile();receipt['runId']=group.runId;
  let browser: Browser | undefined;
  let vite: ChildProcess | undefined;
  let page: Page | undefined;
  let viteLog = '';
  const financial: string[] = [];
  try {
    const f=await world(group,Date.now());
    const capital={currency:'COP',effectiveDate:bogota,sourceId:randomUUID(),supportReference:'SYN-P04-CAPITAL',description:'Capital sintético P04',lines:[{accountId:f.bank.id,debit:'60000000.00',credit:'0.00'},{accountId:f.equity.id,debit:'0.00',credit:'60000000.00'}]},key=randomUUID();await f.proof(f.a,'FINANCE_JOURNAL_POST',{organizationId:f.org,idempotencyKey:key,payload:capital});await f.runtime.finance.mutate(f.a.issued.context,'postJournal',f.org,capital,key);await f.restore.flush();
    const economicNames=['financial_accounts','financial_journals','loan_positions','loan_installments','loan_events','loan_schedule_versions','payments','s09_liabilities_business','s09_expenses_business','s10_assets_business','s10_funds_business'];const economic=async()=>JSON.stringify(await Promise.all(economicNames.map(async n=>[n,hash(await f.database.db.collection(n).find({}).sort({_id:1}).toArray())])));let before=await economic();const bootBefore=before;let fenceReference:number;const bootFence=await f.database.db.collection('transaction_fence').find({}).sort({_id:1}).toArray(),issue=f.sessions.issue.bind(f.sessions);fenceReference=Number(bootFence[0]!['value']);const nativeTransaction=f.database.transaction.bind(f.database),transactions:string[]=[],pendingTransactions=new Set<Promise<unknown>>();const trackingTransaction:typeof f.database.transaction=async work=>{const caller=(new Error().stack??'').split('\n').filter(s=>!s.includes('browser.test.js')).slice(1,4).join(' ');const pending=nativeTransaction(work);pendingTransactions.add(pending);try{const r=await pending;transactions.push(caller);return r;}finally{pendingTransactions.delete(pending);}};f.database.transaction=trackingTransaction;const fenceCheck=async(label:string,exchange=false)=>{while(pendingTransactions.size)await Promise.all([...pendingTransactions]);const rows=await f.database.db.collection('transaction_fence').find({}).toArray();assert.equal(rows.length,1);assert.deepEqual(Object.keys(rows[0]!).sort(),['_id','value']);assert.equal(rows[0]!['_id'],'security');assert.equal(rows[0]!['value'],fenceReference+transactions.length);assert.ok(transactions.every(s=>s.includes('/shared/runtime.js')||s.includes('/modules/sessions/work-http.js')||s.includes('/organizations/service.js')||exchange&&s.includes('/exchange/service.js')),JSON.stringify(transactions));const records=(receipt['fenceChecks']??=[]) as unknown[];records.push({label,base:fenceReference,actual:rows[0]!['value'],nativeCommittedTransactions:transactions.length,callers:[...transactions],allowed:exchange?'current-authority/A07, work activity, organization read, report/export/download technical transaction':'current-authority/A07, work activity, organization read',economicCollectionsUnchanged:true});};let anonymousIssued=0;f.sessions.issue=async(...args)=>{const r=await issue(...args);if(args[1]==='P'&&args[2]===null)anonymousIssued++;return r;};
    assert.equal(today(f.now()), bogota);
    const uiPort = await reservePort();
    const api = await f.https(f.identity,'https://localhost:'+uiPort);
    if (api.port === uiPort || blocked.has(api.port)) throw Error('Protected API port');
    vite = spawn('node', [join(clientRoot, 'node_modules/vite/bin/vite.js'), '--config',join(repoRoot,'Construccion/Sprints/S13/Evidencias/S13-P04-vite.config.mts'),'--configLoader','native','--host','localhost','--strictPort'], {
      cwd: clientRoot,
      env: { ...process.env, CAUDELYX_DEV_UI_PORT: String(uiPort), CAUDELYX_DEV_API_PORT: String(api.port), CAUDELYX_DEV_TLS_DIRECTORY:group.folder,CAUDELYX_P04_CACHE:join(group.folder,'vite-cache') },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    vite.stdout?.on('data', chunk => { viteLog = (viteLog + String(chunk)).slice(-2000); });
    vite.stderr?.on('data', chunk => { viteLog = (viteLog + String(chunk)).slice(-2000); });
    const viteStarted = performance.now();
    await waitForVite(uiPort, api.cert);
    receipt['viteMs'] = Math.round(performance.now() - viteStarted);
    receipt['ports'] = { ui: uiPort, api: api.port };
    await mkdir(captureDir);
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ name: '__Host-caudelyx-session', value: f.a.issued.token, url: 'https://localhost:' + uiPort + '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
    page = await context.newPage();
    page.on('pageerror', error => { receipt['pageError'] = String(error).slice(0, 300); });
    page.on('request', request => {
      if (request.method() === 'GET' || request.method() === 'HEAD' || request.method() === 'OPTIONS') return;
      const path = new URL(request.url()).pathname;
      if(path.includes('/simulation-s12/')||path.startsWith('/api/v1/auth/')||/\/exchange-s11\/exports(?:\/|$)/.test(path))return;
      financial.push(request.method() + ' ' + path);
    });
    await page.goto('https://localhost:' + uiPort + '/#/simulacion', { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Simulación' }).waitFor({ timeout: 20000 });
    await page.getByText(/Uso real permitido: no/).waitFor();
    await page.getByText(/no habilita piloto externo/i).waitFor();
    assert.equal(await page.getByRole('button', { name: /aplicar|desplegar/i }).count(), 0);
    await page.setViewportSize({ width: 360, height: 800 });
    const captures = [await shot(page, '01-ambito-360.png')];
    await page.setViewportSize({ width: 390, height: 844 });
    captures.push(await shot(page, '02-ambito-390.png'));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.keyboard.press('Tab');
    receipt['keyboardFocus'] = await page.evaluate(() => document.activeElement?.tagName ?? 'none');
    const profile=join(group.folder,'chrome-zoom');await mkdir(join(profile,'Default'));await writeFile(join(profile,'Default/Preferences'),JSON.stringify({partition:{default_zoom_level:{x:Math.log(2)/Math.log(1.2)}}}));
    const zoomContext=await chromium.launchPersistentContext(profile,{headless:true,channel:'chrome',ignoreHTTPSErrors:true,viewport:null,args:['--window-size=1280,900']});
    try{await zoomContext.addCookies([{name:'__Host-caudelyx-session',value:f.a.issued.token,url:'https://localhost:'+uiPort+'/',secure:true,httpOnly:true,sameSite:'Lax'}]);const zp=zoomContext.pages()[0]!;await zp.goto('https://localhost:'+uiPort+'/#/simulacion');await zp.getByRole('heading',{name:'Simulación'}).waitFor();await zp.getByRole('button',{name:'Capturar base'}).waitFor();
     const plainProfile=join(group.folder,'chrome-plain');await mkdir(plainProfile);const plainContext=await chromium.launchPersistentContext(plainProfile,{headless:true,channel:'chrome',ignoreHTTPSErrors:true,viewport:null,args:['--window-size=1280,900']});let plain;try{const pp=plainContext.pages()[0]!;await pp.goto('https://localhost:'+uiPort);await pp.getByRole('button',{name:'Iniciar sesión'}).waitFor();plain=await pp.evaluate(()=>({dpr:devicePixelRatio,width:innerWidth,outer:outerWidth}));}finally{await plainContext.close();}const zoomed=await zp.evaluate(()=>({dpr:devicePixelRatio,width:innerWidth,outer:outerWidth,scroll:document.documentElement.scrollWidth,scale:visualViewport?.scale}));assert.ok(zoomed.dpr/plain.dpr>=1.9);assert.equal(zoomed.outer,plain.outer);assert.ok(zoomed.width<=plain.width*0.55);assert.equal(zoomed.scale,1);assert.ok(zoomed.scroll<=zoomed.width+1);const layout=await zp.locator('main').evaluate(e=>({client:e.clientWidth,scroll:e.scrollWidth}));assert.ok(layout.scroll<=layout.client+1);receipt['zoomMain']=layout;receipt['zoomLayout']=await zp.evaluate(()=>[...document.querySelectorAll('main,main>*,.simulation-surface,.simulation-surface>*,.panel')].map(e=>({tag:e.tagName,cls:e.className,w:e.clientWidth,scroll:e.scrollWidth,min:getComputedStyle(e).minWidth,display:getComputedStyle(e).display})));receipt['zoom']={method:'Native Chromium profile page zoom log(2)/log(1.2); same1280x900, no CDP scale or DPR emulation',plain,zoomed};await shot(zp,'02b-native-zoom200.png');const cdp=await zoomContext.newCDPSession(zp),capture=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true});await writeFile(join(captureDir,'02c-native-zoom200-viewport.png'),Buffer.from(capture.data,'base64'));await cdp.detach();}finally{await zoomContext.close();}
    const sameSession = await context.newPage();
    await sameSession.goto('https://localhost:' + uiPort + '/#/simulacion', { waitUntil: 'domcontentloaded' });
    await sameSession.getByRole('heading', { name: 'Simulación' }).waitFor({ timeout: 20000 });
    const stranger = await browser.newContext({ ignoreHTTPSErrors: true });
    const otherPage = await stranger.newPage();
    await otherPage.goto('https://localhost:' + uiPort + '/#/simulacion', { waitUntil: 'domcontentloaded' });
    await otherPage.getByRole('button', { name: 'Iniciar sesión' }).waitFor({ timeout: 15000 });
    assert.equal(await otherPage.getByRole('button', { name: 'Capturar base' }).count(), 0);
    await stranger.close();
    receipt['secondContext'] = 'login-without-cookie';
    receipt['secondTab'] = 'same-context-page-opened';
    await page.waitForLoadState('networkidle');await sameSession.waitForLoadState('networkidle');while(pendingTransactions.size)await Promise.all([...pendingTransactions]);receipt['bootstrapTransactions']=[...transactions];const afterBoot=await economic(),fenceAfter=await f.database.db.collection('transaction_fence').find({}).sort({_id:1}).toArray();const withoutFence=(text:string)=>(JSON.parse(text) as [string,string][]).filter(([n])=>n!=='transaction_fence');assert.deepEqual(withoutFence(afterBoot),withoutFence(bootBefore));assert.equal(bootFence.length,1);assert.equal(fenceAfter.length,1);assert.deepEqual(Object.keys(fenceAfter[0]!).sort(),['_id','value']);assert.equal(fenceAfter[0]!['_id'],'security');assert.equal(fenceAfter[0]!['value'],Number(bootFence[0]!['value'])+transactions.length);receipt['bootstrapFence']={before:bootFence[0]!['value'],after:fenceAfter[0]!['value'],anonymousContextsIssued:anonymousIssued,nativeReadTransactions:transactions.length,scope:'Before simulation boundary: Native current-authority/bootstrap read transactions are counted by the actual Database.transaction wrapper; callers recorded separately. Anonymous P insertion does not increment fence. All economic collections unchanged. Fence remains compared within simulation.'};f.sessions.issue=issue;await fenceCheck('bootstrap');before=afterBoot;
    const [firstBaseResponse]=await Promise.all([page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/bases')&&r.status()===201),page.getByRole('button',{name:'Capturar base'}).click()]);const firstBaseDTO=await firstBaseResponse.json() as {data:{id:string}};
    await page.getByText(/Base capturada el/).waitFor({ timeout: 20000 });
    await page.getByLabel('Nombre de la hipótesis').fill('Compra vinculada sintetica');
    await page.getByLabel('Horizonte en días').fill('30');
    await page.getByLabel('Presupuesto declarado').fill('80000000.00');
    await fillFractions(page);
    await page.getByRole('checkbox', { name: 'Configurar Compra de activo' }).check();
    await page.getByLabel('Fecha, Compra de activo').fill(purchaseDate);
    await page.getByLabel('Costo bruto de compra').fill('200000000.00');
    await page.getByLabel('Caja propia para la compra').fill('80000000.00');
    await page.getByLabel('Deuda propia para la compra').fill('120000000.00');
    await page.getByLabel('Fracción de propiedad').fill('1');
    await page.getByLabel('Fracción de vacancia').fill('0');
    await page.getByLabel('Valor bruto estimado').fill('220000000.00');
    await page.getByRole('checkbox', { name: /Acreedor paga directamente/ }).uncheck();
    let firstCreateKey='',firstCreateBody='',dropped=false,retried=false,retryKey='',retryBody='';
    await page.route('**/simulation-s12/scenarios',async route=>{const request=route.request();if(request.method()!=='POST'){await route.continue();return;}if(!dropped){dropped=true;firstCreateKey=request.headers()['idempotency-key']!;firstCreateBody=request.postData()!;const response=await route.fetch();assert.equal(response.status(),201);receipt['lostResponseCommitted']=true;await route.abort('connectionreset');}else{retryKey=request.headers()['idempotency-key']!;retryBody=request.postData()!;retried=true;await route.continue();}});
    await page.getByRole('button',{name:'Calcular hipótesis',exact:true}).focus();await page.keyboard.press('Enter');await page.getByRole('alert').waitFor();receipt['lostResponseNotice']=await page.getByRole('alert').innerText();assert.doesNotMatch(String(receipt['lostResponseNotice']),/No se guardó nada/);await page.getByRole('button',{name:'Calcular hipótesis',exact:true}).click();

    await page.getByRole('heading', { name: 'Corrida versión 1' }).waitFor({ timeout: 60000 });
    await page.unroute('**/simulation-s12/scenarios');assert.equal(retried,true);assert.equal(retryKey,firstCreateKey);assert.equal(retryBody,firstCreateBody);assert.equal(await f.database.db.collection('s12_scenarios').countDocuments({name:'Compra vinculada sintetica'}),1);receipt['retry']={sameKey:true,sameBody:true,oneScenario:true,lostAfterNativeCommit:true};
    const purchase = page.getByRole('listitem').filter({ hasText: 'Base, Compra de activo' }).first();
    await purchase.waitFor({ timeout: 20000 });
    await purchase.getByText(/no se sustituye por cero/).waitFor();
    assert.equal(await purchase.getByText(/Primer déficit de la hipótesis:/).count(), 0);
    await page.getByLabel('Resultado que se lee en la lista').selectOption({ label: 'Base / Compra de activo' });
    await page.getByRole('row', { name: /Deuda/ }).getByText('120000000.00').waitFor();
    await page.getByRole('row', { name: /Caja mínima de la hipótesis/ }).getByText('0.00').waitFor();
    await page.getByRole('row', { name: /Déficit máximo de la hipótesis/ }).getByText('0.00').waitFor();
    await page.getByRole('row', { name: /Patrimonio de libro/ }).getByText('80000000.00').waitFor();
    await page.getByRole('row', { name: /Valor indicativo/ }).getByText('100000000.00').waitFor();
    await page.getByRole('listitem').filter({ hasText: 'No simulable' }).first().waitFor();
    // eslint-disable-next-line security/detect-object-injection -- Five fixed oracle metric names; never an HTTP-derived key.
    const firstRuns=await f.runtime.simulation.execute(f.a.issued.context,'listRunsBusinessSimulation',{}, {organizationId:f.org},{},randomUUID()),firstRun=(firstRuns.data['items'] as Data[]).find(r=>r['baseId']===firstBaseDTO.data.id&&r['scenarioVersion']===1&&r['state']==='SUCCEEDED');assert.ok(firstRun);const firstResults=await f.runtime.simulation.execute(f.a.issued.context,'getResultsBusinessSimulation',{}, {organizationId:f.org,runId:String(firstRun['id'])},{limit:'100'},randomUUID()),linked=(firstResults.data['outcomes'] as Data[]).find(o=>o['scenarioKind']==='BASE'&&o['alternativeKind']==='ASSET_PURCHASE')!,metrics=linked['metrics'] as Record<string,{value:string|null}>;for(const [key,value]of [['cashMinimum','0.00'],['peakDeficit','0.00'],['ownDebt','120000000.00'],['netWorthBook','80000000.00'],['netWorthIndicative','100000000.00']] as const)assert.equal(metrics[key]!.value,value);receipt['H01API']={run:firstRun['id'],outcome:linked,oracle:'80M+120M purchase200M/estimate220M => minimum0/peak0/debt120M/netWorth80M/indicative100M'};
    captures.push(await shot(page,'03-compra.png'));
    assert.equal(await sameSession.getByText('120000000.00').count(), 0);
    f.clock.value += 61000;
    await page.getByLabel('Fecha de salida declarada, Base').fill(outDate);
    await page.getByLabel('Importe de salida declarada, Base').fill('80000001.00');
    await page.getByLabel('Fecha de entrada declarada, Base').fill(inDate);
    await page.getByLabel('Importe de entrada declarada, Base').fill('30000000.00');
    await page.getByLabel('Referencia de la hipótesis, Base').fill('SIN-SOPORTE-OFICIAL');
    await page.getByRole('button', { name: 'Crear otra versión' }).click();
    await page.getByRole('listitem').filter({ hasText: `Primer déficit de la hipótesis: ${outDate}` }).first().waitFor({ timeout: 60000 });
    captures.push(await shot(page, '04-deficit.png'));
    await fenceCheck('H01 and ordinary flow');console.log('P04 browser H01/ordinary economic check');receipt['H01EconomicAfter']=await economic();receipt['H01EconomicBefore']=before;assert.equal(await economic(),before,'H01 and ordinary declared flow did not mutate native financial state');
    const service=f.runtime.simulation,ps={organizationId:f.org},list=await service.execute(f.a.issued.context,'listRunsBusinessSimulation',{},ps,{},randomUUID()),ordinaryRun=(list.data['items'] as Data[]).find(r=>r['baseId']===firstBaseDTO.data.id&&r['scenarioVersion']===2&&r['state']==='SUCCEEDED');assert.ok(ordinaryRun);const runId=String(ordinaryRun['id']);
    const apiResult=await service.execute(f.a.issued.context,'getResultsBusinessSimulation',{}, {...ps,runId},{limit:'100'},randomUUID());const ordinaryOutcome=(apiResult.data['outcomes'] as Data[]).find(o=>o['scenarioKind']==='BASE'&&o['alternativeKind']==='HOLD_CASH')!,ordinaryMetrics=ordinaryOutcome['metrics'] as Record<string,{value:string|null}>;assert.equal(ordinaryOutcome['firstDeficitDate'],outDate);assert.equal(ordinaryMetrics['availableMinimum']!.value,'-1.00');assert.equal(ordinaryMetrics['cashFinal']!.value,'29999999.00');await page.getByRole('row',{name:/Caja mínima de la hipótesis/}).getByText('-1.00',{exact:true}).waitFor();receipt['ordinaryAPI']=apiResult.data;
    console.log('P04 browser native seed');f.database.transaction=nativeTransaction;const native=await nativeLoan(f);transactions.splice(0);fenceReference=Number((await f.database.db.collection('transaction_fence').findOne({_id:'security' as never}))!['value']);f.database.transaction=trackingTransaction;before=await economic();f.clock.value+=61000;
    const [nativeBaseResponse]=await Promise.all([page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/bases')&&r.status()===201),page.getByRole('button',{name:'Capturar base'}).click()]);const nativeBaseDTO=await nativeBaseResponse.json() as {data:{id:string}};const sourceFlow=await f.database.client.withSession(async s=>{const a=await authority(f.identity,f.a.issued.context,ps,s),r=await service.store.get('s12_bases',nativeBaseDTO.data.id,a,s),c=await service.store.unchunks<Capture>(a,r._id,r['chunks'] as {ids:string[];digest:string},s);return c.base.books.flatMap(b=>b.flows).find(v=>v.entityId===native.loanId&&v.classification==='PRINCIPAL');});assert.ok(sourceFlow);assert.equal(sourceFlow.amount,'500.00');await page.getByText(/La base cambió/).waitFor();
    await page.getByLabel('Nombre de la hipótesis').fill('H02 fuente nativa');await page.getByLabel('Presupuesto declarado').fill('500.00');
    await page.getByRole('checkbox',{name:'Configurar Compra de activo'}).uncheck();await page.getByRole('checkbox',{name:'Configurar Préstamo nuevo'}).check();
    await page.getByLabel('Fracción de recaudo, Base').fill('1');await page.getByLabel('Fecha de salida declarada, Base').fill('');await page.getByLabel('Importe de salida declarada, Base').fill('');await page.getByLabel('Fecha de entrada declarada, Base').fill('');await page.getByLabel('Importe de entrada declarada, Base').fill('');await page.getByLabel('Referencia de la hipótesis, Base').fill('');
    await page.getByLabel('Fecha, Préstamo nuevo',{exact:true}).fill(addDays(bogota,8));await page.getByLabel('Principal del nuevo préstamo').fill('500.00');await page.getByLabel('Fuente de recaudo para reinversión').fill(sourceFlow.id);
    await page.getByLabel('Declaración del calendario, Préstamo nuevo').fill('Hipótesis sintética explícita P04');await page.getByLabel('Principal de apertura del calendario, Préstamo nuevo').fill('500.00');await page.getByLabel('Vencimiento cuota 1, Préstamo nuevo').fill(addDays(bogota,20));
    for(const [label,value]of [['Principal','500.00'],['Interés','0.00'],['Seguro','0.00'],['Comisiones','0.00'],['Total declarado','500.00']] as const)await page.getByLabel(label+' cuota 1, Préstamo nuevo',{exact:true}).fill(value);
    await page.getByRole('button',{name:/Calcular hipótesis|Crear otra versión/}).click();const prudent=page.getByRole('listitem').filter({hasText:'Prudente, Préstamo nuevo'}).last();await prudent.getByText(/INSUFFICIENT_SOURCE/).waitFor({timeout:60000});assert.match(await prudent.innerText(),/No es un déficit de cero/);
    for(const kind of ['Base','Favorable'])assert.match(await page.getByRole('listitem').filter({hasText:kind+', Préstamo nuevo'}).last().innerText(),/Simulable/);
    const runs=await service.execute(f.a.issued.context,'listRunsBusinessSimulation',{},ps,{},randomUUID()),h02run=(runs.data['items'] as Data[]).find(r=>r['baseId']===nativeBaseDTO.data.id&&r['state']==='SUCCEEDED');assert.ok(h02run);const h02id=String(h02run['id']),results=await service.execute(f.a.issued.context,'getResultsBusinessSimulation',{}, {...ps,runId:h02id},{limit:'100'},randomUUID()),outcomes=results.data['outcomes'] as Data[];
    const po=outcomes.find(o=>o['scenarioKind']==='PRUDENT'&&o['alternativeKind']==='NEW_LOAN')!;assert.equal(po['simulability'],'NOT_SIMULABLE');assert.deepEqual(po['reasons'],['INSUFFICIENT_SOURCE']);assert.equal((po['metrics'] as Record<string,{value:string|null}>)['availableFinal']!.value,null);for(const kind of ['BASE','FAVORABLE'])assert.equal(outcomes.find(o=>o['scenarioKind']===kind&&o['alternativeKind']==='NEW_LOAN')!['simulability'],'SIMULABLE');
    await fenceCheck('H02 native simulation');receipt['h02Live']={nativeLoan:native.loanId,source:sourceFlow.id,sourceOrigin:'Actual UUID resolved by operator from signed own captured base; not an invented key nor public discovery endpoint',run:h02id,outcomes};assert.equal(await economic(),before);captures.push(await shot(page,'05-h02-native.png'));
    await page.goto('https://localhost:'+uiPort+'/#/simulacion');await page.getByRole('button',{name:'Capturar base'}).waitFor();
    let heldReady=()=>{},doneLate=()=>{};const heldRequest=new Promise<void>(r=>{heldReady=r;}),lateDelivered=new Promise<void>(r=>{doneLate=r;}),releaseResponse=new Promise<void>(r=>{releaseLate=r;});
    await page.route('**/simulation-s12/bases',async route=>{const response=await route.fetch();assert.equal(response.status(),201);heldReady();await releaseResponse;await route.fulfill({response});doneLate();});
    await page.getByRole('button',{name:'Capturar base'}).click();await heldRequest;
    await Promise.all([page.waitForResponse(r=>r.url().includes('/me/personal/books/')&&r.url().endsWith('/policy')&&r.status()===200),page.getByRole('radio',{name:'Personal del titular',exact:true}).check()]);releaseLate();await lateDelivered;await page.locator('main').evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));assert.equal(await page.getByText(/Base capturada el/).count(),0);assert.equal(await page.getByRole('radio',{name:'Personal del titular',exact:true}).isChecked(),true);await page.unroute('**/simulation-s12/bases');receipt['lateResponse']={nativeResponse201:true,switchedTo:'PERSONAL',oldBusinessBaseVisible:false};await fenceCheck('late response discarded on scope switch');assert.equal(await economic(),before);
    await page.goto('https://localhost:'+uiPort+'/#/intercambio');await page.getByRole('heading',{name:'Reportes y descargas'}).waitFor();await page.getByLabel('Reporte',{exact:true}).selectOption('PORTFOLIO');for(const label of ['Corte','Desde','Hasta'])await page.getByLabel(label,{exact:true}).fill(bogota);await page.getByRole('button',{name:'Consultar corte'}).click();await page.getByLabel('Formato',{exact:true}).waitFor();await page.getByLabel('Formato',{exact:true}).selectOption('CSV');const reportPage=page;const prepareFile=async()=>await Promise.all([reportPage.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/exports')),reportPage.getByRole('button',{name:'Preparar archivo'}).click()]);let [exportResponse]=await prepareFile();if(exportResponse!.status()===409){const first=await exportResponse!.json() as {error:{code:string}};assert.equal(first.error.code,'REPORT_SNAPSHOT_EXPIRED');receipt['firstExportInitialization']={status409:true,explicitRecapture:true,noFileFromOldCut:true};await page.getByRole('alert').waitFor();await Promise.all([page.waitForResponse(r=>r.request().method()==='GET'&&new URL(r.url()).pathname.endsWith('/rows')&&r.status()===200),page.getByRole('button',{name:'Consultar corte'}).click()]);[exportResponse]=await prepareFile();}assert.equal(exportResponse!.status(),202);const exportPayload=await exportResponse!.json() as {data:{id:string;file?:{filename:string}}},exportId=exportPayload.data.id;await page.getByRole('button',{name:'Descargar',exact:true}).waitFor();
    const dlButton=page.getByRole('button',{name:'Descargar',exact:true});for(let i=0;i<30&&await dlButton.isDisabled();i++){await page.getByRole('button',{name:'Consultar archivo',exact:true}).click();await page.waitForTimeout(100);}
    const [download]=await Promise.all([page.waitForEvent('download'),dlButton.click()]);const downloadPath=join(captureDir,'portfolio.csv');await assertWritable(downloadPath);await download.saveAs(downloadPath);receipt['download']={filename:download.suggestedFilename(),browserFailure:await download.failure(),format:'CSV',currentPermissions:true};assert.equal(await download.failure(),null);await page.getByRole('button',{name:'Consultar archivo',exact:true}).click();assert.equal(await economic(),before);f.clock.open=false;try{await page.getByRole('button',{name:'Consultar archivo',exact:true}).click();await page.getByRole('alert').filter({hasText:/El acceso está temporalmente no disponible/}).waitFor();receipt['degraded']={method:'Own fixture admission flag closed; native HTTP503, no mocked response or cryptographic repair',noAutomaticWrite:true};captures.push(await shot(page,'07-degraded.png'));}finally{f.clock.open=true;}await page.getByRole('button',{name:'Consultar archivo',exact:true}).click();await fenceCheck('report export/download, degraded admission and current read recovery',true);assert.equal(await economic(),before);captures.push(await shot(page,'06-export-download.png'));f.database.transaction=nativeTransaction;
    const collaborator = await f.actor();
    const invite = { email: collaborator.email, roleIds: ['C'] };
    await f.proof(f.a, 'MEMBER_INVITE', invite, f.org);
    await f.runtime.organizations.invite(f.a.issued.context, invite);
    await f.identity.dispatchMail();
    const mail = [...f.messages.notificationInbox.values()].find(item => item.kind === 'INVITATION' && item.payload['email'] === collaborator.email);
    assert.ok(mail);
    await f.runtime.organizations.accept(collaborator.issued.context, { mode: 'CONFIRM', token: String(mail.payload['token']) }, randomUUID());
    await assert.rejects(() => f.runtime.simulation.execute(collaborator.issued.context, 'captureBaseBusinessSimulation', { asOf: bogota, currency: 'COP' }, { organizationId: f.org }, {}, randomUUID()), (error: unknown) => error instanceof AppError && (error.status === 403 || error.status === 404));
    (receipt['negatives'] as Record<string,string>)['collaborator']='denied';
    const foreignHeaders={Host:'localhost:'+uiPort,Origin:'https://localhost:'+uiPort,Cookie:'__Host-caudelyx-session='+collaborator.issued.token},exportPath='/api/v1/organizations/'+f.org+'/exchange-s11/exports/'+exportId,foreignExport=await api.client.call('GET',exportPath,undefined,foreignHeaders);assert.ok([403,404].includes(foreignExport.status));assert.equal(JSON.stringify(foreignExport.body).includes(exportId),false);receipt['foreignExport']={status:foreignExport.status,privateIdAbsent:true,currentActor:'real invited C'};

    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await sameSession.getByRole('button', { name: 'Iniciar sesión' }).waitFor({ timeout: 15000 });
    assert.equal(await sameSession.getByText('120000000.00').count(), 0);
    receipt['secondTab'] = 'logout-cleared-the-other-page';
    receipt['financialPosts'] = financial;
    assert.deepEqual(financial, []);
    receipt['captures'] = captures;

    receipt['limits'] = ['Native browser page zoom verified; no OS zoom claim.', 'Viewports 360 and 390 are layout checks.', 'A context without the cookie is not a second tab.', 'The owner did not run a manual task.', 'MEJ manual remains without a report.'];
    receipt['status'] = 'passed';
    receipt['totalMs'] = Math.round(performance.now() - totalStarted);
  } catch (error) {
    receipt['status'] = 'failed';
    receipt['error'] = String(error).slice(0, 800);
    if(page)receipt['screenTextOnError']=(await page.locator('body').innerText()).slice(-14000);
    if (page) await shot(page, 'fallo.png').catch(() => undefined);
    throw error;
  } finally {
    releaseLate();
    receipt['viteLog'] = viteLog.slice(-800);
    if (browser) await browser.close().catch(() => undefined);
    if (vite && vite.exitCode === null) {
      vite.kill();
      await once(vite, 'exit').catch(() => undefined);
    }
    await group.dispose();
    receipt['finishedAt'] = new Date().toISOString();

    await writeFile(receiptPath,JSON.stringify(receipt,null,2));await writeFile(join(repoRoot,'Construccion/Sprints/S13/Evidencias/S13-P04-JOURNEY-'+group.runId+'.json'),JSON.stringify(receipt,null,2));
  }
});
