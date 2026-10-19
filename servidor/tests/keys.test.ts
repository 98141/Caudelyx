import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { loadSyntheticKeys } from '../src/shared/keys.js';

test('persistent synthetic keys survive restart and concurrent startup without silent rotation',async()=>{
  const path=resolve('.runtime',`keys-${randomUUID()}.json`);
  const [first,second]=await Promise.all([loadSyntheticKeys(path),loadSyntheticKeys(path)]);
  const restarted=await loadSyntheticKeys(path);
  assert.deepEqual(first.mail,second.mail);assert.deepEqual(first.totp,restarted.totp);
  assert.notDeepEqual(first.mail,first.totp);assert.equal(first.version,1);
});
