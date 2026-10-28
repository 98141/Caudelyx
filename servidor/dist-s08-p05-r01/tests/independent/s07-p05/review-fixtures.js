/* eslint-disable security/detect-object-injection -- Own fixed account/collection maps of this review, never request input. */
// S07-P05 reviewer world (Claude). Drives the REAL S7 service through the author fixture mechanics (tests/s07/fixture.ts:
// setup/cashSetup, actors with TOTP, proofs per W class) in the reviewer's own group. Expected money comes only from the
// own oracle; this module READS ledger lines, positions and domain rows.
import { randomUUID, createHash } from 'node:crypto';
import { BSON } from 'mongodb';
import { cashSetup } from '../../s07/fixture.js';
export const S7 = ['collection_books', 'collection_journeys', 'collection_actions', 'cash_stations', 'cash_deliveries', 'cash_delivery_facts', 'cash_delivery_allocations', 'cash_close_records', 'collection_commands', 'collection_transitions'];
export const S6 = ['payment_books', 'payments', 'payment_transitions', 'payment_approvals', 'cash_custody', 'custody_bindings', 'custody_movements', 'payment_commands', 'payment_event_snapshots', 'loan_compensations', 'payment_registration_scopes', 'held_funds_profiles', 'held_funds_reservations', 'bank_declarations', 'reconciliation_events', 'payment_reversal_requests'];
export const S5 = ['loan_operation_books', 'loan_positions', 'loan_schedule_versions', 'loan_installments', 'loan_accruals', 'loan_events', 'loan_applications', 'borrower_credits', 'loan_operation_idempotency'];
export const LEDGER = ['financial_journals', 'financial_books', 'financial_evidence_head', 'financial_idempotency'];
export const EVIDENCE = ['lending_merkle_nodes', 'lending_merkle_orgs', 'lending_domain_state'];
export const AUDIT = ['audit_events', 'outbox', 'security_evidence_outbox'];
export const toC = (v) => { const t = String(v), neg = t.startsWith('-'), [w = '0', f = ''] = t.replace('-', '').split('.'); const n = BigInt(w) * 100n + BigInt((f + '00').slice(0, 2)); return neg ? -n : n; };
export const mm = (v) => { const neg = v < 0n, a = neg ? -v : v; return (neg ? '-' : '') + (a / 100n).toString() + '.' + (a % 100n).toString().padStart(2, '0'); };
export async function world(group, approve = true) {
    const f = await cashSetup(group, approve), org = f.org, db = f.database.db;
    const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(f.now()));
    const settle = async (fn) => { try {
        const r = await fn();
        return { status: r.status, data: r.data };
    }
    catch (e) {
        return { status: Number(e.status ?? 500), code: String(e.code ?? e.message) };
    } };
    const st = (r) => `${r.status}${r.code ? ' ' + r.code : ''}`;
    /** Preview-stage rejections reported as 'preview <status> <code>'. */
    const prepared = async (fn) => { try {
        return { p: await fn() };
    }
    catch (e) {
        return { failed: { status: Number(e.status ?? 500), code: 'preview ' + String(e.code ?? e.message) } };
    } };
    const ledger = async () => { const t = new Map(); for (const j of await db.collection('financial_journals').find({ organizationId: org }).toArray())
        for (const l of j['lines'])
            t.set(l.accountId, (t.get(l.accountId) ?? 0n) + toC(l.debit) - toC(l.credit)); return t; };
    const journals = async (filter = {}) => await db.collection('financial_journals').countDocuments({ organizationId: org, ...filter });
    const digest = async (names) => { const h = createHash('sha256'); for (const n of names) {
        h.update(n);
        h.update(BSON.EJSON.stringify(await db.collection(n).find({}).sort({ _id: 1 }).toArray(), { relaxed: false }));
    } return h.digest('hex'); };
    /** Position of `responsible` on `account` as the API returns it (read by `actor`). */
    const position = async (responsible, account, actor = f.a) => {
        const r = await f.readCollections('getCashPosition', responsible, actor);
        const x = (r.data.items).find(i => i['accountId'] === account);
        if (!x)
            return null;
        const ph = x['physical'];
        return { ledgerBalance: x['ledgerBalance'], retainedAtOrigin: x['retainedAtOrigin'], committed: x['committed'], uncommitted: x['uncommitted'], deliveredNet: x['deliveredNet'], held: x['held'], compensationReserve: x['compensationReserve'], available: x['available'],
            physical: { confirmedOnSite: ph['confirmedOnSite'], inTransit: ph['inTransit'], receivedUnposted: ph['receivedUnposted'], unlocatedDisputed: ph['unlocatedDisputed'], unidentifiedSurplus: ph['unidentifiedSurplus'] } };
    };
    const s2 = async (op, payload, id, etag) => { const key = randomUUID(), purpose = { createTransfer: 'FINANCE_TRANSFER', postJournal: 'FINANCE_JOURNAL_POST', reverseJournal: 'FINANCE_JOURNAL_REVERSE' }[op]; await f.proof(f.a, purpose, { organizationId: org, idempotencyKey: key, payload, ...(etag ? { expectedETag: etag } : {}) }, id); return await settle(() => f.runtime.finance.mutate(f.a.issued.context, op, org, payload, key, id, etag)); };
    const transfer = async (from, to, amount) => await s2('createTransfer', { currency: 'COP', effectiveDate: today(), sourceId: randomUUID(), supportReference: 'SYN-TR', description: 'Traslado sintético', fromAccountId: from, toAccountId: to, amount });
    /** Collections fact command (dispatch/receive/cancel/return...) returning a Reply. */
    const act = async (operation, id, actor, extra = {}) => await settle(() => f.act(operation, id, actor, extra));
    const count = async (id, amount, actor = f.o) => await settle(() => f.count(id, amount, actor));
    const request = async (amount) => { const p = await prepared(() => f.request(amount)); if (p.failed)
        return { ...p.failed, prep: undefined, id: undefined }; const r = await settle(p.p.execute); return { ...r, prep: p.p, id: r.data?.['entityId'] }; };
    const confirm = async (id, compensation = false) => { const p = await prepared(() => f.confirm(id, compensation)); if (p.failed)
        return { ...p.failed, prep: undefined }; return { ...(await settle(p.p.execute)), prep: p.p }; };
    const compensate = async (originalId, key = randomUUID()) => { const d = await f.readCollections('getCashDelivery', originalId); const p = await prepared(() => f.prepareCollections({ kind: 'COMPENSATE_REQUEST', originalDeliveryId: originalId, resourceETag: d.etag, reason: 'Compensación sintética', supportReference: 'SYN-COMP' }, f.a, key)); if (p.failed)
        return { ...p.failed, prep: undefined, id: undefined }; const r = await settle(p.p.execute); return { ...r, prep: p.p, id: r.data?.['entityId'] }; };
    const delivery = async (id) => await f.delivery(id);
    return { f, org, db, today, settle, st, prepared, ledger, journals, digest, position, s2, transfer, act, count, request, confirm, compensate, delivery };
}
//# sourceMappingURL=review-fixtures.js.map