/* eslint-disable security/detect-object-injection -- Own fixed account/collection maps of this review, never request input. */
// S06-P05 reviewer world (Claude). Drives the REAL S6 service through the author fixture mechanics (tests/s06/fixture.ts:
// seed, actors with TOTP, proofs per W class), in the reviewer's own group. Expected money never comes from here: tests
// compare what this module READS (ledger lines, domain rows, API projections) with the own oracle (oracle.ts).
import { randomUUID, createHash } from 'node:crypto';
import { BSON } from 'mongodb';
import { setup, code } from '../../s06/fixture.js';
export { code };
export const S6 = ['payment_books', 'payments', 'payment_transitions', 'payment_approvals', 'cash_custody', 'custody_bindings', 'custody_movements', 'payment_commands', 'payment_event_snapshots', 'loan_compensations', 'payment_registration_scopes', 'held_funds_profiles', 'held_funds_reservations', 'bank_declarations', 'reconciliation_events', 'payment_reversal_requests'];
export const S5 = ['loan_operation_books', 'loan_positions', 'loan_schedule_versions', 'loan_installments', 'loan_accruals', 'loan_events', 'loan_applications', 'borrower_credits', 'loan_operation_idempotency'];
export const LEDGER = ['financial_journals', 'financial_books', 'financial_evidence_head', 'financial_idempotency'];
export const EVIDENCE = ['lending_merkle_nodes', 'lending_merkle_orgs', 'lending_domain_state'];
export const AUDIT = ['audit_events', 'outbox', 'security_evidence_outbox'];
export const toC = (v) => { const t = String(v), neg = t.startsWith('-'), [w = '0', f = ''] = t.replace('-', '').split('.'); const n = BigInt(w) * 100n + BigInt((f + '00').slice(0, 2)); return neg ? -n : n; };
export const mm = (v) => { const neg = v < 0n, a = neg ? -v : v; return (neg ? '-' : '') + (a / 100n).toString() + '.' + (a % 100n).toString().padStart(2, '0'); };
export async function world(group, options = {}) {
    const f = await setup(group, options), pay = f.pay, org = f.org;
    const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(f.now()));
    const db = f.database.db;
    /** Ledger read from the own group: natural debit-credit per account id. */
    const ledger = async () => { const t = new Map(); for (const j of await db.collection('financial_journals').find({ organizationId: org }).toArray())
        for (const l of j['lines'])
            t.set(l.accountId, (t.get(l.accountId) ?? 0n) + toC(l.debit) - toC(l.credit)); return t; };
    const journals = async (filter = {}) => await db.collection('financial_journals').countDocuments({ organizationId: org, ...filter });
    /** Canonical digest of whole collections (all orgs): any write — domain, ledger, evidence, audit — changes it. */
    const digest = async (names) => { const h = createHash('sha256'); for (const n of names) {
        h.update(n);
        h.update(BSON.EJSON.stringify(await db.collection(n).find({}).sort({ _id: 1 }).toArray(), { relaxed: false }));
    } return h.digest('hex'); };
    const counts = async (names) => Object.fromEntries(await Promise.all(names.map(async (n) => [n, await db.collection(n).countDocuments({})])));
    /** Run a payment mutation and return status/code instead of throwing. */
    const settle = async (fn) => { try {
        const r = await fn();
        return { status: r.status, data: r.data };
    }
    catch (e) {
        return { status: Number(e.status ?? 500), code: String(e.code ?? e.message) };
    } };
    const st = (r) => `${r.status}${r.code ? ' ' + r.code : ''}`;
    const readPay = async (id, actor = f.a) => { const r = await pay.read(actor.issued.context, 'getPayment', org, id); return { etag: r.etag, ...r.data }; };
    const position = async (loanId) => (await f.position(loanId)).data;
    const installments = async (loanId) => (await f.ops.read(f.a.issued.context, 'listLoanInstallments', org, loanId, { limit: 100 })).data.items;
    const credit = async (borrowerId) => String((await db.collection('borrower_credits').findOne({ _id: borrowerId, organizationId: org }))?.['balance'] ?? '0.00');
    const custody = async (paymentId) => await db.collection('cash_custody').findOne({ organizationId: org, paymentId });
    const held = async () => await db.collection('held_funds_reservations').find({ organizationId: org }).toArray();
    /** Preview-stage rejections are reported as 'preview <status> <code>'; command-stage as '<status> <code>'. */
    const prepare = async (command, actor, key) => { try {
        return { prepared: await f.preparePayment(command, actor, key) };
    }
    catch (e) {
        return { failed: { status: Number(e.status ?? 500), code: 'preview ' + String(e.code ?? e.message) } };
    } };
    const register = async (intent, mode, actor = f.a, key = randomUUID()) => { const p = await prepare({ kind: 'REGISTER', mode, effectiveDate: today(), intent }, actor, key); if (p.failed)
        return { ...p.failed, prepared: undefined, id: undefined }; const r = await settle(p.prepared.execute); return { ...r, prepared: p.prepared, id: r.data?.['entityId'] }; };
    const approve = async (paymentId, actor, key = randomUUID()) => { const pr = await readPay(paymentId), v = await f.state(); const p = await prepare({ kind: 'APPROVE', paymentId, resourceETag: pr.etag, effectiveDate: today(), expectedOperationsETag: v.operationsBookETag }, actor, key); if (p.failed)
        return { ...p.failed, prepared: undefined }; return { ...(await settle(p.prepared.execute)), prepared: p.prepared }; };
    const decide = async (op, paymentId, actor) => { const p = await readPay(paymentId); return await settle(() => f.mutatePayment(op, { resourceETag: p.etag, reason: 'Motivo sintético', supportReference: 'SYN-DEC' }, paymentId, actor)); };
    const returnCash = async (paymentId, actor, amount) => { const p = await readPay(paymentId), cu = await pay.read(f.a.issued.context, 'getCashCustody', org, paymentId); return await settle(() => f.mutatePayment('returnProvisionalCash', { resourceETag: p.etag, custodyETag: cu.etag, amount, returnedAt: new Date(f.now() - 1000).toISOString(), recipientReference: 'SYN-RECIPIENT', reason: 'Devolución sintética', supportReference: 'SYN-RET' }, paymentId, actor)); };
    const requestReversal = async (eventId) => { const old = await db.collection('payment_reversal_requests').findOne({ _id: eventId, organizationId: org }); return await settle(() => f.mutatePayment('requestPaymentReversal', { resourceETag: old ? `"${eventId}:${String(old['version'])}"` : `"${eventId}:1"`, reason: 'Corrección sintética', supportReference: 'SYN-REV' }, eventId)); };
    const executeReversal = async (eventId, paymentId, key = randomUUID()) => { const request = await pay.read(f.a.issued.context, 'getLoanEventReversalRequest', org, eventId), v = await f.state(); const p = await prepare({ kind: 'EXECUTE_REVERSAL', paymentId, originalEventId: eventId, resourceETag: request.etag, reversalRequestId: eventId, effectiveDate: today(), expectedOperationsETag: v.operationsBookETag, supportReference: 'SYN-REV' }, f.a, key); if (p.failed)
        return { ...p.failed, prepared: undefined }; return { ...(await settle(p.prepared.execute)), prepared: p.prepared }; };
    const reverseAll = async (eventId, paymentId) => { const r = await requestReversal(eventId); if (r.status !== 201)
        return { request: r, execute: null }; return { request: r, execute: await executeReversal(eventId, paymentId) }; };
    /** S2 writers on the own book (with the W proof each class requires). */
    const s2 = async (op, payload, id, etag) => { const key = randomUUID(), purpose = { createTransfer: 'FINANCE_TRANSFER', postJournal: 'FINANCE_JOURNAL_POST', reverseJournal: 'FINANCE_JOURNAL_REVERSE' }[op]; await f.proof(f.a, purpose, { organizationId: org, idempotencyKey: key, payload, ...(etag ? { expectedETag: etag } : {}) }, id); return await settle(() => f.runtime.finance.mutate(f.a.issued.context, op, org, payload, key, id, etag)); };
    const transfer = async (from, to, amount) => await s2('createTransfer', { currency: 'COP', effectiveDate: today(), sourceId: randomUUID(), supportReference: 'SYN-TR', description: 'Traslado sintético', fromAccountId: from, toAccountId: to, amount });
    /** S5 direct writers (ACCRUE / APPLY_CREDIT / legacy RECEIPT) through the S5 service. */
    const s5 = async (request) => { try {
        const c = await f.make(request);
        return await settle(c.execute);
    }
    catch (e) {
        return { status: Number(e.status ?? 500), code: String(e.code) };
    } };
    const accrue = async (loanId) => await s5({ kind: 'ACCRUE', loanId, positionETag: (await f.position(loanId)).etag, throughDate: today(), effectiveDate: today(), supportReference: 'SYN-ACC' });
    const applyCredit = async (borrowerId, loanId, amount) => { const cr = await f.ops.read(f.a.issued.context, 'getBorrowerCredit', org, borrowerId); return await s5({ kind: 'APPLY_CREDIT', borrowerId, creditETag: cr.etag, amount, targets: [{ loanId, positionETag: (await f.position(loanId)).etag, amount, mode: 'REGULAR' }], effectiveDate: today(), supportReference: 'SYN-AC' }); };
    const scope = async (registrarId, loanId, active, scopeId = randomUUID()) => { const old = await db.collection('payment_registration_scopes').findOne({ _id: scopeId, organizationId: org }); const r = await settle(() => f.mutatePayment('setPaymentRegistrationScope', { scopeId, registrarId, loanId, scope: 'PAYMENT_REGISTER_ONLY', active, resourceETag: old ? `"${scopeId}:${String(old['version'])}"` : `"${scopeId}:0"`, supportReference: 'SYN-SCOPE' })); return { ...r, scopeId }; };
    const declare = async (accountId, amount, valueDate, reference, line = randomUUID().slice(0, 12)) => { const a = await f.runtime.finance.read(f.a.issued.context, 'readAccount', org, accountId); return await settle(() => f.mutatePayment('createBankDeclaration', { accountId, accountETag: a.etag, currency: 'COP', direction: 'INCOMING', amount, valueDate, reference, source: 'MANUAL_DECLARATION', declaredBankName: 'Banco sintético', statementReference: 'EXT-1', lineReference: line, supportReference: 'SYN-DECL' })); };
    const declaration = async (id) => { const r = await pay.read(f.a.issued.context, 'getBankDeclaration', org, id); const items = r.data.items; const row = items ? items[0] : r.data; return { ...row, etag: `"${id}:${String(row['version'])}"` }; };
    const link = async (paymentId, declarationId) => { const p = await readPay(paymentId), d = await declaration(declarationId); return await settle(() => f.mutatePayment('linkReconciliation', { paymentId, paymentETag: p.etag, bankDeclarationId: declarationId, bankDeclarationETag: d.etag, supportReference: 'SYN-LINK' })); };
    const unlink = async (paymentId, declarationId) => { const p = await readPay(paymentId), d = await declaration(declarationId); return await settle(() => f.mutatePayment('unlinkReconciliation', { paymentId, paymentETag: p.etag, bankDeclarationId: declarationId, bankDeclarationETag: d.etag, linkId: String(d['activeLinkId']), reason: 'Desvinculación sintética', supportReference: 'SYN-UNLINK' })); };
    const dispose = async (paymentId, state) => { const p = await readPay(paymentId); return await settle(() => f.mutatePayment('disposeReconciliation', { paymentId, resourceETag: p.etag, state, reason: 'Revisión sintética', supportReference: 'SYN-DISP' })); };
    const voidDecl = async (id) => { const d = await declaration(id); return await settle(() => f.mutatePayment('voidBankDeclaration', { resourceETag: d.etag, reason: 'Anulación sintética', supportReference: 'SYN-VOID' }, id)); };
    return { f, pay, org, db, today, prepare, ledger, journals, digest, counts, settle, st, readPay, position, installments, credit, custody, held, register, approve, decide, returnCash, requestReversal, executeReversal, reverseAll, s2, transfer, s5, accrue, applyCredit, scope, declare, declaration, link, unlink, dispose, voidDecl };
}
//# sourceMappingURL=review-fixtures.js.map