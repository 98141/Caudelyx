/* eslint-disable security/detect-object-injection, security/detect-non-literal-fs-filename -- Own fixed collection/actor maps and own registered control path of this review, never request input. */
// S08-P05 reviewer world (Claude). Drives the REAL candidate through the author fixture mechanics (tests/s07/fixture.ts cashSetup,
// TOTP actors, proofs per W class) in the reviewer's own group. Reporting results are compared with the own raw-data oracle
// (indicators.ts) and with amounts commanded here; this module only READS Mongo rows (raw dataset, digests).
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BSON, type Document } from 'mongodb';
import { generate } from 'otplib';
import { world as s7world } from '../s07-p05/review-fixtures.js';
import { password, type s08ReviewProfile } from './review-profile.js';
import { ProjectionRuntime } from '../../../src/modules/reporting/projection/service.js';
import type { Dataset } from './indicators.js';

export type Group = Awaited<ReturnType<typeof s08ReviewProfile>>;
export type Reply = { status: number; code?: string; data?: Record<string, unknown> };
export const evidence = (name: string, d: Record<string, unknown>) => console.log(JSON.stringify({ evidence: name, ...d }));
export const PROJECTION = ['reporting_projection_heads', 'reporting_projection_units', 'reporting_projection_flows', 'reporting_projection_rows', 'reporting_projection_nodes', 'reporting_projection_manifests', 'reporting_projection_barriers'];

export async function world8(group: Group, opts: { approve?: boolean } = {}) {
  const w = await s7world(group as never, opts.approve ?? true), f = w.f, org = w.org, db = w.db;
  type Actor = typeof f.a;
  const bank = (await f.accountS06('BANK_P05', 'ASSET', 'BANK')).id;
  /** Fresh password+TOTP login with the reviewer profile password (used after clock jumps). */
  const relogin = async (a: Actor) => {
    const first = await f.identity.login('TENANT', randomUUID(), (a as unknown as { email: string }).email, password); a.issued = first.issued;
    if (first.issued.context.kind !== 'W') { f.clock.value += 30000; a.issued = (await f.runtime.totp.authenticate(first.issued.context, await generate({ secret: a.secret, epoch: Math.floor(f.now() / 1000) }), 'LOGIN', null)).issued; }
    return a;
  };
  const actors: Actor[] = [f.a, f.c, f.o];
  const at = async (iso: string) => { f.clock.value = Date.parse(iso); for (const a of actors) await relogin(a); };
  const member = async (roles: string[]) => {
    const actor = await f.newActor(), payload = { email: actor.email, roleIds: roles }; await f.proof(f.a, 'MEMBER_INVITE', payload, f.org); await f.runtime.organizations.invite(f.a.issued.context, payload); await f.identity.dispatchMail();
    const mail = [...f.messages.notificationInbox.values()].find(x => x.kind === 'INVITATION' && x.payload['email'] === actor.email); if (!mail) throw Error('Missing own invitation');
    await f.runtime.organizations.accept(actor.issued.context, { mode: 'CONFIRM', token: mail.payload['token'] }, randomUUID()); actors.push(actor as Actor); return actor as Actor;
  };
  const rep = async (actor: Actor, op: 'getReportingPolicy' | 'getReportingDashboard' | 'listReportingRows' | 'getReportingLoan', id?: string, query: Record<string, unknown> = {}, orgId = org): Promise<Reply> =>
    await w.settle(() => f.identity.reporting!.read(actor.issued.context, op, orgId, id, query) as never);
  /** Payment REGISTER by T (DIRECT, BANK) with explicit target modes; returns {status,paymentId,eventId}. */
  const bankReceipt = async (loan: { id: string; borrowerId: string }, amount: string, mode: 'REGULAR' | 'EXTRA_PRINCIPAL' = 'REGULAR') => {
    const intent = await f.intent(loan as never, bank, amount, f.a, 'BANK'); intent.targets = intent.targets.map(t => ({ ...t, mode }));
    const p = await w.prepared(() => f.preparePayment({ kind: 'REGISTER', mode: 'DIRECT', effectiveDate: w.today(), intent })); if (p.failed) return { ...p.failed, paymentId: undefined, eventId: undefined };
    const r = await w.settle(p.p!.execute), paymentId = r.data?.['entityId'] as string | undefined; const pay = paymentId ? await db.collection('payments').findOne({ _id: paymentId as never }) : null;
    return { ...r, paymentId, eventId: pay?.['eventId'] as string | undefined };
  };
  const accrue = async (loanId: string, throughDate: string) => {
    const position = await f.position(loanId);
    const p = await w.prepared(() => f.make({ kind: 'ACCRUE', loanId, positionETag: position.etag!, throughDate, effectiveDate: w.today(), supportReference: 'SYN-P05-ACCRUE' } as never)); if (p.failed) return p.failed;
    return await w.settle(p.p!.execute);
  };
  const reverse = async (eventId: string, paymentId: string | null) => { const p = await w.prepared(() => f.reverse(eventId, paymentId)); if (p.failed) return p.failed; return await w.settle(p.p!.execute); };
  const newLoan = async () => { const l = await f.loan({ principal: '2000000.00' }); await f.disburse(l); return l; };
  const rows = async (name: string, filter: Document = { organizationId: org }) => await db.collection<Document & { _id: string }>(name).find(filter).sort({ _id: 1 }).toArray() as never;
  const dump = async (): Promise<Dataset> => ({
    loans: await rows('lending_loans'), borrowers: await rows('lending_borrowers'), installments: await rows('loan_installments'), schedules: await rows('loan_schedule_versions'), events: await rows('loan_events'),
    compensations: await rows('loan_compensations'), payments: await rows('payments'), journals: await rows('financial_journals'), accounts: await rows('financial_accounts'),
    profile: await db.collection<Document & { _id: string }>('loan_operation_books').findOne({ _id: org as never }) as never, custody: await rows('cash_custody'), held: await rows('held_funds_reservations'),
    deliveries: await rows('cash_deliveries'), scopes: await rows('payment_registration_scopes'), openings: await rows('opening_files'),
  });
  /** sha256 of every collection of the 3 own databases (canonical EJSON, sorted by _id); projection store reported separately. */
  const digestAll = async () => {
    const out: Record<string, string> = {}, projection: Record<string, number> = {};
    for (const name of group.names) {
      const d = f.database.client.db(name);
      for (const c of (await d.listCollections({}, { nameOnly: true }).toArray()).map(x => x.name).sort()) {
        const docs = await d.collection(c).find({}).sort({ _id: 1 }).toArray();
        if (PROJECTION.includes(c)) { projection[c] = docs.length; continue; }
        out[name.endsWith('_mail') ? 'mail.' + c : name.endsWith('_security') ? 'security.' + c : c] = createHash('sha256').update(BSON.EJSON.stringify(docs, { relaxed: false })).digest('hex');
      }
    }
    return { collections: out, projection };
  };
  const diff = (a: Record<string, string>, b: Record<string, string>) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k]).sort();
  /** Approved projection 0.1, only in this own synthetic group (same guard as the author harness, not edited). */
  const activate = async () => {
    const runtime = await ProjectionRuntime.createOwned(f.identity, f.keys.cursor, async () => {
      const owner = JSON.parse(await readFile(join(group.folder, 'owner.json'), 'utf8')) as { pid: number; runId: string; names: string[] };
      return owner.pid === process.pid && owner.runId === group.runId && owner.names[0] === f.database.db.databaseName;
    }); f.identity.reporting!.projection = runtime; return runtime;
  };
  const deactivate = async (runtime: ProjectionRuntime) => { await runtime.stop(); delete f.identity.reporting!.projection; };
  return { ...w, w, bank, relogin, at, member, actors, rep, bankReceipt, accrue, reverse, newLoan, dump, digestAll, diff, activate, deactivate };
}
export type World8 = Awaited<ReturnType<typeof world8>>;
/** Indicator list of a dashboard reply as {id: value/status}. */
export const metricsOf = (r: Reply, list = 'organizationMetrics') => Object.fromEntries(((r.data?.[list] ?? []) as Record<string, unknown>[]).map(m => [m['id'], m]));
export const values = (r: Reply, list = 'organizationMetrics') => Object.fromEntries(Object.entries(metricsOf(r, list)).map(([k, m]) => [k, (m as Record<string, unknown>)['value'] as string | null]));
