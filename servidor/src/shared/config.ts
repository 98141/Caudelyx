
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import type {MongoClientOptions} from 'mongodb';

export interface Config {
  mongoUri: string;
  databaseName: string;
  port: number;
  tenantOrigin: string;
  platformOrigin: string;
  profile?: 'persistent-demo';
  mongoOptions?: MongoClientOptions;
  profileFile?: string;
  bindHost?: string;
  platformPort?: number;
}
function secret(file:string|undefined):string {
  if(!file||!lstatSync(file).isFile()||realpathSync(file)!==resolve(file))throw Error('DEMO_SECRET_FILE_INVALID');
  const value=readFileSync(file,'utf8').trim();
  if(!value||value.length>4096||/[\r\n]/.test(value))throw Error('DEMO_SECRET_VALUE_INVALID');
  return value;
}
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  if (env['CAUDELYX_MODE'] !== 'local-synthetic') throw new Error('Local synthetic mode required');
  const persistent=env['CAUDELYX_RUNTIME_PROFILE']==='persistent-demo';
  if(env['CAUDELYX_RUNTIME_PROFILE']&&!persistent)throw Error('Unsupported runtime profile');
  const mongoUri = env['MONGODB_URI'];
  if (!mongoUri) throw new Error('MONGODB_URI required');
  // No credentials, SRV, remote hosts or silently accepted default topology.
  const parsed = new URL(mongoUri);
  if (parsed.protocol !== 'mongodb:' || parsed.username || parsed.password ||
    !(persistent?['mongo','127.0.0.1','localhost','[::1]']:['127.0.0.1', 'localhost', '[::1]']).includes(parsed.hostname) ||
    !parsed.searchParams.get('replicaSet')) throw new Error('Loopback replica set required');
  const databaseName = env['MONGODB_DATABASE'] ?? 'caudelyx_synthetic';
  if (!/^caudelyx_[a-z0-9_]+$/.test(databaseName)) throw new Error('Synthetic database name required');
  if(persistent&&!/^caudelyx_demo_[a-z0-9_]{3,20}$/.test(databaseName))throw Error('Dedicated demo database required');
  if(persistent&&([...parsed.searchParams.keys()].some(k=>k!=='replicaSet')||parsed.searchParams.getAll('replicaSet').length!==1||parsed.searchParams.get('replicaSet')!=='rs0'||!['','/'].includes(parsed.pathname)))throw Error('Explicit demo topology required');
  const port = Number(env['PORT'] ?? '3001');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
  const tenantOrigin = env['TENANT_ORIGIN'] ?? 'https://localhost:3001';
  const platformOrigin = env['PLATFORM_ORIGIN'] ?? 'https://platform.localhost:3002';
  const tenant = new URL(tenantOrigin), platform = new URL(platformOrigin);
  for (const url of [tenant, platform]) {
    if (url.protocol !== 'https:' || url.origin !== url.href.replace(/\/$/, '') ||
      url.username||url.password||url.search||url.hash||
      !(persistent?/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(url.hostname):['localhost','platform.localhost'].includes(url.hostname))) {
      throw new Error('Explicit loopback HTTPS origin required');
    }
  }
  if (tenant.hostname === platform.hostname) throw new Error('Platform requires a different host');
  if(persistent&&(tenantOrigin!==tenant.origin||platformOrigin!==platform.origin))throw Error('Canonical demo HTTPS origins required');
  if(!persistent)return { mongoUri, databaseName, port, tenantOrigin, platformOrigin };
  if(Object.keys(env).some(k=>/^CAUDELYX_.*(?:OWNER|DEV_|AUTH_DIAGNOSTICS)/.test(k)))throw Error('Test activation forbidden in persistent demo');
  const profileFile=env['DEMO_PROFILE_FILE'],ca=env['MONGODB_CA_FILE'];
  if(!profileFile||!ca||!lstatSync(ca).isFile()||realpathSync(ca)!==resolve(ca))throw Error('Demo profile and Mongo CA required');
  const platformPort=Number(env['PLATFORM_PORT']??4002),bindHost=env['CAUDELYX_API_BIND_HOST']??'0.0.0.0';
  if(!Number.isInteger(platformPort)||platformPort<1024||platformPort>65535||platformPort===port||!['127.0.0.1','0.0.0.0'].includes(bindHost))throw Error('Invalid demo listeners');
  return {mongoUri,databaseName,port,tenantOrigin,platformOrigin,profile:'persistent-demo',profileFile,bindHost,platformPort,
    mongoOptions:{tls:true,tlsCAFile:ca,authMechanism:'SCRAM-SHA-256',authSource:'admin',auth:{username:secret(env['MONGODB_USERNAME_FILE']),password:secret(env['MONGODB_PASSWORD_FILE'])}}};
}
