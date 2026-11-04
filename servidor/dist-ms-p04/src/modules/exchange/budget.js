import { AppError } from '../../shared/errors.js';
let current = null;
export function startBudget(kind, memory, milliseconds) { current = { kind, memory, deadline: performance.now() + milliseconds, peak: process.memoryUsage().rss }; checkBudget(); }
export function checkBudget() { if (!current)
    return; current.peak = Math.max(current.peak, process.memoryUsage().rss); if (current.peak > current.memory || performance.now() > current.deadline)
    throw new AppError(503, current.kind + '_BUDGET_EXCEEDED'); }
export function budgetMetrics() { checkBudget(); return { peakRSS: current?.peak ?? process.memoryUsage().rss, rss: process.memoryUsage().rss }; }
//# sourceMappingURL=budget.js.map