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
const restore = new RestoreController(database, join(dirname(process.env['KEYRING_FILE'] ?? '.runtime/synthetic-keys.json'), `gate-${config.databaseName}.json`), keys.journal, keys.priority, keys.cursor);
await restore.initialize();
const identity = new IdentityService(database, new Sessions(database), new SyntheticMessaging(database, keys.mail, Date.now), new PasswordHasher(), () => restore.isOpen());
await identity.initialize();
await attachRuntime(identity, keys, config);
const tlsDirectory = process.env['TLS_DIRECTORY'] ?? '.runtime/tls';
// TLS_DIRECTORY is operator configuration, never derived from HTTP input.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const server = createServer({ key: await readFile(join(tlsDirectory, 'key.pem')), cert: await readFile(join(tlsDirectory, 'cert.pem')) }, createApp({ identity, config })).listen(config.port, '127.0.0.1');
// Same operator-owned TLS pair for the separate platform host.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const platform = createServer({ key: await readFile(join(tlsDirectory, 'key.pem')), cert: await readFile(join(tlsDirectory, 'cert.pem')) }, createApp({ identity, config })).listen(Number(new URL(config.platformOrigin).port || '443'), '127.0.0.1');
let pending = null;
const dispatcher = setInterval(() => {
    if (pending)
        return; // Backpressure: one task, never an unbounded promise queue.
    pending = (async () => { await restore.flush(); if (await identity.isRealmOpen('TENANT')) {
        await identity.dispatchMail();
        await identity.beforeRequest?.();
    } })()
        .catch(() => { console.error('SYNTHETIC_DISPATCH_RETRY_PENDING'); /* Fixed diagnostic only; durable outboxes retained. */ })
        .finally(() => { pending = null; });
}, 1000);
dispatcher.unref();
let stopping = false;
async function shutdown() {
    if (stopping)
        return;
    stopping = true;
    clearInterval(dispatcher);
    try {
        await pending;
        await restore.flush();
    }
    catch { /* Keep evidence/gate closed rather than manufacture a missing journal. */ }
    await Promise.all([new Promise(resolve => server.close(() => resolve())), new Promise(resolve => platform.close(() => resolve()))]);
    await database.close();
    process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => { void shutdown(); });
process.on('message', message => { if (message === 'LOCAL_SYNTHETIC_SHUTDOWN')
    void shutdown(); });
//# sourceMappingURL=server.js.map