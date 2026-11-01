/* eslint-disable security/detect-object-injection -- Closed explicit DTO fields, technical persistence metadata is never spread into API objects. */
import type {Data,Row,EngineBase} from './models.js';
import {metric} from './engine.js';
import {cents} from './money.js';
export const fields=(r:Data,keys:string[])=>Object.fromEntries(keys.map(k=>[k,r[k]]));
export const tag=(r:Row)=>'"s12:'+r._id+':'+r.version+'"';
export const scenarioDTO=(r:Row)=>({id:r._id,...fields(r,['version','status','name','currentVersion','createdAt','expiresAt'])});
export const versionDTO=(r:Row)=>({id:r._id,...fields(r,['scenarioId','number','baseId','horizonDays','assumptions','alternatives','digest','createdAt','expiresAt'])});
export const runDTO=(r:Row)=>({id:r._id,...fields(r,['scenarioId','scenarioVersion','baseId','state','version','createdAt','expiresAt','sourceDigest','errorCode','retryable'])});
export const alertDTO=(r:object)=>fields(r as Data,['id','type','class','severity','state','freshness','episode','version','conditionFingerprint','amount','effectiveDate','lastEvaluatedAt','expiresAt','ackAt','sourceRefs','runId']);
export const commandDTO=(r:Row)=>fields(r,['key','purpose','state','resourceId','requestDigest','expiresAt']);
export function baseDTO(r:Row,b:EngineBase,token:string){
 const summary=(name:'cashBook'|'available'|'reserved'|'held'|'custodyProvisional'|'custodyConfirmed'|'committed')=>metric(b.books.reduce((n,v)=>n+cents(v[name]),0n));
 return{id:r._id,scope:{kind:r.scopeKind,bookId:r.bookId,ownerId:r.ownerId},asOf:b.asOf,knownAt:b.knownAt,capturedAt:r.createdAt,expiresAt:r.expiresAt,freshUntil:r['freshUntil'],baseToken:token,sourceDigest:b.sourceDigest,schemaVersion:'1.0.0',policyVersion:'S12-SIMULATION-1.0',currency:'COP',cashBook:summary('cashBook'),available:summary('available'),reserved:summary('reserved'),held:summary('held'),custodyProvisional:summary('custodyProvisional'),custodyConfirmed:summary('custodyConfirmed'),committed:summary('committed'),coverage:b.books.every(v=>v.coverage==='COMPLETE')?'COMPLETE':'INCOMPLETE',sourceRefs:b.books.flatMap(v=>v.sourceRefs)};
}
