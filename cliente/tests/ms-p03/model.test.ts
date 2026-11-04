import { describe, expect, it } from 'vitest';
import { createSlot, keyFor, markUncertain } from '../../src/features/simple/memory';
import { fractionGap, metricText, percentToFraction, percentToRate, presentedDifference } from '../../src/features/simple/model';
import type { Metric } from '../../src/features/simple/types';

function metric(value: string | null, status: Metric['status']): Metric {
  return { value, status, reasons: [], sourceRefs: [] };
}

describe('cifras de modo simple', () => {
  it('no pinta null ni no disponible como cero', () => {
    expect(metricText(metric(null, 'UNAVAILABLE'))).toBe('No disponible');
    expect(metricText(metric(null, 'COMPLETE'))).toBe('No disponible');
    expect(metricText(metric('0.00', 'COMPLETE'))).toBe('0 COP');
    expect(metricText(metric('270000.00', 'INCOMPLETE'))).toContain('parcial');
    expect(metricText(metric('270000.00', 'INCOMPLETE'))).not.toBe('0 COP');
  });

  it('solo resta cuando las dos cifras están completas', () => {
    expect(presentedDifference(metric('270000.00', 'COMPLETE'), metric(null, 'UNAVAILABLE'))).toBe('No disponible');
    expect(presentedDifference(metric('270000.00', 'COMPLETE'), metric('100000.00', 'COMPLETE'))).toContain('170.000');
  });

  it('exige que los porcentajes sumen 100 y convierte 3 % a tasa de doce decimales', () => {
    const parts = [percentToFraction('40'), percentToFraction('40'), percentToFraction('20')];
    expect(parts).toEqual(['0.400000', '0.400000', '0.200000']);
    expect(fractionGap(parts.filter((part): part is string => part !== null))).toBe(0n);
    expect(percentToFraction('100')).toBe('1.000000');
    expect(percentToRate('3')).toBe('0.030000000000');
  });

  it('no rota la clave cuando el envío quedó sin respuesta', () => {
    const slot = createSlot();
    const first = keyFor(slot, 'mismo');
    markUncertain(slot);
    expect(keyFor(slot, 'mismo')).toBe(first);
    expect(() => keyFor(slot, 'otro')).toThrow(/No se crea otra clave/);
  });
});
