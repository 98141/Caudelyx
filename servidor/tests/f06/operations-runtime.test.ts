// Unit policy isolation only: a mocked capability is never a real admission.
// Negative security preflight below uses the ORIGINAL PersistentDemo.open.
import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,unlink,rmdir,lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,createHmac} from 'node:crypto';
import {Database} from '../../src/shared/database.js';
import {loadConfig,type Config} from '../../src/shared/config.js';
import type {IdentityService} from '../../src/modules/identity/service.js';
import type {SyntheticKeys} from '../../src/shared/keys.js';
import * as admission from '../../src/shared/persistent-demo.js';

const capabilities=new WeakSet<Database>();
mock.module('../../src/shared/persistent-demo.js',{
  exports:{...admission,persistentDemoAdmitted:(db:Database)=>capabilities.has(db)},
});
const {OperationsService}=await import('../../src/modules/lending/operations-service.js');
const base:Config={mongoUri:'mongodb://mongo:27017/?replicaSet=rs0',databaseName:'caudelyx_demo_ops_test',port:4001,tenantOrigin:'https://localhost:3001',platformOrigin:'https://platform.localhost:3002',profile:'persistent-demo',mongoOptions:{tls:true,authMechanism:'SCRAM-SHA-256',authSource:'admin',auth:{username:'synthetic-test-user',password:'synthetic-test-password'}}};
const error=/Operations require existing local synthetic runtime/;
function construct(config:Config,admitted=false){
  const db=new Database('mongodb://127.0.0.1:29999/?replicaSet=rs0',config.databaseName);
  if(admitted)capabilities.add(db);
  // Constructor uses only database; no connection, indexes or financial work.
  return new OperationsService({database:db} as IdentityService,Buffer.alloc(32,7),config);
}
test('exact Docker hostname requires persistent profile AND live admission (unit capability)',()=>{
  assert.doesNotThrow(()=>construct(base,true));
  const prior=construct(base,true);capabilities.delete(prior.identity.database);
  assert.throws(()=>new OperationsService(prior.identity,Buffer.alloc(32,7),base),error);
  assert.throws(()=>construct(base),error);
  const {profile,...legacy}=base;void profile;
  assert.throws(()=>construct(legacy,true),error);
  assert.throws(()=>construct({...base,profile:'other' as 'persistent-demo'},true),error);
  for(const host of ['mongo.example','mongo2','mongo.','MONGO','example.com','172.20.0.2']){
    assert.throws(()=>construct({...base,mongoUri:`mongodb://${host}:27017/?replicaSet=rs0`},true),error);
  }
});
test('legacy loopback and HTTPS localhost policy remains unchanged',()=>{
  const {profile,...legacy}=base;void profile;
  for(const host of ['localhost','127.0.0.1','[::1]'])assert.doesNotThrow(()=>construct({...legacy,mongoUri:`mongodb://${host}:27017/?replicaSet=rs0`}));
  for(const tenantOrigin of ['http://localhost:3001','https://example.com:3001'])assert.throws(()=>construct({...base,tenantOrigin},true),error);
  assert.throws(()=>construct({...base,mongoUri:'https://mongo:27017/'},true),error);
});

test('configuration and original admission reject insecure Docker settings before connecting',async()=>{
  const root=resolve('.runtime/f06-operations-tests'),files=['ca.txt','username.txt','password.txt','keyring.json','profile.json'];
  // Exclusive new directory; exact files removed individually, no recursive rm.
  await mkdir(root);
  try{
    await writeFile(join(root,'ca.txt'),'synthetic-placeholder-not-a-certificate',{flag:'wx'});
    await writeFile(join(root,'username.txt'),'synthetic-test-user',{flag:'wx'});
    await writeFile(join(root,'password.txt'),'synthetic-test-password',{flag:'wx'});
    const keyring=Buffer.from('synthetic-test-keyring-placeholder');
    await writeFile(join(root,'keyring.json'),keyring,{flag:'wx'});
    const env={CAUDELYX_MODE:'local-synthetic',CAUDELYX_RUNTIME_PROFILE:'persistent-demo',MONGODB_URI:base.mongoUri,MONGODB_DATABASE:base.databaseName,DEMO_PROFILE_FILE:join(root,'profile.json'),MONGODB_CA_FILE:join(root,'ca.txt'),MONGODB_USERNAME_FILE:join(root,'username.txt'),MONGODB_PASSWORD_FILE:join(root,'password.txt')};
    const config=loadConfig(env);
    assert.equal(config.mongoOptions?.tls,true);
    assert.equal(config.mongoOptions?.authMechanism,'SCRAM-SHA-256');
    assert.equal(config.mongoOptions?.authSource,'admin');
    for(const MONGODB_URI of ['mongodb://example.com:27017/?replicaSet=rs0','mongodb://mongo.example:27017/?replicaSet=rs0','mongodb://u:p@mongo:27017/?replicaSet=rs0','mongodb://mongo:27017/?replicaSet=rs0&tls=false','mongodb://mongo:27017/?replicaSet=rs0&tlsAllowInvalidCertificates=true'])assert.throws(()=>loadConfig({...env,MONGODB_URI}));
    assert.throws(()=>loadConfig({...env,MONGODB_USERNAME_FILE:''}));
    assert.throws(()=>loadConfig({...env,MONGODB_PASSWORD_FILE:''}));
    assert.throws(()=>loadConfig({...env,MONGODB_CA_FILE:''}));
    const keys:SyntheticKeys={version:2,mail:Buffer.alloc(32,1),totp:Buffer.alloc(32,2),journal:Buffer.alloc(32,3),cursor:Buffer.alloc(32,4),priority:Buffer.alloc(32,5)};
    const payload={version:1,mode:'local-synthetic',realUseAllowed:false,deploymentId:'11111111-1111-4111-8111-111111111111',databaseName:config.databaseName,mongoUri:config.mongoUri,tenantOrigin:config.tenantOrigin,platformOrigin:config.platformOrigin,keyringSHA256:createHash('sha256').update(keyring).digest('hex')};
    const signature=createHmac('sha256',keys.journal).update('CAUDELYX:DEMO:PROFILE:v1:'+JSON.stringify(payload)).digest('hex');
    await writeFile(join(root,'profile.json'),JSON.stringify({payload,signature}),{flag:'wx'});
    const options={tls:true,authMechanism:'SCRAM-SHA-256' as const,authSource:'admin',auth:{username:'synthetic-test-user',password:'synthetic-test-password'}};
    const db=new Database(config.mongoUri,config.databaseName,options);
    let connections=0;
    mock.method(db.client,'connect',async()=>{connections++;throw Error('TEST_CONNECT_BOUNDARY');});
    const attempt=(c:Config)=>admission.PersistentDemo.open(db,c,keys,root,join(root,'keyring.json'));
    for(const mongoOptions of [{...options,tls:false},{...options,tlsInsecure:true},{...options,tlsAllowInvalidCertificates:true},{...options,tlsAllowInvalidHostnames:true},{tls:true}]){
      await assert.rejects(attempt({...config,mongoOptions}),/DEMO_AUTHENTICATED_TLS_REQUIRED/);
    }
    assert.equal(connections,0);
    // Valid signed config reaches network boundary; it is NOT claimed admitted.
    await assert.rejects(attempt(config),/TEST_CONNECT_BOUNDARY/);
    assert.equal(connections,1);
    assert.equal(admission.persistentDemoAdmitted(db),false);
    const realIdentity={database:db} as IdentityService;
    assert.throws(()=>new OperationsService(realIdentity,keys.cursor,config),error);
    for(const actual of [{...options,tls:false},{tls:true},{...options,auth:{username:options.auth.username,password:'synthetic-wrong-password'}}]){
      const insecureDb=new Database(config.mongoUri,config.databaseName,actual);
      mock.method(insecureDb.client,'connect',async()=>{throw Error('UNEXPECTED_NETWORK');});
      await assert.rejects(admission.PersistentDemo.open(insecureDb,config,keys,root,join(root,'keyring.json')),/DEMO_ACTUAL_CONNECTION_INVALID/);
      assert.equal(admission.persistentDemoAdmitted(insecureDb),false);
      await insecureDb.client.close();
    }
    await db.client.close();
  }finally{
    assert.equal((await lstat(root)).isSymbolicLink(),false);
    for(const file of files)await unlink(join(root,file)).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});
    await rmdir(root);
  }
});
