import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { s13Profile, world, password } from './fixture.js';
import { definition } from './oracle.js';
import { today } from '../../src/modules/obligations/calendar.js';
import { uniqueJson } from '../../src/modules/simulation/http.js';
const denied = async (work) => await assert.rejects(work, (e) => e instanceof Error && 'status' in e && [401, 403, 404, 409].includes(Number(e.status)));
test('strict S12 JSON rejects escaped duplicate keys, deep nesting and malformed content without changing global parser', () => {
    assert.throws(() => uniqueJson('{"x":1,"\\u0078":2}'));
    assert.throws(() => uniqueJson('['.repeat(65) + '0' + ']'.repeat(65)));
    assert.throws(() => uniqueJson('{"x":1,}'));
    assert.deepEqual(uniqueJson('{"x":["ñ",null,false,0],"y":{"x":1}}'), { x: ['ñ', null, false, 0], y: { x: 1 } });
});
test('native current authority, private creator, real invited roles, PERSONAL separation and HTTPS envelopes', { timeout: 360000 }, async (t) => {
    const group = await s13Profile();
    try {
        const f = await world(group), service = f.runtime.simulation, ps = { organizationId: f.org }, personal = { bookId: f.book.id };
        const call = async (op, input = {}, params = ps, actor = f.a) => await service.execute(actor.issued.context, op, input, params, {}, randomUUID());
        const b = await call('captureBaseBusinessSimulation', { asOf: today(f.now()), currency: 'COP' }), d = { ...definition(), baseId: b.data['id'], baseToken: b.data['baseToken'] }, scenario = await call('createScenarioBusinessSimulation', { name: 'PRIVATE_S12_NAME', ...d }), sp = { ...ps, scenarioId: String(scenario.data['id']) };
        const pb = await call('captureBasePersonalSimulation', { asOf: today(f.now()), currency: 'COP' }, personal);
        assert.equal(pb.data['cashBook']['value'], '0.00');
        await t.test('actual invited C/O/P/A/L have no owner scenario or PERSONAL access', async () => {
            for (const role of ['C', 'O', 'P', 'A', 'L']) {
                const a = await f.actor(), payload = { email: a.email, roleIds: [role] };
                await f.proof(f.a, 'MEMBER_INVITE', payload, f.org);
                await f.runtime.organizations.invite(f.a.issued.context, payload);
                await f.identity.dispatchMail();
                const mail = [...f.messages.notificationInbox.values()].find(m => m.kind === 'INVITATION' && m.payload['email'] === a.email);
                assert.ok(mail);
                await f.runtime.organizations.accept(a.issued.context, { mode: 'CONFIRM', token: mail.payload['token'] }, randomUUID());
                await denied(() => call('getScenarioBusinessSimulation', {}, sp, a));
                await denied(() => call('getBasePersonalSimulation', {}, { ...personal, baseId: String(pb.data['id']) }, a));
                if (role === 'T') {
                    const list = await call('listScenariosBusinessSimulation', {}, ps, a);
                    assert.deepEqual(list.data['items'], []);
                }
                else
                    await denied(() => call('listScenariosBusinessSimulation', {}, ps, a));
            }
        });
        await t.test('foreign organization and actor/security states cannot reveal opaque objects', async () => {
            const other = await f.actor(), org = (await f.runtime.organizations.create(other.issued.context, { name: 'Otro ámbito S12', currency: 'COP', timezone: 'America/Bogota' }, randomUUID())).data.organization.id;
            await denied(() => call('getScenarioBusinessSimulation', {}, { ...sp, organizationId: org }, other));
            const actor = await f.identity.identities.findOne({ _id: f.a.issued.context.subjectId });
            assert.ok(actor);
            const context = await f.sessions.contexts.findOne({ _id: f.a.issued.context._id });
            assert.ok(context);
            for (const change of [{ roles: ['T', 'SA'] }, { roles: ['SA'] }, { roles: ['A'] }, { roles: ['C'] }, { authEpoch: randomUUID() }, { credentialVersion: randomUUID() }, { authzVersion: randomUUID() }, { suspended: true }]) {
                await f.identity.identities.updateOne({ _id: actor._id }, { $set: change });
                try {
                    await denied(() => call('getScenarioBusinessSimulation', {}, sp));
                }
                finally {
                    await f.identity.identities.replaceOne({ _id: actor._id }, actor);
                }
            }
            for (const kind of ['B', 'L', 'P', 'E_INITIAL']) {
                await f.sessions.contexts.updateOne({ _id: context._id }, { $set: { kind } });
                try {
                    await denied(() => call('getScenarioBusinessSimulation', {}, sp));
                }
                finally {
                    await f.sessions.contexts.replaceOne({ _id: context._id }, context);
                }
            }
            await f.sessions.contexts.updateOne({ _id: context._id }, { $set: { revoked: true } });
            try {
                await denied(() => call('getScenarioBusinessSimulation', {}, sp));
            }
            finally {
                await f.sessions.contexts.replaceOne({ _id: context._id }, context);
            }
        });
        await t.test('BUSINESS suspension leaves current self PERSONAL eligible, consolidation requires explicit FULL100', async () => {
            await denied(() => call('getPolicyConsolidatedSimulation', {}, personal));
            const org = await f.database.db.collection('organizations').findOne({ _id: f.org });
            assert.ok(org);
            await f.database.db.collection('organizations').updateOne({ _id: f.org }, { $set: { status: 'SUSPENDED' } });
            try {
                await denied(() => call('getScenarioBusinessSimulation', {}, sp));
                assert.equal((await call('getBasePersonalSimulation', {}, { ...personal, baseId: String(pb.data['id']) })).status, 200);
            }
            finally {
                await f.database.db.collection('organizations').replaceOne({ _id: f.org }, org);
            }
        });
        await t.test('current FULL100 grants consolidated projection with two separate legal books', async () => {
            await f.mutate('declareOwnEligibility', { right: 'FULL_OWNERSHIP', percentage: '100.00', validFrom: today(f.now()), supportReference: 'SYN-S12-FULL100' }, ps);
            const result = await call('captureBaseConsolidatedSimulation', { asOf: today(f.now()), currency: 'COP' }, personal);
            assert.equal(result.status, 201);
            assert.equal(result.data['scope']['kind'], 'CONSOLIDATED');
            await denied(() => call('getBasePersonalSimulation', {}, { ...personal, baseId: String(result.data['id']) }));
        });
        await t.test('real HTTPS policy, current CSRF and scoped error envelope', async () => {
            const https = await f.https();
            https.client.cookies.set('__Host-caudelyx-session', f.a.issued.token);
            await https.client.refreshCsrf();
            const path = '/api/v1/organizations/' + f.org + '/simulation-s12';
            assert.equal((await https.client.call('GET', path + '/policy')).status, 200);
            const bad = await https.client.call('POST', path + '/bases', { asOf: today(f.now()), currency: 'COP' }, { 'Idempotency-Key': randomUUID(), 'X-CSRF-Token': 'bad' });
            assert.equal(bad.body.error?.code, 'CSRF_INVALID');
            assert.equal(bad.headers['cache-control'], 'no-store');
            const good = await https.client.call('POST', path + '/bases', { asOf: today(f.now()), currency: 'COP' }, { 'Idempotency-Key': randomUUID() });
            assert.equal(good.status, 201, JSON.stringify(good.body));
        });
        await t.test('real grants keep fixed60min and one-shot5min; current reads cannot extend absolute12h or idle60min', async () => {
            const consume = async () => await f.runtime.recovery.regenerate(f.a.issued.context);
            await f.proof(f.a, 'RECOVERY_CODES_REGENERATE');
            await consume();
            await denied(consume);
            await f.proof(f.a, 'RECOVERY_CODES_REGENERATE');
            f.clock.value += 300001;
            await denied(consume);
            const context = (await f.sessions.contexts.findOne({ _id: f.a.issued.context._id })), grant = context.balanceGrant;
            assert.ok(grant);
            const fixedExpiry = context.expiresAt, grantExpiry = grant.expiresAt;
            await call('getPolicyBusinessSimulation');
            const after = (await f.sessions.contexts.findOne({ _id: context._id }));
            assert.equal(after.expiresAt, fixedExpiry);
            assert.equal(after.balanceGrant?.expiresAt, grantExpiry);
            // Clock advancement and direct lastSeen updates are labeled fixture injection;
            // neither changes the absolute expiry or manufactures a renewed grant.
            f.clock.value = grantExpiry;
            await f.sessions.contexts.updateOne({ _id: context._id }, { $set: { lastSeenAt: f.now() } });
            await f.database.client.withSession(async (session) => await assert.rejects(() => f.sessions.consumeProof(f.a.issued.context, 'FINANCE_JOURNAL_POST', null, session)));
            f.clock.value = fixedExpiry;
            await f.sessions.contexts.updateOne({ _id: context._id }, { $set: { lastSeenAt: f.now() } });
            assert.equal(await f.sessions.find(f.a.issued.token, 'TENANT'), null);
            f.a.issued = (await f.identity.login('TENANT', randomUUID(), f.a.email, password)).issued;
            const idle = (await f.sessions.contexts.findOne({ _id: f.a.issued.context._id }));
            f.clock.value = idle.lastSeenAt + 3600000;
            assert.equal(await f.sessions.find(f.a.issued.token, 'TENANT'), null);
        });
    }
    finally {
        await group.dispose();
    }
});
//# sourceMappingURL=privacy.test.js.map