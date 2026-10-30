/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection -- Exact registered owned group marker path and own fixed collection-name digest keys of this review. */
// S10-P05 reviewer world (Claude). `world` is a mechanical copy of tests/s10-p04/fixture.ts (author, frozen) bound to the own profile;
// extras only READ raw Mongo rows (oracle dataset, digests, counts) or drive real product commands. Expected values never come from
// these helpers: they come from oracle.ts and from amounts commanded in the tests.
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BSON } from 'mongodb';
import { ProjectionRuntime } from '../../src/modules/reporting/projection/service.js';
import { wealthContract } from '../../src/modules/wealth/contract.js';
import { managementContract } from '../../src/modules/obligations/contract.js';
import { today } from '../../src/modules/obligations/calendar.js';
export const evidence = (name, d) => console.log(JSON.stringify({ evidence: name, ...d }));
export async function world(group, clockValue = Date.parse('2026-10-28T12:00:00-05:00')) {
    const f = await group.fixture();
    f.clock.value = clockValue;
    const a = await f.actor();
    const org = (await f.runtime.organizations.create(a.issued.context, { name: 'Organización sintética S10 revisión', currency: 'COP', timezone: 'America/Bogota' }, randomUUID())).data.organization.id;
    const account = async (code, accountClass = 'ASSET', kind = 'GENERAL') => { const payload = { code, name: 'Cuenta sintética ' + code, currency: 'COP', accountClass, kind }; return (await f.runtime.finance.mutate(a.issued.context, 'createAccount', org, payload, randomUUID())).data; };
    const bank = await account('BANK_R10', 'ASSET', 'BANK'), equity = await account('EQUITY_R10', 'EQUITY');
    const capital = { currency: 'COP', effectiveDate: today(f.now()), sourceId: randomUUID(), supportReference: 'SYN-R10-CAPITAL', description: 'Capital sintético revisión', lines: [{ accountId: bank.id, debit: '20000000.00', credit: '0.00' }, { accountId: equity.id, debit: '0.00', credit: '20000000.00' }] }, key = randomUUID();
    await f.proof(a, 'FINANCE_JOURNAL_POST', { organizationId: org, idempotencyKey: key, payload: capital });
    await f.runtime.finance.mutate(a.issued.context, 'postJournal', org, capital, key);
    await f.restore.flush();
    const owner = async () => { const o = JSON.parse(await readFile(join(group.folder, 'owner.json'), 'utf8')); return o.pid === process.pid && o.runId === group.runId && o.names[0] === f.database.db.databaseName; };
    const service = f.runtime.obligations;
    await service.prepareOwned(owner);
    await f.runtime.wealth.prepareOwned(owner);
    const projection = await ProjectionRuntime.createOwned(f.identity, f.keys.cursor, owner);
    f.identity.reporting.projection = projection;
    await service.activateOwned(owner);
    const mutate = async (operation, payload, params = {}, expected, key = randomUUID(), actor = a, proof = true) => {
        const p = managementContract().operations.get(operation).definition['x-purpose'], command = { operationId: operation, idempotencyKey: key, ...(params['organizationId'] ? { organizationId: params['organizationId'] } : {}), ...(params['bookId'] ? { bookId: params['bookId'] } : {}), pathParameters: params, payload, ...(expected ? { expectedETag: expected } : {}) };
        if (proof)
            await f.proof(actor, p, command, params['expenseId'] ?? params['ruleId'] ?? params['liabilityId'] ?? params['relationshipId']);
        return await service.mutate(actor.issued.context, operation, payload, params, key, expected);
    };
    const book = (await mutate('createPersonalBook', { currency: 'COP' })).data;
    const personal = async (label, accountClass = 'ASSET', kind = 'GENERAL') => (await mutate('createPersonalAccount', { code: label, name: 'Personal sintética ' + label, currency: 'COP', accountClass, kind }, { bookId: book.id })).data;
    const read = async (operation, params = {}, query = { asOf: today(f.now()) }, actor = a) => await service.read(actor.issued.context, operation, params, query);
    const wealth = f.runtime.wealth;
    const wealthMutate = async (operation, payload, params, expected, key = randomUUID(), actor = a, proof = true) => {
        const purpose = wealthContract().operations.get(operation).definition['x-purpose'], command = { operationId: operation, idempotencyKey: key, ...(params['organizationId'] ? { organizationId: params['organizationId'] } : {}), ...(params['bookId'] ? { bookId: params['bookId'] } : {}), pathParameters: params, payload, ...(expected ? { expectedETag: expected } : {}) };
        if (proof)
            await f.proof(actor, purpose, command, params['assetId'] ?? params['fundId']);
        return await wealth.mutate(actor.issued.context, operation, payload, params, key, expected);
    };
    const wealthRead = async (operation, params = {}, query = { asOf: today(f.now()) }, actor = a) => await wealth.read(actor.issued.context, operation, params, query);
    // ---- reviewer extras
    const settle = async (fn) => { try {
        const r = await fn();
        return { status: r.status, data: r.data, etag: r.etag, meta: r.meta };
    }
    catch (e) {
        return { status: Number(e.status ?? 500), code: String(e.code ?? e.message) };
    } };
    const st = (r) => `${r.status}${r.code ? ' ' + r.code : ''}`;
    const member = async (roles) => {
        const c = await f.actor(), invitation = { email: c.email, roleIds: roles };
        await f.proof(a, 'MEMBER_INVITE', invitation, org);
        await f.runtime.organizations.invite(a.issued.context, invitation);
        await f.identity.dispatchMail();
        const mail = [...f.messages.notificationInbox.values()].find(m => m.kind === 'INVITATION' && m.payload['email'] === c.email);
        if (!mail)
            throw Error('Missing own invitation');
        await f.runtime.organizations.accept(c.issued.context, { mode: 'CONFIRM', token: mail.payload['token'] }, randomUUID());
        await f.restore.flush();
        return c;
    };
    const rows = async (name, filter = {}) => await f.database.db.collection(name).find(filter).sort({ _id: 1 }).toArray();
    const dump = async () => ({ personalAccounts: await rows('s09_personal_accounts'), personalJournals: await rows('s09_personal_journals'), businessAccounts: await rows('financial_accounts', { organizationId: org }), businessJournals: await rows('financial_journals', { organizationId: org }) });
    const digestAll = async (skip = []) => {
        const out = {};
        for (const name of group.names) {
            const d = f.database.client.db(name);
            for (const c of (await d.listCollections({}, { nameOnly: true }).toArray()).map(x => x.name).sort()) {
                if (skip.includes(c))
                    continue;
                out[(name.endsWith('_mail') ? 'mail.' : name.endsWith('_security') ? 'security.' : '') + c] = createHash('sha256').update(BSON.EJSON.stringify(await d.collection(c).find({}).sort({ _id: 1 }).toArray(), { relaxed: false })).digest('hex');
            }
        }
        return out;
    };
    const diff = (x, y) => [...new Set([...Object.keys(x), ...Object.keys(y)])].filter(k => x[k] !== y[k]).sort();
    const n = async (c, q = {}) => await f.database.db.collection(c).countDocuments(q);
    const counts = async () => ({ personalJournals: await n('s09_personal_journals'), businessJournals: await n('financial_journals', { organizationId: org }), fundEvents: await n('s10_fund_events_personal') + await n('s10_fund_events_business'), assetEvents: await n('s10_asset_events_personal') + await n('s10_asset_events_business'), claims: await n('s10_source_claims_personal') + await n('s10_source_claims_business'), liabilities: await n('s09_liabilities_personal') + await n('s09_liabilities_business'), commands: await n('s09_commands') });
    return { ...f, owner, a, org, bank, equity, account, personal, book, service, projection, mutate, read, group, wealth, wealthMutate, wealthRead, settle, st, member, rows, dump, digestAll, diff, counts };
}
export const info = (r) => r.data;
export const idOf = (r) => String(info(r)['id'] ?? info(r)['resourceId']);
export const rate = { kind: 'NONE_DECLARED', source: 'SYNTHETIC_DECLARED', sourceReference: 'SYN-ZERO-DECLARED', validFrom: '2026-10-01', observedOn: '2026-10-01', unit: 'ANNUAL_FRACTION', convention: 'ANNUAL_SIMPLE_ACT_365', decimalValue: '0.00', combine: 'NONE' };
/** Single-installment official declared schedule (principal only), totals built here. */
export const official = (principal, due = '2026-10-28') => ({ kind: 'OFFICIAL_DECLARED', validFrom: '2026-10-28', referenceDate: '2026-09-28', sourceReference: 'SYN-R10-OFFICIAL', principalOpening: principal, rateVersionIds: [], installments: [{ number: 1, dueDate: due, principal, interest: '0.00', insurance: '0.00', fees: '0.00', total: principal }] });
//# sourceMappingURL=review-fixtures.js.map