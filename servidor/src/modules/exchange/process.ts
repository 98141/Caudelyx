/* eslint-disable security/detect-object-injection -- Environment names are a fixed operator allowlist; no HTTP keys or credentials reach the child. */
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {AppError} from '../../shared/errors.js';
import type {Plan,Scope,Mode,SnapshotData} from './models.js';
interface Metrics {peakRSS:number;rss:number;durationMs:number}
type Input={kind:'PARSE';bytes:Buffer;scope:Scope;mode:Mode;namespace:string}|{kind:'EXPORT';snapshot:SnapshotData;format:string};
export async function isolated<T extends Plan|Buffer>(input:Input,authorized:()=>Promise<void>):Promise<{value:T;metrics:Metrics}>{
 await authorized();const nonce=randomUUID(),kind=input.kind==='PARSE'?'FILE':'REPORT',deadline=input.kind==='PARSE'?10000:60000;
 const env=Object.fromEntries(['SystemRoot','SYSTEMROOT','TEMP','TMP','WINDIR'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]!]));
 const child=fork(fileURLToPath(new URL('./worker.js',import.meta.url)),[],{windowsHide:true,serialization:'advanced',execArgv:['--max-old-space-size='+(input.kind==='PARSE'?'128':'320')],env,stdio:['ignore','ignore','ignore','ipc']});
 const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));let timer:ReturnType<typeof setTimeout>|undefined,poll:ReturnType<typeof setInterval>|undefined,busy=false;
 try{
  const result=await new Promise<{value:T;metrics:Metrics}>((resolve,reject)=>{
   child.once('error',reject);child.once('exit',()=>reject(new AppError(503,kind+'_BUDGET_EXCEEDED')));
   child.once('message',(raw:unknown)=>{const r=raw as {nonce:string;ok:boolean;value:T;code:string;status:number;metrics:Metrics};if(r.nonce!==nonce)return reject(new AppError(503,'INTEGRITY_MISMATCH'));if(!r.ok)return reject(new AppError(r.status,r.code));resolve({value:r.value,metrics:r.metrics});});
   timer=setTimeout(()=>reject(new AppError(503,kind+'_BUDGET_EXCEEDED')),deadline);
   poll=setInterval(()=>{if(busy)return;busy=true;authorized().catch(reject).finally(()=>{busy=false;});},250);
   child.send({...input,nonce});
  });await authorized();return result;
 }finally{clearTimeout(timer);clearInterval(poll);if(child.exitCode===null&&!child.killed)child.kill();await exited;}
}
