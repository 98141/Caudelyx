import { test, expect } from '@playwright/test';
import process from 'node:process';

test('P04 real terms lifecycle and exact schedules without financial posting',async({page,context,request})=>{
  const control=async(path:string,body?:unknown)=>{
    const r=await request.fetch(process.env.P04_CONTROL+path,{method:body?'POST':'GET',headers:{'X-P04-Owner':process.env.P04_OWNER!},...(body?{data:body}:{})});
    expect(r.status()).toBe(200);return await r.json();
  };
  const actor=await control('/session');
  await context.addCookies([{name:'__Host-caudelyx-session',value:actor.token,url:process.env.P04_URL!,secure:true,httpOnly:true,sameSite:'Lax'}]);
  const proof=async(legend:string)=>{
    const {code}=await control('/tick'),group=page.getByRole('group',{name:legend,exact:true});
    await group.getByLabel('Contraseña actual',{exact:true}).fill(actor.password);
    await group.getByLabel('Código TOTP vigente',{exact:true}).fill(code);
  };
  const transportErrors: string[]=[];
  const response=(method:string,end:string)=>page.waitForResponse(async r=>{
    if(r.request().method()!==method||!new URL(r.url()).pathname.endsWith(end))return false;
    if(r.status()>=400){
      const code=(await r.json()).error?.code as string|undefined;
      console.log('P04_HTTP_STATUS '+JSON.stringify({method,operation:end.split('/').at(-1),status:r.status(),code}));
      // call() has one existing, bounded CSRF_INVALID refresh/retry. Observe the user command's terminal response.
      if(r.status()===400&&code==='CSRF_INVALID'){transportErrors.push(code);return false;}
    }
    return true;
  });
  const command=async(method:string,end:string,button:string)=>{
    const result=response(method,end);await page.getByRole('button',{name:button,exact:true}).click();const r=await result;
    const body=await r.json();expect(r.status(),body.error?.code).toBeGreaterThanOrEqual(200);expect(r.status(),body.error?.code).toBeLessThan(300);return body.data;
  };
  await page.goto('/#/prestatarios');
  await expect(page.getByRole('heading',{name:'Prestatarios',exact:true})).toBeVisible();
  await page.getByLabel('Clave del campo',{exact:true}).fill('zona');await page.getByLabel('Nombre del campo',{exact:true}).fill('Zona sintética');
  await page.getByLabel('Motivo del cambio de catálogo',{exact:true}).fill('Catálogo integrado sintético');
  await proof('Publicar el campo');await command('POST','/borrower-field-schemas','Publicar campo');
  await page.getByLabel('Código',{exact:true}).fill('P04_UI');await page.getByLabel('Nombre',{exact:true}).fill('Persona UI sintética');
  await page.getByLabel('Zona sintética',{exact:true}).fill('Zona de prueba');await proof('Confirmar el guardado de la ficha');
  const borrower=await command('POST','/borrowers','Crear ficha');
  await page.getByLabel('Nombre',{exact:true}).fill('Persona UI actualizada');await page.getByLabel('Motivo del cambio',{exact:true}).fill('Edición sintética');
  await proof('Confirmar el guardado de la ficha');await command('PUT','/borrowers/'+borrower.id,'Guardar cambios');
  await expect(page.getByText('Versión 1: Persona UI sintética. Alta inicial.')).toBeVisible();
  await expect(page.getByText('Versión 2: Persona UI actualizada. Edición sintética.')).toBeVisible();
  await page.goto('/#/prestamos');
  await expect(page.getByRole('option',{name:'P001 · Persona sintética P001'})).toBeAttached();
  await page.getByLabel('Prestatario').selectOption({label:'P001 · Persona sintética P001'});
  await page.getByRole('button',{name:'Más prestatarios',exact:true}).click();
  await expect(page.getByLabel('Prestatario')).not.toHaveValue('');
  await expect(page.getByRole('option',{name:'P021 · Persona sintética P021'})).toBeAttached();
  await page.getByLabel('Prestatario').selectOption(borrower.id);
  await page.getByRole('button',{name:'Elegir CASH_P04 para Cuenta prevista de desembolso',exact:true}).click();
  await page.getByLabel('Capital',{exact:true}).fill('1.000');await page.getByLabel('Modalidad').selectOption('CONSTANT_PRINCIPAL');
  await page.getByLabel('Frecuencia de la cuota').selectOption('MONTH');await page.getByLabel('Clase de tasa').selectOption('EFFECTIVE');
  await page.getByLabel('Unidad de la tasa').selectOption('MONTH');await page.getByLabel('Tasa en porcentaje',{exact:true}).fill('1');
  await page.getByLabel('Fecha de inicio',{exact:true}).fill('2024-01-31');await page.getByLabel('Fecha de la primera cuota',{exact:true}).fill('2024-02-29');
  await page.getByLabel('Número de cuotas',{exact:true}).fill('3');
  const quote=await command('POST','/loan-quotes','Ver cronograma');
  expect(quote.schedule.map((r:{date:string})=>r.date)).toEqual(['2024-02-29','2024-03-31','2024-04-30']);
  expect(quote.totals).toEqual({principal:'1000.00',interest:'20.00',payment:'1020.00'});
  expect(quote.schedule.at(-1).closingPrincipal).toBe('0.00');
  const cents=(s:string)=>BigInt(s.replace('.',''));
  expect(quote.schedule.reduce((n:bigint,r:{principal:string})=>n+cents(r.principal),0n)).toBe(100000n);
  const schedule=page.getByRole('region',{name:'Cronograma simulado'});
  await expect(schedule.getByRole('cell',{name:'2024-02-29',exact:true})).toBeVisible();
  await proof('Guardar los términos de esta simulación');const loan=await command('POST','/loans','Guardar borrador de términos');
  expect(loan.calculation).toMatchObject({totals:quote.totals,schedule:quote.schedule});expect(loan.status).toBe('DRAFT');
  await expect(page.getByRole('button',{name:'Confirmar términos',exact:true})).toBeDisabled();
  await page.getByRole('checkbox',{name:/Confirmo estos términos/}).check();await proof('Confirmar términos');
  await command('POST','/loans/'+loan.id+'/confirmation','Confirmar términos');
  await page.getByRole('button',{name:'Más préstamos',exact:true}).click();
  await expect(page.getByRole('button',{name:'Términos confirmados · versión 1',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Términos confirmados · versión 1',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Historial de términos',exact:true})).toBeVisible();
  await expect(page.getByLabel('Capital',{exact:true})).toHaveValue('1.000');
  await page.getByLabel('Capital',{exact:true}).fill('1.200');await page.getByLabel('Tasa en porcentaje',{exact:true}).fill('0');
  await page.getByLabel('Modalidad').selectOption('LEVEL_PAYMENT');
  const next=await command('POST','/loan-quotes','Ver cronograma');
  expect(next.totals).toEqual({principal:'1200.00',interest:'0.00',payment:'1200.00'});expect(next.schedule.map((r:{payment:string})=>r.payment)).toEqual(['400.00','400.00','400.00']);
  await expect(page.getByRole('checkbox',{name:/Confirmo estos términos/})).toHaveCount(0);
  await page.getByLabel('Motivo del cambio de términos',{exact:true}).fill('Versión dos sintética');await proof('Guardar los términos de esta simulación');
  const replaced=await command('PUT','/loans/'+loan.id+'/terms','Reemplazar términos');expect(replaced.termsVersion).toBe(2);expect(replaced.confirmation).toBeNull();
  await expect(page.getByRole('checkbox',{name:/Confirmo estos términos/})).not.toBeChecked();
  await page.getByRole('checkbox',{name:/Confirmo estos términos/}).check();await proof('Confirmar términos');await command('POST','/loans/'+loan.id+'/confirmation','Confirmar términos');
  await expect(page.getByText('Versión 1: Capital uniforme · capital 1.000 COP')).toBeVisible();
  await expect(page.getByText('Versión 2: Cuota nivelada · capital 1.200 COP')).toBeVisible();
  await page.reload();await page.getByRole('button',{name:'Más préstamos',exact:true}).click();await page.getByRole('button',{name:'Términos confirmados · versión 2',exact:true}).click();
  await expect(page.getByLabel('Capital',{exact:true})).toHaveValue('1.200');
  await expect(page.getByLabel('Tasa en porcentaje',{exact:true})).toHaveValue('0');
  await expect(page.getByRole('button',{name:'Confirmar términos',exact:true})).toHaveCount(0);
  for(const width of [360,390,768,1024,1440]){
    await page.setViewportSize({width,height:900});
    if(process.env.P04_LAYOUT_PROPOSAL==='1'&&!await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)){
      console.log('P04_LAYOUT_PROPOSAL_RUNTIME_ONLY '+JSON.stringify(await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,overflow:Array.from(document.querySelectorAll('main, .panel, fieldset, .split')).map(e=>({tag:e.tagName,class:e.className,width:Math.round(e.getBoundingClientRect().width)}))}))));
      await page.screenshot({path:process.env.P04_VISUAL!.replace('S04-P04-VISUAL.png','S04-P04-RESPONSIVE-BEFORE.png'),fullPage:true});
      await page.addStyleTag({content:'.frame > main, .panel fieldset, .split > .field { min-width: 0; }'});
    }
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'document overflow at '+width).toBe(true);
  }
  await page.evaluate(()=>{document.body.style.zoom='2';});
  await expect(page.getByRole('button',{name:'Preparar un borrador nuevo',exact:true})).toBeVisible();
  await page.evaluate(()=>{document.body.style.zoom='';});
  await page.keyboard.press('Control+Home');await page.keyboard.press('Tab');expect(await page.evaluate(()=>document.activeElement?.tagName)).not.toBe('BODY');
  expect(await page.evaluate(()=>localStorage.length+sessionStorage.length)).toBe(0);
  await page.setViewportSize({width:1024,height:900});await page.screenshot({path:process.env.P04_VISUAL!,fullPage:true});
  await page.getByLabel('Capital',{exact:true}).fill('1.000');
  await page.getByLabel('Modalidad').selectOption('INTEREST_ONLY');
  await page.getByLabel('Clase de tasa').selectOption('NOMINAL_ANNUAL');
  await page.getByLabel('Tasa en porcentaje',{exact:true}).fill('12');
  await page.getByLabel('Períodos de capitalización al año',{exact:true}).fill('12');
  // A second legitimate client refresh invalidates the page's cached token; exercise the existing recovery.
  const fresh=await context.request.get(process.env.P04_URL+'/api/v1/auth/csrf');expect(fresh.status()).toBe(200);
  const errorsBefore=transportErrors.length;
  const interestOnly=await command('POST','/loan-quotes','Ver cronograma');
  expect(transportErrors.length).toBe(errorsBefore+1);
  expect(interestOnly.periodicRate24).toBe('0.010000000000000000000000');
  expect(interestOnly.totals).toEqual({principal:'1000.00',interest:'30.00',payment:'1030.00'});
  expect(interestOnly.schedule.map((r:{principal:string})=>r.principal)).toEqual(['0.00','0.00','1000.00']);
  expect(interestOnly.schedule.at(-1).closingPrincipal).toBe('0.00');
  await page.getByLabel('Fecha de la primera cuota',{exact:true}).fill('2024-03-01');
  const irregular=response('POST','/loan-quotes');await page.getByRole('button',{name:'Ver cronograma',exact:true}).click();
  expect((await irregular).status()).toBe(422);await expect(page.getByRole('alert')).toBeVisible();
  const cookie=(await context.cookies()).find(c=>c.name==='__Host-caudelyx-session');expect(cookie).toBeDefined();
  await control('/complete',{token:cookie!.value,loan:loan.id});
});
