import express from 'express';
import { TLSSocket } from 'node:tls';
import { AppError } from '../../shared/errors.js';
import { reportingContract } from './contract.js';
export const isReportingPath = (path) => /^\/api\/v1\/organizations\/[^/]+\/reporting(?:\/|$)/i.test(path);
export function reportingError(error) {
    if (!(error instanceof AppError))
        return new AppError(503, error && typeof error === 'object' && 'code' in error && error.code === 50 ? 'REPORT_BUDGET_EXCEEDED' : 'SERVICE_UNAVAILABLE');
    if (['MFA_REQUIRED', 'RECOVERY_RESTRICTED'].includes(error.code))
        return new AppError(403, 'ACCESS_DENIED');
    return reportingContract().errors.has(error.code) ? error : new AppError(503, 'SERVICE_UNAVAILABLE');
}
export function reportingRouter(identity, config) {
    const router = express.Router(), contract = reportingContract();
    for (const [operation, { path, definition }] of contract.operations) {
        router.all('/api/v1' + path.replace(/\{([^}]+)\}/g, ':$1'), async (req, res, next) => {
            try {
                if (!(req.socket instanceof TLSSocket) || !req.socket.encrypted || req.headers.host !== new URL(config.tenantOrigin).host)
                    throw new AppError(403, 'ACCESS_DENIED');
                await identity.requireOpen('TENANT');
                const cookies = (req.headers.cookie ?? '').split(';').map(c => c.trim()).filter(c => c.startsWith('__Host-caudelyx-session='));
                if (cookies.length !== 1)
                    throw new AppError(401, 'AUTH_INVALID');
                const context = await identity.sessions.find(cookies[0].slice('__Host-caudelyx-session='.length), 'TENANT');
                if (!context)
                    throw new AppError(401, 'AUTH_INVALID');
                if (req.method !== 'GET') {
                    res.set('Allow', 'GET');
                    throw new AppError(405, 'METHOD_NOT_ALLOWED');
                }
                if ((res.locals['jsonBodyBytes'] ?? (req.headers['content-length'] || req.headers['transfer-encoding'] ? 1 : 0)) > 0)
                    throw new AppError(422, 'INPUT_INVALID');
                if (Object.keys(req.query).some(k => !definition.parameters.some(p => p.in === 'query' && p.name === k)))
                    throw new AppError(422, 'INPUT_INVALID');
                for (const p of definition.parameters) {
                    const raw = p.in === 'path' ? req.params[p.name] : req.query[p.name];
                    if (raw === undefined) {
                        if (p.required)
                            throw new AppError(422, 'INPUT_INVALID');
                        continue;
                    }
                    const value = p.name === 'limit' && typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : raw;
                    contract.validate(operation + ':' + p.name, value);
                }
                if (!identity.reporting)
                    throw new AppError(503, 'SERVICE_UNAVAILABLE');
                const id = Object.entries(req.params).find(([name]) => name !== 'organizationId')?.[1];
                const result = await identity.reporting.read(context, operation, String(req.params['organizationId']), typeof id === 'string' ? id : undefined, req.query);
                contract.validate(operation + ':response', { data: result.data }, true);
                res.set('X-Request-Id', String(res.locals['requestId']));
                res.status(200).json({ data: result.data });
            }
            catch (e) {
                next(reportingError(e));
            }
        });
    }
    return router;
}
//# sourceMappingURL=http.js.map