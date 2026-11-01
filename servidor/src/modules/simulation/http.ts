/* eslint-disable security/detect-object-injection -- Closed OpenAPI route/parameter catalog. JSON duplicate-key scanner never evaluates code. */
import express from 'express';
import {TLSSocket} from 'node:tls';
import type {IdentityService} from '../identity/service.js';
import type {Config} from '../../shared/config.js';
import {AppError} from '../../shared/errors.js';
import {simulationContract} from './contract.js';
import type {Data} from './models.js';
const invalid=():never=>{throw new AppError(422,'INPUT_INVALID');};
export function uniqueJson(text:string):unknown{
 let i=0,nodes=0;const ws=()=>{while(i<text.length&&/[\t\n\r ]/.test(text[i]!))i++;};
 const str=()=>{const start=i;if(text[i++]!=='"')invalid();while(i<text.length){const c=text[i++];if(c==='"')return JSON.parse(text.slice(start,i)) as string;if(c==='\\')i++;}return invalid();};
 const value=(depth:number):void=>{ws();if(depth>64||++nodes>100000)invalid();const c=text[i];
  if(c==='{'){i++;ws();const keys=new Set<string>();if(text[i]==='}'){i++;return;}while(i<text.length){ws();const key=str();if(keys.has(key))invalid();keys.add(key);ws();if(text[i++]!==':')invalid();value(depth+1);ws();if(text[i]==='}'){i++;return;}if(text[i++]!==',')invalid();}invalid();}
  else if(c==='['){i++;ws();if(text[i]===']'){i++;return;}while(i<text.length){value(depth+1);ws();if(text[i]===']'){i++;return;}if(text[i++]!==',')invalid();}invalid();}
  else if(c==='"')str();else{
   // eslint-disable-next-line security/detect-unsafe-regex -- Anchored JSON primitive token, bounded by the independent 256 KiB body limit.
   const match=/^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i));if(!match)invalid();i+=match![0].length;}
 };
 try{value(0);ws();if(i!==text.length)invalid();return JSON.parse(text) as unknown;}catch{invalid();}
}
export function simulationRouter(identity:IdentityService,config:Config){
 const router=express.Router(),contract=simulationContract(),json=express.raw({type:'application/json',limit:262144,inflate:false});
 for(const[operation,{path,method,definition}]of contract.operations){
  const parameters=definition.parameters.map(p=>({...p,validate:contract.validator('HTTP:'+operation+':'+p.name,p.schema)}));
  router.all('/api/v1'+path.replace(/\{([^}]+)\}/g,':$1'),async(req,res,next)=>{
   if(req.method.toLowerCase()!==method)return next();
   try{
    if(!(req.socket instanceof TLSSocket)||!req.socket.encrypted||req.headers.host!==new URL(config.tenantOrigin).host)throw new AppError(403,'ACCESS_DENIED');
    await identity.requireOpen('TENANT');const cookies=(req.headers.cookie??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith('__Host-caudelyx-session='));
    if(cookies.length!==1)throw new AppError(401,'AUTH_INVALID');
    const token=cookies[0]!.slice('__Host-caudelyx-session='.length),context=path.startsWith('/me/')?await identity.sessions.findPersonal(token):await identity.sessions.find(token,'TENANT');
    if(!context)throw new AppError(401,'AUTH_INVALID');
    if(method==='post'){if(req.headers.origin!==config.tenantOrigin||req.headers['sec-fetch-site']==='cross-site')throw new AppError(400,'CSRF_INVALID');identity.sessions.checkCsrf(context,req.get('X-CSRF-Token'));}
    if(Object.keys(req.query).some(k=>!parameters.some(p=>p.in==='query'&&p.name===k)))invalid();
    for(const p of parameters){const raw=p.in==='path'?req.params[p.name]:p.in==='query'?req.query[p.name]:req.get(p.name);if(raw===undefined){if(p.required)throw new AppError(p.name==='If-Match'?428:422,p.name==='If-Match'?'ETAG_REQUIRED':'INPUT_INVALID');continue;}if(!p.validate(['limit','versionNumber'].includes(p.name)&&typeof raw==='string'&&/^[1-9][0-9]*$/.test(raw)?Number(raw):raw))invalid();}
    let input:Data={};
    if(method==='post'){
     if(!req.is('application/json')||req.get('Content-Encoding')&&req.get('Content-Encoding')!=='identity')invalid();
     await new Promise<void>((resolve,reject)=>json(req,res,error=>error?reject(error):resolve()));
     if(!Buffer.isBuffer(req.body))invalid();let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(req.body as Buffer);}catch{invalid();}
     input=uniqueJson(text!) as Data;contract.body(operation,input);
    }else if(req.headers['transfer-encoding']||Number(req.get('Content-Length')??0)>0)invalid();
    const params=Object.fromEntries(Object.entries(req.params).map(([k,v])=>{if(typeof v!=='string')invalid();return[k,v as string];})),service=identity.simulation;
    if(!service)throw new AppError(503,'SERVICE_UNAVAILABLE');
    const result=await service!.execute(context,operation,input,params,req.query,req.get('Idempotency-Key')??'',req.get('If-Match')),response={data:result.data,requestId:res.locals['requestId']};
    contract.result(operation,result.status,response);if(result.etag)res.set('ETag',result.etag);res.status(result.status).json(response);
   }catch(error){
    const e=error instanceof AppError?error:error instanceof Error&&'type'in error&&error.type==='entity.too.large'?new AppError(413,'SIMULATION_SCOPE_TOO_LARGE'):error instanceof SyntaxError||error instanceof Error&&'type'in error?new AppError(422,'INPUT_INVALID'):new AppError(503,'SERVICE_UNAVAILABLE');
    const allowed=(contract.document.components.schemas['ErrorEnvelope'] as {properties:{error:{properties:{code:{enum:string[]}}}}}).properties.error.properties.code.enum,code=allowed.includes(e.code)?e.code:'SERVICE_UNAVAILABLE';
    if(e.status===429)res.set('Retry-After','60');res.status(code==='SERVICE_UNAVAILABLE'?503:e.status).json({error:{code,message:'No se pudo completar la solicitud.',details:null},requestId:res.locals['requestId']});
   }
  });
 }
 return router;
}
