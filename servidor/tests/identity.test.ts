import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startReplicaSet } from './helpers/replica-set.js';
import { Database } from '../src/shared/database.js';
import { Sessions } from '../src/modules/sessions/service.js';
import { IdentityService, canonicalEmail } from '../src/modules/identity/service.js';
import { PasswordHasher } from '../src/modules/identity/password.js';
import { SyntheticMessaging } from '../src/modules/messaging/service.js';
import { FrozenContract } from '../src/shared/contract.js';
import { AppError } from '../src/shared/errors.js';

test('frozen contract enforces discriminants, closed objects and reset acknowledgement', () => {
  const contract = new FrozenContract(); assert.equal(contract.operations.size, 38);
  assert.throws(() => contract.validate('A02', { email: 'x@example.test', displayName: 'X', privacyPolicyVersion: 'synthetic-v1', acceptTerms: true, password: 'no-password-on-registration' }));
  assert.throws(() => contract.validate('A19', { token: 'A'.repeat(43), newPassword: 'synthetic-password-long' }));
  contract.validate('A19', { mode: 'PREVIEW', token: 'A'.repeat(43) });
});

test('email canonicalization preserves plus/dots and rejects EAI/controls', () => {
  assert.equal(canonicalEmail('First.Last+Tag@Example.Test'), 'first.last+tag@example.test');
  assert.notEqual(canonicalEmail('a.b@example.test'), canonicalEmail('ab@example.test'));
  assert.throws(() => canonicalEmail('ñ@example.test')); assert.throws(() => canonicalEmail('x@example.test\n'));
});

test('real identity activation, code replay, bootstrap binding and reset without MFA bypass', { timeout: 120000 }, async () => {
  const replica = await startReplicaSet(), db = new Database(replica.uri, 'caudelyx_identity');
  let clock = Date.now();
  let open = true;
  const now = () => clock;
  try {
    await db.connect();
    const sessions = new Sessions(db, now), messaging = new SyntheticMessaging(db, randomBytes(32), now);
    const identity = new IdentityService(db, sessions, messaging, new PasswordHasher(), () => open, now);
    await identity.initialize();
    const anonymous = await sessions.issue('TENANT', 'P', null);
    const email = 'person_synthetic@example.test', password = 'a long synthetic password 314159';
    await identity.register('TENANT', 'source-test', { email, displayName: 'Persona sintética', privacyPolicyVersion: 'synthetic-v1' });
    const pending = await identity.identities.findOne({ email }); assert.ok(pending); assert.equal(pending.passwordHash, null);
    await messaging.deliver(async () => true);
    const activation = [...messaging.inbox.values()].find(m => m.purpose === 'ACTIVATION'); assert.ok(activation);
    const enrolled = await identity.confirmEmail(anonymous.context, { purpose: 'ACTIVATION', token: activation.token, newPassword: password });
    assert.equal(enrolled.issued.context.kind, 'E_INITIAL');
    const activated = await identity.identities.findOne({ email }); assert.ok(activated);
    assert.notEqual(activated.passwordHash, password); assert.equal(activated.hasEverConfirmedFactor, false);
    await assert.rejects(identity.confirmEmail(anonymous.context, { purpose: 'ACTIVATION', token: activation.token, newPassword: password }));
    const login = await identity.login('TENANT', 'login-test', email, password);
    assert.equal(login.issued.context.kind, 'L'); assert.equal(login.data.authState, 'MFA_ENROLLMENT');
    await identity.requestEmail('TENANT', 'source-initial', 'INITIAL_MFA_PROOF', null, login.issued.context);
    await messaging.deliver(async () => true);
    const initial = [...messaging.inbox.values()].find(m => m.purpose === 'INITIAL_MFA_PROOF'); assert.ok(initial);
    const other = await identity.login('TENANT', 'login-second', email, password);
    await assert.rejects(identity.confirmEmail(other.issued.context, { purpose: 'INITIAL_MFA_PROOF', token: initial.token }), (e: unknown) => e instanceof AppError && e.code === 'TOKEN_INVALID');
    const initialEnrollment = await identity.confirmEmail(login.issued.context, { purpose: 'INITIAL_MFA_PROOF', token: initial.token });
    assert.equal(initialEnrollment.issued.context.kind, 'E_INITIAL');
    const resetContext = await sessions.issue('TENANT', 'P', null);
    await identity.requestEmail('TENANT', 'source-reset', 'RESET', email, resetContext.context);
    await messaging.deliver(async () => true);
    const reset = [...messaging.inbox.values()].find(m => m.purpose === 'RESET'); assert.ok(reset);
    assert.ok(reset.warning?.includes('no podrás terminar el alta'));
    await assert.rejects(identity.reset(resetContext.context, { mode: 'CONFIRM', token: reset.token,
      newPassword: 'a replacement synthetic password 271828', warningAcknowledged: true }, 'reset-verify'),
    (e: unknown) => e instanceof AppError && e.code === 'INVALID_STATE');
    const preview = await identity.reset(resetContext.context, { mode: 'PREVIEW', token: reset.token }, 'reset-verify');
    assert.equal('warningRequired' in preview && preview.warningRequired, true);
    const confirmed = await identity.reset(resetContext.context, { mode: 'CONFIRM', token: reset.token,
      newPassword: 'a replacement synthetic password 271828', warningAcknowledged: true }, 'reset-verify');
    assert.equal('nextAction' in confirmed && confirmed.nextAction, 'LOGIN');
    assert.equal(await sessions.find(initialEnrollment.issued.token, 'TENANT'), null);
    const after = await identity.login('TENANT', 'login-new', email, 'a replacement synthetic password 271828');
    assert.equal(after.data.authState, 'FACTOR_LOSS_BLOCKED');
    await assert.rejects(identity.requestEmail('TENANT', 'initial-denied', 'INITIAL_MFA_PROOF', null, after.issued.context),
      (e: unknown) => e instanceof AppError && e.code === 'INITIAL_MFA_PROOF_DENIED');
    assert.equal(await sessions.find(other.issued.token, 'TENANT'), null);
    clock += 300001;
    assert.equal(await sessions.find(after.issued.token, 'TENANT'), null);
    open = false;
    await assert.rejects(identity.login('TENANT', 'restore', email, password),
      (e: unknown) => e instanceof AppError && e.code === 'SERVICE_UNAVAILABLE');
    assert.deepEqual(await identity.requestEmail('TENANT', 'restore', 'RESET', email, resetContext.context), { code: 'GENERIC_ACCOUNT_ACTION' });
  } finally { await db.close(); await replica.stop(); }
});

test('mail quota preserves one pending turn, dispatches fresh token and never stores clear codes', { timeout: 120000 }, async () => {
  const replica = await startReplicaSet(), db = new Database(replica.uri, 'caudelyx_queue');
  let clock = Date.now(); const now = () => clock;
  try {
    await db.connect();
    const sessions = new Sessions(db, now), messages = new SyntheticMessaging(db, randomBytes(32), now);
    const service = new IdentityService(db, sessions, messages, new PasswordHasher(), () => true, now);
    await service.initialize();
    const input = { email: 'queue_synthetic@example.test', displayName: 'Cola sintética', privacyPolicyVersion: 'synthetic-v1' };
    for (let attempt = 0; attempt < 3; attempt++) {
      await service.register('TENANT', `source-${attempt}`, input); clock += 60000;
    }
    assert.equal(await messages.proofs.countDocuments(), 3);
    await service.register('TENANT', 'pending-source', input);
    const before = await messages.quotas.findOne(); assert.ok(before?.pending);
    clock += 60000;
    await service.register('TENANT', 'spam-source', input);
    const after = await messages.quotas.findOne(); assert.deepEqual(after?.pending, before.pending);
    // Retried/coalesced requests do not renew the admitted dueAt or code expiry.
    clock = before.pending.dueAt;
    await service.dispatchMail();
    const queue = await messages.quotas.findOne(); assert.equal(queue?.pending, null);
    assert.equal(await messages.proofs.countDocuments(), 4);
    const delivered = [...messages.inbox.values()]; assert.equal(delivered.length, 1); // Earlier codes expired.
    const fresh = delivered[0]; assert.ok(fresh);
    const stored = await messages.messages.findOne({ _id: fresh.id }); assert.ok(stored);
    assert.equal(stored.expiresAt, clock + 600000); assert.ok(!JSON.stringify(stored).includes(fresh.token));
    await Promise.all([service.dispatchMail(), service.dispatchMail()]);
    assert.equal(messages.inbox.size, 1);
  } finally { await db.close(); await replica.stop(); }
});

test('concurrent activation has one winner on real MongoDB transactions', { timeout: 120000 }, async () => {
  const replica = await startReplicaSet(), db = new Database(replica.uri, 'caudelyx_race');
  try {
    await db.connect(); const sessions = new Sessions(db), messages = new SyntheticMessaging(db, randomBytes(32), Date.now);
    const service = new IdentityService(db, sessions, messages, new PasswordHasher(), () => true);
    await service.initialize();
    await service.register('TENANT', 'race', { email: 'race_synthetic@example.test', displayName: 'Carrera sintética', privacyPolicyVersion: 'synthetic-v1' });
    await service.dispatchMail(); const code = [...messages.inbox.values()][0]; assert.ok(code);
    const contexts = await Promise.all([sessions.issue('TENANT', 'P', null), sessions.issue('TENANT', 'P', null)]);
    const results = await Promise.allSettled(contexts.map(({ context }) => service.confirmEmail(context, {
      purpose: 'ACTIVATION', token: code.token, newPassword: 'synthetic parallel password 112233',
    })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(await sessions.contexts.countDocuments({ kind: 'E_INITIAL', revoked: false }), 1);
    assert.equal(await messages.proofs.countDocuments({ consumed: true }), 1);
  } finally { await db.close(); await replica.stop(); }
});
