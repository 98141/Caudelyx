import { createHash } from 'node:crypto';
import { BSON, type ClientSession } from 'mongodb';
import type { Database } from '../../shared/database.js';

// A digest is evidence, never a balance cache or a license to manufacture lost entries.
export interface FinanceEvidence {digest:string;revision:number}
export const financeCollections = ['financial_accounts','financial_journals','financial_idempotency'] as const;
export async function financialDigest(database:Database,session?:ClientSession):Promise<string> {
  const hash=createHash('sha256');
  for(const name of financeCollections) {
    hash.update(name);
    for await(const row of database.db.collection(name).find({},session?{session}:{}).sort({_id:1})) hash.update(BSON.EJSON.stringify(row,{relaxed:false}));
  }
  return hash.digest('hex');
}
export async function recordFinancialEvidence(database:Database,session:ClientSession):Promise<void> {
  const digest=await financialDigest(database,session);
  await database.db.collection<FinanceEvidence&{_id:string}>('financial_evidence_head').updateOne({_id:'finance'},{$set:{digest},$inc:{revision:1}},{session,upsert:true});
}
export async function financialEvidenceMatches(database:Database,expected:FinanceEvidence|undefined,session?:ClientSession):Promise<boolean> {
  const options=session?{session}:{};
  if(!expected) {
    for(const name of financeCollections)if(await database.db.collection(name).countDocuments({},options)>0)return false;
    return true;
  }
  return expected.digest === await financialDigest(database,session);
}
