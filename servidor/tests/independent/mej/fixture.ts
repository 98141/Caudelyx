/* eslint-disable security/detect-object-injection -- Fixed account labels/operation kinds of this test, never request input. */
// MEJ-5 reviewer world (Claude). Every reviewed operation goes through the REAL HTTPS app with cookie/CSRF/Origin,
// Idempotency-Key and If-Match; step-up only through A42/A43. Setup that is itself under review (org, accounts,
// borrowers, quotes) also uses HTTP: under MEJ they are WORK_ONLY and must not ask for any code.
import { randomUUID } from 'node:crypto';
import type { ApiClient, ApiBody } from '../../helpers/client.js';
import { password, type ReviewFixture } from './review-profile.js';

export type Reply = { status: number; body: ApiBody; headers: import('node:http').IncomingHttpHeaders };
export const st = (r: Reply) => `${r.status}${r.body.error?.code ? ' ' + r.body.error.code : ''}`;
export const data = <T = Record<string, unknown>>(r: Reply) => r.body.data as T;
export const tag = (r: Reply) => String(r.headers['etag']);
export const ACCOUNTS = [['BANK', 'Banco revisora', 'ASSET', 'BANK'], ['CASH', 'Caja revisora', 'ASSET', 'CASH'], ['P', 'Cartera capital', 'ASSET', 'GENERAL'], ['I', 'Interés por cobrar', 'ASSET', 'GENERAL'],
  ['Y', 'Ingreso por intereses', 'INCOME', 'GENERAL'], ['C', 'Saldo a favor', 'LIABILITY', 'GENERAL'], ['E', 'Patrimonio revisora', 'EQUITY', 'GENERAL']] as const;
export interface Who { email: string; secret?: string; issued: { context: { _id: string; subjectId: string | null }; token: string }; c: ApiClient }

export async function world(f: ReviewFixture) {
  const h = await f.https();
  const base = (org: string) => `/api/v1/organizations/${org}`;
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(f.now()));
  const connect = async <T extends { issued: { token: string } }>(holder: T): Promise<T & { c: ApiClient }> => ({ ...holder, c: await h.client(holder.issued.token) });
  const call = async (who: { c: ApiClient }, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    if (method !== 'GET') await who.c.refreshCsrf().catch(() => undefined);
    return await who.c.call(method, path.startsWith('/api') ? path : '/api/v1' + path, body, headers) as Reply;
  };
  const sessionToken = (who: { c: ApiClient }) => who.c.cookies.get('__Host-caudelyx-session') ?? '';
  /** Login through A05 from a fresh anonymous browser; returns a client holding the issued W cookie. */
  const login = async (email: string, pass = password) => { const c = await h.client(); const r = await call({ c }, 'POST', '/auth/login', { email, password: pass }); return { c, r }; };
  /** HTTP step-up (A42 prepare + A43 TOTP verify) on a fresh 30 s step; Set-Cookie rotation is kept by the client jar. */
  const stepUp = async (who: { c: ApiClient; secret?: string }, purpose: string, command?: Record<string, unknown>, resourceId?: string) => {
    const prepare = await call(who, 'POST', '/auth/step-up/intents', { purpose, method: 'TOTP', ...(command ? { command } : {}), ...(resourceId ? { resourceId } : {}) });
    if (prepare.status !== 200) return { prepare };
    f.clock.value += 30000;
    const verify = await call(who, 'POST', '/auth/step-up/verify', { intentId: data<{ intentId: string }>(prepare).intentId, method: 'TOTP', code: await f.totpCode(who.secret!) });
    return { prepare, verify };
  };
  /** Titular with factor, organization and accounts, all through HTTP without any code (WORK_ONLY). */
  const tenant = async (label: string) => {
    const a = await f.actor(), who = await connect(a);
    const created = await call(who, 'POST', '/organizations', { name: 'Organización revisora ' + label, timezone: 'America/Bogota', currency: 'COP' }, { 'Idempotency-Key': randomUUID() });
    if (created.status !== 201) throw Error('A08 without code failed: ' + st(created));
    const org = data<{ organization: { id: string } }>(created).organization.id;
    const acc: Record<string, string> = {};
    for (const [code, name, accountClass, kind] of ACCOUNTS) {
      const r = await call(who, 'POST', base(org) + '/financial/accounts', { code: code + '_R5', name, currency: 'COP', accountClass, kind }, { 'Idempotency-Key': randomUUID() });
      if (r.status !== 201) throw Error('account without code failed: ' + st(r));
      acc[code] = data<{ id: string }>(r).id;
    }
    return { who, org, acc, label };
  };
  type T = Awaited<ReturnType<typeof tenant>>;
  const journalBody = (lines: { accountId: string; debit: string; credit: string }[], ref = 'SYN-R5') => ({ currency: 'COP', effectiveDate: today(), sourceId: randomUUID(), supportReference: ref, description: 'Movimiento revisora', lines });
  const postJournal = async (t: T, lines: { accountId: string; debit: string; credit: string }[], key = randomUUID(), body = journalBody(lines)) =>
    ({ key, body, r: await call(t.who, 'POST', base(t.org) + '/financial/journal-entries', body, { 'Idempotency-Key': key }) });
  const fund = (t: T, amount: string, to = 'BANK') => postJournal(t, [{ accountId: t.acc[to]!, debit: amount, credit: '0.00' }, { accountId: t.acc['E']!, debit: '0.00', credit: amount }]);
  const balanceGrant = async (t: T) => { const { key, body } = { key: randomUUID(), body: journalBody([{ accountId: t.acc['BANK']!, debit: '1.00', credit: '0.00' }, { accountId: t.acc['E']!, debit: '0.00', credit: '1.00' }]) };
    return await stepUp(t.who, 'FINANCE_JOURNAL_POST', { organizationId: t.org, idempotencyKey: key, payload: body }); };
  const initial = async (t: T, items: { accountId: string; amount: string }[], key = randomUUID(), extra: Record<string, unknown> = {}) => {
    const body = { effectiveDate: today(), sourceId: randomUUID(), supportReference: 'SYN-SI-R5', description: 'Saldo inicial revisora', items, ...extra };
    return { key, body, r: await call(t.who, 'POST', base(t.org) + '/financial/initial-balances', body, { 'Idempotency-Key': key }) };
  };
  const borrower = async (t: T, code: string) => { const r = await call(t.who, 'POST', base(t.org) + '/borrowers', { borrowerCode: code, profile: { displayName: 'Persona sintética ' + code, schemaVersion: 1, extras: {} } }, { 'Idempotency-Key': randomUUID() }); return { r, id: data<{ id?: string }>(r)?.id ?? '' }; };
  const termsOf = (t: T, borrowerId: string, d: Record<string, unknown> = {}) => ({ borrowerId, plannedFundingAccountId: t.acc['BANK']!, principal: '2000000.00', effectiveDate: '2026-09-30', firstDueDate: '2026-10-31', installmentCount: 4,
    method: 'CONSTANT_PRINCIPAL', frequency: 'MONTH', rate: { type: 'EFFECTIVE', unit: 'MONTH', value: '0.030000000000' }, calendarConvention: 'PERIODIC_FIXED', holidayAdjustment: 'NO_SHIFT', policyVersion: 'S04-LOCAL-CO-0.1', jurisdiction: 'CO', usage: 'LOCAL_SYNTHETIC', ...d });
  /** S4 quote → draft → confirm, all WORK_ONLY through HTTP. */
  const loan = async (t: T, borrowerId: string, d: Record<string, unknown> = {}, confirm = true) => {
    const q = await call(t.who, 'POST', base(t.org) + '/loan-quotes', { terms: termsOf(t, borrowerId, d) }, { 'Idempotency-Key': randomUUID() });
    if (q.status !== 201 && q.status !== 200) throw Error('quote failed ' + st(q));
    const { id: quoteId, fingerprint } = data<{ id: string; fingerprint: string }>(q);
    const draft = await call(t.who, 'POST', base(t.org) + '/loans', { quoteId, quoteFingerprint: fingerprint }, { 'Idempotency-Key': randomUUID() });
    if (draft.status !== 201) throw Error('draft failed ' + st(draft));
    const id = data<{ id: string }>(draft).id;
    let confirmed: Reply | undefined;
    if (confirm) confirmed = await call(t.who, 'POST', base(t.org) + `/loans/${id}/confirmation`, { quoteId, quoteFingerprint: fingerprint, termsVersion: 1 }, { 'Idempotency-Key': randomUUID(), 'If-Match': tag(draft) });
    return { id, quoteId, fingerprint, draft, confirmed };
  };
  const get = async (t: T, path: string) => await call(t.who, 'GET', base(t.org) + path);
  const accountETag = async (t: T, code: string) => tag(await get(t, '/financial/accounts/' + t.acc[code]));
  const positionETag = async (t: T, id: string) => tag(await get(t, '/loan-operations/positions/' + id));
  const profile = (t: T) => ({ principalAccountId: t.acc['P']!, interestReceivableAccountId: t.acc['I']!, interestIncomeAccountId: t.acc['Y']!, borrowerCreditAccountId: t.acc['C']! });
  const disburseRequest = async (t: T, loanId: string) => ({ kind: 'DISBURSE', loanId, loanETag: tag(await get(t, '/loans/' + loanId)), fundingAccountETag: await accountETag(t, 'BANK'), accountProfile: profile(t),
    accountVersions: { principalAccountId: await accountETag(t, 'P'), interestReceivableAccountId: await accountETag(t, 'I'), interestIncomeAccountId: await accountETag(t, 'Y'), borrowerCreditAccountId: await accountETag(t, 'C') }, effectiveDate: today(), supportReference: 'SYN-R5-DISBURSE' });
  const accrueRequest = async (t: T, loanId: string, throughDate = today()) => ({ kind: 'ACCRUE', loanId, positionETag: await positionETag(t, loanId), throughDate, effectiveDate: today(), supportReference: 'SYN-R5-ACCRUE' });
  const receiptRequest = async (t: T, borrowerId: string, amount: string, targets: { loanId: string; amount: string }[], excess: 'CREDIT' | 'REJECT' = 'CREDIT') => ({
    kind: 'RECEIPT', borrowerId, destinationAccountId: t.acc['BANK']!, destinationAccountETag: await accountETag(t, 'BANK'), receivedAmount: amount,
    targets: await Promise.all(targets.map(async x => ({ loanId: x.loanId, positionETag: await positionETag(t, x.loanId), amount: x.amount, mode: 'REGULAR' }))), excessDisposition: excess, receiptReference: 'SYN-R5-REC-' + randomUUID().slice(0, 8), effectiveDate: today(), supportReference: 'SYN-R5-RECEIPT' });
  const creditRequest = async (t: T, borrowerId: string, amount: string, targets: { loanId: string; amount: string }[]) => ({
    kind: 'APPLY_CREDIT', borrowerId, creditETag: tag(await get(t, '/loan-operations/credits/' + borrowerId)), amount, targets: await Promise.all(targets.map(async x => ({ loanId: x.loanId, positionETag: await positionETag(t, x.loanId), amount: x.amount, mode: 'REGULAR' }))), effectiveDate: today(), supportReference: 'SYN-R5-CREDIT' });
  const OP: Record<string, string> = { DISBURSE: 'disbursements', ACCRUE: 'accruals', RECEIPT: 'receipts', APPLY_CREDIT: 'credit-applications' };
  /** Preview + execute an S5 command. Balance authority is the 60-min grant; no per-command code. */
  const operate = async (t: T, request: Record<string, unknown>) => {
    const book = tag(await get(t, '/loan-operations/book')), key = randomUUID();
    const pv = await call(t.who, 'POST', base(t.org) + '/loan-operation-previews', { executionKey: key, expectedBookETag: book, request });
    if (pv.status !== 200) return { preview: pv, r: pv };
    const payload = { previewToken: data<{ previewToken: string }>(pv).previewToken, request };
    const r = await call(t.who, 'POST', base(t.org) + '/loan-operations/' + OP[String(request['kind'])], payload, { 'Idempotency-Key': key, 'If-Match': book });
    return { preview: pv, r, key, payload, book };
  };
  /** Ledger balances in natural debit-minus-credit cents, computed from the own group's journals (not from the API). */
  const ledger = async (t: T) => {
    const totals = new Map<string, bigint>();
    for (const j of await f.database.db.collection('financial_journals').find({ organizationId: t.org }).toArray()) for (const l of j['lines'] as { accountId: string; debit: unknown; credit: unknown }[]) {
      const cents = (v: unknown) => { const text = String(v), [w = '0', fr = ''] = text.split('.'); return BigInt(w) * 100n + BigInt((fr + '00').slice(0, 2)); };
      totals.set(l.accountId, (totals.get(l.accountId) ?? 0n) + cents(l.debit) - cents(l.credit));
    }
    return new Map(ACCOUNTS.map(([code]) => [code, totals.get(t.acc[code]!) ?? 0n] as const));
  };
  return { f, h, base, today, connect, call, login, stepUp, tenant, journalBody, postJournal, fund, balanceGrant, initial, borrower, termsOf, loan, get, accountETag, positionETag, disburseRequest, accrueRequest, receiptRequest, creditRequest, operate, ledger, sessionToken };
}
export type World = Awaited<ReturnType<typeof world>>;
export type Tenant = Awaited<ReturnType<World['tenant']>>;
