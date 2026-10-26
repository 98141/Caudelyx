import {render,screen,within,waitFor,act} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe,it,expect,vi} from 'vitest';
import {AuthProvider,useAuth} from '../../src/shared/auth';
import {FinanceScreen} from '../../src/features/finance/Finance';
import {HomeScreen} from '../../src/features/home/Home';
import {InitialBalances} from '../../src/features/finance/InitialBalances';
import {StepUpProvider,ensureStepUp} from '../../src/shared/step-up';
import {useSessionActivity} from '../../src/shared/session-activity';
import {LocalMailboxHint} from '../../src/shared/ui';
import {call} from '../../src/shared/api';
const org='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const account={id,code:'CAJA_C1',name:'Caja C1',accountClass:'ASSET',kind:'CASH',status:'ACTIVE',version:1,currency:'COP'};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(status>=400?{error:{code:data}}:{data}),{status,headers:{'Content-Type':'application/json'}});
function install(extra?:(path:string,init?:RequestInit)=>Response|Promise<Response>){
 const now=Date.now(),me={sessionContext:'W',authState:'WORKING',userId:'c1-owner',roleIds:['T'],organizationId:org,profile:{displayName:'Persona C1',emailVerified:true,hasFactor:true},session:{serverNow:new Date(now).toISOString(),idleExpiresAt:new Date(now+3600000).toISOString(),absoluteExpiresAt:new Date(now+43200000).toISOString(),balanceVerifiedUntil:null}},urls:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{const path=String(input);urls.push(path);
  if(path.endsWith('/auth/me'))return json(structuredClone(me));if(path.endsWith('/auth/csrf'))return json({csrfToken:'csrf-C1'});if(path.endsWith('/organization'))return json({id:org,status:'ACTIVE',actorRoleIds:me.roleIds});
  if(extra){const custom=await extra(path,init);return custom;}return json(path.includes('/journal-entries')?{items:[],nextCursor:null}:path.endsWith('/'+id)?account:{items:[account],nextCursor:null});}));return{me,urls};
}
function Renew(){const auth=useAuth();return <><button onClick={()=>{if(auth.me?.session)auth.applySession({...auth.me.session,serverNow:new Date().toISOString()});}}>Renovar metadata</button><button onClick={()=>void auth.refresh()}>Consultar identidad</button></>;}
function Protected(){return <button onClick={()=>void ensureStepUp({purpose:'PASSWORD_CHANGE',summary:'Cambiar contraseña'}).then(()=>call('POST','/auth/password/change',{newPassword:'Synthetic C1 password 462915'})).catch(()=>undefined)}>Acción</button>;}
const shell=(child:React.ReactNode)=>render(<AuthProvider><Renew/>{child}</AuthProvider>);

describe('MEJ-C1 correcciones post revisión',()=>{
 it('R1: conserva pestaña, cuenta, importe y texto al renovar y reconsultar la misma autoridad',async()=>{
  const f=install();shell(<FinanceScreen/>);const user=userEvent.setup();await user.click(await screen.findByRole('tab',{name:'Movimientos'}));const form=within(screen.getByRole('region',{name:'Asiento'}));
  await user.type(form.getByLabelText('Descripción'),'Borrador que debe permanecer');await user.type(form.getAllByLabelText('Importe')[0],'610,25');await user.click(form.getByRole('combobox',{name:'línea 1'}));await user.click(await screen.findByRole('option',{name:/CAJA_C1/}));const selected=form.getByRole('combobox',{name:'línea 1'}) as HTMLInputElement;const label=selected.value;
  await user.click(screen.getByRole('tab',{name:'Cuentas'}));await user.click(screen.getByRole('tab',{name:'Movimientos'}));await user.click(screen.getByRole('button',{name:'Renovar metadata'}));await user.click(screen.getByRole('button',{name:'Consultar identidad'}));await waitFor(()=>expect(f.urls.filter(p=>p.endsWith('/auth/me'))).toHaveLength(2));
  expect(screen.getByRole('tab',{name:'Movimientos'})).toHaveAttribute('aria-selected','true');expect(form.getByLabelText('Descripción')).toHaveValue('Borrador que debe permanecer');expect(form.getAllByLabelText('Importe')[0]).toHaveValue('610,25');expect(selected).toHaveValue(label);expect(f.urls.filter(p=>p.endsWith('/organization'))).toHaveLength(1);
 });
 it('R1 negativo: un cambio real de rol retira el libro anterior',async()=>{
  const f=install();shell(<FinanceScreen/>);const user=userEvent.setup();await screen.findByRole('tab',{name:'Cuentas'});f.me.roleIds=['L'];await user.click(screen.getByRole('button',{name:'Consultar identidad'}));await waitFor(()=>expect(screen.queryByRole('tab',{name:'Cuentas'})).toBeNull());
 });
 it('Inicio conserva lecturas por metadata y muestra org/caja/saldo/prestatario/préstamo',async()=>{
  const f=install();shell(<HomeScreen/>);await screen.findByText(/5. Crear un préstamo. Hecho/);const before=f.urls.length;const user=userEvent.setup();await user.click(screen.getByRole('button',{name:'Renovar metadata'}));await act(async()=>{await Promise.resolve();});expect(f.urls.length).toBe(before);expect(screen.getAllByRole('listitem')).toHaveLength(5);
 });
 it('F7: pointerdown más click de Seguir conectado producen un solo POST',async()=>{
  const f=install(path=>path.endsWith('/activity')?json({session:{...f.me.session,serverNow:new Date().toISOString()}}):json({items:[]}));
  function Activity(){const auth=useAuth(),activity=useSessionActivity({enabled:auth.phase==='ready',clock:auth.clock,onSession:auth.applySession,onExpired:auth.expire});return <><p>{auth.phase}</p><button data-session-activity="explicit" onClick={()=>void activity.stayConnected()}>Seguir conectado</button></>;}
  render(<AuthProvider><Activity/></AuthProvider>);await screen.findByText('ready');const user=userEvent.setup();await user.click(screen.getByRole('button',{name:'Seguir conectado'}));await waitFor(()=>expect(f.urls.filter(p=>p.endsWith('/activity'))).toHaveLength(1));
 });
 it('F13: prepara el intento automáticamente y confirma con un único botón',async()=>{
  let commands=0;const f=install(path=>{if(path.endsWith('/intents'))return json({intentId:'c1-intent',method:'TOTP',expiresAt:new Date(Date.now()+300000).toISOString()});if(path.endsWith('/step-up/verify'))return json({verifiedClass:'SECURITY_ONE_SHOT'});if(path.endsWith('/password/change')){commands++;return json({});}return json({items:[]});});shell(<StepUpProvider><Protected/></StepUpProvider>);const user=userEvent.setup();await user.click(screen.getByRole('button',{name:'Acción'}));const dialog=await screen.findByRole('dialog');await waitFor(()=>expect(within(dialog).getByRole('button',{name:'Confirmar'})).toBeEnabled());expect(screen.queryByRole('button',{name:'Pedir código'})).toBeNull();await user.type(within(dialog).getByLabelText('Código de 6 dígitos'),'123456');await user.click(within(dialog).getByRole('button',{name:'Confirmar'}));await waitFor(()=>expect(commands).toBe(1));expect(f.urls.filter(p=>p.endsWith('/intents'))).toHaveLength(1);
 });
 it.each(['R_REQUIRED','REAUTH_REQUIRED'])('F6: %s abre prueba nueva sin reenviar la mutación',async code=>{
  let commands=0;install(path=>{if(path.endsWith('/intents'))return json({intentId:'c1-intent',method:'TOTP',expiresAt:new Date(Date.now()+300000).toISOString()});if(path.endsWith('/step-up/verify'))return json({verifiedClass:'SECURITY_ONE_SHOT'});if(path.endsWith('/password/change')){commands++;return json(code,403);}return json({items:[]});});shell(<StepUpProvider><Protected/></StepUpProvider>);const user=userEvent.setup();await user.click(screen.getByRole('button',{name:'Acción'}));const first=await screen.findByRole('dialog');await waitFor(()=>expect(within(first).getByRole('button',{name:'Confirmar'})).toBeEnabled());await user.type(within(first).getByLabelText('Código de 6 dígitos'),'123456');await user.click(within(first).getByRole('button',{name:'Confirmar'}));await waitFor(()=>expect(commands).toBe(1));await screen.findByRole('dialog');expect(commands).toBe(1);await user.click(screen.getByRole('button',{name:'Cancelar'}));
 });
 it('F8: muestra éxito después del registro confirmado de saldo inicial',async()=>{
  install((path,init)=>path.includes('/accounts/')?json(account):path.includes('/accounts')?json({items:[account]}):path.includes('/initial-balances')&&init?.method==='POST'?json({initialBalanceRecorded:true}):json({items:[]}));shell(<InitialBalances base={'/organizations/'+org+'/financial'} organizationId={org} onRecorded={async()=>undefined}/>);const user=userEvent.setup();await screen.findByRole('heading',{name:'Registrar saldo inicial'});await user.type(screen.getByLabelText('Soporte'),'SYN-C1');await user.click(screen.getByRole('combobox',{name:'cuenta 1'}));await user.click(await screen.findByRole('option',{name:/CAJA_C1/}));await user.type(screen.getByLabelText('Monto'),'100');await user.click(screen.getByRole('button',{name:'Revisar'}));await user.click(screen.getByRole('button',{name:'Registrar'}));await screen.findByText(/Saldo inicial registrado. El servidor confirmó/);
 });
 it('F10: hint de desarrollo local sin env privada y oculto en producción sin flag',()=>{
  vi.stubEnv('VITE_CAUDELYX_MODE','');vi.stubEnv('DEV',true);const view=render(<LocalMailboxHint/>);expect(screen.getByText(/Modo local sintético/)).toBeInTheDocument();vi.stubEnv('DEV',false);view.rerender(<LocalMailboxHint/>);expect(screen.queryByText(/Modo local sintético/)).toBeNull();
 });
});
