/* eslint-disable security/detect-object-injection -- Fixed labels/maps of this test, never request input. */
// MEJ-5 independent final review (Claude) of MEJ-4-v1-INTEGRADO. Own group (review-profile.ts), real HTTPS for
// every reviewed operation, own oracles. No author helper/test is executed; no production engine is imported for expectations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { AppError } from '../../../src/shared/errors.js';
import { purposeClass, BALANCE_PURPOSES, SECURITY_PURPOSES, WORK_PURPOSES } from '../../../src/modules/sessions/work-policy.js';
import { financePurposes } from '../../../src/modules/finance/contract.js';
import { purposes as openingPurposes } from '../../../src/modules/opening/contract.js';
import { purposes as lendingPurposes } from '../../../src/modules/lending/contract.js';
import { operationPurposes } from '../../../src/modules/lending/operations-contract.js';
import { reviewProfile, receipt, password, folder } from './review-profile.js';
import { world, st, data, tag, type Tenant } from './fixture.js';
import { s5Scenario, ledgerOracle, mirror, c, m, ORACLE_SOURCES } from './economic-oracle.js';

const observations = new Map<string, unknown>();
const observe = (k: string, v: unknown) => { observations.set(k, v); };
const codeOf = async (p: Promise<unknown>) => { try { await p; return 'OK'; } catch (e) { return e instanceof AppError ? `${e.status} ${e.code}` : String(e).slice(0, 80); } };

// Literal lists from AUTH_MEJ_v1 §AUTH-M02 (contract text), the reviewer's oracle for the catalogue.
const CONTRACT_BALANCE = ['FINANCE_JOURNAL_POST', 'FINANCE_TRANSFER', 'FINANCE_JOURNAL_REVERSE', 'OPENING_COMMIT', 'LOAN_DISBURSE', 'LOAN_ACCRUE', 'LOAN_RECEIPT_POST', 'LOAN_CREDIT_APPLY'];
const CONTRACT_SECURITY = ['MEMBER_INVITE', 'MEMBER_ROLE_CHANGE', 'MEMBER_SUSPEND', 'MEMBER_REACTIVATE', 'MEMBER_SESSIONS_REVOKE', 'ORGANIZATION_SESSIONS_REVOKE', 'PASSWORD_CHANGE', 'MFA_ENROLL', 'MFA_REMOVE', 'RECOVERY_CODES_REGENERATE', 'SESSION_REVOKE_OTHER', 'SESSION_REVOKE_ALL'];
const CONTRACT_WORK = ['ORGANIZATION_CREATE', 'ORGANIZATION_EDIT', 'INVITATION_REVOKE', 'FINANCE_ACCOUNT_CREATE', 'FINANCE_ACCOUNT_UPDATE', 'OPENING_CREATE', 'OPENING_REPLACE', 'OPENING_VALIDATE', 'OPENING_APPROVE', 'OPENING_CANCEL', 'BORROWER_SCHEMA_PUBLISH', 'BORROWER_CREATE', 'BORROWER_REPLACE', 'BORROWER_DEACTIVATE', 'BORROWER_REACTIVATE', 'LOAN_DRAFT_CREATE', 'LOAN_TERMS_REPLACE', 'LOAN_TERMS_CONFIRM', 'LOAN_CANCEL'];
const ALL = [...CONTRACT_BALANCE, ...CONTRACT_SECURITY, ...CONTRACT_WORK];

test('MEJ-5 revisión independiente: grupo propio reutilizado', { timeout: 1500000 }, async t => {
  const group = await reviewProfile('review');
  try {
    await t.test('M00 AT-MEJ-35: fallo de setup parcial deja el grupo reutilizable', async () => {
      await assert.rejects(group.fixture({ failSetup: true }), /Injected own partial setup failure/);
      const f = await group.fixture(); assert.ok(await f.database.db.command({ ping: 1 }));
    });

    await t.test('M01 AT-MEJ-03/04/06: catálogo cerrado 19/8/12 = contrato = propósitos del código', async () => {
      const contract = JSON.parse(readFileSync(resolve('../../Construccion/Sprints/MEJ/Contratos/openapi-mej-v1.json'), 'utf8'))['x-purpose-policy'];
      assert.deepEqual(new Set(contract.BALANCE_60M), new Set(CONTRACT_BALANCE)); assert.deepEqual(new Set(contract.SECURITY_ONE_SHOT), new Set(CONTRACT_SECURITY)); assert.deepEqual(new Set(contract.WORK_ONLY), new Set(CONTRACT_WORK));
      assert.deepEqual([CONTRACT_BALANCE.length, CONTRACT_SECURITY.length, CONTRACT_WORK.length, new Set(ALL).size], [8, 12, 19, 39]);
      for (const p of CONTRACT_BALANCE) assert.equal(purposeClass(p), 'BALANCE_60M', p);
      for (const p of CONTRACT_SECURITY) assert.equal(purposeClass(p), 'SECURITY_ONE_SHOT', p);
      for (const p of CONTRACT_WORK) assert.equal(purposeClass(p), 'WORK_ONLY', p);
      for (const p of ['LOGIN', 'FINANCE_ANY', 'LOAN_ANY', 'INITIAL_BALANCE', 'finance_journal_post', '']) assert.equal(purposeClass(p), null, p);
      const code = new Set<string>([...financePurposes, ...openingPurposes.values(), ...lendingPurposes.values(), ...operationPurposes, ...CONTRACT_SECURITY, 'ORGANIZATION_CREATE', 'ORGANIZATION_EDIT', 'INVITATION_REVOKE']);
      assert.deepEqual([...code].filter(p => !ALL.includes(p)), [], 'code purpose outside the catalogue');
      assert.deepEqual(new Set([...BALANCE_PURPOSES, ...SECURITY_PURPOSES, ...WORK_PURPOSES]), new Set(ALL));
    });

    await t.test('M02 AT-MEJ-03/04/06: punto de control por cada uno de los 39 propósitos', async () => {
      const f = await group.fixture(), a = await f.actor(), result: Record<string, string> = {};
      const check = async (label: string, ctx = a.issued.context) => { for (const p of ALL) result[label + ':' + p] = await codeOf(f.database.transaction(async s => { await f.sessions.consumeProof(ctx, p, null, s, null); })); };
      await check('no-grant');
      for (const p of CONTRACT_WORK) assert.equal(result['no-grant:' + p], 'OK', p);
      for (const p of [...CONTRACT_BALANCE, ...CONTRACT_SECURITY]) assert.equal(result['no-grant:' + p], '403 REAUTH_REQUIRED', p);
      const a42work: Record<string, string> = {}; for (const p of CONTRACT_WORK) { a42work[p] = await codeOf(f.identity.work!.prepare(a.issued.context, { purpose: p, method: 'TOTP' })); assert.match(a42work[p]!, /^4[0-9]{2} /, 'A42 refuses unprotected ' + p); }
      observe('M02 A42 WORK refusals', a42work);
      observe('M02 A42 LOGIN', await codeOf(f.identity.work!.prepare(a.issued.context, { purpose: 'LOGIN', method: 'TOTP' })));
      // Grant from a real TOTP: the eight balance purposes pass, the twelve security ones still need their own proof.
      const org = await f.runtime.organizations.create(a.issued.context, { name: 'Org M02', timezone: 'America/Bogota', currency: 'COP' }, randomUUID());
      const holder = { issued: a.issued, secret: a.secret };
      const bank = await f.runtime.finance.mutate(holder.issued.context, 'createAccount', (org.data.organization as { id: string }).id, { code: 'B_M02', name: 'Banco', currency: 'COP', accountClass: 'ASSET', kind: 'BANK' }, randomUUID());
      const eq = await f.runtime.finance.mutate(holder.issued.context, 'createAccount', (org.data.organization as { id: string }).id, { code: 'E_M02', name: 'Patrimonio', currency: 'COP', accountClass: 'EQUITY', kind: 'GENERAL' }, randomUUID());
      const orgId = (org.data.organization as { id: string }).id, key = randomUUID();
      const body = { currency: 'COP', effectiveDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(f.now())), sourceId: randomUUID(), supportReference: 'M02', description: 'Grant', lines: [{ accountId: (bank.data as { id: string }).id, debit: '1.00', credit: '0.00' }, { accountId: (eq.data as { id: string }).id, debit: '0.00', credit: '1.00' }] };
      const v = await f.stepUp(holder, 'FINANCE_JOURNAL_POST', { organizationId: orgId, idempotencyKey: key, payload: body });
      assert.equal(v.data.verifiedClass, 'BALANCE_60M');
      await check('grant', holder.issued.context);
      for (const p of [...CONTRACT_WORK, ...CONTRACT_BALANCE]) assert.equal(result['grant:' + p], 'OK', 'with grant ' + p);
      for (const p of CONTRACT_SECURITY) assert.equal(result['grant:' + p], '403 REAUTH_REQUIRED', 'grant never satisfies ' + p);
      observe('M02', { checked: Object.keys(result).length });
    });

    await t.test('M03 AT-MEJ-03/20: trabajo sin código por HTTP y roles intactos', async () => {
      const f = await group.fixture(), w = await world(f), T = await w.tenant('M03'), o: Record<string, string> = {};
      const ren = await w.call(T.who, 'PATCH', w.base(T.org) + '/financial/accounts/' + T.acc['CASH'], { name: 'Caja renombrada' }, { 'If-Match': await w.accountETag(T, 'CASH'), 'Idempotency-Key': randomUUID() }); o['FINANCE_ACCOUNT_UPDATE'] = st(ren);
      const b = await w.borrower(T, 'R5_B1'); o['BORROWER_CREATE'] = st(b.r);
      const brp = await w.call(T.who, 'PUT', w.base(T.org) + '/borrowers/' + b.id, { profile: { displayName: 'Persona editada', schemaVersion: 1, extras: {} }, changeReason: 'Edición revisora' }, { 'Idempotency-Key': randomUUID(), 'If-Match': tag(b.r) }); o['BORROWER_REPLACE'] = st(brp);
      const bd = await w.call(T.who, 'POST', w.base(T.org) + `/borrowers/${b.id}/deactivation`, { reason: 'Prueba' }, { 'Idempotency-Key': randomUUID(), 'If-Match': tag(brp) }); o['BORROWER_DEACTIVATE'] = st(bd);
      const br = await w.call(T.who, 'POST', w.base(T.org) + `/borrowers/${b.id}/reactivation`, { reason: 'Prueba' }, { 'Idempotency-Key': randomUUID(), 'If-Match': tag(bd) }); o['BORROWER_REACTIVATE'] = st(br);
      const l = await w.loan(T, b.id, {}, false); o['LOAN_DRAFT_CREATE'] = st(l.draft);
      const q2 = await w.call(T.who, 'POST', w.base(T.org) + '/loan-quotes', { terms: w.termsOf(T, b.id, { principal: '1500000.00' }) }, { 'Idempotency-Key': randomUUID() });
      const rt = await w.call(T.who, 'PUT', w.base(T.org) + `/loans/${l.id}/terms`, { quoteId: data<{ id: string }>(q2).id, quoteFingerprint: data<{ fingerprint: string }>(q2).fingerprint, changeReason: 'Cambio revisora' }, { 'Idempotency-Key': randomUUID(), 'If-Match': tag(l.draft) }); o['LOAN_TERMS_REPLACE'] = st(rt);
      const cf = await w.call(T.who, 'POST', w.base(T.org) + `/loans/${l.id}/confirmation`, { quoteId: data<{ id: string }>(q2).id, quoteFingerprint: data<{ fingerprint: string }>(q2).fingerprint, termsVersion: 2 }, { 'Idempotency-Key': randomUUID(), 'If-Match': tag(rt) }); o['LOAN_TERMS_CONFIRM'] = st(cf);
      const ca = await w.call(T.who, 'POST', w.base(T.org) + `/loans/${l.id}/cancellation`, { reason: 'Cancelación revisora' }, { 'Idempotency-Key': randomUUID(), 'If-Match': tag(cf) }); o['LOAN_CANCEL'] = st(ca);
      const sch = await w.call(T.who, 'POST', w.base(T.org) + '/borrower-field-schemas', { fields: [{ key: 'barrio', label: 'Barrio', type: 'TEXT', deprecated: false }], changeReason: 'Campo revisora' }, { 'Idempotency-Key': randomUUID(), 'If-Match': tag(await w.get(T, '/borrower-field-schemas/current')) }); o['BORROWER_SCHEMA_PUBLISH'] = st(sch);
      const org = await w.call(T.who, 'GET', '/organization'); const ed = await w.call(T.who, 'PATCH', '/organization', { name: 'Organización editada' }, { 'If-Match': tag(org) }); o['ORGANIZATION_EDIT'] = st(ed);
      // Confirming terms must not write money; no grant or proof was created by WORK operations.
      assert.equal(await f.database.db.collection('financial_journals').countDocuments({ organizationId: T.org }), 0, 'no journal by WORK operations');
      const live = await f.sessions.find(w.sessionToken(T.who), 'TENANT');
      o['context after WORK'] = JSON.stringify({ grant: live?.balanceGrant ?? null, reauth: live?.reauth ?? null });
      // Roles intact: a confirmed never-factor user accepts an Operator invitation in W and cannot do finance/admin.
      const B = await f.worker(), bw = await w.connect(B);
      const invite = { email: B.email, roleIds: ['O'] };
      o['invite without proof'] = st(await w.call(T.who, 'POST', '/organization/invitations', invite));
      const pr = await w.stepUp(T.who, 'MEMBER_INVITE', invite, T.org); o['MEMBER_INVITE step-up'] = st(pr.verify ?? pr.prepare);
      o['invite with proof'] = st(await w.call(T.who, 'POST', '/organization/invitations', invite));
      await f.identity.dispatchMail();
      const inv = (await f.runtime.organizations.invitations.findOne({ email: B.email }))!;
      const note = [...f.messages.notificationInbox.values()].find(n => n.kind === 'INVITATION' && n.subjectId === inv._id)!;
      o['A15 CONFIRM in W never-factor'] = st(await w.call(bw, 'POST', '/auth/invitations/accept', { mode: 'CONFIRM', token: note.payload['token'] }));
      o['O creates finance account'] = st(await w.call(bw, 'POST', w.base(T.org) + '/financial/accounts', { code: 'OP_X', name: 'Intento', currency: 'COP', accountClass: 'ASSET', kind: 'BANK' }, { 'Idempotency-Key': randomUUID() }));
      o['O reads finance accounts'] = st(await w.call(bw, 'GET', w.base(T.org) + '/financial/accounts'));
      o['O invites'] = st(await w.call(bw, 'POST', '/auth/step-up/intents', { purpose: 'MEMBER_INVITE', method: 'TOTP', command: { email: 'otro@example.test', roleIds: ['O'] }, resourceId: T.org }));
      assert.match(o['O creates finance account']!, /^40[34]/); assert.match(o['O reads finance accounts']!, /^40[34]/); assert.match(o['O invites']!, /^403/);
      // INVITATION_REVOKE is WORK: no code needed.
      const inv2 = { email: 'r5-rev-' + randomUUID() + '@example.test', roleIds: ['O'] };
      await w.stepUp(T.who, 'MEMBER_INVITE', inv2, T.org); await w.call(T.who, 'POST', '/organization/invitations', inv2);
      const row = (await f.runtime.organizations.invitations.findOne({ email: inv2.email }))!;
      const list = await w.call(T.who, 'GET', '/organization/invitations'); const item = (data<{ items: { id: string; version: string }[] }>(list).items ?? []).find(x => x.id === row._id);
      o['INVITATION_REVOKE'] = st(await w.call(T.who, 'DELETE', '/organization/invitations/' + row._id, undefined, { 'If-Match': item?.version ?? '' }));
      assert.match(o['INVITATION_REVOKE']!, /^20/); assert.match(o['invite without proof']!, /^403 (R_REQUIRED|REAUTH_REQUIRED)$/); assert.match(o['A15 CONFIRM in W never-factor']!, /^200/);
      observe('M03', o);
    });

    await t.test('M04 AT-MEJ-04/05: hora de saldo fija 3600000 ms, varias acciones con un código', async () => {
      const f = await group.fixture(), w = await world(f), T = await w.tenant('M04'), o: Record<string, unknown> = {};
      o['journal without grant'] = st((await w.fund(T, '1000.00')).r);
      assert.equal(o['journal without grant'], '403 R_REQUIRED');
      const g = await w.balanceGrant(T); assert.equal(g.verify?.status, 200);
      const until = Date.parse(String((g.verify!.body.data as { session: { balanceVerifiedUntil: string } }).session.balanceVerifiedUntil)), grantedAt = f.now();
      assert.equal(until - grantedAt, 3600000, 'exactly 60 min from verification');
      const fund = await w.fund(T, '500000.00'); assert.equal(fund.r.status, 201);
      const tr = await w.call(T.who, 'POST', w.base(T.org) + '/financial/transfers', { currency: 'COP', effectiveDate: w.today(), sourceId: randomUUID(), supportReference: 'TR', description: 'Transferencia', fromAccountId: T.acc['BANK'], toAccountId: T.acc['CASH'], amount: '1000.00' }, { 'Idempotency-Key': randomUUID() });
      assert.equal(tr.status, 201, 'transfer under the same grant ' + st(tr));
      const small = await w.fund(T, '100.00'); assert.equal(small.r.status, 201, 'second journal, same grant'); const jid = data<{ id: string }>(small.r).id;
      const rv = await w.call(T.who, 'POST', w.base(T.org) + `/financial/journal-entries/${jid}/reversals`, { effectiveDate: w.today(), sourceId: randomUUID(), supportReference: 'RV', reason: 'Reversa revisora' }, { 'Idempotency-Key': randomUUID(), 'If-Match': tag(await w.get(T, '/financial/journal-entries/' + jid)) });
      assert.equal(rv.status, 201, 'reversal under the same grant ' + st(rv));
      // Activity renews idle only; grant deadline unchanged.
      f.clock.value = grantedAt + 1800000;
      const act = await w.call(T.who, 'POST', '/auth/session/activity', {}); assert.equal(act.status, 200);
      assert.equal(Date.parse((act.body.data as { session: { balanceVerifiedUntil: string } }).session.balanceVerifiedUntil), until, 'activity does not extend grant');
      f.clock.value = until - 1; assert.equal((await w.fund(T, '1.00')).r.status, 201, '3599999 ms still valid');
      f.clock.value = until; o['at 3600000'] = st((await w.fund(T, '1.00')).r); assert.equal(o['at 3600000'], '403 R_REQUIRED');
      const me = await w.call(T.who, 'GET', '/auth/me'); assert.equal(me.status, 200, 'W keeps working after grant expiry'); const shown = (me.body.data as { session: { balanceVerifiedUntil: string | null; serverNow: string } }).session; o['balanceVerifiedUntil after expiry'] = shown.balanceVerifiedUntil; assert.ok(shown.balanceVerifiedUntil === null || Date.parse(shown.balanceVerifiedUntil) <= Date.parse(shown.serverNow), 'expired grant never shown as active');
      // Another session of the same person has no grant.
      const g2 = await w.balanceGrant(T); assert.equal(g2.verify?.status, 200);
      const other = await w.login(T.who.email); assert.equal(other.r.status, 200);
      o['other session'] = st(await w.call({ c: other.c }, 'POST', w.base(T.org) + '/financial/journal-entries', w.journalBody([{ accountId: T.acc['BANK']!, debit: '1.00', credit: '0.00' }, { accountId: T.acc['E']!, debit: '0.00', credit: '1.00' }]), { 'Idempotency-Key': randomUUID() }));
      assert.equal(o['other session'], '403 R_REQUIRED');
      // Revocation by password change (security proof) kills W and its grant.
      const pc = await w.stepUp(T.who, 'PASSWORD_CHANGE'); assert.equal(pc.verify?.status, 200);
      const ch = await w.call(T.who, 'POST', '/auth/password/change', { currentPassword: password, newPassword: 'Otra frase sintetica de la revisora MEJ5 77' }); o['password change'] = st(ch);
      o['after revocation'] = st((await w.fund(T, '1.00')).r); assert.match(String(o['after revocation']), /^401/);
      observe('M04', o);
    });

    await t.test('M05 AT-MEJ-06/33: prueba de seguridad única, ligada y de 5 min', async () => {
      const f = await group.fixture(), w = await world(f), T = await w.tenant('M05'), o: Record<string, string> = {};
      const g = await w.balanceGrant(T); assert.equal(g.verify?.status, 200);
      o['regenerate with balance grant only'] = st(await w.call(T.who, 'POST', '/auth/mfa/recovery-codes/regenerate', {}));
      assert.match(o['regenerate with balance grant only']!, /^403 (R_REQUIRED|REAUTH_REQUIRED)$/);
      const p = await w.stepUp(T.who, 'RECOVERY_CODES_REGENERATE'); assert.equal(p.verify?.status, 200);
      assert.equal((p.verify!.body.data as { verifiedClass: string }).verifiedClass, 'SECURITY_ONE_SHOT');
      o['wrong purpose with proof'] = st(await w.call(T.who, 'POST', '/auth/sessions/revoke-all', {}));
      o['right purpose'] = st(await w.call(T.who, 'POST', '/auth/mfa/recovery-codes/regenerate', {}));
      o['replay same proof'] = st(await w.call(T.who, 'POST', '/auth/mfa/recovery-codes/regenerate', {}));
      assert.match(o['wrong purpose with proof']!, /^403 (R_REQUIRED|REAUTH_REQUIRED)$/); assert.match(o['right purpose']!, /^20/); assert.match(o['replay same proof']!, /^403 (R_REQUIRED|REAUTH_REQUIRED)$/);
      const me = await w.call(T.who, 'GET', '/auth/me'); assert.notEqual((me.body.data as { session: { balanceVerifiedUntil: unknown } }).session.balanceVerifiedUntil, undefined);
      // 5-minute TTL from preparation.
      const prep = await w.call(T.who, 'POST', '/auth/step-up/intents', { purpose: 'RECOVERY_CODES_REGENERATE', method: 'TOTP' }); const prepAt = f.now();
      f.clock.value = prepAt + 30000;
      const ver = await w.call(T.who, 'POST', '/auth/step-up/verify', { intentId: data<{ intentId: string }>(prep).intentId, method: 'TOTP', code: await f.totpCode(T.who.secret!) }); assert.equal(ver.status, 200);
      f.clock.value = prepAt + 300000; o['at 5 min'] = st(await w.call(T.who, 'POST', '/auth/mfa/recovery-codes/regenerate', {})); assert.match(o['at 5 min']!, /^403 (R_REQUIRED|REAUTH_REQUIRED)$/);
      // Replay of a consumed TOTP step is rejected for a new intent.
      f.clock.value += 30000; const stepCode = await f.totpCode(T.who.secret!);
      const prepA = await w.call(T.who, 'POST', '/auth/step-up/intents', { purpose: 'RECOVERY_CODES_REGENERATE', method: 'TOTP' });
      o['first use of step'] = st(await w.call(T.who, 'POST', '/auth/step-up/verify', { intentId: data<{ intentId: string }>(prepA).intentId, method: 'TOTP', code: stepCode }));
      const prep2 = await w.call(T.who, 'POST', '/auth/step-up/intents', { purpose: 'RECOVERY_CODES_REGENERATE', method: 'TOTP' });
      o['same TOTP step again'] = st(await w.call(T.who, 'POST', '/auth/step-up/verify', { intentId: data<{ intentId: string }>(prep2).intentId, method: 'TOTP', code: stepCode }));
      assert.match(o['same TOTP step again']!, /^4/);
      observe('M05', o);
    });

    await t.test('M06 AT-MEJ-11/12: inactividad 60 min y absoluto 12 h; GET no renueva', async () => {
      const f = await group.fixture(), w = await world(f), T = await w.tenant('M06'), o: Record<string, unknown> = {};
      const start = f.now();
      const me1 = await w.call(T.who, 'GET', '/auth/me'), idle1 = Date.parse((me1.body.data as { session: { idleExpiresAt: string } }).session.idleExpiresAt);
      f.clock.value = start + 1000; await w.call(T.who, 'GET', '/auth/me');
      const me2 = await w.call(T.who, 'GET', '/auth/me'); assert.equal(Date.parse((me2.body.data as { session: { idleExpiresAt: string } }).session.idleExpiresAt), idle1, 'GET does not renew');
      o['activity without CSRF'] = (await T.who.c.call('POST', '/api/v1/auth/session/activity', {}, { 'X-CSRF-Token': 'x' })).status;
      o['activity with body'] = st(await w.call(T.who, 'POST', '/auth/session/activity', { now: f.now() + 9e9 }));
      f.clock.value = idle1 - 1; assert.equal((await w.call(T.who, 'GET', '/auth/me')).status, 200);
      const act = await w.call(T.who, 'POST', '/auth/session/activity', {}); const idle2 = Date.parse((act.body.data as { session: { idleExpiresAt: string } }).session.idleExpiresAt);
      assert.equal(idle2, f.now() + 3600000); const absolute = Date.parse((act.body.data as { session: { absoluteExpiresAt: string } }).session.absoluteExpiresAt);
      f.clock.value = idle2; o['at idle deadline'] = (await w.call(T.who, 'GET', '/auth/me')).status; assert.equal(o['at idle deadline'], 401);
      // Absolute: keep acting every 59 min until 12 h.
      const fresh = await w.login(T.who.email); let last = 200; const absStart = f.now();
      for (let k = 0; k < 13 && f.now() + 3540000 < absStart + 43200000; k++) { f.clock.value += 3540000; last = (await w.call({ c: fresh.c }, 'POST', '/auth/session/activity', {})).status; }
      o['last activity before absolute'] = last;
      f.clock.value = absStart + 43200000; o['at absolute'] = (await w.call({ c: fresh.c }, 'POST', '/auth/session/activity', {})).status; assert.equal(o['at absolute'], 401);
      // B (pending) idle: 60 min per AUTH-M04; residual 30-min checks on business routes observed.
      const b = await f.signup(); const cb = await w.h.client(b.issued.token);
      f.clock.value += 31 * 60000; o['B me 31 min'] = (await w.call({ c: cb }, 'GET', '/auth/me')).status;
      o['B organization 31 min'] = st(await w.call({ c: cb }, 'POST', '/organizations', { name: 'x', timezone: 'America/Bogota', currency: 'COP' }, { 'Idempotency-Key': randomUUID() }));
      observe('M06', { ...o, absoluteFromActivity: absolute - start });
    });

    await t.test('M07 AT-MEJ-08/09: primer factor justo a tiempo, RESET con organización y bloqueos', async () => {
      const f = await group.fixture(), w = await world(f), o: Record<string, unknown> = {};
      const a = await f.worker(), who = await w.connect(a);
      const created = await w.call(who, 'POST', '/organizations', { name: 'Org JIT', timezone: 'America/Bogota', currency: 'COP' }, { 'Idempotency-Key': randomUUID() }); assert.equal(created.status, 201, 'org without factor');
      const org = data<{ organization: { id: string } }>(created).organization.id;
      const bank = data<{ id: string }>(await w.call(who, 'POST', w.base(org) + '/financial/accounts', { code: 'B_JIT', name: 'Banco JIT', currency: 'COP', accountClass: 'ASSET', kind: 'BANK' }, { 'Idempotency-Key': randomUUID() })).id;
      const eq = data<{ id: string }>(await w.call(who, 'POST', w.base(org) + '/financial/accounts', { code: 'E_JIT', name: 'Patrimonio JIT', currency: 'COP', accountClass: 'EQUITY', kind: 'GENERAL' }, { 'Idempotency-Key': randomUUID() })).id;
      const jb = w.journalBody([{ accountId: bank, debit: '1.00', credit: '0.00' }, { accountId: eq, debit: '0.00', credit: '1.00' }]);
      o['journal without factor'] = st(await w.call(who, 'POST', w.base(org) + '/financial/journal-entries', jb, { 'Idempotency-Key': randomUUID() }));
      o['A42 without factor'] = st(await w.call(who, 'POST', '/auth/step-up/intents', { purpose: 'FINANCE_JOURNAL_POST', method: 'TOTP', command: { organizationId: org, idempotencyKey: randomUUID(), payload: jb } }));
      assert.equal(o['A42 without factor'], '403 MFA_ENROLLMENT_REQUIRED');
      const ctx = (await f.sessions.find(w.sessionToken(who), 'TENANT'))!;
      o['JIT wrong password'] = await codeOf(f.runtime.totp.enroll(ctx, 'JIT', 'clave equivocada sintética 0000'));
      const e = await f.runtime.totp.enroll((await f.sessions.find(w.sessionToken(who), 'TENANT'))!, 'JIT', password);
      const secret = new URL(e.provisioningUri).searchParams.get('secret')!;
      const before = (await f.identity.identities.findOne({ _id: a.subject._id }))!;
      const done = await f.runtime.totp.confirm((await f.sessions.find(w.sessionToken(who), 'TENANT'))!, e.enrollmentId, await f.totpCode(secret));
      const after = (await f.identity.identities.findOne({ _id: a.subject._id }))!;
      o['state before/after'] = [before.state, after.state]; o['roles after'] = after.roles; o['org kept'] = after.organizationId === org;
      assert.deepEqual(after.roles, before.roles); assert.equal(after.organizationId, before.organizationId);
      o['grant after voluntary enrol'] = done.issued?.context.balanceGrant ?? null;
      // 5-min password window for first factor.
      const b = await f.worker(); const ctxB = b.issued.context;
      const eb = await f.runtime.totp.enroll(ctxB, 'JIT2', password); const sb = new URL(eb.provisioningUri).searchParams.get('secret')!;
      f.clock.value += 300000; o['first factor at 5 min'] = await codeOf(f.runtime.totp.confirm(ctxB, eb.enrollmentId, await f.totpCode(sb)));
      assert.notEqual(o['first factor at 5 min'], 'OK');
      // G-M2: never-factor with organization → RESET → W → first factor → one notification.
      const r = await f.worker(), rw = await w.connect(r);
      const rc = await w.call(rw, 'POST', '/organizations', { name: 'Org RESET', timezone: 'America/Bogota', currency: 'COP' }, { 'Idempotency-Key': randomUUID() }); assert.equal(rc.status, 201);
      const p = await f.sessions.issue('TENANT', 'P', null);
      await f.identity.requestEmail('TENANT', 'r5-reset', 'RESET', r.email, p.context);
      const token = (await f.mail(r.subject._id, 'RESET')).token;
      const pv = await f.identity.reset(p.context, { mode: 'PREVIEW', token }, 'r5-reset') as { warningRequired: boolean };
      await f.identity.reset(p.context, { mode: 'CONFIRM', token, newPassword: 'Nueva frase sintetica revisora MEJ5 31', warningAcknowledged: pv.warningRequired }, 'r5-reset');
      const relog = await f.identity.login('TENANT', 'r5-relog', r.email, 'Nueva frase sintetica revisora MEJ5 31'); o['login after RESET'] = relog.issued.context.kind;
      const er = await f.runtime.totp.enroll(relog.issued.context, 'Tras RESET', 'Nueva frase sintetica revisora MEJ5 31');
      await f.runtime.totp.confirm(relog.issued.context, er.enrollmentId, await f.totpCode(new URL(er.provisioningUri).searchParams.get('secret')!));
      await f.identity.dispatchMail();
      o['FIRST_FACTOR_AFTER_PASSWORD_RESET notifications'] = await f.database.db.collection('synthetic_notifications').countDocuments({ subjectId: r.subject._id, kind: 'FIRST_FACTOR_AFTER_PASSWORD_RESET' });
      assert.equal(o['FIRST_FACTOR_AFTER_PASSWORD_RESET notifications'], 1);
      // Factor loss: had a factor, now zero → no W, no JIT.
      const lost = await f.actor();
      await f.identity.identities.updateOne({ _id: lost.subject._id }, { $set: { factorCount: 0 } });
      await f.sessions.factors.updateMany({ subjectId: lost.subject._id }, { $set: { state: 'REVOKED' } });
      o['factor-loss login'] = await codeOf(f.identity.login('TENANT', 'r5-lost', lost.email, password).then(x => { if (x.issued.context.kind === 'W') throw Error('W issued'); return x; }));
      observe('M07', o);
    });

    await t.test('M08 AT-MEJ-17/18/19: saldo inicial sin código, único, atómico, entre procesos', async () => {
      const f = await group.fixture(), w = await world(f), o: Record<string, unknown> = {};
      // Never-factor Titular: no code and no factor needed.
      const a = await f.worker(), who = await w.connect(a);
      const created = await w.call(who, 'POST', '/organizations', { name: 'Org SI', timezone: 'America/Bogota', currency: 'COP' }, { 'Idempotency-Key': randomUUID() });
      const org = data<{ organization: { id: string } }>(created).organization.id, acc: Record<string, string> = {};
      for (const [code, cls, kind] of [['BANK', 'ASSET', 'BANK'], ['CASH', 'ASSET', 'CASH'], ['GEN', 'ASSET', 'GENERAL']] as const) acc[code] = data<{ id: string }>(await w.call(who, 'POST', w.base(org) + '/financial/accounts', { code: code + '_SI', name: 'Cuenta ' + code, currency: 'COP', accountClass: cls, kind }, { 'Idempotency-Key': randomUUID() })).id;
      const T = { who, org, acc, label: 'SI' } as unknown as Tenant;
      for (const [label, items, extra] of [['GENERAL', [{ accountId: acc['GEN']!, amount: '10.00' }], {}], ['zero', [{ accountId: acc['BANK']!, amount: '0.00' }], {}], ['negative', [{ accountId: acc['BANK']!, amount: '-1.00' }], {}],
        ['duplicate', [{ accountId: acc['BANK']!, amount: '1.00' }, { accountId: acc['BANK']!, amount: '1.00' }], {}], ['future', [{ accountId: acc['BANK']!, amount: '1.00' }], { effectiveDate: '2199-01-01' }], ['foreign account', [{ accountId: randomUUID(), amount: '1.00' }], {}],
        ['extra scope', [{ accountId: acc['BANK']!, amount: '1.00' }], { ownerId: 'x' }], ['100 items', Array.from({ length: 100 }, () => ({ accountId: randomUUID(), amount: '1.00' })), {}]] as const) {
        o['neg ' + label] = st((await w.initial(T, items as unknown as { accountId: string; amount: string }[], randomUUID(), extra as Record<string, unknown>)).r);
        assert.match(String(o['neg ' + label]), /^4/, label);
      }
      assert.equal(await f.database.db.collection('financial_accounts').countDocuments({ organizationId: org }), 3, 'no orphan capital account after rejected loads');
      const ok = await w.initial(T, [{ accountId: acc['BANK']!, amount: '100.00' }, { accountId: acc['CASH']!, amount: '25.50' }]);
      o['positive'] = st(ok.r); assert.equal(ok.r.status, 201);
      const j = data<{ journal: { id: string; lines: { accountId: string; debit: string; credit: string }[]; source: { type: string } }; capitalAccountId: string }>(ok.r);
      const capital = await f.database.db.collection('financial_accounts').findOne({ _id: j.capitalAccountId as never });
      o['capital account'] = { code: capital?.['code'], name: capital?.['name'], cls: capital?.['accountClass'], kind: capital?.['kind'] };
      const totals = ledgerOracle([{ lines: j.journal.lines.map(l => ({ account: l.accountId, debit: l.debit, credit: l.credit })) }]);
      assert.equal(m(totals.get(acc['BANK']!)!), '100.00'); assert.equal(m(totals.get(acc['CASH']!)!), '25.50'); assert.equal(m(totals.get(j.capitalAccountId)!), '-125.50');
      o['source'] = j.journal.source?.type;
      const replay = await w.call(who, 'POST', w.base(org) + '/financial/initial-balances', ok.body, { 'Idempotency-Key': ok.key }); o['replay'] = st(replay);
      assert.equal(replay.status, 200); assert.equal(data<{ journal: { id: string } }>(replay).journal.id, j.journal.id);
      o['replay other payload'] = st(await w.call(who, 'POST', w.base(org) + '/financial/initial-balances', { ...ok.body, description: 'Otro' }, { 'Idempotency-Key': ok.key }));
      o['second load new key'] = st((await w.initial(T, [{ accountId: acc['BANK']!, amount: '1.00' }])).r);
      assert.equal(await f.database.db.collection('financial_journals').countDocuments({ organizationId: org }), 1);
      // After a normal journal, SI is never available (fresh tenant with factor and grant).
      const N = await w.tenant('SI-N'); const g = await w.balanceGrant(N); assert.equal(g.verify?.status, 200); assert.equal((await w.fund(N, '10.00')).r.status, 201);
      o['after first journal'] = st((await w.initial(N, [{ accountId: N.acc['BANK']!, amount: '5.00' }])).r);
      assert.match(String(o['after first journal']), /^409/);
      // Ambiguous homonym capital account → 409 without choosing.
      const H = await w.tenant('SI-H');
      for (let k = 0; k < 2; k++) await w.call(H.who, 'POST', w.base(H.org) + '/financial/accounts', { code: 'CAP' + k, name: 'Capital inicial', currency: 'COP', accountClass: 'EQUITY', kind: 'GENERAL' }, { 'Idempotency-Key': randomUUID() });
      o['homonym capital'] = st((await w.initial(H, [{ accountId: H.acc['BANK']!, amount: '5.00' }])).r);
      // Rollback: audit write fails → nothing persists, retry works.
      const R = await w.tenant('SI-R'), db = f.database.db;
      await db.command({ collMod: 'audit_events', validator: { $expr: { $eq: [1, 0] } }, validationAction: 'error' });
      try { o['with audit failure'] = st((await w.initial(R, [{ accountId: R.acc['BANK']!, amount: '7.00' }])).r); } finally { await db.command({ collMod: 'audit_events', validator: {}, validationAction: 'error' }); }
      o['after rollback'] = { journals: await db.collection('financial_journals').countDocuments({ organizationId: R.org }), accounts: await db.collection('financial_accounts').countDocuments({ organizationId: R.org }) };
      o['retry after rollback'] = st((await w.initial(R, [{ accountId: R.acc['BANK']!, amount: '7.00' }])).r);
      assert.deepEqual(o['after rollback'], { journals: 0, accounts: 7 }); assert.equal(o['retry after rollback'], '201');
      // Two processes: SI in a peer instance vs SI here; and SI vs normal journal.
      const P = await w.tenant('SI-P'), release = group.hold();
      const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.js', import.meta.url))], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      await receipt({ event: 'peer-created', pid: child.pid }); const exited = once(child, 'exit');
      const next = () => new Promise<Record<string, unknown>>((ok2, ko) => { const timer = setTimeout(() => ko(Error('peer timeout')), 30000); child.once('message', v => { clearTimeout(timer); ok2(v as Record<string, unknown>); }); });
      try {
        const ready = next(); child.send({ type: 'initialize', uri: f.config.mongoUri, name: f.database.db.databaseName, folder, now: f.now(), keys: Object.fromEntries(Object.entries(f.keys).filter(([k]) => k !== 'version').map(([k, v]) => [k, (v as Buffer).toString('base64')])) });
        assert.equal((await ready)['type'], 'ready');
        const races: string[] = [];
        for (let k = 0; k < 3; k++) {
          const Q = k === 0 ? P : await w.tenant('SI-P' + k);
          const peerBody = { effectiveDate: w.today(), sourceId: randomUUID(), supportReference: 'PEER', description: 'Peer', items: [{ accountId: Q.acc['BANK']!, amount: '3.00' }] };
          const pending = next(); child.send({ type: 'execute', token: w.sessionToken(Q.who), org: Q.org, body: peerBody, key: randomUUID() });
          const [mine, peer] = await Promise.all([w.initial(Q, [{ accountId: Q.acc['CASH']!, amount: '4.00' }]), pending]);
          races.push(`${mine.r.status}/${String(peer['status'])}`);
          assert.equal([mine.r.status, Number(peer['status'])].filter(s => s === 201).length, 1, 'exactly one initialization across processes');
          assert.equal(await f.database.db.collection('financial_journals').countDocuments({ organizationId: Q.org }), 1);
        }
        o['cross-process SI races'] = races;
        const S = await w.tenant('SI-J'); const gs = await w.balanceGrant(S); assert.equal(gs.verify?.status, 200);
        const [si, jn] = await Promise.all([w.initial(S, [{ accountId: S.acc['CASH']!, amount: '4.00' }]), w.fund(S, '9.00')]);
        const js = await f.database.db.collection('financial_journals').find({ organizationId: S.org }).sort({ _id: 1 }).toArray();
        o['SI vs journal'] = `${si.r.status}/${jn.r.status}`;
        if (si.r.status === 201) { const siJournal = data<{ journal: { id: string } }>(si.r).journal.id; const siDoc = js.find(x => String(x['_id']) === siJournal)!; for (const x of js) if (x !== siDoc) assert.ok(String(x['recordedAt'] ?? x['postedAt'] ?? '') >= String(siDoc['recordedAt'] ?? siDoc['postedAt'] ?? ''), 'SI never after a journal'); }
        const stopped = exited; child.send({ type: 'stop' }); await Promise.race([stopped, new Promise(r => setTimeout(r, 10000))]);
      } finally { if (child.exitCode === null && !child.killed) { child.kill(); await exited; } await receipt({ event: 'peer-stopped', pid: child.pid }); release(); }
      observe('M08', o);
    });

    await t.test('M09 AT-MEJ-32/33: dinero S2 y S5 contra oráculo propio, replay sin doble efecto', async () => {
      const f = await group.fixture(), w = await world(f), o: Record<string, unknown> = {};
      f.clock.value = Date.parse('2026-10-24T12:00:00-05:00');
      const T = await w.tenant('M09'); const g = await w.balanceGrant(T); assert.equal(g.verify?.status, 200);
      const funding = await w.fund(T, '5000000.00'); assert.equal(funding.r.status, 201);
      const tr = await w.call(T.who, 'POST', w.base(T.org) + '/financial/transfers', { currency: 'COP', effectiveDate: w.today(), sourceId: randomUUID(), supportReference: 'TR', description: 'Transferencia', fromAccountId: T.acc['BANK'], toAccountId: T.acc['CASH'], amount: '250000.00' }, { 'Idempotency-Key': randomUUID() });
      assert.equal(tr.status, 201);
      const extra = await w.fund(T, '1000.00'), xid = data<{ id: string }>(extra.r).id;
      const rv = await w.call(T.who, 'POST', w.base(T.org) + `/financial/journal-entries/${xid}/reversals`, { effectiveDate: w.today(), sourceId: randomUUID(), supportReference: 'RV', reason: 'Reversa' }, { 'Idempotency-Key': randomUUID(), 'If-Match': tag(await w.get(T, '/financial/journal-entries/' + xid)) });
      assert.equal(rv.status, 201);
      const s2 = ledgerOracle([{ lines: [{ account: 'BANK', debit: '5000000.00', credit: '0.00' }, { account: 'E', debit: '0.00', credit: '5000000.00' }] }, { lines: [{ account: 'CASH', debit: '250000.00', credit: '0.00' }, { account: 'BANK', debit: '0.00', credit: '250000.00' }] },
        { lines: [{ account: 'BANK', debit: '1000.00', credit: '0.00' }, { account: 'E', debit: '0.00', credit: '1000.00' }] }, { lines: mirror([{ account: 'BANK', debit: '1000.00', credit: '0.00' }, { account: 'E', debit: '0.00', credit: '1000.00' }]) }]);
      const l1 = await w.ledger(T);
      for (const k of ['BANK', 'CASH', 'E'] as const) assert.equal(m(l1.get(k)!), m(s2.get(k)!), 'S2 ' + k);
      // S5 with own oracle.
      const b = await w.borrower(T, 'R5_S5'); const L = await w.loan(T, b.id); assert.equal(L.confirmed?.status, 200, 'confirm terms without code');
      const before = await f.database.db.collection('financial_journals').countDocuments({ organizationId: T.org });
      const dis = await w.operate(T, await w.disburseRequest(T, L.id)); o['disburse'] = st(dis.r); assert.equal(dis.r.status, 201);
      const replay = await w.call(T.who, 'POST', w.base(T.org) + '/loan-operations/disbursements', dis.payload, { 'Idempotency-Key': dis.key!, 'If-Match': dis.book! }); o['disburse replay'] = st(replay);
      assert.equal(await f.database.db.collection('financial_journals').countDocuments({ organizationId: T.org }), before + 1, 'replay does not double money');
      f.clock.value = Date.parse('2026-10-31T12:00:00-05:00');
      const login = await w.login(T.who.email); T.who.c = login.c; const g2 = await w.balanceGrant(T); assert.equal(g2.verify?.status, 200);
      const acr = await w.operate(T, await w.accrueRequest(T, L.id)); o['accrue'] = st(acr.r);
      const rec = await w.operate(T, await w.receiptRequest(T, b.id, '700000.00', [{ loanId: L.id, amount: '500000.00' }], 'CREDIT')); o['receipt'] = st(rec.r);
      const cre = await w.operate(T, await w.creditRequest(T, b.id, '50000.00', [{ loanId: L.id, amount: '50000.00' }])); o['credit apply'] = st(cre.r);
      const expected = s5Scenario(w.termsOf(T, b.id) as never, { funding: c('4750000.00'), receipt: c('700000.00'), receiptBudget: c('500000.00'), creditApply: c('50000.00'), disburseDay: '2026-10-24', dueDay: '2026-10-31' });
      const position = data<Record<string, unknown>>(await w.get(T, '/loan-operations/positions/' + L.id));
      const credit = data<Record<string, unknown>>(await w.get(T, '/loan-operations/credits/' + b.id));
      const led = await w.ledger(T);
      o['oracle'] = { final: expected.final, creditFinal: expected.creditFinal };
      o['observed'] = { principalOutstanding: position['principalOutstanding'], accruedOutstandingInterest: position['accruedOutstandingInterest'], collectedInterestTotal: position['collectedInterestTotal'], credit: credit['balance'] ?? credit['available'] ?? credit, P: m(led.get('P')!), I: m(led.get('I')!), Y: m(led.get('Y')!), C: m(led.get('C')!) };
      assert.equal(position['principalOutstanding'], expected.final.principalOutstanding, 'principal vs oracle');
      assert.equal(m(led.get('P')!), expected.final.principalOutstanding, 'P ledger vs oracle');
      assert.equal(m(-led.get('C')!), expected.creditFinal, 'credit ledger vs oracle');
      assert.equal(m(-led.get('Y')!), expected.final.accruedInterestTotal, 'interest income vs oracle');
      observe('M09', { ...o, oracleSources: ORACLE_SOURCES });
    });

    await t.test('M11 AT-MEJ-20/AUTH-M03: A42 autoriza rol antes de reservar intento o pedir factor', async () => {
      const f = await group.fixture(), w = await world(f), T = await w.tenant('M11'), o: Record<string, string> = {};
      const B = await f.worker(), bw = await w.connect(B), invite = { email: B.email, roleIds: ['O'] };
      await w.stepUp(T.who, 'MEMBER_INVITE', invite, T.org); await w.call(T.who, 'POST', '/organization/invitations', invite); await f.identity.dispatchMail();
      const inv = (await f.runtime.organizations.invitations.findOne({ email: B.email }))!;
      const note = [...f.messages.notificationInbox.values()].find(n => n.kind === 'INVITATION' && n.subjectId === inv._id)!;
      assert.equal((await w.call(bw, 'POST', '/auth/invitations/accept', { mode: 'CONFIRM', token: note.payload['token'] })).status, 200);
      const journal = w.journalBody([{ accountId: T.acc['BANK']!, debit: '1.00', credit: '0.00' }, { accountId: T.acc['E']!, debit: '0.00', credit: '1.00' }]);
      const asks = async (label: string) => {
        o[label + ' MEMBER_INVITE'] = st(await w.call(bw, 'POST', '/auth/step-up/intents', { purpose: 'MEMBER_INVITE', method: 'TOTP', command: { email: 'otro-' + randomUUID() + '@example.test', roleIds: ['O'] }, resourceId: T.org }));
        o[label + ' FINANCE_JOURNAL_POST'] = st(await w.call(bw, 'POST', '/auth/step-up/intents', { purpose: 'FINANCE_JOURNAL_POST', method: 'TOTP', command: { organizationId: T.org, idempotencyKey: randomUUID(), payload: journal } }));
        o[label + ' MEMBER_ROLE_CHANGE (self→A)'] = st(await w.call(bw, 'POST', '/auth/step-up/intents', { purpose: 'MEMBER_ROLE_CHANGE', method: 'TOTP', command: { roleIds: ['A'] }, resourceId: B.subject._id }));
      };
      await asks('O never-factor');
      // Same Operator after registering a factor voluntarily: an intent must still not be reserved for unauthorised actions.
      const ctx = (await f.sessions.find(w.sessionToken(bw), 'TENANT'))!;
      const e = await f.runtime.totp.enroll(ctx, 'Operador', password), secret = new URL(e.provisioningUri).searchParams.get('secret')!;
      const done = await f.runtime.totp.confirm(ctx, e.enrollmentId, await f.totpCode(secret)); bw.c.cookies.set('__Host-caudelyx-session', done.issued!.token);
      await asks('O with factor');
      const reserved = await f.sessions.contexts.countDocuments({ subjectId: B.subject._id, revoked: false, 'reauth.intentId': { $exists: true } });
      o['intents reserved for O'] = String(reserved);
      observe('M11', o);
      for (const k of Object.keys(o).filter(k => k.startsWith('O with factor'))) assert.match(o[k]!, /^4/, k + ' must not succeed');
    });

    await t.test('M10 AT-MEJ-19/21: restore conserva saldo inicial y no revive W ni grants', async () => {
      const f = await group.fixture(), w = await world(f), o: Record<string, unknown> = {};
      const T = await w.tenant('M10');
      assert.equal((await w.initial(T, [{ accountId: T.acc['BANK']!, amount: '100.00' }])).r.status, 201);
      const g = await w.balanceGrant(T); assert.equal(g.verify?.status, 200);
      const wToken = w.sessionToken(T.who);
      await f.restore.flush(); const snapshot = await f.restore.snapshot();
      await f.restore.beginRestore(snapshot); o['open during restore'] = f.restore.isOpen();
      await f.restore.reconcile({ approved: true, reviewId: 'mej5-complete' }); o['open after reconcile'] = f.restore.isOpen();
      o['old W after restore'] = (await f.sessions.find(wToken, 'TENANT'))?.kind ?? null;
      const re = await w.login(T.who.email); T.who.c = re.c; o['login after restore'] = re.r.status;
      o['SI after restore'] = st((await w.initial(T, [{ accountId: T.acc['BANK']!, amount: '1.00' }])).r);
      assert.match(String(o['SI after restore']), /^409/, 'restore must not reopen the initial-balance exception');
      o['grant after restore'] = (await w.call(T.who, 'GET', '/auth/me')).body.data?.['session'];
      // Incomplete evidence keeps the realm closed.
      await f.database.client.db(f.database.db.databaseName + '_external_security').collection<{ _id: number }>('events').deleteOne({ _id: 1 });
      await f.restore.beginRestore(snapshot); o['reconcile with gap'] = await codeOf(f.restore.reconcile({ approved: true, reviewId: 'mej5-gap' })); o['open with gap'] = f.restore.isOpen();
      assert.equal(o['open with gap'], false);
      observe('M10', o);
    });
  } finally {
    await receipt({ event: 'observations', file: 'review', observations: Object.fromEntries(observations) });
    console.log('MEJ5_OBSERVATIONS ' + JSON.stringify(Object.fromEntries(observations), (_k, v) => typeof v === 'bigint' ? v.toString() : v));
    await group.dispose();
  }
});
