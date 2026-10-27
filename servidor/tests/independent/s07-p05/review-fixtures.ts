/* eslint-disable security/detect-object-injection -- Own fixed account/collection maps of this review, never request input. */
// S07-P05 reviewer world (Claude). Drives the REAL S7 service through the author fixture mechanics (tests/s07/fixture.ts:
// setup/cashSetup, actors with TOTP, proofs per W class) in the reviewer's own group. Expected money comes only from the
// own oracle; this module READS ledger lines, positions and domain rows.
import { randomUUID, createHash } from 'node:crypto';
import { BSON, type Document } from 'mongodb';
import { cashSetup } from '../../s07/fixture.js';
import type { s07Profile } from './review-profile.js';

export type Group = Awaited<ReturnType<typeof s07Profile>>;
export const S7 = ['collection_books', 'collection_journeys', 'collection_actions', 'cash_stations', 'cash_deliveries', 'cash_delivery_facts', 'cash_delivery_allocations', 'cash_close_records', 'collection_commands', 'collection_transitions'];
export const S6 = ['payment_books', 'payments', 'payment_transitions', 'payment_approvals', 'cash_custody', 'custody_bindings', 'custody_movements', 'payment_commands', 'payment_event_snapshots', 'loan_compensations', 'payment_registration_scopes', 'held_funds_profiles', 'held_funds_reservations', 'bank_declarations', 'reconciliation_events', 'payment_reversal_requests'];
export const S5 = ['loan_operation_books', 'loan_positions', 'loan_schedule_versions', 'loan_installments', 'loan_accruals', 'loan_events', 'loan_applications', 'borrower_credits', 'loan_operation_idempotency'];
export const LEDGER = ['financial_journals', 'financial_books', 'financial_evidence_head', 'financial_idempotency'];
export const EVIDENCE = ['lending_merkle_nodes', 'lending_merkle_orgs', 'lending_domain_state'];
export const AUDIT = ['audit_events', 'outbox', 'security_evidence_outbox'];
export const toC = (v: unknown) => { const t = String(v), neg = t.startsWith('-'), [w = '0', f = ''] = t.replace('-', '').split('.'); const n = BigInt(w) * 100n + BigInt((f + '00').slice(0, 2)); return neg ? -n : n; };
export const mm = (v: bigint) => { const neg = v < 0n, a = neg ? -v : v; return (neg ? '-' : '') + (a / 100n).toString() + '.' + (a % 100n).toString().padStart(2, '0'); };
export type Reply = { status: number; code?: string; data?: Record<string, unknown> };

export async function world(group: Group, approve = true) {
  const f = await cashSetup(group as never, approve), org = f.org, db = f.database.db;
  type Actor = typeof f.a;
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(f.now()));
  const settle = async (fn: () => Promise<{ status: number; data?: unknown }>): Promise<Reply> => { try { const r = await fn(); return { status: r.status, data: r.data as Record<string, unknown> }; } catch (e) { return { status: Number((e as { status?: number }).status ?? 500), code: String((e as { code?: string }).code ?? (e as Error).message) }; } };
  const st = (r: Reply) => `${r.status}${r.code ? ' ' + r.code : ''}`;
  /** Preview-stage rejections reported as 'preview <status> <code>'. */
  const prepared = async <T>(fn: () => Promise<T>): Promise<{ p?: T; failed?: Reply }> => { try { return { p: await fn() }; } catch (e) { return { failed: { status: Number((e as { status?: number }).status ?? 500), code: 'preview ' + String((e as { code?: string }).code ?? (e as Error).message) } }; } };
  const ledger = async () => { const t = new Map<string, bigint>(); for (const j of await db.collection('financial_journals').find({ organizationId: org }).toArray()) for (const l of j['lines'] as { accountId: string; debit: unknown; credit: unknown }[]) t.set(l.accountId, (t.get(l.accountId) ?? 0n) + toC(l.debit) - toC(l.credit)); return t; };
  const journals = async (filter: Document = {}) => await db.collection('financial_journals').countDocuments({ organizationId: org, ...filter });
  const digest = async (names: string[]) => { const h = createHash('sha256'); for (const n of names) { h.update(n); h.update(BSON.EJSON.stringify(await db.collection(n).find({}).sort({ _id: 1 }).toArray(), { relaxed: false })); } return h.digest('hex'); };
  /** Position of `responsible` on `account` as the API returns it (read by `actor`). */
  const position = async (responsible: string, account: string, actor: Actor = f.a) => { const r = await f.readCollections('getCashPosition', responsible, actor); const x = ((r.data as { items: Record<string, unknown>[] }).items).find(i => i['accountId'] === account); if (!x) return null;
    const ph = x['physical'] as Record<string, string>; return { ledgerBalance: x['ledgerBalance'], retainedAtOrigin: x['retainedAtOrigin'], committed: x['committed'], uncommitted: x['uncommitted'], deliveredNet: x['deliveredNet'], held: x['held'], compensationReserve: x['compensationReserve'], available: x['available'],
      physical: { confirmedOnSite: ph['confirmedOnSite'], inTransit: ph['inTransit'], receivedUnposted: ph['receivedUnposted'], unlocatedDisputed: ph['unlocatedDisputed'], unidentifiedSurplus: ph['unidentifiedSurplus'] } }; };
  const s2 = async (op: 'createTransfer' | 'postJournal' | 'reverseJournal', payload: Record<string, unknown>, id?: string, etag?: string) => { const key = randomUUID(), purpose = { createTransfer: 'FINANCE_TRANSFER', postJournal: 'FINANCE_JOURNAL_POST', reverseJournal: 'FINANCE_JOURNAL_REVERSE' }[op]; await f.proof(f.a, purpose, { organizationId: org, idempotencyKey: key, payload, ...(etag ? { expectedETag: etag } : {}) }, id); return await settle(() => f.runtime.finance.mutate(f.a.issued.context, op, org, payload, key, id, etag)); };
  const transfer = async (from: string, to: string, amount: string) => await s2('createTransfer', { currency: 'COP', effectiveDate: today(), sourceId: randomUUID(), supportReference: 'SYN-TR', description: 'Traslado sintético', fromAccountId: from, toAccountId: to, amount });
  /** Collections fact command (dispatch/receive/cancel/return...) returning a Reply. */
  const act = async (operation: string, id: string, actor: Actor, extra: Record<string, unknown> = {}) => await settle(() => f.act(operation, id, actor, extra));
  const count = async (id: string, amount: string, actor: Actor = f.o) => await settle(() => f.count(id, amount, actor));
  const request = async (amount: string) => { const p = await prepared(() => f.request(amount)); if (p.failed) return { ...p.failed, prep: undefined, id: undefined }; const r = await settle(p.p!.execute); return { ...r, prep: p.p, id: r.data?.['entityId'] as string | undefined }; };
  const confirm = async (id: string, compensation = false) => { const p = await prepared(() => f.confirm(id, compensation)); if (p.failed) return { ...p.failed, prep: undefined }; return { ...(await settle(p.p!.execute)), prep: p.p }; };
  const compensate = async (originalId: string, key = randomUUID()) => { const d = await f.readCollections('getCashDelivery', originalId); const p = await prepared(() => f.prepareCollections({ kind: 'COMPENSATE_REQUEST', originalDeliveryId: originalId, resourceETag: d.etag, reason: 'Compensación sintética', supportReference: 'SYN-COMP' }, f.a, key as never)); if (p.failed) return { ...p.failed, prep: undefined, id: undefined }; const r = await settle(p.p!.execute); return { ...r, prep: p.p, id: r.data?.['entityId'] as string | undefined }; };
  const delivery = async (id: string) => await f.delivery(id);
  return { f, org, db, today, settle, st, prepared, ledger, journals, digest, position, s2, transfer, act, count, request, confirm, compensate, delivery };
}
export type World = Awaited<ReturnType<typeof world>>;
