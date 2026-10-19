import { createApp } from './app.js';
import { loadConfig } from './shared/config.js';
import { Database } from './shared/database.js';
import { IdentityService } from './modules/identity/service.js';
import { Sessions } from './modules/sessions/service.js';
import { SyntheticMessaging } from './modules/messaging/service.js';
import { PasswordHasher } from './modules/identity/password.js';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';

const config = loadConfig(process.env);
const database = new Database(config.mongoUri, config.databaseName);
await database.connect();
// Synthetic encryption keys are process-ephemeral; never accept real data or reuse snapshots as proof of history.
const identity = new IdentityService(database, new Sessions(database),
  new SyntheticMessaging(database, randomBytes(32), Date.now), new PasswordHasher(),
  () => process.env['CAUDELYX_REALM_CLOSED'] !== 'true');
await identity.initialize();
const server = createServer({ key: await readFile('.runtime/tls/key.pem'), cert: await readFile('.runtime/tls/cert.pem') },
  createApp({ identity, config })).listen(config.port, '127.0.0.1');
const platform = createServer({ key: await readFile('.runtime/tls/key.pem'), cert: await readFile('.runtime/tls/cert.pem') },
  createApp({ identity, config })).listen(Number(new URL(config.platformOrigin).port || '443'), '127.0.0.1');
const dispatcher = setInterval(() => { void identity.dispatchMail().catch(() => { /* Durable queue retained; no secret logging. */ }); }, 1000);
dispatcher.unref();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    clearInterval(dispatcher);
    server.close(() => { platform.close(() => { void database.close(); }); });
  });
}
