/* eslint-disable security/detect-object-injection, security/detect-non-literal-fs-filename -- Own fixed metric ids; exact owned control path of this review's live group. */
// S08-P05 own AT08 measurement (Claude): the author's bulk synthetic fixture tests/s08/fixture.ts benchmarkFixture (read-only, 1k loans
// /10k events/50k lines) seeded into the reviewer's own group; HTTPS dashboard 2 readers × 10 rounds + cold, PORTFOLIO page 100 walk,
// direct path and approved projection 0.1; dashboard figures checked against the own raw-data oracle. No latency promise is derived.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { s08ReviewProfile } from './review-profile.js';
import { benchmarkFixture } from '../../s08/fixture.js';
import { ProjectionRuntime } from '../../../src/modules/reporting/projection/service.js';
import { evidence } from './review-fixtures.js';
import { oracle } from './indicators.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
test('P08-AT08 own volume measurement 1k/10k/50k', { timeout: 2400000 }, async () => {
    const group = await s08ReviewProfile(), release = group.hold(), o = {};
    let projection;
    try {
        const t0 = performance.now(), f = await benchmarkFixture(group, 1000);
        o['seedMs'] = Math.round(performance.now() - t0);
        o['counts'] = f.benchmarkCounts;
        const web = await f.https();
        web.client.cookies.set('__Host-caudelyx-session', f.a.issued.token);
        const base = '/api/v1/organizations/' + f.org + '/reporting', q = '?from=2026-10-01&to=2027-07-31&asOf=2027-07-31';
        const measure = async (label) => {
            const lat = [], st = [], bytes = [];
            const call = async () => { const s = performance.now(), r = await web.client.call('GET', base + '/dashboard' + q), ms = performance.now() - s; st.push(r.status); bytes.push(JSON.stringify(r.body).length); if (r.status === 200)
                lat.push(ms); return { r, ms }; };
            const cold = await call();
            const coldMs = Math.round(cold.ms);
            lat.pop();
            for (let i = 0; i < 10; i++)
                await Promise.all([call(), call()]);
            const s = [...lat].sort((a, b) => a - b), p = (x) => s.length ? Math.round(s[Math.min(s.length - 1, Math.ceil(x * s.length) - 1)] * 10) / 10 : null;
            let page = null, walk = null;
            if (cold.r.status === 200) {
                const tok = encodeURIComponent(String(cold.r.body.data['meta']['snapshotToken']));
                const ps = performance.now(), pg = await web.client.call('GET', base + '/reports/PORTFOLIO?snapshotToken=' + tok + '&limit=100');
                page = { status: pg.status, ms: Math.round(performance.now() - ps), items: pg.body.data?.['items']?.length, totalRows: pg.body.data?.['totalRows'] };
                let cursor = pg.body.data?.['nextCursor'], pages = 1, rows = pg.body.data?.['items']?.length ?? 0;
                const ws = performance.now();
                while (cursor && pages < 20) {
                    const r = await web.client.call('GET', base + '/reports/PORTFOLIO?snapshotToken=' + tok + '&limit=100&cursor=' + encodeURIComponent(cursor));
                    if (r.status !== 200) {
                        walk = { failedAt: pages, status: r.status, code: r.body.error?.code };
                        break;
                    }
                    pages++;
                    rows += r.body.data['items'].length;
                    cursor = r.body.data['nextCursor'];
                }
                walk ??= { pages, rows, ms: Math.round(performance.now() - ws) };
            }
            o[label] = { coldMs, coldStatus: cold.r.status, coldCode: cold.r.body.error?.code ?? null, statuses: [...new Set(st)], successful: s.length, concurrency: 2, p50Ms: p(0.5), p95Ms: p(0.95), maxMs: s.length ? Math.round(s.at(-1)) : null, responseBytes: Math.max(...bytes), page100: page, walkPortfolio: walk, memoryRss: process.memoryUsage().rss };
            return cold.r;
        };
        const direct = await measure('directo (sin proyección)');
        const i0 = performance.now();
        projection = await ProjectionRuntime.createOwned(f.identity, f.keys.cursor, async () => { const owner = JSON.parse(await readFile(join(group.folder, 'owner.json'), 'utf8')); return owner.runId === group.runId && owner.pid === process.pid && owner.names[0] === f.database.db.databaseName; });
        f.identity.reporting.projection = projection;
        o['projectionInitMs'] = Math.round(performance.now() - i0);
        const proj = await measure('proyección 0.1');
        // Own oracle on the raw 1k dataset for the figures of the successful response.
        const ok = proj.status === 200 ? proj : direct.status === 200 ? direct : null;
        if (ok) {
            const db = f.database.db, org = f.org, raw = async (n) => await db.collection(n).find({ organizationId: org }).toArray();
            const data = { loans: await raw('lending_loans'), borrowers: await raw('lending_borrowers'), installments: await raw('loan_installments'), schedules: await raw('loan_schedule_versions'), events: await raw('loan_events'), compensations: await raw('loan_compensations'), payments: await raw('payments'), journals: await raw('financial_journals'), accounts: await raw('financial_accounts'), profile: await db.collection('loan_operation_books').findOne({ _id: org }), custody: await raw('cash_custody'), held: await raw('held_funds_reservations'), deliveries: await raw('cash_deliveries'), scopes: await raw('payment_registration_scopes'), openings: await raw('opening_files') };
            const meta = ok.body.data['meta'], exp = oracle(data, { asOf: '2027-07-31', from: '2026-10-01', to: '2027-07-31', recordedThrough: String(meta['recordedThrough']) }, { kind: 'T', actor: '' });
            const got = Object.fromEntries(ok.body.data['organizationMetrics'].map(m => [m['id'], m['value']]));
            o['oráculo 1k'] = Object.fromEntries(['PRINCIPAL_OUTSTANDING', 'INTEREST_ACCRUED', 'LIQUIDITY_BOOK', 'PRINCIPAL_OVERDUE', 'PRINCIPAL_EXPOSED_OVERDUE', 'PAR30', 'INTEREST_RECEIVABLE'].map(k => [k, { server: got[k], oracle: exp.metrics[k] }]));
            o['esperado autor'] = f.expected;
        }
        o['node'] = process.version;
    }
    finally {
        evidence('P08-AT08', { observed: o });
        await projection?.stop();
        release();
        await group.dispose();
    }
    const or = o['oráculo 1k'];
    if (or)
        for (const [k, v] of Object.entries(or))
            assert.equal(v.server, v.oracle, k);
});
//# sourceMappingURL=perf.test.js.map