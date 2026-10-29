import {BSON,type Document} from 'mongodb';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {AppError} from '../../shared/errors.js';

const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):
  value!==null&&typeof value==='object'?Object.fromEntries(Object.entries(value)
    .sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)])):value;
export const encode=(value:unknown)=>JSON.stringify(canonical(BSON.EJSON.serialize(value,{relaxed:false})));
const frame=(value:string)=>`${Buffer.byteLength(value)}:${value}`;
export const hash=(value:unknown)=>createHash('sha256').update(frame('S09-AUTH-BOOKS-1'))
  .update(frame(encode(value))).digest('hex');
export const copy=<T>(value:T):T=>BSON.EJSON.parse(BSON.EJSON.stringify(value,{relaxed:false}),{relaxed:false}) as T;
export const unavailable=():never=>{throw new AppError(503,'SERVICE_UNAVAILABLE');};
export class ProjectionCodec {
  private readonly key:Buffer;
  constructor(key:Buffer){this.key=createHmac('sha256',key).update('CAUDELYX:S09:BOOKS:KEY:v1').digest();}
  seal(purpose:string,body:unknown):string{
    return createHmac('sha256',this.key).update(frame(purpose)).update(frame(encode(body))).digest('hex');
  }
  verify(purpose:string,body:unknown,mac:unknown):boolean{
    return typeof mac==='string'&&/^[a-f0-9]{64}$/.test(mac)&&timingSafeEqual(Buffer.from(mac,'hex'),Buffer.from(this.seal(purpose,body),'hex'));
  }
}
export interface Mutation {namespace:string;key:unknown;before:string|null;after:string|null}
export const mutation=(namespace:string,before:Document|null,after:Document|null):Mutation=>({
  namespace,key:copy((after??before)!['_id']),before:before===null?null:hash(before),after:after===null?null:hash(after),
});
export const mutationKey=(item:Mutation)=>encode([item.namespace,item.key]);
export function orderedPaths(items:Mutation[]):Mutation[]{
  const paths=new Map<string,Mutation[]>();
  for(const item of items){const key=mutationKey(item),path=paths.get(key)??[];path.push(item);paths.set(key,path);}
  return [...paths].sort(([a],[b])=>a<b?-1:a>b?1:0).flatMap(([,path])=>path);
}
export const transactionId=(sessionId:unknown,number:unknown)=>hash({session:sessionId,number:String(number)});
