/* eslint-disable security/detect-object-injection -- Own fixed class/total keys over raw synthetic rows of this review, never request input. */
// S09-P05 independent oracle (Claude). Written from the approved contracts LIABILITIES/EXPENSES/PRIVATE_CONSOLIDATION_S09 1.0.0 and
// REFERENCE_CASES_S09 only. Input is the RAW dataset of the reviewer's own group (Mongo rows read directly); no production module
// (obligations/finance/reporting/money) is imported. Money is integer cents (BigInt).
type Raw = Record<string, unknown> & { _id: string };
export interface Dataset { personalAccounts: Raw[]; personalJournals: Raw[]; personalEvents: Raw[]; businessEvents: Raw[]; businessAccounts: Raw[]; businessJournals: Raw[]; relationships: Raw[]; declarations: Raw[]; expenses: Raw[] }
export interface Totals { assets: bigint; liabilities: bigint; equity: bigint; income: bigint; expense: bigint; cashAvailable: bigint }
export const cents = (v: unknown): bigint => { const t = String(v ?? '0'), neg = t.startsWith('-'), [w = '0', f = ''] = t.replace('-', '').split('.'); const n = BigInt(w) * 100n + BigInt((f + '00').slice(0, 2)); return neg ? -n : n; };
export const money = (v: bigint) => { const neg = v < 0n, a = neg ? -v : v; return (neg ? '-' : '') + (a / 100n).toString() + '.' + (a % 100n).toString().padStart(2, '0'); };
export const show = (t: Totals) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, money(v)])) as Record<keyof Totals, string>;
const S = (x: bigint[]) => x.reduce((a, b) => a + b, 0n);

/** Book totals at economic cut asOf and knowledge K. A journal is known when its whole unit is known: max(journal recordedAt, unitKnownAt of every event that references it) (K01). */
export function totals(d: Dataset, kind: 'PERSONAL' | 'BUSINESS', bookId: string, asOf: string, K = '9999-12-31T23:59:59.999Z'): Totals {
  const accounts = kind === 'PERSONAL' ? d.personalAccounts.filter(a => a['bookId'] === bookId) : d.businessAccounts.filter(a => a['organizationId'] === bookId);
  const journals = kind === 'PERSONAL' ? d.personalJournals.filter(j => j['bookId'] === bookId) : d.businessJournals.filter(j => j['organizationId'] === bookId);
  const events = (kind === 'PERSONAL' ? d.personalEvents : d.businessEvents).filter(e => e['bookId'] === bookId);
  const unit = (j: Raw) => [String(j['recordedAt']), ...events.filter(e => (e['journalIds'] as string[] ?? []).includes(j._id)).map(e => String(e['unitKnownAt']))].sort().at(-1)!;
  const bal = new Map<string, bigint>();
  for (const j of journals) if (String(j['effectiveDate']) <= asOf && unit(j) <= K) for (const l of j['lines'] as Raw[]) bal.set(String(l['accountId']), (bal.get(String(l['accountId'])) ?? 0n) + cents(l['debit']) - cents(l['credit']));
  const t: Totals = { assets: 0n, liabilities: 0n, equity: 0n, income: 0n, expense: 0n, cashAvailable: 0n };
  for (const a of accounts) { const n = bal.get(a._id) ?? 0n, cls = String(a['accountClass']);
    if (cls === 'ASSET') t.assets += n; else if (cls === 'LIABILITY') t.liabilities -= n; else if (cls === 'EQUITY') t.equity -= n; else if (cls === 'INCOME') t.income -= n; else if (cls === 'EXPENSE') t.expense += n;
    if (cls === 'ASSET' && ['CASH', 'BANK'].includes(String(a['kind']))) t.cashAvailable += n; }
  return t;
}
/** Balance of one account (debit-positive) at a cut. */
export function balance(d: Dataset, kind: 'PERSONAL' | 'BUSINESS', bookId: string, accountId: string, asOf: string): bigint {
  const journals = kind === 'PERSONAL' ? d.personalJournals.filter(j => j['bookId'] === bookId) : d.businessJournals.filter(j => j['organizationId'] === bookId);
  return S(journals.filter(j => String(j['effectiveDate']) <= asOf).flatMap(j => (j['lines'] as Raw[]).filter(l => l['accountId'] === accountId).map(l => cents(l['debit']) - cents(l['credit']))));
}

// ---- recurrence (EXPENSES_S09 1.0.0): inclusive start/end, anchor from original start, clamp to last day, no holiday inference.
const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const iso = (y: number, m: number, day: number) => `${y}-${pad(m)}-${pad(day)}`;
const addDays = (s: string, n: number) => new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
export interface RuleSpec { frequency: string; startDate: string; endDate?: string; monthDay?: number | 'LAST_DAY'; twiceMonthlyDays?: (number | 'LAST_DAY')[]; customDates?: string[] }
export function occurrences(r: RuleSpec, from: string, through: string): string[] {
  const lo = r.startDate > from ? r.startDate : from, hi = r.endDate && r.endDate < through ? r.endDate : through, out: string[] = [];
  const keep = (x: string) => { if (x >= lo && x <= hi && x >= r.startDate) out.push(x); };
  const sy = +r.startDate.slice(0, 4), sm = +r.startDate.slice(5, 7);
  const months = { MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12 }[r.frequency as 'MONTHLY'];
  if (months) for (let i = 0; i < 1200; i++) { const k = sm - 1 + i * months, y = sy + Math.floor(k / 12), m = (k % 12) + 1, L = lastDay(y, m), day = r.monthDay === 'LAST_DAY' ? L : Math.min(Number(r.monthDay), L), x = iso(y, m, day); if (x > hi) break; keep(x); }
  else if (['DAILY', 'WEEKLY', 'FORTNIGHTLY'].includes(r.frequency)) { const step = r.frequency === 'DAILY' ? 1 : r.frequency === 'WEEKLY' ? 7 : 15; for (let x = r.startDate; x <= hi; x = addDays(x, step)) keep(x); }
  else if (r.frequency === 'TWICE_MONTHLY') for (let i = 0; i < 1200; i++) { const k = sm - 1 + i, y = sy + Math.floor(k / 12), m = (k % 12) + 1; if (iso(y, m, 1) > hi) break; for (const v of [...r.twiceMonthlyDays!].map(v => v === 'LAST_DAY' ? lastDay(y, m) : v).sort((a, b) => a - b)) keep(iso(y, m, v)); }
  else if (r.frequency === 'CUSTOM') for (const x of [...r.customDates!].sort()) keep(x);
  return out;
}

// ---- private consolidation (PRIVATE_CONSOLIDATION_S09 §cálculo): gross of eligible books at one cut, eliminate only reciprocal backed relationships.
export function consolidation(d: Dataset, personalBookId: string, org: string | null, subjectId: string, asOf: string, K = '9999-12-31T23:59:59.999Z') {
  const declared = org ? d.declarations.filter(x => x['bookId'] === org && x['subjectId'] === subjectId && String(x['validFrom']) <= asOf && String(x['recordedAt']) <= K).sort((x, y) => Number(x['version']) - Number(y['version'])).at(-1) : undefined;
  const eligible = !!declared && declared['right'] === 'FULL_OWNERSHIP' && declared['percentage'] === '100.00';
  const p = totals(d, 'PERSONAL', personalBookId, asOf, K), b = eligible ? totals(d, 'BUSINESS', org!, asOf, K) : null, gross = { ...p };
  if (b) for (const k of Object.keys(gross) as (keyof Totals)[]) gross[k] += b[k];
  const net = { ...gross }, eliminations: { relationshipId: string; kind: string; amount: string }[] = [];
  if (b) {
    const visible = (r: Raw) => String(r['effectiveDate']) <= asOf && String(r['unitKnownAt']) <= K && !(r['reversedEffectiveDate'] && String(r['reversedEffectiveDate']) <= asOf && String(r['reversedKnownAt']) <= K);
    const rel = d.relationships.filter(r => r['personalBookId'] === personalBookId && r['businessBookId'] === org);
    for (const r of rel.filter(r => !r['rootRelationshipId'] && visible(r))) {
      const left = cents(r['amount']) - S(rel.filter(x => x['rootRelationshipId'] === r._id && visible(x)).map(x => cents(x['amount'])));
      if (left === 0n) continue; net.assets -= left; if (r['kind'] === 'CONTRIBUTION') net.equity -= left; else net.liabilities -= left;
      eliminations.push({ relationshipId: r._id, kind: String(r['kind']), amount: money(left) });
    }
  }
  return { eligible, participation: declared && !eligible ? String(declared['percentage']) : null, personal: show(p), business: b && show(b), gross: show(gross), eliminations, net: show(net) };
}
