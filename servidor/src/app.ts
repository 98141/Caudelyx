import {collectionsRouter,isCollectionPath,collectionError} from './modules/collections/http.js';
import {paymentsRouter,isPaymentPath,paymentError} from './modules/payments/http.js';
import {workRouter} from './modules/sessions/work-http.js';
import { onboardingBusinessGuard } from './modules/identity/onboarding-http.js';
import express, { type ErrorRequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { AppError } from './shared/errors.js';
import { authRouter, strictJson } from './shared/http.js';
import type { IdentityService } from './modules/identity/service.js';
import type { Config } from './shared/config.js';
import { financeRouter,financialError } from './modules/finance/http.js';
import {openingRouter} from './modules/opening/http.js';
import {transportFallback} from './shared/transport.js';
import {lendingRouter,lendingError,isLendingPath} from './modules/lending/http.js';
import {operationsRouter,isOperationsPath,operationError} from './modules/lending/operations-http.js';

export function createApp(runtime?: { identity: IdentityService; config: Config }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.set('trust proxy', false);
  app.use((_req, res, next) => {
    res.locals['requestId'] = randomUUID();
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' });
    next();
  });
  if (runtime) {
    app.use(strictJson());
    app.use(workRouter(runtime.identity,runtime.config));
    app.use(authRouter(runtime.identity, runtime.config));
    app.use(onboardingBusinessGuard(runtime.identity,runtime.config));
    app.use(financeRouter(runtime.identity,runtime.config));
    app.use(openingRouter(runtime.identity,runtime.config));
    app.use(lendingRouter(runtime.identity,runtime.config));
    app.use(operationsRouter(runtime.identity,runtime.config));
    app.use(paymentsRouter(runtime.identity,runtime.config));
    app.use(collectionsRouter(runtime.identity,runtime.config));
    app.use(transportFallback(runtime.identity,runtime.config));
  }
  // No business route is mounted until its authentication dependencies pass checkpoints.
  app.use((_req, _res, next) => next(new AppError(503, 'SERVICE_UNAVAILABLE')));
  const errors: ErrorRequestHandler = (error: unknown, req, res, _next) => {
    void _next; // Express identifies error handlers by all four parameters.
    const requestPath=req.path.toLowerCase();
    const parserError = error instanceof Error && 'type' in error && ['entity.parse.failed', 'entity.too.large'].includes(String(error.type));
    const oversized=error instanceof Error&&'type'in error&&error.type==='entity.too.large';
    const business=isCollectionPath(requestPath)||isLendingPath(requestPath)||isOperationsPath(requestPath)||isPaymentPath(requestPath),a32=['/api/v1/auth/reauthenticate','/api/v1/auth/step-up/intents'].includes(requestPath);
    const unsupported=error instanceof Error&&'type'in error&&error.type==='encoding.unsupported';
    const known = error instanceof AppError ? error : oversized&&(/^\/api\/v1\/organizations\/[^/]+\/financial(?:\/|$)/.test(requestPath)||business||a32)?new AppError(413,'INPUT_TOO_LARGE'):parserError||unsupported ? new AppError(business?422:400,business?'INPUT_INVALID':'BAD_REQUEST') : new AppError(503, 'SERVICE_UNAVAILABLE');
    if(isCollectionPath(requestPath)){const failure=collectionError(known);res.status(failure.status).json({error:{code:failure.code},requestId:res.locals['requestId']});return;}
    if(isPaymentPath(requestPath)){const failure=paymentError(known);res.status(failure.status).json({error:{code:failure.code},requestId:res.locals['requestId']});return;}
    if(isOperationsPath(requestPath)){const failure=operationError(known);res.status(failure.status).json({error:{code:failure.code},requestId:res.locals['requestId']});return;}
    if(a32&&(oversized||res.locals['scopedCommandBody']&&known.code==='INPUT_TOO_LARGE')){res.status(413).json({error:{code:'INPUT_TOO_LARGE'},requestId:res.locals['requestId']});return;}
    if(isLendingPath(requestPath)){const failure=lendingError(known);res.status(failure.status).json({error:{code:failure.code},requestId:res.locals['requestId']});return;}
    if(/^\/api\/v1\/organizations\/[^/]+\/financial(?:\/|$)/.test(requestPath)) {
      const failure=financialError(known);res.status(failure.status).json({error:{code:failure.code},requestId:res.locals['requestId']});return;
    }
    if(known.status===403 && known.code==='REAUTH_REQUIRED' && runtime && req.headers.host===new URL(runtime.config.tenantOrigin).host){res.status(403).json({error:{code:'R_REQUIRED'},requestId:res.locals['requestId']});return;}
    if (known.status === 429) res.set('Retry-After', '30');
    res.status(known.status).json({ error: { code: known.code, message: known.code==='ACCOUNT_ALREADY_EXISTS'?'Ya existe una cuenta con ese correo. Ingresa o restablece la contraseña.':known.code==='EMAIL_NOT_VERIFIED'?'Confirma tu correo para continuar.':known.code==='MFA_REQUIRED'?'Protege tu cuenta para acceder a la organización.':known.code==='ROUTE_NOT_FOUND'?'No se encontró la ruta.':known.code==='METHOD_NOT_ALLOWED'?'El método no está permitido.':'El servicio no está disponible.' },
      requestId: res.locals['requestId'] });
  };
  app.use(errors);
  return app;
}
