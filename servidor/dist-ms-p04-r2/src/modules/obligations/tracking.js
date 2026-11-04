import { mutation } from './codec.js';
import { originals } from './catalog.js';
export class ManagementTracking {
    active = new WeakMap();
    begin(s) { this.active.set(s, { mutations: [], books: new Set(), latest: new Map() }); }
    end(s) { this.active.delete(s); }
    capture(s, name, before, after) {
        const state = this.active.get(s);
        if (!state || !s.inTransaction() || !originals.has(name))
            throw Error('Unregistered management transaction');
        state.mutations.push(mutation(name, before, after));
        for (const row of [before, after])
            if (typeof row?.['bookId'] === 'string') {
                state.books.add(row['bookId']);
                const stamp = typeof row['recordedAt'] === 'string' ? Date.parse(row['recordedAt']) : 0;
                if (Number.isFinite(stamp))
                    state.latest.set(row['bookId'], Math.max(state.latest.get(row['bookId']) ?? 0, stamp));
            }
    }
}
//# sourceMappingURL=tracking.js.map