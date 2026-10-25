import { test, expect, type Page } from '@playwright/test';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PASSWORD, openActivation } from '../e2e/fixtures';

const server=resolve(import.meta.dirname,'../../../servidor');
const workspace=resolve(server,'../..');
const evidence=resolve(workspace,'Construccion/Sprints/S03/Evidencias');
const environment={...process.env,CAUDELYX_MODE:'local-synthetic',CAUDELYX_DEV_TEST_ID:process.env.CAUDELYX_TEST_RUN_ID!,
  CAUDELYX_DEV_UI_PORT:'5351',CAUDELYX_DEV_API_PORT:'5451',CAUDELYX_DEV_PLATFORM_PORT:'5352'};
let profile:{directory:string;dispose():Promise<void>};
let runner:ChildProcess|undefined;
async function start(){
  runner=spawn(process.execPath,['scripts/dev.mjs'],{cwd:resolve(server,'..'),env:environment,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  // Do not log requests, mailbox output or activation URLs. Startup output is retained in memory only.
  runner.stdout?.resume();runner.stderr?.resume();
  await new Promise<void>((accept,reject)=>{
    const timer=setTimeout(()=>reject(Error('Owned stack readiness timeout')),30000);
    runner!.on('message',message=>{if(message==='S02_INSTALLED_READY'){clearTimeout(timer);accept();}});
    runner!.once('exit',code=>{clearTimeout(timer);reject(Error('Owned stack exited '+code));});
    runner!.once('error',reject);
  });
}
async function stop(){
  if(!runner||runner.exitCode!==null)return;
  const child=runner,ended=once(child,'exit');child.send('LOCAL_DEV_STOP');
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([ended,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned stack shutdown timeout')),20000);})]);}
  finally{clearTimeout(timer);}runner=undefined;
}
async function fingerprints(){
  const descriptor=JSON.parse(await readFile(resolve(profile.directory,'descriptor.json'),'utf8')) as {keyringFile:string;databaseName:string};
  const files=[descriptor.keyringFile,resolve(profile.directory,'tls/key.pem'),resolve(profile.directory,'tls/cert.pem'),resolve(profile.directory,`gate-${descriptor.databaseName}.json`),resolve(profile.directory,`gate-${descriptor.databaseName}.json.journal.jsonl`)];
  const result:Record<string,string>={};
  for(const file of files)result[file]=createHash('sha256').update(await readFile(file)).digest('hex');return result;
}
test.beforeAll(async()=>{
  const module=await import(pathToFileURL(resolve(server,'dist/tests/helpers/local-test-profile.js')).href) as {localTestProfile():Promise<typeof profile>};
  profile=await module.localTestProfile();
  try{await start();}catch(error){try{await stop();}finally{await profile.dispose();}throw error;}
});
test.afterAll(async()=>{try{await stop();}finally{if(profile)await profile.dispose();}});

async function confirm(page:Page,button:string,suffix:string,method='POST',expected=[200,201]){
  const form=page.locator('form').filter({has:page.getByRole('button',{name:button,exact:true})});
  await form.getByLabel('Contraseña actual').fill(PASSWORD);
  const response=page.waitForResponse(r=>r.url().endsWith(suffix)&&r.request().method()===method);
  await form.getByRole('button',{name:button,exact:true}).click();
  const reply=await response;expect(expected).toContain(reply.status());
  await expect(page.getByRole('button',{name:'Enviando…',exact:true})).toHaveCount(0);return reply;
}
test('S03 P04 real wizard, accounting, pagination, stale approval and persistence',async({page})=>{
  page.setDefaultTimeout(12000);
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  const email=`p04_${Date.now()}@example.test`;
  await page.goto('/#/registro');
  await page.getByLabel('Correo').fill(email);await page.getByLabel('Nombre visible').fill('Integración sintética');
  await page.getByLabel('Contraseña').fill(PASSWORD);await page.getByRole('checkbox').check();
  await page.getByRole('button',{name:'Crear cuenta'}).click();
  await expect(page.getByRole('heading',{name:'Mi cuenta',exact:true})).toBeVisible();
  // Real CLI reads/decrypts the own synthetic inbox; output is memory-only and never an artifact.
  let token='';
  for(let n=0;n<20&&!token;n++){
    const {stdout}=await promisify(execFile)(process.execPath,['scripts/mailbox-installed.mjs','--email',email],{cwd:server,env:environment,windowsHide:true});
    const parsed=JSON.parse(stdout) as {messages:{purpose:string;code:string}[]};
    token=parsed.messages.find(m=>m.purpose==='ACTIVATION')?.code??'';
    if(!token)await new Promise(r=>setTimeout(r,250));
  }
  if(!token)throw Error('Synthetic CLI message unavailable');
  await openActivation(page,'ACTIVATION',token);token='';
  await page.getByRole('button',{name:'Activar cuenta',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Proteger mi cuenta'})).toBeVisible();
  await page.getByRole('combobox',{name:/Tipo/}).selectOption('WEBAUTHN');
  const enrolled=page.waitForResponse(r=>r.url().endsWith('/auth/mfa/webauthn/registration/verify'));
  await page.getByRole('button',{name:'Preparar factor'}).click();expect((await enrolled).status()).toBe(201);
  await page.goto('/#/organizacion');await page.getByLabel('Nombre').fill('Libro sintético P04');
  const orgReply=await confirm(page,'Crear organización','/organizations');
  const org=(await orgReply.json()).data.organization.id as string;
  await expect(page.getByRole('heading',{name:'Libro sintético P04'})).toBeVisible();
  await page.getByRole('link',{name:'Abrir el libro de cuentas'}).click();
  await expect(page.getByRole('button',{name:'Crear cuenta contable'})).toBeVisible();
  await expect(page.getByText('Cargando cuentas y asientos…')).toBeHidden();
  const ids:Record<string,string>={};
  // More than one real API page; accounts are created through normal UI/R.
  const accounts:string[][]=[...Array.from({length:19},(_,i)=>[`A${String(i).padStart(2,'0')}`,'Auxiliar sintética','GENERAL','ASSET']),
    ['ZASSET','Activo sintético','GENERAL','ASSET'],['ZBANK','Banco sintético','BANK','ASSET'],
    ['ZCASH','Caja sintética','CASH','ASSET'],['ZEQUITY','Aportes sintéticos','GENERAL','EQUITY'],
    ['ZHIST','Resultados históricos','GENERAL','EQUITY'],['ZINTEREST','Interés histórico','GENERAL','ASSET'],['ZPRINCIPAL','Cartera histórica','GENERAL','ASSET']];
  for(const [code,name,kind,accountClass] of accounts){
    await page.getByRole('textbox',{name:'Código',exact:true}).fill(code!);
    await page.getByRole('textbox',{name:'Nombre',exact:true}).fill(name!);
    await page.getByRole('combobox',{name:'Tipo',exact:true}).selectOption(kind!);
    if(kind==='GENERAL')await page.getByRole('combobox',{name:'Clase',exact:true}).selectOption(accountClass!);
    ids[code!]=(await (await confirm(page,'Crear cuenta contable','/accounts')).json()).data.id;
  }
  const base=`/api/v1/organizations/${org}/financial`;
  const read=async(path:string)=>page.evaluate(async url=>{const r=await fetch(url);return {status:r.status,body:await r.json()};},path);
  const first=await read(base+'/accounts?limit=20');expect(first.status).toBe(200);expect(first.body.data.items).toHaveLength(20);expect(first.body.data.nextCursor).toBeTruthy();
  const second=await read(base+'/accounts?limit=20&cursor='+encodeURIComponent(first.body.data.nextCursor));expect(second.body.data.items).toHaveLength(6);
  await page.getByRole('textbox',{name:'Código',exact:true}).fill('ZBANK');await page.getByRole('textbox',{name:'Nombre',exact:true}).fill('Duplicada sintética');
  const duplicate=await confirm(page,'Crear cuenta contable','/accounts','POST',[409]);
  expect(['INPUT_INVALID','SOURCE_CONFLICT']).toContain((await duplicate.json()).error.code);
  await expect(page.getByText('No se pudo crear: el código ya existe o entró en conflicto. Revisa el código y vuelve a intentarlo.',{exact:true})).toBeVisible();
  console.log('P04 checkpoint:26accounts,20+6pages,duplicate409');
  const op=page.getByRole('region',{name:'Apertura manual',exact:true});
  await op.getByLabel('Fecha de corte de la apertura').fill('2020-01-01');await op.getByRole('button',{name:'Siguiente',exact:true}).click();
  await op.getByRole('button',{name:'Agregar soporte',exact:true}).click();
  await op.getByLabel('Referencia del soporte').fill('P04-SOPORTE-SINTETICO');await op.getByLabel('Fecha del soporte').fill('2020-01-01');
  await op.getByLabel('Declaración').selectOption('OWNER_CHECKED');await op.getByRole('button',{name:'Siguiente',exact:true}).click();
  for(const [type,external] of [['BORROWER','P04-PERSONA'],['HISTORICAL_LOAN','P04-PRESTAMO'],['BASIC_ASSET','P04-ACTIVO']]){
    await op.getByRole('button',{name:'Agregar referencia histórica',exact:true}).click();
    const group=op.locator('fieldset').filter({has:page.getByLabel('Tipo de referencia')}).last();
    await group.getByLabel('Tipo de referencia').selectOption(type!);await group.getByLabel('Referencia externa').fill(external!);
    if(type==='BORROWER')await group.getByLabel('Nombre visible').fill('Persona sintética P04');
    if(type==='HISTORICAL_LOAN'){
      await group.getByLabel('Contraparte del préstamo').selectOption({label:'Persona sintética P04'});await group.getByLabel('Fecha de originación').fill('2019-01-01');
    }
    if(type==='BASIC_ASSET'){
      await group.getByLabel('Categoría de la referencia').fill('VEHICLE');await group.getByLabel('Fecha de adquisición').fill('2019-01-01');await group.getByLabel('Origen informado').fill('Titularidad y origen declarados en soporte sintético');
    }
    await group.getByRole('checkbox',{name:'P04-SOPORTE-SINTETICO',exact:true}).check();
  }
  await op.getByRole('button',{name:'Siguiente',exact:true}).click();
  async function choose(group:ReturnType<Page['locator']>,label:string,code:string){
    const button=group.getByRole('button',{name:`Elegir ${code} para ${label}`,exact:true});
    for(let n=0;n<3;n++){
      // Wait for each page to settle before deciding whether to advance.
      await expect(group.getByText(`Cargando cuentas de ${label}…`,{exact:true})).toBeHidden();
      if(await button.count()){await button.focus();await button.press('Enter');return;}
      const next=group.getByRole('button',{name:`${label}: cuentas siguientes`,exact:true});await expect(next).toBeEnabled();
      const response=page.waitForResponse(r=>r.url().includes('/accounts?')&&r.request().method()==='GET');await next.click();expect((await response).status()).toBe(200);
    }
    throw Error('Account not found across actual pages: '+code);
  }
  for(const [category,label,code,amount,reference,equity] of [
    ['BANK','Banco','ZBANK','100','',''],['PRINCIPAL_RECEIVABLE','Principal de cartera histórica','ZPRINCIPAL','200','P04-PRESTAMO',''],
    ['BASIC_ASSET','Activo básico','ZASSET','300','P04-ACTIVO',''],['EQUITY','Patrimonio declarado','ZEQUITY','599','','CONTRIBUTED'],
    ['EQUITY','Patrimonio declarado','ZHIST','20','','HISTORICAL_RESULTS'],
  ]){
    await op.getByRole('button',{name:'Agregar componente',exact:true}).click();
    const group=op.locator('fieldset').filter({has:page.getByLabel('Categoría del componente')}).last();
    await group.getByLabel('Categoría del componente').selectOption(category!);
    if(category==='BANK'){
      // Alter one outgoing cursor, but obtain the rejection from the real API.
      let changed=false;
      await page.route('**/financial/accounts?*',async route=>{
        const url=new URL(route.request().url());
        if(!changed&&url.searchParams.has('cursor')){changed=true;url.searchParams.set('cursor','invalid-synthetic-cursor');await route.continue({url:url.toString()});}
        else await route.continue();
      });
      const invalid=page.waitForResponse(r=>r.url().includes('/accounts?')&&r.status()===422);
      await group.getByRole('button',{name:'Banco: cuentas siguientes',exact:true}).click();expect((await invalid).status()).toBe(422);
      await expect(group.getByText('La página pedida no es válida. Se vuelve a la primera, sin tratarlo como un resultado.',{exact:true})).toBeVisible();
      await page.unroute('**/financial/accounts?*');
    }
    await choose(group,label!,code!);
    if(category==='BANK'){
      await group.getByRole('button',{name:'Banco: cuentas anteriores',exact:true}).click();
      await expect(group.getByRole('heading',{name:'Seleccionada para Banco',exact:true})).toBeVisible();
      const selected=group.getByRole('article').filter({has:page.getByRole('heading',{name:'Seleccionada para Banco',exact:true})});
      await expect(selected.getByText('ZBANK · Banco sintético',{exact:true})).toBeVisible();
      await group.getByLabel('Buscar Banco en esta página').fill('NO-COINCIDE');await expect(selected.getByText('ZBANK · Banco sintético',{exact:true})).toBeVisible();
    }
    await group.getByLabel(category==='EQUITY'?'Importe de patrimonio':'Importe del componente').fill(amount!);
    if(equity)await group.getByLabel('Clase de patrimonio').selectOption(equity);
    if(reference)await group.getByLabel('Referencia del componente').selectOption({label:reference});
    await group.getByRole('checkbox',{name:'P04-SOPORTE-SINTETICO',exact:true}).check();
  }
  await op.getByRole('button',{name:'Siguiente',exact:true}).click();await op.getByRole('button',{name:'Agregar interés histórico',exact:true}).click();
  const interest=op.getByRole('group',{name:'Interés informativo',exact:true});await interest.getByLabel('Tratamiento del interés').selectOption('RECOGNIZED_OPENING');
  const recognized=op.getByRole('group',{name:'Interés reconocido en la apertura',exact:true});
  await recognized.getByLabel('Préstamo histórico del interés').selectOption({label:'P04-PRESTAMO'});await recognized.getByLabel('Importe del interés').fill('20');
  await choose(recognized,'Cuenta del interés reconocido','ZINTEREST');await recognized.getByLabel('Declaración del reconocimiento').fill('Interés histórico reconocido contra patrimonio histórico declarado');
  await recognized.getByLabel('Patrimonio de resultados históricos').selectOption({label:'20'});await recognized.getByRole('checkbox',{name:'P04-SOPORTE-SINTETICO',exact:true}).check();
  await op.getByRole('button',{name:'Siguiente',exact:true}).click();
  const created=await confirm(page,'Guardar borrador de apertura','/opening-files');const openingId=(await created.json()).data.id;
  console.log('P04 checkpoint:draft saved through real R');
  expect(created.request().postDataJSON().snapshot.components.map((c:{amount:string})=>c.amount)).toEqual(['100.00','200.00','300.00','599.00','20.00']);
  await page.reload();await op.getByRole('button',{name:'Reanudar 2020-01-01',exact:true}).click();
  await expect(op.getByRole('heading',{name:'Resumen previo',exact:true})).toBeVisible();
  await op.getByRole('button',{name:'Corte y ámbito',exact:true}).click();
  await expect(op.getByLabel('Fecha de corte de la apertura')).toHaveValue('2020-01-01');
  const bad=await confirm(page,'Validar con el servidor',`/opening-files/${openingId}/validations`);
  expect((await bad.json()).data.report.totals.balanceDifference).toBe('1.00');await expect(op.getByText(/Diferencia de balance\./)).toBeVisible();
  expect((await read(base+'/journal-entries')).body.data.items).toHaveLength(0);
  for(const name of ['Soportes','Referencias históricas','Componentes y cuentas'])await op.getByRole('button',{name,exact:true}).click();
  const equityGroup=op.locator('fieldset').filter({has:page.getByLabel('Categoría del componente')}).nth(3);
  await equityGroup.getByLabel('Importe de patrimonio').fill('600');
  await op.getByRole('button',{name:'Interés y antecedentes',exact:true}).click();await op.getByRole('button',{name:'Resumen y guardado',exact:true}).click();
  await op.getByLabel('Motivo del cambio').fill('Corregir aporte declarado según soporte');await confirm(page,'Guardar borrador de apertura',`/opening-files/${openingId}`,'PUT');
  const valid=await confirm(page,'Validar con el servidor',`/opening-files/${openingId}/validations`);const validBody=(await valid.json()).data;
  console.log('P04 checkpoint:difference corrected and validated');
  expect(validBody.report.issues).toEqual([]);expect(validBody.report.totals.assets).toBe('620.00');expect(validBody.report.totals.equity).toBe('620.00');expect(validBody.report.totals.debit).toBe(validBody.report.totals.credit);
  await op.getByRole('checkbox',{name:/Apruebo el expediente validado/}).check();await confirm(page,'Aprobar apertura',`/opening-files/${openingId}/approval`);
  await expect(op.getByRole('button',{name:'Validar con el servidor',exact:true})).toHaveCount(0);
  await expect(op.getByText(/vuelve a guardarlo con un motivo/)).toBeVisible();
  await expect(op.getByRole('checkbox',{name:/Confirmo el corte, los soportes/})).not.toBeChecked();
  // A real catalog mutation makes an approved validation stale before commit.
  await page.getByRole('button',{name:'Cuentas siguientes',exact:true}).click();
  await page.getByRole('heading',{name:'ZBANK · Banco sintético',exact:true}).locator('xpath=..').getByRole('button',{name:'Cambiar nombre'}).click();
  await page.getByLabel('Nuevo nombre').fill('Banco revisado P04');await confirm(page,'Guardar nombre','/accounts/'+ids['ZBANK'],'PATCH');
  await op.getByRole('checkbox',{name:/Confirmo el corte, los soportes/}).check();
  const commitForm=page.locator('form').filter({has:page.getByRole('button',{name:'Confirmar apertura en el libro',exact:true})});
  await commitForm.getByLabel('Contraseña actual').fill(PASSWORD);
  const staleReply=page.waitForResponse(r=>r.url().endsWith(`/opening-files/${openingId}/commit`)&&r.request().method()==='POST');
  await commitForm.getByRole('button',{name:'Confirmar apertura en el libro',exact:true}).click();const stale=await staleReply;
  expect(stale.status()).toBe(409);expect((await stale.json()).error.code).toBe('OPENING_VALIDATION_STALE');
  console.log('P04 checkpoint:stale commit409');
  expect((await read(base+'/journal-entries')).body.data.items).toHaveLength(0);
  // APPROVED must first be explicitly replaced, even if only dependencies changed.
  await op.getByLabel('Motivo del cambio').fill('Invalidar aprobación tras cambio de catálogo');
  await confirm(page,'Guardar borrador de apertura',`/opening-files/${openingId}`,'PUT');
  await confirm(page,'Validar con el servidor',`/opening-files/${openingId}/validations`);
  await op.getByRole('checkbox',{name:/Apruebo el expediente validado/}).check();await confirm(page,'Aprobar apertura',`/opening-files/${openingId}/approval`);
  await op.getByRole('checkbox',{name:/Confirmo el corte, los soportes/}).check();const posted=await confirm(page,'Confirmar apertura en el libro',`/opening-files/${openingId}/commit`);
  const final=(await posted.json()).data;expect(final.status).toBe('POSTED');expect(final.commit.ledgerLineMap).toHaveLength(6);
  const listed=op.getByRole('article').filter({has:page.getByRole('heading',{name:'Corte 2020-01-01',exact:true})});
  await expect(listed.getByText(/Estado del expediente: POSTED/)).toContainText(`Versión ${final.version}`);
  console.log('P04 checkpoint:opening posted');
  await expect(op.getByText(/El servidor confirmó la apertura al corte/)).toBeVisible();
  const journals=await read(base+'/journal-entries');expect(journals.body.data.items).toHaveLength(1);
  const journal=await read(base+'/journal-entries/'+final.commit.journalId);expect(journal.body.data.source).toEqual({type:'OPENING',id:openingId});
  expect(journal.body.data.effectiveDate).toBe('2020-01-01');expect(journal.body.data.lines).toHaveLength(6);
  const before=await read(base+'/balances?asOf=2019-12-31'),cut=await read(base+'/balances?asOf=2020-01-01');
  expect(before.status).toBe(200);expect(cut.status).toBe(200);expect(before.body.data.items.every((b:{naturalBalance:string})=>b.naturalBalance==='0.00')).toBe(true);
  for(const [code,amount] of [['ZBANK','100.00'],['ZPRINCIPAL','200.00'],['ZASSET','300.00'],['ZEQUITY','600.00'],['ZHIST','20.00'],['ZINTEREST','20.00']])expect(cut.body.data.items.find((b:{accountId:string})=>b.accountId===ids[code!]).naturalBalance).toBe(amount);
  expect(cut.body.data.items.find((b:{accountId:string})=>b.accountId===ids['ZCASH']).naturalBalance).toBe('0.00');
  for(const width of [360,390,768,1024,1440]){
    await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth+1)).toBe(false);
    await op.scrollIntoViewIfNeeded();await page.screenshot({path:resolve(evidence,`S03-P04-UI-${width}.png`)});
  }
  await page.evaluate(()=>{document.documentElement.style.zoom='2';});expect(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth+1)).toBe(false);await page.evaluate(()=>{document.documentElement.style.zoom='1';});
  await stop();const controls=await fingerprints();await start();expect(await fingerprints()).toEqual(controls);await page.reload();
  await op.getByRole('button',{name:'Reanudar 2020-01-01',exact:true}).click();await expect(op.getByText(/El servidor confirmó la apertura al corte/)).toBeVisible();
  expect((await read(base+'/journal-entries')).body.data.items).toHaveLength(1);expect((await read(base+'/balances?asOf=2020-01-01')).body.data.items).toEqual(cut.body.data.items);
  expect(await page.evaluate(()=>localStorage.length+sessionStorage.length)).toBe(0);
  await writeFile(resolve(evidence,'S03-P04-ECONOMIC.json'),JSON.stringify({task:'S03-P04',at:new Date().toISOString(),source:'Real HTTPS UI commands and authenticated API reads; synthetic group only',accounts:26,openingId,journalId:final.commit.journalId,initialDifference:'1.00',staleCommit:{status:409,code:'OPENING_VALIDATION_STALE',journalsAfter:0},totals:validBody.report.totals,journal:journal.body.data,balancesBefore:before.body.data,balancesAtCut:cut.body.data,persistence:{sameFiveControlHashes:true,sameBalances:true,journals:1},pagination:{first:20,second:6,selectionAcrossPages:true},responsive:[360,390,768,1024,1440],zoom:2,localStorageEntries:0,sessionStorageEntries:0},null,2)+'\n');
});
