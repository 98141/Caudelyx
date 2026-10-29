export const cents = (v) => { const t = String(v ?? '0'), neg = t.startsWith('-'), [w = '0', f = ''] = t.replace('-', '').split('.'); const n = BigInt(w) * 100n + BigInt((f + '00').slice(0, 2)); return neg ? -n : n; };
export const money = (v) => { const neg = v < 0n, a = neg ? -v : v; return (neg ? '-' : '') + (a / 100n).toString() + '.' + (a % 100n).toString().padStart(2, '0'); };
export const show = (t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, money(v)]));
const S = (x) => x.reduce((a, b) => a + b, 0n);
/** Book totals at economic cut asOf and knowledge K. A journal is known when its whole unit is known: max(journal recordedAt, unitKnownAt of every event that references it) (K01). */
export function totals(d, kind, bookId, asOf, K = '9999-12-31T23:59:59.999Z') {
    const accounts = kind === 'PERSONAL' ? d.personalAccounts.filter(a => a['bookId'] === bookId) : d.businessAccounts.filter(a => a['organizationId'] === bookId);
    const journals = kind === 'PERSONAL' ? d.personalJournals.filter(j => j['bookId'] === bookId) : d.businessJournals.filter(j => j['organizationId'] === bookId);
    const events = (kind === 'PERSONAL' ? d.personalEvents : d.businessEvents).filter(e => e['bookId'] === bookId);
    const unit = (j) => [String(j['recordedAt']), ...events.filter(e => (e['journalIds'] ?? []).includes(j._id)).map(e => String(e['unitKnownAt']))].sort().at(-1);
    const bal = new Map();
    for (const j of journals)
        if (String(j['effectiveDate']) <= asOf && unit(j) <= K)
            for (const l of j['lines'])
                bal.set(String(l['accountId']), (bal.get(String(l['accountId'])) ?? 0n) + cents(l['debit']) - cents(l['credit']));
    const t = { assets: 0n, liabilities: 0n, equity: 0n, income: 0n, expense: 0n, cashAvailable: 0n };
    for (const a of accounts) {
        const n = bal.get(a._id) ?? 0n, cls = String(a['accountClass']);
        if (cls === 'ASSET')
            t.assets += n;
        else if (cls === 'LIABILITY')
            t.liabilities -= n;
        else if (cls === 'EQUITY')
            t.equity -= n;
        else if (cls === 'INCOME')
            t.income -= n;
        else if (cls === 'EXPENSE')
            t.expense += n;
        if (cls === 'ASSET' && ['CASH', 'BANK'].includes(String(a['kind'])))
            t.cashAvailable += n;
    }
    return t;
}
/** Balance of one account (debit-positive) at a cut. */
export function balance(d, kind, bookId, accountId, asOf) {
    const journals = kind === 'PERSONAL' ? d.personalJournals.filter(j => j['bookId'] === bookId) : d.businessJournals.filter(j => j['organizationId'] === bookId);
    return S(journals.filter(j => String(j['effectiveDate']) <= asOf).flatMap(j => j['lines'].filter(l => l['accountId'] === accountId).map(l => cents(l['debit']) - cents(l['credit']))));
}
// ---- recurrence (EXPENSES_S09 1.0.0): inclusive start/end, anchor from original start, clamp to last day, no holiday inference.
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const iso = (y, m, day) => `${y}-${pad(m)}-${pad(day)}`;
const addDays = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
export function occurrences(r, from, through) {
    const lo = r.startDate > from ? r.startDate : from, hi = r.endDate && r.endDate < through ? r.endDate : through, out = [];
    const keep = (x) => { if (x >= lo && x <= hi && x >= r.startDate)
        out.push(x); };
    const sy = +r.startDate.slice(0, 4), sm = +r.startDate.slice(5, 7);
    const months = { MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12 }[r.frequency];
    if (months)
        for (let i = 0; i < 1200; i++) {
            const k = sm - 1 + i * months, y = sy + Math.floor(k / 12), m = (k % 12) + 1, L = lastDay(y, m), day = r.monthDay === 'LAST_DAY' ? L : Math.min(Number(r.monthDay), L), x = iso(y, m, day);
            if (x > hi)
                break;
            keep(x);
        }
    else if (['DAILY', 'WEEKLY', 'FORTNIGHTLY'].includes(r.frequency)) {
        const step = r.frequency === 'DAILY' ? 1 : r.frequency === 'WEEKLY' ? 7 : 15;
        for (let x = r.startDate; x <= hi; x = addDays(x, step))
            keep(x);
    }
    else if (r.frequency === 'TWICE_MONTHLY')
        for (let i = 0; i < 1200; i++) {
            const k = sm - 1 + i, y = sy + Math.floor(k / 12), m = (k % 12) + 1;
            if (iso(y, m, 1) > hi)
                break;
            for (const v of [...r.twiceMonthlyDays].map(v => v === 'LAST_DAY' ? lastDay(y, m) : v).sort((a, b) => a - b))
                keep(iso(y, m, v));
        }
    else if (r.frequency === 'CUSTOM')
        for (const x of [...r.customDates].sort())
            keep(x);
    return out;
}
// ---- private consolidation (PRIVATE_CONSOLIDATION_S09 §cálculo): gross of eligible books at one cut, eliminate only reciprocal backed relationships.
export function consolidation(d, personalBookId, org, subjectId, asOf, K = '9999-12-31T23:59:59.999Z') {
    const declared = org ? d.declarations.filter(x => x['bookId'] === org && x['subjectId'] === subjectId && String(x['validFrom']) <= asOf && String(x['recordedAt']) <= K).sort((x, y) => Number(x['version']) - Number(y['version'])).at(-1) : undefined;
    const eligible = !!declared && declared['right'] === 'FULL_OWNERSHIP' && declared['percentage'] === '100.00';
    const p = totals(d, 'PERSONAL', personalBookId, asOf, K), b = eligible ? totals(d, 'BUSINESS', org, asOf, K) : null, gross = { ...p };
    if (b)
        for (const k of Object.keys(gross))
            gross[k] += b[k];
    const net = { ...gross }, eliminations = [];
    if (b) {
        const visible = (r) => String(r['effectiveDate']) <= asOf && String(r['unitKnownAt']) <= K && !(r['reversedEffectiveDate'] && String(r['reversedEffectiveDate']) <= asOf && String(r['reversedKnownAt']) <= K);
        const rel = d.relationships.filter(r => r['personalBookId'] === personalBookId && r['businessBookId'] === org);
        for (const r of rel.filter(r => !r['rootRelationshipId'] && visible(r))) {
            const left = cents(r['amount']) - S(rel.filter(x => x['rootRelationshipId'] === r._id && visible(x)).map(x => cents(x['amount'])));
            if (left === 0n)
                continue;
            net.assets -= left;
            if (r['kind'] === 'CONTRIBUTION')
                net.equity -= left;
            else
                net.liabilities -= left;
            eliminations.push({ relationshipId: r._id, kind: String(r['kind']), amount: money(left) });
        }
    }
    return { eligible, participation: declared && !eligible ? String(declared['percentage']) : null, personal: show(p), business: b && show(b), gross: show(gross), eliminations, net: show(net) };
}
//# sourceMappingURL=oracle.js.map