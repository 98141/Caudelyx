/* eslint-disable security/detect-non-literal-fs-filename -- Exact owned group inventory checked before every harness write. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {root,assertWritable as exact} from './ms-p02-guard.mjs';
export const projectRoot=root;
const log=path.join(root,'Construccion/Sprints/MODO-SIMPLE/Evidencias/MS-P02-RESOURCES.jsonl');
export async function assertWritable(target){
 const p=path.resolve(target);if(p===log)return await exact(p);
 await exact(log);
 const rows=(await fs.readFile(log,'utf8')).trim().split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s));
 const reservation=rows.find(r=>r.task==='MS-P02'&&r.event==='reserved-before-create'&&r.ownerPid===process.pid&&typeof r.folder==='string'&&(p===r.folder||p.startsWith(r.folder+path.sep)));
 const runtime=path.join(root,'Caudelyx/servidor/.runtime');
 if(!reservation||path.dirname(reservation.folder)!==runtime||!/^ms-p02-[a-f0-9]{24}$/.test(path.basename(reservation.folder))||rows.some(r=>r.groupId===reservation.groupId&&r.event==='cleanup-complete'))throw Error('UNREGISTERED_MS_NATIVE_RESOURCE');
 for(let cursor=p;cursor!==root;cursor=path.dirname(cursor)){if(!cursor.startsWith(root+path.sep))throw Error('OUTSIDE_MS_RESOURCE');try{const st=await fs.lstat(cursor);if(st.isSymbolicLink()||await fs.realpath(cursor)!==cursor)throw Error('LINKED_MS_RESOURCE');}catch(e){if(e.code!=='ENOENT')throw e;}}
 return p;
}
export async function writeOwn(target,data,_root=projectRoot,options={}){void _root;await assertWritable(target);await fs.writeFile(target,data,options);}
export async function appendOwn(target,data){await assertWritable(target);await fs.appendFile(target,data);}
export async function mkdirOwn(target){await assertWritable(target);await fs.mkdir(target,{recursive:true});}
