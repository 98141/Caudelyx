/* eslint-disable security/detect-object-injection -- Own fixed labels/collection names of this review, never request input. */
// S09-P05 own integrity review (Claude): two-book relationship atomicity at boundaries the author did not inject (business event,
// relationship row, idempotency record), replay/conflict/ETag, two-book reversal and double reversal, generic single-leg reversal,
// K unit of both halves vs own oracle (H02), then tamper+undo (closed, no reseal), deleted original and dropped PERSONAL collection
// on reactivation (never reopened as empty). Digests cover every collection of the 3 own databases except observer barriers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { s09ReviewProfile } from './review-profile.js';
import { world, evidence, info, idOf, rate, schedule, type World } from './review-fixtures.js';
import { totals, consolidation, show } from './oracle.js';
import { managementContract } from '../../../src/modules/obligations/contract.js';
import type { Data } from '../../../src/modules/obligations/models.js';

const D = '2026-10-28', BARRIERS = ['reporting_projection_barriers', 's09_projection_barriers'];
test('S09-P05 integridad propia: cruces atómicos, idempotencia, reversos, K, manipulación y fuentes ausentes', { timeout: 900000 }, async () => {
  const group = await s09ReviewProfile(), o: Record<string, unknown> = {}, fail: string[] = [];
  const expect = (at: string, got: unknown, want: unknown) => { const g = JSON.stringify(got), w = JSON.stringify(want); o['check ' + at] = g === w ? 'PASS' : { got, want }; if (g !== w) fail.push(`${at}: ${g} ≠ ${w}`); };
  try {
    const x: World = await world(group), P = { bookId: x.book.id }, B = { organizationId: x.org }, subject = x.a.issued.context.subjectId!;
    const ok = async (label: string, fn: () => Promise<{ status: number; data?: unknown; etag?: string }>) => { const r = await x.settle(fn); o[label] = x.st(r); if (![200, 201].includes(r.status)) throw Error(`${label}: ${x.st(r)}`); return r; };
    const bank = (await x.personal('I_BANK', 'ASSET', 'BANK')).id, debt = (await x.personal('I_DEBT', 'LIABILITY')).id, due = (await x.personal('I_DUE', 'ASSET')).id, bDue = (await x.account('I_BDUE', 'LIABILITY')).id;
    const loan = await ok('fondeo', () => x.mutate('personalCreateLiability', { kind: 'PRIVATE_DEBT', label: 'Fondeo integridad', counterpartyReference: 'SYN-R09-INT', principal: '1000000.00', rate, schedule: schedule([['2026-11-28', '1000000.00']]), prepaymentPermissions: [], supportReference: 'SYN-R09-INT' }, P));
    await ok('fondeo activar', () => x.mutate('personalActivateLiability', { effectiveDate: D, recognitionKind: 'CASH_RECEIPT', principalAccountId: debt, destinationAccountId: bank, legalOwnerReference: 'SYN-R09-OWNER', funding: [{ kind: 'DIRECT_CREDIT', amount: '1000000.00' }], supportReference: 'SYN-R09-INT-ACT' }, { ...P, liabilityId: idOf(loan) }, loan.etag));
    const elig = await ok('FULL100', () => x.mutate('declareOwnEligibility', { right: 'FULL_OWNERSHIP', percentage: '100.00', validFrom: D, supportReference: 'SYN-R09-INT-100' }, B));
    const body = async (amount: string) => { const pb = await x.read('getOwnPersonalBook'), bb = await x.read('getBusinessBook', B); return { kind: 'INTERBOOK_LOAN', businessOrganizationId: x.org, businessBookETag: bb.etag, personalBookETag: pb.etag, eligibilityVersionId: idOf(elig), effectiveDate: D, amount, fromScope: 'PERSONAL', personalCashAccountId: bank, businessCashAccountId: x.bank.id, personalContraAccountId: due, businessContraAccountId: bDue, supportReference: 'SYN-R09-INT-REL' } as Data; };
    /** Proof first (sessions change), then digest, then the command without proof: the digest isolates the command's own effects. */
    const prove = async (operation: string, payload: Data, params: Record<string, string>, key: string, expected?: string) => { const p = managementContract().operations.get(operation)!.definition['x-purpose']!; await x.proof(x.a, p, { operationId: operation, idempotencyKey: key, ...(params['organizationId'] ? { organizationId: params['organizationId'] } : {}), ...(params['bookId'] ? { bookId: params['bookId'] } : {}), pathParameters: params, payload, ...(expected ? { expectedETag: expected } : {}) }, params['relationshipId']); };
    const digest = async () => await x.digestAll(BARRIERS);
    // ---- atomicity at three boundaries not injected by the author
    const store = x.service.store, put = store.put.bind(store);
    for (const boundary of ['s09_events_business', 's09_relationships', 's09_commands']) {
      const key = randomUUID(), payload = await body('1.00'); await prove('postInterbookRelationship', payload, {}, key); const before = await digest();
      store.put = (async (...args: Parameters<typeof put>) => { const r = await put(...args); if (args[0] === boundary) throw Error('SYN_R09_BOUNDARY_' + boundary); return r; }) as typeof put;
      let res; try { res = await x.settle(() => x.mutate('postInterbookRelationship', payload, {}, undefined, key, x.a, false)); } finally { store.put = put; }
      expect(`fallo tras escribir ${boundary}: error y 0 cambios en las 3 bases`, [res.status >= 500 || /SYN_R09/.test(String(res.code)), x.diff(before, await digest())], [true, []]);
    }
    // ---- replay / conflict / stale ETag
    const key = randomUUID(), payload = await body('100000.00'); await prove('postInterbookRelationship', payload, {}, key);
    const first = await ok('cruce 100k', () => x.mutate('postInterbookRelationship', payload, {}, undefined, key, x.a, false)), c1 = await x.counts();
    const again = await x.settle(() => x.mutate('postInterbookRelationship', payload, {}, undefined, key, x.a, false));
    expect('replay misma clave: 200, mismo id, 0 efectos', [again.status, idOf(again), await x.counts()], [200, idOf(first), c1]);
    const conflict = await x.settle(() => x.mutate('postInterbookRelationship', { ...payload, amount: '100000.01' }, {}, undefined, key, x.a, true));
    expect('misma clave cuerpo distinto: 409 sin efectos', [x.st(conflict), await x.counts()], ['409 IDEMPOTENCY_CONFLICT', c1]);
    const stale = await x.settle(() => x.mutate('postInterbookRelationship', { ...payload, amount: '1.00' }, {}, undefined, randomUUID()));
    expect('ETag de libros anterior: 412 sin efectos', [x.st(stale), await x.counts()], ['412 PRECONDITION_FAILED', c1]);
    // ---- K unit of both halves (H02/K01) vs own oracle
    const rel = (await x.rows('s09_relationships', { _id: idOf(first) }))[0] as Data, unit = String(rel['unitKnownAt']), before1 = new Date(Date.parse(unit) - 1).toISOString();
    const pe = (await x.rows('s09_events_personal', { _id: (rel['sourceEventIds'] as string[])[0] }))[0] as Data, be = (await x.rows('s09_events_business', { _id: (rel['sourceEventIds'] as string[])[1] }))[0] as Data;
    expect('ambas mitades con la misma unidad K', [pe['unitKnownAt'], be['unitKnownAt']], [unit, unit]);
    const d1 = await x.dump();
    for (const [label, K] of [['K = unidad − 1 ms', before1], ['K = unidad', unit]] as const) {
      const api = info(await x.read('getPrivateConsolidation', {}, { asOf: D, recordedThrough: K })), mine = consolidation(d1, x.book.id, x.org, subject, D, K);
      expect(`${label}: consolidado producto = oráculo (personal, bruto, neto, eliminaciones)`, [api['personalTotals'], api['gross'], api['net'], ((api['eliminations'] as Data[]) ?? []).map(e => e['amount'])], [mine.personal, mine.gross, mine.net, mine.eliminations.map(e => e.amount)]);
      o[`oráculo ${label}`] = { personalCash: mine.personal.cashAvailable, eliminations: mine.eliminations.length };
    }
    expect('K: la unidad −1 ms excluye ambas mitades', [show(totals(d1, 'PERSONAL', x.book.id, D, before1)).cashAvailable, show(totals(d1, 'PERSONAL', x.book.id, D, unit)).cashAvailable], ['1000000.00', '900000.00']);
    // ---- single-leg generic reversal of the business half is closed
    const bj = String((be['journalIds'] as string[])[0]), jrow = (await x.rows('financial_journals', { _id: bj }))[0] as Data, rk = randomUUID(), rp = { effectiveDate: D, sourceId: randomUUID(), supportReference: 'SYN-R09-ONELEG', reason: 'Una sola mitad' }, rtag = `"${bj}:${String(jrow['version'])}"`;
    await x.proof(x.a, 'FINANCE_JOURNAL_REVERSE', { organizationId: x.org, idempotencyKey: rk, payload: rp, expectedETag: rtag }, bj); const c2 = await x.counts();
    const oneLeg = await x.settle(() => x.runtime.finance.mutate(x.a.issued.context, 'reverseJournal', x.org, rp, rk, bj, rtag) as never);
    expect('reverso genérico de la mitad BUSINESS: 409 DOMAIN_REVERSAL_FORBIDDEN sin efectos', [x.st(oneLeg), await x.counts()], ['409 DOMAIN_REVERSAL_FORBIDDEN', c2]);
    // ---- two-book reversal, double reversal
    const relEnvelope = async () => { const pb = await x.read('getOwnPersonalBook'), bb = await x.read('getBusinessBook', B), r = (await x.rows('s09_relationships', { _id: idOf(first) }))[0] as Data; return { pb, bb, etag: `"${idOf(first)}:${String(r['version'])}"` }; };
    let ren = await relEnvelope(); await ok('reverso del cruce', () => x.mutate('reverseInterbookRelationship', { effectiveDate: D, reason: 'Reverso sintético', personalBookETag: ren.pb.etag, businessBookETag: ren.bb.etag, supportReference: 'SYN-R09-REV' }, { relationshipId: idOf(first) }, ren.etag));
    const d2 = await x.dump(), con2 = info(await x.read('getPrivateConsolidation')), m2 = consolidation(d2, x.book.id, x.org, subject, D);
    expect('tras reverso: personal y negocio vuelven (oráculo) y sin eliminación', [show(totals(d2, 'PERSONAL', x.book.id, D)).cashAvailable, m2.eliminations.length, ((con2['eliminations'] as unknown[]) ?? []).length, con2['net']], ['1000000.00', 0, 0, m2.net]);
    expect('tras reverso: originales intactos (2 asientos originales + 2 inversos)', [(await x.rows('s09_personal_journals', { _id: (pe['journalIds'] as string[])[0] })).length, (await x.rows('financial_journals', { _id: bj })).length], [1, 1]);
    ren = await relEnvelope(); const c3 = await x.counts(), twice = await x.settle(() => x.mutate('reverseInterbookRelationship', { effectiveDate: D, reason: 'Otra vez', personalBookETag: ren.pb.etag, businessBookETag: ren.bb.etag, supportReference: 'SYN-R09-REV2' }, { relationshipId: idOf(first) }, ren.etag));
    expect('doble reverso rechazado sin efectos', [twice.status >= 400 && twice.status < 500, await x.counts()], [true, c3]); o['doble reverso'] = x.st(twice);
    // ---- tamper + undo (closed, no reseal); then deleted original and dropped collection on reactivation
    const raw = x.database.client.db(x.database.db.databaseName), journals = raw.collection<Data & { _id: string }>('s09_personal_journals'), victim = (await journals.find({ bookId: x.book.id }).sort({ _id: 1 }).limit(1).toArray())[0]!;
    await journals.updateOne({ _id: victim._id }, { $set: { supportReference: 'SYN-R09-TAMPER' } }); await journals.replaceOne({ _id: victim._id }, victim);
    const afterUndo = await x.settle(() => x.read('getOwnPersonalBook')), consolidationAfter = await x.settle(() => x.read('getPrivateConsolidation'));
    expect('manipulación + undo: lecturas cerradas 503 (sin resello)', [afterUndo.status, consolidationAfter.status], [503, 503]); o['manipulación+undo'] = [x.st(afterUndo), x.st(consolidationAfter)];
    await x.service.stop(); await x.projection.stop();
    const reopen = async (label: string) => { const r = await x.settle(async () => { await x.service.prepareOwned(x.owner); await x.service.activateOwned(x.owner); return { status: 200, data: await x.service.read(x.a.issued.context, 'getOwnPersonalBook', {}, { asOf: D }) } as never; }); o[label] = x.st(r); return r; };
    const r0 = await reopen('reactivar tras undo (datos idénticos)'); if (r0.status === 200) await x.service.stop();
    await journals.deleteOne({ _id: victim._id }); const r1 = await reopen('reactivar con asiento original borrado');
    expect('asiento PERSONAL borrado: no reabre ni sirve libro', r1.status >= 500, true); try { await x.service.stop(); } catch { /* already closed */ }
    await journals.insertOne(victim); await raw.dropCollection('s09_personal_journals'); const r2 = await reopen('reactivar con colección PERSONAL ausente');
    expect('colección PERSONAL ausente: no se abre como libro vacío', r2.status >= 500, true); try { await x.service.stop(); } catch { /* already closed */ }
    evidence('S09-INTEGRITY', { observed: o, failures: fail });
    assert.deepEqual(fail, [], 'integrity mismatches');
    console.log('S09_P05_INTEGRITY_PASS');
  } catch (e) { evidence('S09-INTEGRITY-PARCIAL', { observed: o, failures: fail, error: String(e).slice(0, 400) }); throw e; } finally { await group.dispose(); }
});
