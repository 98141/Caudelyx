/* eslint-disable security/detect-non-literal-fs-filename -- Closed packet namespaces and canonical ancestors; no HTTP input. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
function lexical(value){
 if(typeof value!=='string'||!value||value.length>240||/[\0]/.test(value)||value.startsWith('\\\\?\\')||value.startsWith('\\\\.\\')||value.split(/[\\/]/).some(s=>s==='..'||s==='.'||/~[0-9]/.test(s)||/[ .]$/.test(s)))throw Error('AMBIGUOUS_OUTPUT_PATH');
 const rest=value.replace(/^[A-Za-z]:/,'');if(rest.includes(':'))throw Error('OUTPUT_ADS_REFUSED');
}
async function canonicalExisting(p){const st=await fs.lstat(p);if(st.isSymbolicLink())throw Error('LINKED_OUTPUT_REFUSED');if(await fs.realpath(p)!==p)throw Error('ALIASED_OUTPUT_REFUSED');return st;}
async function sealAbsent(base){
 let cursor=base;const parts=['Construccion','Sprints','S13','Evidencias'];for(const name of parts){cursor=path.join(cursor,name);lexical(cursor);const st=await canonicalExisting(cursor);if(!st.isDirectory())throw Error('INVALID_SEAL_PARENT');}
 const marker=path.join(cursor,'S13-P04-HASHES.json');lexical(marker);
 try{await fs.lstat(marker);}catch(error){if(error.code==='ENOENT')return;throw error;}throw Error('FROZEN_S13_P04_REFUSE_BEFORE_WRITE');
}
export async function assertWritable(target,root=projectRoot){
 if(process.env.CAUDELYX_S13_CANCEL==='1')throw Error('CANCELLED_BEFORE_OUTPUT');
 lexical(target);lexical(root);const base=path.resolve(root);if(!(await canonicalExisting(base)).isDirectory())throw Error('INVALID_OUTPUT_ROOT');await sealAbsent(base);
 const p=path.resolve(target),relative=path.relative(base,p).replaceAll(path.sep,'/');if(path.isAbsolute(relative)||relative.startsWith('../')||relative==='..'||!relative)throw Error('OUTPUT_OUTSIDE_WORKSPACE');
 const parts=relative.split('/'),evidence=parts.slice(0,4).join('/')==='Construccion/Sprints/S13/Evidencias'&&/^S13-P04-[A-Za-z0-9_.-]+$/.test(parts[4]??'');
 const compiled=parts[0]==='Caudelyx'&&((parts[1]==='servidor'&&['dist-s13-p04','dist-s13-p04-dev'].includes(parts[2]))||(parts[1]==='cliente'&&parts[2]==='dist-s13-p04'));
 const runtime=parts[0]==='Caudelyx'&&parts[1]==='servidor'&&parts[2]==='.runtime'&&/^s13-p04-[a-f0-9]{24}$/.test(parts[3]??'');
 if(!evidence&&!compiled&&!runtime)throw Error('PROTECTED_OR_UNREGISTERED_OUTPUT');
 let cursor=base,missing=false;for(const segment of parts){cursor=path.join(cursor,segment);if(missing)continue;try{await canonicalExisting(cursor);}catch(error){if(error.code!=='ENOENT')throw error;missing=true;}}
 return p;
}
export async function writeOwn(target,data,root=projectRoot,options={}){options.signal?.throwIfAborted();await assertWritable(target,root);options.signal?.throwIfAborted();await fs.writeFile(target,data,options);}
export async function appendOwn(target,data,root=projectRoot){await assertWritable(target,root);await fs.appendFile(target,data);}
export async function mkdirOwn(target,root=projectRoot){await assertWritable(target,root);await fs.mkdir(target,{recursive:true});}
