/* eslint-disable security/detect-non-literal-fs-filename -- Read-only contained sealed inputs. No compile, DB, lock, receipt or file writes. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {projectRoot} from './s13-p04-guard.mjs';
const start=performance.now(),e=path.join(projectRoot,'Construccion/Sprints/S13/Evidencias');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
async function contained(name){
 if(typeof name!=='string'||name.includes('\\')||name.split('/').some(n=>n==='..'||n==='.'||n.includes(':')))throw Error('INVALID_SEALED_PATH');
 const p=path.resolve(projectRoot,name),relative=path.relative(projectRoot,p);if(path.isAbsolute(relative)||relative.startsWith('..'))throw Error('OUTSIDE_SEALED_ROOT');let cursor=projectRoot;
 for(const part of relative.split(path.sep)){cursor=path.join(cursor,part);if((await fs.lstat(cursor)).isSymbolicLink()||await fs.realpath(cursor)!==cursor)throw Error('SEALED_LINK_OR_ALIAS');}return p;
}
async function files(dir){let result=[];for(const d of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,d.name);if(d.isSymbolicLink()||await fs.realpath(p)!==p)throw Error('SELECTOR_LINK');if(d.isDirectory())result.push(...await files(p));else result.push(path.relative(projectRoot,p).replaceAll(path.sep,'/'));}return result;}
try{
 const trusted=process.argv[2];if(process.argv.length!==3||!/^--sha256=[a-f0-9]{64}$/.test(trusted??''))throw Error('TRUSTED_MANIFEST_SHA256_REQUIRED');
 const raw=await fs.readFile(path.join(e,'S13-P04-HASHES.json'));if(digest(raw)!==trusted.slice(9))throw Error('MANIFEST_IDENTITY_MISMATCH');const manifest=JSON.parse(raw);
 if(manifest.id!=='S13-P04-v1-INTEGRADO'||manifest.realUseAllowed!==false||manifest.independentApproval!==false||manifest.P05Activated!==false)throw Error('INVALID_MANIFEST_SCOPE');
 for(const[n,r]of Object.entries(manifest.files)){const bytes=await fs.readFile(await contained(n));if(digest(bytes)!==r.sha256||bytes.length!==r.bytes)throw Error('SEALED_FILE_DRIFT:'+n);}
 const snapshot=await read(path.join(e,'S13-P04-SNAPSHOT.json'));
 for(const row of snapshot.sources)if(digest(Buffer.from(row.base64,'base64'))!==row.sha256||digest(await fs.readFile(await contained(row.path)))!==row.sha256)throw Error('SNAPSHOT_DRIFT:'+row.path);
 if(digest(JSON.stringify(snapshot.sources.map(r=>[r.path,r.sha256])))!==manifest.sourceFingerprint||snapshot.sources.length!==manifest.sourceCount)throw Error('SOURCE_FINGERPRINT_DRIFT');
 for(const lane of manifest.selectors){const actual=(await files(await contained(lane))).sort(),declared=Object.keys(manifest.files).filter(n=>n.startsWith(lane+'/')).sort();if(JSON.stringify(actual)!==JSON.stringify(declared))throw Error('CANDIDATE_SELECTOR_DRIFT:'+lane);}
 const state=await read(path.join(e,'S13-P04-BUILD-STATE.json'));
 for(const[n,h]of state.inputs){const name=path.relative(projectRoot,path.resolve(projectRoot,'Caudelyx/servidor',n)).replaceAll(path.sep,'/');if(digest(await fs.readFile(await contained(name)))!==h)throw Error('BUILD_INPUT_DRIFT:'+n);}
 for(const[n,h]of state.outputs)if(digest(await fs.readFile(await contained('Caudelyx/servidor/dist-s13-p04/'+n)))!==h)throw Error('COMPILED_DRIFT:'+n);
 const dev=await read(path.join(e,'S13-P04-DEV-BUILD-STATE.json'));if(dev.cycles!==2)throw Error('DEV_START_EVIDENCE_MISSING');for(const[n,h]of Object.entries({...dev.inputs,...dev.outputs}))if(digest(await fs.readFile(await contained(n)))!==h)throw Error('DEV_INPUT_OR_OUTPUT_DRIFT:'+n);
 const compiler=await read(path.join(e,'S13-P04-COMPILER-INPUTS.json'));for(const[n,h]of Object.entries(compiler.files))if(digest(await fs.readFile(await contained(n)))!==h)throw Error('COMPILER_DEPENDENCY_DRIFT:'+n);
 const preimages=await read(path.join(e,'S13-P04-PREIMAGES.json'));if(Object.keys(preimages).length!==28)throw Error('LIVE_PREIMAGES_MISSING');for(const row of Object.values(preimages))if(digest(Buffer.from(row.base64,'base64'))!==row.sha256)throw Error('PREIMAGE_DRIFT');
 const inventory=await read(path.join(e,'S13-P04-INVENTORY.json'));for(const[n,r]of Object.entries(inventory.protected)){const p=await contained(n),bytes=await fs.readFile(p),st=await fs.stat(p,{bigint:true});if(digest(bytes)!==r.sha256||bytes.length!==r.bytes||Number(st.mtimeNs)!==r.mtimeNs)throw Error('PROTECTED_BYTES_OR_MTIME_DRIFT:'+n);}
 const resources=await read(path.join(e,'S13-P04-RESOURCE-SUMMARY.json')),gates=await read(path.join(e,'S13-P04-GATES.json'));
 if(!resources.allGroupsEnded||resources.retained.length||!gates.READY_FOR_P05||!gates.P04Integrated||gates.P05Activated||gates.P05Reviewed||gates.realUseAllowed!==false||gates.independentApproval!==false)throw Error('INVALID_GATE');
 process.stdout.write(JSON.stringify({state:'PASS',candidateId:manifest.id,manifestSHA256:digest(raw),sourceFingerprint:manifest.sourceFingerprint,files:Object.keys(manifest.files).length,sources:snapshot.sources.length,protected:Object.keys(inventory.protected).length,durationMs:performance.now()-start,writes:0,DBConnections:0,independentApproval:false})+'\n');
}catch(error){process.stderr.write(JSON.stringify({state:'FAIL',error:String(error),writes:0,DBConnections:0})+'\n');process.exitCode=1;}
