import {workContract} from '../modules/sessions/work-policy.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { AppError } from './errors.js';
import { financeContract, financePurposes, isFinancial } from '../modules/finance/contract.js';
import {openingContract,openingPurposes,isOpening} from '../modules/opening/contract.js';
import {lendingContract,lendingPurposes,isLending} from '../modules/lending/contract.js';
import {operationsContract,operationPurposes,isOperation} from '../modules/lending/operations-contract.js';

interface Operation {
  operationId: string;
  requestBody?: { content: { 'application/json': { schema: object } } };
  responses: Record<string, { content?: { 'application/json': { schema: object } } }>;
}
interface Contract { paths: Record<string, Record<string, Operation>>; components: object }

export class FrozenContract {
  readonly operations = new Map<string, { method: string; path: string; validate: ValidateFunction | null }>();
  private readonly results = new Map<string, ValidateFunction>();
  constructor() {
    const root = resolve('../..');
    const manifestPath = resolve(root, 'Construccion/Sprints/S01/Evidencias/S01-P01-BASELINE-v0.9.json');
    // Fixed repository paths; no paths derived from HTTP input.
    const manifestBytes = readFileSync(manifestPath);
    if (createHash('sha256').update(manifestBytes).digest('hex') !== 'd7bdc7f1023e043292315e048508aff73aa3d14ba829d87f053b1929d02d8935') throw new Error('Frozen baseline changed');
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as { sources: { path: string; sha256: string }[] };
    for (const source of manifest.sources) {
      // Manifest is trusted only after verifying its literal expected SHA256 above.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      if (createHash('sha256').update(readFileSync(resolve(root, source.path))).digest('hex') !== source.sha256) throw new Error('Frozen source changed');
    }
    // Explicit owner-authorized local candidate layered on the unchanged0.9
    // baseline. This is not a new frozen baseline or independent acceptance.
    const candidateBytes = readFileSync(resolve(root, 'Construccion/Sprints/S01/Evidencias/S01-P04-v4-API-v0.11-CANDIDATE.json'));
    if (createHash('sha256').update(candidateBytes).digest('hex') !== '95b913a919aab17952f955ec2083b69ff0c22dba410df17f4bc6dcaf0ef30b92') throw new Error('Profile API candidate changed');
    const candidate = JSON.parse(candidateBytes.toString('utf8')) as {sources:{path:string;sha256:string}[]};
    for (const source of candidate.sources) {
      // Expected candidate manifest has a literal hash above; paths are not HTTP input.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      if (createHash('sha256').update(readFileSync(resolve(root, source.path))).digest('hex') !== source.sha256) throw new Error('Profile API source changed');
    }
    const path = resolve(root, 'Construccion/docs/contratos/openapi-auth-v0.11-review.yaml');
    const contract = parse(readFileSync(path, 'utf8')) as Contract;
    // Owner-approved AJ-ONB overlay; historical baseline/candidate bytes are still verified above.
    const onboardingBytes=readFileSync(resolve(root,'Construccion/Sprints/AJ-ONB/Contratos/openapi-auth-aj-onb-v1.json'));
    if(createHash('sha256').update(onboardingBytes).digest('hex')!=='d482383816f57103af9c0241a56874e55f3813789495df29f9e653c1d7946d21')throw new Error('Onboarding contract changed');
    const onboarding=JSON.parse(onboardingBytes.toString('utf8')) as Contract;
    // eslint-disable-next-line security/detect-object-injection -- Keys originate only from the hash-verified repository contract above.
    for(const [path,methods]of Object.entries(onboarding.paths))contract.paths[path]={...contract.paths[path],...methods};
    const currentComponents=contract.components as Record<string,object>;
    // eslint-disable-next-line security/detect-object-injection -- Component names are from the same hash-verified contract, never HTTP.
    for(const [name,entries]of Object.entries(onboarding.components))currentComponents[name]={...currentComponents[name],...entries};
    // Additive S02 candidate only in memory; canonical S1 documents/hashes stay intact.
    const extendPurposes = (node:unknown):void => {
      if(!node || typeof node!=='object')return;
      if(Array.isArray(node)){for(const child of node)extendPurposes(child);return;}
      const record=node as Record<string,unknown>;
      if(Array.isArray(record['enum'])&&record['enum'].includes('ORGANIZATION_CREATE'))record['enum']=[...record['enum'],...financePurposes,...openingPurposes,...lendingPurposes,...operationPurposes];
      else if(Array.isArray(record['enum'])&&record['enum'].includes('ORGANIZATION_EDIT'))record['enum']=[...record['enum'],'FINANCE_ACCOUNT_UPDATE','FINANCE_JOURNAL_REVERSE',...openingPurposes.filter(p=>p!=='OPENING_CREATE'),...lendingPurposes.filter(p=>!['BORROWER_SCHEMA_PUBLISH','BORROWER_CREATE','LOAN_DRAFT_CREATE'].includes(p)),...operationPurposes];
      for(const child of Object.values(record))extendPurposes(child);
    };
    extendPurposes(contract.components);
    const addendumBytes = readFileSync(resolve(root, 'Construccion/Sprints/S01/Evidencias/S01-P04-v2-API-ADDENDUM.json'));
    if (createHash('sha256').update(addendumBytes).digest('hex') !== '2e08b418095b5c3dc15a57420f9374d1a846c2f386d815fa6cd8fb4d2e7caea8') throw new Error('Approved A09 addendum changed');
    const addendum = JSON.parse(addendumBytes.toString('utf8')) as { resultSchema: object };
    const mej=workContract();
    const composed=contract.components as {schemas:Record<string,Record<string,unknown>>};
    // eslint-disable-next-line security/detect-object-injection -- Names are a fixed server-owned schema allowlist.
    for(const name of ['OnbBasicMe','OnbBasicData']){const node=composed.schemas[name];if(node)(node['properties'] as Record<string,unknown>)['session']=mej.reference('SessionMeta');}
    composed.schemas['OwnProfile']=structuredClone(composed.schemas['OnbOwnProfile']!);
    for(const path of Object.values(contract.paths))for(const operation of Object.values(path)){
      if(['A05','A07','A27'].includes(operation.operationId)){
        const response=operation.responses['200']?.content?.['application/json'];
        if(response)response.schema={anyOf:[response.schema,mej.reference('WorkResult')]};
      }
      if(['A22','A24'].includes(operation.operationId)&&operation.requestBody){const request=operation.requestBody.content['application/json'];request.schema={anyOf:[request.schema,mej.reference('FirstEnrollmentInput')]};}
      if(operation.operationId==='A20'&&operation.requestBody)operation.requestBody.content['application/json'].schema={type:'object',additionalProperties:false,properties:{newPassword:{$ref:'#/components/schemas/Password'},currentPassword:{$ref:'#/components/schemas/Password'}},required:['newPassword']};
    }
    const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: true });
    formats.default(ajv);mej.install(ajv);
    for (const [path, methods] of Object.entries(contract.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const schema = operation.requestBody?.content['application/json'].schema;
        const validate = schema ? ajv.compile({ ...schema, components: contract.components }) : null;
        this.operations.set(operation.operationId, { method, path, validate });
        for (const [status, response] of Object.entries(operation.responses)) {
          const schema = response.content?.['application/json'].schema;
          if (schema) this.results.set(`${operation.operationId}:${status}`, ajv.compile({ ...(operation.operationId === 'A09' && status === '200' ? addendum.resultSchema : schema), components: contract.components }));
        }
      }
    }
  }
  validate(id: string, body: unknown): void {
    if(id==='A32'&&body&&typeof body==='object'&&'purpose'in body&&isOperation(body.purpose)){operationsContract().auth(body as Record<string,unknown>);return;}
    if(id==='A32'&&body&&typeof body==='object'&&'purpose'in body&&isLending(body.purpose)){lendingContract().auth(body as Record<string,unknown>);return;}
    if(id==='A32'&&body&&typeof body==='object'&&'purpose'in body&&isOpening(body.purpose)){openingContract().auth(body);return;}
    if(id==='A32'&&body&&typeof body==='object'&&'purpose' in body&&isFinancial(body.purpose)){
      financeContract().validate('FinancialReauthentication',body);return;
    }
    const operation = this.operations.get(id);
    if (!operation) throw new Error('Unknown contract operation');
    if (operation.validate && !operation.validate(body)) throw new AppError(422, 'INPUT_INVALID');
  }
  validateResult(id: string, status: number, body: unknown): void {
    const validate = this.results.get(`${id}:${status}`);
    if (validate && !validate(body)) throw new AppError(503, 'SERVICE_UNAVAILABLE');
  }
}
