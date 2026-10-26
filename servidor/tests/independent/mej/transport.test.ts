// MEJ-5 transport/identity review (Claude): N01 commit vs response, N03 logout, H03 aliases, GET without writes (AT08),
// H02 mailboxes and PLATFORM non-relaxation, over the real HTTPS app of the own group. Product code is only observed;
// fault injection patches prototypes in this process for one request and always restores them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FrozenContract } from '../../../src/shared/contract.js';
import { WorkContract } from '../../../src/modules/sessions/work-policy.js';
import { ApiClient } from '../../helpers/client.js';
import { createServer as createHttpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { reviewProfile, receipt, password, folder, freePort } from './review-profile.js';
import { world, st, data } from './fixture.js';

const observations = new Map<string, unknown>();
const observe = (k: string, v: unknown) => { observations.set(k, v); };
const sessionCookieSet = (h: import('node:http').IncomingHttpHeaders) => (h['set-cookie'] ?? []).some(v => v.startsWith('__Host-caudelyx-session=') && !v.startsWith('__Host-caudelyx-session=;'));

test('MEJ-5 transporte e identidad: grupo propio', { timeout: 900000 }, async t => {
  const group = await reviewProfile('transport');
  try {
    await t.test('T01 AT-MEJ-13/N01: fallo de esquema tras A05 no entrega sesión ni desaloja sesiones válidas', async () => {
      const f = await group.fixture(), w = await world(f), T = await w.tenant('T01'), o: Record<string, unknown> = {};
      const logins: ApiClient[] = [];
      for (let k = 0; k < 4; k++) { const l = await w.login(T.who.email); assert.equal(l.r.status, 200); logins.push(l.c); }
      const before = await f.sessions.contexts.countDocuments({ subjectId: T.who.issued.context.subjectId, kind: 'W', revoked: false });
      const original = FrozenContract.prototype.validateResult; let fired = false;
      FrozenContract.prototype.validateResult = function (id: string, status: number, body: unknown) { if (id === 'A05' && !fired) { fired = true; throw Object.assign(new Error('injected schema failure'), { status: 503 }); } return original.call(this, id, status, body); };
      let failed;
      try { failed = await w.login(T.who.email); } finally { FrozenContract.prototype.validateResult = original; }
      o['A05 with schema failure'] = st(failed.r); o['session cookie sent'] = sessionCookieSet(failed.r.headers);
      const after = await f.sessions.contexts.countDocuments({ subjectId: T.who.issued.context.subjectId, kind: 'W', revoked: false });
      o['live W before/after'] = [before, after];
      const stillValid: number[] = []; for (const c of [T.who.c, ...logins]) stillValid.push((await c.call('GET', '/api/v1/auth/me')).status);
      o['previously valid sessions after failed login'] = stillValid;
      assert.notEqual(failed.r.status, 200); assert.equal(o['session cookie sent'], false, 'no usable session without a valid response');
      observe('T01', o);
    });

    await t.test('T02 AT-MEJ-13/N01: respuesta A43 perdida o fallo de esquema después del commit', async () => {
      const f = await group.fixture(), w = await world(f), T = await w.tenant('T02'), o: Record<string, unknown> = {};
      const body = w.journalBody([{ accountId: T.acc['BANK']!, debit: '1.00', credit: '0.00' }, { accountId: T.acc['E']!, debit: '0.00', credit: '1.00' }]);
      // Lost response: the browser never stores the rotated cookie.
      const prep = await w.call(T.who, 'POST', '/auth/step-up/intents', { purpose: 'FINANCE_JOURNAL_POST', method: 'TOTP', command: { organizationId: T.org, idempotencyKey: randomUUID(), payload: body } });
      f.clock.value += 30000; const code = await f.totpCode(T.who.secret!);
      const lost = new ApiClient(T.who.c.port, T.who.c.cert); for (const [k, v] of T.who.c.cookies) lost.cookies.set(k, v); lost.csrf = T.who.c.csrf;
      const verified = await lost.call('POST', '/api/v1/auth/step-up/verify', { intentId: data<{ intentId: string }>(prep).intentId, method: 'TOTP', code });
      o['A43 committed'] = verified.status;
      const reconcile = await T.who.c.call('GET', '/api/v1/auth/me'); o['A07 with the old cookie after lost A43'] = reconcile.status;
      o['old cookie journal'] = st(await w.call(T.who, 'POST', w.base(T.org) + '/financial/journal-entries', body, { 'Idempotency-Key': randomUUID() }));
      // Schema failure of the A43 response after commit.
      const L = await w.login(T.who.email); const who2 = { ...T.who, c: L.c };
      const prep2 = await w.call(who2, 'POST', '/auth/step-up/intents', { purpose: 'FINANCE_JOURNAL_POST', method: 'TOTP', command: { organizationId: T.org, idempotencyKey: randomUUID(), payload: body } });
      f.clock.value += 30000; const code2 = await f.totpCode(T.who.secret!);
      const original = WorkContract.prototype.validate; let fired = false;
      WorkContract.prototype.validate = function (name: string, value: unknown, response = false) { if (name === 'StepUpVerified' && response && !fired) { fired = true; throw Object.assign(new Error('injected'), { status: 503 }); } return original.call(this, name, value, response); };
      let r2; try { r2 = await w.call(who2, 'POST', '/auth/step-up/verify', { intentId: data<{ intentId: string }>(prep2).intentId, method: 'TOTP', code: code2 }); } finally { WorkContract.prototype.validate = original; }
      o['A43 with schema failure'] = st(r2); o['A43 failure set cookie'] = sessionCookieSet(r2.headers);
      o['A07 after A43 schema failure'] = (await who2.c.call('GET', '/api/v1/auth/me')).status;
      o['retry same intent and code after rolled-back failure'] = st(await w.call(who2, 'POST', '/auth/step-up/verify', { intentId: data<{ intentId: string }>(prep2).intentId, method: 'TOTP', code: code2 }));
      // Wrong code does not close a healthy W (AT-MEJ-16 server side).
      const L3 = await w.login(T.who.email); const who3 = { ...T.who, c: L3.c };
      const prep3 = await w.call(who3, 'POST', '/auth/step-up/intents', { purpose: 'FINANCE_JOURNAL_POST', method: 'TOTP', command: { organizationId: T.org, idempotencyKey: randomUUID(), payload: body } });
      o['wrong code'] = st(await w.call(who3, 'POST', '/auth/step-up/verify', { intentId: data<{ intentId: string }>(prep3).intentId, method: 'TOTP', code: '000000' }));
      o['W after wrong code'] = (await who3.c.call('GET', '/api/v1/auth/me')).status; assert.equal(o['W after wrong code'], 200);
      observe('T02', o);
    });

    await t.test('T03 AT-MEJ-15/N03: A06 revoca pre-sesión y sesión, idempotente, exige CSRF con contexto válido', async () => {
      const f = await group.fixture(), w = await world(f), T = await w.tenant('T03'), o: Record<string, unknown> = {};
      const c = new ApiClient(T.who.c.port, T.who.c.cert); await c.refreshCsrf();
      const pre = c.cookies.get('__Host-caudelyx-pre')!; c.cookies.set('__Host-caudelyx-session', w.sessionToken(T.who)); await c.refreshCsrf();
      o['logout without CSRF'] = (await c.call('POST', '/api/v1/auth/logout', undefined, { 'X-CSRF-Token': 'nope' })).status;
      const out = await c.call('POST', '/api/v1/auth/logout'); o['logout'] = out.status;
      o['cleared cookies'] = (out.headers['set-cookie'] ?? []).map(v => v.split('=')[0] + (v.includes('Max-Age=0') ? ':cleared' : ':set'));
      const { createHash } = await import('node:crypto'); const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
      o['pre revoked'] = (await f.sessions.contexts.findOne({ _id: digest(pre) }))?.revoked; o['session revoked'] = (await f.sessions.contexts.findOne({ _id: digest(w.sessionToken(T.who)) }))?.revoked;
      const again = new ApiClient(T.who.c.port, T.who.c.cert); again.cookies.set('__Host-caudelyx-session', w.sessionToken(T.who));
      o['repeat logout'] = (await again.call('POST', '/api/v1/auth/logout')).status; o['old cookie after logout'] = (await again.call('GET', '/api/v1/auth/me')).status;
      o['old cookie business'] = (await again.call('GET', w.base(T.org) + '/financial/accounts')).status;
      assert.equal(o['logout'], 204); assert.equal(o['pre revoked'], true); assert.equal(o['session revoked'], true); assert.equal(o['repeat logout'], 204); assert.equal(o['old cookie after logout'], 401);
      observe('T03', o);
    });

    await t.test('T04 AT-MEJ-23/H03: alias con mayúsculas, mismo contrato, sin 503 ni salto de CSRF', async () => {
      const f = await group.fixture(), w = await world(f), T = await w.tenant('T04'), o: Record<string, string> = {};
      const b = await f.signup(), cb = await w.h.client(b.issued.token);
      const paths = ['/financial/accounts', '/FINANCIAL/accounts', '/Financial/Accounts', '/borrowers', '/BORROWERS', '/loan-operations/positions', '/LOAN-OPERATIONS/positions', '/financial/opening-files', '/FINANCIAL/OPENING-FILES'];
      for (const p of paths) { o['B GET ' + p] = st(await w.call({ c: cb }, 'GET', w.base(T.org) + p)); o['W GET ' + p] = st(await w.call(T.who, 'GET', w.base(T.org) + p)); }
      for (const p of ['/api/v1/organizations/' + T.org + '/FINANCIAL/INITIAL-BALANCES', '/api/v1/organizations/' + T.org + '/financial/initial-balances', '/API/V1/AUTH/STEP-UP/INTENTS', '/api/v1/auth/step-up/intents']) {
        o['W POST no CSRF ' + p] = st(await T.who.c.call('POST', p, {}, { 'X-CSRF-Token': 'x' }) as never);
      }
      for (const [k, v] of Object.entries(o)) assert.ok(!v.startsWith('503'), k + ' must not 503');
      for (const [k, v] of Object.entries(o).filter(([k]) => k.startsWith('W POST no CSRF'))) assert.ok(!v.startsWith('2'), k);
      const lower = o['B GET /financial/accounts'];
      for (const [k, v] of Object.entries(o).filter(([k]) => k.startsWith('B GET'))) assert.equal(v, lower, 'uniform B guard ' + k);
      observe('T04', o);
    });

    await t.test('T05 AT-MEJ-34/AT08: GET de sesión y negocio no escriben dominio, ledger, evidencia ni lastSeen', async () => {
      const f = await group.fixture(), w = await world(f), T = await w.tenant('T05');
      const g = await w.balanceGrant(T); assert.equal(g.verify?.status, 200); await w.fund(T, '3000000.00');
      const b = await w.borrower(T, 'R5_T05'); const L = await w.loan(T, b.id); assert.equal((await w.operate(T, await w.disburseRequest(T, L.id))).r.status, 201);
      const writes: string[] = [], db = f.database.db.databaseName;
      Reflect.set(f.database.client, 'monitorCommands', true);
      const listener = (e: { commandName: string; databaseName: string; command: Record<string, unknown> }) => { if (['insert', 'update', 'delete', 'findAndModify', 'bulkWrite'].includes(e.commandName) && e.databaseName.startsWith(db)) writes.push(e.commandName + ':' + String(e.command[e.commandName])); };
      const seenBefore = (await f.sessions.find(w.sessionToken(T.who), 'TENANT'))!.lastSeenAt;
      f.database.client.on('commandStarted', listener);
      const statuses: Record<string, number> = {};
      try {
        for (const p of ['/api/v1/auth/me', w.base(T.org) + '/financial/accounts', w.base(T.org) + '/loans', w.base(T.org) + '/loans/' + L.id, w.base(T.org) + '/loan-operations/positions', w.base(T.org) + '/loan-operations/positions/' + L.id,
          w.base(T.org) + `/loan-operations/positions/${L.id}/installments`, w.base(T.org) + `/loan-operations/positions/${L.id}/schedule-versions`, w.base(T.org) + '/loan-operations/book', w.base(T.org) + '/borrowers', '/api/v1/organization']) {
          for (let k = 0; k < 2; k++) statuses[p.replace(T.org, '{org}').replace(L.id, '{loan}')] = (await T.who.c.call('GET', p)).status;
        }
      } finally { f.database.client.off('commandStarted', listener); }
      const seenAfter = (await f.sessions.find(w.sessionToken(T.who), 'TENANT'))!.lastSeenAt;
      observe('T05', { statuses, writes, lastSeenUnchanged: seenAfter === seenBefore });
      assert.deepEqual(writes, [], 'GET must not write'); assert.equal(seenAfter, seenBefore);
      for (const [k, v] of Object.entries(statuses)) assert.equal(v, 200, k);
    });

    await t.test('T06 AT-MEJ-22/H02: ambos buzones con alta directa, invitación legado y «No fui yo»', async () => {
      const f = await group.fixture(), o: Record<string, unknown> = {};
      const local = await import(pathToFileURL(resolve('scripts/mailbox-local.mjs')).href) as { activationItem: (i: unknown, m: unknown, t: string, o: URL) => Record<string, unknown> };
      const installed = await import(pathToFileURL(resolve('scripts/mailbox-installed.mjs')).href) as { activationItem: (i: unknown, m: unknown, t: string, o: URL) => Record<string, unknown> };
      const a = await f.signup(); const msg = await f.database.db.collection('synthetic_mail').findOne({ subjectId: a.subject._id, purpose: 'ACTIVATION' });
      const identity = await f.identity.identities.findOne({ _id: a.subject._id }), origin = new URL('https://localhost:3001');
      const itemLocal = local.activationItem(identity, msg, a.token, origin), itemInstalled = installed.activationItem(identity, msg, a.token, origin);
      const redact = (x: Record<string, unknown>) => JSON.parse(JSON.stringify(x).split(a.token).join('[TOKEN]'));
      o['direct local'] = redact(itemLocal); o['direct installed'] = redact(itemInstalled);
      assert.deepEqual(itemLocal, itemInstalled, 'both mailboxes agree');
      assert.equal(itemLocal['requiresPasswordSetup'], false); assert.ok(!String(itemLocal['activationUrl']).includes('legacy=1'));
      assert.ok(String(itemLocal['rejectionUrl']).includes('#/rechazar?') && String(itemLocal['rejectionUrl']).includes('purpose=REJECT'));
      const legacy = { ...identity, registrationSource: 'INVITATION', passwordHash: null };
      o['invitation legacy'] = redact(local.activationItem(legacy, msg, a.token, origin));
      assert.equal(local.activationItem(legacy, msg, a.token, origin)['requiresPasswordSetup'], true);
      observe('T06', o);
    });

    await t.test('T07 AT-MEJ-01: PLATFORM no acepta rutas MEJ ni W', async () => {
      const f = await group.fixture(), w = await world(f), T = await w.tenant('T07'), o: Record<string, string> = {};
      const p = new ApiClient(T.who.c.port, T.who.c.cert, 'platform.localhost'); p.cookies.set('__Host-caudelyx-platform-session', w.sessionToken(T.who)); p.cookies.set('__Host-caudelyx-session', w.sessionToken(T.who)); await p.refreshCsrf().catch(() => undefined);
      o['platform me with tenant W'] = st(await p.call('GET', '/api/v1/auth/me') as never);
      o['platform step-up intents'] = st(await p.call('POST', '/api/v1/auth/step-up/intents', { purpose: 'FINANCE_JOURNAL_POST', method: 'TOTP' }) as never);
      o['platform activity'] = st(await p.call('POST', '/api/v1/auth/session/activity', {}) as never);
      o['platform login tenant account'] = st(await p.call('POST', '/api/v1/auth/login', { email: T.who.email, password }) as never);
      for (const [k, v] of Object.entries(o)) assert.ok(!v.startsWith('2'), k);
      observe('T07', o);
    });
    await t.test('T08 AT-MEJ-14/15/25–30: navegador real, capturas 360/768/1440 y zoom', async () => {
      const f = await group.fixture({ static: true }), w = await world(f);
      const A = await w.tenant('E2E-A'), B = await w.tenant('E2E-B'), names = { A: 'Ana Revisora', B: 'Beto Revisor' };
      for (const [T, name] of [[A, names.A], [B, names.B]] as const) {
        const me = await w.call(T.who, 'GET', '/auth/me'), version = (me.body.data?.['profile'] as { version: string }).version;
        assert.equal((await w.call(T.who, 'PATCH', '/auth/profile', { displayName: name }, { 'If-Match': version })).status, 200);
      }
      const secrets: Record<string, string> = { A: A.who.secret!, B: B.who.secret! }, nonce = randomUUID(), actions: string[] = [];
      const controlPort = await freePort([w.h.port]); await receipt({ event: 'control-reserved-before-listen', controlPort });
      const control = createHttpServer(async (req, res) => {
        if (req.headers['x-fixture-owner'] !== nonce || req.method !== 'POST') { res.writeHead(403); res.end(); return; }
        try {
          let raw = ''; for await (const part of req) { raw += String(part); if (raw.length > 2048) throw Error('too large'); }
          const body = JSON.parse(raw) as Record<string, string>; actions.push(body['action']!);
          let out: unknown;
          if (body['action'] === 'who') out = { emailA: A.who.email, emailB: B.who.email, password, nameA: names.A, nameB: names.B, orgA: 'Organización revisora E2E-A', orgB: 'Organización revisora E2E-B' };
          else if (body['action'] === 'journals') out = { count: String(await f.database.db.collection('financial_journals').countDocuments({ organizationId: (body['who'] === 'B' ? B : A).org })) };
          else if (body['action'] === 'code' && secrets[body['who'] ?? '']) { f.clock.value += 30000; out = { code: await f.totpCode(secrets[body['who']!]!) }; }
          else throw Error('unknown own control');
          res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out));
        } catch { res.writeHead(400); res.end('{}'); }
      });
      control.listen(controlPort, '127.0.0.1'); await once(control, 'listening');
      const started = Date.now(), release = group.hold();
      const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/independent/mej/playwright.config.ts'], { cwd: resolve('../cliente'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, MEJ5_URL: 'https://localhost:' + w.h.port, MEJ5_CONTROL: 'http://127.0.0.1:' + controlPort, MEJ5_NONCE: nonce, MEJ5_OUTPUT: folder, MEJ5_EVIDENCE: resolve('../../Construccion/Sprints/MEJ/Evidencias') } });
      await receipt({ event: 'playwright-child-created', pid: child.pid });
      let output = ''; for (const s of [child.stdout, child.stderr]) s.on('data', b => { output += String(b); });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        timer = setTimeout(() => child.kill(), 430000);
        const [exit] = await once(child, 'exit');
        const redacted = output.replace(/otpauth:\/\/[^\s"']+/g, 'otpauth://[REDACTED]');
        console.log('MEJ5_BROWSER_OUTPUT\n' + redacted.slice(-20000));
        observe('T08', { exit, seconds: (Date.now() - started) / 1000, controlActions: actions, evidence: [...redacted.matchAll(/MEJ5_EVIDENCE (.*)/g)].map(x => x[1]) });
        assert.equal(exit, 0, 'real browser journey must pass');
      } finally {
        clearTimeout(timer); if (child.exitCode === null && !child.killed) { child.kill(); await once(child, 'exit'); }
        await new Promise<void>(r => control.close(() => r())); release();
        await receipt({ event: 'playwright-child-stopped', pid: child.pid, controlPort });
      }
    });
  } finally {
    await receipt({ event: 'observations', file: 'transport', observations: Object.fromEntries(observations) });
    console.log('MEJ5_OBSERVATIONS ' + JSON.stringify(Object.fromEntries(observations)));
    await group.dispose();
  }
});
