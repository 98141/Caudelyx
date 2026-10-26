/* Own S06-P03 group. Does not call the P02 profile and does not append its receipt log. */
import { purposeClass } from '../../../servidor/dist-s06/src/modules/sessions/work-policy.js';
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
import { Database } from '../../../servidor/dist-s06/src/shared/database.js';
import { Sessions } from '../../../servidor/dist-s06/src/modules/sessions/service.js';
import { SyntheticMessaging } from '../../../servidor/dist-s06/src/modules/messaging/service.js';
import { IdentityService } from '../../../servidor/dist-s06/src/modules/identity/service.js';
import { PasswordHasher } from '../../../servidor/dist-s06/src/modules/identity/password.js';
import { RestoreController } from '../../../servidor/dist-s06/src/shared/restore.js';
import { attachRuntime } from '../../../servidor/dist-s06/src/shared/runtime.js';
import { createApp } from '../../../servidor/dist-s06/src/app.js';
import { startReplicaSet } from '../../../servidor/dist-s06/tests/helpers/replica-set.js';
import { ApiClient } from '../../../servidor/dist-s06/tests/helpers/client.js';

const servidor = resolve(dirname(fileURLToPath(import.meta.url)), '../../../servidor');
chdir(servidor);

const id = 'c6b2026e10a64d42a01c7c81';
const uuid = 'c6b2026e-10a6-4d42-a01c-7c81ecb80603';
const root = resolve('.runtime');
const folder = join(root, 's06-p03-' + id);
const mongoFolder = join(root, 'manual-test-' + uuid);
const databaseName = 'caudelyx_s06_p03_' + id;
const names = [databaseName, databaseName + '_external_mail', databaseName + '_external_security'];
const log = resolve('../../Construccion/Sprints/S06/Evidencias/S06-P03-RESOURCES.jsonl');
const servers = [];
const clients = [];
export const password = 'Frase de prueba sintetica larga 9871236450';

async function receipt(record) {
  await appendFile(log, JSON.stringify({ at: new Date().toISOString(), task: 'S06-P03', ...record }) + '\n');
}
export function assertOwnUri(uri) {
  const u = new URL(uri);
  if (u.hostname !== '127.0.0.1' || !u.port || ['27017', '27181'].includes(u.port) || u.searchParams.get('replicaSet') !== 'caudelyx-manual') throw Error('Protected/unknown Mongo profile');
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
  if (![folder, mongoFolder].includes(resolve(path)) || resolve(await realpath(path)) !== resolve(path) || (await lstat(path)).isSymbolicLink()) throw Error('Unowned control path');
  if (resolve(await realpath(root)) !== root) throw Error('Linked runtime root');
  await size(path);
  await rm(path, { recursive: true, force: false, maxRetries: 3 });
}

export async function p03Profile() {
  const executionId = randomUUID();
  const note = record => receipt({ ...record, runId: executionId, groupId: id });
  const portProbe = probe().listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const address = portProbe.address();
  if (!address || typeof address === 'string' || [27017, 27181].includes(address.port)) throw Error('Protected test port');
  const port = address.port;
  await new Promise(r => portProbe.close(() => r()));
  await note({ event: 'reserved-before-create', ownerPid: process.pid, port, databases: names, folder, mongoFolder, budget: { groups: 1, mongoStorageAndIndexBytes: 262144000, dbPathBytes: 536870912, controlBytes: 125829120 } });
  for (const path of [folder, mongoFolder]) {
    try {
      await lstat(path);
      await note({ event: 'existing-resource-blocked', path, resourcesCreated: 0 });
      throw Error('Existing own resource requires inventory before reuse');
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
    }
  }
  await mkdir(root, { recursive: true });
  if (resolve(await realpath(root)) !== root || (await lstat(root)).isSymbolicLink()) throw Error('Linked runtime root');
  await mkdir(folder);
  const owner = { id, runId: executionId, pid: process.pid, nonce: randomUUID(), names, port };
  await writeFile(join(folder, 'owner.json'), JSON.stringify(owner), { flag: 'wx' });
  let replica;
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
        const topology = await control.db('admin').command({ getCmdLineOpts: 1 });
        const parsed = topology.parsed;
        if (!parsed.storage?.dbPath || resolve(parsed.storage.dbPath) !== mongoFolder) throw Error('Unknown Mongo process');
        const foreign = await control.db('admin').aggregate([
          { $currentOp: { allUsers: true, idleConnections: true, idleSessions: true } },
          { $match: { 'clientMetadata.application.name': { $ne: 'S06_P03_CLEANUP' }, $or: [{ 'command.$db': { $in: names } }, { $expr: { $in: [{ $arrayElemAt: [{ $split: [{ $ifNull: ['$ns', ''] }, '.'] }, 0] }, names] } }] } },
          { $project: { _id: 0, active: 1 } },
        ]).toArray();
        if (foreign.length) throw Error('Unclosed or unknown fixture consumer');
        for (const name of names) {
          const s = await control.db(name).command({ dbStats: 1 });
          stats.push({ name, dataSize: s.dataSize, storageSize: s.storageSize, indexSize: s.indexSize });
        }
        const controlBytes = await size(folder);
        const dbPathBytes = await size(mongoFolder);
        const mongoBytes = stats.reduce((n, r) => n + Number(r.storageSize) + Number(r.indexSize), 0);
        await note({ event: 'cleanup-before', stats, controlBytes, dbPathBytes, mongoBytes, overBudget: mongoBytes > 262144000 || dbPathBytes > 536870912 || controlBytes > 125829120 });
        for (const name of names) await control.db(name).dropDatabase();
        const remaining = await control.db('admin').command({ listDatabases: 1, nameOnly: true, filter: { name: { $in: names } } });
        if (remaining.databases.length) throw Error('Test databases remain');
        await control.close();
        control = undefined;
      }
      try {
        await replica?.stop();
      } catch (error) {
        const rows = (await readFile(join(mongoFolder, 'mongo.log'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
        const started = rows.find(row => row.msg === 'MongoDB starting');
        const pid = started?.attr?.pid;
        if (!pid || !started?.attr?.dbPath || resolve(started.attr.dbPath) !== mongoFolder) throw error;
        let absent = false;
        try { process.kill(pid, 0); } catch (e) { if (e?.code === 'ESRCH') absent = true; else throw e; }
        if (!absent) throw error;
        await new Promise((resolvePort, reject) => { const check = probe(); check.once('error', reject); check.listen(port, '127.0.0.1', () => check.close(() => resolvePort())); });
        await note({ event: 'cleanup-stop-timeout-recovered', pid, port, ownPIDAbsent: true, ownPortAbsent: true, reason: String(error) });
      }
      try { await removeOwn(mongoFolder); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
      await removeOwn(folder);
      disposed = true;
      await note({ event: 'cleanup-complete', databases: names, remaining: 0, controlRemoved: true, mongoProcessStopped: true });
    } catch (error) {
      await note({ event: 'cleanup-failed', reason: String(error).slice(0, 200), retainUntil: new Date(Date.now() + 86400000).toISOString() });
      throw error;
    }
  };
  try {
    replica = await startReplicaSet({ manualProfile: 'test-' + uuid, port });
    assertOwnUri(replica.uri);
    control = new MongoClient(replica.uri, { appName: 'S06_P03_CLEANUP' });
    await control.connect();
    await note({ event: 'created', databases: names, port, folder, mongoFolder });
    const fixture = async (options = {}) => {
      await closeConsumers();
      for (const name of names) await control.db(name).dropDatabase();
      for (const e of await readdir(folder)) if (e !== 'owner.json') {
        const p = join(folder, e);
        const s = await lstat(p);
        if (s.isDirectory() || s.isSymbolicLink()) throw Error('Unexpected test control');
        await rm(p);
      }
      await note({ event: 'group-reused', databases: names });
      const database = new Database(replica.uri, databaseName);
      clients.push(database);
      await database.connect();
      const clock = { value: Math.floor(Date.now() / 30000) * 30000 + 1000, open: true };
      const now = () => clock.value;
      const keys = { version: 1, ...(options.legacy ? {} : { priority: randomBytes(32) }), mail: randomBytes(32), totp: randomBytes(32), journal: randomBytes(32), cursor: randomBytes(32) };
      const restore = new RestoreController(database, join(folder, 'gate.json'), keys.journal, keys.priority);
      await restore.initialize();
      const sessions = new Sessions(database, now);
      const messages = new SyntheticMessaging(database, keys.mail, now);
      const identity = new IdentityService(database, sessions, messages, new PasswordHasher(), () => clock.open && restore.isOpen(), now);
      await identity.initialize();
      const config = { mongoUri: replica.uri, databaseName, port: 0, tenantOrigin: 'https://localhost:0', platformOrigin: 'https://platform.localhost:0' };
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
        if (!reserved || typeof reserved === 'string' || [27017, 27181, port].includes(reserved.port)) throw Error('Protected HTTPS port');
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
        const a = server.address();
        if (!a || typeof a === 'string') throw Error('No HTTPS listener');
        config.tenantOrigin = 'https://localhost:' + a.port;
        config.platformOrigin = 'https://platform.localhost:' + a.port;
        Object.assign(runtime.webauthn.origins, { TENANT: config.tenantOrigin, PLATFORM: config.platformOrigin });
        await note({ event: 'https-created', port: a.port });
        return { client: new ApiClient(a.port, cert), port: a.port, cert };
      };
      return { database, clock, now, keys, restore, sessions, messages, identity, runtime, config, signup, actor, proof, https };
    };
    return { fixture, dispose, folder, names, port, uri: replica.uri };
  } catch (error) {
    let startupTail = '';
    try { startupTail = (await readFile(join(mongoFolder, 'mongo.log'), 'utf8')).split('\n').slice(-8).join('\n'); } catch { /* before its own log exists */ }
    await note({ event: 'setup-failed', reason: String(error), startupTail });
    await dispose();
    throw error;
  }
}
