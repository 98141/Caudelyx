import express from 'express';
import {TLSSocket} from 'node:tls';
import {Ajv2020} from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import type {IdentityService} from '../identity/service.js';
import type {Config} from '../../shared/config.js';
import {AppError} from '../../shared/errors.js';
import {lendingContract} from './contract.js';
export const isLendingPath=(path:string)=>/^\/api\/v1\/organizations\/[^/]+\/(?:lending-policy|borrower-field-schemas|borrowers|loan-quotes|loans)(?:\/|$)/i.test(path);
export function lendingError(e:unknown){
  if(!(e instanceof AppError))return new AppError(503,'SERVICE_UNAVAILABLE');
  if(e.code==='INPUT_TOO_LARGE')return new AppError(413,'INPUT_TOO_LARGE');
  if(e.code==='REAUTH_REQUIRED')return new AppError(403,'R_REQUIRED');
  if(['MFA_REQUIRED','EMAIL_NOT_VERIFIED','RECOVERY_RESTRICTED'].includes(e.code))return new AppError(403,'ACCESS_DENIED');
  if(e.code==='BAD_REQUEST')return new AppError(422,'INPUT_INVALID');
  return lendingContract().errors.has(e.code)?e:new AppError(503,'SERVICE_UNAVAILABLE');
}
export function lendingRouter(identity:IdentityService,config:Config){
  const router=express.Router(),contract=lendingContract(),ajv=new Ajv2020({strict:false});formats.default(ajv);
  for(const [operation,{path,method,definition}] of contract.operations){
    const parameters=definition.parameters.map(p=>({...p,check:ajv.compile(p.schema)}));
    router.all('/api/v1'+path.replace(/\{([^}]+)\}/g,':$1'),async(req,res,next)=>{
      if(req.method.toLowerCase()!==method&&!(req.method==='HEAD'&&method==='get'))return next();
      try{
        if(!(req.socket instanceof TLSSocket)||!req.socket.encrypted||req.headers.host!==new URL(config.tenantOrigin).host)throw new AppError(403,'ACCESS_DENIED');
        await identity.requireOpen('TENANT');await identity.beforeRequest?.();
        const tokens=(req.headers.cookie??'').split(';').map(c=>c.trim()).filter(c=>c.startsWith('__Host-caudelyx-session='));
        if(tokens.length>1)throw new AppError(401,'AUTH_INVALID');
        const context=await identity.sessions.find(tokens[0]?.slice('__Host-caudelyx-session='.length),'TENANT');
        if(!context)throw new AppError(401,'AUTH_INVALID');if(!identity.lending)throw new AppError(503,'SERVICE_UNAVAILABLE');
        const org=String(req.params['organizationId']);
        await identity.database.transaction(async s=>{await identity.lending!.actor(context,org,s);});
        if(method!=='get'){
          if(req.headers.origin!==config.tenantOrigin||req.headers['sec-fetch-site']==='cross-site')throw new AppError(400,'CSRF_INVALID');
          identity.sessions.checkCsrf(context,req.get('X-CSRF-Token'));if(!req.is('application/json'))throw new AppError(422,'INPUT_INVALID');
        }else if((res.locals['jsonBodyBytes']??(Number(req.headers['content-length']??0)>0||req.headers['transfer-encoding']?1:0))>0)throw new AppError(422,'INPUT_INVALID');
        if(Object.keys(req.query).some(k=>!parameters.some(p=>p.in==='query'&&p.name===k)))throw new AppError(422,'INPUT_INVALID');
        for(const p of parameters){
          const raw=p.in==='path'?req.params[p.name]:p.in==='query'?req.query[p.name]:req.get(p.name);
          if(raw===undefined){if(p.required)throw new AppError(p.name==='If-Match'?428:422,p.name==='If-Match'?'ETAG_REQUIRED':'INPUT_INVALID');continue;}
          const value=['limit','schemaVersion','version'].includes(p.name)&&typeof raw==='string'&&/^[1-9][0-9]*$/.test(raw)?Number(raw):raw;if(!p.check(value))throw new AppError(422,'INPUT_INVALID');
        }
        const id=typeof req.params['id']==='string'?req.params['id']:undefined,version=typeof req.params['version']==='string'?req.params['version']:typeof req.params['schemaVersion']==='string'?req.params['schemaVersion']:undefined;
        const result=method==='get'?await identity.lending.read(context,operation,org,id,req.query,version):await identity.lending.mutate(context,operation,org,req.body,req.get('Idempotency-Key'),id,req.get('If-Match'));
        const body={data:result.data,requestId:res.locals['requestId']};contract.result(operation,result.status,body);
        if(result.etag)res.set('ETag',result.etag);res.status(result.status).json(body);
      }catch(e){const known=lendingError(e),body={error:{code:known.code},requestId:res.locals['requestId']};if(known.status===429)res.set('Retry-After',String(Math.max(1,60-Math.floor(identity.now()/1000)%60)));res.status(known.status).json(body);}
    });
  }return router;
}
