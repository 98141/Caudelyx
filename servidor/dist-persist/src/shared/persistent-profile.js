// Owner-approved 01-11-2026: management domains may run on the persistent manual profile only.
// Exact local synthetic target: Mongo 127.0.0.1:27181, replica set caudelyx-manual, database caudelyx_manual.
export const PERSISTENT_MANUAL = { database: 'caudelyx_manual', port: 27181, replicaSet: 'caudelyx-manual' };
export function persistentManualRequested(env = process.env) {
    return env['CAUDELYX_MODE'] === 'local-synthetic' && env['CAUDELYX_PERSISTENT_DOMAINS'] === 'manual';
}
export function isPersistentManual(database) {
    const hosts = database.client.options.hosts;
    return persistentManualRequested() && database.db.databaseName === PERSISTENT_MANUAL.database && hosts.length === 1 &&
        hosts[0]?.host === '127.0.0.1' && hosts[0]?.port === PERSISTENT_MANUAL.port;
}
//# sourceMappingURL=persistent-profile.js.map