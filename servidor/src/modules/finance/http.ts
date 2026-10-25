import express, { type Request } from 'express';
import { TLSSocket } from 'node:tls';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import type { IdentityService } from '../identity/service.js';
import type { Config } from '../../shared/config.js';
import { AppError } from '../../shared/errors.js';
import { financeContract } from './contract.js';
import { purposes } from './service.js';
import {observeAuthFailure} from '../../shared/diagnostics.js';

export function financialError(error:AppError):AppError {
  if(['DOMAIN_ACCOUNT_PROTECTED','DOMAIN_REVERSAL_FORBIDDEN'].includes(error.code))return error;
  if(error.code==='BAD_REQUEST')return new AppError(400,'INPUT_INVALID');
  if(error.code==='REAUTH_REQUIRED')return new AppError(403,'R_REQUIRED');
  if(['RECOVERY_RESTRICTED','MFA_REQUIRED'].includes(error.code))return new AppError(403,'ACCESS_DENIED');
  const allowed=['AUTH_INVALID','ACCESS_DENIED','CSRF_INVALID','INPUT_INVALID','SERVICE_UNAVAILABLE','ETAG_REQUIRED','PRECONDITION_FAILED','R_REQUIRED','IDEMPOTENCY_CONFLICT','SOURCE_CONFLICT','UNBALANCED_ENTRY','ACCOUNT_OVERDRAFT','CURRENCY_MISMATCH','ALREADY_REVERSED','RESOURCE_NOT_FOUND','OPENING_CUTOFF_CONFLICT','OPENING_IMMUTABLE','ROUTE_NOT_FOUND','METHOD_NOT_ALLOWED','INPUT_TOO_LARGE','BOOK_NOT_ELIGIBLE','OPENING_ALREADY_POSTED','OPENING_STATE_CONFLICT','OPENING_VALIDATION_STALE','OPENING_NOT_BALANCED'];
  return allowed.includes(error.code)?error:new AppError(503,'SERVICE_UNAVAILABLE');
}

function sessionCookie(req:Request):string|undefined {
  const cookies=(req.headers.cookie??'').split(';').map(c=>c.trim()).filter(c=>c.startsWith('__Host-caudelyx-session='));
  if(cookies.length>1)throw new AppError(401,'AUTH_INVALID');return cookies[0]?.slice('__Host-caudelyx-session='.length);
}
export function financeRouter(identity:IdentityService,config:Config) {
  const router=express.Router(),contract=financeContract(),ajv=new Ajv2020({strict:false});formats.default(ajv);
  for(const [operation,{path,method,definition}]of contract.operations) {
    const parameters=(definition.parameters??[]).map(p=>({...p,check:ajv.compile(p.schema)}));
    router.all('/api/v1'+path.replace(/\{([^}]+)\}/g,':$1'),async(req,res,next)=>{
      if(req.method.toLowerCase()!==method)return next();
      try {
        if(!(req.socket instanceof TLSSocket)||!req.socket.encrypted)throw new AppError(403,'ACCESS_DENIED');
        if(req.headers.host!==new URL(config.tenantOrigin).host)throw new AppError(403,'ACCESS_DENIED');
        await identity.requireOpen('TENANT');await identity.beforeRequest?.();
        const context=await identity.sessions.find(sessionCookie(req),'TENANT');if(!context)throw new AppError(401,'AUTH_INVALID');
        // Check current auth and membership before schemas or resource-dependent errors.
        const organizationId=typeof req.params['organizationId']==='string'?req.params['organizationId']:'';
        if(!identity.finance)throw new AppError(503,'SERVICE_UNAVAILABLE');
        await identity.database.transaction(async session=>{
          const {identity:actor}=await identity.sessions.requireStrong(context,session);
          if(actor.organizationId!==organizationId.toLowerCase())throw new AppError(404,'RESOURCE_NOT_FOUND');
          if(!actor.roles.includes('T')||actor.roles.includes('SA'))throw new AppError(403,'ACCESS_DENIED');
        });
        if(method!=='get') {
          if(req.headers.origin!==config.tenantOrigin||req.headers['sec-fetch-site']==='cross-site')throw new AppError(400,'CSRF_INVALID');
          identity.sessions.checkCsrf(context,req.get('X-CSRF-Token'));
          if(!req.is('application/json'))throw new AppError(422,'INPUT_INVALID');
        }else if(req.body!==undefined)throw new AppError(422,'INPUT_INVALID');
        const allowedQuery=parameters.filter(p=>p.in==='query').map(p=>p.name);
        if(Object.keys(req.query).some(k=>!allowedQuery.includes(k)))throw new AppError(422,'INPUT_INVALID');
        for(const p of parameters) {
          const value=p.in==='path'?req.params[p.name]:p.in==='query'?req.query[p.name]:req.get(p.name);
          if(value===undefined) {if(p.required)throw new AppError(p.name==='If-Match'?428:422,p.name==='If-Match'?'ETAG_REQUIRED':'INPUT_INVALID');continue;}
          const parsed=p.name==='limit'&&typeof value==='string'&&/^[1-9][0-9]*$/.test(value)?Number(value):value;
          if(!p.check(parsed))throw new AppError(422,'INPUT_INVALID');
        }
        const id=typeof req.params['id']==='string'?req.params['id']:undefined;
        const result=purposes.has(operation)?await identity.finance.mutate(context,operation,organizationId,req.body,req.get('Idempotency-Key'),id,req.get('If-Match')):
          await identity.finance.read(context,operation,organizationId,id,req.query);
        const body={data:result.data,requestId:res.locals['requestId']};contract.result(operation,result.status,body);
        if(result.etag)res.set('ETag',result.etag);res.status(result.status).json(body);
      }catch(error) {
        const known=financialError(error instanceof AppError?error:new AppError(503,'SERVICE_UNAVAILABLE'));
        if(known.status===401)observeAuthFailure();
        const body={error:{code:known.code},requestId:res.locals['requestId']};
        contract.result(operation,known.status,body);
        res.status(known.status).json(body);
      }
    });
  }
  return router;
}
