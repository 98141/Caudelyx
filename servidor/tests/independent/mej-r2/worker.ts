import { initialBalances } from '../../../dist/src/modules/finance/initial-balances.js';
import { join } from 'node:path';
import { Database } from '../../../dist/src/shared/database.js';
import { RestoreController } from '../../../dist/src/shared/restore.js';
import { Sessions } from '../../../dist/src/modules/sessions/service.js';
import { SyntheticMessaging } from '../../../dist/src/modules/messaging/service.js';
import { IdentityService } from '../../../dist/src/modules/identity/service.js';
import { PasswordHasher } from '../../../dist/src/modules/identity/password.js';
import { attachRuntime } from '../../../dist/src/shared/runtime.js';
import type { SyntheticKeys } from '../../../dist/src/shared/keys.js';
import type { Config } from '../../../dist/src/shared/config.js';

const OWN = 'caudelyx_mej_r2_b7e4c1a90f46d58c2e1a04ab';
let database: Database | undefined;
let identity: IdentityService | undefined;

process.on('message', (input: Record<string, unknown>) => { void (async () => {
  try {
    if (input['type'] === 'initialize') {
      const uri = String(input['uri']);
      const name = String(input['name']);
      const url = new URL(uri);
      if (url.hostname !== '127.0.0.1' || !url.port || ['27017', '27181'].includes(url.port) || url.searchParams.get('replicaSet') !== 'caudelyx-manual' || url.username || url.password || name !== OWN || uri.includes('caudelyx_dev') || uri.includes('caudelyx_mej_c1_')) throw Error('Unknown peer profile');
      const serialized = input['keys'] as Record<string, string>;
      const keys = { version: 1, mail: Buffer.from(serialized['mail']!, 'base64'), totp: Buffer.from(serialized['totp']!, 'base64'), journal: Buffer.from(serialized['journal']!, 'base64'), cursor: Buffer.from(serialized['cursor']!, 'base64') } as SyntheticKeys;
      const now = () => Number(input['now']);
      database = new Database(uri, name);
      await database.connect();
      const restore = new RestoreController(database, join(String(input['folder']), 'gate.json'), keys.journal);
      await restore.initialize();
      const sessions = new Sessions(database, now);
      identity = new IdentityService(database, sessions, new SyntheticMessaging(database, keys.mail, now), new PasswordHasher(), () => restore.isOpen(), now);
      await identity.initialize();
      await attachRuntime(identity, keys, input['config'] as Config);
      process.send?.({ type: 'ready', pid: process.pid });
    } else if (input['type'] === 'execute') {
      const context = await identity!.sessions.find(String(input['token']), 'TENANT');
      if (!context) throw Error('Own peer session unavailable');
      if (input['operation'] === 'financePost') {
        const result = await identity!.finance!.mutate(context, 'postJournal', String(input['organizationId']), input['payload'], String(input['key']));
        process.send?.({ type: 'result', status: result.status, pid: process.pid });
        return;
      }
      const result = input['operation'] === 'initialBalances'
        ? await initialBalances(identity!.finance!, context, String(input['organizationId']), input['payload'], String(input['key']))
        : await identity!.operations!.mutate(context, String(input['operation']), String(input['organizationId']), input['payload'], input['key'], String(input['etag']));
      process.send?.({ type: 'result', status: result.status, data: result.data, pid: process.pid });
    } else if (input['type'] === 'stop') {
      await database?.close();
      process.disconnect();
    }
  } catch (e) {
    process.send?.({ type: 'error', status: (e as { status?: number }).status ?? 503, code: (e as { code?: string }).code ?? 'OWN_PEER_ERROR', pid: process.pid });
  }
})(); });
