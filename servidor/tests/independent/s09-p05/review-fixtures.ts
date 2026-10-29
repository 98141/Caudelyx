/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection -- Exact registered owned group marker path and own fixed collection-name digest keys of this review. */
// S09-P05 reviewer world (Claude). `world` is a mechanical copy of tests/s09-backend/fixture.ts (author, frozen) bound to the own
// profile; extras only READ raw Mongo rows (oracle dataset, digests) or drive real product commands. Expected values never come
// from these helpers: they come from oracle.ts and from amounts commanded in the tests.
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BSON, type Document } from 'mongodb';
import { s09ReviewProfile } from './review-profile.js';
import { ProjectionRuntime } from '../../../src/modules/reporting/projection/service.js';
import { managementContract } from '../../../src/modules/obligations/contract.js';
import { today } from '../../../src/modules/obligations/calendar.js';
import type { Data } from '../../../src/modules/obligations/models.js';
import type { Dataset } from './oracle.js';

export type Group = Awaited<ReturnType<typeof s09ReviewProfile>>;
export type Reply = { status: number; code?: string | undefined; data?: Data | undefined; etag?: string | undefined; meta?: unknown };
export const evidence = (name: string, d: Record<string, unknown>) => console.log(JSON.stringify({ evidence: name, ...d }));

export async function world(group: Group, clockValue = Date.parse('2026-10-28T12:00:00-05:00')) {
  const f = await group.fixture(); f.clock.value = clockValue; const a = await f.actor();
  const org = (await f.runtime.organizations.create(a.issued.context, { name: 'Organización sintética S09 revisión', currency: 'COP', timezone: 'America/Bogota' }, randomUUID())).data.organization.id;
  const account = async (code: string, accountClass = 'ASSET', kind = 'GENERAL', actor = a, orgId = org) => { const payload = { code, name: 'Cuenta sintética ' + code, currency: 'COP', accountClass, kind }; return (await f.runtime.finance.mutate(actor.issued.context, 'createAccount', orgId, payload, randomUUID())).data as { id: string; version: number }; };
  const bank = await account('BANK_R09', 'ASSET', 'BANK'), equity = await account('EQUITY_R09', 'EQUITY');
  const capital = { currency: 'COP', effectiveDate: today(f.now()), sourceId: randomUUID(), supportReference: 'SYN-R09-CAPITAL', description: 'Capital sintético revisión', lines: [{ accountId: bank.id, debit: '20000000.00', credit: '0.00' }, { accountId: equity.id, debit: '0.00', credit: '20000000.00' }] }, key = randomUUID();
  await f.proof(a, 'FINANCE_JOURNAL_POST', { organizationId: org, idempotencyKey: key, payload: capital }); await f.runtime.finance.mutate(a.issued.context, 'postJournal', org, capital, key); await f.restore.flush();
  const owner = async () => { const o = JSON.parse(await readFile(join(group.folder, 'owner.json'), 'utf8')) as { pid: number; runId: string; names: string[] }; return o.pid === process.pid && o.runId === group.runId && o.names[0] === f.database.db.databaseName; };
  const service = f.runtime.obligations; await service.prepareOwned(owner); const projection = await ProjectionRuntime.createOwned(f.identity, f.keys.cursor, owner); f.identity.reporting!.projection = projection; await service.activateOwned(owner);
  type Actor = typeof a;
  const mutate = async (operation: string, payload: Data, params: Record<string, string> = {}, expected?: string, key = randomUUID(), actor: Actor = a, proof = true) => {
    const p = managementContract().operations.get(operation)!.definition['x-purpose']!, command = { operationId: operation, idempotencyKey: key, ...(params['organizationId'] ? { organizationId: params['organizationId'] } : {}), ...(params['bookId'] ? { bookId: params['bookId'] } : {}), pathParameters: params, payload, ...(expected ? { expectedETag: expected } : {}) };
    if (proof) await f.proof(actor, p, command, params['expenseId'] ?? params['ruleId'] ?? params['liabilityId'] ?? params['relationshipId']);
    return await service.mutate(actor.issued.context, operation, payload, params, key, expected);
  };
  const book = (await mutate('createPersonalBook', { currency: 'COP' })).data as { id: string };
  const personal = async (label: string, accountClass = 'ASSET', kind = 'GENERAL', actor: Actor = a, bookId = book.id) => (await mutate('createPersonalAccount', { code: label, name: 'Personal sintética ' + label, currency: 'COP', accountClass, kind }, { bookId }, undefined, randomUUID(), actor)).data as { id: string; version: number };
  const read = async (operation: string, params: Record<string, string> = {}, query: Data = { asOf: today(f.now()) }, actor: Actor = a) => await service.read(actor.issued.context, operation, params, query);
  // ---- reviewer extras
  /** Settles a product call into {status, code, data, etag} (errors carry status/code). */
  const settle = async (fn: () => Promise<{ status: number; data?: unknown; etag?: string; meta?: unknown }>): Promise<Reply> => { try { const r = await fn(); return { status: r.status, data: r.data as Data, etag: r.etag, meta: r.meta }; } catch (e) { return { status: Number((e as { status?: number }).status ?? 500), code: String((e as { code?: string }).code ?? (e as Error).message) }; } };
  const st = (r: Reply) => `${r.status}${r.code ? ' ' + r.code : ''}`;
  /** Member of the org with the given roles through the real invitation flow (same mechanics as author S9 browser walk). */
  const member = async (roles: string[]) => {
    const c = await f.actor(), invitation = { email: c.email, roleIds: roles }; await f.proof(a, 'MEMBER_INVITE', invitation, org); await f.runtime.organizations.invite(a.issued.context, invitation); await f.identity.dispatchMail();
    const mail = [...f.messages.notificationInbox.values()].find(m => m.kind === 'INVITATION' && m.payload['email'] === c.email); if (!mail) throw Error('Missing own invitation');
    await f.runtime.organizations.accept(c.issued.context, { mode: 'CONFIRM', token: mail.payload['token'] }, randomUUID()); await f.restore.flush(); return c;
  };
  const rows = async (name: string, filter: Document = {}): Promise<(Data & { _id: string })[]> => await f.database.db.collection<Document & { _id: string }>(name).find(filter).sort({ _id: 1 }).toArray() as never;
  /** Raw dataset for the own oracle (no product module is used to interpret it). */
  const dump = async (): Promise<Dataset> => ({
    personalAccounts: await rows('s09_personal_accounts'), personalJournals: await rows('s09_personal_journals'), personalEvents: await rows('s09_events_personal'), businessEvents: await rows('s09_events_business'),
    businessAccounts: await rows('financial_accounts', { organizationId: org }), businessJournals: await rows('financial_journals', { organizationId: org }), relationships: await rows('s09_relationships'), declarations: await rows('s09_ownership_declarations'),
    expenses: [...await rows('s09_expenses_personal'), ...await rows('s09_expenses_business')],
  });
  /** sha256 of every collection of the 3 own databases (canonical EJSON sorted by _id). */
  const digestAll = async (skip: string[] = []) => {
    const out: Record<string, string> = {};
    for (const name of group.names) { const d = f.database.client.db(name);
      for (const c of (await d.listCollections({}, { nameOnly: true }).toArray()).map(x => x.name).sort()) { if (skip.includes(c)) continue;
        out[(name.endsWith('_mail') ? 'mail.' : name.endsWith('_security') ? 'security.' : '') + c] = createHash('sha256').update(BSON.EJSON.stringify(await d.collection(c).find({}).sort({ _id: 1 }).toArray(), { relaxed: false })).digest('hex'); } }
    return out;
  };
  const diff = (x: Record<string, string>, y: Record<string, string>) => [...new Set([...Object.keys(x), ...Object.keys(y)])].filter(k => x[k] !== y[k]).sort();
  const counts = async () => ({ personalJournals: await f.database.db.collection('s09_personal_journals').countDocuments(), businessJournals: await f.database.db.collection('financial_journals').countDocuments({ organizationId: org }), personalEvents: await f.database.db.collection('s09_events_personal').countDocuments(), businessEvents: await f.database.db.collection('s09_events_business').countDocuments(), commands: await f.database.db.collection('s09_commands').countDocuments(), relationships: await f.database.db.collection('s09_relationships').countDocuments() });
  return { ...f, owner, a, org, bank, equity, account, personal, book, service, projection, mutate, read, group, settle, st, member, rows, dump, digestAll, diff, counts };
}
export type World = Awaited<ReturnType<typeof world>>;
export const info = (r: { data?: unknown }) => r.data as Data;
export const idOf = (r: { data?: unknown }) => String(info(r)['id']);
export const rate = { kind: 'NONE_DECLARED', source: 'SYNTHETIC_DECLARED', sourceReference: 'SYN-ZERO-DECLARED', validFrom: '2026-10-01', observedOn: '2026-10-01', unit: 'ANNUAL_FRACTION', convention: 'ANNUAL_SIMPLE_ACT_365', decimalValue: '0.00', combine: 'NONE' };
/** Official declared schedule from explicit rows [dueDate, principal, interest, insurance] (totals computed here in cents). */
export const schedule = (rowsIn: [string, string, string?, string?][]) => {
  const c = (v: string) => BigInt(v.replace('.', '')), m = (n: bigint) => (n / 100n).toString() + '.' + (n % 100n).toString().padStart(2, '0');
  const installments = rowsIn.map(([dueDate, principal, interest = '0.00', insurance = '0.00'], i) => ({ number: i + 1, dueDate, principal, interest, insurance, fees: '0.00', total: m(c(principal) + c(interest) + c(insurance)) }));
  return { kind: 'OFFICIAL_DECLARED', validFrom: '2026-10-28', referenceDate: '2026-09-28', sourceReference: 'SYN-R09-OFFICIAL', principalOpening: m(installments.reduce((n, x) => n + c(x.principal), 0n)), rateVersionIds: [], installments };
};
