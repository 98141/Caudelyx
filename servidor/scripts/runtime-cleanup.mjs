import fs from 'node:fs/promises';
import path from 'node:path';
import { runtimeRoot, mongoProcesses, tlsProcesses, safeDirectory, requireSyntheticMode, acquireRuntime } from './local-runtime.mjs';

requireSyntheticMode();
const release = await acquireRuntime();
try {
  const processes = [...await mongoProcesses(), ...await tlsProcesses()];
  // One fresh process snapshot for the batch. Old eligible mkdtemp names are never reused by our helpers;
  // local launchers share this exclusive lock, and newly created test directories are protected by the age threshold.
  const confirmed = [...await mongoProcesses(), ...await tlsProcesses()];
  let removed = 0, retained = 0;
  for (const name of await fs.readdir(runtimeRoot)) {
    if (!/^(?:replica-|tls-)[A-Za-z0-9_-]+$/.test(name)) continue;
    const directory = path.join(runtimeRoot, name);
    if ((await fs.lstat(directory)).mtimeMs > Date.now() - 3600000) { retained++; continue; }
    if (processes.some(r => path.resolve(r.path) === directory)) { retained++; continue; }
    const safe = await safeDirectory(directory, name.startsWith('replica-') ? 'replica-' : 'tls-');
    if (confirmed.some(r => path.resolve(r.path) === safe)) { retained++; continue; }
    await fs.rm(safe, { recursive: true, force: false, maxRetries: 3 }); removed++;
  }
  console.log(JSON.stringify({ removed, retained, protected: ['manual-replica', 'manual-control', 'keyring', 'tls', 'Mongo27017'] }));
} finally { await release(); }
