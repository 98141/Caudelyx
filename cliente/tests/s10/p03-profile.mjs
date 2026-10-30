import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile, rm, lstat, realpath, readdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createServer as probe } from 'node:net';
import { createServer } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(fileURLToPath(new URL('../../../../Caudelyx/servidor/package.json', import.meta.url)));
const { MongoClient } = require('mongodb');
const { generate } = require('otplib');

const servidor = fileURLToPath(new URL('../../../../Caudelyx/servidor/', import.meta.url));
const dist = fileURLToPath(new URL('../../../../Caudelyx/servidor/dist-s10-backend/', import.meta.url));
process.chdir(servidor);
const { purposeClass } = await import(new URL('src/modules/sessions/work-policy.js', 'file:///' + dist.replaceAll('\\', '/')));
const { Database } = await import(new URL('src/shared/database.js', 'file:///' + dist.replaceAll('\\', '/')));
const { Sessions } = await import(new URL('src/modules/sessions/service.js', 'file:///' + dist.replaceAll('\\', '/')));
const { SyntheticMessaging } = await import(new URL('src/modules/messaging/service.js', 'file:///' + dist.replaceAll('\\', '/')));
const { IdentityService } = await import(new URL('src/modules/identity/service.js', 'file:///' + dist.replaceAll('\\', '/')));
const { PasswordHasher } = await import(new URL('src/modules/identity/password.js', 'file:///' + dist.replaceAll('\\', '/')));
const { RestoreController } = await import(new URL('src/shared/restore.js', 'file:///' + dist.replaceAll('\\', '/')));
const { attachRuntime } = await import(new URL('src/shared/runtime.js', 'file:///' + dist.replaceAll('\\', '/')));
const { createApp } = await import(new URL('src/app.js', 'file:///' + dist.replaceAll('\\', '/')));

const id = randomBytes(12).toString('hex');
const root = resolve('.runtime');
const folder = join(root, 's10-p03-' + id);
const databaseName = 'caudelyx_s08_p02_' + id;
const names = [databaseName, databaseName + '_external_mail', databaseName + '_external_security'];
const log = resolve('../../Construccion/Sprints/S10/Evidencias/S10-P03-RESOURCES.jsonl');
const servers = [];
const clients = [];
export const password = 'Frase de prueba sintetica larga 9871236450';

function assertOwnUri(uri) {
  const u = new URL(uri);
  if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.port !== '27017' || u.searchParams.get('replicaSet') !== 'rs0') throw Error('Protected/unknown Mongo profile');
}
async function size(path) {
  let n = 0;
  for (const e of await readdir(path, { withFileTypes: true })) {
    const p = join(path, e.name), s = await lstat(p);
    if (s.isSymbolicLink()) throw Error('Refuse linked controls');
    n += e.isDirectory() ? await size(p) : s.size;
  }
  return n;
}
async function removeOwn(path) {
  if (resolve(path) !== folder || resolve(await realpath(path)) !== resolve(path) || (await lstat(path)).isSymbolicLink()) throw Error('Unowned control path');
  await rm(path, { recursive: true, force: false, maxRetries: 3 });
}

export async function p03Profile() {
  const executionId = randomUUID();
  await mkdir(dirname(log), { recursive: true });
  const receipt = async record => appendFile(log, JSON.stringify({ at: new Date().toISOString(), task: 'S10-P03', runId: executionId, groupId: id, ...record }) + '\n');
  const portProbe = probe().listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const address = portProbe.address();
  if (!address || typeof address === 'string' || [27017, 27181].includes(address.port)) throw Error('Protected test port');
  const port = address.port;
  await new Promise(r => portProbe.close(() => r()));
  await receipt({ event: 'reserved-before-create', ownerPid: process.pid, port, databases: names, folder, sharedMongo: true, budget: { groups: 1, mongoBytes: 268435456, controlBytes: 125829120 } });
  try { await lstat(folder); throw Error('Existing own resource'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await mkdir(root, { recursive: true });
  await mkdir(folder);
  const owner = { id, runId: executionId, pid: process.pid, names, port };
  await writeFile(join(folder, 'owner.json'), JSON.stringify(owner), { flag: 'wx' });
  let control, controlConnected = false, ownsDatabaseNames = false, disposed = false;
  const uri = 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
  const closeConsumers = async () => {
    for (const server of servers.splice(0)) await new Promise(r => server.close(() => r()));
    for (const db of clients.splice(0)) await db.close();
  };
  const dispose = async () => {
    if (disposed) return;
    try {
      if (JSON.stringify(JSON.parse(await readFile(join(folder, 'owner.json'), 'utf8'))) !== JSON.stringify(owner)) throw Error('Ownership changed');
      await closeConsumers();
      if (control && controlConnected && ownsDatabaseNames) {
        const topology = await control.db('admin').command({ hello: 1 });
        if (topology.setName !== 'rs0' || !topology.isWritablePrimary) throw Error('Unexpected installed topology');
        const stats = [];
        for (const name of names) {
          const s = await control.db(name).command({ dbStats: 1 });
          stats.push({ name, storageSize: s.storageSize, indexSize: s.indexSize });
        }
        const mongoBytes = stats.reduce((n, r) => n + Number(r.storageSize) + Number(r.indexSize), 0);
        const controlBytes = await size(folder);
        await receipt({ event: 'cleanup-before', stats, controlBytes, mongoBytes, overBudget: mongoBytes > 268435456 || controlBytes > 125829120 });
        for (const name of names) await control.db(name).dropDatabase();
        const remaining = await control.db('admin').command({ listDatabases: 1, nameOnly: true, filter: { name: { $in: names } } });
        if (remaining.databases.length) throw Error('Test databases remain');
        await control.close();
      }
      await removeOwn(folder);
      disposed = true;
      await receipt({ event: 'cleanup-complete', databases: names, remaining: 0, sharedMongoServiceUnchanged: true });
    } catch (error) {
      await receipt({ event: 'cleanup-failed', reason: String(error).slice(0, 200) });
      throw error;
    }
  };
  try {
    assertOwnUri(uri);
    control = new MongoClient(uri, { appName: 'S10_P03_CLEANUP' });
    await control.connect();
    controlConnected = true;
    const present = await control.db('admin').command({ listDatabases: 1, filter: { name: { $in: names } }, nameOnly: true });
    if (present.databases.length) throw Error('Pre-existing database name is not owned');
    ownsDatabaseNames = true;
    await receipt({ event: 'created', databases: names, port: 27017, folder, sharedMongo: true });
    const fixture = async () => {
      await closeConsumers();
      for (const name of names) await control.db(name).dropDatabase();
      const database = new Database(uri, databaseName, { monitorCommands: true });
      clients.push(database);
      await database.connect();
      const clock = { value: Date.parse('2026-10-28T12:00:00-05:00'), open: true };
      const now = () => clock.value;
      const keys = { version: 1, priority: randomBytes(32), mail: randomBytes(32), totp: randomBytes(32), journal: randomBytes(32), cursor: randomBytes(32) };
      const restore = new RestoreController(database, join(folder, 'gate.json'), keys.journal, keys.priority, keys.cursor);
      await restore.initialize();
      const sessions = new Sessions(database, now);
      const messages = new SyntheticMessaging(database, keys.mail, now);
      const identity = new IdentityService(database, sessions, messages, new PasswordHasher(), () => clock.open && restore.isOpen(), now);
      await identity.initialize();
      const config = { mongoUri: uri, databaseName, port: 0, tenantOrigin: 'https://localhost:0', platformOrigin: 'https://platform.localhost:0' };
      const runtime = await attachRuntime(identity, keys, config);
      const actor = async () => {
        const anonymous = await sessions.issue('TENANT', 'P', null);
        const email = randomUUID() + '@example.test';
        const registered = await identity.register('TENANT', randomUUID(), { email, displayName: 'Persona sintética', privacyPolicyVersion: 'synthetic-v1', password }, anonymous.context);
        await identity.dispatchMail();
        const subject = await identity.identities.findOne({ email });
        const mail = [...messages.inbox.values()].find(m => m.subjectId === subject._id && m.purpose === 'ACTIVATION');
        const confirmed = await identity.confirmEmail(registered.issued.context, { purpose: 'ACTIVATION', token: mail.token });
        const enrollment = await runtime.totp.enroll(confirmed.issued.context, 'Prueba', password);
        const secret = new URL(enrollment.provisioningUri).searchParams.get('secret');
        const completed = await runtime.totp.confirm(confirmed.issued.context, enrollment.enrollmentId, await generate({ secret, epoch: Math.floor(now() / 1000) }));
        return { email, secret, issued: completed.issued };
      };
      const proof = async (a, purpose, command, resourceId) => {
        const kind = purposeClass(purpose);
        const current = await sessions.contexts.findOne({ _id: a.issued.context._id });
        if (kind === 'WORK_ONLY' || kind === 'BALANCE_60M' && current?.balanceGrant && current.balanceGrant.expiresAt > now()) return a.issued;
        const result = await identity.work.prepare(a.issued.context, { purpose, method: 'TOTP', ...(command ? { command } : {}), ...(resourceId ? { resourceId } : {}) });
        clock.value += 30000;
        a.issued = (await identity.work.verify(a.issued.context, { intentId: result.intentId, method: 'TOTP', code: await generate({ secret: a.secret, epoch: Math.floor(now() / 1000) }) })).issued;
        return a.issued;
      };
      const https = async () => {
        await promisify(execFile)('C:/Program Files/Git/usr/bin/openssl.exe', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(folder, 'key.pem'), '-out', join(folder, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { windowsHide: true });
        const cert = await readFile(join(folder, 'cert.pem')), key = await readFile(join(folder, 'key.pem'));
        const reservation = probe().listen(0, '127.0.0.1');
        await once(reservation, 'listening');
        const reserved = reservation.address();
        if (!reserved || typeof reserved === 'string' || [27017, 27181].includes(reserved.port)) throw Error('Protected HTTPS port');
        await new Promise(r => reservation.close(() => r()));
        const directory = resolve('../cliente/dist');
        const app = createApp({ identity, config });
        const server = createServer({ cert, key }, (req, res) => {
          if ((req.url ?? '').toLowerCase().startsWith('/api/')) return app(req, res);
          void (async () => {
            const url = new URL(req.url ?? '/', 'https://localhost');
            const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
            const file = resolve(directory, relative || 'index.html');
            if (!file.startsWith(directory)) { res.statusCode = 404; res.end(); return; }
            const bytes = await readFile(file);
            res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
            res.setHeader('Cache-Control', 'no-store');
            res.end(bytes);
          })().catch(() => { res.statusCode = 404; res.end(); });
        });
        servers.push(server);
        server.listen(reserved.port, '127.0.0.1');
        await once(server, 'listening');
        const listening = server.address();
        config.tenantOrigin = 'https://localhost:' + listening.port;
        config.platformOrigin = 'https://platform.localhost:' + listening.port;
        Object.assign(runtime.webauthn.origins, { TENANT: config.tenantOrigin, PLATFORM: config.platformOrigin });
        await receipt({ event: 'https-created', port: listening.port });
        return { port: listening.port, cert };
      };
      return { database, clock, now, keys, restore, identity, runtime, config, actor, proof, https };
    };
    return { runId: executionId, groupId: id, names, folder, fixture, dispose };
  } catch (error) {
    await receipt({ event: 'setup-failed', reason: String(error).slice(0, 300) });
    await dispose();
    throw error;
  }
}
