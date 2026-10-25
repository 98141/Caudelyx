import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {Ajv2020,type ValidateFunction} from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import {AppError} from '../../shared/errors.js';
export const purposes=new Map([['publishBorrowerSchema','BORROWER_SCHEMA_PUBLISH'],['createBorrower','BORROWER_CREATE'],['replaceBorrower','BORROWER_REPLACE'],['deactivateBorrower','BORROWER_DEACTIVATE'],['reactivateBorrower','BORROWER_REACTIVATE'],['createLoanDraft','LOAN_DRAFT_CREATE'],['replaceLoanTerms','LOAN_TERMS_REPLACE'],['confirmLoanTerms','LOAN_TERMS_CONFIRM'],['cancelLoan','LOAN_CANCEL']]);
export const lendingPurposes=[...purposes.values()];
export const isLending=(p:unknown):p is string=>typeof p==='string'&&lendingPurposes.includes(p);
interface Operation {operationId:string;parameters:{name:string;in:string;required?:boolean;schema:object}[];requestBody?:{content:{'application/json':{schema:object}}};responses:Record<string,{content?:{'application/json':{schema:object}}}>}
export class LendingContract {
  readonly operations=new Map<string,{path:string;method:string;definition:Operation}>();
  readonly errors:Set<string>;
  private readonly schemas=new Map<string,ValidateFunction>();private readonly results=new Map<string,ValidateFunction>();
  constructor(){
    const bytes=readFileSync(resolve('../../Construccion/Sprints/S04/Contratos/openapi-lending-s04.json'));
    if(createHash('sha256').update(bytes).digest('hex')!=='f7b169834e83f403eb0b293a5ffa284f33434366af96e9d56c12dc799d467815')throw Error('S04 contract changed');
    const doc=JSON.parse(bytes.toString('utf8')) as {paths:Record<string,Record<string,Operation>>;components:{schemas:Record<string,object>}};
    // Owner-approved S05 compatibility overlay; frozen S04 bytes remain verified above.
    const err=doc.components.schemas['Error'] as {properties:{error:{properties:{code:{enum:string[]}}}}};err.properties.error.properties.code.enum.push('INTEGRITY_MISMATCH','RATE_LIMITED');
    const ajv=new Ajv2020({strict:false,validateFormats:true});formats.default(ajv);
    for(const [name,schema] of Object.entries(doc.components.schemas))this.schemas.set(name,ajv.compile({...schema,components:doc.components}));
    for(const [path,methods] of Object.entries(doc.paths))for(const [method,definition] of Object.entries(methods)){
      this.operations.set(definition.operationId,{path,method,definition});
      if(definition.requestBody)this.schemas.set(definition.operationId,ajv.compile({...definition.requestBody.content['application/json'].schema,components:doc.components}));
      for(const [status,r] of Object.entries(definition.responses))if(r.content)this.results.set(definition.operationId+':'+status,ajv.compile({...r.content['application/json'].schema,components:doc.components}));
    }
    const error=doc.components.schemas['Error'] as {properties:{error:{properties:{code:{enum:string[]}}}}};this.errors=new Set(error.properties.error.properties.code.enum);
  }
  validate(name:string,value:unknown){if(!this.schemas.get(name)?.(value))throw new AppError(422,'INPUT_INVALID');}
  result(op:string,status:number,value:unknown){if(!this.results.get(op+':'+status)?.(value))throw new AppError(503,'SERVICE_UNAVAILABLE');}
  intent(purpose:string,resourceId:string|null,command:unknown){this.validate('ReauthenticationIntentS04',{purpose,resourceId,command});}
  auth(value:Record<string,unknown>){const {password,...intent}=value;if(typeof password!=='string'||password.length<15||password.length>128)throw new AppError(422,'INPUT_INVALID');this.validate('ReauthenticationIntentS04',{...intent,resourceId:intent['resourceId']??null});}
}
let cached:LendingContract|undefined;
export const lendingContract=()=>cached??=new LendingContract();
export function canonical(value:unknown,key=''):unknown{
  if(Array.isArray(value))return value.map(v=>canonical(v));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v,k)]));
  if(typeof value==='string'){
    if((key==='id'||key.endsWith('Id')||key==='idempotencyKey'||['organizationEpoch','actorAuthzVersion','actorAuthEpoch','credentialVersion'].includes(key))&&/^(?:[0-9a-f]{8}-[0-9a-f-]{27})$/i.test(value))return value.toLowerCase();
    const s=value.trim().normalize('NFC');return key==='borrowerCode'||key==='number'?s.toUpperCase():s;
  }return value;
}
export const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const uuid=(v:unknown):string=>{lendingContract().validate('Id',v);return v as string;};
