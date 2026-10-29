import {render,screen,waitFor,cleanup} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {ObligationActions} from '../../src/features/lending/ObligationActions';
const api=vi.hoisted(()=>({call:vi.fn()}));vi.mock('../../src/shared/api',()=>api);
const ids={book:'11111111-1111-4111-8111-111111111111',entity:'22222222-2222-4222-8222-222222222222',debt:'33333333-3333-4333-8333-333333333333',payable:'44444444-4444-4444-8444-444444444444',expense:'55555555-5555-4555-8555-555555555555',bank:'66666666-6666-4666-8666-666666666666',event:'77777777-7777-4777-8777-777777777777'};
const accounts=[{id:ids.debt,code:'DEUDA',name:'Deuda',accountClass:'LIABILITY'},{id:ids.payable,code:'PAGAR',name:'Por pagar',accountClass:'LIABILITY'},{id:ids.expense,code:'GASTO',name:'Gasto',accountClass:'EXPENSE'},{id:ids.bank,code:'BANCO',name:'Banco',accountClass:'ASSET'}];
afterEach(()=>{cleanup();vi.clearAllMocks();});
function setup(panel='liabilities'){
 const item={id:ids.entity,version:4,label:'Deuda sintética',description:'Servicio sintético',schedule:{id:ids.event,kind:'OFFICIAL_DECLARED',principalOpening:'1000000.00'},events:[{id:ids.event,kind:'EXPENSE_PAY',effectiveDate:'2026-10-28',amount:'40.00',reversalOfId:null}]},send=vi.fn(async()=>({data:{id:ids.entity},etag:'"nuevo"'})),refresh=vi.fn(async()=>{}),setError=vi.fn();api.call.mockImplementation(async(_method:string,path:string)=>({data:path.endsWith('/accounts')?{items:accounts}:item}));
 const props={base:'/me/personal/books/'+ids.book+'/finance-s09',today:'2026-10-28',panel,items:[item],pending:false,setPending:vi.fn(),setError,send,refresh};const rendered=render(<ObligationActions {...props}/>);return{...rendered,item,send,refresh,setError,props};
}
describe('integración de formularios S09 P04',()=>{
 it('envía la cuota por componentes exactos y solo reconoce cuando se declara',async()=>{
  const f=setup(),u=userEvent.setup();await u.selectOptions(screen.getByLabelText('Registro para operar'),ids.entity);await screen.findByText(/Versión consultada/);
  await u.type(screen.getByLabelText('Número de cuota'),'1');for(const[label,value]of [['Principal que se amortiza','200'],['Interés del pago','30'],['Seguro del pago','10'],['Cargos del pago','0']])await u.type(screen.getByLabelText(label!),value!);
  for(const select of screen.getAllByLabelText('Cuenta del principal'))await u.selectOptions(select,ids.debt);await u.selectOptions(screen.getByLabelText('Cuenta de componentes por pagar'),ids.payable);await u.selectOptions(screen.getByLabelText('Cuenta de gasto de componentes'),ids.expense);for(const select of screen.getAllByLabelText('Cuenta de salida'))await u.selectOptions(select,ids.bank);
  await u.selectOptions(screen.getByLabelText('Devengo de componentes'),'no');const support=screen.getAllByLabelText('Soporte de la operación');for(const input of support)await u.type(input,'SYN-SUPPORT');await u.click(screen.getByRole('button',{name:'Confirmar cuota'}));
  await waitFor(()=>expect(f.send).toHaveBeenCalled());const args=f.send.mock.calls[0] as unknown as [string,string,string,Record<string,unknown>,string,string];expect(args[0]).toBe('personalPayLiability');expect(args[3].amount).toBe('240.00');expect(args[3]).not.toHaveProperty('componentRecognitions');expect(api.call).toHaveBeenCalledWith('GET',f.props.base+'/liabilities/'+ids.entity+'?asOf=2026-10-28');expect(args[5]).toBe('"'+ids.entity+':4"');expect(f.setError.mock.calls.every(args=>args[0]===null)).toBe(true);
 });
 it('revierte solo un identificador original recibido, con la ruta del pago',async()=>{
  const f=setup('expenses'),u=userEvent.setup();await u.selectOptions(screen.getByLabelText('Registro para operar'),ids.entity);await u.selectOptions(screen.getByLabelText('Evento a revertir'),ids.event);await u.type(screen.getByLabelText('Motivo de reversión'),'Corrección sintética');for(const input of screen.getAllByLabelText('Soporte de la operación'))await u.type(input,'SYN-REVERSE');await u.click(screen.getByRole('button',{name:'Confirmar reversión'}));await waitFor(()=>expect(f.send).toHaveBeenCalled());const args=f.send.mock.calls[0] as unknown as string[];expect(args[0]).toBe('personalReverseExpensePayment');expect(args[2]).toContain('/payments/'+ids.event+'/reversals');
 });
 it('al cambiar de libro descarta el registro y las cuentas del anterior',async()=>{
  const f=setup(),u=userEvent.setup();await u.selectOptions(screen.getByLabelText('Registro para operar'),ids.entity);expect(screen.getByRole('button',{name:'Confirmar cuota'})).toBeInTheDocument();f.rerender(<ObligationActions {...f.props} base={'/me/personal/books/88888888-8888-4888-8888-888888888888/finance-s09'} items={[]}/>);await waitFor(()=>expect(screen.queryByRole('button',{name:'Confirmar cuota'})).not.toBeInTheDocument());
 });
});
