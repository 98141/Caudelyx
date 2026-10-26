import {isLendingPath} from '../lending/http.js';
import {isOperationsPath} from '../lending/operations-http.js';
import type { RequestHandler } from 'express';
import { TLSSocket } from 'node:tls';
import type { IdentityService } from './service.js';
import type { Config } from '../../shared/config.js';
import { AppError } from '../../shared/errors.js';
import { emailVerified } from './onboarding.js';
import { financeContract } from '../finance/contract.js';
import { openingContract } from '../opening/contract.js';

/** AUTH AJ-ONB precedes the frozen financial routers for non-operational contexts. */
export function onboardingBusinessGuard(identity: IdentityService, config: Config): RequestHandler {
  return async (req, res, next) => {
    if (!/^\/api\/v1\/organizations\/[^/]+\/financial(?:\/|$)/i.test(req.path)&&!isLendingPath(req.path.toLowerCase())&&!isOperationsPath(req.path.toLowerCase())) return next();
    try {
      if (!(req.socket instanceof TLSSocket) || !req.socket.encrypted || req.headers.host !== new URL(config.tenantOrigin).host) throw new AppError(403, 'ACCESS_DENIED');
      await identity.requireOpen('TENANT');
      const cookies = (req.headers.cookie ?? '').split(';').map(value => value.trim());
      const tokens = (name:string) => cookies.filter(value => value.startsWith(name+'='));
      const session = tokens('__Host-caudelyx-session'), pre = tokens('__Host-caudelyx-pre');
      if (session.length>1 || pre.length>1) throw new AppError(401,'AUTH_INVALID');
      const context = await identity.sessions.find(session[0]?.split('=')[1], 'TENANT') ??
        await identity.sessions.find(pre[0]?.split('=')[1], 'TENANT');
      if (!context || context.kind==='W'||context.kind==='S'&&context.realm==='PLATFORM') return next();
      if (req.method!=='GET') {
        if (req.headers.origin!==config.tenantOrigin || req.headers['sec-fetch-site']==='cross-site') throw new AppError(400,'CSRF_INVALID');
        identity.sessions.checkCsrf(context,req.get('X-CSRF-Token'));
        if (!req.is('application/json')) throw new AppError(422,'INPUT_INVALID');
        const contract=req.path.toLowerCase().includes('/financial/openings')?openingContract():financeContract();
        const matched=[...contract.operations].find(([,op])=>op.method===req.method.toLowerCase()&&
          // eslint-disable-next-line security/detect-non-literal-regexp -- Route templates come exclusively from the hash-verified S2/S3 contracts; no request data builds this pattern.
          new RegExp('^/api/v1'+op.path.replace(/\{[^}]+\}/g,'[^/]+')+'$','i').test(req.path));
        if(matched)contract.validate(matched[0],req.body);
      } else if (req.body!==undefined) throw new AppError(422,'INPUT_INVALID');
      const subject = await identity.identities.findOne({_id:context.subjectId??'',realm:'TENANT'});
      if (!subject) throw new AppError(401,'AUTH_INVALID');
      // No organization/resource lookup occurs before this uniform denial.
      throw new AppError(403,emailVerified(subject)?'MFA_REQUIRED':'EMAIL_NOT_VERIFIED');
    } catch (error) {
      const known=error instanceof AppError?error:new AppError(503,'SERVICE_UNAVAILABLE');
      // AUTH's approved new codes must not be remapped by historical finance schemas.
      res.status(known.status).json({error:{code:known.code},requestId:res.locals['requestId']});
    }
  };
}
