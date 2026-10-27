/* eslint-disable security/detect-object-injection -- Own fixed observation keys of this review, never request input. */
// S07-P05 H-S6-P05-02 revalidation (Claude): interruptions of the legacy→HMAC priority migration at several boundaries,
// operator review, restarts and absent/other keys. Invariant checked with an OWN tree walk from the org root:
// whenever the realm is OPEN with a configured priority key, the head is HMAC-SHA256-v1 and every reachable node has the
// HMAC priority computed here (never the public formula). Economic collections must stay byte-identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { BSON } from 'mongodb';
import { s07Profile } from './review-profile.js';
import { setup } from '../../s07/fixture.js';
import { Database } from '../../../src/shared/database.js';
import { RestoreController } from '../../../src/shared/restore.js';
const evidence = (name, d) => console.log(JSON.stringify({ evidence: name, ...d }));
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, canonical(x)])) : v;
const H = (v) => createHash('sha256').update(JSON.stringify(canonical(BSON.EJSON.serialize(v, { relaxed: false })))).digest('hex');
const ECON = ['loan_events', 'loan_applications', 'loan_positions', 'loan_installments', 'loan_accruals', 'borrower_credits', 'financial_journals', 'payments', 'cash_custody'];
const BOUNDARIES = [
    ['before nodes', 'lending_merkle_nodes', { __s07_p05_fault: { $exists: true } }],
    ['mid nodes', 'lending_merkle_nodes', { hash: { $regex: '^[0-9a-e]' } }],
    ['org roots', 'lending_merkle_orgs', { __s07_p05_fault: { $exists: true } }],
    ['header', 'lending_domain_state', { __s07_p05_fault: { $exists: true } }],
    ['checkpoint', 'lending_priority_checkpoint', { __s07_p05_fault: { $exists: true } }],
    ['transition audit', 'audit_events', { __s07_p05_fault: { $exists: true } }],
];
test('P07-H02 legacy→HMAC interruptions never open with a legacy policy', { timeout: 3600000 }, async (t) => {
    const group = await s07Profile();
    try {
        for (const [label, coll, validator] of BOUNDARIES) {
            await t.test('boundary: ' + label, async (st) => {
                const o = {};
                st.after(() => evidence('P07-H02', { boundary: label, observed: o }));
                const f = await setup(group, { legacy: true }), db = f.database.db, l = await f.loan({ principal: '2000000.00' });
                await f.disburse(l);
                await f.restore.flush();
                const digest = async () => { const h = createHash('sha256'); for (const n of ECON) {
                    h.update(n);
                    h.update(BSON.EJSON.stringify(await db.collection(n).find({}).sort({ _id: 1 }).toArray(), { relaxed: false }));
                } return h.digest('hex'); };
                const d0 = await digest(), priority = randomBytes(32), keys = { ...f.keys, version: 2, priority };
                const on = async (k) => { const peer = new Database(group.uri, group.names[0]); await peer.connect(); const restore = new RestoreController(peer, f.restore.gatePath, k.journal, k.priority); let error = null; try {
                    await restore.initialize();
                }
                catch (e) {
                    error = String(e.code ?? e.message);
                } return { peer, restore, error }; };
                /** Own invariant: open ⇒ HMAC head + all reachable nodes carry HMAC priorities under the configured key. */
                const verify = async (open, key) => {
                    const head = await db.collection('lending_domain_state').findOne({ _id: 'evidence' }), root = (await db.collection('lending_merkle_orgs').findOne({ _id: f.org }))?.root;
                    const coll2 = db.collection('lending_merkle_nodes'), stack = root ? [root.id] : [];
                    let n = 0, hm = 0, pub = 0;
                    while (stack.length) {
                        const x = await coll2.findOne({ _id: stack.pop() });
                        if (!x) {
                            n++;
                            continue;
                        }
                        n++;
                        if (key && createHmac('sha256', key).update(JSON.stringify(['CAUDELYX:PRIORITY:v1', x.namespace, x.key])).digest('hex') === x.priority)
                            hm++;
                        if (H(x.key) === x.priority)
                            pub++;
                        if (x.left)
                            stack.push(x.left.id);
                        if (x.right)
                            stack.push(x.right.id);
                    }
                    const r = { open, policy: head?.['priorityPolicy'] ?? null, reachable: n, hmac: hm, publicFormula: pub, economicUnchanged: await digest() === d0 };
                    return { ...r, invariantHolds: !open || r.policy === 'HMAC-SHA256-v1' && hm === n && pub === 0 };
                };
                // 1. migration attempt with the fault active
                await db.command({ collMod: coll, validator, validationLevel: 'strict', validationAction: 'error' }).catch(async () => { await db.createCollection(coll); await db.command({ collMod: coll, validator, validationLevel: 'strict', validationAction: 'error' }); });
                let first;
                try {
                    first = await on(keys);
                }
                finally {
                    await db.command({ collMod: coll, validator: {}, validationLevel: 'off' });
                }
                o['1 interrupted start'] = { error: first.error, ...(await verify(first.restore.isOpen(), priority)) };
                // 2. operator review on that same runtime (approved review is not a dispensation)
                let rec = 'reconciled';
                try {
                    await first.restore.reconcile({ approved: true, reviewId: 'S07_P05_REVIEW_AFTER_INTERRUPTION' });
                }
                catch (e) {
                    rec = String(e.code ?? e);
                }
                o['2 review after interruption'] = { reconcile: rec, ...(await verify(first.restore.isOpen(), priority)) };
                await first.peer.close();
                // 3. restart with the right key (completes or requires review), then review if still closed
                const second = await on(keys);
                let rec2 = 'not needed';
                if (!second.restore.isOpen()) {
                    try {
                        await second.restore.reconcile({ approved: true, reviewId: 'S07_P05_REVIEW_RESTART' });
                        rec2 = 'reconciled';
                    }
                    catch (e) {
                        rec2 = String(e.code ?? e);
                    }
                }
                o['3 restart right key'] = { error: second.error, review: rec2, ...(await verify(second.restore.isOpen(), priority)) };
                await second.peer.close();
                // 4. absent / other key: closed, and a review cannot open it
                for (const [name, k] of [['absent key', { journal: f.keys.journal }], ['other key', { journal: f.keys.journal, priority: randomBytes(32) }]]) {
                    const x = await on(k);
                    let r3 = 'reconciled';
                    try {
                        await x.restore.reconcile({ approved: true, reviewId: 'S07_P05_WRONG_KEY' });
                    }
                    catch (e) {
                        r3 = String(e.code ?? e);
                    }
                    o['4 ' + name] = { error: x.error, review: r3, open: x.restore.isOpen() };
                    await x.peer.close();
                }
                const back = await on(keys);
                if (!back.restore.isOpen()) {
                    try {
                        await back.restore.reconcile({ approved: true, reviewId: 'S07_P05_RIGHT_KEY' });
                    }
                    catch { /* recorded below */ }
                }
                o['5 right key after wrong keys'] = await verify(back.restore.isOpen(), priority);
                await back.peer.close();
                for (const k of ['1 interrupted start', '2 review after interruption', '3 restart right key', '5 right key after wrong keys'])
                    assert.equal(o[k].invariantHolds, true, k);
                for (const k of ['1 interrupted start', '2 review after interruption', '3 restart right key', '5 right key after wrong keys'])
                    assert.equal(o[k].economicUnchanged, true, k);
                assert.equal(o['3 restart right key'].open, true);
                assert.equal(o['4 absent key'].open, false);
                assert.equal(o['4 other key'].open, false);
                assert.equal(o['5 right key after wrong keys'].open, true);
            });
        }
    }
    finally {
        await group.dispose();
    }
});
//# sourceMappingURL=continuity.test.js.map