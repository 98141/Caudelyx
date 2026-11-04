import { evaluate } from './engine.js';
process.once('message', (raw) => {
    const input = raw, start = performance.now();
    let peakRSS = process.memoryUsage.rss();
    try {
        const budget = () => { peakRSS = Math.max(peakRSS, process.memoryUsage.rss(), process.resourceUsage().maxRSS * 1024); if (performance.now() - start > 10000 || peakRSS > 268435456)
            throw Error('SIMULATION_BUDGET_EXCEEDED'); };
        const value = evaluate(input.base, input.definition, { seed: input.seed, sensitivity: input.sensitivity, budget });
        budget();
        if (Buffer.byteLength(JSON.stringify(value)) > 16777216)
            throw Error('SIMULATION_SCOPE_TOO_LARGE');
        budget();
        // Parent keeps the proposal private until the final post-serialization budget
        // acknowledgement. IPC memory is therefore included before publication.
        process.send?.({ nonce: input.nonce, type: 'PROPOSAL', ok: true, value }, () => {
            try {
                budget();
                process.send?.({ nonce: input.nonce, type: 'FINAL', ok: true, metrics: { peakRSS, durationMs: performance.now() - start } }, () => process.disconnect());
            }
            catch {
                process.send?.({ nonce: input.nonce, type: 'ERROR', ok: false, code: 'SIMULATION_BUDGET_EXCEEDED' }, () => process.disconnect());
            }
        });
    }
    catch (e) {
        const code = e instanceof Error && 'code' in e ? String(e.code) : e instanceof Error ? e.message : 'SIMULATION_BUDGET_EXCEEDED';
        process.send?.({ nonce: input.nonce, type: 'ERROR', ok: false, code }, () => process.disconnect());
    }
});
//# sourceMappingURL=worker.js.map