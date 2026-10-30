import express from 'express';
import {TLSSocket} from 'node:tls';
import {Ajv2020} from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import type {IdentityService} from '../identity/service.js';
import type {Config} from '../../shared/config.js';
import {AppError} from '../../shared/errors.js';
import {wealthContract} from './contract.js';
export function wealthRouter(identity:IdentityService,config:Config){
 const router=express.Router(),contract=wealthContract(),a=new Ajv2020({strict:false});formats.default(a);
 for(const[op,{path,method,definition}]of contract.operations){
  const parameters=definition.parameters.map(p=>({...p,validate:a.compile({...p.schema,components:contract.document.components})}));
  router.all('/api/v1'+path.replace(/\{([^}]+)\}/g,':$1'),async(req,res,next)=>{
   if(req.method.toLowerCase()!==method)return next();
   try{
    if(!(req.socket instanceof TLSSocket)||!req.socket.encrypted||req.headers.host!==new URL(config.tenantOrigin).host)throw new AppError(403,'ACCESS_DENIED');
    await identity.requireOpen('TENANT');const cookies=(req.headers.cookie??'').split(';').map(c=>c.trim()).filter(c=>c.startsWith('__Host-caudelyx-session='));if(cookies.length!==1)throw new AppError(401,'AUTH_INVALID');
    const token=cookies[0]!.slice('__Host-caudelyx-session='.length),context=path.startsWith('/me/')?await identity.sessions.findPersonal(token):await identity.sessions.find(token,'TENANT');if(!context)throw new AppError(401,'AUTH_INVALID');
    if(!identity.wealth)throw new AppError(503,'SERVICE_UNAVAILABLE');
    if(method==='get'){if((res.locals['jsonBodyBytes']??(req.headers['content-length']||req.headers['transfer-encoding']?1:0))>0)throw new AppError(422,'INPUT_INVALID');}
    else{if(req.headers.origin!==config.tenantOrigin||req.headers['sec-fetch-site']==='cross-site')throw new AppError(400,'CSRF_INVALID');identity.sessions.checkCsrf(context,req.get('X-CSRF-Token'));if(!req.is('application/json'))throw new AppError(422,'INPUT_INVALID');}
    if(Object.keys(req.query).some(k=>!parameters.some(p=>p.in==='query'&&p.name===k)))throw new AppError(422,'INPUT_INVALID');
    for(const p of parameters){const raw=p.in==='path'?req.params[p.name]:p.in==='query'?req.query[p.name]:req.get(p.name);if(raw===undefined){if(p.required)throw new AppError(p.name==='If-Match'?428:422,p.name==='If-Match'?'ETAG_REQUIRED':'INPUT_INVALID');continue;}const value=p.name==='limit'&&typeof raw==='string'&&/^[1-9][0-9]*$/.test(raw)?Number(raw):raw;if(!p.validate(value))throw new AppError(422,'INPUT_INVALID');}
    const params=Object.fromEntries(Object.entries(req.params).map(([k,v])=>{if(typeof v!=='string')throw new AppError(422,'INPUT_INVALID');return[k,v.toLowerCase()];}));
    const result=method==='get'?await identity.wealth.read(context,op,params,req.query):await identity.wealth.mutate(context,op,req.body,params,req.get('Idempotency-Key')??'',req.get('If-Match'));
    const body={data:result.data,...(result.meta?{meta:result.meta}:{}),requestId:res.locals['requestId']};contract.result(op,result.status,body);if(result.etag)res.set('ETag',result.etag);res.status(result.status).json(body);
   }catch(error){const original=error instanceof AppError?error:new AppError(503,'SERVICE_UNAVAILABLE'),mapped=new Map([['ACCOUNT_OVERDRAFT','INSUFFICIENT_AVAILABLE_FUNDS'],['UNBALANCED_ENTRY','COMPONENT_MISMATCH'],['RECOVERY_RESTRICTED','ACCESS_DENIED']]),code=mapped.get(original.code)??original.code,e=contract.errors.has(code)?new AppError(original.status,code):new AppError(503,'SERVICE_UNAVAILABLE');res.status(e.status).json({error:{code:e.code},requestId:res.locals['requestId']});}
  });
 }return router;
}
