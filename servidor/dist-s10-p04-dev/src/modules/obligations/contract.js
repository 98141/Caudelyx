import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { AppError } from '../../shared/errors.js';
import { isPersonalWealthCommand } from '../wealth/contract.js';
const bytes = () => readFileSync(resolve('../../Construccion/Sprints/S09/Contratos/openapi-expenses-s09-p04.json'));
export function document() { const b = bytes(); if (createHash('sha256').update(b).digest('hex') !== '573335da8e0b09f146cfb36209e1cf78538e8466d478c34f33eab49f7bc7c6b9')
    throw Error('S09 approved contract changed'); return JSON.parse(b.toString('utf8')); }
export const managementClasses = Object.fromEntries(Object.entries(document()['x-purposes']).map(([p, v]) => [p, v.category]));
export const isManagementPurpose = (value) => typeof value === 'string' && Object.hasOwn(managementClasses, value);
export const isPersonalManagementCommand = (purpose, command) => isPersonalWealthCommand(purpose, command) || (isManagementPurpose(purpose) && typeof command?.['operationId'] === 'string' && managementContract().operations.get(command['operationId'])?.path.startsWith('/me/') === true);
export class ManagementContract {
    document = document();
    operations = new Map();
    schemas = new Map();
    results = new Map();
    constructor() {
        const a = new Ajv2020({ strict: false });
        formats.default(a);
        const components = this.document.components;
        for (const [name, s] of Object.entries(components.schemas))
            this.schemas.set(name, a.compile({ ...s, components }));
        for (const [path, methods] of Object.entries(this.document.paths))
            for (const [method, definition] of Object.entries(methods)) {
                this.operations.set(definition.operationId, { path, method, definition });
                if (definition.requestBody)
                    this.schemas.set(definition.operationId, a.compile({ ...definition.requestBody.content['application/json'].schema, components }));
                for (const [status, r] of Object.entries(definition.responses))
                    if (r.content)
                        this.results.set(definition.operationId + ':' + status, a.compile({ ...r.content['application/json'].schema, components }));
            }
    }
    validate(name, value) { if (!this.schemas.get(name)?.(value))
        throw new AppError(422, 'INPUT_INVALID'); }
    result(name, status, value) { if (!this.results.get(name + ':' + status)?.(value))
        throw new AppError(503, 'SERVICE_UNAVAILABLE'); }
    command(purpose, input) {
        if (!input || typeof input !== 'object' || Array.isArray(input))
            throw new AppError(422, 'INPUT_INVALID');
        const c = input;
        if (Object.keys(c).some(k => !['operationId', 'organizationId', 'bookId', 'idempotencyKey', 'resourceId', 'expectedETag', 'pathParameters', 'payload'].includes(k)))
            throw new AppError(422, 'INPUT_INVALID');
        const operation = this.operations.get(String(c['operationId']));
        if (!operation || operation.definition['x-purpose'] !== purpose)
            throw new AppError(422, 'INPUT_INVALID');
        this.validate('Id', c['idempotencyKey']);
        this.validate(String(c['operationId']), c['payload']);
        if (c['bookId'] !== undefined)
            this.validate('Id', c['bookId']);
        if (c['organizationId'] !== undefined)
            this.validate('Id', c['organizationId']);
        if (c['expectedETag'] !== undefined)
            this.validate('ETag', c['expectedETag']);
        return canonical(c);
    }
}
export const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, canonical(x)])) : typeof v === 'string' ? v.trim().normalize('NFC') : v;
let value;
export const managementContract = () => value ??= new ManagementContract();
//# sourceMappingURL=contract.js.map