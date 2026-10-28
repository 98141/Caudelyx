/* eslint-disable security/detect-non-literal-fs-filename -- Fixed owned fixture metadata and reporting field names. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { s08Profile } from './profile.js';
import { cashSetup } from '../s07/fixture.js';
import { ProjectionRuntime } from '../../src/modules/reporting/projection/service.js';
import { originals, collections } from '../../src/modules/reporting/projection/catalog.js';
import { hash } from '../../src/modules/reporting/projection/codec.js';
import { today } from '../../src/modules/finance/service.js';
const value = (d, id) => [...(d['organizationMetrics'] ?? []), ...(d['ownActivityMetrics'] ?? [])].find(m => m['id'] === id)?.['value'];
const cents = (v) => BigInt(String(v).replace('.', ''));
test('H-S8-P05-01 active compensation is reserve, not FORWARD custody commitment', { timeout: 180000 }, async () => {
    const group = await s08Profile();
    let projection;
    try {
        const f = await cashSetup(group), web = await f.https(), base = '/api/v1/organizations/' + f.org + '/reporting', query = '?from=2026-10-01&to=' + today(f.now()) + '&asOf=' + today(f.now());
        projection = await ProjectionRuntime.createOwned(f.identity, f.keys.cursor, async () => { const owner = JSON.parse(await readFile(join(group.folder, 'owner.json'), 'utf8')); return owner.pid === process.pid && owner.runId === group.runId && owner.names[0] === f.database.db.databaseName; });
        f.identity.reporting.projection = projection;
        const digest = async () => { const data = []; for (const name of [...originals, ...Object.values(collections).filter(n => n !== collections.barriers), 'audit_events', 'outbox', 'transaction_fence'])
            data.push([name, await f.database.db.collection(name).find({}).sort({ _id: 1 }).toArray()]); return hash(data); };
        const report = async (actor = f.a) => { web.client.cookies.set('__Host-caudelyx-session', actor.issued.token); const response = await web.client.call('GET', base + '/dashboard' + query); assert.equal(response.status, 200, JSON.stringify(response.body)); const d = response.body.data; const rows = await web.client.call('GET', base + '/reports/CASH?snapshotToken=' + encodeURIComponent(String(d['meta']['snapshotToken'])) + '&limit=100'); assert.equal(rows.status, 200, JSON.stringify(rows.body)); return { d, rows: rows.body.data['items'] }; };
        const id = String((await (await f.request()).execute()).data['entityId']);
        const forward = await report();
        assert.equal(value(forward.d, 'CUSTODY_COMMITTED'), '250000.00');
        assert.equal(forward.rows.find(r => r['accountId'] === f.cash.id)['committed'], '250000.00');
        assert.equal(value((await report(f.c)).d, 'CUSTODY_COMMITTED'), '250000.00');
        await f.act('dispatchCashDelivery', id, f.c);
        await f.act('receiveCashDelivery', id, f.o);
        await f.count(id);
        await (await f.confirm(id)).execute();
        const done = await report();
        assert.equal(value(done.d, 'CUSTODY_COMMITTED'), '0.00');
        assert.equal(value(done.d, 'CUSTODY_CONFIRMED'), '50000.00');
        assert.equal(value(done.d, 'LIQUIDITY_RESERVED'), '50000.00');
        const original = await f.delivery(id), compensation = await (await f.prepareCollections({ kind: 'COMPENSATE_REQUEST', originalDeliveryId: id, resourceETag: '"' + id + ':' + original.version + '"', reason: 'Retorno real sintético', supportReference: 'C01' })).execute(), cid = String(compensation.data['entityId']);
        // The existing S7 reader uses Database.transaction and advances its security fence; finish it before the reporting-only baseline.
        const s7 = (await f.readCollections('getCashPosition', f.o.issued.context.subjectId, f.o)).data.items.find(r => r['accountId'] === f.central.id);
        const before = await digest(), active = await report(), o = await report(f.o), c = await report(f.c), central = active.rows.find(r => r['accountId'] === f.central.id);
        const observed = { T: value(active.d, 'CUSTODY_COMMITTED'), O: value(o.d, 'CUSTODY_COMMITTED'), C: value(c.d, 'CUSTODY_COMMITTED'), central: central['committed'], S7committed: s7['committed'], S7compensationReserve: s7['compensationReserve'], reserved: value(active.d, 'LIQUIDITY_RESERVED'), confirmed: value(active.d, 'CUSTODY_CONFIRMED') };
        console.log('H01_ACTIVE_COMPENSATION', JSON.stringify(observed));
        assert.equal(observed.S7committed, '0.00');
        assert.equal(observed.S7compensationReserve, '250000.00');
        assert.equal(observed.reserved, '300000.00');
        assert.equal(observed.confirmed, '50000.00');
        assert.equal(cents(value(done.d, 'LIQUIDITY_AVAILABLE')) - cents(value(active.d, 'LIQUIDITY_AVAILABLE')), 25000000n);
        assert.equal(observed.T, '0.00', 'T CUSTODY_COMMITTED must exclude active COMPENSATION');
        assert.equal(observed.O, '0.00');
        assert.equal(observed.C, '0.00');
        assert.equal(observed.central, '0.00');
        assert.equal(o.rows.find(r => r['accountId'] === f.central.id)['committed'], '0.00');
        assert.equal(await digest(), before, 'Read-only reporting must not mutate originals/book/evidence/audit/fence');
        await f.act('dispatchCashDelivery', cid, f.o);
        await f.act('receiveCashDelivery', cid, f.c);
        await f.count(cid, '250000.00', f.c);
        await (await f.confirm(cid, true)).execute();
        const final = await report();
        assert.equal(value(final.d, 'CUSTODY_COMMITTED'), '0.00');
        assert.equal(value(final.d, 'CUSTODY_CONFIRMED'), '300000.00');
        assert.equal(value(final.d, 'LIQUIDITY_RESERVED'), '300000.00');
        assert.equal(value(final.d, 'DELIVERED_NET'), '0.00');
        assert.equal(value(final.d, 'RECEIPTS_CONFIRMED'), '300000.00');
        assert.equal(value(final.d, 'INTEREST_RECEIVED'), '60000.00');
        console.log('H01_FOCAL_PASS FORWARD250->confirmed0->activeComp0/reserve250->confirmedComp0;T/C/O/CENTRAL;GETwrites0');
    }
    finally {
        await projection?.stop();
        await group.dispose();
    }
});
//# sourceMappingURL=committed.test.js.map