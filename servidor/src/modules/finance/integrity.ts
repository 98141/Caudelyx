import { createHash } from 'node:crypto';
import { BSON, type ClientSession } from 'mongodb';
import type { Database } from '../../shared/database.js';

// A digest is evidence, never a balance cache or a license to manufacture lost entries.
export interface FinanceEvidence {digest:string;revision:number;format?:'opening-v1'}
export const financeCollections = ['financial_accounts','financial_journals','financial_idempotency'] as const;
const openingCollections=['opening_files','opening_validations','opening_references','opening_idempotency'] as const;
async function hasOpening(database:Database,session?:ClientSession){
  const options=session?{session}:{};
  for(const name of openingCollections)if(await database.db.collection(name).countDocuments({},options))return true;
  return Boolean(await database.db.collection('financial_books').findOne({openingId:{$exists:true}},options));
}
export async function financialDigest(database:Database,session?:ClientSession,format?:'opening-v1'):Promise<string> {
  const hash=createHash('sha256');
  for(const name of [...financeCollections,...(format==='opening-v1'?openingCollections:[])]) {
    hash.update(name);
    for await(const row of database.db.collection(name).find({},session?{session}:{}).sort({_id:1})) hash.update(BSON.EJSON.stringify(row,{relaxed:false}));
  }
  if(format==='opening-v1'){
    hash.update('opening_book_markers');
    // Fence counters change on replay; only the immutable economic opening marker
    // belongs to this versioned evidence. No retroactive reinterpretation of S02.
    for await(const row of database.db.collection('financial_books').find({openingId:{$exists:true}},session?{session}:{}).project({_id:1,openingId:1,cutoffDate:1}).sort({_id:1}))hash.update(BSON.EJSON.stringify(row,{relaxed:false}));
  }
  return hash.digest('hex');
}
export async function recordFinancialEvidence(database:Database,session:ClientSession):Promise<void> {
  const previous=await database.db.collection<FinanceEvidence&{_id:string}>('financial_evidence_head').findOne({_id:'finance'},{session});
  const format=previous?.format==='opening-v1'||await hasOpening(database,session)?'opening-v1':undefined;
  const digest=await financialDigest(database,session,format);
  await database.db.collection<FinanceEvidence&{_id:string}>('financial_evidence_head').updateOne({_id:'finance'},{$set:{digest,...(format?{format}:{})},$inc:{revision:1}},{session,upsert:true});
}
export async function financialEvidenceMatches(database:Database,expected:FinanceEvidence|undefined,session?:ClientSession):Promise<boolean> {
  const options=session?{session}:{};
  if(!expected) {
    if(await hasOpening(database,session))return false;
    for(const name of financeCollections)if(await database.db.collection(name).countDocuments({},options)>0)return false;
    return true;
  }
  if(expected.format!=='opening-v1'&&await hasOpening(database,session))return false;
  return expected.digest === await financialDigest(database,session,expected.format);
}
