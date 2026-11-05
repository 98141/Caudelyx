import {PersistentDemo,activatePersistentModules,loadPersistentKeys} from './shared/persistent-demo.js';
import {BootDiagnostics} from './shared/boot-diagnostics.js';
import {monthlyService} from './modules/lending/ms-service.js';
import { createApp } from './app.js';
import { loadConfig } from './shared/config.js';
import { Database } from './shared/database.js';
import { IdentityService } from './modules/identity/service.js';
import { Sessions } from './modules/sessions/service.js';
import { SyntheticMessaging } from './modules/messaging/service.js';
import { PasswordHasher } from './modules/identity/password.js';
import { loadSyntheticKeys } from './shared/keys.js';
import { attachRuntime } from './shared/runtime.js';
import { RestoreController } from './shared/restore.js';
import { dirname, join,resolve,basename } from 'node:path';
import { createServer,type Server } from 'node:https';
import { readFile,realpath,lstat } from 'node:fs/promises';

async function listen(server:Server,port:number,host:string){
  await new Promise<void>((resolve,reject)=>{
    const failed=(error:Error)=>reject(error);server.once('error',failed);
    server.listen(port,host,()=>{server.off('error',failed);resolve();});
  });
}
async function closeListener(server:Server|undefined){
  if(server?.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
}
async function main(){
const boot=new BootDiagnostics();
const config = await boot.run('CONFIG',()=>loadConfig(process.env));
const database = await boot.run('DATABASE_CLIENT',()=>new Database(config.mongoUri, config.databaseName,config.mongoOptions));
let demo:PersistentDemo|undefined;
let server:Server|undefined,platform:Server|undefined,stopping=false;
try{
const ms=process.env['CAUDELYX_DEV_BUILD_SCOPE']==='MS-P02';
const s13=['S13-P02','S13-P04'].includes(process.env['CAUDELYX_DEV_BUILD_SCOPE']??'');
const s12=ms||s13||process.env['CAUDELYX_DEV_BUILD_SCOPE']==='S12-P02'||process.env['CAUDELYX_DEV_BUILD_SCOPE']==='S12-P04';
const s09=process.env['CAUDELYX_DEV_BUILD_SCOPE']==='S09-P04',s10=process.env['CAUDELYX_DEV_BUILD_SCOPE']==='S10-P04',s11=process.env['CAUDELYX_DEV_BUILD_SCOPE']==='S11-P02'||process.env['CAUDELYX_DEV_BUILD_SCOPE']==='S11-P04',control=resolve(dirname(process.env['KEYRING_FILE']??'.runtime/synthetic-keys.json'));
// eslint-disable-next-line security/detect-non-literal-fs-filename -- Exact temporary owner directory is checked against the closed S09 namespace before filesystem access.
const owned=async()=>{if((!s09&&!s10&&!s11&&!s12)||!/^caudelyx_s08_p02_[a-f0-9]{24}$/.test(config.databaseName)||basename(control)!==(ms?'ms-p02-':s13?(process.env['CAUDELYX_DEV_BUILD_SCOPE']==='S13-P04'?'s13-p04-':'s13-p02-'):s12?(process.env['CAUDELYX_DEV_BUILD_SCOPE']==='S12-P04'?'s12-p04-':'s12-p02-'):s11?(process.env['CAUDELYX_DEV_BUILD_SCOPE']==='S11-P04'?'s11-p04-':'s11-p02-'):s10?'s10-p04-':'s09-p04-')+config.databaseName.slice(-24)||resolve(control,'..')!==resolve('.runtime')||await realpath(control)!==control||(await lstat(control)).isSymbolicLink())throw Error('Unowned management activation');const owner=JSON.parse(await readFile(join(control,'owner.json'),'utf8')) as {pid:number;names:string[];nonce?:string};if(owner.pid!==Number(process.env[ms?'CAUDELYX_MS_OWNER_PID':s13?'CAUDELYX_S13_OWNER_PID':s12?'CAUDELYX_S12_OWNER_PID':s11?'CAUDELYX_S11_OWNER_PID':s10?'CAUDELYX_S10_OWNER_PID':'CAUDELYX_S09_OWNER_PID'])||!owner.names.includes(config.databaseName))throw Error('Unregistered management activation');if((s10||s11||s12)&&(!owner.nonce||owner.nonce!==process.env[ms?'CAUDELYX_MS_OWNER_NONCE':s13?'CAUDELYX_S13_OWNER_NONCE':s12?'CAUDELYX_S12_OWNER_NONCE':s11?'CAUDELYX_S11_OWNER_NONCE':'CAUDELYX_S10_OWNER_NONCE']||JSON.stringify(owner.names)!==JSON.stringify([config.databaseName,config.databaseName+'_external_mail',config.databaseName+'_external_security'])))throw Error('Invalid S10 owner nonce/names');process.kill(owner.pid,0);return true;};
if(s09||s10||s11||s12)await owned();
const keyringFile=process.env['KEYRING_FILE']??'.runtime/synthetic-keys.json';
const keys=await boot.run('KEYRING',()=>config.profile==='persistent-demo'?loadPersistentKeys(keyringFile):loadSyntheticKeys(keyringFile));
if(config.profile==='persistent-demo')demo=await boot.run('DEMO_ADMISSION',()=>PersistentDemo.open(database,config,keys,control,keyringFile,boot));
await boot.run('DATABASE_INDEXES',()=>database.connect());
const restore = new RestoreController(database,demo||s09||s10||s11||s12?join(control,'gate.json'):join(control,`gate-${config.databaseName}.json`),keys.journal,keys.priority,keys.cursor);
const verifyOwner=async()=>demo?await demo.verify():await owned();
await boot.run('RESTORE',()=>restore.initialize(demo?boot:undefined));
await boot.run('RESTORE_OPEN',()=>{if(demo&&!restore.isOpen())throw Error('DEMO_RESTORE_GATE_CLOSED');});
const identity = new IdentityService(database, new Sessions(database),
  new SyntheticMessaging(database, keys.mail, Date.now), new PasswordHasher(),
  () => restore.isOpen()&&(!demo||demo.live()));
await boot.run('IDENTITY',()=>identity.initialize(boot));
await boot.run('RUNTIME',()=>attachRuntime(identity,keys,config,{...(demo||s11||s12?{exchangePrivateRoot:join(control,'private')}:{}),boot}));
if(demo||s11||s12)await boot.run('PRIVATE_STORAGE',()=>identity.exchange!.files.guard());
if(s09){await identity.obligations!.prepareOwned(verifyOwner);const{ProjectionRuntime}=await import('./modules/reporting/projection/service.js');const projection=await ProjectionRuntime.createOwned(identity,keys.cursor,verifyOwner,false,()=>identity.obligations!.activateOwned(verifyOwner));identity.reporting!.projection=projection;database.projectionShutdown=async()=>{await identity.obligations!.stop();await projection.stop();};}
if(demo)await boot.run('MODULES',()=>activatePersistentModules(identity,keys,verifyOwner,boot));
else if(s10||s11||s12){await identity.obligations!.prepareOwned(verifyOwner);await identity.wealth!.prepareOwned(verifyOwner);if(demo||s12)await identity.simulation!.prepareOwned(verifyOwner);const{ProjectionRuntime}=await import('./modules/reporting/projection/service.js');const projection=await ProjectionRuntime.createOwned(identity,keys.cursor,verifyOwner,false,()=>identity.obligations!.activateOwned(verifyOwner));identity.reporting!.projection=projection;database.projectionShutdown=async()=>{await identity.obligations!.stop();await projection.stop();};}
if(!demo&&s12)await identity.simulation!.activateOwned(verifyOwner);
if(!demo&&ms)await monthlyService(identity).activateOwned(verifyOwner);
const requireModules=()=>{if(demo&&(!restore.isOpen()||!demo.live()||!identity.obligations?.active||!identity.reporting?.projection?.ready||!identity.simulation?.store.active||!monthlyService(identity).active))throw Error('DEMO_MODULES_UNAVAILABLE');};
await boot.run('MODULES_READY',requireModules);
const tlsDirectory = process.env['TLS_DIRECTORY'] ?? '.runtime/tls';
// TLS_DIRECTORY is operator configuration, never derived from HTTP input.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const tls=await boot.run('TLS_LOAD',async()=>({key:await readFile(join(tlsDirectory,'key.pem')),cert:await readFile(join(tlsDirectory,'cert.pem'))}));
await boot.run('TENANT_LISTEN',async()=>{
  server=createServer(tls,createApp({identity,config,health:()=>({live:!stopping,ready:restore.isOpen()&&(!demo||demo.live()&&identity.obligations?.active===true&&identity.reporting?.projection?.ready===true&&identity.simulation?.store.active===true&&monthlyService(identity).active)})}));
  await listen(server,config.port,config.bindHost??'127.0.0.1');
});
// Same operator-owned TLS pair for the separate platform host.
await boot.run('PLATFORM_LISTEN',async()=>{
  platform=createServer(tls,createApp({identity,config}));
  await listen(platform,config.platformPort??Number(new URL(config.platformOrigin).port||'443'),config.bindHost??'127.0.0.1');
});
// Complete only after BOTH listeners and all legitimate modules are ready.
// An INITIALIZING deployment remains resumable when TLS/bind fails.
await boot.run('READY',async()=>{requireModules();await demo?.ready();});
boot.mark('COMPLETE','OK');
let pending: Promise<void> | null = null;
const dispatcher = setInterval(() => {
  if (pending) return; // Backpressure: one task, never an unbounded promise queue.
  pending = (async()=>{await restore.flush();if(await identity.isRealmOpen('TENANT')){await identity.dispatchMail();await identity.beforeRequest?.();if((demo||s11||s12)&&identity.obligations?.active)await identity.exchange!.reconcile();if((demo||s12)&&identity.simulation?.store.active)await identity.simulation.reconcile();}})()
    .catch(() => { console.error('SYNTHETIC_DISPATCH_RETRY_PENDING'); /* Fixed diagnostic only; durable outboxes retained. */ })
    .finally(() => { pending = null; });
}, 1000);
dispatcher.unref();
async function shutdown() {
  if (stopping) return; stopping = true;
    clearInterval(dispatcher);
  try { await pending; await restore.flush(); } catch { /* Keep evidence/gate closed rather than manufacture a missing journal. */ }
  await Promise.all([closeListener(server),closeListener(platform)]);
  await database.projectionShutdown?.();delete database.projectionShutdown;
  try{await restore.flush();}finally{await demo?.close();await database.close();} process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void shutdown(); });
process.on('message', message => { if (message === 'LOCAL_SYNTHETIC_SHUTDOWN') void shutdown(); });

}catch(error){
  boot.fail('BOOT',error);stopping=true;
  await boot.run('CLEANUP_LISTENERS',()=>Promise.all([closeListener(server),closeListener(platform)])).catch(()=>{});
  await boot.run('CLEANUP_WORKERS',async()=>{await database.projectionShutdown?.();delete database.projectionShutdown;}).catch(()=>{});
  await boot.run('CLEANUP_LEASE',()=>demo?.close()).catch(()=>{});
  await boot.run('CLEANUP_DATABASE',()=>database.close()).catch(()=>{});
  throw error;
}
}
void main().catch(()=>{console.error('CAUDELYX_BOOT_FAILED: verificar perfil, TLS, controles y disponibilidad; sin reparación automática.');process.exitCode=1;});
