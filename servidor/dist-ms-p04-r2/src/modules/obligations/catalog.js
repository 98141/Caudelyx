/* eslint-disable security/detect-object-injection -- Root keys are checked against the closed original catalog before lookup. */
import { keyNames, table, booksTable, privateAccounts, privateJournals, assignments, declarations, relationships, commands, globalEvidence } from './models.js';
import { wealthOriginals } from '../wealth/models.js';
import { exchangeTables } from '../exchange/models.js';
export const msOriginals = ['ms_mappings', 'ms_commands', 'ms_mandates', 'ms_closure_policies', 'ms_history_claims', 'ms_distributions', 'ms_distribution_uses', 'ms_savings_links', 'ms_debt_plans'];
export const originals = new Set([booksTable, privateAccounts, privateJournals, assignments, declarations, relationships, commands, globalEvidence, ...keyNames.flatMap(n => [table('BUSINESS', n), table('PERSONAL', n)]), ...wealthOriginals, ...exchangeTables, ...msOriginals]);
export function managementFormatValid(h) {
    const names = Object.keys(h.roots);
    if (names.some(n => !originals.has(n)))
        return false;
    const s10 = names.some(n => n.startsWith('s10_') && h.roots[n].count > 0), s11 = names.some(n => n.startsWith('s11_') && h.roots[n].count > 0), ms = names.some(n => n.startsWith('ms_') && h.roots[n].count > 0);
    if (h.formatVersion === 1)
        return !s10 && !s11 && !ms;
    if (h.formatVersion === 2)
        return h['catalogVersion'] === 2 && h['fundDeltaVersion'] === 1 && !s11 && !ms;
    if (h.formatVersion === 3)
        return h['catalogVersion'] === 3 && h['fundDeltaVersion'] === 1 && h['exchangeVersion'] === 1 && !ms;
    return h.formatVersion === 4 && h['catalogVersion'] === 4 && h['fundDeltaVersion'] === 1 && h['exchangeVersion'] === 1 && h['simpleVersion'] === 1;
}
export const collections = { heads: 's09_projection_heads', manifests: 's09_projection_manifests', barriers: 's09_projection_barriers' };
export const protectedCollections = new Set(originals);
export const limits = Object.freeze({ pendingBytes: 64 * 1024 * 1024, pendingEvents: 10000, barrierPeriodMs: 250, barrierMaxRows: 4096, barrierMaxBytes: 16 * 1024 * 1024, barrierTtlMs: 60000, requestMs: 10000, chunkRows: 512, chunkBytes: 256 * 1024, derivedBytes: 1024 * 1024 * 1024, groupBytes: 4 * 1024 * 1024 * 1024 });
//# sourceMappingURL=catalog.js.map