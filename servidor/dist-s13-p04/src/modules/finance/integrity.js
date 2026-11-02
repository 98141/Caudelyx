import { createHash } from 'node:crypto';
import { BSON } from 'mongodb';
import { canRecordScopedFinance, FinanceProofCollector, scopedFinanceEvidenceMatches } from './scoped-integrity.js';
export const financeCollections = ['financial_accounts', 'financial_journals', 'financial_idempotency'];
const openingCollections = ['opening_files', 'opening_validations', 'opening_references', 'opening_idempotency'];
async function hasOpening(database, session) {
    const options = session ? { session } : {};
    for (const name of openingCollections)
        if (await database.db.collection(name).countDocuments({}, options))
            return true;
    return Boolean(await database.db.collection('financial_books').findOne({ openingId: { $exists: true } }, options));
}
export async function financialDigest(database, session, format, collect) {
    const hash = createHash('sha256');
    for (const name of [...financeCollections, ...(format === 'opening-v1' ? openingCollections : [])]) {
        hash.update(name);
        for await (const row of database.db.collection(name).find({}, session ? { session } : {}).sort({ _id: 1 })) {
            hash.update(BSON.EJSON.stringify(row, { relaxed: false }));
            collect?.(name, row);
        }
    }
    if (format === 'opening-v1') {
        hash.update('opening_book_markers');
        // Fence counters change on replay; only the immutable economic opening marker
        // belongs to this versioned evidence. No retroactive reinterpretation of S02.
        for await (const row of database.db.collection('financial_books').find({ openingId: { $exists: true } }, session ? { session } : {}).project({ _id: 1, openingId: 1, cutoffDate: 1 }).sort({ _id: 1 })) {
            hash.update(BSON.EJSON.stringify(row, { relaxed: false }));
            collect?.('opening_book_markers', row);
        }
    }
    return hash.digest('hex');
}
export async function recordFinancialEvidence(database, session) {
    const previous = await database.db.collection('financial_evidence_head').findOne({ _id: 'finance' }, { session });
    const format = previous?.format === 'opening-v1' || await hasOpening(database, session) ? 'opening-v1' : undefined;
    const collector = canRecordScopedFinance(database, previous) ? new FinanceProofCollector() : null;
    const digest = await financialDigest(database, session, format, collector ? (name, row) => collector.add(name, row) : undefined);
    await database.db.collection('financial_evidence_head').updateOne({ _id: 'finance' }, { $set: { digest, ...(format ? { format } : {}), ...(collector ? { scoped: collector.finish(database, digest, (previous?.revision ?? 0) + 1), scopedVersion: 1 } : {}) }, $inc: { revision: 1 } }, { session, upsert: true });
}
export async function financialEvidenceMatches(database, expected, session) {
    const options = session ? { session } : {};
    if (!expected) {
        if (await hasOpening(database, session))
            return false;
        for (const name of financeCollections)
            if (await database.db.collection(name).countDocuments({}, options) > 0)
                return false;
        return true;
    }
    if (expected.format !== 'opening-v1' && await hasOpening(database, session))
        return false;
    return expected.digest === await financialDigest(database, session, expected.format) && await scopedFinanceEvidenceMatches(database, expected, session);
}
//# sourceMappingURL=integrity.js.map