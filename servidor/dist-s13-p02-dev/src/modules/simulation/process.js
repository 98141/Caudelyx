/* eslint-disable security/detect-object-injection -- Fixed process environment allowlist; synthetic read-only calculation payload contains no session or credentials. */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
export async function isolated(base, definition, seed, sensitivity, authorized) {
    await authorized();
    const nonce = randomUUID(), env = Object.fromEntries(['SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'WINDIR'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
    const child = fork(fileURLToPath(new URL('./worker.js', import.meta.url)), [], { windowsHide: true, serialization: 'advanced', execArgv: ['--max-old-space-size=128'], env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = new Promise(resolve => child.once('close', () => resolve()));
    let timer, poll, busy = false;
    try {
        const result = await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', () => reject(new AppError(503, 'SIMULATION_BUDGET_EXCEEDED')));
            let proposal;
            child.on('message', (raw) => {
                const r = raw;
                if (r.nonce !== nonce)
                    return reject(new AppError(503, 'INTEGRITY_MISMATCH'));
                if (!r.ok)
                    return reject(new AppError(r.code === 'SIMULATION_SCOPE_TOO_LARGE' ? 413 : 503, r.code));
                if (r.type === 'PROPOSAL' && !proposal) {
                    proposal = r.value;
                    return;
                }
                if (r.type !== 'FINAL' || !proposal || !Number.isFinite(r.metrics?.peakRSS) || r.metrics.peakRSS > 268435456 || !Number.isFinite(r.metrics.durationMs) || r.metrics.durationMs > 10000)
                    return reject(new AppError(503, 'INTEGRITY_MISMATCH'));
                resolve({ value: proposal, metrics: r.metrics });
            });
            timer = setTimeout(() => reject(new AppError(503, 'SIMULATION_BUDGET_EXCEEDED')), 10000);
            poll = setInterval(() => { if (busy)
                return; busy = true; authorized().catch(reject).finally(() => { busy = false; }); }, 250);
            child.send({ nonce, base, definition, seed, sensitivity });
        });
        await authorized();
        return { ...result, metrics: { ...result.metrics, workerPid: child.pid ?? null } };
    }
    finally {
        clearTimeout(timer);
        clearInterval(poll);
        if (child.exitCode === null && !child.killed)
            child.kill();
        await exited;
    }
}
//# sourceMappingURL=process.js.map