/* Own S08-P03 group on the installed replica. Does not stop Mongo and does not touch caudelyx_dev. */
import { purposeClass } from '../../../servidor/dist-s08-projection/src/modules/sessions/work-policy.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile, rm, lstat, realpath, readdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createServer as probe } from 'node:net';
import { createServer } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chdir } from 'node:process';
const { MongoClient } = await import(pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../../../servidor/node_modules/mongodb/lib/index.js')).href);
const { generate } = await import(pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../../../servidor/node_modules/otplib/dist/index.js')).href);
import { Database } from '../../../servidor/dist-s08-projection/src/shared/database.js';
import { Sessions } from '../../../servidor/dist-s08-projection/src/modules/sessions/service.js';
import { SyntheticMessaging } from '../../../servidor/dist-s08-projection/src/modules/messaging/service.js';
import { IdentityService } from '../../../servidor/dist-s08-projection/src/modules/identity/service.js';
import { PasswordHasher } from '../../../servidor/dist-s08-projection/src/modules/identity/password.js';
import { RestoreController } from '../../../servidor/dist-s08-projection/src/shared/restore.js';
import { attachRuntime } from '../../../servidor/dist-s08-projection/src/shared/runtime.js';
import { createApp } from '../../../servidor/dist-s08-projection/src/app.js';
import { ApiClient } from '../../../servidor/dist-s08-projection/tests/helpers/client.js';

const servidor = resolve(dirname(fileURLToPath(import.meta.url)), '../../../servidor');
chdir(servidor);

const id = 'c8b2026e10a64d42a01c7c86';
const root = resolve('.runtime');
const folder = join(root, 's08-p03-' + id);
const databaseName = 'caudelyx_s08_p03_' + id;
const names = [databaseName, databaseName + '_external_mail', databaseName + '_external_security'];
const log = resolve('../../Construccion/Sprints/S08/Evidencias/S08-P03-RESOURCES.jsonl');
const servers = [];
const clients = [];
export const password = 'Frase de prueba sintetica larga 9871236450';

async function receipt(record) {
  await appendFile(log, JSON.stringify({ at: new Date().toISOString(), task: 'S08-P03', ...record }) + '\n');
}
export function assertOwnUri(uri) {
  const u = new URL(uri);
  if (u.hostname !== '127.0.0.1' || u.port !== '27017' || u.searchParams.get('replicaSet') !== 'rs0') throw Error('Protected/unknown Mongo profile');
}
async function size(path) {
  let n = 0;
  for (const e of await readdir(path, { withFileTypes: true })) {
    const p = join(path, e.name);
    const s = await lstat(p);
    if (s.isSymbolicLink()) throw Error('Refuse linked controls');
    n += e.isDirectory() ? await size(p) : s.size;
  }
  return n;
}
async function removeOwn(path) {
  if (resolve(path) !== folder || resolve(await realpath(path)) !== resolve(path) || (await lstat(path)).isSymbolicLink()) throw Error('Unowned control path');
  if (resolve(await realpath(root)) !== root) throw Error('Linked runtime root');
  await size(path);
  await rm(path, { recursive: true, force: false, maxRetries: 3 });
}

export async function p03Profile() {
  const executionId = randomUUID();
  const note = record => receipt({ ...record, runId: executionId, groupId: id });
  await note({ event: 'reserved-before-create', ownerPid: process.pid, databases: names, folder, sharedMongo: true, budget: { groups: 1, mongoStorageAndIndexBytes: 262144000, controlBytes: 125829120 } });
  try {
    await lstat(folder);
    await note({ event: 'existing-resource-blocked', path: folder, resourcesCreated: 0 });
    throw Error('Existing own resource requires inventory before reuse');
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
  await mkdir(root, { recursive: true });
  if (resolve(await realpath(root)) !== root || (await lstat(root)).isSymbolicLink()) throw Error('Linked runtime root');
  await mkdir(folder);
  const owner = { id, runId: executionId, pid: process.pid, nonce: randomUUID(), names };
  await writeFile(join(folder, 'owner.json'), JSON.stringify(owner), { flag: 'wx' });
  const uri = 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
  let control;
  let disposed = false;
  const closeConsumers = async () => {
    for (const server of servers.splice(0)) await new Promise(r => server.close(() => r()));
    for (const db of clients.splice(0)) await db.close();
  };
  const dispose = async () => {
    if (disposed) return;
    try {
      if (JSON.stringify(JSON.parse(await readFile(join(folder, 'owner.json'), 'utf8'))) !== JSON.stringify(owner)) throw Error('Ownership changed');
      await closeConsumers();
      const stats = [];
      if (control) {
        const topology = await control.db('admin').command({ hello: 1 });
        if (topology.setName !== 'rs0' || !topology.isWritablePrimary) throw Error('Unexpected installed topology');
        const foreign = await control.db('admin').aggregate([
          { $currentOp: { allUsers: true, idleConnections: true, idleSessions: true } },
          { $match: { 'clientMetadata.application.name': { $ne: 'S08_P03_CLEANUP' }, $or: [{ 'command.$db': { $in: names } }, { $expr: { $in: [{ $arrayElemAt: [{ $split: [{ $ifNull: ['$ns', ''] }, '.'] }, 0] }, names] } }] } },
          { $project: { _id: 0, active: 1 } },
        ]).toArray();
        if (foreign.length) throw Error('Unclosed or unknown fixture consumer');
        for (const name of names) {
          const s = await control.db(name).command({ dbStats: 1 });
          stats.push({ name, dataSize: s.dataSize, storageSize: s.storageSize, indexSize: s.indexSize });
        }
        const controlBytes = await size(folder);
        const mongoBytes = stats.reduce((n, r) => n + Number(r.storageSize) + Number(r.indexSize), 0);
        await note({ event: 'cleanup-before', stats, controlBytes, mongoBytes, overBudget: mongoBytes > 262144000 || controlBytes > 125829120 });
        for (const name of names) await control.db(name).dropDatabase();
        const remaining = await control.db('admin').command({ listDatabases: 1, nameOnly: true, filter: { name: { $in: names } } });
        if (remaining.databases.length) throw Error('Test databases remain');
        await control.close();
        control = undefined;
      }
      await removeOwn(folder);
      disposed = true;
      await note({ event: 'cleanup-complete', databases: names, remaining: 0, controlRemoved: true, sharedMongoServiceUnchanged: true });
    } catch (error) {
      await note({ event: 'cleanup-failed', reason: String(error).slice(0, 200), retainUntil: new Date(Date.now() + 86400000).toISOString() });
      throw error;
    }
  };
  try {
    assertOwnUri(uri);
    control = new MongoClient(uri, { appName: 'S08_P03_CLEANUP' });
    await control.connect();
    await note({ event: 'created', databases: names, port: 27017, folder, sharedMongo: true });
    const fixture = async (options = {}) => {
      await closeConsumers();
      const prior = [];
      for (const name of names) {
        const s = await control.db(name).command({ dbStats: 1 });
        prior.push({ name, dataSize: s.dataSize, storageSize: s.storageSize, indexSize: s.indexSize });
      }
      const controlBytes = await size(folder);
      const mongoBytes = prior.reduce((n, r) => n + Number(r.storageSize) + Number(r.indexSize), 0);
      await note({ event: 'reuse-before', stats: prior, controlBytes, mongoBytes });
      if (mongoBytes > 262144000 || controlBytes > 125829120) throw Error('Own resource budget exceeded');
      for (const name of names) await control.db(name).dropDatabase();
      for (const e of await readdir(folder)) if (e !== 'owner.json') {
        const p = join(folder, e);
        const s = await lstat(p);
        if (s.isDirectory() || s.isSymbolicLink()) throw Error('Unexpected test control');
        await rm(p);
      }
      await note({ event: 'group-reused', databases: names });
      const database = new Database(uri, databaseName);
      clients.push(database);
      await database.connect();
      const clock = { value: Math.floor(Date.now() / 30000) * 30000 + 1000, open: true };
      const now = () => clock.value;
      const keys = { version: 1, ...(options.legacy ? {} : { priority: randomBytes(32) }), mail: randomBytes(32), totp: randomBytes(32), journal: randomBytes(32), cursor: randomBytes(32) };
      const restore = new RestoreController(database, join(folder, 'gate.json'), keys.journal, keys.priority, keys.cursor);
      await restore.initialize();
      const sessions = new Sessions(database, now);
      const messages = new SyntheticMessaging(database, keys.mail, now);
      const identity = new IdentityService(database, sessions, messages, new PasswordHasher(), () => clock.open && restore.isOpen(), now);
      await identity.initialize();
      const config = { mongoUri: uri, databaseName, port: 0, tenantOrigin: 'https://localhost:0', platformOrigin: 'https://platform.localhost:0' };
      const runtime = await attachRuntime(identity, keys, config);
      const signup = async () => {
        const anonymous = await sessions.issue('TENANT', 'P', null);
        const email = randomUUID() + '@example.test';
        const registered = await identity.register('TENANT', randomUUID(), { email, displayName: 'Persona sintética', privacyPolicyVersion: 'synthetic-v1', password }, anonymous.context);
        if (!registered.issued) throw Error('No basic session');
        await identity.dispatchMail();
        const subject = await identity.identities.findOne({ email });
        const mail = [...messages.inbox.values()].find(m => m.subjectId === subject._id && m.purpose === 'ACTIVATION');
        if (!mail) throw Error('No activation');
        return { email, issued: registered.issued, token: mail.token };
      };
      const actor = async () => {
        const a = await signup();
        const confirmed = await identity.confirmEmail(a.issued.context, { purpose: 'ACTIVATION', token: a.token });
        const context = confirmed.issued.context;
        const enrollment = await runtime.totp.enroll(context, 'Prueba', password);
        const secret = new URL(enrollment.provisioningUri).searchParams.get('secret');
        const completed = await runtime.totp.confirm(context, enrollment.enrollmentId, await generate({ secret, epoch: Math.floor(now() / 1000) }));
        if (!completed.issued) throw Error('No strong session');
        return { email: a.email, secret, issued: completed.issued };
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
      const https = async (withClient = false) => {
        await promisify(execFile)('C:/Program Files/Git/usr/bin/openssl.exe', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(folder, 'key.pem'), '-out', join(folder, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,DNS:platform.localhost,IP:127.0.0.1'], { windowsHide: true });
        const cert = await readFile(join(folder, 'cert.pem'));
        const key = await readFile(join(folder, 'key.pem'));
        const reservation = probe().listen(0, '127.0.0.1');
        await once(reservation, 'listening');
        const reserved = reservation.address();
        if (!reserved || typeof reserved === 'string' || [27017, 27181].includes(reserved.port)) throw Error('Protected HTTPS port');
        await new Promise(r => reservation.close(() => r()));
        await note({ event: 'https-reserved-before-listen', port: reserved.port });
        const app = createApp({ identity, config });
        const server = createServer({ cert, key }, (req, res) => {
          if (!withClient || (req.url ?? '').toLowerCase().startsWith('/api/')) return app(req, res);
          void (async () => {
            const directory = resolve('../cliente/dist');
            const url = new URL(req.url ?? '/', 'https://localhost');
            const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
            const file = resolve(directory, relative || 'index.html');
            if (!file.startsWith(directory + '/') && !file.startsWith(directory + '\\') && file !== join(directory, 'index.html')) { res.statusCode = 404; res.end(); return; }
            try {
              const bytes = await readFile(file);
              const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream';
              res.setHeader('Content-Type', type);
              res.setHeader('Cache-Control', 'no-store');
              res.end(bytes);
            } catch { res.statusCode = 404; res.end(); }
          })().catch(() => { res.statusCode = 503; res.end(); });
        });
        servers.push(server);
        server.listen(reserved.port, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw Error('No HTTPS listener');
        config.tenantOrigin = 'https://localhost:' + address.port;
        config.platformOrigin = 'https://platform.localhost:' + address.port;
        Object.assign(runtime.webauthn.origins, { TENANT: config.tenantOrigin, PLATFORM: config.platformOrigin });
        await note({ event: 'https-created', port: address.port });
        return { client: new ApiClient(address.port, cert), port: address.port, cert };
      };
      return { database, clock, now, keys, restore, sessions, messages, identity, runtime, config, signup, actor, proof, https, proxy: async () => { throw Error('Proxy not used by this walk'); } };
    };
    return { fixture, dispose, folder, names, port: 27017, uri };
  } catch (error) {
    await note({ event: 'setup-failed', reason: String(error) });
    await dispose();
    throw error;
  }
}
