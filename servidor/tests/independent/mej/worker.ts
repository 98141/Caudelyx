// MEJ-5 peer process (Claude): a second backend instance over the SAME own group (same DB, gate and keys), used to prove
// that the initial-balance fence holds across processes. It only runs when spawned by the own review test over IPC.
import { join, resolve } from 'node:path';
import { Database } from '../../../src/shared/database.js';
import { Sessions } from '../../../src/modules/sessions/service.js';
import { SyntheticMessaging } from '../../../src/modules/messaging/service.js';
import { IdentityService } from '../../../src/modules/identity/service.js';
import { PasswordHasher } from '../../../src/modules/identity/password.js';
import { RestoreController } from '../../../src/shared/restore.js';
import { attachRuntime } from '../../../src/shared/runtime.js';
import { initialBalances } from '../../../src/modules/finance/initial-balances.js';
import { AppError } from '../../../src/shared/errors.js';

type Init = { type: 'initialize'; uri: string; name: string; folder: string; now: number; keys: Record<string, string> };
type Exec = { type: 'execute'; token: string; org: string; body: unknown; key: string };
let state: { database: Database; identity: IdentityService } | undefined;
process.on('message', (message: Init | Exec | { type: 'stop' }) => {
  void (async () => {
    if (message.type === 'initialize') {
      const url = new URL(message.uri);
      if (url.hostname !== '127.0.0.1' || ['27017', '27181'].includes(url.port) || url.searchParams.get('replicaSet') !== 'caudelyx-manual' || !/^caudelyx_mej5_[0-9a-f]{24}$/.test(message.name)) throw Error('Protected peer profile');
      if (!resolve(message.folder).includes(join('.runtime', 'mej-5'))) throw Error('Foreign control folder');
      const database = new Database(message.uri, message.name); await database.connect();
      const keys = { version: 1 as const, mail: Buffer.from(message.keys['mail']!, 'base64'), totp: Buffer.from(message.keys['totp']!, 'base64'), journal: Buffer.from(message.keys['journal']!, 'base64'), cursor: Buffer.from(message.keys['cursor']!, 'base64') };
      const now = () => message.now;
      const restore = new RestoreController(database, join(message.folder, 'gate.json'), keys.journal); await restore.initialize();
      const sessions = new Sessions(database, now), identity = new IdentityService(database, sessions, new SyntheticMessaging(database, keys.mail, now), new PasswordHasher(), () => restore.isOpen(), now);
      await identity.initialize();
      await attachRuntime(identity, keys, { mongoUri: message.uri, databaseName: message.name, port: 0, tenantOrigin: 'https://localhost:0', platformOrigin: 'https://platform.localhost:0' });
      state = { database, identity }; process.send!({ type: 'ready', pid: process.pid });
    } else if (message.type === 'execute') {
      const context = await state!.identity.sessions.find(message.token, 'TENANT');
      try { const r = await initialBalances(state!.identity.finance!, context!, message.org, message.body, message.key); process.send!({ type: 'result', status: r.status ?? 200 }); }
      catch (e) { process.send!({ type: 'result', status: e instanceof AppError ? e.status : 500, code: e instanceof AppError ? e.code : String(e).slice(0, 120) }); }
    } else { await state?.database.close(); process.disconnect(); }
  })().catch(e => { process.send?.({ type: 'error', reason: String(e).slice(0, 200) }); process.exitCode = 1; });
});
