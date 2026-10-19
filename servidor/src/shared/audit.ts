import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import type { Database } from './database.js';

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
    const document = { eventId: randomUUID(), action: event.action, realm: event.realm,
      subjectId: event.subjectId, actorId: event.actorId, outcome: event.outcome, createdAt: new Date() };
    await this.database.db.collection('audit_events').insertOne(document, { session });
    await this.database.db.collection('outbox').insertOne({ ...document, kind: 'AUDIT', dispatched: false }, { session });
  }
}
