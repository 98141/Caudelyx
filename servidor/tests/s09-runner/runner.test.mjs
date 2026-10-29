/* eslint-disable security/detect-non-literal-fs-filename -- Test files stay within one registered own run; containment, ownership and active leases are exercised before cleanup. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inside,noLinks,createRun,releaseRun,cleanupRun,withRun,fingerprint,ensureBuild,command} from '../../scripts/s09-runner-core.mjs';
const server=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const ownRoot=path.join(process.env['CAUDELYX_S09_RUN_FOLDER']??path.join(server,'.runtime/s09-runner'),'test-controls');
const sandbox=work=>withRun(ownRoot,work);

test('reject root/outside/protected sibling; reject active and foreign leases before cleanup',async()=>{
  const owner=await createRun(ownRoot);
  try{
    assert.throws(()=>inside(ownRoot,ownRoot),/UNSAFE_PATH/);
    assert.throws(()=>inside(ownRoot,path.join(server,'.runtime/caudelyx_dev')),/UNSAFE_PATH/);
    assert.throws(()=>inside(ownRoot,path.join(ownRoot,'../caudelyx_manual')),/UNSAFE_PATH/);
    await assert.rejects(cleanupRun(ownRoot,owner),/ACTIVE_LEASE/);
    await assert.rejects(cleanupRun(ownRoot,{...owner,runId:'00000000-0000-0000-0000-000000000000'}),/OWNERSHIP_MISMATCH/);
    const current=JSON.parse(await fs.readFile(path.join(owner.folder,'owner.json'),'utf8'));
    await fs.writeFile(path.join(owner.folder,'owner.json'),JSON.stringify({...current,pid:process.pid+1,active:false}));
    await assert.rejects(cleanupRun(ownRoot,{...owner,pid:process.pid+1}),/FOREIGN_LEASE/);
    await fs.writeFile(path.join(owner.folder,'owner.json'),JSON.stringify(current));
  }finally{await releaseRun(ownRoot,owner);await cleanupRun(ownRoot,owner);}
});
test('setup failure cleans own group controls; fixture has no DB/MFA substitute',async()=>{
  let folder;const receipts=[];
  await assert.rejects(withRun(ownRoot,async owner=>{folder=owner.folder;await fs.writeFile(path.join(folder,'partial-fixture.json'),'synthetic');throw Error('INJECTED_SETUP_FAILURE');},r=>receipts.push(r)),/INJECTED_SETUP_FAILURE/);
  await assert.rejects(fs.stat(folder),{code:'ENOENT'});assert.deepEqual(receipts.map(r=>r.phase),['created','cleanup']);
});
test('failed setup receipt still releases and removes the owned control group',async()=>{
  let folder;const phases=[];
  await assert.rejects(withRun(ownRoot,async()=>assert.fail('work must not start'),receipt=>{
    phases.push(receipt.phase);if(receipt.phase==='created'){folder=receipt.folder;throw Error('INJECTED_RECEIPT_FAILURE');}
  }),/INJECTED_RECEIPT_FAILURE/);
  assert.deepEqual(phases,['created','cleanup']);await assert.rejects(fs.stat(folder),{code:'ENOENT'});
});
test('reject ancestor links by filesystem-metadata guard, without requiring link creation privilege',async()=>sandbox(async owner=>{
  const ancestor=path.join(owner.folder,'guarded'),target=path.join(ancestor,'child');await fs.mkdir(ancestor);
  await assert.rejects(noLinks(ownRoot,target,async name=>name===ancestor?{isSymbolicLink:()=>true}:fs.lstat(name)),/UNSAFE_LINK/);
}));
test('actual junction/reparse escape is rejected when Windows permits creating the fixture link',async t=>sandbox(async owner=>{
  const outside=path.join(owner.folder,'outside'),nested=path.join(owner.folder,'controls');await fs.mkdir(outside);await fs.mkdir(nested);
  const link=path.join(nested,'escape');
  try{await fs.symlink(outside,link,process.platform==='win32'?'junction':'dir');}
  catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Actual junction fixture unavailable: '+error.code+'; metadata rejection is separately tested, no real-junction PASS claimed.');return;}throw error;}
  try{await assert.rejects(noLinks(ownRoot,path.join(link,'child')),/UNSAFE_LINK/);await assert.rejects(cleanupRun(ownRoot,owner),/ACTIVE_LEASE/);}
  finally{await fs.unlink(link);}
}));
test('exact build cache invalidates source/config/dependency changes and output corruption',async()=>sandbox(async owner=>{
  const source=path.join(owner.folder,'source.ts'),config=path.join(owner.folder,'config.json'),dependency=path.join(owner.folder,'dep.d.ts'),out=path.join(owner.folder,'out');
  await fs.writeFile(source,'export const value=1;');await fs.writeFile(config,'{}');await fs.writeFile(dependency,'declare const value: number;');let builds=0;
  const options={root:owner.folder,output:out,inputs:[source,config,dependency],metadata:{compiler:'fixture-compiler-v1',flags:['strict']},compile:async()=>{builds++;await fs.writeFile(path.join(out,'compiled.js'),'compiled '+builds);}};
  assert.equal((await ensureBuild(options)).cached,false);assert.equal((await ensureBuild(options)).cached,true);assert.equal(builds,1);
  const first=(await fingerprint(options.inputs,options.metadata)).key;
  for(const file of [source,config,dependency]){await fs.appendFile(file,'\n');assert.equal((await ensureBuild(options)).cached,false);}
  assert.notEqual((await fingerprint(options.inputs,options.metadata)).key,first);
  await fs.writeFile(path.join(out,'compiled.js'),'corrupted');assert.equal((await ensureBuild(options)).cached,false);
  assert.equal((await ensureBuild({...options,metadata:{...options.metadata,flags:['different']}})).cached,false);
  assert.equal(builds,6);
}));
test('unowned artifacts and concurrent build lease prevent overwrite',async()=>sandbox(async owner=>{
  const source=path.join(owner.folder,'source.ts'),out=path.join(owner.folder,'out');await fs.writeFile(source,'source');await fs.mkdir(out);await fs.writeFile(path.join(out,'foreign.txt'),'preserve');
  const options={root:owner.folder,output:out,inputs:[source],compile:async()=>assert.fail('must not compile')};
  await assert.rejects(ensureBuild(options),/UNOWNED_OUTPUT/);assert.equal(await fs.readFile(path.join(out,'foreign.txt'),'utf8'),'preserve');
  await fs.writeFile(path.join(out,'.s09-build-lease.json'),'foreign-active-lease');
  await assert.rejects(ensureBuild(options),/BUILD_LEASE_ACTIVE_OR_UNRECOVERED/);assert.equal(await fs.readFile(path.join(out,'.s09-build-lease.json'),'utf8'),'foreign-active-lease');
}));
test('input mutation during build is rejected; failed compiler never leaves a reusable success marker',async()=>sandbox(async owner=>{
  const source=path.join(owner.folder,'source.ts'),out=path.join(owner.folder,'out');await fs.writeFile(source,'before');
  await assert.rejects(ensureBuild({root:owner.folder,output:out,inputs:[source],compile:async()=>fs.writeFile(source,'after')}),/INPUT_CHANGED_DURING_BUILD/);
  await assert.rejects(fs.stat(path.join(out,'.s09-build.json')),{code:'ENOENT'});
  await assert.rejects(ensureBuild({root:owner.folder,output:out,inputs:[source],compile:async()=>{throw Error('COMPILER_FAIL');}}),/COMPILER_FAIL/);
  await assert.rejects(fs.stat(path.join(out,'.s09-build-lease.json')),{code:'ENOENT'});
}));
test('own child command completes without a pending timeout/listener wait',async()=>{
  const r=await command([process.execPath,'-e','process.stdout.write("ready")'],{cwd:server,timeoutMs:10000});
  assert.equal(r.exitCode,0);assert.equal(r.stdout,'ready');assert.equal(r.timedOut,false);
  // Correctness asserts prompt completion by state, not a tight/flaky wall-time threshold.
});
test('own child timeout and bounded-output overflow are recorded as failures',async()=>{
  const timeout=await command([process.execPath,'-e','setInterval(()=>{},1000)'],{cwd:server,timeoutMs:150});assert.equal(timeout.timedOut,true);assert.notEqual(timeout.exitCode,0);
  const output=await command([process.execPath,'-e','process.stdout.write("x".repeat(10000))'],{cwd:server,maxOutputBytes:100});assert.equal(output.outputOverflow,true);
});
