// S13-P05 (Claude): own group for fail-closed probes that latch the process (kept apart so they do not mask other suites).
// 1) First export on a scope with an orphan management row (no native book) must fail closed and never repair/create the header.
// 2) Observe the blast radius of that latch on an unrelated tenant in the same process (availability, not a privacy leak).
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {s13Profile, world} from './profile.js';
import {booksTable} from '../../src/modules/obligations/models.js';
import {originals as managementOriginals} from '../../src/modules/obligations/catalog.js';
import {today} from '../../src/modules/obligations/calendar.js';
import type {Data} from '../../src/modules/simulation/models.js';

const checks: Record<string, unknown> = {};
const fail = async (fn: () => Promise<unknown>) => { try { const r = await fn() as {status?: number}; return {ok: true, status: r?.status}; } catch (e) { return {ok: false, status: (e as {status?: number}).status, code: (e as {code?: string}).code}; } };

test('S13-P05 orphan scope: first export fails closed without repairing; latch blast radius observed', {timeout: 300000}, async () => {
  const group = await s13Profile();
  try {
    const f = await world(group), ex = f.identity.exchange!, sim = f.runtime.simulation, date = today(f.now());
    // Unrelated tenant works before the probe.
    const before = await fail(() => sim.execute(f.a.issued.context, 'captureBaseBusinessSimulation', {asOf: date, currency: 'COP'}, {organizationId: f.org}, {}, randomUUID()));
    const o = await f.actor(), org = (await f.runtime.organizations.create(o.issued.context, {name: 'Org huerfana P05', currency: 'COP', timezone: 'America/Bogota'}, randomUUID())).data.organization.id, ps = {organizationId: org};
    const tok = ((await ex.report(o.issued.context, {...ps, reportKind: 'PORTFOLIO'}, {asOf: date, from: date, to: date})).data['meta'] as Data)['snapshotToken'];
    const collection = [...managementOriginals][0]!;
    await f.database.db.collection(collection).insertOne({_id: 'p05-orphan-' + randomUUID(), bookId: org} as never);
    const orphan = await fail(() => ex.createExport(o.issued.context, ps, {reportKind: 'PORTFOLIO', snapshotToken: tok, format: 'CSV'}, randomUUID()));
    const books = await f.database.db.collection(booksTable).countDocuments({_id: org as never}), exports = await f.database.db.collection('s11_exports').countDocuments();
    f.clock.value += 7000;
    const otherTenantAfter = await fail(() => sim.execute(f.a.issued.context, 'captureBaseBusinessSimulation', {asOf: date, currency: 'COP'}, {organizationId: f.org}, {}, randomUUID()));
    const otherReportAfter = await fail(() => ex.report(f.a.issued.context, {organizationId: f.org, reportKind: 'PORTFOLIO'}, {asOf: date, from: date, to: date}));
    checks['orphan'] = {collection, export: orphan, booksCreated: books, exportsCreated: exports};
    checks['latchBlastRadius'] = {otherTenantSimulationBefore: before, otherTenantSimulationAfter: otherTenantAfter, otherTenantReportAfter: otherReportAfter};
    assert.equal(orphan.ok, false); assert.equal(books, 0, 'orphaned scope never repaired'); assert.equal(exports, 0);
  } finally {
    writeFileSync('../../Construccion/Sprints/S13/Evidencias/S13-P05-CHECKS-ORPHAN.json', JSON.stringify({task: 'S13-P05', suite: 'orphan', at: new Date().toISOString(), group: group.names[0], checks}, null, 1) + '\n');
    await group.dispose();
  }
});
