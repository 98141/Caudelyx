/* eslint-disable security/detect-object-injection -- Own fixed labels/actor maps of this review, never request input. */
// S10-P05 own privacy review (Claude): PERSONAL wealth (funds, assets, sources, positions, private wealth) of T must not reach collaborators
// C/O/P/A of the same org, T of another org, SA/T+SA, BUSINESS routes, S8/S9 business reports, foreign tokens or HTTPS caches; BUSINESS
// wealth is T-only; authority is current (role change, org suspension, leaving the org simulated by direct identity update).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { s10ReviewProfile } from './review-profile.js';
import { world, evidence, info, idOf, rate, official } from './review-fixtures.js';
const D = '2026-10-28';
test('S10-P05 privacidad propia: patrimonio PERSONAL aislado, BUSINESS solo T, autoridad actual', { timeout: 900000 }, async () => {
    const group = await s10ReviewProfile(), o = {}, fail = [];
    const expect = (at, got, want) => { const g = JSON.stringify(got), w = JSON.stringify(want); o['check ' + at] = g === w ? 'PASS' : { got, want }; if (g !== w)
        fail.push(`${at}: ${g} ≠ ${w}`); };
    try {
        const x = await world(group), P = { bookId: x.book.id }, B = { organizationId: x.org };
        const ok = async (label, fn) => { const r = await x.settle(fn); if (![200, 201].includes(r.status))
            throw Error(`${label}: ${x.st(r)}`); return r; };
        const ptag = async () => String((await x.wealthRead('personalGetWealthBook', P)).etag);
        const wallet = (await x.personal('V_WALLET', 'ASSET', 'BANK')).id, cap = (await x.personal('V_CAP', 'EQUITY')).id, prop = (await x.personal('V_PROP', 'ASSET')).id, debt = (await x.personal('V_DEBT', 'LIABILITY')).id;
        await ok('aporte', async () => x.wealthMutate('personalRecordExternalFunds', { bookETag: await ptag(), effectiveDate: D, amount: '76543210.98', cashAccountId: wallet, provenanceKind: 'DECLARED', supportReference: 'SYN-R10-PRIV', nature: 'OWNER_CAPITAL_CONTRIBUTION', equityAccountId: cap, contributorReference: 'SYN-R10-OWNER' }, P));
        const fund = await ok('fondo', () => x.wealthMutate('personalCreateFund', { mode: 'VIRTUAL', label: 'PRIVADO-R10-FONDO', purpose: 'SAVINGS', backingAccountId: wallet, supportReference: 'SYN-R10-PRIV' }, P)), fp = { ...P, fundId: idOf(fund) };
        await ok('asignar', async () => x.wealthMutate('personalAllocateFund', { bookETag: await ptag(), effectiveDate: D, amount: '1234567.89', supportReference: 'SYN-R10-PRIV' }, fp, (await x.wealthRead('personalGetFund', fp)).etag));
        const draft = await ok('borrador', () => x.wealthMutate('personalCreateAssetDraft', { assetClass: 'HOUSE', otherClassDescription: null, label: 'PRIVADO-R10-CASA', origin: 'PURCHASE', legalOwnerReference: 'SYN-R10-OWNER', ownershipPercentage: '100.00', grossCostDeclared: '98765432.10', assetAccountId: prop, supportReferences: ['SYN-R10-PRIV'], locationGeneral: null }, P)), ap = { ...P, assetId: idOf(draft) };
        await ok('adquirir', async () => x.wealthMutate('personalAcquireAsset', { bookETag: await ptag(), effectiveDate: D, ownedConsideration: '98765432.10', capitalizedCosts: [], funding: [{ nature: 'EXISTING_CASH', settlementMode: 'FROM_ACCOUNT', accountId: wallet, sourceJournalId: null, amount: '50000000.00', provenanceKind: 'DECLARED', reference: 'SYN-R10' }, { nature: 'DIRECT_NEW_DEBT', settlementMode: 'DIRECT_SELLER', principalAccountId: debt, liabilityDefinition: { kind: 'BANK_LOAN', label: 'PRIVADO-R10-HIPOTECA', counterpartyReference: 'SYN-R10', principal: '48765432.10', rate, schedule: official('48765432.10', '2026-11-28'), prepaymentPermissions: [], supportReference: 'SYN-R10' }, amount: '48765432.10', provenanceKind: 'SUPPORTED_REFERENCE', reference: 'SYN-R10' }], supportReference: 'SYN-R10-PRIV' }, ap, (await x.wealthRead('personalGetAsset', ap)).etag));
        const markers = ['PRIVADO-R10', '76543210.98', '1234567.89', '98765432.10', '48765432.10', '26543210.98', x.book.id, idOf(fund), idOf(draft)];
        const leaks = (r) => markers.filter(m => JSON.stringify(r ?? null).includes(m));
        const C = await x.member(['C']), O = await x.member(['O']), Pm = await x.member(['P']), A = await x.member(['A']), T2 = await x.actor();
        await x.runtime.organizations.create(T2.issued.context, { name: 'Otra organización sintética', currency: 'COP', timezone: 'America/Bogota' }, randomUUID());
        const r = async (label, fn) => { const res = await x.settle(fn); o[label] = { status: x.st(res), leaks: leaks(res) }; return res; };
        const reads = [['libro', 'personalGetWealthBook', P], ['fondos', 'personalListFunds', P], ['fondo', 'personalGetFund', fp], ['activos', 'personalListAssets', P], ['activo', 'personalGetAsset', ap], ['fuentes', 'personalListAssetSources', ap], ['posiciones', 'personalGetWealthPositions', P], ['disponibilidad', 'personalGetWealthAvailability', P]];
        const g0 = await x.digestAll();
        for (const [who, actor] of [['C', C], ['O', O], ['P', Pm], ['A', A], ['T otra org', T2]]) {
            for (const [k, op, ps] of reads)
                await r(`${who} ${k} PERSONAL de T`, () => x.wealthRead(op, ps, k === 'disponibilidad' ? { asOf: D, accountId: wallet } : { asOf: D }, actor));
            await r(`${who} patrimonio privado`, () => x.wealthRead('getPrivateWealth', {}, { asOf: D }, actor));
            await r(`${who} libro wealth BUSINESS`, () => x.wealthRead('businessGetWealthBook', B, { asOf: D }, actor));
            await r(`${who} activos BUSINESS`, () => x.wealthRead('businessListAssets', B, { asOf: D }, actor));
        }
        const missing = await r('C activo inexistente', () => x.wealthRead('personalGetAsset', { ...P, assetId: randomUUID() }, { asOf: D }, C));
        const s8 = await r('T dashboard S8 BUSINESS', () => x.runtime.reporting.read(x.a.issued.context, 'getReportingDashboard', x.org, undefined, { asOf: D, from: '2026-10-01', to: D }));
        const tok = String(s8.data['meta']['snapshotToken']);
        for (const kind of ['MOVEMENTS', 'CASH'])
            await r(`T S8 ${kind}`, () => x.runtime.reporting.read(x.a.issued.context, 'listReportingRows', x.org, kind, { snapshotToken: tok, limit: 100 }));
        await r('T S9 consolidado privado', () => x.read('getPrivateConsolidation'));
        await r('T wealth BUSINESS propio', () => x.wealthRead('businessListAssets', B));
        const g1 = await x.digestAll(), changed = x.diff(g0, g1);
        o['lecturas: colecciones cambiadas'] = changed;
        expect('lecturas puras: solo barreras técnicas de observador', changed.filter(c => !['reporting_projection_barriers', 's09_projection_barriers'].includes(c)), []);
        for (const who of ['C', 'O', 'P', 'A', 'T otra org']) {
            for (const [k] of reads)
                expect(`${who} ${k} PERSONAL de T → 404 sin datos`, o[`${who} ${k} PERSONAL de T`], { status: '404 RESOURCE_NOT_FOUND', leaks: [] });
            expect(`${who} patrimonio privado sin datos de T`, o[`${who} patrimonio privado`].leaks, []);
            for (const k of ['libro wealth BUSINESS', 'activos BUSINESS'])
                expect(`${who} ${k} denegado sin datos`, [/^40[34] /.test(o[`${who} ${k}`].status), o[`${who} ${k}`].leaks], [true, []]);
        }
        expect('404 uniforme: ajeno = inexistente', o['C activo PERSONAL de T'].status, x.st(missing));
        for (const k of ['T dashboard S8 BUSINESS', 'T S8 MOVEMENTS', 'T S8 CASH', 'T wealth BUSINESS propio'])
            expect(`${k} sin marcadores PERSONAL`, o[k].leaks, []);
        // ---- foreign snapshot tokens
        const list = await x.wealthRead('personalListAssets', P), ptok = String(list.meta['snapshotToken']);
        await ok('T2 libro', () => x.mutate('createPersonalBook', { currency: 'COP' }, {}, undefined, randomUUID(), T2));
        const t2book = String(info(await x.read('getOwnPersonalBook', {}, { asOf: D }, T2))['id']);
        const cross = await r('token PERSONAL en BUSINESS', () => x.wealthRead('businessListAssets', B, { asOf: D, snapshotToken: ptok })), foreign = await r('token de T usado por T2', () => x.wealthRead('personalListAssets', { bookId: t2book }, { asOf: D, snapshotToken: ptok }, T2));
        expect('token PERSONAL en BUSINESS rechazado', cross.status >= 400 && leaks(cross).length === 0, true);
        expect('token de otro actor rechazado', foreign.status >= 400 && leaks(foreign).length === 0, true);
        const intrude = await x.settle(() => x.wealthMutate('personalCreateFund', { mode: 'VIRTUAL', label: 'Intruso', purpose: 'SAVINGS', backingAccountId: wallet, supportReference: 'SYN' }, P, undefined, randomUUID(), T2));
        expect('T2 escribe en libro de T → 404', x.st(intrude), '404 RESOURCE_NOT_FOUND');
        // ---- current authority: SA / T+SA, org suspended, leaving org
        const subject = x.a.issued.context.subjectId, ids = x.identity.identities, original = (await ids.findOne({ _id: subject }));
        for (const roles of [['SA'], ['T', 'SA']]) {
            await ids.updateOne({ _id: subject }, { $set: { roles: roles } });
            expect(`roles ${roles.join('+')} → wealth PERSONAL 403`, x.st(await x.settle(() => x.wealthRead('personalListAssets', P))), '403 ACCESS_DENIED');
        }
        await ids.updateOne({ _id: subject }, { $set: { roles: original.roles } });
        const orgs = x.database.db.collection('organizations'), orgRow = (await orgs.findOne({ _id: x.org }));
        await orgs.updateOne({ _id: x.org }, { $set: { status: 'SUSPENDED' } });
        expect('org suspendida: wealth PERSONAL sigue / BUSINESS denegado', [x.st(await x.settle(() => x.wealthRead('personalGetAsset', ap))), /^40[34] /.test(x.st(await x.settle(() => x.wealthRead('businessListAssets', B))))], ['200', true]);
        await orgs.updateOne({ _id: x.org }, { $set: { status: orgRow.status } });
        await ids.updateOne({ _id: subject }, { $set: { organizationId: null, roles: [] } });
        const after = { asset: x.st(await x.settle(() => x.wealthRead('personalGetAsset', ap))), business: x.st(await x.settle(() => x.wealthRead('businessListAssets', B))), wealth: await x.settle(() => x.wealthRead('getPrivateWealth', {}, { asOf: D })) };
        o['tras salir de la org'] = { asset: after.asset, business: after.business, wealth: x.st(after.wealth), businessField: after.wealth.data?.['business'] ?? null };
        expect('salida: activo PERSONAL propio legible, BUSINESS anterior denegado, sin negocio en patrimonio', [after.asset, /^40[34] /.test(after.business), after.wealth.data?.['business'] ?? null], ['200', true, null]);
        expect('salida: colaborador anterior sigue sin ver PERSONAL', x.st(await x.settle(() => x.wealthRead('personalGetAsset', ap, { asOf: D }, C))), '404 RESOURCE_NOT_FOUND');
        await ids.updateOne({ _id: subject }, { $set: { organizationId: original.organizationId, roles: original.roles } });
        // ---- HTTPS real
        const web = await x.https(), http = web.client;
        http.cookies.set('__Host-caudelyx-session', x.a.issued.token);
        const own = await http.call('GET', `/api/v1/me/personal/books/${x.book.id}/wealth-s10/assets?asOf=${D}`);
        expect('HTTPS PERSONAL propio 200 no-store', [own.status, String(own.headers['cache-control'])], [200, 'no-store']);
        http.cookies.delete('__Host-caudelyx-session');
        expect('HTTPS sin sesión 401', (await http.call('GET', `/api/v1/me/personal/books/${x.book.id}/wealth-s10/assets?asOf=${D}`)).status, 401);
        http.cookies.set('__Host-caudelyx-session', C.issued.token);
        const path = (id) => `/api/v1/me/personal/books/${x.book.id}/wealth-s10/assets/${id}?asOf=${D}`, hf = await http.call('GET', path(idOf(draft))), hn = await http.call('GET', path(randomUUID()));
        const norm = (b) => JSON.stringify(b['error'] ?? null);
        expect('HTTPS C → 404 uniforme sin datos', [hf.status, norm(hf.body), leaks(hf.body)], [404, norm(hn.body), []]);
        evidence('S10-PRIVACY', { observed: o, failures: fail });
        assert.deepEqual(fail, [], 'privacy mismatches');
        console.log('S10_P05_PRIVACY_PASS');
    }
    catch (e) {
        evidence('S10-PRIVACY-PARCIAL', { observed: o, failures: fail, error: String(e).slice(0, 500) });
        throw e;
    }
    finally {
        await group.dispose();
    }
});
//# sourceMappingURL=privacy.test.js.map