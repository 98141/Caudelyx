/* eslint-disable security/detect-non-literal-fs-filename -- Exact MEJ-5 reserved control/evidence paths, never HTTP input. */
// MEJ-5 reviewer profile (Claude). New harness version: own mongod (manual-test-<uuid>), exact names from MEJ-5-INPUTS,
// owner nonce, no adoption of existing folders, foreign-consumer check, measured budget, drop + absence proof.
// Never 27017/27181, caudelyx_dev/caudelyx_manual, owner controls/keys or processes. Receipts: MEJ-5-RESOURCES.jsonl.
import express from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile, rm, lstat, realpath, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer as probe } from 'node:net';
import { createServer } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { MongoClient } from 'mongodb';
import { generate } from 'otplib';
import { Database } from '../../../src/shared/database.js';
import { Sessions } from '../../../src/modules/sessions/service.js';
import { SyntheticMessaging } from '../../../src/modules/messaging/service.js';
import { IdentityService } from '../../../src/modules/identity/service.js';
import { PasswordHasher } from '../../../src/modules/identity/password.js';
import { RestoreController } from '../../../src/shared/restore.js';
import { attachRuntime } from '../../../src/shared/runtime.js';
import { createApp } from '../../../src/app.js';
import type { Context } from '../../../src/modules/identity/models.js';
import { startReplicaSet } from '../../helpers/replica-set.js';
import { ApiClient } from '../../helpers/client.js';

export const RUN_ID = 'e5ee1709a607a74f17200ff3', UUID = '4562d9e6-a111-41c5-b08a-5f8339ac7d9e';
const root = resolve('.runtime');
export const folder = join(root, 'mej-5', RUN_ID), mongoFolder = join(root, 'manual-test-' + UUID);
export const databaseName = 'caudelyx_mej5_' + RUN_ID;
export const names = [databaseName, databaseName + '_external_mail', databaseName + '_external_security'];
const log = resolve('../../Construccion/Sprints/MEJ/Evidencias/MEJ-5-RESOURCES.jsonl');
export const BUDGET = { storageIndexBytes: 134217728, dbPathBytes: 536870912, controlBytes: 16777216 };
export const password = 'Frase sintetica revisora MEJ5 2468013579';
const execution = randomUUID();
export const receipt = async (r: Record<string, unknown>) => await appendFile(log, JSON.stringify({ at: new Date().toISOString(), task: 'MEJ-5', runId: RUN_ID, execution, pid: process.pid, ...r }) + '\n');

export function assertOwnUri(uri: string) {
  const u = new URL(uri);
  if (u.hostname !== '127.0.0.1' || !u.port || ['27017', '27181'].includes(u.port) || u.searchParams.get('replicaSet') !== 'caudelyx-manual') throw Error('Protected/unknown Mongo profile');
}
export async function size(path: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(path, { withFileTypes: true })) { const p = join(path, e.name), s = await lstat(p); if (s.isSymbolicLink()) throw Error('Refuse linked controls'); n += e.isDirectory() ? await size(p) : s.size; }
  return n;
}
async function removeOwn(path: string) {
  if (![folder, mongoFolder].includes(resolve(path)) || resolve(await realpath(path)) !== resolve(path) || (await lstat(path)).isSymbolicLink()) throw Error('Unowned control path');
  if (resolve(await realpath(root)) !== root) throw Error('Linked runtime root');
  await size(path); await rm(path, { recursive: true, force: false, maxRetries: 3 });
}
export async function freePort(exclude: number[] = []): Promise<number> {
  const p = probe().listen(0, '127.0.0.1'); await once(p, 'listening'); const a = p.address();
  await new Promise<void>(r => p.close(() => r()));
  if (!a || typeof a === 'string' || [27017, 27181, 3001, 3002, 4001, ...exclude].includes(a.port)) throw Error('Protected port');
  return a.port;
}

export async function reviewProfile(label: string) {
  const port = await freePort();
  await receipt({ event: 'reserved-before-create', label, mongoPort: port, databases: names, folder, mongoFolder, budget: BUDGET });
  for (const p of [folder, mongoFolder]) { try { await lstat(p); await receipt({ event: 'existing-resource-blocked', path: p }); throw Error('Existing own resource requires inventory before reuse'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
  await mkdir(join(root, 'mej-5'), { recursive: true }); await mkdir(folder);
  const owner = { runId: RUN_ID, execution, pid: process.pid, nonce: randomUUID(), names, port };
  await writeFile(join(folder, 'owner.json'), JSON.stringify(owner), { flag: 'wx' });
  const servers: ReturnType<typeof createServer>[] = [], clients: Database[] = [];
  let replica: Awaited<ReturnType<typeof startReplicaSet>> | undefined, control: MongoClient | undefined, disposed = false, reuses = 0, leases = 0;
  let peak = { storageIndexBytes: 0, dataBytes: 0, controlBytes: 0, dbPathBytes: 0 };
  const stats = async () => { const out = []; for (const name of names) { const s = await control!.db(name).command({ dbStats: 1 }); out.push({ name, dataSize: Number(s['dataSize']), storageSize: Number(s['storageSize']), indexSize: Number(s['indexSize']) }); } return out; };
  const closeConsumers = async () => { for (const s of servers.splice(0)) { s.closeAllConnections?.(); await new Promise<void>(r => s.close(() => r())); } for (const d of clients.splice(0)) await d.close(); };
  const dispose = async () => {
    if (disposed) return;
    if (leases) { await receipt({ event: 'cleanup-blocked-live-lease', leases }); throw Error('Own lease is live'); }
    try {
      if (JSON.stringify(JSON.parse(await readFile(join(folder, 'owner.json'), 'utf8'))) !== JSON.stringify(owner)) throw Error('Ownership changed');
      await closeConsumers();
      if (control) {
        const opts = await control.db('admin').command({ getCmdLineOpts: 1 });
        const dbPath = (opts['parsed'] as { storage?: { dbPath?: string } }).storage?.dbPath;
        if (!dbPath || resolve(dbPath) !== mongoFolder) throw Error('Unknown Mongo process');
        const foreign = await control.db('admin').aggregate([{ $currentOp: { allUsers: true, idleConnections: true, idleSessions: true } },
          { $match: { 'clientMetadata.application.name': { $ne: 'MEJ_5_CLEANUP' }, $or: [{ 'command.$db': { $in: names } }, { $expr: { $in: [{ $arrayElemAt: [{ $split: [{ $ifNull: ['$ns', ''] }, '.'] }, 0] }, names] } }] } }, { $project: { _id: 0, active: 1 } }]).toArray();
        if (foreign.length) throw Error('Unclosed or unknown consumer');
        await receipt({ event: 'cleanup-before', stats: await stats(), controlBytes: await size(folder), dbPathBytes: await size(mongoFolder), peak, reuses });
        for (const name of names) await control.db(name).dropDatabase();
        const remaining = await control.db('admin').command({ listDatabases: 1, nameOnly: true, filter: { name: { $in: names } } });
        if ((remaining['databases'] as unknown[]).length) throw Error('Test databases remain');
        await control.close(); control = undefined;
      }
      await replica?.stop();
      try { await removeOwn(mongoFolder); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      await removeOwn(folder); disposed = true;
      await receipt({ event: 'cleanup-complete', databases: names, remaining: 0, controlRemoved: true, mongoProcessStopped: true, reuses });
    } catch (error) {
      await receipt({ event: 'cleanup-failed', reason: String(error).slice(0, 240), retainUntil: new Date(Date.now() + 86400000).toISOString(), responsible: 'Claude/MEJ-5', paths: [folder, mongoFolder] });
      throw error;
    }
  };
  try {
    replica = await startReplicaSet({ manualProfile: 'test-' + UUID, port }); assertOwnUri(replica.uri);
    control = new MongoClient(replica.uri, { appName: 'MEJ_5_CLEANUP' }); await control.connect();
    await receipt({ event: 'created', label, databases: names, mongoPort: port, folder, mongoFolder });
    const fixture = async (options: { static?: boolean; failSetup?: boolean } = {}) => {
      await closeConsumers();
      const before = await stats(), controls = await size(folder), dbPath = await size(mongoFolder);
      const storageIndex = before.reduce((n, s) => n + s.storageSize + s.indexSize, 0), data = before.reduce((n, s) => n + s.dataSize, 0);
      peak = { storageIndexBytes: Math.max(peak.storageIndexBytes, storageIndex), dataBytes: Math.max(peak.dataBytes, data), controlBytes: Math.max(peak.controlBytes, controls), dbPathBytes: Math.max(peak.dbPathBytes, dbPath) };
      await receipt({ event: 'reuse-before', storageIndexBytes: storageIndex, dataBytes: data, controlBytes: controls, dbPathBytes: dbPath });
      if (storageIndex > BUDGET.storageIndexBytes || controls > BUDGET.controlBytes || dbPath > BUDGET.dbPathBytes) throw Error('Own resource budget exceeded');
      for (const name of names) await control!.db(name).dropDatabase();
      for (const e of await readdir(folder)) if (e !== 'owner.json') {
        const p = join(folder, e), s = await lstat(p);
        if (s.isSymbolicLink()) throw Error('Linked test control');
        if (s.isDirectory()) { if (e !== 'playwright' || resolve(await realpath(p)) !== join(folder, 'playwright')) throw Error('Unexpected test control'); await size(p); await rm(p, { recursive: true, force: false }); }
        else await rm(p);
      }
      reuses++; await receipt({ event: 'group-reused', reuses });
      const database = new Database(replica!.uri, databaseName); clients.push(database); await database.connect();
      if (options.failSetup) { await database.close(); clients.splice(clients.indexOf(database), 1); await receipt({ event: 'partial-setup-failure-consumer-closed' }); throw Error('Injected own partial setup failure'); }
      const clock = { value: Math.floor(Date.now() / 30000) * 30000 + 1000, open: true }, now = () => clock.value;
      const keys = { version: 1 as const, mail: randomBytes(32), totp: randomBytes(32), journal: randomBytes(32), cursor: randomBytes(32) };
      const restore = new RestoreController(database, join(folder, 'gate.json'), keys.journal); await restore.initialize();
      const sessions = new Sessions(database, now), messages = new SyntheticMessaging(database, keys.mail, now);
      const identity = new IdentityService(database, sessions, messages, new PasswordHasher(), () => clock.open && restore.isOpen(), now); await identity.initialize();
      const config = { mongoUri: replica!.uri, databaseName, port: 0, tenantOrigin: 'https://localhost:0', platformOrigin: 'https://platform.localhost:0' };
      const runtime = await attachRuntime(identity, keys, config);
      const totpCode = async (secret: string) => await generate({ secret, epoch: Math.floor(now() / 1000) });
      const mail = async (subjectId: string, purpose: string) => {
        await identity.dispatchMail();
        const m = [...messages.inbox.values()].filter(x => x.subjectId === subjectId && x.purpose === purpose).at(-1);
        if (!m) throw Error('No synthetic mail ' + purpose); return m;
      };
      /** Pending account with B session (A02). */
      const signup = async (source: string = randomUUID()) => {
        const p = await sessions.issue('TENANT', 'P', null), email = 'r5-' + randomUUID() + '@example.test';
        const registered = await identity.register('TENANT', source, { email, displayName: 'Revisora MEJ5', privacyPolicyVersion: 'synthetic-v1', password }, p.context);
        if (!registered.issued) throw Error('No B session');
        const subject = (await identity.identities.findOne({ email }))!;
        return { email, issued: registered.issued, subject, token: (await mail(subject._id, 'ACTIVATION')).token };
      };
      /** Confirmed account, never factor: own B confirms and rotates to W (AUTH-M01). */
      const worker = async () => {
        const a = await signup();
        const c = await identity.confirmEmail(a.issued.context, { purpose: 'ACTIVATION', token: a.token });
        if (!c.issued || c.issued.context.kind !== 'W') throw Error('Own B confirmation did not rotate to W');
        return { ...a, issued: c.issued };
      };
      /** W with a confirmed TOTP factor registered voluntarily (first factor in W, password re-entered). */
      const actor = async () => {
        const a = await worker();
        const e = await runtime.totp.enroll(a.issued.context, 'Revisora', password);
        const secret = new URL(e.provisioningUri).searchParams.get('secret')!;
        const done = await runtime.totp.confirm(a.issued.context, e.enrollmentId, await totpCode(secret));
        if (!done.issued) throw Error('No rotated W after factor');
        return { ...a, secret, issued: done.issued };
      };
      type Holder = { issued: { context: Context; token: string } ; secret: string };
      /** Real step-up through StepUpService (A42/A43 service layer): TOTP on a fresh 30 s step. */
      const stepUp = async (h: Holder, purpose: string, command?: Record<string, unknown>, resourceId?: string) => {
        const prepared = await identity.work!.prepare(h.issued.context, { purpose, method: 'TOTP', ...(command ? { command } : {}), ...(resourceId ? { resourceId } : {}) });
        clock.value += 30000;
        const verified = await identity.work!.verify(h.issued.context, { intentId: prepared.intentId, method: 'TOTP', code: await totpCode(h.secret) });
        h.issued = verified.issued; return verified;
      };
      const https = async () => {
        const run = promisify(execFile);
        await run('C:/Program Files/Git/usr/bin/openssl.exe', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(folder, 'key.pem'), '-out', join(folder, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,DNS:platform.localhost,IP:127.0.0.1'], { windowsHide: true });
        const cert = await readFile(join(folder, 'cert.pem')), key = await readFile(join(folder, 'key.pem'));
        const httpsPort = await freePort([port]);
        await receipt({ event: 'https-reserved-before-listen', httpsPort });
        const app = express();
        if (options.static) app.use(express.static(resolve('../cliente/dist'), { cacheControl: false, etag: false }));
        app.use(createApp({ identity, config }));
        const server = createServer({ cert, key }, app); servers.push(server); server.listen(httpsPort, '127.0.0.1'); await once(server, 'listening');
        config.tenantOrigin = 'https://localhost:' + httpsPort; config.platformOrigin = 'https://platform.localhost:' + httpsPort;
        Object.assign(runtime.webauthn.origins, { TENANT: config.tenantOrigin, PLATFORM: config.platformOrigin });
        await receipt({ event: 'https-created', httpsPort });
        const client = async (token?: string, host = 'localhost') => { const c = new ApiClient(httpsPort, cert, host); if (token) c.cookies.set('__Host-caudelyx-session', token); await c.refreshCsrf().catch(() => undefined); return c; };
        return { port: httpsPort, cert, client };
      };
      return { database, clock, now, keys, restore, sessions, messages, identity, runtime, config, totpCode, mail, signup, worker, actor, stepUp, https };
    };
    return { fixture, dispose, port, uri: replica.uri, hold: () => { leases++; let on = true; return () => { if (on) { leases--; on = false; } }; } };
  } catch (error) {
    await receipt({ event: 'setup-failed', reason: String(error).slice(0, 240) });
    await dispose(); throw error;
  }
}
export type ReviewFixture = Awaited<ReturnType<Awaited<ReturnType<typeof reviewProfile>>['fixture']>>;
