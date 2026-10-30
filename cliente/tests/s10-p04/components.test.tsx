import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {render,screen,within,cleanup} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {WealthScreen} from '../../src/features/lending/Wealth';
import {AuthProvider} from '../../src/shared/auth';
import {ApiError,type Me} from '../../src/shared/contracts';
const proof=vi.hoisted(()=>vi.fn(async(request:unknown)=>{void request;}));
vi.mock('../../src/shared/step-up',()=>({ensureStepUp:proof}));
const org='11111111-1111-4111-8111-111111111111',actor='22222222-2222-4222-8222-222222222222',bank='33333333-3333-4333-8333-333333333333',fund='44444444-4444-4444-8444-444444444444',book='55555555-5555-4555-8555-555555555555';
const person=(roles=['T']):Me=>({authState:'ACTIVE',userId:actor,organizationId:org,roleIds:roles,profile:{displayName:'Sintética',email:'s10@example.test',emailVerified:true}});
const json=(data:unknown,status=200,etag?:string)=>new Response(JSON.stringify(status>=400?{error:{code:status===409?'REPORT_SNAPSHOT_STALE':'SERVICE_UNAVAILABLE'},requestId:'SYN'}:{data,meta:{scope:'BUSINESS',coverage:'COMPLETE',reasons:[]},requestId:'SYN'}),{status,headers:{'Content-Type':'application/json',...(etag?{ETag:etag}:{})}});
type Post={path:string;body:Record<string,unknown>;key:string|null;etag:string|null};
function setup(options:{roles?:string[];lost?:boolean;stale?:boolean;lateBook?:boolean}={}) {
 const posts:Post[]=[],gets:string[]=[];let version=0,releaseBook=()=>{};
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=String(input); if(init?.method==='POST'&&path.includes('/wealth-s10/')){posts.push({path,body:JSON.parse(String(init.body)),key:new Headers(init.headers).get('Idempotency-Key'),etag:new Headers(init.headers).get('If-Match')});if(options.lost&&posts.length===1)throw new TypeError('Lost response after commit');return json({eventId:'event',resourceId:fund,version:2,journalIds:[],unitKnownAt:'2026-10-29T17:00:00.000Z'},posts.length>1?200:201);}
  gets.push(path);if(path.endsWith('/auth/csrf'))return json({csrfToken:'csrf'});if(path.endsWith('/auth/me'))return json(person(options.roles));if(path.endsWith('/me/personal/book'))return options.lateBook?new Promise<Response>(resolve=>{releaseBook=()=>resolve(json({id:book}));}):json({id:book});
  if(path.includes('/wealth-s10/book?'))return json({id:org,scope:'BUSINESS',currency:'COP'},200,'"book-'+(++version)+'"');
  if(path.includes('/funds/'+fund+'?'))return json({id:fund,label:'Ahorro de negocio',reserved:'20000000.00'},200,'"fund-'+version+'"');
  if(path.includes('/funds?'))return json({items:[{id:fund,label:'Ahorro de negocio',status:'ACTIVE'}],nextCursor:null});
  if(path.includes('/assets?'))return options.stale?json({},409):json({items:[],nextCursor:null});
  if(path.includes('/financial/accounts?')||path.includes('/finance-s09/accounts?'))return json({items:[{id:bank,name:'Banco sintético',code:'BANK',status:'ACTIVE',accountClass:'ASSET',kind:'BANK'}],nextCursor:null});
  if(path.includes('/positions?'))return json({recognizedAssetCost:'200000000.00',ownedEstimatedValue:null,linkedPrincipal:'0.00',cashAvailable:'0.00',rentCashReceived:'0.00'});
  if(path.includes('/me/private-wealth?'))return json({personal:{recognizedAssetCost:'0.00',ownedEstimatedValue:null,linkedPrincipal:'0.00'},business:null,indicativeOwnedAssets:null,eliminations:[]});
  return json({},404);
 }));
 render(<AuthProvider><WealthScreen /></AuthProvider>);return {posts,gets,releaseBook:()=>releaseBook()};
}
async function releaseForm(user:ReturnType<typeof userEvent.setup>) {
 await user.click(await screen.findByRole('button',{name:'Asignar, liberar o trasladar ahorro'}));await user.click(screen.getByRole('button',{name:'Cargar fondos, activos y cuentas'}));
 const form=await screen.findByRole('form',{name:'Asignar, liberar o trasladar ahorro'});await user.selectOptions(within(form).getByLabelText('Fondo a operar'),fund);await user.type(within(form).getByLabelText('Importe del fondo'),'20.000.000');await user.type(within(form).getByLabelText('Soporte de la operación'),'SYN');return form;
}
describe('S10-P04 integration component boundaries',()=>{
 beforeEach(()=>proof.mockClear());afterEach(()=>{cleanup();vi.unstubAllGlobals();sessionStorage.clear();});
 it('uses required book cut and exact MEJ resource/path bindings when releasing20M',async()=>{
  const user=userEvent.setup(),{posts,gets}=setup(),form=await releaseForm(user);await user.click(within(form).getByRole('button',{name:'Revisar operación'}));await user.click(await within(form).findByRole('button',{name:'Confirmar operación'}));await screen.findByText(/Operación registrada por el servidor/);
  expect(posts).toHaveLength(1);expect(posts[0].body.amount).toBe('20000000.00');expect(posts[0].body.bookETag).toBe('"book-1"');expect(gets.some(p=>p.includes('/book?asOf='))).toBe(true);
  const request=proof.mock.calls.at(-1)?.[0] as unknown as {command:{pathParameters:unknown};resourceId:string};expect(request.command.pathParameters).toEqual({organizationId:org,fundId:fund});expect(request.resourceId).toBe(fund);
 });
 it('lost response keeps exact original key, payload and ETag even after a fresh preview',async()=>{
  const user=userEvent.setup(),{posts}=setup({lost:true}),form=await releaseForm(user);await user.click(within(form).getByRole('button',{name:'Revisar operación'}));await user.click(await within(form).findByRole('button',{name:'Confirmar operación'}));await screen.findByText(/No se confirmó la operación/);
  await user.selectOptions(within(form).getByLabelText('Acción del fondo'),'AllocateFund');await user.selectOptions(within(form).getByLabelText('Acción del fondo'),'ReleaseFund');await user.click(within(form).getByRole('button',{name:'Revisar operación'}));await user.click(await within(form).findByRole('button',{name:'Confirmar operación'}));await screen.findByText(/Operación registrada por el servidor/);
  expect(posts).toHaveLength(2);expect(posts[1]).toEqual(posts[0]);
 });
 it('does not reuse uncertain write key for a different economic command',async()=>{
  const user=userEvent.setup(),{posts}=setup({lost:true}),form=await releaseForm(user);await user.click(within(form).getByRole('button',{name:'Revisar operación'}));await user.click(await within(form).findByRole('button',{name:'Confirmar operación'}));await screen.findByText(/No se confirmó la operación/);
  const input=within(form).getByLabelText('Importe del fondo');await user.clear(input);await user.type(input,'1');await user.click(within(form).getByRole('button',{name:'Revisar operación'}));await user.click(await within(form).findByRole('button',{name:'Confirmar operación'}));await screen.findByText(/Hay una confirmación pendiente/);expect(posts).toHaveLength(1);
 });
 it('failed confirmation leaves the economic draft intact and sends no mutation',async()=>{
  const user=userEvent.setup(),{posts}=setup(),form=await releaseForm(user);proof.mockRejectedValueOnce(new ApiError(503,'SERVICE_UNAVAILABLE',null,'No se pudo abrir la confirmación.'));
  await user.click(within(form).getByRole('button',{name:'Revisar operación'}));await user.click(await within(form).findByRole('button',{name:'Confirmar operación'}));await screen.findByText('No se pudo abrir la confirmación.');expect(within(form).getByLabelText('Importe del fondo')).toHaveValue('20.000.000');expect(posts).toHaveLength(0);
 });
 it('uses closed private query and never displays missing estimate as zero',async()=>{
  const user=userEvent.setup(),{gets}=setup();await user.click(await screen.findByRole('button',{name:/^Personal$/}));await user.click(screen.getByRole('button',{name:'Ver consolidado privado'}));await screen.findByRole('heading',{name:'Consolidado privado'});expect(gets.find(p=>p.includes('/me/private-wealth?'))).not.toContain('limit=');expect(screen.getAllByText('Sin dato del servidor').length).toBeGreaterThan(0);
 });
 it('scope change remounts forms and does not copy the business draft into PERSONAL',async()=>{
  const user=userEvent.setup();setup();await user.type(await screen.findByRole('textbox',{name:/^Nombre$/}),'BORRADOR PRIVADO NEGOCIO');await user.click(screen.getByRole('button',{name:/^Personal$/}));expect(screen.getByRole('textbox',{name:/^Nombre$/})).toHaveValue('');expect(Object.entries(sessionStorage).some(([k,v])=>k.includes('PERSONAL')&&v.includes('BORRADOR PRIVADO NEGOCIO'))).toBe(false);
 });
 it('late personal book lookup is independent of an earlier BUSINESS list request',async()=>{
  const user=userEvent.setup(),state=setup({lateBook:true});await user.click(await screen.findByRole('button',{name:'Ver fondos'}));await screen.findByText('Ahorro de negocio');state.releaseBook();await user.click(screen.getByRole('button',{name:/^Personal$/}));await vi.waitFor(()=>expect(screen.getByRole('button',{name:'Ver fondos'})).toBeEnabled());
 });
 it('T+SA cannot select BUSINESS or send organization reads',async()=>{
  const user=userEvent.setup(),{gets}=setup({roles:['T','SA']});await screen.findByText(/Este ámbito de negocio no está en tu rol/);expect(screen.queryByRole('button',{name:/^Negocio$/})).toBeNull();await user.click(screen.getByRole('button',{name:'Ver fondos'}));await vi.waitFor(()=>expect(gets.some(p=>p.includes('/wealth-s10/funds'))).toBe(true));expect(gets.some(p=>p.includes('/organizations/'))).toBe(false);
 });
 it('stale read clears previously rendered financial totals',async()=>{
  const user=userEvent.setup();setup({stale:true});await user.click(await screen.findByRole('button',{name:'Ver posición'}));await screen.findByText('200.000.000 COP');await user.click(screen.getByRole('button',{name:'Ver activos'}));await vi.waitFor(()=>expect(screen.queryByText('200.000.000 COP')).toBeNull());
 });
});
