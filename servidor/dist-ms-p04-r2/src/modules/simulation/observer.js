import { BSON } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors.js';
import { codec, controls, protectedTables, signedBody } from './evidence.js';
import { hash } from './codec.js';
const fail = () => { throw new AppError(503, 'INTEGRITY_MISMATCH'); };
export const transactionId = (id, n) => hash([id, n]);
export class Observer {
    database;
    onFault;
    stream;
    loop;
    running = false;
    fault = false;
    pending = [];
    tx = null;
    bytes = 0;
    waiters = new Map();
    constructor(database, onFault) {
        this.database = database;
        this.onFault = onFault;
    }
    get ready() { return this.running && !this.fault; }
    trip() { if (this.fault)
        return; this.fault = true; for (const w of this.waiters.values()) {
        clearTimeout(w.timer);
        w.reject(new AppError(503, 'INTEGRITY_MISMATCH'));
    } this.waiters.clear(); void this.onFault().catch(() => { }); }
    disconnected = () => { if (this.running)
        this.trip(); };
    async start(verify) {
        if (this.running)
            fail();
        this.running = true;
        this.database.client.on('serverHeartbeatFailed', this.disconnected);
        this.database.client.on('connectionPoolCleared', this.disconnected);
        this.stream = this.database.db.watch([{ $match: { $or: [{ 'ns.coll': { $in: protectedTables } }, { operationType: { $nin: ['insert', 'update', 'replace', 'delete'] } }] } }], { showExpandedEvents: true, fullDocument: 'required', fullDocumentBeforeChange: 'required', maxAwaitTimeMS: 100 });
        try {
            const first = await this.stream.tryNext();
            if (first)
                this.accept(first);
            this.loop = this.consume();
            await this.barrier();
            await verify();
            await this.barrier();
        }
        catch (e) {
            this.trip();
            await this.stop();
            throw e;
        }
    }
    async stop() { this.running = false; this.database.client.off('serverHeartbeatFailed', this.disconnected); this.database.client.off('connectionPoolCleared', this.disconnected); for (const w of this.waiters.values()) {
        clearTimeout(w.timer);
        w.reject(new AppError(503, 'SERVICE_UNAVAILABLE'));
    } this.waiters.clear(); await this.stream?.close(); await this.loop; }
    async barrier() {
        if (!this.ready)
            fail();
        const id = randomUUID(), body = { _id: id, issued: Date.now(), expiresAt: new Date(Date.now() + 60000) }, row = { ...body, mac: codec(this.database).seal('BARRIER', body) };
        const done = new Promise((resolve, reject) => { const timer = setTimeout(() => { this.waiters.delete(id); this.trip(); reject(new AppError(503, 'SERVICE_UNAVAILABLE')); }, 10000); this.waiters.set(id, { resolve, reject, timer }); });
        try {
            await this.database.db.collection(controls.barriers).insertOne(row, { writeConcern: { w: 'majority' } });
            await done;
            if (!this.ready)
                fail();
        }
        catch (e) {
            this.trip();
            throw e;
        }
    }
    async consume() { try {
        while (this.running) {
            const e = await this.stream.tryNext();
            if (e)
                this.accept(e);
        }
    }
    catch {
        if (this.running)
            this.trip();
    } }
    finish() {
        if (!this.pending.length)
            return;
        const manifests = this.pending.filter(e => 'ns' in e && 'coll' in e.ns && e.ns.coll === controls.manifests);
        if (manifests.length !== 1)
            fail();
        const e = manifests[0], m = 'fullDocument' in e ? e.fullDocument : null;
        if (e.operationType !== 'insert' || !m || m['_id'] !== this.tx || !codec(this.database).verify('MANIFEST', signedBody(m), m['mac']))
            fail();
        const mutations = [];
        for (const event of this.pending) {
            if (!('ns' in event) || !('coll' in event.ns) || event.ns.coll === controls.manifests)
                continue;
            const before = 'fullDocumentBeforeChange' in event ? event.fullDocumentBeforeChange : null, after = 'fullDocument' in event ? event.fullDocument : null;
            if (event.operationType !== 'insert' && !before || event.operationType !== 'delete' && !after)
                fail();
            mutations.push({ table: event.ns.coll, id: 'documentKey' in event ? event.documentKey._id : null, before: before ? hash(before) : null, after: after ? hash(after) : null });
        }
        if (hash(mutations) !== m['mutationRoot'])
            fail();
        this.pending = [];
        this.tx = null;
        this.bytes = 0;
    }
    accept(e) {
        try {
            if (!('ns' in e) || !('coll' in e.ns) || !['insert', 'replace', 'update', 'delete'].includes(e.operationType))
                fail();
            const ns = 'ns' in e && 'coll' in e.ns ? e.ns.coll : '';
            if (ns === controls.barriers) {
                this.finish();
                const r = e.operationType === 'delete' && 'fullDocumentBeforeChange' in e ? e.fullDocumentBeforeChange : 'fullDocument' in e ? e.fullDocument : null;
                if (!r || !codec(this.database).verify('BARRIER', signedBody(r), r['mac']))
                    fail();
                if (e.operationType === 'delete') {
                    if (!(r['expiresAt'] instanceof Date) || r['expiresAt'].getTime() > Date.now())
                        fail();
                    return;
                }
                if (e.operationType !== 'insert')
                    fail();
                const w = this.waiters.get(String(r['_id']));
                if (w) {
                    clearTimeout(w.timer);
                    this.waiters.delete(String(r['_id']));
                    w.resolve();
                }
                return;
            }
            const tx = 'lsid' in e && 'txnNumber' in e && e.lsid?.id !== undefined ? transactionId(e.lsid.id, e.txnNumber) : null;
            if (!tx)
                fail();
            if (this.tx && tx !== this.tx)
                this.finish();
            this.tx = tx;
            this.pending.push(e);
            this.bytes += BSON.serialize(e).length;
            if (this.bytes > 33554432 || this.pending.length > 5000)
                fail();
        }
        catch {
            this.trip();
        }
    }
}
//# sourceMappingURL=observer.js.map