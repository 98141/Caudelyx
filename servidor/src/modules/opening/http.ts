import express from 'express';
import {TLSSocket} from 'node:tls';
import {Ajv2020} from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import type {IdentityService} from '../identity/service.js';
import type {Config} from '../../shared/config.js';
import {AppError} from '../../shared/errors.js';
import {financialError} from '../finance/http.js';
import {openingContract,purposes} from './contract.js';
import {observeAuthFailure} from '../../shared/diagnostics.js';

export function openingRouter(identity:IdentityService,config:Config){
  const router=express.Router(),contract=openingContract(),ajv=new Ajv2020({strict:false});formats.default(ajv);
  for(const [operation,{path,method,definition}] of contract.operations){
    const parameters=definition.parameters.map(p=>({...p,check:ajv.compile(p.schema)}));
    router.all('/api/v1'+path.replace(/\{([^}]+)\}/g,':$1'),async(req,res,next)=>{
      if(req.method.toLowerCase()!==method)return next();
      let missingSession=false;
      try{
        if(!(req.socket instanceof TLSSocket)||!req.socket.encrypted||req.headers.host!==new URL(config.tenantOrigin).host)throw new AppError(403,'ACCESS_DENIED');
        await identity.requireOpen('TENANT');await identity.beforeRequest?.();
        const cookies=(req.headers.cookie??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith('__Host-caudelyx-session='));
        if(cookies.length>1)throw new AppError(401,'AUTH_INVALID');
        const context=await identity.sessions.find(cookies[0]?.slice('__Host-caudelyx-session='.length),'TENANT');
        if(!context){missingSession=true;throw new AppError(401,'AUTH_INVALID');}
        const org=typeof req.params['organizationId']==='string'?req.params['organizationId']:'';
        await identity.database.transaction(async session=>{
          const {identity:actor}=await identity.sessions.requireStrong(context,session);
          if(actor.organizationId!==org.toLowerCase())throw new AppError(404,'RESOURCE_NOT_FOUND');
          if(!actor.roles.includes('T')||actor.roles.includes('SA'))throw new AppError(403,'ACCESS_DENIED');
        });
        if(method!=='get'){
          if(req.headers.origin!==config.tenantOrigin||req.headers['sec-fetch-site']==='cross-site')throw new AppError(400,'CSRF_INVALID');
          identity.sessions.checkCsrf(context,req.get('X-CSRF-Token'));if(!req.is('application/json'))throw new AppError(422,'INPUT_INVALID');
        }else if(req.body!==undefined)throw new AppError(422,'INPUT_INVALID');
        if(Object.keys(req.query).some(k=>!parameters.some(p=>p.in==='query'&&p.name===k)))throw new AppError(422,'INPUT_INVALID');
        for(const p of parameters){
          const raw=p.in==='path'?req.params[p.name]:p.in==='query'?req.query[p.name]:req.get(p.name);
          if(raw===undefined){if(p.required)throw new AppError(p.name==='If-Match'?428:422,p.name==='If-Match'?'ETAG_REQUIRED':'INPUT_INVALID');continue;}
          const value=p.name==='limit'&&typeof raw==='string'&&/^[1-9][0-9]*$/.test(raw)?Number(raw):raw;
          if(!p.check(value))throw new AppError(422,'INPUT_INVALID');
        }
        if(!identity.opening)throw new AppError(503,'SERVICE_UNAVAILABLE');
        const id=typeof req.params['id']==='string'?req.params['id']:undefined;
        const result=purposes.has(operation)?await identity.opening.mutate(context,operation,org,req.body,req.get('Idempotency-Key'),id,req.get('If-Match')):await identity.opening.read(context,operation,org,id,req.query);
        const body={data:result.data,requestId:res.locals['requestId']};contract.result(operation,result.status,body);
        if(result.etag)res.set('ETag',result.etag);res.status(result.status).json(body);
      }catch(e){
        const known=financialError(e instanceof AppError?e:new AppError(503,'SERVICE_UNAVAILABLE'));
        if(known.status===401)observeAuthFailure(missingSession?'sessionMissing':'unknown');
        const body={error:{code:known.code},requestId:res.locals['requestId']};
        contract.result(operation,known.status,body);res.status(known.status).json(body);
      }
    });
  }
  return router;
}
