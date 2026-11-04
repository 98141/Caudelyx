/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection -- Explicit hash-pinned local contracts; closed operation and schema maps. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { AppError } from '../../shared/errors.js';
function pinned(path, digest) { const bytes = readFileSync(resolve('../../Construccion/Sprints/' + path)); if (createHash('sha256').update(bytes).digest('hex') !== digest)
    throw Error('Wealth approved contract changed'); return JSON.parse(bytes.toString('utf8')); }
export const wealthDocument = () => pinned('S10/Contratos/openapi-assets-s10-p02.json', 'c23703e1bd99b4dcf495cad7d5c819b92d325ea63c94715f9dff91119d22df45');
export const wealthClasses = Object.fromEntries(Object.entries(wealthDocument()['x-purposes']).map(([p, v]) => [p, v.category]));
export const isWealthPurpose = (v) => typeof v === 'string' && Object.hasOwn(wealthClasses, v);
export const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, canonical(x)])) : typeof v === 'string' ? v.trim().normalize('NFC') : v;
export class WealthContract {
    document = wealthDocument();
    operations = new Map();
    errors = new Set(this.document['x-error-codes']);
    schemas = new Map();
    results = new Map();
    ajv = new Ajv2020({ strict: false });
    constructor() {
        formats.default(this.ajv);
        const old = pinned('S09/Contratos/openapi-expenses-s09-p04.json', '573335da8e0b09f146cfb36209e1cf78538e8466d478c34f33eab49f7bc7c6b9');
        this.ajv.addSchema({ ...old, $id: 'urn:caudelyx:s09:p04' });
        const rewrite = (v) => Array.isArray(v) ? v.map(rewrite) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === '$ref' && typeof x === 'string' && x.includes('openapi-expenses-s09-p04.json#') ? 'urn:caudelyx:s09:p04#' + x.split('#')[1] : rewrite(x)])) : v;
        this.document = rewrite(this.document);
        for (const [name, schema] of Object.entries(this.document.components.schemas))
            this.schemas.set(name, this.ajv.compile({ ...schema, components: this.document.components }));
        for (const [path, methods] of Object.entries(this.document.paths))
            for (const [method, definition] of Object.entries(methods)) {
                this.operations.set(definition.operationId, { path, method, definition });
                if (definition.requestBody)
                    this.schemas.set(definition.operationId, this.ajv.compile({ ...definition.requestBody.content['application/json'].schema, components: this.document.components }));
                for (const [status, response] of Object.entries(definition.responses))
                    if (response.content)
                        this.results.set(definition.operationId + ':' + status, this.ajv.compile({ ...response.content['application/json'].schema, components: this.document.components }));
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
        const op = this.operations.get(String(c['operationId']));
        if (!op || op.definition['x-purpose'] !== purpose)
            throw new AppError(422, 'INPUT_INVALID');
        this.validate(String(c['operationId']), c['payload']);
        this.validate('Id', c['idempotencyKey']);
        for (const key of ['bookId', 'organizationId', 'resourceId'])
            if (c[key] !== undefined)
                this.validate('Id', c[key]);
        if (c['expectedETag'] !== undefined)
            this.validate('ETag', c['expectedETag']);
        if (!c['pathParameters'] || typeof c['pathParameters'] !== 'object' || Array.isArray(c['pathParameters']))
            throw new AppError(422, 'INPUT_INVALID');
        const ps = c['pathParameters'], keys = op.definition.parameters.filter(p => p.in === 'path').map(p => p.name);
        if (Object.keys(ps).some(k => !keys.includes(k)) || keys.some(k => !ps[k]))
            throw new AppError(422, 'INPUT_INVALID');
        for (const v of Object.values(ps))
            this.validate('Id', v);
        return canonical(c);
    }
}
let instance;
export const wealthContract = () => instance ??= new WealthContract();
export const isPersonalWealthCommand = (purpose, command) => isWealthPurpose(purpose) && typeof command?.['operationId'] === 'string' && wealthContract().operations.get(command['operationId'])?.path.startsWith('/me/') === true;
//# sourceMappingURL=contract.js.map