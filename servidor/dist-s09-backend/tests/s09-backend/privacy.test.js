import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { s09Profile } from './profile.js';
import { world, code } from './fixture.js';
test('S09 actual invited C/O/P/A and foreign titular cannot access owner originals, aggregates, cursors or accounts', { timeout: 240000 }, async () => {
    const group = await s09Profile();
    try {
        const f = await world(group), params = { bookId: f.book.id };
        await f.mutate('personalCreateExpense', { nominalDate: '2026-10-28', dueDate: '2026-10-28', description: 'SYN-OWNER-PRIVATE', category: 'OTHER', amountMode: 'FIXED', amount: '123.00', supportReference: 'SYN-PRIVATE' }, params);
        const snapshot = await f.read('listPersonalExpenses', params);
        for (const role of ['C', 'O', 'P', 'A']) {
            const actor = await f.actor(), payload = { email: actor.email, roleIds: [role] };
            await f.proof(f.a, 'MEMBER_INVITE', payload, f.org);
            await f.runtime.organizations.invite(f.a.issued.context, payload);
            await f.identity.dispatchMail();
            const mail = [...f.messages.notificationInbox.values()].find(m => m.kind === 'INVITATION' && m.payload['email'] === actor.email);
            assert.ok(mail);
            await f.runtime.organizations.accept(actor.issued.context, { mode: 'CONFIRM', token: mail.payload['token'] }, randomUUID());
            for (const op of ['listPersonalExpenses', 'listPersonalLiabilities', 'listPersonalAccounts', 'getPrivateConsolidation'])
                await assert.rejects(() => f.read(op, params, {}, actor), code('RESOURCE_NOT_FOUND'));
            await assert.rejects(() => f.read('listPersonalExpenses', params, { snapshotToken: snapshot.meta['snapshotToken'] }, actor), code('RESOURCE_NOT_FOUND'));
            await assert.rejects(() => f.mutate('createPersonalBook', { currency: 'COP' }, {}, undefined, randomUUID(), actor), code('ACCESS_DENIED'));
        }
        const foreign = await f.actor();
        await f.runtime.organizations.create(foreign.issued.context, { name: 'Otra organización sintética', currency: 'COP', timezone: 'America/Bogota' }, randomUUID());
        await f.mutate('createPersonalBook', { currency: 'COP' }, {}, undefined, randomUUID(), foreign);
        await assert.rejects(() => f.read('listPersonalExpenses', params, {}, foreign), code('RESOURCE_NOT_FOUND'));
        await assert.rejects(() => f.read('getBusinessBook', { organizationId: f.org }, {}, foreign), code('RESOURCE_NOT_FOUND'));
        const actorId = f.a.issued.context.subjectId, original = await f.identity.identities.findOne({ _id: actorId });
        assert.ok(original);
        await f.identity.identities.updateOne({ _id: actorId }, { $set: { roles: ['C'], organizationId: null } });
        assert.equal((await f.read('getOwnPersonalBook')).status, 200);
        await assert.rejects(() => f.read('getBusinessBook', { organizationId: f.org }), code('RESOURCE_NOT_FOUND'));
        await f.identity.identities.updateOne({ _id: actorId }, { $set: { roles: original.roles, organizationId: original.organizationId } });
        const context = await f.sessions.contexts.findOne({ _id: f.a.issued.context._id });
        assert.ok(context);
        await f.identity.identities.updateOne({ _id: actorId }, { $set: { authEpoch: randomUUID() } });
        await assert.rejects(() => f.read('getOwnPersonalBook'), code('AUTH_INVALID'));
        await f.identity.identities.updateOne({ _id: actorId }, { $set: { authEpoch: original.authEpoch } });
        console.log('S09_PRIVACY_PASS real C/O/P/A + foreign T; private cursor/account/aggregate denied; owner book survives role/org change; current epoch required');
    }
    finally {
        await group.dispose();
    }
});
//# sourceMappingURL=privacy.test.js.map