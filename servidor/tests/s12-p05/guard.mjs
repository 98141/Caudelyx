/* eslint-disable security/detect-non-literal-fs-filename -- S12-P05 own closed output lanes; canonical paths checked before every write. */
// S12-P05 (Claude): own write guard. Allows only S12-P05 evidence and .runtime/s12-p05-<24hex>; refuses after own seal.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..');
export async function assertWritable(target,root=projectRoot){
 const base=await fs.realpath(root),p=path.resolve(target),relative=path.relative(base,p).replaceAll(path.sep,'/');
 if(path.isAbsolute(relative)||relative.startsWith('../')||relative==='..'||!relative)throw Error('OUTPUT_OUTSIDE_WORKSPACE');
 if(await fs.stat(path.join(base,'Construccion/Sprints/S12/Evidencias/S12-P05-HASHES.json')).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))throw Error('FROZEN_P05_REFUSE_BEFORE_WRITE');
 const parts=relative.split('/');
 const evidence=parts.slice(0,4).join('/')==='Construccion/Sprints/S12/Evidencias'&&/^S12-P05-[A-Za-z0-9_.-]+$/.test(parts[4]??'');
 const runtime=parts.slice(0,3).join('/')==='Caudelyx/servidor/.runtime'&&/^s12-p05-[a-f0-9]{24}$/.test(parts[3]??'');
 if(!evidence&&!runtime)throw Error('PROTECTED_OR_UNREGISTERED_OUTPUT');
 let cursor=base;for(const segment of parts){cursor=path.join(cursor,segment);try{const st=await fs.lstat(cursor);if(st.isSymbolicLink())throw Error('LINKED_OUTPUT_REFUSED');if(await fs.realpath(cursor)!==cursor)throw Error('ALIASED_OUTPUT_REFUSED');}catch(error){if(error.code!=='ENOENT')throw error;}}
 return p;
}
export async function writeOwn(target,data,root=projectRoot,options={}){await assertWritable(target,root);await fs.writeFile(target,data,options);}
export async function appendOwn(target,data,root=projectRoot){await assertWritable(target,root);await fs.appendFile(target,data);}
export async function mkdirOwn(target,root=projectRoot){await assertWritable(target,root);await fs.mkdir(target,{recursive:true});}
