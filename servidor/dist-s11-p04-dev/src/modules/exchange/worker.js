import { parseWorkbook } from './workbook.js';
import { normalizeWorkbook } from './normalizer.js';
import { exportReport } from './formats.js';
import { startBudget, budgetMetrics } from './budget.js';
import { AppError } from '../../shared/errors.js';
// One IPC request per isolated process. No DB, HTTP clients, operator secrets or
// uploaded paths are accepted. The parent exclusively owns lifecycle/authority.
process.once('message', (raw) => {
    const started = performance.now();
    try {
        if (!raw || !['PARSE', 'EXPORT'].includes(raw.kind) || typeof raw.nonce !== 'string')
            throw new AppError(422, 'INPUT_INVALID');
        startBudget(raw.kind === 'PARSE' ? 'FILE' : 'REPORT', raw.kind === 'PARSE' ? 268435456 : 536870912, raw.kind === 'PARSE' ? 10000 : 60000);
        const value = raw.kind === 'PARSE' ? normalizeWorkbook(parseWorkbook(Buffer.from(raw.bytes)), raw.scope, { mode: raw.mode, namespace: raw.namespace }) : exportReport(raw.format, raw.snapshot);
        process.send?.({ nonce: raw.nonce, ok: true, value, metrics: { ...budgetMetrics(), durationMs: performance.now() - started } }, () => { process.disconnect?.(); });
    }
    catch (error) {
        process.send?.({ nonce: raw?.nonce, ok: false, code: error instanceof AppError ? error.code : 'SERVICE_UNAVAILABLE', status: error instanceof AppError ? error.status : 503, metrics: { durationMs: performance.now() - started, rss: process.memoryUsage().rss } }, () => { process.disconnect?.(); });
    }
});
//# sourceMappingURL=worker.js.map