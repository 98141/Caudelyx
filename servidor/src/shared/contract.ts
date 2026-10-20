import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { AppError } from './errors.js';

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
    const path = resolve(root, 'Construccion/docs/contratos/openapi-auth.yaml');
    const contract = parse(readFileSync(path, 'utf8')) as Contract;
    const addendumBytes = readFileSync(resolve(root, 'Construccion/Sprints/S01/Evidencias/S01-P04-v2-API-ADDENDUM.json'));
    if (createHash('sha256').update(addendumBytes).digest('hex') !== '2e08b418095b5c3dc15a57420f9374d1a846c2f386d815fa6cd8fb4d2e7caea8') throw new Error('Approved A09 addendum changed');
    const addendum = JSON.parse(addendumBytes.toString('utf8')) as { resultSchema: object };
    const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: true });
    formats.default(ajv);
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
    const operation = this.operations.get(id);
    if (!operation) throw new Error('Unknown contract operation');
    if (operation.validate && !operation.validate(body)) throw new AppError(422, 'INPUT_INVALID');
  }
  validateResult(id: string, status: number, body: unknown): void {
    const validate = this.results.get(`${id}:${status}`);
    if (validate && !validate(body)) throw new AppError(503, 'SERVICE_UNAVAILABLE');
  }
}
