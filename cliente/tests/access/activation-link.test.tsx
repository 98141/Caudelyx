import { afterEach, describe, expect, it } from 'vitest';
import { captureActivationLink, clearActivationLink, peekActivation } from '../../src/shared/activation-link';

const token = 'A'.repeat(43);

afterEach(() => {
  clearActivationLink();
  window.history.replaceState(null, '', '/#/ingresar');
});

describe('enlace de activación', () => {
  it('guarda el enlace en memoria y lo quita de la dirección', () => {
    window.history.replaceState(null, '', `/#/activar?purpose=ACTIVATION&token=${token}&legacy=1`);
    captureActivationLink();
    expect(window.location.hash).toBe('#/activar');
    expect(window.location.search).toBe('');
    expect(window.location.href.includes(token)).toBe(false);
    expect(peekActivation()).toEqual({ status: 'ready', purpose: 'ACTIVATION', token, legacyHint: true });
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('rechaza forma inválida, duplicados y secreto en la consulta', () => {
    window.history.replaceState(null, '', `/#/activar?purpose=ACTIVATION&purpose=INITIAL_MFA_PROOF&token=${token}`);
    captureActivationLink();
    expect(peekActivation()).toEqual({ status: 'invalid' });
    expect(window.location.href.includes(token)).toBe(false);
    clearActivationLink();

    window.history.replaceState(null, '', `/?token=${token}#/activar?purpose=ACTIVATION&token=${'B'.repeat(43)}`);
    captureActivationLink();
    expect(peekActivation()).toEqual({ status: 'invalid' });
    expect(window.location.href.includes(token)).toBe(false);
    expect(window.location.search).toBe('');
  });

  it('quita el secreto si la dirección cambia sin recargar', () => {
    window.history.replaceState(null, '', '/#/ingresar');
    captureActivationLink();
    window.location.hash = `#/activar?purpose=ACTIVATION&token=${token}`;
    captureActivationLink();
    expect(window.location.hash).toBe('#/activar');
    expect(window.location.href.includes(token)).toBe(false);
    expect(peekActivation()).toEqual({ status: 'ready', purpose: 'ACTIVATION', token, legacyHint: false });
  });

  it('rechaza escapes malformados y duplicados codificados sin dejar el secreto en la dirección', () => {
    for (const extra of ['%=1', '%E0%A4=1', '%70urpose=ACTIVATION']) {
      clearActivationLink();
      window.history.replaceState(null, '', `/#/activar?purpose=ACTIVATION&token=${token}&${extra}`);
      expect(() => captureActivationLink()).not.toThrow();
      expect(peekActivation()).toEqual({ status: 'invalid' });
      expect(window.location.hash).toBe('#/activar');
      expect(window.location.href.includes(token)).toBe(false);
      expect(localStorage.length + sessionStorage.length).toBe(0);
    }
  });

  it('cerrar sesión borra el secreto de la memoria', () => {
    window.history.replaceState(null, '', `/#/activar?purpose=INITIAL_MFA_PROOF&token=${token}`);
    captureActivationLink();
    clearActivationLink();
    expect(peekActivation()).toBeNull();
    expect(window.location.hash).toBe('#/activar');
  });

  it.each([
    ['#/perfil', '#/perfil'],
    ['#/perfil?tab=seguridad', '#/perfil?tab=seguridad'],
  ])('limpia parámetros de otra ruta sin capturarlos: %s', (route, expected) => {
    window.history.replaceState(null, '', `/#/activar?purpose=ACTIVATION&token=${token}`);
    captureActivationLink();
    window.history.replaceState(null, '', `/${route}${route.includes('?') ? '&' : '?'}purpose=ACTIVATION&token=${token}&legacy=1`);
    captureActivationLink();
    expect(window.location.hash).toBe(expected);
    expect(window.location.href.includes(token)).toBe(false);
    expect(peekActivation()).toBeNull();
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });
});
