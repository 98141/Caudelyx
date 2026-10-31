/* eslint-disable security/detect-object-injection -- Hash-pinned closed schema/operation maps. */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {Ajv2020,type ValidateFunction} from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import {AppError} from '../../shared/errors.js';
import type {Data} from './models.js';
interface Definition {operationId:string;parameters:{name:string;in:string;required:boolean;schema:object}[];requestBody?:{content:Record<string,{schema:object}>};responses:Record<string,{content?:Record<string,{schema:object}>}>;'x-purpose'?:string;'x-mej-category'?:'WORK_ONLY'|'BALANCE_60M'}
interface Spec {paths:Record<string,Record<string,Definition>>;components:{schemas:Record<string,object>};'x-purposes':Record<string,{category:'WORK_ONLY'|'BALANCE_60M';operations:string[]}>;'x-error-codes':string[];'x-limits':Record<string,number>;'x-report-columns':Record<string,string[]>}
// eslint-disable-next-line security/detect-non-literal-fs-filename -- Callers are fixed literal contract names; exact SHA256 is verified before parsing.
function pinned(file:string,digest:string){const bytes=readFileSync(resolve('../../Construccion/Sprints/S11/Contratos',file));if(createHash('sha256').update(bytes).digest('hex')!==digest)throw Error('Frozen S11 contract changed');return JSON.parse(bytes.toString('utf8'));}
export interface Column {name:string;type:string;required:boolean;maxLength:number;enum?:string[];nullable?:boolean;pattern?:string}
export const dictionary=()=>pinned('COLUMN_DICTIONARY_S11.json','e3db83426c8ed2482f142368fbc9aa8dc88fa6417dc785bb73f9c7ec11e898b7') as {sheets:{name:string;columns:Column[]}[];controlKeys:string[]};
export class ExchangeContract {
 readonly document=pinned('openapi-import-export-s11-p02.json','92d752d2a924a74c5f1d0439f6d029aa0f3927d3b51f9bb0076eb812c9b47729') as Spec;
 readonly operations=new Map<string,{path:string;method:string;definition:Definition}>();
 readonly checks=new Map<string,ValidateFunction>();readonly ajv=new Ajv2020({strict:false,validateFormats:true,allErrors:true});
 private readonly results=new Map<string,ValidateFunction>();
 private readonly definitions=new Map<string,object>();
 private readonly resultDefinitions=new Map<string,object>();
 constructor(){
  formats.default(this.ajv);
  for(const[name,schema]of Object.entries(this.document.components.schemas))this.definitions.set(name,{...schema,components:this.document.components});
  for(const[path,methods]of Object.entries(this.document.paths))for(const[method,definition]of Object.entries(methods)){
   this.operations.set(definition.operationId,{path,method,definition});const json=definition.requestBody?.content['application/json'];if(json)this.definitions.set(definition.operationId,{...json.schema,components:this.document.components});
   for(const[status,response]of Object.entries(definition.responses)){const schema=response.content?.['application/json']?.schema;if(schema)this.resultDefinitions.set(definition.operationId+':'+status,{...schema,components:this.document.components});}
  }
  this.definitions.set('Workbook',pinned('template-s11.schema.json','06fa04ecb7497183459d8a888173b7dff682cb53bb92a290321d2bdc921ba523') as object);
 }
 // A fresh bounded worker needs only its actual schemas, not every HTTP response.
 // Shapes/options stay identical; first-use compilation is cached per instance.
 private compiled(name:string,definitions:Map<string,object>,cache:Map<string,ValidateFunction>){
  let fn=cache.get(name);if(!fn){const schema=definitions.get(name);if(schema){fn=this.ajv.compile(schema);cache.set(name,fn);}}return fn;
 }
 validate(name:string,value:unknown){const fn=this.compiled(name,this.definitions,this.checks);if(!fn||!fn(value))throw new AppError(422,'INPUT_INVALID');}
 valid(name:string,value:unknown){return this.compiled(name,this.definitions,this.checks)?.(value)===true;}
 result(operation:string,status:number,value:unknown){if(!this.compiled(operation+':'+status,this.resultDefinitions,this.results)?.(value))throw new AppError(503,'SERVICE_UNAVAILABLE');}
 command(purpose:string,input:unknown):Data{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new AppError(422,'INPUT_INVALID');const c=input as Data;
  if(Object.keys(c).some(k=>!['operationId','idempotencyKey','resourceId','expectedETag','pathParameters','payload','bookId','organizationId'].includes(k)))throw new AppError(422,'INPUT_INVALID');
  const op=this.operations.get(String(c['operationId']));if(!op||op.definition['x-purpose']!==purpose)throw new AppError(422,'INPUT_INVALID');
  this.validate('Id',c['idempotencyKey']);if(c['expectedETag']!==undefined)this.validate('ETag',c['expectedETag']);
  const ps=c['pathParameters'];if(!ps||typeof ps!=='object'||Array.isArray(ps))throw new AppError(422,'INPUT_INVALID');const params=ps as Data,keys=op.definition.parameters.filter(p=>p.in==='path').map(p=>p.name);
  if(Object.keys(params).some(k=>!keys.includes(k))||keys.some(k=>!params[k]))throw new AppError(422,'INPUT_INVALID');for(const v of Object.values(params))this.validate('Id',v);
  if(this.definitions.has(String(c['operationId'])))this.validate(String(c['operationId']),c['payload']);return c;
 }
}
let singleton:ExchangeContract|undefined;
export const exchangeContract=()=>singleton??=new ExchangeContract();
export const isExchangePurpose=(v:unknown):v is string=>typeof v==='string'&&Object.hasOwn(exchangeContract().document['x-purposes'],v);
export const exchangeClass=(v:string)=>exchangeContract().document['x-purposes'][v]?.category;
export const isPersonalExchangeCommand=(p:unknown,c:Data|null|undefined)=>isExchangePurpose(p)&&typeof c?.['operationId']==='string'&&exchangeContract().operations.get(c['operationId'])?.path.startsWith('/me/')===true;

// Fixed P01 files only, verified against the approved immutable manifest before use.
export function templateDownloads(personal=false):Data[]{
 const manifest=pinned('../Evidencias/S11-P01-CONTRACT-HASHES.json','47fab524b76daa141756976a25614bb820a3b74d70ff1bc8a39b88eb87764f50') as {files:Record<string,string>};
 return [['blank','caudelyx-import-template'],['opening-600','opening-600'],['wealth-200m','wealth-200m'],['negative-cases','negative-cases']].filter((_,i)=>!personal||i===0).map(([id,name])=>{
  const filename=name+'.xlsx',relative='Construccion/Sprints/S11/Plantillas/v1.0.0/'+filename;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Name is selected only from the literal allowlist above, never request input.
  const bytes=readFileSync(resolve('../../',relative)),sha256=createHash('sha256').update(bytes).digest('hex');
  if(bytes.length>131072||sha256!==manifest.files[relative])throw new AppError(503,'SERVICE_UNAVAILABLE');
  return{id,templateVersion:'1.0.0',filename,mediaType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',bytes:bytes.length,sha256,contentBase64:bytes.toString('base64')};
 });
}
