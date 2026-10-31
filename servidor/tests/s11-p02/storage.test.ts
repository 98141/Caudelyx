/* eslint-disable security/detect-non-literal-fs-filename -- Synthetic tests use fixed fixture contracts, pinned workbook markup and registered own UUID filesystem roots; destructive leaves require owner/realpath checks. No HTTP-supplied paths or executable text. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,readdir,unlink,rmdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {PrivateStorage} from '../../src/modules/exchange/storage.js';
test('private UUID-only storage rejects corrupt/missing/path resources and cleans only exact own objects',async()=>{
 const id=randomUUID(),root=path.resolve('.runtime/s11-p02-'+id),receipt=path.resolve('../../Construccion/Sprints/S11/Evidencias/S11-P02-RESOURCES.jsonl');
 // Durable exact resource inventory before any directory/file creation.
 const {appendFile}=await import('node:fs/promises');await appendFile(receipt,JSON.stringify({event:'filesystem-reserved',runId:id,root,ownerPid:process.pid,files:['owner.json',id,id+'.part'],at:new Date().toISOString()})+'\n');
 await mkdir(root,{recursive:false});await writeFile(path.join(root,'owner.json'),JSON.stringify({runId:id,pid:process.pid}));const store=new PrivateStorage(root);
 try{
  const bytes=Buffer.from('sintético privado'),meta=await store.publish(id,bytes);assert.deepEqual(await store.read(id,meta),bytes);await assert.rejects(()=>store.publish(id,bytes));await assert.rejects(()=>store.publish('../escape',bytes));await assert.rejects(()=>store.read(randomUUID(),meta));
  await writeFile(path.join(root,id+'.part'),'another publisher owns this',{flag:'wx'});await assert.rejects(()=>store.publish(id,bytes));assert.equal(await readFile(path.join(root,id+'.part'),'utf8'),'another publisher owns this');await unlink(path.join(root,id+'.part'));
  await writeFile(path.join(root,id),Buffer.from('corrupto'));await assert.rejects(()=>store.read(id,meta));await store.remove(id);assert.deepEqual(await readdir(root),['owner.json']);
 }finally{
  await store.remove(id);const owner=JSON.parse(await readFile(path.join(root,'owner.json'),'utf8')) as {runId:string;pid:number};assert.equal(owner.runId,id);assert.equal(owner.pid,process.pid);assert.equal((await lstat(root)).isSymbolicLink(),false);await unlink(path.join(root,'owner.json'));await rmdir(root);await appendFile(receipt,JSON.stringify({event:'filesystem-cleaned',runId:id,root,exactAbsent:!await lstat(root).then(()=>true,()=>false),at:new Date().toISOString()})+'\n');
 }
});
