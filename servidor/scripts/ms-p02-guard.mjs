/* eslint-disable security/detect-non-literal-fs-filename -- Each target must equal an exact registered file; all ancestors and existing target reject symbolic links before writes. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
export const evidence=path.join(root,'Construccion/Sprints/MODO-SIMPLE/Evidencias');
export async function assertWritable(filename){
 const target=path.resolve(filename);
 if(await fs.stat(path.join(evidence,'MS-P02-HASHES.json')).then(()=>true,e=>{if(e.code!=='ENOENT')throw e;return false;}))throw Error('FROZEN_MS_P02_NO_WRITES');
 const input=JSON.parse(await fs.readFile(path.join(evidence,'MS-P02-INPUTS.json'),'utf8'));
 const allowed=new Set([...input.reservedPaths,...(input.compiledPaths??[])].map(p=>path.resolve(root,p).toLowerCase()));
 if(!allowed.has(target.toLowerCase()))throw Error('UNRESERVED_MS_P02_PATH');
 try{if((await fs.lstat(target)).isSymbolicLink())throw Error('LINKED_MS_PATH');}catch(e){if(e.code!=='ENOENT')throw e;}
 for(let cursor=path.dirname(target);cursor!==root;cursor=path.dirname(cursor)){
  if(!cursor.startsWith(root+path.sep))throw Error('OUTSIDE_MS_WORKSPACE');
  try{if((await fs.lstat(cursor)).isSymbolicLink())throw Error('LINKED_MS_PATH');}catch(e){if(e.code!=='ENOENT')throw e;}
 }
}
export async function writeOwn(filename,value){await assertWritable(filename);await fs.writeFile(filename,value);}
