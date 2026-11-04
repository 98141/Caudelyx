import {afterEach,expect,it,vi} from 'vitest';
import {bumpSessionEpoch,callDocument,resetSessionMemory} from '../../src/shared/api';
import {DiscardedRequest} from '../../src/shared/contracts';
import {createSlot,keyFor,clearSimpleMemory} from '../../src/features/simple/memory';
import {postKnown} from '../../src/features/simple/transport';
import {metricText,presentedDifference} from '../../src/features/simple/model';
afterEach(()=>{vi.unstubAllGlobals();resetSessionMemory();clearSimpleMemory();});
it('raw mode-simple document remains raw and keeps ETag while old envelope is unchanged',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({rows:[],totalCount:0}),{headers:{ETag:'"native:1"'}})));const r=await callDocument<{rows:unknown[]}>('GET','/api/modo-simple/v1/books/book/monthly-loans');expect(r.data.rows).toEqual([]);expect(r.etag).toBe('"native:1"');
});
it('a late successful response cannot cross session generation',async()=>{
 let resolve!:(r:Response)=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(r=>{resolve=r;})));const work=callDocument('GET','/api/modo-simple/v1/books/book/monthly');bumpSessionEpoch();resolve(new Response(JSON.stringify({principal:'private'})));await expect(work).rejects.toBeInstanceOf(DiscardedRequest);
});
it('lost POST response keeps the same idempotency key and rejects a changed intent',async()=>{
 let attempts=0;const seen:string[]=[];vi.stubGlobal('fetch',vi.fn(async(path:string,init?:RequestInit)=>{if(path.includes('/auth/csrf'))return new Response(JSON.stringify({data:{csrfToken:'synthetic'},requestId:'synthetic'}));seen.push(new Headers(init?.headers).get('Idempotency-Key')!);if(++attempts===1)throw new TypeError('lost response');return new Response(JSON.stringify({status:'CONFIRMED'}));}));const slot=createSlot(),key=keyFor(slot,'same');await expect(postKnown(slot,key,'/api/modo-simple/v1/books/book/distributions-commits',{executionKey:key},'"book:1"',undefined,'finish')).rejects.toMatchObject({code:'OFFLINE'});expect(keyFor(slot,'same')).toBe(key);expect(()=>keyFor(slot,'different')).toThrow();await postKnown(slot,key,'/api/modo-simple/v1/books/book/distributions-commits',{executionKey:key},'"book:1"',undefined,'finish');expect(seen).toEqual([key,key]);
});
it('unknown official components never become a zero total or a computed difference',()=>{
 const missing={value:null,status:'INCOMPLETE' as const,reasons:['UNKNOWN'],sourceRefs:[]},zero={value:'0.00',status:'COMPLETE' as const,reasons:[],sourceRefs:[]};expect(metricText(missing)).toBe('No disponible');expect(presentedDifference(missing,zero)).toBe('No disponible');expect(metricText(zero)).toContain('0');
});
