import { cents, formatCop, fromCents } from '../../shared/money';
import type { Metric } from './types';

const RATE = /^(?:0\.[0-9]{12}|1\.0{12})$/;

export function metricText(metric: Metric | null | undefined): string {
  if (!metric || metric.status === 'UNAVAILABLE' || metric.value === null) return 'No disponible';
  if (metric.status === 'NOT_APPLICABLE') return 'No aplica';
  const shown = formatCop(metric.value);
  if (!shown || metric.status !== 'COMPLETE' && metric.status !== 'INCOMPLETE') return 'No disponible';
  if (metric.status === 'INCOMPLETE') return `${shown} COP, parcial`;
  return `${shown} COP`;
}

export function formatPreviewCop(value: string | null | undefined): string {
  if (!value) return 'No disponible';
  const shown = formatCop(value);
  if (!shown) return 'No disponible';
  if (value.endsWith('.00') && !shown.includes(',')) return `${shown},00 COP`;
  return `${shown} COP`;
}

export function presentedDifference(expected: Metric, actual: Metric): string {
  if (expected.status !== 'COMPLETE' || actual.status !== 'COMPLETE' || expected.value === null || actual.value === null) return 'No disponible';
  const left = cents(expected.value);
  const right = cents(actual.value);
  if (left === null || right === null) return 'No disponible';
  return formatPreviewCop(fromCents(right - left));
}

export function attentionLine(label: string, metric: Metric): string | null {
  if (metric.status === 'COMPLETE' || metric.status === 'NOT_APPLICABLE') return null;
  const reason = metric.reasons.length ? ` Motivo: ${metric.reasons.join(', ')}.` : '';
  return `${label}: ${metricText(metric)}.${reason}`;
}

export function percentToFraction(input: string): string | null {
  const value = input.trim().normalize('NFC').replaceAll(' ', '').replace(',', '.');
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,4})?$/.test(value)) return null;
  const [whole, frac = ''] = value.split('.');
  const micros = BigInt(whole) * 10000n + BigInt(frac.padEnd(4, '0'));
  if (micros > 1000000n) return null;
  if (micros === 1000000n) return '1.000000';
  return `0.${micros.toString().padStart(6, '0')}`;
}

export function fractionMicros(value: string): bigint | null {
  if (value === '1.000000') return 1000000n;
  if (!/^0\.\d{6}$/.test(value)) return null;
  return BigInt(value.slice(2));
}

export function fractionGap(parts: string[]): bigint | null {
  let sum = 0n;
  for (const part of parts) {
    const micros = fractionMicros(part);
    if (micros === null) return null;
    sum += micros;
  }
  return 1000000n - sum;
}

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

export function rateLabel(value: string): string {
  if (!RATE.test(value)) return 'No disponible';
  const [whole, fraction] = value.split('.');
  const integer = String(Number(whole) * 100 + Number(fraction.slice(0, 2)));
  const decimals = fraction.slice(2).replace(/0+$/, '');
  return `${integer}${decimals ? ',' + decimals : ''} % por ciclo`;
}

export function pageSum(values: Array<string | null>): { text: string; unknown: number } {
  let total = 0n;
  let unknown = 0;
  for (const value of values) {
    if (value === null) { unknown += 1; continue; }
    const amount = cents(value);
    if (amount === null) { unknown += 1; continue; }
    total += amount;
  }
  const shown = formatPreviewCop(fromCents(total));
  if (unknown > 0) return { text: `${shown} de filas con importe; ${unknown} sin cifra`, unknown };
  return { text: shown, unknown };
}

export function concealMessage(status: number): string | null {
  if (status === 403 || status === 404) return 'No se puede mostrar esta información. No se revelan datos de otro ámbito.';
  return null;
}
