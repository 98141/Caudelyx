import { domainCollections } from '../../lending/evidence-v2.js';
export const originals = new Set([...domainCollections,
    'financial_accounts', 'financial_journals', 'financial_idempotency', 'opening_files',
    'opening_validations', 'opening_references', 'opening_idempotency', 'financial_books',
    'financial_evidence_head', 'lending_merkle_nodes', 'lending_merkle_orgs']);
export const collections = {
    heads: 'reporting_projection_heads', units: 'reporting_projection_units',
    flows: 'reporting_projection_flows', rows: 'reporting_projection_rows',
    nodes: 'reporting_projection_nodes', manifests: 'reporting_projection_manifests',
    barriers: 'reporting_projection_barriers',
};
export const derived = new Set([collections.units, collections.flows, collections.rows, collections.nodes]);
export const protectedCollections = new Set([...originals, ...derived]);
export const limits = Object.freeze({ pendingBytes: 64 * 1024 * 1024, pendingEvents: 10000,
    barrierPeriodMs: 250, barrierMaxRows: 4096, barrierMaxBytes: 16 * 1024 * 1024,
    barrierTtlMs: 60000, requestMs: 10000, chunkRows: 512, chunkBytes: 256 * 1024,
    derivedBytes: 1024 * 1024 * 1024, groupBytes: 4 * 1024 * 1024 * 1024 });
//# sourceMappingURL=catalog.js.map