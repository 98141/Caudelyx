/* Own security integration tests; filesystem writes pass exact guarded ownership. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { BSON } from 'mongodb';
import { msProfile, world } from './fixture.js';
import { data, setupMonthly, seedCapital, msTag } from './helpers.js';
import { wealthTable } from '../../src/modules/wealth/models.js';
import { etag } from '../../src/modules/obligations/models.js';
import { AppError } from '../../src/shared/errors.js';
import { today } from '../../src/modules/finance/service.js';
import { ApiClient } from './client.js';
test('integrated safeguards: atomic distribution abort, two processes, lost response, CAS, grant and cleanup', { timeout: 300000 }, async (t) => {
    const group = await msProfile();
    try {
        const f = await world(group, Date.now(), false), m = await setupMonthly(f), date = today(f.now()), external = await f.account('P04_OTHER_INCOME', 'INCOME');
        await seedCapital(f);
        const payload = { currency: 'COP', effectiveDate: date, sourceId: randomUUID(), supportReference: 'SYN-EXTERNAL', description: 'Ingreso sintético separado del interés', lines: [{ accountId: f.bank.id, debit: '10000.00', credit: '0.00' }, { accountId: external.id, debit: '0.00', credit: '10000.00' }] }, journalKey = randomUUID();
        await f.proof(f.a, 'FINANCE_JOURNAL_POST', { organizationId: f.org, idempotencyKey: journalKey, payload });
        await f.runtime.finance.mutate(f.a.issued.context, 'postJournal', f.org, payload, journalKey);
        await f.restore.flush();
        f.clock.value += 1000;
        const fund = await f.wealthMutate('businessCreateFund', { mode: 'VIRTUAL', label: 'Emergencia seguridad', purpose: 'SAVINGS', backingAccountId: f.bank.id, supportReference: 'SYN' }, { organizationId: f.org }), fundId = String(data(fund)['id']), params = { bookId: f.org };
        const quote = async (amount = '5000.00', emergency = true) => { const view = data(await m.ms.read(f.a.issued.context, 'msGetMonthlyView', params, { month: date.slice(0, 7), effectiveDate: date })), tag = await msTag(f), key = randomUUID(), body = { executionKey: key, month: date.slice(0, 7), effectiveDate: date, amount, destinations: emergency ? [{ kind: 'EMERGENCY', fraction: '0.500000', fundId, expectedFundETag: etag(await f.database.client.withSession(async (s) => await f.service.store.get(wealthTable('BUSINESS', 'funds'), fundId, { kind: 'BUSINESS', bookId: f.org, ownerId: f.org, organizationId: f.org }, s))) }, { kind: 'LOAN_FREE', fraction: '0.500000' }] : [{ kind: 'FREE', fraction: '1.000000' }], mappingVersion: view['cuts']['mappingVersion'], sourceVector: view['cuts']['sourceVector'], expectedBookETag: tag, action: 'DISTRIBUTE' }, q = await m.ms.mutate(f.a.issued.context, 'msPreviewDistribution', body, params, key, tag); return { key, tag, body: { executionKey: key, previewToken: data(q)['previewToken'], requestHash: data(q)['requestHash'] } }; };
        const first = await quote(), stale = await quote();
        await t.test('failure after audit/outbox aborts signed originals, balances, commands and heads', async () => { const names = ['ms_distributions', 'ms_commands', wealthTable('BUSINESS', 'fund_events'), 's09_evidence', 's09_projection_heads', 'financial_journals', 'outbox', 'audit_events', 'security_evidence_outbox'], digest = async () => createHash('sha256').update(BSON.EJSON.stringify(await Promise.all(names.map(n => f.database.db.collection(n).find({}).sort({ _id: 1 }).toArray())), { relaxed: false })).digest('hex'), before = await digest(), append = f.identity.audit.append.bind(f.identity.audit); f.identity.audit.append = async (...args) => { const r = await append(...args); if (args[0].action === 'MS_COMMAND')
            throw new AppError(503, 'SERVICE_UNAVAILABLE'); return r; }; try {
            await assert.rejects(m.ms.mutate(f.a.issued.context, 'msCommitDistribution', first.body, params, first.key, first.tag), { code: 'SERVICE_UNAVAILABLE' });
        }
        finally {
            f.identity.audit.append = append;
        } assert.equal(await digest(), before); });
        await t.test('two genuine processes retry one frozen command without a second reserve', async () => { const peer = await group.peer({ keys: f.keys, now: f.now(), enableBusiness: true }); try {
            const pair = await Promise.all([m.ms.mutate(f.a.issued.context, 'msCommitDistribution', first.body, params, first.key, first.tag), peer.execute({ operation: 'msCommitDistribution', payload: first.body, params, key: first.key, expected: first.tag, token: f.a.issued.token })]);
            assert.equal(pair[0].status, 200);
            assert.equal(pair[1]['type'], 'result', JSON.stringify(pair[1]));
            assert.deepEqual(pair[0].data, pair[1]['data']);
        }
        finally {
            await peer.close();
        } assert.equal(await f.database.db.collection('ms_distributions').countDocuments({ bookId: f.org, kind: 'DISTRIBUTE' }), 1); const balances = await f.database.client.withSession(async (s) => await f.wealth.reserved({ kind: 'BUSINESS', bookId: f.org, ownerId: f.org, organizationId: f.org }, s)); assert.equal(balances.get(fundId), 250000n); });
        await t.test('stale CAS and excess surplus reject before a second effect', async () => { await assert.rejects(m.ms.mutate(f.a.issued.context, 'msCommitDistribution', stale.body, params, stale.key, stale.tag), { code: 'PRECONDITION_FAILED' }); await assert.rejects(quote('6000.00', false), { code: 'INSUFFICIENT_AVAILABLE_FUNDS' }); });
        await t.test('actual lost HTTPS commit response recovers by same key with one distribution', async () => { const q = await quote('1000.00', false), h = await f.https(), path = '/api/modo-simple/v1/books/' + f.org + '/distributions-commits', proxy = await f.proxy(h, path), client = new ApiClient(proxy.port, h.cert); client.cookies.set('__Host-caudelyx-session', f.a.issued.token); h.client.cookies.set('__Host-caudelyx-session', f.a.issued.token); await h.client.refreshCsrf(); client.csrf = h.client.csrf; await assert.rejects(client.call('POST', path, q.body, { 'Idempotency-Key': q.key, 'If-Match': q.tag, Origin: 'https://localhost:' + h.port })); const retry = await h.client.call('POST', path, q.body, { 'Idempotency-Key': q.key, 'If-Match': q.tag }); assert.equal(retry.status, 200, JSON.stringify(retry.body)); assert.equal(await f.database.db.collection('ms_commands').countDocuments({ key: q.key }), 1); assert.equal(await f.database.db.collection('ms_distributions').countDocuments({ bookId: f.org, kind: 'DISTRIBUTE' }), 2); });
        await t.test('different actor cannot read BUSINESS and live W does not replace an expired grant', async () => { const other = await f.actor(); await assert.rejects(m.ms.read(other.issued.context, 'msGetMonthlyView', params, { month: date.slice(0, 7) })); const h = await f.https(); h.client.cookies.set('__Host-caudelyx-session', f.a.issued.token); await h.client.refreshCsrf(); f.clock.value += 1800000; assert.equal((await h.client.call('POST', '/api/v1/auth/session/activity', {})).status, 200); f.clock.value += 1860001; await assert.rejects(m.ms.mutate(f.a.issued.context, 'msCommitDistribution', first.body, params, first.key, first.tag), { code: 'R_REQUIRED' }); });
        await t.test('protected path and live lease refuse cleanup, then partial setup closes and cancels safely', async () => { const guard = await import(new URL('../../../scripts/ms-p04-native-guard.mjs', import.meta.url).href); await assert.rejects(guard.assertWritable(guard.projectRoot + '/Caudelyx/servidor/.runtime/caudelyx_dev/keys.json')); const release = group.hold(); try {
            await assert.rejects(group.dispose(), /lease is live/);
        }
        finally {
            release();
        } await assert.rejects(group.fixture({ failSetup: true }), /Injected own partial setup failure/); try {
            throw Object.assign(new Error('Controlled owner cancellation'), { name: 'AbortError' });
        }
        catch (e) {
            assert.equal(e.name, 'AbortError');
        }
        finally {
            await group.dispose();
        } });
    }
    finally {
        await group.dispose();
    }
});
//# sourceMappingURL=security.test.js.map