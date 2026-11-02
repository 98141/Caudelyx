import {evidenceIdentity} from '../local-recovery/identity.js';
/* eslint-disable security/detect-object-injection -- Root keys are a closed technical catalog, never HTTP keys. */
import {createHash,createHmac} from 'node:crypto';
import type {ClientSession,Document} from 'mongodb';
import type {Database} from '../../shared/database.js';
import {AppError} from '../../shared/errors.js';
import {Codec,hash} from './codec.js';
import {tables} from './models.js';
export const controls={heads:'s12_projection_heads',manifests:'s12_projection_manifests',barriers:'s12_projection_barriers'} as const;
export const protectedTables=[...tables,controls.heads,controls.manifests,controls.barriers];
interface Config {codec:Codec;keyDigest:string}
const configured=new WeakMap<Database,Config>();
export function configureSimulationEvidence(database:Database,key:Buffer){const digest=createHash('sha256').update(key).digest('hex'),old=configured.get(database);if(old&&old.keyDigest!==digest)throw Error('S12 evidence key cannot change');if(!old)configured.set(database,{codec:new Codec(createHmac('sha256',key).update('S12:EVIDENCE').digest()),keyDigest:digest});}
export const codec=(database:Database)=>{const c=configured.get(database);if(!c)throw new AppError(503,'INTEGRITY_MISMATCH');return c.codec;};
export interface Head extends Document {_id:string;actorId:string;scopeKind:string;bookId:string;ownerId:string;restoreEpoch:string;catalogVersion:1;technicalRevision:number;roots:Record<string,{count:number;hash:string}>;lastManifest:string;previousManifest:string|null;mac:string}
export interface Evidence {format:'simulation-v1';digest:string;revision:number}
export function signedBody(row:Document){const{mac,...body}=row;void mac;return body;}
export function verifyRow(database:Database,table:string,row:Document){return codec(database).verify('ROW:'+table,signedBody(row),row['mac']);}
export function sealRow<T extends Document>(database:Database,table:string,row:T):T&{mac:string}{return{...row,mac:codec(database).seal('ROW:'+table,row)};}
export async function simulationHead(database:Database,s?:ClientSession):Promise<Evidence|undefined>{
 const row=await database.db.collection<Head>(controls.heads).findOne({_id:'GLOBAL'},s?{session:s}:{});
 if(!row)return undefined;
 if(!codec(database).verify('HEAD',signedBody(row),row.mac))throw new AppError(503,'INTEGRITY_MISMATCH');
 return{format:'simulation-v1',digest:hash(row),revision:row.technicalRevision};
}
export async function simulationEvidenceMatches(database:Database,expected:Evidence|undefined){
 const existing=new Set((await database.db.listCollections().toArray()).map(r=>r.name));
 const global=await database.db.collection<Head>(controls.heads).findOne({_id:'GLOBAL'});
 if(!global){if(expected)return false;for(const name of tables)if(existing.has(name)&&await database.db.collection(name).countDocuments())return false;return true;}
 if(!expected||expected.format!=='simulation-v1'||expected.digest!==hash(global)||expected.revision!==global.technicalRevision||protectedTables.some(n=>!existing.has(n)))return false;
 if(!codec(database).verify('HEAD',signedBody(global),global.mac))return false;
 if(global.lastManifest.startsWith('FAULT:'))return false;
 let manifestId:string|null=global.lastManifest,expectedGlobal:string|null=hash(global);const chain=new Set<string>();
 while(manifestId){
  if(chain.has(manifestId)||chain.size>100000)return false;chain.add(manifestId);
  const manifest=await database.db.collection<Document&{_id:string}>(controls.manifests).findOne({_id:manifestId});
  if(!manifest||manifest['databaseName']!==evidenceIdentity(database)||!codec(database).verify('MANIFEST',signedBody(manifest),manifest['mac'])||manifest['global']!==expectedGlobal)return false;
  expectedGlobal=manifest['previousGlobal'] as string|null;manifestId=manifest['previousManifest'] as string|null;
 }
 if(expectedGlobal!==null||await database.db.collection(controls.manifests).countDocuments()!==chain.size)return false;
 const heads=await database.db.collection<Head>(controls.heads).find({_id:{$ne:'GLOBAL'}}).sort({_id:1}).toArray();
 const roots={};
 for(const h of heads){if(!codec(database).verify('HEAD',signedBody(h),h.mac))return false;
  for(const name of tables){const rows=await database.db.collection(name).find({actorId:h.actorId,scopeKind:h.scopeKind,bookId:h.bookId,ownerId:h.ownerId}).sort({_id:1}).toArray();if(rows.some(r=>!verifyRow(database,name,r)))return false;const root={count:rows.length,hash:hash(rows.map(r=>[r._id,hash(r)]))};if(hash(root)!==hash(h.roots[name]))return false;}
  Object.assign(roots,{[h._id]:{count:1,hash:hash(h)}});
 }
 if(hash(roots)!==hash(global.roots))return false;
 for(const name of tables){const count=await database.db.collection(name).countDocuments();let total=0;for(const h of heads)total+=h.roots[name]?.count??0;if(count!==total)return false;}
 return true;
}
