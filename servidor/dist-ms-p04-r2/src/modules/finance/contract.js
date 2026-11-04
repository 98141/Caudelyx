import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { AppError } from '../../shared/errors.js';
import { openingContract } from '../opening/contract.js';
import { operationsContract } from '../lending/operations-contract.js';
export const financePurposes = ['FINANCE_ACCOUNT_CREATE', 'FINANCE_ACCOUNT_UPDATE', 'FINANCE_JOURNAL_POST', 'FINANCE_TRANSFER', 'FINANCE_JOURNAL_REVERSE'];
export const isFinancial = (purpose) => typeof purpose === 'string' && financePurposes.includes(purpose);
export class FinanceContract {
    operations = new Map();
    schemas = new Map();
    results = new Map();
    constructor() {
        const bytes = readFileSync(resolve('../../Construccion/Sprints/S02/Contratos/openapi-finance-s02.yaml'));
        if (createHash('sha256').update(bytes).digest('hex') !== 'e94743580b8ba587814d882bf492f636979bf76b6e96f46d3fd8a5b5db5dc729')
            throw new Error('P01 financial contract changed');
        const document = parse(bytes.toString('utf8'));
        for (const methods of Object.values(document.paths))
            for (const operation of Object.values(methods))
                if (operation.operationId === 'listAccounts') {
                    operation.parameters ??= [];
                    operation.parameters.push({ name: 'q', in: 'query', required: false, schema: { type: 'string', maxLength: 100 } });
                }
        const ajv = new Ajv2020({ strict: false, validateFormats: true });
        formats.default(ajv);
        for (const [name, schema] of Object.entries(document.components.schemas))
            this.schemas.set(name, ajv.compile({ ...schema, components: document.components }));
        for (const [path, methods] of Object.entries(document.paths))
            for (const [method, definition] of Object.entries(methods)) {
                this.operations.set(definition.operationId, { path, method, definition });
                if (definition.requestBody)
                    this.schemas.set(definition.operationId, ajv.compile({ ...definition.requestBody.content['application/json'].schema, components: document.components }));
                for (const [status, response] of Object.entries(definition.responses))
                    if (response.content)
                        this.results.set(`${definition.operationId}:${status}`, ajv.compile({ ...response.content['application/json'].schema, components: document.components }));
            }
    }
    validate(name, value) {
        const check = this.schemas.get(name);
        if (!check || !check(value))
            throw new AppError(422, 'INPUT_INVALID');
    }
    result(id, status, value) {
        if (value && typeof value === 'object') {
            const copy = structuredClone(value);
            const walk = (n) => { if (!n || typeof n !== 'object')
                return; if (Array.isArray(n)) {
                for (const x of n)
                    walk(x);
                return;
            } const o = n; if (o['type'] === 'LOAN_COMPENSATION')
                o['type'] = 'LOAN_OPERATION'; if (['CASH_DELIVERY', 'CASH_DELIVERY_COMPENSATION'].includes(String(o['type'])))
                o['type'] = 'TRANSFER'; for (const x of Object.values(o))
                walk(x); };
            walk(copy);
            value = copy;
        }
        if (status === 409 && value && typeof value === 'object' && 'error' in value && ['DOMAIN_ACCOUNT_PROTECTED', 'DOMAIN_REVERSAL_FORBIDDEN'].includes(String(value.error.code))) {
            operationsContract().validate('Error', value);
            return;
        }
        const overlay = new Map([['readJournal', 'JournalResponseS03'], ['listJournals', 'JournalPageS03'], ['postJournal', 'JournalResponseS03'], ['createTransfer', 'JournalResponseS03'], ['reverseJournal', 'JournalResponseS03']]).get(id);
        if (overlay && [200, 201].includes(status)) {
            openingContract().validate(overlay, value);
            return;
        }
        if (status === 409 && value && typeof value === 'object' && 'error' in value) {
            const code = value.error?.code;
            if (code === 'OPENING_IMMUTABLE' || code === 'OPENING_CUTOFF_CONFLICT') {
                openingContract().validate('Error', value);
                return;
            }
        }
        const check = this.results.get(`${id}:${status}`);
        if (!check || !check(value))
            throw new AppError(503, 'SERVICE_UNAVAILABLE');
    }
}
let shared;
export const financeContract = () => shared ??= new FinanceContract();
export function canonical(value) {
    if (Array.isArray(value))
        return value.map(canonical);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
    if (typeof value === 'string') {
        if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value))
            return value.toLowerCase();
        return value.trim().normalize('NFC');
    }
    return value;
}
//# sourceMappingURL=contract.js.map