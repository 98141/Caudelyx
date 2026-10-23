/* eslint-disable security/detect-object-injection -- Keys are this test's own fixed labels/array indexes, never request input. */
// S03-P05 independent review (Claude) of S03-P04-v1-INTEGRADO: manual opening over the REAL HTTPS app (cookie, CSRF,
// A32 password + A27 TOTP for every R) on an isolated Mongo 27017/rs0 group reserved for P05 (one group, reused sequentially).
// Setup reuses the author's resource-guarded fixture only for group/actors/clock; scenarios and assertions are independent.
// Evidence lines carry statuses, codes and synthetic amounts only; no token, code, cookie or key is printed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generate } from 'otplib';
import { financeFixture } from '../../finance/fixture.js';
import { today } from '../../../src/modules/finance/service.js';
import { RestoreController } from '../../../src/shared/restore.js';
import { ApiClient, type ApiBody } from '../../helpers/client.js';
import type { Document } from 'mongodb';

type Fixture = Awaited<ReturnType<typeof financeFixture>>;
type Actor = Awaited<ReturnType<Fixture['actor']>>;
type Reply = { status: number; body: ApiBody; headers: import('node:http').IncomingHttpHeaders };
const evidence = (name: string, data: Record<string, unknown>) => console.log(JSON.stringify({ evidence: name, ...data }));
const day = (base: string, delta: number) => new Date(Date.parse(base + 'T12:00:00Z') + delta * 86400000).toISOString().slice(0, 10);
const SESSION = '__Host-caudelyx-session';
const OPENING: Record<string, string> = { create: 'OPENING_CREATE', replace: 'OPENING_REPLACE', validate: 'OPENING_VALIDATE', approve: 'OPENING_APPROVE', cancel: 'OPENING_CANCEL', commit: 'OPENING_COMMIT' };
const status = (r: Reply) => `${r.status}${r.body.error?.code ? ' ' + r.body.error.code : ''}`;

/** One HTTPS listener per fixture; every actor/org gets its own client on it. */
async function harness(f: Fixture) {
  let listener: { port: number; cert: Buffer } | undefined;
  const client = async (a: Actor, host = 'localhost') => {
    if (!listener) { const s = await f.https(a); listener = { port: s.port, cert: s.cert }; if (host === 'localhost') return s.client; }
    const c = new ApiClient(listener.port, listener.cert, host); c.cookies.set(SESSION, a.issued.token); await c.refreshCsrf().catch(() => undefined); return c;
  };
  const r = async (c: ApiClient, a: Actor, purpose: string, command: Record<string, unknown>, resourceId?: string) => {
    const a32 = await c.call('POST', '/api/v1/auth/reauthenticate', { password: f.password, purpose, command, ...(resourceId ? { resourceId } : {}) });
    if (a32.status !== 200) return a32.status;
    f.clock.value += 30000;
    const a27 = await c.call('POST', '/api/v1/auth/mfa/challenges/verify', { method: 'TOTP', purpose, code: await generate({ secret: a.secret, epoch: Math.floor(f.now() / 1000) }), ...(resourceId ? { resourceId } : {}) });
    await c.refreshCsrf(); return a27.status;
  };
  const base = (org: string) => `/api/v1/organizations/${org}/financial`;
  /** Opening command: R bound to exactly payload/key/ETag/resource, then the call. */
  const op = async (c: ApiClient, a: Actor, org: string, kind: string, payload: Record<string, unknown>, o: { id?: string; etag?: string; key?: string; skipR?: boolean } = {}): Promise<Reply & { key: string }> => {
    const key = o.key ?? randomUUID();
    if (!o.skipR) {
      const s = await r(c, a, OPENING[kind]!, { organizationId: org, idempotencyKey: key, payload, ...(o.id ? { expectedETag: o.etag } : {}) }, o.id);
      if (s !== 200) return { status: -s, body: {}, headers: {}, key };
    }
    const tail = kind === 'create' ? '' : `/${o.id}` + ({ replace: '', validate: '/validations', approve: '/approval', cancel: '/cancellation', commit: '/commit' } as Record<string, string>)[kind];
    const res = await c.call(kind === 'replace' ? 'PUT' : 'POST', `${base(org)}/opening-files${tail}`, payload, { 'Idempotency-Key': key, ...(o.id && o.etag ? { 'If-Match': o.etag } : {}) });
    return { ...res, key };
  };
  const fin = async (c: ApiClient, a: Actor, org: string, purpose: string, path: string, payload: Record<string, unknown>, o: { id?: string; etag?: string } = {}) => {
    const key = randomUUID(), s = await r(c, a, purpose, { organizationId: org, idempotencyKey: key, payload, ...(o.etag ? { expectedETag: o.etag } : {}) }, o.id);
    if (s !== 200) return { status: -s, body: {} as ApiBody, headers: {} };
    return await c.call(purpose === 'FINANCE_ACCOUNT_UPDATE' ? 'PATCH' : 'POST', `${base(org)}${path}`, payload, { 'Idempotency-Key': key, ...(o.etag ? { 'If-Match': o.etag } : {}) });
  };
  const account = async (c: ApiClient, a: Actor, org: string, code: string, accountClass: string, kind = 'GENERAL') => {
    const res = await fin(c, a, org, 'FINANCE_ACCOUNT_CREATE', '/accounts', { code, name: `Cuenta ${code}`, accountClass, kind, currency: 'COP' });
    assert.equal(res.status, 201, `account ${code}`); return String(res.body.data?.['id']);
  };
  const balances = async (c: ApiClient, org: string, asOf: string, recordedThrough?: string) => {
    const res = await c.call('GET', `${base(org)}/balances?${new URLSearchParams({ asOf, ...(recordedThrough ? { recordedThrough } : {}) }).toString()}`); assert.equal(res.status, 200);
    return res.body.data as { recordedThrough: string; items: { accountId: string; naturalBalance: string }[] };
  };
  /** New T actor + organization + client on the shared listener. */
  const tenant = async () => { const a = await f.actor(), org = await f.organization(a), c = await client(a); return { a, org, c }; };
  return { client, r, op, fin, account, balances, base, tenant };
}
const nb = (b: { items: { accountId: string; naturalBalance: string }[] }, id: string) => b.items.find(i => i.accountId === id)?.naturalBalance ?? 'absent';
const sup = (date: string) => ({ id: randomUUID(), reference: 'P05-SOPORTE-SINTETICO', asOfDate: date, declaration: 'OWNER_CHECKED' as const });
/** Approved example 1 (contract): bank100, principal200, asset300, liability150, equity450. */
function example1(C: string, acc: Record<string, string>, equity = '450.00') {
  const s = sup(C), ids = { borrower: randomUUID(), loan: randomUUID(), asset: randomUUID(), obligation: randomUUID() };
  return { ids, snapshot: { cutoffDate: C, supports: [s],
    references: [
      { id: ids.borrower, type: 'BORROWER', externalReference: 'P05-B-1', supportIds: [s.id], displayName: 'Prestatario sintético' },
      { id: ids.loan, type: 'HISTORICAL_LOAN', externalReference: 'P05-L-1', supportIds: [s.id], borrowerId: ids.borrower, originationDate: day(C, -60), fundingReference: 'Aporte declarado' },
      { id: ids.asset, type: 'BASIC_ASSET', externalReference: 'P05-A-1', supportIds: [s.id], category: 'Equipo', acquisitionDate: day(C, -90) },
      { id: ids.obligation, type: 'OBLIGATION', externalReference: 'P05-O-1', supportIds: [s.id], counterpartyLabel: 'Acreedor sintético', incurredDate: day(C, -30) }],
    components: [
      { id: randomUUID(), category: 'BANK', accountId: acc['BANK']!, amount: '100.00', supportIds: [s.id] },
      { id: randomUUID(), category: 'PRINCIPAL_RECEIVABLE', accountId: acc['PRIN']!, amount: '200.00', supportIds: [s.id], referenceId: ids.loan },
      { id: randomUUID(), category: 'BASIC_ASSET', accountId: acc['ASSET']!, amount: '300.00', supportIds: [s.id], referenceId: ids.asset },
      { id: randomUUID(), category: 'LIABILITY', accountId: acc['LIAB']!, amount: '150.00', supportIds: [s.id], referenceId: ids.obligation },
      { id: randomUUID(), category: 'EQUITY', accountId: acc['EQ']!, amount: equity, supportIds: [s.id], equityKind: 'CONTRIBUTED' }],
    historicalInterest: [], informationalHistory: [{ id: randomUUID(), date: day(C, -60), description: 'Desembolso histórico 200 (antecedente, no se contabiliza)', supportIds: [s.id], referenceId: ids.loan }] } };
}
/** Principal 200 with historical interest 20, recognized (needs HIST 220) or informational (equity 200). */
function interestExample(C: string, acc: Record<string, string>, treatment: 'RECOGNIZED_OPENING' | 'INFORMATIONAL') {
  const s = sup(C), borrower = randomUUID(), loan = randomUUID(), equity = randomUUID();
  return { cutoffDate: C, supports: [s],
    references: [{ id: borrower, type: 'BORROWER', externalReference: 'P05-B-2', supportIds: [s.id], displayName: 'Prestatario sintético 2' },
      { id: loan, type: 'HISTORICAL_LOAN', externalReference: 'P05-L-2', supportIds: [s.id], borrowerId: borrower, originationDate: day(C, -45) }],
    components: [{ id: randomUUID(), category: 'PRINCIPAL_RECEIVABLE', accountId: acc['PRIN']!, amount: '200.00', supportIds: [s.id], referenceId: loan },
      { id: equity, category: 'EQUITY', accountId: acc[treatment === 'RECOGNIZED_OPENING' ? 'HIST' : 'EQ']!, amount: treatment === 'RECOGNIZED_OPENING' ? '220.00' : '200.00', supportIds: [s.id], equityKind: treatment === 'RECOGNIZED_OPENING' ? 'HISTORICAL_RESULTS' : 'CONTRIBUTED' }],
    historicalInterest: [treatment === 'RECOGNIZED_OPENING'
      ? { id: randomUUID(), loanReferenceId: loan, amount: '20.00', treatment, supportIds: [s.id], accountId: acc['INT']!, recognitionDeclaration: 'Interés histórico declarado por el titular', equityComponentId: equity }
      : { id: randomUUID(), loanReferenceId: loan, amount: '20.00', treatment, supportIds: [s.id] }],
    informationalHistory: [] };
}
type Snapshot = ReturnType<typeof example1>['snapshot'];
/** create -> validate -> approve -> commit; returns every reply for assertions. */
async function lifecycle(h: Awaited<ReturnType<typeof harness>>, c: ApiClient, a: Actor, org: string, snapshot: Record<string, unknown>) {
  const created = await h.op(c, a, org, 'create', { snapshot }), id = String(created.body.data?.['id']);
  const validated = await h.op(c, a, org, 'validate', { policyVersion: 'S03-OPENING-0.1' }, { id, etag: String(created.headers['etag']) });
  const v = validated.body.data?.['validation'] as { id: string; fingerprint: string } | null;
  if (!v) return { id, created, validated, approved: undefined, committed: undefined, report: validated.body.data?.['report'] as Report };
  const approved = await h.op(c, a, org, 'approve', { validationId: v.id, validationFingerprint: v.fingerprint }, { id, etag: String(validated.headers['etag']) });
  const committed = await h.op(c, a, org, 'commit', { validationId: v.id, validationFingerprint: v.fingerprint }, { id, etag: String(approved.headers['etag']) });
  return { id, created, validated, approved, committed, report: validated.body.data?.['report'] as Report, binding: v };
}
interface Report { issues: { code: string; path: string; relatedIds: string[] }[]; totals: Record<string, string>; proposedLines: { accountId: string; debit: string; credit: string; componentIds: string[]; interestIds: string[] }[] }
const lines = (rep: Report, names: Record<string, string>) => rep.proposedLines.map(l => `${Object.entries(names).find(([, v]) => v === l.accountId)?.[0] ?? '?'} ${l.debit}/${l.credit}`).sort();

test('P05-S3-01 approved examples end to end over HTTPS: positions only (no disbursement/new cash/income), D=C and A=L+E, cut reconstruction, one OPENING per book, cutoff/immutability for later S2 commands, recognized vs informational interest, negative equity, 0.01 difference blocks', { timeout: 600000 }, async () => {
  const f = await financeFixture();
  try {
    const h = await harness(f), t = today(f.now()), C = day(t, -3), observed = new Map<string, unknown>();
    // Org A: example 1, first with patrimonio 449.99 (difference 0.01), corrected by PUT with reason.
    const A = await h.tenant(), acc: Record<string, string> = {};
    for (const [code, cls, kind] of [['BANK', 'ASSET', 'BANK'], ['PRIN', 'ASSET', 'GENERAL'], ['ASSET', 'ASSET', 'GENERAL'], ['LIAB', 'LIABILITY', 'GENERAL'], ['EQ', 'EQUITY', 'GENERAL'], ['CASH', 'ASSET', 'CASH']] as const) acc[code] = await h.account(A.c, A.a, A.org, code, cls, kind);
    const cutBefore = (await h.balances(A.c, A.org, t)).recordedThrough; f.clock.value += 1000;
    const wrong = example1(C, acc, '449.99');
    const diff = await lifecycle(h, A.c, A.a, A.org, wrong.snapshot);
    const approveDraft = await h.op(A.c, A.a, A.org, 'approve', { validationId: randomUUID(), validationFingerprint: 'a'.repeat(64) }, { id: diff.id, etag: String(diff.validated.headers['etag']) });
    observed.set('0.01 difference', { validate: diff.validated.status, state: (diff.validated.body.data?.['opening'] as Record<string, unknown>)['status'], codes: diff.report.issues.map(i => i.code), balanceDifference: diff.report.totals['balanceDifference'], approveDraft: status(approveDraft), journals: await f.database.db.collection('financial_journals').countDocuments({ organizationId: A.org }) });
    const fixed = example1(C, acc);
    const put = await h.op(A.c, A.a, A.org, 'replace', { snapshot: fixed.snapshot, changeReason: 'Corrige patrimonio declarado' }, { id: diff.id, etag: String(diff.validated.headers['etag']) });
    const v = await h.op(A.c, A.a, A.org, 'validate', { policyVersion: 'S03-OPENING-0.1' }, { id: diff.id, etag: String(put.headers['etag']) });
    const rep = v.body.data?.['report'] as Report, val = v.body.data?.['validation'] as { id: string; fingerprint: string };
    const ap = await h.op(A.c, A.a, A.org, 'approve', { validationId: val.id, validationFingerprint: val.fingerprint }, { id: diff.id, etag: String(v.headers['etag']) });
    const commit = await h.op(A.c, A.a, A.org, 'commit', { validationId: val.id, validationFingerprint: val.fingerprint }, { id: diff.id, etag: String(ap.headers['etag']) });
    observed.set('example 1 lifecycle', { put: `${put.status} ${(put.body.data as Record<string, unknown>)['status']} cv=${(put.body.data as Record<string, unknown>)['contentVersion']}`, validate: `${v.status} ${val ? 'VALIDATED' : 'DRAFT'}`, approve: ap.status, commit: commit.status,
      totals: rep.totals, lines: lines(rep, acc), fingerprintKeptThroughApprove: (ap.body.data as { validation?: { fingerprint: string } })?.validation?.fingerprint === val.fingerprint });
    const journals = await f.database.db.collection('financial_journals').find({ organizationId: A.org }).toArray();
    const opening = journals.find(j => (j['source'] as { type: string }).type === 'OPENING');
    let d = 0n, cr = 0n; for (const l of (opening?.['lines'] ?? []) as { debit: { toString(): string }; credit: { toString(): string } }[]) { d += BigInt(l.debit.toString().replace('.', '')); cr += BigInt(l.credit.toString().replace('.', '')); }
    const cut = await h.balances(A.c, A.org, C), before = await h.balances(A.c, A.org, day(C, -1)), notYet = await h.balances(A.c, A.org, C, cutBefore);
    observed.set('ledger after commit', { journals: journals.length, openingLines: (opening?.['lines'] as unknown[])?.length, debitCents: String(d), creditCents: String(cr), effectiveDate: opening?.['effectiveDate'] === C, source: `${(opening?.['source'] as { type: string })?.type} id=file:${(opening?.['source'] as { id: string })?.id === diff.id}` });
    observed.set('balances at C', Object.fromEntries(Object.entries(acc).map(([k, id]) => [k, nb(cut, id)])));
    observed.set('balances at C-1 and at C before commit recorded', { cMinus1: Object.values(acc).every(id => nb(before, id) === '0.00'), recordedBefore: Object.values(acc).every(id => nb(notYet, id) === '0.00') });
    const refs = await f.database.db.collection('opening_references').find({ organizationId: A.org }).toArray();
    observed.set('materialized references', { count: refs.length, principalOutstanding: refs.find(x => x['type'] === 'HISTORICAL_LOAN')?.['principalOutstanding'], loansOriginated: await f.database.db.collection('loans').countDocuments().catch(() => 0) });
    const file = await A.c.call('GET', `${h.base(A.org)}/opening-files/${diff.id}`);
    const map = (file.body.data?.['commit'] as { ledgerLineMap: { componentIds: string[] }[] })?.ledgerLineMap ?? [];
    observed.set('posted file', { status: file.body.data?.['status'], lineMapComponents: map.reduce((n, l) => n + l.componentIds.length, 0) });
    // Later S2 commands and immutability.
    const at = (date: string) => ({ currency: 'COP', effectiveDate: date, sourceId: randomUUID(), supportReference: 'P05', description: 'Operación posterior', lines: [{ accountId: acc['BANK']!, debit: '1.00', credit: '0.00' }, { accountId: acc['EQ']!, debit: '0.00', credit: '1.00' }] });
    const s2AtC = await h.fin(A.c, A.a, A.org, 'FINANCE_JOURNAL_POST', '/journal-entries', at(C)), s2Before = await h.fin(A.c, A.a, A.org, 'FINANCE_JOURNAL_POST', '/journal-entries', at(day(C, -1)));
    const s2After = await h.fin(A.c, A.a, A.org, 'FINANCE_JOURNAL_POST', '/journal-entries', at(day(C, 1)));
    const openingGet = await A.c.call('GET', `${h.base(A.org)}/journal-entries/${String(opening?.['_id'])}`);
    const reverse = await h.fin(A.c, A.a, A.org, 'FINANCE_JOURNAL_REVERSE', `/journal-entries/${String(opening?.['_id'])}/reversals`, { effectiveDate: t, sourceId: randomUUID(), supportReference: 'P05', reason: 'Intento de revertir apertura' }, { id: String(opening?.['_id']), etag: String(openingGet.headers['etag']) });
    const second = await h.op(A.c, A.a, A.org, 'create', { snapshot: example1(C, acc).snapshot });
    const replay = await h.op(A.c, A.a, A.org, 'commit', { validationId: val.id, validationFingerprint: val.fingerprint }, { id: diff.id, etag: String(ap.headers['etag']), key: commit.key });
    const newKey = await h.op(A.c, A.a, A.org, 'commit', { validationId: val.id, validationFingerprint: val.fingerprint }, { id: diff.id, etag: String(file.headers['etag']) });
    const editPosted = await h.op(A.c, A.a, A.org, 'replace', { snapshot: fixed.snapshot, changeReason: 'Editar confirmado' }, { id: diff.id, etag: String(file.headers['etag']) });
    const listJ = await A.c.call('GET', `${h.base(A.org)}/journal-entries?limit=10`);
    observed.set('after posting', { s2AtCutoff: status(s2AtC), s2BeforeCutoff: status(s2Before), s2AfterCutoff: s2After.status, reverseOpening: status(reverse), secondOpening: status(second),
      replayCommit: `${replay.status} sameJournal=${(replay.body.data as { commit?: { journalId: string } })?.commit?.journalId === String(opening?.['_id'])}`, commitNewKey: status(newKey), editPosted: status(editPosted),
      s2ListShowsOpening: ((listJ.body.data?.['items'] ?? []) as { source: { type: string } }[]).some(j => j.source.type === 'OPENING') ? `${listJ.status} OPENING visible` : `${listJ.status} not visible`,
      openingJournalsAfterAll: await f.database.db.collection('financial_journals').countDocuments({ organizationId: A.org, 'source.type': 'OPENING' }) });
    // Org B: recognized historical interest; Org C: informational; Org D: negative equity.
    const B = await h.tenant(), accB: Record<string, string> = {};
    for (const [code, cls] of [['PRIN', 'ASSET'], ['INT', 'ASSET'], ['HIST', 'EQUITY']] as const) accB[code] = await h.account(B.c, B.a, B.org, code, cls);
    const recognized = await lifecycle(h, B.c, B.a, B.org, interestExample(C, accB, 'RECOGNIZED_OPENING'));
    const C2 = await h.tenant(), accC: Record<string, string> = {};
    for (const [code, cls] of [['PRIN', 'ASSET'], ['EQ', 'EQUITY']] as const) accC[code] = await h.account(C2.c, C2.a, C2.org, code, cls);
    const informational = await lifecycle(h, C2.c, C2.a, C2.org, interestExample(C, accC, 'INFORMATIONAL'));
    const D = await h.tenant(), accD: Record<string, string> = {};
    for (const [code, cls, kind] of [['BANK', 'ASSET', 'BANK'], ['LIAB', 'LIABILITY', 'GENERAL'], ['EQ', 'EQUITY', 'GENERAL']] as const) accD[code] = await h.account(D.c, D.a, D.org, code, cls, kind);
    const sd = sup(C), ob = randomUUID();
    const deficit = await lifecycle(h, D.c, D.a, D.org, { cutoffDate: C, supports: [sd], references: [{ id: ob, type: 'OBLIGATION', externalReference: 'P05-O-D', supportIds: [sd.id], counterpartyLabel: 'Acreedor', incurredDate: day(C, -10) }],
      components: [{ id: randomUUID(), category: 'BANK', accountId: accD['BANK']!, amount: '50.00', supportIds: [sd.id] }, { id: randomUUID(), category: 'LIABILITY', accountId: accD['LIAB']!, amount: '100.00', supportIds: [sd.id], referenceId: ob },
        { id: randomUUID(), category: 'EQUITY', accountId: accD['EQ']!, amount: '-50.00', supportIds: [sd.id], equityKind: 'OTHER_DECLARED' }], historicalInterest: [], informationalHistory: [] });
    const balB = await h.balances(B.c, B.org, C), balC = await h.balances(C2.c, C2.org, C), balD = await h.balances(D.c, D.org, C);
    observed.set('recognized interest', { commit: recognized.committed?.status, lines: lines(recognized.report, accB), principal: recognized.report.totals['principal'], recognizedInterest: recognized.report.totals['recognizedInterest'], balances: Object.fromEntries(Object.entries(accB).map(([k, id]) => [k, nb(balB, id)])) });
    observed.set('informational interest', { commit: informational.committed?.status, lines: lines(informational.report, accC), informationalInterest: informational.report.totals['informationalInterest'], balances: Object.fromEntries(Object.entries(accC).map(([k, id]) => [k, nb(balC, id)])) });
    observed.set('negative equity', { commit: deficit.committed?.status, lines: lines(deficit.report, accD), totals: { assets: deficit.report.totals['assets'], liabilities: deficit.report.totals['liabilities'], equity: deficit.report.totals['equity'] }, balances: Object.fromEntries(Object.entries(accD).map(([k, id]) => [k, nb(balD, id)])) });
    evidence('P05-S3-01', { observed: Object.fromEntries(observed) });
    assert.deepEqual(observed.get('0.01 difference'), { validate: 200, state: 'DRAFT', codes: ['BALANCE_DIFFERENCE', 'LEDGER_DIFFERENCE'], balanceDifference: '0.01', approveDraft: '409 OPENING_STATE_CONFLICT', journals: 0 });
    const e1 = observed.get('example 1 lifecycle') as Record<string, unknown>;
    assert.equal(e1['put'], '200 DRAFT cv=2'); assert.equal(e1['validate'], '200 VALIDATED'); assert.equal(e1['approve'], 200); assert.equal(e1['commit'], 201); assert.equal(e1['fingerprintKeptThroughApprove'], true);
    assert.deepEqual(e1['lines'], ['ASSET 300.00/0.00', 'BANK 100.00/0.00', 'EQ 0.00/450.00', 'LIAB 0.00/150.00', 'PRIN 200.00/0.00']);
    assert.deepEqual(observed.get('ledger after commit'), { journals: 1, openingLines: 5, debitCents: '60000', creditCents: '60000', effectiveDate: true, source: 'OPENING id=file:true' });
    assert.deepEqual(observed.get('balances at C'), { BANK: '100.00', PRIN: '200.00', ASSET: '300.00', LIAB: '150.00', EQ: '450.00', CASH: '0.00' });
    assert.deepEqual(observed.get('balances at C-1 and at C before commit recorded'), { cMinus1: true, recordedBefore: true });
    assert.equal((observed.get('materialized references') as Record<string, unknown>)['principalOutstanding'], '200.00');
    assert.deepEqual(observed.get('posted file'), { status: 'POSTED', lineMapComponents: 5 });
    const after = observed.get('after posting') as Record<string, unknown>;
    assert.equal(after['s2AtCutoff'], '409 OPENING_CUTOFF_CONFLICT'); assert.equal(after['s2BeforeCutoff'], '409 OPENING_CUTOFF_CONFLICT'); assert.equal(after['s2AfterCutoff'], 201);
    assert.equal(after['reverseOpening'], '409 OPENING_IMMUTABLE'); assert.equal(after['secondOpening'], '409 OPENING_ALREADY_POSTED'); assert.equal(after['replayCommit'], '200 sameJournal=true');
    assert.match(String(after['commitNewKey']), /^409 /); assert.equal(after['editPosted'], '409 OPENING_IMMUTABLE'); assert.equal(after['s2ListShowsOpening'], '200 OPENING visible'); assert.equal(after['openingJournalsAfterAll'], 1);
    assert.deepEqual(observed.get('recognized interest'), { commit: 201, lines: ['HIST 0.00/220.00', 'INT 20.00/0.00', 'PRIN 200.00/0.00'], principal: '200.00', recognizedInterest: '20.00', balances: { PRIN: '200.00', INT: '20.00', HIST: '220.00' } });
    assert.deepEqual(observed.get('informational interest'), { commit: 201, lines: ['EQ 0.00/200.00', 'PRIN 200.00/0.00'], informationalInterest: '20.00', balances: { PRIN: '200.00', EQ: '200.00' } });
    assert.deepEqual(observed.get('negative equity'), { commit: 201, lines: ['BANK 50.00/0.00', 'EQ 50.00/0.00', 'LIAB 0.00/100.00'], totals: { assets: '50.00', liabilities: '100.00', equity: '-50.00' }, balances: { BANK: '50.00', LIAB: '100.00', EQ: '-50.00' } });
  } finally { await f.close(); }
});

test('P05-S3-02 rejections: schema 422 before R (money/date/ownership), semantic issues reported 200 DRAFT without journal (support/reference/mapping/date/duplicates/interest policy/opposite equity), operated book not eligible even at net zero', { timeout: 600000 }, async () => {
  const f = await financeFixture();
  try {
    const h = await harness(f), t = today(f.now()), C = day(t, -3), observed = new Map<string, unknown>();
    const A = await h.tenant(), acc: Record<string, string> = {};
    for (const [code, cls, kind] of [['BANK', 'ASSET', 'BANK'], ['PRIN', 'ASSET', 'GENERAL'], ['ASSET', 'ASSET', 'GENERAL'], ['LIAB', 'LIABILITY', 'GENERAL'], ['EQ', 'EQUITY', 'GENERAL'], ['INT', 'ASSET', 'GENERAL'], ['HIST', 'EQUITY', 'GENERAL'], ['INCOME', 'INCOME', 'GENERAL']] as const) acc[code] = await h.account(A.c, A.a, A.org, code, cls, kind);
    const base = () => JSON.parse(JSON.stringify(example1(C, acc).snapshot)) as Snapshot & Record<string, unknown>;
    // Schema-level (no R needed).
    const schema: Record<string, string> = {};
    const bad = async (label: string, mutate: (s: Record<string, unknown>) => void, extra: Record<string, unknown> = {}) => { const s = base() as unknown as Record<string, unknown>; mutate(s); const res = await h.op(A.c, A.a, A.org, 'create', { snapshot: s, ...extra }, { skipR: true }); schema[label] = status(res); };
    const comp = (s: Record<string, unknown>, i: number) => (s['components'] as Record<string, unknown>[])[i]!;
    await bad('principal 0.00', s => { comp(s, 1)['amount'] = '0.00'; });
    await bad('amount 1999.5', s => { comp(s, 0)['amount'] = '1999.5'; });
    await bad('amount as JSON number', s => { comp(s, 0)['amount'] = 100; });
    await bad('equity -0.00', s => { comp(s, 4)['amount'] = '-0.00'; });
    await bad('negative bank', s => { comp(s, 0)['amount'] = '-100.00'; });
    await bad('cutoff 2026-02-30', s => { s['cutoffDate'] = '2026-02-30'; });
    await bad('bookId injected', s => { s['bookId'] = randomUUID(); });
    await bad('ownerId on component', s => { comp(s, 0)['ownerId'] = randomUUID(); });
    await bad('no supports', s => { s['supports'] = []; });
    await bad('INCOME category', s => { comp(s, 0)['category'] = 'INCOME'; });
    await bad('predecessorId not uuid', () => undefined, { predecessorId: 'x' });
    observed.set('schema rejections', schema);
    // Future cutoff passes the schema and must be refused by the server.
    const future = base(); future.cutoffDate = day(t, 1);
    observed.set('future cutoff', status(await h.op(A.c, A.a, A.org, 'create', { snapshot: future })));
    // Semantic issues: one draft, replaced per variant, validated each time.
    const created = await h.op(A.c, A.a, A.org, 'create', { snapshot: base() });
    const id = String(created.body.data?.['id']); let etagNow = String(created.headers['etag']);
    const issues: Record<string, string[]> = {};
    const variant = async (label: string, mutate: (s: Snapshot & Record<string, unknown>) => void) => {
      const s = base(); mutate(s);
      const put = await h.op(A.c, A.a, A.org, 'replace', { snapshot: s, changeReason: `Variante ${label}` }, { id, etag: etagNow }); assert.equal(put.status, 200, `PUT ${label}`);
      const v = await h.op(A.c, A.a, A.org, 'validate', { policyVersion: 'S03-OPENING-0.1' }, { id, etag: String(put.headers['etag']) });
      etagNow = String(v.headers['etag']);
      issues[label] = [...new Set((v.body.data?.['report'] as Report).issues.map(i => i.code))].sort().concat(`state=${(v.body.data?.['opening'] as Record<string, string>)['status']}`);
    };
    const c = (s: Snapshot, i: number) => s.components[i] as unknown as Record<string, unknown>;
    await variant('unknown support id', s => { c(s, 0)['supportIds'] = [randomUUID()]; });
    await variant('unused obligation reference', s => { s.components.splice(3, 1); s.components[3]!.amount = '600.00'; });
    await variant('duplicate external reference', s => { (s.references as unknown[])[2] = { id: s.references[2]!.id, type: 'HISTORICAL_LOAN', externalReference: 'P05-L-1', supportIds: [s.supports[0]!.id], borrowerId: s.references[0]!.id, originationDate: day(C, -5) }; });
    await variant('loan origination after cutoff', s => { (s.references[1] as Record<string, unknown>)['originationDate'] = day(C, 1); });
    await variant('support asOf after cutoff', s => { s.supports[0]!.asOfDate = day(C, 1); });
    await variant('loan borrowerId not a borrower', s => { (s.references[1] as Record<string, unknown>)['borrowerId'] = s.references[2]!.id; });
    await variant('BANK component on GENERAL account', s => { c(s, 0)['accountId'] = acc['ASSET']; });
    await variant('equity on INCOME account', s => { c(s, 4)['accountId'] = acc['INCOME']; });
    await variant('principal and asset share an account', s => { c(s, 2)['accountId'] = acc['PRIN']; });
    await variant('two principal positions for one loan', s => { s.components.push({ ...s.components[1]!, id: randomUUID(), amount: '1.00' }); s.components[4]!.amount = '451.00'; });
    await variant('opposite equity kinds on one account', s => { s.components.push({ id: randomUUID(), category: 'EQUITY', accountId: acc['EQ']!, amount: '-10.00', supportIds: [s.supports[0]!.id], equityKind: 'OTHER_DECLARED' } as never); s.components[4]!.amount = '460.00'; });
    await variant('recognized interest against CONTRIBUTED equity', s => { s.historicalInterest.push({ id: randomUUID(), loanReferenceId: s.references[1]!.id, amount: '20.00', treatment: 'RECOGNIZED_OPENING', supportIds: [s.supports[0]!.id], accountId: acc['INT']!, recognitionDeclaration: 'Declarado', equityComponentId: s.components[4]!.id } as never); s.components[4]!.amount = '470.00'; });
    await variant('recognized interest on the principal account', s => { const eq = randomUUID(); s.components.push({ id: eq, category: 'EQUITY', accountId: acc['HIST']!, amount: '20.00', supportIds: [s.supports[0]!.id], equityKind: 'HISTORICAL_RESULTS' } as never); s.historicalInterest.push({ id: randomUUID(), loanReferenceId: s.references[1]!.id, amount: '20.00', treatment: 'RECOGNIZED_OPENING', supportIds: [s.supports[0]!.id], accountId: acc['PRIN']!, recognitionDeclaration: 'Declarado', equityComponentId: eq } as never); });
    await variant('historical-results equity smaller than recognized interest', s => { const eq = randomUUID(); s.components.push({ id: eq, category: 'EQUITY', accountId: acc['HIST']!, amount: '10.00', supportIds: [s.supports[0]!.id], equityKind: 'HISTORICAL_RESULTS' } as never); s.components[4]!.amount = '460.00'; s.historicalInterest.push({ id: randomUUID(), loanReferenceId: s.references[1]!.id, amount: '20.00', treatment: 'RECOGNIZED_OPENING', supportIds: [s.supports[0]!.id], accountId: acc['INT']!, recognitionDeclaration: 'Declarado', equityComponentId: eq } as never); });
    observed.set('semantic issues (all must stay DRAFT)', issues);
    observed.set('journals in org after all validations', await f.database.db.collection('financial_journals').countDocuments({ organizationId: A.org }));
    // Operated book: an S2 entry and its compensation (net zero) make the book ineligible.
    const B = await h.tenant(), bank = await h.account(B.c, B.a, B.org, 'BANK', 'ASSET', 'BANK'), eq = await h.account(B.c, B.a, B.org, 'EQ', 'EQUITY');
    const posted = await h.fin(B.c, B.a, B.org, 'FINANCE_JOURNAL_POST', '/journal-entries', { currency: 'COP', effectiveDate: day(t, -1), sourceId: randomUUID(), supportReference: 'P05', description: 'Aporte', lines: [{ accountId: bank, debit: '5.00', credit: '0.00' }, { accountId: eq, debit: '0.00', credit: '5.00' }] });
    const rev = await h.fin(B.c, B.a, B.org, 'FINANCE_JOURNAL_REVERSE', `/journal-entries/${String(posted.body.data?.['id'])}/reversals`, { effectiveDate: t, sourceId: randomUUID(), supportReference: 'P05', reason: 'Compensa' }, { id: String(posted.body.data?.['id']), etag: String(posted.headers['etag']) });
    const sb = sup(day(t, -5));
    const ineligible = await h.op(B.c, B.a, B.org, 'create', { snapshot: { cutoffDate: day(t, -5), supports: [sb], references: [], components: [{ id: randomUUID(), category: 'BANK', accountId: bank, amount: '1.00', supportIds: [sb.id] }, { id: randomUUID(), category: 'EQUITY', accountId: eq, amount: '1.00', supportIds: [sb.id], equityKind: 'CONTRIBUTED' }], historicalInterest: [], informationalHistory: [] } });
    observed.set('operated book at net zero', { posted: posted.status, reversed: rev.status, create: status(ineligible), openingFiles: await f.database.db.collection('opening_files').countDocuments({ organizationId: B.org }) });
    evidence('P05-S3-02', { observed: Object.fromEntries(observed) });
    for (const [k, v] of Object.entries(schema)) assert.equal(v, '422 INPUT_INVALID', k);
    assert.equal(observed.get('future cutoff'), '422 INPUT_INVALID');
    const expect: Record<string, string> = { 'unknown support id': 'SUPPORT_REQUIRED', 'unused obligation reference': 'REFERENCE_INVALID', 'duplicate external reference': 'REFERENCE_DUPLICATE', 'loan origination after cutoff': 'DATE_INVALID',
      'support asOf after cutoff': 'DATE_INVALID', 'loan borrowerId not a borrower': 'REFERENCE_INVALID', 'BANK component on GENERAL account': 'ACCOUNT_MAPPING_INVALID', 'equity on INCOME account': 'ACCOUNT_MAPPING_INVALID',
      'principal and asset share an account': 'ACCOUNT_MAPPING_INVALID', 'two principal positions for one loan': 'DUPLICATE_POSITION', 'opposite equity kinds on one account': 'ACCOUNT_MAPPING_INVALID',
      'recognized interest against CONTRIBUTED equity': 'INTEREST_POLICY_INVALID', 'recognized interest on the principal account': 'ACCOUNT_MAPPING_INVALID', 'historical-results equity smaller than recognized interest': 'INTEREST_POLICY_INVALID' };
    for (const [k, code] of Object.entries(expect)) { assert.ok(issues[k]?.includes(code), `${k} -> ${code} (${issues[k]?.join(',')})`); assert.ok(issues[k]?.includes('state=DRAFT'), `${k} DRAFT`); }
    assert.equal(observed.get('journals in org after all validations'), 0);
    assert.deepEqual(observed.get('operated book at net zero'), { posted: 201, reversed: 201, create: '409 BOOK_NOT_ELIGIBLE', openingFiles: 0 });
  } finally { await f.close(); }
});

test('P05-S3-03 state machine, stale and concurrency: rename after approval -> 409 STALE without ledger; PUT invalidates approval; ETag 428/412; cancel + predecessor; two sessions commit once; S2 posting vs commit race; revocation before commit; injected evidence failure rolls everything back and keeps R', { timeout: 600000 }, async () => {
  const f = await financeFixture();
  try {
    const h = await harness(f), t = today(f.now()), C = day(t, -3), observed = new Map<string, unknown>();
    const setupOrg = async () => { const T = await h.tenant(), acc: Record<string, string> = {}; for (const [code, cls, kind] of [['BANK', 'ASSET', 'BANK'], ['PRIN', 'ASSET', 'GENERAL'], ['ASSET', 'ASSET', 'GENERAL'], ['LIAB', 'LIABILITY', 'GENERAL'], ['EQ', 'EQUITY', 'GENERAL']] as const) acc[code] = await h.account(T.c, T.a, T.org, code, cls, kind); return { ...T, acc }; };
    const toApproved = async (T: Awaited<ReturnType<typeof setupOrg>>) => {
      const cr = await h.op(T.c, T.a, T.org, 'create', { snapshot: example1(C, T.acc).snapshot }), id = String(cr.body.data?.['id']);
      const v = await h.op(T.c, T.a, T.org, 'validate', { policyVersion: 'S03-OPENING-0.1' }, { id, etag: String(cr.headers['etag']) });
      const val = v.body.data?.['validation'] as { id: string; fingerprint: string }, binding = { validationId: val.id, validationFingerprint: val.fingerprint };
      const ap = await h.op(T.c, T.a, T.org, 'approve', binding, { id, etag: String(v.headers['etag']) });
      return { id, binding, etag: String(ap.headers['etag']), approve: ap.status, created: cr };
    };
    // 1) Stale by external rename after approval.
    const S = await setupOrg(), sa = await toApproved(S);
    const accRow = await S.c.call('GET', `${h.base(S.org)}/accounts/${S.acc['EQ']}`);
    const rename = await h.fin(S.c, S.a, S.org, 'FINANCE_ACCOUNT_UPDATE', `/accounts/${S.acc['EQ']}`, { name: 'Patrimonio renombrado' }, { id: S.acc['EQ']!, etag: String(accRow.headers['etag']) });
    const staleCommit = await h.op(S.c, S.a, S.org, 'commit', sa.binding, { id: sa.id, etag: sa.etag });
    const noIfMatch = await S.c.call('POST', `${h.base(S.org)}/opening-files/${sa.id}/commit`, sa.binding, { 'Idempotency-Key': randomUUID() });
    const wrongEtag = await h.op(S.c, S.a, S.org, 'commit', sa.binding, { id: sa.id, etag: `"${sa.id}:1"` });
    const put = await h.op(S.c, S.a, S.org, 'replace', { snapshot: example1(C, S.acc).snapshot, changeReason: 'Revalidar tras renombre' }, { id: sa.id, etag: sa.etag });
    const oldBindingAfterPut = await h.op(S.c, S.a, S.org, 'commit', sa.binding, { id: sa.id, etag: String(put.headers['etag']) });
    observed.set('stale and invalidation', { approve: sa.approve, rename: rename.status, commitAfterRename: status(staleCommit), noIfMatch: status(noIfMatch as Reply), wrongEtag: status(wrongEtag), putAfterApproval: `${put.status} ${(put.body.data as Record<string, unknown>)['status']} approval=${(put.body.data as Record<string, unknown>)['approval'] === null}`,
      oldBindingAfterPut: status(oldBindingAfterPut), journals: await f.database.db.collection('financial_journals').countDocuments({ organizationId: S.org }) });
    // Cancel and predecessor rules.
    const cancel = await h.op(S.c, S.a, S.org, 'cancel', { reason: 'Se rehace' }, { id: sa.id, etag: String(put.headers['etag']) });
    const editCancelled = await h.op(S.c, S.a, S.org, 'replace', { snapshot: example1(C, S.acc).snapshot, changeReason: 'x' }, { id: sa.id, etag: String(cancel.headers['etag']) });
    const next = await h.op(S.c, S.a, S.org, 'create', { snapshot: example1(C, S.acc).snapshot, predecessorId: sa.id });
    const third = await h.op(S.c, S.a, S.org, 'create', { snapshot: example1(C, S.acc).snapshot, predecessorId: String(next.body.data?.['id']) });
    observed.set('cancel/predecessor', { cancel: `${cancel.status} ${(cancel.body.data as Record<string, unknown>)['status']}`, editCancelled: status(editCancelled), newWithCancelledPredecessor: next.status, secondActiveOrActivePredecessor: status(third) });
    // 2) Two sessions, same command and key, both with their own R: one effect.
    const P = await setupOrg(), pa = await toApproved(P), second = await f.login(P.a), c2 = await h.client(second);
    const key = randomUUID(), command = { organizationId: P.org, idempotencyKey: key, payload: pa.binding, expectedETag: pa.etag };
    assert.equal(await h.r(P.c, P.a, 'OPENING_COMMIT', command, pa.id), 200); assert.equal(await h.r(c2, second, 'OPENING_COMMIT', command, pa.id), 200);
    const both = await Promise.all([P.c, c2].map(cl => cl.call('POST', `${h.base(P.org)}/opening-files/${pa.id}/commit`, pa.binding, { 'Idempotency-Key': key, 'If-Match': pa.etag })));
    const conflict = await h.op(P.c, P.a, P.org, 'commit', { validationId: pa.binding.validationId, validationFingerprint: 'b'.repeat(64) }, { id: pa.id, etag: pa.etag, key });
    observed.set('concurrent commit', { statuses: both.map(x => x.status).sort(), sameBody: JSON.stringify(both[0]?.body.data) === JSON.stringify(both[1]?.body.data), journals: await f.database.db.collection('financial_journals').countDocuments({ organizationId: P.org }),
      replayAudits: await f.database.db.collection('audit_events').countDocuments({ action: 'OPENING_REPLAY' }), sameKeyOtherPayload: status(conflict) });
    // 3) S2 posting dated <= C racing the commit: exactly one establishes the initial position.
    const Q = await setupOrg(), qa = await toApproved(Q), kc = randomUUID(), ks = randomUUID();
    const s2 = { currency: 'COP', effectiveDate: day(C, -1), sourceId: randomUUID(), supportReference: 'P05', description: 'Carrera', lines: [{ accountId: Q.acc['BANK']!, debit: '1.00', credit: '0.00' }, { accountId: Q.acc['EQ']!, debit: '0.00', credit: '1.00' }] };
    assert.equal(await h.r(Q.c, Q.a, 'OPENING_COMMIT', { organizationId: Q.org, idempotencyKey: kc, payload: qa.binding, expectedETag: qa.etag }, qa.id), 200);
    const q2 = await f.login(Q.a), cq2 = await h.client(q2);
    assert.equal(await h.r(cq2, q2, 'FINANCE_JOURNAL_POST', { organizationId: Q.org, idempotencyKey: ks, payload: s2 }), 200);
    const race = await Promise.all([Q.c.call('POST', `${h.base(Q.org)}/opening-files/${qa.id}/commit`, qa.binding, { 'Idempotency-Key': kc, 'If-Match': qa.etag }), cq2.call('POST', `${h.base(Q.org)}/journal-entries`, s2, { 'Idempotency-Key': ks })]);
    const qj = await f.database.db.collection('financial_journals').find({ organizationId: Q.org }).toArray();
    observed.set('S2 vs commit race', { commit: status(race[0]!), s2: status(race[1]!), journals: qj.length, types: qj.map(j => (j['source'] as { type: string }).type).sort(), successes: race.filter(x => x.status === 201).length });
    // 4) Revocation between approval and commit; then authorization restored (new authzVersion) -> old validation is stale.
    const R = await setupOrg(), ra = await toApproved(R), subject = R.a.issued.context.subjectId!;
    const rk = randomUUID(); assert.equal(await h.r(R.c, R.a, 'OPENING_COMMIT', { organizationId: R.org, idempotencyKey: rk, payload: ra.binding, expectedETag: ra.etag }, ra.id), 200);
    await f.identity.identities.updateOne({ _id: subject }, { $set: { roles: ['A'], authzVersion: randomUUID() } });
    const revoked = await R.c.call('POST', `${h.base(R.org)}/opening-files/${ra.id}/commit`, ra.binding, { 'Idempotency-Key': rk, 'If-Match': ra.etag });
    await f.identity.identities.updateOne({ _id: subject }, { $set: { roles: ['T'], authzVersion: randomUUID() } });
    const back = await f.login(R.a), cb = await h.client(back);
    const afterRestore = await h.op(cb, back, R.org, 'commit', ra.binding, { id: ra.id, etag: ra.etag });
    observed.set('revocation before commit', { revoked: status(revoked), afterRoleRestored: status(afterRestore), journals: await f.database.db.collection('financial_journals').countDocuments({ organizationId: R.org }) });
    // 5) Injected failure inside the commit transaction (evidence head write rejected): no ledger/references/marker/idempotency, R kept.
    const F = await setupOrg(), fa = await toApproved(F), fk = randomUUID();
    assert.equal(await h.r(F.c, F.a, 'OPENING_COMMIT', { organizationId: F.org, idempotencyKey: fk, payload: fa.binding, expectedETag: fa.etag }, fa.id), 200);
    await f.database.db.command({ collMod: 'financial_evidence_head', validator: { $expr: { $eq: [1, 0] } }, validationAction: 'error' });
    let failed: Reply;
    try { failed = await F.c.call('POST', `${h.base(F.org)}/opening-files/${fa.id}/commit`, fa.binding, { 'Idempotency-Key': fk, 'If-Match': fa.etag }); }
    finally { await f.database.db.command({ collMod: 'financial_evidence_head', validator: {}, validationAction: 'error' }); }
    const state = { status: status(failed), journals: await f.database.db.collection('financial_journals').countDocuments({ organizationId: F.org }), references: await f.database.db.collection('opening_references').countDocuments({ organizationId: F.org }),
      marker: Boolean((await f.database.db.collection('financial_books').findOne({ _id: F.org as never }))?.['openingId']), idempotency: await f.database.db.collection('opening_idempotency').countDocuments({ organizationId: F.org, operation: 'commitOpening' }),
      fileStatus: (await F.c.call('GET', `${h.base(F.org)}/opening-files/${fa.id}`)).body.data?.['status'], rConsumed: (await f.context(F.a.issued.context)).reauth?.consumed ?? 'n/a' };
    const retry = await F.c.call('POST', `${h.base(F.org)}/opening-files/${fa.id}/commit`, fa.binding, { 'Idempotency-Key': fk, 'If-Match': fa.etag });
    observed.set('injected evidence failure', { ...state, retrySameCommandSameR: retry.status, journalsAfterRetry: await f.database.db.collection('financial_journals').countDocuments({ organizationId: F.org }) });
    evidence('P05-S3-03', { observed: Object.fromEntries(observed) });
    assert.deepEqual(observed.get('stale and invalidation'), { approve: 200, rename: 200, commitAfterRename: '409 OPENING_VALIDATION_STALE', noIfMatch: '428 ETAG_REQUIRED', wrongEtag: '412 PRECONDITION_FAILED', putAfterApproval: '200 DRAFT approval=true', oldBindingAfterPut: '409 OPENING_STATE_CONFLICT', journals: 0 });
    const cp = observed.get('cancel/predecessor') as Record<string, unknown>;
    assert.equal(cp['cancel'], '200 CANCELLED'); assert.equal(cp['editCancelled'], '409 OPENING_STATE_CONFLICT'); assert.equal(cp['newWithCancelledPredecessor'], 201); assert.match(String(cp['secondActiveOrActivePredecessor']), /^409 /);
    const cc = observed.get('concurrent commit') as Record<string, unknown>;
    assert.deepEqual(cc['statuses'], [200, 201]); assert.equal(cc['sameBody'], true); assert.equal(cc['journals'], 1); assert.equal(cc['sameKeyOtherPayload'], '409 IDEMPOTENCY_CONFLICT');
    const rc = observed.get('S2 vs commit race') as Record<string, unknown>; assert.equal(rc['successes'], 1); assert.equal(rc['journals'], 1);
    const rv = observed.get('revocation before commit') as Record<string, unknown>; assert.match(String(rv['revoked']), /^40[13] /); assert.equal(rv['afterRoleRestored'], '409 OPENING_VALIDATION_STALE'); assert.equal(rv['journals'], 0);
    const inj = observed.get('injected evidence failure') as Record<string, unknown>;
    assert.match(String(inj['status']), /^503 /); assert.deepEqual([inj['journals'], inj['references'], inj['marker'], inj['idempotency'], inj['fileStatus'], inj['rConsumed']], [0, 0, false, 0, 'APPROVED', false]);
    assert.equal(inj['retrySameCommandSameR'], 201); assert.equal(inj['journalsAfterRetry'], 1);
  } finally { await f.close(); }
});

test('P05-S3-04 isolation, roles, R binding and transport: foreign org/file/cursor 404/422; A/O/C/P/L/SA/T+SA 403; L 401; PLATFORM 403; R of another purpose/payload 403; CSRF 400; F04.1 404/405+Allow vs 503 real; F04.3 duplicate code 409; F04.2 suspended org 401', { timeout: 600000 }, async () => {
  const f = await financeFixture();
  try {
    const h = await harness(f), t = today(f.now()), C = day(t, -3), observed = new Map<string, unknown>();
    const A = await h.tenant(), B = await h.tenant(), accA: Record<string, string> = {}, accB: Record<string, string> = {};
    for (const [code, cls, kind] of [['BANK', 'ASSET', 'BANK'], ['PRIN', 'ASSET', 'GENERAL'], ['ASSET', 'ASSET', 'GENERAL'], ['LIAB', 'LIABILITY', 'GENERAL'], ['EQ', 'EQUITY', 'GENERAL']] as const) { accA[code] = await h.account(A.c, A.a, A.org, code, cls, kind); accB[code] = await h.account(B.c, B.a, B.org, code, cls, kind); }
    const fileB = await h.op(B.c, B.a, B.org, 'create', { snapshot: example1(C, accB).snapshot }), idB = String(fileB.body.data?.['id']);
    const fileA = await h.op(A.c, A.a, A.org, 'create', { snapshot: example1(C, accA).snapshot }), idA = String(fileA.body.data?.['id']);
    const x: Record<string, string> = {};
    x['GET foreign file (foreign path)'] = status(await A.c.call('GET', `${h.base(B.org)}/opening-files/${idB}`));
    x['GET foreign file (own path)'] = status(await A.c.call('GET', `${h.base(A.org)}/opening-files/${idB}`));
    x['LIST foreign org'] = status(await A.c.call('GET', `${h.base(B.org)}/opening-files`));
    x['POST foreign commit, no CSRF/R'] = status(await A.c.call('POST', `${h.base(B.org)}/opening-files/${idB}/commit`, {}, { 'X-CSRF-Token': 'x' }));
    x['A32 for foreign file'] = String(await h.r(A.c, A.a, 'OPENING_VALIDATE', { organizationId: A.org, idempotencyKey: randomUUID(), payload: { policyVersion: 'S03-OPENING-0.1' }, expectedETag: `"${idB}:1"` }, idB));
    x['own snapshot referencing foreign account'] = '';
    const cross = example1(C, accA).snapshot; cross.components[0]!.accountId = accB['BANK']!;
    const crossPut = await h.op(A.c, A.a, A.org, 'replace', { snapshot: cross, changeReason: 'Cuenta ajena' }, { id: idA, etag: String(fileA.headers['etag']) });
    const crossVal = await h.op(A.c, A.a, A.org, 'validate', { policyVersion: 'S03-OPENING-0.1' }, { id: idA, etag: String(crossPut.headers['etag']) });
    x['own snapshot referencing foreign account'] = `${crossVal.status} ${[...new Set((crossVal.body.data?.['report'] as Report).issues.map(i => i.code))].join(',')} leaksForeignName=${JSON.stringify(crossVal.body).includes('Cuenta BANK')}`;
    const pageA = await A.c.call('GET', `${h.base(A.org)}/opening-files?limit=1`);
    await h.op(A.c, A.a, A.org, 'cancel', { reason: 'otra' }, { id: idA, etag: String(crossVal.headers['etag']) }); await h.op(A.c, A.a, A.org, 'create', { snapshot: example1(C, accA).snapshot, predecessorId: idA });
    const page1 = await A.c.call('GET', `${h.base(A.org)}/opening-files?limit=1`), cursor = String(page1.body.data?.['nextCursor']);
    x['cursor of A replayed by B'] = status(await B.c.call('GET', `${h.base(B.org)}/opening-files?limit=1&cursor=${encodeURIComponent(cursor)}`));
    x['cursor with other limit'] = status(await A.c.call('GET', `${h.base(A.org)}/opening-files?limit=2&cursor=${encodeURIComponent(cursor)}`));
    x['unknown query'] = status(await A.c.call('GET', `${h.base(A.org)}/opening-files?scope=PERSONAL`));
    observed.set('cross-tenant', x); observed.set('page sizes', [pageA.status, (page1.body.data?.['items'] as unknown[]).length]);
    // Roles and session states.
    const subject = A.a.issued.context.subjectId!, roles: Record<string, string> = {};
    for (const role of [['A'], ['O'], ['C'], ['P'], ['L'], ['SA'], ['T', 'SA']]) {
      await f.identity.identities.updateOne({ _id: subject }, { $set: { roles: role } });
      roles[role.join('+')] = `GET ${status(await A.c.call('GET', `${h.base(A.org)}/opening-files`))} / POST ${status(await A.c.call('POST', `${h.base(A.org)}/opening-files`, { snapshot: {} }, { 'Idempotency-Key': randomUUID() }))}`;
    }
    await f.identity.identities.updateOne({ _id: subject }, { $set: { roles: ['T'] } });
    observed.set('roles', roles);
    const login = await f.identity.login('TENANT', randomUUID(), A.a.email, f.password), lc = await h.client({ ...A.a, issued: login.issued } as Actor);
    const plat = await h.client(A.a, 'platform.localhost');
    const s: Record<string, string> = {
      'L password-only': status(await lc.call('GET', `${h.base(A.org)}/opening-files`)),
      'PLATFORM host': status(await plat.call('GET', `${h.base(A.org)}/opening-files`)),
      'A32 opening purpose on PLATFORM': String((await plat.call('POST', '/api/v1/auth/reauthenticate', { password: f.password, purpose: 'OPENING_CREATE', command: { organizationId: A.org, idempotencyKey: randomUUID(), payload: { snapshot: example1(C, accA).snapshot } } })).status) };
    // R binding over HTTP.
    const snap = example1(C, accA).snapshot, k1 = randomUUID();
    assert.equal(await h.r(A.c, A.a, 'FINANCE_JOURNAL_POST', { organizationId: A.org, idempotencyKey: k1, payload: { currency: 'COP', effectiveDate: C, sourceId: randomUUID(), supportReference: 'x', description: 'x', lines: [{ accountId: accA['BANK']!, debit: '1.00', credit: '0.00' }, { accountId: accA['EQ']!, debit: '0.00', credit: '1.00' }] } }), 200);
    s['finance R used for opening create'] = status(await A.c.call('POST', `${h.base(A.org)}/opening-files`, { snapshot: snap }, { 'Idempotency-Key': k1 }));
    const k2 = randomUUID(); assert.equal(await h.r(A.c, A.a, 'OPENING_CREATE', { organizationId: A.org, idempotencyKey: k2, payload: { snapshot: snap } }), 200);
    const altered = JSON.parse(JSON.stringify(snap)) as Snapshot; altered.components[0]!.amount = '101.00';
    s['R for other payload'] = status(await A.c.call('POST', `${h.base(A.org)}/opening-files`, { snapshot: altered }, { 'Idempotency-Key': k2 }));
    s['CSRF wrong'] = status(await A.c.call('POST', `${h.base(A.org)}/opening-files`, { snapshot: snap }, { 'Idempotency-Key': k2, 'X-CSRF-Token': 'bad' }));
    s['Origin other'] = status(await A.c.call('POST', `${h.base(A.org)}/opening-files`, { snapshot: snap }, { 'Idempotency-Key': k2, Origin: 'https://evil.example' }));
    observed.set('session/R/CSRF', s);
    // F04 transport.
    const tr: Record<string, string> = {};
    const allow = async (label: string, method: string, path: string, client = A.c) => { const res = await client.call(method, path, method === 'GET' || method === 'HEAD' || method === 'DELETE' || method === 'OPTIONS' ? undefined : {}, { 'Idempotency-Key': randomUUID() }); tr[label] = `${status(res)}${res.headers['allow'] ? ' Allow=' + String(res.headers['allow']) : ''}`; };
    await allow('unknown financial route', 'GET', `${h.base(A.org)}/no-such-thing`);
    await allow('DELETE on opening-files collection', 'DELETE', `${h.base(A.org)}/opening-files`);
    await allow('PATCH on opening-files/{id}', 'PATCH', `${h.base(A.org)}/opening-files/${idA}`);
    await allow('HEAD on opening-files', 'HEAD', `${h.base(A.org)}/opening-files`);
    await allow('OPTIONS on opening-files', 'OPTIONS', `${h.base(A.org)}/opening-files`);
    await allow('DELETE on accounts/{id}', 'DELETE', `${h.base(A.org)}/accounts/${accA['BANK']}`);
    await allow('unknown non-financial route', 'GET', '/api/v1/no-such-route');
    const anon = new ApiClient(A.c.port, A.c.cert); await anon.refreshCsrf();
    tr['valid GET without session'] = status(await anon.call('GET', `${h.base(A.org)}/opening-files`));
    const dup = await h.fin(A.c, A.a, A.org, 'FINANCE_ACCOUNT_CREATE', '/accounts', { code: 'BANK', name: 'Duplicada', accountClass: 'ASSET', kind: 'BANK', currency: 'COP' });
    tr['F04.3 duplicate account code'] = status(dup);
    await f.runtime.organizations.organizations.updateOne({ _id: A.org }, { $set: { status: 'SUSPENDED' } });
    tr['F04.2 suspended org (HTTP)'] = status(await A.c.call('GET', `${h.base(A.org)}/opening-files`));
    await f.runtime.organizations.organizations.updateOne({ _id: A.org }, { $set: { status: 'ACTIVE' } });
    // Real closure (restore gate): unknown and known routes must answer 503, not 404.
    const snapshotCut = await f.restore.snapshot(); await f.restore.beginRestore(snapshotCut);
    await allow('unknown route while realm closed', 'GET', `${h.base(A.org)}/no-such-thing`, anon);
    await allow('DELETE known template while realm closed', 'DELETE', `${h.base(A.org)}/opening-files`, anon);
    tr['valid GET while realm closed'] = status(await anon.call('GET', `${h.base(A.org)}/opening-files`));
    await f.restore.reconcile({ approved: true, reviewId: 'P05-S3-transport-closure' });
    observed.set('transport', tr);
    evidence('P05-S3-04', { observed: Object.fromEntries(observed) });
    for (const k of ['GET foreign file (foreign path)', 'GET foreign file (own path)', 'LIST foreign org', 'POST foreign commit, no CSRF/R']) assert.equal(x[k], '404 RESOURCE_NOT_FOUND', k);
    assert.equal(x['A32 for foreign file'], '404'); assert.match(x['own snapshot referencing foreign account'] ?? '', /^200 .*ACCOUNT_INVALID.* leaksForeignName=false$/);
    assert.equal(x['cursor of A replayed by B'], '422 INPUT_INVALID'); assert.equal(x['cursor with other limit'], '422 INPUT_INVALID'); assert.equal(x['unknown query'], '422 INPUT_INVALID');
    for (const [k, v] of Object.entries(roles)) assert.equal(v, 'GET 403 ACCESS_DENIED / POST 403 ACCESS_DENIED', k);
    assert.equal(s['L password-only'], '401 AUTH_INVALID'); assert.equal(s['PLATFORM host'], '403 ACCESS_DENIED'); assert.notEqual(s['A32 opening purpose on PLATFORM'], '200');
    assert.equal(s['finance R used for opening create'], '403 R_REQUIRED'); assert.equal(s['R for other payload'], '403 R_REQUIRED'); assert.equal(s['CSRF wrong'], '400 CSRF_INVALID'); assert.equal(s['Origin other'], '400 CSRF_INVALID');
    assert.equal(tr['unknown financial route'], '404 ROUTE_NOT_FOUND'); assert.match(tr['DELETE on opening-files collection'] ?? '', /^405 METHOD_NOT_ALLOWED Allow=GET, POST$/);
    assert.match(tr['PATCH on opening-files/{id}'] ?? '', /^405 METHOD_NOT_ALLOWED Allow=GET, PUT$/); assert.match(tr['HEAD on opening-files'] ?? '', /^405/); assert.match(tr['OPTIONS on opening-files'] ?? '', /^405/);
    assert.match(tr['DELETE on accounts/{id}'] ?? '', /^405 METHOD_NOT_ALLOWED Allow=GET, PATCH$/); assert.equal(tr['unknown non-financial route'], '404 ROUTE_NOT_FOUND');
    assert.equal(tr['valid GET without session'], '401 AUTH_INVALID'); assert.match(tr['F04.3 duplicate account code'] ?? '', /^409 (INPUT_INVALID|SOURCE_CONFLICT)$/);
    assert.match(tr['F04.2 suspended org (HTTP)'] ?? '', /^(401 AUTH_INVALID|403 ACCESS_DENIED)$/);
    assert.equal(tr['unknown route while realm closed'], '503 SERVICE_UNAVAILABLE'); assert.equal(tr['DELETE known template while realm closed'], '503 SERVICE_UNAVAILABLE'); assert.equal(tr['valid GET while realm closed'], '503 SERVICE_UNAVAILABLE');
  } finally { await f.close(); }
});

test('P05-S3-05 restore with S3 sources: complete post-opening cut reconciles (same journal/file/references/marker); pre-opening cut and offline tampering of opening file/reference/marker/validation stay closed and reconcile refuses; live tamper characterized (F01, not asserted)', { timeout: 600000 }, async () => {
  const f = await financeFixture();
  try {
    const h = await harness(f), t = today(f.now()), C = day(t, -3), observed = new Map<string, unknown>();
    const A = await h.tenant(), acc: Record<string, string> = {};
    for (const [code, cls, kind] of [['BANK', 'ASSET', 'BANK'], ['PRIN', 'ASSET', 'GENERAL'], ['ASSET', 'ASSET', 'GENERAL'], ['LIAB', 'LIABILITY', 'GENERAL'], ['EQ', 'EQUITY', 'GENERAL']] as const) acc[code] = await h.account(A.c, A.a, A.org, code, cls, kind);
    const preOpening = await f.restore.snapshot();
    const life = await lifecycle(h, A.c, A.a, A.org, example1(C, acc).snapshot); assert.equal(life.committed?.status, 201);
    await f.restore.flush();
    const db = f.database.db, before = { journal: await db.collection('financial_journals').findOne({ organizationId: A.org }), file: await db.collection('opening_files').findOne({ _id: life.id as never }), refs: await db.collection('opening_references').countDocuments({ organizationId: A.org }), marker: (await db.collection('financial_books').findOne({ _id: A.org as never }))?.['openingId'] };
    const full = await f.restore.snapshot();
    await f.restore.beginRestore(full); await f.restore.reconcile({ approved: true, reviewId: 'P05-S3-full-cut' });
    const after = { journal: await db.collection('financial_journals').findOne({ organizationId: A.org }), file: await db.collection('opening_files').findOne({ _id: life.id as never }), refs: await db.collection('opening_references').countDocuments({ organizationId: A.org }), marker: (await db.collection('financial_books').findOne({ _id: A.org as never }))?.['openingId'] };
    observed.set('complete cut', { open: f.restore.isOpen(), sameJournal: JSON.stringify(before.journal) === JSON.stringify(after.journal), sameFile: JSON.stringify(before.file) === JSON.stringify(after.file), refs: `${before.refs}/${after.refs}`, marker: before.marker === after.marker && Boolean(after.marker) });
    const cases: Record<string, unknown> = {};
    const check = async (label: string, mutate: () => Promise<void>, revert: () => Promise<void>) => {
      await mutate();
      const c1 = new RestoreController(f.database, f.restore.gatePath, f.keys.journal); await c1.initialize(); const open = c1.isOpen();
      let rec = 'reconciled'; try { await c1.reconcile({ approved: true, reviewId: 'P05-S3-tampered' }); } catch (e) { rec = (e as { code?: string }).code ?? 'refused'; }
      await revert(); const c2 = new RestoreController(f.database, f.restore.gatePath, f.keys.journal); await c2.initialize(); if (!c2.isOpen()) await c2.reconcile({ approved: true, reviewId: 'P05-S3-exact-revert' });
      cases[label] = { openWhileTampered: open, reconcileWhileTampered: rec, openAfterExactRevertAndReview: c2.isOpen() };
    };
    const file = await db.collection('opening_files').findOne({ _id: life.id as never }) as Document, ref = await db.collection('opening_references').findOne({ organizationId: A.org, type: 'HISTORICAL_LOAN' }) as Document;
    const book = await db.collection('financial_books').findOne({ _id: A.org as never }) as Document, val = await db.collection('opening_validations').findOne({ openingId: life.id, operation: 'approveOpening' }) as Document;
    await check('opening file status rewritten', async () => { await db.collection('opening_files').updateOne({ _id: life.id as never }, { $set: { status: 'APPROVED' } }); }, async () => { await db.collection('opening_files').replaceOne({ _id: life.id as never }, file); });
    await check('reference principalOutstanding inflated', async () => { await db.collection('opening_references').updateOne({ _id: ref['_id'] }, { $set: { principalOutstanding: '2000.00' } }); }, async () => { await db.collection('opening_references').replaceOne({ _id: ref['_id'] }, ref); });
    await check('book cutoff marker moved', async () => { await db.collection('financial_books').updateOne({ _id: A.org as never }, { $set: { cutoffDate: '2000-01-01' } }); }, async () => { await db.collection('financial_books').updateOne({ _id: A.org as never }, { $set: { cutoffDate: book['cutoffDate'] } }); });
    await check('approval record deleted', async () => { await db.collection('opening_validations').deleteOne({ _id: val['_id'] }); }, async () => { await db.collection('opening_validations').insertOne(val); });
    observed.set('offline tampering', cases);
    // Live tampering (F01 characterization for S3 collections): edit a materialized reference while running, then a legitimate later command.
    const L = await f.login(A.a), cl = await h.client(L);
    await db.collection('opening_references').updateOne({ _id: ref['_id'] }, { $set: { principalOutstanding: '9999.00' } });
    const later = await h.fin(cl, L, A.org, 'FINANCE_JOURNAL_POST', '/journal-entries', { currency: 'COP', effectiveDate: day(C, 1), sourceId: randomUUID(), supportReference: 'P05', description: 'Posterior', lines: [{ accountId: acc['BANK']!, debit: '1.00', credit: '0.00' }, { accountId: acc['EQ']!, debit: '0.00', credit: '1.00' }] });
    await f.restore.flush();
    const live = new RestoreController(f.database, f.restore.gatePath, f.keys.journal); await live.initialize();
    observed.set('live tamper of opening reference then later command (F01)', { laterCommand: later.status, restartOpen: live.isOpen(), principalOutstandingNow: (await db.collection('opening_references').findOne({ _id: ref['_id'] }))?.['principalOutstanding'] });
    // Pre-opening security/financial cut after the opening exists: cannot reopen.
    await f.restore.beginRestore(preOpening);
    let preRec = 'reconciled'; try { await f.restore.reconcile({ approved: true, reviewId: 'P05-S3-pre-opening' }); } catch (e) { preRec = (e as { code?: string }).code ?? 'refused'; }
    observed.set('pre-opening cut after commit', { reconcile: preRec, open: f.restore.isOpen() });
    evidence('P05-S3-05', { observed: Object.fromEntries(observed) });
    assert.deepEqual(observed.get('complete cut'), { open: true, sameJournal: true, sameFile: true, refs: '4/4', marker: true });
    for (const [k, v] of Object.entries(cases)) assert.deepEqual(v, { openWhileTampered: false, reconcileWhileTampered: 'SERVICE_UNAVAILABLE', openAfterExactRevertAndReview: true }, k);
    assert.deepEqual(observed.get('pre-opening cut after commit'), { reconcile: 'SERVICE_UNAVAILABLE', open: false });
  } finally { await f.close(); }
});
