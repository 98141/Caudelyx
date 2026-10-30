/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection -- Fixed synthetic key allowlist and own registered test control directory, parent PID and database verified before access. */
import {readFile,realpath} from 'node:fs/promises';
import {resolve,dirname,join,basename} from 'node:path';
import {Database} from '../../src/shared/database.js';
import {Sessions} from '../../src/modules/sessions/service.js';
import {SyntheticMessaging} from '../../src/modules/messaging/service.js';
import {IdentityService} from '../../src/modules/identity/service.js';
import {PasswordHasher} from '../../src/modules/identity/password.js';
import {RestoreController} from '../../src/shared/restore.js';
import {attachRuntime} from '../../src/shared/runtime.js';
import {assertOwnUri} from './profile.js';
import type {SyntheticKeys} from '../../src/shared/keys.js';
import {ProjectionRuntime} from '../../src/modules/reporting/projection/service.js';
import type {Data} from '../../src/modules/reporting/models.js';
let database:Database|undefined,identity:IdentityService|undefined;let phase='MESSAGE';
process.on('message',(input:Data)=>{void(async()=>{
 if(input['type']==='initialize'){
  const uri=String(input['uri']),name=String(input['name']),folder=resolve(String(input['folder']));assertOwnUri(uri);
  if(!/^caudelyx_s08_p02_[a-f0-9]{24}$/.test(name)||dirname(folder)!==resolve('.runtime')||await realpath(folder)!==folder||!/^s10-p04-[a-f0-9]{24}$/.test(basename(folder)))throw Error('Unowned restart profile');
  const owner=JSON.parse(await readFile(join(folder,'owner.json'),'utf8')) as {pid:number;names:string[]};if(owner.pid!==process.ppid||!owner.names.includes(name))throw Error('Unowned restart group');
  const encoded=input['keys'] as Record<string,{data:number[]}|number>,keys={version:1} as SyntheticKeys;
  for(const key of ['journal','cursor','mail','totp','priority'] as const){const v=encoded[key] as {data:number[]}|undefined;if(v)keys[key]=Buffer.from(v.data);}
  database=new Database(uri,name);await database.connect();const now=()=>Number(input['now']);
  const restore=new RestoreController(database,join(folder,'gate.json'),keys.journal,keys.priority,keys.cursor);phase='RESTORE';await restore.initialize();if(!restore.isOpen())throw Error('Own restart gate is closed');
  const sessions=new Sessions(database,now),messages=new SyntheticMessaging(database,keys.mail,now);
  identity=new IdentityService(database,sessions,messages,new PasswordHasher(),()=>restore.isOpen(),now);phase='IDENTITY';await identity.initialize();
  phase='RUNTIME';await attachRuntime(identity,keys,{mongoUri:uri,databaseName:name,port:0,tenantOrigin:'https://localhost:0',platformOrigin:'https://platform.localhost:0'});
  phase='PREPARE';await identity.obligations!.prepareOwned(async()=>owner.pid===process.ppid&&owner.names.includes(name));
  await identity.wealth!.prepareOwned(async()=>owner.pid===process.ppid&&owner.names.includes(name));
  phase='MANAGEMENT_OBSERVER';await identity.obligations!.activateOwned(async()=>owner.pid===process.ppid&&owner.names.includes(name));
  if(input['enableBusiness']===true){phase='REPORTING_OBSERVER';const projection=await ProjectionRuntime.createOwned(identity,keys.cursor,async()=>owner.pid===process.ppid&&owner.names.includes(name));identity.reporting!.projection=projection;}
  process.send?.({type:'ready'});return;
 }
 if(input['type']==='execute'){
  if(!identity||!database)throw Error('Worker not initialized');const operation=String(input['operation']);
  const contract=(await import('../../src/modules/wealth/contract.js')).wealthContract(),definition=contract.operations.get(operation);if(!definition)throw Error('Unknown closed worker operation');
  const context=await identity.sessions.findPersonal(String(input['token']));if(!context)throw Error('Worker session unavailable');
  const result=definition.method==='get'?await identity.wealth!.read(context,operation,input['params'] as Record<string,string>,input['query'] as Data??{}):await identity.wealth!.mutate(context,operation,input['payload'],input['params'] as Record<string,string>,String(input['key']),input['expected']===undefined?undefined:String(input['expected']));
  process.send?.({type:'result',...result});return;
 }
 if(input['type']==='stop'){await identity?.obligations?.stop();await database?.close();process.disconnect();}
 })().catch(error=>process.send?.({type:'error',phase,message:error instanceof Error?error.message:'UNKNOWN',code:error instanceof Error&&'code'in error?String(error.code):'WORKER_FAILED'}));});
