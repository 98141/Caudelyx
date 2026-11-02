import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { s13Profile, world } from './fixture.js';
import { nativeLoan } from './native-seed.js';
import { booksTable } from '../../src/modules/obligations/models.js';
import { verifyRow } from '../../src/modules/obligations/evidence.js';
import { hash } from '../../src/modules/simulation/codec.js';
import { today } from '../../src/modules/obligations/calendar.js';
const { writeOwn } = await import(new URL('../../../scripts/s13-p04-guard.mjs', import.meta.url).href);
test('native S5 portfolio export202 creates one readable CSV using current consistent clock', { timeout: 150000 }, async () => { const group = await s13Profile(), receipt = { runId: group.runId }; try {
    const f = await world(group, Date.now());
    await nativeLoan(f);
    const date = today(f.now()), ps = { organizationId: f.org }, service = f.identity.exchange, report = await service.report(f.a.issued.context, { ...ps, reportKind: 'PORTFOLIO' }, { asOf: date, from: date, to: date });
    receipt['clock'] = { identityUTC: new Date(f.now()).toISOString(), wallUTC: new Date().toISOString() };
    let input = { reportKind: 'PORTFOLIO', snapshotToken: report.data['meta']['snapshotToken'], format: 'CSV' };
    const key = randomUUID(), before = await f.runtime.finance.journals.countDocuments();
    const nativeBefore = hash(await f.runtime.finance.journals.find({}).sort({ _id: 1 }).toArray());
    assert.equal(await f.database.db.collection(booksTable).countDocuments({ _id: f.org }), 0);
    const foreign = await f.actor();
    await assert.rejects(() => service.createExport(foreign.issued.context, ps, input, randomUUID()), (e) => e instanceof Error && 'status' in e && [403, 404].includes(Number(e.status)));
    assert.equal(await f.database.db.collection(booksTable).countDocuments({ _id: f.org }), 0);
    receipt['foreignCannotInitialize'] = true;
    await assert.rejects(() => service.createExport(f.a.issued.context, ps, input, randomUUID()), (e) => e instanceof Error && 'code' in e && e.code === 'REPORT_SNAPSHOT_EXPIRED');
    assert.equal(await f.database.db.collection('s11_exports').countDocuments(), 0);
    assert.equal(await f.database.db.collection('s11_jobs').countDocuments(), 0);
    const book = await f.database.db.collection(booksTable).findOne({ _id: f.org });
    assert.ok(book);
    assert.equal(book['monetaryRevision'], 0);
    assert.equal(verifyRow(f.database, booksTable, book), true);
    const fresh = await service.report(f.a.issued.context, { ...ps, reportKind: 'PORTFOLIO' }, { asOf: date, from: date, to: date });
    input = { ...input, snapshotToken: fresh.data['meta']['snapshotToken'] };
    const result = await service.createExport(f.a.issued.context, ps, input, key);
    assert.equal(result.status, 202);
    assert.equal(result.data['state'], 'SUCCEEDED');
    assert.equal(await f.runtime.finance.journals.countDocuments(), before);
    const replay = await service.createExport(f.a.issued.context, ps, input, key);
    assert.equal(replay.data['id'], result.data['id']);
    assert.equal(await f.database.db.collection('s11_exports').countDocuments(), 1);
    assert.equal(hash(await f.runtime.finance.journals.find({}).sort({ _id: 1 }).toArray()), nativeBefore);
    receipt['initialization'] = { oldSnapshotRejected: true, emptySignedBook: true, monetaryRevision: 0, noJobBeforeRecapture: true, explicitNewSnapshot: true, replayOneExport: true, nativeJournalsUnchanged: true };
    receipt['state'] = 'PASS';
    receipt['export'] = { id: result.data['id'], state: result.data['state'], status: result.status, totalRows: result.data['totalRows'] };
}
catch (e) {
    receipt['state'] = 'FAIL';
    receipt['error'] = { message: String(e), stack: e instanceof Error ? e.stack : '', code: e instanceof Error && 'code' in e ? e.code : null };
    throw e;
}
finally {
    await writeOwn(resolve('../../Construccion/Sprints/S13/Evidencias/S13-P04-EXPORT-FOCUS.json'), JSON.stringify(receipt, null, 2) + '\n');
    await group.dispose();
} });
//# sourceMappingURL=export.test.js.map