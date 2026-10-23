const THOUSANDS = /^(?:0|[1-9]\d{0,2})(?:\.\d{3})+$/;
const PLAIN = /^(?:0|[1-9]\d*)$/;
const CANONICAL = /^(-?)(0|[1-9]\d{0,15})\.(\d{2})$/;

export function parseSignedCop(input: string): string | null {
  const value = input.trim().normalize('NFC');
  if (!value || /[eE+\s]/.test(value)) return null;
  const negative = value.startsWith('-');
  const body = negative ? value.slice(1) : value;
  if (!body || body.startsWith('-')) return null;
  const canonical = parseLocalCop(body);
  if (!canonical || (negative && canonical === '0.00')) return null;
  return negative ? `-${canonical}` : canonical;
}

export function parseLocalCop(input: string): string | null {
  const value = input.trim().normalize('NFC');
  if (!value || /[eE+\s]/.test(value) || value.includes('-')) return null;
  const comma = value.indexOf(',');
  let whole = value;
  let cents = '00';
  if (comma >= 0) {
    if (value.includes(',', comma + 1)) return null;
    whole = value.slice(0, comma);
    const fraction = value.slice(comma + 1);
    if (!/^\d{1,2}$/.test(fraction)) return null;
    cents = fraction.padEnd(2, '0');
  }
  if (!(THOUSANDS.test(whole) || PLAIN.test(whole))) return null;
  const digits = whole.replaceAll('.', '');
  if (!/^(?:0|[1-9]\d{0,15})$/.test(digits)) return null;
  const canonical = `${digits}.${cents}`;
  return CANONICAL.test(canonical) ? canonical : null;
}

export function formatCop(canonical: string): string | null {
  const match = CANONICAL.exec(canonical);
  if (!match) return null;
  const grouped = match[2].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return match[3] === '00' ? `${match[1]}${grouped}` : `${match[1]}${grouped},${match[3]}`;
}

export function cents(canonical: string): bigint | null {
  const match = CANONICAL.exec(canonical);
  if (!match) return null;
  const value = BigInt(match[2]) * 100n + BigInt(match[3]);
  return match[1] === '-' ? -value : value;
}

export function fromCents(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

export function todayBogota(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export interface CommandBinding { fingerprint: string; idempotencyKey: string; sourceId: string }

export function bindCommand(scope: { current: CommandBinding | null }, fingerprint: string): CommandBinding {
  if (!scope.current || scope.current.fingerprint !== fingerprint) {
    scope.current = { fingerprint, idempotencyKey: crypto.randomUUID(), sourceId: crypto.randomUUID() };
  }
  return scope.current;
}

export function releaseCommand(scope: { current: CommandBinding | null }): void {
  scope.current = null;
}
