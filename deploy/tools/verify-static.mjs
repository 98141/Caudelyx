// Local static checks only: no Docker, network, product startup or DB access.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {inventory} from './package-contracts.mjs';
import {contractPath, sha256, verifyBundle} from '../api/verify-contracts.mjs';

const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const workspace = path.dirname(repo);
const checks = [];
async function check(name, work) {
  const start = performance.now();
  try { const detail = await work(); checks.push({name, status: 'PASS', milliseconds: +(performance.now()-start).toFixed(3), detail}); }
  catch (error) { checks.push({name, status: 'FAIL', milliseconds: +(performance.now()-start).toFixed(3), error: error.message}); }
}
const read = relative => fs.readFile(path.join(repo, relative), 'utf8');
const {parseDocument} = await import(pathToFileURL(path.join(repo, 'servidor/node_modules/yaml/dist/index.js')).href);
let compose;
await check('Compose YAML syntax and duplicate keys (not Docker schema validation)', async () => {
  const doc = parseDocument(await read('deploy/docker-compose.demo.yml'), {uniqueKeys: true});
  assert.equal(doc.errors.length, 0, doc.errors.map(e=>e.message).join('; ')); compose = doc.toJS();
  assert.deepEqual(Object.keys(compose.services), ['mongo','api','web']);
});
await check('Network ownership, loopback, external volumes and resource limits', () => {
  const {mongo,api,web} = compose.services;
  assert.equal(mongo.ports, undefined);assert.equal(api.ports, undefined);
  assert.deepEqual(mongo.networks,['database']);assert.deepEqual(api.networks,['edge','database']);assert.deepEqual(web.networks,['edge','hostaccess']);
  assert.equal(compose.networks.database.internal,true);assert.equal(compose.networks.edge.internal,true);
  assert.deepEqual(Object.keys(compose.networks),['edge','database','hostaccess']);
  assert.deepEqual(compose.networks.hostaccess,{external:true,name:'caudelyx-demo-hostaccess'});
  assert.ok(web.ports.every(p=>p.startsWith('127.0.0.1:')));
  for (const service of [api,web]) {
    assert.equal(service.network_mode,undefined);
    assert.equal(service.read_only,true); assert.deepEqual(service.cap_drop,['ALL']);
  }
  for (const service of [mongo,api,web]) {
    assert.ok(service.cpus>0); assert.ok(service.mem_limit); assert.equal(service.mem_limit,service.memswap_limit);
    assert.ok(service.pids_limit>0); assert.equal(service.restart,'unless-stopped');
  }
  for (const v of Object.values(compose.volumes)) {assert.equal(v.external,true); assert.match(v.name,/caudelyx-demo-/);}
  assert.equal(api.environment.MONGODB_URI,'mongodb://mongo:27017/?replicaSet=rs0');
  assert.equal(api.environment.CAUDELYX_RUNTIME_PROFILE,'persistent-demo');
  assert.equal(api.environment.MONGODB_PASSWORD_FILE,'/run/secrets/app_password');
  assert.equal(api.environment.CAUDELYX_MODE,'local-synthetic');
  for (const service of [mongo,api,web]) for (const mount of service.volumes) if (typeof mount==='object') {
    assert.equal(mount.read_only,true); assert.equal(mount.bind.create_host_path,false);
  }
  const keyMount=api.volumes.find(v=>typeof v==='object'&&v.target===api.environment.KEYRING_FILE);
  assert.ok(keyMount?.read_only);
  return {published: web.ports, limitsMiB: 1024+1536+128, cpus: 3};
});
await check('Nginx HTTPS upstreams, exact hosts and no port collision', async () => {
  const nginx=await read('deploy/nginx/nginx.conf');
  assert.match(nginx,/listen 3001 ssl/); assert.match(nginx,/listen 3443 ssl/);
  assert.doesNotMatch(nginx,/listen 3002/); assert.match(nginx,/proxy_ssl_verify on;/);
  assert.match(nginx,/proxy_pass https:\/\/api:4001;/);
  assert.match(nginx,/proxy_pass https:\/\/api:4002;/);
  assert.match(nginx,/proxy_ssl_name api;/);
  assert.match(nginx,/proxy_set_header Host \$http_host;/); assert.ok(nginx.includes('${PLATFORM_AUTHORITY}'));
  const health=await read('deploy/nginx/healthcheck.sh');assert.ok(health.includes('--connect-to "$PLATFORM_HOST:$PLATFORM_PORT:127.0.0.1:3443"'));assert.doesNotMatch(health,/--insecure|\s-k\s/);
  assert.doesNotMatch(nginx,/proxy_ssl_verify off|access_log on|proxy_hide_header/);
  let balance=0; for (const token of nginx.replace(/#.*$/gm,'').match(/[{}]/g)??[]) {balance+=token==='{'?1:-1; assert.ok(balance>=0);} assert.equal(balance,0);
  return 'Structural review only; nginx -t and TLS requests pending';
});
await check('Dockerfile COPY inputs exist and contexts exclude private data', async () => {
  const ignored=await read('.dockerignore'); assert.match(ignored,/^\*\*$/m);
  assert.doesNotMatch(ignored,/!.*(?:Construccion|\.runtime|node_modules|dist|\.env)/);
  for (const name of ['api','web']) {
    const dockerfile=await read(`deploy/docker/${name}.Dockerfile`);
    assert.doesNotMatch(dockerfile,/COPY\s+\.\s|ADD\s|Construccion|\.env/);
    assert.match(dockerfile,/USER (?:node|101:101)/);
    for (const line of dockerfile.split('\n').filter(l=>l.startsWith('COPY ')&&!l.includes('--from='))) {
      const tokens=line.split(/\s+/).slice(1).filter(t=>!t.startsWith('--')); tokens.pop();
      for (const src of tokens) {assert.ok(!src.startsWith('/')&&!src.includes('..')); await fs.stat(path.join(repo,src));}
    }
  }
  return 'Existing inputs and allowlist inspected; no Docker parser/build was invoked';
});
await check('JavaScript syntax of all new infrastructure scripts', async () => {
  const names=['api/entrypoint.mjs','api/healthcheck.mjs','api/verify-contracts.mjs','mongo/healthcheck.js','mongo/init-replica.js','tools/package-contracts.mjs','tools/verify-static.mjs','tools/provision.mjs','tools/operations.mjs','tools/mailbox.mjs'];
  for (const name of names) {
    const result=spawnSync(process.execPath,['--check',path.join(repo,'deploy',name)],{encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);
  }
  return {scripts: names.length, executed: 'syntax parser only'};
});
await check('Vite build configuration TypeScript semantics (no emit/build)', async () => {
  const ts=(await import(pathToFileURL(path.join(repo,'cliente/node_modules/typescript/lib/typescript.js')).href)).default;
  const program=ts.createProgram([path.join(repo,'cliente/vite.docker.config.ts')],{noEmit:true,skipLibCheck:true,strict:true,target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,types:[],esModuleInterop:true});
  const errors=ts.getPreEmitDiagnostics(program).filter(d=>d.category===ts.DiagnosticCategory.Error);
  assert.equal(errors.length,0,errors.map(d=>ts.flattenDiagnosticMessageText(d.messageText,' ')).join('; '));
  return {emitted: 0};
});
await check('Existing manifests and lockfiles agree; Node range preserved', async () => {
  for (const folder of ['cliente','servidor']) {
    const pkg=JSON.parse(await read(folder+'/package.json')), lock=JSON.parse(await read(folder+'/package-lock.json'));
    assert.equal(pkg.engines.node,'>=24.15.0 <25');
    assert.deepEqual(pkg.dependencies,lock.packages[''].dependencies);
    assert.deepEqual(pkg.devDependencies,lock.packages[''].devDependencies);
  }
  return 'No install, audit, version resolution or lockfile write';
});
await check('All literal and transitive contract hashes, refs and template allowlist', async () => {
  const data=await inventory(workspace);
  return {files:data.files.length,bytes:data.files.reduce((n,f)=>n+f.bytes,0),sourceAnchors:data.sourceAnchors.length,copied:0};
});
await check('Private bundle guards reject path traversal and invalid manifest digest before I/O', async () => {
  for (const relative of ['Construccion/../Caudelyx/.env','Construccion//a','/etc/passwd','Construccion/a/../../x','Construccion\\a']) assert.throws(()=>contractPath(workspace,relative));
  assert.equal(sha256(Buffer.from('abc')),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  await assert.rejects(verifyBundle(workspace,'not-read','invalid'),/digest required/);
  return {negativePaths:5,copies:0,connections:0};
});
await check('Mongo authentication, TLS and explicit bootstrap',async()=>{
  const {parse}=await import(pathToFileURL(path.join(repo,'servidor/node_modules/yaml/dist/index.js')).href),m=parse(await read('deploy/mongo/mongo-config.yml'));
  assert.equal(m.security.authorization,'enabled');assert.equal(m.net.tls.mode,'requireTLS');assert.equal(m.replication.replSetName,'rs0');assert.ok(m.security.keyFile);
  assert.deepEqual(compose.services.api.secrets,['app_username','app_password','demo_profile']);assert.ok(!compose.services.web.secrets);
  return 'Static declarations only; Docker networking and Linux permissions need runtime';
});
console.log(JSON.stringify({task:'F06-INTEGRAL-002',scope:'STATIC_LOCAL_ONLY',checks,
  pending:['nginx -t','image versions/digests and Linux native dependencies','image builds','Docker replica startup and network isolation','Docker cold restore','Coolify compatibility','independent review','deployment authorization'],
  dockerInvocations:0,networkConnections:0,databaseConnections:0,contractsCopied:0},null,2));
if (checks.some(c=>c.status==='FAIL')) process.exitCode=1;
