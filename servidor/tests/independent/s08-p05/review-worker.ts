// S08-P05 own peer worker: copy of tests/s08-p04/worker.ts bound to the reviewer group only.
/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection -- Fixed synthetic key allowlist and own registered test control directory, parent PID and database verified before access. */
import {readFile,realpath} from 'node:fs/promises';
import {resolve,dirname,join,basename} from 'node:path';
import {Database} from '../../../src/shared/database.js';
import {Sessions} from '../../../src/modules/sessions/service.js';
import {SyntheticMessaging} from '../../../src/modules/messaging/service.js';
import {IdentityService} from '../../../src/modules/identity/service.js';
import {PasswordHasher} from '../../../src/modules/identity/password.js';
import {RestoreController} from '../../../src/shared/restore.js';
import {attachRuntime} from '../../../src/shared/runtime.js';
import {assertOwnUri} from './review-profile.js';
import type {SyntheticKeys} from '../../../src/shared/keys.js';
import {ProjectionRuntime} from '../../../src/modules/reporting/projection/service.js';
import type {Data} from '../../../src/modules/reporting/models.js';
let database:Database|undefined,identity:IdentityService|undefined;
process.on('message',(input:Data)=>{void(async()=>{
 if(input['type']==='initialize'){
  const uri=String(input['uri']),name=String(input['name']),folder=resolve(String(input['folder']));assertOwnUri(uri);
  if(!/^caudelyx_s08_p02_a5d08c1f3e7b49d2b86e0f15$/.test(name)||dirname(folder)!==resolve('.runtime')||await realpath(folder)!==folder||!/^s08-p05-a5d08c1f3e7b49d2b86e0f15$/.test(basename(folder)))throw Error('Unowned restart profile');
  const owner=JSON.parse(await readFile(join(folder,'owner.json'),'utf8')) as {pid:number;names:string[]};if(owner.pid!==process.ppid||!owner.names.includes(name))throw Error('Unowned restart group');
  const encoded=input['keys'] as Record<string,{data:number[]}|number>,keys={version:1} as SyntheticKeys;
  for(const key of ['journal','cursor','mail','totp','priority'] as const){const v=encoded[key] as {data:number[]}|undefined;if(v)keys[key]=Buffer.from(v.data);}
  database=new Database(uri,name);await database.connect();const now=()=>Number(input['now']);
  const restore=new RestoreController(database,join(folder,'gate.json'),keys.journal,keys.priority,keys.cursor);await restore.initialize();if(!restore.isOpen())throw Error('Own restart gate is closed');
  const sessions=new Sessions(database,now),messages=new SyntheticMessaging(database,keys.mail,now);
  identity=new IdentityService(database,sessions,messages,new PasswordHasher(),()=>restore.isOpen(),now);await identity.initialize();
  await attachRuntime(identity,keys,{mongoUri:uri,databaseName:name,port:0,tenantOrigin:'https://localhost:0',platformOrigin:'https://platform.localhost:0'});
  const projection=await ProjectionRuntime.createOwned(identity,keys.cursor,async()=>owner.pid===process.ppid&&owner.names.includes(name));identity.reporting!.projection=projection;
  process.send?.({type:'ready'});return;
 }
 if(input['type']==='execute'){
  if(!identity||!database)throw Error('Worker not initialized');const operation=String(input['operation']);
  if(!['getReportingDashboard','listReportingRows','getReportingLoan'].includes(operation))throw Error('Read-only worker operation');
  const context=await identity.sessions.find(String(input['token']),'TENANT');if(!context)throw Error('Worker session unavailable');
  const result=await identity.reporting!.read(context,operation,String(input['org']),input['id']===undefined?undefined:String(input['id']),input['query'] as Data);
  process.send?.({type:'result',...result});return;
 }
 if(input['type']==='stop'){await database?.close();process.disconnect();}
 })().catch(error=>process.send?.({type:'error',code:error instanceof Error&&'code'in error?String(error.code):'WORKER_FAILED'}));});
