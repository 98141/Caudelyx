import express from 'express';
import {TLSSocket} from 'node:tls';
import type {IdentityService} from '../identity/service.js';
import type {Config} from '../../shared/config.js';
import type {StepUpInput} from './step-up.js';
import {AppError} from '../../shared/errors.js';
import {sessionMeta,workContract} from './work-policy.js';
import type {StepUpService} from './step-up.js';
import {initialBalances} from '../finance/initial-balances.js';

export function workRouter(identity:IdentityService,config:Config){
  const router=express.Router(),contract=workContract();
  for(const path of ['/api/v1/auth/session/activity','/api/v1/auth/step-up/intents','/api/v1/auth/step-up/verify','/api/v1/organizations/:organizationId/financial/initial-balances']){
    router.post(path,async(req,res)=>{
      try{
        if(!(req.socket instanceof TLSSocket)||!req.socket.encrypted||req.headers.host!==new URL(config.tenantOrigin).host)throw new AppError(403,'ACCESS_DENIED');
        await identity.requireOpen('TENANT');await identity.beforeRequest?.();
        const cookies=(req.headers.cookie??'').split(';').map(c=>c.trim()).filter(c=>c.startsWith('__Host-caudelyx-session='));
        if(cookies.length!==1)throw new AppError(401,'AUTH_INVALID');
        const context=await identity.sessions.find(cookies[0]!.slice('__Host-caudelyx-session='.length),'TENANT');
        if(!context)throw new AppError(401,'AUTH_INVALID');
        if(req.headers.origin!==config.tenantOrigin||req.headers['sec-fetch-site']==='cross-site')throw new AppError(400,'CSRF_INVALID');
        identity.sessions.checkCsrf(context,req.get('X-CSRF-Token'));
        if(!req.is('application/json')||Object.keys(req.query).length)throw new AppError(422,'INPUT_INVALID');
        let data:unknown,status=200;
        if(path.endsWith('/activity')){
          if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length)throw new AppError(422,'INPUT_INVALID');
          data=await identity.database.transaction(async session=>{
            const fresh=context.kind==='B'?await identity.sessions.findById(context,session):(await identity.sessions.requireOperational(context,session)).context;
            if(!['W','B'].includes(fresh.kind))throw new AppError(403,'ACCESS_DENIED');
            fresh.lastSeenAt=identity.now();await identity.sessions.contexts.updateOne({_id:fresh._id,revoked:false},{$set:{lastSeenAt:fresh.lastSeenAt}},{session});
            const response={session:sessionMeta(fresh,identity.now())};contract.validate('SessionResult',{data:response,requestId:res.locals['requestId']},true);return response;
          });
        }else if(path.endsWith('/intents')){
          if(!identity.work)throw new AppError(503,'SERVICE_UNAVAILABLE');
          data=await identity.work.prepare(context,req.body as StepUpInput);
          contract.validate('StepUpPrepared',{data,requestId:res.locals['requestId']},true);
        }else if(path.endsWith('/verify')){
          if(!identity.work)throw new AppError(503,'SERVICE_UNAVAILABLE');
          const result=await identity.work.verify(context,req.body as Parameters<StepUpService['verify']>[1],cookies[0]!.slice('__Host-caudelyx-session='.length));data=result.data;
          contract.validate('StepUpVerified',{data,requestId:res.locals['requestId']},true);
          if(result.issued.token!==cookies[0]!.slice('__Host-caudelyx-session='.length))res.append('Set-Cookie',`__Host-caudelyx-session=${result.issued.token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0,Math.ceil((result.issued.context.expiresAt-identity.now())/1000))}`);
        }else{
          const id=req.params['organizationId'];if(typeof id!=='string'||!identity.finance)throw new AppError(422,'INPUT_INVALID');
          const result=await initialBalances(identity.finance,context,id,req.body,req.get('Idempotency-Key'));data=result.data;status=result.status;if(result.etag)res.set('ETag',result.etag);
        }
        res.status(status).json({data,requestId:res.locals['requestId']});
      }catch(error){const e=error instanceof AppError?error:new AppError(503,'SERVICE_UNAVAILABLE');res.status(e.status).json({error:{code:e.code==='REAUTH_REQUIRED'?'R_REQUIRED':e.code},requestId:res.locals['requestId']});}
    });
  }
  return router;
}
