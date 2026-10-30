import express from 'express';
import { collectionOperations } from '../collections/contract.js';
import { TLSSocket } from 'node:tls';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { AppError } from '../../shared/errors.js';
import { paymentContract, paymentDocument } from './contract.js';
export const isPaymentPath = (path) => /^\/api\/v1\/organizations\/[^/]+\/(?:payments|payment-previews|loan-events|loan-event-reversal-requests|cash-custody|custody-bindings|payment-registration-scopes|held-funds-profile|bank-declarations|reconciliation-links|reconciliation-unlinks|reconciliation-dispositions)(?:\/|$)/i.test(path);
export function paymentError(error) {
    if (!(error instanceof AppError))
        return new AppError(503, 'SERVICE_UNAVAILABLE');
    if (error.code === 'REAUTH_REQUIRED')
        return new AppError(403, 'R_REQUIRED');
    if (['MFA_REQUIRED', 'EMAIL_NOT_VERIFIED', 'RECOVERY_RESTRICTED'].includes(error.code))
        return new AppError(403, 'ACCESS_DENIED');
    const codes = paymentDocument().components.schemas['ErrorCode'].properties.code.enum;
    return codes.includes(error.code) ? error : new AppError(503, 'SERVICE_UNAVAILABLE');
}
export function paymentsRouter(identity, config) {
    const router = express.Router(), contract = paymentContract(), ajv = new Ajv2020({ strict: false });
    formats.default(ajv);
    const components = paymentDocument().components;
    for (const [op, { path, method, definition }] of contract.operations) {
        if (collectionOperations.has(op))
            continue;
        const parameters = definition.parameters.map(p => ({ ...p, validate: ajv.compile({ ...p.schema, components }) }));
        router.all('/api/v1' + path.replace(/\{([^}]+)\}/g, ':$1'), async (req, res, next) => {
            if (req.method.toLowerCase() !== method && !(req.method === 'HEAD' && method === 'get'))
                return next();
            try {
                if (!(req.socket instanceof TLSSocket) || !req.socket.encrypted || req.headers.host !== new URL(config.tenantOrigin).host)
                    throw new AppError(403, 'ACCESS_DENIED');
                await identity.requireOpen('TENANT');
                await identity.beforeRequest?.();
                const cookies = (req.headers.cookie ?? '').split(';').map(c => c.trim()).filter(c => c.startsWith('__Host-caudelyx-session='));
                if (cookies.length !== 1)
                    throw new AppError(401, 'AUTH_INVALID');
                const context = await identity.sessions.find(cookies[0].slice('__Host-caudelyx-session='.length), 'TENANT');
                if (!context)
                    throw new AppError(401, 'AUTH_INVALID');
                if (!identity.payments)
                    throw new AppError(503, 'SERVICE_UNAVAILABLE');
                const org = String(req.params['organizationId']);
                await identity.database.transaction(s => identity.payments.actor(context, org, s));
                if (method === 'get') {
                    if ((res.locals['jsonBodyBytes'] ?? (req.headers['content-length'] || req.headers['transfer-encoding'] ? 1 : 0)) > 0)
                        throw new AppError(422, 'INPUT_INVALID');
                }
                else {
                    if (req.headers.origin !== config.tenantOrigin || req.headers['sec-fetch-site'] === 'cross-site')
                        throw new AppError(400, 'CSRF_INVALID');
                    identity.sessions.checkCsrf(context, req.get('X-CSRF-Token'));
                    if (!req.is('application/json'))
                        throw new AppError(422, 'INPUT_INVALID');
                }
                if (Object.keys(req.query).some(k => !parameters.some(p => p.in === 'query' && p.name === k)))
                    throw new AppError(422, 'INPUT_INVALID');
                for (const p of parameters) {
                    const raw = p.in === 'path' ? req.params[p.name] : p.in === 'query' ? req.query[p.name] : req.get(p.name);
                    if (raw === undefined) {
                        if (p.required)
                            throw new AppError(p.name === 'If-Match' ? 428 : 422, p.name === 'If-Match' ? 'ETAG_REQUIRED' : 'INPUT_INVALID');
                        continue;
                    }
                    const value = p.name === 'limit' && typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : raw;
                    if (!p.validate(value))
                        throw new AppError(422, 'INPUT_INVALID');
                }
                const id = Object.entries(req.params).find(([name]) => name !== 'organizationId')?.[1];
                const result = method === 'get' ? await identity.payments.read(context, op, org, typeof id === 'string' ? id : undefined, req.query) : op === 'previewPayment' ? await identity.payments.preview(context, org, req.body) : await identity.payments.mutate(context, op, org, req.body, req.get('Idempotency-Key'), req.get('If-Match'), typeof id === 'string' ? id : undefined);
                const body = { data: result.data, requestId: res.locals['requestId'] };
                contract.result(op, result.status, body);
                if (result.etag)
                    res.set('ETag', result.etag);
                res.status(result.status).json(body);
            }
            catch (e) {
                const error = paymentError(e);
                if (error.status === 429)
                    res.set('Retry-After', '60');
                res.status(error.status).json({ error: { code: error.code }, requestId: res.locals['requestId'] });
            }
        });
    }
    return router;
}
//# sourceMappingURL=http.js.map