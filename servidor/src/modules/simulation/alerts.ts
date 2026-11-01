import {createHash} from 'node:crypto';
import type {Metric,SourceRef,Outcome,Evaluation} from './models.js';
import {cents} from './money.js';
export const factTypes=['LOAN_DUE','LOAN_OVERDUE','CUSTODY_PENDING','DELIVERY_PENDING','RECONCILIATION_PENDING','EXPENSE_DUE','LIABILITY_DUE','CONCENTRATION'] as const;
export const scenarioTypes=['SCENARIO_DEFICIT','SCENARIO_RESERVE_SHORTFALL','SCENARIO_INCOMPLETE'] as const;
export type AlertType=typeof factTypes[number]|typeof scenarioTypes[number];
export interface Candidate {type:AlertType;class:'FACT'|'SCENARIO';entityKey:string;condition:boolean|null;amount:Metric;effectiveDate:string;sourceRefs:SourceRef[];runId:string|null}
export interface AlertData {id:string;type:AlertType;class:'FACT'|'SCENARIO';severity:'INFO'|'WARNING'|'CRITICAL';state:'ACTIVE'|'ACKNOWLEDGED'|'RESOLVED'|'EXPIRED';freshness:'CURRENT'|'STALE';episode:number;version:number;conditionFingerprint:string;amount:Metric;effectiveDate:string;lastEvaluatedAt:string;expiresAt:string;ackAt:string|null;sourceRefs:SourceRef[];runId:string|null}
export interface StoredAlert extends AlertData {dedupeKey:string;entityKey:string;thresholdKey:string;sourceDigest:string}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const dedupeKey=(actorScopeKey:string,thresholdKey:string,c:Candidate)=>hash([actorScopeKey,c.type,c.entityKey,'S12-ALERTS-1.0',thresholdKey,c.runId??'FACT']);
const uuid=(value:string)=>value.slice(0,8)+'-'+value.slice(8,12)+'-4'+value.slice(13,16)+'-8'+value.slice(17,20)+'-'+value.slice(20,32);
const severity=(type:AlertType):AlertData['severity']=>['SCENARIO_DEFICIT','SCENARIO_RESERVE_SHORTFALL'].includes(type)?'CRITICAL':['LOAN_DUE','EXPENSE_DUE','LIABILITY_DUE'].includes(type)?'INFO':'WARNING';
export function evaluateAlerts(candidates:Candidate[],previous:StoredAlert[],options:{actorScopeKey:string;thresholdKey:string;now:number;sourceDigest:string;completelyEvaluated:AlertType[]}){
 const updated:StoredAlert[]=[],seen=new Set<string>(),now=new Date(options.now).toISOString();let created=0,changed=0,resolved=0;
 const keyFor=(candidate:Candidate)=>dedupeKey(options.actorScopeKey,options.thresholdKey,candidate);
 const work=(candidate:Candidate,prior?:StoredAlert)=>{
  const dedupeKey=keyFor(candidate);if(seen.has(dedupeKey))throw Error('DUPLICATE_ALERT_PREDICATE');seen.add(dedupeKey);
  if(candidate.condition===null){if(prior)updated.push({...prior,freshness:'STALE',version:prior.version+1});return;}
  if(!candidate.condition){if(prior&&['ACTIVE','ACKNOWLEDGED'].includes(prior.state)){updated.push({...prior,state:'RESOLVED',freshness:'CURRENT',version:prior.version+1,lastEvaluatedAt:now,sourceDigest:options.sourceDigest,expiresAt:new Date(Math.min(Date.parse(prior.expiresAt),options.now+7*86400000)).toISOString()});resolved++;}return;}
  const expired=prior!==undefined&&(prior.state==='EXPIRED'||Date.parse(prior.expiresAt)<=options.now),recurrence=prior?.state==='RESOLVED',episode=(prior?.episode??0)+(prior===undefined||expired||recurrence?1:0),freshEpisode=prior===undefined||expired||recurrence;
  const conditionFingerprint=hash([candidate.type,candidate.entityKey,candidate.amount,candidate.effectiveDate,options.thresholdKey]);
  const record:StoredAlert={id:expired?uuid(hash([dedupeKey,episode,now])):prior?.id??uuid(dedupeKey),type:candidate.type,class:candidate.class,severity:severity(candidate.type),state:!freshEpisode&&prior?.state==='ACKNOWLEDGED'?'ACKNOWLEDGED':'ACTIVE',freshness:'CURRENT',episode,version:(prior?.version??0)+1,conditionFingerprint,amount:candidate.amount,effectiveDate:candidate.effectiveDate,lastEvaluatedAt:now,expiresAt:freshEpisode?new Date(options.now+30*86400000).toISOString():prior!.expiresAt,ackAt:freshEpisode?null:prior!.ackAt,sourceRefs:candidate.sourceRefs,runId:candidate.runId,dedupeKey,entityKey:candidate.entityKey,thresholdKey:options.thresholdKey,sourceDigest:options.sourceDigest};
  updated.push(record);if(prior===undefined||expired)created++;else changed++;
 };
 for(const c of candidates){const prior=previous.find(p=>p.dedupeKey===keyFor(c));work(c,prior);}
 for(const prior of previous){if(seen.has(prior.dedupeKey)||prior.thresholdKey!==options.thresholdKey)continue;
  if(Date.parse(prior.expiresAt)<=options.now){updated.push({...prior,state:'EXPIRED',freshness:'STALE',version:prior.version+1});continue;}
  work({type:prior.type,class:prior.class,entityKey:prior.entityKey,condition:options.completelyEvaluated.includes(prior.type)?false:null,amount:prior.amount,effectiveDate:prior.effectiveDate,sourceRefs:prior.sourceRefs,runId:prior.runId},prior);
 }
 return{updated,created,changed,resolved};
}
export function scenarioCandidates(result:Evaluation,runId:string,asOf:string):Candidate[]{
 const output:Candidate[]=[];
 for(const r of result.reserveShortfalls??[])output.push({type:'SCENARIO_RESERVE_SHORTFALL',class:'SCENARIO',entityKey:r.outcomeId+':'+r.fundId,condition:true,amount:{value:r.amount,status:'COMPLETE',reasons:[],knownPartial:null},effectiveDate:r.date,sourceRefs:[],runId});
 for(const o of result.outcomes){const metric=o.metrics.peakDeficit,complete=metric.value!==null,knownBook=result.bookDays.find(d=>d.outcomeId===o.id&&d.minimum!==null&&cents(d.minimum)<0n);
  output.push({type:'SCENARIO_DEFICIT',class:'SCENARIO',entityKey:o.id,condition:complete?cents(metric.value!)>0n:knownBook!==undefined?true:null,amount:metric,effectiveDate:o.firstDeficitDate??asOf,sourceRefs:[],runId});
  output.push({type:'SCENARIO_INCOMPLETE',class:'SCENARIO',entityKey:o.id,condition:outcomeIncomplete(o),amount:{value:null,status:'NOT_APPLICABLE',reasons:[],knownPartial:null},effectiveDate:asOf,sourceRefs:[],runId});
 }
 return output;
}
export function acknowledge(alert:StoredAlert,now:number):StoredAlert{
 if(alert.freshness!=='CURRENT'||Date.parse(alert.lastEvaluatedAt)+300000<=now||Date.parse(alert.expiresAt)<=now)throw Error('SOURCE_CONFLICT');
 if(alert.state==='ACKNOWLEDGED')return alert;
 if(alert.state!=='ACTIVE')throw Error('RUN_STATE_CONFLICT');
 return{...alert,state:'ACKNOWLEDGED',ackAt:new Date(now).toISOString(),version:alert.version+1};
}
export function outcomeIncomplete(o:Outcome){return o.coverage!=='COMPLETE'||o.simulability!=='SIMULABLE'||Object.values(o.metrics).some(m=>['INCOMPLETE','UNAVAILABLE'].includes(m.status));}
