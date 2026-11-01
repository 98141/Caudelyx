import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {BSON} from 'mongodb';
export const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value!==null&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)])):value;
export const encode=(value:unknown)=>JSON.stringify(canonical(BSON.EJSON.serialize(value,{relaxed:false})));
export const hash=(value:unknown)=>createHash('sha256').update('CAUDELYX:S12:v1\0').update(encode(value)).digest('hex');
export const copy=<T>(value:T):T=>BSON.EJSON.parse(BSON.EJSON.stringify(value,{relaxed:false}),{relaxed:false}) as T;
export class Codec {
 private readonly key:Buffer;
 constructor(key:Buffer){this.key=createHmac('sha256',key).update('CAUDELYX:S12:TECHNICAL:v1').digest();}
 seal(purpose:string,value:unknown){return createHmac('sha256',this.key).update(purpose+'\0').update(encode(value)).digest('hex');}
 verify(purpose:string,value:unknown,signature:unknown){return typeof signature==='string'&&/^[a-f0-9]{64}$/.test(signature)&&timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(this.seal(purpose,value),'hex'));}
}
