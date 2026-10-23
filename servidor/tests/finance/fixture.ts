import { randomBytes,randomUUID } from 'node:crypto';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { execFile,spawn, type ChildProcess } from 'node:child_process';
import { createServer as portServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generate } from 'otplib';
import { Database } from '../../src/shared/database.js';
import { RestoreController } from '../../src/shared/restore.js';
import { Sessions } from '../../src/modules/sessions/service.js';
import { IdentityService } from '../../src/modules/identity/service.js';
import { SyntheticMessaging } from '../../src/modules/messaging/service.js';
import { PasswordHasher } from '../../src/modules/identity/password.js';
import { attachRuntime } from '../../src/shared/runtime.js';
import { createApp } from '../../src/app.js';
import { ApiClient } from '../helpers/client.js';
import type { Context } from '../../src/modules/identity/models.js';
import { purposes } from '../../src/modules/finance/service.js';
import { localTestProfile } from '../helpers/local-test-profile.js';

export async function financeFixture() {
  const profile=await localTestProfile(),folder=profile.directory;
  const database=new Database(profile.uri,profile.database);
  const clock={value:Math.floor(Date.now()/30000)*30000+1000};const now=()=>clock.value;
  const keys={version:1 as const,mail:randomBytes(32),totp:randomBytes(32),journal:randomBytes(32),cursor:randomBytes(32)};
  const restore=new RestoreController(database,join(folder,`gate-${database.db.databaseName}.json`),keys.journal);
  const sessions=new Sessions(database,now),messaging=new SyntheticMessaging(database,keys.mail,now);
  const identity=new IdentityService(database,sessions,messaging,new PasswordHasher(),()=>restore.isOpen(),now);
  try {
    await database.connect();await restore.initialize();
    await identity.initialize();const config={mongoUri:'mongodb://localhost:27017/?replicaSet=rs0',databaseName:database.db.databaseName,port:0,tenantOrigin:'https://localhost:0',platformOrigin:'https://platform.localhost:0'};
    const runtime=await attachRuntime(identity,keys,config);
    const password='synthetic finance long password 98461357';
    const actor=async()=>{
      const email=`${randomUUID()}@example.test`,anonymous=await sessions.issue('TENANT','P',null);
      await identity.register('TENANT',randomUUID(),{email,displayName:'Persona sintética',privacyPolicyVersion:'synthetic-v1'});
      await identity.dispatchMail();const subject=await identity.identities.findOne({email});
      const message=[...messaging.inbox.values()].find(m=>m.subjectId===subject?._id&&m.purpose==='ACTIVATION');
      if(!message)throw Error('Activation fixture unavailable');
      const initial=await identity.confirmEmail(anonymous.context,{purpose:'ACTIVATION',token:message.token,newPassword:password});
      const enrollment=await runtime.totp.enroll(initial.issued.context,'Sintético');
      const secret=new URL(enrollment.provisioningUri).searchParams.get('secret');if(!secret)throw Error('TOTP fixture unavailable');
      const completed=await runtime.totp.confirm(initial.issued.context,enrollment.enrollmentId,await generate({secret,epoch:Math.floor(now()/1000)}));
      if(!completed.issued)throw Error('No strong session');
      return{email,secret,issued:completed.issued};
    };
    type Actor=Awaited<ReturnType<typeof actor>>;
    const proof=async(a:Actor,purpose:string,command:Record<string,unknown>,resourceId?:string)=>{
      await identity.reauthenticate(a.issued.context,{password,purpose,command,...(resourceId?{resourceId}:{})});
      clock.value+=30000;
      const target=purpose.startsWith('FINANCE_')?resourceId?.toLowerCase()??null:resourceId??null;
      const result=await runtime.totp.authenticate(a.issued.context,await generate({secret:a.secret,epoch:Math.floor(now()/1000)}),purpose,target);
      a.issued=result.issued;return result.issued;
    };
    const organization=async(a:Actor)=>{
      const payload={name:'Organización sintética',currency:'COP',timezone:'America/Bogota'};
      await proof(a,'ORGANIZATION_CREATE',payload);return(await runtime.organizations.create(a.issued.context,payload,randomUUID())).data.organization.id;
    };
    const mutate=async(a:Actor,org:string,operation:string,payload:Record<string,unknown>,options:{key?:string;id?:string;etag?:string}={})=>{
      const key=options.key??randomUUID();await proof(a,purposes.get(operation)!,{organizationId:org,idempotencyKey:key,payload,...(options.etag?{expectedETag:options.etag}:{})},options.id);
      return await runtime.finance.mutate(a.issued.context,operation,org,payload,key,options.id,options.etag);
    };
    const login=async(a:Actor)=>{
      const first=await identity.login('TENANT',randomUUID(),a.email,password);clock.value+=30000;
      return{...a,issued:(await runtime.totp.authenticate(first.issued.context,await generate({secret:a.secret,epoch:Math.floor(now()/1000)}),'LOGIN',null)).issued};
    };
    let server:ReturnType<typeof createServer>|undefined;
    const children:ChildProcess[]=[];
    const stop=async(child:ChildProcess)=>{
      if(child.exitCode!==null)return;
      const exited=once(child,'exit');child.send('LOCAL_SYNTHETIC_SHUTDOWN');
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Own child failed orderly shutdown')),15000);})]);}
      finally{clearTimeout(timer);}
    };
    const https=async(a:Actor)=>{
      // Exact private fixture directory; no manual keyring, TLS rotation or global trust changes.
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed .runtime parent plus generated UUID, never HTTP input.
      await mkdir(folder,{recursive:true});await promisify(execFile)('C:/Program Files/Git/usr/bin/openssl.exe',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(folder,'key.pem'),'-out',join(folder,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,DNS:platform.localhost,IP:127.0.0.1'],{windowsHide:true});
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Read only this fixture's generated TLS pair.
      const cert=await readFile(join(folder,'cert.pem')),key=await readFile(join(folder,'key.pem'));
      server=createServer({cert,key},createApp({identity,config})).listen(0,'127.0.0.1');await once(server,'listening');
      const address=server.address();if(!address||typeof address==='string')throw Error('No test listener');
      config.tenantOrigin=`https://localhost:${address.port}`;config.platformOrigin=`https://platform.localhost:${address.port}`;
      const client=new ApiClient(address.port,cert);client.cookies.set('__Host-caudelyx-session',a.issued.token);await client.refreshCsrf();return{client,port:address.port,cert};
    };
    const native=async(a:Actor)=>{
      const freePort=async()=>{const s=portServer().listen(0,'127.0.0.1');await once(s,'listening');const p=s.address();if(!p||typeof p==='string')throw Error('No test port');await new Promise<void>(r=>s.close(()=>r()));return p.port;};
      // Synthetic key material stays only inside this fixture's ignored control folder, never evidence/logs.
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Generated fixture control directory.
      await writeFile(join(folder,'keys.json'),JSON.stringify({version:1,mail:keys.mail.toString('base64url'),totp:keys.totp.toString('base64url'),journal:keys.journal.toString('base64url'),cursor:keys.cursor.toString('base64url')}),{mode:0o600});
      const port=await freePort();let platformPort=await freePort();while(platformPort===port)platformPort=await freePort();
      const child=spawn(process.execPath,['dist/src/server.js'],{env:{...process.env,CAUDELYX_MODE:'local-synthetic',MONGODB_URI:'mongodb://localhost:27017/?replicaSet=rs0',MONGODB_DATABASE:database.db.databaseName,PORT:String(port),TENANT_ORIGIN:`https://localhost:${port}`,PLATFORM_ORIGIN:`https://platform.localhost:${platformPort}`,KEYRING_FILE:join(folder,'keys.json'),TLS_DIRECTORY:folder},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
      children.push(child);let stderr='';child.stderr?.on('data',b=>{stderr+=String(b).slice(0,2000);});
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Own generated TLS certificate, public half only.
      const client=new ApiClient(port,await readFile(join(folder,'cert.pem')));client.cookies.set('__Host-caudelyx-session',a.issued.token);
      for(let i=0;i<200;i++){
        if(child.exitCode!==null)throw Error('Native backend exited: '+stderr);
        try{await client.refreshCsrf();return{child,client};}catch{await delay(50);}
      }throw Error('Native backend readiness deadline');
    };
    return{database,clock,now,keys,restore,sessions,identity,runtime,password,actor,proof,organization,mutate,login,https,native,folder,
      context:async(context:Context)=>(await sessions.contexts.findOne({_id:context._id}))!,
      close:async()=>{try{for(const child of children)await stop(child);}finally{try{if(server)await new Promise<void>(r=>server!.close(()=>r()));await restore.flush();}finally{try{await database.close();}finally{await profile.dispose();}}}}};
  }catch(error){try{await database.close();}finally{await profile.dispose();}throw error;}
}
