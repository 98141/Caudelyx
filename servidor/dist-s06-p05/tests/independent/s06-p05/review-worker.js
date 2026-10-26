// S06-P05 own peer worker: copy of tests/s06/worker.ts bound to the reviewer group only.
import { Database } from '../../../src/shared/database.js';
import { RestoreController } from '../../../src/shared/restore.js';
import { Sessions } from '../../../src/modules/sessions/service.js';
import { IdentityService } from '../../../src/modules/identity/service.js';
import { SyntheticMessaging } from '../../../src/modules/messaging/service.js';
import { PasswordHasher } from '../../../src/modules/identity/password.js';
import { attachRuntime } from '../../../src/shared/runtime.js';
import { join, resolve } from 'node:path';
let db, identity;
process.on('message', (input) => {
    void (async () => {
        try {
            if (input['type'] === 'initialize') {
                const uri = String(input['uri']), name = String(input['name']), folder = String(input['folder']), u = new URL(uri);
                if (u.hostname !== '127.0.0.1' || !u.port || ['27017', '27181'].includes(u.port) || u.searchParams.get('replicaSet') !== 'caudelyx-manual' || name !== 'caudelyx_s06_p05_88801d49cd294def47b9edeb' || resolve(folder) !== resolve('.runtime/s06-p05-88801d49cd294def47b9edeb'))
                    throw Error('Unknown own S06 profile');
                const serialized = input['keys'], keys = { version: 2, mail: Buffer.from(serialized['mail'], 'base64'), totp: Buffer.from(serialized['totp'], 'base64'), journal: Buffer.from(serialized['journal'], 'base64'), cursor: Buffer.from(serialized['cursor'], 'base64'), priority: Buffer.from(serialized['priority'], 'base64') };
                db = new Database(uri, name);
                await db.connect();
                const restore = new RestoreController(db, join(folder, 'gate.json'), keys.journal, keys.priority);
                await restore.initialize();
                const now = () => Number(input['now']), sessions = new Sessions(db, now);
                identity = new IdentityService(db, sessions, new SyntheticMessaging(db, keys.mail, now), new PasswordHasher(), () => restore.isOpen(), now);
                await identity.initialize();
                await attachRuntime(identity, keys, input['config']);
                process.send?.({ type: 'ready', pid: process.pid });
            }
            else if (input['type'] === 'execute') {
                const context = await identity.sessions.find(String(input['token']), 'TENANT');
                if (!context)
                    throw Error('Own peer invalid context');
                const result = await identity.payments.mutate(context, String(input['operation']), String(input['organizationId']), input['payload'], input['key'], String(input['etag']), String(input['resourceId']));
                process.send?.({ type: 'result', status: result.status, pid: process.pid });
            }
            else if (input['type'] === 'stop') {
                await db?.close();
                process.disconnect();
            }
        }
        catch (e) {
            process.send?.({ type: 'error', status: e.status ?? 503, code: e.code ?? 'OWN_PEER_ERROR', pid: process.pid });
        }
    })();
});
//# sourceMappingURL=review-worker.js.map