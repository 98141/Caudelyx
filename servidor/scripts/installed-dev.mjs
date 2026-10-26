/* eslint-disable security/detect-non-literal-fs-filename -- Fixed operator-owned profile paths; never derived from HTTP input. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:net';
import { request } from 'node:https';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { installedSettings, inspectInstalled, serverRoot, projectRoot } from './installed-profile.mjs';

async function freePort(port, host) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', () => reject(new Error(`Puerto ${port} ocupado o no disponible. No se detienen otros procesos.`)));
    probe.listen(port, host, resolve);
  });
  await new Promise(resolve => probe.close(resolve));
}
async function prepareTls(settings) {
  let key, cert;
  try {
    key = await fs.readFile(path.join(settings.tls, 'key.pem'));
    cert = await fs.readFile(path.join(settings.tls, 'cert.pem'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Bootstrap only a completely new profile; never replace a partial or expired pair.
    const existing = await fs.readdir(settings.tls).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    if (existing.length) throw new Error('TLS S02 incompleto: revisar el perfil; no se rotan certificados automáticamente.');
    const source = path.join(serverRoot, '.runtime', 'manual-control');
    key = await fs.readFile(path.join(source, 'tls-key.pem'));
    cert = await fs.readFile(path.join(source, 'tls-cert.pem'));
    await fs.mkdir(settings.tls, { recursive: true });
    await fs.writeFile(path.join(settings.tls, 'key.pem'), key, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(settings.tls, 'cert.pem'), cert, { flag: 'wx', mode: 0o600 });
  }
  const x509 = new X509Certificate(cert);
  if (!x509.checkPrivateKey(createPrivateKey(key)) || !x509.checkHost('localhost') || !x509.checkHost('platform.localhost') ||
      Date.parse(x509.validTo) <= Date.now() + 60000) throw new Error('Certificado local inválido/caducado: renovación explícita necesaria. No se omite HTTPS.');
  return cert;
}
async function stop(child, ipc, record) {
  if (!child || child.exitCode !== null) return;
  record?.({event:'owned-child-before-stop',pid:child.pid,spawnfile:child.spawnfile,spawnargs:child.spawnargs,exitCode:child.exitCode,connected:child.connected,method:ipc&&child.connected?'IPC_LOCAL_SYNTHETIC_SHUTDOWN':'OWN_CHILD_HANDLE'});
  const ended = once(child, 'exit');
  if (ipc && child.connected) child.send('LOCAL_SYNTHETIC_SHUTDOWN'); else child.kill();
  const timer = setTimeout(() => child.kill(), 15000);
  try { await ended; } finally { clearTimeout(timer); }
}
async function ready(url, cert, host, statuses = [200]) {
  return await new Promise(resolve => {
    const req = request(url, { ca: cert, servername: 'localhost', headers: host ? { Host: host } : {}, timeout: 500 }, response => {
      response.resume(); response.once('end', () => resolve(statuses.includes(response.statusCode)));
    });
    req.on('error', () => resolve(false)); req.on('timeout', () => req.destroy()); req.end();
  });
}
export async function runInstalled(env = process.env) {
  const settings = installedSettings(env);
  const record=settings.testId?value=>console.log(JSON.stringify({task:'S06-P04-installed',testId:settings.testId,...value})):undefined;
  // Topology check does not read collections, create indexes, start mongod or change its configuration.
  const mongo = await inspectInstalled(settings);
  for (const p of [settings.apiPort, settings.platformPort]) await freePort(p, '127.0.0.1');
  await freePort(settings.uiPort, '::1');
  await freePort(settings.uiPort, '127.0.0.1');
  await fs.mkdir(settings.control, { recursive: true });
  const lockPath = path.join(settings.control, 'runner.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); } catch { throw new Error('Perfil S02 ya reservado: no iniciar otra copia ni borrar un lock sin verificar su proceso.'); }
  let api, ui;
  let stopRequested = false, apiExited = false;
  const stopped = new Promise(resolve => {
    const requestStop = () => { stopRequested = true; resolve(); };
    process.once('SIGINT', requestStop); process.once('SIGTERM', requestStop);
    process.on('message', message => { if (message === 'LOCAL_DEV_STOP') requestStop(); });
  });
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const existed = await fs.stat(settings.descriptor).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
    const hasKeys = await fs.stat(settings.keyring).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
    if (existed && !hasKeys) throw new Error('Falta el keyring de un perfil existente. No se regeneran claves ni se sustituyen sus datos/controles.');
    const cert = await prepareTls(settings);
    const build = spawn(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.local.json'], { cwd: serverRoot, windowsHide: true, stdio: 'inherit' });
    const [buildCode] = await once(build, 'exit');
    if (buildCode !== 0) throw new Error('Build del servidor falló; no se arranca código anterior como si fuera vigente.');
    const descriptor = { profile: 'installed-s02', mode: 'local-synthetic', mongoUri: mongo.mongoUri, databaseName: settings.database,
      keyringFile: settings.keyring, tenantOrigin: settings.tenantOrigin, platformOrigin: settings.platformOrigin, apiPort: settings.apiPort };
    await fs.writeFile(settings.descriptor, JSON.stringify(descriptor, null, 2), { mode: 0o600 });
    const childEnv = { ...env, CAUDELYX_MODE: 'local-synthetic', MONGODB_URI: mongo.mongoUri, MONGODB_DATABASE: settings.database,
      PORT: String(settings.apiPort), TENANT_ORIGIN: settings.tenantOrigin, PLATFORM_ORIGIN: settings.platformOrigin,
      KEYRING_FILE: settings.keyring, TLS_DIRECTORY: settings.tls, CAUDELYX_DEV_TLS_DIRECTORY: settings.tls, CAUDELYX_DEV_API_PORT: String(settings.apiPort) };
    api = spawn(process.execPath, ['dist-local/src/server.js'], { cwd: serverRoot, env: childEnv, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    record?.({event:'owned-child-created',kind:'api',pid:api.pid,spawnfile:api.spawnfile,spawnargs:api.spawnargs});
    const apiEnded = once(api, 'exit').then(() => { apiExited = true; throw new Error('API S02 detenida antes de completar la ejecución.'); });
    const waitApi = async () => { const deadline = Date.now() + 15000; while (Date.now() < deadline) {
      if (stopRequested || apiExited) return;
      // A01 intentionally stays available when closed. A07 returns 401 anonymously only when open.
      if (await ready(`https://127.0.0.1:${settings.apiPort}/api/v1/auth/me`, cert, `localhost:${settings.uiPort}`, [200, 401])) return;
      await new Promise(r => setTimeout(r, 200));
    } throw new Error('API S02 no disponible o realm cerrado; revisar evidencia, sin fallback.'); };
    await Promise.race([waitApi(), apiEnded]);
    if (stopRequested) return;
    ui = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', 'localhost', '--port', String(settings.uiPort), '--strictPort'],
      { cwd: path.join(projectRoot, 'cliente'), env: childEnv, windowsHide: true, stdio: 'inherit' });
    record?.({event:'owned-child-created',kind:'ui',pid:ui.pid,spawnfile:ui.spawnfile,spawnargs:ui.spawnargs});
    for (let n = 0; n < 60; n++) {
      if (stopRequested) return;
      if (ui.exitCode !== null) throw new Error('La interfaz S02 no pudo arrancar.');
      if (await ready(settings.tenantOrigin, cert)) break;
      if (n === 59) throw new Error('Timeout de la interfaz S02.');
      await new Promise(r => setTimeout(r, 200));
    }
    console.log(`S02 LOCAL SINTÉTICO: ${settings.tenantOrigin}; Mongo existente27017, base ${settings.database}. Ctrl+C conserva datos y controles.`);
    if (process.connected) process.send('S02_INSTALLED_READY');
    if (env.CAUDELYX_DEV_SMOKE === '1') return;
    await Promise.race([stopped, apiEnded, once(ui, 'exit').then(() => { throw new Error('Interfaz S02 detenida.'); })]);
  } finally {
    await stop(ui, false, record); await stop(api, true, record);
    await lock.close(); await fs.unlink(lockPath);
    if (process.connected) process.disconnect();
  }
}
