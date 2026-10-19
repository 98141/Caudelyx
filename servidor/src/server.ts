import { createApp } from './app.js';
import { loadConfig } from './shared/config.js';
import { Database } from './shared/database.js';
import { IdentityService } from './modules/identity/service.js';
import { Sessions } from './modules/sessions/service.js';
import { SyntheticMessaging } from './modules/messaging/service.js';
import { PasswordHasher } from './modules/identity/password.js';
import { loadSyntheticKeys } from './shared/keys.js';
import { attachRuntime } from './shared/runtime.js';
import { RestoreController } from './shared/restore.js';
import { dirname, join } from 'node:path';
import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';

const config = loadConfig(process.env);
const database = new Database(config.mongoUri, config.databaseName);
await database.connect();
const keys = await loadSyntheticKeys(process.env['KEYRING_FILE'] ?? '.runtime/synthetic-keys.json');
const restore = new RestoreController(database,join(dirname(process.env['KEYRING_FILE']??'.runtime/synthetic-keys.json'),`gate-${config.databaseName}.json`),keys.journal);
await restore.initialize();
const identity = new IdentityService(database, new Sessions(database),
  new SyntheticMessaging(database, keys.mail, Date.now), new PasswordHasher(),
  () => restore.isOpen());
await identity.initialize();
await attachRuntime(identity,keys,config);
const server = createServer({ key: await readFile('.runtime/tls/key.pem'), cert: await readFile('.runtime/tls/cert.pem') },
  createApp({ identity, config })).listen(config.port, '127.0.0.1');
const platform = createServer({ key: await readFile('.runtime/tls/key.pem'), cert: await readFile('.runtime/tls/cert.pem') },
  createApp({ identity, config })).listen(Number(new URL(config.platformOrigin).port || '443'), '127.0.0.1');
const dispatcher = setInterval(() => { void (async()=>{await restore.flush();if(restore.isOpen()){await identity.dispatchMail();await identity.beforeRequest?.();}})().catch(() => { console.error('SYNTHETIC_DISPATCH_RETRY_PENDING'); /* Fixed diagnostic only; durable outboxes retained, no error/secret payload. */ }); }, 1000);
dispatcher.unref();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    clearInterval(dispatcher);
    server.close(() => { platform.close(() => { void database.close(); }); });
  });
}
