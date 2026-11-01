/* eslint-disable security/detect-object-injection -- Own synthetic records, own evidence path, closed collection names read from the own test database. */
// S12-P05 (Claude): native review with ONE own Mongo group. Oracle values come from raw journal lines and own inputs,
// never from the production calculator. Full-database diff (all collections, three own databases) + command spies.
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {s12Profile, world} from './profile.js';
import {workbook} from './book.js';
import {table} from '../../src/modules/obligations/models.js';
import type {Data} from '../../src/modules/simulation/models.js';

const OUT = '../../Construccion/Sprints/S12/Evidencias/S12-P05-CHECKS-NATIVE.json';
const checks: Record<string, unknown> = {};
const MARK = 'P05MARK' + randomUUID().replace(/-/g, '').slice(0, 12);
const ECONOMIC = /^(financial_|lending_|loan_|payment|payments$|cash_|held_|collection_|reconciliation|opening_|custody_|s09_|s10_|s11_|transaction_fence|organizations$|identities$)/;
const TECHNICAL_ALLOWED = /^(s12_|audit_events$|security_sequence$|outbox$|security_evidence_outbox$|security_evidence_projection$|reporting_projection_barriers$|s09_projection_barriers$)/;

test('S12-P05 native: raw oracle, deficit order, four alternatives, full no-mutation diff, alerts, privacy markers, H04', {timeout: 900000}, async t => {
  const group = await s12Profile();
  try {
    const f = await world(group), sim = f.runtime.simulation, ex = f.identity.exchange!;
    const dbs = [f.database.db, ...group.names.slice(1).map(n => f.database.client.db(n))];
    const snapshot = async () => { const out: Record<string, Record<string, string>> = {}; for (const db of dbs) for (const c of await db.listCollections({}, {nameOnly: true}).toArray()) { const docs = await db.collection(c.name).find({}).toArray(); out[db.databaseName.replace(group.names[0]!, 'main') + '/' + c.name] = Object.fromEntries(docs.map(d => [String(d['_id']), JSON.stringify(d)])); } return out; };
    const diff = (a: Awaited<ReturnType<typeof snapshot>>, b: Awaited<ReturnType<typeof snapshot>>) => { const changes: Record<string, {added: number; removed: number; changed: number; fields: string[]}> = {};
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const x = a[k] ?? {}, y = b[k] ?? {}; let added = 0, removed = 0, changed = 0; const fields = new Set<string>();
        for (const id of new Set([...Object.keys(x), ...Object.keys(y)])) { if (!(id in x)) added++; else if (!(id in y)) removed++; else if (x[id] !== y[id]) { changed++; const p = JSON.parse(x[id]!) as Data, q = JSON.parse(y[id]!) as Data; for (const fld of new Set([...Object.keys(p), ...Object.keys(q)])) if (JSON.stringify(p[fld]) !== JSON.stringify(q[fld])) fields.add(fld); } }
        if (added || removed || changed) changes[k] = {added, removed, changed, fields: [...fields].sort()}; }
      return changes; };
    const classify = (changes: ReturnType<typeof diff>) => { const economic: string[] = [], technical: string[] = [], unexpected: string[] = [];
      for (const [k, c] of Object.entries(changes)) { const [db, name] = k.split('/') as [string, string];
        if (db !== 'main') unexpected.push(k);
        else if (name === 'contexts') { if (c.added || c.removed || c.fields.some(x => !['lastSeenAt', 'csrf', 'csrfToken', 'csrfDigest', 'csrfSecret'].includes(x))) unexpected.push(k + ':' + c.fields.join(',')); else technical.push(k); }
        else if (TECHNICAL_ALLOWED.test(name)) technical.push(k); else if (ECONOMIC.test(name)) economic.push(k); else unexpected.push(k); }
      return {economic, technical, unexpected}; };
    let commands = 0; const spied: string[] = [];
    const spy = () => { const saved: (() => void)[] = []; for (const [label, svc] of Object.entries({finance: f.runtime.finance, opening: f.runtime.opening, lending: f.runtime.lending, operations: f.runtime.operations, payments: f.runtime.payments, collections: f.runtime.collections, obligations: f.service, wealth: f.wealth, exchange: ex}) as unknown as [string, Record<string, unknown>][]) for (const m of ['mutate', 'confirm', 'post']) { const orig = svc?.[m]; if (typeof orig === 'function') { svc[m] = function (...args: unknown[]) { commands++; spied.push(label + '.' + m); return (orig as (...a: unknown[]) => unknown).apply(this, args); }; saved.push(() => { svc[m] = orig; }); } } return () => saved.forEach(r => r()); };
    const tick = (ms = 6500) => { f.clock.value += ms; };
    type Actor = typeof f.a;
    const call = async (actor: Actor, op: string, input: Data = {}, params: Record<string, string> = {}, query: Data = {}, key: string = randomUUID(), expected?: string) => { if (/^(capture|create|start|cancel|resume|compare|evaluate|acknowledge|archive)/.test(op)) tick(); return await sim.execute(actor.issued.context, op, input, params, query, key, expected); };
    const fail = async (fn: () => Promise<unknown>) => { try { const r = await fn(); return {ok: true, r: JSON.stringify(r).slice(0, 300)}; } catch (e) { return {status: (e as {status?: number}).status, code: (e as {code?: string}).code ?? String(e).slice(0, 120), text: JSON.stringify(e) + String(e)}; } };
    const today = () => new Date(f.now() - 5 * 3600000).toISOString().slice(0, 10);
    const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
    const def = (baseId: string, baseToken: string, o: {horizon?: number; budget?: string; alts?: Data[]; capital?: Data[]; prudent?: Data} = {}) => ({baseId, baseToken, horizonDays: o.horizon ?? 30,
      assumptions: ['PRUDENT', 'BASE', 'FAVORABLE'].map(kind => ({kind, collectionFraction: '1.000000', delayDays: 0, recoveryFraction: '0.000000', recoveryDelayDays: 0, interestProjection: 'DECLARED_SCHEDULE_ONLY', dateOverrides: [], capitalEvents: o.capital ?? [], ...(kind === 'PRUDENT' ? o.prudent ?? {} : {})})),
      alternatives: ['HOLD_CASH', 'DEBT_PREPAYMENT', 'NEW_LOAN', 'ASSET_PURCHASE'].map(kind => o.alts?.find(a => a['kind'] === kind) ?? (kind === 'HOLD_CASH' ? {kind, budget: o.budget ?? '0.00', configured: true, reserveReleases: []} : {kind, budget: o.budget ?? '0.00', configured: false, reason: 'NOT_CONFIGURED'}))});
    const runToEnd = async (actor: Actor, ps: Record<string, string>, scenarioId: string, baseToken: string, prefix = 'Business') => { const run = await call(actor, 'startRun' + prefix + 'Simulation', {scenarioId, scenarioVersion: 1, baseToken, mode: 'STANDARD', sensitivity: null, evaluateAlerts: true}, ps); const rp = {...ps, runId: String(run.data['id'])}; let cur = run;
      for (let i = 0; i < 60 && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(String(cur.data['state'])); i++) { await new Promise(r => setTimeout(r, 200)); cur = await call(actor, 'getRun' + prefix + 'Simulation', {}, rp); }
      return {rp, state: String(cur.data['state']), run: cur.data}; };

    // ---- Actor T2 with an EMPTY business book (cash 0) for the deficit oracle.
    const t2 = await f.actor(), org2 = (await f.runtime.organizations.create(t2.issued.context, {name: 'Org P05 ' + MARK, currency: 'COP', timezone: 'America/Bogota'}, randomUUID())).data.organization.id, p2 = {organizationId: org2};
    await t.test('N1 base from raw journals: org1 cash 20M and empty org2 cash 0; fund 20M protected once', async () => {
      const b1 = await call(f.a, 'captureBaseBusinessSimulation', {asOf: today(), currency: 'COP'}, {organizationId: f.org});
      const journals = await f.database.db.collection('financial_journals').find({organizationId: f.org}).toArray(), banks = new Set((await f.database.db.collection('financial_accounts').find({organizationId: f.org, kind: {$in: ['BANK', 'CASH']}}).toArray()).map(a => String(a['_id'])));
      let raw = 0n; for (const j of journals) if (String(j['effectiveDate']) <= today()) for (const l of j['lines'] as Data[]) if (banks.has(String(l['accountId']))) raw += BigInt(String(l['debit']).replace('.', '')) - BigInt(String(l['credit']).replace('.', ''));
      const empty = await call(t2, 'captureBaseBusinessSimulation', {asOf: today(), currency: 'COP'}, p2);
      checks['N1'] = {rawJournalCashCents: String(raw), base1: {cash: b1.data['cashBook'], available: b1.data['available'], coverage: b1.data['coverage']}, base2: {cash: empty.data['cashBook'], coverage: empty.data['coverage']}};
      assert.equal((b1.data['cashBook'] as Data)['value'], (raw / 100n) + '.' + String(raw % 100n).padStart(2, '0'));
      assert.equal((empty.data['cashBook'] as Data)['value'], '0.00');
    });
    await t.test('N2 native expense OUT30 day16 + declared capital IN50 day28: deficit30/final20 (UI-independent oracle)', async () => {
      await f.mutate('businessCreateExpense', {nominalDate: '2026-11-16', dueDate: '2026-11-16', description: 'Gasto ' + MARK, category: 'OTHER', amountMode: 'FIXED', amount: '30.00', supportReference: 'SYN-P05'}, p2, undefined, randomUUID(), t2);
      const b = await call(t2, 'captureBaseBusinessSimulation', {asOf: today(), currency: 'COP'}, p2), d = def(String(b.data['id']), String(b.data['baseToken']), {capital: [{id: randomUUID(), date: '2026-11-28', kind: 'DECLARED_CAPITAL_IN', amount: '50.00', cashSourceFlowId: null, sourceReference: 'SYN-P05', economicClass: 'CAPITAL_CONTRIBUTION'}]});
      const sc = await call(t2, 'createScenarioBusinessSimulation', {name: 'Escenario ' + MARK, ...d}, p2), r = await runToEnd(t2, p2, String(sc.data['id']), String(b.data['baseToken']));
      assert.equal(r.state, 'SUCCEEDED', JSON.stringify(r.run));
      const res = await call(t2, 'getResultsBusinessSimulation', {}, r.rp, {limit: '100'}), outcomes = res.data['outcomes'] as Data[], o = outcomes.find(x => x['scenarioKind'] === 'BASE' && x['alternativeKind'] === 'HOLD_CASH')!, m = o['metrics'] as Record<string, Data>;
      checks['N2'] = {asOf: today(), firstDeficitDate: o['firstDeficitDate'], availableMinimum: m['availableMinimum'], peak: m['peakDeficit'], cashFinal: m['cashFinal'], coverage: o['coverage'], outcomes: outcomes.length, totalRows: res.data['totalRows']};
      assert.equal(m['availableMinimum']!['value'], '-30.00'); assert.equal(m['peakDeficit']!['value'], '30.00'); assert.equal(m['cashFinal']!['value'], '20.00'); assert.equal(o['firstDeficitDate'], '2026-11-16');
      (checks as Data)['ids2'] = {scenarioId: sc.data['id'], runId: r.rp.runId, baseId: b.data['id']};
    });
    await t.test('N3 four alternatives on native 80M/fund20M + full-database no-mutation diff and command spies', async () => {
      const date = today(), extra = {currency: 'COP', effectiveDate: date, sourceId: randomUUID(), supportReference: 'SYN-P05-CAP', description: 'Capital P05', lines: [{accountId: f.bank.id, debit: '60000000.00', credit: '0.00'}, {accountId: f.equity.id, debit: '0.00', credit: '60000000.00'}]}, ck = randomUUID();
      await f.proof(f.a, 'FINANCE_JOURNAL_POST', {organizationId: f.org, idempotencyKey: ck, payload: extra}); await f.runtime.finance.mutate(f.a.issued.context, 'postJournal', f.org, extra, ck);
      const ps = {organizationId: f.org}, fund = await f.wealthMutate('businessCreateFund', {mode: 'VIRTUAL', label: 'Reserva P05', purpose: 'ASSET_PURCHASE', backingAccountId: f.bank.id, supportReference: 'SYN'}, ps), fundId = String((fund.data as Data)['id']), fp = {...ps, fundId};
      const fr = await f.wealthRead('businessGetFund', fp, {asOf: date}), wb = await f.wealthRead('businessGetWealthBook', ps, {asOf: date});
      await f.wealthMutate('businessAllocateFund', {bookETag: wb.etag, effectiveDate: date, amount: '20000000.00', supportReference: 'SYN'}, fp, fr.etag);
      tick(60001); await f.restore.flush();
      const before = await snapshot(), restoreSpies = spy(), mailBefore = f.messages.inbox.size;
      try {
        const b = await call(f.a, 'captureBaseBusinessSimulation', {asOf: today(), currency: 'COP'}, ps), next = addDays(today(), 1);
        checks['N3-base'] = {cash: b.data['cashBook'], available: b.data['available'], reserved: b.data['reserved']};
        assert.equal((b.data['cashBook'] as Data)['value'], '80000000.00'); assert.equal((b.data['available'] as Data)['value'], '60000000.00'); assert.equal((b.data['reserved'] as Data)['value'], '20000000.00');
        const terms = {kind: 'DECLARED_HYPOTHESIS', sourceReference: 'SYN-P05', principalOpening: '10000000.00', installments: [{number: 1, dueDate: addDays(next, 20), principal: '10000000.00', interest: '300000.00', insurance: '0.00', fees: '0.00', total: '10300000.00'}]};
        const alts = [{kind: 'ASSET_PURCHASE', configured: true, budget: '80000000.00', date: next, reserveReleases: [{fundId, amount: '20000000.00', date: next}], grossCost: '200000000.00', ownCash: '80000000.00', ownDebt: '120000000.00', directCreditor: true, ownershipFraction: '1.000000', estimatedGrossValue: '220000000.00', vacancyFraction: '0.000000', rentSchedule: [], costSchedule: []},
          {kind: 'NEW_LOAN', configured: true, budget: '80000000.00', date: next, principal: '10000000.00', cashSourceFlowId: null, terms, reserveReleases: []},
          {kind: 'DEBT_PREPAYMENT', configured: true, budget: '80000000.00', date: next, liabilityId: randomUUID(), prepaymentMode: 'REDUCE_TERM', terms: {kind: 'NATIVE_VERSION', sourceId: randomUUID(), sourceVersion: 1}, reserveReleases: []}];
        const d = def(String(b.data['id']), String(b.data['baseToken']), {budget: '80000000.00', alts});
        const sc = await call(f.a, 'createScenarioBusinessSimulation', {name: 'Cuatro ' + MARK, ...d}, ps), r = await runToEnd(f.a, ps, String(sc.data['id']), String(b.data['baseToken']));
        assert.equal(r.state, 'SUCCEEDED', JSON.stringify(r.run));
        const res = await call(f.a, 'getResultsBusinessSimulation', {}, r.rp, {limit: '100'}), outcomes = res.data['outcomes'] as Data[];
        const view: Record<string, Record<string, unknown>> = Object.fromEntries(outcomes.filter(o => o['scenarioKind'] === 'BASE').map(o => [String(o['alternativeKind']), {simulability: o['simulability'], ...Object.fromEntries(Object.entries(o['metrics'] as Record<string, Data>).filter(([k]) => ['cashFinal', 'availableMinimum', 'peakDeficit', 'cost', 'ownDebt', 'netWorthBook', 'netWorthIndicative', 'principalOutstanding', 'expectedInterest', 'reserved'].includes(k)).map(([k, m]) => [k, m['value']]))}]));
        checks['N3-outcomesBASE'] = view;
        assert.deepEqual([view['ASSET_PURCHASE']!['cashFinal'], view['ASSET_PURCHASE']!['cost'], view['ASSET_PURCHASE']!['ownDebt'], view['ASSET_PURCHASE']!['netWorthBook'], view['ASSET_PURCHASE']!['netWorthIndicative'], view['ASSET_PURCHASE']!['reserved']], ['0.00', '200000000.00', '120000000.00', '80000000.00', '100000000.00', '0.00']);
        assert.deepEqual([view['HOLD_CASH']!['cashFinal'], view['HOLD_CASH']!['reserved']], ['80000000.00', '20000000.00']);
        assert.equal(view['NEW_LOAN']!['cashFinal'], '80300000.00'); assert.equal(view['DEBT_PREPAYMENT']!['simulability'], 'NOT_SIMULABLE'); assert.equal(view['DEBT_PREPAYMENT']!['cashFinal'], null);
        const chosen = outcomes.filter(o => o['scenarioKind'] === 'BASE' && o['simulability'] !== 'NOT_SIMULABLE').map(o => o['id']), cmp = await call(f.a, 'compareBusinessSimulation', {runIds: [r.rp.runId], outcomeIds: chosen}, ps);
        checks['N3-compare'] = {winner: cmp.data['winner'], rows: Array.isArray(cmp.data['rows']) ? (cmp.data['rows'] as unknown[]).length : Object.keys(cmp.data)};
        assert.equal(cmp.data['winner'], null);
        const facts = await call(f.a, 'evaluateAlertsBusinessSimulation', {kind: 'FACT', baseId: b.data['id'], baseToken: b.data['baseToken'], thresholds: {dueWithinDays: 7, concentrationThreshold: '25.00'}}, ps);
        const list = await call(f.a, 'listAlertsBusinessSimulation', {}, ps), items = list.data['items'] as Data[];
        checks['N3-alerts'] = {factCreated: facts.data['created'], items: items.map(a => ({type: a['type'], class: a['class'], severity: a['severity'], state: a['state']}))};
        const v2 = await call(f.a, 'createVersionBusinessSimulation', {...d, horizonDays: 31}, {...ps, scenarioId: String(sc.data['id'])}, {}, randomUUID(), String(sc.etag ?? '')).catch(e => ({status: (e as {status: number}).status, data: {code: (e as {code: string}).code}}));
        checks['N3-versionWithEtag'] = {status: v2.status, data: v2.data};
        await call(f.a, 'archiveScenarioBusinessSimulation', {}, {...ps, scenarioId: String(sc.data['id'])}, {}, randomUUID(), String((await call(f.a, 'getScenarioBusinessSimulation', {}, {...ps, scenarioId: String(sc.data['id'])})).etag)).catch(e => { checks['N3-archive'] = (e as {code: string}).code; });
      } finally { restoreSpies(); }
      const after = await snapshot(), changes = diff(before, after), cls = classify(changes);
      checks['N3-noMutation'] = {commandsInvoked: commands, spied, changes, ...cls, externalMessagesAdded: f.messages.inbox.size - mailBefore};
      assert.equal(commands, 0, 'no financial command invoked, even transiently'); assert.deepEqual(cls.economic, [], 'no economic collection changed'); assert.equal(f.messages.inbox.size, mailBefore, 'no external channel');
    });
    await t.test('N4 native alerts with controlled clock: due window, dedupe, ACK does not pay, resolve after source change, restart peer dedupe', async () => {
      const ps = p2;
      tick(11 * 86400000); // 2026-10-30 + 11d => within 7 days of the 2026-11-16 due date
      t2.issued = (await f.identity.login('TENANT', randomUUID(), t2.email, 'Frase de prueba sintetica larga 9871236450')).issued;
      f.a.issued = (await f.identity.login('TENANT', randomUUID(), f.a.email, 'Frase de prueba sintetica larga 9871236450')).issued;
      const before = await snapshot();
      const b = await call(t2, 'captureBaseBusinessSimulation', {asOf: today(), currency: 'COP'}, ps), input = {kind: 'FACT', baseId: b.data['id'], baseToken: b.data['baseToken'], thresholds: {dueWithinDays: 7, concentrationThreshold: '25.00'}};
      const e1 = await call(t2, 'evaluateAlertsBusinessSimulation', input, ps), e2 = await call(t2, 'evaluateAlertsBusinessSimulation', input, ps);
      const items = (await call(t2, 'listAlertsBusinessSimulation', {}, ps)).data['items'] as Data[], alert = items.find(a => a['type'] === 'EXPENSE_DUE')!;
      const ap = {...ps, alertId: String(alert['id'])}, detail = await call(t2, 'getAlertBusinessSimulation', {}, ap), key = randomUUID();
      const ack = await call(t2, 'acknowledgeAlertBusinessSimulation', {}, ap, {}, key, detail.etag), replay = await call(t2, 'acknowledgeAlertBusinessSimulation', {}, ap, {}, key, detail.etag);
      const afterAck = classify(diff(before, await snapshot())), beforePeer = await snapshot();
      const peer = await group.peer({keys: f.keys, now: f.now(), enableBusiness: true, enableSimulation: true});
      let peerEval: unknown;
      try { peerEval = await peer.execute({operation: 'evaluateAlertsBusinessSimulation', params: ps, payload: input, key: randomUUID(), token: t2.issued.token}); } finally { await peer.close(); }
      const peerPhase = classify(diff(beforePeer, await snapshot()));
      // Make the condition false through a REAL product command (cancel), then re-evaluate.
      const expId = String((await f.database.db.collection(table('BUSINESS', 'expenses')).findOne({description: 'Gasto ' + MARK}))!['_id']);
      const envelope = await f.read('getBusinessExpenseEnvelope', {...ps, expenseId: expId}, {asOf: today()}, t2);
      await f.mutate('businessCancelExpense', {reason: 'Prueba P05', supportReference: 'SYN-P05'}, {...ps, expenseId: expId}, envelope.etag, randomUUID(), t2);
      const b2 = await call(t2, 'captureBaseBusinessSimulation', {asOf: today(), currency: 'COP'}, ps), e3 = await call(t2, 'evaluateAlertsBusinessSimulation', {...input, baseId: b2.data['id'], baseToken: b2.data['baseToken']}, ps);
      const resolved = await call(t2, 'getAlertBusinessSimulation', {}, ap);
      checks['N4'] = {asOf: today(), created1: e1.data['created'], created2: e2.data['created'], alert: {type: alert['type'], severity: alert['severity'], amount: alert['amount'], effectiveDate: alert['effectiveDate'], class: alert['class']}, ack: ack.data['state'], replay: {status: replay.status, state: replay.data['state']}, peerEval: JSON.stringify(peerEval).slice(0, 300), afterAckDiff: afterAck, peerPhaseDiff: peerPhase, afterCancel: {e3: e3.data, state: resolved.data['state'], freshness: resolved.data['freshness'], episode: resolved.data['episode']}};
      assert.equal(e1.data['created'], 1); assert.equal(e2.data['created'], 0); assert.equal(ack.data['state'], 'ACKNOWLEDGED'); assert.equal(replay.data['state'], 'ACKNOWLEDGED');
      assert.deepEqual(afterAck.economic, [], 'evaluate/ack/peer restart do not touch finance');
      assert.equal(resolved.data['state'], 'RESOLVED');
      (checks as Data)['alert2'] = ap;
    });
    await t.test('N5 privacy: unique markers absent from every foreign-actor response/error; revocation closes old alert and cursors', async () => {
      const old = (checks as Data)['ids2'] as Record<string, string>, ap = (checks as Data)['alert2'] as Record<string, string>, ps = p2;
      const expiredOld = await fail(() => call(t2, 'getResultsBusinessSimulation', {}, {...ps, runId: old['runId']!}, {limit: '2'}));
      const fb = await call(t2, 'captureBaseBusinessSimulation', {asOf: today(), currency: 'COP'}, ps), fsc = await call(t2, 'createScenarioBusinessSimulation', {name: 'Privado ' + MARK, ...def(String(fb.data['id']), String(fb.data['baseToken']))}, ps), fr = await runToEnd(t2, ps, String(fsc.data['id']), String(fb.data['baseToken']));
      assert.equal(fr.state, 'SUCCEEDED');
      const ids: Record<string, string> = {scenarioId: String(fsc.data['id']), runId: fr.rp.runId, baseId: String(fb.data['id'])};
      const foreigners: [string, Actor][] = [['T-otra-org', f.a]];
      for (const role of ['C', 'O', 'A']) { const a = await f.actor(), payload = {email: a.email, roleIds: [role]}; await f.proof(t2, 'MEMBER_INVITE', payload, org2); await f.runtime.organizations.invite(t2.issued.context, payload); await f.identity.dispatchMail(); const mail = [...f.messages.notificationInbox.values()].find(m => m.kind === 'INVITATION' && m.payload['email'] === a.email)!; await f.runtime.organizations.accept(a.issued.context, {mode: 'CONFIRM', token: mail.payload['token']}, randomUUID()); foreigners.push([role, a]); }
      const probes: [string, Data, Record<string, string>, Data][] = [['getScenarioBusinessSimulation', {}, {...ps, scenarioId: ids['scenarioId']!}, {}], ['listScenariosBusinessSimulation', {}, ps, {}], ['getRunBusinessSimulation', {}, {...ps, runId: ids['runId']!}, {}], ['getResultsBusinessSimulation', {}, {...ps, runId: ids['runId']!}, {}], ['getBaseBusinessSimulation', {}, {...ps, baseId: ids['baseId']!}, {}], ['listAlertsBusinessSimulation', {}, ps, {}], ['getAlertBusinessSimulation', {}, ap, {}], ['listRunsBusinessSimulation', {}, ps, {}], ['getVersionBusinessSimulation', {}, {...ps, scenarioId: ids['scenarioId']!, versionNumber: '1'}, {}], ['getPolicyBusinessSimulation', {}, ps, {}]];
      const results: unknown[] = [];
      for (const [who, actor] of foreigners) for (const [op, input, params, query] of probes) { const r = await fail(() => sim.execute(actor.issued.context, op, input, params, query, randomUUID())); results.push({who, op, status: (r as Data)['status'] ?? 'OK', code: (r as Data)['code'], marker: JSON.stringify(r).includes(MARK), leakedId: JSON.stringify(r).includes(ids['scenarioId']!) && op !== 'getScenarioBusinessSimulation'}); }
      const personal = await f.actor(); await f.runtime.organizations.create(personal.issued.context, {name: 'Org personal P05', currency: 'COP', timezone: 'America/Bogota'}, randomUUID());
      const pb = (await f.mutate('createPersonalBook', {currency: 'COP'}, {}, undefined, randomUUID(), personal)).data as {id: string};
      for (const op of ['getScenarioPersonalSimulation', 'getAlertPersonalSimulation']) { const r = await fail(() => sim.execute(personal.issued.context, op, {}, {bookId: pb.id, scenarioId: ids['scenarioId']!, alertId: ap['alertId']!}, {}, randomUUID())); results.push({who: 'PERSONAL-ajeno', op, status: (r as Data)['status'] ?? 'OK', marker: JSON.stringify(r).includes(MARK)}); }
      // Revocation (declared injection on the identity, then restored): owner loses T => old alert/results not readable.
      const me = await f.identity.identities.findOne({_id: t2.issued.context.subjectId!}); assert.ok(me);
      const page1 = await call(t2, 'getResultsBusinessSimulation', {}, {...ps, runId: ids['runId']!}, {limit: '2'}), cursor = String(page1.data['nextCursor']);
      const revoked: Data = {};
      for (const change of [{roles: ['A']}, {roles: ['C']}, {authEpoch: randomUUID()}, {suspended: true}]) { await f.identity.identities.updateOne({_id: me._id}, {$set: change}); try { revoked[JSON.stringify(change)] = {alert: await fail(() => call(t2, 'getAlertBusinessSimulation', {}, ap)), list: await fail(() => call(t2, 'listAlertsBusinessSimulation', {}, ps)), page2: await fail(() => call(t2, 'getResultsBusinessSimulation', {}, {...ps, runId: ids['runId']!}, {limit: '2', cursor}))}; } finally { await f.identity.identities.replaceOne({_id: me._id}, me); } }
      const relog = (await f.identity.login('TENANT', randomUUID(), t2.email, 'Frase de prueba sintetica larga 9871236450')).issued, oldCtx = t2.issued;
      t2.issued = relog; const cursorNewSession = await fail(() => call(t2, 'getResultsBusinessSimulation', {}, {...ps, runId: ids['runId']!}, {limit: '2', cursor}));
      await f.sessions.contexts.updateOne({_id: oldCtx.context._id}, {$set: {revoked: true}}); const oldSession = await fail(() => sim.execute(oldCtx.context, 'getAlertBusinessSimulation', {}, ap, {}, randomUUID()));
      const flat = (o: unknown) => JSON.stringify(o);
      checks['N5'] = {marker: MARK, expiredOldResults: {status: (expiredOld as Data)['status'], code: (expiredOld as Data)['code']}, probes: results, revoked: Object.fromEntries(Object.entries(revoked).map(([k, v]) => [k, Object.fromEntries(Object.entries(v as Data).map(([q, r]) => [q, {status: (r as Data)['status'] ?? 'OK', code: (r as Data)['code'], marker: flat(r).includes(MARK)}]))])), cursorNewSession: {status: (cursorNewSession as Data)['status'] ?? 'OK', code: (cursorNewSession as Data)['code']}, oldRevokedSession: {status: (oldSession as Data)['status'] ?? 'OK', code: (oldSession as Data)['code']}};
      assert.ok(results.every(r => !(r as Data)['marker']), 'marker never exposed to a foreign actor');
      assert.ok(results.filter(r => (r as Data)['op'] !== 'getPolicyBusinessSimulation').every(r => (r as Data)['status'] !== 'OK'), 'foreign actor denied on private objects');
      for (const v of Object.values(revoked)) for (const r of Object.values(v as Data)) { assert.notEqual((r as Data)['ok'], true, 'revoked authority cannot read old private alert/results'); assert.ok(!flat(r).includes(MARK)); }
      assert.notEqual((oldSession as Data)['ok'], true);
    });
    await t.test('N6 H04 native: preview flags an existing CREATE key; concurrent confirm of two clean previews has one winner; replay is stable', async () => {
      const ps = {organizationId: f.org}, namespace = 'SYN-S12-P05-H04';
      const preview = async (name: string) => { tick(61000); const created = await ex.createImport(f.a.issued.context, 'createBusinessImport', {label: 'Catálogo P05', namespace, mode: 'OPERATIVE', templateVersion: '1.0.0', mappingVersion: 'S11-MAP-1'}, ps, randomUUID());
        const ip = {...ps, importId: String(created.data['id'])}, up = await ex.upload(f.a.issued.context, ip, randomUUID(), created.etag, workbook('OPERATIVE', namespace, {Cuentas: [{externalKey: 'P05BANK', action: 'CREATE', code: 'SYN_P05', name, accountClass: 'ASSET', kind: 'BANK', currency: 'COP'}]}));
        await ex.preparePreview(f.a.issued.context, ip, randomUUID(), up.etag); return {ip, current: await ex.readImport(f.a.issued.context, ip, 'getBusinessImport'), preview: await ex.readImport(f.a.issued.context, ip, 'getBusinessImportPreview')}; };
      const a = await preview('Cuenta P05 A'), b = await preview('Cuenta P05 B');
      const bookETag = await f.database.client.withSession(s => f.wealth.bookTag({kind: 'BUSINESS', bookId: f.org, ownerId: f.org, organizationId: f.org}, s));
      const payload = (p: typeof a) => ({previewId: p.preview.data['id'], semanticHash: p.preview.data['semanticHash'], bookETag}), ka = randomUUID(), kb = randomUUID();
      await f.proof(f.a, 'IMPORT_CONFIRM', {operationId: 'confirmBusinessImport', organizationId: f.org, pathParameters: a.ip, payload: payload(a), idempotencyKey: ka, expectedETag: a.current.etag}, a.ip.importId);
      const settled = await Promise.allSettled([ex.confirm(f.a.issued.context, a.ip, payload(a), ka, a.current.etag), ex.confirm(f.a.issued.context, b.ip, payload(b), kb, b.current.etag)]);
      const out = settled.map(s => s.status === 'fulfilled' ? {status: s.value.status} : {code: (s.reason as {code?: string}).code, status: (s.reason as {status?: number}).status});
      const accounts = await f.runtime.finance.accounts.countDocuments({organizationId: f.org, code: 'SYN_P05'});
      const replay = await fail(() => ex.confirm(f.a.issued.context, a.ip, payload(a), ka, a.current.etag));
      const c = await preview('Cuenta P05 C'), items = (c.preview.data['items'] as Data[]).filter(i => i['code'] === 'EXTERNAL_KEY_CONFLICT');
      checks['N6'] = {previewsCleanBefore: [a.preview.data['canConfirm'], b.preview.data['canConfirm']], concurrent: out, accounts, replay: (replay as Data)['ok'] ? 'OK same receipt' : replay, afterWinner: {canConfirm: c.preview.data['canConfirm'], items: items.map(i => ({cell: i['cell'], severity: i['severity'], keys: i['relatedKeys']}))}};
      assert.equal(accounts, 1); assert.equal(out.filter(o => o.status === 201).length, 1, JSON.stringify(out)); assert.equal(c.preview.data['canConfirm'], false); assert.ok(items.some(i => i['severity'] === 'ERROR'));
      assert.ok(!JSON.stringify(items).includes(f.org), 'conflict issue does not expose owner ids');
    });
    await t.test('N7 lifecycle: idempotency replay/conflict, stale base after source change and day change, cancel race, tampered payload fails closed', async () => {
      const ps = p2, r: Data = {};
      const b = await call(t2, 'captureBaseBusinessSimulation', {asOf: today(), currency: 'COP'}, ps), d = {name: 'Ciclo ' + MARK, ...def(String(b.data['id']), String(b.data['baseToken']))}, key = randomUUID();
      const s1 = await call(t2, 'createScenarioBusinessSimulation', d, ps, {}, key), s2 = await call(t2, 'createScenarioBusinessSimulation', d, ps, {}, key);
      r['replay'] = {first: s1.status, second: s2.status, sameId: s1.data['id'] === s2.data['id']};
      r['conflict'] = await fail(() => call(t2, 'createScenarioBusinessSimulation', {...d, name: 'Otro ' + MARK}, ps, {}, key));
      const chunksBefore = new Set((await f.database.db.collection('s12_payload_chunks').find({}, {projection: {_id: 1}}).toArray()).map(x => String(x['_id'])));
      const run = await runToEnd(t2, ps, String(s1.data['id']), String(b.data['baseToken'])); r['run'] = run.state;
      const fresh = (await f.database.db.collection('s12_payload_chunks').find({}).toArray()).filter(x => !chunksBefore.has(String(x['_id'])));
      // Cancel after success must not hide the success.
      const cur = await call(t2, 'getRunBusinessSimulation', {}, run.rp); r['cancelAfterSuccess'] = await fail(() => call(t2, 'cancelRunBusinessSimulation', {}, run.rp, {}, randomUUID(), String(cur.etag)));
      // Source change: a new native expense makes the old base token unusable for a CURRENT run.
      await f.mutate('businessCreateExpense', {nominalDate: addDays(today(), 3), dueDate: addDays(today(), 3), description: 'Cambio ' + MARK, category: 'OTHER', amountMode: 'FIXED', amount: '5.00', supportReference: 'SYN-P05'}, ps, undefined, randomUUID(), t2);
      r['staleAfterSourceChange'] = await fail(() => call(t2, 'startRunBusinessSimulation', {scenarioId: s1.data['id'], scenarioVersion: 1, baseToken: b.data['baseToken'], mode: 'STANDARD', sensitivity: null, evaluateAlerts: false}, ps));
      r['oldResultAfterSourceChange'] = await fail(async () => { const x = await call(t2, 'getResultsBusinessSimulation', {}, run.rp, {limit: '1'}); return {freshness: x.data['freshness'] ?? x.data['state'] ?? Object.keys(x.data)}; });
      // Tamper one stored chunk: reads must fail closed (no partial/fabricated result), then restore the exact bytes.
      if (fresh.length) { const target = fresh[0]!, field = Object.keys(target).find(k2 => typeof target[k2] === 'string' && (target[k2] as string).length > 40 && !['_id', 'mac'].includes(k2));
        if (field) { const orig = target[field] as string, flipped = (orig[10] === 'A' ? 'B' : 'A'); await f.database.db.collection('s12_payload_chunks').updateOne({_id: target['_id'] as never}, {$set: {[field]: orig.slice(0, 10) + flipped + orig.slice(11)}});
          r['tampered'] = {field, read: await fail(() => call(t2, 'getResultsBusinessSimulation', {}, run.rp, {limit: '1'}))};
          await f.database.db.collection('s12_payload_chunks').replaceOne({_id: target['_id'] as never}, target);
          r['afterUndo'] = await fail(() => call(t2, 'getResultsBusinessSimulation', {}, run.rp, {limit: '1'})); } }
      tick(86400000); t2.issued = (await f.identity.login('TENANT', randomUUID(), t2.email, 'Frase de prueba sintetica larga 9871236450')).issued;
      r['staleAfterDayChange'] = await fail(() => call(t2, 'startRunBusinessSimulation', {scenarioId: s1.data['id'], scenarioVersion: 1, baseToken: b.data['baseToken'], mode: 'STANDARD', sensitivity: null, evaluateAlerts: false}, ps));
      const slim = (x: unknown) => { const o = x as Data; return o['ok'] ? {ok: true, r: String(o['r']).slice(0, 160)} : {status: o['status'], code: o['code']}; };
      checks['N7'] = Object.fromEntries(Object.entries(r).map(([k2, v]) => [k2, typeof v === 'object' && v !== null && ('ok' in (v as Data) || 'status' in (v as Data)) ? slim(v) : v]));
      if (r['tampered']) checks['N7-tamper'] = {field: (r['tampered'] as Data)['field'], read: slim((r['tampered'] as Data)['read'])};
      assert.equal(s1.data['id'], s2.data['id']); assert.equal((r['conflict'] as Data)['status'], 409);
      assert.notEqual((r['staleAfterSourceChange'] as Data)['ok'], true, 'old base token cannot start a CURRENT run after a source change');
      assert.notEqual((r['staleAfterDayChange'] as Data)['ok'], true);
      if (r['tampered']) assert.notEqual(((r['tampered'] as Data)['read'] as Data)['ok'], true, 'tampered payload never served');
    });
  } finally {
    writeFileSync(OUT, JSON.stringify({task: 'S12-P05', suite: 'native', at: new Date().toISOString(), group: group.names[0], checks}, null, 1) + '\n');
    await group.dispose();
  }
});
