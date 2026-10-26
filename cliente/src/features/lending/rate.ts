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

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function endOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Presentation only: the first due date the approved calendar would accept. */
export function suggestedFirstDue(effectiveDate: string, frequency: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) return null;
  const start = new Date(`${effectiveDate}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || iso(start) !== effectiveDate) return null;
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const day = start.getUTCDate();
  const monthEnd = endOfMonth(year, month);
  const endMonth = day === monthEnd;
  const fixed: Record<string, number> = { DAY: 1, WEEK: 7, FIFTEEN_DAYS: 15 };
  const step = fixed[frequency];
  if (step) return iso(new Date(Date.UTC(year, month, day + step)));
  if (frequency === 'MONTH') {
    const next = new Date(Date.UTC(year, month + 1, 1));
    const nextYear = next.getUTCFullYear();
    const nextMonth = next.getUTCMonth();
    return iso(new Date(Date.UTC(nextYear, nextMonth, endMonth ? endOfMonth(nextYear, nextMonth) : Math.min(day, endOfMonth(nextYear, nextMonth)))));
  }
  if (frequency === 'SEMIMONTH') {
    if (day !== 15 && !endMonth) return null;
    return day === 15 ? iso(new Date(Date.UTC(year, month + 1, 0))) : iso(new Date(Date.UTC(year, month + 1, 15)));
  }
  return null;
}
