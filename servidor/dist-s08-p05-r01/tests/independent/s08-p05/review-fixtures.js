/* eslint-disable security/detect-object-injection, security/detect-non-literal-fs-filename -- Own fixed collection/actor maps and own registered control path of this review, never request input. */
// S08-P05 reviewer world (Claude). Drives the REAL candidate through the author fixture mechanics (tests/s07/fixture.ts cashSetup,
// TOTP actors, proofs per W class) in the reviewer's own group. Reporting results are compared with the own raw-data oracle
// (indicators.ts) and with amounts commanded here; this module only READS Mongo rows (raw dataset, digests).
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BSON } from 'mongodb';
import { generate } from 'otplib';
import { world as s7world } from '../s07-p05/review-fixtures.js';
import { password } from './review-profile.js';
import { ProjectionRuntime } from '../../../src/modules/reporting/projection/service.js';
export const evidence = (name, d) => console.log(JSON.stringify({ evidence: name, ...d }));
export const PROJECTION = ['reporting_projection_heads', 'reporting_projection_units', 'reporting_projection_flows', 'reporting_projection_rows', 'reporting_projection_nodes', 'reporting_projection_manifests', 'reporting_projection_barriers'];
export async function world8(group, opts = {}) {
    const w = await s7world(group, opts.approve ?? true), f = w.f, org = w.org, db = w.db;
    const bank = (await f.accountS06('BANK_P05', 'ASSET', 'BANK')).id;
    /** Fresh password+TOTP login with the reviewer profile password (used after clock jumps). */
    const relogin = async (a) => {
        const first = await f.identity.login('TENANT', randomUUID(), a.email, password);
        a.issued = first.issued;
        if (first.issued.context.kind !== 'W') {
            f.clock.value += 30000;
            a.issued = (await f.runtime.totp.authenticate(first.issued.context, await generate({ secret: a.secret, epoch: Math.floor(f.now() / 1000) }), 'LOGIN', null)).issued;
        }
        return a;
    };
    const actors = [f.a, f.c, f.o];
    const at = async (iso) => { f.clock.value = Date.parse(iso); for (const a of actors)
        await relogin(a); };
    const member = async (roles) => {
        const actor = await f.newActor(), payload = { email: actor.email, roleIds: roles };
        await f.proof(f.a, 'MEMBER_INVITE', payload, f.org);
        await f.runtime.organizations.invite(f.a.issued.context, payload);
        await f.identity.dispatchMail();
        const mail = [...f.messages.notificationInbox.values()].find(x => x.kind === 'INVITATION' && x.payload['email'] === actor.email);
        if (!mail)
            throw Error('Missing own invitation');
        await f.runtime.organizations.accept(actor.issued.context, { mode: 'CONFIRM', token: mail.payload['token'] }, randomUUID());
        actors.push(actor);
        return actor;
    };
    const rep = async (actor, op, id, query = {}, orgId = org) => await w.settle(() => f.identity.reporting.read(actor.issued.context, op, orgId, id, query));
    /** Payment REGISTER by T (DIRECT, BANK) with explicit target modes; returns {status,paymentId,eventId}. */
    const bankReceipt = async (loan, amount, mode = 'REGULAR') => {
        const intent = await f.intent(loan, bank, amount, f.a, 'BANK');
        intent.targets = intent.targets.map(t => ({ ...t, mode }));
        const p = await w.prepared(() => f.preparePayment({ kind: 'REGISTER', mode: 'DIRECT', effectiveDate: w.today(), intent }));
        if (p.failed)
            return { ...p.failed, paymentId: undefined, eventId: undefined };
        const r = await w.settle(p.p.execute), paymentId = r.data?.['entityId'];
        const pay = paymentId ? await db.collection('payments').findOne({ _id: paymentId }) : null;
        return { ...r, paymentId, eventId: pay?.['eventId'] };
    };
    const accrue = async (loanId, throughDate) => {
        const position = await f.position(loanId);
        const p = await w.prepared(() => f.make({ kind: 'ACCRUE', loanId, positionETag: position.etag, throughDate, effectiveDate: w.today(), supportReference: 'SYN-P05-ACCRUE' }));
        if (p.failed)
            return p.failed;
        return await w.settle(p.p.execute);
    };
    const reverse = async (eventId, paymentId) => { const p = await w.prepared(() => f.reverse(eventId, paymentId)); if (p.failed)
        return p.failed; return await w.settle(p.p.execute); };
    const newLoan = async () => { const l = await f.loan({ principal: '2000000.00' }); await f.disburse(l); return l; };
    const rows = async (name, filter = { organizationId: org }) => await db.collection(name).find(filter).sort({ _id: 1 }).toArray();
    const dump = async () => ({
        loans: await rows('lending_loans'), borrowers: await rows('lending_borrowers'), installments: await rows('loan_installments'), schedules: await rows('loan_schedule_versions'), events: await rows('loan_events'),
        compensations: await rows('loan_compensations'), payments: await rows('payments'), journals: await rows('financial_journals'), accounts: await rows('financial_accounts'),
        profile: await db.collection('loan_operation_books').findOne({ _id: org }), custody: await rows('cash_custody'), held: await rows('held_funds_reservations'),
        deliveries: await rows('cash_deliveries'), scopes: await rows('payment_registration_scopes'), openings: await rows('opening_files'),
    });
    /** sha256 of every collection of the 3 own databases (canonical EJSON, sorted by _id); projection store reported separately. */
    const digestAll = async () => {
        const out = {}, projection = {};
        for (const name of group.names) {
            const d = f.database.client.db(name);
            for (const c of (await d.listCollections({}, { nameOnly: true }).toArray()).map(x => x.name).sort()) {
                const docs = await d.collection(c).find({}).sort({ _id: 1 }).toArray();
                if (PROJECTION.includes(c)) {
                    projection[c] = docs.length;
                    continue;
                }
                out[name.endsWith('_mail') ? 'mail.' + c : name.endsWith('_security') ? 'security.' + c : c] = createHash('sha256').update(BSON.EJSON.stringify(docs, { relaxed: false })).digest('hex');
            }
        }
        return { collections: out, projection };
    };
    const diff = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k]).sort();
    /** Approved projection 0.1, only in this own synthetic group (same guard as the author harness, not edited). */
    const activate = async () => {
        const runtime = await ProjectionRuntime.createOwned(f.identity, f.keys.cursor, async () => {
            const owner = JSON.parse(await readFile(join(group.folder, 'owner.json'), 'utf8'));
            return owner.pid === process.pid && owner.runId === group.runId && owner.names[0] === f.database.db.databaseName;
        });
        f.identity.reporting.projection = runtime;
        return runtime;
    };
    const deactivate = async (runtime) => { await runtime.stop(); delete f.identity.reporting.projection; };
    return { ...w, w, bank, relogin, at, member, actors, rep, bankReceipt, accrue, reverse, newLoan, dump, digestAll, diff, activate, deactivate };
}
/** Indicator list of a dashboard reply as {id: value/status}. */
export const metricsOf = (r, list = 'organizationMetrics') => Object.fromEntries((r.data?.[list] ?? []).map(m => [m['id'], m]));
export const values = (r, list = 'organizationMetrics') => Object.fromEntries(Object.entries(metricsOf(r, list)).map(([k, m]) => [k, m['value']]));
//# sourceMappingURL=review-fixtures.js.map