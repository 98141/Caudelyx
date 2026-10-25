/* eslint-disable security/detect-object-injection -- Array indices come from the four closed operation/purpose tables; unknown purpose never grants a permission. */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {Ajv2020,type ValidateFunction} from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import {AppError} from '../../shared/errors.js';
export const operationPurposes=['LOAN_DISBURSE','LOAN_ACCRUE','LOAN_RECEIPT_POST','LOAN_CREDIT_APPLY'];
export const isOperation=(v:unknown):v is string=>typeof v==='string'&&operationPurposes.includes(v);
export const operationKinds=new Map([['disburseLoan','DISBURSE'],['accrueLoanInterest','ACCRUE'],['postLoanReceipt','RECEIPT'],['applyBorrowerCredit','APPLY_CREDIT']]);
export const operationPurpose=new Map([...operationKinds.keys()].map((op,i)=>[op,operationPurposes[i]!]));
interface Operation {operationId:string;parameters:{name:string;in:string;required?:boolean;schema:object}[];requestBody?:{content:{'application/json':{schema:object}}};responses:Record<string,{content?:{'application/json':{schema:object}}}>}
interface Spec {paths:Record<string,Record<string,Operation>>;components:{schemas:Record<string,object>}}
export function operationsDocument(){
  const bytes=readFileSync(resolve('../../Construccion/Sprints/S05/Contratos/openapi-operations-s05.json'));
  if(createHash('sha256').update(bytes).digest('hex')!=='dd7d7f1c634b4c1b7c9498f62f9a99d06425da2d43081c3898517c79fb654be0')throw Error('S05 approved contract changed');
  return JSON.parse(bytes.toString('utf8')) as Spec;
}
export class OperationsContract {
  readonly operations=new Map<string,{path:string;method:string;definition:Operation}>();
  readonly errors:Set<string>;
  private readonly schemas=new Map<string,ValidateFunction>();private readonly results=new Map<string,ValidateFunction>();
  constructor(){
    const doc=operationsDocument(),ajv=new Ajv2020({strict:false,validateFormats:true});formats.default(ajv);
    for(const[n,schema]of Object.entries(doc.components.schemas))this.schemas.set(n,ajv.compile({...schema,components:doc.components}));
    for(const[path,methods]of Object.entries(doc.paths))for(const[method,definition]of Object.entries(methods)){
      this.operations.set(definition.operationId,{path,method,definition});
      if(definition.requestBody)this.schemas.set(definition.operationId,ajv.compile({...definition.requestBody.content['application/json'].schema,components:doc.components}));
      for(const[status,r]of Object.entries(definition.responses))if(r.content)this.results.set(definition.operationId+':'+status,ajv.compile({...r.content['application/json'].schema,components:doc.components}));
    }
    this.errors=new Set((doc.components.schemas['Error'] as {properties:{error:{properties:{code:{enum:string[]}}}}}).properties.error.properties.code.enum);
  }
  validate(n:string,v:unknown){if(!this.schemas.get(n)?.(v))throw new AppError(422,'INPUT_INVALID');}
  result(op:string,status:number,v:unknown){if(!this.results.get(op+':'+status)?.(v))throw new AppError(503,'SERVICE_UNAVAILABLE');}
  intent(purpose:string,resourceId:string|null,command:unknown){const index=operationPurposes.indexOf(purpose),kind=[...operationKinds.values()][index];if(!kind)throw new AppError(422,'INPUT_INVALID');this.validate(kind+'ReauthenticationIntent',{purpose,resourceId,command});}
  auth(v:Record<string,unknown>){const{password,...intent}=v;if(typeof password!=='string'||password.length<15||password.length>128)throw new AppError(422,'INPUT_INVALID');const kind=[...operationKinds.values()][operationPurposes.indexOf(String(v['purpose']))];this.validate(kind+'ReauthenticationIntent',intent);}
}
let cached:OperationsContract|undefined;
export const operationsContract=()=>cached??=new OperationsContract();
