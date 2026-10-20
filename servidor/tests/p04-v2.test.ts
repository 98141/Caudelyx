import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, totpActor, additionalActor, stepUp } from './helpers/fixture.js';
import { RecoveryService } from '../src/modules/recovery/service.js';
import { OrganizationsService } from '../src/modules/organizations/service.js';
import { randomBytes } from 'node:crypto';
import { PasswordHasher } from '../src/modules/identity/password.js';
import { readdir } from 'node:fs/promises';
import { FrozenContract } from '../src/shared/contract.js';
import { randomUUID } from 'node:crypto';

test('v2 recovery policy: role/revoke preserve E, suspend ends flow, reactivate never revives it; stale expiry cannot touch next flow', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const admin = await totpActor(f), org = new OrganizationsService(f.identity, randomBytes(32)), recovery = new RecoveryService(f.identity, f.lifecycle);
    await org.initialize(); await recovery.initialize();
    const body = { name: 'Synthetic v2', timezone: 'America/Bogota', currency: 'COP' };
    const proof = await stepUp(f, admin.issued.context, admin.secret, 'ORGANIZATION_CREATE', undefined, body);
    const created = await org.create(proof.context, body, 'v2-organization-key-001');
    const member = await additionalActor(f);
    await f.identity.identities.updateOne({ _id: member.issued.context.subjectId! }, { $set: { organizationId: created.data.organization.id, roles: ['O'], state: 'ACTIVE' } });
    const organization = await org.organizations.findOne({ _id: created.data.organization.id }); assert.ok(organization);
    await f.sessions.contexts.updateOne({ _id: member.issued.context._id }, { $set: { organizationEpoch: organization.authEpoch } });
    const memberContext = { ...member.issued.context, organizationEpoch: organization.authEpoch };
    const ownManager = await org.read(proof.context), ownMember = await org.read(memberContext);
    assert.deepEqual(ownManager.data.actorRoleIds, ['T']); assert.deepEqual(ownMember.data.actorRoleIds, ['O']);
    assert.equal('version' in ownMember.data, false);
    const contract = new FrozenContract();
    contract.validateResult('A09', 200, { data: ownMember.data, requestId: randomUUID() });
    assert.throws(() => contract.validateResult('A09', 200, { data: { ...ownMember.data, actorRoleIds: ['SA'] }, requestId: randomUUID() }));
    const regen = await stepUp(f, memberContext, member.secret, 'RECOVERY_CODES_REGENERATE');
    const codes = (await recovery.regenerate(regen.context)).codes;
    const login = await f.identity.login('TENANT', 'v2-member', member.email, f.password);
    const first = await recovery.start(login.issued.context, codes[0]!, 'v2-first');
    const flow1 = await recovery.flows.findOne({ _id: first.issued.context.recoveryId! }); assert.ok(flow1);
    await assert.rejects(recovery.flows.insertOne({ ...flow1, _id: 'another-active-flow' }));
    let adminContext = proof.context;
    const id = memberContext.subjectId!;
    let row = await f.identity.identities.findOne({ _id: id }); assert.ok(row);
    let rp = await stepUp(f, adminContext, admin.secret, 'MEMBER_ROLE_CHANGE', id, { roleIds: ['C'] });
    await org.roles(rp.context, id, { roleIds: ['C'] }, row.version); adminContext = rp.context;
    assert.ok(await f.sessions.find(first.issued.token, 'TENANT'));
    row = await f.identity.identities.findOne({ _id: id }); assert.ok(row);
    rp = await stepUp(f, adminContext, admin.secret, 'MEMBER_SESSIONS_REVOKE', id);
    await org.memberCommand(rp.context, id, 'REVOKE', row.version); adminContext = rp.context;
    assert.ok(await f.sessions.find(first.issued.token, 'TENANT'));
    rp = await stepUp(f, adminContext, admin.secret, 'MEMBER_SUSPEND', id);
    await org.memberCommand(rp.context, id, 'SUSPEND', row.version); adminContext = rp.context;
    assert.equal((await recovery.flows.findOne({ _id: flow1._id }))?.status, 'REVOKED');
    assert.equal(await f.sessions.find(first.issued.token, 'TENANT'), null);
    row = await f.identity.identities.findOne({ _id: id }); assert.ok(row);
    rp = await stepUp(f, adminContext, admin.secret, 'MEMBER_REACTIVATE', id);
    await org.memberCommand(rp.context, id, 'REACTIVATE', row.version);
    const l2 = await f.identity.login('TENANT', 'v2-new-flow', member.email, f.password);
    const second = await recovery.start(l2.issued.context, codes[1]!, 'v2-second');
    f.clock.value = flow1.expiresAt + 1; await recovery.expire();
    assert.equal((await f.identity.identities.findOne({ _id: id }))?.state, 'RECOVERY_RESTRICTED');
    assert.ok(await f.sessions.find(second.issued.token, 'TENANT'));
    console.log('Recovery approved policy and stale-expiry isolation passed with Mongo unique ACTIVE index.');
  } finally { await f.close(); }
});

test('v2 fixture setup failure releases its real Mongo process and temporary directory', { timeout: 120000 }, async () => {
  const before = (await readdir('.runtime')).filter(n => n.startsWith('replica-')).sort();
  const original = PasswordHasher.prototype.initialize;
  PasswordHasher.prototype.initialize = async () => { throw new Error('synthetic setup failure'); };
  try { await assert.rejects(fixture()); } finally { PasswordHasher.prototype.initialize = original; }
  assert.deepEqual((await readdir('.runtime')).filter(n => n.startsWith('replica-')).sort(), before);
});
