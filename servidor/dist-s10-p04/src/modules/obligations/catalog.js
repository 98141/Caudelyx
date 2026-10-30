import { keyNames, table, booksTable, privateAccounts, privateJournals, assignments, declarations, relationships, commands, globalEvidence } from './models.js';
import { wealthOriginals } from '../wealth/models.js';
export const originals = new Set([booksTable, privateAccounts, privateJournals, assignments, declarations, relationships, commands, globalEvidence, ...keyNames.flatMap(n => [table('BUSINESS', n), table('PERSONAL', n)]), ...wealthOriginals]);
export const collections = { heads: 's09_projection_heads', manifests: 's09_projection_manifests', barriers: 's09_projection_barriers' };
export const protectedCollections = new Set(originals);
export const limits = Object.freeze({ pendingBytes: 64 * 1024 * 1024, pendingEvents: 10000, barrierPeriodMs: 250, barrierMaxRows: 4096, barrierMaxBytes: 16 * 1024 * 1024, barrierTtlMs: 60000, requestMs: 10000, chunkRows: 512, chunkBytes: 256 * 1024, derivedBytes: 1024 * 1024 * 1024, groupBytes: 4 * 1024 * 1024 * 1024 });
//# sourceMappingURL=catalog.js.map