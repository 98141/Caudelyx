/* eslint-disable security/detect-non-literal-fs-filename -- Exact generated fixture paths are verified under fixed .runtime. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, utimes, stat, rm, readdir } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { startReplicaSet } from './helpers/replica-set.js';
import { testCertificate } from './helpers/tls.js';
const exec = promisify(execFile);
test('DEV cleanup removes only old inactive replica/tls; retains active Mongo, recent folders and manual data; TLS helper leaves no folder', { timeout: 120000 }, async () => {
  const root = resolve('.runtime'), id = randomUUID();
  const targets = ['replica-clean-' + id, 'tls-clean-' + id, 'tls-recent-' + id, 'manual-clean-' + id].map(n => resolve(root, n));
  const replica = await startReplicaSet();
  try {
    const keyPath = '.runtime/synthetic-keys.json';
    const keyBefore = await readFile(keyPath).then(b => createHash('sha256').update(b).digest('hex')).catch(() => null);
    for (const p of targets) { await mkdir(p); await writeFile(resolve(p, 'synthetic-marker'), 'no private material'); }
    const old = new Date(Date.now() - 7200000);
    for (const p of [...targets.slice(0, 2), replica.directory]) await utimes(p, old, old);
    const output = await exec(process.execPath, ['scripts/runtime-cleanup.mjs'], { env: { ...process.env, CAUDELYX_MODE: 'local-synthetic' }, windowsHide: true, timeout:60000 });
    assert.ok(JSON.parse(output.stdout).removed >= 2);
    for (const p of targets.slice(0, 2)) await assert.rejects(stat(p));
    assert.ok((await stat(replica.directory)).isDirectory());
    assert.ok((await stat(targets[2]!)).isDirectory()); assert.ok((await stat(targets[3]!)).isDirectory());
    const keyAfter = await readFile(keyPath).then(b => createHash('sha256').update(b).digest('hex')).catch(() => null);
    assert.equal(keyAfter, keyBefore);
    const before = (await readdir(root)).filter(n => n.startsWith('tls-')).sort();
    const tls = await testCertificate(); assert.ok(tls.key.length > 0 && tls.cert.length > 0);
    assert.deepEqual((await readdir(root)).filter(n => n.startsWith('tls-')).sort(), before);
  } finally {
    await replica.stop();
    for (const p of targets) {
      if (dirname(p) !== root || !basename(p).endsWith(id)) throw new Error('Unsafe cleanup fixture');
      await rm(p, { recursive: true, force: true });
    }
  }
});
