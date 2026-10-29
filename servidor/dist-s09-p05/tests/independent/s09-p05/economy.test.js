/* eslint-disable security/detect-object-injection -- Own fixed labels/account maps of this review, never request input. */
// S09-P05 own economic review (Claude) of S09-P04-v1-INTEGRADO on ONE own group. Each checkpoint compares the product (API envelopes,
// private consolidation) with the own raw-data oracle (oracle.ts) and with the amounts commanded here (REFERENCE_CASES_S09 1.0.0).
// Cases: L01 préstamo≠ingreso; L02A/L02B 240k=200k+30k+10k sin doble devengo; L05 tarjeta; L03 compra financiada BUSINESS; L06 abono;
// FUNDS disponible y por fecha; E01–E04 gastos/recurrencias/versiones; C01/C02/C04/C05 consolidado y participación 40%.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { s09ReviewProfile } from './review-profile.js';
import { world, evidence, info, idOf, rate, schedule } from './review-fixtures.js';
import { totals, consolidation, occurrences, show, money, cents } from './oracle.js';
const D = '2026-10-28';
test('S09-P05 economía propia: deuda/gastos/recurrencias/fondos/consolidado contra oráculo', { timeout: 1200000 }, async () => {
    const group = await s09ReviewProfile(), o = {}, fail = [];
    const expect = (at, got, want) => { const g = JSON.stringify(got), w = JSON.stringify(want); o['check ' + at] = g === w ? 'PASS' : { got, want }; if (g !== w)
        fail.push(`${at}: ${g} ≠ ${w}`); };
    try {
        const x = await world(group), f = x, P = { bookId: x.book.id }, B = { organizationId: x.org }, subject = x.a.issued.context.subjectId;
        const ok = async (label, fn) => { const r = await x.settle(fn); o[label] = x.st(r); if (![200, 201].includes(r.status))
            throw Error(`${label}: ${x.st(r)}`); return r; };
        const pa = async (code, cls, kind = 'GENERAL') => (await x.personal(code, cls, kind)).id, ba = async (code, cls, kind = 'GENERAL') => (await x.account(code, cls, kind)).id;
        const pBank = await pa('R_PBANK', 'ASSET', 'BANK'), pBank2 = await pa('R_PBANK2', 'ASSET', 'BANK'), pDebt = await pa('R_PDEBT', 'LIABILITY'), pPay = await pa('R_PPAY', 'LIABILITY'), pExp = await pa('R_PEXP', 'EXPENSE'), pAsset = await pa('R_PASSET', 'ASSET'), pDue = await pa('R_PDUE', 'ASSET'), pInv = await pa('R_PINV', 'ASSET');
        const bDebt = await ba('R_BDEBT', 'LIABILITY'), bAsset = await ba('R_BASSET', 'ASSET'), bDue = await ba('R_BDUE', 'LIABILITY'), bExp = await ba('R_BEXP', 'EXPENSE'), bPay = await ba('R_BPAY', 'LIABILITY'), bBank0 = await ba('R_BBANK0', 'ASSET', 'BANK');
        /** Oracle totals vs product consolidation personalTotals (and business book totals when visible). */
        const checkpoint = async (label, want) => {
            const d = await x.dump(), mine = show(totals(d, 'PERSONAL', x.book.id, D)), con = info(await x.read('getPrivateConsolidation')), api = con['personalTotals'];
            expect(label + ' PERSONAL producto = oráculo', api, mine);
            if (want)
                expect(label + ' PERSONAL = comandado', Object.fromEntries(Object.keys(want).map(k => [k, mine[k]])), want);
            o['totals ' + label] = { oracle: mine, business: show(totals(d, 'BUSINESS', x.org, D)) };
            return { d, con, mine };
        };
        const liability = async (scope, kind, principal, sched, permissions = []) => await ok(`crear ${kind} ${principal}`, () => x.mutate(scope === 'P' ? 'personalCreateLiability' : 'businessCreateLiability', { kind, label: 'Deuda revisión ' + kind, counterpartyReference: 'SYN-R09-EXT', principal, rate, schedule: sched, prepaymentPermissions: permissions, supportReference: 'SYN-R09-' + kind }, scope === 'P' ? P : B));
        const env = async (scope, id) => await x.read(scope === 'P' ? 'getPersonalLiabilityEnvelope' : 'getBusinessLiabilityEnvelope', { ...(scope === 'P' ? P : B), liabilityId: id });
        const activate = async (scope, created, recognitionKind, principalAccountId, destinationAccountId, amount) => await ok(`activar ${recognitionKind} ${amount}`, () => x.mutate(scope === 'P' ? 'personalActivateLiability' : 'businessActivateLiability', { effectiveDate: D, recognitionKind, principalAccountId, destinationAccountId, legalOwnerReference: 'SYN-R09-OWNER', funding: [{ kind: 'DIRECT_CREDIT', amount }], supportReference: 'SYN-R09-ACT' }, { ...(scope === 'P' ? P : B), liabilityId: idOf(created) }, created.etag));
        const schedId = (e) => String(info(e)['schedule']['id']);
        await checkpoint('S0 vacío', { assets: '0.00', liabilities: '0.00', income: '0.00', expense: '0.00', cashAvailable: '0.00' });
        // ---- L01 préstamo recibido 400k: caja y pasivo, ingreso 0
        const l01 = await liability('P', 'BANK_LOAN', '400000.00', schedule([['2026-11-28', '400000.00']]));
        await activate('P', l01, 'CASH_RECEIPT', pDebt, pBank, '400000.00');
        expect('L01 principalOutstanding', info(await env('P', idOf(l01)))['principalOutstanding'], '400000.00');
        await checkpoint('L01', { assets: '400000.00', liabilities: '400000.00', income: '0.00', expense: '0.00', cashAvailable: '400000.00' });
        // ---- L02A compuesto: reconocer+pagar 240k
        const two = schedule([[D, '200000.00', '30000.00', '10000.00'], ['2026-11-28', '800000.00']]);
        const a2 = await liability('P', 'BANK_LOAN', '1000000.00', two);
        await activate('P', a2, 'CASH_RECEIPT', pDebt, pBank, '1000000.00');
        let e2 = await env('P', idOf(a2));
        const compound = { scheduleVersionId: schedId(e2), effectiveDate: D, amount: '240000.00', cashAccountId: pBank, allocations: [{ installmentNumber: 1, component: 'PRINCIPAL', amount: '200000.00', accountId: pDebt }, { installmentNumber: 1, component: 'INTEREST', amount: '30000.00', accountId: pPay }, { installmentNumber: 1, component: 'INSURANCE', amount: '10000.00', accountId: pPay }], componentRecognitions: [{ installmentNumber: 1, component: 'INTEREST', amount: '30000.00', expenseAccountId: pExp, payableAccountId: pPay }, { installmentNumber: 1, component: 'INSURANCE', amount: '10000.00', expenseAccountId: pExp, payableAccountId: pPay }], supportReference: 'SYN-R09-240K' };
        const k2 = randomUUID();
        await ok('L02A reconocer+pagar 240k', () => x.mutate('personalRecognizeAndPayLiability', compound, { ...P, liabilityId: idOf(a2) }, e2.etag, k2));
        const c2 = await x.counts(), replay = await x.settle(() => x.mutate('personalRecognizeAndPayLiability', compound, { ...P, liabilityId: idOf(a2) }, e2.etag, k2));
        expect('L02A replay misma clave', [replay.status, await x.counts()], [200, c2]);
        e2 = await env('P', idOf(a2));
        expect('L02A principal/componentes', [info(e2)['principalOutstanding'], info(e2)['componentOutstanding']], ['800000.00', '0.00']);
        await checkpoint('L02A', { assets: '1160000.00', liabilities: '1200000.00', income: '0.00', expense: '40000.00', cashAvailable: '1160000.00' });
        // ---- L02B devengo previo y pago: gasto 40k una sola vez
        const b2 = await liability('P', 'BANK_LOAN', '1000000.00', two);
        await activate('P', b2, 'CASH_RECEIPT', pDebt, pBank, '1000000.00');
        let eb = await env('P', idOf(b2));
        const recog = { scheduleVersionId: schedId(eb), effectiveDate: D, components: [{ installmentNumber: 1, component: 'INTEREST', amount: '30000.00', expenseAccountId: pExp, payableAccountId: pPay }, { installmentNumber: 1, component: 'INSURANCE', amount: '10000.00', expenseAccountId: pExp, payableAccountId: pPay }], supportReference: 'SYN-R09-ACCRUE' };
        await ok('L02B devengar 30k+10k', () => x.mutate('personalRecognizeLiabilityComponent', recog, { ...P, liabilityId: idOf(b2) }, eb.etag));
        eb = await env('P', idOf(b2));
        await checkpoint('L02B devengado', { expense: '80000.00', liabilities: '2240000.00' });
        await ok('L02B pagar 240k ya devengado', () => x.mutate('personalPayLiability', { scheduleVersionId: schedId(eb), effectiveDate: D, amount: '240000.00', cashAccountId: pBank, allocations: compound.allocations, supportReference: 'SYN-R09-PAY' }, { ...P, liabilityId: idOf(b2) }, eb.etag));
        eb = await env('P', idOf(b2));
        const c2b = await x.counts(), again = await x.settle(() => x.mutate('personalRecognizeLiabilityComponent', recog, { ...P, liabilityId: idOf(b2) }, eb.etag));
        o['L02B segundo devengo'] = x.st(again);
        expect('L02B segundo devengo rechazado sin efectos', [again.status >= 400, await x.counts()], [true, c2b]);
        expect('L02B principal/componentes', [info(eb)['principalOutstanding'], info(eb)['componentOutstanding']], ['800000.00', '0.00']);
        await checkpoint('L02B', { assets: '1920000.00', liabilities: '2000000.00', income: '0.00', expense: '80000.00', cashAvailable: '1920000.00' });
        // ---- L05 tarjeta: compra gasto 120k + compra activo 50k; pago del extracto sin gasto adicional
        const card = await liability('P', 'CARD', '120000.00', schedule([[D, '120000.00']]));
        await activate('P', card, 'EXPENSE_PURCHASE', pDebt, pExp, '120000.00');
        let ec = await env('P', idOf(card));
        await ok('L05 compra tarjeta ASSET 50k', () => x.mutate('personalPostCardPurchase', { effectiveDate: D, amount: '50000.00', classification: 'ASSET', destinationAccountId: pAsset, cardLiabilityAccountId: pDebt, legalOwnerReference: 'SYN-R09-OWNER', cycleStart: '2026-10-01', cycleEnd: '2026-10-31', paymentDue: '2026-11-15', supportReference: 'SYN-R09-CARD' }, { ...P, liabilityId: idOf(card) }, ec.etag));
        ec = await env('P', idOf(card));
        await checkpoint('L05 compras', { expense: '200000.00', liabilities: '2170000.00', assets: '1970000.00' });
        await ok('L05 pagar extracto 120k', () => x.mutate('personalPayLiability', { scheduleVersionId: schedId(ec), effectiveDate: D, amount: '120000.00', cashAccountId: pBank, allocations: [{ installmentNumber: 1, component: 'PRINCIPAL', amount: '120000.00', accountId: pDebt }], supportReference: 'SYN-R09-STATEMENT' }, { ...P, liabilityId: idOf(card) }, ec.etag));
        expect('L05 saldo tarjeta tras pago', info(await env('P', idOf(card)))['principalOutstanding'], '50000.00');
        await checkpoint('L05', { assets: '1850000.00', liabilities: '2050000.00', expense: '200000.00', cashAvailable: '1800000.00' });
        // ---- L06 abono REDUCE_TERM 200k sobre 600k; negativos sin permiso y calendario no conciliado
        const six = schedule(['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03'].map(dd => [dd, '100000.00']));
        const l06 = await liability('P', 'BANK_LOAN', '600000.00', six, ['REDUCE_TERM']);
        await activate('P', l06, 'CASH_RECEIPT', pDebt, pBank, '600000.00');
        let e6 = await env('P', idOf(l06));
        const c6 = await x.counts(), badSched = await x.settle(() => x.mutate('personalPrepayLiability', { effectiveDate: D, amount: '200000.00', cashAccountId: pBank, mode: 'REDUCE_TERM', previousScheduleVersionId: schedId(e6), resultSchedule: { ...six, principalOpening: '399000.00', installments: [...six.installments.slice(0, 3), { ...six.installments[3], principal: '99000.00', total: '99000.00' }] }, supportReference: 'SYN-R09-BAD' }, { ...P, liabilityId: idOf(l06) }, e6.etag));
        o['L06 calendario no conciliado'] = x.st(badSched);
        expect('L06 calendario no conciliado rechazado sin efectos', [badSched.status >= 400, await x.counts()], [true, c6]);
        await ok('L06 abono 200k REDUCE_TERM', () => x.mutate('personalPrepayLiability', { effectiveDate: D, amount: '200000.00', cashAccountId: pBank, mode: 'REDUCE_TERM', previousScheduleVersionId: schedId(e6), resultSchedule: { ...six, principalOpening: '400000.00', installments: six.installments.slice(0, 4) }, supportReference: 'SYN-R09-PREPAY' }, { ...P, liabilityId: idOf(l06) }, e6.etag));
        e6 = await env('P', idOf(l06));
        expect('L06 principal 400k / 4 cuotas', [info(e6)['principalOutstanding'], info(e6)['schedule']['installments'].length], ['400000.00', 4]);
        const e1v = await env('P', idOf(l01)), c6b = await x.counts(), noPerm = await x.settle(() => x.mutate('personalPrepayLiability', { effectiveDate: D, amount: '1.00', cashAccountId: pBank, mode: 'REDUCE_TERM', previousScheduleVersionId: schedId(e1v), resultSchedule: schedule([['2026-11-28', '399999.00']]), supportReference: 'SYN-R09-NOPERM' }, { ...P, liabilityId: idOf(l01) }, e1v.etag));
        expect('L06 abono sin permiso 409 ABON_NOT_ALLOWED sin efectos', [x.st(noPerm), await x.counts()], ['409 ABON_NOT_ALLOWED', c6b]);
        await checkpoint('L06', { cashAvailable: '2200000.00', liabilities: '2450000.00', expense: '200000.00' });
        // ---- E01 gasto reconocido 100k, pago parcial 40k
        const ex1 = await ok('E01 crear gasto 100k', () => x.mutate('personalCreateExpense', { nominalDate: D, dueDate: D, description: 'Servicio revisión', category: 'SERVICES', amountMode: 'FIXED', amount: '100000.00', supportReference: 'SYN-R09-E01' }, P)), ep = { ...P, expenseId: idOf(ex1) };
        const j0 = (await x.counts()).personalJournals;
        let ee = await x.read('getPersonalExpenseEnvelope', ep);
        expect('E01 crear no postea', (await x.counts()).personalJournals, j0);
        await ok('E01 reconocer 100k', () => x.mutate('personalRecognizeExpense', { amount: '100000.00', effectiveDate: D, expenseAccountId: pExp, payableAccountId: pPay, supportReference: 'SYN-R09-REC' }, ep, ee.etag));
        ee = await x.read('getPersonalExpenseEnvelope', ep);
        await ok('E01 pagar 40k', () => x.mutate('personalPayExpense', { amount: '40000.00', effectiveDate: D, cashAccountId: pBank, supportReference: 'SYN-R09-PART' }, ep, ee.etag));
        ee = await x.read('getPersonalExpenseEnvelope', ep);
        expect('E01 pendiente 60k PARTIAL', [info(ee)['outstanding'], info(ee)['settlementStatus']], ['60000.00', 'PARTIAL']);
        expect('E01 dos asientos', (await x.counts()).personalJournals - j0, 2);
        await checkpoint('E01', { expense: '300000.00', cashAvailable: '2160000.00', liabilities: '2510000.00' });
        // ---- E02 variable sin precio
        const ex2 = await ok('E02 crear VARIABLE', () => x.mutate('personalCreateExpense', { nominalDate: D, dueDate: '2026-10-30', description: 'Variable revisión', category: 'OTHER', amountMode: 'VARIABLE', supportReference: 'SYN-R09-E02' }, P)), ep2 = { ...P, expenseId: idOf(ex2) };
        let ev2 = await x.read('getPersonalExpenseEnvelope', ep2);
        const c7 = await x.counts();
        const pay2 = await x.settle(() => x.mutate('personalPayExpense', { amount: '1.00', effectiveDate: D, cashAccountId: pBank, supportReference: 'SYN-R09-E02P' }, ep2, ev2.etag));
        ev2 = await x.read('getPersonalExpenseEnvelope', ep2);
        expect('E02 UNPRICED sin importe; pago 409 INVALID_STATE; 0 efectos', [info(ev2)['planningStatus'], info(ev2)['amount'] ?? null, x.st(pay2), await x.counts()], ['UNPRICED', null, '409 INVALID_STATE', c7]);
        // ---- FUNDS: disponible insuficiente (BUSINESS) y fondos por fecha (PERSONAL)
        const bx = await ok('FUNDS gasto BUSINESS 1000', () => x.mutate('businessCreateExpense', { nominalDate: D, dueDate: D, description: 'Negocio revisión', category: 'SERVICES', amountMode: 'FIXED', amount: '1000.00', supportReference: 'SYN-R09-BX' }, B)), bp = { ...B, expenseId: idOf(bx) };
        let bxe = await x.read('getBusinessExpenseEnvelope', bp);
        await ok('FUNDS reconocer BUSINESS', () => x.mutate('businessRecognizeExpense', { amount: '1000.00', effectiveDate: D, expenseAccountId: bExp, payableAccountId: bPay, supportReference: 'SYN-R09-BXR' }, bp, bxe.etag));
        bxe = await x.read('getBusinessExpenseEnvelope', bp);
        const c8 = await x.counts(), nofunds = await x.settle(() => x.mutate('businessPayExpense', { amount: '1.00', effectiveDate: D, cashAccountId: bBank0, supportReference: 'SYN-R09-NOFUNDS' }, bp, bxe.etag));
        o['FUNDS código caja 0'] = x.st(nofunds);
        expect('FUNDS caja 0 BUSINESS → 409 sin efectos', [nofunds.status, await x.counts()], [409, c8]);
        const l2 = await liability('P', 'PRIVATE_DEBT', '100000.00', schedule([['2026-11-28', '100000.00']]));
        await activate('P', l2, 'CASH_RECEIPT', pDebt, pBank2, '100000.00');
        const ex3 = await ok('FUNDS gasto con fecha anterior', () => x.mutate('personalCreateExpense', { nominalDate: '2026-10-27', dueDate: '2026-10-27', description: 'Anterior revisión', category: 'SERVICES', amountMode: 'FIXED', amount: '50000.00', supportReference: 'SYN-R09-E3' }, P)), ep3 = { ...P, expenseId: idOf(ex3) };
        let ev3 = await x.read('getPersonalExpenseEnvelope', ep3);
        await ok('FUNDS reconocer 27-oct', () => x.mutate('personalRecognizeExpense', { amount: '50000.00', effectiveDate: '2026-10-27', expenseAccountId: pExp, payableAccountId: pPay, supportReference: 'SYN-R09-E3R' }, ep3, ev3.etag));
        ev3 = await x.read('getPersonalExpenseEnvelope', ep3);
        const c9 = await x.counts(), early = await x.settle(() => x.mutate('personalPayExpense', { amount: '50000.00', effectiveDate: '2026-10-27', cashAccountId: pBank2, supportReference: 'SYN-R09-EARLY' }, ep3, ev3.etag));
        expect('FUNDS fondos del 28 no financian pago del 27 (409 sin efectos)', [x.st(early), await x.counts()], ['409 INSUFFICIENT_AVAILABLE_FUNDS', c9]);
        await ok('FUNDS pago el 28 con fondos ya recibidos', () => x.mutate('personalPayExpense', { amount: '50000.00', effectiveDate: D, cashAccountId: pBank2, supportReference: 'SYN-R09-ONTIME' }, ep3, ev3.etag));
        await checkpoint('FUNDS', { expense: '350000.00', cashAvailable: '2210000.00' });
        // ---- E03/E04 recurrencias: fechas del oráculo propio, regeneración idempotente, 0 asientos
        const jr = (await x.counts()).personalJournals, rules = [
            ['E03 MONTHLY clamp', { frequency: 'MONTHLY', startDate: '2027-01-31', monthDay: 31 }, '2027-01-31', '2027-04-30'],
            ['E04 ANNUAL 29-feb', { frequency: 'ANNUAL', startDate: '2024-02-29', monthDay: 29 }, '2024-02-29', '2028-02-29'],
            ['E04 FORTNIGHTLY', { frequency: 'FORTNIGHTLY', startDate: '2026-10-01' }, '2026-10-01', '2026-10-31'],
            ['E04 TWICE_MONTHLY 1/15', { frequency: 'TWICE_MONTHLY', startDate: '2026-10-01', twiceMonthlyDays: [1, 15] }, '2026-10-01', '2026-10-31'],
            ['E04 CUSTOM', { frequency: 'CUSTOM', startDate: '2026-10-03', customDates: ['2026-10-03', '2026-10-19'] }, '2026-10-01', '2026-10-31']
        ];
        for (const [label, spec, from, through] of rules) {
            const rr = await ok(label + ' crear', () => x.mutate('personalCreateExpenseRule', { ...spec, monthEndPolicy: 'CLAMP_TO_LAST_DAY', description: 'Regla revisión', category: 'SERVICES', amountMode: 'FIXED', amount: '10000.00', supportReference: 'SYN-R09-RULE' }, P)), rp = { ...P, ruleId: idOf(rr) };
            await ok(label + ' generar', () => x.mutate('personalGenerateOccurrences', { from, through }, rp, rr.etag));
            const re = await x.read('getPersonalRuleEnvelope', rp);
            const dates = async () => (await x.rows('s09_expenses_personal', { seriesId: idOf(rr) })).map((e) => String(e['nominalDate'])).sort();
            const first = await dates();
            expect(label + ' fechas = oráculo', first, occurrences(spec, from, through));
            await ok(label + ' regenerar', () => x.mutate('personalGenerateOccurrences', { from, through }, rp, re.etag));
            expect(label + ' regenerar no duplica', await dates(), first);
        }
        const dup = await x.settle(() => x.mutate('personalCreateExpenseRule', { frequency: 'CUSTOM', startDate: '2026-10-03', customDates: ['2026-10-03', '2026-10-03'], monthEndPolicy: 'CLAMP_TO_LAST_DAY', description: 'Duplicada', category: 'SERVICES', amountMode: 'FIXED', amount: '1.00', supportReference: 'SYN-R09-DUP' }, P));
        expect('E04 CUSTOM duplicada 422', dup.status, 422);
        expect('E03/E04 agenda no postea', (await x.counts()).personalJournals, jr);
        // ---- versión de regla: no reescribe ocurrencia pagada
        const base = { frequency: 'MONTHLY', startDate: D, monthDay: 28, monthEndPolicy: 'CLAMP_TO_LAST_DAY', description: 'Regla versión revisión', category: 'SERVICES', amountMode: 'FIXED', amount: '50000.00', supportReference: 'SYN-R09-VER' };
        const vr = await ok('VER crear regla', () => x.mutate('personalCreateExpenseRule', base, P)), vp = { ...P, ruleId: idOf(vr) };
        await ok('VER generar 3', () => x.mutate('personalGenerateOccurrences', { from: D, through: '2026-12-28' }, vp, vr.etag));
        const occ = async () => Object.fromEntries((await x.rows('s09_expenses_personal', { seriesId: idOf(vr) })).map((e) => [String(e['nominalDate']), String(e['amount'])]).sort((p, q) => String(p[0]).localeCompare(String(q[0]))));
        const first = (await x.rows('s09_expenses_personal', { seriesId: idOf(vr), nominalDate: D }))[0], fp = { ...P, expenseId: String(first['_id']) }, fe = await x.read('getPersonalExpenseEnvelope', fp);
        await ok('VER reconocer+pagar ocurrencia 28-oct', () => x.mutate('personalRecognizeAndPayExpense', { amount: '50000.00', effectiveDate: D, expenseAccountId: pExp, payableAccountId: pPay, cashAccountId: pBank, supportReference: 'SYN-R09-VERPAY' }, fp, fe.etag));
        const jv = await x.counts(), occBefore = await occ();
        let ve = await x.read('getPersonalRuleEnvelope', vp);
        const conflict = await x.settle(() => x.mutate('personalVersionExpenseRule', { ...base, amount: '60000.00', effectiveFrom: D }, vp, ve.etag));
        o['VER versión desde ocurrencia pagada'] = x.st(conflict);
        expect('VER versión que toca la pagada rechazada sin efectos', [conflict.status >= 400, await occ(), await x.counts()], [true, occBefore, jv]);
        ve = await x.read('getPersonalRuleEnvelope', vp);
        await ok('VER versión desde 2026-11-01', () => x.mutate('personalVersionExpenseRule', { ...base, amount: '60000.00', effectiveFrom: '2026-11-01' }, vp, ve.etag));
        expect('VER ocurrencias tras versión', await occ(), { [D]: '50000.00', '2026-11-28': '60000.00', '2026-12-28': '60000.00' });
        expect('VER versión no postea', (await x.counts()).personalJournals, jv.personalJournals);
        await checkpoint('VER', { expense: '400000.00', cashAvailable: '2160000.00' });
        // ---- L03 BUSINESS compra financiada activo 1.2M, cuota 100k; deuda externa (C02)
        const twelve = schedule(Array.from({ length: 12 }, (_, i) => [i === 0 ? D : `2027-${String(i).padStart(2, '0')}-28`, '100000.00']));
        const l03 = await liability('B', 'FINANCED_PURCHASE', '1200000.00', twelve);
        const bBefore = totals(await x.dump(), 'BUSINESS', x.org, D);
        await activate('B', l03, 'ASSET_PURCHASE', bDebt, bAsset, '1200000.00');
        let e3 = await env('B', idOf(l03));
        await ok('L03 cuota 100k principal', () => x.mutate('businessPayLiability', { scheduleVersionId: schedId(e3), effectiveDate: D, amount: '100000.00', cashAccountId: x.bank.id, allocations: [{ installmentNumber: 1, component: 'PRINCIPAL', amount: '100000.00', accountId: bDebt }], supportReference: 'SYN-R09-L03' }, { ...B, liabilityId: idOf(l03) }, e3.etag));
        e3 = await env('B', idOf(l03));
        const bAfter = totals(await x.dump(), 'BUSINESS', x.org, D);
        expect('L03 principal 1.1M; BUSINESS activo +1.1M neto, pasivo +1.1M, gasto 0', [info(e3)['principalOutstanding'], money(bAfter.assets - bBefore.assets), money(bAfter.liabilities - bBefore.liabilities), money(bAfter.expense - bBefore.expense)], ['1100000.00', '1100000.00', '1100000.00', '0.00']);
        // ---- C01/C04/C05 consolidado FULL100
        const elig = await ok('C declarar FULL100', () => x.mutate('declareOwnEligibility', { right: 'FULL_OWNERSHIP', percentage: '100.00', validFrom: D, supportReference: 'SYN-R09-100' }, B));
        const rel = async (label, kind, amount, pc, bc, extra = {}) => {
            const pb = await x.read('getOwnPersonalBook'), bb = await x.read('getBusinessBook', B);
            return await ok(label, () => x.mutate('postInterbookRelationship', { kind, businessOrganizationId: x.org, businessBookETag: bb.etag, personalBookETag: pb.etag, eligibilityVersionId: idOf(elig), effectiveDate: D, amount, fromScope: 'PERSONAL', personalCashAccountId: pBank, businessCashAccountId: x.bank.id, personalContraAccountId: pc, businessContraAccountId: bc, supportReference: 'SYN-R09-REL', ...extra }));
        };
        await rel('C01 préstamo entre libros 100k', 'INTERBOOK_LOAN', '100000.00', pDue, bDue);
        const contrib = await rel('C04 aporte 100k', 'CONTRIBUTION', '100000.00', pInv, x.equity.id), croot = (await x.rows('s09_relationships', { _id: idOf(contrib) }))[0];
        await rel('C04 retiro 40k', 'WITHDRAWAL', '40000.00', pInv, x.equity.id, { fromScope: 'BUSINESS', originalEventIds: croot['sourceEventIds'] });
        const rx = await ok('C05 gasto negocio 70k', () => x.mutate('businessCreateExpense', { nominalDate: D, dueDate: D, description: 'Pagado por titular', category: 'SERVICES', amountMode: 'FIXED', amount: '70000.00', supportReference: 'SYN-R09-C05' }, B)), rxp = { ...B, expenseId: idOf(rx) };
        const rxe = await x.read('getBusinessExpenseEnvelope', rxp);
        await ok('C05 reconocer', () => x.mutate('businessRecognizeExpense', { amount: '70000.00', effectiveDate: D, expenseAccountId: bExp, payableAccountId: bPay, supportReference: 'SYN-R09-C05R' }, rxp, rxe.etag));
        await rel('C05 reembolso 70k', 'REIMBURSEMENT', '70000.00', pDue, bDue, { originalExpenseId: idOf(rx) });
        expect('C05 gasto negocio pagado una vez', [info(await x.read('getBusinessExpenseEnvelope', rxp))['paid'], info(await x.read('getBusinessExpenseEnvelope', rxp))['outstanding']], ['70000.00', '0.00']);
        const { d: dc, con } = await checkpoint('C consolidado', { cashAvailable: '1930000.00' }), oc = consolidation(dc, x.book.id, x.org, subject, D);
        const elimApi = (con['eliminations'] ?? []).map(e => ({ relationshipId: String(e['relationshipId']), kind: String(e['kind']), amount: String(e['amount']) })).sort((p, q) => p.relationshipId.localeCompare(q.relationshipId));
        expect('C eliminaciones producto = oráculo', elimApi, [...oc.eliminations].sort((p, q) => p.relationshipId.localeCompare(q.relationshipId)));
        expect('C eliminaciones = comandado (100k préstamo, 60k aporte neto, 70k reembolso)', oc.eliminations.map(e => e.kind + ' ' + e.amount).sort(), ['CONTRIBUTION 60000.00', 'INTERBOOK_LOAN 100000.00', 'REIMBURSEMENT 70000.00']);
        expect('C bruto/neto producto = oráculo', [con['gross'], con['net']], [oc.gross, oc.net]);
        expect('C un negocio elegible', (con['businesses'] ?? []).length, 1);
        expect('C02 deuda externa 1.1M sigue en neto (no eliminada)', cents(oc.net.liabilities) >= 110000000n && !oc.eliminations.some(e => e.amount === '1100000.00'), true);
        // ---- participación 40 %: separada, sin sumar el negocio ni eliminar; cruce con elegibilidad 100 previa ya no autorizado
        await ok('P40 declarar participación 40', () => x.mutate('declareOwnEligibility', { right: 'PARTICIPATION', percentage: '40.00', validFrom: D, supportReference: 'SYN-R09-40' }, B));
        const con40 = info(await x.read('getPrivateConsolidation')), o40 = consolidation(await x.dump(), x.book.id, x.org, subject, D);
        expect('P40 participación separada, negocio no sumado, sin eliminaciones', [(con40['businesses'] ?? []).length, (con40['participations'] ?? []).map(p => p['percentage']), (con40['eliminations'] ?? []).length, con40['gross'], o40.eligible], [0, ['40.00'], 0, o40.gross, false]);
        const c10 = await x.counts(), stale = await x.settle(async () => { const pb = await x.read('getOwnPersonalBook'), bb = await x.read('getBusinessBook', B); return await x.mutate('postInterbookRelationship', { kind: 'INTERBOOK_LOAN', businessOrganizationId: x.org, businessBookETag: bb.etag, personalBookETag: pb.etag, eligibilityVersionId: idOf(elig), effectiveDate: D, amount: '1.00', fromScope: 'PERSONAL', personalCashAccountId: pBank, businessCashAccountId: x.bank.id, personalContraAccountId: pDue, businessContraAccountId: bDue, supportReference: 'SYN-R09-STALE' }); });
        expect('P40 cruce con elegibilidad 100 superada rechazado sin efectos', [stale.status >= 400, await x.counts()], [true, c10]);
        o['P40 cruce'] = x.st(stale);
        void f;
        evidence('S09-ECONOMY', { observed: o, failures: fail });
        assert.deepEqual(fail, [], 'economy mismatches');
        console.log('S09_P05_ECONOMY_PASS');
    }
    catch (e) {
        evidence('S09-ECONOMY-PARCIAL', { observed: o, failures: fail, error: String(e).slice(0, 400) });
        throw e;
    }
    finally {
        await group.dispose();
    }
});
//# sourceMappingURL=economy.test.js.map