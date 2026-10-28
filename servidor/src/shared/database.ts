import { MongoClient, type ClientSession, type Db } from 'mongodb';
import {ProjectionTracking,type WriteSet} from '../modules/reporting/projection/tracking.js';

export class Database {
  transactionGuard?: () => void | Promise<void>;
  securityCheck?: (predicate: () => boolean) => Promise<boolean>;
  readonly client: MongoClient;
  readonly db: Db;
  readonly projectionTracking: ProjectionTracking;
  projectionPublisher?: (session: ClientSession, changes: WriteSet) => Promise<void>;
  projectionShutdown?: () => Promise<void>;
  constructor(uri: string, name: string, options: {monitorCommands?:boolean} = {}) {
    this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000, retryWrites: true, monitorCommands:options.monitorCommands??false });
    this.projectionTracking = new ProjectionTracking(this.client.db(name));
    this.db = this.projectionTracking.db;
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
        this.projectionTracking.begin(session);
        try {
          await this.transactionGuard?.();
          if(this.transactionGuard)await this.db.collection<{_id:string;value:number}>('transaction_fence').updateOne({_id:'security'},{$inc:{value:1}},{session,upsert:true});
          const result=await work(session);
          if(this.projectionTracking.enabled){
            if(!this.projectionPublisher)throw new Error('Projection publisher unavailable');
            await this.projectionPublisher(session,this.projectionTracking.active.get(session)!);
          }
          return result;
        } finally { this.projectionTracking.end(session); }
      }, {
        readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary',
      }));
  }
  async close(): Promise<void> { await this.projectionShutdown?.(); await this.client.close(); }
}
