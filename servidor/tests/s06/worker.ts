import {Database} from '../../src/shared/database.js';
import {RestoreController} from '../../src/shared/restore.js';
import {Sessions} from '../../src/modules/sessions/service.js';
import {IdentityService} from '../../src/modules/identity/service.js';
import {SyntheticMessaging} from '../../src/modules/messaging/service.js';
import {PasswordHasher} from '../../src/modules/identity/password.js';
import {attachRuntime} from '../../src/shared/runtime.js';
import type {SyntheticKeys} from '../../src/shared/keys.js';
import type {Config} from '../../src/shared/config.js';
import {join,resolve} from 'node:path';
let db:Database|undefined,identity:IdentityService|undefined;
process.on('message',(input:Record<string,unknown>)=>{void(async()=>{
 try{
  if(input['type']==='initialize'){
   const uri=String(input['uri']),name=String(input['name']),folder=String(input['folder']),u=new URL(uri);if(u.hostname!=='127.0.0.1'||!u.port||['27017','27181'].includes(u.port)||u.searchParams.get('replicaSet')!=='caudelyx-manual'||name!=='caudelyx_s06_p02_c6b2026e10a64d42a01c7c80'||resolve(folder)!==resolve('.runtime/s06-p02-c6b2026e10a64d42a01c7c80'))throw Error('Unknown own S06 profile');
   const serialized=input['keys'] as Record<string,string>,keys:SyntheticKeys={version:2,mail:Buffer.from(serialized['mail']!,'base64'),totp:Buffer.from(serialized['totp']!,'base64'),journal:Buffer.from(serialized['journal']!,'base64'),cursor:Buffer.from(serialized['cursor']!,'base64'),priority:Buffer.from(serialized['priority']!,'base64')};db=new Database(uri,name);await db.connect();const restore=new RestoreController(db,join(folder,'gate.json'),keys.journal,keys.priority);await restore.initialize();const now=()=>Number(input['now']),sessions=new Sessions(db,now);identity=new IdentityService(db,sessions,new SyntheticMessaging(db,keys.mail,now),new PasswordHasher(),()=>restore.isOpen(),now);await identity.initialize();await attachRuntime(identity,keys,input['config'] as Config);process.send?.({type:'ready',pid:process.pid});
  }else if(input['type']==='execute'){
   const context=await identity!.sessions.find(String(input['token']),'TENANT');if(!context)throw Error('Own peer invalid context');const result=await identity!.payments!.mutate(context,String(input['operation']),String(input['organizationId']),input['payload'],input['key'],String(input['etag']),String(input['resourceId']));process.send?.({type:'result',status:result.status,pid:process.pid});
  }else if(input['type']==='stop'){await db?.close();process.disconnect();}
 }catch(e){process.send?.({type:'error',status:(e as {status?:number}).status??503,code:(e as {code?:string}).code??'OWN_PEER_ERROR',pid:process.pid});}
})();});
