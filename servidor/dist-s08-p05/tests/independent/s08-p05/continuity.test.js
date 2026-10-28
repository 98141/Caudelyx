/* eslint-disable security/detect-object-injection -- Own fixed observation keys of this review, never request input. */
// S08-P05 continuity review (Claude): legacy opening without schedule (coverage INCOMPLETE, no false PAR30), offline tampering of a
// reporting source (fail closed, GET never reseals), exact revert + operator review, snapshot token issued before tampering/restore,
// restart in an own peer process (current authority, same figures) and tampering of the approved projection store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BSON } from 'mongodb';
import { s08ReviewProfile } from './review-profile.js';
import { world8, evidence, values, metricsOf, PROJECTION } from './review-fixtures.js';
import { oracle } from './indicators.js';
import { cashSetup } from '../../s07/fixture.js';
const only = (name) => !process.env['P05_ONLY'] || process.env['P05_ONLY'].split(',').some(x => name.startsWith(x));
const EVIDENCE = ['lending_merkle_nodes', 'lending_merkle_orgs', 'lending_domain_state', 'financial_evidence_head', 'audit_events', 'outbox', 'security_evidence_outbox'];
test('P08-K continuity, restore and legacy coverage', { timeout: 3600000 }, async (t) => {
    const group = await s08ReviewProfile();
    try {
        await t.test('K1 apertura legacy sin calendario: INCOMPLETE, PAR30 null, principal no clasificable (AT05 LEGACY)', { skip: !only('K1') }, async (st) => {
            const o = {};
            st.after(() => evidence('P08-K1', { observed: o }));
            const f = await cashSetup(group, true, true), org = f.org, T = f.a, db = f.database.db;
            const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(f.now()));
            const read = async (actor, op, id, q = {}) => { try {
                const r = await f.identity.reporting.read(actor.issued.context, op, org, id, q);
                return { status: r.status, data: r.data };
            }
            catch (e) {
                return { status: Number(e.status ?? 500), code: String(e.code) };
            } };
            const raw = async (name) => await db.collection(name).find({ organizationId: org }).toArray();
            const dataset = async () => ({ loans: await raw('lending_loans'), borrowers: await raw('lending_borrowers'), installments: await raw('loan_installments'), schedules: await raw('loan_schedule_versions'), events: await raw('loan_events'), compensations: await raw('loan_compensations'), payments: await raw('payments'), journals: await raw('financial_journals'), accounts: await raw('financial_accounts'), profile: await db.collection('loan_operation_books').findOne({ _id: org }), custody: await raw('cash_custody'), held: await raw('held_funds_reservations'), deliveries: await raw('cash_deliveries'), scopes: await raw('payment_registration_scopes'), openings: await raw('opening_files') });
            for (const [label, cut] of [['período posterior a la apertura', { asOf: today, from: '2026-10-01', to: today }], ['período que cruza el corte de apertura', { asOf: today, from: '2026-09-01', to: today }]]) {
                const r = await read(T, 'getReportingDashboard', undefined, cut);
                if (r.status !== 200) {
                    o[label] = r;
                    continue;
                }
                const meta = r.data['meta'], exp = oracle(await dataset(), { ...cut, recordedThrough: String(meta['recordedThrough']) }, { kind: 'T', actor: '' });
                const got = metricsOf(r);
                o[label] = { coverage: meta['coverage'], server: Object.fromEntries(Object.entries(got).map(([k, m]) => [k, `${m.value} ${m.status} ${m.reasons.join(',')}`])), oracle: { coverage: exp.coverage, PAR30: exp.metrics['PAR30'], PRINCIPAL_OUTSTANDING: exp.metrics['PRINCIPAL_OUTSTANDING'], PRINCIPAL_LEDGER: exp.metrics['PRINCIPAL_LEDGER'] } };
                if (label === 'período posterior a la apertura') {
                    const tok = String(meta['snapshotToken']);
                    o['PORTFOLIO'] = (await read(T, 'listReportingRows', 'PORTFOLIO', { snapshotToken: tok, limit: '100' })).data?.['items']?.map(x => ({ state: x['state'], principal: x['principal'], dpd: x['dpd'], exposed: x['exposedPrincipal'] }));
                    o['CONCENTRATION'] = (await read(T, 'listReportingRows', 'CONCENTRATION', { snapshotToken: tok, limit: '100' })).data?.['items']?.map(x => ({ group: x['group'], principal: x['principal'], percent: x['percent'], denominator: x['denominator'] }));
                    const c = await read(f.c, 'getReportingDashboard', undefined, cut);
                    o['C asignado (sin apertura ajena)'] = { coverage: c.data?.['meta']?.['coverage']?.['status'], PAR30: values(c, 'assignedMetrics')['PAR30'], unclassifiable: c.data?.['meta']?.['coverage']?.['unclassifiablePrincipal'] };
                    assert.equal(got['PAR30'].value, null);
                    assert.equal(got['PAR30'].status, 'INCOMPLETE');
                    assert.equal(got['PRINCIPAL_LEDGER'].value, exp.metrics['PRINCIPAL_LEDGER']);
                    assert.equal(meta['coverage']['unclassifiablePrincipal'], exp.coverage.unclassifiablePrincipal);
                }
            }
        });
        await t.test('K2 manipulación de fuente, revert exacto, token previo, reinicio en proceso propio y proyección manipulada (AT10)', { skip: !only('K2') }, async (st) => {
            const o = {};
            st.after(() => evidence('P08-K2', { observed: o }));
            const x = await world8(group), f = x.f, T = f.a, cut = { asOf: x.today(), from: '2026-10-01', to: x.today() };
            const db = x.db, ev = async () => { const h = createHash('sha256'); for (const n of EVIDENCE) {
                h.update(n);
                h.update(BSON.EJSON.stringify(await db.collection(n).find({}).sort({ _id: 1 }).toArray(), { relaxed: false }));
            } return h.digest('hex'); };
            const d0 = await x.rep(T, 'getReportingDashboard', undefined, cut), v0 = values(d0), token0 = String(d0.data['meta']['snapshotToken']);
            // (a) restart without changes in an own peer process (fresh runtime + approved projection, same keys/clock).
            const peer = await group.peer({ keys: f.keys, now: f.now() });
            try {
                const pr = await peer.execute({ operation: 'getReportingDashboard', token: T.issued.token, org: x.org, query: cut });
                o['a reinicio sin cambios'] = { type: pr.type, status: pr.status ?? pr.code, sameFigures: pr.type === 'result' && JSON.stringify(values({ status: 200, data: pr.data ?? {} })) === JSON.stringify(v0) };
                const pt = await peer.execute({ operation: 'listReportingRows', id: 'PORTFOLIO', token: T.issued.token, org: x.org, query: { snapshotToken: token0 } });
                o['a sello previo en proceso reiniciado'] = pt.type === 'result' ? String(pt.status) : 'error ' + pt.code;
                // Revocation done in the main process is honoured by the restarted process (current authority).
                const sc = await db.collection('payment_registration_scopes').findOne({ _id: f.scopeId });
                await f.mutatePayment('setPaymentRegistrationScope', { scopeId: f.scopeId, registrarId: f.c.issued.context.subjectId, loanId: f.l.id, scope: 'PAYMENT_REGISTER_ONLY', active: false, resourceETag: `"${f.scopeId}:${sc?.['version']}"`, supportReference: 'SYN-P05-REVOKE' });
                const pc = await peer.execute({ operation: 'getReportingDashboard', token: f.c.issued.token, org: x.org, query: cut });
                o['a C revocado leído en proceso reiniciado'] = pc.type === 'result' ? values({ status: 200, data: pc.data ?? {} }, 'assignedMetrics')['PRINCIPAL_OUTSTANDING'] : 'error ' + pc.code;
            }
            finally {
                await peer.close();
            }
            const d1 = await x.rep(T, 'getReportingDashboard', undefined, cut), v1 = values(d1), token1 = String(d1.data['meta']['snapshotToken']);
            // (b) offline tamper of an installment (reporting source) without evidence update → fail closed, no reseal on GET.
            const inst = await db.collection('loan_installments').findOne({ organizationId: x.org, loanId: f.l.id, number: 2 }), e0 = await ev(), dg0 = await x.digestAll();
            await db.collection('loan_installments').updateOne({ _id: inst['_id'] }, { $set: { interest: '1.00' } });
            const bad = await x.rep(T, 'getReportingDashboard', undefined, cut), badTok = await x.rep(T, 'listReportingRows', 'PORTFOLIO', { snapshotToken: token1 }), badC = await x.rep(f.c, 'getReportingDashboard', undefined, cut);
            o['b tras manipulación'] = { dashboardT: x.st(bad), tokenT: x.st(badTok), dashboardC: x.st(badC), gateOpen: f.restore.isOpen(), evidenceUnchangedByGet: await ev() === e0 };
            // (c) exact revert; gate state, operator review if closed, then old/new tokens.
            await db.collection('loan_installments').replaceOne({ _id: inst['_id'] }, inst);
            const afterRevert = await x.rep(T, 'getReportingDashboard', undefined, cut);
            o['c revert exacto'] = { status: x.st(afterRevert), gateOpen: f.restore.isOpen() };
            if (!f.restore.isOpen()) {
                try {
                    await f.restore.reconcile({ approved: true, reviewId: 'S08_P05_REVIEW_AFTER_REVERT' });
                    o['c revisión operador'] = 'reconciled';
                }
                catch (e) {
                    o['c revisión operador'] = String(e.code ?? e);
                }
            }
            const d2 = await x.rep(T, 'getReportingDashboard', undefined, cut);
            o['c después'] = { status: x.st(d2), sameFigures: JSON.stringify(values(d2)) === JSON.stringify(v1), token1: x.st(await x.rep(T, 'listReportingRows', 'PORTFOLIO', { snapshotToken: token1 })), unchangedDomain: x.diff(dg0.collections, (await x.digestAll()).collections) };
            // (d) projection 0.1: tamper one projected row; the read must not serve a false KPI.
            const rt = await x.w.settle(async () => ({ status: 200, data: await x.activate() }));
            if (rt.status === 200) {
                const pv = values(await x.rep(T, 'getReportingDashboard', undefined, cut)), counts = Object.fromEntries(await Promise.all(PROJECTION.map(async (n) => [n, await db.collection(n).countDocuments({})])));
                const unit = await db.collection('reporting_projection_units').findOne({});
                if (unit) {
                    const json = BSON.EJSON.stringify(unit);
                    const k = Object.keys(unit).find(z => !['_id', 'organizationId', 'mac', 'hash'].includes(z) && typeof unit[z] === 'string');
                    if (k)
                        await db.collection('reporting_projection_units').updateOne({ _id: unit['_id'] }, { $set: { [k]: String(unit[k]) + 'x' } });
                    const pr = await x.rep(T, 'getReportingDashboard', undefined, cut);
                    o['d proyección manipulada'] = { field: k, status: x.st(pr), equalsTruth: pr.status === 200 ? JSON.stringify(values(pr)) === JSON.stringify(pv) : null };
                    await db.collection('reporting_projection_units').replaceOne({ _id: unit['_id'] }, BSON.EJSON.parse(json));
                }
                o['d proyección'] = { equalToDirect: JSON.stringify(pv) === JSON.stringify(v1), counts };
                await x.deactivate(rt.data);
            }
            else
                o['d proyección'] = x.st(rt);
            assert.match(String(o['b tras manipulación'].dashboardT), /^503 /);
            assert.equal(o['b tras manipulación'].evidenceUnchangedByGet, true);
            assert.equal(o['a reinicio sin cambios'].sameFigures, true);
        });
        await t.test('K4 restore real (gate cerrado por manipulación offline de la cabecera de evidencia + revisión) y proyección manipulada', { skip: !only('K4') }, async (st) => {
            const o = {};
            st.after(() => evidence('P08-K4', { observed: o }));
            const x = await world8(group), f = x.f, T = f.a, db = x.db, cut = { asOf: x.today(), from: '2026-10-01', to: x.today() };
            const d0 = await x.rep(T, 'getReportingDashboard', undefined, cut), v0 = values(d0), seal0 = String(d0.data['meta']['snapshotToken']);
            const { Database } = await import('../../../src/shared/database.js'), { RestoreController } = await import('../../../src/shared/restore.js');
            const head = await db.collection('lending_domain_state').findOne({ _id: 'evidence' });
            await db.collection('lending_domain_state').updateOne({ _id: 'evidence' }, { $set: { revision: Number(head['revision']) + 7 } });
            const peer = new Database(group.uri, group.names[0]);
            await peer.connect();
            try {
                const rc = new RestoreController(peer, f.restore.gatePath, f.keys.journal, Reflect.get(f.keys, 'priority'), f.keys.cursor);
                let init = 'ok';
                try {
                    await rc.initialize();
                }
                catch (e) {
                    init = String(e.code ?? e.message);
                }
                o['a arranque con cabecera manipulada'] = { initialize: init, peerOpen: rc.isOpen(), mainOpen: f.restore.isOpen(), dashboard: x.st(await x.rep(T, 'getReportingDashboard', undefined, cut)), seal0: x.st(await x.rep(T, 'listReportingRows', 'PORTFOLIO', { snapshotToken: seal0 })) };
                await db.collection('lending_domain_state').replaceOne({ _id: 'evidence' }, head);
                // Operator path as in S6/S7: a NEW controller after the exact revert, then an approved review if still closed.
                const rc2 = new RestoreController(peer, f.restore.gatePath, f.keys.journal, Reflect.get(f.keys, 'priority'), f.keys.cursor);
                let init2 = 'ok';
                try {
                    await rc2.initialize();
                }
                catch (e) {
                    init2 = String(e.code ?? e.message);
                }
                let rec = 'not needed';
                if (!rc2.isOpen()) {
                    try {
                        await rc2.reconcile({ approved: true, reviewId: 'S08_P05_RESTORE_REVIEW' });
                        rec = 'reconciled';
                    }
                    catch (e) {
                        rec = String(e.code ?? e.message);
                    }
                }
                o['b revert exacto + controlador nuevo + revisión'] = { initialize: init2, reconcile: rec, peerOpen: rc2.isOpen(), mainOpen: f.restore.isOpen() };
            }
            finally {
                await peer.close();
            }
            const d1 = await x.rep(T, 'getReportingDashboard', undefined, cut);
            o['c tras restore'] = { dashboard: x.st(d1), sameFigures: JSON.stringify(values(d1)) === JSON.stringify(v0), sealIssuedBeforeRestore: x.st(await x.rep(T, 'listReportingRows', 'PORTFOLIO', { snapshotToken: seal0 })) };
            // Projection 0.1 in this fresh world: tamper one projected unit; a read must not serve a different KPI as valid.
            const rt = await x.w.settle(async () => ({ status: 200, data: await x.activate() }));
            o['d activar proyección'] = x.st(rt);
            if (rt.status === 200) {
                const pv = values(await x.rep(T, 'getReportingDashboard', undefined, cut)), unit = await db.collection('reporting_projection_units').findOne({});
                o['d proyección = directo'] = JSON.stringify(pv) === JSON.stringify(values(d1));
                if (unit) {
                    const json = BSON.EJSON.stringify(unit, { relaxed: false }), k = Object.keys(unit).find(z => !['_id', 'organizationId'].includes(z) && typeof unit[z] === 'string');
                    if (k)
                        await db.collection('reporting_projection_units').updateOne({ _id: unit['_id'] }, { $set: { [k]: String(unit[k]) + '0' } });
                    const pr = await x.rep(T, 'getReportingDashboard', undefined, cut);
                    o['d unidad proyectada manipulada'] = { field: k, status: x.st(pr), servedFiguresEqualTruth: pr.status === 200 ? JSON.stringify(values(pr)) === JSON.stringify(pv) : null };
                    await db.collection('reporting_projection_units').replaceOne({ _id: unit['_id'] }, BSON.EJSON.parse(json, { relaxed: false }));
                    const pa = await x.rep(T, 'getReportingDashboard', undefined, cut);
                    o['d tras restaurar unidad'] = { status: x.st(pa), equal: pa.status === 200 ? JSON.stringify(values(pa)) === JSON.stringify(pv) : null };
                }
                await x.deactivate(rt.data);
            }
            const pd = o['d unidad proyectada manipulada'];
            if (pd)
                assert.notEqual(pd.servedFiguresEqualTruth, false);
        });
        await t.test('K3 validación cerrada de filtros por HTTPS (OpenAPI) frente a la llamada interna', { skip: !only('K3') }, async (st) => {
            const o = {};
            st.after(() => evidence('P08-K3', { observed: o }));
            const x = await world8(group), f = x.f, https = await f.https(false);
            const { ApiClient } = await import('../../helpers/client.js');
            const cl = new ApiClient(https.port, https.cert);
            cl.cookies.set('__Host-caudelyx-session', f.a.issued.token);
            const base = `/api/v1/organizations/${x.org}/reporting`, d = await cl.call('GET', `${base}/dashboard?asOf=${x.today()}&from=${x.today()}&to=${x.today()}`), tok = encodeURIComponent(String((d.body.data?.['meta'])['snapshotToken']));
            for (const [k, q] of [['ageBand D30', 'ageBand=D30'], ['ageBand vacío', 'ageBand='], ['loanId no uuid', 'loanId=abc'], ['limit abc', 'limit=abc'], ['limit 0', 'limit=0'], ['state minúscula', 'state=active'], ['ageBand válido', 'ageBand=D91_PLUS']]) {
                const r = await cl.call('GET', `${base}/reports/PORTFOLIO?snapshotToken=${tok}&${q}`);
                o['HTTPS ' + k] = `${r.status} ${r.body.error?.code ?? ''}`.trim();
                const inner = await x.rep(f.a, 'listReportingRows', 'PORTFOLIO', { snapshotToken: decodeURIComponent(tok), ...Object.fromEntries([q.split('=')]) });
                o['interno ' + k] = x.st(inner) + (inner.status === 200 ? ' rows=' + String(inner.data?.['totalRows']) : '');
            }
            assert.match(String(o['HTTPS ageBand D30']), /^422 /);
        });
    }
    finally {
        await group.dispose();
    }
});
//# sourceMappingURL=continuity.test.js.map