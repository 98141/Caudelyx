import { parseLocalCop } from '../../shared/money';

const RATE = /^(?:0\.[0-9]{12}|1\.0{12})$/;
const PRINCIPAL = /^(?:0\.(?:0[1-9]|[1-9][0-9])|[1-9][0-9]{0,11}\.[0-9]{2}|1000000000000\.00)$/;

export function percentToRate(input: string): string | null {
  const value = input.trim().normalize('NFC').replaceAll(' ', '').replace(',', '.');
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,10})?$/.test(value)) return null;
  const [whole, frac = ''] = value.split('.');
  const digits = `${whole}${frac}`;
  const shift = whole.length - 2;
  const canonical = shift > 0
    ? `${digits.slice(0, shift).replace(/^0+(?=\d)/, '') || '0'}.${(digits.slice(shift) + '0'.repeat(12)).slice(0, 12)}`
    : `0.${(`${'0'.repeat(-shift)}${digits}` + '0'.repeat(12)).slice(0, 12)}`;
  return RATE.test(canonical) ? canonical : null;
}

export function principalFromLocal(input: string): string | null {
  const canonical = parseLocalCop(input);
  return canonical && PRINCIPAL.test(canonical) ? canonical : null;
}

// Presentation conversion only: preserve the twelve fractional rate digits.
export function rateToPercent(value: string): string {
  if (!RATE.test(value)) throw new Error('Tasa guardada no válida.');
  const [whole, fraction] = value.split('.');
  const integer = String(Number(whole) * 100 + Number(fraction.slice(0, 2)));
  const decimals = fraction.slice(2).replace(/0+$/, '');
  return integer + (decimals ? ',' + decimals : '');
}
