import { useState } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TotpMaterial } from '../../src/features/security/Security';
afterEach(()=>vi.useRealTimers());
it('AT14: borra el material al vencer cinco minutos sin interacción',async()=>{
  vi.useFakeTimers();
  function Fixture(){const[uri,setUri]=useState('otpauth://totp/Caudelyx:timeout@example.test?secret=JBSWY3DPEHPK3PXP&issuer=Caudelyx');return uri?<TotpMaterial uri={uri} onClear={()=>setUri('')}/>:<p>Material retirado</p>;}
  const view=render(<Fixture/>);await act(async()=>{await Promise.resolve();});
  expect(document.body.textContent?.includes('JBSWY3DPEHPK3PXP')).toBe(true);
  await act(async()=>{vi.advanceTimersByTime(300000);});
  expect(document.body.textContent?.includes('JBSWY3DPEHPK3PXP'),'El secreto debe borrarse por timeout').toBe(false);
  expect(document.querySelector('img')).toBeNull();expect(document.querySelector('output')).toBeNull();view.unmount();
});

it('AT14: escribir en el formulario no reinicia el plazo del material',async()=>{
  vi.useFakeTimers();const first=vi.fn(),latest=vi.fn(),uri='otpauth://totp/Caudelyx:timer@example.test?secret=JBSWY3DPEHPK3PXP&issuer=Caudelyx';
  const view=render(<TotpMaterial uri={uri} onClear={first}/>);
  await act(async()=>{vi.advanceTimersByTime(240000);});view.rerender(<TotpMaterial uri={uri} onClear={latest}/>);
  await act(async()=>{vi.advanceTimersByTime(60000);});expect(first).not.toHaveBeenCalled();expect(latest).toHaveBeenCalledOnce();view.unmount();
});
it('AT14: desmontar cancela el temporizador y retira el DOM',async()=>{
  vi.useFakeTimers();const clear=vi.fn(),view=render(<TotpMaterial uri="otpauth://totp/Caudelyx:unmount@example.test?secret=JBSWY3DPEHPK3PXP&issuer=Caudelyx" onClear={clear}/>);
  view.unmount();await act(async()=>{vi.advanceTimersByTime(300000);});expect(clear).not.toHaveBeenCalled();expect(document.querySelector('output')).toBeNull();
});
