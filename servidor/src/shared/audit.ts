import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import type { Database } from './database.js';
import { captureSecurityDelta, type SecurityEvidence } from './evidence.js';

export interface AuditEvent {
  action: string;
  realm: 'TENANT' | 'PLATFORM';
  subjectId: string;
  actorId: string;
  outcome: 'SUCCESS' | 'DENIED';
}
export class AuditWriter {
  constructor(private readonly database: Database) {}
  async append(event: AuditEvent, session: ClientSession): Promise<void> {
    // Construct an allowlist explicitly; caller objects never become log payloads.
    const counter = await this.database.db.collection<{_id:string;value:number}>('security_sequence').findOneAndUpdate({_id:'security'},{$inc:{value:1}},{upsert:true,returnDocument:'after',session});
    if(!counter)throw new Error('Security sequence unavailable');
    const document = { eventId: randomUUID(), sequence:counter.value, action: event.action, realm: event.realm,
      subjectId: event.subjectId, actorId: event.actorId, outcome: event.outcome, createdAt: new Date() };
    await this.database.db.collection('audit_events').insertOne(document, { session });
    await this.database.db.collection('outbox').insertOne({ ...document, kind: 'AUDIT', dispatched: false }, { session });
    await this.database.db.collection<{_id:number;eventId:string;state:SecurityEvidence}>('security_evidence_outbox').insertOne({
      _id:counter.value,eventId:document.eventId,state:await captureSecurityDelta(this.database,session,counter.value)}, {session});
  }
}
