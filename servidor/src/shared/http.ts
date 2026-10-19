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
const implemented = new Set(['A01','A02','A03','A04','A05','A06','A07','A18','A19']);

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
        if (!implemented.has(id)) throw new AppError(503, 'SERVICE_UNAVAILABLE');
        if (Object.keys(req.query).length) throw new AppError(422, 'INPUT_INVALID');
        const source = req.socket.remoteAddress ?? 'unknown';
        const pre = cookie(req, preName(realm)), strong = cookie(req, sessionName(realm));
        let context = await service.sessions.find(strong ?? pre, realm);
        if (id === 'A01') {
          const csrf = opaque();
          if (context) await service.sessions.contexts.updateOne({ _id: context._id, revoked: false }, { $set: { csrfHash: digest(csrf) } });
          else {
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
            if (!context) throw new AppError(400, 'CSRF_INVALID');
            service.sessions.checkCsrf(context, req.get('X-CSRF-Token'));
          }
        }
        if (id === 'A06') {
          if (context) await service.sessions.contexts.updateOne({ _id: context._id }, { $set: { revoked: true } });
          setCookie(res, preName(realm), '', 0); setCookie(res, sessionName(realm), '', 0); res.status(204).end(); return;
        }
        if (!context) throw new AppError(401, 'AUTH_INVALID');
        if (id === 'A07') {
          service.requireOpen(realm);
          if (context.kind === 'P') throw new AppError(401, 'AUTH_INVALID');
          if (context.kind !== 'L' && context.kind !== 'E_INITIAL') throw new AppError(503, 'SERVICE_UNAVAILABLE');
          const identity = await service.identities.findOne({ _id: context.subjectId ?? '', realm });
          if (!identity) throw new AppError(401, 'AUTH_INVALID');
          const authState = context.kind === 'E_INITIAL' ? 'MFA_ENROLLMENT' : identity.state === 'RECOVERY_RESTRICTED' ?
            'RECOVERY_RESTRICTED' : identity.factorCount ? 'MFA_REQUIRED' : service.eligible(identity) ? 'MFA_ENROLLMENT' : 'FACTOR_LOSS_BLOCKED';
          // E_RECOVERY has a separate expiry-bearing implementation; L never exposes its private flow metadata.
          if (authState === 'RECOVERY_RESTRICTED') throw new AppError(503, 'SERVICE_UNAVAILABLE');
          const body = { data: { authState }, requestId: res.locals['requestId'] };
          contract.validateResult(id, 200, body); res.status(200).json(body); return;
        }
        if (!req.is('application/json')) throw new AppError(400, 'BAD_REQUEST');
        contract.validate(id, req.body);
        let data: unknown, status = 200;
        let issued: Awaited<ReturnType<typeof service.sessions.issue>> | undefined;
        if (id === 'A02') {
          data = await service.register(realm, source, req.body as { email: string; displayName: string; privacyPolicyVersion: string }); status = 202;
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
        } else throw new AppError(503, 'SERVICE_UNAVAILABLE');
        if (issued) setCookie(res, preName(realm), issued.token, Math.max(0, Math.ceil((issued.context.expiresAt - service.now()) / 1000)));
        const body = { data, requestId: res.locals['requestId'] };
        contract.validateResult(id, status, body); res.status(status).json(body);
      } catch (error) { next(error); }
    });
  }
  return router;
}

export function strictJson() {
  return express.json({ limit: '16kb', strict: true, verify: (_req, _res, buffer) => {
    try { new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw new AppError(400, 'BAD_REQUEST'); }
  } });
}
