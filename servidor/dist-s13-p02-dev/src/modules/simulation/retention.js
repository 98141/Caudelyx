import { tables } from './models.js';
import { hash } from './codec.js';
export async function retain(store, a, s) {
    const now = store.identity.now();
    for (const table of tables) {
        const rows = await store.all(table, a, s);
        for (const r of rows) {
            if (r['tombstone'] === true) {
                if (Date.parse(r.expiresAt) <= now)
                    await store.remove(table, a, r._id, s);
                continue;
            }
            if (Date.parse(r.expiresAt) <= now) {
                if (table === 's12_payload_chunks' || table === 's12_limits') {
                    await store.remove(table, a, r._id, s);
                    continue;
                }
                // Signed manifests retain hashes. Tombstones retain no labels, amounts,
                // tokens, source refs, payloads, result pages or request bodies.
                const alert = table === 's12_alerts' ? r['payload'] : null;
                await store.put(table, a, { tombstone: true, recordDigest: hash(r), state: 'EXPIRED', ...(alert ? { dedupeKey: alert.dedupeKey, episode: alert.episode } : {}), createdAt: r.createdAt, expiresAt: new Date(now + 30 * 86400000).toISOString() }, s, r._id);
            }
            else if (table === 's12_runs' && r['state'] === 'RUNNING' && Date.parse(String(r['leaseUntil'])) <= now) {
                await store.put(table, a, { ...r, state: 'FAILED', errorCode: 'RUN_INTERRUPTED', retryable: false, leaseUntil: null }, s, r._id);
            }
            else if (table === 's12_runs' && r['state'] === 'QUEUED' && Date.parse(String(r['freshUntil'])) <= now) {
                await store.put(table, a, { ...r, state: 'FAILED', errorCode: 'BASE_STALE', retryable: false, leaseUntil: null }, s, r._id);
            }
        }
    }
}
//# sourceMappingURL=retention.js.map