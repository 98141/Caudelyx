/* eslint-disable security/detect-object-injection -- Closed signed table/root maps, server-owned IDs and counters only. */
import {createHmac,timingSafeEqual} from 'node:crypto';
import type {ClientSession,Document} from 'mongodb';
import type {Database} from '../../shared/database.js';
import {originals,collections} from './catalog.js';
import {ProjectionCodec,hash} from './codec.js';
import {booksTable,globalEvidence,type Row} from './models.js';
const keys=new WeakMap<Database,ProjectionCodec>();
export interface Evidence {_id:string;revision:number;digest:string;previousDigest:string;mac:string}
export const configureManagementEvidence=(db:Database,key:Buffer)=>{if(!keys.has(db))keys.set(db,new ProjectionCodec(createHmac('sha256',key).update('S09:ORIGINALS:v1').digest()));};
export function codec(db:Database){const value=keys.get(db);if(!value)throw Error('Management evidence key unavailable');return value;}
export function signRow(db:Database,name:string,body:Document){const copy={...body};delete copy['mac'];return{...copy,mac:codec(db).seal('ROW:'+db.db.databaseName+':'+name,copy)} as Row;}
export function verifyRow(db:Database,name:string,row:Document){const {mac,...body}=row;return codec(db).verify('ROW:'+db.db.databaseName+':'+name,body,mac);}
export const tableRoot=(rows:Document[])=>({count:rows.length,hash:hash(rows.map(r=>[r['_id'],hash(r)]).sort(([a],[b])=>String(a)<String(b)?-1:String(a)>String(b)?1:0))});
export async function managementHead(db:Database,s?:ClientSession){return await db.db.collection<Evidence>(globalEvidence).findOne({_id:'management'},s?{session:s}:{});}
export async function managementEvidenceMatches(db:Database,expected:{digest:string;revision:number}|undefined,s?:ClientSession):Promise<boolean>{
 try{
  const options=s?{session:s}:{},head=await managementHead(db,s);
  if(!head){if(expected)return false;for(const name of originals)if(await db.db.collection(name).countDocuments({},options))return false;return true;}
  if(!expected||head.digest!==expected.digest||head.revision!==expected.revision)return false;
  const {mac,...body}=head;if(!codec(db).verify('GLOBAL:'+db.db.databaseName,body,mac))return false;
  const heads=await db.db.collection<Document&{_id:string}>(collections.heads).find({},options).sort({_id:1}).toArray();
  if(hash(heads.map(h=>[h._id,hash(h)]))!==head.digest)return false;
  const seen=new Set<string>();
  for(const h of heads){
   const {mac:signature,...payload}=h;if(!new ProjectionCodecKey(db).verify(payload,signature))return false;
   const book=await db.db.collection<Row>(booksTable).findOne({_id:h._id},options);
   if(!book||!verifyRow(db,booksTable,book)||hash(book)!==h['bookHash'])return false;seen.add(h._id);
   const roots=h['roots'] as Record<string,{hash:string;count:number}>;
   for(const name of originals){if(name===globalEvidence||name===booksTable)continue;
    const rows=await db.db.collection<Row>(name).find({bookId:h._id},options).sort({_id:1}).toArray();
    if(rows.some(row=>!verifyRow(db,name,row))||hash(tableRoot(rows))!==hash(roots[name]))return false;
   }
  }
  for(const name of originals){if(name===globalEvidence)continue;const filter=name===booksTable?{_id:{$nin:[...seen]}}:{bookId:{$nin:[...seen]}};if(await db.db.collection<Row>(name).countDocuments(filter,options))return false;}
  return true;
 }catch{return false;}
}
// The transport key is purpose-derived from the same existing cursor key; it is not a new persistent anchor.
const transports=new WeakMap<Database,ProjectionCodec>();
export function configureManagementTransport(db:Database,key:Buffer){if(!transports.has(db))transports.set(db,new ProjectionCodec(key));}
export function transportCodec(db:Database){const c=transports.get(db);if(!c)throw Error('Management transport key unavailable');return c;}
class ProjectionCodecKey{constructor(readonly db:Database){}verify(body:unknown,mac:unknown){return transportCodec(this.db).verify('HEAD',body,mac);}}
export function sameDigest(a:string,b:string){return /^[0-9a-f]{64}$/.test(a)&&/^[0-9a-f]{64}$/.test(b)&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
