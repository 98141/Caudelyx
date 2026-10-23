import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {Ajv2020,type ValidateFunction} from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import {AppError} from '../../shared/errors.js';

export const openingPurposes=['OPENING_CREATE','OPENING_REPLACE','OPENING_VALIDATE','OPENING_APPROVE','OPENING_CANCEL','OPENING_COMMIT'];
export const isOpening=(p:unknown):p is string=>typeof p==='string'&&openingPurposes.includes(p);
export const purposes=new Map([['createOpening','OPENING_CREATE'],['replaceOpening','OPENING_REPLACE'],['validateOpening','OPENING_VALIDATE'],['approveOpening','OPENING_APPROVE'],['cancelOpening','OPENING_CANCEL'],['commitOpening','OPENING_COMMIT']]);
interface Parameter {name:string;in:string;required?:boolean;schema:object}
interface Operation {operationId:string;parameters:Parameter[];requestBody?:{content:{'application/json':{schema:object}}};responses:Record<string,{content?:{'application/json':{schema:object}}}>}
export class OpeningContract {
  readonly operations=new Map<string,{path:string;method:string;definition:Operation}>();
  private readonly schemas=new Map<string,ValidateFunction>();
  private readonly results=new Map<string,ValidateFunction>();
  constructor(){
    const bytes=readFileSync(resolve('../../Construccion/Sprints/S03/Contratos/openapi-opening-s03.json'));
    if(createHash('sha256').update(bytes).digest('hex')!=='51978d457cf3d4f1a3aea91ae7a8c7a5b2e2782dc3dea7a7475f314067e4f016')throw Error('Frozen S03 contract changed');
    const doc=JSON.parse(bytes.toString('utf8')) as {paths:Record<string,Record<string,Operation>>;components:{schemas:Record<string,object>}};
    const ajv=new Ajv2020({strict:false,validateFormats:true});formats.default(ajv);
    for(const [name,schema] of Object.entries(doc.components.schemas))this.schemas.set(name,ajv.compile({...schema,components:doc.components}));
    for(const [path,methods] of Object.entries(doc.paths))for(const [method,definition] of Object.entries(methods)){
      this.operations.set(definition.operationId,{path,method,definition});
      if(definition.requestBody)this.schemas.set(definition.operationId,ajv.compile({...definition.requestBody.content['application/json'].schema,components:doc.components}));
      for(const [status,r] of Object.entries(definition.responses))if(r.content)this.results.set(`${definition.operationId}:${status}`,ajv.compile({...r.content['application/json'].schema,components:doc.components}));
    }
  }
  validate(name:string,value:unknown){if(!this.schemas.get(name)?.(value))throw new AppError(422,'INPUT_INVALID');}
  result(operation:string,status:number,value:unknown){if(!this.results.get(`${operation}:${status}`)?.(value))throw new AppError(503,'SERVICE_UNAVAILABLE');}
  intent(purpose:string,resourceId:string|null,command:unknown){this.validate('OpeningReauthenticationIntent',{purpose,command,...(resourceId?{resourceId}:{})});}
  auth(value:unknown){
    if(!value||typeof value!=='object')throw new AppError(422,'INPUT_INVALID');
    const {password,...intent}=value as Record<string,unknown>;
    if(typeof password!=='string'||password.length<15||password.length>128)throw new AppError(422,'INPUT_INVALID');
    this.validate('OpeningReauthenticationIntent',intent);
  }
}
let shared:OpeningContract|undefined;
export const openingContract=()=>shared??=new OpeningContract();
export function canonicalOpening(value:unknown):unknown{
  if(Array.isArray(value))return value.map(canonicalOpening);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonicalOpening(v)]));
  if(typeof value==='string')return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)?value.toLowerCase():value.trim().normalize('NFC');
  return value;
}
