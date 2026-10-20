/* eslint-disable security/detect-non-literal-fs-filename -- Paths are controller-owned test fixtures inside .runtime. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { fixture, totpActor } from '../helpers/fixture.js';
import { RestoreController } from '../../src/shared/restore.js';

test('v2 external file missing, retroceded, truncated or tampered closes the realm and cannot reconcile from Mongo alone', { timeout: 120000 }, async () => {
  const f = await fixture({ controlledRestore: true });
  try {
    const restore = f.restore; assert.ok(restore);
    await restore.flush();
    const early = await readFile(restore.fileJournal.path, 'utf8');
    await totpActor(f); await restore.flush();
    const latest = await readFile(restore.fileJournal.path, 'utf8');
    assert.ok(latest.length > early.length); assert.equal(restore.isOpen(), true);
    for (const variant of ['deleted', 'retroceded', 'truncated', 'tampered']) {
      if (variant === 'deleted') await unlink(restore.fileJournal.path);
      else await writeFile(restore.fileJournal.path, variant === 'retroceded' ? early : variant === 'truncated' ? latest.slice(0, -1) : latest.replace('FACTOR', 'FORGED'));
      // Ensure the tamper always changes a signed byte even if no literal FACTOR appears.
      if (variant === 'tampered') await writeFile(restore.fileJournal.path, latest.replace('eventId', 'eventXX'));
      assert.equal(restore.isOpen(), false, variant);
      const restarted: RestoreController = new RestoreController(f.database, restore.gatePath, restore.key); await restarted.initialize();
      assert.equal(restarted.isOpen(), false, variant);
      await assert.rejects(restarted.reconcile({ approved: true, reviewId: 'synthetic-only' }));
      await writeFile(restore.fileJournal.path, latest);
      await restarted.reconcile({ approved: true, reviewId: 'synthetic-only-control' });
      assert.equal(restarted.isOpen(), true);
    }
    console.log('External evidence variants: deleted/retroceded/truncated/tampered all fail closed; Mongo alone never repairs the file.');
  } finally { await f.close(); }
});
