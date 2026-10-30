import {test} from 'node:test';
import assert from 'node:assert/strict';
import {signedCents,amountReader} from '../../src/modules/wealth/models.js';
import {money,MAX_CENTS,storedCents} from '../../src/modules/finance/money.js';
import {BSON} from 'mongodb';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {encode,hash,rowHashes,ProjectionCodec} from '../../src/modules/obligations/codec.js';
import {ManagementStore} from '../../src/modules/obligations/store.js';
import type {Database} from '../../src/shared/database.js';
import type {ClientSession} from 'mongodb';
import {signRow,tableRoot} from '../../src/modules/obligations/evidence.js';
import {collections} from '../../src/modules/obligations/catalog.js';
import type {Scope} from '../../src/modules/obligations/models.js';
test('S10 signed reservation/cost deltas retain exact cents and canonical zero',()=>{
 assert.equal(signedCents('20000000.00')+signedCents('-8000000.00'),1200000000n);
 for(const value of [-MAX_CENTS,-1n,0n,1n,MAX_CENTS])assert.equal(signedCents(money(value)),value);
 for(const invalid of ['-0.00','--1.00','-01.00','1e2','1.001','+1.00','NaN'])assert.throws(()=>signedCents(invalid));
 assert.throws(()=>money(MAX_CENTS+1n));
 const read=amountReader();for(const value of ['0.00','0.01','2.50','200000000.00','9999999999999999.99'])for(let i=0;i<10;i++){const decimal=BSON.Decimal128.fromString(value);assert.equal(read(decimal),storedCents(decimal));}for(const value of ['-1.00','NaN','Infinity','1.001'])assert.throws(()=>read(BSON.Decimal128.fromString(value)));
});
test('S10 signed head format2 is rejected by the actual frozen S9 read gate; current reader preserves legitimate S9 format1',async()=>{
 const filename=resolve('dist-s09-backend/src/modules/obligations/store.js');assert.equal(createHash('sha256').update(await readFile(filename)).digest('hex'),'5e9ca9f01040661ab46cc131111095a048d8d04e06e9019a2daa4015247a7548');const old=await import(pathToFileURL(filename).href) as {ManagementStore:typeof ManagementStore},key=Buffer.alloc(32,31),codec=new ProjectionCodec(key);let head:Record<string,unknown>={};
 const database={db:{databaseName:'synthetic',collection:()=>({findOne:async()=>head})}} as unknown as Database,legacy=new old.ManagementStore(database,key,()=>0),current=new ManagementStore(database,key,()=>0);
 for(const version of [1,2]){const body={_id:'book',bookId:'book',databaseName:'synthetic',formatVersion:version,...(version===2?{catalogVersion:2,fundDeltaVersion:1}:{}),roots:{},bookHash:'a'.repeat(64)};head={...body,mac:codec.seal('HEAD',body)};assert.equal((await current.head('book',{} as ClientSession))?.formatVersion,version);if(version===1)assert.equal((await legacy.head('book',{} as ClientSession))?.formatVersion,1);else await assert.rejects(()=>legacy.head('book',{} as ClientSession),(e:unknown)=>e instanceof Error&&'code'in e&&e.code==='INTEGRITY_MISMATCH');}
});

test('S10 binary proof bridge rehashes all fresh BSON bytes, rejects same-count tamper and never caches authority or rows',async()=>{
 const key=Buffer.alloc(32,71),codec=new ProjectionCodec(key),scope:Scope={kind:'PERSONAL',bookId:'book',ownerId:'owner'},name='s10_funds_personal';let head:Record<string,unknown>={},raw:Buffer[]=[];
 const database={db:{databaseName:'synthetic',collection:(table:string)=>table===collections.heads?{findOne:async()=>head}:{find:()=>({sort:()=>({toArray:async()=>raw})})}}} as unknown as Database,store=new ManagementStore(database,key,()=>0),session={} as ClientSession;
 const original=signRow(database,name,{_id:'fund',...scope,domainKind:scope.kind,version:1,recordedAt:'2026-10-29T18:00:00.000Z',amount:BSON.Decimal128.fromString('20000000.00'),label:'SYN'}),body={_id:'book',bookId:'book',databaseName:'synthetic',formatVersion:2,catalogVersion:2,fundDeltaVersion:1,roots:{[name]:tableRoot([original])}};head={...body,mac:codec.seal('HEAD',body)};raw=[Buffer.from(BSON.serialize(original))];
 const first=await store.all(name,scope,session);first[0]!['label']='MUTATED-LOCAL-RETURN';assert.equal((await store.all(name,scope,session))[0]!['label'],'SYN');
 raw=[Buffer.from(BSON.serialize({...original,label:'CORRUPT'}))];await assert.rejects(()=>store.all(name,scope,session),(e:unknown)=>e instanceof Error&&'code'in e&&e.code==='INTEGRITY_MISMATCH');
 raw=[];await assert.rejects(()=>store.all(name,scope,session));raw=[Buffer.from(BSON.serialize(Object.fromEntries(Object.entries(original).reverse())))];assert.equal((await store.all(name,scope,session))[0]!['label'],'SYN');
 store.clearBinaryProofs();assert.equal((await store.all(name,scope,session)).length,1);head={...head,mac:'0'.repeat(64)};await assert.rejects(()=>store.all(name,scope,session));
});
test('S10 encoding remains byte/hash/HMAC compatible with the immutable S9 compiled oracle across BSON, Unicode and fallbacks',async()=>{
 const filename=resolve('dist-s09-backend/src/modules/obligations/codec.js'),bytes=await readFile(filename);assert.equal(createHash('sha256').update(bytes).digest('hex'),'28bc50abd51b144fe6aef54a36eb3db53004281794a34c12b3d95fa7ba2d25ae');
 const legacy=await import(pathToFileURL(filename).href) as {encode:typeof encode;hash:typeof hash;ProjectionCodec:typeof ProjectionCodec},key=Buffer.alloc(32,42),oldCodec=new legacy.ProjectionCodec(key),nextCodec=new ProjectionCodec(key);
 const special=[null,undefined,true,false,0,-0,1,-1,2147483647,2147483648,-2147483649,1.5,NaN,Infinity,-Infinity,9007199254740991,'áé漢字😀\u0000\n',new Date('2026-10-29T17:00:00.000Z'),new BSON.Decimal128(Buffer.alloc(16)),BSON.Decimal128.fromString('9999999999999999.99'),new BSON.Int32(7),new BSON.Double(1.25),BSON.Long.fromString('9223372036854775807'),new BSON.ObjectId('0123456789abcdef01234567'),new BSON.Binary(Buffer.from([0,1,127,255])),new BSON.Timestamp({t:123,i:4}),new BSON.MinKey(),new BSON.MaxKey(),/á+b/im,JSON.parse('{"__proto__":"own","10":"ten","2":"two"}') as unknown];
 for(let i=0;i<1000;i++){
  const value=special.at(i%special.length),row={_id:'SYN-'+i,bookId:'book',ownerId:'owner',domainKind:i%2?'BUSINESS':'PERSONAL',version:i+1,recordedAt:'2026-10-29T17:00:00.000Z',mac:'a'.repeat(64),details:{z:value,a:[value,{amount:BSON.Decimal128.fromString('0.00'),negative:BSON.Decimal128.fromString('-12.50')}],'😀':'sí'},lines:Array.from({length:5},(_,k)=>({accountId:'account-'+k,debit:BSON.Decimal128.fromString('2.50'),credit:BSON.Decimal128.fromString('0.00')}))};
  assert.equal(encode(row),legacy.encode(row));assert.equal(hash(row),legacy.hash(row));assert.equal(rowHashes([row]).get(row._id),legacy.hash(row));assert.equal(nextCodec.seal('SYN',row),oldCodec.seal('SYN',row));assert.equal(oldCodec.verify('SYN',row,nextCodec.seal('SYN',row)),true);
 }
 const getter={bookId:'book',domainKind:'PERSONAL',mac:'a'.repeat(64),get value(){return 'owned';}},custom={bookId:'book',domainKind:'PERSONAL',mac:'a'.repeat(64),nested:{toJSON:()=>({x:'value'})}};for(const row of [getter,custom])assert.equal(encode(row),legacy.encode(row));
});
