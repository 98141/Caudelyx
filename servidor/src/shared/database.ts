import { MongoClient, type ClientSession, type Db } from 'mongodb';

export class Database {
  transactionGuard?: () => void;
  readonly client: MongoClient;
  readonly db: Db;
  constructor(uri: string, name: string) {
    this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000, retryWrites: true });
    this.db = this.client.db(name);
  }
  async connect(): Promise<void> {
    await this.client.connect();
    const hello = await this.db.admin().command({ hello: 1 });
    if (typeof hello['setName'] !== 'string') {
      await this.client.close();
      throw new Error('Replica set required for atomic audit/outbox');
    }
    await this.db.collection('audit_events').createIndex({ eventId: 1 }, { unique: true });
    await this.db.collection('outbox').createIndex({ eventId: 1 }, { unique: true });
  }
  async transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    return await this.client.withSession(async (session) =>
      await session.withTransaction(async () => {
        this.transactionGuard?.();
        if(this.transactionGuard)await this.db.collection<{_id:string;value:number}>('transaction_fence').updateOne({_id:'security'},{$inc:{value:1}},{session,upsert:true});
        return await work(session);
      }, {
        readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary',
      }));
  }
  async close(): Promise<void> { await this.client.close(); }
}
