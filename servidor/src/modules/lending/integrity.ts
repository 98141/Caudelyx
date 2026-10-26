import {createHash} from 'node:crypto';
import {BSON,type ClientSession} from 'mongodb';
import type {Database} from '../../shared/database.js';
import {commitEvidence,verifyV2,domainCollections} from './evidence-v2.js';
import {verifyAllLoans} from './verification.js';
export interface LendingEvidence {format:'lending-v1'|'lending-v2';digest:string;revision:number}
export const lendingCollections=['lending_borrowers','lending_borrower_versions','lending_field_schemas','lending_quotes','lending_loans','lending_loan_versions','lending_actions','lending_idempotency','lending_domain_state'] as const;
export const head=(database:Database,session?:ClientSession)=>database.db.collection<LendingEvidence&{_id:string}>('lending_domain_state').findOne({_id:'evidence'},session?{session}:{});
export async function lendingDigest(database:Database,session?:ClientSession){
  const hash=createHash('sha256');
  for(const name of lendingCollections){hash.update(name);for await(const row of database.db.collection<{_id:string}>(name).find(name==='lending_domain_state'?{_id:{$ne:'evidence'}}:{},session?{session}:{}).sort({_id:1}))hash.update(BSON.EJSON.stringify(row,{relaxed:false}));}
  return hash.digest('hex');
}
export async function recordLendingEvidence(database:Database,session:ClientSession){
  await commitEvidence(database,session);
}
export async function lendingEvidenceMatches(database:Database,expected:LendingEvidence|undefined){
  const actual=await head(database);
  if(!expected){for(const name of [...domainCollections,'lending_merkle_nodes','lending_merkle_orgs','lending_v2_checkpoint'])if(await database.db.collection(name).countDocuments())return false;return true;}
  if(expected.format==='lending-v2'){try{const {operationsEvidenceMatches}=await import('./operations-service.js');return await verifyV2(database,expected)&&(await verifyAllLoans(database),await operationsEvidenceMatches(database))&&await(await import('../payments/economic.js')).paymentsEvidenceMatches(database);}catch{return false;}}
  return expected.format==='lending-v1'&&actual?.format==='lending-v1'&&actual.digest===expected.digest&&actual.revision===expected.revision&&await lendingDigest(database)===expected.digest;
}
