/* eslint-disable security/detect-object-injection -- Fixed process environment allowlist; synthetic read-only calculation payload contains no session or credentials. */
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {AppError} from '../../shared/errors.js';
import type {EngineBase,VersionInput,Evaluation,Data} from './models.js';
export async function isolated(base:EngineBase,definition:VersionInput,seed:string,sensitivity:Data|null,authorized:()=>Promise<void>){
 await authorized();const nonce=randomUUID(),env=Object.fromEntries(['SystemRoot','SYSTEMROOT','TEMP','TMP','WINDIR'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]!]));
 const child=fork(fileURLToPath(new URL('./worker.js',import.meta.url)),[],{windowsHide:true,serialization:'advanced',execArgv:['--max-old-space-size=128'],env,stdio:['ignore','ignore','ignore','ipc']});
 const exited=new Promise<void>(resolve=>child.once('close',()=>resolve()));let timer:NodeJS.Timeout|undefined,poll:NodeJS.Timeout|undefined,busy=false;
 try{
  const result=await new Promise<{value:Evaluation;metrics:{peakRSS:number;durationMs:number}}>((resolve,reject)=>{
   child.once('error',reject);child.once('close',()=>reject(new AppError(503,'SIMULATION_BUDGET_EXCEEDED')));
   let proposal:Evaluation|undefined;
   child.on('message',(raw:unknown)=>{
    const r=raw as {nonce:string;type:string;ok:boolean;code:string;value:Evaluation;metrics:{peakRSS:number;durationMs:number}};
    if(r.nonce!==nonce)return reject(new AppError(503,'INTEGRITY_MISMATCH'));
    if(!r.ok)return reject(new AppError(r.code==='SIMULATION_SCOPE_TOO_LARGE'?413:503,r.code));
    if(r.type==='PROPOSAL'&&!proposal){proposal=r.value;return;}
    if(r.type!=='FINAL'||!proposal||!Number.isFinite(r.metrics?.peakRSS)||r.metrics.peakRSS>268435456||!Number.isFinite(r.metrics.durationMs)||r.metrics.durationMs>10000)return reject(new AppError(503,'INTEGRITY_MISMATCH'));
    resolve({value:proposal,metrics:r.metrics});
   });
   timer=setTimeout(()=>reject(new AppError(503,'SIMULATION_BUDGET_EXCEEDED')),10000);
   poll=setInterval(()=>{if(busy)return;busy=true;authorized().catch(reject).finally(()=>{busy=false;});},250);
   child.send({nonce,base,definition,seed,sensitivity});
  });await authorized();return{...result,metrics:{...result.metrics,workerPid:child.pid??null}};
 }finally{clearTimeout(timer);clearInterval(poll);if(child.exitCode===null&&!child.killed)child.kill();await exited;}
}
