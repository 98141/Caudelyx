/* eslint-disable security/detect-object-injection -- Closed, compiled parameter catalog from the pinned API. */
import express from 'express';
import {TLSSocket} from 'node:tls';
import {Ajv2020} from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import type {IdentityService} from '../identity/service.js';
import type {Config} from '../../shared/config.js';
import {monthlyContract} from './ms-contract.js';
import {monthlyService} from './ms-service.js';
import {AppError} from '../../shared/errors.js';
export function monthlyRouter(identity:IdentityService,config:Config){
 const router=express.Router(),contract=monthlyContract(),ajv=new Ajv2020({strict:false});formats.default(ajv);
 for(const[operation,spec]of contract.operations){
  const parameters=spec.definition.parameters.map(raw=>{const p=('$ref'in raw?contract.document.components.parameters[String(raw['$ref']).split('/').at(-1)!]:raw)!;return{name:String(p['name']),in:String(p['in']),required:p['required']===true,check:ajv.compile({...p['schema'] as object,components:contract.document.components})};});
  router.all('/api'+spec.path.replace(/\{([^}]+)\}/g,':$1'),async(req,res,next)=>{
   if(req.method.toLowerCase()!==spec.method&&!(req.method==='HEAD'&&spec.method==='get'))return next();
   try{
    if(!(req.socket instanceof TLSSocket)||!req.socket.encrypted||req.headers.host!==new URL(config.tenantOrigin).host)throw new AppError(403,'ACCESS_DENIED');
    await identity.requireOpen('TENANT');await identity.beforeRequest?.();const cookies=(req.headers.cookie??'').split(';').map(c=>c.trim()).filter(c=>c.startsWith('__Host-caudelyx-session='));if(cookies.length>1)throw new AppError(401,'AUTH_INVALID');const context=await identity.sessions.find(cookies[0]?.slice('__Host-caudelyx-session='.length),'TENANT');if(!context)throw new AppError(401,'AUTH_INVALID');
    const ms=monthlyService(identity);await ms.requireActive();
    if(spec.method!=='get'){if(req.headers.origin!==config.tenantOrigin||req.headers['sec-fetch-site']==='cross-site')throw new AppError(400,'CSRF_INVALID');identity.sessions.checkCsrf(context,req.get('X-CSRF-Token'));if(!req.is('application/json'))throw new AppError(422,'INPUT_INVALID');}
    else if((res.locals['jsonBodyBytes']??(Number(req.headers['content-length']??0)>0||req.headers['transfer-encoding']?1:0))>0)throw new AppError(422,'INPUT_INVALID');
    if(Object.keys(req.query).some(k=>!parameters.some(p=>p['in']==='query'&&p['name']===k)))throw new AppError(422,'INPUT_INVALID');
    for(const p of parameters){const name=String(p['name']),raw=p['in']==='path'?req.params[name]:p['in']==='query'?req.query[name]:req.get(name);if(raw===undefined){if(p['required'])throw new AppError(name==='If-Match'?428:422,name==='If-Match'?'ETAG_REQUIRED':'INPUT_INVALID');continue;}if(!p.check(raw))throw new AppError(422,'INPUT_INVALID');}
    const params=Object.fromEntries(Object.entries(req.params).map(([k,v])=>[k,String(v)])),key=req.get('Idempotency-Key')??'';
    if(spec.method!=='get'&&req.body?.executionKey!==undefined&&req.body.executionKey!==key)throw new AppError(409,'IDEMPOTENCY_CONFLICT');
    const result=spec.method==='get'?await ms.read(context,operation,params,req.query):await ms.mutate(context,operation,req.body,params,key,req.get('If-Match'));
    contract.result(operation,result.data);if(result.etag)res.set('ETag',result.etag);res.status(result.status).json(result.data);
   }catch(error){const e=error instanceof AppError?error:new AppError(503,'SERVICE_UNAVAILABLE');res.status(e.status).json({error:{code:e.code},requestId:res.locals['requestId']});}
  });
 }
 return router;
}
