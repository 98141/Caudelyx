import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const password='Frase de prueba sintetica larga 9871236450';
const control=async(action:string,fields:Record<string,string|number>={})=>{
  const target=process.env.AJ_ONB_4_CONTROL,owner=process.env.AJ_ONB_4_OWNER;
  if(!target||!owner||!target.startsWith('http://127.0.0.1:'))throw Error('Own loopback control required');
  const response=await fetch(target,{method:'POST',headers:{'X-Fixture-Owner':owner},body:JSON.stringify({action,...fields})});
  if(!response.ok)throw Error('Own control failed');return await response.json() as Record<string,string|boolean>;
};
async function register(page:Page,email:string,name:string){
  await page.goto('/#/registro');await page.getByLabel('Correo',{exact:true}).fill(email);
  await page.getByLabel('Nombre visible',{exact:true}).fill(name);
  await page.getByLabel('Contraseña',{exact:true}).fill(password);
  await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Crear cuenta',exact:true}).click();
  await expect(page).toHaveURL(/#\/perfil$/);await expect(page.getByText('Confirma tu correo para crear organizaciones',{exact:false}).first()).toBeVisible();
}
async function login(page:Page,email:string){
  await page.goto('/#/ingresar');await page.getByLabel('Correo',{exact:true}).fill(email);await page.getByLabel('Contraseña',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Iniciar sesión',exact:true}).click();await expect(page).toHaveURL(/#\/perfil$/);
}
async function prepare(page:Page){
  await page.goto('/#/seguridad');await page.getByLabel('Contraseña actual',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Preparar factor',exact:true}).click();
  await expect(page.getByRole('img',{name:/Código QR/})).toBeVisible();
  const uri=await page.locator('output').filter({hasText:'otpauth://'}).innerText();
  if(!uri.startsWith('otpauth://'))throw Error('No real provisioning URI');
  const secret=new URL(uri).searchParams.get('secret');if(!secret)throw Error('No real TOTP material');return{uri,secret};
}

test('AT20/21 UI/API real: alta B, otro navegador, TOTP S/R, RESET G01 y rechazo',async({browser,page,baseURL})=>{
  const events:{method:string;path:string}[]=[],foreign:string[]=[],metrics:unknown[]=[];
  page.context().on('request',r=>{const u=new URL(r.url());if(u.protocol==='https:'){if(u.origin!==baseURL)foreign.push(u.hostname);events.push({method:r.method(),path:u.pathname});}});
  const email=randomUUID()+'@example.test';await register(page,email,'Persona integrada');
  await expect(page.getByRole('link',{name:'Ingresar',exact:true})).toHaveCount(0);
  await expect(page.getByRole('link',{name:'Crear cuenta',exact:true})).toHaveCount(0);
  const before=await control('inspect',{email});
  for(const width of [360,390,768,1024,1440]){
    await page.setViewportSize({width,height:900});
    const layout=await page.evaluate(()=>({viewport:innerWidth,content:document.documentElement.scrollWidth}));
    metrics.push({screen:'profile',width,...layout});expect(layout.content<=layout.viewport+1,'Profile must fit viewport').toBeTruthy();
  }
  await page.setViewportSize({width:390,height:844});await page.keyboard.press('Tab');
  expect(await page.evaluate(()=>document.activeElement!==document.body),'Keyboard reaches controls').toBeTruthy();
  const calls=events.length;await page.goto('/#/organizacion');await expect(page.getByRole('heading',{name:'Protege tu cuenta'})).toBeVisible();
  expect(events.slice(calls).some(r=>r.path==='/api/v1/organization'),'B UI must not fetch business').toBeFalsy();
  const blocked=await page.evaluate(async()=>{const r=await fetch('/api/v1/organization');const b=await r.json();return{status:r.status,code:b.error.code};});
  expect(blocked).toEqual({status:403,code:'EMAIL_NOT_VERIFIED'});
  const {token}=await control('mail',{email,purpose:'ACTIVATION'});
  const second=await browser.newContext({ignoreHTTPSErrors:true,baseURL}),receiver=await second.newPage();
  let posts=0;receiver.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/email-verifications/confirm'))posts++;});
  await receiver.goto('/#/activar?purpose=ACTIVATION&token='+String(token));
  await expect(receiver.getByRole('button',{name:'Activar cuenta',exact:true})).toBeVisible();
  expect(receiver.url().includes(String(token)),'Fragment token removed').toBeFalsy();expect(posts).toBe(0);
  await expect(receiver.getByLabel('Contraseña',{exact:true})).toHaveCount(0);
  await receiver.getByRole('button',{name:'Activar cuenta',exact:true}).click();await expect(receiver.getByText('Correo confirmado ✓',{exact:true})).toBeVisible();
  expect(posts).toBe(1);expect((await control('inspect',{email})).hash===before.hash,'Confirmation must preserve password hash').toBeTruthy();
  const anonymous=await receiver.evaluate(async()=> (await fetch('/api/v1/auth/me')).status);expect(anonymous).toBe(401);
  await page.goto('/#/perfil');await page.reload();await expect(page.getByText('Correo confirmado',{exact:true})).toBeVisible();
  await page.clock.install();
  const material=await prepare(page);expect(decodeURIComponent(new URL(material.uri).pathname).includes(email),'TOTP label must identify own email').toBeTruthy();
  const qr=page.getByRole('img',{name:/Código QR/});expect((await qr.getAttribute('src'))?.startsWith('data:image/svg+xml'),'QR must be local SVG').toBeTruthy();
  for(const width of [360,390,768,1024,1440]){await page.setViewportSize({width,height:900});const box=await qr.boundingBox();expect(!!box&&box.width<=width,'QR must fit').toBeTruthy();}
  expect(await page.evaluate(()=>Object.keys(localStorage).length+Object.keys(sessionStorage).length),'No browser storage of factor').toBe(0);
  await page.getByRole('button',{name:'Ocultar y borrar de la pantalla'}).click();await expect(qr).toHaveCount(0);await expect(page.locator('output')).toHaveCount(0);
  await prepare(page);await page.clock.fastForward(300000);await expect(qr).toHaveCount(0);await expect(page.locator('output')).toHaveCount(0);
  const active=await prepare(page);const {code}=await control('code',{secret:active.secret});
  await page.getByLabel('Código TOTP actual',{exact:true}).fill(String(code));await page.getByRole('button',{name:'Confirmar TOTP',exact:true}).click();
  await expect(page.locator('output')).toHaveCount(0);await expect(qr).toHaveCount(0);
  await page.goto('/#/organizacion');await expect(page.getByRole('heading',{name:'Crear la organización'})).toBeVisible();
  await control('tick');const step=await control('code',{secret:active.secret});
  await page.getByLabel('Nombre',{exact:true}).fill('Organización integrada');await page.getByLabel('Contraseña actual',{exact:true}).fill(password);
  await page.getByLabel('Código TOTP vigente',{exact:true}).fill(String(step.code));await page.getByRole('button',{name:'Crear organización',exact:true}).click();
  await expect(page.getByText('Organización creada. Una segunda organización no está permitida.',{exact:true})).toBeVisible();
  await second.close();
  // A separate account remains unconfirmed until RESET; original B must be revoked.
  const resetContext=await browser.newContext({ignoreHTTPSErrors:true,baseURL}),pending=await resetContext.newPage(),resetEmail=randomUUID()+'@example.test';
  await register(pending,resetEmail,'G01 integrada');const resetBefore=await control('inspect',{email:resetEmail});
  const resetter=await browser.newContext({ignoreHTTPSErrors:true,baseURL}),resetPage=await resetter.newPage();
  await resetPage.goto('/#/restablecer');await resetPage.getByLabel('Correo',{exact:true}).fill(resetEmail);await resetPage.getByRole('button',{name:'Solicitar código',exact:true}).click();
  await expect(resetPage.getByText(/Si la solicitud es admisible/)).toBeVisible();const resetMail=await control('mail',{email:resetEmail,purpose:'RESET'});
  await resetPage.getByLabel('Código de restablecimiento',{exact:true}).fill(String(resetMail.token));await resetPage.getByRole('button',{name:'Previsualizar aviso',exact:true}).click();
  await expect(resetPage.getByText(/El servidor no pidió el aviso de bloqueo/)).toBeVisible();await resetPage.getByLabel('Contraseña nueva',{exact:true}).fill(password);
  await resetPage.getByRole('button',{name:'Confirmar restablecimiento',exact:true}).click();await expect(resetPage.getByText(/Contraseña actualizada/)).toBeVisible();
  const resetAfter=await control('inspect',{email:resetEmail});expect(resetAfter.emailVerified).toBe(true);expect(resetAfter.reset).toBe(true);expect(resetBefore.hash!==resetAfter.hash,'RESET replaces hash').toBeTruthy();
  expect(await pending.evaluate(async()=> (await fetch('/api/v1/auth/me')).status)).toBe(401);
  await login(resetPage,resetEmail);await prepare(resetPage);await resetPage.getByRole('button',{name:'Cerrar sesión',exact:true}).click();await expect(resetPage.getByRole('img',{name:/Código QR/})).toHaveCount(0);await expect(resetPage.locator('output')).toHaveCount(0);
  await login(resetPage,resetEmail);const resetFactor=await prepare(resetPage),resetCode=await control('code',{secret:resetFactor.secret});
  await resetPage.getByLabel('Código TOTP actual',{exact:true}).fill(String(resetCode.code));await resetPage.getByRole('button',{name:'Confirmar TOTP',exact:true}).click();await expect(resetPage.locator('output')).toHaveCount(0);
  await resetPage.goto('/#/organizacion');await expect(resetPage.getByRole('heading',{name:'Crear la organización'})).toBeVisible();
  await resetContext.close();await resetter.close();
  const rejectedContext=await browser.newContext({ignoreHTTPSErrors:true,baseURL}),rejected=await rejectedContext.newPage(),rejectEmail=randomUUID()+'@example.test';
  await register(rejected,rejectEmail,'Rechazo integrado');const rejectMail=await control('mail',{email:rejectEmail,purpose:'ACTIVATION'});
  const noContext=await browser.newContext({ignoreHTTPSErrors:true,baseURL}),no=await noContext.newPage();
  await no.goto('/#/rechazar?purpose=REJECT&token='+String(rejectMail.token));await expect(no.getByRole('button',{name:'No fui yo',exact:true})).toBeVisible();
  expect(no.url().includes(String(rejectMail.token)),'Reject fragment removed').toBeFalsy();expect((await control('inspect',{email:rejectEmail})).exists).toBe(true);
  await no.getByRole('button',{name:'No fui yo',exact:true}).click();await expect(no.getByText(/La solicitud quedó anulada/)).toBeVisible();
  expect((await control('inspect',{email:rejectEmail})).exists).toBe(false);expect(await rejected.evaluate(async()=> (await fetch('/api/v1/auth/me')).status)).toBe(401);
  await noContext.close();await rejectedContext.close();expect(foreign,'No external origin used by main flow').toEqual([]);
  const evidence=process.env.AJ_ONB_4_EVIDENCE;if(!evidence)throw Error('Registered evidence path required');
  writeFileSync(evidence,JSON.stringify({task:'AJ-ONB-4',browserVersion:browser.version(),timeout:'PASS_BROWSER_CLOCK_300000MS',resetG01:'PASS_REAL_TOTP_TO_S',result:'PASS_AUTOMATED_UI_API',physicalScan:'PENDING',screenReaderPhysical:'PENDING',metrics,requests:events,foreignOrigins:foreign,materialRecorded:false},null,2));
});
