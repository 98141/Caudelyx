import express from 'express';
import {TLSSocket} from 'node:tls';
import {Ajv2020} from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import type {IdentityService} from '../identity/service.js';
import type {Config} from '../../shared/config.js';
import {AppError} from '../../shared/errors.js';
import {operationsContract,operationsDocument} from './operations-contract.js';
export const isOperationsPath=(path:string)=>/^\/api\/v1\/organizations\/[^/]+\/(?:loan-operations|loan-operation-previews)(?:\/|$)/.test(path);
export function operationError(e:unknown){
  if(!(e instanceof AppError))return new AppError(503,'SERVICE_UNAVAILABLE');
  if(e.code==='REAUTH_REQUIRED')return new AppError(403,'R_REQUIRED');
  if(['MFA_REQUIRED','EMAIL_NOT_VERIFIED','RECOVERY_RESTRICTED'].includes(e.code))return new AppError(403,'ACCESS_DENIED');
  if(e.code==='INPUT_TOO_LARGE')return new AppError(413,e.code);
  if(['BAD_REQUEST','CURRENCY_MISMATCH','UNBALANCED_ENTRY'].includes(e.code))return new AppError(422,'INPUT_INVALID');
  return operationsContract().errors.has(e.code)?e:new AppError(503,'SERVICE_UNAVAILABLE');
}
export function operationsRouter(identity:IdentityService,config:Config){
  const router=express.Router(),contract=operationsContract(),ajv=new Ajv2020({strict:false});formats.default(ajv);
  const components=operationsDocument().components;
  for(const [operation,{path,method,definition}]of contract.operations){
    const parameters=definition.parameters.map(p=>({...p,check:ajv.compile({...p.schema,components})}));
    router.all('/api/v1'+path.replace(/\{([^}]+)\}/g,':$1'),async(req,res,next)=>{
      if(req.method.toLowerCase()!==method&&!(req.method==='HEAD'&&method==='get'))return next();
      try{
        if(!(req.socket instanceof TLSSocket)||!req.socket.encrypted||req.headers.host!==new URL(config.tenantOrigin).host)throw new AppError(403,'ACCESS_DENIED');
        await identity.requireOpen('TENANT');await identity.beforeRequest?.();
        const cookies=(req.headers.cookie??'').split(';').map(c=>c.trim()).filter(c=>c.startsWith('__Host-caudelyx-session='));if(cookies.length>1)throw new AppError(401,'AUTH_INVALID');
        const context=await identity.sessions.find(cookies[0]?.slice('__Host-caudelyx-session='.length),'TENANT');if(!context)throw new AppError(401,'AUTH_INVALID');
        const service=identity.operations;if(!service)throw new AppError(503,'SERVICE_UNAVAILABLE');
        const org=String(req.params['organizationId']);await identity.database.transaction(async s=>{await identity.lending!.actor(context,org,s);});
        if(method!=='get'){
          if(req.headers.origin!==config.tenantOrigin||req.headers['sec-fetch-site']==='cross-site')throw new AppError(400,'CSRF_INVALID');identity.sessions.checkCsrf(context,req.get('X-CSRF-Token'));
          if(!req.is('application/json'))throw new AppError(422,'INPUT_INVALID');
        }else if((res.locals['jsonBodyBytes']??(Number(req.headers['content-length']??0)>0||req.headers['transfer-encoding']?1:0))>0)throw new AppError(422,'INPUT_INVALID');
        if(Object.keys(req.query).some(k=>!parameters.some(p=>p.in==='query'&&p.name===k)))throw new AppError(422,'INPUT_INVALID');
        for(const p of parameters){
          const raw=p.in==='path'?req.params[p.name]:p.in==='query'?req.query[p.name]:req.get(p.name);
          if(raw===undefined){if(p.required)throw new AppError(p.name==='If-Match'?428:422,p.name==='If-Match'?'ETAG_REQUIRED':'INPUT_INVALID');continue;}
          const value=p.name==='limit'&&typeof raw==='string'&&/^[1-9][0-9]*$/.test(raw)?Number(raw):raw;if(!p.check(value))throw new AppError(422,'INPUT_INVALID');
        }
        const id=req.params['loanId']??req.params['borrowerId']??req.params['eventId']??req.params['commandKey'];
        const result=method==='get'?await service.read(context,operation,org,typeof id==='string'?id:undefined,req.query):operation==='previewLoanOperation'?await service.preview(context,org,req.body):await service.mutate(context,operation,org,req.body,req.get('Idempotency-Key'),req.get('If-Match'));
        const body={data:result.data,requestId:res.locals['requestId']};contract.result(operation,result.status,body);if(result.etag)res.set('ETag',result.etag);res.status(result.status).json(body);
      }catch(e){const known=operationError(e);if(known.status===429)res.set('Retry-After',String(Math.max(1,60-Math.floor(identity.now()/1000)%60)));res.status(known.status).json({error:{code:known.code},requestId:res.locals['requestId']});}
    });
  }return router;
}
