import { isWealthPurpose, wealthContract } from '../modules/wealth/contract.js';
import { isCollectionPurpose } from '../modules/collections/contract.js';
import { isManagementPurpose, managementContract } from '../modules/obligations/contract.js';
import { FrozenContract } from './contract.js';
import { AppError } from './errors.js';
import { canonical, isFinancial, financeContract } from '../modules/finance/contract.js';
import { isOpening, canonicalOpening, openingContract } from '../modules/opening/contract.js';
import { isLending, canonical as canonicalLending, lendingContract, purposes as lendingOperations } from '../modules/lending/contract.js';
import { isOperation, operationPurpose, operationsContract } from '../modules/lending/operations-contract.js';
import { isPaymentPurpose, paymentContract } from '../modules/payments/contract.js';
let contract;
export function validateCommand(operation, input) { (contract ??= new FrozenContract()).validate(operation, input); }
export const payloadPurposes = ['ORGANIZATION_CREATE', 'ORGANIZATION_EDIT', 'MEMBER_INVITE', 'MEMBER_ROLE_CHANGE', 'MFA_ENROLL'];
export function authorizePurpose(realm, purpose, command) {
    if (realm === 'PLATFORM' && (isManagementPurpose(purpose) || isWealthPurpose(purpose)))
        throw new AppError(403, 'ACCESS_DENIED');
    if (realm === 'PLATFORM' && (isPaymentPurpose(purpose) || isCollectionPurpose(purpose)))
        throw new AppError(403, 'ACCESS_DENIED');
    if (realm === 'PLATFORM' && isLending(purpose))
        throw new AppError(403, 'ACCESS_DENIED');
    if (realm === 'PLATFORM' && isOperation(purpose))
        throw new AppError(403, 'ACCESS_DENIED');
    if (realm === 'PLATFORM' && (isFinancial(purpose) || isOpening(purpose)))
        throw new AppError(403, 'ACCESS_DENIED');
    const tenant = ['ORGANIZATION_CREATE', 'ORGANIZATION_EDIT', 'MEMBER_INVITE', 'INVITATION_REVOKE', 'MEMBER_ROLE_CHANGE', 'MEMBER_SUSPEND', 'MEMBER_REACTIVATE', 'MEMBER_SESSIONS_REVOKE', 'ORGANIZATION_SESSIONS_REVOKE'];
    if (realm === 'PLATFORM' && (tenant.includes(purpose) || purpose === 'MFA_ENROLL' && command?.['methodType'] === 'TOTP'))
        throw new AppError(403, 'ACCESS_DENIED');
}
export function normalizeCommand(purpose, input, email) {
    if (isWealthPurpose(purpose))
        return wealthContract().command(purpose, input);
    if (isManagementPurpose(purpose))
        return managementContract().command(purpose, input);
    if (isPaymentPurpose(purpose) || isCollectionPurpose(purpose)) {
        if (!input)
            throw new AppError(422, 'INPUT_INVALID');
        const c = canonicalLending(input);
        paymentContract().validate(String(c['operationId']), c['payload']);
        if (paymentContract().purpose(String(c['operationId']), c['payload']) !== purpose)
            throw new AppError(422, 'INPUT_INVALID');
        return c;
    }
    if (isOperation(purpose)) {
        if (!input)
            throw new AppError(422, 'INPUT_INVALID');
        const command = canonicalLending(input);
        const operation = [...operationPurpose].find(([, p]) => p === purpose)[0];
        operationsContract().validate(operation, command['payload']);
        return command;
    }
    if (isLending(purpose)) {
        if (!input)
            throw new AppError(422, 'INPUT_INVALID');
        const command = canonicalLending(input);
        const operation = [...lendingOperations].find(([, p]) => p === purpose)[0];
        lendingContract().validate(operation, command['payload']);
        return command;
    }
    if (isOpening(purpose)) {
        if (!input)
            throw new AppError(422, 'INPUT_INVALID');
        const command = canonicalOpening(input);
        const schema = new Map([['OPENING_CREATE', 'OpeningCreate'], ['OPENING_REPLACE', 'OpeningReplace'], ['OPENING_VALIDATE', 'ValidateCommand'], ['OPENING_APPROVE', 'ValidationBinding'], ['OPENING_CANCEL', 'CancelCommand'], ['OPENING_COMMIT', 'ValidationBinding']]).get(purpose);
        openingContract().validate(schema, command['payload']);
        return command;
    }
    if (isFinancial(purpose)) {
        if (!input)
            throw new AppError(422, 'INPUT_INVALID');
        const command = canonical(input);
        const schema = new Map([['FINANCE_ACCOUNT_CREATE', 'AccountCreate'], ['FINANCE_ACCOUNT_UPDATE', 'AccountRename'], ['FINANCE_JOURNAL_POST', 'Posting'], ['FINANCE_TRANSFER', 'Transfer'], ['FINANCE_JOURNAL_REVERSE', 'Reversal']]).get(purpose);
        financeContract().validate(schema, command['payload']);
        return command;
    }
    if (!payloadPurposes.includes(purpose))
        return null;
    if (!input)
        throw new AppError(422, 'INPUT_INVALID');
    switch (purpose) {
        case 'ORGANIZATION_CREATE': return { name: input['name'].trim(), timezone: input['timezone'], currency: input['currency'] };
        case 'ORGANIZATION_EDIT': return { name: input['name'].trim() };
        case 'MEMBER_INVITE': return { email: email(input['email']), roleIds: [...input['roleIds']].sort() };
        case 'MEMBER_ROLE_CHANGE': return { roleIds: [...input['roleIds']].sort() };
        case 'MFA_ENROLL': return { methodType: input['methodType'], label: input['label'].trim() };
        default: throw new AppError(422, 'INPUT_INVALID');
    }
}
//# sourceMappingURL=commands.js.map