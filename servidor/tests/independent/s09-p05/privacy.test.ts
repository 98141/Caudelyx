/* eslint-disable security/detect-object-injection -- Own fixed labels/actor maps of this review, never request input. */
// S09-P05 own privacy review (Claude): PERSONAL of T must not reach collaborator C/O of the same org, T of another org, SA/T+SA,
// BUSINESS routes, S8 reporting, foreign tokens or HTTPS caches; authority is evaluated currently (role/org change, suspension, leaving
// the org). Unique synthetic markers are seeded in PERSONAL and searched in every foreign response; 404 must be uniform.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { s09ReviewProfile } from './review-profile.js';
import { world, evidence, info, idOf, rate, schedule, type World, type Reply } from './review-fixtures.js';

const D = '2026-10-28';
test('S09-P05 privacidad propia: aislamiento PERSONAL, autoridad actual, BUSINESS/S8 sin datos personales', { timeout: 900000 }, async () => {
  const group = await s09ReviewProfile(), o: Record<string, unknown> = {}, fail: string[] = [];
  const expect = (at: string, got: unknown, want: unknown) => { const g = JSON.stringify(got), w = JSON.stringify(want); o['check ' + at] = g === w ? 'PASS' : { got, want }; if (g !== w) fail.push(`${at}: ${g} ≠ ${w}`); };
  try {
    const x: World = await world(group), P = { bookId: x.book.id }, B = { organizationId: x.org };
    const ok = async (label: string, fn: () => Promise<{ status: number; data?: unknown; etag?: string }>) => { const r = await x.settle(fn); if (![200, 201].includes(r.status)) throw Error(`${label}: ${x.st(r)}`); return r; };
    const bank = (await x.personal('V_BANK', 'ASSET', 'BANK')).id, debt = (await x.personal('V_DEBT', 'LIABILITY')).id, exp = (await x.personal('V_EXP', 'EXPENSE')).id, pay = (await x.personal('V_PAY', 'LIABILITY')).id;
    const loan = await ok('loan', () => x.mutate('personalCreateLiability', { kind: 'PRIVATE_DEBT', label: 'PRIVADO-R09-DEUDA', counterpartyReference: 'SYN-R09-PRIV', principal: '654321.09', rate, schedule: schedule([['2026-11-28', '654321.09']]), prepaymentPermissions: [], supportReference: 'SYN-R09-PRIV' }, P));
    await ok('activate', () => x.mutate('personalActivateLiability', { effectiveDate: D, recognitionKind: 'CASH_RECEIPT', principalAccountId: debt, destinationAccountId: bank, legalOwnerReference: 'SYN-R09-OWNER', funding: [{ kind: 'DIRECT_CREDIT', amount: '654321.09' }], supportReference: 'SYN-R09-PRIV-ACT' }, { ...P, liabilityId: idOf(loan) }, loan.etag));
    const ex = await ok('expense', () => x.mutate('personalCreateExpense', { nominalDate: D, dueDate: D, description: 'PRIVADO-R09-MARCA', category: 'SERVICES', amountMode: 'FIXED', amount: '12345.67', supportReference: 'SYN-R09-PRIV-E' }, P)), ep = { ...P, expenseId: idOf(ex) };
    await ok('recognize+pay', async () => x.mutate('personalRecognizeAndPayExpense', { amount: '12345.67', effectiveDate: D, expenseAccountId: exp, payableAccountId: pay, cashAccountId: bank, supportReference: 'SYN-R09-PRIV-P' }, ep, (await x.read('getPersonalExpenseEnvelope', ep)).etag));
    const markers = ['PRIVADO-R09', '12345.67', '654321.09', '641975.42', x.book.id, idOf(ex), idOf(loan)];
    const leaks = (r: unknown) => markers.filter(m => JSON.stringify(r ?? null).includes(m));
    const C = await x.member(['C']), O = await x.member(['O']), T2 = await x.actor();
    await x.runtime.organizations.create(T2.issued.context, { name: 'Otra organización sintética', currency: 'COP', timezone: 'America/Bogota' }, randomUUID());
    const r = async (label: string, fn: () => Promise<unknown>) => { const res: Reply = await x.settle(fn as never); o[label] = { status: x.st(res), leaks: leaks(res) }; return res; };
    // ---- same-org collaborators, other T, all reads under one purity line
    const g0 = await x.digestAll(), reads: Reply[] = [];
    for (const [who, actor] of [['C', C], ['O', O], ['T otra org', T2]] as const) {
      reads.push(await r(`${who} getOwnPersonalBook`, () => x.read('getOwnPersonalBook', {}, { asOf: D }, actor)));
      reads.push(await r(`${who} gasto PERSONAL de T`, () => x.read('getPersonalExpenseEnvelope', ep, { asOf: D }, actor)));
      reads.push(await r(`${who} lista gastos PERSONAL de T`, () => x.read('listPersonalExpenses', P, { asOf: D }, actor)));
      reads.push(await r(`${who} deuda PERSONAL de T`, () => x.read('getPersonalLiabilityEnvelope', { ...P, liabilityId: idOf(loan) }, { asOf: D }, actor)));
      reads.push(await r(`${who} agenda PERSONAL de T`, () => x.read('listPersonalAgenda', P, { asOf: D }, actor)));
      reads.push(await r(`${who} consolidado`, () => x.read('getPrivateConsolidation', {}, { asOf: D }, actor)));
      reads.push(await r(`${who} libro BUSINESS`, () => x.read('getBusinessBook', B, { asOf: D }, actor)));
      reads.push(await r(`${who} gastos BUSINESS`, () => x.read('listBusinessExpenses', B, { asOf: D }, actor)));
    }
    const nonexistent = await r('C gasto inexistente', () => x.read('getPersonalExpenseEnvelope', { ...P, expenseId: randomUUID() }, { asOf: D }, C));
    const s8 = await r('T dashboard S8 BUSINESS', () => x.runtime.reporting!.read(x.a.issued.context, 'getReportingDashboard', x.org, undefined, { asOf: D, from: '2026-10-01', to: D }));
    const tok = String(((s8.data as Record<string, unknown>)['meta'] as Record<string, unknown>)['snapshotToken']);
    for (const kind of ['MOVEMENTS', 'CASH']) await r(`T S8 ${kind}`, () => x.runtime.reporting!.read(x.a.issued.context, 'listReportingRows', x.org, kind, { snapshotToken: tok, limit: 100 }));
    await r('C dashboard S8', () => x.runtime.reporting!.read(C.issued.context, 'getReportingDashboard', x.org, undefined, { asOf: D, from: '2026-10-01', to: D }));
    await r('T gastos BUSINESS propios', () => x.read('listBusinessExpenses', B));
    const g1 = await x.digestAll(), changed = x.diff(g0, g1); o['lecturas: colecciones cambiadas'] = changed;
    expect('lecturas ajenas/negativas puras: solo barreras técnicas de observador cambian', changed.filter(c => !['reporting_projection_barriers', 's09_projection_barriers'].includes(c)), []);
    for (const who of ['C', 'O', 'T otra org']) {
      for (const k of ['gasto PERSONAL de T', 'lista gastos PERSONAL de T', 'deuda PERSONAL de T', 'agenda PERSONAL de T']) expect(`${who} ${k} → 404 sin datos`, o[`${who} ${k}`], { status: '404 RESOURCE_NOT_FOUND', leaks: [] });
      expect(`${who} getOwnPersonalBook sin libro → 404`, (o[`${who} getOwnPersonalBook`] as { status: string }).status, '404 RESOURCE_NOT_FOUND');
      expect(`${who} consolidado sin datos de T`, (o[`${who} consolidado`] as { leaks: string[] }).leaks, []);
    }
    for (const who of ['C', 'O']) for (const k of ['libro BUSINESS', 'gastos BUSINESS']) expect(`${who} ${k} → 403/404 sin datos`, [/^40[34] /.test((o[`${who} ${k}`] as { status: string }).status), (o[`${who} ${k}`] as { leaks: string[] }).leaks], [true, []]);
    for (const k of ['libro BUSINESS', 'gastos BUSINESS']) expect(`T otra org ${k} → 404`, (o[`T otra org ${k}`] as { status: string }).status, '404 RESOURCE_NOT_FOUND');
    expect('404 uniforme: ajeno = inexistente', (o['C gasto PERSONAL de T'] as { status: string }).status, x.st(nonexistent));
    for (const k of ['T dashboard S8 BUSINESS', 'T S8 MOVEMENTS', 'T S8 CASH', 'C dashboard S8', 'T gastos BUSINESS propios']) expect(`${k} sin marcadores PERSONAL`, (o[k] as { leaks: string[] }).leaks, []);
    // ---- alta personal solo T; libro ajeno en comandos
    expect('C no puede crear libro PERSONAL (alta requiere T)', (await x.settle(() => x.mutate('createPersonalBook', { currency: 'COP' }, {}, undefined, randomUUID(), C))).status, 403);
    await ok('T2 crea su libro', () => x.mutate('createPersonalBook', { currency: 'COP' }, {}, undefined, randomUUID(), T2));
    const intrude = await x.settle(() => x.mutate('createPersonalAccount', { code: 'INTRUSO', name: 'Intrusa', currency: 'COP', accountClass: 'ASSET', kind: 'GENERAL' }, P, undefined, randomUUID(), T2));
    expect('T2 escribe en libro de T → 404', x.st(intrude), '404 RESOURCE_NOT_FOUND');
    const t2book = info(await x.read('getOwnPersonalBook', {}, { asOf: D }, T2)); expect('T2 su libro no es el de T', t2book['id'] !== x.book.id && leaks(t2book).length === 0, true);
    // ---- tokens/cursores de otro ámbito o actor
    const list = await x.read('listPersonalExpenses', P), ptok = String((list.meta as Record<string, unknown>)['snapshotToken']);
    const cross = await r('token PERSONAL en ruta BUSINESS', () => x.read('listBusinessExpenses', B, { asOf: D, snapshotToken: ptok }));
    const foreign = await r('token de T usado por T2 en su libro', () => x.read('listPersonalExpenses', { bookId: String(t2book['id']) }, { asOf: D, snapshotToken: ptok }, T2));
    expect('token PERSONAL en BUSINESS rechazado', cross.status >= 400 && leaks(cross).length === 0, true); expect('token de otro actor rechazado', foreign.status >= 400 && leaks(foreign).length === 0, true);
    // ---- autoridad actual: SA / T+SA, org suspendida, salida de la org (actualización sintética directa de la identidad)
    const subject = x.a.issued.context.subjectId!, ids = x.identity.identities, original = (await ids.findOne({ _id: subject }))!;
    for (const roles of [['SA'], ['T', 'SA']]) { await ids.updateOne({ _id: subject }, { $set: { roles: roles as never } }); expect(`roles ${roles.join('+')} → PERSONAL 403`, x.st(await x.settle(() => x.read('getOwnPersonalBook'))), '403 ACCESS_DENIED'); }
    await ids.updateOne({ _id: subject }, { $set: { roles: original.roles } });
    const orgs = x.database.db.collection<{ _id: string; status: string }>('organizations'), orgRow = (await orgs.findOne({ _id: x.org }))!;
    await orgs.updateOne({ _id: x.org }, { $set: { status: 'SUSPENDED' } });
    expect('org suspendida: PERSONAL sigue / BUSINESS denegado', [x.st(await x.settle(() => x.read('getOwnPersonalBook'))), /^40[34] /.test(x.st(await x.settle(() => x.read('getBusinessBook', B))))], ['200', true]);
    const susp = info(await x.read('getPrivateConsolidation')); expect('org suspendida: consolidado sin negocio', ((susp['businesses'] as unknown[]) ?? []).length, 0);
    await orgs.updateOne({ _id: x.org }, { $set: { status: orgRow.status } });
    await ids.updateOne({ _id: subject }, { $set: { organizationId: null as never, roles: [] as never } });
    const after = { book: x.st(await x.settle(() => x.read('getOwnPersonalBook'))), expense: x.st(await x.settle(() => x.read('getPersonalExpenseEnvelope', ep))), business: x.st(await x.settle(() => x.read('getBusinessBook', B))), consolidation: await x.settle(() => x.read('getPrivateConsolidation')) };
    o['tras salir de la org'] = { ...after, consolidation: x.st(after.consolidation), businesses: ((after.consolidation.data?.['businesses'] as unknown[]) ?? []).length };
    expect('salida de org: PERSONAL propio sigue legible', [after.book, after.expense], ['200', '200']); expect('salida de org: BUSINESS anterior denegado', /^40[34] /.test(after.business), true);
    expect('salida de org: consolidado sin el negocio anterior', ((after.consolidation.data?.['businesses'] as unknown[]) ?? []).length, 0);
    expect('salida de org: colaborador de la org anterior sigue sin ver PERSONAL', x.st(await x.settle(() => x.read('getPersonalExpenseEnvelope', ep, { asOf: D }, C))), '404 RESOURCE_NOT_FOUND');
    await ids.updateOne({ _id: subject }, { $set: { organizationId: original.organizationId as never, roles: original.roles } });
    // ---- HTTPS real: no-store, 401 sin sesión, 404 uniforme sin cuerpo con datos
    const web = await x.https(), http = web.client; http.cookies.set('__Host-caudelyx-session', x.a.issued.token);
    const own = await http.call('GET', '/api/v1/me/personal/book'); o['HTTPS propio'] = { status: own.status, cache: own.headers['cache-control'] };
    expect('HTTPS PERSONAL propio 200 no-store', [own.status, String(own.headers['cache-control'])], [200, 'no-store']);
    http.cookies.delete('__Host-caudelyx-session'); expect('HTTPS sin sesión 401', (await http.call('GET', '/api/v1/me/personal/book')).status, 401);
    http.cookies.set('__Host-caudelyx-session', C.issued.token);
    const path = (id: string) => `/api/v1/me/personal/books/${x.book.id}/finance-s09/expenses/${id}?asOf=${D}`, hf = await http.call('GET', path(idOf(ex))), hn = await http.call('GET', path(randomUUID()));
    o['HTTPS C ajeno/inexistente'] = { foreign: [hf.status, hf.body], missing: [hn.status, hn.body] };
    expect('HTTPS C → 404 uniforme sin datos', [hf.status, JSON.stringify((hf.body as Record<string, unknown>)['error'] ?? null).replace(/"requestId":"[^"]*"/, ''), leaks(hf.body)], [404, JSON.stringify((hn.body as Record<string, unknown>)['error'] ?? null).replace(/"requestId":"[^"]*"/, ''), []]);
    evidence('S09-PRIVACY', { observed: o, failures: fail, reads: reads.length });
    assert.deepEqual(fail, [], 'privacy mismatches');
    console.log('S09_P05_PRIVACY_PASS');
  } catch (e) { evidence('S09-PRIVACY-PARCIAL', { observed: o, failures: fail, error: String(e).slice(0, 400) }); throw e; } finally { await group.dispose(); }
});
