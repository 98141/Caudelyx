/* eslint-disable security/detect-object-injection -- Server-owned organization/account IDs in signed proof maps and fixed table names. */
import {BSON,type ClientSession,type Document} from 'mongodb';
import {createHash,createHmac,timingSafeEqual,type Hash} from 'node:crypto';
import type {Database} from '../../shared/database.js';
import type {Account,Journal} from './models.js';
import type {Row} from '../reporting/models.js';
import {AppError} from '../../shared/errors.js';
import {financialDigest,financialEvidenceMatches,type FinanceEvidence} from './integrity.js';
const keys=new WeakMap<Database,Buffer>();
const tables=['financial_accounts','financial_journals','financial_idempotency','opening_files','opening_validations','opening_references','opening_idempotency'];
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,canonical(x)])):v;
const encode=(v:unknown)=>JSON.stringify(canonical(BSON.EJSON.serialize(v,{relaxed:false})));
export interface ScopedFinance {version:1;rowEncoding:'BSON-v1';tenants:Record<string,{digest:string;accounts:Record<string,string>}>;mac:string}
type Head=FinanceEvidence&{_id:string;scoped?:ScopedFinance};
export const configureScopedFinance=(db:Database,key:Buffer)=>keys.set(db,createHmac('sha256',key).update('CAUDELYX:FINANCE:SCOPED:KEY:v1').digest());
const mac=(db:Database,digest:string,revision:number,scoped:Omit<ScopedFinance,'mac'>)=>{
 const key=keys.get(db);if(!key)throw new AppError(503,'SERVICE_UNAVAILABLE');return createHmac('sha256',key).update(encode({purpose:'CAUDELYX:FINANCE:SCOPED:v1',digest,revision,scoped})).digest('hex');
};
export const canRecordScopedFinance=(db:Database,old:Head|null)=>{
 if(old?.scopedVersion===1&&!old.scoped)throw new AppError(503,'INTEGRITY_MISMATCH');
 if(old?.scoped)verifyHead(db,old);
 return keys.has(db)&&(!old||Boolean(old.scoped));
};
export class FinanceProofCollector{
 private readonly tenants=new Map<string,Hash>();private readonly accounts=new Map<string,Map<string,Hash>>();
 add(name:string,row:Document){
  const org=name==='opening_book_markers'?String(row['_id']):String(row['organizationId']);if(!org||org==='undefined')throw new AppError(503,'INTEGRITY_MISMATCH');
  // Full persisted documents, BSON length framing and Decimal128 retained.
  // Global legacy financialDigest keeps its original byte representation.
  const serialized=BSON.serialize(row),prefix=name+'\0';let h=this.tenants.get(org);if(!h){h=createHash('sha256');this.tenants.set(org,h);}h.update(prefix).update(serialized).update('\n');
  if(name!=='financial_accounts'&&name!=='financial_journals')return;
  const ids=name==='financial_accounts'?[String(row['_id'])]:[...new Set((row['lines'] as {accountId:string}[]).map(l=>l.accountId))];
  let account=this.accounts.get(org);if(!account){account=new Map();this.accounts.set(org,account);}
  for(const id of ids){let hash=account.get(id);if(!hash){hash=createHash('sha256');account.set(id,hash);}hash.update(prefix).update(serialized).update('\n');}
 }
 finish(db:Database,digest:string,revision:number):ScopedFinance{
  const tenants:ScopedFinance['tenants']={};for(const[org,h]of this.tenants)tenants[org]={digest:h.digest('hex'),accounts:Object.fromEntries([...(this.accounts.get(org)??[])].map(([id,h])=>[id,h.digest('hex')]))};
  const scoped={version:1 as const,rowEncoding:'BSON-v1' as const,tenants};return{...scoped,mac:mac(db,digest,revision,scoped)};
 }
}
function verifyHead(db:Database,head:Head|null){
 if(!head)return;
 if(!head.scoped)throw new AppError(503,'SERVICE_UNAVAILABLE');
 const {mac:signature,...body}=head.scoped,expected=mac(db,head.digest,head.revision,body);
 if(body.version!==1||body.rowEncoding!=='BSON-v1'||!/^([0-9a-f]{64})$/.test(signature)||!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex')))throw new AppError(503,'INTEGRITY_MISMATCH');
}
export async function scopedFinanceEvidenceMatches(database:Database,expected:FinanceEvidence|undefined,session?:ClientSession){
 const actual=await database.db.collection<Head>('financial_evidence_head').findOne({_id:'finance'},session?{session}:{});
 if(!actual)return !expected?.scopedVersion;
 if(!actual.scoped&&!actual.scopedVersion&&!expected?.scopedVersion)return true;
 try{if(expected?.scopedVersion===1&&actual.scopedVersion!==1)return false;verifyHead(database,actual);return true;}catch{return false;}
}
export async function loadReportingFinance(database:Database,org:string,accountIds:string[]|null,session:ClientSession,budget:()=>void):Promise<{accounts:Account[];journals:Journal[];opening:Row[];proofDigest:string}>{
 budget();const head=await database.db.collection<Head>('financial_evidence_head').findOne({_id:'finance'},{session});verifyHead(database,head);
 const expected=head?.scoped?.tenants[org],collector=new FinanceProofCollector();
 if(accountIds?.length===0)return{accounts:[],journals:[],opening:[],proofDigest:expected?.digest??'EMPTY_FINANCE'};
 let accounts:Account[]=[],journals:Journal[]=[],opening:Row[]=[];let lineCount=0;
 for(const name of tables){
  if(accountIds!==null&&!['financial_accounts','financial_journals'].includes(name))continue;
  if(name.startsWith('opening_')&&head?.format!=='opening-v1')continue;
  const filter:Document={organizationId:org,...(['financial_accounts','financial_journals','opening_files'].includes(name)?{bookId:org,ownerId:org,financialScope:'BUSINESS',currency:'COP'}:{}),...(accountIds===null?{}:name==='financial_accounts'?{_id:{$in:accountIds}}:{'lines.accountId':{$in:accountIds}})};
  const rows:Row[]=[];
  const consume=(row:Row)=>{
   budget();if(name==='financial_journals'){lineCount+=(row['lines'] as unknown[]).length;if(lineCount>200000)throw new AppError(422,'REPORT_SCOPE_TOO_LARGE');}collector.add(name,row);
   if(['financial_accounts','financial_journals','opening_files'].includes(name))rows.push(row);
  };
  const cursor=database.db.collection<Row>(name).find(filter,{session,maxTimeMS:10000}).hint(accountIds!==null&&name==='financial_journals'?'reporting_account_scope':'reporting_financial_scope').sort({_id:1}).batchSize(500);
  try{while(await cursor.hasNext()){const first=await cursor.next();if(first)consume(first);for(const row of cursor.readBufferedDocuments())consume(row);}}finally{await cursor.close();}
  if(name==='financial_accounts')accounts=rows as unknown as Account[];if(name==='financial_journals')journals=rows as unknown as Journal[];if(name==='opening_files')opening=rows;
 }
 if(accountIds===null&&head?.format==='opening-v1'){
  const marker=await database.db.collection<{_id:string;openingId?:string;cutoffDate?:string}>('financial_books').findOne({_id:org,openingId:{$exists:true}},{session,projection:{_id:1,openingId:1,cutoffDate:1}});if(marker)collector.add('opening_book_markers',marker);
 }
 const actual=collector.finish(database,head?.digest??'',head?.revision??0).tenants[org];
 if(accountIds===null){if(actual?.digest!==expected?.digest)throw new AppError(503,'INTEGRITY_MISMATCH');}
 else for(const id of accountIds)if(!actual?.accounts[id]||actual.accounts[id]!==expected?.accounts[id])throw new AppError(503,'INTEGRITY_MISMATCH');
 return{accounts,journals,opening,proofDigest:accountIds===null?expected?.digest??'EMPTY_FINANCE':createHash('sha256').update(encode(accountIds.map(id=>[id,expected?.accounts[id]]))).digest('hex')};
}
// P02 explicitly restricts legacy initialization to registered synthetic groups.
// No route, GET, startup hook, caudelyx_dev/manual or automatic migration.
export async function bootstrapReportingFinance(database:Database,session:ClientSession){
 if(!/^caudelyx_s08_p02_[a-f0-9]{24}$/.test(database.db.databaseName))throw new AppError(403,'ACCESS_DENIED');
 const head=await database.db.collection<Head>('financial_evidence_head').findOne({_id:'finance'},{session});if(!head||!await financialEvidenceMatches(database,head,session))throw new AppError(503,'INTEGRITY_MISMATCH');
 const collector=new FinanceProofCollector();const digest=await financialDigest(database,session,head.format,(name,row)=>collector.add(name,row));
 if(digest!==head.digest)throw new AppError(503,'INTEGRITY_MISMATCH');
  await database.db.collection<Head>('financial_evidence_head').updateOne({_id:'finance',digest:head.digest,revision:head.revision},{$set:{scoped:collector.finish(database,digest,head.revision),scopedVersion:1}},{session});
}
