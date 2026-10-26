import { randomUUID } from 'node:crypto';
import { generate } from 'otplib';
import { purposes } from '../../src/modules/lending/contract.js';
export const view = (r) => r.data;
export async function setup(group) {
    const f = await group.fixture(), a = await f.actor();
    const tenant = async (actor) => {
        const payload = { name: 'Organización sintética S04', currency: 'COP', timezone: 'America/Bogota' };
        await f.proof(actor, 'ORGANIZATION_CREATE', payload);
        const org = (await f.runtime.organizations.create(actor.issued.context, payload, randomUUID())).data.organization.id;
        const accountPayload = { code: 'CASH_S04', name: 'Caja sintética S04', currency: 'COP', accountClass: 'ASSET', kind: 'CASH' }, key = randomUUID();
        await f.proof(actor, 'FINANCE_ACCOUNT_CREATE', { organizationId: org, idempotencyKey: key, payload: accountPayload });
        const account = (await f.runtime.finance.mutate(actor.issued.context, 'createAccount', org, accountPayload, key)).data;
        return { actor, org, account: account.id };
    };
    const own = await tenant(a);
    const mutate = async (operation, payload, options = {}) => {
        const actor = options.actor ?? a, org = options.org ?? own.org, key = options.key ?? randomUUID(), command = { organizationId: org, idempotencyKey: key, payload, ...(options.etag ? { expectedETag: options.etag } : {}) };
        const purpose = purposes.get(operation);
        if (purpose && !options.noProof)
            await f.proof(actor, purpose, command, options.id);
        return await f.runtime.lending.mutate(actor.issued.context, operation, org, payload, key, options.id, options.etag);
    };
    const borrower = async (code = 'SYN_' + randomUUID().slice(0, 8).toUpperCase(), profile = { displayName: 'Persona sintética', schemaVersion: 1, extras: {} }) => await mutate('createBorrower', { borrowerCode: code, profile });
    const terms = (borrowerId, delta = {}) => ({ borrowerId, plannedFundingAccountId: own.account, principal: '1000.00', effectiveDate: '2024-01-31', firstDueDate: '2024-02-29', installmentCount: 3, method: 'LEVEL_PAYMENT', frequency: 'MONTH', rate: { type: 'EFFECTIVE', unit: 'MONTH', value: '0.010000000000' }, calendarConvention: 'PERIODIC_FIXED', holidayAdjustment: 'NO_SHIFT', policyVersion: 'S04-LOCAL-CO-0.1', jurisdiction: 'CO', usage: 'LOCAL_SYNTHETIC', ...delta });
    const quote = async (borrowerId, delta = {}) => await mutate('createLoanQuote', { terms: terms(borrowerId, delta) });
    const login = async (actor) => {
        const first = await f.identity.login('TENANT', randomUUID(), actor.email, 'Frase de prueba sintetica larga 9871236450');
        f.clock.value += 30000;
        return { ...actor, issued: (await f.runtime.totp.authenticate(first.issued.context, await generate({ secret: actor.secret, epoch: Math.floor(f.now() / 1000) }), 'LOGIN', null)).issued };
    };
    return { ...f, a, ...own, newActor: f.actor, tenant, mutate, borrower, terms, quote, login, read: async (operation, id, query = {}, version) => await f.runtime.lending.read(a.issued.context, operation, own.org, id, query, version) };
}
//# sourceMappingURL=fixture.js.map