import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { AppError } from '../../shared/errors.js';
export class ReportingContract {
    document;
    operations = new Map();
    errors = new Set();
    validators = new Map();
    constructor() {
        const bytes = readFileSync(resolve('../../Construccion/Sprints/S08/Contratos/openapi-reporting-s08-p02.json'));
        if (createHash('sha256').update(bytes).digest('hex') !== '445eceda7001758875cdbc7ee3db4b4e976c9a62f038c59aa95d2d1b92c2b27b')
            throw Error('S08 reporting contract changed');
        this.document = JSON.parse(bytes.toString('utf8'));
        const ajv = new Ajv2020({ strict: false });
        formats.default(ajv);
        for (const [name, schema] of Object.entries(this.document.components.schemas)) {
            this.validators.set(name, ajv.compile({ ...schema, components: this.document.components }));
            if (name.startsWith('Error')) {
                const codes = schema.properties.error.properties.code.enum;
                for (const c of codes)
                    this.errors.add(c);
            }
        }
        for (const [path, { get }] of Object.entries(this.document.paths)) {
            this.operations.set(get.operationId, { path, definition: get });
            for (const p of get.parameters)
                this.validators.set(get.operationId + ':' + p.name, ajv.compile({ ...p.schema, components: this.document.components }));
            const result = get.responses['200'].content['application/json'].schema;
            this.validators.set(get.operationId + ':response', ajv.compile({ ...result, components: this.document.components }));
        }
    }
    validate(name, value, result = false) { const validator = this.validators.get(name); if (!validator?.(value))
        throw new AppError(result ? 503 : 422, result ? 'SERVICE_UNAVAILABLE' : 'INPUT_INVALID'); }
}
let singleton;
export const reportingContract = () => singleton ??= new ReportingContract();
//# sourceMappingURL=contract.js.map