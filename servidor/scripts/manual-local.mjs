import fs from 'node:fs/promises';
import path from 'node:path';
import { manualPaths, requireSyntheticMode, mongoProcesses, safeDirectory, acquireRuntime } from './local-runtime.mjs';

requireSyntheticMode();
if (process.argv.includes('--reset')) {
  const release = await acquireRuntime();
  try {
    const p = manualPaths(), processes = await mongoProcesses();
    if (processes.some(r => path.resolve(r.path) === p.data)) throw new Error('Manual Mongo still in use');
    try { await fs.rm(await safeDirectory(p.data, 'manual-'), { recursive: true, force: false, maxRetries: 3 }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    // Reset only this profile's control evidence; keep the current encryption keyring.
    try {
      await safeDirectory(p.control, 'manual-control');
      for (const name of await fs.readdir(p.control)) {
        if (!/^gate-caudelyx_manual\.json(?:\.journal\.jsonl(?:\.lock)?)?$/.test(name)) continue;
        const target = path.join(p.control, name), s = await fs.lstat(target);
        if (!s.isFile() || s.isSymbolicLink()) throw new Error('Unsafe manual marker');
        await fs.unlink(target);
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await fs.unlink(p.descriptor).catch(e => { if (e.code !== 'ENOENT') throw e; });
    console.log('Estado manual sintético borrado; keyring conservado. No se tocó Mongo27017.');
  } finally { await release(); }
} else {
  process.argv.push('--manual');
  await import('./dev-local.mjs');
}
