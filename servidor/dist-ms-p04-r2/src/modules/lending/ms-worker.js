import { randomUUID } from 'node:crypto';
import { msStableId } from './ms-service.js';
import { AppError } from '../../shared/errors.js';
import { today } from '../finance/service.js';
import { stateOf } from './operations-service.js';
import { issueMsExecution, withMsExecution, authorizeMsExecution } from './ms-history.js';
import { recordLendingEvidence } from './integrity.js';
import { hash } from './contract.js';
export class MsWorker {
    ms;
    timer;
    stopped = true;
    pending;
    owner = randomUUID();
    constructor(ms) {
        this.ms = ms;
    }
    start() { if (!this.stopped)
        return; this.stopped = false; this.schedule(); }
    schedule() { if (this.stopped)
        return; this.timer = setTimeout(() => { this.pending = this.runOnce().catch(() => { }).finally(() => { this.pending = undefined; this.schedule(); }); }, 1000); this.timer.unref(); }
    async stop() { this.stopped = true; if (this.timer)
        clearTimeout(this.timer); await this.pending; }
    async runOnce() {
        await this.ms.requireActive();
        const identity = this.ms.identity, db = identity.database, day = today(identity.now()), candidates = await db.db.collection('ms_mandates').find({ status: 'ACTIVE', nextWakeDate: { $lte: day } }).sort({ bookId: 1, _id: 1 }).limit(100).toArray();
        let cycles = 0, completed = 0;
        for (const candidate of candidates) {
            if (cycles >= 1000)
                break;
            const scope = { kind: 'BUSINESS', bookId: candidate.bookId, ownerId: candidate.bookId, organizationId: candidate.bookId }, started = performance.now(), barrier = await this.ms.management.enter(started), legacy = await identity.reporting.projection.enter(started);
            const claimed = await db.transaction(async (s) => { const store = this.ms.management.store; store.tracking.begin(s); try {
                const m = (await store.all('ms_mandates', scope, s)).find(r => r._id === candidate._id);
                if (!m || m['status'] !== 'ACTIVE' || String(m['nextWakeDate']) > day || Number(m['leaseUntil']) > identity.now())
                    return false;
                await store.put('ms_mandates', { ...m, version: m.version + 1, leaseOwner: this.owner, leaseUntil: identity.now() + 60000 }, s);
                await store.touch(scope, s);
                await store.finish(s);
                return true;
            }
            finally {
                store.tracking.end(s);
            } });
            if (!claimed) {
                await this.ms.management.leave(barrier, started);
                await identity.reporting.projection.leave(legacy, started);
                continue;
            }
            await db.flushEvidence();
            const result = await db.transaction(async (s) => {
                const store = this.ms.management.store;
                store.tracking.begin(s);
                try {
                    const m = (await store.all('ms_mandates', scope, s)).find(r => r._id === candidate._id);
                    if (!m || m['status'] !== 'ACTIVE' || m['leaseOwner'] !== this.owner || Number(m['leaseUntil']) <= identity.now())
                        return { cycles: 0 };
                    const actor = await identity.identities.findOne({ _id: String(m['actorId']), realm: 'TENANT', organizationId: scope.bookId }, { session: s }), org = await db.db.collection('organizations').findOne({ _id: scope.bookId }, { session: s }), loan = await this.ms.loan(scope.bookId, String(m['loanId']), s), state = await stateOf(db, loan, s);
                    if (!state?.position.monthlyState)
                        throw new AppError(503, 'INTEGRITY_MISMATCH');
                    const terms = state.position.monthlyState, key = msStableId(scope.bookId, loan._id, 'AUTO', String(state.position.version), day), ops = identity.operations, book = await ops.books.findOne({ _id: scope.bookId }, { session: s }), bookTag = '"' + scope.bookId + ':ops:' + (book?.version ?? 0) + '"', request = { kind: 'ACCRUE', loanId: loan._id, positionETag: '"' + loan._id + ':' + state.position.version + '"', throughDate: day, effectiveDate: day, supportReference: String(m['supportReference']) };
                    let changed = 0, pause = false;
                    try {
                        if (!actor || !org)
                            throw new AppError(403, 'MANDATE_INVALID');
                        const token = issueMsExecution(identity, actor, org, request, key, 'AUTO:' + loan._id + ':' + key, 'MANDATE', m._id);
                        await withMsExecution(token, async () => {
                            // Even a zero-interest/no-due wake must validate the current consent.
                            await authorizeMsExecution(identity, actor, org, request, key, key, s);
                            if (terms.status === 'SETTLED')
                                return;
                            const plan = await ops.plan(actor, org, request, key, bookTag, s, identity.now());
                            if (plan.plan.accruals.length + cycles > 1000)
                                return;
                            await ops.persist(plan, actor, scope.bookId, request, key, s);
                            changed = plan.plan.accruals.length;
                            await recordLendingEvidence(db, s);
                        });
                    }
                    catch (e) {
                        if (e instanceof AppError && e.code === 'NO_ACCRUAL_DUE') { }
                        else if (e instanceof AppError && e.status === 403)
                            pause = true;
                        else
                            throw e;
                    }
                    const tomorrow = new Date(day + 'T12:00:00Z');
                    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
                    const next = changed === 12 ? day : tomorrow.toISOString().slice(0, 10);
                    // Settlement is reversible inside the same cycle. Keep the original
                    // consent eligible for a fresh authority check; do not finish it forever.
                    await store.put('ms_mandates', { ...m, version: m.version + 1, status: pause ? 'PAUSED' : 'ACTIVE', pauseReason: pause ? 'CURRENT_AUTHORITY_OR_CONSENT_INVALID' : null, nextWakeDate: next, leaseOwner: null, leaseUntil: 0, lastRunAt: new Date(identity.now()).toISOString(), lastSourceDigest: hash(terms) }, s);
                    await store.touch(scope, s);
                    await store.finish(s);
                    if (actor) {
                        const actorFence = await identity.identities.updateOne({ _id: actor._id, authEpoch: actor.authEpoch, authzVersion: actor.authzVersion, credentialVersion: actor.credentialVersion, suspended: false }, { $inc: { operationCommandFence: 1 } }, { session: s });
                        if (!pause && actorFence.matchedCount !== 1)
                            throw new AppError(403, 'ACCESS_DENIED');
                    }
                    if (org && !pause) {
                        const orgFence = await db.db.collection('organizations').updateOne({ _id: org._id, status: 'ACTIVE', authEpoch: org.authEpoch }, { $inc: { operationCommandFence: 1 } }, { session: s });
                        if (orgFence.matchedCount !== 1)
                            throw new AppError(403, 'ACCESS_DENIED');
                    }
                    if (actor)
                        await identity.audit.append({ realm: 'TENANT', actorId: actor._id, subjectId: actor._id, action: pause ? 'MS_MANDATE_PAUSED' : 'MS_MANDATE_WAKE', outcome: 'SUCCESS' }, s);
                    return { cycles: changed };
                }
                finally {
                    store.tracking.end(s);
                }
            });
            cycles += result.cycles;
            completed++;
            await db.flushEvidence();
            await this.ms.management.leave(barrier, started);
            await identity.reporting.projection.leave(legacy, started);
        }
        return { selected: candidates.length, completed, cycles, limits: { loans: 100, cyclesPerLoan: 12, cycles: 1000, leaseMs: 60000 } };
    }
}
//# sourceMappingURL=ms-worker.js.map