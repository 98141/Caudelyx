/* eslint-disable security/detect-object-injection -- Keys are this test's own fixed field names/array indexes, never request input. */
// S02-P05 independent finance checks (Claude) on S02-P04-v1-INTEGRADO. Everything below goes through the REAL HTTPS app
// (CSRF, session cookie, A32 password + A27 TOTP for every R) against an isolated Mongo 27017/rs0 group reserved for P05.
// Setup reuses the author's resource-guarded fixture only to create the group, actors and clock; assertions are independent.
// No secret, code or token is printed: evidence lines carry statuses, counts and synthetic amounts only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generate } from 'otplib';
import { financeFixture } from '../../finance/fixture.js';
import { today } from '../../../src/modules/finance/service.js';
import { ApiClient, type ApiBody } from '../../helpers/client.js';

type Fixture = Awaited<ReturnType<typeof financeFixture>>;
type Actor = Awaited<ReturnType<Fixture['actor']>>;
const evidence = (name: string, data: Record<string, unknown>) => console.log(JSON.stringify({ evidence: name, ...data }));
const day = (base: string, delta: number) => new Date(Date.parse(base + 'T12:00:00Z') + delta * 86400000).toISOString().slice(0, 10);
const purposeOf: Record<string, string> = { accounts: 'FINANCE_ACCOUNT_CREATE', rename: 'FINANCE_ACCOUNT_UPDATE', 'journal-entries': 'FINANCE_JOURNAL_POST', transfers: 'FINANCE_TRANSFER', reversals: 'FINANCE_JOURNAL_REVERSE' };

/** Owned HTTPS harness: one actor, one org, R per command through A32+A27 over HTTP. */
async function http(f: Fixture, a: Actor, org: string, shared?: { port: number; cert: Buffer }) {
  // f.https() starts ONE listener and pins config.tenantOrigin to it; further actors reuse that listener.
  let listener = shared, client: ApiClient;
  if (listener) { client = new ApiClient(listener.port, listener.cert); client.cookies.set('__Host-caudelyx-session', a.issued.token); await client.refreshCsrf(); }
  else { const started = await f.https(a); client = started.client; listener = { port: started.port, cert: started.cert }; }
  const base = `/api/v1/organizations/${org}/financial`;
  const r = async (c: ApiClient, actor: Actor, purpose: string, command: Record<string, unknown>, resourceId?: string) => {
    const a32 = await c.call('POST', '/api/v1/auth/reauthenticate', { password: f.password, purpose, command, ...(resourceId ? { resourceId } : {}) });
    if (a32.status !== 200) return a32.status;
    f.clock.value += 30000;
    const a27 = await c.call('POST', '/api/v1/auth/mfa/challenges/verify', { method: 'TOTP', purpose, code: await generate({ secret: actor.secret, epoch: Math.floor(f.now() / 1000) }), ...(resourceId ? { resourceId } : {}) });
    await c.refreshCsrf();
    return a27.status;
  };
  /** Full command: R bound to exactly this payload/key/ETag, then the financial call. */
  const send = async (c: ApiClient, actor: Actor, kind: 'accounts' | 'rename' | 'journal-entries' | 'transfers' | 'reversals', payload: Record<string, unknown>,
    o: { key?: string; id?: string; etag?: string; skipR?: boolean } = {}) => {
    const key = o.key ?? randomUUID();
    if (!o.skipR) {
      const status = await r(c, actor, purposeOf[kind]!, { organizationId: org, idempotencyKey: key, payload, ...(o.etag ? { expectedETag: o.etag } : {}) }, o.id);
      if (status !== 200) return { status: -status, body: {} as ApiBody, headers: {} as import('node:http').IncomingHttpHeaders, key };
    }
    const path = kind === 'rename' ? `${base}/accounts/${o.id}` : kind === 'reversals' ? `${base}/journal-entries/${o.id}/reversals` : `${base}/${kind}`;
    const res = await c.call(kind === 'rename' ? 'PATCH' : 'POST', path, payload, { 'Idempotency-Key': key, ...(o.etag ? { 'If-Match': o.etag } : {}) });
    return { ...res, key };
  };
  const account = async (code: string, accountClass: string, kind: string) => {
    const res = await send(client, a, 'accounts', { code, name: `Cuenta ${code}`, accountClass, kind, currency: 'COP' });
    assert.equal(res.status, 201, `create ${code}`); return String(res.body.data?.['id']);
  };
  const balances = async (asOf: string, recordedThrough?: string) => {
    const q = new URLSearchParams({ asOf, ...(recordedThrough ? { recordedThrough } : {}) });
    const res = await client.call('GET', `${base}/balances?${q.toString()}`); assert.equal(res.status, 200);
    return res.body.data as { recordedThrough: string; items: { accountId: string; naturalBalance: string; debitTotal: string; creditTotal: string }[] };
  };
  return { client, base, r, send, account, balances, listener };
}
const posting = (date: string, lines: [string, string, string][], extra: Record<string, unknown> = {}) => ({ currency: 'COP', effectiveDate: date, sourceId: randomUUID(),
  supportReference: 'Soporte sintético P05', description: 'Asiento sintético P05', lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit, credit })), ...extra });
const nb = (b: Awaited<ReturnType<Awaited<ReturnType<typeof http>>['balances']>>, id: string) => b.items.find(i => i.accountId === id)?.naturalBalance;
async function counts(f: Fixture) {
  const db = f.database.db;
  return { journals: await db.collection('financial_journals').countDocuments(), accounts: await db.collection('financial_accounts').countDocuments(),
    idempotency: await db.collection('financial_idempotency').countDocuments(), financeAudit: await db.collection('audit_events').countDocuments({ action: /^FINANCE_/ }),
    outbox: await db.collection('outbox').countDocuments() };
}
async function ledgerInvariant(f: Fixture) {
  const bad: string[] = [];
  for (const j of await f.database.db.collection('financial_journals').find({}).toArray()) {
    let d = 0n, c = 0n;
    for (const l of j['lines'] as { debit: { toString(): string }; credit: { toString(): string } }[]) {
      const ld = BigInt(l.debit.toString().replace('.', '')), lc = BigInt(l.credit.toString().replace('.', ''));
      if ((ld > 0n) === (lc > 0n)) bad.push(`${String(j['_id']).slice(0, 8)} one-side`);
      d += ld; c += lc;
    }
    if (d !== c) bad.push(`${String(j['_id']).slice(0, 8)} unbalanced`);
  }
  return bad;
}

test('P05-FIN-01 COP exactness over HTTPS: centavos sums, invalid/unrepresentable inputs, range edge, account immutability; ledger balanced per event; nothing mutates on rejection', { timeout: 240000 }, async () => {
  const f = await financeFixture();
  try {
    const a = await f.actor(), org = await f.organization(a), h = await http(f, a, org), date = today(f.now());
    const bank = await h.account('P5BANK', 'ASSET', 'BANK'), cash = await h.account('P5CASH', 'ASSET', 'CASH'), equity = await h.account('P5EQ', 'EQUITY', 'GENERAL');
    const observed = new Map<string, unknown>();
    const three = await h.send(h.client, a, 'journal-entries', posting(date, [[bank, '0.10', '0.00'], [cash, '0.20', '0.00'], [equity, '0.00', '0.30']]));
    observed.set('0.10+0.20=0.30 posting', `${three.status} ${JSON.stringify((three.body.data?.['lines'] as { debit: string; credit: string }[]).map(l => l.debit + '/' + l.credit))}`);
    const stored = await f.database.db.collection('financial_journals').findOne({ _id: String(three.body.data?.['id']) as never });
    observed.set('stored type', (stored?.['lines'] as { debit: { _bsontype: string } }[])[0]?.debit._bsontype);
    const before = await counts(f);
    const invalid: Record<string, unknown> = {};
    for (const [label, amount] of [['1999.5', '1999.5'], ['number 1999.5', 1999.5], ['es-CO 1.999,50', '1.999,50'], ['grouped 1,999.50', '1,999.50'], ['exponent', '1e3'], ['negative', '-1.00'],
      ['leading zero', '01.00'], ['spaces', ' 1.00'], ['three decimals', '0.001'], ['17 integer digits', '10000000000000000.00'], ['empty', ''], ['null', null]] as const) {
      const res = await h.send(h.client, a, 'journal-entries', posting(date, [[bank, amount as string, '0.00'], [equity, '0.00', '1.00']]), { skipR: true });
      invalid[label] = `${res.status} ${res.body.error?.code ?? ''}`;
    }
    observed.set('invalid amounts (no R needed: schema first)', invalid);
    const zeroBoth = await h.send(h.client, a, 'journal-entries', posting(date, [[bank, '0.00', '0.00'], [equity, '0.00', '0.00']]), { skipR: true });
    const bothSides = await h.send(h.client, a, 'journal-entries', posting(date, [[bank, '1.00', '1.00'], [equity, '0.00', '1.00']]), { skipR: true });
    const unbalanced = await h.send(h.client, a, 'journal-entries', posting(date, [[bank, '0.01', '0.00'], [equity, '0.00', '0.02']]));
    const oneAccount = await h.send(h.client, a, 'journal-entries', posting(date, [[bank, '1.00', '0.00'], [bank, '0.00', '1.00']]));
    const future = await h.send(h.client, a, 'journal-entries', posting(day(date, 1), [[bank, '1.00', '0.00'], [equity, '0.00', '1.00']]));
    const usd = await h.send(h.client, a, 'journal-entries', posting(date, [[bank, '1.00', '0.00'], [equity, '0.00', '1.00']], { currency: 'USD' }), { skipR: true });
    observed.set('semantic rejections', { zeroBoth: `${zeroBoth.status} ${zeroBoth.body.error?.code}`, bothSides: `${bothSides.status} ${bothSides.body.error?.code}`, unbalanced: `${unbalanced.status} ${unbalanced.body.error?.code}`,
      sameAccountBothSides: `${oneAccount.status} ${oneAccount.body.error?.code}`, futureDate: `${future.status} ${future.body.error?.code}`, currencyUSD: `${usd.status} ${usd.body.error?.code}` });
    const accountRejects: Record<string, unknown> = {};
    for (const [label, body] of [['CASH as LIABILITY', { code: 'P5X1', name: 'x', accountClass: 'LIABILITY', kind: 'CASH', currency: 'COP' }], ['initial balance field', { code: 'P5X2', name: 'x', accountClass: 'ASSET', kind: 'BANK', currency: 'COP', balance: '100.00' }],
      ['ownerId injected', { code: 'P5X3', name: 'x', accountClass: 'ASSET', kind: 'BANK', currency: 'COP', ownerId: randomUUID() }], ['scope PERSONAL', { code: 'P5X4', name: 'x', accountClass: 'ASSET', kind: 'BANK', currency: 'COP', financialScope: 'PERSONAL' }],
      ['lowercase code', { code: 'p5x5', name: 'x', accountClass: 'ASSET', kind: 'BANK', currency: 'COP' }]] as const) {
      const res = await h.send(h.client, a, 'accounts', body as Record<string, unknown>, { skipR: true }); accountRejects[label] = `${res.status} ${res.body.error?.code ?? ''}`;
    }
    const dup = await h.send(h.client, a, 'accounts', { code: 'P5BANK', name: 'Duplicada', accountClass: 'ASSET', kind: 'BANK', currency: 'COP' });
    accountRejects['duplicate code'] = `${dup.status} ${dup.body.error?.code ?? ''}`;
    const accountRow = await h.client.call('GET', `${h.base}/accounts/${bank}`), etag = String(accountRow.headers['etag']);
    const patchExtra = await h.send(h.client, a, 'rename', { name: 'Banco', kind: 'CASH' }, { id: bank, etag, skipR: true });
    accountRejects['PATCH with kind'] = `${patchExtra.status} ${patchExtra.body.error?.code ?? ''}`;
    for (const [m, p] of [['DELETE', `${h.base}/accounts/${bank}`], ['PUT', `${h.base}/accounts/${bank}`], ['POST', `${h.base}/accounts/${bank}/balance`], ['DELETE', `${h.base}/journal-entries/${String(three.body.data?.['id'])}`]] as const)
      accountRejects[`${m} ${p.split('/financial/')[1]?.replace(/[0-9a-f-]{36}/g, '{id}')}`] = (await h.client.call(m, p, m === 'DELETE' ? undefined : { balance: '1.00' }, { 'Idempotency-Key': randomUUID() })).status;
    observed.set('account/ledger immutability', accountRejects);
    const after = await counts(f);
    // R issuance (A32/A27) legitimately audits; compare only financial state and FINANCE_* audits.
    const fin = (c: typeof before) => ({ journals: c.journals, accounts: c.accounts, idempotency: c.idempotency, financeAudit: c.financeAudit });
    observed.set('counts unchanged by every rejection', JSON.stringify(fin(before)) === JSON.stringify(fin(after)) ? true : { before: fin(before), after: fin(after) });
    // Range edge on a separate org so the earlier book is untouched.
    const b = await f.actor(), orgB = await f.organization(b), hb = await http(f, b, orgB, h.listener);
    const bb = await hb.account('MAXBANK', 'ASSET', 'BANK'), be = await hb.account('MAXEQ', 'EQUITY', 'GENERAL');
    const max = await hb.send(hb.client, b, 'journal-entries', posting(date, [[bb, '9999999999999999.99', '0.00'], [be, '0.00', '9999999999999999.99']]));
    const over = await hb.send(hb.client, b, 'journal-entries', posting(date, [[bb, '0.01', '0.00'], [be, '0.00', '0.01']]));
    const maxBal = await hb.balances(date);
    observed.set('range edge', { maxPosting: max.status, plusOneCent: `${over.status} ${over.body.error?.code ?? ''}`, bankBalance: nb(maxBal, bb), equityBalance: nb(maxBal, be) });
    const bal = await h.balances(date);
    observed.set('balances after 0.10/0.20/0.30', { bank: nb(bal, bank), cash: nb(bal, cash), equity: nb(bal, equity) });
    observed.set('ledger invariant violations', await ledgerInvariant(f));
    evidence('P05-FIN-01', { observed: Object.fromEntries(observed) });
    assert.match(String(observed.get('0.10+0.20=0.30 posting')), /^201 \["0\.10\/0\.00","0\.20\/0\.00","0\.00\/0\.30"\]$/);
    assert.equal(observed.get('stored type'), 'Decimal128');
    for (const v of Object.values(invalid)) assert.match(String(v), /^422 INPUT_INVALID$/);
    assert.deepEqual(observed.get('semantic rejections'), { zeroBoth: '422 INPUT_INVALID', bothSides: '422 INPUT_INVALID', unbalanced: '422 UNBALANCED_ENTRY', sameAccountBothSides: '422 INPUT_INVALID', futureDate: '422 INPUT_INVALID', currencyUSD: '422 INPUT_INVALID' });
    for (const [k, v] of Object.entries(accountRejects)) if (k.startsWith('DELETE') || k.startsWith('PUT') || k.startsWith('POST')) assert.ok(Number(v) >= 400 && Number(v) !== 200 && Number(v) !== 201, k); else assert.match(String(v), /^(409|422) /, k);
    assert.equal(observed.get('counts unchanged by every rejection'), true);
    assert.deepEqual(observed.get('range edge'), { maxPosting: 201, plusOneCent: '422 INPUT_INVALID', bankBalance: '9999999999999999.99', equityBalance: '9999999999999999.99' });
    assert.deepEqual(observed.get('balances after 0.10/0.20/0.30'), { bank: '0.10', cash: '0.20', equity: '0.30' });
    assert.deepEqual(observed.get('ledger invariant violations'), []);
  } finally { await f.close(); }
});

test('P05-FIN-02 approved example by effective date and recorded cut: aporte, transferencia 25.50, compensación; reconstruction from paged journals equals API balances; original immutable; overdraft (also retroactive) rejected', { timeout: 240000 }, async () => {
  const f = await financeFixture();
  try {
    const a = await f.actor(), org = await f.organization(a), h = await http(f, a, org), t = today(f.now());
    const D1 = day(t, -3), D2 = day(t, -2), D3 = day(t, -1), D0 = day(t, -4);
    const bank = await h.account('BANCO', 'ASSET', 'BANK'), cash = await h.account('CAJA', 'ASSET', 'CASH'), equity = await h.account('APORTE', 'EQUITY', 'GENERAL'), income = await h.account('INGRESO', 'INCOME', 'GENERAL');
    const observed = new Map<string, unknown>();
    const cut0 = (await h.balances(t)).recordedThrough; f.clock.value += 1000;
    const aporte = await h.send(h.client, a, 'journal-entries', posting(D1, [[bank, '100.00', '0.00'], [equity, '0.00', '100.00']]));
    const cut1 = (await h.balances(t)).recordedThrough; f.clock.value += 1000;
    const transfer = await h.send(h.client, a, 'transfers', { currency: 'COP', effectiveDate: D2, sourceId: randomUUID(), supportReference: 'Soporte P05', description: 'Banco a caja', fromAccountId: bank, toAccountId: cash, amount: '25.50' });
    const tid = String(transfer.body.data?.['id']), tEtag = String(transfer.headers['etag']);
    const originalGet = await h.client.call('GET', `${h.base}/journal-entries/${tid}`);
    const cut2 = (await h.balances(t)).recordedThrough; f.clock.value += 1000;
    observed.set('transfer lines', (transfer.body.data?.['lines'] as { accountId: string; debit: string; credit: string }[]).map(l => `${l.accountId === bank ? 'BANK' : l.accountId === cash ? 'CASH' : '?'} ${l.debit}/${l.credit}`));
    const noIfMatch = await h.send(h.client, a, 'reversals', { effectiveDate: D3, sourceId: randomUUID(), supportReference: 'P05', reason: 'Sin ETag' }, { id: tid, skipR: true });
    const staleEtag = await h.send(h.client, a, 'reversals', { effectiveDate: D3, sourceId: randomUUID(), supportReference: 'P05', reason: 'ETag ajeno' }, { id: tid, etag: `"${tid}:2"` });
    const beforeOriginal = await h.send(h.client, a, 'reversals', { effectiveDate: D1, sourceId: randomUUID(), supportReference: 'P05', reason: 'Antes del original' }, { id: tid, etag: tEtag });
    const reversal = await h.send(h.client, a, 'reversals', { effectiveDate: D3, sourceId: randomUUID(), supportReference: 'P05', reason: 'Compensación P05' }, { id: tid, etag: tEtag });
    const rid = String(reversal.body.data?.['id']);
    const second = await h.send(h.client, a, 'reversals', { effectiveDate: D3, sourceId: randomUUID(), supportReference: 'P05', reason: 'Otra vez' }, { id: tid, etag: tEtag });
    const ofReversal = await h.send(h.client, a, 'reversals', { effectiveDate: D3, sourceId: randomUUID(), supportReference: 'P05', reason: 'Reversión de reversión' }, { id: rid, etag: String(reversal.headers['etag']) });
    const originalAfter = await h.client.call('GET', `${h.base}/journal-entries/${tid}`);
    observed.set('reversal rules', { noIfMatch: `${noIfMatch.status} ${noIfMatch.body.error?.code}`, staleEtag: `${staleEtag.status} ${staleEtag.body.error?.code}`, dateBeforeOriginal: `${beforeOriginal.status} ${beforeOriginal.body.error?.code}`,
      reversal: `${reversal.status} reversalOf=${reversal.body.data?.['reversalOfId'] === tid} source=${(reversal.body.data?.['source'] as Record<string, string>)['type']}`, secondReversal: `${second.status} ${second.body.error?.code}`,
      reversalOfReversal: `${ofReversal.status} ${ofReversal.body.error?.code}`, originalUnchanged: JSON.stringify(originalGet.body.data) === JSON.stringify(originalAfter.body.data) && originalGet.headers['etag'] === originalAfter.headers['etag'] });
    const cut3 = (await h.balances(t)).recordedThrough;
    const table: Record<string, unknown> = {};
    for (const [label, asOf, rt] of [['D0', D0, undefined], ['D1', D1, undefined], ['D2', D2, undefined], ['D3', D3, undefined], ['D3 @cut0 (nothing recorded)', D3, cut0], ['D3 @cut1', D3, cut1], ['D3 @cut2 (before reversal recorded)', D3, cut2], ['D3 @cut3', D3, cut3]] as const) {
      const b = await h.balances(asOf, rt);
      table[label] = { bank: nb(b, bank), cash: nb(b, cash), equity: nb(b, equity), income: nb(b, income) };
    }
    observed.set('balances by effective date / recorded cut', table);
    const repeat = await h.balances(D2, cut2), repeatAgain = await h.balances(D2, cut2);
    observed.set('same cuts same result', JSON.stringify(repeat) === JSON.stringify(repeatAgain));
    // Independent reconstruction: page the journal list one item at a time and sum with BigInt per account and date.
    const pages: { effectiveDate: string; lines: { accountId: string; debit: string; credit: string }[] }[] = [];
    let cursor: string | null = null, guard = 0;
    do {
      const q: URLSearchParams = new URLSearchParams({ limit: '1', asOf: t, recordedThrough: cut3, ...(cursor ? { cursor } : {}) });
      const res = await h.client.call('GET', `${h.base}/journal-entries?${q.toString()}`); assert.equal(res.status, 200);
      const page = res.body.data as { items: typeof pages; nextCursor: string | null }; pages.push(...page.items); cursor = page.nextCursor;
    } while (cursor && ++guard < 50);
    const centsOf = (v: string) => BigInt(v.replace('.', '')), fmt = (v: bigint) => `${v < 0n ? '-' : ''}${(v < 0n ? -v : v) / 100n}.${String((v < 0n ? -v : v) % 100n).padStart(2, '0')}`;
    const mismatches: string[] = [];
    for (const asOf of [D0, D1, D2, D3]) {
      const api = await h.balances(asOf, cut3);
      for (const [id, debitNatural] of [[bank, true], [cash, true], [equity, false], [income, false]] as const) {
        let s = 0n; for (const j of pages.filter(p => p.effectiveDate <= asOf)) for (const l of j.lines.filter(x => x.accountId === id)) s += debitNatural ? centsOf(l.debit) - centsOf(l.credit) : centsOf(l.credit) - centsOf(l.debit);
        if (fmt(s) !== nb(api, id)) mismatches.push(`${asOf} ${id.slice(0, 6)} api=${nb(api, id)} own=${fmt(s)}`);
      }
    }
    observed.set('paged journals', pages.length); observed.set('reconstruction mismatches', mismatches);
    // Overdraft: current, and retroactive (cash had nothing on D1).
    const overdraft = await h.send(h.client, a, 'transfers', { currency: 'COP', effectiveDate: t, sourceId: randomUUID(), supportReference: 'P05', description: 'Excede', fromAccountId: bank, toAccountId: cash, amount: '100.01' });
    const retro = await h.send(h.client, a, 'transfers', { currency: 'COP', effectiveDate: D1, sourceId: randomUUID(), supportReference: 'P05', description: 'Retroactivo', fromAccountId: cash, toAccountId: bank, amount: '0.01' });
    const sameAcc = await h.send(h.client, a, 'transfers', { currency: 'COP', effectiveDate: t, sourceId: randomUUID(), supportReference: 'P05', description: 'Misma', fromAccountId: bank, toAccountId: bank, amount: '1.00' });
    const general = await h.send(h.client, a, 'transfers', { currency: 'COP', effectiveDate: t, sourceId: randomUUID(), supportReference: 'P05', description: 'General', fromAccountId: bank, toAccountId: equity, amount: '1.00' });
    const zero = await h.send(h.client, a, 'transfers', { currency: 'COP', effectiveDate: t, sourceId: randomUUID(), supportReference: 'P05', description: 'Cero', fromAccountId: bank, toAccountId: cash, amount: '0.00' }, { skipR: true });
    // Reversing the funding after money left the bank would make it negative from D3 on: must be refused.
    const fundingReversal = await h.send(h.client, a, 'transfers', { currency: 'COP', effectiveDate: t, sourceId: randomUUID(), supportReference: 'P05', description: 'Banco a caja hoy', fromAccountId: bank, toAccountId: cash, amount: '60.00' });
    const aporteRev = await h.send(h.client, a, 'reversals', { effectiveDate: t, sourceId: randomUUID(), supportReference: 'P05', reason: 'Revertir aporte' }, { id: String(aporte.body.data?.['id']), etag: String(aporte.headers['etag']) });
    observed.set('transfer/overdraft rules', { overdraft: `${overdraft.status} ${overdraft.body.error?.code}`, retroactive: `${retro.status} ${retro.body.error?.code}`, sameAccount: `${sameAcc.status} ${sameAcc.body.error?.code}`,
      toGeneral: `${general.status} ${general.body.error?.code}`, zero: `${zero.status} ${zero.body.error?.code}`, transfer60: fundingReversal.status, reverseFundingAfterSpending: `${aporteRev.status} ${aporteRev.body.error?.code}` });
    const final = await h.balances(t);
    observed.set('final', { bank: nb(final, bank), cash: nb(final, cash), equity: nb(final, equity), income: nb(final, income) });
    observed.set('ledger invariant violations', await ledgerInvariant(f));
    evidence('P05-FIN-02', { observed: Object.fromEntries(observed) });
    assert.deepEqual(observed.get('transfer lines'), ['CASH 25.50/0.00', 'BANK 0.00/25.50']);
    assert.deepEqual(observed.get('reversal rules'), { noIfMatch: '428 ETAG_REQUIRED', staleEtag: '412 PRECONDITION_FAILED', dateBeforeOriginal: '422 INPUT_INVALID', reversal: '201 reversalOf=true source=REVERSAL', secondReversal: '409 ALREADY_REVERSED', reversalOfReversal: '422 INPUT_INVALID', originalUnchanged: true });
    assert.deepEqual(table, {
      D0: { bank: '0.00', cash: '0.00', equity: '0.00', income: '0.00' }, D1: { bank: '100.00', cash: '0.00', equity: '100.00', income: '0.00' },
      D2: { bank: '74.50', cash: '25.50', equity: '100.00', income: '0.00' }, D3: { bank: '100.00', cash: '0.00', equity: '100.00', income: '0.00' },
      'D3 @cut0 (nothing recorded)': { bank: '0.00', cash: '0.00', equity: '0.00', income: '0.00' }, 'D3 @cut1': { bank: '100.00', cash: '0.00', equity: '100.00', income: '0.00' },
      'D3 @cut2 (before reversal recorded)': { bank: '74.50', cash: '25.50', equity: '100.00', income: '0.00' }, 'D3 @cut3': { bank: '100.00', cash: '0.00', equity: '100.00', income: '0.00' } });
    assert.equal(observed.get('same cuts same result'), true); assert.equal(observed.get('paged journals'), 3); assert.deepEqual(mismatches, []);
    assert.deepEqual(observed.get('transfer/overdraft rules'), { overdraft: '409 ACCOUNT_OVERDRAFT', retroactive: '409 ACCOUNT_OVERDRAFT', sameAccount: '422 INPUT_INVALID', toGeneral: '422 INPUT_INVALID', zero: '422 INPUT_INVALID', transfer60: 201, reverseFundingAfterSpending: '409 ACCOUNT_OVERDRAFT' });
    assert.deepEqual(observed.get('final'), { bank: '40.00', cash: '60.00', equity: '100.00', income: '0.00' });
    assert.deepEqual(observed.get('ledger invariant violations'), []);
  } finally { await f.close(); }
});

test('P05-FIN-03 idempotency and races over HTTPS: same command from two sessions, replay needs a fresh R, payload/source conflicts, concurrent withdrawals cannot overdraw, failed commands leave no partial effect and do not consume R', { timeout: 240000 }, async () => {
  const f = await financeFixture();
  try {
    const a = await f.actor(), org = await f.organization(a), h = await http(f, a, org), t = today(f.now());
    const bank = await h.account('B', 'ASSET', 'BANK'), cash = await h.account('C', 'ASSET', 'CASH'), equity = await h.account('E', 'EQUITY', 'GENERAL');
    const observed = new Map<string, unknown>();
    const second = await f.login(a), h2 = await http(f, second, org, h.listener);
    const payload = posting(t, [[bank, '100.00', '0.00'], [equity, '0.00', '100.00']]), key = randomUUID(), command = { organizationId: org, idempotencyKey: key, payload };
    const before = await counts(f);
    assert.equal(await h.r(h.client, a, 'FINANCE_JOURNAL_POST', command), 200); assert.equal(await h2.r(h2.client, second, 'FINANCE_JOURNAL_POST', command), 200);
    const race = await Promise.all([h.client, h2.client].map(c => c.call('POST', `${h.base}/journal-entries`, payload, { 'Idempotency-Key': key })));
    const afterRace = await counts(f);
    observed.set('same command, two sessions, concurrent', { statuses: race.map(r => r.status).sort(), sameBody: JSON.stringify(race[0]?.body.data) === JSON.stringify(race[1]?.body.data),
      journalsDelta: afterRace.journals - before.journals, idempotencyDelta: afterRace.idempotency - before.idempotency });
    const replayNoR = await h.client.call('POST', `${h.base}/journal-entries`, payload, { 'Idempotency-Key': key });
    const replay = await h.send(h.client, a, 'journal-entries', payload, { key });
    const changed = await h.send(h.client, a, 'journal-entries', { ...payload, description: 'Otro texto' }, { key });
    const reorder = await h.send(h.client, a, 'journal-entries', { ...payload, lines: [...payload.lines].reverse() }, { key });
    const otherKeySameSource = await h.send(h.client, a, 'journal-entries', payload);
    const sameSourceTransfer = await h.send(h.client, a, 'transfers', { currency: 'COP', effectiveDate: t, sourceId: payload.sourceId, supportReference: 'P05', description: 'Mismo sourceId otro tipo', fromAccountId: bank, toAccountId: cash, amount: '1.00' });
    observed.set('replay/conflicts', { replayWithoutFreshR: `${replayNoR.status} ${replayNoR.body.error?.code}`, replayWithFreshR: `${replay.status} sameId=${replay.body.data?.['id'] === race.find(r => r.status === 201)?.body.data?.['id']}`,
      sameKeyChangedDescription: `${changed.status} ${changed.body.error?.code}`, sameKeyReorderedLines: `${reorder.status} ${reorder.body.error?.code}`, otherKeySameSource: `${otherKeySameSource.status} ${otherKeySameSource.body.error?.code}`,
      sameSourceIdOtherType: sameSourceTransfer.status });
    // Concurrent withdrawals: each fits alone, together they would overdraw BANK (99.00 left after the 1.00 transfer).
    const w = (amount: string) => ({ currency: 'COP', effectiveDate: t, sourceId: randomUUID(), supportReference: 'P05', description: 'Retiro concurrente', fromAccountId: bank, toAccountId: cash, amount });
    const w1 = w('60.00'), w2 = w('60.00'), k1 = randomUUID(), k2 = randomUUID();
    assert.equal(await h.r(h.client, a, 'FINANCE_TRANSFER', { organizationId: org, idempotencyKey: k1, payload: w1 }), 200);
    assert.equal(await h2.r(h2.client, second, 'FINANCE_TRANSFER', { organizationId: org, idempotencyKey: k2, payload: w2 }), 200);
    const preRace2 = await counts(f);
    const race2 = await Promise.all([h.client.call('POST', `${h.base}/transfers`, w1, { 'Idempotency-Key': k1 }), h2.client.call('POST', `${h.base}/transfers`, w2, { 'Idempotency-Key': k2 })]);
    const postRace2 = await counts(f), bal = await h.balances(t);
    const loserContext = race2[0]?.status === 409 ? a : second;
    const loserR = (await f.context(loserContext.issued.context)).reauth;
    observed.set('concurrent withdrawals', { statuses: race2.map(r => `${r.status} ${r.body.error?.code ?? ''}`.trim()).sort(), bank: nb(bal, bank), cash: nb(bal, cash),
      journalsDelta: postRace2.journals - preRace2.journals, auditDelta: postRace2.financeAudit - preRace2.financeAudit, outboxDelta: postRace2.outbox - preRace2.outbox, loserRConsumed: loserR?.consumed ?? 'none' });
    // The losing request's R is still unconsumed and bound: retrying the same command gets the same business refusal, not R_REQUIRED.
    const loserClient = loserContext === a ? h.client : h2.client, loserBody = loserContext === a ? w1 : w2, loserKey = loserContext === a ? k1 : k2;
    const retry = await loserClient.call('POST', `${h.base}/transfers`, loserBody, { 'Idempotency-Key': loserKey });
    observed.set('loser retries same command with same R', `${retry.status} ${retry.body.error?.code ?? ''}`);
    const end = await counts(f);
    // Every non-replay success = exactly one idempotency row + one FINANCE_* audit; replays add only FINANCE_REPLAY audits.
    const successes = await f.database.db.collection('financial_idempotency').countDocuments();
    const firstTimeAudits = await f.database.db.collection('audit_events').countDocuments({ action: /^FINANCE_(?!REPLAY)/ });
    observed.set('atomic bookkeeping', { idempotencyRows: successes, firstTimeFinanceAudits: firstTimeAudits, journals: end.journals, accounts: end.accounts, replayAudits: await f.database.db.collection('audit_events').countDocuments({ action: 'FINANCE_REPLAY' }) });
    observed.set('ledger invariant violations', await ledgerInvariant(f));
    evidence('P05-FIN-03', { observed: Object.fromEntries(observed) });
    assert.deepEqual(observed.get('same command, two sessions, concurrent'), { statuses: [200, 201], sameBody: true, journalsDelta: 1, idempotencyDelta: 1 });
    assert.deepEqual(observed.get('replay/conflicts'), { replayWithoutFreshR: '403 R_REQUIRED', replayWithFreshR: '200 sameId=true', sameKeyChangedDescription: '409 IDEMPOTENCY_CONFLICT', sameKeyReorderedLines: '409 IDEMPOTENCY_CONFLICT', otherKeySameSource: '409 SOURCE_CONFLICT', sameSourceIdOtherType: 201 });
    assert.deepEqual(observed.get('concurrent withdrawals'), { statuses: ['201', '409 ACCOUNT_OVERDRAFT'], bank: '39.00', cash: '61.00', journalsDelta: 1, auditDelta: 1, outboxDelta: 1, loserRConsumed: false });
    assert.equal(observed.get('loser retries same command with same R'), '409 ACCOUNT_OVERDRAFT');
    assert.deepEqual(observed.get('atomic bookkeeping'), { idempotencyRows: 6, firstTimeFinanceAudits: 6, journals: 3, accounts: 3, replayAudits: 2 });
    assert.deepEqual(observed.get('ledger invariant violations'), []);
  } finally { await f.close(); }
});
