/* eslint-disable security/detect-non-literal-fs-filename -- Exact registered control path from owned profile. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { s08Profile } from './profile.js';
import { cashSetup } from '../s07/fixture.js';
import { ProjectionRuntime } from '../../src/modules/reporting/projection/service.js';
export async function activate(group, f) {
    const runtime = await ProjectionRuntime.createOwned(f.identity, f.keys.cursor, async () => {
        const owner = JSON.parse(await readFile(join(group.folder, 'owner.json'), 'utf8'));
        return owner.pid === process.pid && owner.runId === group.runId && owner.names[0] === f.database.db.databaseName;
    });
    f.identity.reporting.projection = runtime;
    return runtime;
}
export async function walkFixture() {
    const group = await s08Profile();
    try {
        const f = await cashSetup(group, true, true);
        const projection = await activate(group, f);
        const serve = f.https;
        const web = await serve(true);
        return { group, f, web, projection, close: async () => { await projection.stop(); await group.dispose(); } };
    }
    catch (error) {
        await group.dispose();
        throw error;
    }
}
//# sourceMappingURL=fixture.js.map