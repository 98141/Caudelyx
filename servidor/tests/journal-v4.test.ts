/* eslint-disable security/detect-non-literal-fs-filename -- Own mkdtemp fixtures only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { ExternalJournal, type JournalEntry } from '../src/shared/external-journal.js';
import type { SecurityState } from '../src/shared/evidence.js';

test('v4 peer append witnesses verify only the tail; missing/forged hints fall back, prefix tampering plus growth never trusts a cached prefix', async () => {
  const root = resolve('.runtime'); await mkdir(root, {recursive:true});
  const directory = await mkdtemp(resolve(root, 'v4-journal-'));
  try {
    const path = resolve(directory, 'journal.jsonl'), key = randomBytes(32);
    const writer = new ExternalJournal(path, key), peer = new ExternalJournal(path, key);
    const state: SecurityState = {identities:[],factors:[],codes:[],invitations:[],organizations:[]};
    writer.createEmpty(); await writer.readVerified(); await peer.readVerified();
    const append = async () => {
      const data = {_id:writer.length+1,eventId:randomUUID(),previous:writer.signatureAt(writer.length)??'',state};
      const row: JournalEntry = {...data,signature:writer.sign(data)};
      await writer.exclusive(async()=>await writer.append(row));
    };
    await append(); await append(); await append();
    const before = {...peer.diagnostics}; await peer.exclusive(async()=>await peer.readVerified());
    assert.equal(peer.length, 3); assert.equal(peer.isVerified(), true);
    assert.equal(peer.diagnostics.fullAsyncReads, before.fullAsyncReads);
    assert.equal(peer.diagnostics.incrementalAsyncReads, before.incrementalAsyncReads + 1);

    await append();
    assert.equal(peer.isVerified(),true,'bounded authenticated tail is usable by synchronous diagnostics too');
    assert.equal(peer.length,4);assert.equal(peer.diagnostics.boundedIncrementalReads,1);

    await append(); await unlink(path+'.receipts.json');
    await peer.exclusive(async()=>await peer.readVerified());
    assert.equal(peer.length, 5); assert.equal(peer.diagnostics.fullAsyncReads, before.fullAsyncReads+1);
    await append(); await writeFile(path+'.receipts.json', '{"payload":{"version":1,"transitions":[]},"signature":"forged"}');
    await peer.exclusive(async()=>await peer.readVerified()); assert.equal(peer.length, 6);
    assert.equal(peer.diagnostics.fullAsyncReads, before.fullAsyncReads+2);

    const good = await readFile(path);
    const data = {_id:7,eventId:randomUUID(),previous:writer.signatureAt(6)??'',state};
    // Even a genuinely signed tail cannot justify an old prefix whose bytes were changed.
    const forgedPrefix = good.toString('utf8').replace('eventId', 'eventXX');
    await writeFile(path, forgedPrefix + JSON.stringify({...data,signature:writer.sign(data)})+'\n');
    await assert.rejects(peer.exclusive(async()=>await peer.readVerified()));
    await assert.rejects(writer.exclusive(async()=>await writer.append({...data,signature:writer.sign(data)})));
    assert.equal(peer.isVerified(), false);
  } finally {
    assert.equal(dirname(await realpath(directory)), await realpath(root));
    await rm(directory, {recursive:true,force:true});
  }
});
