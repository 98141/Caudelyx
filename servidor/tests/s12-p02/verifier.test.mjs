/* eslint-disable security/detect-non-literal-fs-filename -- New exact UUID own filesystem root, validated against the output guard before create and removal. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {projectRoot,assertWritable,mkdirOwn,writeOwn,appendOwn} from '../../scripts/s12-p02-guard.mjs';
const sha=data=>createHash('sha256').update(data).digest('hex');
test('H01 actual new guard: success, early and late failure never alter candidate/log/receipt/compiled files',async()=>{
 const p01=JSON.parse(await fs.readFile(path.join(projectRoot,'Construccion/Sprints/S12/Evidencias/S12-P01-HASHES.json'),'utf8'));
 const names=[...Object.keys(p01.files),'Construccion/Sprints/S11/Evidencias/S11-P04-RUNS.json','Construccion/Sprints/S11/Evidencias/S11-P04-VERIFY.json','Caudelyx/servidor/dist-s11-p04/src/app.js'];assert.ok(names.length>30);
 const inventory=async()=>Promise.all(names.map(async name=>{const p=path.join(projectRoot,name),s=await fs.stat(p);return[name,sha(await fs.readFile(p)),s.mtimeMs,s.size];}));
 const before=await inventory(),folder=path.join(projectRoot,'Construccion/Sprints/S12/Evidencias/S12-P02-GUARD-QA-'+randomUUID()),fake=path.join(folder,'workspace');
 await mkdirOwn(fake);
 try{
  const own=path.join(fake,'Construccion/Sprints/S12/Evidencias/S12-P02-own.log'),protectedLog=path.join(fake,'Construccion/Sprints/S11/Evidencias/sealed.log');
  await assertWritable(protectedLog,projectRoot);await fs.mkdir(path.dirname(protectedLog),{recursive:true});await fs.writeFile(protectedLog,'untouched');
  await mkdirOwn(path.dirname(own),projectRoot);await writeOwn(own,'success',fake);
  await assert.rejects(writeOwn(protectedLog,'corrupt',fake),/PROTECTED_OR_UNREGISTERED/);
  const stat=await fs.stat(protectedLog),digest=sha(await fs.readFile(protectedLog));
  const fail=async early=>{try{if(early)throw Error('ENOENT_EARLY_BEFORE_FIXTURE');await appendOwn(own,'before-late-failure',fake);throw Error('LATE_FAILURE');}catch{await appendOwn(protectedLog,'must not reach disk',fake);}};
  await assert.rejects(fail(true),/PROTECTED_OR_UNREGISTERED/);await assert.rejects(fail(false),/PROTECTED_OR_UNREGISTERED/);
  assert.equal(sha(await fs.readFile(protectedLog)),digest);assert.equal((await fs.stat(protectedLog)).mtimeMs,stat.mtimeMs);
  const marker=path.join(fake,'Construccion/Sprints/S12/Evidencias/S12-P02-HASHES.json');await writeOwn(marker,'{}',fake);
  await assert.rejects(appendOwn(own,'forbidden after seal',fake),/FROZEN_P02_REFUSE_BEFORE_WRITE/);
  await assert.rejects(mkdirOwn(path.join(fake,'Caudelyx/servidor/dist-s12-p02'),fake),/FROZEN_P02_REFUSE_BEFORE_WRITE/);
  await assert.rejects(writeOwn(path.join(projectRoot,'Construccion/Sprints/S12/Evidencias/S12-P01-VERIFY.json'),'forbidden'),/PROTECTED_OR_UNREGISTERED/);
  assert.deepEqual(await inventory(),before);
 }finally{const checked=await assertWritable(folder);assert.equal(await fs.realpath(folder),checked);await fs.rm(checked,{recursive:true,force:false});assert.equal(await fs.stat(checked).then(()=>true,()=>false),false);}
});
