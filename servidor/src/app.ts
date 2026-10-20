import express, { type ErrorRequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { AppError } from './shared/errors.js';
import { authRouter, strictJson } from './shared/http.js';
import type { IdentityService } from './modules/identity/service.js';
import type { Config } from './shared/config.js';

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
    app.use(authRouter(runtime.identity, runtime.config));
  }
  // No business route is mounted until its authentication dependencies pass checkpoints.
  app.use((_req, _res, next) => next(new AppError(503, 'SERVICE_UNAVAILABLE')));
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    void _next; // Express identifies error handlers by all four parameters.
    const parserError = error instanceof Error && 'type' in error && ['entity.parse.failed', 'entity.too.large'].includes(String(error.type));
    const known = error instanceof AppError ? error : parserError ? new AppError(400, 'BAD_REQUEST') : new AppError(503, 'SERVICE_UNAVAILABLE');
    if (known.status === 429) res.set('Retry-After', '30');
    res.status(known.status).json({ error: { code: known.code, message: 'El servicio no está disponible.' },
      requestId: res.locals['requestId'] });
  };
  app.use(errors);
  return app;
}
