/* eslint-disable security/detect-non-literal-fs-filename -- Guarded own QA root and exact synthetic descendants only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {projectRoot,assertWritable,mkdirOwn,writeOwn,appendOwn} from '../../scripts/s13-p02-guard.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
test('new writer rejects seal/errors/aliases/cancel before output and preserves frozen inputs',async()=>{
 const root=path.join(projectRoot,'Construccion/Sprints/S13/Evidencias'),qa=path.join(root,'S13-P02-QA'),fake=path.join(qa,'W'),e=path.join(fake,'Construccion/Sprints/S13/Evidencias');
 const protectedFiles=['S13-P01-HASHES.json','S13-P01-VERIFY.json','S13-P01-RUNS.json'];
 const inventory=async()=>Promise.all(protectedFiles.map(async n=>{const p=path.join(root,n),st=await fs.stat(p);return[n,hash(await fs.readFile(p)),st.size,st.mtimeMs];}));
 const before=await inventory();await assertWritable(qa);await fs.mkdir(e,{recursive:true});const own=path.join(e,'S13-P02-output.log'),marker=path.join(e,'S13-P02-HASHES.json');let checks=0;
 try{
  await writeOwn(own,'valid',fake);checks++;
  for(const unsafe of [path.join(fake,'Caudelyx/servidor/dist-local/no'),path.join(e,'S12-P04-VERIFY.json'),own+':ads',own+' ',own.replace('output','OUT~1'),e+'/../Evidencias/S13-P02-output.log','x'.repeat(241)]){await assert.rejects(writeOwn(unsafe,'forbidden',fake));checks++;}
  const controller=new AbortController();controller.abort();await assert.rejects(writeOwn(path.join(e,'S13-P02-aborted.log'),'forbidden',fake,{signal:controller.signal}));assert.equal(await fs.stat(path.join(e,'S13-P02-aborted.log')).then(()=>true,()=>false),false);checks++;
  const original=fs.lstat;fs.lstat=async(p,...args)=>{if(p===marker)throw Object.assign(Error('injected inaccessible seal'),{code:'EACCES'});return original(p,...args);};try{await assert.rejects(appendOwn(own,'forbidden',fake),/inaccessible/);checks++;}finally{fs.lstat=original;}
  const outside=path.join(qa,'outside'),link=path.join(e,'S13-P02-link');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'untouched'),'sentinel');await fs.symlink(outside,link,'junction');await assert.rejects(writeOwn(path.join(link,'untouched'),'forbidden',fake),/LINKED|ALIASED/);assert.equal(await fs.readFile(path.join(outside,'untouched'),'utf8'),'sentinel');checks++;
  const stamp=await fs.stat(own),bytes=await fs.readFile(own);await fs.writeFile(marker,'{}');await assert.rejects(appendOwn(own,'forbidden',fake),/FROZEN_S13_P02/);assert.deepEqual(await fs.readFile(own),bytes);assert.equal((await fs.stat(own)).mtimeMs,stamp.mtimeMs);checks++;
  await assert.rejects(mkdirOwn(path.join(fake,'Caudelyx/servidor/dist-s13-p02'),fake),/FROZEN/);checks++;
  assert.deepEqual(await inventory(),before);process.stdout.write(JSON.stringify({guardChecks:checks,frozenSHABytesMtimeUnchanged:true,injectedAccessError:true,actualJunction:true,cancelBeforeCreate:true})+'\n');
 }finally{assert.equal(await fs.realpath(qa),qa);assert.equal(path.dirname(qa),root);await fs.rm(qa,{recursive:true,force:false});assert.equal(await fs.stat(qa).then(()=>true,()=>false),false);}
});
