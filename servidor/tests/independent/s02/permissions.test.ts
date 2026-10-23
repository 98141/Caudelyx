/* eslint-disable security/detect-object-injection -- Keys are this test's own fixed field names/array indexes, never request input. */
// S02-P05 independent authorization/isolation checks (Claude) over the REAL HTTPS app on an isolated Mongo 27017/rs0 group.
// Role/suspension changes are applied directly to this test's own synthetic identities/organizations to obtain each state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generate } from 'otplib';
import { financeFixture } from '../../finance/fixture.js';
import { today } from '../../../src/modules/finance/service.js';
import { ApiClient } from '../../helpers/client.js';

type Fixture = Awaited<ReturnType<typeof financeFixture>>;
type Actor = Awaited<ReturnType<Fixture['actor']>>;
const evidence = (name: string, data: Record<string, unknown>) => console.log(JSON.stringify({ evidence: name, ...data }));
const SESSION = '__Host-caudelyx-session';

async function setup() {
  const f = await financeFixture();
  try {
    const a = await f.actor(), org = await f.organization(a), b = await f.actor(), orgB = await f.organization(b);
    const started = await f.https(a), listener = { port: started.port, cert: started.cert };
    const clientFor = async (token: string, host = 'localhost') => { const c = new ApiClient(listener.port, listener.cert, host); c.cookies.set(SESSION, token); await c.refreshCsrf().catch(() => undefined); return c; };
    const ca = started.client, cb = await clientFor(b.issued.token);
    const r = async (c: ApiClient, actor: Actor, purpose: string, command: Record<string, unknown> | undefined, resourceId?: string) => {
      const a32 = await c.call('POST', '/api/v1/auth/reauthenticate', { password: f.password, purpose, ...(command ? { command } : {}), ...(resourceId ? { resourceId } : {}) });
      if (a32.status !== 200) return a32.status;
      f.clock.value += 30000;
      const a27 = await c.call('POST', '/api/v1/auth/mfa/challenges/verify', { method: 'TOTP', purpose, code: await generate({ secret: actor.secret, epoch: Math.floor(f.now() / 1000) }), ...(resourceId ? { resourceId } : {}) });
      await c.refreshCsrf(); return a27.status;
    };
    const base = (o: string) => `/api/v1/organizations/${o}/financial`;
    const accountBody = (code: string) => ({ code, name: `Cuenta ${code}`, accountClass: 'ASSET', kind: 'BANK', currency: 'COP' });
    const create = async (c: ApiClient, actor: Actor, o: string, code: string) => {
      const key = randomUUID(), payload = accountBody(code);
      assert.equal(await r(c, actor, 'FINANCE_ACCOUNT_CREATE', { organizationId: o, idempotencyKey: key, payload }), 200);
      const res = await c.call('POST', `${base(o)}/accounts`, payload, { 'Idempotency-Key': key }); assert.equal(res.status, 201); return String(res.body.data?.['id']);
    };
    return { f, a, b, org, orgB, ca, cb, clientFor, r, base, accountBody, create, listener };
  } catch (e) { await f.close(); throw e; }
}
const shape = (body: { error?: { code: string }; data?: unknown }) => JSON.stringify(Object.keys(body).sort()) + (body.error ? ':' + body.error.code : '');

test('P05-PERM-01 two tenants: foreign org/resources/cursors/R are 404/422 before CSRF, schema or R; nothing leaks or mutates', { timeout: 240000 }, async () => {
  const s = await setup();
  try {
    const { f, a, org, orgB, ca, cb, r, base } = s, date = today(f.now()), observed = new Map<string, unknown>();
    const mine = await s.create(ca, a, org, 'MINE'), mineEq = await s.create(ca, a, org, 'MINEEQ'), theirs = await s.create(cb, s.b, orgB, 'THEIRS');
    await s.create(cb, s.b, orgB, 'THEIRS2');
    const before = await f.database.db.collection('financial_journals').countDocuments();
    const out: Record<string, string> = {};
    const call = async (label: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => { const res = await ca.call(method, path, body, headers); out[label] = `${res.status} ${shape(res.body)}`; return res; };
    await call('GET foreign accounts', 'GET', `${base(orgB)}/accounts`);
    await call('GET foreign account by id (foreign path)', 'GET', `${base(orgB)}/accounts/${theirs}`);
    await call('GET foreign account by id (own path)', 'GET', `${base(org)}/accounts/${theirs}`);
    await call('GET foreign balances', 'GET', `${base(orgB)}/balances?asOf=${date}`);
    await call('POST foreign org, no CSRF/R/schema', 'POST', `${base(orgB)}/accounts`, { nonsense: true }, { 'X-CSRF-Token': 'bad', 'Idempotency-Key': 'x' });
    await call('GET unknown org', 'GET', `${base(randomUUID())}/accounts`);
    await call('GET malformed org id', 'GET', `${base('not-a-uuid')}/accounts`);
    await call('GET own org uppercase', 'GET', `${base(org.toUpperCase())}/accounts`);
    const crossKey = randomUUID(), crossPayload = { currency: 'COP', effectiveDate: date, sourceId: randomUUID(), supportReference: 'P05', description: 'Cruce', lines: [{ accountId: mine, debit: '1.00', credit: '0.00' }, { accountId: theirs, debit: '0.00', credit: '1.00' }] };
    const rCross = await r(ca, a, 'FINANCE_JOURNAL_POST', { organizationId: org, idempotencyKey: crossKey, payload: crossPayload });
    await call('POST own org referencing foreign account (with R)', 'POST', `${base(org)}/journal-entries`, crossPayload, { 'Idempotency-Key': crossKey });
    out['A32 for foreign organizationId'] = String(await r(ca, a, 'FINANCE_ACCOUNT_CREATE', { organizationId: orgB, idempotencyKey: randomUUID(), payload: s.accountBody('X') }));
    out['A32 foreign resourceId'] = String(await r(ca, a, 'FINANCE_ACCOUNT_UPDATE', { organizationId: org, idempotencyKey: randomUUID(), expectedETag: `"${theirs}:1"`, payload: { name: 'X' } }, theirs));
    const pageA = await ca.call('GET', `${base(org)}/accounts?limit=1`), cursor = String(pageA.body.data?.['nextCursor']);
    const cursorUseB = await cb.call('GET', `${base(orgB)}/accounts?limit=1&cursor=${encodeURIComponent(cursor)}`);
    out['A cursor replayed by B on B'] = `${cursorUseB.status} ${shape(cursorUseB.body)}`;
    const after = await f.database.db.collection('financial_journals').countDocuments();
    observed.set('responses', out); observed.set('R for cross posting', rCross); observed.set('journals delta', after - before);
    observed.set('foreign ids anywhere in A responses', JSON.stringify(out).includes(theirs));
    evidence('P05-PERM-01', { observed: Object.fromEntries(observed) });
    for (const k of ['GET foreign accounts', 'GET foreign account by id (foreign path)', 'GET foreign account by id (own path)', 'GET foreign balances', 'POST foreign org, no CSRF/R/schema', 'GET unknown org', 'POST own org referencing foreign account (with R)'])
      assert.equal(out[k], '404 ["error","requestId"]:RESOURCE_NOT_FOUND', k);
    assert.match(out['GET malformed org id'] ?? '', /^(404|422) /); assert.match(out['GET own org uppercase'] ?? '', /^200 /);
    assert.equal(out['A32 for foreign organizationId'], '404'); assert.equal(out['A32 foreign resourceId'], '404');
    assert.equal(out['A cursor replayed by B on B'], '422 ["error","requestId"]:INPUT_INVALID');
    assert.equal(observed.get('journals delta'), 0); assert.equal(mineEq.length > 0, true);
  } finally { await s.f.close(); }
});

test('P05-PERM-02 roles and session states: only active T with strong MFA session; A/O/C/P/L/SA, P, L, E_INITIAL, PLATFORM host and suspended org/identity denied; role change voids an issued R', { timeout: 240000 }, async () => {
  const s = await setup();
  try {
    const { f, a, org, ca, r, base } = s, observed = new Map<string, unknown>(), subject = a.issued.context.subjectId!;
    const roles: Record<string, string> = {};
    for (const role of [['A'], ['O'], ['C'], ['P'], ['L'], ['SA'], ['T', 'SA'], ['A', 'O', 'C']]) {
      await f.identity.identities.updateOne({ _id: subject }, { $set: { roles: role } });
      const g = await ca.call('GET', `${base(org)}/accounts`), p = await ca.call('POST', `${base(org)}/accounts`, s.accountBody('ROLE'), { 'Idempotency-Key': randomUUID() });
      roles[role.join('+')] = `GET ${g.status} ${g.body.error?.code ?? ''} / POST ${p.status} ${p.body.error?.code ?? ''}`;
    }
    await f.identity.identities.updateOne({ _id: subject }, { $set: { roles: ['T'] } });
    observed.set('roles', roles);
    const states: Record<string, string> = {};
    const anon = await s.clientFor('invalid-token'); anon.cookies.delete(SESSION); await anon.refreshCsrf();
    states['anonymous P'] = `${(await anon.call('GET', `${base(org)}/accounts`)).status}`;
    const login = await f.identity.login('TENANT', randomUUID(), a.email, f.password), lc = await s.clientFor(login.issued.token);
    states['L password-only'] = `${(await lc.call('GET', `${base(org)}/accounts`)).status} ${(await lc.call('GET', `${base(org)}/accounts`)).body.error?.code}`;
    const email = `${randomUUID()}@example.test`, pre = await f.sessions.issue('TENANT', 'P', null);
    await f.identity.register('TENANT', randomUUID(), { email, displayName: 'Inicial P05', privacyPolicyVersion: 'synthetic-v1' }); await f.identity.dispatchMail();
    const subj = await f.identity.identities.findOne({ email }), msg = [...f.identity.messaging.inbox.values()].find(m => m.subjectId === subj?._id && m.purpose === 'ACTIVATION');
    const initial = await f.identity.confirmEmail(pre.context, { purpose: 'ACTIVATION', token: msg!.token, newPassword: f.password }), ic = await s.clientFor(initial.issued.token);
    states['E_INITIAL (no factor, no org)'] = `${(await ic.call('GET', `${base(org)}/accounts`)).status}`;
    const plat = await s.clientFor(a.issued.token, 'platform.localhost');
    states['PLATFORM host'] = `${(await plat.call('GET', `${base(org)}/accounts`)).status}`;
    states['A32 financial purpose on PLATFORM host'] = `${(await plat.call('POST', '/api/v1/auth/reauthenticate', { password: f.password, purpose: 'FINANCE_ACCOUNT_CREATE', command: { organizationId: org, idempotencyKey: randomUUID(), payload: s.accountBody('PLAT') } })).status}`;
    await f.runtime.organizations.organizations.updateOne({ _id: org }, { $set: { status: 'SUSPENDED' } });
    states['org SUSPENDED'] = `${(await ca.call('GET', `${base(org)}/accounts`)).status} ${(await ca.call('GET', `${base(org)}/accounts`)).body.error?.code}`;
    states['A32 while org SUSPENDED'] = String(await r(ca, a, 'FINANCE_ACCOUNT_CREATE', { organizationId: org, idempotencyKey: randomUUID(), payload: s.accountBody('SUSP') }));
    await f.runtime.organizations.organizations.updateOne({ _id: org }, { $set: { status: 'ACTIVE' } });
    await f.identity.identities.updateOne({ _id: subject }, { $set: { suspended: true } });
    states['identity suspended'] = `${(await ca.call('GET', `${base(org)}/accounts`)).status}`;
    await f.identity.identities.updateOne({ _id: subject }, { $set: { suspended: false } });
    observed.set('session/org states', states);
    // R issued while T; authorization version changes before use (role removed and restored): R must not survive.
    const key = randomUUID(), payload = s.accountBody('AFTERROLE');
    assert.equal(await r(ca, a, 'FINANCE_ACCOUNT_CREATE', { organizationId: org, idempotencyKey: key, payload }), 200);
    await f.identity.identities.updateOne({ _id: subject }, { $set: { roles: ['A'], authzVersion: randomUUID() } });
    const whileA = await ca.call('POST', `${base(org)}/accounts`, payload, { 'Idempotency-Key': key });
    await f.identity.identities.updateOne({ _id: subject }, { $set: { roles: ['T'], authzVersion: randomUUID() } });
    const afterRestore = await ca.call('POST', `${base(org)}/accounts`, payload, { 'Idempotency-Key': key });
    observed.set('R across authz change', { whileRoleA: `${whileA.status} ${whileA.body.error?.code}`, afterRoleRestored: `${afterRestore.status} ${afterRestore.body.error?.code}` });
    observed.set('accounts created by denied paths', await f.database.db.collection('financial_accounts').countDocuments({ code: { $in: ['ROLE', 'PLAT', 'SUSP', 'AFTERROLE'] } }));
    evidence('P05-PERM-02', { observed: Object.fromEntries(observed) });
    for (const [k, v] of Object.entries(roles)) assert.match(v, /^GET 403 ACCESS_DENIED \/ POST 403 ACCESS_DENIED$/, k);
    assert.equal(states['anonymous P'], '401'); assert.match(states['L password-only'] ?? '', /^401 /); assert.match(states['E_INITIAL (no factor, no org)'] ?? '', /^40[13]$/);
    assert.equal(states['PLATFORM host'], '403'); assert.match(states['A32 financial purpose on PLATFORM host'] ?? '', /^40[34]$/);
    // Over HTTP the S1 organization-state guard already invalidates the strong session (401); the service-level check would say 403. Both deny without data.
    assert.match(states['org SUSPENDED'] ?? '', /^(401 AUTH_INVALID|403 ACCESS_DENIED)$/); assert.notEqual(states['A32 while org SUSPENDED'], '200'); assert.match(states['identity suspended'] ?? '', /^40[13]$/);
    const rc = observed.get('R across authz change') as Record<string, string>;
    assert.match(rc['whileRoleA'] ?? '', /^40[13] /); assert.match(rc['afterRoleRestored'] ?? '', /^40[13] /);
    assert.equal(observed.get('accounts created by denied paths'), 0);
  } finally { await s.f.close(); }
});

test('P05-PERM-03 transport and R binding on mutations: CSRF/Origin/Fetch-Metadata/content-type, missing/other-purpose/other-payload/other-key/expired R, PERSONAL scope, unknown params; S1 A32 purpose still works', { timeout: 240000 }, async () => {
  const s = await setup();
  try {
    const { f, a, org, ca, r, base } = s, observed = new Map<string, unknown>();
    const payload = s.accountBody('BIND'), key = randomUUID(), command = { organizationId: org, idempotencyKey: key, payload };
    assert.equal(await r(ca, a, 'FINANCE_ACCOUNT_CREATE', command), 200);
    const t: Record<string, string> = {};
    const post = async (label: string, body: unknown, headers: Record<string, string>, client = ca) => { const res = await client.call('POST', `${base(org)}/accounts`, body, headers); t[label] = `${res.status} ${res.body.error?.code ?? ''}`.trim(); };
    await post('CSRF missing', payload, { 'Idempotency-Key': key, 'X-CSRF-Token': '' });
    await post('CSRF wrong', payload, { 'Idempotency-Key': key, 'X-CSRF-Token': 'not-the-token' });
    await post('Origin other', payload, { 'Idempotency-Key': key, Origin: 'https://evil.example' });
    await post('Sec-Fetch-Site cross-site', payload, { 'Idempotency-Key': key, 'Sec-Fetch-Site': 'cross-site' });
    await post('Content-Type text/plain', payload, { 'Idempotency-Key': key, 'Content-Type': 'text/plain' });
    await post('Idempotency-Key missing', payload, {});
    await post('Idempotency-Key not UUID', payload, { 'Idempotency-Key': 'abc' });
    await post('other payload than R', { ...payload, name: 'Otro nombre' }, { 'Idempotency-Key': key });
    await post('other key than R', payload, { 'Idempotency-Key': randomUUID() });
    await post('PERSONAL in body', { ...payload, financialScope: 'PERSONAL' }, { 'Idempotency-Key': key });
    const R = (await f.context(a.issued.context)).reauth;
    observed.set('R still unconsumed after all rejected attempts', R?.consumed === false);
    f.clock.value += 300001;
    await post('bound R after 5:00', payload, { 'Idempotency-Key': key });
    const otherPurposeKey = randomUUID();
    observed.set('A32 SESSION_REVOKE_ALL (S1 purpose, no command)', String(await r(ca, a, 'SESSION_REVOKE_ALL', undefined)));
    await post('R of S1 purpose used for finance', s.accountBody('S1R'), { 'Idempotency-Key': otherPurposeKey });
    observed.set('A32 financial with unknown command field', String(await r(ca, a, 'FINANCE_ACCOUNT_CREATE', { organizationId: org, idempotencyKey: randomUUID(), payload, extra: true })));
    observed.set('A32 financial with open/unknown purpose', String(await r(ca, a, 'FINANCE_ANYTHING', { organizationId: org, idempotencyKey: randomUUID(), payload })));
    const q: Record<string, string> = {};
    for (const query of ['scope=PERSONAL', 'financialScope=PERSONAL', 'ownerId=x', 'limit=0', 'limit=101', 'limit=1.5', 'unknown=1']) { const res = await ca.call('GET', `${base(org)}/accounts?${query}`); q[query] = `${res.status} ${res.body.error?.code ?? ''}`; }
    const balNoDate = await ca.call('GET', `${base(org)}/balances`), balBadDate = await ca.call('GET', `${base(org)}/balances?asOf=2026-02-30`);
    q['balances without asOf'] = `${balNoDate.status} ${balNoDate.body.error?.code ?? ''}`; q['balances asOf 2026-02-30'] = `${balBadDate.status} ${balBadDate.body.error?.code ?? ''}`;
    const getSetCookie = await ca.call('GET', `${base(org)}/accounts`);
    observed.set('GET sets cookies', Boolean(getSetCookie.headers['set-cookie']?.length));
    observed.set('mutation transport/R', t); observed.set('queries', q);
    observed.set('accounts created', await f.database.db.collection('financial_accounts').countDocuments({ organizationId: org }));
    evidence('P05-PERM-03', { observed: Object.fromEntries(observed) });
    assert.deepEqual(t, { 'CSRF missing': '400 CSRF_INVALID', 'CSRF wrong': '400 CSRF_INVALID', 'Origin other': '400 CSRF_INVALID', 'Sec-Fetch-Site cross-site': '400 CSRF_INVALID', 'Content-Type text/plain': '422 INPUT_INVALID',
      'Idempotency-Key missing': '422 INPUT_INVALID', 'Idempotency-Key not UUID': '422 INPUT_INVALID', 'other payload than R': '403 R_REQUIRED', 'other key than R': '403 R_REQUIRED', 'PERSONAL in body': '422 INPUT_INVALID',
      'bound R after 5:00': '403 R_REQUIRED', 'R of S1 purpose used for finance': '403 R_REQUIRED' });
    assert.equal(observed.get('R still unconsumed after all rejected attempts'), true); assert.equal(observed.get('A32 SESSION_REVOKE_ALL (S1 purpose, no command)'), '200');
    assert.notEqual(observed.get('A32 financial with unknown command field'), '200'); assert.notEqual(observed.get('A32 financial with open/unknown purpose'), '200');
    for (const [k, v] of Object.entries(q)) assert.equal(v, '422 INPUT_INVALID', k);
    assert.equal(observed.get('accounts created'), 0);
  } finally { await s.f.close(); }
});
