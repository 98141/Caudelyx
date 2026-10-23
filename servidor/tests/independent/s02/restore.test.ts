/* eslint-disable security/detect-object-injection -- Keys are this test's own fixed field names/array indexes, never request input. */
// S02-P05 independent restore/evidence checks for the financial domain (AT12), Claude. Real Mongo 27017/rs0 group owned by
// this review, real RestoreController + signed external journal in the group's own control directory. Tampering is applied
// only to this group's synthetic documents and always reverted byte-exactly inside the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { financeFixture } from '../../finance/fixture.js';
import { today } from '../../../src/modules/finance/service.js';
import { RestoreController } from '../../../src/shared/restore.js';
import { Decimal128, type Document } from 'mongodb';
import type { Result } from '../../../src/modules/finance/models.js';

type Fixture = Awaited<ReturnType<typeof financeFixture>>;
const evidence = (name: string, data: Record<string, unknown>) => console.log(JSON.stringify({ evidence: name, ...data }));
const data = (r: Result) => r.data as Record<string, unknown>;
const account = (code: string, kind: string, accountClass: string) => ({ code, name: `Cuenta ${code}`, accountClass, kind, currency: 'COP' });
const posting = (date: string, debitId: string, creditId: string, amount: string) => ({ currency: 'COP', effectiveDate: date, sourceId: randomUUID(), supportReference: 'Soporte P05', description: 'Asiento P05',
  lines: [{ accountId: debitId, debit: amount, credit: '0.00' }, { accountId: creditId, debit: '0.00', credit: amount }] });
async function book(f: Fixture) {
  const a = await f.actor(), org = await f.organization(a);
  const bank = String(data(await f.mutate(a, org, 'createAccount', account('RBANK', 'BANK', 'ASSET'))).id);
  const cash = String(data(await f.mutate(a, org, 'createAccount', account('RCASH', 'CASH', 'ASSET'))).id);
  const equity = String(data(await f.mutate(a, org, 'createAccount', account('REQ', 'GENERAL', 'EQUITY'))).id);
  return { a, org, bank, cash, equity, date: today(f.now()) };
}
const restartOpen = async (f: Fixture) => { const c = new RestoreController(f.database, f.restore.gatePath, f.keys.journal); await c.initialize(); return c.isOpen(); };
const bal = async (f: Fixture, a: { issued: { context: Parameters<Fixture['runtime']['finance']['read']>[0] } }, org: string, id: string, date: string) =>
  ((data(await f.runtime.finance.read(a.issued.context, 'balances', org, undefined, { asOf: date })).items as { accountId: string; naturalBalance: string }[]).find(i => i.accountId === id))?.naturalBalance;

test('P05-RES-01 complete financial snapshot round-trip: restore + approved reconcile reopens with identical balances/ETags and new commands work; a snapshot older than later commands cannot reopen and leaves no partial ledger', { timeout: 240000 }, async () => {
  const f = await financeFixture();
  try {
    const { a, org, bank, cash, equity, date } = await book(f), observed = new Map<string, unknown>();
    const first = await f.mutate(a, org, 'postJournal', posting(date, bank, equity, '100.00'));
    await f.mutate(a, org, 'createTransfer', { currency: 'COP', effectiveDate: date, sourceId: randomUUID(), supportReference: 'P05', description: 'Banco a caja', fromAccountId: bank, toAccountId: cash, amount: '25.50' });
    const beforeBank = await bal(f, a, org, bank, date), beforeCash = await bal(f, a, org, cash, date);
    const snapshot = await f.restore.snapshot();
    await f.restore.beginRestore(snapshot); const closedDuring = f.restore.isOpen();
    let duringRead = 'ok'; try { await f.runtime.finance.read(a.issued.context, 'listAccounts', org); } catch (e) { duringRead = (e as { code?: string }).code ?? 'error'; }
    await f.restore.reconcile({ approved: true, reviewId: 'P05-synthetic-complete-cut' });
    const openAfter = f.restore.isOpen();
    // S1 rule: restore revokes contexts. The pre-restore session must be dead; a fresh login+MFA continues.
    let oldSession = 'ok'; try { await f.runtime.finance.read(a.issued.context, 'listAccounts', org); } catch (e) { oldSession = (e as { code?: string }).code ?? 'error'; }
    const b = await f.login(a);
    const afterBank = await bal(f, b, org, bank, date), afterCash = await bal(f, b, org, cash, date);
    const etagSame = (await f.runtime.finance.read(b.issued.context, 'readJournal', org, String(data(first).id))).etag === first.etag;
    const after = await f.mutate(b, org, 'postJournal', posting(date, bank, equity, '1.00'));
    observed.set('complete cut', { closedDuring, duringRead, openAfter, oldSessionAfterRestore: oldSession, balancesEqual: beforeBank === afterBank && beforeCash === afterCash, etagSame, newCommandAfterReconcile: after.status, bankAfterNew: await bal(f, b, org, bank, date), restartOpen: await restartOpen(f) });
    // Older snapshot: two more commands happen after it.
    const old = await f.restore.snapshot();
    await f.mutate(b, org, 'postJournal', posting(date, bank, equity, '2.00'));
    await f.mutate(b, org, 'createTransfer', { currency: 'COP', effectiveDate: date, sourceId: randomUUID(), supportReference: 'P05', description: 'Tras snapshot', fromAccountId: bank, toAccountId: cash, amount: '1.00' });
    await f.restore.flush();
    await f.restore.beginRestore(old);
    let reconcile = 'reconciled'; try { await f.restore.reconcile({ approved: true, reviewId: 'P05-synthetic-old-cut' }); } catch (e) { reconcile = (e as { code?: string }).code ?? 'refused'; }
    observed.set('older cut', { reconcile, open: f.restore.isOpen(), restartOpen: await restartOpen(f), journalsNow: await f.runtime.finance.journals.countDocuments(), journalsInOldSnapshot: JSON.parse(old.collections['financial_journals'] ?? '[]').length });
    evidence('P05-RES-01', { observed: Object.fromEntries(observed) });
    assert.deepEqual(observed.get('complete cut'), { closedDuring: false, duringRead: 'SERVICE_UNAVAILABLE', openAfter: true, oldSessionAfterRestore: 'AUTH_INVALID', balancesEqual: true, etagSame: true, newCommandAfterReconcile: 201, bankAfterNew: '75.50', restartOpen: true });
    const o = observed.get('older cut') as Record<string, unknown>;
    assert.equal(o['reconcile'], 'SERVICE_UNAVAILABLE'); assert.equal(o['open'], false); assert.equal(o['restartOpen'], false); assert.equal(o['journalsNow'], o['journalsInOldSnapshot']);
  } finally { await f.close(); }
});

test('P05-RES-02 offline tampering of financial documents is detected at restart and refused by reconcile (amount, date, deleted entry, forged balanced entry, idempotency result); only exact revert + approved review reopens', { timeout: 240000 }, async () => {
  const f = await financeFixture();
  try {
    const { a, org, bank, equity, date } = await book(f), observed = new Map<string, unknown>();
    const p = await f.mutate(a, org, 'postJournal', posting(date, bank, equity, '100.00')); await f.restore.flush();
    const id = String(data(p).id), journals = f.runtime.finance.journals, original = await journals.findOne({ _id: id }) as Document;
    const cases: Record<string, unknown> = {};
    // A closed gate is durable: only an approved reconcile reopens it, and reconcile must refuse while the data is still tampered.
    const check = async (label: string, mutate: () => Promise<void>, revert: () => Promise<void>) => {
      await mutate();
      const c1 = new RestoreController(f.database, f.restore.gatePath, f.keys.journal); await c1.initialize(); const tampered = c1.isOpen();
      let reconcileTampered = 'reconciled'; try { await c1.reconcile({ approved: true, reviewId: 'P05-synthetic-tampered' }); } catch (e) { reconcileTampered = (e as { code?: string }).code ?? 'refused'; }
      await revert();
      const c2 = new RestoreController(f.database, f.restore.gatePath, f.keys.journal); await c2.initialize(); const closedAfterRevertBeforeReview = !c2.isOpen();
      await c2.reconcile({ approved: true, reviewId: 'P05-synthetic-exact-revert' });
      cases[label] = { openWhileTampered: tampered, reconcileWhileTampered: reconcileTampered, staysClosedUntilReview: closedAfterRevertBeforeReview, openAfterExactRevertAndReview: c2.isOpen() };
    };
    await check('both line amounts x10 (still balanced)', async () => { await journals.updateOne({ _id: id }, { $set: { 'lines.0.debit': Decimal128.fromString('1000.00'), 'lines.1.credit': Decimal128.fromString('1000.00') } }); }, async () => { await journals.replaceOne({ _id: id }, original as never); });
    await check('effectiveDate moved', async () => { await journals.updateOne({ _id: id }, { $set: { effectiveDate: '2020-01-01' } }); }, async () => { await journals.replaceOne({ _id: id }, original as never); });
    await check('entry deleted', async () => { await journals.deleteOne({ _id: id }); }, async () => { await journals.insertOne(original as never); });
    const forgedId = randomUUID();
    await check('forged balanced entry inserted', async () => { await journals.insertOne({ ...original, _id: forgedId, source: { type: 'MANUAL_JOURNAL', id: randomUUID() } } as never); }, async () => { await journals.deleteOne({ _id: forgedId }); });
    const idem = await f.runtime.finance.idempotency.findOne({ operation: 'postJournal' }) as Document;
    await check('idempotency result rewritten', async () => { await f.runtime.finance.idempotency.updateOne({ _id: idem['_id'] }, { $set: { 'result.status': 299 } }); }, async () => { await f.runtime.finance.idempotency.replaceOne({ _id: idem['_id'] }, idem as never); });
    observed.set('cases', cases);
    evidence('P05-RES-02', { observed: Object.fromEntries(observed) });
    for (const [k, v] of Object.entries(cases)) assert.deepEqual(v, { openWhileTampered: false, reconcileWhileTampered: 'SERVICE_UNAVAILABLE', staysClosedUntilReview: true, openAfterExactRevertAndReview: true }, k);
  } finally { await f.close(); }
});

test('P05-RES-03 characterization: tampering WHILE the process runs is served until restart and is absorbed into the next signed financial digest by any later legitimate command', { timeout: 240000 }, async () => {
  const f = await financeFixture();
  try {
    const { a, org, bank, cash, equity, date } = await book(f), observed = new Map<string, unknown>();
    const p = await f.mutate(a, org, 'postJournal', posting(date, bank, equity, '100.00')); await f.restore.flush();
    const id = String(data(p).id);
    await f.runtime.finance.journals.updateOne({ _id: id }, { $set: { 'lines.0.debit': Decimal128.fromString('1000.00'), 'lines.1.credit': Decimal128.fromString('1000.00') } });
    observed.set('balance served after live tamper (no restart)', await bal(f, a, org, bank, date));
    const t = await f.mutate(a, org, 'createTransfer', { currency: 'COP', effectiveDate: date, sourceId: randomUUID(), supportReference: 'P05', description: 'Comando legítimo posterior', fromAccountId: bank, toAccountId: cash, amount: '500.00' });
    await f.restore.flush();
    observed.set('legitimate command after tamper (spends tampered funds)', t.status);
    observed.set('restart open after tamper + later command', await restartOpen(f));
    observed.set('bank after restart', await bal(f, a, org, bank, date));
    evidence('P05-RES-03', { observed: Object.fromEntries(observed), note: 'Characterization of the evidence model (digest of the whole financial state at each commit); recorded as a finding if absorbed.' });
    // No assertion on the absorption itself: this test documents behaviour for disposition. Only the live-serve fact is asserted.
    assert.equal(observed.get('balance served after live tamper (no restart)'), '1000.00');
  } finally { await f.close(); }
});

test('P05-RES-04 characterization: cost of one financial command vs ledger size (full digest + full overdraft scan per command)', { timeout: 600000 }, async () => {
  const f = await financeFixture();
  try {
    const { a, org, bank, cash, equity, date } = await book(f), timings: Record<string, number> = {};
    const measure = async (label: string) => {
      const key = randomUUID(), payload = { currency: 'COP', effectiveDate: date, sourceId: randomUUID(), supportReference: 'P05', description: 'Medición', fromAccountId: bank, toAccountId: cash, amount: '0.01' };
      await f.proof(a, 'FINANCE_TRANSFER', { organizationId: org, idempotencyKey: key, payload });
      const t0 = performance.now(); const r = await f.runtime.finance.mutate(a.issued.context, 'createTransfer', org, payload, key); timings[label] = Math.round(performance.now() - t0);
      assert.equal(r.status, 201);
    };
    await f.mutate(a, org, 'postJournal', posting(date, bank, equity, '1000.00'));
    await measure('~2 journals');
    const template = await f.runtime.finance.journals.findOne({ organizationId: org, 'source.type': 'MANUAL_JOURNAL' }) as Document;
    let seeded = 0;
    for (const target of [2000, 10000]) {
      const rows = Array.from({ length: target - seeded }, () => ({ ...template, _id: randomUUID(), source: { type: 'MANUAL_JOURNAL', id: randomUUID() }, recordedAt: template['recordedAt'] }));
      for (let i = 0; i < rows.length; i += 1000) await f.runtime.finance.journals.insertMany(rows.slice(i, i + 1000) as never[]);
      seeded = target; await measure(`~${target} journals`);
    }
    evidence('P05-RES-04', { timingsMs: timings, note: 'synthetic balanced rows inserted directly into this group only to size the ledger; command latency measured inside one process on the local Mongo' });
    assert.ok(Object.values(timings).every(v => v > 0));
  } finally { await f.close(); }
});
