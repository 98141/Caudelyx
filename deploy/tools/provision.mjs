// Explicit NEW synthetic deployment only. Never repairs/reuses a private root.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomBytes,randomUUID,createHash,createHmac} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pack} from './package-contracts.mjs';
const exec=promisify(execFile);
const sha=b=>createHash('sha256').update(b).digest('hex');
const repo=path.resolve(fileURLToPath(new URL('../..',import.meta.url)));
export async function provision(destination,settings={}){
  const root=path.resolve(destination),parent=path.dirname(root);
  for(const forbidden of [repo,path.resolve(repo,'../Construccion')])if(root===forbidden||root.startsWith(forbidden+path.sep)||forbidden.startsWith(root+path.sep))throw Error('Private root must be outside source/documentation');
  if(await fs.realpath(parent)!==parent)throw Error('Private parent must exist without links');
  const databaseName=settings.databaseName??'caudelyx_demo_integral',mongoUri=settings.mongoUri??'mongodb://mongo:27017/?replicaSet=rs0';
  if(!/^caudelyx_demo_[a-z0-9_]{3,20}$/.test(databaseName))throw Error('Dedicated demo name required');
  const tenantOrigin=settings.tenantOrigin??'https://localhost:3001',platformOrigin=settings.platformOrigin??'https://platform.localhost:3002';
  const hosts=[new URL(tenantOrigin).hostname,new URL(platformOrigin).hostname];
  if(hosts.some(h=>!/^[-a-z0-9.]+$/i.test(h)))throw Error('DNS HTTPS origins required');
  const deploymentId=randomUUID();
  await fs.mkdir(root,{mode:0o700});
  // Set owner-only Windows ACL before writing ANY material, not after copying.
  if(process.platform==='win32')await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$p=$env:F06_PRIVATE_PATH; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $a=New-Object System.Security.AccessControl.DirectorySecurity; $a.SetOwner($sid); $a.SetAccessRuleProtection($true,$false); $a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))); (New-Object System.IO.DirectoryInfo($p)).SetAccessControl($a); $got=(New-Object System.IO.DirectoryInfo($p)).GetAccessControl(); if(-not $got.AreAccessRulesProtected){throw 'ACL_FAILED'}; foreach($entry in $got.Access){if($entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'ACL_PRINCIPAL_FAILED'}}"],{env:{...process.env,F06_PRIVATE_PATH:root},windowsHide:true});
  const write=async(relative,bytes,mode=0o600)=>{const p=path.join(root,relative);await fs.mkdir(path.dirname(p),{recursive:true,mode:0o700});await fs.writeFile(p,bytes,{flag:'wx',mode});return p;};
  const keys={version:2,...Object.fromEntries(['priority','mail','totp','journal','cursor'].map(k=>[k,randomBytes(32).toString('base64url')]))};
  const keyBytes=Buffer.from(JSON.stringify(keys)+'\n');await write('control/keys.json',keyBytes);await fs.mkdir(path.join(root,'control/private'),{mode:0o700});
  for(const [n,value] of Object.entries({app_username:'caudelyx_application',app_password:randomBytes(36).toString('base64url'),admin_username:'caudelyx_operator',admin_password:randomBytes(36).toString('base64url'),monitor_username:'caudelyx_monitor',monitor_password:randomBytes(36).toString('base64url'),replica_key:randomBytes(512).toString('base64')}))await write('secrets/'+n,value+'\n');
  const openssl=settings.openssl??(process.platform==='win32'?'C:/Program Files/Git/mingw64/bin/openssl.exe':'openssl');
  const ssl=async args=>{try{await exec(openssl,args,{windowsHide:true,env:{...process.env,MSYS_NO_PATHCONV:'1'},maxBuffer:1024*1024});}catch{throw Error('DEMO_TLS_PROVISION_FAILED');}};
  await fs.mkdir(path.join(root,'.authority'),{mode:0o700});
  const caKey=path.join(root,'.authority/ca.key'),caCert=path.join(root,'.authority/ca.pem');
  await ssl(['req','-x509','-newkey','rsa:3072','-nodes','-keyout',caKey,'-out',caCert,'-days','30','-subj','/CN=Caudelyx Private Synthetic Demo CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
  for(const role of ['api','web','mongo']){
    const folder=path.join(root,'tls',role);await fs.mkdir(folder,{recursive:true,mode:0o700});
    const key=path.join(folder,'key.pem'),csr=path.join(root,'.authority',role+'.csr'),cert=path.join(folder,'cert.pem');
    const dns=[...new Set([role,'localhost','platform.localhost',...(role==='web'?hosts:[])])];
    const ext=await write('.authority/'+role+'.ext','subjectAltName='+dns.map(h=>'DNS:'+h).join(',')+',IP:127.0.0.1\nextendedKeyUsage=serverAuth'+(role==='mongo'?',clientAuth':'')+'\nkeyUsage=digitalSignature,keyEncipherment\n');
    await ssl(['req','-new','-newkey','rsa:2048','-nodes','-keyout',key,'-out',csr,'-subj','/CN='+role]);
    await ssl(['x509','-req','-in',csr,'-CA',caCert,'-CAkey',caKey,'-set_serial','0x'+randomBytes(16).toString('hex'),'-out',cert,'-days','14','-extfile',ext]);
    await fs.copyFile(caCert,path.join(folder,'ca.pem'),fs.constants.COPYFILE_EXCL);
    if(role==='mongo')await write('tls/mongo/server.pem',Buffer.concat([await fs.readFile(key),await fs.readFile(cert)]));
    if(role==='web')await fs.copyFile(caCert,path.join(folder,'api-ca.pem'),fs.constants.COPYFILE_EXCL);
  }
  const payload={version:1,mode:'local-synthetic',realUseAllowed:false,deploymentId,databaseName,mongoUri,tenantOrigin,platformOrigin,keyringSHA256:sha(keyBytes)};
  const signature=createHmac('sha256',Buffer.from(keys.journal,'base64url')).update('CAUDELYX:DEMO:PROFILE:v1:'+JSON.stringify(payload)).digest('hex');
  await write('profile.json',JSON.stringify({payload,signature},null,2)+'\n');
  const contracts=await pack(path.dirname(repo),path.join(root,'contracts'));
  const env={CAUDELYX_MODE:'local-synthetic',CAUDELYX_RUNTIME_PROFILE:'persistent-demo',MONGODB_URI:mongoUri,MONGODB_DATABASE:databaseName,PORT:String(settings.port??4001),PLATFORM_PORT:String(settings.platformPort??4002),TENANT_ORIGIN:tenantOrigin,PLATFORM_ORIGIN:platformOrigin,KEYRING_FILE:path.join(root,'control/keys.json'),TLS_DIRECTORY:path.join(root,'tls/api'),DEMO_PROFILE_FILE:path.join(root,'profile.json'),MONGODB_USERNAME_FILE:path.join(root,'secrets/app_username'),MONGODB_PASSWORD_FILE:path.join(root,'secrets/app_password'),MONGODB_CA_FILE:path.join(root,'tls/mongo/ca.pem'),CAUDELYX_API_BIND_HOST:'127.0.0.1',CAUDELYX_CONTRACTS_SHA256:contracts.manifestSha256};
  await write('local.env',Object.entries(env).map(([k,v])=>k+'='+JSON.stringify(v.replaceAll('\\','/'))).join('\n')+'\n');
  await write('deployment.json',JSON.stringify({deploymentId,databaseName,mongoUri,tenantOrigin,platformOrigin,contractsSHA256:contracts.manifestSha256,createdAt:new Date().toISOString(),syntheticOnly:true},null,2)+'\n');
  return{root,env,deploymentId,databaseName,contractsSHA256:contracts.manifestSha256};
}
// Run explicitly as root AFTER secure transfer to the Linux Docker host.
// Compose file-backed secrets keep host permissions; its uid/mode declarations
// cannot be relied upon to chown a bind-mounted secret.
export async function prepareLinux(destination){
 if(process.platform!=='linux'||process.getuid()!==0)throw Error('DEMO_LINUX_ROOT_REQUIRED');
 const root=path.resolve(destination);if(await fs.realpath(root)!==root||root===repo||root.startsWith(repo+path.sep))throw Error('DEMO_PRIVATE_PATH_INVALID');
 const p=JSON.parse(await fs.readFile(path.join(root,'profile.json'),'utf8')),keys=JSON.parse(await fs.readFile(path.join(root,'control/keys.json'),'utf8'));
 const expected=createHmac('sha256',Buffer.from(keys.journal,'base64url')).update('CAUDELYX:DEMO:PROFILE:v1:'+JSON.stringify(p.payload)).digest('hex');
 if(p.signature!==expected||p.payload.mode!=='local-synthetic'||p.payload.realUseAllowed!==false||p.payload.keyringSHA256!==sha(await fs.readFile(path.join(root,'control/keys.json'))))throw Error('DEMO_PRIVATE_BINDING_INVALID');
 async function tree(folder,uid){
  const stat=await fs.lstat(folder);if(stat.isSymbolicLink()||await fs.realpath(folder)!==path.resolve(folder)||!stat.isFile()&&!stat.isDirectory())throw Error('DEMO_PRIVATE_LINK_DENIED');
  if(stat.isDirectory())for(const e of await fs.readdir(folder))await tree(path.join(folder,e),uid);
  await fs.chown(folder,uid,uid);await fs.chmod(folder,stat.isDirectory()?0o700:0o400);
 }
 // Root remains the only host principal able to traverse the private root.
 await fs.chown(root,0,0);await fs.chmod(root,0o700);
 for(const dir of ['contracts','tls/api','control'])await tree(path.join(root,dir),1000);
 await tree(path.join(root,'tls/web'),101);
 for(const name of ['app_username','app_password']){const f=path.join(root,'secrets',name);if(await fs.realpath(f)!==f||!(await fs.lstat(f)).isFile())throw Error('DEMO_SECRET_PATH_INVALID');await fs.chown(f,0,0);await fs.chmod(f,0o444);}
 await fs.chmod(path.join(root,'profile.json'),0o444);
 return{hostRoot:'root:root 0700',apiUID:1000,webUID:101,secretFiles:'read-only in assigned container; private root inaccessible to host users'};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  try{const [flag,output,settings]=process.argv.slice(2);if(flag==='--prepare-linux'&&output){console.log(JSON.stringify(await prepareLinux(output)));}else{if(flag!=='--new'||!output)throw Error('Usage: provision.mjs --new NEW_PRIVATE_ROOT [PUBLIC_SETTINGS_JSON]');const r=await provision(output,settings?JSON.parse(await fs.readFile(settings,'utf8')):{});console.log(JSON.stringify({deploymentId:r.deploymentId,databaseName:r.databaseName,contractsSHA256:r.contractsSHA256,authorityPrivateKey:'Keep .authority OFF the VM; never transfer it or put it in Git'}));}}
  catch{console.error('DEMO_PROVISION_FAILED: destination must be NEW; inspect partial output, never overwrite or regenerate');process.exitCode=1;}
}
