/* eslint-disable security/detect-non-literal-fs-filename -- Read-only fixed own BUILD-STATE path; all evidence writes pass the exclusive P02 guard. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { base, definition, flow, uid } from './oracle.js';
import { evaluate } from '../../src/modules/simulation/engine.js';
import { isolated } from '../../src/modules/simulation/process.js';
import { AppError } from '../../src/shared/errors.js';
import { s12Profile, world, password } from './fixture.js';
import { today, day } from '../../src/modules/obligations/calendar.js';
const { writeOwn, projectRoot } = await import(new URL('../../../scripts/s12-p02-guard.mjs', import.meta.url).href);
const measurements = [];
test('bounded isolated worker:366days/12outcomes, expansion ceiling, revocation/cancel before publication', { timeout: 60000 }, async () => {
    const b = base(Array.from({ length: 2000 }, (_, i) => flow(10000 + i, day('2026-11-01', i % 366), 'OUT', '0.01')), { cashBook: '10000.00', available: '10000.00', ownDebt: '100.00' }), d = definition({ kind: 'NEW_LOAN', budget: '10.00', configured: true, reserveReleases: [], date: '2026-11-01', principal: '10.00', cashSourceFlowId: null, terms: { kind: 'DECLARED_HYPOTHESIS', sourceReference: 'SYN', principalOpening: '10.00', installments: [{ number: 1, dueDate: '2026-12-01', principal: '10.00', interest: '1.00', insurance: '0.00', fees: '0.00', total: '11.00' }] } });
    d.horizonDays = 366;
    b.books[0].terms = [{ id: uid(900), version: 1, kind: 'LIABILITY', bookId: b.targetBookId, principalOpening: '100.00', installments: [{ number: 1, dueDate: '2026-12-01', principal: '100.00', interest: '1.00', insurance: '0.00', fees: '0.00', total: '101.00' }], prepaymentPermissions: ['REDUCE_INSTALLMENT'], supported: true, reason: null }];
    b.books[0].flows.push(flow(900, '2026-12-01', 'OUT', '100.00', 'DEBT_PRINCIPAL'));
    d.alternatives[1] = { kind: 'DEBT_PREPAYMENT', budget: '10.00', configured: true, reserveReleases: [], liabilityId: uid(900), date: '2026-11-01', prepaymentMode: 'REDUCE_INSTALLMENT', terms: { kind: 'DECLARED_HYPOTHESIS', sourceReference: 'SYN', principalOpening: '90.00', installments: [{ number: 1, dueDate: '2026-12-01', principal: '90.00', interest: '0.90', insurance: '0.00', fees: '0.00', total: '90.90' }] } };
    d.alternatives[3] = { kind: 'ASSET_PURCHASE', budget: '10.00', configured: true, reserveReleases: [], date: '2026-11-01', grossCost: '10.00', ownCash: '10.00', ownDebt: '0.00', directCreditor: true, ownershipFraction: '1.000000', estimatedGrossValue: '12.00', vacancyFraction: '0.000000', rentSchedule: [], costSchedule: [] };
    let checks = 0;
    const start = performance.now(), r = await isolated(b, d, 'capacity', null, async () => { checks++; });
    assert.equal(r.value.outcomes.length, 12);
    assert.equal(r.value.days.length, 4392);
    assert.ok(r.metrics.peakRSS <= 268435456);
    assert.ok(r.metrics.durationMs <= 10000);
    assert.ok(r.value.metrics.expandedFlows <= 50000);
    assert.ok(Buffer.byteLength(JSON.stringify(r.value)) <= 16777216);
    assert.ok(checks >= 2);
    assert.ok(r.metrics.workerPid);
    assert.throws(() => process.kill(r.metrics.workerPid, 0), (e) => e instanceof Error && 'code' in e && e.code === 'ESRCH');
    measurements.push({ case: '366/12/2000sources', ...r.metrics, parentDurationMs: performance.now() - start, expandedFlows: r.value.metrics.expandedFlows, resultBytes: Buffer.byteLength(JSON.stringify(r.value)), checks, childExitAwaited: true });
    const tooLarge = structuredClone(b);
    tooLarge.books[0].flows = Array.from({ length: 50001 }, (_, i) => flow(30000 + i, '2026-11-01', 'OUT', '0.01'));
    assert.throws(() => evaluate(tooLarge, d, { seed: 'limit' }), (e) => e instanceof AppError && e.code === 'SIMULATION_SCOPE_TOO_LARGE');
    for (const code of ['ACCESS_DENIED', 'RUN_STATE_CONFLICT']) {
        let n = 0;
        const start = performance.now();
        await assert.rejects(() => isolated(b, d, 'rejected', null, async () => { if (++n > 1)
            throw new AppError(403, code); }), (e) => e instanceof AppError && e.code === code);
        measurements.push({ case: code, checks: n, durationMs: performance.now() - start, noResultPublished: true });
    }
    await writeOwn(join(projectRoot, 'Construccion/Sprints/S12/Evidencias/S12-P02-CAPACITY-WORKER.json'), JSON.stringify({ state: 'PASS_COMPONENT_WORKER', sourceKey: JSON.parse(await readFile(join(projectRoot, 'Construccion/Sprints/S12/Evidencias/S12-P02-BUILD-STATE.json'), 'utf8')).key, measurements }, null, 2) + '\n');
});
test('native transactional global queue8, one active actor-scope, cancel/revoke never publish', { timeout: 240000 }, async () => {
    const group = await s12Profile();
    try {
        const f = await world(group), service = f.runtime.simulation, actors = [];
        // Native actors and assignments are seeded before evaluating S12 admission.
        for (let i = 0; i < 9; i++) {
            const a = await f.actor();
            await f.runtime.organizations.create(a.issued.context, { name: 'Titular sintético cola ' + i, currency: 'COP', timezone: 'America/Bogota' }, randomUUID());
            const book = await f.mutate('createPersonalBook', { currency: 'COP' }, {}, undefined, randomUUID(), a);
            actors.push({ a, params: { bookId: String(book.data['id']) } });
        }
        const control = service;
        control.pumping = true;
        const runs = [];
        let firstRequest;
        try {
            for (const [i, item] of actors.entries()) {
                const call = async (op, input = {}) => await service.execute(item.a.issued.context, op, input, item.params, {}, randomUUID()), b = await call('captureBasePersonalSimulation', { asOf: today(f.now()), currency: 'COP' }), d = { ...definition(), baseId: b.data['id'], baseToken: b.data['baseToken'] }, scenario = await call('createScenarioPersonalSimulation', { name: 'Cola sintética ' + i, ...d }), request = { scenarioId: scenario.data['id'], scenarioVersion: 1, baseToken: b.data['baseToken'], mode: 'STANDARD', sensitivity: null, evaluateAlerts: false };
                if (i === 0)
                    firstRequest = request;
                if (i === 8) {
                    await assert.rejects(() => call('startRunPersonalSimulation', request), (e) => e instanceof AppError && e.code === 'RATE_LIMITED');
                    break;
                }
                const run = await call('startRunPersonalSimulation', request);
                assert.equal(run.data['state'], 'QUEUED');
                runs.push({ ...item, id: String(run.data['id']), etag: run.etag });
                if (i === 0)
                    await assert.rejects(() => call('startRunPersonalSimulation', request), (e) => e instanceof AppError && e.code === 'RUN_STATE_CONFLICT');
            }
            assert.equal(await f.database.db.collection('s12_runs').countDocuments({ state: 'QUEUED' }), 8);
            assert.equal(await f.database.db.collection('s12_results').countDocuments(), 0);
            for (const run of runs) {
                const r = await service.execute(run.a.issued.context, 'cancelRunPersonalSimulation', {}, { ...run.params, runId: run.id }, {}, randomUUID(), run.etag);
                assert.equal(r.data['state'], 'CANCELLED');
            }
            assert.equal(await f.database.db.collection('s12_results').countDocuments(), 0);
            const owner = actors[0], revokedRun = await service.execute(owner.a.issued.context, 'startRunPersonalSimulation', firstRequest, owner.params, {}, randomUUID());
            await f.identity.revokeSessions(owner.a.issued.context, owner.a.issued.context.managementId);
            control.pumping = false;
            await service.pump();
            assert.equal(await f.database.db.collection('s12_results').countDocuments(), 0);
            await assert.rejects(() => service.execute(owner.a.issued.context, 'getRunPersonalSimulation', {}, { ...owner.params, runId: String(revokedRun.data['id']) }), (e) => e instanceof AppError && e.code === 'AUTH_INVALID');
            owner.a.issued = (await f.identity.login('TENANT', randomUUID(), owner.a.email, password)).issued;
            const durable = await service.execute(owner.a.issued.context, 'getRunPersonalSimulation', {}, { ...owner.params, runId: String(revokedRun.data['id']) });
            assert.equal(durable.data['state'], 'QUEUED', 'no credential was persisted to execute revoked queued work');
            measurements.push({ case: 'native global admission', queued: 8, ninth: 'RATE_LIMITED', sameActor: 'RUN_STATE_CONFLICT', cancelled: 8, results: 0, pumpPause: 'Explicit test interleaving only, no production hook' });
        }
        finally {
            control.pumping = false;
        }
        await writeOwn(join(projectRoot, 'Construccion/Sprints/S12/Evidencias/S12-P02-CAPACITY-NATIVE.json'), JSON.stringify({ state: 'PASS_COMPONENT_NATIVE', sourceKey: JSON.parse(await readFile(join(projectRoot, 'Construccion/Sprints/S12/Evidencias/S12-P02-BUILD-STATE.json'), 'utf8')).key, measurements: measurements.filter(m => m['case'] === 'native global admission'), groupId: group.runId }, null, 2) + '\n');
    }
    finally {
        await group.dispose();
    }
});
//# sourceMappingURL=capacity.test.js.map