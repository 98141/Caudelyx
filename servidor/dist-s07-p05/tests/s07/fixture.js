import { randomUUID } from 'node:crypto';
import { fundedSetup } from '../operations/fixture.js';
import { today } from '../../src/modules/finance/service.js';
export const code = (value) => (e) => e instanceof Error && 'code' in e && e.code === value;
export async function setup(group, options = {}) {
    const f = await fundedSetup({ ...group, fixture: () => group.fixture(options) }, '2026-10-31T12:00:00-05:00', options.withOpening ?? false), pay = f.identity.payments;
    const account = async (label, accountClass = 'ASSET', kind = 'GENERAL') => {
        const payload = { code: label, name: 'Cuenta sintética ' + label, currency: 'COP', accountClass, kind }, r = await f.runtime.finance.mutate(f.a.issued.context, 'createAccount', f.org, payload, randomUUID());
        return r.data;
    };
    const state = async () => { const r = await pay.read(f.a.issued.context, 'getPaymentsState', f.org); return r.data; };
    const mutate = async (operation, payload, id, actor = f.a, key = randomUUID()) => {
        const versions = await state(), purpose = pay ? (await import('../../src/modules/payments/contract.js')).paymentContract().purpose(operation, payload) : '';
        const command = { organizationId: f.org, idempotencyKey: key, expectedETag: versions.paymentsBookETag, operationId: operation, resourceId: id ?? null, payload };
        await f.proof(actor, purpose, command, id);
        return await pay.mutate(actor.issued.context, operation, f.org, payload, key, versions.paymentsBookETag, id);
    };
    const prepare = async (command, actor = f.a, key = randomUUID()) => {
        const versions = await state(), preview = await pay.preview(actor.issued.context, f.org, { executionKey: key, expectedPaymentsETag: versions.paymentsBookETag, command }), p = preview.data;
        const operation = command['kind'] === 'REGISTER' ? 'registerPayment' : command['kind'] === 'APPROVE' ? 'approvePayment' : 'executePaymentReversal', id = command['kind'] === 'REGISTER' ? undefined : String(command[command['kind'] === 'APPROVE' ? 'paymentId' : 'originalEventId']), payload = { command, previewToken: p.token };
        const purpose = (await import('../../src/modules/payments/contract.js')).paymentContract().purpose(operation, payload), proofCommand = { organizationId: f.org, idempotencyKey: key, expectedETag: versions.paymentsBookETag, operationId: operation, resourceId: id ?? null, payload };
        const execute = async () => { await f.proof(actor, purpose, proofCommand, id); return await pay.mutate(actor.issued.context, operation, f.org, payload, key, versions.paymentsBookETag, id); };
        return { execute, operation, purpose, payload, key, etag: versions.paymentsBookETag, id, preview: p, proofCommand };
    };
    const member = async (role) => {
        const actor = await f.newActor(), payload = { email: actor.email, roleIds: [role] };
        await f.proof(f.a, 'MEMBER_INVITE', payload, f.org);
        await f.runtime.organizations.invite(f.a.issued.context, payload);
        await f.identity.dispatchMail();
        const mail = [...f.messages.notificationInbox.values()].find(m => m.kind === 'INVITATION' && m.payload['email'] === actor.email);
        if (!mail)
            throw Error('Missing own invitation');
        await f.runtime.organizations.accept(actor.issued.context, { mode: 'CONFIRM', token: mail.payload['token'] }, randomUUID());
        return actor;
    };
    const intent = async (loan, destination, amount = '300000.00', actor = f.a, method = 'BANK') => {
        const position = await f.position(loan.id), a = await f.runtime.finance.read(f.a.issued.context, 'readAccount', f.org, destination), binding = method === 'CASH' ? await pay.read(f.a.issued.context, 'getCustodyBinding', f.org, actor.issued.context.subjectId) : null;
        return { method, borrowerId: loan.borrowerId, amount, currency: 'COP', destinationAccountId: destination, destinationAccountETag: a.etag, custodianId: method === 'CASH' ? actor.issued.context.subjectId : null, bindingETag: binding?.etag ?? null, observedDate: today(f.now()), observedAt: new Date(f.now()).toISOString(), receiptReference: 'SYN-' + randomUUID(), supportReference: 'SYN-S06', targets: [{ loanId: loan.id, positionETag: position.etag, amount, mode: 'REGULAR' }], excessDisposition: 'CREDIT' };
    };
    const bind = async (actor, cash, held) => {
        const cashRead = await f.runtime.finance.read(f.a.issued.context, 'readAccount', f.org, cash), h = await f.runtime.finance.read(f.a.issued.context, 'readAccount', f.org, held);
        return await mutate('setCustodyBinding', { custodianId: actor.issued.context.subjectId, accountId: cash, accountETag: cashRead.etag, heldLiabilityAccountId: held, heldLiabilityAccountETag: h.etag, resourceETag: `"${actor.issued.context.subjectId}:binding:0"`, supportReference: 'SYN-BIND' });
    };
    const profile = async () => { const h = await account('HELD', 'LIABILITY'), r = await f.runtime.finance.read(f.a.issued.context, 'readAccount', f.org, h.id); await mutate('setHeldFundsProfile', { configurationKind: 'HELD_FUNDS_PROFILE', heldLiabilityAccountId: h.id, heldLiabilityAccountETag: r.etag, resourceETag: `"${f.org}:held-profile:0"`, supportReference: 'SYN-HELD' }); return h.id; };
    const readPayment = async (id) => await pay.read(f.a.issued.context, 'getPayment', f.org, id);
    const reverse = async (eventId, paymentId) => {
        const r = await mutate('requestPaymentReversal', { resourceETag: `"${eventId}:1"`, reason: 'Corrección sintética', supportReference: 'SYN-REVERSE' }, eventId), request = await pay.read(f.a.issued.context, 'getLoanEventReversalRequest', f.org, r.data.entityId), v = await state();
        return await prepare({ kind: 'EXECUTE_REVERSAL', paymentId, originalEventId: eventId, resourceETag: request.etag, reversalRequestId: eventId, effectiveDate: today(f.now()), expectedOperationsETag: v.operationsBookETag, supportReference: 'SYN-REVERSE' });
    };
    const collections = f.identity.collections;
    const collectionsState = async () => (await collections.read(f.a.issued.context, 'getCollectionsState', f.org)).data;
    const readCollections = async (operation, id, actor = f.a, query = {}) => await collections.read(actor.issued.context, operation, f.org, id, query);
    const mutateCollections = async (operation, payload, id, actor = f.a, key = randomUUID()) => {
        const v = await collectionsState(), purpose = (await import('../../src/modules/collections/contract.js')).collectionContract().purpose(operation, payload), command = { organizationId: f.org, idempotencyKey: key, expectedETag: v.collectionsBookETag, operationId: operation, resourceId: id ?? null, payload };
        await f.proof(actor, purpose, command, id);
        return await collections.mutate(actor.issued.context, operation, f.org, payload, key, v.collectionsBookETag, id);
    };
    const prepareCollections = async (command, actor = f.a, key = randomUUID()) => {
        const preview = (await collections.preview(actor.issued.context, f.org, { executionKey: key, command })).data, payload = { command, previewToken: preview.token }, kind = command['kind'];
        const operation = kind === 'REQUEST' ? 'requestCashDelivery' : kind === 'CONFIRM' ? 'confirmCashDelivery' : kind === 'COMPENSATE_REQUEST' ? 'requestCashDeliveryCompensation' : 'confirmCashDeliveryCompensation', id = kind === 'REQUEST' ? undefined : String(command[kind === 'COMPENSATE_REQUEST' ? 'originalDeliveryId' : 'deliveryId']), purpose = (await import('../../src/modules/collections/contract.js')).collectionContract().purpose(operation, payload), proofCommand = { organizationId: f.org, idempotencyKey: key, expectedETag: preview.state.collectionsBookETag, operationId: operation, resourceId: id ?? null, payload };
        const execute = async () => { await f.proof(actor, purpose, proofCommand, id); return await collections.mutate(actor.issued.context, operation, f.org, payload, key, preview.state.collectionsBookETag, id); };
        return { execute, operation, id, purpose, key, payload, etag: preview.state.collectionsBookETag, preview, proofCommand };
    };
    return { ...f, collections, collectionsState, readCollections, mutateCollections, prepareCollections, pay, state, mutatePayment: mutate, preparePayment: prepare, member, intent, accountS06: account, bind, heldProfile: profile, readPayment, reverse };
}
export async function cashSetup(group, approve = true, withOpening = false) {
    const f = await setup(group, { withOpening }), c = await f.member('C'), o = await f.member('O'), l = await f.loan({ principal: '2000000.00' });
    await f.disburse(l);
    const cash = await f.accountS06('CASH_S07', 'ASSET', 'CASH'), central = await f.accountS06('CENTRAL_S07', 'ASSET', 'CASH'), held = await f.heldProfile();
    await f.bind(c, cash.id, held);
    const scopeId = randomUUID();
    await f.mutatePayment('setPaymentRegistrationScope', { scopeId, registrarId: c.issued.context.subjectId, loanId: l.id, scope: 'PAYMENT_REGISTER_ONLY', active: true, resourceETag: '"' + scopeId + ':0"', supportReference: 'SYN-S07' });
    const stationId = randomUUID(), account = await f.runtime.finance.read(f.a.issued.context, 'readAccount', f.org, central.id), receiver = await f.identity.identities.findOne({ _id: o.issued.context.subjectId });
    await f.mutateCollections('setCashStation', { stationId, resourceETag: '"' + stationId + ':0"', accountId: central.id, accountETag: account.etag, receiverId: receiver._id, receiverETag: receiver.version, active: true, supportReference: 'SYN-S07' });
    const p = (await (await f.preparePayment({ kind: 'REGISTER', mode: 'SUPERVISED', effectiveDate: today(f.now()), intent: await f.intent(l, cash.id, '300000.00', c, 'CASH') }, c)).execute()).data;
    const approveCash = async () => { const payment = await f.readPayment(p.entityId), versions = await f.state(); return await (await f.preparePayment({ kind: 'APPROVE', paymentId: p.entityId, resourceETag: payment.etag, effectiveDate: today(f.now()), expectedOperationsETag: versions.operationsBookETag })).execute(); };
    if (approve)
        await approveCash();
    const delivery = async (id) => (await f.readCollections('getCashDelivery', id)).data;
    const request = async (amount = '250000.00') => {
        const stations = (await f.readCollections('listCashStations', undefined, c)).data, station = stations.items.find(x => x['stationId'] === stationId), positions = (await f.readCollections('getCashPosition', c.issued.context.subjectId, c)).data, source = positions.items.find(x => x['accountId'] === cash.id), custody = await f.pay.read(c.issued.context, 'getCashCustody', f.org, p.entityId);
        return await f.prepareCollections({ kind: 'REQUEST', stationId, stationETag: station['stationETag'], sourceAccountId: cash.id, sourceAccountETag: source['accountETag'], bindingETag: source['bindingETag'], journeyId: null, amount, portions: [{ sourcePaymentId: p.entityId, sourceCustodyETag: custody.etag, amount }], supportReference: 'SYN-S07' }, c);
    };
    const act = async (operation, id, actor = f.a, extra = {}) => { const d = await f.readCollections('getCashDelivery', id); return await f.mutateCollections(operation, { resourceETag: d.etag, occurredAt: new Date(f.now()).toISOString(), reason: 'Hecho físico sintético', supportReference: 'SYN-S07', ...extra }, id, actor); };
    const count = async (id, amount = '250000.00', actor = o) => { const d = await f.readCollections('getCashDelivery', id); return await f.mutateCollections('countCashDelivery', { resourceETag: d.etag, amount, occurredAt: new Date(f.now()).toISOString(), denominations: [], reason: 'Conteo real sintético', supportReference: 'SYN-S07' }, id, actor); };
    const confirm = async (id, compensation = false) => { const d = await delivery(id); return await f.prepareCollections({ kind: compensation ? 'COMPENSATE_CONFIRM' : 'CONFIRM', deliveryId: id, resourceETag: '"' + id + ':' + d.version + '"', countId: d.countId, countETag: '"' + d.countId + ':1"', effectiveDate: today(f.now()), supportReference: 'SYN-S07' }); };
    return { ...f, c, o, l, cash, central, held, stationId, scopeId, paymentId: p.entityId, approveCash, delivery, request, act, count, confirm };
}
//# sourceMappingURL=fixture.js.map