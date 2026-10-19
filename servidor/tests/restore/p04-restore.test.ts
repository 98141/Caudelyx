import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { generate } from 'otplib';
import { fixture, totpActor, stepUp, additionalActor } from '../helpers/fixture.js';
import { RecoveryService } from '../../src/modules/recovery/service.js';
import { ApiClient } from '../helpers/client.js';
import { testCertificate } from '../helpers/tls.js';
import { createApp } from '../../src/app.js';
import { attachRuntime } from '../../src/shared/runtime.js';
import type { SyntheticSnapshot } from '../../src/shared/restore.js';

test('P04 real serialized historical T0 restore: consumed codes/retired factors and post-T0 identities never revive; no mail replay', { timeout: 120000 }, async () => {
  const f = await fixture({ controlledRestore: true });
  try {
    const controller = f.restore; assert.ok(controller);
    const actor = await totpActor(f), recovery = new RecoveryService(f.identity, f.lifecycle);
    const proof = await stepUp(f, actor.issued.context, actor.secret, 'RECOVERY_CODES_REGENERATE');
    const codes = await recovery.regenerate(proof.context);
    const t0 = await controller.snapshot();
    await writeFile('.runtime/p04-restore-t0.json', JSON.stringify(t0));
    const later = await additionalActor(f);
    const login = await f.identity.login('TENANT', 'p04-recovery', f.email, f.password);
    const started = await recovery.start(login.issued.context, codes.codes[0]!, 'p04-recovery');
    const pending = await f.totp.enroll(started.issued.context, 'Factor posterior T0');
    const secret = new URL(pending.provisioningUri).searchParams.get('secret'); assert.ok(secret);
    await f.totp.confirm(started.issued.context, pending.enrollmentId, await generate({ secret, epoch: Math.floor(f.now() / 1000) }));
    await recovery.complete(started.issued.context, pending.enrollmentId, [actor.factorId]);
    await controller.flush();
    const t1 = await f.database.db.collection<{ _id: string; value: number }>('security_sequence').findOne({ _id: 'security' });
    assert.ok(t1 && t1.value > t0.watermark);
    const loaded = JSON.parse(await readFile('.runtime/p04-restore-t0.json', 'utf8')) as SyntheticSnapshot;
    await controller.beginRestore(loaded);
    assert.equal(controller.isOpen(), false);
    // Explicitly a test fixture, never a real operator approval.
    await controller.reconcile({ approved: true, reviewId: 'P04-synthetic-independent-review-still-pending' });
    assert.equal((await f.sessions.factors.findOne({ _id: actor.factorId }))?.state, 'REVOKED');
    assert.equal(await f.sessions.factors.findOne({ _id: pending.enrollmentId }), null);
    assert.equal(await recovery.codes.countDocuments({ consumed: false }), 0);
    assert.equal((await f.identity.identities.findOne({ email: f.email }))?.state, 'FACTOR_LOSS_BLOCKED');
    assert.equal(await f.sessions.find(actor.issued.token, 'TENANT'), null);
    assert.equal(await f.sessions.contexts.countDocuments({ revoked: false }), 0);
    assert.equal(await f.messages.messages.countDocuments({ delivered: false }), 0);
    assert.equal(await f.messages.notifications.countDocuments({ delivered: false }), 0);
    assert.equal(await f.database.db.collection('outbox').countDocuments({ dispatched: false }), 0);
    assert.equal(await f.identity.identities.countDocuments({ email: later.email }), 0);
    await f.identity.register('TENANT', 'p04-re-register', { email: later.email, displayName: 'Synthetic', privacyPolicyVersion: 'synthetic-v1' });
    assert.equal(await f.identity.identities.countDocuments({ email: later.email }), 0);
    // A31 also changes credentialVersion; missing current password material must fail closed after T0.
    assert.equal((await f.identity.identities.findOne({ email: f.email }))?.passwordHash, null);
    await assert.rejects(f.identity.login('TENANT', 'p04-old-factor', f.email, f.password));
    await assert.rejects(f.totp.authenticate(actor.issued.context, await generate({ secret: actor.secret, epoch: Math.floor(f.now() / 1000) }), 'LOGIN', null));
    await assert.rejects(recovery.start(started.issued.context, codes.codes[0]!, 'p04-used-code'));
    console.log(JSON.stringify({ evidence: 'P04-restore', t0: t0.watermark, t1: t1.value, snapshotSHA256: createHash('sha256').update(JSON.stringify(t0)).digest('hex'), externalContinuous: true, revivedFactors: 0, reusableOldCodes: 0, replayableOutbox: 0 }));
  } finally { await f.close(); }
});

test('P04 restore external gap closes real HTTPS realm: public registration/PREPARE, login, MFA and old S all denied uniformly', { timeout: 120000 }, async () => {
  const f = await fixture({ controlledRestore: true });
  const tls = await testCertificate();
  const config = { mongoUri: f.uri, databaseName: f.database.db.databaseName, port: 0, tenantOrigin: 'https://localhost:0', platformOrigin: 'https://platform.localhost:0' };
  await attachRuntime(f.identity, { version: 1, mail: f.mailKey, totp: f.totpKey, journal: randomBytes(32), cursor: randomBytes(32) }, config);
  const server = createServer(tls, createApp({ identity: f.identity, config })).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const controller = f.restore; assert.ok(controller);
    const actor = await totpActor(f), t0 = await controller.snapshot();
    await f.identity.database.transaction(async session => {
      await f.identity.audit.append({ realm: 'TENANT', action: 'P04_SYNTHETIC_CUT', actorId: actor.issued.context.subjectId!, subjectId: actor.issued.context.subjectId!, outcome: 'SUCCESS' }, session);
    });
    await controller.flush();
    const journal = f.database.client.db(`${f.database.db.databaseName}_external_security`).collection('events');
    const last = await journal.find().sort({ _id: -1 }).next(); assert.ok(last);
    await journal.deleteOne({ _id: last._id });
    await controller.beginRestore(t0);
    await assert.rejects(controller.reconcile({ approved: true, reviewId: 'P04-gap-test-only' }));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    config.tenantOrigin = `https://localhost:${address.port}`;
    config.platformOrigin = `https://platform.localhost:${address.port}`;
    const client = new ApiClient(address.port, tls.cert);
    await client.refreshCsrf();
    const count = await f.identity.identities.countDocuments();
    const observations = new Map<string, number>();
    for (const [label, route, body] of [
      ['new-registration', '/auth/register', { email: 'absent_p04@example.test', displayName: 'Synthetic', privacyPolicyVersion: 'synthetic-v1', acceptTerms: true }],
      ['known-registration', '/auth/register', { email: f.email, displayName: 'Synthetic', privacyPolicyVersion: 'synthetic-v1', acceptTerms: true }],
      ['prepare', '/auth/invitations/accept', { mode: 'PREPARE', token: 'A'.repeat(43), displayName: 'Synthetic', privacyPolicyVersion: 'synthetic-v1', acceptTerms: true }],
      ['login', '/auth/login', { email: f.email, password: f.password }],
      ['mfa', '/auth/mfa/totp/enrollments', { label: 'Forbidden' }],
    ] as const) {
      const result = await client.call('POST', '/api/v1' + route, body);
      observations.set(label, result.status);
      assert.equal(result.status, 503);
      assert.equal(result.body.error?.code, 'SERVICE_UNAVAILABLE');
    }
    client.cookies.set('__Host-caudelyx-session', actor.issued.token);
    assert.equal((await client.call('GET', '/api/v1/auth/me')).status, 503);
    assert.equal(await f.identity.identities.countDocuments(), count);
    assert.equal(controller.isOpen(), false);
    console.log(JSON.stringify({ evidence: 'P04-real-HTTPS-restore-gap', observations: Object.fromEntries(observations), identitiesCreated: 0, realmOpen: false }));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});
