/* eslint-disable security/detect-object-injection -- Closed OpenAPI catalogs and fixed schema property names, not executable user keys. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { AppError } from '../../shared/errors.js';
export const msErrors = ['MONEY_OVERFLOW', 'REAL_USE_NOT_ALLOWED', 'SETTLEMENT_PREVIEW_REQUIRED', 'SETTLEMENT_AMOUNT_INSUFFICIENT', 'ACCRUAL_CATCHUP_REQUIRED', 'HISTORY_DEPENDENCY_CONFLICT', 'HISTORY_RANGE_UNSUPPORTED', 'PERIOD_CLOSURE_UNAVAILABLE', 'PERIOD_CLOSED', 'SOURCE_ALREADY_USED', 'MANDATE_INVALID', 'CONSOLIDATION_INCOMPLETE', 'INSUFFICIENT_AVAILABLE_FUNDS', 'MS_QUERY_BUDGET_EXCEEDED', 'MS_SCOPE_TOO_LARGE'];
export function msDocument() {
    const bytes = readFileSync(resolve('../../Construccion/Sprints/MODO-SIMPLE/Contratos/P01-v1/openapi-modo-simple-p01-approved.json'));
    if (createHash('sha256').update(bytes).digest('hex') !== 'f3253ae506ee19f9215a0863ee0a0870d5599b5ad28c032fef254808dea3c1c1')
        throw Error('Approved MS contract changed');
    return msRuntimeDelta(JSON.parse(bytes.toString('utf8')));
}
function msRuntimeDelta(d) {
    // Serialization needed by the already-approved behavior: an explicit future
    // rate date, quota/fund/opportunity references, compensation reference, and a
    // non-posting debt draft. The approved source document is never overwritten.
    const ref = (n) => ({ $ref: '#/components/schemas/' + n }), object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
    const schemas = d.components.schemas, schema = (n) => schemas[n];
    Object.assign(schema('Commit').properties['previewToken'], { maxLength: 32768 });
    Object.assign(schema('Preview').properties['previewToken'], { maxLength: 32768 });
    schemas['OpeningMonthlyPeriod'] = object({ ordinal: { type: 'integer', minimum: 1, maximum: 1000 }, principalBase: ref('Money'), rate: ref('MonthlyRate'), contractualInterest: ref('Money'), paidBeforeOpening: ref('Money'), recognizedInterestRemaining: ref('Money'), unrecognizedInterestRemaining: ref('Money') });
    schema('HistoryLink').properties['openingPeriods'] = { type: 'array', minItems: 1, maxItems: 1000, items: ref('OpeningMonthlyPeriod') };
    schema('HistoryLink').required.push('openingPeriods');
    schemas['MonthlyTermsChange'] = structuredClone(schemas['MonthlyTerms']);
    schema('MonthlyTermsChange').properties['effectiveFrom'] = ref('Date');
    schemas['SavingsTarget'] = object({ liabilityId: ref('Id'), installmentId: ref('Id'), installmentNumber: { type: 'integer', minimum: 1, maximum: 360 }, fundId: ref('Id'), opportunityDates: { type: 'array', items: ref('Date'), maxItems: 366 } }, ['liabilityId', 'fundId', 'opportunityDates']);
    Object.assign(schemas['SavingsTarget'], { oneOf: [{ required: ['installmentId'], not: { required: ['installmentNumber'] } }, { required: ['installmentNumber'], not: { required: ['installmentId'] } }] });
    schema('MappingVersion').properties['savingsTargets'] = { type: 'array', items: ref('SavingsTarget'), maxItems: 100 };
    schema('DistributionPreview').properties['action'] = { type: 'string', enum: ['DISTRIBUTE', 'REVERSE'] };
    schema('DistributionPreview').properties['reversesDistributionId'] = ref('Id');
    schemas['MsPaymentTarget'] = object({ loanId: ref('Id'), positionETag: ref('ETag'), amount: ref('Money'), mode: { type: 'string', enum: ['REGULAR', 'EXTRA_PRINCIPAL', 'SETTLEMENT'] } });
    schemas['MsDirectPaymentIntent'] = object({ method: { type: 'string', enum: ['CASH', 'BANK'] }, borrowerId: ref('Id'), amount: ref('Money'), currency: { const: 'COP' }, destinationAccountId: ref('Id'), destinationAccountETag: ref('ETag'), custodianId: { anyOf: [ref('Id'), { type: 'null' }] }, bindingETag: { anyOf: [ref('ETag'), { type: 'null' }] }, observedDate: ref('Date'), observedAt: ref('Instant'), receiptReference: { type: 'string', minLength: 1, maxLength: 80 }, supportReference: { type: 'string', minLength: 1, maxLength: 160 }, targets: { type: 'array', minItems: 1, maxItems: 10, items: ref('MsPaymentTarget') }, excessDisposition: { type: 'string', enum: ['REJECT', 'CREDIT'] } });
    schema('HistoryPayment').properties['directIntent'] = ref('MsDirectPaymentIntent');
    schema('HistoryPayment').required = schema('HistoryPayment').required.filter(k => k !== 'paymentId');
    Object.assign(schemas['HistoryPayment'], { oneOf: [{ required: ['paymentId'], not: { required: ['directIntent'] } }, { required: ['directIntent'], not: { required: ['paymentId'] } }] });
    schemas['SimpleDebtPlanInput'] = object({ entity: { type: 'string', minLength: 1, maxLength: 100 }, declaredBalance: ref('Money'), declaredQuota: { anyOf: [ref('Money'), { type: 'null' }] }, frequency: { type: ['string', 'null'], enum: ['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'CUSTOM', null] }, nextDueDate: { anyOf: [ref('Date'), { type: 'null' }] }, installmentsRemaining: { type: ['integer', 'null'], minimum: 1, maximum: 360 } });
    schemas['SimpleDebtPlan'] = object({ id: ref('Id'), bookId: ref('Id'), version: { type: 'integer', minimum: 1 }, status: { const: 'INFORMATIONAL_DRAFT' }, details: ref('SimpleDebtPlanInput'), paymentCoverage: { const: 'INCOMPLETE' } });
    schemas['SimpleDebtPlanList'] = object({ rows: { type: 'array', items: ref('SimpleDebtPlan'), maxItems: 100 }, totalCount: { type: 'integer', minimum: 0 }, nextCursor: { type: ['string', 'null'], maxLength: 4096 } });
    for (const field of ['installmentId', 'dueDate'])
        schema('SavingsRow').properties[field] = { anyOf: [schema('SavingsRow').properties[field], { type: 'null' }] };
    schemas['MappingRecord'] = object({ id: ref('Id'), bookId: ref('Id'), version: { type: 'integer', minimum: 1 }, digest: ref('Digest'), mapping: ref('MappingVersion') });
    schemas['MappingList'] = object({ rows: { type: 'array', maxItems: 100, items: ref('MappingRecord') }, totalCount: { type: 'integer', minimum: 0 }, nextCursor: { type: ['string', 'null'], maxLength: 4096 } });
    for (const methods of Object.values(d.paths))
        for (const op of Object.values(methods))
            if (op.operationId === 'msVersionMonthlyTerms')
                op.requestBody = { content: { 'application/json': { schema: ref('MonthlyTermsChange') } } };
    const base = '/modo-simple/v1/books/{bookId}', create = structuredClone(d.paths[base + '/monthly-loans']['post']), list = structuredClone(d.paths[base + '/savings-plan']['get']);
    Object.assign(create, { operationId: 'msCreateDebtPlan', 'x-purpose': 'MS_DEBT_PLAN_CREATE', 'x-scope': 'BOOK', requestBody: { required: true, content: { 'application/json': { schema: ref('SimpleDebtPlanInput') } } } });
    create.responses['200'].content['application/json'].schema = ref('SimpleDebtPlan');
    Object.assign(list, { operationId: 'msListDebtPlans' });
    list.responses['200'].content['application/json'].schema = ref('SimpleDebtPlanList');
    d.paths[base + '/debt-plans'] = { get: list, post: create };
    const mappings = structuredClone(list);
    mappings.operationId = 'msListMappingVersions';
    mappings.responses['200'].content['application/json'].schema = ref('MappingList');
    d.paths[base + '/mappings/versions']['get'] = mappings;
    for (const methods of Object.values(d.paths))
        for (const op of Object.values(methods))
            Object.assign(op, { 'x-state': 'IMPLEMENTED_UNREVIEWED' });
    schema('MonthlyView').properties['interestExpectedThisMonth'] = ref('Metric');
    schema('MonthlyView').required.push('interestExpectedThisMonth');
    schemas['InterbookRoot'] = object({ id: ref('Id'), effectiveDate: ref('Date'), remaining: ref('Money'), sourceEventIds: { type: 'array', minItems: 2, maxItems: 2, items: ref('Id') }, personalContraAccountId: ref('Id'), businessContraAccountId: ref('Id') });
    schemas['InterbookEligibility'] = object({ id: ref('Id'), validFrom: ref('Date'), percentage: { const: '100.00' } });
    schemas['InterbookAccount'] = object({ id: ref('Id'), code: { type: 'string' }, name: { type: 'string' }, accountClass: { type: 'string' }, kind: { type: 'string' } });
    schemas['InterbookOptions'] = object({ personalBookId: ref('Id'), organizationId: ref('Id'), metadataTime: { const: 'CURRENT_AUTHORITY' }, personalAccounts: { type: 'array', maxItems: 100, items: ref('InterbookAccount') }, businessAccounts: { type: 'array', maxItems: 100, items: ref('InterbookAccount') }, eligibilities: { type: 'array', maxItems: 1, items: ref('InterbookEligibility') }, contributions: { type: 'array', maxItems: 100, items: ref('InterbookRoot') } });
    const options = structuredClone(list);
    options.operationId = 'msGetInterbookOptions';
    options.responses['200'].content['application/json'].schema = ref('InterbookOptions');
    d.paths[base + '/interbook-options'] = { get: options };
    d.info.version = '1.0.3';
    Object.assign(schema('Cuts').properties['contractVersion'], { const: '1.0.3' });
    return msCompatibility(d);
}
// Versioned compatibility overlay in memory. All frozen source bytes remain pinned.
// The extra enum values route to a distinct engine; finite SETTLEMENT is rejected.
export function msCompatibility(document) {
    const walk = (v) => {
        if (Array.isArray(v)) {
            for (const n of v)
                walk(n);
            return;
        }
        if (!v || typeof v !== 'object')
            return;
        const obj = v;
        if (Array.isArray(obj['enum'])) {
            const list = obj['enum'];
            if (list.includes('REGULAR') && list.includes('EXTRA_PRINCIPAL') && !list.includes('SETTLEMENT'))
                list.push('SETTLEMENT');
            if (list.includes('TERMS_CONFIRMED'))
                for (const value of ['MONTHLY_DRAFT', 'MONTHLY_ACTIVE'])
                    if (!list.includes(value))
                        list.push(value);
            if (list.includes('ORIGINATED_S04') && !list.includes('MONTHLY_OPEN_V1'))
                list.push('MONTHLY_OPEN_V1');
            if (list.includes('HISTORICAL_DECLARED') && list.includes('ORIGINAL'))
                for (const value of ['MONTHLY_ORIGINAL', 'MONTHLY_PERIOD'])
                    if (!list.includes(value))
                        list.push(value);
            if (list.includes('INPUT_INVALID') && list.includes('SERVICE_UNAVAILABLE'))
                for (const code of msErrors)
                    if (!list.includes(code))
                        list.push(code);
        }
        const props = obj['properties'];
        if (props && props['kind']?.['const'] && ['REGISTER', 'APPROVE'].includes(String(props['kind']['const'])))
            props['msHistoryReference'] = { type: 'string', pattern: '^[0-9a-f]{64}$' };
        if (props && props['originalExpectedInterest'] && !props['originalExpectedInterest']['anyOf'])
            props['originalExpectedInterest'] = { anyOf: [props['originalExpectedInterest'], { type: 'null' }] };
        if (props && props['expectedFutureInterest'] && !props['expectedFutureInterest']['anyOf'])
            props['expectedFutureInterest'] = { anyOf: [props['expectedFutureInterest'], { type: 'null' }] };
        for (const n of Object.values(obj))
            walk(n);
    };
    walk(document);
    return document;
}
export class MonthlyContract {
    document = msDocument();
    operations = new Map();
    checks = new Map();
    constructor() {
        const ajv = new Ajv2020({ strict: false, allErrors: true });
        formats.default(ajv);
        const components = this.document.components;
        for (const [name, schema] of Object.entries(components.schemas))
            this.checks.set(name, ajv.compile({ ...schema, components }));
        for (const [path, methods] of Object.entries(this.document.paths))
            for (const [method, definition] of Object.entries(methods)) {
                this.operations.set(definition.operationId, { path, method, definition });
                if (definition.requestBody)
                    this.checks.set(definition.operationId, ajv.compile({ ...definition.requestBody.content['application/json'].schema, components }));
                for (const [status, response] of Object.entries(definition.responses))
                    if (response.content)
                        this.checks.set(definition.operationId + ':' + status, ajv.compile({ ...response.content['application/json'].schema, components }));
            }
    }
    validate(name, value) { if (!this.checks.get(name)?.(value))
        throw new AppError(422, 'INPUT_INVALID'); }
    result(operation, value) { if (!this.checks.get(operation + ':200')?.(value))
        throw new AppError(503, 'SERVICE_UNAVAILABLE'); }
}
let instance;
export const monthlyContract = () => instance ??= new MonthlyContract();
export const msClasses = () => Object.fromEntries([...monthlyContract().operations.values()].filter(v => v.definition['x-mej-category'] !== 'READ_ONLY').map(v => [v.definition['x-purpose'], v.definition['x-mej-category']]));
export const isMsPurpose = (p) => typeof p === 'string' && Object.hasOwn(msClasses(), p);
export function msManagementDelta(document) {
    const walk = (v) => {
        if (!v || typeof v !== 'object')
            return;
        if (Array.isArray(v)) {
            for (const x of v)
                walk(x);
            return;
        }
        const o = v, p = o['properties'];
        if (p?.['businessOrganizationId'] && p['personalCashAccountId'])
            p['msDistributionId'] = { type: 'string', format: 'uuid' };
        if (p?.['category'] && p['description'] && (p['nominalDate'] || p['frequency'])) {
            p['msLabelId'] = { type: 'string', format: 'uuid' };
            p['msMappingVersion'] = { type: 'string', minLength: 1, maxLength: 80 };
        }
        for (const x of Object.values(o))
            walk(x);
    };
    walk(document);
    return document;
}
//# sourceMappingURL=ms-contract.js.map