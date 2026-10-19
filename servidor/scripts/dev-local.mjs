// Synthetic-only local runner: no global services, no real data, no remote database.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { randomUUID } from 'node:crypto';
import { startReplicaSet } from '../dist/tests/helpers/replica-set.js';
import { testCertificate } from '../dist/tests/helpers/tls.js';

const replica = await startReplicaSet();
let child;
try {
  const apiPort=process.env.CAUDELYX_DEV_API_PORT??'3001';
  if(!/^\d{4,5}$/.test(apiPort)||Number(apiPort)<1024||Number(apiPort)>65535||Number(apiPort)===3002)throw new Error('Invalid local API port');
  const databaseName=`caudelyx_dev_${randomUUID().replaceAll('-', '')}`;
  const tls = await testCertificate();
  await mkdir('.runtime/tls', { recursive: true });
  await writeFile('.runtime/tls/key.pem', tls.key);
  await writeFile('.runtime/tls/cert.pem', tls.cert);
  await writeFile('.runtime/local-connection.json',JSON.stringify({mode:'local-synthetic',mongoUri:replica.uri,databaseName,apiPort:Number(apiPort),tenantOrigin:'https://localhost:3001',platformOrigin:'https://platform.localhost:3002',keyringFile:'.runtime/synthetic-keys.json'},null,2),{mode:0o600});
  child = spawn(process.execPath, ['dist/src/server.js'], { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, CAUDELYX_MODE: 'local-synthetic',
      MONGODB_URI: replica.uri, MONGODB_DATABASE: databaseName,
      PORT: apiPort, TENANT_ORIGIN: 'https://localhost:3001', PLATFORM_ORIGIN: 'https://platform.localhost:3002' } });
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
  if (!process.argv.includes('--smoke')) {
    await Promise.race([once(process, 'SIGINT'), once(process, 'SIGTERM'), once(child, 'exit')]);
  } else console.log('Smoke A01 CSRF over real HTTPS + replica set: PASS');
} finally {
  if (child && child.exitCode === null) {
    const ended = once(child, 'exit'); child.kill(); await ended;
  }
  await replica.stop();
}
