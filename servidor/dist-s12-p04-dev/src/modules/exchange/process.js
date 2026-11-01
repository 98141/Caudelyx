/* eslint-disable security/detect-object-injection -- Environment names are a fixed operator allowlist; no HTTP keys or credentials reach the child. */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
export async function isolated(input, authorized) {
    await authorized();
    const nonce = randomUUID(), kind = input.kind === 'PARSE' ? 'FILE' : 'REPORT', deadline = input.kind === 'PARSE' ? 10000 : 60000;
    const env = Object.fromEntries(['SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'WINDIR'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
    const child = fork(fileURLToPath(new URL('./worker.js', import.meta.url)), [], { windowsHide: true, serialization: 'advanced', execArgv: ['--max-old-space-size=' + (input.kind === 'PARSE' ? '128' : '320')], env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = new Promise(resolve => child.once('exit', () => resolve()));
    let timer, poll, busy = false;
    try {
        const result = await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', () => reject(new AppError(503, kind + '_BUDGET_EXCEEDED')));
            child.once('message', (raw) => { const r = raw; if (r.nonce !== nonce)
                return reject(new AppError(503, 'INTEGRITY_MISMATCH')); if (!r.ok)
                return reject(new AppError(r.status, r.code)); resolve({ value: r.value, metrics: r.metrics }); });
            timer = setTimeout(() => reject(new AppError(503, kind + '_BUDGET_EXCEEDED')), deadline);
            poll = setInterval(() => { if (busy)
                return; busy = true; authorized().catch(reject).finally(() => { busy = false; }); }, 250);
            child.send({ ...input, nonce });
        });
        await authorized();
        return result;
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