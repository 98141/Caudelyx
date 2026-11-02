import { MongoClient } from 'mongodb';
import { ProjectionTracking } from '../modules/reporting/projection/tracking.js';
export class Database {
    transactionGuard;
    securityCheck;
    client;
    db;
    projectionTracking;
    projectionPublisher;
    projectionShutdown;
    flushEvidence;
    wealthReserves;
    wealthGuard;
    wealthBeforeCommit;
    wealthAssertReversible;
    constructor(uri, name, options = {}) {
        this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000, retryWrites: true, monitorCommands: options.monitorCommands ?? false });
        this.projectionTracking = new ProjectionTracking(this.client.db(name));
        this.db = this.projectionTracking.db;
    }
    async connect() {
        await this.client.connect();
        const hello = await this.db.admin().command({ hello: 1 });
        if (typeof hello['setName'] !== 'string') {
            await this.client.close();
            throw new Error('Replica set required for atomic audit/outbox');
        }
        await this.db.collection('audit_events').createIndex({ eventId: 1 }, { unique: true });
        await this.db.collection('outbox').createIndex({ eventId: 1 }, { unique: true });
    }
    async transaction(work) {
        return await this.client.withSession(async (session) => await session.withTransaction(async () => {
            this.projectionTracking.begin(session);
            try {
                await this.transactionGuard?.();
                if (this.transactionGuard)
                    await this.db.collection('transaction_fence').updateOne({ _id: 'security' }, { $inc: { value: 1 } }, { session, upsert: true });
                const result = await work(session);
                await this.wealthBeforeCommit?.(session, this.projectionTracking.active.get(session));
                if (this.projectionTracking.enabled) {
                    if (!this.projectionPublisher)
                        throw new Error('Projection publisher unavailable');
                    await this.projectionPublisher(session, this.projectionTracking.active.get(session));
                }
                return result;
            }
            finally {
                this.projectionTracking.end(session);
            }
        }, {
            readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary',
        }));
    }
    async close() { await this.projectionShutdown?.(); await this.client.close(); }
}
//# sourceMappingURL=database.js.map