/* eslint-disable security/detect-non-literal-fs-filename -- Fixed approved workspace/output roots and exact registered controls; destructive paths pass containment, ancestor-link, ownership and lease checks. */
import {createHash,randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';

export const VERSION='S09-RUNNER-1';
const normalized=p=>path.resolve(p).toLowerCase();
export function inside(root,target){
  const r=normalized(root),t=normalized(target);
  if(t===r||!t.startsWith(r+path.sep))throw Error('UNSAFE_PATH');
  return path.resolve(target);
}
export async function noLinks(root,target,lstat=fs.lstat){
  inside(root,target);
  const absolute=path.resolve(target),resolvedRoot=path.resolve(root);
  // Inspect root and every ancestor too; a junction above the leaf must not escape.
  let part=path.parse(resolvedRoot).root;
  for(const name of absolute.slice(part.length).split(path.sep).filter(Boolean)){
    part=path.join(part,name);
    try{if((await lstat(part)).isSymbolicLink())throw Error('UNSAFE_LINK');}
    catch(error){if(error.code==='ENOENT')break;throw error;}
  }
  return absolute;
}
export const hash=b=>createHash('sha256').update(b).digest('hex');
export async function fileHash(filename){return hash(await fs.readFile(filename));}
export async function listFiles(root,{extensions,exclude=[]}={}){
  const result=[];
  async function visit(folder){
    for(const item of await fs.readdir(folder,{withFileTypes:true})){
      if(item.isSymbolicLink())throw Error('UNSAFE_LINK');
      const filename=path.join(folder,item.name);
      if(item.isDirectory()){if(!exclude.includes(item.name))await visit(filename);}
      else if(item.isFile()&&(!extensions||extensions.some(e=>item.name.endsWith(e))))result.push(filename);
    }
  }
  await visit(root);return result.sort();
}
export async function fingerprint(files,metadata={}){
  const rows=[];
  for(const filename of [...new Set(files.map(p=>path.resolve(p)))].sort())rows.push([filename,await fileHash(filename)]);
  return{key:hash(JSON.stringify({version:VERSION,metadata,rows})),files:rows,metadata};
}
export async function createRun(root,runId=randomUUID()){
  if(!/^[a-f0-9-]{36}$/.test(runId))throw Error('INVALID_RUN_ID');
  const folder=await noLinks(root,path.join(root,runId));
  await fs.mkdir(root,{recursive:true});await fs.mkdir(folder);
  const owner={version:VERSION,runId,pid:process.pid,folder,createdAt:new Date().toISOString(),active:true};
  await fs.writeFile(path.join(folder,'owner.json'),JSON.stringify(owner),{flag:'wx'});
  return owner;
}
export async function readOwner(root,owner){
  const folder=await noLinks(root,owner.folder);
  if(path.basename(folder)!==owner.runId)throw Error('OWNERSHIP_MISMATCH');
  const actual=JSON.parse(await fs.readFile(path.join(folder,'owner.json'),'utf8'));
  if(actual.version!==VERSION||actual.runId!==owner.runId||actual.pid!==owner.pid||normalized(actual.folder)!==normalized(folder))throw Error('OWNERSHIP_MISMATCH');
  return actual;
}
export async function releaseRun(root,owner){
  const actual=await readOwner(root,owner);
  if(actual.pid!==process.pid)throw Error('FOREIGN_LEASE');
  actual.active=false;await fs.writeFile(path.join(actual.folder,'owner.json'),JSON.stringify(actual));
}
export async function cleanupRun(root,owner){
  const actual=await readOwner(root,owner);
  if(actual.active)throw Error('ACTIVE_LEASE');
  if(actual.pid!==process.pid)throw Error('FOREIGN_LEASE');
  // Do not follow a descendant junction during recursive removal.
  await listFiles(actual.folder);
  const target=await noLinks(root,actual.folder);
  await fs.rm(target,{recursive:true});
  return{runId:actual.runId,folder:target,removed:true};
}
export async function withRun(root,work,onResource=()=>{},runId=randomUUID()){
  const setupStart=performance.now();
  const owner=await createRun(root,runId);
  try{await onResource({phase:'created',...owner,durationMs:performance.now()-setupStart});return await work(owner);}
  finally{
    const cleanupStart=performance.now();
    await releaseRun(root,owner);
    const result=await cleanupRun(root,owner);await onResource({phase:'cleanup',...result,durationMs:performance.now()-cleanupStart});
  }
}
export async function command(argv,{cwd,timeoutMs=120000,maxOutputBytes=2*1024*1024,env}={}){
  const started=performance.now();let stdout='',stderr='',bytes=0,timedOut=false,outputOverflow=false;
  const child=spawn(argv[0],argv.slice(1),{cwd,...(env?{env}:{}),shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let timer;
  const receive=(which,chunk)=>{
    bytes+=chunk.length;
    if(bytes>maxOutputBytes){outputOverflow=true;child.kill('SIGTERM');return;}
    if(which==='stdout')stdout+=chunk.toString();else stderr+=chunk.toString();
  };
  child.stdout.on('data',b=>receive('stdout',b));child.stderr.on('data',b=>receive('stderr',b));
  const result=await new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('close',(exitCode,signal)=>resolve({exitCode,signal}));
    timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},timeoutMs);
  }).finally(()=>clearTimeout(timer));
  return{argv,cwd,...result,stdout,stderr,timedOut,outputOverflow,durationMs:performance.now()-started};
}

export async function ensureBuild({root,output,inputs,metadata={},compile,always=false}){
  const started=performance.now();await noLinks(root,output);
  const state=await fingerprint(inputs,metadata),marker=path.join(output,'.s09-build.json'),lease=path.join(output,'.s09-build-lease.json');
  await fs.mkdir(output,{recursive:true});
  let lock;
  try{lock=await fs.open(lease,'wx');}
  catch(error){if(error.code==='EEXIST')throw Error('BUILD_LEASE_ACTIVE_OR_UNRECOVERED');throw error;}
  await lock.writeFile(JSON.stringify({version:VERSION,pid:process.pid,startedAt:new Date().toISOString()}));await lock.close();
  try{
    let old;
    try{old=JSON.parse(await fs.readFile(marker,'utf8'));}
    catch(error){if(error.code!=='ENOENT')throw error;}
    const actual=await listFiles(output),relative=p=>path.relative(output,p).replaceAll(path.sep,'/');
    const artifactFiles=actual.filter(p=>p!==marker&&p!==lease);
    if(!old&&artifactFiles.length)throw Error('UNOWNED_OUTPUT');
    if(old?.version&&old.version!==VERSION)throw Error('UNOWNED_OUTPUT');
    let valid=Boolean(old?.version===VERSION&&old.key===state.key);
    const expected=new Map(old?.outputs??[]);
    if(artifactFiles.length!==expected.size)valid=false;
    for(const file of artifactFiles)if(await fileHash(file)!==expected.get(relative(file)))valid=false;
    if(valid&&!always)return{cached:true,key:state.key,durationMs:performance.now()-started,compilerMs:0,inputCount:state.files.length,artifactCount:expected.size};
    // Only an exact, recorded output list may be removed; no broad historical dist sweep.
    if(old){
      const known=new Set(old.outputs.map(([p])=>p));
      for(const file of artifactFiles){if(!known.has(relative(file)))throw Error('UNOWNED_OUTPUT');await noLinks(output,file);}
      for(const file of artifactFiles)await fs.unlink(file);
      await fs.unlink(marker);
    }
    const compileStart=performance.now();await compile();const compilerMs=performance.now()-compileStart;
    // Reject inputs modified while compiling, including compiler/config/lock/contracts.
    const after=await fingerprint(inputs,metadata);if(after.key!==state.key)throw Error('INPUT_CHANGED_DURING_BUILD');
    const outputs=[];
    for(const file of await listFiles(output))if(file!==marker&&file!==lease)outputs.push([relative(file),await fileHash(file)]);
    await fs.writeFile(marker,JSON.stringify({version:VERSION,key:state.key,inputs:state.files,metadata,outputs},null,2)+'\n');
    return{cached:false,key:state.key,durationMs:performance.now()-started,compilerMs,inputCount:state.files.length,artifactCount:outputs.length};
  }finally{await fs.unlink(lease);}
}
