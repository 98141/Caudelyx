import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const cent = (value) => { const text = String(value), negative = text.startsWith('-'), parts = (negative ? text.slice(1) : text).split('.'), whole = parts[0] ?? '', fraction = parts[1] ?? ''; assert.ok(parts.length <= 2 && whole.length > 0 && whole.length <= 18 && fraction.length <= 2 && !/[^0-9]/.test(whole + fraction), 'noncanonical raw amount ' + text); const n = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')); return negative ? -n : n; };
const fixed = (n) => { const sign = n < 0n ? '-' : '', a = n < 0n ? -n : n; return sign + String(a / 100n) + '.' + String(a % 100n).padStart(2, '0'); };
export async function rawWealthOracle(db, bookId, bankId, assetAccountId, debtAccountId, assetId, cells) {
    const journals = await db.collection('financial_journals').find({ organizationId: bookId }).toArray(), accounts = await db.collection('financial_accounts').find({ organizationId: bookId }).toArray();
    const lines = journals.flatMap(j => j['lines']), balance = (id) => lines.filter(l => l.accountId === id).reduce((n, l) => n + cent(l.debit) - cent(l.credit), 0n);
    const cash = balance(bankId), cost = balance(assetAccountId), debt = -balance(debtAccountId), income = accounts.filter(a => a['accountClass'] === 'INCOME').reduce((n, a) => n - balance(String(a['_id'])), 0n);
    const asset = await db.collection('s10_assets_business').findOne({ _id: assetId }), valuations = await db.collection('s10_asset_valuations_business').find({ assetId }).sort({ valuationDate: -1 }).toArray(), funding = await db.collection('s10_asset_funding_business').find({ assetId }).toArray();
    assert.ok(asset);
    assert.equal(valuations.length, 1);
    const estimate = cent(valuations[0]['grossEstimatedValue']);
    assert.equal(cent(asset['recognizedCost']), cost);
    assert.equal(String(asset['ownershipPercentage']), '100.00');
    assert.equal(funding.reduce((n, r) => n + cent(r['amount']), 0n), cost);
    const events = await db.collection('s10_fund_events_business').find({ bookId }).toArray(), reservation = events.flatMap(e => (e['deltas'] ?? [])).reduce((n, r) => n + cent(r.delta), 0n);
    assert.equal(cash, 0n);
    assert.equal(cost, 20000000000n);
    assert.equal(debt, 12000000000n);
    assert.equal(estimate, 22000000000n);
    assert.equal(income, 0n);
    assert.equal(reservation, 0n);
    const expected = { base: cash + cost - debt, estimated: cash + estimate - debt };
    for (const [key, value] of Object.entries(expected)) {
        const actual = cells.find(c => c['columnId'] === key);
        assert.ok(actual);
        assert.equal(cent(actual['value']), value, 'raw ledger oracle ' + key);
    }
    const raw = { journals: journals.map(j => ({ id: String(j['_id']), effectiveDate: j['effectiveDate'], lines: j['lines'].map(l => ({ accountId: l.accountId, debit: String(l.debit), credit: String(l.credit) })) })), asset: { id: assetId, recognizedCost: String(asset['recognizedCost']), ownershipPercentage: String(asset['ownershipPercentage']) }, valuation: valuations.map(v => ({ id: String(v['_id']), date: v['valuationDate'], grossEstimatedValue: String(v['grossEstimatedValue']) })), funding: funding.map(f => ({ id: String(f['_id']), nature: f['nature'], amount: String(f['amount']) })) };
    await writeFile('../../Construccion/Sprints/S11/Evidencias/S11-P04-RAW-ORACLE.json', JSON.stringify({ result: 'PASS', bookId, raw, computed: { cash: fixed(cash), cost: fixed(cost), debt: fixed(debt), estimate: fixed(estimate), income: fixed(income), reservationAfterConsumption: fixed(reservation), base: fixed(expected.base), estimated: fixed(expected.estimated) }, method: 'Raw BSON journal lines/accounts/native asset/funding/valuation/events; independent BigInt cents, no product report engine or finance money helper; snapshot cells only compared after calculation' }, null, 2) + '\n');
}
export async function rawPersonalOracle(db, bookId, walletId, assetAccountId, debtAccountId, assetId, cells) {
    const journals = await db.collection('s09_personal_journals').find({ bookId }).toArray(), lines = journals.flatMap(j => j['lines']), balance = (id) => lines.filter(l => l.accountId === id).reduce((n, l) => n + cent(l.debit) - cent(l.credit), 0n);
    const asset = await db.collection('s10_assets_personal').findOne({ _id: assetId }), valuation = await db.collection('s10_asset_valuations_personal').findOne({ assetId });
    assert.ok(asset && valuation);
    const percentage = cent(asset['ownershipPercentage']), cost = balance(assetAccountId), debt = -balance(debtAccountId), cash = balance(walletId), estimate = cent(valuation['grossEstimatedValue']) * percentage / 10000n;
    assert.equal(percentage, 4000n);
    assert.equal(cost, 8000000000n);
    assert.equal(cash, 0n);
    assert.equal(debt, 3000000000n);
    assert.equal(estimate, 8800000000n);
    assert.equal(cent(asset['grossCostDeclared']) * percentage / 10000n, cost);
    const expected = { base: cash + cost - debt, estimated: cash + estimate - debt };
    for (const [key, value] of Object.entries(expected)) {
        const actual = cells.find(c => c['columnId'] === key);
        assert.ok(actual);
        assert.equal(cent(actual['value']), value, 'raw PERSONAL oracle ' + key);
    }
    await writeFile('../../Construccion/Sprints/S11/Evidencias/S11-P04-RAW-PERSONAL-ORACLE.json', JSON.stringify({ result: 'PASS', bookId, raw: { journals: journals.map(j => ({ id: String(j['_id']), lines: j['lines'].map(l => ({ accountId: l.accountId, debit: String(l.debit), credit: String(l.credit) })) })), assetId, percentage: String(asset['ownershipPercentage']), grossCost: String(asset['grossCostDeclared']), grossEstimatedValue: String(valuation['grossEstimatedValue']) }, computed: { cost: fixed(cost), cash: fixed(cash), ownDebtFull: fixed(debt), ownedEstimate: fixed(estimate), base: fixed(expected.base), estimated: fixed(expected.estimated) }, method: 'Raw private BSON ledger and stored40percent valuation, independent BigInt cents; debt is the full own30M, never multiplied by ownership' }, null, 2) + '\n');
}
//# sourceMappingURL=report-oracle.js.map