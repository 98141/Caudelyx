import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {request} from 'node:https';
import {connect} from 'node:tls';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import type {fundedSetup} from './p04-fixture.js';
import {password} from './p04-fixture.js';
import {evidenceDirectory} from './p04-profile.js';
import {FrozenContract} from '../../src/shared/contract.js';
import {lendingContract} from '../../src/modules/lending/contract.js';
type F=Awaited<ReturnType<typeof fundedSetup>>;
async function rawCall(port:number,cert:Buffer,method:string,path:string,bytes:Buffer,headers:Record<string,string>){
  return await new Promise<{status:number;headers:import('node:http').IncomingHttpHeaders;raw:string;body:unknown}>((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,servername:'localhost',ca:cert,method,path,headers:{Host:'localhost:47231',...(bytes.length?{'Content-Type':'application/json','Content-Length':String(bytes.length)}:{}),...headers}},res=>{const chunks:Buffer[]=[];res.on('data',x=>chunks.push(Buffer.from(x)));res.on('end',()=>{const raw=Buffer.concat(chunks).toString('utf8');try{resolve({status:res.statusCode??0,headers:res.headers,raw,body:raw?JSON.parse(raw):null});}catch(e){reject(e);}});});req.on('error',reject);req.end(bytes);
  });
}
async function wire(port:number,cert:Buffer,path:string,cookie:string,framing:'length'|'chunked'|'missing',method='GET'){
  return await new Promise<string>((resolve,reject)=>{
    const socket=connect({host:'127.0.0.1',port,servername:'localhost',ca:cert}),chunks:Buffer[]=[];socket.setTimeout(10000,()=>socket.destroy(Error('Own TLS timeout')));socket.on('error',reject);socket.on('data',x=>chunks.push(x));socket.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));socket.on('secureConnect',()=>socket.write(`${method} ${path} HTTP/1.1\r\nHost: localhost:47231\r\nCookie: ${cookie}\r\nContent-Type: application/json\r\nConnection: close\r\n${framing==='length'?'Content-Length: 2\r\n':framing==='chunked'?'Transfer-Encoding: chunked\r\n':''}\r\n${framing==='chunked'?'2\r\n{}\r\n0\r\n\r\n':'{}'}`));
  });
}
function catalogue(){
  const fields=Array.from({length:10},(_,k)=>({key:'field_'+k,label:'ñ'.repeat(80),type:'ENUM',deprecated:false,options:Array.from({length:10},(_,j)=>({code:'O'+j,label:'ñ'.repeat(80)}))})),body={fields,changeReason:'Catálogo sintético de frontera'};
  assert.ok(Buffer.byteLength(JSON.stringify(body))>16384);lendingContract().validate('publishBorrowerSchema',body);return body;
}
export async function transportChecks(t:TestContext,f:F){
  const https=await f.https(),proxy=await f.proxy(https),base=`/api/v1/organizations/${f.org}`,reports:Record<string,unknown>[]=[];
  const headers=()=>({Cookie:'__Host-caudelyx-session='+f.a.issued.token,Origin:f.config.tenantOrigin,'X-CSRF-Token':f.a.issued.csrf});
  await t.test('AT01/09/13:actual HTTPS preview/R-bound disbursement, closed DTOs and finance source overlay',async()=>{
    const l=await f.loan({principal:'1000.00'}),key=randomUUID(),book=await rawCall(https.port,https.cert,'GET',base+'/loan-operations/book',Buffer.alloc(0),headers());assert.equal(book.status,200);
    const intent=await f.fundingRequest(l),preview=await rawCall(https.port,https.cert,'POST',base+'/loan-operation-previews',Buffer.from(JSON.stringify({executionKey:key,expectedBookETag:book.headers.etag!,request:intent})),headers());assert.equal(preview.status,200);
    const data=(preview.body as {data:{previewToken:string}}).data,payload={previewToken:data.previewToken,request:intent};await f.proof(f.a,'LOAN_DISBURSE',{organizationId:f.org,idempotencyKey:key,payload,expectedETag:book.headers.etag!},l.id);
    const committed=await rawCall(https.port,https.cert,'POST',base+'/loan-operations/disbursements',Buffer.from(JSON.stringify(payload)),{...headers(),'Idempotency-Key':key,'If-Match':book.headers.etag!});assert.equal(committed.status,201);
    const journal=(committed.body as {data:{event:{journalId:string}}}).data.event.journalId,result=await rawCall(https.port,https.cert,'GET',base+'/financial/journal-entries/'+journal,Buffer.alloc(0),headers());assert.equal(result.status,200);assert.equal((result.body as {data:{source:{type:string}}}).data.source.type,'LOAN_OPERATION');
    const list=await rawCall(https.port,https.cert,'GET',base+'/loan-operations/positions',Buffer.alloc(0),headers());assert.equal(list.status,200);const row=(list.body as {data:{items:{borrower:{code:string;name:string};originalPrincipal:string;statusLabel:string}[]}}).data.items[0]!;assert.ok(row.borrower.code&&row.borrower.name);assert.equal(row.originalPrincipal,'1000.00');assert.equal(row.statusLabel,'Activo');
  });
  await t.test('AT12/H04: real HTTPS length/chunked API/proxy422 versus missing framing400; HEAD empty',async()=>{
    for(const endpoint of [https,proxy])for(const framing of ['length','chunked','missing'] as const){
      const raw=await wire(endpoint.port,endpoint.cert,base+'/loan-operations/policy',headers().Cookie,framing),status=Number(/^HTTP\/1\.1 (\d+)/.exec(raw)?.[1]),body=raw.split('\r\n\r\n')[1]??'';
      reports.push({layer:endpoint===https?'API':'OWN_HTTPS_PROXY',framing,status,contentType:/content-type: ([^\r]+)/i.exec(raw)?.[1]??null,bodyPrefix:body.slice(0,240)});
      if(framing==='missing'){assert.equal(status,400);}else{assert.equal(status,422);assert.match(raw,/INPUT_INVALID/);assert.match(raw,/application\/json/);}
    }
    const raw=await wire(https.port,https.cert,base+'/loan-operations/policy',headers().Cookie,'length','HEAD');assert.match(raw,/HTTP\/1.1 422/);assert.equal(raw.split('\r\n\r\n')[1],'');
  });
  await t.test('AT12/H03: valid10-field multibyte catalogue body65536, A32 wrapper98304, defaults unchanged',async()=>{
    const payload=catalogue(),serialized=JSON.stringify(payload),businessBody=Buffer.from(serialized+' '.repeat(65536-Buffer.byteLength(serialized))),key=randomUUID(),current=await f.read('getCurrentBorrowerSchema'),intent={purpose:'BORROWER_SCHEMA_PUBLISH',password,resourceId:null,command:{organizationId:f.org,idempotencyKey:key,payload,expectedETag:current.etag!}},source=JSON.stringify(intent);
    assert.ok(Buffer.byteLength(source)<98304);
    const accepted=await rawCall(https.port,https.cert,'POST','/api/v1/auth/reauthenticate',Buffer.from(source+' '.repeat(98304-Buffer.byteLength(source))),headers());assert.equal(accepted.status,200);
    const tooLarge=await rawCall(https.port,https.cert,'POST','/api/v1/auth/reauthenticate',Buffer.from(source+' '.repeat(98305-Buffer.byteLength(source))),headers());assert.equal(tooLarge.status,413);assert.match(tooLarge.raw,/INPUT_TOO_LARGE/);
    const nested={...intent,command:{...intent.command,payload:{padding:'x'.repeat(65537-14)}}};assert.equal(Buffer.byteLength(JSON.stringify(nested.command.payload)),65537);const nestedResult=await rawCall(https.port,https.cert,'POST','/api/v1/auth/reauthenticate',Buffer.from(JSON.stringify(nested)),headers());assert.equal(nestedResult.status,413);
    const nestedAt={...nested,command:{...nested.command,payload:{padding:'x'.repeat(65536-14)}}};const nestedAtResult=await rawCall(https.port,https.cert,'POST','/api/v1/auth/reauthenticate',Buffer.from(JSON.stringify(nestedAt)),headers());assert.equal(nestedAtResult.status,422,'Size accepted, deliberately invalid schema rejected');
    const other=await rawCall(https.port,https.cert,'POST','/api/v1/auth/reauthenticate',Buffer.from(JSON.stringify({purpose:'MFA_DISABLE',password})+' '.repeat(17000)),headers());assert.equal(other.status,400);
    const webPath='/api/v1'+new FrozenContract().operations.get('A26')!.path;
    const webAt=await rawCall(https.port,https.cert,'POST',webPath,Buffer.from('{}'+' '.repeat(65534)),headers());assert.equal(webAt.status,422,'64KiB parsed then invalid WebAuthn schema');
    const webOver=await rawCall(https.port,https.cert,'POST',webPath,Buffer.from('{}'+' '.repeat(65535)),headers());assert.equal(webOver.status,400,'Existing WebAuthn size error unchanged');
    reports.push({webAuthnBytes:65536,webAuthnSchemaStatus:webAt.status,webAuthnOverBytes:65537,webAuthnOverStatus:webOver.status});
    await f.proof(f.a,'BORROWER_SCHEMA_PUBLISH',intent.command);
    const result=await rawCall(https.port,https.cert,'POST',base+'/borrower-field-schemas',businessBody,{...headers(),'If-Match':current.etag!,'Idempotency-Key':key});assert.equal(result.status,200);
    const over=await rawCall(https.port,https.cert,'POST',base+'/borrower-field-schemas',Buffer.concat([businessBody,Buffer.from(' ')]),{...headers(),'If-Match':current.etag!,'Idempotency-Key':key});assert.equal(over.status,413);
    reports.push({businessUTF8Bytes:65536,characters:businessBody.toString('utf8').length,bodyPadding:'Valid JSON trailing whitespace; actual catalogue within10-field S4 limit and >16KiB',businessStatus:result.status,overStatus:over.status,a32Bytes:98304,a32Status:accepted.status,a32OverStatus:tooLarge.status,nested65536SchemaStatus:nestedAtResult.status,nested65537Status:nestedResult.status,otherAuthOver16KiB:other.status});
  });
  await t.test('AT09/12: UTF8 invalid, wrong method/query, CSRF and unavailable envelopes',async()=>{
    const invalid=await rawCall(https.port,https.cert,'POST',base+'/loan-operation-previews',Buffer.from([0xc3,0x28]),headers());assert.equal(invalid.status,422);
    const method=await rawCall(https.port,https.cert,'DELETE',base+'/loan-operations/book',Buffer.from('{}'),headers());assert.equal(method.status,405);
    const query=await rawCall(https.port,https.cert,'GET',base+'/loan-operations/book?extra=true',Buffer.alloc(0),headers());assert.equal(query.status,422);
    const csrf=await rawCall(https.port,https.cert,'POST',base+'/loan-operation-previews',Buffer.from('{}'),{...headers(),'X-CSRF-Token':'wrong'});assert.equal(csrf.status,400);assert.match(csrf.raw,/CSRF_INVALID/);
    f.clock.open=false;try{const closed=await rawCall(https.port,https.cert,'GET',base+'/loan-operations/book',Buffer.alloc(0),headers());assert.equal(closed.status,503);assert.match(closed.raw,/SERVICE_UNAVAILABLE/);}finally{f.clock.open=true;}
  });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed S05 root or exclusively created replay directory with a validated24-hex name.
  await writeFile(evidenceDirectory+'/S05-P04-CHECKS.json',JSON.stringify({status:'EXECUTED',results:reports,diagnosis:'Missing Content-Length/Transfer-Encoding makes JSON bytes a malformed next HTTP request. Native HTTP/1.1 parser returns400 before Express. Valid framing reaches application and returns422 JSON, including an owned reverse proxy. Not a Vite/manual-service test.'},null,2));
}
