import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { access,writeFile,unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { localTestProfile, testNames } from '../helpers/local-test-profile.js';

test('P04 cleanup rejects protected names before allocation',()=>{
  for(const id of ['caudelyx_dev','caudelyx_manual','../manual-control','admin',''])assert.throws(()=>testNames(id));
});
test('P04 refuses cleanup with a live lease; exact owner can clean after releasing it',async()=>{
  const profile=await localTestProfile(),lock=join(profile.directory,'p04-live-test.lock');
  try{
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Exact validated own fixture path.
    await writeFile(lock,JSON.stringify({pid:process.pid}),{flag:'wx'});
    await assert.rejects(profile.dispose(),/Live fixture process/);
    await access(profile.directory);
  }finally{
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Release only the lease created above.
    await unlink(lock);await profile.dispose();
  }
});
test('P04 orderly cancellation closes worker connection and removes its real group',{timeout:30000},async()=>{
  const helper=new URL('../helpers/local-test-profile.js',import.meta.url).href;
  const code=`
    import {MongoClient} from 'mongodb';
    const {localTestProfile}=await import(${JSON.stringify(helper)});
    const profile=await localTestProfile(),client=new MongoClient(profile.uri);
    try{
      await client.connect();await client.db(profile.database).collection('cancelled_fixture').insertOne({synthetic:true});
      const cancelled=new Promise(r=>process.once('message',r));process.send('READY');await cancelled;
    }finally{await client.close();await profile.dispose();process.disconnect();}
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{env:process.env,windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
  child.stderr?.resume();const ended=once(child,'exit');
  await Promise.race([once(child,'message'),ended.then(()=>{throw Error('Cancellation worker exited before ready');})]);
  child.send('LOCAL_TEST_CANCEL');const [status]=await ended;assert.equal(status,0);
});
test('P04 a setup failure releases the exact real Mongo group and controls; same group can be reused',async()=>{
  for(let iteration=0;iteration<2;iteration++) {
    const profile=await localTestProfile();
    const client=new MongoClient(profile.uri);
    try {
      await client.connect();
      for(const name of profile.names)await client.db(name).collection('synthetic_setup').insertOne({synthetic:true});
      await assert.rejects(async()=>{throw Error('Simulated setup failure after real allocation');},/setup failure/);
    }finally{await client.close();await profile.dispose();}
    await assert.rejects(access(profile.directory),{code:'ENOENT'});
    const inspect=new MongoClient(profile.uri);await inspect.connect();
    try{const found=await inspect.db('admin').command({listDatabases:1,nameOnly:true,filter:{name:{$in:profile.names}}});assert.equal(found['databases'].length,0);}finally{await inspect.close();}
  }
});
