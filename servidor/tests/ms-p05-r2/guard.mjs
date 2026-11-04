/* MS-P05-R2 own write guard (Claude, independent review). Synthetic data only.
 * Allowed writes: the exact MS-P05-R2 evidence names reserved in MS-P05-R2-INPUTS.json, and the single
 * .runtime/ms-p04-<24hex> group registered as reserved-before-create by THIS process in MS-P05-R2-RESOURCES.jsonl
 * and not yet cleaned. Everything else (author evidence, frozen harnesses, shared services) is refused. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..');
export const projectRoot=root;
const evidence=path.join(root,'Construccion/Sprints/MODO-SIMPLE/Evidencias');
export const resourcesLog=path.join(evidence,'MS-P05-R2-RESOURCES.jsonl');
const inputs=JSON.parse(await fs.readFile(path.join(evidence,'MS-P05-R2-INPUTS.json'),'utf8'));
const reserved=new Set(inputs.reservedPaths.map(p=>path.join(root,p)));
const runtime=path.join(root,'Caudelyx/servidor/.runtime');
async function unlinked(p){
 for(let cursor=p;cursor!==root;cursor=path.dirname(cursor)){
  if(!cursor.startsWith(root+path.sep))throw Error('OUTSIDE_PROJECT');
  try{const st=await fs.lstat(cursor);if(st.isSymbolicLink()||await fs.realpath(cursor)!==cursor)throw Error('LINKED_PATH');}catch(e){if(e.code!=='ENOENT')throw e;}
 }
}
export async function assertWritable(target){
 const p=path.resolve(target);
 if(reserved.has(p)){await unlinked(p);return p;}
 const rows=(await fs.readFile(resourcesLog,'utf8').catch(e=>{if(e.code==='ENOENT')return'';throw e;})).split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s));
 const group=rows.find(r=>r.task==='MS-P05-R2'&&r.event==='reserved-before-create'&&r.ownerPid===process.pid&&typeof r.folder==='string'&&(p===r.folder||p.startsWith(r.folder+path.sep)));
 if(!group||path.dirname(group.folder)!==runtime||!/^ms-p04-[a-f0-9]{24}$/.test(path.basename(group.folder))||rows.some(r=>r.groupId===group.groupId&&r.event==='cleanup-complete'))throw Error('UNREGISTERED_MS_P05_R2_RESOURCE:'+p);
 await unlinked(p);return p;
}
export async function writeOwn(target,data,_root=projectRoot,options={}){void _root;await assertWritable(target);await fs.writeFile(target,data,options);}
export async function appendOwn(target,data){await assertWritable(target);await fs.appendFile(target,data);}
export async function mkdirOwn(target){await assertWritable(target);await fs.mkdir(target,{recursive:true});}
export async function receipt(record){await appendOwn(resourcesLog,JSON.stringify({at:new Date().toISOString(),task:'MS-P05-R2',...record})+'\n');}
