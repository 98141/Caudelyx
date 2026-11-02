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
import { PERSISTENT_MANUAL, persistentManualRequested } from './shared/persistent-profile.js';
import { dirname, join, resolve, basename } from 'node:path';
import { createServer } from 'node:https';
import { readFile, realpath, lstat } from 'node:fs/promises';
const config = loadConfig(process.env);
const database = new Database(config.mongoUri, config.databaseName);
await database.connect();
const s12 = process.env['CAUDELYX_DEV_BUILD_SCOPE'] === 'S12-P02' || process.env['CAUDELYX_DEV_BUILD_SCOPE'] === 'S12-P04';
const s09 = process.env['CAUDELYX_DEV_BUILD_SCOPE'] === 'S09-P04', s10 = process.env['CAUDELYX_DEV_BUILD_SCOPE'] === 'S10-P04', s11 = process.env['CAUDELYX_DEV_BUILD_SCOPE'] === 'S11-P02' || process.env['CAUDELYX_DEV_BUILD_SCOPE'] === 'S11-P04', control = resolve(dirname(process.env['KEYRING_FILE'] ?? '.runtime/synthetic-keys.json'));
// Owner-approved persistent manual profile (01-11-2026); each domain re-checks the exact Mongo target.
const persistent = persistentManualRequested() && config.databaseName === PERSISTENT_MANUAL.database && !s09 && !s10 && !s11 && !s12;
// eslint-disable-next-line security/detect-non-literal-fs-filename -- Exact temporary owner directory is checked against the closed S09 namespace before filesystem access.
const owned = async () => { if (persistent)
    return true; if ((!s09 && !s10 && !s11 && !s12) || !/^caudelyx_s08_p02_[a-f0-9]{24}$/.test(config.databaseName) || basename(control) !== (s12 ? (process.env['CAUDELYX_DEV_BUILD_SCOPE'] === 'S12-P04' ? 's12-p04-' : 's12-p02-') : s11 ? (process.env['CAUDELYX_DEV_BUILD_SCOPE'] === 'S11-P04' ? 's11-p04-' : 's11-p02-') : s10 ? 's10-p04-' : 's09-p04-') + config.databaseName.slice(-24) || resolve(control, '..') !== resolve('.runtime') || await realpath(control) !== control || (await lstat(control)).isSymbolicLink())
    throw Error('Unowned management activation'); const owner = JSON.parse(await readFile(join(control, 'owner.json'), 'utf8')); if (owner.pid !== Number(process.env[s12 ? 'CAUDELYX_S12_OWNER_PID' : s11 ? 'CAUDELYX_S11_OWNER_PID' : s10 ? 'CAUDELYX_S10_OWNER_PID' : 'CAUDELYX_S09_OWNER_PID']) || !owner.names.includes(config.databaseName))
    throw Error('Unregistered management activation'); if ((s10 || s11 || s12) && (!owner.nonce || owner.nonce !== process.env[s12 ? 'CAUDELYX_S12_OWNER_NONCE' : s11 ? 'CAUDELYX_S11_OWNER_NONCE' : 'CAUDELYX_S10_OWNER_NONCE'] || JSON.stringify(owner.names) !== JSON.stringify([config.databaseName, config.databaseName + '_external_mail', config.databaseName + '_external_security'])))
    throw Error('Invalid S10 owner nonce/names'); process.kill(owner.pid, 0); return true; };
if (s09 || s10 || s11 || s12)
    await owned();
const keys = await loadSyntheticKeys(process.env['KEYRING_FILE'] ?? '.runtime/synthetic-keys.json');
const restore = new RestoreController(database, s09 || s10 || s11 || s12 ? join(control, 'gate.json') : join(control, `gate-${config.databaseName}.json`), keys.journal, keys.priority, keys.cursor);
await restore.initialize();
const identity = new IdentityService(database, new Sessions(database), new SyntheticMessaging(database, keys.mail, Date.now), new PasswordHasher(), () => restore.isOpen());
await identity.initialize();
await attachRuntime(identity, keys, config, s11 || s12 || persistent ? { exchangePrivateRoot: join(control, 'private') } : {});
if (s11 || s12 || persistent)
    await identity.exchange.files.guard();
// Legacy finance evidence predates S08 scoped proofs; sign it once from the verified digest.
if (persistent) {
    const head = await database.db.collection('financial_evidence_head').findOne({ _id: 'finance' });
    if (head && !head.scoped) {
        const { bootstrapReportingFinance } = await import('./modules/finance/scoped-integrity.js');
        await database.transaction(s => bootstrapReportingFinance(database, s));
    }
}
if (s09) {
    await identity.obligations.prepareOwned(owned);
    const { ProjectionRuntime } = await import('./modules/reporting/projection/service.js');
    const projection = await ProjectionRuntime.createOwned(identity, keys.cursor, owned, false, () => identity.obligations.activateOwned(owned));
    identity.reporting.projection = projection;
    database.projectionShutdown = async () => { await identity.obligations.stop(); await projection.stop(); };
}
if (s10 || s11 || s12 || persistent) {
    await identity.obligations.prepareOwned(owned);
    await identity.wealth.prepareOwned(owned);
    if (s12 || persistent)
        await identity.simulation.prepareOwned(owned);
    const { ProjectionRuntime } = await import('./modules/reporting/projection/service.js');
    const projection = await ProjectionRuntime.createOwned(identity, keys.cursor, owned, false, () => identity.obligations.activateOwned(owned));
    identity.reporting.projection = projection;
    database.projectionShutdown = async () => { await identity.obligations.stop(); await projection.stop(); };
}
if (s12 || persistent)
    await identity.simulation.activateOwned(owned);
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
        if ((s11 || s12 || persistent) && identity.obligations?.active)
            await identity.exchange.reconcile();
        if ((s12 || persistent) && identity.simulation?.store.active)
            await identity.simulation.reconcile();
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