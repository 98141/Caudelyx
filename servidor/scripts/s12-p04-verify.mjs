/* eslint-disable security/detect-non-literal-fs-filename -- Read-only sealed manifests and contained paths. No compile, DB, receipt or file write. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {projectRoot} from './s12-p04-guard.mjs';
const start=performance.now(),e=path.join(projectRoot,'Construccion/Sprints/S12/Evidencias');
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function contained(name){const p=path.resolve(projectRoot,name),relative=path.relative(projectRoot,p);if(path.isAbsolute(relative)||relative.startsWith('..'))throw Error('OUTSIDE_SEALED_ROOT');let cursor=projectRoot;for(const part of relative.split(path.sep)){cursor=path.join(cursor,part);if((await fs.lstat(cursor)).isSymbolicLink())throw Error('SEALED_LINK');}return p;}
async function files(dir){let result=[];for(const d of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,d.name);if(d.isSymbolicLink())throw Error('SOURCE_LINK');if(d.isDirectory())result.push(...await files(p));else result.push(path.relative(projectRoot,p).replaceAll(path.sep,'/'));}return result;}
try{
 const raw=await fs.readFile(path.join(e,'S12-P04-HASHES.json')),manifest=JSON.parse(raw),verify=await read(path.join(e,'S12-P04-VERIFY.json'));
 if(digest(raw)!==verify.manifestSHA256)throw Error('MANIFEST_IDENTITY_MISMATCH');
 for(const[n,r]of Object.entries(manifest.files)){const p=await contained(n),b=await fs.readFile(p);if(digest(b)!==r.sha256||b.length!==r.bytes)throw Error('SEALED_FILE_DRIFT:'+n);}
 const snapshot=await read(path.join(e,'S12-P04-SNAPSHOT.json'));
 for(const row of snapshot.sources)if(digest(Buffer.from(row.base64,'base64'))!==row.sha256)throw Error('SNAPSHOT_DRIFT:'+row.path);
 if(digest(JSON.stringify(snapshot.sources.map(r=>[r.path,r.sha256])))!==manifest.sourceFingerprint)throw Error('SOURCE_FINGERPRINT_DRIFT');
 for(const[project,lanes]of [['servidor',['src','tests/s12-p04','dist-s12-p04','dist-s12-p04-dev']],['cliente',['src','tests/s12-p04','dist-s12-p04']]])for(const lane of lanes){const actual=(await files(path.join(projectRoot,'Caudelyx',project,lane))).sort(),prefix='Caudelyx/'+project+'/'+lane+'/',declared=Object.keys(manifest.files).filter(n=>n.startsWith(prefix)).sort();if(JSON.stringify(actual)!==JSON.stringify(declared))throw Error('CANDIDATE_SELECTOR_DRIFT:'+project+'/'+lane);}
 const clientBuild=await read(path.join(e,'S12-P04-CLIENT-BUILD-STATE.json'));
 for(const[n,h]of clientBuild.outputs)if(digest(await fs.readFile(await contained('Caudelyx/cliente/'+n)))!==h)throw Error('CLIENT_BUILD_DRIFT:'+n);
 for(const[n,h]of clientBuild.inputs)if(digest(await fs.readFile(await contained(path.relative(projectRoot,path.resolve(projectRoot,'Caudelyx/servidor',n)))))!==h)throw Error('CLIENT_BUILD_INPUT_DRIFT:'+n);
 const compiler=await read(path.join(e,'S12-P04-COMPILER-INPUTS.json'));
 for(const[n,h]of Object.entries(compiler.files))if(digest(await fs.readFile(await contained(n)))!==h)throw Error('COMPILER_DEPENDENCY_DRIFT:'+n);
 const inventory=await read(path.join(e,'S12-P04-INVENTORY.json'));
 for(const[n,r]of Object.entries(inventory.protected)){const p=await contained(n),b=await fs.readFile(p),st=await fs.stat(p,{bigint:true});if(digest(b)!==r.sha256||b.length!==r.bytes||Number(st.mtimeNs)!==r.mtimeNs)throw Error('PROTECTED_BYTES_OR_MTIME_DRIFT:'+n);}
 const resources=await read(path.join(e,'S12-P04-RESOURCE-SUMMARY.json')),gates=await read(path.join(e,'S12-P04-GATES.json'));
 if(!resources.allGroupsEnded||!gates.READY_FOR_P05||gates.P05Activated||gates.P05Reviewed||gates.realUseAllowed!==false||gates.independentApproval!==false)throw Error('INVALID_GATE');
 process.stdout.write(JSON.stringify({state:'PASS',candidateId:manifest.id,manifestSHA256:digest(raw),sourceFingerprint:manifest.sourceFingerprint,files:Object.keys(manifest.files).length,protected:Object.keys(inventory.protected).length,durationMs:performance.now()-start,writes:0,DBConnections:0,independentApproval:false})+'\n');
}catch(error){process.stderr.write(JSON.stringify({state:'FAIL',error:String(error),writes:0})+'\n');process.exitCode=1;}
