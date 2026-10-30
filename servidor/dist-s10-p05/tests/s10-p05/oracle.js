export const cents = (v) => { const t = String(v ?? '0'), neg = t.startsWith('-'), [w = '0', f = ''] = t.replace('-', '').split('.'); const n = BigInt(w) * 100n + BigInt((f + '00').slice(0, 2)); return neg ? -n : n; };
export const money = (v) => { const neg = v < 0n, a = neg ? -v : v; return (neg ? '-' : '') + (a / 100n).toString() + '.' + (a % 100n).toString().padStart(2, '0'); };
export const show = (t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, money(v)]));
const pick = (d, kind, book) => kind === 'PERSONAL'
    ? { accounts: d.personalAccounts.filter(a => a['bookId'] === book), journals: d.personalJournals.filter(j => j['bookId'] === book) }
    : { accounts: d.businessAccounts.filter(a => a['organizationId'] === book), journals: d.businessJournals.filter(j => j['organizationId'] === book) };
/** Per-account debit-positive balances at economic cut asOf and knowledge K (journal recordedAt). */
export function balances(d, kind, book, asOf, K = '9999-12-31T23:59:59.999Z') {
    const b = new Map();
    for (const j of pick(d, kind, book).journals)
        if (String(j['effectiveDate']) <= asOf && String(j['recordedAt']) <= K)
            for (const l of j['lines'])
                b.set(String(l['accountId']), (b.get(String(l['accountId'])) ?? 0n) + cents(l['debit']) - cents(l['credit']));
    return b;
}
export function totals(d, kind, book, asOf, K) {
    const bal = balances(d, kind, book, asOf, K), t = { assets: 0n, liabilities: 0n, equity: 0n, income: 0n, expense: 0n, cash: 0n };
    for (const a of pick(d, kind, book).accounts) {
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
            t.cash += n;
    }
    return t;
}
/** Indicative owned portion (FUNDING_AND_OWNERSHIP §ejemplo40%): gross estimate × percentage, HALF_UP to the cent; equity = owned estimate − FULL own linked principal. */
export function indicative(grossEstimate, percentage, ownPrincipal) {
    if (grossEstimate === null)
        return { ownedEstimate: null, equity: null };
    const num = cents(grossEstimate) * cents(percentage), q = num / 10000n, r = num % 10000n, owned = r * 2n >= 10000n ? q + 1n : q;
    return { ownedEstimate: money(owned), equity: money(owned - cents(ownPrincipal)) };
}
//# sourceMappingURL=oracle.js.map