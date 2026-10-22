/* eslint-disable security/detect-non-literal-fs-filename -- Own mkdtemp fixture under the verified .runtime root. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, realpath, stat } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { ExternalJournal, type JournalEntry } from '../src/shared/external-journal.js';
import type { SecurityState } from '../src/shared/evidence.js';

test('v3 valid legacy journal >10MiB: warm guards and appends never rescan the prefix; unknown tampering closes', async () => {
  const root = await realpath('.runtime'), directory = await mkdtemp(resolve(root, 'v3-journal-'));
  try {
    const journal = new ExternalJournal(resolve(directory, 'journal.jsonl'), randomBytes(32));
    const state: SecurityState = { identities: [], factors: [], codes: [], invitations: [], organizations: Array.from({length:128}, (_, i) => ({
      _id: randomUUID(), name: `Synthetic legacy organization ${i}`, status: 'ACTIVE', version: randomUUID(), authEpoch: randomUUID(),
    })) };
    let previous = ''; const rows: JournalEntry[] = [];
    do {
      const data = { _id: rows.length + 1, eventId: randomUUID(), previous, state };
      const row = { ...data, signature: journal.sign(data) }; rows.push(row); previous = row.signature;
    } while (rows.length * Buffer.byteLength(JSON.stringify(rows[0])) < 11 * 1024 * 1024);
    const text = rows.map(r => JSON.stringify(r) + '\n').join('');
    await writeFile(journal.path, text); assert.ok((await stat(journal.path)).size > 10 * 1024 * 1024);
    await journal.readVerified(true);
    const before = { ...journal.diagnostics }, started = performance.now();
    for (let i = 0; i < 500; i++) assert.equal(journal.isVerified(), true);
    const warmGuardMs = performance.now() - started;
    const data = { _id: rows.length + 1, eventId: randomUUID(), previous, state: {identities:[],factors:[],codes:[],invitations:[],organizations:[],format:'delta-v1' as const} };
    await journal.append({ ...data, signature: journal.sign(data) });
    assert.equal(journal.isVerified(), true); assert.equal(journal.diagnostics.fullAsyncReads, before.fullAsyncReads);
    assert.equal(journal.diagnostics.boundedInlineReads, before.boundedInlineReads);
    assert.ok(warmGuardMs < 500, `500 constant-size guards took ${warmGuardMs}ms`);
    await writeFile(journal.path, text.replace('eventId', 'eventXX'));
    assert.equal(journal.isVerified(), false); await assert.rejects(journal.readVerified(true));
    console.log(JSON.stringify({evidence:'v3-legacy-cache',legacyBytes:Buffer.byteLength(text),entries:rows.length,warmGuards:500,warmGuardMs,fullReadsDuringWarmGuardsAndAppend:0,tamperClosed:true}));
  } finally {
    const actual = await realpath(directory);
    assert.equal(dirname(actual), root); assert.ok(basename(actual).startsWith('v3-journal-'));
    await rm(actual, { recursive: true, force: true });
  }
});
