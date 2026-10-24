/* eslint-disable security/detect-object-injection -- Keys are this test's own fixed labels/array indexes, never request input. */
// S04-P05 independent review (Claude) of S04-P04-v1-INTEGRADO: borrowers, quotes and versioned loan terms over the REAL
// HTTPS app (cookie, CSRF, A32 password + A27 TOTP for every R) on ONE own group in installed Mongo 27017 (p05-profile.ts),
// reused sequentially by every scenario. Setup (org, accounts, a POSTED opening) uses in-process commands only before the
// HTTP client exists; every reviewed operation goes through HTTP. Assertions and expected values are independent
// (./oracle.ts for money). Evidence lines carry statuses, codes and synthetic amounts only; no token, code or cookie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { BSON, type Document } from 'mongodb';
import { generate } from 'otplib';
import { reviewProfile, receipt, password, assertOwnUri, names, type ReviewFixture } from './p05-profile.js';
import { ApiClient, type ApiBody } from '../../helpers/client.js';
import { RestoreController } from '../../../src/shared/restore.js';
import { lendingDigest } from '../../../src/modules/lending/integrity.js';
import { purposes as openingPurposes } from '../../../src/modules/opening/contract.js';
import { oracle, type OracleTerms } from './oracle.js';

type Group = Awaited<ReturnType<typeof reviewProfile>>;
type Actor = Awaited<ReturnType<ReviewFixture['actor']>>;
type Reply = { status: number; body: ApiBody; headers: import('node:http').IncomingHttpHeaders };
type Data = Record<string, unknown> & { id: string; version: number; fingerprint: string; status: string; termsVersion: number; profileVersion: number; expiresAt: string };
const evidence = (name: string, data: Record<string, unknown>) => console.log(JSON.stringify({ evidence: name, ...data }));
const st = (r: Reply) => `${r.status}${r.body.error?.code ? ' ' + r.body.error.code : ''}`;
const data = (r: Reply) => r.body.data as Data;
const tag = (r: Reply) => String(r.headers['etag']);
const OPS = new Map<string, { m: string; path: (id?: string) => string; purpose?: string; resource?: boolean }>([
  ['publishBorrowerSchema', { m: 'POST', path: () => '/borrower-field-schemas', purpose: 'BORROWER_SCHEMA_PUBLISH' }],
  ['createBorrower', { m: 'POST', path: () => '/borrowers', purpose: 'BORROWER_CREATE' }],
  ['replaceBorrower', { m: 'PUT', path: id => `/borrowers/${id}`, purpose: 'BORROWER_REPLACE', resource: true }],
  ['deactivateBorrower', { m: 'POST', path: id => `/borrowers/${id}/deactivation`, purpose: 'BORROWER_DEACTIVATE', resource: true }],
  ['reactivateBorrower', { m: 'POST', path: id => `/borrowers/${id}/reactivation`, purpose: 'BORROWER_REACTIVATE', resource: true }],
  ['createLoanQuote', { m: 'POST', path: () => '/loan-quotes' }],
  ['createLoanDraft', { m: 'POST', path: () => '/loans', purpose: 'LOAN_DRAFT_CREATE' }],
  ['replaceLoanTerms', { m: 'PUT', path: id => `/loans/${id}/terms`, purpose: 'LOAN_TERMS_REPLACE', resource: true }],
  ['confirmLoanTerms', { m: 'POST', path: id => `/loans/${id}/confirmation`, purpose: 'LOAN_TERMS_CONFIRM', resource: true }],
  ['cancelLoan', { m: 'POST', path: id => `/loans/${id}/cancellation`, purpose: 'LOAN_CANCEL', resource: true }],
]);
const LEDGER = ['financial_books', 'financial_journals', 'financial_idempotency', 'financial_evidence_head', 'opening_files', 'opening_references', 'opening_validations', 'opening_idempotency'];
const LENDING = ['lending_borrowers', 'lending_borrower_versions', 'lending_field_schemas', 'lending_quotes', 'lending_loans', 'lending_loan_versions', 'lending_actions', 'lending_idempotency'];

async function setup(group: Group, o: { opening?: boolean } = {}) {
  const f = await group.fixture();
  const base = (org: string) => `/api/v1/organizations/${org}`;
  const tenant = async (label: string) => {
    const a = await f.actor();
    const payload = { name: `Organización sintética P05 ${label}`, currency: 'COP', timezone: 'America/Bogota' };
    await f.proof(a, 'ORGANIZATION_CREATE', payload);
    const org = (await f.runtime.organizations.create(a.issued.context, payload, randomUUID())).data.organization.id as string;
    const acc: Record<string, string> = {};
    for (const [code, name, accountClass, kind] of [['CASH_P05', 'Caja sintética P05', 'ASSET', 'CASH'], ['BANK_P05', 'Banco sintético P05', 'ASSET', 'BANK'], ['GEN_P05', 'Activo general P05', 'ASSET', 'GENERAL'], ['EQ_P05', 'Patrimonio P05', 'EQUITY', 'GENERAL'], ['PRIN_P05', 'Cartera histórica P05', 'ASSET', 'GENERAL']] as const) {
      const ap = { code, name, currency: 'COP', accountClass, kind }, key = randomUUID();
      await f.proof(a, 'FINANCE_ACCOUNT_CREATE', { organizationId: org, idempotencyKey: key, payload: ap });
      acc[code] = ((await f.runtime.finance.mutate(a.issued.context, 'createAccount', org, ap, key)).data as { id: string }).id;
    }
    let opening: { id: string; borrowerRef: string; loanRef: string } | undefined;
    if (o.opening) { // S3 POSTED opening (setup, in-process, before any HTTP client): BORROWER + HISTORICAL_LOAN 200.
      const C = '2020-01-31', sup = { id: randomUUID(), reference: 'P05-S4-SOPORTE', asOfDate: C, declaration: 'OWNER_CHECKED' }, br = randomUUID(), lr = randomUUID();
      const snapshot = { cutoffDate: C, supports: [sup], references: [
        { id: br, type: 'BORROWER', externalReference: 'P05-HIST-B1', displayName: 'Persona histórica sintética', supportIds: [sup.id] },
        { id: lr, type: 'HISTORICAL_LOAN', externalReference: 'P05-HIST-L1', borrowerId: br, originationDate: '2019-06-30', fundingReference: 'Aporte declarado', supportIds: [sup.id] }],
        components: [{ id: randomUUID(), category: 'CASH', accountId: acc['CASH_P05']!, amount: '100.00', supportIds: [sup.id] },
          { id: randomUUID(), category: 'PRINCIPAL_RECEIVABLE', accountId: acc['PRIN_P05']!, amount: '200.00', referenceId: lr, supportIds: [sup.id] },
          { id: randomUUID(), category: 'EQUITY', accountId: acc['EQ_P05']!, amount: '300.00', equityKind: 'CONTRIBUTED', supportIds: [sup.id] }],
        historicalInterest: [], informationalHistory: [] };
      let file: { id: string; version: number; validation?: { id: string; fingerprint: string } } | undefined;
      const run = async (op: string, payload: Record<string, unknown>) => {
        const k = randomUUID(), id = op === 'createOpening' ? undefined : file!.id, expected = id ? `"${id}:${file!.version}"` : undefined;
        await f.proof(a, openingPurposes.get(op)!, { organizationId: org, idempotencyKey: k, payload, ...(expected ? { expectedETag: expected } : {}) }, id);
        const r = await f.runtime.opening.mutate(a.issued.context, op, org, payload, k, id, expected);
        file = (op === 'validateOpening' ? (r.data as { opening: typeof file }).opening : r.data) as typeof file;
      };
      await run('createOpening', { snapshot }); await run('validateOpening', { policyVersion: 'S03-OPENING-0.1' });
      const bind = () => ({ validationId: file!.validation!.id, validationFingerprint: file!.validation!.fingerprint });
      await run('approveOpening', bind()); await run('commitOpening', bind());
      opening = { id: file!.id, borrowerRef: br, loanRef: lr };
    }
    return { a, org, acc, opening, c: undefined as unknown as ApiClient, label };
  };
  type T = Awaited<ReturnType<typeof tenant>>;
  const connect = async (t: T) => { t.c = await f.client(t.a); return t; };
  /** R over HTTP: A32 (password + exact intent) then A27 TOTP; returns the A27 status (or the failing A32 status). */
  const r = async (t: T, purpose: string, command: Record<string, unknown>, resourceId?: string | null) => {
    const a32 = await t.c.call('POST', '/api/v1/auth/reauthenticate', { password, purpose, command, ...(resourceId ? { resourceId } : {}) });
    if (a32.status !== 200) return a32.status;
    f.clock.value += 30000;
    const a27 = await t.c.call('POST', '/api/v1/auth/mfa/challenges/verify', { method: 'TOTP', purpose, code: await generate({ secret: t.a.secret, epoch: Math.floor(f.now() / 1000) }), ...(resourceId ? { resourceId } : {}) });
    await t.c.refreshCsrf(); return a27.status;
  };
  type Opt = { id?: string; etag?: string; key?: string; skipR?: boolean; onlyR?: boolean; rPurpose?: string; rPayload?: unknown; rResource?: string | null; rEtag?: string; headers?: Record<string, string>; org?: string };
  const cmd = async (t: T, op: string, payload: unknown, o: Opt = {}): Promise<Reply & { key: string; r?: number | undefined }> => {
    const spec = OPS.get(op)!, key = o.key ?? randomUUID(), org = o.org ?? t.org;
    let rs: number | undefined;
    if (spec.purpose && !o.skipR) {
      const etag = o.rEtag ?? o.etag;
      rs = await r(t, o.rPurpose ?? spec.purpose, { organizationId: org, idempotencyKey: key, payload: o.rPayload ?? payload, ...(etag ? { expectedETag: etag } : {}) }, o.rResource !== undefined ? o.rResource : spec.resource ? o.id : null);
      if (rs !== 200) return { status: -rs, body: {}, headers: {}, key, r: rs };
    }
    if (o.onlyR) return { status: 0, body: {}, headers: {}, key, r: rs };
    const res = await t.c.call(spec.m, base(org) + spec.path(o.id), payload, { 'Idempotency-Key': key, ...(o.etag ? { 'If-Match': o.etag } : {}), ...(o.headers ?? {}) });
    return { ...res, key, r: rs };
  };
  const get = async (t: T, path: string, client?: ApiClient) => await (client ?? t.c).call('GET', base(t.org) + path);
  const terms = (t: T, borrowerId: string, d: Record<string, unknown> = {}) => ({ borrowerId, plannedFundingAccountId: t.acc['CASH_P05']!, principal: '1000.00', effectiveDate: '2024-01-31', firstDueDate: '2024-02-29', installmentCount: 3,
    method: 'CONSTANT_PRINCIPAL', frequency: 'MONTH', rate: { type: 'EFFECTIVE', unit: 'MONTH', value: '0.010000000000' }, calendarConvention: 'PERIODIC_FIXED', holidayAdjustment: 'NO_SHIFT',
    policyVersion: 'S04-LOCAL-CO-0.1', jurisdiction: 'CO', usage: 'LOCAL_SYNTHETIC', ...d });
  const profile = (displayName: string, schemaVersion = 1, extra: Record<string, unknown> = {}) => ({ displayName, schemaVersion, extras: {}, ...extra });
  const borrower = async (t: T, code: string, p: Record<string, unknown> = profile('Persona sintética ' + code)) => await cmd(t, 'createBorrower', { borrowerCode: code, profile: p });
  const quote = async (t: T, borrowerId: string, d: Record<string, unknown> = {}) => await cmd(t, 'createLoanQuote', { terms: terms(t, borrowerId, d) });
  const draft = async (t: T, q: Data, extra: Record<string, unknown> = {}) => await cmd(t, 'createLoanDraft', { quoteId: q.id, quoteFingerprint: q.fingerprint, ...extra });
  const hashOf = async (cols: string[]) => { const h = createHash('sha256'); for (const n of cols) { h.update(n); h.update(BSON.EJSON.stringify(await f.database.db.collection(n).find().sort({ _id: 1 }).toArray(), { relaxed: false })); } return h.digest('hex'); };
  const counts = async (cols: string[]) => Object.fromEntries(await Promise.all(cols.map(async n => [n, await f.database.db.collection(n).countDocuments()] as const)));
  /** Independent second session (own context) for the same actor: password + TOTP login. */
  const login = async (a: Actor): Promise<Actor> => {
    const first = await f.identity.login('TENANT', randomUUID(), a.email, password); f.clock.value += 30000;
    return { ...a, issued: (await f.runtime.totp.authenticate(first.issued.context, await generate({ secret: a.secret, epoch: Math.floor(f.now() / 1000) }), 'LOGIN', null)).issued };
  };
  return { f, base, tenant, connect, r, cmd, get, terms, profile, borrower, quote, draft, hashOf, counts, login };
}

test('P05-S4 backend review on one own group', { timeout: 3600000 }, async t => {
  const group = await reviewProfile();
  let interrupted = false;
  const signal = () => { interrupted = true; void group.dispose('cancelled-by-signal').finally(() => process.exit(130)); };
  process.once('SIGINT', signal); process.once('SIGTERM', signal);
  try {
    await t.test('P05-S4-01 borrowers, duplicates, homonyms, versions, catalog evolution and extras (AT01/14)', async () => {
      const h = await setup(group), A = await h.connect(await h.tenant('A')), B = await h.connect(await h.tenant('B')), o: Record<string, unknown> = {};
      const cur = await h.get(A, '/borrower-field-schemas/current');
      o['GET current schema'] = { status: cur.status, schemaVersion: data(cur)['schemaVersion'], etag: tag(cur) === `"${A.org}:1"`, writes: await h.f.database.db.collection('lending_field_schemas').countDocuments() };
      assert.equal(cur.status, 200); assert.equal(data(cur)['schemaVersion'], 1); assert.equal(o['GET current schema'] && (o['GET current schema'] as { writes: number }).writes, 0);
      const min = await h.borrower(A, 'P05_MIN', h.profile('Persona mínima'));
      const replay = await A.c.call('POST', `${h.base(A.org)}/borrowers`, { borrowerCode: 'P05_MIN', profile: h.profile('Persona mínima') }, { 'Idempotency-Key': min.key });
      const replayR = await h.cmd(A, 'createBorrower', { borrowerCode: 'P05_MIN', profile: h.profile('Persona mínima') }, { key: min.key });
      const conflict = await h.cmd(A, 'createBorrower', { borrowerCode: 'P05_OTHER', profile: h.profile('Otra') }, { key: min.key });
      o['create minimal'] = { create: st(min), noDocumentNoContact: !('document' in (data(min)['profile'] as object)), replayWithoutNewR: st(replay), replayWithNewR: st(replayR), sameBody: JSON.stringify(data(replayR)) === JSON.stringify(data(min)), sameKeyOtherPayload: st(conflict) };
      assert.equal(min.status, 201); assert.equal(replayR.status, 200); assert.equal(conflict.status, 409);
      const lower = await h.borrower(A, 'p05_lower');
      o['lowercase code'] = st(lower);
      const dup = await h.borrower(A, 'P05_MIN'); o['duplicate code'] = st(dup); assert.equal(st(dup), '409 BORROWER_CODE_CONFLICT');
      const deact = await h.cmd(A, 'deactivateBorrower', { reason: 'Prueba de duplicado inactivo' }, { id: min.body.data!['id'] as string, etag: tag(min) });
      const dupInactive = await h.borrower(A, 'P05_MIN');
      const deactAgain = await h.cmd(A, 'deactivateBorrower', { reason: 'Otra vez' }, { id: data(min).id, etag: tag(deact) });
      const react = await h.cmd(A, 'reactivateBorrower', { reason: 'Reactivación sintética' }, { id: data(min).id, etag: tag(deact) });
      o['state'] = { deactivate: st(deact), versionAfter: data(deact).version, profileVersionAfter: data(deact).profileVersion, duplicateWhileInactive: st(dupInactive), deactivateTwice: st(deactAgain), reactivate: st(react), versionAfterReactivate: data(react).version };
      assert.equal(st(dupInactive), '409 BORROWER_CODE_CONFLICT'); assert.equal(data(deact).profileVersion, 1); assert.equal(data(deact).version, 2); assert.equal(st(deactAgain), '409 STATE_CONFLICT'); assert.equal(data(react).version, 3);
      // Documents: unique per org by type+normalized number; other type/other org allowed (no shared identity).
      const d1 = await h.borrower(A, 'P05_DOC1', h.profile('Documento uno', 1, { document: { type: 'CC', number: '0012-345a' } }));
      const d2 = await h.borrower(A, 'P05_DOC2', h.profile('Documento dos', 1, { document: { type: 'CC', number: ' 0012-345A ' } }));
      const d3 = await h.borrower(A, 'P05_DOC3', h.profile('Documento tres', 1, { document: { type: 'NIT', number: '0012-345A' } }));
      const dB = await h.borrower(B, 'P05_DOC1', h.profile('Documento uno', 1, { document: { type: 'CC', number: '0012-345A' } }));
      o['documents'] = { first: st(d1), storedNumber: (data(d1)['profile'] as { document: { number: string } }).document.number, sameNormalized: st(d2), otherType: st(d3), otherOrgSameCodeAndDocument: st(dB) };
      assert.equal(st(d2), '409 BORROWER_DOCUMENT_CONFLICT'); assert.equal(d3.status, 201); assert.equal(dB.status, 201);
      // Homonyms: warning only, own org only, max 10 candidates.
      const names10: Reply[] = [];
      for (let k = 0; k < 12; k++) names10.push(await h.borrower(A, `P05_HOM${k}`, h.profile(k % 2 ? 'María  José Pérez' : 'maría josé pérez')));
      await h.borrower(B, 'P05_HOMB', h.profile('María José Pérez'));
      const lastHom = data(names10.at(-1)!), candB = data(await h.get(B, '/borrowers/' + data(names10[0]!).id));
      const bOwn = data(await h.borrower(B, 'P05_HOMB2', h.profile('MARÍA JOSÉ PÉREZ')));
      o['homonyms'] = { allCreated: names10.every(r => r.status === 201), possibleDuplicate: lastHom['possibleDuplicate'], candidates: (lastHom['duplicateCandidates'] as unknown[]).length, crossTenantRead: candB === undefined ? 'no data' : 'LEAK',
        otherOrgCandidatesOnlyOwn: (bOwn['duplicateCandidates'] as { borrowerCode: string }[]).map(c => c.borrowerCode) };
      assert.equal(lastHom['possibleDuplicate'], true); assert.equal((lastHom['duplicateCandidates'] as unknown[]).length, 10);
      assert.deepEqual((bOwn['duplicateCandidates'] as { borrowerCode: string }[]).map(c => c.borrowerCode), ['P05_HOMB']);
      // PUT keeps history; ETag 428/412.
      const id = data(d1).id, v1 = tag(d1);
      const noEtag = await h.cmd(A, 'replaceBorrower', { profile: h.profile('Documento uno editado', 1, { document: { type: 'CC', number: '0012-345A' } }), changeReason: 'Corrección' }, { id, rEtag: v1 }); // valid R bound to v1, then no If-Match header
      const put = await h.cmd(A, 'replaceBorrower', { profile: h.profile('Documento uno editado', 1, { document: { type: 'CC', number: '0012-345A' } }), changeReason: 'Corrección' }, { id, etag: v1 });
      const stale = await h.cmd(A, 'replaceBorrower', { profile: h.profile('Otra edición'), changeReason: 'Stale' }, { id, etag: v1 });
      const versions = data(await h.get(A, `/borrowers/${id}/versions`)) as unknown as { items: { profileVersion: number; profile: { displayName: string } }[] };
      const version1 = data(await h.get(A, `/borrowers/${id}/versions/1`)) as unknown as { profile: { displayName: string } };
      o['replace/history'] = { noIfMatch: st(noEtag), put: st(put), profileVersion: data(put).profileVersion, staleEtag: st(stale), history: versions.items.map(v => `${v.profileVersion}:${v.profile.displayName}`), v1Name: version1.profile.displayName };
      assert.equal(noEtag.status, 428); assert.equal(stale.status, 412); assert.equal(data(put).profileVersion, 2); assert.equal(version1.profile.displayName, 'Documento uno');
      // Catalog: virtual v1 -> v2 with 4 types; typed extras; evolution conflicts; deprecation.
      const fields = [{ key: 'zona', label: 'Zona', type: 'TEXT', deprecated: false }, { key: 'fecha_visita', label: 'Fecha de visita', type: 'DATE', deprecated: false }, { key: 'activo', label: 'Activo', type: 'BOOLEAN', deprecated: false }, { key: 'segmento', label: 'Segmento', type: 'ENUM', deprecated: false, options: [{ code: 'A', label: 'Segmento A' }, { code: 'B', label: 'Segmento B' }] }];
      const proto = await h.cmd(A, 'publishBorrowerSchema', { fields: [{ key: '__proto__', label: 'x', type: 'TEXT', deprecated: false }], changeReason: 'Clave peligrosa' }, { etag: `"${A.org}:1"` });
      const pub = await h.cmd(A, 'publishBorrowerSchema', { fields, changeReason: 'Catálogo sintético P05' }, { etag: `"${A.org}:1"` });
      const pubStale = await h.cmd(A, 'publishBorrowerSchema', { fields, changeReason: 'Repetido' }, { etag: `"${A.org}:1"` });
      const extrasOk = await h.borrower(A, 'P05_EXTRA', h.profile('Con extras', 2, { extras: { zona: 'Norte', fecha_visita: '2024-02-29', activo: true, segmento: 'A' } }));
      const bad = async (code: string, extras: Record<string, unknown>, sv = 2) => st(await h.borrower(A, code, h.profile('Extra inválido', sv, { extras })));
      o['extras'] = { proto: st(proto), publish: st(pub), version: data(pub)['schemaVersion'], publishStaleEtag: st(pubStale), valid: st(extrasOk),
        dateNotLeap: await bad('P05_X1', { fecha_visita: '2023-02-29' }), booleanAsText: await bad('P05_X2', { activo: 'true' }), enumUnknown: await bad('P05_X3', { segmento: 'C' }),
        unknownKey: await bad('P05_X4', { color: 'rojo' }), staleSchemaVersion: await bad('P05_X5', {}, 1), numberValue: await bad('P05_X6', { zona: 5 }) };
      assert.equal(Math.abs(proto.status), 422); assert.equal(pub.status, 200); assert.equal(pubStale.status, 412); assert.equal(extrasOk.status, 201);
      const evo = async (label: string, f2: unknown[]) => st(await h.cmd(A, 'publishBorrowerSchema', { fields: f2, changeReason: label }, { etag: `"${A.org}:2"` }));
      o['evolution'] = {
        changeType: await evo('cambia tipo', [{ ...fields[0], type: 'DATE' }, ...fields.slice(1)]),
        removeEnumOption: await evo('quita opción', [...fields.slice(0, 3), { ...fields[3], options: [{ code: 'A', label: 'Segmento A' }] }]),
        dropField: await evo('retira campo', fields.slice(1)),
        reuseKeyTwice: await evo('clave repetida', [...fields, { key: 'zona', label: 'Zona 2', type: 'TEXT', deprecated: false }]),
        deprecateDate: await evo('depreca fecha', [fields[0], { ...fields[1], deprecated: true }, fields[2], fields[3]]),
      };
      assert.equal(o['evolution'] && (o['evolution'] as Record<string, string>)['deprecateDate'], '200');
      for (const k of ['changeType', 'removeEnumOption', 'dropField', 'reuseKeyTwice']) assert.equal((o['evolution'] as Record<string, string>)[k], '409 SCHEMA_EVOLUTION_CONFLICT', k);
      const deprecatedValue = await h.borrower(A, 'P05_DEP', h.profile('Con fecha deprecada', 3, { extras: { fecha_visita: '2024-03-01' } }));
      const oldStill = data(await h.get(A, `/borrowers/${data(extrasOk).id}/versions/1`)) as unknown as { profile: { extras: Record<string, unknown>; schemaVersion: number } };
      o['deprecation'] = { newValueForDeprecated: st(deprecatedValue), historicProfileKeepsValue: oldStill.profile.extras['fecha_visita'], historicSchemaVersion: oldStill.profile.schemaVersion };
      assert.equal(deprecatedValue.status, 422); assert.equal(oldStill.profile.extras['fecha_visita'], '2024-02-29');
      // Body size: the S1 strict JSON parser limit vs the S4 64 KiB contract, with contract-valid catalogs on B (fresh v1).
      const catalog = (labelChar: string) => ({ fields: Array.from({ length: 10 }, (_, k) => ({ key: ('campo' + k).padEnd(32, 'x'), label: labelChar.repeat(80), type: 'ENUM', deprecated: false,
        options: Array.from({ length: 10 }, (_, j) => ({ code: `OPCION_${k}_${j}`.padEnd(40, 'X'), label: labelChar.repeat(80) })) })), changeReason: 'R'.repeat(240) });
      const sizes: Record<string, unknown> = {};
      for (const [label, ch] of [['ASCII maximal', 'E'], ['Spanish ñ maximal', 'ñ']] as const) {
        const body = catalog(ch), bytes = Buffer.byteLength(JSON.stringify(body)), res = await h.cmd(B, 'publishBorrowerSchema', body, { etag: `"${B.org}:1"` });
        sizes[label] = { bodyBytes: bytes, over16KiB: bytes > 16384, under64KiB: bytes < 65536, result: res.status < 0 ? `A32 rejected ${-res.status}` : st(res) };
      }
      const half = catalog('E'); half.fields = half.fields.slice(0, 5);
      const halfRes = await h.cmd(B, 'publishBorrowerSchema', half, { etag: `"${B.org}:1"` });
      sizes['half catalog'] = { bodyBytes: Buffer.byteLength(JSON.stringify(half)), result: st(halfRes) };
      const huge = await A.c.call('POST', `${h.base(A.org)}/borrowers`, { borrowerCode: 'P05_HUGE', profile: h.profile('x'.repeat(70000)) }, { 'Idempotency-Key': randomUUID() });
      const mid = await A.c.call('POST', `${h.base(A.org)}/borrowers`, { borrowerCode: 'P05_MID', profile: h.profile('x'.repeat(20000)) }, { 'Idempotency-Key': randomUUID() });
      o['body size'] = { ...sizes, over64KiB: st(huge), between16And64KiB: st(mid) };
      assert.equal(huge.status, 413); assert.equal(halfRes.status, 200);
      // Search/pagination: escaped q, cursor bound to filter/limit/org.
      const page1 = data(await h.get(A, '/borrowers?limit=5')) as unknown as { items: { borrowerCode: string }[]; nextCursor: string };
      const page2 = data(await h.get(A, `/borrowers?limit=5&cursor=${page1.nextCursor}`)) as unknown as { items: { borrowerCode: string }[] };
      o['search/pagination'] = { regexQ: (data(await h.get(A, '/borrowers?q=.*')) as unknown as { items: unknown[] }).items.length, likeQ: (data(await h.get(A, '/borrowers?q=HOM1')) as unknown as { items: unknown[] }).items.length,
        pagesDisjoint: page1.items.every(x => !page2.items.some(y => y.borrowerCode === x.borrowerCode)), page1: page1.items.map(x => x.borrowerCode),
        cursorOtherLimit: st(await h.get(A, `/borrowers?limit=6&cursor=${page1.nextCursor}`)), cursorOtherFilter: st(await h.get(A, `/borrowers?limit=5&status=ACTIVE&cursor=${page1.nextCursor}`)),
        cursorInOtherOrg: st(await h.get(B, `/borrowers?limit=5&cursor=${page1.nextCursor}`)), limit0: st(await h.get(A, '/borrowers?limit=0')), limit101: st(await h.get(A, '/borrowers?limit=101')), unknownQuery: st(await h.get(A, '/borrowers?sort=code')) };
      assert.equal((o['search/pagination'] as Record<string, unknown>)['regexQ'], 0);
      for (const k of ['cursorOtherLimit', 'cursorOtherFilter', 'cursorInOtherOrg', 'limit0', 'limit101', 'unknownQuery']) assert.match(String((o['search/pagination'] as Record<string, unknown>)[k]), /^422 /, k);
      // Editing a person never touches the financial book.
      o['ledger untouched by borrowers'] = { journals: await h.f.database.db.collection('financial_journals').countDocuments(), books: await h.f.database.db.collection('financial_books').countDocuments({ openingId: { $exists: true } }) };
      evidence('P05-S4-01', { observed: o });
    });

    await t.test('P05-S4-02 S3 opening history: BORROWER link once, immutable, no loan/disbursement/ledger change; wrong links refused (AT11)', async () => {
      const h = await setup(group, { opening: true }), A0 = await h.tenant('A'), B0 = await h.tenant('B');
      const A = await h.connect(A0), B = await h.connect(B0), o: Record<string, unknown> = {};
      const ledger0 = await h.hashOf(LEDGER), journals0 = await h.f.database.db.collection('financial_journals').find({ organizationId: A.org }).toArray();
      const link = { openingId: A.opening!.id, referenceId: A.opening!.borrowerRef };
      const ok = await h.cmd(A, 'createBorrower', { borrowerCode: 'P05_HIST', profile: h.profile('Persona histórica enlazada'), openingBorrowerReference: link });
      const again = await h.cmd(A, 'createBorrower', { borrowerCode: 'P05_HIST2', profile: h.profile('Otra ficha'), openingBorrowerReference: link });
      const loanRef = await h.cmd(A, 'createBorrower', { borrowerCode: 'P05_HIST3', profile: h.profile('Préstamo como persona'), openingBorrowerReference: { ...link, referenceId: A.opening!.loanRef } });
      const unknown = await h.cmd(A, 'createBorrower', { borrowerCode: 'P05_HIST4', profile: h.profile('Inexistente'), openingBorrowerReference: { ...link, referenceId: randomUUID() } });
      const foreign = await h.cmd(B, 'createBorrower', { borrowerCode: 'P05_HIST5', profile: h.profile('Ajeno'), openingBorrowerReference: link });
      const reLink = await h.cmd(A, 'replaceBorrower', { profile: h.profile('Persona histórica enlazada'), changeReason: 'Intento de cambiar enlace', openingBorrowerReference: { ...link, referenceId: randomUUID() } }, { id: data(ok).id, etag: tag(ok) });
      const ledger1 = await h.hashOf(LEDGER), journals1 = await h.f.database.db.collection('financial_journals').find({ organizationId: A.org }).toArray();
      const loans = await h.f.database.db.collection('lending_loans').countDocuments(), ref = await h.f.database.db.collection('opening_references').findOne({ organizationId: A.org, type: 'HISTORICAL_LOAN' });
      o['links'] = { create: st(ok), stored: JSON.stringify(data(ok)['openingBorrowerReference']) === JSON.stringify(link), secondBorrowerSameLink: st(again), historicalLoanRefAsBorrower: st(loanRef), unknownRef: st(unknown), otherTenant: st(foreign), changeLinkOnPut: st(reLink) };
      o['no economic effect'] = { ledgerAndOpeningHashUnchanged: ledger0 === ledger1, journals: `${journals0.length}/${journals1.length}`, journalSources: journals1.map(j => j['source'] ?? j['type']), loansCreated: loans, historicalPrincipalDeclared: ref?.['principalOutstanding'] };
      assert.equal(ok.status, 201); assert.equal(st(again), '409 OPENING_REFERENCE_CONFLICT'); assert.equal(st(loanRef), '404 RESOURCE_NOT_FOUND'); assert.equal(st(unknown), '404 RESOURCE_NOT_FOUND'); assert.equal(st(foreign), '404 RESOURCE_NOT_FOUND'); assert.equal(Math.abs(reLink.status), 422);
      assert.equal(ledger0, ledger1); assert.equal(journals1.length, 1); assert.equal(loans, 0);
      evidence('P05-S4-02', { observed: o });
    });

    await t.test('P05-S4-03 quote/draft/confirm/replace/cancel end to end: server == own oracle, versions, TTL boundary, stale dependencies, no ledger (AT07/09/10)', async () => {
      const h = await setup(group), A = await h.connect(await h.tenant('A')), B = await h.connect(await h.tenant('B')), o: Record<string, unknown> = {};
      const db = h.f.database.db, ledger0 = await h.hashOf(LEDGER);
      const p1 = data(await h.borrower(A, 'P05_L1')), p2 = data(await h.borrower(A, 'P05_L2')), pB = data(await h.borrower(B, 'P05_LB'));
      // Quote without R; end-to-end equality with the own oracle for three modalities.
      const q1r = await h.quote(A, p1.id); const q1 = data(q1r);
      const methods: Record<string, unknown> = {};
      for (const [method, extra] of [['CONSTANT_PRINCIPAL', {}], ['LEVEL_PAYMENT', {}], ['INTEREST_ONLY', { rate: { type: 'NOMINAL_ANNUAL', unit: 'YEAR', value: '0.120000000000', compoundingPeriodsPerYear: 12 } }], ['LEVEL_PAYMENT', { frequency: 'SEMIMONTH', effectiveDate: '2024-01-15', firstDueDate: '2024-01-31', installmentCount: 24, rate: { type: 'EFFECTIVE', unit: 'YEAR', value: '0.260000000000' } }]] as const) {
        const tm = h.terms(A, p1.id, { method, ...extra }), qr = await h.cmd(A, 'createLoanQuote', { terms: tm }), mine = oracle(tm as unknown as OracleTerms);
        assert.equal(qr.status, 201); assert.ok('value' in mine);
        const d = data(qr); const got = { schedule: d['schedule'], totals: d['totals'], periodicRate24: d['periodicRate24'], basePayment: d['basePayment'], finalPaymentAdjustment: d['finalPaymentAdjustment'] };
        assert.deepEqual(got, mine.value, method);
        methods[`${method}/${tm.frequency}/${tm.installmentCount}`] = { payments: (d['schedule'] as { payment: string }[]).slice(0, 3).map(x => x.payment), totals: d['totals'], i24: d['periodicRate24'], equalsOracle: true };
      }
      o['server == oracle'] = methods;
      const replay = await h.cmd(A, 'createLoanQuote', { terms: h.terms(A, p1.id) }, { key: q1r.key });
      const replayOther = await h.cmd(A, 'createLoanQuote', { terms: h.terms(A, p1.id, { principal: '1001.00' }) }, { key: q1r.key });
      o['quote'] = { create: st(q1r), r: q1r.r ?? 'none', expiresIn: Date.parse(q1.expiresAt) - Date.parse(String(q1['createdAt'])), replay: st(replay), replaySame: JSON.stringify(data(replay)) === JSON.stringify(q1), replayOtherTerms: st(replayOther),
        getQuote: st(await h.get(A, `/loan-quotes/${q1.id}`)), getFromOtherOrg: st(await B.c.call('GET', `${h.base(B.org)}/loan-quotes/${q1.id}`)), getForeignPath: st(await B.c.call('GET', `${h.base(A.org)}/loan-quotes/${q1.id}`)),
        foreignAccount: st(await h.quote(A, p1.id, { plannedFundingAccountId: B.acc['CASH_P05'] })), foreignBorrower: st(await h.quote(A, pB.id)), equityAccount: st(await h.quote(A, p1.id, { plannedFundingAccountId: A.acc['EQ_P05'] })),
        generalAsset: st(await h.quote(A, p1.id, { plannedFundingAccountId: A.acc['GEN_P05'] })), bankAccount: st(await h.quote(A, p1.id, { plannedFundingAccountId: A.acc['BANK_P05'] })), realUse: st(await h.quote(A, p1.id, { usage: 'REAL' })),
        otherPolicy: st(await h.quote(A, p1.id, { policyVersion: 'S04-LOCAL-CO-9.9' })), missingRate: st(await A.c.call('POST', `${h.base(A.org)}/loan-quotes`, { terms: { ...h.terms(A, p1.id), rate: undefined } }, { 'Idempotency-Key': randomUUID() })),
        irregular: st(await h.quote(A, p1.id, { firstDueDate: '2024-03-15' })), activeField: st(await A.c.call('POST', `${h.base(A.org)}/loan-quotes`, { terms: { ...h.terms(A, p1.id), status: 'ACTIVE' } }, { 'Idempotency-Key': randomUUID() })) };
      assert.equal(q1r.status, 201); assert.equal(q1r.r, undefined); assert.equal(replay.status, 200); assert.equal((o['quote'] as Record<string, unknown>)['replaySame'], true); assert.equal(replayOther.status, 409);
      assert.equal((o['quote'] as Record<string, unknown>)['expiresIn'], 900000);
      for (const [k, v] of [['getFromOtherOrg', '404'], ['getForeignPath', '404'], ['foreignAccount', '404'], ['foreignBorrower', '404'], ['equityAccount', '422'], ['generalAsset', '422'], ['realUse', '403 REAL_USE_NOT_ALLOWED'], ['otherPolicy', '422 POLICY_UNSUPPORTED'], ['missingRate', '422'], ['irregular', '422 IRREGULAR_PERIOD_UNSUPPORTED'], ['activeField', '422']] as const) assert.ok(String((o['quote'] as Record<string, unknown>)[k]).startsWith(v), `${k}: ${String((o['quote'] as Record<string, unknown>)[k])}`);
      // Draft / confirm / replace / cancel.
      const d1 = await h.draft(A, q1, { note: 'Borrador sintético' }), loan = data(d1);
      const reuse = await h.draft(A, q1), badFp = await h.cmd(A, 'createLoanDraft', { quoteId: q1.id, quoteFingerprint: '0'.repeat(64) });
      const extraField = await h.cmd(A, 'createLoanDraft', { quoteId: q1.id, quoteFingerprint: q1.fingerprint, isDisbursed: true });
      const conf = await h.cmd(A, 'confirmLoanTerms', { quoteId: q1.id, quoteFingerprint: q1.fingerprint, termsVersion: 1 }, { id: loan.id, etag: tag(d1) });
      const confAgain = await h.cmd(A, 'confirmLoanTerms', { quoteId: q1.id, quoteFingerprint: q1.fingerprint, termsVersion: 1 }, { id: loan.id, etag: tag(conf) });
      const confReplay = await h.cmd(A, 'confirmLoanTerms', { quoteId: q1.id, quoteFingerprint: q1.fingerprint, termsVersion: 1 }, { id: loan.id, etag: tag(d1), key: conf.key });
      const q2 = data(await h.quote(A, p1.id, { method: 'LEVEL_PAYMENT', principal: '1200.00', rate: { type: 'EFFECTIVE', unit: 'MONTH', value: '0.000000000000' } }));
      const qOther = data(await h.quote(A, p2.id));
      const putOther = await h.cmd(A, 'replaceLoanTerms', { quoteId: qOther.id, quoteFingerprint: qOther.fingerprint, changeReason: 'Otra persona' }, { id: loan.id, etag: tag(conf) });
      const putSameQuote = await h.cmd(A, 'replaceLoanTerms', { quoteId: q1.id, quoteFingerprint: q1.fingerprint, changeReason: 'Misma cotización' }, { id: loan.id, etag: tag(conf) });
      const put = await h.cmd(A, 'replaceLoanTerms', { quoteId: q2.id, quoteFingerprint: q2.fingerprint, changeReason: 'Nueva condición sintética' }, { id: loan.id, etag: tag(conf) });
      const hist = data(await h.get(A, `/loans/${loan.id}/versions`)) as unknown as { items: { termsVersion: number; quoteId: string; calculation: { totals: unknown } }[] };
      const v1 = data(await h.get(A, `/loans/${loan.id}/versions/1`)) as unknown as { terms: { principal: string }; calculation: { totals: { interest: string } } };
      const conf2 = await h.cmd(A, 'confirmLoanTerms', { quoteId: q2.id, quoteFingerprint: q2.fingerprint, termsVersion: 2 }, { id: loan.id, etag: tag(put) });
      const cancel = await h.cmd(A, 'cancelLoan', { reason: 'Cancelación sintética' }, { id: loan.id, etag: tag(conf2) });
      const q3 = data(await h.quote(A, p1.id));
      const afterCancel = { put: st(await h.cmd(A, 'replaceLoanTerms', { quoteId: q3.id, quoteFingerprint: q3.fingerprint, changeReason: 'Tras cancelar' }, { id: loan.id, etag: tag(cancel) })),
        confirm: st(await h.cmd(A, 'confirmLoanTerms', { quoteId: q2.id, quoteFingerprint: q2.fingerprint, termsVersion: 2 }, { id: loan.id, etag: tag(cancel) })),
        cancel: st(await h.cmd(A, 'cancelLoan', { reason: 'Otra vez' }, { id: loan.id, etag: tag(cancel) })) };
      o['lifecycle'] = { draft: `${st(d1)} ${loan.status} v${loan.version} tv${loan.termsVersion}`, sameQuoteOtherKey: st(reuse), wrongFingerprint: st(badFp), isDisbursedField: st(extraField),
        confirm: `${st(conf)} ${data(conf).status} v${data(conf).version} tv${data(conf).termsVersion}`, confirmTwiceNewKey: st(confAgain), confirmReplaySameKeyNewR: `${st(confReplay)} same=${JSON.stringify(data(confReplay)) === JSON.stringify(data(conf))}`,
        replaceWithOtherBorrowersQuote: st(putOther), replaceWithAlreadyUsedQuote: st(putSameQuote), replace: `${st(put)} ${data(put).status} v${data(put).version} tv${data(put).termsVersion} confirmation=${JSON.stringify(data(put)['confirmation'])}`,
        history: hist.items.map(x => x.termsVersion), version1Immutable: `${v1.terms.principal}/${v1.calculation.totals.interest}`, confirmV2: `${st(conf2)} ${data(conf2).status}`, cancel: `${st(cancel)} ${data(cancel).status}`, afterCancel };
      assert.equal(d1.status, 201); assert.equal(loan.status, 'DRAFT'); assert.equal(st(reuse), '409 QUOTE_ALREADY_USED'); assert.equal(st(badFp), '409 QUOTE_BINDING_MISMATCH'); assert.equal(Math.abs(extraField.status), 422);
      assert.equal(data(conf).status, 'TERMS_CONFIRMED'); assert.equal(st(confAgain), '409 STATE_CONFLICT'); assert.equal(confReplay.status, 200);
      assert.equal(st(putOther), '409 QUOTE_BINDING_MISMATCH'); assert.equal(st(putSameQuote), '409 QUOTE_ALREADY_USED'); assert.equal(data(put).status, 'DRAFT'); assert.equal(data(put)['confirmation'], null); assert.equal(data(put).termsVersion, 2);
      assert.deepEqual(hist.items.map(x => x.termsVersion), [1, 2]); assert.equal(v1.terms.principal, '1000.00'); assert.equal(data(cancel).status, 'CANCELLED');
      for (const v of Object.values(afterCancel)) assert.equal(v, '409 STATE_CONFLICT');
      // TTL boundary: now == expiresAt is expired; one millisecond earlier is valid. Each R advances the clock 30 s.
      const qa = data(await h.quote(A, p2.id, { principal: '500.00' }));
      h.f.clock.value = Date.parse(qa.expiresAt) - 30000; const atExpiry = await h.draft(A, qa);
      const qb = data(await h.quote(A, p2.id, { principal: '501.00' }));
      h.f.clock.value = Date.parse(qb.expiresAt) - 30001; const justBefore = await h.draft(A, qb);
      o['ttl'] = { atExpiresAt: st(atExpiry), oneMsBefore: st(justBefore), expiredQuoteStillReadable: st(await h.get(A, `/loan-quotes/${qa.id}`)) };
      assert.equal(st(atExpiry), '409 QUOTE_EXPIRED'); assert.equal(justBefore.status, 201);
      // Stale dependencies: borrower edit, catalog publish, account rename (S2), borrower deactivation.
      const stale: Record<string, string> = {};
      { const q = data(await h.quote(A, p2.id, { principal: '700.00' })), b = await h.get(A, `/borrowers/${p2.id}`);
        await h.cmd(A, 'replaceBorrower', { profile: h.profile('Persona editada'), changeReason: 'Editar tras cotizar' }, { id: p2.id, etag: tag(b) }); stale['borrower edited'] = st(await h.draft(A, q)); }
      { const q = data(await h.quote(A, p2.id, { principal: '701.00' }));
        await h.cmd(A, 'publishBorrowerSchema', { fields: [{ key: 'zona', label: 'Zona', type: 'TEXT', deprecated: false }], changeReason: 'Catálogo tras cotizar' }, { etag: `"${A.org}:1"` });
        stale['catalog published'] = st(await h.draft(A, q)); }
      // Every S4 command so far (quotes, drafts, confirmations, replacements, cancellation, rejections, TTL, two stale cases): ledger/opening identical.
      const ledgerBeforeRename = await h.hashOf(LEDGER); assert.equal(ledgerBeforeRename, ledger0);
      { const q = data(await h.quote(A, p1.id, { principal: '702.00' })), acc = await A.c.call('GET', `${h.base(A.org)}/financial/accounts/${A.acc['CASH_P05']}`);
        const key = randomUUID(), payload = { name: 'Caja renombrada P05' };
        const rr = await h.r(A, 'FINANCE_ACCOUNT_UPDATE', { organizationId: A.org, idempotencyKey: key, payload, expectedETag: tag(acc) }, A.acc['CASH_P05']);
        const ren = await A.c.call('PATCH', `${h.base(A.org)}/financial/accounts/${A.acc['CASH_P05']}`, payload, { 'Idempotency-Key': key, 'If-Match': tag(acc) });
        stale['account renamed (S2)'] = `${st(ren)} (R ${rr}) -> ${st(await h.draft(A, q))}`; }
      const ledgerAfterRename = await h.hashOf(LEDGER); // the S2 rename itself writes S2 idempotency/evidence
      { const q = data(await h.quote(A, p1.id, { principal: '703.00' })), b = await h.get(A, `/borrowers/${p1.id}`);
        await h.cmd(A, 'deactivateBorrower', { reason: 'Inactivar tras cotizar' }, { id: p1.id, etag: tag(b) }); stale['borrower deactivated'] = st(await h.draft(A, q));
        stale['quote for inactive borrower'] = st(await h.quote(A, p1.id)); }
      o['stale'] = stale;
      for (const k of ['borrower edited', 'catalog published', 'borrower deactivated']) assert.equal(stale[k], '409 QUOTE_STALE', k);
      assert.equal(stale['quote for inactive borrower'], '422 INPUT_INVALID');
      // No ledger/cash/balance/disbursement: only an account NAME changed in this scenario (S2 rename above).
      const ledger1 = await h.hashOf(LEDGER), accounts = await db.collection('financial_accounts').find({ organizationId: A.org }).toArray();
      const actions = await db.collection('lending_actions').countDocuments(), audits = await db.collection('audit_events').countDocuments({ action: /^LENDING_/ }), outbox = await db.collection('outbox').countDocuments({ action: /^LENDING_/ });
      const loans = await db.collection('lending_loans').find().toArray();
      o['no financial effect'] = { ledgerAndOpeningHashUnchangedBeforeRename: ledgerBeforeRename === ledger0, ledgerAndOpeningUnchangedAfterRenameBySubsequentS4: ledger1 === ledgerAfterRename, journals: await db.collection('financial_journals').countDocuments(), accountsChangedOnlyByRename: accounts.filter(a => a['version'] !== 1).map(a => a['code']),
        loanStatuses: loans.map(l => l['status']), forbiddenFields: loans.some(l => ['isDisbursed', 'outstandingBalance', 'disbursedAt', 'balance'].some(k => k in l)), lendingActions: actions, lendingAudits: audits, lendingOutbox: outbox };
      assert.equal(await db.collection('financial_journals').countDocuments(), 0); assert.equal(await db.collection('financial_books').countDocuments({ openingId: { $exists: true } }), 0);
      assert.ok(loans.every(l => ['DRAFT', 'TERMS_CONFIRMED', 'CANCELLED'].includes(String(l['status'])))); assert.equal(actions, audits); assert.equal(audits, outbox);
      assert.equal(ledger1, ledgerAfterRename);
      // Routes that would move money do not exist.
      const tr: Record<string, string> = {};
      for (const [m, p] of [['POST', `/loans/${loan.id}/activation`], ['POST', `/loans/${loan.id}/disbursement`], ['POST', `/loans/${loan.id}/payments`], ['DELETE', `/loans/${loan.id}`], ['PATCH', `/loan-quotes/${q1.id}`], ['GET', '/loan-quotes'], ['DELETE', `/borrowers/${p2.id}`]] as const) {
        const res = await A.c.call(m, h.base(A.org) + p, m === 'GET' || m === 'DELETE' ? undefined : {}, { 'Idempotency-Key': randomUUID() }); tr[`${m} ${p.replace(/[0-9a-f-]{36}/g, '{id}')}`] = `${st(res)}${res.headers['allow'] ? ' Allow=' + String(res.headers['allow']) : ''}`;
      }
      o['transport'] = tr;
      assert.ok(Object.values(tr).every(v => /^(404 ROUTE_NOT_FOUND|405 METHOD_NOT_ALLOWED)/.test(v)), JSON.stringify(tr));
      evidence('P05-S4-03', { observed: o });
    });

    await t.test('P05-S4-04 isolation, roles, session, R binding, CSRF, limits, realm (AT13)', async () => {
      const h = await setup(group), A = await h.connect(await h.tenant('A')), B = await h.connect(await h.tenant('B')), o: Record<string, unknown> = {};
      const pa = await h.borrower(A, 'P05_ISO'), q = data(await h.quote(A, data(pa).id)), dr = await h.draft(A, q), loan = data(dr);
      const x: Record<string, string> = {};
      for (const p of [`/borrowers/${data(pa).id}`, `/borrowers/${data(pa).id}/versions`, `/loan-quotes/${q.id}`, `/loans/${loan.id}`, `/loans/${loan.id}/versions`, '/borrowers', '/loans', '/lending-policy', '/borrower-field-schemas/current'])
        x['B GET A path ' + p.replace(/[0-9a-f-]{36}/g, '{id}')] = st(await B.c.call('GET', h.base(A.org) + p));
      for (const p of [`/borrowers/${data(pa).id}`, `/loan-quotes/${q.id}`, `/loans/${loan.id}`]) x['B GET own path, A id ' + p.replace(/[0-9a-f-]{36}/g, '{id}')] = st(await B.c.call('GET', h.base(B.org) + p));
      x['B mutate A org without CSRF/R'] = st(await B.c.call('POST', `${h.base(A.org)}/loans/${loan.id}/cancellation`, { reason: 'x' }, { 'Idempotency-Key': randomUUID(), 'If-Match': tag(dr), 'X-CSRF-Token': 'none' }));
      x['B confirm with A quote on B org'] = st(await h.cmd(B, 'createLoanDraft', { quoteId: q.id, quoteFingerprint: q.fingerprint }));
      x['B quote on A org'] = st(await B.c.call('POST', `${h.base(A.org)}/loan-quotes`, { terms: h.terms(A, data(pa).id) }, { 'Idempotency-Key': randomUUID() }));
      o['cross-tenant'] = x;
      for (const [k, v] of Object.entries(x)) assert.match(v, /^404 RESOURCE_NOT_FOUND/, k);
      // Same-org second titular (membership simulated by a synthetic DB update: S4 has no invitation flow): may read, may not use.
      const X = await h.f.actor();
      await h.f.database.db.collection('identities').updateOne({ _id: X.subjectId as never }, { $set: { organizationId: A.org, roles: ['T'] } });
      const XT = await h.connect({ ...A, a: X, c: undefined as unknown as ApiClient, label: 'A2' });
      o['second titular same org'] = { readQuote: st(await h.get(XT, `/loan-quotes/${q.id}`)), useQuote: st(await h.cmd(XT, 'confirmLoanTerms', { quoteId: q.id, quoteFingerprint: q.fingerprint, termsVersion: 1 }, { id: loan.id, etag: tag(dr) })) };
      // Roles: no permission for A/O/C/P/L/SA/T+SA (also GET).
      const subject = A.a.subjectId as never, roles: Record<string, string> = {};
      for (const role of [['A'], ['O'], ['C'], ['P'], ['L'], ['SA'], ['T', 'SA']]) {
        await h.f.database.db.collection('identities').updateOne({ _id: subject }, { $set: { roles: role } });
        roles[role.join('+')] = `GET ${st(await h.get(A, '/loans'))} / quote ${st(await A.c.call('POST', `${h.base(A.org)}/loan-quotes`, { terms: h.terms(A, data(pa).id) }, { 'Idempotency-Key': randomUUID() }))}`;
      }
      await h.f.database.db.collection('identities').updateOne({ _id: subject }, { $set: { roles: ['T'] } });
      o['roles'] = roles;
      for (const [k, v] of Object.entries(roles)) assert.equal(v, 'GET 403 ACCESS_DENIED / quote 403 ACCESS_DENIED', k);
      // Session kinds.
      const anon = new ApiClient(A.c.port, A.c.cert); await anon.refreshCsrf();
      const basic = await h.f.signup(), bc = new ApiClient(A.c.port, A.c.cert); bc.cookies.set('__Host-caudelyx-session', basic.issued.token); await bc.refreshCsrf().catch(() => undefined);
      const plat = await h.f.client(A.a, 'platform.localhost');
      const s: Record<string, string> = { 'no session GET': st(await anon.call('GET', `${h.base(A.org)}/loans`)), 'no session quote': st(await anon.call('POST', `${h.base(A.org)}/loan-quotes`, { terms: h.terms(A, data(pa).id) }, { 'Idempotency-Key': randomUUID() })),
        'basic (password, no MFA) GET': st(await bc.call('GET', `${h.base(A.org)}/lending-policy`)), 'PLATFORM host GET': st(await plat.call('GET', `${h.base(A.org)}/loans`)) };
      // R binding: purpose/payload/resource/ETag/consumed/foreign purpose.
      const p2 = await h.borrower(A, 'P05_RB'), b2 = data(p2);
      s['R of other purpose (REACTIVATE used for DEACTIVATE)'] = st(await h.cmd(A, 'deactivateBorrower', { reason: 'x' }, { id: b2.id, etag: tag(p2), rPurpose: 'BORROWER_REACTIVATE' }));
      s['R for other payload'] = st(await h.cmd(A, 'deactivateBorrower', { reason: 'x' }, { id: b2.id, etag: tag(p2), rPayload: { reason: 'y' } }));
      s['R for other resource'] = st(await h.cmd(A, 'deactivateBorrower', { reason: 'x' }, { id: b2.id, etag: tag(p2), rResource: data(pa).id }));
      s['R for other ETag'] = st(await h.cmd(A, 'deactivateBorrower', { reason: 'x' }, { id: b2.id, etag: tag(p2), rEtag: `"${b2.id}:9"` }));
      s['finance R for borrower create'] = st(await h.cmd(A, 'createBorrower', { borrowerCode: 'P05_FR', profile: h.profile('x') }, { rPurpose: 'FINANCE_ACCOUNT_CREATE' }));
      const used = await h.cmd(A, 'createBorrower', { borrowerCode: 'P05_RC', profile: h.profile('x') });
      s['R consumed: same R second command'] = st(await A.c.call('POST', `${h.base(A.org)}/borrowers`, { borrowerCode: 'P05_RC2', profile: h.profile('x') }, { 'Idempotency-Key': randomUUID() }));
      s['no R at all'] = st(await h.cmd(A, 'createBorrower', { borrowerCode: 'P05_NR', profile: h.profile('x') }, { skipR: true }));
      // CSRF/Origin/content-type/query/body.
      const k = await h.cmd(A, 'createBorrower', { borrowerCode: 'P05_CS', profile: h.profile('x') }, { onlyR: true });
      const call = async (headers: Record<string, string>, body: unknown = { borrowerCode: 'P05_CS', profile: h.profile('x') }, path = '/borrowers') => st(await A.c.call('POST', h.base(A.org) + path, body, { 'Idempotency-Key': k.key, ...headers }));
      s['CSRF wrong'] = await call({ 'X-CSRF-Token': 'bad' }); s['Origin other'] = await call({ Origin: 'https://evil.example' }); s['Sec-Fetch-Site cross-site'] = await call({ 'Sec-Fetch-Site': 'cross-site' });
      s['text/plain'] = await call({ 'Content-Type': 'text/plain' });
      s['GET with query extra'] = st(await h.get(A, '/loans?debug=1')); { const gb = await A.c.call('GET', `${h.base(A.org)}/loans`, {}); s['GET with body'] = `${st(gb)} ct=${String(gb.headers['content-type'] ?? 'none')} body=${JSON.stringify(gb.body).slice(0, 60)}`; }
      s['valid after all rejections (same R still unconsumed)'] = await call({});
      s['used'] = st(used);
      o['session/R/CSRF'] = s;
      for (const [k2, v] of Object.entries({ 'no session GET': '401', 'no session quote': '401', 'basic (password, no MFA) GET': '40', 'PLATFORM host GET': '403', 'R of other purpose (REACTIVATE used for DEACTIVATE)': '403 R_REQUIRED', 'R for other payload': '403 R_REQUIRED', 'R for other resource': '403 R_REQUIRED', 'R for other ETag': '403 R_REQUIRED', 'R consumed: same R second command': '403 R_REQUIRED', 'no R at all': '403 R_REQUIRED', 'CSRF wrong': '400 CSRF_INVALID', 'Origin other': '400 CSRF_INVALID', 'Sec-Fetch-Site cross-site': '400 CSRF_INVALID', 'text/plain': '4', 'GET with query extra': '422', 'GET with body': '4', 'valid after all rejections (same R still unconsumed)': '201' }))
        assert.ok(String(s[k2]).startsWith(v), `${k2}: ${s[k2]}`);
      assert.ok(!String(s['finance R for borrower create']).startsWith('201'));
      // Suspended org and closed realm.
      await h.f.database.db.collection('organizations').updateOne({ _id: A.org as never }, { $set: { status: 'SUSPENDED' } });
      const susp = { GET: st(await h.get(A, '/loans')), quote: st(await A.c.call('POST', `${h.base(A.org)}/loan-quotes`, { terms: h.terms(A, data(pa).id) }, { 'Idempotency-Key': randomUUID() })) };
      await h.f.database.db.collection('organizations').updateOne({ _id: A.org as never }, { $set: { status: 'ACTIVE' } });
      h.f.clock.open = false;
      const closed = { lendingGET: st(await h.get(A, '/loans')), unknownLendingRoute: st(await h.get(A, '/loans/x/y/z')), anonymous: st(await anon.call('GET', `${h.base(A.org)}/loans`)) };
      h.f.clock.open = true;
      o['suspended org'] = susp; o['realm closed'] = closed;
      assert.ok(Object.values(susp).every(v => /^40[13]/.test(v)), JSON.stringify(susp)); assert.ok(Object.values(closed).every(v => v === '503 SERVICE_UNAVAILABLE'), JSON.stringify(closed));
      evidence('P05-S4-04', { observed: o });
    });

    await t.test('P05-S4-05 concurrency, revocation and injected failures: one effect, no partial write, R not consumed (AT14/15)', async () => {
      const h = await setup(group), A0 = await h.tenant('A'), o: Record<string, unknown> = {}, db = h.f.database.db;
      // Two independent sessions of the same titular (separate login contexts), so concurrent requests are real.
      const second = await h.login(A0.a), A = await h.connect(A0), A2 = await h.connect({ ...A0, a: second, c: undefined as unknown as ApiClient });
      const b = await h.borrower(A, 'P05_CC'), id = data(b).id;
      // Two PUT with the same ETag, each with its own valid R: serial order, one wins.
      const k1 = await h.cmd(A, 'replaceBorrower', { profile: h.profile('Edición uno'), changeReason: 'uno' }, { id, etag: tag(b), onlyR: true });
      const k2 = await h.cmd(A2, 'replaceBorrower', { profile: h.profile('Edición dos'), changeReason: 'dos' }, { id, etag: tag(b), onlyR: true });
      const [r1, r2] = await Promise.all([A.c.call('PUT', `${h.base(A.org)}/borrowers/${id}`, { profile: h.profile('Edición uno'), changeReason: 'uno' }, { 'Idempotency-Key': k1.key, 'If-Match': tag(b) }),
        A2.c.call('PUT', `${h.base(A.org)}/borrowers/${id}`, { profile: h.profile('Edición dos'), changeReason: 'dos' }, { 'Idempotency-Key': k2.key, 'If-Match': tag(b) })]);
      const after = await db.collection('lending_borrowers').findOne({ _id: id as never });
      o['concurrent PUT same ETag'] = { statuses: [st(r1), st(r2)].sort(), profileVersion: after?.['profileVersion'], versions: await db.collection('lending_borrower_versions').countDocuments({ borrowerId: id }) };
      assert.deepEqual([r1.status, r2.status].sort(), [200, 412]); assert.equal(after?.['profileVersion'], 2);
      // Two drafts from the same quote with different keys at once.
      const q = data(await h.quote(A, id)), d1 = await h.cmd(A, 'createLoanDraft', { quoteId: q.id, quoteFingerprint: q.fingerprint }, { onlyR: true }), d2 = await h.cmd(A2, 'createLoanDraft', { quoteId: q.id, quoteFingerprint: q.fingerprint }, { onlyR: true });
      const [x1, x2] = await Promise.all([A.c.call('POST', `${h.base(A.org)}/loans`, { quoteId: q.id, quoteFingerprint: q.fingerprint }, { 'Idempotency-Key': d1.key }), A2.c.call('POST', `${h.base(A.org)}/loans`, { quoteId: q.id, quoteFingerprint: q.fingerprint }, { 'Idempotency-Key': d2.key })]);
      o['concurrent drafts same quote'] = { statuses: [st(x1), st(x2)].sort(), loans: await db.collection('lending_loans').countDocuments(), versions: await db.collection('lending_loan_versions').countDocuments({ quoteId: q.id }) };
      assert.deepEqual([x1.status, x2.status].sort(), [201, 409]); assert.equal(await db.collection('lending_loans').countDocuments(), 1);
      // Same key + same payload concurrently (two R): single effect.
      const key = randomUUID(), body = { borrowerCode: 'P05_SAMEKEY', profile: h.profile('Misma clave') };
      await h.cmd(A, 'createBorrower', body, { key, onlyR: true }); await h.cmd(A2, 'createBorrower', body, { key, onlyR: true });
      const [y1, y2] = await Promise.all([A.c.call('POST', `${h.base(A.org)}/borrowers`, body, { 'Idempotency-Key': key }), A2.c.call('POST', `${h.base(A.org)}/borrowers`, body, { 'Idempotency-Key': key })]);
      o['concurrent same key'] = { statuses: [st(y1), st(y2)].sort(), borrowers: await db.collection('lending_borrowers').countDocuments({ borrowerCode: 'P05_SAMEKEY' }) };
      assert.equal(await db.collection('lending_borrowers').countDocuments({ borrowerCode: 'P05_SAMEKEY' }), 1);
      // Confirm racing a borrower deactivation: a valid serial order, never a confirmation on a stale quote.
      const loan = x1.status === 201 ? x1 : x2, lq = data(loan), bnow = await h.get(A, `/borrowers/${id}`);
      const c1 = await h.cmd(A, 'confirmLoanTerms', { quoteId: q.id, quoteFingerprint: q.fingerprint, termsVersion: 1 }, { id: lq.id, etag: tag(loan), onlyR: true });
      const c2 = await h.cmd(A2, 'deactivateBorrower', { reason: 'Carrera' }, { id, etag: tag(bnow), onlyR: true });
      const [z1, z2] = await Promise.all([A.c.call('POST', `${h.base(A.org)}/loans/${lq.id}/confirmation`, { quoteId: q.id, quoteFingerprint: q.fingerprint, termsVersion: 1 }, { 'Idempotency-Key': c1.key, 'If-Match': tag(loan) }),
        A2.c.call('POST', `${h.base(A.org)}/borrowers/${id}/deactivation`, { reason: 'Carrera' }, { 'Idempotency-Key': c2.key, 'If-Match': tag(bnow) })]);
      const finalLoan = await db.collection('lending_loans').findOne({ _id: lq.id as never }), finalB = await db.collection('lending_borrowers').findOne({ _id: id as never });
      o['confirm vs deactivate'] = { confirm: st(z1), deactivate: st(z2), loan: finalLoan?.['status'], borrower: finalB?.['status'] };
      assert.equal(z2.status, 200); assert.ok(z1.status === 200 || st(z1) === '409 QUOTE_STALE');
      // Revocation after quote, before draft.
      const b3 = data(await h.borrower(A, 'P05_REV')), q3 = data(await h.quote(A, b3.id));
      await db.collection('identities').updateOne({ _id: A.a.subjectId as never }, { $set: { roles: ['A'], authzVersion: randomUUID() } });
      const revoked = await h.draft(A, q3);
      await db.collection('identities').updateOne({ _id: A.a.subjectId as never }, { $set: { roles: ['T'], authzVersion: randomUUID() } });
      const oldSession = await h.draft(A, q3), relogged = await h.connect({ ...A0, a: await h.login(A0.a), c: undefined as unknown as ApiClient }), restored = await h.draft(relogged, q3);
      o['revocation'] = { draftWhileRevoked: st(revoked), oldSessionAfterRestore: st(oldSession), newSessionAfterAuthorityRestored: st(restored) };
      assert.ok([-400, -401, -403, 401, 403].includes(revoked.status), st(revoked));
      assert.equal(st(restored), '409 QUOTE_STALE');
      // Injected failures at the end of the transaction (audit, actions) and at the S4 fence, after a valid R: zero effects, R reusable.
      const T2 = await h.connect(await h.tenant('C'));
      const inject: Record<string, unknown> = {};
      for (const coll of ['lending_actions', 'audit_events', 'lending_domain_state']) {
        const payload = { borrowerCode: 'P05_FAIL_' + coll.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 20), profile: h.profile('Fallo inyectado ' + coll) }, pre = await h.cmd(T2, 'createBorrower', payload, { onlyR: true });
        const before = await h.counts(LENDING);
        await db.command({ collMod: coll, validator: { $expr: { $eq: [1, 0] } }, validationAction: 'error' }).catch(async () => { await db.createCollection(coll, { validator: { $expr: { $eq: [1, 0] } } }); });
        let failed: Reply | undefined;
        try { failed = await T2.c.call('POST', `${h.base(T2.org)}/borrowers`, payload, { 'Idempotency-Key': pre.key }); }
        finally { await db.command({ collMod: coll, validator: {}, validationAction: 'error' }); }
        const mid = await h.counts(LENDING);
        const retry = await T2.c.call('POST', `${h.base(T2.org)}/borrowers`, payload, { 'Idempotency-Key': pre.key });
        inject[coll] = { failed: st(failed!), noPartialWrite: JSON.stringify(before) === JSON.stringify(mid), retrySameKeySameR: st(retry) };
        assert.equal(failed!.status, 503); assert.deepEqual(mid, before); assert.equal(retry.status, 201);
      }
      o['injected failures'] = inject;
      evidence('P05-S4-05', { observed: o });
    });

    await t.test('P05-S4-06 restore/persistence: complete cut, offline tampering per S4 source, live tampering characterized (F01-S4), digest cost (F02-S4) (AT15)', async () => {
      const h = await setup(group), A = await h.connect(await h.tenant('A')), B = await h.connect(await h.tenant('B')), o: Record<string, unknown> = {}, db = h.f.database.db;
      const preS4 = await h.f.restore.snapshot();
      const b = await h.borrower(A, 'P05_RS'), q = data(await h.quote(A, data(b).id)), dr = await h.draft(A, q);
      const conf = await h.cmd(A, 'confirmLoanTerms', { quoteId: q.id, quoteFingerprint: q.fingerprint, termsVersion: 1 }, { id: data(dr).id, etag: tag(dr) });
      assert.equal(conf.status, 200); await h.f.restore.flush();
      const restart = async () => { const c = new RestoreController(h.f.database, h.f.restore.gatePath, h.f.keys.journal); await c.initialize(); return c; };
      o['restart after commands'] = { open: (await restart()).isOpen() };
      const before = await db.collection('lending_loans').findOne({ _id: data(dr).id as never });
      const full = await h.f.restore.snapshot(); await h.f.restore.beginRestore(full); await h.f.restore.reconcile({ approved: true, reviewId: 'P05-S4-full-cut' });
      const afterFull = await db.collection('lending_loans').findOne({ _id: data(dr).id as never });
      o['complete cut'] = { open: h.f.restore.isOpen(), sameLoan: JSON.stringify(before) === JSON.stringify(afterFull) };
      assert.equal(h.f.restore.isOpen(), true); assert.equal(JSON.stringify(before), JSON.stringify(afterFull));
      const cases: Record<string, unknown> = {};
      const check = async (label: string, mutate: () => Promise<void>, revert: () => Promise<void>) => {
        await mutate(); const c1 = await restart(), open = c1.isOpen();
        let rec = 'reconciled'; try { await c1.reconcile({ approved: true, reviewId: 'P05-S4-tampered' }); } catch (e) { rec = (e as { code?: string }).code ?? 'refused'; }
        await revert(); const c2 = await restart(); if (!c2.isOpen()) await c2.reconcile({ approved: true, reviewId: 'P05-S4-exact-revert' });
        cases[label] = { openWhileTampered: open, reconcileWhileTampered: rec, openAfterExactRevert: c2.isOpen() };
      };
      const snap = async (coll: string, filter: Document) => await db.collection(coll).findOne(filter) as Document;
      const loanDoc = await snap('lending_loans', { _id: data(dr).id }), lv = await snap('lending_loan_versions', { loanId: data(dr).id }), qd = await snap('lending_quotes', { _id: q.id }), bd = await snap('lending_borrowers', { _id: data(b).id });
      const bv = await snap('lending_borrower_versions', { borrowerId: data(b).id }), idem = await snap('lending_idempotency', { organizationId: A.org }), act = await snap('lending_actions', { organizationId: A.org }), headDoc = await snap('lending_domain_state', { _id: 'evidence' });
      const back = (coll: string, d: Document) => async () => { await db.collection(coll).deleteOne({ _id: d['_id'] }); await db.collection(coll).insertOne(d); };
      await check('loan principal edited', async () => { await db.collection('lending_loans').updateOne({ _id: loanDoc['_id'] }, { $set: { 'terms.principal': '9999.00' } }); }, back('lending_loans', loanDoc));
      await check('loan version schedule edited', async () => { await db.collection('lending_loan_versions').updateOne({ _id: lv['_id'] }, { $set: { 'calculation.totals.interest': '0.00' } }); }, back('lending_loan_versions', lv));
      await check('quote totals edited', async () => { await db.collection('lending_quotes').updateOne({ _id: qd['_id'] }, { $set: { 'totals.interest': '1.00' } }); }, back('lending_quotes', qd));
      await check('borrower name edited', async () => { await db.collection('lending_borrowers').updateOne({ _id: bd['_id'] }, { $set: { 'profile.displayName': 'Alterado' } }); }, back('lending_borrowers', bd));
      await check('borrower version deleted', async () => { await db.collection('lending_borrower_versions').deleteOne({ _id: bv['_id'] }); }, back('lending_borrower_versions', bv));
      await check('idempotency record deleted', async () => { await db.collection('lending_idempotency').deleteOne({ _id: idem['_id'] }); }, back('lending_idempotency', idem));
      await check('action deleted', async () => { await db.collection('lending_actions').deleteOne({ _id: act['_id'] }); }, back('lending_actions', act));
      await check('evidence head deleted', async () => { await db.collection('lending_domain_state').deleteOne({ _id: 'evidence' as never }); }, back('lending_domain_state', headDoc));
      o['offline tampering'] = cases;
      for (const [k, v] of Object.entries(cases)) { const c = v as { openWhileTampered: boolean; reconcileWhileTampered: string; openAfterExactRevert: boolean }; assert.equal(c.openWhileTampered, false, k); assert.notEqual(c.reconcileWhileTampered, 'reconciled', k); assert.equal(c.openAfterExactRevert, true, k); }
      // Pre-S4 cut on a system that now has S4 history.
      let pre = 'reconciled'; try { await h.f.restore.beginRestore(preS4); await h.f.restore.reconcile({ approved: true, reviewId: 'P05-S4-pre-cut' }); } catch (e) { pre = (e as { code?: string }).code ?? 'refused'; }
      o['pre-S4 cut after S4 history'] = { reconcile: pre, open: h.f.restore.isOpen(), loansAfter: await db.collection('lending_loans').countDocuments() };
      if (!h.f.restore.isOpen()) { await h.f.restore.beginRestore(full); await h.f.restore.reconcile({ approved: true, reviewId: 'P05-S4-back-to-full' }); }
      assert.equal(h.f.restore.isOpen(), true);
      // Restores replace the session collection with the cut: fresh logins (own contexts) for what follows.
      const A2 = await h.connect({ ...A, a: await h.login(A.a), c: undefined as unknown as ApiClient }), B2 = await h.connect({ ...B, a: await h.login(B.a), c: undefined as unknown as ApiClient });
      // Live tampering while open (characterization): edit a DRAFT loan's terms/calculation, then legitimate commands.
      const b2 = data(await h.borrower(A2, 'P05_LIVE')), q2 = data(await h.quote(A2, b2.id)), d2 = await h.draft(A2, q2), lid = data(d2).id;
      await db.collection('lending_loans').updateOne({ _id: lid as never }, { $set: { 'terms.principal': '9000.00', 'calculation.totals.principal': '9000.00' } });
      const confirmTampered = await h.cmd(A2, 'confirmLoanTerms', { quoteId: q2.id, quoteFingerprint: q2.fingerprint, termsVersion: 1 }, { id: lid, etag: tag(d2) });
      const later = await h.borrower(A2, 'P05_LATER'); await h.f.restore.flush();
      const live = await restart(), tampered = await db.collection('lending_loans').findOne({ _id: lid as never });
      const qTamper = data(await h.quote(A2, b2.id, { principal: '800.00' }));
      await db.collection('lending_quotes').updateOne({ _id: qTamper.id as never }, { $set: { 'totals.interest': '0.00' } });
      const useTamperedQuote = await h.draft(A2, qTamper);
      await db.collection('lending_quotes').updateOne({ _id: qTamper.id as never }, { $set: { 'totals.interest': (qTamper['totals'] as { interest: string }).interest } });
      o['live tampering (F01-S4)'] = { confirmOfTamperedDraft: `${st(confirmTampered)} ${data(confirmTampered)?.status ?? ''}`, laterCommand: st(later), restartOpen: live.isOpen(), loanPrincipalNow: (tampered?.['terms'] as { principal: string })?.principal, quotePrincipal: (q2['terms'] as { principal: string }).principal, tamperedQuoteUsed: st(useTamperedQuote) };
      assert.equal(st(useTamperedQuote), '503 SERVICE_UNAVAILABLE');
      // F02-S4: digest cost grows with all tenants' S4 data (quotes are kept forever, 360-row schedules).
      const bB = data(await h.borrower(B2, 'P05_TIMING'));
      const timeQuote = async () => { const t0 = performance.now(); const r = await h.quote(B2, bB.id); assert.equal(r.status, 201); return Math.round(performance.now() - t0); };
      const timeDigest = async () => { const t0 = performance.now(); await lendingDigest(h.f.database); return Math.round(performance.now() - t0); };
      const cost: Record<string, unknown> = {}, bulkActor = await h.login(A.a);
      const bulk = async (n: number) => { for (let k = 0; k < n; k++) await h.f.runtime.lending.mutate(bulkActor.issued.context, 'createLoanQuote', A.org, { terms: h.terms(A, b2.id, { method: 'CONSTANT_PRINCIPAL', frequency: 'DAY', installmentCount: 360, firstDueDate: '2024-02-01', principal: '3600.00' }) }, randomUUID()); };
      for (const total of [0, 100, 300]) {
        const have = await db.collection('lending_quotes').countDocuments({ organizationId: A.org, 'terms.installmentCount': 360 });
        if (total > have) await bulk(total - have);
        const m = await group.measure();
        cost[`A has ${total} quotes x360 rows`] = { digestMs: await timeDigest(), tenantBquoteHttpMs: [await timeQuote(), await timeQuote(), await timeQuote()], mongoBytes: m.mongoBytes };
      }
      o['F02-S4 cost'] = cost;
      evidence('P05-S4-06', { observed: o });
    });

    await t.test('P05-S4-07 §15 own group: partial setup failure closes consumer, lease blocks cleanup, protected URIs refused (AT16)', async () => {
      const o: Record<string, unknown> = {};
      let setupFailure = 'none'; try { await group.fixture({ failSetup: true }); } catch (e) { setupFailure = String((e as Error).message); }
      const release = group.hold(); let blocked = 'not blocked'; try { await group.dispose('lease-test'); } catch (e) { blocked = String((e as Error).message); } release();
      const refused: Record<string, string> = {};
      for (const uri of ['mongodb://127.0.0.1:27181', 'mongodb://localhost:27017', 'mongodb://127.0.0.1:27017/caudelyx_dev', 'mongodb://user:pw@127.0.0.1:27017', 'mongodb://127.0.0.1:27017/?directConnection=true']) { try { assertOwnUri(uri); refused[uri.replace(/user:pw@/, 'user:***@')] = 'accepted'; } catch { refused[uri.replace(/user:pw@/, 'user:***@')] = 'refused'; } }
      o['partial setup'] = setupFailure; o['live lease'] = blocked; o['protected uris'] = refused; o['own names only'] = names;
      await receipt({ event: 'section15-negative-checks', setupFailure, blocked, refused });
      assert.equal(setupFailure, 'Injected own partial setup failure'); assert.equal(blocked, 'Own fixture lease is live'); assert.ok(Object.values(refused).every(v => v === 'refused'));
      evidence('P05-S4-07', { observed: o });
    });
  } finally {
    process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal);
    if (!interrupted) await group.dispose(t.signal.aborted ? 'aborted' : 'end');
  }
});
