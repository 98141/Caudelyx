// MEJ-4 adapted version by Codex; original read-only: opening/s03-p04-integration
import {render,screen,within,waitFor,fireEvent} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe,it,expect,vi} from 'vitest';
import {OpeningWizard} from '../../../src/features/opening/Opening';
import {AuthProvider} from '../../../src/shared/auth';

const org='11111111-1111-4111-8111-111111111111',id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const account='22222222-2222-4222-8222-222222222222',support='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const report={issues:[],totals:{assets:'100.00',liabilities:'0.00',equity:'100.00',debit:'100.00',credit:'100.00',balanceDifference:'0.00',ledgerDifference:'0.00',principal:'0.00',recognizedInterest:'0.00',informationalInterest:'0.00'},proposedLines:[]};
const validation={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',validatedAt:'2026-10-23T00:00:00.000Z',contentVersion:1,fingerprint:'ab'.repeat(32),report};
function reply(data:unknown,etag?:string){return new Response(JSON.stringify({data,requestId:'p04-synthetic'}),{status:200,headers:{'Content-Type':'application/json',...(etag?{ETag:etag}:{})}});}
function mount(status:string){
  let reads=0;
  let file={id,version:1,contentVersion:1,status,financialScope:'BUSINESS',currency:'COP',predecessorId:null,validation:status==='DRAFT'?null:validation,approval:null,commit:null,cancellation:null,
    snapshot:{cutoffDate:'2020-01-01',supports:[{id:support,reference:'SYNTHETIC-P04',asOfDate:'2020-01-01',declaration:'DECLARED'}],references:[],components:[{id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',category:'BANK',accountId:account,amount:'100.00',supportIds:[support]}],historicalInterest:[],informationalHistory:[]}};
  vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=String(input);
    if(path.endsWith('/auth/csrf'))return reply({csrfToken:'synthetic-csrf'});
    if(path.endsWith('/auth/me'))return reply({authState:'ACTIVE',userId:'synthetic-user',organizationId:org});
    if(path.endsWith('/auth/reauthenticate')||path.endsWith('/auth/mfa/challenges/verify'))return reply({nextAction:'READY'});
    if(path.endsWith('/validations')&&init?.method==='POST'){
      file={...file,status:'VALIDATED',version:2,validation};return reply({opening:file,report,validation},`"${id}:2"`);
    }
    if(path.endsWith('/opening-files/'+id)){reads++;return reply(file,`"${id}:${file.version}"`);}
    if(path.includes('/opening-files'))return reply({items:[{id,status,version:1,cutoffDate:'2020-01-01',updatedAt:'2026-10-23T00:00:00.000Z'}],nextCursor:null});
    if(path.includes('/accounts'))return reply(path.includes('?')?{items:[],nextCursor:null}:{id:account,code:'BANK',name:'Banco sintético',accountClass:'ASSET',kind:'BANK',status:'ACTIVE',version:1,currency:'COP'});
    throw Error('Unexpected synthetic UI route');
  }));
  render(<AuthProvider><OpeningWizard organizationId={org} base={`/organizations/${org}/financial`}/></AuthProvider>);
  return {reads:()=>reads};
}
async function resume(){const user=userEvent.setup();await user.click(await screen.findByRole('button',{name:'Reanudar 2020-01-01'}));await screen.findByRole('heading',{name:'Resumen previo'});return user;}

describe('P04 UI integration findings',()=>{
  it('requires explicit save before validating an approved file',async()=>{
    mount('APPROVED');await resume();
    expect(screen.queryByRole('button',{name:'Validar con el servidor'})).not.toBeInTheDocument();
    expect(screen.getByText(/vuelve a guardarlo con un motivo/)).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Guardar borrador de apertura'})).toBeEnabled();
  });
  it('updates the visible list row from the real validation response',async()=>{
    mount('DRAFT');const user=await resume();
    const form=screen.getByRole('button',{name:'Validar con el servidor'}).closest('form')!;
    await user.click(within(form).getByRole('button',{name:'Validar con el servidor'}));
    await screen.findByText(/Estado VALIDATED/);
    const row=screen.getByRole('heading',{name:'Corte 2020-01-01'}).closest('article')!;
    expect(within(row).getByText(/Estado del expediente: VALIDATED/)).toHaveTextContent('Versión 2');
  });
  for(const [status,label] of [['VALIDATED',/Apruebo el expediente validado/],['APPROVED',/Confirmo el corte, los soportes/]] as const){
    it(`requires renewed explicit consent when resuming ${status}`,async()=>{
      const f=mount(status),user=await resume();
      await user.click(screen.getByRole('checkbox',{name:label}));expect(screen.getByRole('checkbox',{name:label})).toBeChecked();
      await user.click(screen.getByRole('button',{name:'Reanudar 2020-01-01'}));await waitFor(()=>expect(f.reads()).toBe(2));
      await waitFor(()=>expect(screen.getByRole('checkbox',{name:label})).not.toBeChecked());
      if(status==='VALIDATED'){
        await user.click(screen.getByRole('checkbox',{name:label}));
        await user.click(screen.getByRole('button',{name:'Corte y ámbito'}));
        const cutoff=screen.getByLabelText('Fecha de corte de la apertura');
        fireEvent.change(cutoff,{target:{value:'2020-01-02'}});
        fireEvent.change(cutoff,{target:{value:'2020-01-01'}});
        expect(screen.getByRole('checkbox',{name:label})).not.toBeChecked();
      }
    });
  }
});

// Unit boundary only. Actual factor/HTTP authority is exercised by MEJ4 HTTPS/E2E.
vi.mock('../../../src/shared/step-up', () => ({ensureStepUp: vi.fn().mockResolvedValue(undefined), StepUpProvider: ({children}: {children: unknown}) => children}));
