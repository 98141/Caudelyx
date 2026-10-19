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
  const tls = await testCertificate();
  await mkdir('.runtime/tls', { recursive: true });
  await writeFile('.runtime/tls/key.pem', tls.key);
  await writeFile('.runtime/tls/cert.pem', tls.cert);
  child = spawn(process.execPath, ['dist/src/server.js'], { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, CAUDELYX_MODE: 'local-synthetic', CAUDELYX_REALM_CLOSED: 'false',
      MONGODB_URI: replica.uri, MONGODB_DATABASE: `caudelyx_dev_${randomUUID().replaceAll('-', '')}`,
      PORT: '3001', TENANT_ORIGIN: 'https://localhost:3001', PLATFORM_ORIGIN: 'https://127.0.0.1:3002' } });
  let failure;
  child.on('error', error => { failure = error; });
  let available = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failure) throw failure;
    if (child.exitCode !== null) throw new Error('Synthetic backend failed to start');
    const success = await new Promise(resolve => {
      const req = request({ hostname: '127.0.0.1', port: 3001, path: '/api/v1/auth/csrf',
        ca: tls.cert, servername: 'localhost', headers: { Host: 'localhost:3001' }, timeout: 500 }, res => {
        res.resume(); res.once('end', () => resolve(res.statusCode === 200));
      });
      req.on('error', () => resolve(false)); req.on('timeout', () => req.destroy()); req.end();
    });
    if (success) { available = true; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!available) throw new Error('Synthetic HTTPS readiness timed out');
  console.log('LOCAL SINTÉTICO: https://localhost:3001 (tenant), https://127.0.0.1:3002 (plataforma).');
  console.log('Certificado local sin confianza pública; no introducir datos reales. MFA/S/tenant aún incompletos, denegados con503.');
  if (!process.argv.includes('--smoke')) {
    await Promise.race([once(process, 'SIGINT'), once(process, 'SIGTERM'), once(child, 'exit')]);
  } else console.log('Smoke A01 CSRF over real HTTPS + replica set: PASS');
} finally {
  if (child && child.exitCode === null) {
    const ended = once(child, 'exit'); child.kill(); await ended;
  }
  await replica.stop();
}
