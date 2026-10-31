import { TLSSocket } from 'node:tls';
import { FrozenContract } from './contract.js';
import { financeContract } from '../modules/finance/contract.js';
import { openingContract } from '../modules/opening/contract.js';
import { lendingContract } from '../modules/lending/contract.js';
import { AppError } from './errors.js';
import { paymentContract } from '../modules/payments/contract.js';
import { operationsContract } from '../modules/lending/operations-contract.js';
import { managementContract } from '../modules/obligations/contract.js';
import { exchangeContract } from '../modules/exchange/contract.js';
export function transportFallback(identity, config) {
    const routes = new Map();
    const add = (path, method) => { const p = '/api/v1' + path, set = routes.get(p) ?? new Set(); set.add(method.toUpperCase()); routes.set(p, set); };
    for (const op of new FrozenContract().operations.values())
        add(op.path, op.method);
    for (const c of [financeContract(), openingContract(), lendingContract(), operationsContract(), paymentContract()])
        for (const op of c.operations.values())
            add(op.path, op.method);
    for (const op of managementContract().operations.values())
        add(op.path, op.method);
    for (const op of exchangeContract().operations.values())
        add(op.path, op.method);
    for (const path of ['/auth/session/activity', '/auth/step-up/intents', '/auth/step-up/verify', '/organizations/{organizationId}/financial/initial-balances'])
        add(path, 'post');
    const templates = [...routes].map(([path, methods]) => ({ parts: path.split('/'), methods }));
    return async (req, res, next) => {
        try {
            if (!(req.socket instanceof TLSSocket) || !req.socket.encrypted)
                throw new AppError(403, 'ACCESS_DENIED');
            const realm = req.headers.host === new URL(config.tenantOrigin).host ? 'TENANT' : req.headers.host === new URL(config.platformOrigin).host ? 'PLATFORM' : null;
            if (!realm)
                throw new AppError(403, 'ACCESS_DENIED');
            await identity.requireOpen(realm);
            const parts = req.path.replace(/\/$/, '').split('/');
            // eslint-disable-next-line security/detect-object-injection -- Integer position of a fixed contract template into a split URL array, never an object/query key.
            const found = templates.find(t => t.parts.length === parts.length && t.parts.every((part, i) => part.startsWith('{') ? Boolean(parts[i]) : part.toLowerCase() === parts[i]?.toLowerCase()));
            if (found) {
                res.set('Allow', [...found.methods].sort().join(', '));
                throw new AppError(405, 'METHOD_NOT_ALLOWED');
            }
            throw new AppError(404, 'ROUTE_NOT_FOUND');
        }
        catch (e) {
            next(e);
        }
    };
}
//# sourceMappingURL=transport.js.map