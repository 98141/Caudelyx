import { MongoClient } from 'mongodb';
export class Database {
    transactionGuard;
    securityCheck;
    client;
    db;
    constructor(uri, name) {
        this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000, retryWrites: true });
        this.db = this.client.db(name);
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
            await this.transactionGuard?.();
            if (this.transactionGuard)
                await this.db.collection('transaction_fence').updateOne({ _id: 'security' }, { $inc: { value: 1 } }, { session, upsert: true });
            return await work(session);
        }, {
            readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary',
        }));
    }
    async close() { await this.client.close(); }
}
//# sourceMappingURL=database.js.map