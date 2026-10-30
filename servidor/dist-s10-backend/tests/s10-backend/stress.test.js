/* eslint-disable security/detect-object-injection -- Four closed benchmark mode names index local timing arrays. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { s10Profile } from './profile.js';
import { world } from './fixture.js';
import { signRow, managementEvidenceMatches, managementHead } from '../../src/modules/obligations/evidence.js';
import { decimal } from '../../src/modules/finance/money.js';
import { ProjectionRuntime } from '../../src/modules/reporting/projection/service.js';
import { booksTable } from '../../src/modules/obligations/models.js';
const small = process.env['S10_STRESS_PREFLIGHT'] === '1', batches = small ? 1 : 20, population = batches * 50;
test('S10 affected current/list/historical paths ' + population + ' assets, ' + population * 10 + ' units, ' + population * 50 + ' journal lines, 2 readers', { timeout: 600000 }, async () => {
    const group = await s10Profile(), wall = performance.now();
    try {
        const f = await world(group), bank = await f.personal('ST_BANK', 'ASSET', 'BANK'), asset = await f.personal('ST_ASSET'), income = await f.personal('ST_INCOME', 'INCOME'), equity = await f.personal('ST_EQUITY', 'EQUITY'), scope = { kind: 'PERSONAL', bookId: f.book.id, ownerId: f.a.issued.context.subjectId }, params = { bookId: f.book.id }, date = '2026-10-28';
        await f.service.stop();
        await f.projection.stop();
        f.clock.open = false;
        const seedStart = performance.now(), base = f.now();
        let tick = 0;
        for (let batch = 0; batch < batches; batch++)
            await f.database.transaction(async (s) => {
                f.service.store.tracking.begin(s);
                try {
                    const groups = new Map(), add = (name, input) => { const row = signRow(f.database, name, { ...input, bookId: scope.bookId, ownerId: scope.ownerId, domainKind: 'PERSONAL' }), rows = groups.get(name) ?? []; rows.push(row); groups.set(name, rows); return row; };
                    for (let k = 0; k < 50; k++) {
                        const id = randomUUID(), acquisition = randomUUID(), initial = new Date(base + (++tick)).toISOString(), assetBody = { _id: id, version: 2, assetClass: 'HOUSE', otherClassDescription: null, label: 'Sintético ' + String(batch * 50 + k).padStart(4, '0'), origin: 'OPENING', legalOwnerReference: 'SYN', ownershipPercentage: '100.00', grossCostDeclared: '1000.00', recognizedCost: '1000.00', assetAccountId: asset.id, supportReferences: ['SYN'], locationGeneral: null, status: 'ACTIVE', liabilityIds: [], acquisitionEventId: acquisition };
                        const draft = signRow(f.database, 's10_assets_personal', { ...assetBody, version: 1, status: 'DRAFT', recognizedCost: '0.00', acquisitionEventId: null, bookId: scope.bookId, ownerId: scope.ownerId, domainKind: 'PERSONAL', recordedAt: initial });
                        add('s09_history_personal', { _id: 's10_assets_personal:' + id + ':1', version: 1, recordedAt: initial, entityTable: 's10_assets_personal', entityId: id, payload: draft });
                        let acquisitionAt = initial;
                        for (let n = 0; n < 10; n++) {
                            const eventId = n === 0 ? acquisition : randomUUID(), journalId = randomUUID(), stamp = new Date(base + (++tick)).toISOString(), kind = n === 0 ? 'ASSET_EXISTING_LINK' : 'ASSET_RENT_RECEIVE', amount = n === 0 ? '1000.00' : '10.00', lines = n === 0 ? [{ accountId: asset.id, debit: decimal('500.00'), credit: decimal('0.00') }, { accountId: asset.id, debit: decimal('500.00'), credit: decimal('0.00') }, ...['250.00', '250.00', '500.00'].map(v => ({ accountId: equity.id, debit: decimal('0.00'), credit: decimal(v) }))] : [...Array.from({ length: 4 }, () => ({ accountId: bank.id, debit: decimal('2.50'), credit: decimal('0.00') })), { accountId: income.id, debit: decimal('0.00'), credit: decimal('10.00') }];
                            add('s09_personal_journals', { _id: journalId, version: 1, recordedAt: stamp, effectiveDate: date, sourceKind: n === 0 ? 'EXISTING_SYNTHETIC_LEDGER' : 'MANAGEMENT_OPERATION', sourceId: eventId, supportReference: 'SYN-STRESS', reversalOfId: null, lines });
                            if (n > 0)
                                add('s09_events_personal', { _id: eventId, version: 1, recordedAt: stamp, entityId: id, kind, effectiveDate: date, unitKnownAt: stamp, amount, allocations: [], journalIds: [journalId], reversalOfId: null, components: { wealthRootId: eventId } });
                            add('s10_asset_events_personal', { _id: eventId, version: 1, recordedAt: stamp, entityId: id, kind, effectiveDate: date, unitKnownAt: stamp, amount, reversalOfId: null, journalIds: n === 0 ? [] : [journalId], ledgerEventIds: n === 0 ? [] : [eventId], deltas: [], details: { assetAccountId: asset.id, costDelta: n === 0 ? '1000.00' : '0.00' } });
                            if (n === 0) {
                                acquisitionAt = stamp;
                                for (const lineIndex of [0, 1])
                                    add('s10_source_claims_personal', { _id: randomUUID(), version: 1, recordedAt: stamp, assetId: id, sourceKind: 'EXISTING_JOURNAL', sourceId: journalId, journalId, lineIndex, componentId: null, amount: '500.00', status: 'CLAIMED', sourceEventId: eventId });
                                add('s10_asset_funding_personal', { _id: randomUUID(), version: 1, recordedAt: stamp, assetId: id, amount: '1000.00', provenanceKind: 'SUPPORTED_REFERENCE', reference: 'SYN-EXISTING-LEDGER', sourceKind: 'JOURNAL', sourceEventId: eventId, details: { journalId } });
                            }
                        }
                        add('s10_assets_personal', { ...assetBody, recordedAt: acquisitionAt });
                    }
                    for (const [name, rows] of groups) {
                        await f.database.db.collection(name).insertMany(rows, { session: s });
                        for (const row of rows)
                            f.service.store.tracking.capture(s, name, null, row);
                    }
                    const book = await f.service.store.get(booksTable, scope.bookId, scope, s);
                    await f.service.store.put(booksTable, { ...book, version: book.version + 500, monetaryRevision: book.monetaryRevision + 500, recordedAt: new Date(base + tick + 1).toISOString() }, s, false);
                    await f.service.store.finish(s);
                    await f.identity.audit.append({ realm: 'TENANT', actorId: scope.ownerId, subjectId: scope.ownerId, action: 'SYNTHETIC_OWNED_S10_STRESS_SEED', outcome: 'SUCCESS' }, s);
                }
                finally {
                    f.service.store.tracking.end(s);
                }
            });
        f.clock.value = base + tick + 100;
        const seedMs = performance.now() - seedStart;
        await group.phase('large-seed', seedMs);
        const verifyStart = performance.now();
        assert.equal(await managementEvidenceMatches(f.database, (await managementHead(f.database))), true);
        assert.equal(await f.database.db.collection('s10_assets_personal').countDocuments(), population);
        assert.equal(await f.database.db.collection('s10_asset_events_personal').countDocuments(), population * 10);
        assert.equal((await f.database.db.collection('s09_personal_journals').aggregate([{ $unwind: '$lines' }, { $count: 'lines' }]).toArray())[0]?.['lines'], population * 50);
        f.clock.open = true;
        await f.service.prepareOwned(f.owner);
        await f.service.activateOwned(f.owner);
        f.identity.reporting.projection = await ProjectionRuntime.createOwned(f.identity, f.keys.cursor, f.owner);
        await f.restore.flush();
        const verifyMs = performance.now() - verifyStart;
        const timings = {}, errors = [];
        for (const mode of ['current-list', 'historical-list', 'current-positions', 'current-availability'])
            for (let pair = 0; pair < 5; pair++)
                await Promise.all([0, 1].map(async () => {
                    const start = performance.now();
                    try {
                        const result = await f.wealthRead(mode === 'current-positions' ? 'personalGetWealthPositions' : mode === 'current-availability' ? 'personalGetWealthAvailability' : 'personalListAssets', params, { asOf: date, ...(mode === 'current-availability' ? { accountId: bank.id } : mode === 'current-positions' ? {} : { limit: 100 }), ...(mode === 'historical-list' ? { recordedThrough: new Date(base + Math.floor(tick / 2)).toISOString() } : {}) });
                        if (mode === 'current-positions') {
                            assert.equal(result.data['recognizedAssetCost'], population * 1000 + '.00');
                            assert.equal(result.data['cashAvailable'], population * 90 + '.00');
                        }
                        else if (mode === 'current-availability')
                            assert.equal(result.data['free'], population * 90 + '.00');
                        else
                            assert.equal(result.data.items.length, Math.min(mode === 'historical-list' ? population / 2 : population, 100));
                        (timings[mode] ??= []).push(performance.now() - start);
                    }
                    catch (e) {
                        errors.push(mode + ':' + String(e));
                    }
                }));
        const fund = await f.wealthMutate('personalCreateFund', { mode: 'VIRTUAL', label: 'Reserva de estrés', purpose: 'SAVINGS', backingAccountId: bank.id, supportReference: 'SYN' }, params), fundId = String(fund.data['id']), fundParams = { ...params, fundId };
        for (let i = 0; i < 10; i++) {
            const book = await f.wealthRead('personalGetWealthBook', params, { asOf: date }), view = await f.wealthRead('personalGetFund', fundParams, { asOf: date }), start = performance.now();
            await f.wealthMutate('personalAllocateFund', { bookETag: book.etag, effectiveDate: date, amount: '1.00', supportReference: 'SYN' }, fundParams, view.etag);
            (timings['reservation-writer'] ??= []).push(performance.now() - start);
        }
        const summaries = Object.fromEntries(Object.entries(timings).map(([name, values]) => { const sorted = [...values].sort((a, b) => a - b); return [name, { samples: values, p50: sorted[Math.ceil(sorted.length * .5) - 1] ?? null, p95: sorted[Math.ceil(sorted.length * .95) - 1] ?? null }]; })), result = { atUTC: new Date().toISOString(), small, dimensions: { assets: population, wealthUnits: population * 10, managementReferences: population * 9, journalLines: population * 50, readers: 2, page: 100 }, seedMs, verifyMs, paths: summaries, errors, targetMs: 2000, requestBudgetMs: 10000, wallMs: performance.now() - wall, seedPolicy: 'Own closed offline synthetic group. Existing recognized ledger links and actual rent journals, signed originals/history/claims and tracked manifests; complete verification before reopening. No persistent migration or reduced MFA/crypto/limits.' };
        const filename = resolve('../../Construccion/Sprints/S10/Evidencias/S10-P02-v2-STRESS.json');
        let report;
        try {
            report = JSON.parse(await readFile(filename, 'utf8'));
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
            report = { runs: [] };
        }
        report.runs.push(result);
        await writeFile(filename, JSON.stringify(report, null, 2) + '\n');
        console.log('S10_STRESS', JSON.stringify(result));
        assert.equal(errors.length, 0);
        for (const stats of Object.values(summaries)) {
            assert.equal(stats.samples.length, 10);
            assert.ok(stats.p95 !== null && stats.p95 <= 2000, 'p95 exceeds unchanged 2s target');
        }
    }
    finally {
        await group.dispose();
    }
});
//# sourceMappingURL=stress.test.js.map