/* eslint-disable security/detect-object-injection -- Fixed pinned contract; closed operation/schema catalogs only. */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {Ajv2020,type ValidateFunction} from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import {AppError} from '../../shared/errors.js';
import type {Data} from './models.js';
import {fraction} from './money.js';
export function normalizeHypotheses(input:Data):Data{
 const value=structuredClone(input),text=(v:unknown)=>{const n=fraction(v);return(n/1000000n)+'.'+(n%1000000n).toString().padStart(6,'0');};
 for(const a of (value['assumptions']??[]) as Data[])for(const k of ['collectionFraction','recoveryFraction'])a[k]=text(a[k]);
 for(const a of (value['alternatives']??[]) as Data[])for(const k of ['ownershipFraction','vacancyFraction'])if(a[k]!==undefined)a[k]=text(a[k]);
 const sample=value['sensitivity'] as Data|null|undefined;
 if(sample&&['COLLECTION_FRACTION','VACANCY_FRACTION'].includes(String(sample['parameter'])))sample['values']=(sample['values'] as unknown[]).map(text);
 return value;
}
export const purposes=['SIM_BASE_CAPTURE','SIM_SCENARIO_CREATE','SIM_SCENARIO_VERSION','SIM_SCENARIO_ARCHIVE','SIM_RUN_START','SIM_RUN_CANCEL','SIM_COMPARE','ALERT_EVALUATE','ALERT_ACK'] as const;
export const isSimulationPurpose=(value:unknown):value is typeof purposes[number]=>typeof value==='string'&&purposes.some(p=>p===value);
export interface Definition {operationId:string;parameters:{name:string;in:string;required:boolean;schema:object}[];requestBody?:{content:Record<string,{schema:object}>};responses:Record<string,{content?:Record<string,{schema:object}>}>;'x-purpose'?:string;'x-scope':'BUSINESS'|'PERSONAL'|'CONSOLIDATED'}
interface Document {paths:Record<string,Record<string,Definition>>;components:{schemas:Record<string,object>};'x-limits':Record<string,number>}
export class SimulationContract {
 readonly document:Document;
 readonly operations=new Map<string,{path:string;method:string;definition:Definition}>();
 private readonly checks=new Map<string,ValidateFunction>();private readonly ajv=new Ajv2020({strict:false,allErrors:true,validateFormats:true});
 constructor(){
  const raw=readFileSync(resolve('../../Construccion/Sprints/S13/Contratos/openapi-simulation-alerts-s13-p01.json'));
  if(createHash('sha256').update(raw).digest('hex')!=='9d73fa2cc8a78c05b5b0780676d35750c64c8eafa5398fa18a248b438b299dc7')throw Error('S13 simulation contract changed');
  this.document=JSON.parse(raw.toString('utf8')) as Document;formats.default(this.ajv);
  for(const[path,methods]of Object.entries(this.document.paths))for(const[method,definition]of Object.entries(methods))this.operations.set(definition.operationId,{path,method,definition});
 }
 validator(name:string,schema?:object){let check=this.checks.get(name);if(!check){const target=schema??this.document.components.schemas[name];if(!target)throw new AppError(422,'INPUT_INVALID');check=this.ajv.compile({...target,components:this.document.components});this.checks.set(name,check);}return check;}
 validate(name:string,value:unknown){if(!this.validator(name)(value))throw new AppError(422,'INPUT_INVALID');}
 body(operationId:string,value:unknown){const op=this.operations.get(operationId),schema=op?.definition.requestBody?.content['application/json']?.schema;if(!schema||!this.validator(operationId,schema)(value))throw new AppError(422,'INPUT_INVALID');}
 result(operationId:string,status:number,value:unknown){const schema=this.operations.get(operationId)?.definition.responses[String(status)]?.content?.['application/json']?.schema;if(!schema||!this.validator(operationId+':'+status,schema)(value))throw new AppError(503,'SERVICE_UNAVAILABLE');}
 command(purpose:string,input:unknown){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new AppError(422,'INPUT_INVALID');const c=input as Data;
  if(Object.keys(c).some(k=>!['operationId','idempotencyKey','resourceId','expectedETag','pathParameters','payload','bookId','organizationId'].includes(k)))throw new AppError(422,'INPUT_INVALID');
  const op=this.operations.get(String(c['operationId']));if(!op||op.definition['x-purpose']!==purpose)throw new AppError(422,'INPUT_INVALID');
  this.validate('Id',c['idempotencyKey']);if(c['resourceId']!==undefined&&c['resourceId']!==null)this.validate('Id',c['resourceId']);if(c['expectedETag']!==undefined)this.validate('ETag',c['expectedETag']);
  const ps=c['pathParameters'];if(!ps||typeof ps!=='object'||Array.isArray(ps))throw new AppError(422,'INPUT_INVALID');const params=ps as Data,path=op.definition.parameters.filter(p=>p.in==='path');
  if(Object.keys(params).some(k=>!path.some(p=>p.name===k))||path.some(p=>params[p.name]===undefined||!this.validator('param:'+op.definition.operationId+':'+p.name,p.schema)(params[p.name])))throw new AppError(422,'INPUT_INVALID');
  this.body(String(c['operationId']),c['payload']);return c;
 }
}
let singleton:SimulationContract|undefined;
export const simulationContract=()=>singleton??=new SimulationContract();
export const isPersonalSimulationCommand=(purpose:unknown,command:Data|null|undefined)=>isSimulationPurpose(purpose)&&typeof command?.['operationId']==='string'&&simulationContract().operations.get(command['operationId'])?.path.startsWith('/me/')===true;
