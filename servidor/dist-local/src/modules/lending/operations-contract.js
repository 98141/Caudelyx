/* eslint-disable security/detect-object-injection -- Array indices come from the four closed operation/purpose tables; unknown purpose never grants a permission. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { AppError } from '../../shared/errors.js';
export const operationPurposes = ['LOAN_DISBURSE', 'LOAN_ACCRUE', 'LOAN_RECEIPT_POST', 'LOAN_CREDIT_APPLY'];
export const isOperation = (v) => typeof v === 'string' && operationPurposes.includes(v);
export const operationKinds = new Map([['disburseLoan', 'DISBURSE'], ['accrueLoanInterest', 'ACCRUE'], ['postLoanReceipt', 'RECEIPT'], ['applyBorrowerCredit', 'APPLY_CREDIT']]);
export const operationPurpose = new Map([...operationKinds.keys()].map((op, i) => [op, operationPurposes[i]]));
export function operationsDocument() {
    const bytes = readFileSync(resolve('../../Construccion/Sprints/S05/Contratos/openapi-operations-s05.json'));
    if (createHash('sha256').update(bytes).digest('hex') !== 'dd7d7f1c634b4c1b7c9498f62f9a99d06425da2d43081c3898517c79fb654be0')
        throw Error('S05 approved contract changed');
    const doc = JSON.parse(bytes.toString('utf8'));
    const walk = (v) => { if (!v || typeof v !== 'object')
        return; if (Array.isArray(v)) {
        if (v.includes('ORIGINAL') && v.includes('EXTRA_PRINCIPAL'))
            v.push('REVERSAL_RESTORE');
        if (v.includes('NO_ACCRUAL_DUE'))
            v.push('PAYMENT_FLOW_REQUIRED');
        for (const x of v)
            walk(x);
    }
    else
        for (const x of Object.values(v))
            walk(x); };
    walk(doc.components.schemas);
    return doc;
}
export class OperationsContract {
    operations = new Map();
    errors;
    schemas = new Map();
    results = new Map();
    constructor() {
        const doc = operationsDocument(), ajv = new Ajv2020({ strict: false, validateFormats: true });
        formats.default(ajv);
        for (const [n, schema] of Object.entries(doc.components.schemas))
            this.schemas.set(n, ajv.compile({ ...schema, components: doc.components }));
        for (const [path, methods] of Object.entries(doc.paths))
            for (const [method, definition] of Object.entries(methods)) {
                this.operations.set(definition.operationId, { path, method, definition });
                if (definition.requestBody)
                    this.schemas.set(definition.operationId, ajv.compile({ ...definition.requestBody.content['application/json'].schema, components: doc.components }));
                for (const [status, r] of Object.entries(definition.responses))
                    if (r.content)
                        this.results.set(definition.operationId + ':' + status, ajv.compile({ ...r.content['application/json'].schema, components: doc.components }));
            }
        this.errors = new Set(doc.components.schemas['Error'].properties.error.properties.code.enum);
    }
    validate(n, v) { if (!this.schemas.get(n)?.(v))
        throw new AppError(422, 'INPUT_INVALID'); }
    result(op, status, v) { if (!this.results.get(op + ':' + status)?.(v))
        throw new AppError(503, 'SERVICE_UNAVAILABLE'); }
    intent(purpose, resourceId, command) { const index = operationPurposes.indexOf(purpose), kind = [...operationKinds.values()][index]; if (!kind)
        throw new AppError(422, 'INPUT_INVALID'); this.validate(kind + 'ReauthenticationIntent', { purpose, resourceId, command }); }
    auth(v) { const { password, ...intent } = v; if (typeof password !== 'string' || password.length < 15 || password.length > 128)
        throw new AppError(422, 'INPUT_INVALID'); const kind = [...operationKinds.values()][operationPurposes.indexOf(String(v['purpose']))]; this.validate(kind + 'ReauthenticationIntent', intent); }
}
let cached;
export const operationsContract = () => cached ??= new OperationsContract();
//# sourceMappingURL=operations-contract.js.map