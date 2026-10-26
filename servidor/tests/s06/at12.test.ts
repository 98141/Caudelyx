/* eslint-disable security/detect-object-injection, security/detect-non-literal-fs-filename -- Registered synthetic fixture, fixed output and enumerated event metadata. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {BSON,type CommandStartedEvent,type CommandSucceededEvent,type Document} from 'mongodb';
import {s06Profile} from './profile.js';
import {setup} from './fixture.js';
import {Database} from '../../src/shared/database.js';
import {RestoreController} from '../../src/shared/restore.js';
import {Sessions} from '../../src/modules/sessions/service.js';
import {IdentityService} from '../../src/modules/identity/service.js';
import {PasswordHasher} from '../../src/modules/identity/password.js';
import {SyntheticMessaging} from '../../src/modules/messaging/service.js';
import {attachRuntime} from '../../src/shared/runtime.js';
import {evidenceMetrics} from '../../src/modules/lending/evidence-v2.js';
import {today} from '../../src/modules/finance/service.js';
import {head,lendingEvidenceMatches} from '../../src/modules/lending/integrity.js';
const H=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const eventId=(org:string,actor:string,key:string)=>{const h=H([org,actor,'RECEIPT',key]);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
const fraction=(hex:string)=>parseInt(hex.slice(0,8),16)/0x100000000;
test('S06 AT12 adversarial legacy and same-source HMAC migration',{timeout:1500000},async()=>{
 const focus=process.env['S06_AT12_WIRE_FOCUS']==='1';const group=await s06Profile(),out:Record<string,unknown>={task:'S06-P02',independentReview:false,startedUTC:new Date().toISOString()},file=resolve('../../Construccion/Sprints/S06/Evidencias/S06-P02-AT12'+(focus?'-HMAC-WIRE':'')+'.json');let peer:Database|undefined;
 const save=async()=>await writeFile(file,JSON.stringify(out,null,2)+'\n');
 try{
  const f=await setup(group,{legacy:true}),l=await f.loan({principal:'10000000.00',rate:{type:'EFFECTIVE',unit:'MONTH',value:'0.000000000000'}});await f.disburse(l);const http=await f.https();http.client.cookies.set('__Host-caudelyx-session',f.a.issued.token);await http.client.refreshCsrf();
  const tree=async(db=f.database)=>(await db.db.collection('lending_merkle_orgs').findOne({_id:f.org as never}))!['root'] as {height:number;count:number};
  const measure=async(label:string,db:Database,client:typeof http.client)=>{
   const samples=[];for(let i=0;i<20;i++){
    const wire={commands:0,requestBytes:0,responseBytes:0,failures:0,transactionStarts:0,commits:0,aborts:0,domainWrites:0},writes=['insert','update','delete','findAndModify'],collections=new Set(['loan_positions','loan_installments','loan_events','payments','cash_custody','financial_journals','lending_merkle_nodes','lending_domain_state','financial_evidence_head']);
    const started=(e:CommandStartedEvent)=>{wire.commands++;wire.requestBytes+=BSON.calculateObjectSize(e.command);if(e.command['startTransaction'])wire.transactionStarts++;if(e.commandName==='commitTransaction')wire.commits++;if(e.commandName==='abortTransaction')wire.aborts++;if(writes.includes(e.commandName)&&collections.has(String(e.command[e.commandName])))wire.domainWrites++;};
    const succeeded=(e:CommandSucceededEvent)=>{wire.responseBytes+=BSON.calculateObjectSize(e.reply as Document);};const failed=()=>{wire.failures++;};
    Reflect.set(db.client,'monitorCommands',true);db.client.on('commandStarted',started);db.client.on('commandSucceeded',succeeded);db.client.on('commandFailed',failed);const docs=evidenceMetrics.documentReads,nodes=evidenceMetrics.indexNodesRead,bytes=evidenceMetrics.hashBytes,start=performance.now();
    try{const r=await client.call('GET',`/api/v1/organizations/${f.org}/loan-operations/book`);assert.equal(r.status,200);assert.ok(wire.commands>0);assert.equal(wire.domainWrites,0);samples.push({status:r.status,ms:performance.now()-start,documentReads:evidenceMetrics.documentReads-docs,indexNodes:evidenceMetrics.indexNodesRead-nodes,hashBytes:evidenceMetrics.hashBytes-bytes,wire,retries:Math.max(0,wire.transactionStarts-wire.commits)});}finally{db.client.removeListener('commandStarted',started);db.client.removeListener('commandSucceeded',succeeded);db.client.removeListener('commandFailed',failed);}
   }const sorted=samples.map(x=>x.ms).sort((a,b)=>a-b),result={label,tree:await tree(db),successfulReads:20,p50:sorted[9],p95:sorted[18],samples};out[label]=result;await save();return result;
  };
  evidenceMetrics.captureOrganizations=true;await measure('legacyNormal',f.database,http.client);
  const existing=await f.ops.events.findOne({kind:'DISBURSE'}),half=fraction(existing!._id.replace(/-/g,''))<0.5?0.5:0;const bins=150,ground:string[]=[],actor=f.a.issued.context.subjectId!,start=performance.now();let tries=0;
  for(let i=0;i<(focus?0:bins);i++)for(;;){tries++;const key=randomUUID(),id=eventId(f.org,actor,key),priority=H('loan_events|P|'+id);if(fraction(id.replace(/-/g,''))>=half+i/(bins*2)&&fraction(id.replace(/-/g,''))<half+(i+1)/(bins*2)&&fraction(priority)>=i/bins&&fraction(priority)<(i+1)/bins){ground.push(key);break;}}
  out['offlineGrinding']={tries,keys:ground.length,ms:performance.now()-start,formula:'public SHA256 of original event identity and JSON primary key, no priority secret'};await save();
  const trace:unknown[]=[],failures:unknown[]=[];let sequence=0;
  const receipt=async(key:string)=>{if(sequence%15===0)f.clock.value+=60000;sequence++;const pos=await f.position(l.id),account=await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,f.account),cmd=await f.make({kind:'RECEIPT',borrowerId:l.borrowerId,destinationAccountId:f.account,destinationAccountETag:account.etag!,receivedAmount:'0.01',targets:[{loanId:l.id,positionETag:pos.etag!,amount:'0.01',mode:'REGULAR'}],excessDisposition:'CREDIT',receiptReference:'SYN-AT12-'+sequence,effectiveDate:today(f.now()),supportReference:'SYN-AT12'},key as ReturnType<typeof randomUUID>);await f.proof(f.a,cmd.purpose,{organizationId:f.org,idempotencyKey:key,payload:cmd.payload,expectedETag:cmd.etag},cmd.id);http.client.cookies.set('__Host-caudelyx-session',f.a.issued.token);await http.client.refreshCsrf();return await http.client.call('POST',`/api/v1/organizations/${f.org}/loan-operations/receipts`,cmd.payload,{'Idempotency-Key':key,'If-Match':cmd.etag});};
  for(const key of ground){const r=await receipt(key),root=await tree();trace.push({n:sequence,status:r.status,height:root.height,count:root.count});if(r.status!==201){failures.push({phase:'ground',at:sequence,status:r.status,body:r.body});break;}if(root.height===128)break;}
  for(let i=0;!focus&&(await tree()).height<128&&i<150;i++){try{const r=await receipt(randomUUID());if(r.status!==201)failures.push({phase:'random',at:sequence,status:r.status,body:r.body});}catch(e){failures.push({phase:'randomPreparation',error:String(e)});}trace.push({n:sequence,...await tree()});}
  if(focus)for(let i=0;i<3;i++)assert.equal((await receipt(randomUUID())).status,201);out['heightTrace']=trace;out['rejectedWrites']=failures;await save();if(!focus)assert.ok((await tree()).height>=120&&(await tree()).height<=128,'Record the actual adversarial height; height128 has a separate preserved R12 witness');await measure(focus?'legacyBeforeHmac':'legacyAdversarial',f.database,http.client);assert.equal(await lendingEvidenceMatches(f.database,(await head(f.database))!),true);await f.restore.flush();
  const names=['loan_events','loan_applications','loan_accruals','loan_positions','loan_installments','financial_journals'],capture=async(db:Database)=>Object.fromEntries(await Promise.all(names.map(async c=>[c,H(BSON.EJSON.stringify(await db.db.collection(c).find().sort({_id:1}).toArray(),{relaxed:false}))]))),before=await capture(f.database);
  peer=new Database(group.uri,group.names[0]!);Reflect.set(peer.client,'monitorCommands',true);await peer.connect();const priority=randomBytes(32),restore=new RestoreController(peer,f.restore.gatePath,f.keys.journal,priority);await restore.initialize();assert.equal(restore.isOpen(),true);out['sourceHashesBefore']=before;out['sourceHashesAfter']=await capture(peer);assert.deepEqual(out['sourceHashesAfter'],before);out['sameSourceBytesPreserved']=true;assert.ok((await tree(peer)).height<128);
  const keys={...f.keys,version:2 as const,priority},sessions=new Sessions(peer,f.now),identity=new IdentityService(peer,sessions,new SyntheticMessaging(peer,keys.mail,f.now),new PasswordHasher(),()=>restore.isOpen(),f.now);await identity.initialize();await attachRuntime(identity,keys,f.config);const upgraded=await(f.https as unknown as (client:boolean,identity:IdentityService)=>ReturnType<typeof f.https>)(false,identity);upgraded.client.cookies.set('__Host-caudelyx-session',f.a.issued.token);await upgraded.client.refreshCsrf();await measure('hmacSameDocuments',peer,upgraded.client);assert.equal(await lendingEvidenceMatches(peer,(await head(peer))!),true);out['sameSourceBytesPreserved']=true;out['status']='PASS';
 }catch(e){out['status']='FAIL';out['error']=String(e);throw e;}finally{evidenceMetrics.captureOrganizations=false;out['endedUTC']=new Date().toISOString();await save();await peer?.close();await group.dispose();}
});
