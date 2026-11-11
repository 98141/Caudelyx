// Cold, encrypted, create-only backup/restore. No deletion, key generation,
// migration, gate repair, or operation on an unidentified Docker resource.
import fs from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomBytes,randomUUID,createCipheriv,createDecipheriv,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
const execute=promisify(execFile),self=fileURLToPath(import.meta.url);
const hash=b=>createHash('sha256').update(b).digest('hex');
// Only closed codes are emitted. Never log Error.message/stack, Docker stderr,
// archive headers, filesystem paths, keys, IV/tag or decrypted contents.
const safeCodes=new Set(('BACKUP_PATH_INVALID BACKUP_ENTRY_INVALID BACKUP_ENTRY_ESCAPE BACKUP_LINKED_ROOT BACKUP_NONREGULAR_ENTRY BACKUP_SOURCE_CHANGED RESTORE_TARGET_NOT_EMPTY BACKUP_TRUNCATED BACKUP_HEADER_LIMIT BACKUP_METADATA_INVALID BACKUP_TOTAL_LIMIT RESTORE_PARENT_INVALID BACKUP_DIRECTORY_INVALID BACKUP_TRAILING_DATA BACKUP_OWNER_INVALID BACKUP_TIME_INVALID BACKUP_KEY_INVALID BACKUP_CIPHERTEXT_INVALID BACKUP_FORMAT_INVALID BACKUP_MANIFEST_INVALID BACKUP_GROUP_INVALID BACKUP_ARCHIVE_INVALID RESTORE_ORIGINAL_PATH_FORBIDDEN RESTORE_VOLUME_ALREADY_EXISTS DEMO_DOCKER_OPERATION_FAILED REMOTE_DOCKER_CONTEXT_FORBIDDEN PINNED_NODE_HELPER_IMAGE_REQUIRED DEMO_PRIVATE_IDENTITY_INVALID RESTORE_GCM_AUTH_FAILED RESTORE_HELPER_EXIT_FAILED RESTORE_HELPER_SIGNAL RESTORE_ACL_FAILED DOCKER_UNAVAILABLE DOCKER_PERMISSION_DENIED RESTORE_HELPER_IMAGE_UNAVAILABLE RESTORE_HELPER_MOUNT_INVALID ENOENT EACCES EPERM ENOSPC EDQUOT EEXIST EROFS EIO EISDIR ENOTDIR EMFILE EPIPE ECONNRESET ERR_STREAM_PREMATURE_CLOSE ERR_STREAM_DESTROYED ERR_CRYPTO_INVALID_IV ERR_CRYPTO_INVALID_AUTH_TAG').split(' '));
export function operationCode(error){
 if(safeCodes.has(error?.code))return error.code;
 if(safeCodes.has(error?.message))return error.message;
 const stderr=typeof error?.stderr==='string'?error.stderr.slice(-16384):'';
 if(/permission denied while trying to connect|access is denied/i.test(stderr))return 'DOCKER_PERMISSION_DENIED';
 if(/cannot connect to the docker daemon|failed to connect to the docker API|is the docker daemon running/i.test(stderr))return 'DOCKER_UNAVAILABLE';
 if(/invalid mount config|bind source path does not exist|invalid volume specification/i.test(stderr))return 'RESTORE_HELPER_MOUNT_INVALID';
 if(/pull access denied|manifest unknown|no such image/i.test(stderr))return 'RESTORE_HELPER_IMAGE_UNAVAILABLE';
 return 'UNCLASSIFIED';
}
function failure(code,cause){return Object.assign(new Error(code,{cause}),{code});}
const authenticationFailure=error=>error?.message==='Unsupported state or unable to authenticate data';
function report(stage,status,error,role){const exitCode=error?.exitCode??error?.cause?.exitCode??error?.cause?.code;console.error(JSON.stringify({event:'CAUDELYX_RESTORE',stage,status,...(role?{role}:{}),...(error?{code:operationCode(error),...(operationCode(error.cause)!=='UNCLASSIFIED'?{causeCode:operationCode(error.cause)}:{}),...(Number.isInteger(exitCode)&&exitCode>=0&&exitCode<=255?{exitCode}:{})}:{})}));}
async function step(stage,work,role){report(stage,'START',null,role);try{const result=await work();report(stage,'OK',null,role);return result;}catch(error){report(stage,'FAIL',error,role);throw error;}}
function archiveDecipher(record,key){
 if(key.length!==32)throw Error('BACKUP_KEY_INVALID');
 if(!/^[a-f0-9]{24}$/.test(record.iv)||!/^[a-f0-9]{32}$/.test(record.tag))throw Error('BACKUP_CIPHERTEXT_INVALID');
 const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(record.iv,'hex'));decipher.setAuthTag(Buffer.from(record.tag,'hex'));return decipher;
}
const mac=(key,p)=>createHmac('sha256',key).update('CAUDELYX:DEMO:BACKUP:v1:'+JSON.stringify(p)).digest('hex');
async function fileHash(file){const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');}
async function ordinary(file){const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||await fs.realpath(file)!==path.resolve(file))throw Error('BACKUP_PATH_INVALID');return fs.readFile(file);}
function inside(root,name){if(typeof name!=='string'||!name||/[\\:\0\r\n]/.test(name)||name.startsWith('/')||name.split('/').some(n=>!n||n==='.'||n==='..'))throw Error('BACKUP_ENTRY_INVALID');const p=path.resolve(root,name);if(!p.startsWith(path.resolve(root)+path.sep))throw Error('BACKUP_ENTRY_ESCAPE');return p;}
export async function* archiveDirectory(root){
 root=path.resolve(root);if(await fs.realpath(root)!==root)throw Error('BACKUP_LINKED_ROOT');
 async function* walk(folder){for(const entry of (await fs.readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  const full=path.join(folder,entry.name),before=await fs.lstat(full),relative=path.relative(root,full).split(path.sep).join('/');inside(root,relative);
  if(before.isSymbolicLink()||!before.isDirectory()&&!before.isFile()||await fs.realpath(full)!==full)throw Error('BACKUP_NONREGULAR_ENTRY');
  const header=Buffer.from(JSON.stringify({path:relative,directory:before.isDirectory(),size:before.isDirectory()?0:before.size,mode:before.mode&0o777,uid:before.uid,gid:before.gid,mtime:before.mtimeMs})),length=Buffer.alloc(4);length.writeUInt32BE(header.length);yield length;yield header;
  if(before.isDirectory())yield* walk(full);else{let count=0;for await(const b of createReadStream(full)){count+=b.length;yield b;}const after=await fs.lstat(full);if(count!==before.size||after.ino!==before.ino||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw Error('BACKUP_SOURCE_CHANGED');}
 }}
 yield* walk(root);yield Buffer.alloc(4);
}
export async function extractDirectory(root,input){
 root=path.resolve(root);if(await fs.realpath(root)!==root||(await fs.readdir(root)).length)throw Error('RESTORE_TARGET_NOT_EMPTY');
 // chmod(0700) alone does not restrict Windows inherited ACLs. Secure the
 // fresh destination BEFORE any plaintext is extracted; children inherit it.
 if(process.platform==='win32')await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$p=$env:F06_RESTORE_DIRECTORY; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $a=New-Object System.Security.AccessControl.DirectorySecurity; $a.SetOwner($sid); $a.SetAccessRuleProtection($true,$false); $a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))); (New-Object System.IO.DirectoryInfo($p)).SetAccessControl($a); $got=(New-Object System.IO.DirectoryInfo($p)).GetAccessControl(); if(-not $got.AreAccessRulesProtected){throw 'ACL_FAILED'}; foreach($entry in $got.Access){if($entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'ACL_PRINCIPAL_FAILED'}}"],{env:{...process.env,F06_RESTORE_DIRECTORY:root},windowsHide:true});
 const iterator=input[Symbol.asyncIterator]();let buffer=Buffer.alloc(0),ended=false;
 async function take(n){while(buffer.length<n){const next=await iterator.next();if(next.done)throw Error('BACKUP_TRUNCATED');buffer=Buffer.concat([buffer,Buffer.from(next.value)]);}const value=buffer.subarray(0,n);buffer=buffer.subarray(n);return value;}
 const directories=[],seen=new Set();let total=0;
 for(;;){const n=(await take(4)).readUInt32BE();if(!n)break;if(n>65536)throw Error('BACKUP_HEADER_LIMIT');let h;try{h=JSON.parse((await take(n)).toString('utf8'));}catch(error){if(error instanceof SyntaxError)throw failure('BACKUP_FORMAT_INVALID',error);throw error;}const target=inside(root,h?.path);
  if(seen.has(h.path)||typeof h.directory!=='boolean'||!Number.isSafeInteger(h.size)||h.size<0||h.size>128*1024**3||!Number.isInteger(h.mode)||h.mode<0||h.mode>0o777)throw Error('BACKUP_METADATA_INVALID');seen.add(h.path);total+=h.size;if(total>128*1024**3)throw Error('BACKUP_TOTAL_LIMIT');
  const parent=path.dirname(target);if(await fs.realpath(parent)!==parent)throw Error('RESTORE_PARENT_INVALID');
  if(h.directory){if(h.size)throw Error('BACKUP_DIRECTORY_INVALID');await fs.mkdir(target,{mode:0o700});directories.push([target,h]);}
  else{const handle=await fs.open(target,'wx',0o600);try{let left=h.size;while(left){const b=await take(Math.min(left,65536));await handle.writeFile(b);left-=b.length;}await handle.sync();}finally{await handle.close();}await metadata(target,h);}
 }
 const tail=await iterator.next();ended=tail.done===true;if(buffer.length||!ended)throw Error('BACKUP_TRAILING_DATA');
 for(const [target,h] of directories.reverse())await metadata(target,h);
 return{entries:seen.size,bytes:total};
}
async function metadata(file,h){if(process.platform!=='win32'){if(!Number.isInteger(h.uid)||!Number.isInteger(h.gid)||h.uid<0||h.gid<0)throw Error('BACKUP_OWNER_INVALID');await fs.chown(file,h.uid,h.gid);await fs.chmod(file,h.mode);}if(!Number.isFinite(h.mtime))throw Error('BACKUP_TIME_INVALID');await fs.utimes(file,new Date(h.mtime),new Date(h.mtime));}
export async function encryptArchive(stream,destination,key){
 if(key.length!==32)throw Error('BACKUP_KEY_INVALID');const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
 await pipeline(stream,cipher,createWriteStream(destination,{flags:'wx',mode:0o600}));
 return{file:path.basename(destination),iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),sha256:await fileHash(destination),bytes:(await fs.stat(destination)).size};
}
export async function decryptArchive(file,record,key,destination){
 if(key.length!==32||await fileHash(file)!==record.sha256)throw Error('BACKUP_CIPHERTEXT_INVALID');
 const decipher=archiveDecipher(record,key);let cryptoError;decipher.on('error',error=>{cryptoError=error;});
 const input=createReadStream(file),transfer=pipeline(input,decipher),extraction=extractDirectory(destination,decipher);
 // Attach both rejection handlers immediately: a small invalid archive can
 // finish while the ACL preflight is awaiting PowerShell. No unhandled error
 // may bypass the caller's quarantine/cleanup path.
 try{const [,result]=await Promise.all([transfer,extraction]);return result;}
 catch(error){input.destroy();decipher.destroy();await Promise.allSettled([transfer,extraction]);throw cryptoError===error&&authenticationFailure(error)?failure('RESTORE_GCM_AUTH_FAILED',error):error;}
}
export function restoreDockerArgs(name,image){
 helper(image);if(!/^caudelyx-demo-restore-[a-f0-9-]{36}-(?:mongo|runtime)$/.test(name))throw Error('RESTORE_ORIGINAL_PATH_FORBIDDEN');
 return ['run','--rm','--interactive','--network','none','--read-only','--user','0:0','--mount',`type=volume,source=${name},target=/target`,'--mount',`type=bind,source=${self},target=/op/operations.mjs,readonly`,'--entrypoint','node',image,'/op/operations.mjs','__extract','/target'];
}
// Register error/close/stderr handlers synchronously, before starting the pipe.
// close waits for stdio, unlike exit. Every promise has a rejection handler.
export async function restoreArchiveToProcess(file,record,key,child){
 let processError,closed=false,tail='',helperCode,cryptoError,timer,killTimer;
 const completed=new Promise(resolve=>{
  child.on('error',error=>{processError=error;});
  child.once('close',(code,signal)=>{closed=true;clearTimeout(timer);clearTimeout(killTimer);resolve({code,signal});});
 });
 child.stderr?.on('data',chunk=>{tail=(tail+chunk.toString('utf8')).slice(-16384);});
 child.stderr?.on('error',()=>{});
 let input,decipher,streamError;
 try{
  decipher=archiveDecipher(record,key);decipher.on('error',error=>{cryptoError=error;});input=createReadStream(file);
  const transfer=pipeline(input,decipher,child.stdin).catch(error=>{
   streamError=error;
   // Closing stdin gives the extractor EOF. Escalate only this owned child if
   // it ignores cancellation; do not touch any application container/volume.
   if(!closed){timer=setTimeout(()=>child.kill('SIGTERM'),5000);killTimer=setTimeout(()=>child.kill('SIGKILL'),10000);}
  });
  const exit=completed.then(result=>{if(processError||result.code!==0){input.destroy();decipher.destroy();child.stdin?.destroy();}return result;});
  const [,result]=await Promise.all([transfer,exit]);
  for(const line of tail.split(/\r?\n/))try{const row=JSON.parse(line);if(row.event==='CAUDELYX_RESTORE'&&row.stage==='EXTRACT'&&row.status==='FAIL'&&safeCodes.has(row.code))helperCode=row.code;}catch{}
  if(processError)throw failure(operationCode(processError)==='UNCLASSIFIED'?'RESTORE_HELPER_EXIT_FAILED':operationCode(processError),processError);
  if(streamError&&cryptoError===streamError&&authenticationFailure(streamError))throw failure('RESTORE_GCM_AUTH_FAILED',streamError);
  if(streamError&&!['EPIPE','ECONNRESET','ERR_STREAM_PREMATURE_CLOSE','ERR_STREAM_DESTROYED'].includes(operationCode(streamError)))throw streamError;
  if(helperCode)throw failure(helperCode,Object.assign(new Error('RESTORE_HELPER_EXIT_FAILED'),{exitCode:result.code}));
  if(result.signal)throw failure('RESTORE_HELPER_SIGNAL');
  if(result.code!==0){const code=operationCode({stderr:tail});throw failure(code==='UNCLASSIFIED'?'RESTORE_HELPER_EXIT_FAILED':code,Object.assign(new Error('RESTORE_HELPER_EXIT_FAILED'),{exitCode:result.code}));}
  if(streamError)throw streamError;
 }catch(error){
  input?.destroy();decipher?.destroy();child.stdin?.destroy();
  if(!closed){child.kill('SIGTERM');killTimer??=setTimeout(()=>child.kill('SIGKILL'),10000);}
  await completed;throw error;
 }
}
async function docker(args){try{return(await execute('docker',args,{windowsHide:true,maxBuffer:16*1024*1024})).stdout.trim();}catch(error){throw failure('DEMO_DOCKER_OPERATION_FAILED',error);}}
async function localDocker(){if(process.env.DOCKER_HOST&&!/^(unix:|npipe:)/.test(process.env.DOCKER_HOST))throw Error('REMOTE_DOCKER_CONTEXT_FORBIDDEN');const context=JSON.parse(await docker(['context','inspect']));if(!context[0]?.Endpoints?.docker?.Host?.match(/^(unix:|npipe:)/))throw Error('REMOTE_DOCKER_CONTEXT_FORBIDDEN');}
function helper(image){if(typeof image!=='string'||!/@sha256:[a-f0-9]{64}$/.test(image))throw Error('PINNED_NODE_HELPER_IMAGE_REQUIRED');}
async function model(composeFile,envFile){
 await localDocker();
 const prefix=['compose','--env-file',path.resolve(envFile),'-f',path.resolve(composeFile)],m=JSON.parse(await docker([...prefix,'config','--format','json']));
 if(!/^caudelyx-demo(?:-restore-[a-f0-9-]{36})?$/.test(m.name)||Object.keys(m.services).sort().join(',')!=='api,mongo,web')throw Error('DEMO_PROJECT_IDENTITY_INVALID');
 const volumes=Object.fromEntries(Object.entries(m.volumes).map(([k,v])=>[k,v.name]));
 if(Object.values(volumes).some(v=>!/^caudelyx-demo-(?:mongo-data|api-runtime|restore-[a-f0-9-]{36}-(?:mongo|runtime))$/.test(v)))throw Error('DEMO_VOLUME_IDENTITY_INVALID');
 return{prefix,m,volumes};
}
async function privateIdentity(root){
 const p=JSON.parse(await ordinary(path.join(root,'profile.json'))),keys=JSON.parse(await ordinary(path.join(root,'control/keys.json'))),signature=createHmac('sha256',Buffer.from(keys.journal,'base64url')).update('CAUDELYX:DEMO:PROFILE:v1:'+JSON.stringify(p.payload)).digest('hex');
 if(!/^[a-f0-9]{64}$/.test(p.signature)||!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(p.signature,'hex'))||p.payload.mode!=='local-synthetic'||p.payload.realUseAllowed!==false||p.payload.keyringSHA256!==hash(await ordinary(path.join(root,'control/keys.json'))))throw Error('DEMO_PRIVATE_IDENTITY_INVALID');return p.payload;
}
async function verifyVolumes(volumes,deploymentId){for(const name of Object.values(volumes)){const [v]=JSON.parse(await docker(['volume','inspect',name]));if(v.Name!==name||v.Labels?.['caudelyx.deploymentId']!==deploymentId)throw Error('DEMO_UNOWNED_VOLUME');}}
async function containers(prefix,project){const ids=(await docker([...prefix,'ps','-aq'])).split(/\s+/).filter(Boolean);if(ids.length!==3)throw Error('DEMO_THREE_CONTAINERS_REQUIRED');const list=JSON.parse(await docker(['inspect',...ids]));if(list.some(c=>c.Config.Labels?.['com.docker.compose.project']!==project)||list.map(c=>c.Config.Labels?.['com.docker.compose.service']).sort().join(',')!=='api,mongo,web')throw Error('DEMO_CONTAINER_IDENTITY_INVALID');return list;}
async function backupGroup({compose,env,privateRoot,output,keyFile,helperImage}){
 helper(helperImage);const root=path.resolve(privateRoot),dest=path.resolve(output),key=await ordinary(keyFile);
 if(key.length!==32||path.resolve(keyFile).startsWith(root+path.sep)||dest===root||dest.startsWith(root+path.sep)||root.startsWith(dest+path.sep))throw Error('BACKUP_LOCATION_OR_KEY_INVALID');
 const identity=await privateIdentity(root),{prefix,m,volumes}=await model(compose,env),api=m.services.api.environment;
 if(api.CAUDELYX_MODE!=='local-synthetic'||api.CAUDELYX_RUNTIME_PROFILE!=='persistent-demo'||api.MONGODB_DATABASE!==identity.databaseName||api.MONGODB_URI!==identity.mongoUri||api.TENANT_ORIGIN!==identity.tenantOrigin||api.PLATFORM_ORIGIN!==identity.platformOrigin||path.resolve(m.secrets.demo_profile.file)!==path.join(root,'profile.json'))throw Error('BACKUP_CONFIGURATION_MISMATCH');
 await verifyVolumes(volumes,identity.deploymentId);const current=await containers(prefix,m.name);
 for(const [service,target,role]of [['mongo','/data/db','mongo-data'],['api','/srv/Caudelyx/servidor/.runtime','api-runtime']]){
  const mount=current.find(c=>c.Config.Labels['com.docker.compose.service']===service).Mounts.find(v=>v.Destination===target);
  if(mount?.Type!=='volume'||mount.Name!==volumes[role])throw Error('BACKUP_RUNNING_VOLUME_MISMATCH');
 }
 const apiMounts=current.find(c=>c.Config.Labels['com.docker.compose.service']==='api').Mounts;
 const keyMount=apiMounts.find(v=>v.Destination==='/srv/Caudelyx/servidor/.runtime/demo-control/keys.json');
 if(keyMount?.Type!=='bind'||path.resolve(keyMount.Source)!==path.join(root,'control/keys.json'))throw Error('BACKUP_RUNNING_KEYRING_MISMATCH');
 await fs.mkdir(dest,{mode:0o700}); // Existing backup directories are never reused.
 await docker([...prefix,'stop','web','api']);await docker([...prefix,'stop','mongo']);
 const stopped=await containers(prefix,m.name);if(stopped.some(c=>c.State.Running||c.State.ExitCode!==0))throw Error('DEMO_CLEAN_STOP_REQUIRED');
 const records=[];
 for(const [role,name] of Object.entries(volumes)){
  const child=spawn('docker',['run','--rm','--network','none','--read-only','--user','0:0','--mount',`type=volume,source=${name},target=/source,readonly`,'--mount',`type=bind,source=${self},target=/op/operations.mjs,readonly`,'--entrypoint','node',helperImage,'/op/operations.mjs','__archive','/source'],{stdio:['ignore','pipe','pipe'],windowsHide:true});const exited=once(child,'exit');child.stderr.resume();const record=await encryptArchive(child.stdout,path.join(dest,role+'.enc'),key);if((await exited)[0]!==0)throw Error('BACKUP_VOLUME_READ_FAILED');records.push({role,...record});
 }
 records.push({role:'private',...await encryptArchive(Readable.from(archiveDirectory(root)),path.join(dest,'private.enc'),key)});
 const payload={version:1,backupId:randomUUID(),deploymentId:identity.deploymentId,createdAt:new Date().toISOString(),databaseName:identity.databaseName,sourcePrivateRoot:root,project:m.name,volumes,images:stopped.map(c=>({service:c.Config.Labels['com.docker.compose.service'],imageId:c.Image})),records};
 await fs.writeFile(path.join(dest,'manifest.json'),JSON.stringify({payload,signature:mac(key,payload)},null,2)+'\n',{flag:'wx',mode:0o600});
 // Deliberately remain stopped: operator verifies the copy before restart.
 return{backupId:payload.backupId,archives:records.length,originalsPreserved:true,services:'STOPPED_PENDING_OPERATOR_VERIFICATION'};
}
async function restoreGroup({backup,keyFile,privateRoot,helperImage}){
 await step('PREFLIGHT',async()=>{helper(helperImage);await localDocker();});
 const source=path.resolve(backup),key=await step('KEY_READ',()=>ordinary(keyFile)),envelope=await step('MANIFEST_READ',async()=>{try{return JSON.parse(await ordinary(path.join(source,'manifest.json')));}catch(error){if(error instanceof SyntaxError)throw failure('BACKUP_MANIFEST_INVALID',error);throw error;}}),p=envelope.payload;
 await step('MANIFEST_VERIFY',async()=>{
 if(key.length!==32||!p||typeof p!=='object'||typeof envelope.signature!=='string'||!/^[a-f0-9]{64}$/.test(envelope.signature)||!timingSafeEqual(Buffer.from(envelope.signature,'hex'),Buffer.from(mac(key,p),'hex'))||p.version!==1)throw Error('BACKUP_MANIFEST_INVALID');
 if(!Array.isArray(p.records)||p.records.length!==3||p.records.map(r=>r.role).sort().join(',')!=='api-runtime,mongo-data,private')throw Error('BACKUP_GROUP_INVALID');
 });
 await step('ARCHIVES_VERIFY',async()=>{
 for(const record of p.records)if(record.file!==record.role+'.enc'||!(/^[a-f0-9]{24}$/).test(record.iv)||!(/^[a-f0-9]{32}$/).test(record.tag)||await fileHash(path.join(source,record.file))!==record.sha256)throw Error('BACKUP_ARCHIVE_INVALID');
 });
 const id=randomUUID(),volumes={'mongo-data':'caudelyx-demo-restore-'+id+'-mongo','api-runtime':'caudelyx-demo-restore-'+id+'-runtime'},dest=path.resolve(privateRoot);
 // Identifies only newly allocated resources; no paths, backup identity or data.
 console.error(JSON.stringify({event:'CAUDELYX_RESTORE_TARGETS',restoreId:id,volumes}));
 await step('DESTINATION_CREATE',async()=>{
 if(dest===p.sourcePrivateRoot||dest.startsWith(p.sourcePrivateRoot+path.sep)||dest===source||dest.startsWith(source+path.sep))throw Error('RESTORE_ORIGINAL_PATH_FORBIDDEN');
 if(await fs.realpath(path.dirname(dest))!==path.dirname(dest))throw Error('RESTORE_PARENT_INVALID');
 await fs.mkdir(dest,{mode:0o700});
 if(await fs.realpath(dest)!==dest)throw Error('RESTORE_PARENT_INVALID');
 });
 try{
 for(const [role,name] of Object.entries(volumes)){
  // UUID new target only; no volume deletion or reuse and no original mounts.
  await step('VOLUME_CREATE',async()=>{
  if(await docker(['volume','ls','--filter',`name=^${name}$`,'--format','{{.Name}}']))throw Error('RESTORE_VOLUME_ALREADY_EXISTS');
  await docker(['volume','create','--label','caudelyx.deploymentId='+p.deploymentId,name]);
  },role);
  const r=p.records.find(r=>r.role===role);
  await step('VOLUME_TRANSFER',async()=>{
   const child=spawn('docker',restoreDockerArgs(name,helperImage),{stdio:['pipe','ignore','pipe'],windowsHide:true});
   await restoreArchiveToProcess(path.join(source,r.file),r,key,child);
  },role);
 }
 await step('PRIVATE_DECRYPT_EXTRACT',()=>decryptArchive(path.join(source,'private.enc'),p.records.find(r=>r.role==='private'),key,dest));
 await step('PRIVATE_IDENTITY',()=>privateIdentity(dest));
 }catch(error){console.error(JSON.stringify({event:'CAUDELYX_RESTORE_QUARANTINED',restoreId:id,volumes,originalsPreserved:true}));throw error;}
 report('COMPLETE','OK');
 return{project:'caudelyx-demo-restore-'+id,volumes,privateRoot:dest,services:'NOT_STARTED',sourceBackupId:p.backupId,required:'same Mongo image/version, internal paths, database names and signed profile; new loopback ports if original runs'};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const [operation,...args]=process.argv.slice(2);
 try{
  if(operation==='__archive'){await pipeline(Readable.from(archiveDirectory(args[0])),process.stdout);}
  else if(operation==='__extract'){try{await extractDirectory(args[0],process.stdin);}catch(error){report('EXTRACT','FAIL',error);throw error;}}
  else{
   const options={};for(let i=0;i<args.length;i+=2){if(!args[i].startsWith('--')||args[i+1]===undefined)throw Error('DEMO_OPERATION_USAGE');options[args[i].slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=args[i+1];}
   if(operation==='backup')console.log(JSON.stringify(await backupGroup(options),null,2));
   else if(operation==='restore')console.log(JSON.stringify(await restoreGroup(options),null,2));
   else if(operation==='prepare-volumes'){
    const identity=await privateIdentity(path.resolve(options.privateRoot)),{volumes}=await model(options.compose,options.env);
    for(const name of Object.values(volumes)){let exists=false;try{await docker(['volume','inspect',name]);exists=true;}catch{}if(exists)throw Error('DEMO_VOLUME_ALREADY_EXISTS');}
    for(const name of Object.values(volumes))await docker(['volume','create','--label','caudelyx.deploymentId='+identity.deploymentId,name]);console.log('DEMO_NEW_VOLUMES_CREATED');
   }else throw Error('DEMO_OPERATION_USAGE');
  }
 }catch(error){console.error(operation==='restore'||operation==='__extract'?(operationCode(error)==='UNCLASSIFIED'?'DEMO_OPERATION_FAILED':operationCode(error)):(error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'DEMO_OPERATION_FAILED'));process.exitCode=1;}
}
