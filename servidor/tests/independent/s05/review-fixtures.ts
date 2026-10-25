/* eslint-disable security/detect-object-injection -- Fixed labels/profile keys of this test, never request input. */
// S05-P05-v2 reviewer fixtures (Claude). Setup (organization, accounts, S2 funding journal, S4 borrower/quote/draft/confirm)
// runs in-process BEFORE the HTTP client exists; every reviewed S5 operation then goes through the real HTTPS app
// (cookie, CSRF, preview, A32 password + A27 TOTP R, Idempotency-Key, If-Match). No production calculation is imported.
import { randomUUID } from 'node:crypto';
import { generate } from 'otplib';
import type { ApiClient, ApiBody } from '../../helpers/client.js';
import { password, type reviewProfile, type ReviewFixture } from './review-profile.js';

export type Group = Awaited<ReturnType<typeof reviewProfile>>;
export type Actor = Awaited<ReturnType<ReviewFixture['actor']>>;
export type Reply = { status: number; body: ApiBody; headers: import('node:http').IncomingHttpHeaders; key?: string; r?: number | undefined };
export const st = (r: Reply) => `${r.status}${r.body.error?.code ? ' ' + r.body.error.code : ''}`;
export const data = <T = Record<string, unknown>>(r: Reply) => r.body.data as T;
export const tag = (r: Reply) => String(r.headers['etag']);
export const ACCOUNTS = [['BANK', 'Banco sintético S5', 'ASSET', 'BANK'], ['CASH', 'Caja sintética S5', 'ASSET', 'CASH'], ['P', 'Cartera capital S5', 'ASSET', 'GENERAL'], ['I', 'Interés por cobrar S5', 'ASSET', 'GENERAL'],
  ['Y', 'Ingreso por intereses S5', 'INCOME', 'GENERAL'], ['C', 'Saldo a favor prestatarios S5', 'LIABILITY', 'GENERAL'], ['E', 'Patrimonio sintético S5', 'EQUITY', 'GENERAL'], ['X', 'Activo general libre S5', 'ASSET', 'GENERAL']] as const;
const LOAN_PURPOSE: Record<string, string> = { createLoanDraft: 'LOAN_DRAFT_CREATE', confirmLoanTerms: 'LOAN_TERMS_CONFIRM', replaceLoanTerms: 'LOAN_TERMS_REPLACE', cancelLoan: 'LOAN_CANCEL', createBorrower: 'BORROWER_CREATE' };
export const OP = { DISBURSE: { path: 'disbursements', purpose: 'LOAN_DISBURSE' }, ACCRUE: { path: 'accruals', purpose: 'LOAN_ACCRUE' }, RECEIPT: { path: 'receipts', purpose: 'LOAN_RECEIPT_POST' }, APPLY_CREDIT: { path: 'credit-applications', purpose: 'LOAN_CREDIT_APPLY' } } as const;

export async function world(group: Group, clockIso: string) {
  const f = await group.fixture(); f.clock.value = Date.parse(clockIso);
  const base = (org: string) => `/api/v1/organizations/${org}`;
  const setClock = (iso: string) => { if (Date.parse(iso) < f.clock.value) throw Error('clock must not go back'); f.clock.value = Date.parse(iso); };
  const login = async (a: Actor): Promise<Actor> => {
    const first = await f.identity.login('TENANT', randomUUID(), a.email, password); f.clock.value += 30000;
    return { ...a, issued: (await f.runtime.totp.authenticate(first.issued.context, await generate({ secret: a.secret, epoch: Math.floor(f.now() / 1000) }), 'LOGIN', null)).issued };
  };
  /** Tenant: actor + org + 8 accounts + optional S2 funding journal (BANK Dr / E Cr) on today's date. */
  const tenant = async (label: string, funding = '20000000.00') => {
    const a = await f.actor();
    const payload = { name: `Organización sintética S5 ${label}`, currency: 'COP', timezone: 'America/Bogota' };
    await f.proof(a, 'ORGANIZATION_CREATE', payload);
    const org = (await f.runtime.organizations.create(a.issued.context, payload, randomUUID())).data.organization.id as string;
    const acc: Record<string, string> = {};
    for (const [code, name, accountClass, kind] of ACCOUNTS) {
      const ap = { code: code + '_S5', name, currency: 'COP', accountClass, kind }, key = randomUUID();
      await f.proof(a, 'FINANCE_ACCOUNT_CREATE', { organizationId: org, idempotencyKey: key, payload: ap });
      acc[code] = ((await f.runtime.finance.mutate(a.issued.context, 'createAccount', org, ap, key)).data as { id: string }).id;
    }
    const t = { a, h: a, org, acc, label, c: undefined as unknown as ApiClient, borrowers: new Map<string, string>(), loans: new Map<string, { id: string; borrowerId: string; principal: string }>() };
    if (funding !== '0.00') await journal(t, [{ accountId: acc['BANK']!, debit: funding, credit: '0.00' }, { accountId: acc['E']!, debit: '0.00', credit: funding }], 'SYN-SEED-' + label);
    return t;
  };
  type T = Awaited<ReturnType<typeof tenant>>;
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(f.now()));
  async function journal(t: T, lines: { accountId: string; debit: string; credit: string }[], ref: string) {
    const p = { currency: 'COP', effectiveDate: today(), sourceId: randomUUID(), supportReference: ref, description: 'Movimiento sintético S5', lines }, key = randomUUID();
    await f.proof(t.a, 'FINANCE_JOURNAL_POST', { organizationId: t.org, idempotencyKey: key, payload: p });
    return await f.runtime.finance.mutate(t.a.issued.context, 'postJournal', t.org, p, key);
  }
  const lend = async (t: T, op: string, payload: Record<string, unknown>, id?: string, etag?: string) => {
    const key = randomUUID(), purpose = LOAN_PURPOSE[op];
    if (purpose) await f.proof(t.a, purpose, { organizationId: t.org, idempotencyKey: key, payload, ...(etag ? { expectedETag: etag } : {}) }, id);
    return await f.runtime.lending.mutate(t.a.issued.context, op, t.org, payload, key, id, etag);
  };
  const borrower = async (t: T, code: string, name = 'Persona sintética ' + code) => { const r = await lend(t, 'createBorrower', { borrowerCode: code, profile: { displayName: name, schemaVersion: 1, extras: {} } }); const id = (r.data as { id: string }).id; t.borrowers.set(code, id); return id; };
  const termsOf = (t: T, borrowerId: string, d: Record<string, unknown> = {}) => ({ borrowerId, plannedFundingAccountId: t.acc['BANK']!, principal: '1000.00', effectiveDate: '2026-09-30', firstDueDate: '2026-10-31', installmentCount: 4,
    method: 'CONSTANT_PRINCIPAL', frequency: 'MONTH', rate: { type: 'EFFECTIVE', unit: 'MONTH', value: '0.010000000000' }, calendarConvention: 'PERIODIC_FIXED', holidayAdjustment: 'NO_SHIFT', policyVersion: 'S04-LOCAL-CO-0.1', jurisdiction: 'CO', usage: 'LOCAL_SYNTHETIC', ...d });
  /** S4 terms confirmed in-process (setup): quote -> draft -> confirm. Returns loan id. */
  const confirmed = async (t: T, label: string, borrowerId: string, d: Record<string, unknown> = {}, confirm = true) => {
    const q = (await f.runtime.lending.mutate(t.a.issued.context, 'createLoanQuote', t.org, { terms: termsOf(t, borrowerId, d) }, randomUUID())).data as { id: string; fingerprint: string };
    const dr = await lend(t, 'createLoanDraft', { quoteId: q.id, quoteFingerprint: q.fingerprint }); const id = (dr.data as { id: string }).id;
    if (confirm) await lend(t, 'confirmLoanTerms', { quoteId: q.id, quoteFingerprint: q.fingerprint, termsVersion: 1 }, id, dr.etag);
    t.loans.set(label, { id, borrowerId, principal: String(termsOf(t, borrowerId, d).principal) }); return id;
  };
  /** Fresh login + HTTPS client for the tenant (after any clock jump or restore). */
  /** HTTP uses its OWN login context (t.h); in-process setup keeps using t.a, so neither rotates the other's session. */
  const connect = async (t: T) => { t.h = await login(t.a); t.c = await f.client(t.h); return t; };
  const r = async (t: T, purpose: string, command: Record<string, unknown>, resourceId?: string | null, pass = password) => {
    const a32 = await t.c.call('POST', '/api/v1/auth/reauthenticate', { password: pass, purpose, command, ...(resourceId ? { resourceId } : {}) });
    if (a32.status !== 200) return a32.status;
    f.clock.value += 30000;
    const a27 = await t.c.call('POST', '/api/v1/auth/mfa/challenges/verify', { method: 'TOTP', purpose, code: await generate({ secret: t.a.secret, epoch: Math.floor(f.now() / 1000) }), ...(resourceId ? { resourceId } : {}) });
    await t.c.refreshCsrf(); return a27.status;
  };
  const get = async (t: T, path: string) => await t.c.call('GET', base(t.org) + path) as Reply;
  const book = async (t: T) => tag(await get(t, '/loan-operations/book'));
  const accountETag = async (t: T, code: string) => tag(await t.c.call('GET', `${base(t.org)}/financial/accounts/${t.acc[code]}`));
  const loanETag = async (t: T, id: string) => tag(await t.c.call('GET', `${base(t.org)}/loans/${id}`));
  const positionETag = async (t: T, id: string) => tag(await get(t, '/loan-operations/positions/' + id));
  const profile = (t: T) => ({ principalAccountId: t.acc['P']!, interestReceivableAccountId: t.acc['I']!, interestIncomeAccountId: t.acc['Y']!, borrowerCreditAccountId: t.acc['C']! });
  const disburseRequest = async (t: T, loanId: string, funding = 'BANK') => ({ kind: 'DISBURSE', loanId, loanETag: await loanETag(t, loanId), fundingAccountETag: await accountETag(t, funding), accountProfile: profile(t),
    accountVersions: { principalAccountId: await accountETag(t, 'P'), interestReceivableAccountId: await accountETag(t, 'I'), interestIncomeAccountId: await accountETag(t, 'Y'), borrowerCreditAccountId: await accountETag(t, 'C') }, effectiveDate: today(), supportReference: 'SYN-P05-DISBURSE' });
  const receiptRequest = async (t: T, borrowerId: string, amount: string, targets: { loanId: string; amount: string; mode?: 'REGULAR' | 'EXTRA_PRINCIPAL' }[], excess: 'CREDIT' | 'REJECT' = 'REJECT', account = 'BANK', ref = 'SYN-REC-' + randomUUID().slice(0, 8)) => ({
    kind: 'RECEIPT', borrowerId, destinationAccountId: t.acc[account]!, destinationAccountETag: await accountETag(t, account), receivedAmount: amount,
    targets: await Promise.all(targets.map(async x => ({ loanId: x.loanId, positionETag: await positionETag(t, x.loanId), amount: x.amount, mode: x.mode ?? 'REGULAR' }))), excessDisposition: excess, receiptReference: ref, effectiveDate: today(), supportReference: 'SYN-P05-RECEIPT' });
  const creditRequest = async (t: T, borrowerId: string, amount: string, targets: { loanId: string; amount: string; mode?: 'REGULAR' | 'EXTRA_PRINCIPAL' }[]) => ({
    kind: 'APPLY_CREDIT', borrowerId, creditETag: tag(await get(t, '/loan-operations/credits/' + borrowerId)), amount, targets: await Promise.all(targets.map(async x => ({ loanId: x.loanId, positionETag: await positionETag(t, x.loanId), amount: x.amount, mode: x.mode ?? 'REGULAR' }))), effectiveDate: today(), supportReference: 'SYN-P05-CREDIT' });
  const accrueRequest = async (t: T, loanId: string, throughDate = today()) => ({ kind: 'ACCRUE', loanId, positionETag: await positionETag(t, loanId), throughDate, effectiveDate: today(), supportReference: 'SYN-P05-ACCRUE' });
  const resourceOf = (req: Record<string, unknown>) => String(req['kind'] === 'DISBURSE' || req['kind'] === 'ACCRUE' ? req['loanId'] : req['borrowerId']);
  const preview = async (t: T, request: Record<string, unknown>, key = randomUUID(), bookETag?: string) => {
    const etag = bookETag ?? await book(t);
    const res = await t.c.call('POST', base(t.org) + '/loan-operation-previews', { executionKey: key, expectedBookETag: etag, request }) as Reply;
    return { res, key, etag, token: (res.body.data?.['previewToken'] as string | undefined) ?? '', plan: res.body.data?.['plan'] as Record<string, unknown> | undefined };
  };
  type Pv = Awaited<ReturnType<typeof preview>>;
  /** Execute a previewed command: R bound to the exact command, then POST with Idempotency-Key + If-Match. */
  const execute = async (t: T, request: Record<string, unknown>, pv: Pv, o: { skipR?: boolean; onlyR?: boolean; rPurpose?: string; rPayload?: unknown; pass?: string; headers?: Record<string, string>; etag?: string; token?: string } = {}): Promise<Reply> => {
    const kind = String(request['kind']) as keyof typeof OP, spec = OP[kind], payload = { previewToken: o.token ?? pv.token, request }, etag = o.etag ?? pv.etag;
    let rs: number | undefined;
    if (!o.skipR) { rs = await r(t, o.rPurpose ?? spec.purpose, { organizationId: t.org, idempotencyKey: pv.key, payload: o.rPayload ?? payload, expectedETag: etag }, resourceOf(request), o.pass); if (rs !== 200) return { status: -rs, body: {}, headers: {}, key: pv.key, r: rs }; }
    if (o.onlyR) return { status: 0, body: {}, headers: {}, key: pv.key, r: rs };
    const res = await t.c.call('POST', `${base(t.org)}/loan-operations/${spec.path}`, payload, { 'Idempotency-Key': pv.key, 'If-Match': etag, ...(o.headers ?? {}) }) as Reply;
    return { ...res, key: pv.key, r: rs };
  };
  const run = async (t: T, request: Record<string, unknown>) => { const pv = await preview(t, request); if (pv.res.status !== 200) return { ...pv.res, preview: pv } as Reply & { preview: Pv }; return { ...(await execute(t, request, pv)), preview: pv }; };
  const db = f.database.db;
  /** Ledger balances (natural debit-minus-credit cents) of the tenant's accounts, from the OWN group's journals. */
  const ledger = async (t: T) => {
    const totals = new Map<string, bigint>();
    for (const j of await db.collection('financial_journals').find({ organizationId: t.org }).toArray()) for (const l of j['lines'] as { accountId: string; debit: unknown; credit: unknown }[]) {
      const cents = (v: unknown) => { const text = String(v), neg = text.startsWith('-'), [w = '0', fr = ''] = text.replace('-', '').split('.'); const n = BigInt(w) * 100n + BigInt((fr + '00').slice(0, 2)); return neg ? -n : n; };
      totals.set(l.accountId, (totals.get(l.accountId) ?? 0n) + cents(l.debit) - cents(l.credit));
    }
    const byCode: Record<string, bigint> = {}; for (const [code] of ACCOUNTS) byCode[code] = totals.get(t.acc[code]!) ?? 0n; return byCode;
  };
  const counts = async (cols: string[]) => Object.fromEntries(await Promise.all(cols.map(async n => [n, await db.collection(n).countDocuments()] as const)));
  /** Second Titular of the SAME organization through the real invitation flow (A12 invite with R, A15 PREPARE/CONFIRM). */
  const invite = async (t: T, roleIds: string[] = ['T']) => {
    const email = randomUUID() + '@example.test';
    await f.proof(t.a, 'MEMBER_INVITE', { email, roleIds }, t.org); await f.runtime.organizations.invite(t.a.issued.context, { email, roleIds }); await f.identity.dispatchMail();
    const inv = (await f.runtime.organizations.invitations.findOne({ email }))!, note = [...f.messages.notificationInbox.values()].find(n => n.kind === 'INVITATION' && n.subjectId === inv._id)!;
    const token = note.payload['token']!, p = await f.sessions.issue('TENANT', 'P', null);
    await f.runtime.organizations.accept(p.context, { mode: 'PREPARE', token, displayName: 'Titular invitado sintético', privacyPolicyVersion: 'synthetic-v1', acceptTerms: true }, 'invite'); await f.identity.dispatchMail();
    const subject = (await f.identity.identities.findOne({ email }))!, activation = [...f.messages.inbox.values()].find(mm => mm.subjectId === subject._id && mm.purpose === 'ACTIVATION')!;
    const initial = await f.identity.confirmEmail(p.context, { purpose: 'ACTIVATION', token: activation.token, newPassword: password });
    const enrollment = await f.runtime.totp.enroll(initial.issued.context, 'Invitado'), secret = new URL(enrollment.provisioningUri).searchParams.get('secret')!;
    const completed = await f.runtime.totp.confirm(initial.issued.context, enrollment.enrollmentId, await generate({ secret, epoch: Math.floor(f.now() / 1000) }));
    await f.runtime.organizations.accept(completed.issued!.context, { mode: 'CONFIRM', token }, 'accept');
    const member = { email, secret, issued: completed.issued!, subjectId: subject._id as string };
    const second = { ...t, a: member as unknown as Actor, h: member as unknown as Actor, c: undefined as unknown as ApiClient };
    return await connect(second);
  };
  /** Number of fresh (unconsumed) R proofs of the HTTP actor for a purpose, read from the own group's contexts. */
  const proofsLeft = async (t: T, purpose: string) => await db.collection('contexts').countDocuments({ subjectId: t.h.issued.context.subjectId, 'reauth.purpose': purpose, 'reauth.consumed': false });
  /** Make one collection reject every write for the duration of fn (fault injection), then restore it. */
  const inject = async <R>(collection: string, fn: () => Promise<R>) => {
    await db.command({ collMod: collection, validator: { $expr: { $eq: [1, 0] } }, validationAction: 'error' }).catch(async () => { await db.createCollection(collection, { validator: { $expr: { $eq: [1, 0] } } }); });
    try { return await fn(); } finally { await db.command({ collMod: collection, validator: {}, validationAction: 'error' }); }
  };
  const orgCounts = async (t: T) => Object.fromEntries(await Promise.all(S5_COLLECTIONS.map(async n => [n, await db.collection(n).countDocuments(n === 'audit_events' || n === 'outbox' ? { action: /^LOAN_/ } : { organizationId: t.org })] as const)));
  return { invite, proofsLeft, inject, orgCounts, f, base, setClock, login, tenant, journal, lend, borrower, termsOf, confirmed, connect, r, get, book, accountETag, loanETag, positionETag, profile, disburseRequest, receiptRequest, creditRequest, accrueRequest, preview, execute, run, ledger, counts, today, db };
}
export type World = Awaited<ReturnType<typeof world>>;
export type Tenant = Awaited<ReturnType<World['tenant']>>;
export const S5_COLLECTIONS = ['loan_operation_books', 'loan_positions', 'loan_schedule_versions', 'loan_installments', 'loan_accruals', 'loan_events', 'loan_applications', 'borrower_credits', 'loan_operation_idempotency', 'financial_journals', 'audit_events', 'outbox'];
