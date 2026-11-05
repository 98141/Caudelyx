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
 for(;;){const n=(await take(4)).readUInt32BE();if(!n)break;if(n>65536)throw Error('BACKUP_HEADER_LIMIT');const h=JSON.parse((await take(n)).toString('utf8')),target=inside(root,h.path);
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
 const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(record.iv,'hex'));decipher.setAuthTag(Buffer.from(record.tag,'hex'));
 const input=createReadStream(file),transfer=pipeline(input,decipher),extraction=extractDirectory(destination,decipher);
 // Attach both rejection handlers immediately: a small invalid archive can
 // finish while the ACL preflight is awaiting PowerShell. No unhandled error
 // may bypass the caller's quarantine/cleanup path.
 try{const [,result]=await Promise.all([transfer,extraction]);return result;}
 catch(error){input.destroy();decipher.destroy();await Promise.allSettled([transfer,extraction]);throw error;}
}
async function docker(args){try{return(await execute('docker',args,{windowsHide:true,maxBuffer:16*1024*1024})).stdout.trim();}catch{throw Error('DEMO_DOCKER_OPERATION_FAILED');}}
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
 helper(helperImage);await localDocker();
 const source=path.resolve(backup),key=await ordinary(keyFile),envelope=JSON.parse(await ordinary(path.join(source,'manifest.json'))),p=envelope.payload;
 if(key.length!==32||!envelope.signature?.match(/^[a-f0-9]{64}$/)||!timingSafeEqual(Buffer.from(envelope.signature,'hex'),Buffer.from(mac(key,p),'hex'))||p.version!==1)throw Error('BACKUP_MANIFEST_INVALID');
 if(p.records.length!==3||p.records.map(r=>r.role).sort().join(',')!=='api-runtime,mongo-data,private')throw Error('BACKUP_GROUP_INVALID');
 for(const record of p.records)if(record.file!==record.role+'.enc'||!(/^[a-f0-9]{24}$/).test(record.iv)||!(/^[a-f0-9]{32}$/).test(record.tag)||await fileHash(path.join(source,record.file))!==record.sha256)throw Error('BACKUP_ARCHIVE_INVALID');
 const id=randomUUID(),volumes={'mongo-data':'caudelyx-demo-restore-'+id+'-mongo','api-runtime':'caudelyx-demo-restore-'+id+'-runtime'},dest=path.resolve(privateRoot);
 if(dest===p.sourcePrivateRoot||dest.startsWith(p.sourcePrivateRoot+path.sep)||dest===source||dest.startsWith(source+path.sep))throw Error('RESTORE_ORIGINAL_PATH_FORBIDDEN');await fs.mkdir(dest,{mode:0o700});
 for(const [role,name] of Object.entries(volumes)){
  // UUID new target only; no volume deletion or reuse and no original mounts.
  let exists=false;try{await docker(['volume','inspect',name]);exists=true;}catch{}if(exists)throw Error('RESTORE_VOLUME_ALREADY_EXISTS');
  await docker(['volume','create','--label','caudelyx.deploymentId='+p.deploymentId,name]);
  const r=p.records.find(r=>r.role===role),decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(r.iv,'hex'));decipher.setAuthTag(Buffer.from(r.tag,'hex'));
  const child=spawn('docker',['run','--rm','--network','none','--read-only','--user','0:0','--mount',`type=volume,source=${name},target=/target`,'--mount',`type=bind,source=${self},target=/op/operations.mjs,readonly`,'--entrypoint','node',helperImage,'/op/operations.mjs','__extract','/target'],{stdio:['pipe','ignore','pipe'],windowsHide:true});const exited=once(child,'exit');child.stderr.resume();await pipeline(createReadStream(path.join(source,r.file)),decipher,child.stdin);if((await exited)[0]!==0)throw Error('RESTORE_VOLUME_FAILED');
 }
 await decryptArchive(path.join(source,'private.enc'),p.records.find(r=>r.role==='private'),key,dest);await privateIdentity(dest);
 return{project:'caudelyx-demo-restore-'+id,volumes,privateRoot:dest,services:'NOT_STARTED',sourceBackupId:p.backupId,required:'same Mongo image/version, internal paths, database names and signed profile; new loopback ports if original runs'};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{
  const [operation,...args]=process.argv.slice(2);
  if(operation==='__archive'){await pipeline(Readable.from(archiveDirectory(args[0])),process.stdout);}
  else if(operation==='__extract'){await extractDirectory(args[0],process.stdin);}
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
 }catch(error){console.error(error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'DEMO_OPERATION_FAILED');process.exitCode=1;}
}
