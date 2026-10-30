/* eslint-disable security/detect-object-injection -- Own fixed labels/account maps of this review, never request input. */
// S10-P05 own economic review (Claude) of S10-P04-v1-INTEGRADO, ONE own group. Each checkpoint compares the product with the own
// raw-data oracle (oracle.ts) and with amounts commanded here (REFERENCE_CASES_S10 1.0.0; 40 % case with figures different from the
// author's). BUSINESS: reserve vs writers S2/S9/acquisition, release, concurrency, real transfer. PERSONAL: 200M = 80M + 120M direct
// debt, estimate 220M, rent 2M + linked S9 expense 0.3M, 40 % ownership, private wealth view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { s10ReviewProfile } from './review-profile.js';
import { world, evidence, info, idOf, rate, official, type World } from './review-fixtures.js';
import { totals, show, indicative, money, cents, type Totals } from './oracle.js';
import { wealthContract } from '../../src/modules/wealth/contract.js';
import type { Data } from '../../src/modules/obligations/models.js';

const D = '2026-10-28';
test('S10-P05 economía propia: fondos/escritores/adquisición/estimación/renta/40 % contra oráculo', { timeout: 1200000 }, async () => {
  const group = await s10ReviewProfile(), o: Record<string, unknown> = {}, fail: string[] = [];
  const expect = (at: string, got: unknown, want: unknown) => { const g = JSON.stringify(got), w = JSON.stringify(want); o['check ' + at] = g === w ? 'PASS' : { got, want }; if (g !== w) fail.push(`${at}: ${g} ≠ ${w}`); };
  try {
    const x: World = await world(group), B = { organizationId: x.org }, P = { bookId: x.book.id };
    const ok = async (label: string, fn: () => Promise<{ status: number; data?: unknown; etag?: string; meta?: unknown }>) => { const r = await x.settle(fn); o[label] = x.st(r); if (![200, 201].includes(r.status)) throw Error(`${label}: ${x.st(r)}`); return r; };
    const wb = (op: string, p: Data, ps: Record<string, string> = B, e?: string, k?: string) => x.wealthMutate('business' + op, p, ps, e, k), rb = (op: string, ps: Record<string, string> = B, q: Data = { asOf: D }) => x.wealthRead('business' + op, ps, q);
    const wp = (op: string, p: Data, ps: Record<string, string> = P, e?: string, k?: string) => x.wealthMutate('personal' + op, p, ps, e, k), rp = (op: string, ps: Record<string, string> = P, q: Data = { asOf: D }) => x.wealthRead('personal' + op, ps, q);
    const btag = async () => String((await rb('GetWealthBook')).etag), ptag = async () => String((await rp('GetWealthBook')).etag);
    const bt = async () => show(totals(await x.dump(), 'BUSINESS', x.org, D)), pt = async () => show(totals(await x.dump(), 'PERSONAL', x.book.id, D));
    const sub = (t: Record<keyof Totals, string>, keys: (keyof Totals)[]) => Object.fromEntries(keys.map(k => [k, t[k]]));
    // ======== BUSINESS: reserve 20M, every writer must respect it
    const bank2 = (await x.account('R_BANK2', 'ASSET', 'BANK')).id, bExp = (await x.account('R_BEXP', 'EXPENSE')).id, bPay = (await x.account('R_BPAY', 'LIABILITY')).id, bDebt = (await x.account('R_BDEBT', 'LIABILITY')).id, bAsset = (await x.account('R_BASSET', 'ASSET')).id;
    const fund = await ok('crear fondo VIRTUAL', () => wb('CreateFund', { mode: 'VIRTUAL', label: 'Ahorro revisión', purpose: 'ASSET_PURCHASE', backingAccountId: x.bank.id, supportReference: 'SYN-R10' })), fp = { ...B, fundId: idOf(fund) };
    const getFund = async () => await rb('GetFund', fp), avail = async (accountId: string, fundId?: string) => info(await rb('GetWealthAvailability', B, { asOf: D, accountId, ...(fundId ? { fundId } : {}) }));
    const t0 = await bt(), j0 = (await x.counts()).businessJournals;
    await ok('asignar 20M', async () => wb('AllocateFund', { bookETag: await btag(), effectiveDate: D, amount: '20000000.00', supportReference: 'SYN-R10' }, fp, (await getFund()).etag));
    const a1 = await avail(x.bank.id, fp.fundId); expect('F asignar: libre 0 / reservado 20M / confirmado 20M', [a1['confirmedCash'], a1['fundReserved'], a1['free']], ['20000000.00', '20000000.00', '0.00']);
    expect('F asignar: 0 asientos y totales sin cambio', [(await x.counts()).businessJournals - j0, await bt()], [0, t0]);
    // S9 expense recognized (no cash) and S9 liability received into bank2 (unprotected) to have real S9 writers to test.
    const be = await ok('S9 gasto negocio 1000', () => x.mutate('businessCreateExpense', { nominalDate: D, dueDate: D, description: 'Gasto revisión', category: 'SERVICES', amountMode: 'FIXED', amount: '1000.00', supportReference: 'SYN-R10-BE' }, B)), bep = { ...B, expenseId: idOf(be) };
    await ok('S9 reconocer gasto', async () => x.mutate('businessRecognizeExpense', { amount: '1000.00', effectiveDate: D, expenseAccountId: bExp, payableAccountId: bPay, supportReference: 'SYN-R10-BER' }, bep, (await x.read('getBusinessExpenseEnvelope', bep)).etag));
    const bl = await ok('S9 deuda negocio 1000', () => x.mutate('businessCreateLiability', { kind: 'PRIVATE_DEBT', label: 'Deuda revisión', counterpartyReference: 'SYN-R10', principal: '1000.00', rate, schedule: official('1000.00'), prepaymentPermissions: [], supportReference: 'SYN-R10-BL' }, B)), blp = { ...B, liabilityId: idOf(bl) };
    await ok('S9 activar deuda en BANK2', () => x.mutate('businessActivateLiability', { effectiveDate: D, recognitionKind: 'CASH_RECEIPT', principalAccountId: bDebt, destinationAccountId: bank2, legalOwnerReference: 'SYN-R10', funding: [{ kind: 'DIRECT_CREDIT', amount: '1000.00' }], supportReference: 'SYN-R10-BLA' }, blp, bl.etag));
    const c1 = await x.counts(), writers: [string, () => Promise<unknown>][] = [
      ['S2 traslado entre cuentas', async () => { const key = randomUUID(), payload = { currency: 'COP', effectiveDate: D, sourceId: randomUUID(), supportReference: 'SYN-R10-TR', description: 'Traslado prohibido', fromAccountId: x.bank.id, toAccountId: bank2, amount: '1.00' }; await x.proof(x.a, 'FINANCE_TRANSFER', { organizationId: x.org, idempotencyKey: key, payload }); return x.runtime.finance.mutate(x.a.issued.context, 'createTransfer', x.org, payload, key); }],
      ['S9 pago de gasto', async () => x.mutate('businessPayExpense', { amount: '1.00', effectiveDate: D, cashAccountId: x.bank.id, supportReference: 'SYN-R10-BEP' }, bep, (await x.read('getBusinessExpenseEnvelope', bep)).etag)],
      ['S9 pago de deuda', async () => { const e = await x.read('getBusinessLiabilityEnvelope', blp); return x.mutate('businessPayLiability', { scheduleVersionId: String((info(e)['schedule'] as Data)['id']), effectiveDate: D, amount: '1000.00', cashAccountId: x.bank.id, allocations: [{ installmentNumber: 1, component: 'PRINCIPAL', amount: '1000.00', accountId: bDebt }], supportReference: 'SYN-R10-BLP' }, blp, e.etag); }]];
    for (const [label, fn] of writers) { const r = await x.settle(fn as never); o['escritor ' + label] = x.st(r); expect(`F escritor ${label} no gasta la reserva (409, 0 efectos)`, [r.status, await x.counts()], [409, c1]); }
    await ok('liberar 20M', async () => wb('ReleaseFund', { bookETag: await btag(), effectiveDate: D, amount: '20000000.00', supportReference: 'SYN-R10' }, fp, (await getFund()).etag));
    const t1 = await bt(), a2 = await avail(x.bank.id, fp.fundId);
    expect('F liberar: libre 20M, reservado 0, 0 asientos nuevos por liberar', [a2['free'], a2['fundReserved'], (await x.counts()).businessJournals - c1.businessJournals], ['20000000.00', '0.00', 0]);
    expect('F liberar: activos/patrimonio = antes de asignar (salvo S9 comandado)', sub(t1, ['equity', 'income']), sub(t0, ['equity', 'income']));
    // ---- X01 concurrency: two acquisitions of 15M against the same 20M reserve
    await ok('reasignar 20M', async () => wb('AllocateFund', { bookETag: await btag(), effectiveDate: D, amount: '20000000.00', supportReference: 'SYN-R10' }, fp, (await getFund()).etag));
    const draft = async (label: string) => await ok('borrador ' + label, () => wb('CreateAssetDraft', { assetClass: 'APARTMENT', otherClassDescription: null, label, origin: 'PURCHASE', legalOwnerReference: 'SYN-R10', ownershipPercentage: '100.00', grossCostDeclared: '15000000.00', assetAccountId: bAsset, supportReferences: ['SYN-R10'], locationGeneral: null }));
    const d1 = await draft('Bien concurrente A'), d2 = await draft('Bien concurrente B'), tag = await btag();
    const acquire = (assetId: string, etag?: string) => ({ op: 'businessAcquireAsset', params: { ...B, assetId }, etag, payload: { bookETag: tag, effectiveDate: D, ownedConsideration: '15000000.00', capitalizedCosts: [], funding: [{ nature: 'RELEASED_SAVINGS', settlementMode: 'CONSUME_RESERVATION', fundId: fp.fundId, accountId: x.bank.id, amount: '15000000.00', provenanceKind: 'DECLARED', reference: 'SYN-R10-SAVINGS' }], supportReference: 'SYN-R10-ACQ' } as Data });
    const jobs = [acquire(idOf(d1), (await rb('GetAsset', { ...B, assetId: idOf(d1) })).etag), acquire(idOf(d2), (await rb('GetAsset', { ...B, assetId: idOf(d2) })).etag)].map(j => ({ ...j, key: randomUUID() }));
    for (const j of jobs) await x.proof(x.a, wealthContract().operations.get(j.op)!.definition['x-purpose']!, { operationId: j.op, idempotencyKey: j.key, organizationId: x.org, pathParameters: j.params, payload: j.payload, ...(j.etag ? { expectedETag: j.etag } : {}) }, j.params.assetId);
    const both = await Promise.all(jobs.map(j => x.settle(() => x.wealth.mutate(x.a.issued.context, j.op, j.payload, j.params, j.key, j.etag) as never)));
    o['X01 concurrentes'] = both.map(x.st); const a3 = await avail(x.bank.id, fp.fundId);
    expect('X01 una 201 y otra 409/412; reserva 5M (nunca negativa)', [both.filter(r => r.status === 201).length, both.filter(r => [409, 412].includes(r.status)).length, a3['fundReserved']], [1, 1, '5000000.00']);
    // ---- real transfer of the remaining 5M: no income
    const jt = (await x.counts()).businessJournals, tBefore = await bt();
    await ok('trasladar 5M a BANK2', async () => wb('TransferFund', { bookETag: await btag(), effectiveDate: D, amount: '5000000.00', destinationAccountId: bank2, destinationFundId: null, supportReference: 'SYN-R10-TF' }, fp, (await getFund()).etag));
    const tAfter = await bt(); expect('F traslado real: 1 asiento, ingreso 0, activos/patrimonio iguales', [(await x.counts()).businessJournals - jt, tAfter.income, tAfter.assets, tAfter.equity], [1, tBefore.income, tBefore.assets, tBefore.equity]);
    expect('BUSINESS final = comandado', sub(tAfter, ['assets', 'liabilities', 'equity', 'income', 'expense', 'cash']), { assets: '20001000.00', liabilities: '2000.00', equity: '20000000.00', income: '0.00', expense: '1000.00', cash: '5001000.00' });
    // ======== PERSONAL: 200M = 80M cash + 120M direct seller debt
    const wallet = (await x.personal('R_WALLET', 'ASSET', 'BANK')).id, cap = (await x.personal('R_CAP', 'EQUITY')).id, pAsset = (await x.personal('R_PROP', 'ASSET')).id, pDebt = (await x.personal('R_PDEBT', 'LIABILITY')).id, pInc = (await x.personal('R_RENT', 'INCOME')).id, pExp = (await x.personal('R_COSTS', 'EXPENSE')).id, pPay = (await x.personal('R_PAY', 'LIABILITY')).id;
    const contribute = async (amount: string) => await ok('aporte ' + amount, async () => wp('RecordExternalFunds', { bookETag: await ptag(), effectiveDate: D, amount, cashAccountId: wallet, provenanceKind: 'DECLARED', supportReference: 'SYN-R10', nature: 'OWNER_CAPITAL_CONTRIBUTION', equityAccountId: cap, contributorReference: 'SYN-R10-OWNER' }));
    const pdraft = async (label: string, pct: string, gross: string) => await ok('borrador ' + label, () => wp('CreateAssetDraft', { assetClass: 'HOUSE', otherClassDescription: null, label, origin: 'PURCHASE', legalOwnerReference: 'SYN-R10-OWNER', ownershipPercentage: pct, grossCostDeclared: gross, assetAccountId: pAsset, supportReferences: ['SYN-R10'], locationGeneral: null }));
    const asset = async (id: string, q: Data = { asOf: D }) => await rp('GetAsset', { ...P, assetId: id }, q);
    await contribute('80000000.00'); expect('A01 aporte 80M es patrimonio, no ingreso', sub(await pt(), ['cash', 'equity', 'income']), { cash: '80000000.00', equity: '80000000.00', income: '0.00' });
    const h = await pdraft('Casa revisión', '100.00', '200000000.00'), hp = { ...P, assetId: idOf(h) }; const pj = (await x.counts()).personalJournals;
    const unknown = info(await asset(hp.assetId)); expect('desconocido ≠ 0: borrador sin estimación', [unknown['ownedEstimatedValue'] ?? null, unknown['indicativeEquity'] ?? null], [null, null]);
    await ok('A01 adquirir 200M = 80M caja + 120M deuda directa', async () => wp('AcquireAsset', { bookETag: await ptag(), effectiveDate: D, ownedConsideration: '200000000.00', capitalizedCosts: [], funding: [{ nature: 'EXISTING_CASH', settlementMode: 'FROM_ACCOUNT', accountId: wallet, sourceJournalId: null, amount: '80000000.00', provenanceKind: 'DECLARED', reference: 'SYN-R10-CASH' }, { nature: 'DIRECT_NEW_DEBT', settlementMode: 'DIRECT_SELLER', principalAccountId: pDebt, liabilityDefinition: { kind: 'BANK_LOAN', label: 'Hipoteca revisión', counterpartyReference: 'SYN-R10-BANK', principal: '120000000.00', rate, schedule: official('120000000.00', '2026-11-28'), prepaymentPermissions: [], supportReference: 'SYN-R10' }, amount: '120000000.00', provenanceKind: 'SUPPORTED_REFERENCE', reference: 'SYN-R10-LENDER' }], supportReference: 'SYN-R10-ACQ' }, hp, (await asset(hp.assetId)).etag));
    let av = info(await asset(hp.assetId));
    expect('A01 un asiento; activo 200M, caja 0, pasivo 120M, patrimonio 80M, ingreso 0', [(await x.counts()).personalJournals - pj, sub(await pt(), ['assets', 'cash', 'liabilities', 'equity', 'income'])], [1, { assets: '200000000.00', cash: '0.00', liabilities: '120000000.00', equity: '80000000.00', income: '0.00' }]);
    expect('A01 ficha: costo 200M, principal vinculado 120M', [av['recognizedCost'], av['linkedPrincipal']], ['200000000.00', '120000000.00']);
    // ---- A05 estimate 220M: no posting
    const pv = (await x.counts()).personalJournals, tv = await pt();
    await ok('A05 estimar 220M', async () => wp('RecordAssetValuation', { valuationDate: D, grossEstimatedValue: '220000000.00', method: 'OWNER_ESTIMATE', sourceReference: 'SYN-R10', supportReference: 'SYN-R10' }, hp, (await asset(hp.assetId)).etag));
    av = info(await asset(hp.assetId)); const i100 = indicative('220000000.00', '100.00', '120000000.00');
    expect('A05 estimado = oráculo, costo sin cambio, 0 asientos, totales iguales', [av['ownedEstimatedValue'], av['indicativeEquity'], av['recognizedCost'], (await x.counts()).personalJournals - pv, await pt()], [i100.ownedEstimate, i100.equity, '200000000.00', 0, tv]);
    // ---- A08 rent 2M (replay) + S9 expense 0.3M linked
    const rk = randomUUID(), rpay = async () => ({ bookETag: await ptag(), effectiveDate: D, amount: '2000000.00', cashAccountId: wallet, incomeAccountId: pInc, supportReference: 'SYN-R10-RENT' });
    const rentBody = await rpay(), rentTag = (await asset(hp.assetId)).etag, pr0 = (await x.counts()).personalJournals;
    const r1 = await ok('A08 renta 2M', () => wp('ReceiveAssetRent', rentBody, hp, rentTag, rk)), r2 = await x.settle(() => wp('ReceiveAssetRent', rentBody, hp, rentTag, rk));
    expect('A08 replay misma clave: 200, mismo dato, 1 asiento', [r2.status, JSON.stringify(r2.data) === JSON.stringify(r1.data), (await x.counts()).personalJournals - pr0], [200, true, 1]);
    const due = await ok('S9 gasto 0,3M', () => x.mutate('personalCreateExpense', { nominalDate: D, dueDate: D, description: 'Mantenimiento revisión', category: 'SERVICES', amountMode: 'FIXED', amount: '300000.00', supportReference: 'SYN-R10-EXP' }, P)), dp = { ...P, expenseId: idOf(due) };
    await ok('S9 reconocer+pagar 0,3M', () => x.mutate('personalRecognizeAndPayExpense', { effectiveDate: D, amount: '300000.00', cashAccountId: wallet, expenseAccountId: pExp, payableAccountId: pPay, supportReference: 'SYN-R10-EXPP' }, dp, due.etag));
    const pe = (await x.rows('s09_events_personal', { entityId: idOf(due), kind: 'EXPENSE_PAY' }))[0]!, pl = (await x.counts()).personalJournals;
    await ok('A08 vincular gasto', async () => wp('LinkAssetExpense', { expenseId: idOf(due), sourceEventId: pe._id, amount: '300000.00', effectiveDate: D, supportReference: 'SYN-R10-LINK' }, hp, (await asset(hp.assetId)).etag));
    const pos = info(await rp('GetWealthPositions')); o['posiciones tras renta/gasto'] = pos;
    expect('A08 vínculo sin asiento; caja 1,7M; ingreso 2M; gasto 0,3M', [(await x.counts()).personalJournals - pl, sub(await pt(), ['cash', 'income', 'expense'])], [0, { cash: '1700000.00', income: '2000000.00', expense: '300000.00' }]);
    const dupLink = await x.settle(async () => wp('LinkAssetExpense', { expenseId: idOf(due), sourceEventId: pe._id, amount: '300000.00', effectiveDate: D, supportReference: 'SYN-R10-LINK2' }, hp, (await asset(hp.assetId)).etag));
    expect('A08 segundo vínculo del mismo gasto rechazado', dupLink.status >= 400, true); o['segundo vínculo'] = x.st(dupLink);
    // ======== 40 %: gross 300M, own 120M = 70M cash + 50M existing debt; estimate 350M → 140M; equity 90M
    const loan = await ok('préstamo recibido 50M', async () => wp('RecordExternalFunds', { bookETag: await ptag(), effectiveDate: D, amount: '50000000.00', cashAccountId: wallet, provenanceKind: 'SUPPORTED_REFERENCE', supportReference: 'SYN-R10', nature: 'RECEIVED_LOAN', principalAccountId: pDebt, liabilityDefinition: { kind: 'BANK_LOAN', label: 'Crédito libre revisión', counterpartyReference: 'SYN-R10-BANK2', principal: '50000000.00', rate, schedule: official('50000000.00', '2026-12-28'), prepaymentPermissions: [], supportReference: 'SYN-R10' } }));
    expect('P40 préstamo recibido es pasivo, no ingreso', sub(await pt(), ['income', 'liabilities']), { income: '2000000.00', liabilities: '170000000.00' });
    await contribute('70000000.00');
    const debt = (await x.rows('s09_liabilities_personal', { principal: '50000000.00' }))[0]!, q = await pdraft('Lote 40 % revisión', '40.00', '300000000.00'), qp = { ...P, assetId: idOf(q) };
    await ok('P40 adquirir 120M = 70M caja + 50M deuda existente', async () => wp('AcquireAsset', { bookETag: await ptag(), effectiveDate: D, ownedConsideration: '120000000.00', capitalizedCosts: [], funding: [{ nature: 'EXISTING_CASH', settlementMode: 'FROM_ACCOUNT', amount: '70000000.00', accountId: wallet, sourceJournalId: null, provenanceKind: 'DECLARED', reference: 'SYN-R10' }, { nature: 'EXISTING_DEBT_LINK', settlementMode: 'FROM_ACCOUNT', amount: '50000000.00', accountId: wallet, liabilityId: debt._id, sourceJournalId: (info(loan)['journalIds'] as string[])[0], provenanceKind: 'SUPPORTED_REFERENCE', reference: 'SYN-R10' }], supportReference: 'SYN-R10-ACQ40' }, qp, (await asset(qp.assetId)).etag));
    await ok('P40 estimar bruto 350M', async () => wp('RecordAssetValuation', { valuationDate: D, grossEstimatedValue: '350000000.00', method: 'OWNER_ESTIMATE', sourceReference: 'SYN-R10', supportReference: 'SYN-R10' }, qp, (await asset(qp.assetId)).etag));
    const qv = info(await asset(qp.assetId)), i40 = indicative('350000000.00', '40.00', '50000000.00');
    expect('P40 costo 120M, estimado propio = oráculo (140M), principal 50M completo, equidad = oráculo (90M)', [qv['recognizedCost'], qv['ownedEstimatedValue'], qv['linkedPrincipal'], qv['indicativeEquity']], ['120000000.00', i40.ownedEstimate, '50000000.00', i40.equity]);
    const final = await pt(); expect('PERSONAL final = comandado', sub(final, ['assets', 'liabilities', 'equity', 'income', 'expense', 'cash']), { assets: '321700000.00', liabilities: '170000000.00', equity: '150000000.00', income: '2000000.00', expense: '300000.00', cash: '1700000.00' });
    expect('PERSONAL cuadra (A = L + E + I − X)', final.assets, money(cents(final.liabilities) + cents(final.equity) + cents(final.income) - cents(final.expense)));
    // ---- private wealth: ledger counted once; indicative view replaces only backed base
    const pw = info(await x.wealthRead('getPrivateWealth', {}, { asOf: D })); o['privateWealth'] = pw;
    expect('privada: activos de ledger contados una vez = oráculo', pw['ledgerGrossAssets'], final.assets);
    expect('privada: indicativo sustituye solo la base respaldada (1,7M + 220M + 140M)', pw['indicativeOwnedAssets'], money(cents(final.cash) + cents(i100.ownedEstimate!) + cents(i40.ownedEstimate!)));
    expect('privada: negocio no sumado sin elegibilidad FULL100', pw['business'] ?? null, null);
    evidence('S10-ECONOMY', { observed: o, failures: fail });
    assert.deepEqual(fail, [], 'economy mismatches');
    console.log('S10_P05_ECONOMY_PASS');
  } catch (e) { evidence('S10-ECONOMY-PARCIAL', { observed: o, failures: fail, error: String(e).slice(0, 500) }); throw e; } finally { await group.dispose(); }
});
