/* eslint-disable security/detect-non-literal-fs-filename -- One registered owned filesystem group. Exact resolved targets/owner/lease checked before removal; never an application profile or historical candidate. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {verifyCandidate,digest,listFingerprint,buildFingerprint,parseUniqueJSON,FORMAT} from '../../scripts/s10-verifier-core.mjs';

const server=fileURLToPath(new URL('../../',import.meta.url)),runtime=path.join(server,'.runtime'),evidence=path.resolve(server,'../../Construccion/Sprints/S10/Evidencias/S10-P02-RESOURCES.jsonl');
const execute=promisify(execFile),cli=path.join(server,'scripts/s10-verify-candidate.mjs');
const json=value=>JSON.stringify(value,null,2)+'\n';
test('S10 verifier: frozen bytes, invalid inputs, compiled staleness and explicit sidecar',{timeout:60000},async t=>{
 const id=randomUUID(),folder=path.join(runtime,'s10-verifier-'+id),candidate=path.join(folder,'candidate'),review=path.join(folder,'review-output'),owner={id,pid:process.pid,nonce:randomUUID()};let leases=0;
 const receipt=record=>fs.appendFile(evidence,json({...record,atUTC:new Date().toISOString(),task:'S10-P02',groupId:id,folder,ownerPid:process.pid}).replaceAll('\n  ',' ').replace(/\n\}/g,'}').trim()+'\n');
 await receipt({event:'reserved-before-create',databases:[],budgetBytes:16*1024*1024,filesystemGroups:1});
 await fs.mkdir(runtime,{recursive:true});assert.equal(path.resolve(await fs.realpath(runtime)),path.resolve(runtime));
 await fs.mkdir(folder);await fs.writeFile(path.join(folder,'owner.json'),json(owner),{flag:'wx'});await fs.mkdir(review);
 const authorize=async()=>{assert.equal(path.dirname(path.resolve(folder)),path.resolve(runtime));assert.equal(path.basename(folder),'s10-verifier-'+id);assert.equal(path.resolve(await fs.realpath(folder)),path.resolve(folder));assert.equal((await fs.lstat(folder)).isSymbolicLink(),false);assert.deepEqual(JSON.parse(await fs.readFile(path.join(folder,'owner.json'),'utf8')),owner);};
 const inventory=async dir=>{const rows=[];const walk=async p=>{for(const name of(await fs.readdir(p)).sort()){const f=path.join(p,name),s=await fs.lstat(f);if(s.isSymbolicLink()){rows.push([path.relative(dir,f),'LINK:'+await fs.readlink(f)]);}else if(s.isDirectory())await walk(f);else rows.push([path.relative(dir,f),digest(await fs.readFile(f))]);}};await walk(dir);return rows;};
 const remove=async target=>{await authorize();assert.equal(leases,0,'LIVE_LEASE');const absolute=path.resolve(target);assert.ok(absolute===folder||absolute.startsWith(folder+path.sep));assert.equal(path.resolve(await fs.realpath(absolute)),absolute);const rows=await inventory(absolute);assert.ok(!rows.some(([,hash])=>hash.startsWith('LINK:')),'Live reparse point blocks recursive cleanup');await fs.rm(absolute,{recursive:true,force:false});};
 let manifest;
 const seed=async()=>{
  await authorize();try{await remove(candidate);}catch(e){if(e.code!=='ENOENT')throw e;}
  await fs.mkdir(path.join(candidate,'src'),{recursive:true});await fs.mkdir(path.join(candidate,'dist'));
  await fs.writeFile(path.join(candidate,'src/a.ts'),'export const a: number = 1;\n');await fs.writeFile(path.join(candidate,'dist/a.js'),'export const a = 1;\n');
  const source=['src/a.ts',digest(await fs.readFile(path.join(candidate,'src/a.ts')))],output=['dist/a.js',digest(await fs.readFile(path.join(candidate,'dist/a.js')))];
  const metadata={compiler:'synthetic fixture marker; not a compiled product',flags:['--strict'],node:process.version};
  const build={format:FORMAT,metadata,inputs:[{path:source[0],sha256:source[1]}],outputs:[{path:output[0],sha256:output[1]}],inputSets:[{directory:'src',extensions:['.ts'],excludeDirectories:[]}],explicitInputs:[],outputDirectory:'dist',inputFingerprint:buildFingerprint(metadata,[source])};
  await fs.writeFile(path.join(candidate,'build.json'),json(build));
  const snapshot={sourceFingerprint:listFingerprint([source]),sources:[{path:source[0],sha256:source[1],base64:(await fs.readFile(path.join(candidate,source[0]))).toString('base64')}]};await fs.writeFile(path.join(candidate,'snapshot.json'),json(snapshot));await fs.writeFile(path.join(candidate,'VERIFY.json'),'ORIGINAL FROZEN VERIFY\n');
  manifest={candidate:'SYNTHETIC-ONLY',sourceFingerprint:snapshot.sourceFingerprint,files:{}};
  manifest.files=Object.fromEntries(await Promise.all(['src/a.ts','dist/a.js','build.json','snapshot.json','VERIFY.json'].map(async n=>[n,digest(await fs.readFile(path.join(candidate,n)))])));
  await save();
 };
 const save=()=>fs.writeFile(path.join(candidate,'manifest.json'),json(manifest));
 const repin=async n=>{Object.defineProperty(manifest.files,n,{value:digest(await fs.readFile(path.join(candidate,n))),enumerable:true,configurable:true,writable:true});await save();};
 const options=async()=>({root:candidate,manifest:'manifest.json',expectedManifestSHA256:digest(await fs.readFile(path.join(candidate,'manifest.json'))),snapshot:'snapshot.json',buildState:'build.json'});
 const args=async extra=>['--root',candidate,'--manifest','manifest.json','--sha256',(await options()).expectedManifestSHA256,'--snapshot','snapshot.json','--build-state','build.json',...(extra??[])];
 const run=async(extra=[])=>{try{const r=await execute(process.execPath,[cli,...await args(extra)],{timeout:10000,windowsHide:true,maxBuffer:1024*1024});assert.equal(r.stderr,'');return{exit:0,body:JSON.parse(r.stdout)};}catch(e){if(!e.stdout)throw e;return{exit:e.code,body:JSON.parse(e.stdout)};}};
 const rejects=async code=>{const before=await inventory(candidate);await assert.rejects(()=>options().then(verifyCandidate),e=>e.code===code);assert.deepEqual(await inventory(candidate),before);};
 try{
  await receipt({event:'created',databases:[]});
  await t.test('default CLI changes no byte or inventory, including VERIFY',async()=>{await seed();const before=await inventory(folder),r=await run();assert.equal(r.exit,0);assert.equal(r.body.readOnly,true);assert.equal(r.body.files,5);assert.equal(r.body.compiledInputs,1);assert.equal(r.body.compiledOutputs,1);assert.deepEqual(await inventory(folder),before);});
  await t.test('file content tamper rejected without rewriting evidence',async()=>{await seed();await fs.writeFile(path.join(candidate,'src/a.ts'),'tampered');await rejects('FILE_HASH_MISMATCH');});
  await t.test('missing file rejected',async()=>{await seed();await fs.unlink(path.join(candidate,'dist/a.js'));await rejects('MISSING_FILE');});
  await t.test('manifest needs external trusted SHA',async()=>{await seed();const p=await options();await assert.rejects(()=>verifyCandidate({...p,expectedManifestSHA256:'0'.repeat(64)}),e=>e.code==='MANIFEST_HASH_MISMATCH');await assert.rejects(()=>verifyCandidate({...p,expectedManifestSHA256:undefined}),e=>e.code==='TRUSTED_ROOT_AND_MANIFEST_HASH_REQUIRED');});
  await t.test('duplicate raw JSON keys cannot be silently overwritten',async()=>{await seed();const h=manifest.files['src/a.ts'];await fs.writeFile(path.join(candidate,'manifest.json'),' {"files":{"src/a.ts":"'+h+'","src/a.ts":"'+h+'"}}');await rejects('DUPLICATE_JSON_KEY');});
  await t.test('JSON parser rejects malformed tokens, deep nesting and escaped duplicate names',()=>{for(const text of ['01','1.','1e','truex','{"a":1,}','[1,]','{"a":NaN}'])assert.throws(()=>parseUniqueJSON(text),e=>e.code==='INVALID_JSON');assert.throws(()=>parseUniqueJSON(String.raw`{"a":1,"\u0061":2}`),e=>e.code==='DUPLICATE_JSON_KEY');assert.throws(()=>parseUniqueJSON('['.repeat(66)+'0'+']'.repeat(66)),e=>e.code==='JSON_DEPTH_LIMIT');assert.deepEqual(parseUniqueJSON('{"n":-1.5e+2,"v":[true,false,null]}'),{n:-150,v:[true,false,null]});});
  await t.test('duplicate row entries rejected',async()=>{await seed();manifest.files=[{path:'src/a.ts',sha256:manifest.files['src/a.ts']},{path:'src/a.ts',sha256:manifest.files['src/a.ts']}];await save();await rejects('DUPLICATE_FILE');});
  await t.test('path traversal, absolute paths and alternate separators rejected',async()=>{for(const name of ['../outside','C:/outside','/absolute','src\\a.ts','src//a.ts','src/./a.ts','src/a.ts:stream','src/con']){await seed();manifest.files={[name]:'a'.repeat(64)};await save();await rejects('INVALID_RELATIVE_PATH');}});
  await t.test('invalid hash and empty lists rejected',async()=>{await seed();manifest.files={'src/a.ts':'not-a-hash'};await save();await rejects('INVALID_SHA256');manifest.files={};await save();await rejects('INVALID_FILE_LIST');});
  await t.test('source fingerprint checked, not relabeled after mismatch',async()=>{await seed();manifest.sourceFingerprint='b'.repeat(64);await save();await rejects('SOURCE_FINGERPRINT_MISMATCH');});
  await t.test('frozen source order is preserved, not re-sorted by another platform',async()=>{await seed();await fs.writeFile(path.join(candidate,'src/b.ts'),'export const b=2;');await repin('src/b.ts');const sources=[{path:'src/b.ts',sha256:manifest.files['src/b.ts']},{path:'src/a.ts',sha256:manifest.files['src/a.ts']}],fingerprint=listFingerprint(sources.map(r=>[r.path,r.sha256]));manifest.sourceFingerprint=fingerprint;await fs.writeFile(path.join(candidate,'snapshot.json'),json({sources,sourceFingerprint:fingerprint}));await repin('snapshot.json');const result=await verifyCandidate({...await options(),buildState:undefined});assert.equal(result.report.sourceFingerprint,fingerprint);assert.notEqual(fingerprint,listFingerprint([...sources].reverse().map(r=>[r.path,r.sha256])));});
  await t.test('snapshot required and bound to manifest',async()=>{await seed();const p=await options();await assert.rejects(()=>verifyCandidate({...p,snapshot:undefined}),e=>e.code==='SNAPSHOT_REQUIRED');delete manifest.files['snapshot.json'];await save();await rejects('UNPINNED_SNAPSHOT');});
  await t.test('snapshot saved source bytes checked',async()=>{await seed();const p=path.join(candidate,'snapshot.json'),s=JSON.parse(await fs.readFile(p,'utf8'));s.sources[0].base64=Buffer.from('other bytes').toString('base64');await fs.writeFile(p,json(s));await repin('snapshot.json');await rejects('SNAPSHOT_BYTES_MISMATCH');});
  await t.test('stale compiled input detected even if current source/manifest/snapshot agree',async()=>{await seed();await fs.writeFile(path.join(candidate,'src/a.ts'),'export const a: number = 2;\n');const h=digest(await fs.readFile(path.join(candidate,'src/a.ts'))),s={sourceFingerprint:listFingerprint([['src/a.ts',h]]),sources:[{path:'src/a.ts',sha256:h}]};await fs.writeFile(path.join(candidate,'snapshot.json'),json(s));manifest.sourceFingerprint=s.sourceFingerprint;await repin('src/a.ts');await repin('snapshot.json');await rejects('COMPILED_INPUT_CHANGED');});
  await t.test('new transitive source inside declared input set invalidates compiled state',async()=>{await seed();await fs.writeFile(path.join(candidate,'src/b.ts'),'export const b=2;');await rejects('COMPILED_INPUT_SET_CHANGED');});
  await t.test('stale output hash detected with newly frozen manifest',async()=>{await seed();await fs.writeFile(path.join(candidate,'dist/a.js'),'different output');await repin('dist/a.js');await rejects('COMPILED_OUTPUT_MISMATCH');});
  await t.test('compiled metadata/input fingerprint recomputed',async()=>{await seed();const p=path.join(candidate,'build.json'),s=JSON.parse(await fs.readFile(p,'utf8'));s.metadata.flags.push('--changed');await fs.writeFile(p,json(s));await repin('build.json');await rejects('COMPILED_INPUT_KEY_MISMATCH');});
  await t.test('unrecorded compiled output is rejected',async()=>{await seed();await fs.writeFile(path.join(candidate,'dist/unknown.js'),'unknown output');await rejects('COMPILED_OUTPUT_SET_CHANGED');});
  await t.test('independent reviewer namespace does not alter product identity',async()=>{await seed();await fs.mkdir(path.join(candidate,'independent-review'));await fs.writeFile(path.join(candidate,'independent-review/own-test.mjs'),'// own review');const r=await verifyCandidate(await options());assert.equal(r.report.sourceFingerprint,manifest.sourceFingerprint);});
  await t.test('sidecar requires explicit authorized root',async()=>{await seed();const before=await inventory(folder),r=await run(['--sidecar',path.join(review,'result.json')]);assert.equal(r.exit,1);assert.equal(r.body.error,'EXPLICIT_SIDECAR_ROOT_REQUIRED');assert.deepEqual(await inventory(folder),before);});
  await t.test('explicit sidecar writes only new result outside frozen candidate',async()=>{await seed();const before=await inventory(candidate),r=await run(['--sidecar',path.join(review,'result.json'),'--sidecar-root',review]);assert.equal(r.exit,0);assert.equal(r.body.readOnly,false);assert.deepEqual(await inventory(candidate),before);assert.equal(JSON.parse(await fs.readFile(path.join(review,'result.json'),'utf8')).sidecarExplicitlyRequested,true);});
  await t.test('sidecar never overwrites existing files',async()=>{await seed();const before=await inventory(folder),r=await run(['--sidecar',path.join(review,'result.json'),'--sidecar-root',review]);assert.equal(r.exit,1);assert.equal(r.body.error,'EEXIST');assert.deepEqual(await inventory(folder),before);});
  await t.test('sidecar root cannot include sealed inputs',async()=>{await seed();const before=await inventory(folder),r=await run(['--sidecar',path.join(candidate,'bad-sidecar.json'),'--sidecar-root',candidate]);assert.equal(r.exit,1);assert.equal(r.body.error,'SIDECAR_COLLIDES_WITH_SEALED_SET');assert.deepEqual(await inventory(folder),before);});
  await t.test('physical junction rejected for input and sidecar parent',async()=>{
   await seed();const link=path.join(candidate,'src/link'),sideLink=path.join(review,'link');
   const removeLink=async p=>{try{assert.equal((await fs.lstat(p)).isSymbolicLink(),true);assert.ok(path.resolve(await fs.realpath(p)).startsWith(folder+path.sep));try{await fs.unlink(p);}catch(e){if(e.code!=='EPERM')throw e;assert.equal((await fs.lstat(p)).isSymbolicLink(),true);await fs.rmdir(p);}}catch(e){if(e.code!=='ENOENT')throw e;}};
   try{
    await fs.symlink(path.join(candidate,'dist'),link,'junction');manifest.files['src/link/a.js']=manifest.files['dist/a.js'];await save();await rejects('UNSAFE_LINK');
    await removeLink(link);delete manifest.files['src/link/a.js'];await save();
    await fs.symlink(candidate,sideLink,'junction');const r=await run(['--sidecar',path.join(sideLink,'sidecar.json'),'--sidecar-root',review]);assert.equal(r.exit,1);assert.equal(r.body.error,'UNSAFE_LINK');
   }finally{
    for(const p of [link,sideLink])await removeLink(p);
   }
  });
  await t.test('live own lease blocks recursive reuse/cleanup',async()=>{await seed();leases++;try{await assert.rejects(()=>remove(candidate),/LIVE_LEASE/);assert.ok(await fs.stat(path.join(folder,'owner.json')));}finally{leases--;}});
  await t.test('partial filesystem setup cleans only its own exact folder',async()=>{await seed();const partial=path.join(folder,'partial-setup');await fs.mkdir(partial);await fs.writeFile(path.join(partial,'started'),'synthetic');try{throw Error('SYNTHETIC_SETUP_FAILURE');}catch(e){assert.equal(e.message,'SYNTHETIC_SETUP_FAILURE');await remove(partial);}await assert.rejects(()=>fs.stat(partial),{code:'ENOENT'});assert.ok(await fs.stat(path.join(folder,'owner.json')));});
  await receipt({event:'cases-complete',defaultInputBytesInvariant:true,databases:[]});
 }finally{
  await authorize();const rows=await inventory(folder),bytes=await Promise.all(rows.filter(([,h])=>!h.startsWith('LINK:')).map(async([n])=>(await fs.stat(path.join(folder,n))).size));await receipt({event:'cleanup-before',files:rows.length,controlBytes:bytes.reduce((a,b)=>a+b,0),databases:[]});await remove(folder);await receipt({event:'cleanup-complete',remaining:0,controlRemoved:true,databases:[]});
 }
});
