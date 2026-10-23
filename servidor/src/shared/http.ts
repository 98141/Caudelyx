import express, { type Request, type Response } from 'express';
import { TLSSocket } from 'node:tls';
import type { IdentityService } from '../modules/identity/service.js';
import type { Realm } from '../modules/identity/models.js';
import { AppError } from './errors.js';
import { opaque, digest } from './crypto.js';
import { FrozenContract } from './contract.js';
import type { Config } from './config.js';

const preName = (realm: Realm) => realm === 'TENANT' ? '__Host-caudelyx-pre' : '__Host-caudelyx-platform-pre';
const sessionName = (realm: Realm) => realm === 'TENANT' ? '__Host-caudelyx-session' : '__Host-caudelyx-platform-session';
const implemented = new Set(['A01','A02','A03','A04','A05','A06','A07','A18','A19','A39','A40']);

function cookie(req: Request, name: string): string | undefined {
  const values = (req.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  if (values.length > 1) throw new AppError(400, 'BAD_REQUEST');
  return values[0]?.slice(name.length + 1);
}
function setCookie(res: Response, name: string, value: string, maxAge = 300): void {
  res.append('Set-Cookie', `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}
export function authRouter(service: IdentityService, config: Config) {
  const router = express.Router(), contract = new FrozenContract();
  for (const [id, operation] of contract.operations) {
    const path = '/api/v1' + operation.path.replace(/\{([^}]+)\}/g, ':$1');
    router.all(path, async (req, res, next) => {
      if (req.method.toLowerCase() !== operation.method) return next();
      try {
        if (!(req.socket instanceof TLSSocket) || !req.socket.encrypted) throw new AppError(400, 'BAD_REQUEST');
        const host = req.headers.host;
        const tenant = new URL(config.tenantOrigin), platform = new URL(config.platformOrigin);
        const realm: Realm = host === tenant.host ? 'TENANT' : host === platform.host ? 'PLATFORM' : (() => { throw new AppError(403, 'ACCESS_DENIED'); })();
        const origin = realm === 'TENANT' ? config.tenantOrigin : config.platformOrigin;
        const platformAllowed = new Set(['A01','A05','A06','A07','A20','A21','A24','A25','A26','A27','A28','A29','A32','A33','A34','A35']);
        if (realm === 'PLATFORM' && !platformAllowed.has(id)) throw new AppError(403, 'ACCESS_DENIED');
        if (!implemented.has(id) && !service.extension) throw new AppError(503, 'SERVICE_UNAVAILABLE');
        const closed = !await service.isRealmOpen(realm);
        if (closed && id === 'A18') { res.status(202).json({data:{code:'GENERIC_ACCOUNT_ACTION'},requestId:res.locals['requestId']});return; }
        if (closed && !['A01','A06'].includes(id)) await service.requireOpen(realm);
        if (!closed) await service.beforeRequest?.();
        for(const [name,value] of Object.entries(req.query)) {
          if(!['A11','A13','A21','A33'].includes(id)||!['limit','cursor'].includes(name)||typeof value!=='string')throw new AppError(422,'INPUT_INVALID');
        }
        const source = req.socket.remoteAddress ?? 'unknown';
        const pre = cookie(req, preName(realm)), strong = cookie(req, sessionName(realm));
        const strongContext=closed?null:await service.sessions.find(strong,realm);
        let context = closed ? null : strongContext??await service.sessions.find(pre, realm);
        if (id === 'A01') {
          if(strong&&!strongContext)setCookie(res,sessionName(realm),'',0);
          const csrf = opaque();
          if (!context) {
            const issued = await service.sessions.issue(realm, 'P', null); context = issued.context;
            setCookie(res, preName(realm), issued.token, 600);
          }
          await service.sessions.contexts.updateOne({ _id: context._id }, { $set: { csrfHash: digest(csrf) } });
          const body = { data: { csrfToken: csrf }, requestId: res.locals['requestId'] };
          contract.validateResult(id, 200, body); res.status(200).json(body); return;
        }
        if (req.method !== 'GET') {
          if (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') throw new AppError(400, 'CSRF_INVALID');
          if (id !== 'A06' || context) {
            if (!context) {
              const body = req.body as {purpose?:unknown} | undefined;
              if (['A03','A04'].includes(id) && body?.purpose === 'INITIAL_MFA_PROOF' && req.is('application/json')) {
                contract.validate(id, req.body);
                throw new AppError(401,'AUTH_INVALID');
              }
              throw new AppError(400, 'CSRF_INVALID');
            }
            service.sessions.checkCsrf(context, req.get('X-CSRF-Token'));
          }
        }
        if (id === 'A06') {
          if (context) await service.sessions.contexts.updateOne({ _id: context._id }, { $set: { revoked: true } });
          setCookie(res, preName(realm), '', 0); setCookie(res, sessionName(realm), '', 0); res.status(204).end(); return;
        }
        if (!context) throw new AppError(401, 'AUTH_INVALID');
        if(id==='A07'&&service.extension){
          const result=await service.extension(id,context,{},undefined,undefined,source,req.query);
          const body={data:result.data,requestId:res.locals['requestId']};contract.validateResult(id,200,body);if(context.kind==='B')await service.sessions.contexts.updateOne({_id:context._id,revoked:false},{$set:{lastSeenAt:service.now()}});res.json(body);return;
        }
        if (id === 'A07') {
          await service.requireOpen(realm);
          if (context.kind === 'P') {
            const profile=await service.registrationProfile(context);if(!profile)throw new AppError(401,'AUTH_INVALID');
            const body={data:profile,requestId:res.locals['requestId']};contract.validateResult(id,200,body);res.json(body);return;
          }
          if (context.kind !== 'L' && context.kind !== 'E_INITIAL') throw new AppError(503, 'SERVICE_UNAVAILABLE');
          const identity = await service.identities.findOne({ _id: context.subjectId ?? '', realm });
          if (!identity) throw new AppError(401, 'AUTH_INVALID');
          if(identity.state==='PENDING_EMAIL')throw new AppError(401,'AUTH_INVALID');
          const authState = context.kind === 'E_INITIAL' ? 'MFA_ENROLLMENT' : identity.state === 'RECOVERY_RESTRICTED' ?
            'RECOVERY_RESTRICTED' : identity.factorCount ? 'MFA_REQUIRED' : await service.eligible(identity) ? 'MFA_ENROLLMENT' : 'FACTOR_LOSS_BLOCKED';
          // E_RECOVERY has a separate expiry-bearing implementation; L never exposes its private flow metadata.
          if (authState === 'RECOVERY_RESTRICTED') throw new AppError(503, 'SERVICE_UNAVAILABLE');
          const body = { data: { authState, ...(context.kind==='E_INITIAL'?{nextAction:'ENROLL_FIRST_FACTOR'}:{}),
            ...(realm==='TENANT'?{profile:service.ownProfile(identity)}:{}) }, requestId: res.locals['requestId'] };
          contract.validateResult(id, 200, body); res.status(200).json(body); return;
        }
        if (operation.validate && !req.is('application/json')) throw new AppError(400, 'BAD_REQUEST');
        if (!operation.validate && req.body !== undefined && (typeof req.body !== 'object' || req.body === null || Object.keys(req.body as object).length)) throw new AppError(422,'INPUT_INVALID');
        contract.validate(id, req.body);
        if(context.kind==='B'&&!['A03','A04','A21','A22','A23','A24','A25','A39'].includes(id)){
          if(['A08','A09','A10','A11','A12','A13','A14','A15','A16','A17','A36','A37','A38'].includes(id))await service.database.transaction(async session=>{await service.sessions.requireStrong(context,session);});
          throw new AppError(403,'ACCESS_DENIED');
        }
        if(['A18','A19','A40'].includes(id)&&context.kind!=='P')throw new AppError(403,'ACCESS_DENIED');
        let data: unknown, status = 200;
        let issued: Awaited<ReturnType<typeof service.sessions.issue>> | undefined;
        if (id === 'A02') {
          const result=await service.register(realm, source, req.body as Parameters<IdentityService['register']>[2],context);data=result.data;issued=result.issued;status=200;
        } else if (id === 'A03') {
          const body = req.body as { purpose: 'ACTIVATION' | 'INITIAL_MFA_PROOF'; email?: string };
          data = await service.requestEmail(realm, source, body.purpose, body.email ?? null, context); status = 202;
        } else if (id === 'A04') {
          const result = await service.confirmEmail(context, req.body as Parameters<IdentityService['confirmEmail']>[1]);
          data = result.data; issued = result.issued;
        } else if (id === 'A05') {
          const body = req.body as { email: string; password: string };
          const result = await service.login(realm, source, body.email, body.password); data = result.data; issued = result.issued;
          await service.sessions.contexts.updateOne({ _id: context._id }, { $set: { revoked: true } });
        } else if (id === 'A18') {
          data = await service.requestEmail(realm, source, 'RESET', (req.body as { email: string }).email, context); status = 202;
        } else if (id === 'A19') {
          data = await service.reset(context, req.body as Parameters<IdentityService['reset']>[1], source);
          if ((req.body as { mode: string }).mode === 'CONFIRM') {
            setCookie(res, preName(realm), '', 0); setCookie(res, sessionName(realm), '', 0);
          }
        } else if(id==='A39'){
          const result=await service.onboarding.profile(context,req.body as {displayName:string},req.get('If-Match'));data=result.data;res.set('ETag',result.etag);
        } else if(id==='A40'){
          await service.onboarding.reject(context,(req.body as {token:string}).token);res.status(204).end();return;
        } else if(service.extension){
          const param=req.params['id'];if(param!==undefined&&typeof param!=='string')throw new AppError(422,'INPUT_INVALID');
          const result=await service.extension(id,context,req.body??{},param,req.get('If-Match'),source,req.query,req.get('Idempotency-Key'));
          data=result.data;status=result.status??200;issued=result.issued;
          if(result.etag)res.set('ETag',result.etag);
          if(result.clearCookies){setCookie(res,preName(realm),'',0);setCookie(res,sessionName(realm),'',0);}
          if(status===204){res.status(204).end();return;}
        } else throw new AppError(503, 'SERVICE_UNAVAILABLE');
        if (issued) {
          const name=['S','B'].includes(issued.context.kind)?sessionName(realm):preName(realm);
          setCookie(res,name,issued.token,Math.max(0,Math.ceil((issued.context.expiresAt-service.now())/1000)));
          if(['S','B'].includes(issued.context.kind))setCookie(res,preName(realm),'',0);
        }
        if(context.kind==='B')await service.sessions.contexts.updateOne({_id:context._id,revoked:false},{$set:{lastSeenAt:service.now()}});
        const body = { data, requestId: res.locals['requestId'] };
        contract.validateResult(id, status, body); res.status(status).json(body);
      } catch (error) { next(error); }
    });
  }
  return router;
}

export function strictJson() {
  return express.json({ limit: '64kb', strict: true, verify: (req, _res, buffer) => {
    const large = req.url?.startsWith('/api/v1/auth/mfa/webauthn/') || req.url?.split('?')[0]==='/api/v1/auth/mfa/challenges/verify';
    if(!large&&buffer.length>16384)throw new AppError(400,'BAD_REQUEST');
    try { new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw new AppError(400, 'BAD_REQUEST'); }
  } });
}
