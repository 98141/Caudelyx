import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { AppError } from '../../shared/errors.js';
import {openingContract} from '../opening/contract.js';
import {operationsContract} from '../lending/operations-contract.js';

export const financePurposes = ['FINANCE_ACCOUNT_CREATE','FINANCE_ACCOUNT_UPDATE','FINANCE_JOURNAL_POST','FINANCE_TRANSFER','FINANCE_JOURNAL_REVERSE'];
export const isFinancial = (purpose: unknown): purpose is string => typeof purpose === 'string' && financePurposes.includes(purpose);
interface Operation {operationId: string; requestBody?: {content: {'application/json': {schema: object}}}; responses: Record<string,{content?: {'application/json': {schema: object}}}>; parameters?: {name:string;in:string;required?:boolean;schema:object}[]}
export class FinanceContract {
  readonly operations = new Map<string,{path:string;method:string;definition:Operation}>();
  private readonly schemas = new Map<string,ValidateFunction>();
  private readonly results = new Map<string,ValidateFunction>();
  constructor() {
    const bytes = readFileSync(resolve('../../Construccion/Sprints/S02/Contratos/openapi-finance-s02.yaml'));
    if (createHash('sha256').update(bytes).digest('hex') !== 'e94743580b8ba587814d882bf492f636979bf76b6e96f46d3fd8a5b5db5dc729') throw new Error('P01 financial contract changed');
    const document = parse(bytes.toString('utf8')) as {paths:Record<string,Record<string,Operation>>;components:{schemas:Record<string,object>}};
    const ajv = new Ajv2020({strict:false,validateFormats:true}); formats.default(ajv);
    for (const [name,schema] of Object.entries(document.components.schemas)) this.schemas.set(name,ajv.compile({...schema,components:document.components}));
    for (const [path,methods] of Object.entries(document.paths)) for (const [method,definition] of Object.entries(methods)) {
      this.operations.set(definition.operationId,{path,method,definition});
      if (definition.requestBody) this.schemas.set(definition.operationId,ajv.compile({...definition.requestBody.content['application/json'].schema,components:document.components}));
      for (const [status,response] of Object.entries(definition.responses)) if(response.content) this.results.set(`${definition.operationId}:${status}`,ajv.compile({...response.content['application/json'].schema,components:document.components}));
    }
  }
  validate(name:string,value:unknown):void {
    const check = this.schemas.get(name);
    if (!check || !check(value)) throw new AppError(422,'INPUT_INVALID');
  }
  result(id:string,status:number,value:unknown):void {
    if(status===409&&value&&typeof value==='object'&&'error'in value&&['DOMAIN_ACCOUNT_PROTECTED','DOMAIN_REVERSAL_FORBIDDEN'].includes(String((value.error as {code?:string}).code))){operationsContract().validate('Error',value);return;}
    const overlay=new Map([['readJournal','JournalResponseS03'],['listJournals','JournalPageS03'],['postJournal','JournalResponseS03'],['createTransfer','JournalResponseS03'],['reverseJournal','JournalResponseS03']]).get(id);
    if(overlay&&[200,201].includes(status)){openingContract().validate(overlay,value);return;}
    if(status===409&&value&&typeof value==='object'&&'error'in value){
      const code=(value.error as {code?:string})?.code;
      if(code==='OPENING_IMMUTABLE'||code==='OPENING_CUTOFF_CONFLICT'){openingContract().validate('Error',value);return;}
    }
    const check=this.results.get(`${id}:${status}`);
    if(!check || !check(value)) throw new AppError(503,'SERVICE_UNAVAILABLE');
  }
}
let shared:FinanceContract|undefined;
export const financeContract = () => shared ??= new FinanceContract();
export function canonical(value:unknown):unknown {
  if(Array.isArray(value)) return value.map(canonical);
  if(value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
  if(typeof value === 'string') {
    if(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) return value.toLowerCase();
    return value.trim().normalize('NFC');
  }
  return value;
}
