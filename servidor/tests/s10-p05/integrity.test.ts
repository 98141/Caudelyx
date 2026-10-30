/* eslint-disable security/detect-object-injection -- Own fixed labels/collection names of this review, never request input. */
// S10-P05 own integrity review (Claude): acquisition atomicity at S10 boundaries not injected by the author (asset funding, source claims,
// fund events, audit append), replay / same-key-different-body / stale ETag, valuation K unit (K−1 ms excludes, K includes), then
// tamper+undo (closed, no reseal) and a deleted asset original on reactivation (never reopened as empty). Digests cover every
// collection of the 3 own databases except observer barriers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { s10ReviewProfile } from './review-profile.js';
import { world, evidence, info, idOf, type World } from './review-fixtures.js';
import { wealthContract } from '../../src/modules/wealth/contract.js';
import type { Data } from '../../src/modules/obligations/models.js';

const D = '2026-10-28', BARRIERS = ['reporting_projection_barriers', 's09_projection_barriers'];
test('S10-P05 integridad propia: adquisición atómica, idempotencia, K de valoración, manipulación y fuente ausente', { timeout: 900000 }, async () => {
  const group = await s10ReviewProfile(), o: Record<string, unknown> = {}, fail: string[] = [];
  const expect = (at: string, got: unknown, want: unknown) => { const g = JSON.stringify(got), w = JSON.stringify(want); o['check ' + at] = g === w ? 'PASS' : { got, want }; if (g !== w) fail.push(`${at}: ${g} ≠ ${w}`); };
  try {
    const x: World = await world(group), P = { bookId: x.book.id };
    const ok = async (label: string, fn: () => Promise<{ status: number; data?: unknown; etag?: string }>) => { const r = await x.settle(fn); o[label] = x.st(r); if (![200, 201].includes(r.status)) throw Error(`${label}: ${x.st(r)}`); return r; };
    const ptag = async () => String((await x.wealthRead('personalGetWealthBook', P)).etag), asset = async (id: string, q: Data = { asOf: D }) => await x.wealthRead('personalGetAsset', { ...P, assetId: id }, q);
    const wallet = (await x.personal('I_WALLET', 'ASSET', 'BANK')).id, cap = (await x.personal('I_CAP', 'EQUITY')).id, prop = (await x.personal('I_PROP', 'ASSET')).id;
    await ok('aporte 100M', async () => x.wealthMutate('personalRecordExternalFunds', { bookETag: await ptag(), effectiveDate: D, amount: '100000000.00', cashAccountId: wallet, provenanceKind: 'DECLARED', supportReference: 'SYN-R10-INT', nature: 'OWNER_CAPITAL_CONTRIBUTION', equityAccountId: cap, contributorReference: 'SYN-R10' }, P));
    const fund = await ok('fondo', () => x.wealthMutate('personalCreateFund', { mode: 'VIRTUAL', label: 'Fondo integridad', purpose: 'ASSET_PURCHASE', backingAccountId: wallet, supportReference: 'SYN-R10-INT' }, P)), fp = { ...P, fundId: idOf(fund) };
    await ok('asignar 30M', async () => x.wealthMutate('personalAllocateFund', { bookETag: await ptag(), effectiveDate: D, amount: '30000000.00', supportReference: 'SYN-R10-INT' }, fp, (await x.wealthRead('personalGetFund', fp)).etag));
    const draft = async () => idOf(await ok('borrador', () => x.wealthMutate('personalCreateAssetDraft', { assetClass: 'HOUSE', otherClassDescription: null, label: 'Bien integridad', origin: 'PURCHASE', legalOwnerReference: 'SYN-R10', ownershipPercentage: '100.00', grossCostDeclared: '15000000.00', assetAccountId: prop, supportReferences: ['SYN-R10'], locationGeneral: null }, P)));
    const body = async () => ({ bookETag: await ptag(), effectiveDate: D, ownedConsideration: '15000000.00', capitalizedCosts: [], funding: [{ nature: 'RELEASED_SAVINGS', settlementMode: 'CONSUME_RESERVATION', fundId: fp.fundId, accountId: wallet, amount: '10000000.00', provenanceKind: 'DECLARED', reference: 'SYN-R10-SAV' }, { nature: 'EXISTING_CASH', settlementMode: 'FROM_ACCOUNT', accountId: wallet, sourceJournalId: null, amount: '5000000.00', provenanceKind: 'UNKNOWN', reference: 'SYN-R10-UNK' }], supportReference: 'SYN-R10-INT-ACQ' } as Data);
    const prove = async (op: string, params: Record<string, string>, payload: Data, key: string, expected?: string) => await x.proof(x.a, wealthContract().operations.get(op)!.definition['x-purpose']!, { operationId: op, idempotencyKey: key, bookId: x.book.id, pathParameters: params, payload, ...(expected ? { expectedETag: expected } : {}) }, params['assetId'] ?? params['fundId']);
    const digest = async () => await x.digestAll(BARRIERS);
    // ---- atomicity at four boundaries
    const store = x.service.store, put = store.put.bind(store), audit = x.identity.audit.append.bind(x.identity.audit);
    for (const boundary of ['s10_asset_funding_personal', 's10_source_claims_personal', 's10_fund_events_personal', 'AUDIT']) {
      const id = await draft(), params = { ...P, assetId: id }, payload = await body(), key = randomUUID(), etag = (await asset(id)).etag; await prove('personalAcquireAsset', params, payload, key, etag); const before = await digest();
      let hit = false;
      if (boundary === 'AUDIT') x.identity.audit.append = (async (...args: Parameters<typeof audit>) => { await audit(...args); hit = true; throw Error('SYN_R10_AUDIT'); }) as typeof audit;
      else store.put = (async (...args: Parameters<typeof put>) => { const r = await put(...args); if (args[0] === boundary) { hit = true; throw Error('SYN_R10_BOUNDARY_' + boundary); } return r; }) as typeof put;
      let res; try { res = await x.settle(() => x.wealth.mutate(x.a.issued.context, 'personalAcquireAsset', payload, params, key, etag) as never); } finally { store.put = put; x.identity.audit.append = audit; }
      o[`frontera ${boundary}`] = { reached: hit, result: x.st(res) };
      if (hit) expect(`fallo tras escribir ${boundary}: error y 0 cambios en las 3 bases`, [res.status >= 400, x.diff(before, await digest())], [true, []]);
      else o[`frontera ${boundary} no alcanzada`] = 'NO CUBIERTA (la adquisición no escribe esa colección)';
    }
    const reached = Object.entries(o).filter(([k, v]) => k.startsWith('frontera ') && (v as { reached?: boolean }).reached).length; expect('al menos 3 fronteras alcanzadas', reached >= 3, true);
    // ---- replay / conflict / stale
    const id = await draft(), params = { ...P, assetId: id }, payload = await body(), key = randomUUID(), etag = (await asset(id)).etag;
    const first = await ok('adquisición', () => x.wealthMutate('personalAcquireAsset', payload, params, etag, key)), c1 = await x.counts();
    const again = await x.settle(() => x.wealthMutate('personalAcquireAsset', payload, params, etag, key));
    expect('replay misma clave: 200, mismo dato, 0 efectos', [again.status, JSON.stringify(again.data) === JSON.stringify(first.data), await x.counts()], [200, true, c1]);
    const conflict = await x.settle(() => x.wealthMutate('personalAcquireAsset', { ...payload, supportReference: 'OTRO' }, params, etag, key)); expect('misma clave cuerpo distinto: 409 sin efectos', [x.st(conflict), await x.counts()], ['409 IDEMPOTENCY_CONFLICT', c1]);
    const id2 = await draft(), stale = await x.settle(async () => x.wealthMutate('personalAcquireAsset', { ...payload }, { ...P, assetId: id2 }, (await asset(id2)).etag)); expect('ETag de libro anterior: 412 sin efectos', [x.st(stale), (await x.counts()).assetEvents], ['412 PRECONDITION_FAILED', c1.assetEvents]);
    expect('reserva tras una compra con 10M de fondo: 20M', info(await x.wealthRead('personalGetFund', fp))['reserved'], '20000000.00');
    // ---- valuation K unit
    await ok('valoración 18M', async () => x.wealthMutate('personalRecordAssetValuation', { valuationDate: D, grossEstimatedValue: '18000000.00', method: 'OWNER_ESTIMATE', sourceReference: 'SYN-R10', supportReference: 'SYN-R10-VAL' }, params, (await asset(id)).etag));
    const val = (await x.rows('s10_asset_valuations_personal', { assetId: id }))[0] ?? (await x.rows('s10_asset_valuations_personal')).at(-1)!, unit = String(val['unitKnownAt'] ?? val['recordedAt']), beforeK = new Date(Date.parse(unit) - 1).toISOString();
    const vb = info(await asset(id, { asOf: D, recordedThrough: beforeK })), va = info(await asset(id, { asOf: D, recordedThrough: unit }));
    expect('K valoración: K−1 ms sin estimado (null) / K = 18M', [vb['ownedEstimatedValue'] ?? null, va['ownedEstimatedValue']], [null, '18000000.00']);
    // ---- tamper + undo (closed), then deleted original on reactivation
    const raw = x.database.client.db(x.database.db.databaseName), assets = raw.collection<Data & { _id: string }>('s10_assets_personal'), victim = (await assets.findOne({ _id: id }))!;
    await assets.updateOne({ _id: id }, { $set: { label: 'SYN-R10-TAMPER' } }); await assets.replaceOne({ _id: id }, victim);
    const u1 = await x.settle(() => asset(id)), u2 = await x.settle(() => x.wealthRead('getPrivateWealth', {}, { asOf: D }));
    expect('manipulación + undo: lecturas cerradas 503 (sin resello)', [u1.status, u2.status], [503, 503]); o['manipulación+undo'] = [x.st(u1), x.st(u2)];
    await x.service.stop(); await x.projection.stop();
    const reopen = async (label: string) => { const r = await x.settle(async () => { await x.service.prepareOwned(x.owner); await x.wealth.prepareOwned(x.owner); await x.service.activateOwned(x.owner); return { status: 200, data: await x.wealth.read(x.a.issued.context, 'personalGetAsset', { ...P, assetId: id }, { asOf: D }) } as never; }); o[label] = x.st(r); return r; };
    const r0 = await reopen('reactivar tras undo (datos idénticos)'); if (r0.status === 200) await x.service.stop();
    await assets.deleteOne({ _id: id }); const r1 = await reopen('reactivar con ficha de activo borrada');
    expect('ficha de activo borrada: no reabre ni sirve libro vacío', [r1.status >= 500, /INTEGRITY|SOURCE|SERVICE/.test(String(r1.code))], [true, true]); try { await x.service.stop(); } catch { /* already closed */ }
    evidence('S10-INTEGRITY', { observed: o, failures: fail });
    assert.deepEqual(fail, [], 'integrity mismatches');
    console.log('S10_P05_INTEGRITY_PASS');
  } catch (e) { evidence('S10-INTEGRITY-PARCIAL', { observed: o, failures: fail, error: String(e).slice(0, 500) }); throw e; } finally { await group.dispose(); }
});
