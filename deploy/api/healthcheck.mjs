import {readFile} from 'node:fs/promises';
import {request} from 'node:https';
// No cookies, CSRF contexts or expiration sweeps. Endpoints are internal only.
const kind=process.argv[2]??'ready';
if(!['live','ready'].includes(kind))process.exit(1);
try{
 const ca=await readFile('/run/tls/ca.pem');
 const ok=await new Promise(resolve=>{
  const req=request({hostname:'127.0.0.1',port:4001,path:'/internal/health/'+kind,servername:'api',ca,rejectUnauthorized:true,timeout:3000},res=>{res.resume();res.once('end',()=>resolve(res.statusCode===200));});
  req.on('error',()=>resolve(false));req.on('timeout',()=>req.destroy());req.end();
 });process.exitCode=ok?0:1;
}catch{process.exitCode=1;}
