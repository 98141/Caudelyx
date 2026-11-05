import { cents, money } from '../finance/money.js';
export function reconcile(snapshot, accounts, today, eligible = true) {
    const issues = [];
    const issue = (code, path, relatedIds = []) => {
        if (issues.length < 499)
            issues.push({ code, path, relatedIds });
        else if (issues.length === 499)
            issues.push({ code: 'LIMIT_EXCEEDED', path: '/report/issues/additional-errors', relatedIds: [] });
    };
    if (snapshot.cutoffDate > today)
        issue('DATE_INVALID', '/cutoffDate');
    if (!eligible)
        issue('BOOK_NOT_ELIGIBLE', '/');
    const supports = new Set(snapshot.supports.map(s => s.id));
    const refs = new Map(snapshot.references.map(r => [r.id, r]));
    const accountMap = new Map(accounts.map(a => [a._id, a]));
    for (const [name, rows] of Object.entries({ supports: snapshot.supports, references: snapshot.references, components: snapshot.components, historicalInterest: snapshot.historicalInterest, informationalHistory: snapshot.informationalHistory })) {
        const seen = new Set();
        for (const row of rows) {
            if (seen.has(row.id))
                issue('REFERENCE_DUPLICATE', `/${name}`, [row.id]);
            seen.add(row.id);
        }
    }
    const supportIds = (ids, path) => { if (!ids.length || ids.some(id => !supports.has(id)))
        issue('SUPPORT_REQUIRED', path); };
    const date = (d, path) => { if (d && d > snapshot.cutoffDate)
        issue('DATE_INVALID', path); };
    for (const [i, s] of snapshot.supports.entries())
        date(s.asOfDate, `/supports/${i}/asOfDate`);
    const external = new Set();
    for (const [i, r] of snapshot.references.entries()) {
        const key = JSON.stringify([r.type, r.externalReference]);
        if (external.has(key))
            issue('REFERENCE_DUPLICATE', `/references/${i}`, [r.id]);
        external.add(key);
        supportIds(r.supportIds, `/references/${i}/supportIds`);
        date(r.originationDate ?? r.acquisitionDate ?? r.incurredDate, `/references/${i}/date`);
        if (r.type === 'HISTORICAL_LOAN' && refs.get(r.borrowerId ?? '')?.type !== 'BORROWER')
            issue('REFERENCE_INVALID', `/references/${i}/borrowerId`, [r.id]);
    }
    for (const [i, h] of snapshot.informationalHistory.entries()) {
        date(h.date, `/informationalHistory/${i}/date`);
        supportIds(h.supportIds, `/informationalHistory/${i}/supportIds`);
        if (h.referenceId && !refs.has(h.referenceId))
            issue('REFERENCE_INVALID', `/informationalHistory/${i}/referenceId`, [h.id]);
    }
    const positions = new Set(), categories = new Map(), economicRefs = new Set();
    const groups = new Map();
    let assets = 0n, liabilities = 0n, equity = 0n, principal = 0n, recognizedInterest = 0n, informationalInterest = 0n;
    const mapping = (id, category, path) => {
        const a = accountMap.get(id), prior = categories.get(id);
        categories.set(id, category);
        const cls = category === 'LIABILITY' ? 'LIABILITY' : category === 'EQUITY' ? 'EQUITY' : 'ASSET';
        const kind = category === 'CASH' ? 'CASH' : category === 'BANK' ? 'BANK' : 'GENERAL';
        if (!a || a.status !== 'ACTIVE' || a.currency !== 'COP')
            issue('ACCOUNT_INVALID', path, [id]);
        else if (a.accountClass !== cls || a.kind !== kind || prior && prior !== category)
            issue('ACCOUNT_MAPPING_INVALID', path, [id]);
    };
    const line = (accountId, value, debit, id, interest = false) => {
        const group = groups.get(accountId) ?? { debit: 0n, credit: 0n, componentIds: [], interestIds: [] };
        if (debit)
            group.debit += value;
        else
            group.credit += value;
        (interest ? group.interestIds : group.componentIds).push(id);
        groups.set(accountId, group);
    };
    for (const [i, c] of snapshot.components.entries()) {
        const path = `/components/${i}`, signed = c.amount.startsWith('-') ? -cents(c.amount.slice(1)) : cents(c.amount);
        supportIds(c.supportIds, path + '/supportIds');
        mapping(c.accountId, c.category, path + '/accountId');
        const position = c.referenceId ? JSON.stringify(['reference', c.referenceId]) : JSON.stringify([c.category, c.accountId, c.equityKind ?? null]);
        if (positions.has(position))
            issue('DUPLICATE_POSITION', path, [c.id]);
        positions.add(position);
        if (c.referenceId) {
            economicRefs.add(c.referenceId);
            const expected = c.category === 'PRINCIPAL_RECEIVABLE' ? 'HISTORICAL_LOAN' : c.category === 'LIABILITY' ? 'OBLIGATION' : c.category;
            if (refs.get(c.referenceId)?.type !== expected)
                issue('REFERENCE_INVALID', path + '/referenceId', [c.id]);
        }
        if (c.category === 'LIABILITY') {
            liabilities += signed;
            line(c.accountId, signed, false, c.id);
        }
        else if (c.category === 'EQUITY') {
            equity += signed;
            line(c.accountId, signed < 0n ? -signed : signed, signed < 0n, c.id);
        }
        else {
            assets += signed;
            if (c.category === 'PRINCIPAL_RECEIVABLE')
                principal += signed;
            line(c.accountId, signed, true, c.id);
        }
    }
    for (const r of snapshot.references)
        if (r.type !== 'BORROWER' && !economicRefs.has(r.id))
            issue('REFERENCE_INVALID', '/references', [r.id]);
    const loans = new Set(), allocations = new Map();
    for (const [i, h] of snapshot.historicalInterest.entries()) {
        const path = `/historicalInterest/${i}`, amount = cents(h.amount);
        supportIds(h.supportIds, path + '/supportIds');
        if (refs.get(h.loanReferenceId)?.type !== 'HISTORICAL_LOAN' || !economicRefs.has(h.loanReferenceId))
            issue('REFERENCE_INVALID', path + '/loanReferenceId', [h.id]);
        if (loans.has(h.loanReferenceId))
            issue('DUPLICATE_POSITION', path, [h.id]);
        loans.add(h.loanReferenceId);
        if (h.treatment === 'INFORMATIONAL') {
            informationalInterest += amount;
            continue;
        }
        recognizedInterest += amount;
        assets += amount;
        mapping(h.accountId, 'HISTORICAL_INTEREST_RECEIVABLE', path + '/accountId');
        line(h.accountId, amount, true, h.id, true);
        allocations.set(h.equityComponentId, (allocations.get(h.equityComponentId) ?? 0n) + amount);
    }
    for (const [id, total] of allocations) {
        const c = snapshot.components.find(c => c.id === id);
        if (!c || c.category !== 'EQUITY' || c.equityKind !== 'HISTORICAL_RESULTS' || c.amount.startsWith('-') || cents(c.amount) < total)
            issue('INTEREST_POLICY_INVALID', '/historicalInterest/equityComponentId', [id]);
    }
    let debit = 0n, credit = 0n;
    const proposedLines = [];
    for (const [accountId, g] of [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        if (g.debit && g.credit)
            issue('ACCOUNT_MAPPING_INVALID', '/components/opposite-sides', [accountId]);
        debit += g.debit;
        credit += g.credit;
        if (g.debit || g.credit)
            proposedLines.push({ accountId, debit: money(g.debit), credit: money(g.credit), componentIds: g.componentIds, interestIds: g.interestIds });
    }
    if (proposedLines.length < 2 || proposedLines.length > 50)
        issue('LIMIT_EXCEEDED', '/components/postingAccounts');
    if (assets - liabilities - equity !== 0n)
        issue('BALANCE_DIFFERENCE', '/totals/balanceDifference');
    if (debit - credit !== 0n)
        issue('LEDGER_DIFFERENCE', '/totals/ledgerDifference');
    // An invalid one-sided graph cannot be a valid ProposedLine response. Keep issues,
    // never post or silently net opposing balances merely to satisfy the schema.
    const safeLines = proposedLines.some(l => l.debit !== '0.00' && l.credit !== '0.00') || proposedLines.length > 50 ? [] : proposedLines;
    return { issues, totals: { assets: money(assets), liabilities: money(liabilities), equity: money(equity), debit: money(debit), credit: money(credit), balanceDifference: money(assets - liabilities - equity), ledgerDifference: money(debit - credit), principal: money(principal), recognizedInterest: money(recognizedInterest), informationalInterest: money(informationalInterest) }, proposedLines: safeLines };
}
//# sourceMappingURL=reconcile.js.map