import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { AppError } from '../../shared/errors.js';
// The digest is populated from the verified P01 input, not a mutable runtime setting.
export const specificationPath = 'Construccion/Sprints/S07/Contratos/openapi-collections-s07-p02.json';
export const specificationHash = 'e6c675ee2b258b61ff8c1182b36e319c5ed8893f5e407d9b9902e30b4f79325b';
export function paymentDocument() { const bytes = readFileSync(resolve('../..', specificationPath)); if (createHash('sha256').update(bytes).digest('hex') !== specificationHash)
    throw Error('S06 contract changed'); const overlay = readFileSync(resolve('../../Construccion/Sprints/S11/Contratos/openapi-payments-s11-p02.json')); if (createHash('sha256').update(overlay).digest('hex') !== '9a5ff211ec8327385eeea82104001f90f059b29d258a5f6ff30180193fe9254c')
    throw Error('S11 payments delta changed'); return JSON.parse(overlay.toString('utf8')); }
export const paymentClasses = Object.fromEntries(Object.entries(paymentDocument()['x-purpose-catalog-delta']).filter(([p]) => !Object.hasOwn(paymentDocument()['x-purpose-catalog-s07-delta'], p)));
export const isPaymentPurpose = (v) => typeof v === 'string' && Object.hasOwn(paymentClasses, v);
export class PaymentContract {
    operations = new Map();
    schemas = new Map();
    results = new Map();
    constructor() { const d = paymentDocument(), a = new Ajv2020({ strict: false }); formats.default(a); for (const [n, s] of Object.entries(d.components.schemas))
        this.schemas.set(n, a.compile({ ...s, components: d.components })); for (const [path, methods] of Object.entries(d.paths))
        for (const [method, definition] of Object.entries(methods)) {
            this.operations.set(definition.operationId, { path, method, definition });
            if (definition.requestBody)
                this.schemas.set(definition.operationId, a.compile({ ...definition.requestBody.content['application/json'].schema, components: d.components }));
            for (const [status, r] of Object.entries(definition.responses))
                if (r.content)
                    this.results.set(definition.operationId + ':' + status, a.compile({ ...r.content['application/json'].schema, components: d.components }));
        } }
    validate(name, value, response = false) { if (!this.schemas.get(name)?.(value))
        throw new AppError(response ? 503 : 422, response ? 'SERVICE_UNAVAILABLE' : 'INPUT_INVALID'); }
    result(op, status, value) { if (!this.results.get(op + ':' + status)?.(value))
        throw new AppError(503, 'SERVICE_UNAVAILABLE'); }
    purpose(op, payload) { if (op === 'registerPayment')
        return payload['command'].mode === 'DIRECT' ? 'PAYMENT_REGISTER_DIRECT' : 'PAYMENT_REGISTER'; return this.operations.get(op)?.definition['x-purpose'] ?? ''; }
}
let cached;
export const paymentContract = () => cached ??= new PaymentContract();
//# sourceMappingURL=contract.js.map