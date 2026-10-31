/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection -- Fixed synthetic key allowlist and own registered test control directory, parent PID and database verified before access. */
import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, join, basename } from 'node:path';
import { Database } from '../../src/shared/database.js';
import { Sessions } from '../../src/modules/sessions/service.js';
import { SyntheticMessaging } from '../../src/modules/messaging/service.js';
import { IdentityService } from '../../src/modules/identity/service.js';
import { PasswordHasher } from '../../src/modules/identity/password.js';
import { RestoreController } from '../../src/shared/restore.js';
import { attachRuntime } from '../../src/shared/runtime.js';
const assertOwnUri = (uri) => { const u = new URL(uri); if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.port !== '27017' || u.searchParams.get('replicaSet') !== 'rs0')
    throw Error('Unknown own Mongo URI'); };
import { ProjectionRuntime } from '../../src/modules/reporting/projection/service.js';
let database, identity;
let phase = 'MESSAGE';
process.on('message', (input) => {
    void (async () => {
        if (input['type'] === 'initialize') {
            const uri = String(input['uri']), name = String(input['name']), folder = resolve(String(input['folder']));
            assertOwnUri(uri);
            if (!/^caudelyx_s08_p02_[a-f0-9]{24}$/.test(name) || dirname(folder) !== resolve('.runtime') || await realpath(folder) !== folder || !/^s11-p02-[a-f0-9]{24}$/.test(basename(folder)))
                throw Error('Unowned restart profile');
            const owner = JSON.parse(await readFile(join(folder, 'owner.json'), 'utf8'));
            if (owner.pid !== process.ppid || !owner.names.includes(name))
                throw Error('Unowned restart group');
            const encoded = input['keys'], keys = { version: 1 };
            for (const key of ['journal', 'cursor', 'mail', 'totp', 'priority']) {
                const v = encoded[key];
                if (v)
                    keys[key] = Buffer.from(v.data);
            }
            database = new Database(uri, name);
            await database.connect();
            const now = () => Number(input['now']);
            const restore = new RestoreController(database, join(folder, 'gate.json'), keys.journal, keys.priority, keys.cursor);
            phase = 'RESTORE';
            await restore.initialize();
            if (!restore.isOpen())
                throw Error('Own restart gate is closed');
            const sessions = new Sessions(database, now), messages = new SyntheticMessaging(database, keys.mail, now);
            identity = new IdentityService(database, sessions, messages, new PasswordHasher(), () => restore.isOpen(), now);
            phase = 'IDENTITY';
            await identity.initialize();
            phase = 'RUNTIME';
            await attachRuntime(identity, keys, { mongoUri: uri, databaseName: name, port: 0, tenantOrigin: 'https://localhost:0', platformOrigin: 'https://platform.localhost:0' }, { exchangePrivateRoot: join(folder, 'private') });
            phase = 'PREPARE';
            await identity.obligations.prepareOwned(async () => owner.pid === process.ppid && owner.names.includes(name));
            await identity.wealth.prepareOwned(async () => owner.pid === process.ppid && owner.names.includes(name));
            if (input['enableBusiness'] === true) {
                phase = 'REPORTING_OBSERVER';
                const projection = await ProjectionRuntime.createOwned(identity, keys.cursor, async () => owner.pid === process.ppid && owner.names.includes(name), false, () => identity.obligations.activateOwned(async () => owner.pid === process.ppid && owner.names.includes(name)));
                identity.reporting.projection = projection;
            }
            phase = 'MANAGEMENT_OBSERVER';
            if (input['enableBusiness'] !== true)
                await identity.obligations.activateOwned(async () => owner.pid === process.ppid && owner.names.includes(name));
            process.send?.({ type: 'ready' });
            return;
        }
        if (input['type'] === 'execute') {
            if (!identity || !database)
                throw Error('Worker not initialized');
            const operation = String(input['operation']);
            const service = identity.exchange, contract = (await import('../../src/modules/exchange/contract.js')).exchangeContract(), definition = contract.operations.get(operation);
            if (!definition)
                throw Error('Unknown closed worker operation');
            const context = definition.path.startsWith('/me/') ? await identity.sessions.findPersonal(String(input['token'])) : await identity.sessions.find(String(input['token']), 'TENANT');
            if (!context)
                throw Error('Worker session unavailable');
            const params = input['params'], payload = input['payload'], query = (input['query'] ?? {}), key = String(input['key']), expected = input['expected'] === undefined ? undefined : String(input['expected']);
            const result = operation.startsWith('confirm') ? await service.confirm(context, params, payload, key, expected) : operation.endsWith('ReportSnapshot') ? await service.report(context, params, query) : operation.endsWith('ReportRows') ? await service.reportPage(context, params, query) : operation.startsWith('create') && operation.endsWith('Import') ? await service.createImport(context, operation, payload, params, key) : operation.includes('Import') ? await service.readImport(context, params, operation, query) : await service.readExport(context, params, operation, query);
            process.send?.({ type: 'result', ...result });
            return;
        }
        if (input['type'] === 'stop') {
            await identity?.obligations?.stop();
            await database?.close();
            process.disconnect();
        }
    })().catch(error => process.send?.({ type: 'error', phase, message: error instanceof Error ? error.message : 'UNKNOWN', code: error instanceof Error && 'code' in error ? String(error.code) : 'WORKER_FAILED' }));
});
//# sourceMappingURL=worker.js.map