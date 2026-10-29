import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {Ajv2020,type ValidateFunction} from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import {AppError} from '../../shared/errors.js';
interface Definition {operationId:string;parameters:{name:string;in:string;required?:boolean;schema:object}[];responses:Record<string,{content?:{'application/json':{schema:object}}}>}
export class ReportingContract{
 readonly document;readonly operations=new Map<string,{path:string;definition:Definition}>();readonly errors=new Set<string>();
 private readonly validators=new Map<string,ValidateFunction>();
 constructor(){
  const bytes=readFileSync(resolve('../../Construccion/Sprints/S09/Contratos/openapi-reporting-s09-p04.json'));
  if(createHash('sha256').update(bytes).digest('hex')!=='6ec30fadb8f35a867e81f1ed85787bb737396514aee22baaf44b8e67002e1628')throw Error('S08 reporting contract changed');
  this.document=JSON.parse(bytes.toString('utf8')) as {paths:Record<string,{get:Definition}>;components:{schemas:Record<string,object>}};
  const ajv=new Ajv2020({strict:false});formats.default(ajv);
  for(const[name,schema]of Object.entries(this.document.components.schemas)){this.validators.set(name,ajv.compile({...schema,components:this.document.components}));if(name.startsWith('Error')){const codes=(schema as {properties:{error:{properties:{code:{enum:string[]}}}}}).properties.error.properties.code.enum;for(const c of codes)this.errors.add(c);}}
  for(const[path,{get}]of Object.entries(this.document.paths)){
   this.operations.set(get.operationId,{path,definition:get});
   for(const p of get.parameters)this.validators.set(get.operationId+':'+p.name,ajv.compile({...p.schema,components:this.document.components}));
   const result=get.responses['200']!.content!['application/json'].schema;this.validators.set(get.operationId+':response',ajv.compile({...result,components:this.document.components}));
  }
 }
 validate(name:string,value:unknown,result=false){const validator=this.validators.get(name);if(!validator?.(value))throw new AppError(result?503:422,result?'SERVICE_UNAVAILABLE':'INPUT_INVALID');}
}
let singleton:ReportingContract|undefined;
export const reportingContract=()=>singleton??=new ReportingContract();
