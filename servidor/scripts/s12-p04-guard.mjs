/* eslint-disable security/detect-non-literal-fs-filename -- Canonical contained paths with closed own output lanes, no HTTP data. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
export async function assertWritable(target,root=projectRoot){
 const base=await fs.realpath(root),p=path.resolve(target),relative=path.relative(base,p).replaceAll(path.sep,'/');
 if(path.isAbsolute(relative)||relative.startsWith('../')||relative==='..'||!relative)throw Error('OUTPUT_OUTSIDE_WORKSPACE');
 const marker=path.join(base,'Construccion/Sprints/S12/Evidencias/S12-P04-HASHES.json');
 if(await fs.stat(marker).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))throw Error('FROZEN_P02_REFUSE_BEFORE_WRITE');
 const parts=relative.split('/'),evidence=parts.slice(0,4).join('/')==='Construccion/Sprints/S12/Evidencias'&&parts[4]?.startsWith('S12-P04-')&&!/[^A-Za-z0-9_.-]/.test(parts[4]);
 const compiled=parts[0]==='Caudelyx'&&parts[1]==='servidor'&&['dist-s12-p04','dist-s12-p04-dev'].includes(parts[2]);
 const runtime=parts[0]==='Caudelyx'&&parts[1]==='servidor'&&parts[2]==='.runtime'&&parts[3]?.startsWith('s12-p04-')&&/^[a-f0-9]{24}$/.test(parts[3].slice(8));
 const client=parts[0]==='Caudelyx'&&parts[1]==='cliente'&&['dist-s12-p04','.cache-s12-p04'].includes(parts[2]);
 const allowed=evidence||compiled||runtime||client;
 if(!allowed)throw Error('PROTECTED_OR_UNREGISTERED_OUTPUT');
 let cursor=base;for(const segment of relative.split('/')){cursor=path.join(cursor,segment);try{const st=await fs.lstat(cursor);if(st.isSymbolicLink())throw Error('LINKED_OUTPUT_REFUSED');const real=await fs.realpath(cursor);if(real!==cursor)throw Error('ALIASED_OUTPUT_REFUSED');}catch(error){if(error.code!=='ENOENT')throw error;}}
 return p;
}
export async function writeOwn(target,data,root=projectRoot,options={}){await assertWritable(target,root);await fs.writeFile(target,data,options);}
export async function appendOwn(target,data,root=projectRoot){await assertWritable(target,root);await fs.appendFile(target,data);}
export async function mkdirOwn(target,root=projectRoot){await assertWritable(target,root);await fs.mkdir(target,{recursive:true});}
