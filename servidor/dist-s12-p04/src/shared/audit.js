import { randomUUID } from 'node:crypto';
import { captureSecurityDelta } from './evidence.js';
export class AuditWriter {
    database;
    constructor(database) {
        this.database = database;
    }
    async append(event, session) {
        // Construct an allowlist explicitly; caller objects never become log payloads.
        const counter = await this.database.db.collection('security_sequence').findOneAndUpdate({ _id: 'security' }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after', session });
        if (!counter)
            throw new Error('Security sequence unavailable');
        const document = { eventId: randomUUID(), sequence: counter.value, action: event.action, realm: event.realm,
            subjectId: event.subjectId, actorId: event.actorId, outcome: event.outcome, createdAt: new Date(),
            ...(event.opening ? { opening: { id: event.opening.id, version: event.opening.version, validationId: event.opening.validationId, fingerprint: event.opening.fingerprint } } : {}),
            ...(event.lending ? { lending: { operation: event.lending.operation, id: event.lending.id, version: event.lending.version } } : {}) };
        await this.database.db.collection('audit_events').insertOne(document, { session });
        await this.database.db.collection('outbox').insertOne({ ...document, kind: 'AUDIT', dispatched: false }, { session });
        await this.database.db.collection('security_evidence_outbox').insertOne({
            _id: counter.value, eventId: document.eventId, state: await captureSecurityDelta(this.database, session, counter.value)
        }, { session });
    }
}
//# sourceMappingURL=audit.js.map