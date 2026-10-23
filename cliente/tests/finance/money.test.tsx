import { describe, expect, it } from 'vitest';
import { cents, formatCop, fromCents, parseLocalCop } from '../../src/shared/money';

describe('pesos de presentación', () => {
  it('convierte el formato local al contrato y de vuelta, sin número flotante', () => {
    expect(parseLocalCop('1.999')).toBe('1999.00');
    expect(parseLocalCop('1.999,50')).toBe('1999.50');
    expect(parseLocalCop('1999,5')).toBe('1999.50');
    expect(parseLocalCop('0')).toBe('0.00');
    expect(parseLocalCop('1.99')).toBeNull();
    expect(parseLocalCop('1,999')).toBeNull();
    expect(parseLocalCop('1e3')).toBeNull();
    expect(formatCop('1999.00')).toBe('1.999');
    expect(formatCop('1999.50')).toBe('1.999,50');
    expect(formatCop('-10.50')).toBe('-10,50');
    expect(formatCop('1999')).toBeNull();
    expect(fromCents(cents('1999.50')! + cents('0.50')!)).toBe('2000.00');
  });
});
