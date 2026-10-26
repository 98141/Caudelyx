import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { generate } from 'otplib';
import { mejProfile, password } from './profile.ts';
import { accountOf, organizationOf } from './fixture.ts';
import { discardEntireResponse } from './transport.test.ts';
import { oracleWasExecuted, publishedOperationsExample } from './economic-oracle.ts';
import { sessionMeta } from '../../../dist/src/modules/sessions/work-policy.js';
import { today } from '../../../dist/src/modules/finance/service.js';

let own: ReturnType<typeof mejProfile> | undefined;
after(async () => { if (own) await (await own).dispose(); });

test('MEJ-R2 revalidación del delta C1', { timeout: 600000 }, async t => {
  const group = await (own = mejProfile());
  assert.equal(oracleWasExecuted(), false);
  assert.equal(publishedOperationsExample.principalOutstanding, '1710000.00');

  await t.test('F3 B sigue en perfil a 31 min y vence a los 60 min exactos', async () => {
    const f = await group.fixture();
    const a = await f.signup();
    const { client } = await f.https();
    client.cookies.set('__Host-caudelyx-session', a.issued.token);
    client.csrf = a.issued.csrf;
    const start = f.now();
    f.clock.value = start + 31 * 60_000;
    assert.equal((await client.call('GET', '/api/v1/auth/me')).status, 200);
    let guard = await client.call('GET', '/api/v1/organization');
    assert.equal(guard.status, 403);
    assert.equal(guard.body.error?.code, 'EMAIL_NOT_VERIFIED');
    f.clock.value = start + 3_599_999;
    guard = await client.call('GET', '/api/v1/organization');
    assert.equal(guard.body.error?.code, 'EMAIL_NOT_VERIFIED');
    f.clock.value += 1;
    assert.equal((await client.call('GET', '/api/v1/auth/me')).status, 401);
    assert.equal((await client.call('POST', '/api/v1/auth/session/activity', {})).status, 401);
  });

  await t.test('F4 el rol O no reserva un alta y F9 WORK/LOGIN responden 422', async () => {
    const f = await group.fixture();
    const a = await f.signup();
    const confirmed = await f.identity.confirmEmail(a.issued.context, { purpose: 'ACTIVATION', token: a.token });
    await f.runtime.organizations.create(confirmed.issued.context, { name: 'R2 sin factor', currency: 'COP', timezone: 'America/Bogota' }, randomUUID());
    const subject = (await f.identity.identities.findOne({ _id: confirmed.issued.context.subjectId! }))!;
    await f.identity.identities.updateOne({ _id: subject._id }, { $set: { roles: ['O'] } });
    const issued = (await f.identity.login('TENANT', randomUUID(), a.email, password)).issued;
    const { client } = await f.https();
    client.cookies.set('__Host-caudelyx-session', issued.token);
    client.csrf = issued.csrf;
    const denied = await client.call('POST', '/api/v1/auth/step-up/intents', { purpose: 'MEMBER_INVITE', method: 'TOTP', resourceId: subject.organizationId, command: { email: 'guest-r2@example.test', roleIds: ['L'] } });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error?.code, 'ACCESS_DENIED');
    assert.equal((await f.sessions.contexts.findOne({ _id: issued.context._id }))?.reauth, undefined);
    for (const purpose of ['LOGIN', 'ORGANIZATION_CREATE']) assert.equal((await client.call('POST', '/api/v1/auth/step-up/intents', { purpose, method: 'TOTP' })).status, 422);
  });

  await t.test('F2 pierde toda la respuesta A43, conserva la cookie y deja un solo asiento', async () => {
    const f = await group.fixture();
    const actor = await f.actor();
    const org = await organizationOf(f, actor);
    const cash = await accountOf(f, actor, org, 'R2CASH', 'ASSET', 'CASH');
    const equity = await accountOf(f, actor, org, 'R2EQ', 'EQUITY', 'GENERAL');
    const { client, cert, port } = await f.https();
    client.cookies.set('__Host-caudelyx-session', actor.issued.token);
    client.csrf = actor.issued.csrf;
    const payload = { currency: 'COP', effectiveDate: today(f.now()), sourceId: randomUUID(), supportReference: 'SYN-R2', description: 'Pérdida completa', lines: [{ accountId: cash, debit: '10.00', credit: '0.00' }, { accountId: equity, debit: '0.00', credit: '10.00' }] };
    const key = randomUUID();
    const url = `/api/v1/organizations/${org}/financial/journal-entries`;
    const prepared = await client.call('POST', '/api/v1/auth/step-up/intents', { purpose: 'FINANCE_JOURNAL_POST', method: 'TOTP', command: { organizationId: org, idempotencyKey: key, payload } });
    assert.equal(prepared.status, 200);
    f.clock.value += 30_000;
    const verify = { intentId: prepared.body.data?.['intentId'], method: 'TOTP', code: await generate({ secret: actor.secret, epoch: Math.floor(f.now() / 1000) }) };
    const cookie = `__Host-caudelyx-session=${actor.issued.token}`;
    const before = await f.runtime.finance.journals.countDocuments({ organizationId: org });
    const lost = await discardEntireResponse(port, cert, '/api/v1/auth/step-up/verify', verify, cookie, client.csrf);
    assert.equal(lost.status, 200);
    assert.deepEqual(lost.setCookie, []);
    assert.equal(client.cookies.get('__Host-caudelyx-session'), actor.issued.token);
    assert.equal(await f.runtime.finance.journals.countDocuments({ organizationId: org }), before);
    const me = await client.call('GET', '/api/v1/auth/me');
    assert.equal(me.status, 200);
    assert.equal(await f.runtime.finance.journals.countDocuments({ organizationId: org }), before);
    const until = (me.body.data?.['session'] as { balanceVerifiedUntil: string }).balanceVerifiedUntil;
    assert.ok(until);
    assert.equal((await client.call('POST', url, payload, { 'Idempotency-Key': key })).body.error?.code, 'CSRF_INVALID');
    await client.refreshCsrf();
    assert.equal((await client.call('POST', url, payload, { 'Idempotency-Key': key })).status, 201);
    assert.equal((await client.call('POST', url, payload, { 'Idempotency-Key': key })).status, 200);
    assert.equal(await f.runtime.finance.journals.countDocuments({ organizationId: org }), before + 1);
    const security = await client.call('POST', '/api/v1/auth/mfa/recovery-codes/regenerate');
    assert.equal(security.status, 403);
    assert.equal(security.body.error?.code, 'R_REQUIRED');
    f.clock.value += 30 * 60_000;
    assert.equal((await client.call('POST', '/api/v1/auth/session/activity', {})).status, 200);
    assert.equal(((await client.call('GET', '/api/v1/auth/me')).body.data?.['session'] as { balanceVerifiedUntil: string }).balanceVerifiedUntil, until);
    const stored = await f.sessions.contexts.findOne({ _id: actor.issued.context._id });
    assert.ok(stored);
    stored.balanceGrant = { factorId: stored.factorId!, organizationId: org, expiresAt: f.now() + 1000 };
    assert.ok(sessionMeta(stored, f.now() + 999).balanceVerifiedUntil);
    assert.equal(sessionMeta(stored, f.now() + 1000).balanceVerifiedUntil, null);
    assert.equal(sessionMeta(stored, f.now() + 1001).balanceVerifiedUntil, null);
    f.clock.value = Date.parse(until);
    assert.equal((await client.call('POST', url, { ...payload, sourceId: randomUUID() }, { 'Idempotency-Key': randomUUID() })).body.error?.code, 'R_REQUIRED');
    assert.equal(((await client.call('GET', '/api/v1/auth/me')).body.data?.['session'] as { balanceVerifiedUntil: unknown }).balanceVerifiedUntil, null);
    const changePrep = await client.call('POST', '/api/v1/auth/step-up/intents', { purpose: 'PASSWORD_CHANGE', method: 'TOTP' });
    assert.equal(changePrep.status, 200);
    f.clock.value += 30_000;
    const changed = await client.call('POST', '/api/v1/auth/step-up/verify', { intentId: changePrep.body.data?.['intentId'], method: 'TOTP', code: await generate({ secret: actor.secret, epoch: Math.floor(f.now() / 1000) }) });
    assert.equal(changed.status, 200);
    assert.equal(changed.headers['set-cookie'], undefined);
    await client.refreshCsrf();
    assert.equal((await client.call('POST', '/api/v1/auth/password/change', { newPassword: password + ' R2' })).status, 204);
    assert.equal((await client.call('GET', '/api/v1/auth/me')).status, 401);
    await client.refreshCsrf();
    const login = await client.call('POST', '/api/v1/auth/login', { email: actor.email, password: password + ' R2' });
    assert.equal(login.status, 200);
    assert.notEqual(client.cookies.get('__Host-caudelyx-session'), actor.issued.token);
    await client.refreshCsrf();
    assert.equal((await client.call('POST', '/api/v1/auth/logout')).status, 204);
    assert.equal((await client.call('GET', '/api/v1/auth/me')).status, 401);
  });

  await t.test('navegador propio sobre el cliente compilado', async () => {
    const f = await group.fixture();
    const actor = await f.actor();
    const org = await organizationOf(f, actor);
    await accountOf(f, actor, org, 'R2CASH', 'ASSET', 'CASH');
    await accountOf(f, actor, org, 'R2BANK', 'ASSET', 'BANK');
    const endpoint = await f.https(true);
    const outputDir = join(group.folder, 'playwright');
    await mkdir(outputDir);
    const child = spawn(process.execPath, [resolve('../cliente/node_modules/@playwright/test/cli.js'), 'test', '-c', 'tests/independent/mej-r2/playwright.config.ts'], {
      cwd: resolve('../cliente'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MEJR2_BASE_URL: f.config.tenantOrigin, MEJR2_OUTPUT: outputDir, MEJR2_CONTEXT: JSON.stringify({ email: actor.email, password }) },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, output.slice(-4000));
    assert.equal(await f.runtime.finance.journals.countDocuments({ organizationId: org, 'source.type': 'INITIAL_BALANCE' }), 1);
  });
});
