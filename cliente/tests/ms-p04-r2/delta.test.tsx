import {describe,it,expect,vi} from 'vitest';
import {render,screen,fireEvent} from '@testing-library/react';
import {CrossAccountSelect} from '../../src/features/simple/CrossSelectors';
import {localDateTime} from '../../src/features/simple/widgets';
describe('v2 labeled explicit selections and readable dates',()=>{
 it('formats the knowledge timestamp in Bogota without an ISO string',()=>{const text=localDateTime('2026-12-03T15:00:30.553Z');expect(text).toContain('2026');expect(text).not.toContain('T15:');expect(localDateTime('invalid')).toBe('Fecha no disponible');});
 it('has no implicit account choice and sends only the selected authenticated ID',()=>{const change=vi.fn();render(<CrossAccountSelect label="Banco personal" items={[{id:'synthetic-id',name:'Cuenta sintética',code:'P_BANK',accountClass:'ASSET',kind:'BANK'}]} value="" onChange={change}/>);const field=screen.getByLabelText('Banco personal');expect(field).toHaveValue('');expect(screen.queryByRole('textbox')).toBeNull();expect(screen.getByRole('option',{name:'P_BANK · Cuenta sintética'})).toBeVisible();fireEvent.change(field,{target:{value:'synthetic-id'}});expect(change).toHaveBeenCalledWith('synthetic-id');});
});
