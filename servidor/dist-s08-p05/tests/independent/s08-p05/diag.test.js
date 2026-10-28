/* eslint-disable security/detect-object-injection -- Own diagnostic labels only. */
// S08-P05 diagnostic (Claude) for the D0 503/UNAVAILABLE observation of E1: reproduces the D0 operations step by step and records,
// after each step, the T dashboard status with the error stack (top frames) and every raw timestamp beyond the requested cut K.
import { test } from 'node:test';
import { s08ReviewProfile } from './review-profile.js';
import { world8, evidence, values } from './review-fixtures.js';
test('P08-DIAG D0 source inconsistency', { timeout: 1800000 }, async () => {
    const group = await s08ReviewProfile(), o = {};
    try {
        const x = await world8(group), f = x.f;
        const probe = async (label) => {
            const K = new Date(f.now()).toISOString(), cut = { asOf: '2026-10-31', from: '2026-10-01', to: '2026-10-31', recordedThrough: K };
            let res;
            try {
                const r = await f.identity.reporting.read(f.a.issued.context, 'getReportingDashboard', x.org, undefined, cut);
                res = { status: r.status, v: values({ status: 200, data: r.data }) };
            }
            catch (e) {
                res = { code: e.code, stack: String(e.stack).split('\n').slice(0, 4).map(s => s.trim()) };
            }
            const late = {};
            for (const c of ['loan_events', 'financial_journals', 'payments', 'payment_transitions', 'cash_delivery_facts', 'cash_deliveries', 'collection_journeys', 'collection_actions', 'loan_compensations', 'financial_accounts', 'held_funds_reservations', 'cash_custody'])
                for (const d of await x.db.collection(c).find({ organizationId: x.org }).toArray())
                    for (const k of ['recordedAt', 'createdAt', 'closedAt', 'effectiveDate']) {
                        const v = d[k];
                        if (typeof v === 'string' && v > (k === 'effectiveDate' ? cut.asOf : K))
                            (late[c] ??= []).push(k + '=' + v);
                    }
            o[label] = { K, res, late };
        };
        await probe('0 fixture');
        const L2 = await x.newLoan();
        await probe('1 L2 disbursed');
        await x.bankReceipt(L2, '2000000.00', 'EXTRA_PRINCIPAL');
        await probe('2 L2 2M extra');
        const L4 = await x.newLoan();
        await x.bankReceipt(L4, '560000.00');
        await probe('3 L4 560k');
        const L3 = await x.newLoan();
        await x.accrue(L3.id, '2026-10-31');
        await probe('4 L3 accrued');
        const dq = await x.request('250000.00'), did = dq.id;
        await x.act('dispatchCashDelivery', did, f.c);
        await x.act('receiveCashDelivery', did, f.o);
        await x.count(did, '250000.00');
        await probe('5 counted');
        await x.confirm(did);
        await probe('6 delivery confirmed');
        o['delivery'] = await x.db.collection('cash_deliveries').findOne({ _id: did });
    }
    finally {
        evidence('P08-DIAG', { observed: o });
        await group.dispose();
    }
});
//# sourceMappingURL=diag.test.js.map