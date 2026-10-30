/* eslint-disable security/detect-non-literal-fs-filename -- Operator-selected workspace; every path is canonical, contained and checked component-by-component, including sidecar. No default writes. */
import {createHash} from 'node:crypto';
import {promises as fs, constants} from 'node:fs';
import path from 'node:path';

export const FORMAT='CAUDELYX_COMPILED_INPUTS_V1';
const HEX=/^[a-f0-9]{64}$/, MAX_ROWS=100000, MAX_JSON=64*1024*1024;
export class VerificationError extends Error {constructor(code){super(code);this.code=code;}}
const fail=code=>{throw new VerificationError(code);};
export const digest=data=>createHash('sha256').update(data).digest('hex');
const key=p=>process.platform==='win32'?p.toLowerCase():p;
const inside=(root,p)=>key(p)!==key(root)&&key(p).startsWith(key(root+path.sep));
const identity=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
const order=(a,b)=>Buffer.compare(Buffer.from(a[0]),Buffer.from(b[0]));
// A frozen snapshot's ordered source catalog is part of its identity. Do not
// replace the producer's Windows/Python ordering with another collation.
export const listFingerprint=rows=>digest(JSON.stringify(rows));
export const buildFingerprint=(metadata,inputs)=>digest(JSON.stringify({format:FORMAT,metadata,inputs:[...inputs].sort(order)}));

// JSON.parse silently drops duplicate keys. Validate grammar and uniqueness before parsing.
export function parseUniqueJSON(text){
 let i=0;const ws=()=>{while(i<text.length&&/\s/.test(text.charAt(i)))i++;};
 const str=()=>{const start=i++;while(i<text.length){const c=text.charAt(i++);if(c==='"')return JSON.parse(text.slice(start,i));if(c==='\\')i++;}fail('INVALID_JSON');};
 const number=()=>{if(text.charAt(i)==='-')i++;if(text.charAt(i)==='0')i++;else{if(!/[1-9]/.test(text.charAt(i)))fail('INVALID_JSON');while(/[0-9]/.test(text.charAt(i)))i++;}if(text.charAt(i)==='.'){i++;if(!/[0-9]/.test(text.charAt(i)))fail('INVALID_JSON');while(/[0-9]/.test(text.charAt(i)))i++;}if(['e','E'].includes(text.charAt(i))){i++;if(['+','-'].includes(text.charAt(i)))i++;if(!/[0-9]/.test(text.charAt(i)))fail('INVALID_JSON');while(/[0-9]/.test(text.charAt(i)))i++;}};
 const value=depth=>{if(depth>64)fail('JSON_DEPTH_LIMIT');ws();const c=text.charAt(i);
  if(c==='{'){i++;ws();const keys=new Set();if(text.charAt(i)==='}'){i++;return;}for(;;){ws();if(text.charAt(i)!=='"')fail('INVALID_JSON');const k=str();if(keys.has(k))fail('DUPLICATE_JSON_KEY');keys.add(k);ws();if(text.charAt(i++)!==':')fail('INVALID_JSON');value(depth+1);ws();const end=text.charAt(i++);if(end==='}')break;if(end!==',')fail('INVALID_JSON');}}
  else if(c==='['){i++;ws();if(text.charAt(i)===']'){i++;return;}for(;;){value(depth+1);ws();const end=text.charAt(i++);if(end===']')break;if(end!==',')fail('INVALID_JSON');}}
  else if(c==='"')str();
  else {const literal=['true','false','null'].find(v=>text.startsWith(v,i));if(literal)i+=literal.length;else number();}
 };
 try{value(0);ws();if(i!==text.length)fail('INVALID_JSON');return JSON.parse(text);}catch(e){if(e instanceof VerificationError)throw e;fail('INVALID_JSON');}
}

function relativeName(name){
 if(typeof name!=='string'||!name||!name.isWellFormed()||name.includes('\\')||name.includes(':')||name.includes('\0')||path.posix.isAbsolute(name)||name.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))fail('INVALID_RELATIVE_PATH');
 return name;
}
async function safeAbsolute(absolute,{missingLeaf=false}={}){
 let current=path.parse(absolute).root;
 const parts=absolute.slice(current.length).split(path.sep).filter(Boolean);
 for(let i=0;i<parts.length;i++){
  current=path.join(current,parts.at(i));let stat;
  try{stat=await fs.lstat(current,{bigint:true});}catch(e){if(e.code==='ENOENT'&&missingLeaf&&i===parts.length-1)return absolute;fail(e.code==='ENOENT'?'MISSING_FILE':'FILESYSTEM_READ_FAILED');}
  if(stat.isSymbolicLink())fail('UNSAFE_LINK');
  if(i<parts.length-1&&!stat.isDirectory())fail('NOT_A_DIRECTORY');
 }
 const actual=await fs.realpath(absolute);if(key(path.resolve(actual))!==key(absolute))fail('UNSAFE_REALPATH');return absolute;
}
function entries(value){
 const rows=Array.isArray(value)?value.map(r=>{if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!['path','sha256','bytes'].includes(k)))fail('INVALID_FILE_LIST');return[r.path,r.sha256];}):value&&typeof value==='object'?Object.entries(value):fail('INVALID_FILE_LIST');
 if(!rows.length||rows.length>MAX_ROWS)fail('INVALID_FILE_LIST');const seen=new Set();
 return rows.map(([name,sha])=>{relativeName(name);if(typeof sha!=='string'||!HEX.test(sha))fail('INVALID_SHA256');const normalized=key(name);if(seen.has(normalized))fail('DUPLICATE_FILE');seen.add(normalized);return[name,sha];});
}

export async function verifyCandidate({root,manifest,expectedManifestSHA256,snapshot,expectedSourceFingerprint,buildState,maxBytes=1024*1024*1024}={}){
 if(typeof root!=='string'||!path.isAbsolute(root)||!HEX.test(expectedManifestSHA256??''))fail('TRUSTED_ROOT_AND_MANIFEST_HASH_REQUIRED');
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1)fail('INVALID_BYTE_BUDGET');
 root=path.resolve(root);await safeAbsolute(root);if(!(await fs.stat(root)).isDirectory())fail('NOT_A_DIRECTORY');
 const tracked=new Map(),protectedPaths=new Set(),protectedDirectories=new Set();let bytes=0;
 const resolve=name=>{relativeName(name);const p=path.resolve(root,...name.split('/'));if(!inside(root,p))fail('PATH_ESCAPE');return p;};
 const read=async(name,json=false)=>{
  const p=resolve(name);await safeAbsolute(p);const before=await fs.lstat(p,{bigint:true});if(!before.isFile())fail('NOT_A_FILE');
  if(bytes+Number(before.size)>maxBytes||json&&before.size>BigInt(MAX_JSON))fail('BYTE_BUDGET_EXCEEDED');
  const handle=await fs.open(p,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let hash,body;
  try{
   if(identity(await handle.stat({bigint:true}))!==identity(before))fail('INPUT_CHANGED_DURING_VERIFY');
   if(json){body=await handle.readFile({encoding:'utf8'});bytes+=Number(before.size);hash=digest(Buffer.from(body));}
   else{const h=createHash('sha256');for await(const part of handle.createReadStream({autoClose:false})){bytes+=part.length;h.update(part);}hash=h.digest('hex');}
   if(identity(await handle.stat({bigint:true}))!==identity(before))fail('INPUT_CHANGED_DURING_VERIFY');
  }finally{await handle.close();}
  await safeAbsolute(p);if(identity(await fs.lstat(p,{bigint:true}))!==identity(before))fail('INPUT_CHANGED_DURING_VERIFY');
  const old=tracked.get(p);if(old&&old!==identity(before))fail('INPUT_CHANGED_DURING_VERIFY');tracked.set(p,identity(before));protectedPaths.add(p);
  return{hash,value:json?parseUniqueJSON(body):undefined};
 };
 const m=await read(manifest,true);if(m.hash!==expectedManifestSHA256)fail('MANIFEST_HASH_MISMATCH');
 const listed=entries(m.value?.files),map=new Map(listed);
 if(listed.some(([name])=>key(name)===key(manifest)))fail('SELF_INCLUDED_MANIFEST');
 // eslint-disable-next-line security/detect-possible-timing-attacks -- Public local file digests, not authentication secrets or network-facing comparisons.
 for(const[name,hash]of listed)if((await read(name)).hash!==hash)fail('FILE_HASH_MISMATCH');
 let sourceFingerprint=null;
 const declared=m.value.sourceFingerprint??m.value.documentSnapshotFingerprint??m.value.documentFingerprint;
 if(expectedSourceFingerprint!==undefined&&(!HEX.test(expectedSourceFingerprint)||declared&&declared!==expectedSourceFingerprint))fail('SOURCE_FINGERPRINT_MISMATCH');
 if(snapshot){
  if(!map.has(snapshot))fail('UNPINNED_SNAPSHOT');const value=await read(snapshot,true);if(value.hash!==map.get(snapshot))fail('FILE_HASH_MISMATCH');
  if(!Array.isArray(value.value?.sources))fail('INVALID_SNAPSHOT');
  const sources=entries(value.value.sources.map(r=>({path:r.path,sha256:r.sha256})));
  for(const[name,sha]of sources)if(map.get(name)!==sha)fail('SNAPSHOT_SOURCE_NOT_PINNED');
  for(const row of value.value.sources){
   if(row.base64!==undefined){if(typeof row.base64!=='string')fail('INVALID_SNAPSHOT');const data=Buffer.from(row.base64,'base64');if(data.toString('base64')!==row.base64||digest(data)!==row.sha256||row.bytes!==undefined&&row.bytes!==data.length)fail('SNAPSHOT_BYTES_MISMATCH');}
  }
  sourceFingerprint=listFingerprint(sources);const recorded=value.value.sourceFingerprint??value.value.fingerprint??value.value.documentFingerprint;
  if(recorded&&recorded!==sourceFingerprint)fail('SOURCE_FINGERPRINT_MISMATCH');
 }else if(m.value.documentFingerprint)sourceFingerprint=listFingerprint(listed);
 else if(declared||expectedSourceFingerprint)fail('SNAPSHOT_REQUIRED');
 if((declared&&sourceFingerprint!==declared)||(expectedSourceFingerprint&&sourceFingerprint!==expectedSourceFingerprint))fail('SOURCE_FINGERPRINT_MISMATCH');
 let compiledInputs=0,compiledOutputs=0;
 if(buildState){
  if(!map.has(buildState))fail('UNPINNED_BUILD_STATE');const state=await read(buildState,true);if(state.hash!==map.get(buildState))fail('FILE_HASH_MISMATCH');
  const b=state.value;if(b?.format!==FORMAT||!b.metadata||typeof b.metadata!=='object'||Array.isArray(b.metadata)||!HEX.test(b.inputFingerprint??''))fail('INVALID_BUILD_STATE');
  const inputs=entries(b.inputs),outputs=entries(b.outputs);if(buildFingerprint(b.metadata,inputs)!==b.inputFingerprint)fail('COMPILED_INPUT_KEY_MISMATCH');
  // eslint-disable-next-line security/detect-possible-timing-attacks -- Public compiler input digests; no authentication secret is compared.
  for(const[name,hash]of inputs)if((await read(name)).hash!==hash)fail('COMPILED_INPUT_CHANGED');
  const collect=async(directory,extensions,excluded=[])=>{
   const absolute=resolve(directory);await safeAbsolute(absolute);protectedDirectories.add(absolute);const names=[];
   const walk=async(dir)=>{for(const item of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,item.name);if(item.isSymbolicLink())fail('UNSAFE_LINK');if(item.isDirectory()){if(!excluded.includes(item.name))await walk(p);}else if(item.isFile()&&(!extensions||extensions.some(x=>item.name.endsWith(x))))names.push(path.relative(root,p).split(path.sep).join('/'));else if(!item.isFile())fail('NOT_A_FILE');if(names.length>MAX_ROWS)fail('FILE_COUNT_LIMIT');}};
   await walk(absolute);return names;
  };
  if(!Array.isArray(b.inputSets)||!b.inputSets.length||b.inputSets.length>100||!Array.isArray(b.explicitInputs))fail('INVALID_BUILD_INPUT_SELECTORS');
  const expected=new Set(b.explicitInputs.map(relativeName));
  for(const selector of b.inputSets){
   if(!selector||!Array.isArray(selector.extensions)||!selector.extensions.length||selector.extensions.some(e=>typeof e!=='string'||!/^\.[a-zA-Z0-9]+$/.test(e))||!Array.isArray(selector.excludeDirectories)||selector.excludeDirectories.some(n=>typeof n!=='string'||!n||n.includes('/')||n.includes('\\')||n==='.'||n==='..'))fail('INVALID_BUILD_INPUT_SELECTORS');
   for(const name of await collect(selector.directory,selector.extensions,selector.excludeDirectories))expected.add(name);
  }
  if([...expected].sort().join('\0')!==inputs.map(([n])=>n).sort().join('\0'))fail('COMPILED_INPUT_SET_CHANGED');
  for(const[name,hash]of outputs)if(map.get(name)!==hash||(await read(name)).hash!==hash)fail('COMPILED_OUTPUT_MISMATCH');
  const actualOutput=await collect(b.outputDirectory);const expectedOutput=outputs.map(([n])=>n);
  if(actualOutput.filter(n=>n!==buildState).sort().join('\0')!==expectedOutput.sort().join('\0'))fail('COMPILED_OUTPUT_SET_CHANGED');
  compiledInputs=inputs.length;compiledOutputs=outputs.length;
 }
 for(const[p,stamp]of tracked){await safeAbsolute(p);if(identity(await fs.lstat(p,{bigint:true}))!==stamp)fail('INPUT_CHANGED_DURING_VERIFY');}
 return{report:{tool:'S10-READONLY-VERIFIER-1',result:'PASS',manifestSHA256:m.hash,files:listed.length,sourceFingerprint,compiledInputs,compiledOutputs,bytesRead:bytes,readOnly:true},root,protectedPaths,protectedDirectories};
}

export async function writeSidecar(verified,{sidecar,sidecarRoot}){
 if(!sidecar||!sidecarRoot||typeof sidecarRoot!=='string'||!path.isAbsolute(sidecarRoot))fail('EXPLICIT_SIDECAR_ROOT_REQUIRED');
 const root=path.resolve(sidecarRoot);await safeAbsolute(root);if(!(await fs.stat(root)).isDirectory())fail('NOT_A_DIRECTORY');
 if(!path.isAbsolute(sidecar))fail('ABSOLUTE_SIDECAR_REQUIRED');const output=path.resolve(sidecar);
 if(!inside(root,output))fail('SIDECAR_OUTSIDE_AUTHORIZED_ROOT');
 if([...verified.protectedPaths].some(p=>key(p)===key(output)||inside(root,p))||[...verified.protectedDirectories].some(p=>key(p)===key(root)||inside(p,root)||inside(root,p)))fail('SIDECAR_COLLIDES_WITH_SEALED_SET');
 await safeAbsolute(output,{missingLeaf:true});
 const handle=await fs.open(output,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
 try{await handle.writeFile(JSON.stringify({...verified.report,readOnly:false,sidecarExplicitlyRequested:true},null,2)+'\n');}finally{await handle.close();}
 return output;
}
