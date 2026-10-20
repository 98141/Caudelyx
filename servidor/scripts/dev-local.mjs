// Synthetic-only local runner: no global services, no real data, no remote database.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { randomUUID, X509Certificate, createPrivateKey } from 'node:crypto';
import { startReplicaSet } from '../dist/tests/helpers/replica-set.js';
import { testCertificate } from '../dist/tests/helpers/tls.js';
import { acquireRuntime, manualPaths, requireSyntheticMode } from './local-runtime.mjs';

const manual = process.argv.includes('--manual');
if (manual) requireSyntheticMode();
const release = await acquireRuntime();
let replica;
let child;
try {
  const settings = manual ? manualPaths() : null;
  replica = await startReplicaSet(settings ? {manualProfile:settings.profile,port:settings.mongoPort} : {});
  const apiPort=process.env.CAUDELYX_DEV_API_PORT??(manual?'4001':'3001');
  if(!/^\d{4,5}$/.test(apiPort)||Number(apiPort)<1024||Number(apiPort)>65535||Number(apiPort)===3002)throw new Error('Invalid local API port');
  const databaseName=settings?.database??`caudelyx_dev_${randomUUID().replaceAll('-', '')}`;
  let tls;
  if (settings) {
    await mkdir(settings.control, {recursive:true});
    try {
      const key = await readFile(settings.control + '/tls-key.pem'), cert = await readFile(settings.control + '/tls-cert.pem'), certificate = new X509Certificate(cert);
      if (Date.parse(certificate.validTo) > Date.now() + 60000 && certificate.checkPrivateKey(createPrivateKey(key)) && certificate.checkHost('localhost') && certificate.checkHost('platform.localhost')) tls = {key,cert};
    } catch { /* Only synthetic TLS is reissued; identity/keyring/journal material is never replaced here. */ }
  }
  if (!tls) {
    tls = await testCertificate();
    if (settings) {
      await writeFile(settings.control + '/tls-key.pem',tls.key,{mode:0o600});
      await writeFile(settings.control + '/tls-cert.pem',tls.cert,{mode:0o600});
    }
  }
  await mkdir('.runtime/tls', { recursive: true });
  await writeFile('.runtime/tls/key.pem', tls.key);
  await writeFile('.runtime/tls/cert.pem', tls.cert);
  const keyringFile = settings ? settings.control + '/keys.json' : '.runtime/synthetic-keys.json';
  const descriptor = {mode:'local-synthetic',mongoUri:replica.uri,databaseName,apiPort:Number(apiPort),tenantOrigin:'https://localhost:3001',platformOrigin:'https://platform.localhost:3002',keyringFile};
  await writeFile('.runtime/local-connection.json',JSON.stringify(descriptor,null,2),{mode:0o600});
  if (settings) await writeFile(settings.descriptor,JSON.stringify(descriptor,null,2),{mode:0o600});
  child = spawn(process.execPath, ['dist/src/server.js'], { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, CAUDELYX_MODE: 'local-synthetic',
      MONGODB_URI: replica.uri, MONGODB_DATABASE: databaseName,
      KEYRING_FILE: keyringFile, PORT: apiPort, TENANT_ORIGIN: 'https://localhost:3001', PLATFORM_ORIGIN: 'https://platform.localhost:3002' } });
  let failure;
  child.on('error', error => { failure = error; });
  let available = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failure) throw failure;
    if (child.exitCode !== null) throw new Error('Synthetic backend failed to start');
    const success = await new Promise(resolve => {
      const req = request({ hostname: '127.0.0.1', port: Number(apiPort), path: '/api/v1/auth/csrf',
        ca: tls.cert, servername: 'localhost', headers: { Host: 'localhost:3001' }, timeout: 500 }, res => {
        res.resume(); res.once('end', () => resolve(res.statusCode === 200));
      });
      req.on('error', () => resolve(false)); req.on('timeout', () => req.destroy()); req.end();
    });
    if (success) { available = true; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!available) throw new Error('Synthetic HTTPS readiness timed out');
  console.log('LOCAL SINTÉTICO: https://localhost:3001 (tenant), https://platform.localhost:3002 (plataforma).');
  if(apiPort!=='3001')console.log(`API transport on loopback:${apiPort}; tenant UI proxy must preserve Host/Origin localhost:3001.`);
  console.log('Certificado local sintético. Backend sujeto a revisión independiente P05; no introducir datos reales.');
  if (manual) console.log('MODO MANUAL PERSISTENTE. Mongo propio27181 (perfil normal), base caudelyx_manual. Datos solo @example.test.');
  if (process.connected) process.send('LOCAL_RUNTIME_READY');
  if (!process.argv.includes('--smoke')) {
    await Promise.race([once(process, 'SIGINT'), once(process, 'SIGTERM'), once(child, 'exit'), new Promise(resolve => {
      process.on('message', message => { if (message === 'LOCAL_DEV_STOP') resolve(); });
    })]);
  } else console.log('Smoke A01 CSRF over real HTTPS + replica set: PASS');
} finally {
  if (child && child.exitCode === null) {
    const ended = once(child, 'exit');
    if (child.connected) child.send('LOCAL_SYNTHETIC_SHUTDOWN', error => { if (error) child.kill(); }); else child.kill();
    const timeout = setTimeout(() => child.kill(), 15000);
    try { await ended; } finally { clearTimeout(timeout); }
  }
  try { await replica?.stop(); } finally { await release(); }
  if (process.connected) process.disconnect();
}
