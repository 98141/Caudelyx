import {join} from 'node:path';
import {Database} from '../../src/shared/database.js';
import {RestoreController} from '../../src/shared/restore.js';
import {Sessions} from '../../src/modules/sessions/service.js';
import {SyntheticMessaging} from '../../src/modules/messaging/service.js';
import {IdentityService} from '../../src/modules/identity/service.js';
import {PasswordHasher} from '../../src/modules/identity/password.js';
import {attachRuntime} from '../../src/shared/runtime.js';
import type {SyntheticKeys} from '../../src/shared/keys.js';
import type {Config} from '../../src/shared/config.js';
let database:Database|undefined,identity:IdentityService|undefined;
process.on('message',(input:Record<string,unknown>)=>{void(async()=>{
  try{
    if(input['type']==='initialize'){
      const uri=String(input['uri']),name=String(input['name']),url=new URL(uri);
      if(url.hostname!=='127.0.0.1'||!url.port||['27017','27181'].includes(url.port)||url.searchParams.get('replicaSet')!=='caudelyx-manual'||url.username||url.password||name!=='caudelyx_s05_p02_d4c6e1a223104e58b0c50202')throw Error('Unknown peer profile');
      const serialized=input['keys'] as Record<string,string>,keys={version:1,mail:Buffer.from(serialized['mail']!,'base64'),totp:Buffer.from(serialized['totp']!,'base64'),journal:Buffer.from(serialized['journal']!,'base64'),cursor:Buffer.from(serialized['cursor']!,'base64')} as SyntheticKeys,now=()=>Number(input['now']);
      database=new Database(uri,name);await database.connect();const restore=new RestoreController(database,join(String(input['folder']),'gate.json'),keys.journal);await restore.initialize();
      const sessions=new Sessions(database,now);identity=new IdentityService(database,sessions,new SyntheticMessaging(database,keys.mail,now),new PasswordHasher(),()=>restore.isOpen(),now);await identity.initialize();await attachRuntime(identity,keys,input['config'] as Config);process.send?.({type:'ready',pid:process.pid});
    }else if(input['type']==='execute'){
      const context=await identity!.sessions.find(String(input['token']),'TENANT');if(!context)throw Error('Own peer session unavailable');
      const result=await identity!.operations!.mutate(context,String(input['operation']),String(input['organizationId']),input['payload'],input['key'],String(input['etag']));process.send?.({type:'result',status:result.status,data:result.data,pid:process.pid});
    }else if(input['type']==='stop'){await database?.close();process.disconnect();}
  }catch(e){process.send?.({type:'error',status:(e as {status?:number}).status??503,code:(e as {code?:string}).code??'OWN_PEER_ERROR',pid:process.pid});}
})();});
