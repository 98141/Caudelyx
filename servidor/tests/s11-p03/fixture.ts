import { ProjectionRuntime } from '../../src/modules/reporting/projection/service.js';
import { managementContract } from '../../src/modules/obligations/contract.js';
import { today } from '../../src/modules/obligations/calendar.js';
import type { Data } from '../../src/modules/obligations/models.js';
/* eslint-disable security/detect-non-literal-fs-filename -- Exact registered test paths, never HTTP input. */
import { purposeClass } from '../../src/modules/sessions/work-policy.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile, rm, lstat, realpath, readdir, rmdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer as probe } from 'node:net';
import { createServer } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { MongoClient } from 'mongodb';
import { generate } from 'otplib';
import { Database } from '../../src/shared/database.js';
import { Sessions } from '../../src/modules/sessions/service.js';
import { SyntheticMessaging } from '../../src/modules/messaging/service.js';
import { IdentityService } from '../../src/modules/identity/service.js';
import { PasswordHasher } from '../../src/modules/identity/password.js';
import { RestoreController } from '../../src/shared/restore.js';
import { attachRuntime } from '../../src/shared/runtime.js';
import { createApp } from '../../src/app.js';

const id = randomBytes(12).toString('hex');
const root = resolve('.runtime');
const folder = join(root, 's11-p03-' + id);
// Product prepareOwned/createOwned accept only this name shape. The suffix is a new id, checked absent before create.
const databaseName = 'caudelyx_s08_p02_' + id;
const names = [databaseName, databaseName + '_external_mail', databaseName + '_external_security'];
const log = resolve('../../Construccion/Sprints/S11/Evidencias/S11-P03-RESOURCES.jsonl');
const protectedPorts = new Set([27017, 27181, 3001, 3002, 4001]);
const servers: ReturnType<typeof createServer>[] = [];
const clients: Database[] = [];
export const password = 'Frase de prueba sintetica larga 9871236450';
const appendReceipt = async (record: Record<string, unknown>) => await appendFile(log, JSON.stringify({ at: new Date().toISOString(), task: 'S11-P03', ...record }) + '\n');

export function assertOwnUri(uri: string) {
  const u = new URL(uri);
  if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.port !== '27017' || u.searchParams.get('replicaSet') !== 'rs0') throw Error('Protected/unknown Mongo profile');
}

async function size(path: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(path, { withFileTypes: true })) {
    const p = join(path, e.name), s = await lstat(p);
    if (s.isSymbolicLink()) throw Error('Refuse linked controls');
    n += e.isDirectory() ? await size(p) : s.size;
  }
  return n;
}

async function removeOwn(path: string) {
  if (![folder].includes(resolve(path)) || resolve(await realpath(path)) !== resolve(path) || (await lstat(path)).isSymbolicLink()) throw Error('Unowned control path');
  if (resolve(await realpath(root)) !== root) throw Error('Linked runtime root');
  await size(path);
  await rm(path, { recursive: true, force: false, maxRetries: 3 });
}

export async function s11Profile() {
  const executionId = randomUUID();
  const receipt = (record: Record<string, unknown>) => appendReceipt({ ...record, runId: executionId, groupId: id });
  const portProbe = probe().listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const address = portProbe.address();
  if (!address || typeof address === 'string' || protectedPorts.has(address.port)) throw Error('Protected test port');
  const port = address.port;
  await new Promise<void>(r => portProbe.close(() => r()));
  await receipt({ event: 'reserved-before-create', runId: id, ownerPid: process.pid, port, databases: names, folder, privateRoot: join(folder, 'private'), controls: ['owner.json', 'gate.json', 'key.pem', 'cert.pem'], sharedMongo: true, nameConstraint: 'product regex caudelyx_s08_p02_[24 hex], new suffix, not a reused P02 id', budget: { groups: 1, mongoStorageAndIndexBytes: 805306368, dbPathBytes: 536870912, controlBytes: 125829120 } });
  for (const path of [folder]) {
    try { await lstat(path); await receipt({ event: 'existing-resource-blocked', path, resourcesCreated: 0 }); throw Error('Existing own resource requires inventory before reuse'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  await mkdir(root, { recursive: true });
  if (resolve(await realpath(root)) !== root || (await lstat(root)).isSymbolicLink()) throw Error('Linked runtime root');
  await mkdir(folder);
  const owner = { id, runId: executionId, pid: process.pid, nonce: randomUUID(), names, port };
  await writeFile(join(folder, 'owner.json'), JSON.stringify(owner), { flag: 'wx' });
  const replica = { uri: 'mongodb://127.0.0.1:27017/?replicaSet=rs0', stop: async () => {} };
  let control: MongoClient | undefined;
  let controlConnected = false;
  let ownsDatabaseNames = false;
  let disposed = false;
  let liveLeases = 0;
  const closeConsumers = async () => {
    for (const server of servers.splice(0)) await new Promise<void>(r => server.close(() => r()));
    for (const db of clients.splice(0)) await db.close();
  };
  const dispose = async () => {
    const cleanupStarted = performance.now();
    if (disposed) return;
    if (liveLeases) { await receipt({ event: 'cleanup-blocked-live-lease', runId: id }); throw Error('Own fixture lease is live'); }
    try {
      if (JSON.stringify(JSON.parse(await readFile(join(folder, 'owner.json'), 'utf8'))) !== JSON.stringify(owner)) throw Error('Ownership changed');
      await closeConsumers();
      const stats = [];
      if (control && controlConnected && ownsDatabaseNames) {
        const topology = await control.db('admin').command({ hello: 1 });
        if (topology['setName'] !== 'rs0' || !topology['isWritablePrimary']) throw Error('Unexpected installed topology');
        const foreign = await control.db('admin').aggregate([
          { $currentOp: { allUsers: true, idleConnections: true, idleSessions: true } },
          { $match: { 'clientMetadata.application.name': { $ne: 'S11_P03_CLEANUP' }, $or: [{ 'command.$db': { $in: names } }, { $expr: { $in: [{ $arrayElemAt: [{ $split: [{ $ifNull: ['$ns', ''] }, '.'] }, 0] }, names] } }] } },
          { $project: { _id: 0, active: 1 } },
        ]).toArray();
        if (foreign.length) throw Error('Unclosed or unknown fixture consumer');
        for (const name of names) {
          const s = await control.db(name).command({ dbStats: 1 });
          stats.push({ name, dataSize: s['dataSize'], storageSize: s['storageSize'], indexSize: s['indexSize'] });
        }
        const controlBytes = await size(folder), dbPathBytes = 0, mongoBytes = stats.reduce((n, r) => n + Number(r.storageSize) + Number(r.indexSize), 0);
        await receipt({ event: 'cleanup-before', stats, controlBytes, dbPathBytes, mongoBytes, overBudget: mongoBytes > 805306368 || dbPathBytes > 536870912 || controlBytes > 125829120 });
        for (const name of names) await control.db(name).dropDatabase();
        const remaining = await control.db('admin').command({ listDatabases: 1, nameOnly: true, filter: { name: { $in: names } } });
        if ((remaining['databases'] as unknown[]).length) throw Error('Test databases remain');
        await control.close();
        control = undefined;
      }
      if (control && (!controlConnected || !ownsDatabaseNames)) { await control.close(); control = undefined; }
      await removeOwn(folder);
      disposed = true;
      await receipt({ event: 'cleanup-complete', databases: names, remaining: ownsDatabaseNames ? 0 : null, absenceVerified: ownsDatabaseNames, createdDatabaseNames: ownsDatabaseNames ? names : [], controlRemoved: true, sharedMongoServiceUnchanged: true, durationMs: performance.now() - cleanupStarted });
    } catch (error) {
      await receipt({ event: 'cleanup-failed', reason: String(error).slice(0, 200), retainUntil: new Date(Date.now() + 86400000).toISOString() });
      throw error;
    }
  };
  try {
    assertOwnUri(replica.uri);
    control = new MongoClient(replica.uri, { appName: 'S11_P03_CLEANUP' });
    await control.connect();
    controlConnected = true;
    const present = await control.db('admin').command({ listDatabases: 1, filter: { name: { $in: names } }, nameOnly: true });
    if (present['databases'].length) throw Error('Pre-existing database name is not owned; refuse adoption or cleanup');
    ownsDatabaseNames = true;
    await receipt({ event: 'created', databases: names, port: 27017, folder, sharedMongo: true });
    const fixture = async () => {
      if (liveLeases) { await receipt({ event: 'reuse-blocked-live-lease' }); throw Error('Own fixture lease is live'); }
      await closeConsumers();
      const consumers = await control!.db('admin').aggregate([
        { $currentOp: { allUsers: true, idleConnections: true, idleSessions: true } },
        { $match: { 'clientMetadata.application.name': { $ne: 'S11_P03_CLEANUP' }, $or: [{ 'command.$db': { $in: names } }, { $expr: { $in: [{ $arrayElemAt: [{ $split: [{ $ifNull: ['$ns', ''] }, '.'] }, 0] }, names] } }] } },
        { $project: { _id: 0, active: 1 } },
      ]).toArray();
      if (consumers.length) throw Error('Refuse group reuse with a live or unknown consumer');
      const prior = [];
      for (const name of names) {
        const s = await control!.db(name).command({ dbStats: 1 });
        prior.push({ name, dataSize: s['dataSize'], storageSize: s['storageSize'], indexSize: s['indexSize'] });
      }
      const controlBytes = await size(folder), mongoBytes = prior.reduce((n, r) => n + Number(r.storageSize) + Number(r.indexSize), 0);
      await receipt({ event: 'reuse-before', stats: prior, controlBytes, mongoBytes });
      if (mongoBytes > 805306368 || controlBytes > 125829120) throw Error('Own resource budget exceeded');
      for (const name of names) await control!.db(name).dropDatabase();
      for (const e of await readdir(folder)) if (e !== 'owner.json') {
        const p = join(folder, e), stat = await lstat(p);
        if (stat.isSymbolicLink()) throw Error('Unexpected linked control');
        if (stat.isDirectory()) {
          if (e !== 'private' || await realpath(p) !== p) throw Error('Unknown directory');
          for (const name of await readdir(p)) {
            if (!/^[a-f0-9-]{36}(?:\.part)?$/.test(name) || (await lstat(join(p, name))).isSymbolicLink()) throw Error('Unknown private object');
            await rm(join(p, name));
          }
          await rmdir(p);
        } else await rm(p);
      }
      await receipt({ event: 'group-reused', databases: names });
      const database = new Database(replica.uri, databaseName, { monitorCommands: true });
      clients.push(database);
      await database.connect();
      const clock = { value: Math.floor(Date.now() / 30000) * 30000 + 1000, open: true }, now = () => clock.value;
      const keys = { version: 1 as const, priority: randomBytes(32), mail: randomBytes(32), totp: randomBytes(32), journal: randomBytes(32), cursor: randomBytes(32) };
      const restore = new RestoreController(database, join(folder, 'gate.json'), keys.journal, keys.priority, keys.cursor);
      await restore.initialize();
      const sessions = new Sessions(database, now), messages = new SyntheticMessaging(database, keys.mail, now);
      const identity = new IdentityService(database, sessions, messages, new PasswordHasher(), () => clock.open && restore.isOpen(), now);
      await identity.initialize();
      const config = { mongoUri: replica.uri, databaseName, port: 0, tenantOrigin: 'https://localhost:0', platformOrigin: 'https://platform.localhost:0' };
      await mkdir(join(folder, 'private'));
      const runtime = await attachRuntime(identity, keys, config, { exchangePrivateRoot: join(folder, 'private') });
      const signup = async () => {
        const anonymous = await sessions.issue('TENANT', 'P', null), email = randomUUID() + '@example.test';
        const registered = await identity.register('TENANT', randomUUID(), { email, displayName: 'Persona sintética', privacyPolicyVersion: 'synthetic-v1', password }, anonymous.context);
        if (!registered.issued) throw Error('No basic session');
        await identity.dispatchMail();
        const subject = (await identity.identities.findOne({ email }))!;
        const mail = [...messages.inbox.values()].find(m => m.subjectId === subject._id && m.purpose === 'ACTIVATION');
        if (!mail) throw Error('No activation');
        return { email, issued: registered.issued, token: mail.token };
      };
      const actor = async () => {
        const a = await signup();
        const confirmed = await identity.confirmEmail(a.issued.context, { purpose: 'ACTIVATION', token: a.token });
        const context = confirmed.issued.context;
        const enrollment = await runtime.totp.enroll(context, 'Prueba', password);
        const secret = new URL(enrollment.provisioningUri).searchParams.get('secret')!;
        const completed = await runtime.totp.confirm(context, enrollment.enrollmentId, await generate({ secret, epoch: Math.floor(now() / 1000) }));
        if (!completed.issued) throw Error('No strong session');
        return { email: a.email, secret, issued: completed.issued };
      };
      type Actor = Awaited<ReturnType<typeof actor>>;
      const proof = async (a: Actor, purpose: string, command?: Record<string, unknown>, resourceId?: string) => {
        const kind = purposeClass(purpose);
        const current = await sessions.contexts.findOne({ _id: a.issued.context._id });
        if (kind === 'WORK_ONLY' || kind === 'BALANCE_60M' && current?.balanceGrant && current.balanceGrant.expiresAt > now()) return a.issued;
        const result = await identity.work!.prepare(a.issued.context, { purpose, method: 'TOTP', ...(command ? { command } : {}), ...(resourceId ? { resourceId } : {}) });
        clock.value += 30000;
        a.issued = (await identity.work!.verify(a.issued.context, { intentId: result.intentId, method: 'TOTP', code: await generate({ secret: a.secret, epoch: Math.floor(now() / 1000) }) }, a.issued.token)).issued;
        return a.issued;
      };
      const https = async (uiOrigin: string) => {
        await promisify(execFile)('C:/Program Files/Git/usr/bin/openssl.exe', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(folder, 'key.pem'), '-out', join(folder, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { windowsHide: true });
        const cert = await readFile(join(folder, 'cert.pem')), key = await readFile(join(folder, 'key.pem'));
        const reservation = probe().listen(0, '127.0.0.1');
        await once(reservation, 'listening');
        const reserved = reservation.address();
        if (!reserved || typeof reserved === 'string' || protectedPorts.has(reserved.port) || reserved.port === port) throw Error('Protected HTTPS port');
        await new Promise<void>(r => reservation.close(() => r()));
        await receipt({ event: 'https-reserved-before-listen', port: reserved.port, tenantOrigin: uiOrigin });
        const app = createApp({ identity, config });
        const server = createServer({ cert, key }, app);
        servers.push(server);
        server.listen(reserved.port, '127.0.0.1');
        await once(server, 'listening');
        const a = server.address();
        if (!a || typeof a === 'string') throw Error('No HTTPS listener');
        config.tenantOrigin = uiOrigin;
        config.platformOrigin = 'https://platform.localhost:' + a.port;
        Object.assign(runtime.webauthn.origins, { TENANT: config.tenantOrigin, PLATFORM: config.platformOrigin });
        await receipt({ event: 'https-created', port: a.port, tenantOrigin: uiOrigin });
        return { port: a.port, cert };
      };
      return { database, clock, now, keys, restore, sessions, messages, identity, runtime, config, actor, proof, https, folder };
    };
    return { runId: executionId, fixture, dispose, folder, names, port, uri: replica.uri, phase: async (phase: string, durationMs: number) => receipt({ event: 'phase', phase, durationMs }), hold: () => { liveLeases++; let active = true; return () => { if (active) { liveLeases--; active = false; } }; } };
  } catch (error) {
    await receipt({ event: 'setup-failed', reason: String(error), startupTail: 'No Mongo subprocess/service/dbPath created by this fixture' });
    await dispose();
    throw error;
  }
}

export async function world(group: Awaited<ReturnType<typeof s11Profile>>, clockValue = Date.parse('2026-10-30T12:00:00-05:00')) {
  const setup = performance.now(), f = await group.fixture();
  await group.phase('setup', performance.now() - setup);
  const seed = performance.now();
  f.clock.value = clockValue;
  const a = await f.actor();
  const org = (await f.runtime.organizations.create(a.issued.context, { name: 'Organización sintética S11', currency: 'COP', timezone: 'America/Bogota' }, randomUUID())).data.organization.id;
  const account = async (code: string, accountClass = 'ASSET', kind = 'GENERAL') => {
    const payload = { code, name: 'Cuenta sintética ' + code, currency: 'COP', accountClass, kind };
    return (await f.runtime.finance.mutate(a.issued.context, 'createAccount', org, payload, randomUUID())).data as { id: string; version: number };
  };
  const bank = await account('BANK_S11', 'ASSET', 'BANK'), equity = await account('EQUITY_S11', 'EQUITY');
  const capital = { currency: 'COP', effectiveDate: today(f.now()), sourceId: randomUUID(), supportReference: 'SYN-S11-CAPITAL', description: 'Capital sintético S11', lines: [{ accountId: bank.id, debit: '20000000.00', credit: '0.00' }, { accountId: equity.id, debit: '0.00', credit: '20000000.00' }] };
  const key = randomUUID();
  await f.proof(a, 'FINANCE_JOURNAL_POST', { organizationId: org, idempotencyKey: key, payload: capital });
  await f.runtime.finance.mutate(a.issued.context, 'postJournal', org, capital, key);
  await f.restore.flush();
  const owner = async () => {
    const o = JSON.parse(await readFile(join(group.folder, 'owner.json'), 'utf8')) as { pid: number; runId: string; names: string[] };
    return o.pid === process.pid && o.runId === group.runId && o.names[0] === f.database.db.databaseName;
  };
  await group.phase('seed', performance.now() - seed);
  const verification = performance.now();
  const service = f.runtime.obligations;
  await service.prepareOwned(owner);
  await f.runtime.wealth.prepareOwned(owner);
  const projection = await ProjectionRuntime.createOwned(f.identity, f.keys.cursor, owner, false, () => service.activateOwned(owner));
  f.identity.reporting!.projection = projection;
  await group.phase('verification', performance.now() - verification);
  const mutate = async (operation: string, payload: Data, params: Record<string, string> = {}, expected?: string, commandKey: string = randomUUID()) => {
    const purpose = managementContract().operations.get(operation)!.definition['x-purpose']!;
    const command = { operationId: operation, idempotencyKey: commandKey, ...(params['organizationId'] ? { organizationId: params['organizationId'] } : {}), ...(params['bookId'] ? { bookId: params['bookId'] } : {}), pathParameters: params, payload, ...(expected ? { expectedETag: expected } : {}) };
    await f.proof(a, purpose, command, params['expenseId'] ?? params['ruleId'] ?? params['liabilityId'] ?? params['relationshipId']);
    return await service.mutate(a.issued.context, operation, payload, params, commandKey, expected);
  };
  const book = (await mutate('createPersonalBook', { currency: 'COP' })).data as { id: string };
  return { ...f, owner, a, org, bank, equity, book, service, projection, group };
}
