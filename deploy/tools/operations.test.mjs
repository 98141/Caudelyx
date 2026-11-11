// No Docker daemon or real data. Real AES-GCM/files and native Node extractor.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import {archiveDirectory,encryptArchive,decryptArchive,restoreArchiveToProcess,restoreDockerArgs,operationCode} from './operations.mjs';

const script=fileURLToPath(new URL('./operations.mjs',import.meta.url)),repo=fileURLToPath(new URL('../..',import.meta.url));
const digest=b=>createHash('sha256').update(b).digest('hex');
test('focused restore recovery and failures preserve sources and quarantine targets',async t=>{
 const parent=path.resolve(repo,'servidor/.runtime'),root=path.resolve(process.env.F06_RESTORE_TEST_ROOT??path.join(parent,'f06-restore-tests-'+randomUUID()));
 assert.equal(path.dirname(root),parent);assert.match(path.basename(root),/^f06-restore-tests-[a-f0-9-]{36}$/);
 await fs.mkdir(parent,{recursive:true});await fs.mkdir(root,{mode:0o700});await fs.writeFile(path.join(root,'marker'),'f06-restore-tests',{flag:'wx'});
 let bytesBeforeCleanup=0;
 const dirs=['source','local','process','badtag-local','badtag-process','occupied','eof','missing-source','space','format'];
 try{
  for(const dir of dirs)await fs.mkdir(path.join(root,dir),{mode:0o700});
  const payload=Buffer.alloc(4*1024*1024,37),key=Buffer.alloc(32,19),source=path.join(root,'source/payload.bin'),cipher=path.join(root,'archive.enc');
  await fs.writeFile(source,payload,{flag:'wx'});
  const record=await encryptArchive(Readable.from(archiveDirectory(path.join(root,'source'))),cipher,key),cipherHash=digest(await fs.readFile(cipher));
  const helper=(dir,stdio='pipe')=>spawn(process.execPath,[script,'__extract',path.join(root,dir)],{stdio:[stdio,'ignore','pipe'],windowsHide:true});
  await t.test('Docker extractor explicitly keeps stdin open and refuses original volume names',()=>{
   const args=restoreDockerArgs('caudelyx-demo-restore-'+randomUUID()+'-mongo','node@sha256:'+'a'.repeat(64));
   assert.ok(args.includes('--interactive'));assert.ok(!args.includes('--tty'));assert.ok(args.includes('none'));
   assert.throws(()=>restoreDockerArgs('caudelyx-demo-mongo-data','node@sha256:'+'a'.repeat(64)),/RESTORE_ORIGINAL_PATH_FORBIDDEN/);
  });
  await t.test('EOF at helper reproduces missing-input failure safely (no Docker claim)',async()=>{
   const child=helper('eof','ignore');let stderr='';child.stderr.on('data',b=>{stderr+=b;});
   const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code));});
   assert.equal(result,1);assert.match(stderr,/BACKUP_TRUNCATED/);assert.ok(!stderr.includes(root));
  });
  await t.test('authenticated native recovery with 4MiB/backpressure preserves bytes',async()=>{
   const result=await decryptArchive(cipher,record,key,path.join(root,'local'));assert.equal(result.bytes,payload.length);
   assert.equal(digest(await fs.readFile(path.join(root,'local/payload.bin'))),digest(payload));
  });
  await t.test('real extraction subprocess receives full GCM stream and closes successfully',async()=>{
   const child=helper('process');await restoreArchiveToProcess(cipher,record,key,child);
   assert.equal(child.exitCode,0);assert.equal(digest(await fs.readFile(path.join(root,'process/payload.bin'))),digest(payload));
   if(process.platform!=='win32'){const before=await fs.stat(source),after=await fs.stat(path.join(root,'process/payload.bin'));assert.equal(after.mode&0o777,before.mode&0o777);assert.equal(after.uid,before.uid);assert.equal(after.gid,before.gid);assert.ok(Math.abs(after.mtimeMs-before.mtimeMs)<2);}
  });
  await t.test('bad GCM tag rejects local and helper streams and retains partials',async()=>{
   const bad={...record,tag:record.tag==='0'.repeat(32)?'1'.repeat(32):'0'.repeat(32)};
   await assert.rejects(decryptArchive(cipher,bad,key,path.join(root,'badtag-local')),e=>operationCode(e)==='RESTORE_GCM_AUTH_FAILED');
   await assert.rejects(restoreArchiveToProcess(cipher,bad,key,helper('badtag-process')),e=>operationCode(e)==='RESTORE_GCM_AUTH_FAILED');
   assert.equal((await fs.stat(path.join(root,'badtag-local'))).isDirectory(),true);assert.equal((await fs.stat(path.join(root,'badtag-process'))).isDirectory(),true);
  });
  await t.test('ciphertext integrity failure never extracts',async()=>{
   const bad=path.join(root,'truncated.enc');await fs.writeFile(bad,(await fs.readFile(cipher)).subarray(0,100));
   await assert.rejects(decryptArchive(bad,record,key,path.join(root,'format')),/BACKUP_CIPHERTEXT_INVALID/);assert.deepEqual(await fs.readdir(path.join(root,'format')),[]);
  });
  await t.test('nonempty target is preserved; helper code survives secondary pipe error',async()=>{
   const sentinel=path.join(root,'occupied/keep.txt');await fs.writeFile(sentinel,'synthetic-preserve',{flag:'wx'});
   await assert.rejects(restoreArchiveToProcess(cipher,record,key,helper('occupied')),e=>operationCode(e)==='RESTORE_TARGET_NOT_EMPTY');
   assert.equal(await fs.readFile(sentinel,'utf8'),'synthetic-preserve');
  });
  await t.test('spawn failure is handled without unhandled rejection',async()=>{
   const child=spawn(path.join(root,'absent-executable'),[],{stdio:['pipe','ignore','pipe'],windowsHide:true});
   await assert.rejects(restoreArchiveToProcess(cipher,record,key,child),e=>operationCode(e)==='ENOENT');
  });
  await t.test('early child exit with untrusted stderr is bounded and sanitized',async()=>{
   const child=spawn(process.execPath,['-e',"process.stderr.write('secret-synthetic-payload'.repeat(2000));process.exit(37)"],{stdio:['pipe','ignore','pipe'],windowsHide:true});
   await assert.rejects(restoreArchiveToProcess(cipher,record,key,child),e=>operationCode(e)==='RESTORE_HELPER_EXIT_FAILED'&&e.cause?.exitCode===37&&!e.message.includes('secret'));
  });
  await t.test('source read error retains its cause and terminates waiting helper',async()=>{
   const child=helper('missing-source');await assert.rejects(restoreArchiveToProcess(path.join(root,'missing.enc'),record,key,child),e=>operationCode(e)==='ENOENT');
   assert.ok(child.exitCode!==null||child.signalCode!==null);
  });
  await t.test('cancellation reaps only the owned child if it ignores stdin EOF',async()=>{
   const child=spawn(process.execPath,['-e','process.stdin.resume();setInterval(()=>{},1000)'],{stdio:['pipe','ignore','pipe'],windowsHide:true});
   await assert.rejects(restoreArchiveToProcess(path.join(root,'missing.enc'),record,key,child),e=>operationCode(e)==='ENOENT');
   assert.ok(child.exitCode!==null||child.signalCode!==null);
  });
  await t.test('invalid archive JSON cannot leak its contents through helper diagnostics',async()=>{
   const text=Buffer.from('secret-synthetic-payload'),length=Buffer.alloc(4);length.writeUInt32BE(text.length);
   const invalid=path.join(root,'format.enc'),badRecord=await encryptArchive(Readable.from([length,text,Buffer.alloc(4)]),invalid,key),child=helper('format');
   let stderr='';child.stderr.on('data',b=>{stderr+=b;});
   await assert.rejects(restoreArchiveToProcess(invalid,badRecord,key,child),e=>operationCode(e)==='BACKUP_FORMAT_INVALID');
   assert.ok(!stderr.includes('secret-synthetic-payload'));assert.ok(!stderr.includes(root));
  });
  await t.test('safe helper filesystem code propagates without raw payload',async()=>{
   const child=spawn(process.execPath,['-e',"process.stderr.write(JSON.stringify({event:'CAUDELYX_RESTORE',stage:'EXTRACT',status:'FAIL',code:'ENOSPC'})+'\\n');process.exit(1)"],{stdio:['pipe','ignore','pipe'],windowsHide:true});
   await assert.rejects(restoreArchiveToProcess(cipher,record,key,child),e=>operationCode(e)==='ENOSPC');
   assert.equal(operationCode(new Error('secret-synthetic-payload')),'UNCLASSIFIED');assert.equal(operationCode({code:'SECRET_UNKNOWN'}),'UNCLASSIFIED');
   assert.equal(operationCode({stderr:'invalid mount config: private-secret-path'}),'RESTORE_HELPER_MOUNT_INVALID');
   assert.equal(operationCode({stderr:'Cannot connect to the Docker daemon: private-secret-socket'}),'DOCKER_UNAVAILABLE');
  });
  await t.test('backup and original synthetic data remain byte identical after all failures',async()=>{
   assert.equal(digest(await fs.readFile(cipher)),cipherHash);assert.equal(digest(await fs.readFile(source)),digest(payload));
  });
 }finally{
  // Test fixtures only; operational restore code NEVER deletes partial targets.
  assert.equal(await fs.realpath(root),root);assert.equal(await fs.readFile(path.join(root,'marker'),'utf8'),'f06-restore-tests');
  async function clean(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name),s=await fs.lstat(p);assert.equal(s.isSymbolicLink(),false);assert.ok(p.startsWith(root+path.sep));if(s.isDirectory())await clean(p);else{bytesBeforeCleanup+=s.size;await fs.unlink(p);}}await fs.rmdir(dir);}
  await clean(root);t.diagnostic('Synthetic fixture bytes cleaned: '+bytesBeforeCleanup);assert.ok(bytesBeforeCleanup<128*1024*1024);
 }
});
