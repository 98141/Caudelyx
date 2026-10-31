/* eslint-disable security/detect-non-literal-fs-filename -- Synthetic tests use fixed fixture contracts, pinned workbook markup and registered own UUID filesystem roots; destructive leaves require owner/realpath checks. No HTTP-supplied paths or executable text. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {FORMAT,buildFingerprint} from '../../scripts/s11-verifier-core.mjs';
const root=path.resolve('../..'),e=path.join(root,'Construccion/Sprints/S11/Evidencias'),sha=b=>createHash('sha256').update(b).digest('hex');
async function stamp(file){const s=await fs.lstat(file,{bigint:true});return{bytes:String(s.size),mtimeNs:String(s.mtimeNs),sha256:s.isFile()?sha(await fs.readFile(file)):null};}
async function inventory(directory){const out={};for(const x of await fs.readdir(directory,{withFileTypes:true})){assert.equal(x.isSymbolicLink(),false);const p=path.join(directory,x.name);out[x.name]=x.isDirectory()?await inventory(p):await stamp(p);}return out;}
test('S11 verifier is read-only on success, rejection, tamper, absence, stale outputs and malformed lists; sidecars are exclusive and separate',async()=>{
 const id=randomUUID(),own=path.join(e,'S11-P02-SIDECARS',id),candidate=path.join(own,'candidate'),receipts=path.join(own,'receipts'),resourceLog=path.join(e,'S11-P02-RESOURCES.jsonl'),cases=[];
 await fs.appendFile(resourceLog,JSON.stringify({event:'verifier-filesystem-reserved',runId:id,ownerPid:process.pid,root:own,directories:[own,candidate,receipts,path.join(candidate,'src'),path.join(candidate,'dist')],files:['owner.json','candidate/src/unit.ts','candidate/src/extra.ts','candidate/dist/unit.js','candidate/dist/extra.js','candidate/build.json','candidate/seal.json','receipts/verify.json'],at:new Date().toISOString()})+'\n');
 await fs.mkdir(own,{recursive:true});await fs.mkdir(candidate);await fs.mkdir(receipts);await fs.mkdir(path.join(candidate,'src'));await fs.mkdir(path.join(candidate,'dist'));await fs.writeFile(path.join(own,'owner.json'),JSON.stringify({runId:id,pid:process.pid}));
 const protectedInventory=JSON.parse(await fs.readFile(path.join(e,'S11-P02-INVENTORY.json'),'utf8')),names=Object.keys(protectedInventory).filter(p=>p.includes('/dist-s10-p04/')||p.startsWith('Construccion/Sprints/S10/')||p.includes('/tests/s10-')||p.endsWith('/scripts/s10-verifier-core.mjs')),beforeHistorical=new Map(await Promise.all(names.map(async p=>[p,await stamp(path.join(root,p))])));
 async function setup(change){
  for(const extra of ['src/extra.ts','dist/extra.js'])try{await fs.unlink(path.join(candidate,extra));}catch(e){if(e.code!=='ENOENT')throw e;}
  await fs.writeFile(path.join(candidate,'src/unit.ts'),'export const n=1;\n');await fs.writeFile(path.join(candidate,'dist/unit.js'),'export const n = 1;\n');
  const inputs=[['src/unit.ts',sha(await fs.readFile(path.join(candidate,'src/unit.ts')))]],outputs=[['dist/unit.js',sha(await fs.readFile(path.join(candidate,'dist/unit.js')))]],metadata={compiler:'synthetic-independent-fixture',version:1},build={format:FORMAT,metadata,inputs:Object.fromEntries(inputs),outputs:Object.fromEntries(outputs),inputFingerprint:buildFingerprint(metadata,inputs),inputSets:[{directory:'src',extensions:['.ts'],excludeDirectories:[]}],explicitInputs:[],outputDirectory:'dist'};
  await fs.writeFile(path.join(candidate,'build.json'),JSON.stringify(build));let manifest={files:Object.fromEntries([...inputs,...outputs,['build.json',sha(await fs.readFile(path.join(candidate,'build.json')))]])};
  if(change==='bad-list')manifest.files={'../escape':'0'.repeat(64)};
  if(change==='duplicate-list')manifest={files:[{path:'src/unit.ts',sha256:inputs[0][1]},{path:'src/unit.ts',sha256:inputs[0][1]}]};
  await fs.writeFile(path.join(candidate,'seal.json'),JSON.stringify(manifest));
  if(change==='tamper')await fs.writeFile(path.join(candidate,'dist/unit.js'),'tampered');
  if(change==='missing')await fs.unlink(path.join(candidate,'dist/unit.js'));
  if(change==='stale')await fs.writeFile(path.join(candidate,'src/unit.ts'),'export const n=2;\n');
  if(change==='compiled-stale'){await fs.writeFile(path.join(candidate,'src/unit.ts'),'export const n=2;\n');manifest.files['src/unit.ts']=sha(await fs.readFile(path.join(candidate,'src/unit.ts')));await fs.writeFile(path.join(candidate,'seal.json'),JSON.stringify(manifest));}
  if(change==='extra-input')await fs.writeFile(path.join(candidate,'src/extra.ts'),'export const extra=1;\n');
  if(change==='extra-output')await fs.writeFile(path.join(candidate,'dist/extra.js'),'export const extra=1;\n');

  return sha(await fs.readFile(path.join(candidate,'seal.json')));
 }
 const run=(digest,args=[])=>{const p=spawnSync(process.execPath,['scripts/s11-verify.mjs','--root',candidate,'--manifest','seal.json','--sha256',digest,'--build-state','build.json',...args],{cwd:path.resolve('.'),encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(p.error,undefined);assert.equal(p.stderr,'');return{code:p.status,result:JSON.parse(p.stdout)};};
 try{
  for(const variant of ['success','tamper','missing','stale','compiled-stale','extra-input','extra-output','bad-list','duplicate-list','rejected-fixture','wrong-sha']){
   const digest=await setup(variant),before=await inventory(candidate),args=variant==='rejected-fixture'?['--fixture','yes']:[],r=run(variant==='wrong-sha'?'0'.repeat(64):digest,args);assert.equal(r.code,variant==='success'?0:1,variant+':'+JSON.stringify(r.result));if(variant==='compiled-stale')assert.equal(r.result.error,'COMPILED_INPUT_CHANGED');if(variant==='extra-input')assert.equal(r.result.error,'COMPILED_INPUT_SET_CHANGED');if(variant==='extra-output')assert.equal(r.result.error,'COMPILED_OUTPUT_SET_CHANGED');assert.equal(r.result.readOnly,true);assert.deepEqual(await inventory(candidate),before,variant);cases.push({case:variant,...r});
  }
  const digest=await setup('success'),before=await inventory(candidate),sidecar=path.join(receipts,'verify.json'),r=run(digest,['--sidecar-root',receipts,'--sidecar',sidecar]);assert.equal(r.code,0);assert.equal(r.result.readOnly,false);const sidecarBefore=await stamp(sidecar);assert.equal(run(digest,['--sidecar-root',receipts,'--sidecar',sidecar]).code,1);assert.deepEqual(await stamp(sidecar),sidecarBefore);assert.deepEqual(await inventory(candidate),before);
  assert.equal(run(digest,['--sidecar-root',candidate,'--sidecar',path.join(candidate,'attempt.json')]).code,1);assert.deepEqual(await inventory(candidate),before);
  for(const[n,s]of beforeHistorical)assert.deepEqual(await stamp(path.join(root,n)),s,n);
  await fs.appendFile(resourceLog,JSON.stringify({event:'verifier-cases',runId:id,historicalFilesUnchanged:beforeHistorical.size,cases,sidecarExclusive:true,sealedSetUnchanged:true,at:new Date().toISOString()})+'\n');
 }finally{
  const owner=JSON.parse(await fs.readFile(path.join(own,'owner.json'),'utf8'));assert.equal(owner.runId,id);assert.equal(owner.pid,process.pid);assert.equal(await fs.realpath(own),own);assert.equal((await fs.lstat(own)).isSymbolicLink(),false);
  // Exact inventoried leaves only; no recursive cleanup or prefix deletion.
  for(const p of ['candidate/src/unit.ts','candidate/src/extra.ts','candidate/dist/unit.js','candidate/dist/extra.js','candidate/build.json','candidate/seal.json','receipts/verify.json','owner.json'])try{await fs.unlink(path.join(own,p));}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const p of ['candidate/src','candidate/dist','candidate','receipts',''])await fs.rmdir(path.join(own,p));await fs.appendFile(resourceLog,JSON.stringify({event:'verifier-filesystem-cleaned',runId:id,root:own,exactAbsent:!await fs.lstat(own).then(()=>true,()=>false),at:new Date().toISOString()})+'\n');
 }
});

