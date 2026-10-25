import { test, expect, type Page } from '@playwright/test';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PASSWORD, openActivation } from '../e2e/fixtures';

const server=resolve(import.meta.dirname,'../../../servidor');
const workspace=resolve(server,'../..');
const evidence=resolve(workspace,'Construccion/Sprints/S02/Evidencias');
const environment={...process.env,CAUDELYX_MODE:'local-synthetic',CAUDELYX_DEV_TEST_ID:process.env.CAUDELYX_TEST_RUN_ID!,
  CAUDELYX_DEV_UI_PORT:'5311',CAUDELYX_DEV_API_PORT:'5411',CAUDELYX_DEV_PLATFORM_PORT:'5312'};
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

async function confirm(page:Page,button:string,suffix:string,method='POST'){
  const form=page.locator('form').filter({has:page.getByRole('button',{name:button,exact:true})});
  await form.getByLabel('Contraseña actual').fill(PASSWORD);
  const response=page.waitForResponse(r=>r.url().endsWith(suffix)&&r.request().method()===method);
  await form.getByRole('button',{name:button,exact:true}).click();
  const reply=await response;expect([200,201]).toContain(reply.status());return reply;
}
test('P04 real HTTPS registration, CLI, WebAuthn, finance, restart and responsive integration',async({page})=>{
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
  await page.goto('/#/organizacion');await page.getByLabel('Nombre',{exact:true}).fill('Libro sintético P04');
  const orgReply=await confirm(page,'Crear organización','/organizations');
  const org=(await orgReply.json()).data.organization.id as string;
  await expect(page.getByRole('heading',{name:'Libro sintético P04'})).toBeVisible();
  await page.getByRole('link',{name:'Abrir el libro de cuentas'}).click();
  await expect(page.getByRole('button',{name:'Crear cuenta contable'})).toBeVisible();
  await expect(page.getByText('Cargando cuentas y asientos…')).toBeHidden();
  for(const width of [360,390,768,1024,1440]){
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth+1)).toBe(false);
    await page.screenshot({path:resolve(evidence,`S02-P04-UI-${width}.png`)});
  }
  await page.evaluate(()=>{document.documentElement.style.zoom='2';});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth+1)).toBe(false);
  await page.evaluate(()=>{document.documentElement.style.zoom='1';});
  const accountIds:Record<string,string>={};
  for(const [code,name,kind,accountClass] of [['BANK_04','Banco','BANK','ASSET'],['CASH_04','Caja','CASH','ASSET'],['EQUITY_04','Patrimonio','GENERAL','EQUITY']]){
    await page.getByRole('textbox',{name:'Código',exact:true}).fill(code!);await page.getByRole('textbox',{name:'Nombre',exact:true}).fill(name!);
    await page.getByRole('combobox',{name:'Tipo',exact:true}).selectOption(kind!);
    if(kind==='GENERAL')await page.getByRole('combobox',{name:'Clase',exact:true}).selectOption(accountClass!);
    const reply=await confirm(page,'Crear cuenta contable','/accounts');accountIds[code!]=(await reply.json()).data.id;
    await expect(page.getByRole('heading',{name:`${code} · ${name}`})).toBeVisible();
  }
  await page.getByRole('heading',{name:'EQUITY_04 · Patrimonio'}).locator('xpath=..').getByRole('button',{name:'Cambiar nombre'}).click();
  await page.getByLabel('Nuevo nombre').fill('Patrimonio revisado');
  await confirm(page,'Guardar nombre','/accounts/'+accountIds['EQUITY_04'],'PATCH');
  await expect(page.getByRole('heading',{name:'EQUITY_04 · Patrimonio revisado'})).toBeVisible();
  const journal=page.getByRole('region',{name:'Asiento',exact:true});
  for(const [index,code,side] of [[1,'BANK_04','debit'],[2,'EQUITY_04','credit']] as const){
    const line=journal.getByRole('group',{name:`Línea ${index}`});
    await line.getByLabel('Cuenta').selectOption(accountIds[code]!);await line.getByLabel('Lado').selectOption(side);await line.getByLabel('Importe').fill('100');
  }
  await journal.getByRole('textbox',{name:'Soporte',exact:true}).fill('P04-APORTE');
  await journal.getByRole('textbox',{name:'Descripción',exact:true}).fill('Aporte sintético');
  await confirm(page,'Contabilizar asiento','/journal-entries');
  await expect(page.getByRole('heading',{name:'Asiento manual',level:3})).toBeVisible();
  const transfer=page.getByRole('region',{name:'Transferencia',exact:true});
  await transfer.getByLabel('Cuenta de origen').selectOption(accountIds['BANK_04']!);
  await transfer.getByLabel('Cuenta de destino').selectOption(accountIds['CASH_04']!);
  await transfer.getByLabel('Importe').fill('25,50');
  await transfer.getByRole('textbox',{name:'Soporte',exact:true}).fill('P04-TR');
  await transfer.getByRole('textbox',{name:'Descripción',exact:true}).fill('Traslado sintético');
  const transferred=await confirm(page,'Transferir','/transfers');
  expect(transferred.request().postDataJSON().amount).toBe('25.50');
  await page.getByRole('button',{name:'Consultar saldo'}).click();
  await expect(page.getByText('BANK_04 · Banco: 74,50 COP')).toBeVisible();
  await expect(page.getByText('CASH_04 · Caja: 25,50 COP')).toBeVisible();
  // Real route rejects injected scope/unauthenticated reads without any financial mutation.
  const base=`/api/v1/organizations/${org}/financial`;
  const denied=await page.evaluate(async url=>(await fetch(url)).status,base+'/accounts?scope=PERSONAL');expect(denied).toBe(422);
  const anonymous=await page.context().browser()!.newContext({ignoreHTTPSErrors:false});
  try{const other=await anonymous.newPage();expect((await other.goto('https://localhost:5311'+base+'/accounts'))!.status()).toBe(401);}finally{await anonymous.close();}
  await stop();const prior=await fingerprints();await start();
  expect(await fingerprints()).toEqual(prior);
  await page.reload();await expect(page.getByRole('button',{name:'Consultar saldo'})).toBeVisible();
  await page.getByRole('button',{name:'Consultar saldo'}).click();await expect(page.getByText('BANK_04 · Banco: 74,50 COP')).toBeVisible();
  await page.getByRole('heading',{name:'Transferencia',level:3}).locator('xpath=..').getByRole('button',{name:'Revertir este asiento'}).click();
  await page.getByLabel('Motivo de la reversión').fill('Compensación sintética');await page.getByLabel('Soporte de la reversión').fill('P04-REV');
  await confirm(page,'Crear compensación','/reversals');await expect(page.getByRole('heading',{name:'Reversión',level:3})).toBeVisible();
  await page.getByRole('button',{name:'Consultar saldo'}).click();await expect(page.getByText('BANK_04 · Banco: 100 COP')).toBeVisible();
  await expect(page.getByText(': 0 COP saldo del libro')).toBeVisible();
  expect(await page.evaluate(()=>localStorage.length+sessionStorage.length)).toBe(0);
});
