import express from 'express';
import {TLSSocket} from 'node:tls';
import {Ajv2020} from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import type {IdentityService} from '../identity/service.js';
import type {Config} from '../../shared/config.js';
import {AppError} from '../../shared/errors.js';
import {strictJson} from '../../shared/http.js';
import {exchangeContract} from './contract.js';
import type {ExchangeResult} from './service.js';
import type {Data} from './models.js';
export const isExchangePath=(p:string)=>p.toLowerCase().includes('/exchange-s11/');
const XLSX='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
async function body(req:express.Request){
 if(req.get('Content-Encoding')&&req.get('Content-Encoding')!=='identity')throw new AppError(422,'FILE_TYPE_REJECTED');if(req.get('Content-Type')!==XLSX)throw new AppError(422,'FILE_TYPE_REJECTED');
 const length=req.get('Content-Length');if(length!==undefined&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>5242880))throw new AppError(413,'FILE_LIMIT_EXCEEDED');
 const chunks:Buffer[]=[];let count=0;const timer=setTimeout(()=>req.destroy(new AppError(503,'FILE_BUDGET_EXCEEDED')),10000);
 try{for await(const chunk of req){const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);count+=b.length;if(count>5242880)throw new AppError(413,'FILE_LIMIT_EXCEEDED');chunks.push(b);}if(length!==undefined&&Number(length)!==count)throw new AppError(422,'INPUT_INVALID');return Buffer.concat(chunks);}finally{clearTimeout(timer);}
}
export function exchangeRouter(identity:IdentityService,config:Config){
 const router=express.Router(),contract=exchangeContract(),a=new Ajv2020({strict:false}),json=strictJson();formats.default(a);
 for(const[operation,{path,method,definition}]of contract.operations){
  const parameters=definition.parameters.map(p=>({...p,validate:a.compile({...p.schema,components:contract.document.components})})),consolidated=operation.includes('Consolidated'),upload=operation.startsWith('upload');
  router.all('/api/v1'+path.replace(/\{([^}]+)\}/g,':$1'),async(req,res,next)=>{
   if(req.method.toLowerCase()!==method)return next();
   try{
    if(!(req.socket instanceof TLSSocket)||!req.socket.encrypted||req.headers.host!==new URL(config.tenantOrigin).host)throw new AppError(403,'ACCESS_DENIED');
    await identity.requireOpen('TENANT');const cookies=(req.headers.cookie??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith('__Host-caudelyx-session='));if(cookies.length!==1)throw new AppError(401,'AUTH_INVALID');
    const token=cookies[0]!.slice('__Host-caudelyx-session='.length),context=path.startsWith('/me/')?await identity.sessions.findPersonal(token):await identity.sessions.find(token,'TENANT');if(!context)throw new AppError(401,'AUTH_INVALID');const service=identity.exchange;if(!service)throw new AppError(503,'SERVICE_UNAVAILABLE');
    if(method==='post'){if(req.headers.origin!==config.tenantOrigin||req.headers['sec-fetch-site']==='cross-site')throw new AppError(400,'CSRF_INVALID');identity.sessions.checkCsrf(context,req.get('X-CSRF-Token'));}
    if(Object.keys(req.query).some(k=>!parameters.some(p=>p.in==='query'&&p.name===k)))throw new AppError(422,'INPUT_INVALID');
    for(const p of parameters){const raw=p.in==='path'?req.params[p.name]:p.in==='query'?req.query[p.name]:req.get(p.name);if(raw===undefined){if(p.required)throw new AppError(p.name==='If-Match'?428:422,p.name==='If-Match'?'ETAG_REQUIRED':'INPUT_INVALID');continue;}const value=p.name==='limit'&&typeof raw==='string'&&/^[1-9][0-9]*$/.test(raw)?Number(raw):raw;if(!p.validate(value))throw new AppError(422,'INPUT_INVALID');}
    const params=Object.fromEntries(Object.entries(req.params).map(([k,v])=>{if(typeof v!=='string')throw new AppError(422,'INPUT_INVALID');return[k,v];})),key=req.get('Idempotency-Key')??'',expected=req.get('If-Match');let result:ExchangeResult;
    if(upload){const ticket=await service.beginUpload(context,params,key,expected);try{result=await service.finishUpload(context,ticket,await body(req));}catch(error){await service.abortUpload(ticket,error);throw error;}}
    else{
     if(method==='get'){if(req.headers['transfer-encoding']||Number(req.get('Content-Length')??0)>0)throw new AppError(422,'INPUT_INVALID');}
     else{if(!req.is('application/json')||req.get('Content-Encoding')&&req.get('Content-Encoding')!=='identity')throw new AppError(422,'INPUT_INVALID');await new Promise<void>((resolve,reject)=>json(req,res,error=>error?reject(error):resolve()));contract.validate(operation,req.body);}
     const input=(req.body??{}) as Data;
     if(operation.startsWith('download')){
      if(req.get('Range'))throw new AppError(422,'INPUT_INVALID');const download=await service.download(context,params,key,consolidated,expected);let recorded=false;
      const finish=(completed:boolean)=>{if(recorded)return;recorded=true;void service.finishDownload(context,params,completed,consolidated).catch(()=>{ /* STARTED remains durable; no false completion on failure. */ });};res.once('finish',()=>finish(true));res.once('close',()=>finish(res.writableFinished));
      res.set({'Cache-Control':'no-store, private','Pragma':'no-cache','Content-Type':download.file.mediaType,'Content-Length':String(download.bytes.length),'Content-Disposition':'attachment; filename="'+download.file.filename+'"','X-Content-SHA256':download.file.sha256!,'X-Content-Type-Options':'nosniff'});res.status(200).end(download.bytes);return;
     }
     if(operation.endsWith('ExchangePolicy'))result=await service.policy(context,params,consolidated);
     else if(operation.startsWith('create')&&operation.endsWith('Import'))result=await service.createImport(context,operation,input,params,key);
     else if(operation.startsWith('preview'))result=await service.preparePreview(context,params,key,expected,input);
     else if(operation.startsWith('confirm'))result=await service.confirm(context,params,input,key,expected);
     else if(operation.startsWith('cancel')&&operation.endsWith('Import'))result=await service.cancelImport(context,params,key,expected);
     else if(operation.endsWith('ReportSnapshot'))result=await service.report(context,params,req.query,consolidated);
     else if(operation.endsWith('ReportRows'))result=await service.reportPage(context,params,req.query,consolidated);
     else if(operation.startsWith('create')&&operation.endsWith('Export'))result=await service.createExport(context,params,input,key,consolidated);
     else if(operation.startsWith('cancel')&&operation.endsWith('Export'))result=await service.cancelExport(context,params,key,expected,consolidated);
     else if(operation.endsWith('ExchangeJob'))result=await service.job(context,params,consolidated);
     else if(operation.includes('Import'))result=await service.readImport(context,params,operation,req.query);
     else result=await service.readExport(context,params,operation,req.query,consolidated);
    }
    const response={data:result.data,requestId:res.locals['requestId']};contract.result(operation,result.status,response);if(result.etag)res.set('ETag',result.etag);res.status(result.status).json(response);
   }catch(error){const e=error instanceof AppError?error:new AppError(503,'SERVICE_UNAVAILABLE'),code=contract.document['x-error-codes'].includes(e.code)?e.code:'SERVICE_UNAVAILABLE';if(e.status===429)res.set('Retry-After','60');res.status(code==='SERVICE_UNAVAILABLE'?503:e.status).json({error:{code},requestId:res.locals['requestId']});}
  });
 }
 return router;
}
