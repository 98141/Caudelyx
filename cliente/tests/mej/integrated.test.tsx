import {useState} from 'react';
import {act,render,screen,within,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {AuthProvider,useAuth} from '../../src/shared/auth';
import {App} from '../../src/app/App';
import {call,bumpSessionEpoch,resetSessionMemory} from '../../src/shared/api';
import {DiscardedRequest} from '../../src/shared/contracts';
import {StepUpProvider,ensureStepUp} from '../../src/shared/step-up';
import {InvitationForm} from '../../src/features/access/Access';
import {SecurityScreen} from '../../src/features/security/Security';
import {AccountPicker} from '../../src/features/finance/account-picker';
import {clearFlash} from '../../src/shared/flash';
const json=(data:unknown,status=200)=>new Response(JSON.stringify(status>=400?{error:{code:data},requestId:'own'}:{data,requestId:'own'}),{status,headers:{'Content-Type':'application/json'}});
function identity(){const now=Date.now();return {authState:'WORKING',sessionContext:'W',userId:'actor-own',roleIds:['T'],organizationId:'org-own',profile:{displayName:'Persona MEJ4',email:'own@example.test',emailVerified:true,hasFactor:true},session:{serverNow:new Date(now).toISOString(),idleExpiresAt:new Date(now+3600000).toISOString(),absoluteExpiresAt:new Date(now+43200000).toISOString(),balanceVerifiedUntil:null}};}
function install(handler?:(path:string,init?:RequestInit)=>Promise<Response>|Response){
 const me=identity();vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{const path=String(input);
 if(path.endsWith('/auth/csrf'))return json({csrfToken:'own-csrf'});
 if(path.endsWith('/auth/me'))return json(me);
 if(path.endsWith('/auth/logout'))return new Response(null,{status:204});
 return handler?handler(path,init):json({items:[]});}));return me;
}
function Harness(){const {me,logout}=useAuth();const [done,setDone]=useState(false),[error,setError]=useState('');return <><p>{me?.profile?.displayName??'sin cuenta'}</p><button onClick={()=>void ensureStepUp({purpose:'PASSWORD_CHANGE',summary:'Cambiar contraseña'}).then(()=>setDone(true)).catch(e=>setError(e.message))}>Acción protegida</button><button onClick={()=>void logout()}>Salir</button><p>{done?'ejecutada':error}</p></>;}
function shell(child:React.ReactNode){return render(<AuthProvider><StepUpProvider>{child}</StepUpProvider></AuthProvider>);}
beforeEach(()=>{sessionStorage.removeItem('caudelyx-logout-pending');resetSessionMemory();bumpSessionEpoch();clearFlash();window.location.hash='#/seguridad';});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('MEJ4 integración de cliente',()=>{
 it('descarta una respuesta cuyo JSON termina después de cambiar la generación',async()=>{
  let release!:(value:unknown)=>void;let reading!:()=>void;const began=new Promise<void>(r=>reading=r),body=new Promise(r=>release=r);
  vi.stubGlobal('fetch',vi.fn(async()=>({status:200,ok:true,headers:new Headers(),json:()=>{reading();return body;}})));
  const result=call('GET','/late');await began;bumpSessionEpoch();release({data:{actor:'viejo'}});await expect(result).rejects.toBeInstanceOf(DiscardedRequest);
 });
 it('Seguridad W usa modal sin contraseña repetida y ejecuta solo la acción confirmada',async()=>{
  const requests:{path:string;body:unknown}[]=[];install((path,init)=>{requests.push({path,body:init?.body?JSON.parse(String(init.body)):null});
   if(path.endsWith('/intents'))return json({intentId:'intent-own',expiresAt:new Date(Date.now()+300000).toISOString(),method:'TOTP'});
   if(path.endsWith('/step-up/verify'))return json({verifiedClass:'SECURITY_ONE_SHOT',proofExpiresAt:new Date(Date.now()+300000).toISOString()});
   if(path.endsWith('/recovery-codes/regenerate'))return json({codes:['SYNTHETIC-ONE-USE']});return json({items:[]});});
  window.location.hash='#/seguridad?seccion=recuperacion';shell(<SecurityScreen/>);const user=userEvent.setup();await user.click(await screen.findByRole('button',{name:'Regenerar'}));
  const dialog=await screen.findByRole('dialog');expect(within(dialog).queryByLabelText('Contraseña')).toBeNull();await user.click(within(dialog).getByRole('button',{name:'Pedir código'}));
  await user.type(within(dialog).getByLabelText('Código de 6 dígitos'),'123456');await user.click(within(dialog).getByRole('button',{name:'Confirmar'}));
  expect(await screen.findByText('SYNTHETIC-ONE-USE')).toBeInTheDocument();expect(requests.some(x=>x.path.endsWith('/reauthenticate'))).toBe(false);expect(requests.filter(x=>x.path.endsWith('/recovery-codes/regenerate'))).toHaveLength(1);
 });
 it('cancelar durante una preparación tardía no ejecuta ni contamina la siguiente acción',async()=>{
  let release!:(value:Response)=>void;const delayed=new Promise<Response>(r=>release=r);install(path=>path.endsWith('/intents')?delayed:json({items:[]}));shell(<Harness/>);const user=userEvent.setup();
  await screen.findByText('Persona MEJ4');await user.click(screen.getByRole('button',{name:'Acción protegida'}));const dialog=await screen.findByRole('dialog');await user.click(within(dialog).getByRole('button',{name:'Pedir código'}));await user.click(within(dialog).getByRole('button',{name:'Cancelar'}));
  await act(async()=>release(json({intentId:'old',method:'TOTP',expiresAt:new Date(Date.now()+300000).toISOString()})));expect(screen.queryByRole('dialog')).toBeNull();expect(screen.queryByText('ejecutada')).toBeNull();
  await user.click(screen.getByRole('button',{name:'Acción protegida'}));expect(within(await screen.findByRole('dialog')).getByRole('button',{name:'Pedir código'})).toBeInTheDocument();
 });
 it('salir retira el modal y cancela su promesa; no resuelve la acción',async()=>{
  install();shell(<Harness/>);const user=userEvent.setup();await screen.findByText('Persona MEJ4');await user.click(screen.getByRole('button',{name:'Acción protegida'}));await screen.findByRole('dialog');await user.click(screen.getByRole('button',{name:'Salir'}));
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());expect(screen.queryByText('ejecutada')).toBeNull();expect(screen.getByText('sin cuenta')).toBeInTheDocument();
 });
 it('una W visible que vence limpia datos sin esperar una interacción nueva',async()=>{
  vi.useFakeTimers();const me=install();me.session.idleExpiresAt=new Date(Date.now()+1000).toISOString();render(<AuthProvider><App/></AuthProvider>);await act(async()=>{await Promise.resolve();await Promise.resolve();});
  await act(async()=>{await vi.advanceTimersByTimeAsync(16000);});expect(screen.queryByText('Hola, Persona MEJ4')).toBeNull();expect(window.location.hash).toBe('#/ingresar');
 });
 it('la invitación reconoce W sin exigir factor al destinatario y envía CONFIRM exacto',async()=>{
  const sent:unknown[]=[];const recipient=install((path,init)=>{if(path.endsWith('/invitations/accept')){sent.push(JSON.parse(String(init?.body)));return json({nextAction:'CONTINUE'});}return json({items:[]});});recipient.profile.hasFactor=false;shell(<InvitationForm/>);const user=userEvent.setup();await waitFor(()=>expect(screen.queryByText(/Hace falta ingresar/)).toBeNull());expect(screen.queryByText(/ya comprobada con factor/)).toBeNull();expect(screen.queryByLabelText('Contraseña')).toBeNull();const token='A'.repeat(43);await user.type(screen.getAllByLabelText('Código de invitación')[0],token);await user.click(screen.getByRole('button',{name:'Confirmar invitación'}));await screen.findByText(/Invitación confirmada por el servidor/);expect(sent).toEqual([{mode:'CONFIRM',token}]);
 });
 it('R_REQUIRED vuelve a pedir prueba sin reenviar la mutación ni cerrar W',async()=>{
  let commands=0;install(path=>{if(path.endsWith('/intents'))return json({intentId:'proof-own',method:'TOTP',expiresAt:new Date(Date.now()+300000).toISOString()});if(path.endsWith('/step-up/verify'))return json({verifiedClass:'SECURITY_ONE_SHOT',proofExpiresAt:new Date(Date.now()+300000).toISOString()});if(path.endsWith('/password/change')){commands++;return json('R_REQUIRED',403);}return json({items:[]});});
  shell(<Harness/>);const user=userEvent.setup();await screen.findByText('Persona MEJ4');await user.click(screen.getByRole('button',{name:'Acción protegida'}));const first=await screen.findByRole('dialog');await user.click(within(first).getByRole('button',{name:'Pedir código'}));await user.type(within(first).getByLabelText('Código de 6 dígitos'),'123456');await user.click(within(first).getByRole('button',{name:'Confirmar'}));await screen.findByText('ejecutada');await act(async()=>{await call('POST','/auth/password/change',{newPassword:'Synthetic new password 458739'}).catch(()=>undefined);});
  const reopened=await screen.findByRole('dialog');expect(within(reopened).getByRole('button',{name:'Pedir código'})).toBeInTheDocument();expect(commands).toBe(1);expect(screen.getByText('Persona MEJ4')).toBeInTheDocument();await user.click(within(reopened).getByRole('button',{name:'Cancelar'}));expect(commands).toBe(1);
 });
 it('un cierre pendiente sobrevive al remontaje sin consultar ni exponer la sesión anterior',async()=>{
  let release!:(value:Response)=>void;const blocked=new Promise<Response>(r=>release=r);let meCalls=0;const me=identity();
  vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{const path=String(input);if(path.endsWith('/auth/csrf'))return json({csrfToken:'own-csrf'});if(path.endsWith('/auth/me')){meCalls++;return json(me);}if(path.endsWith('/auth/logout'))return blocked;return json({items:[]});}));
  const first=shell(<Harness/>),user=userEvent.setup();await screen.findByText('Persona MEJ4');await user.click(screen.getByRole('button',{name:'Salir'}));expect(sessionStorage.getItem('caudelyx-logout-pending')).toBe('1');expect(window.location.hash).toContain('salida=pendiente');first.unmount();const count=meCalls;
  const second=render(<AuthProvider><App/></AuthProvider>);await act(async()=>{await Promise.resolve();});expect(meCalls).toBe(count);expect(screen.queryByRole('navigation',{name:'Secciones'})).toBeNull();expect(screen.queryByRole('button',{name:'Iniciar sesión'})).toBeNull();second.unmount();await act(async()=>release(new Response(null,{status:204})));sessionStorage.removeItem('caudelyx-logout-pending');
 });
 it('el selector busca globalmente en el servidor y conserva restricciones de clase',async()=>{
  const urls:string[]=[];install((path)=>{urls.push(path);return json({items:[],nextCursor:null});});
  function Picker(){const [id,setId]=useState('');return <AccountPicker base="/organizations/org-own/financial" value={id} onChange={setId} label="Caja destino" accountClass="ASSET" kinds={['CASH']} status="ACTIVE"/>;}
  render(<Picker/>);const user=userEvent.setup();await user.type(screen.getByRole('combobox',{name:'Caja destino'}),'Caja remota');await waitFor(()=>expect(urls.some(path=>path.includes('q=Caja+remota'))).toBe(true));
 });
});
