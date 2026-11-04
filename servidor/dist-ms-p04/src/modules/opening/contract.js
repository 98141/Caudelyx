import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { AppError } from '../../shared/errors.js';
import { managementContract } from '../obligations/contract.js';
import { operationsDocument } from '../lending/operations-contract.js';
export const openingPurposes = ['OPENING_CREATE', 'OPENING_REPLACE', 'OPENING_VALIDATE', 'OPENING_APPROVE', 'OPENING_CANCEL', 'OPENING_COMMIT'];
export const isOpening = (p) => typeof p === 'string' && openingPurposes.includes(p);
export const purposes = new Map([['createOpening', 'OPENING_CREATE'], ['replaceOpening', 'OPENING_REPLACE'], ['validateOpening', 'OPENING_VALIDATE'], ['approveOpening', 'OPENING_APPROVE'], ['cancelOpening', 'OPENING_CANCEL'], ['commitOpening', 'OPENING_COMMIT']]);
export class OpeningContract {
    operations = new Map();
    schemas = new Map();
    results = new Map();
    constructor() {
        const bytes = readFileSync(resolve('../../Construccion/Sprints/S03/Contratos/openapi-opening-s03.json'));
        if (createHash('sha256').update(bytes).digest('hex') !== '51978d457cf3d4f1a3aea91ae7a8c7a5b2e2782dc3dea7a7475f314067e4f016')
            throw Error('Frozen S03 contract changed');
        const overlay = readFileSync(resolve('../../Construccion/Sprints/S11/Contratos/openapi-opening-s11-p02.json'));
        if (createHash('sha256').update(overlay).digest('hex') !== '50cbe18dd6b97b0f2838e563a0a4aa1391dca052c2c79e0d87759a59899ef5b8')
            throw Error('S11 opening delta changed');
        const doc = JSON.parse(overlay.toString('utf8'));
        operationsDocument(); // Verify the approved S05 overlay before composing the new journal source enum.
        managementContract(); // Verify the versioned S09 transport before composing its journal source.
        const extend = (v) => { if (!v || typeof v !== 'object')
            return; if (Array.isArray(v)) {
            for (const x of v)
                extend(x);
            return;
        } const r = v; if (Array.isArray(r['enum']) && r['enum'].includes('OPENING') && r['enum'].includes('MANUAL_JOURNAL'))
            r['enum'] = [...r['enum'], 'LOAN_OPERATION', 'INITIAL_BALANCE', 'MANAGEMENT_OPERATION']; for (const x of Object.values(r))
            extend(x); };
        extend(doc.components);
        const ajv = new Ajv2020({ strict: false, validateFormats: true });
        formats.default(ajv);
        for (const [name, schema] of Object.entries(doc.components.schemas))
            this.schemas.set(name, ajv.compile({ ...schema, components: doc.components }));
        for (const [path, methods] of Object.entries(doc.paths))
            for (const [method, definition] of Object.entries(methods)) {
                this.operations.set(definition.operationId, { path, method, definition });
                if (definition.requestBody)
                    this.schemas.set(definition.operationId, ajv.compile({ ...definition.requestBody.content['application/json'].schema, components: doc.components }));
                for (const [status, r] of Object.entries(definition.responses))
                    if (r.content)
                        this.results.set(`${definition.operationId}:${status}`, ajv.compile({ ...r.content['application/json'].schema, components: doc.components }));
            }
    }
    validate(name, value) { if (!this.schemas.get(name)?.(value))
        throw new AppError(422, 'INPUT_INVALID'); }
    result(operation, status, value) { if (!this.results.get(`${operation}:${status}`)?.(value))
        throw new AppError(503, 'SERVICE_UNAVAILABLE'); }
    intent(purpose, resourceId, command) {
        let c = command;
        if (purpose === 'OPENING_COMMIT' && command && typeof command === 'object') {
            const value = command, payload = value['payload'];
            if (payload?.['importBridge'] !== undefined) {
                this.validate('commitOpening', payload);
                const { importBridge, ...original } = payload;
                void importBridge;
                c = { ...value, payload: original };
            }
        }
        this.validate('OpeningReauthenticationIntent', { purpose, command: c, ...(resourceId ? { resourceId } : {}) });
    }
    auth(value) {
        if (!value || typeof value !== 'object')
            throw new AppError(422, 'INPUT_INVALID');
        const { password, ...intent } = value;
        if (typeof password !== 'string' || password.length < 15 || password.length > 128)
            throw new AppError(422, 'INPUT_INVALID');
        this.validate('OpeningReauthenticationIntent', intent);
    }
}
let shared;
export const openingContract = () => shared ??= new OpeningContract();
export function canonicalOpening(value) {
    if (Array.isArray(value))
        return value.map(canonicalOpening);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonicalOpening(v)]));
    if (typeof value === 'string')
        return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value) ? value.toLowerCase() : value.trim().normalize('NFC');
    return value;
}
//# sourceMappingURL=contract.js.map