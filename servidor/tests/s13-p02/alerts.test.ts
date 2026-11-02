import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateAlerts,acknowledge,type Candidate} from '../../src/modules/simulation/alerts.js';
import {factCandidates,type Capture} from '../../src/modules/simulation/sources.js';
import {base} from './oracle.js';
const options={actorScopeKey:'only-owner-synthetic',thresholdKey:'days7-percent25',now:Date.parse('2026-10-31T17:00:00Z'),sourceDigest:'a'.repeat(64),completelyEvaluated:['LOAN_OVERDUE'] as 'LOAN_OVERDUE'[]};
const candidate:Candidate={type:'LOAN_OVERDUE',class:'FACT',entityKey:'synthetic-loan',condition:true,amount:{value:'30.00',status:'COMPLETE',reasons:[],knownPartial:null},effectiveDate:'2026-10-30',sourceRefs:[],runId:null};
test('exact concentration is strictly greater than25%; past expense/liability remain due, window includes day7',()=>{
 const c:Capture={base:base(),factCoverage:true,facts:[
  {type:'CONCENTRATION',entityKey:'equal',date:'2026-10-31',amount:'25.00',denominator:'100.00',complete:true,sourceRefs:[]},
  {type:'CONCENTRATION',entityKey:'above',date:'2026-10-31',amount:'25.01',denominator:'100.00',complete:true,sourceRefs:[]},
  {type:'EXPENSE_DUE',entityKey:'past',date:'2026-10-01',amount:'1.00',complete:true,sourceRefs:[]},
  {type:'LOAN_DUE',entityKey:'day7',date:'2026-11-07',amount:'1.00',complete:true,sourceRefs:[]},
  {type:'LOAN_DUE',entityKey:'day8',date:'2026-11-08',amount:'1.00',complete:true,sourceRefs:[]}
 ]};
 assert.deepEqual(factCandidates(c,{dueWithinDays:7,concentrationThreshold:'25.00'}).map(c=>c.condition),[false,true,true,true,false]);
});
test('alert dedupe, ACK, complete resolution and a new episode never pay or invent a predicate',()=>{
 const first=evaluateAlerts([candidate],[],options);assert.equal(first.created,1);const ack=acknowledge(first.updated[0]!,options.now);const repeat=evaluateAlerts([candidate],[ack],{...options,sourceDigest:'b'.repeat(64)});assert.equal(repeat.created,0);assert.equal(repeat.updated[0]!.state,'ACKNOWLEDGED');assert.equal(repeat.updated[0]!.id,ack.id);
 const unknown=evaluateAlerts([{...candidate,condition:null}],repeat.updated,options);assert.equal(unknown.updated[0]!.freshness,'STALE');assert.equal(unknown.updated[0]!.state,'ACKNOWLEDGED');
 const resolved=evaluateAlerts([{...candidate,condition:false}],unknown.updated,options);assert.equal(resolved.resolved,1);assert.equal(resolved.updated[0]!.state,'RESOLVED');const recurrence=evaluateAlerts([candidate],resolved.updated,options);assert.equal(recurrence.updated[0]!.state,'ACTIVE');assert.equal(recurrence.updated[0]!.episode,2);assert.equal(recurrence.updated[0]!.ackAt,null);
 assert.equal(candidate.amount.value,'30.00');assert.equal(candidate.condition,true);
});
test('an incomplete evaluation cannot resolve an absent predicate and stale ACK is refused',()=>{
 const first=evaluateAlerts([candidate],[],options).updated;
 const unknown=evaluateAlerts([],first,{...options,completelyEvaluated:[]});assert.equal(unknown.updated[0]!.state,'ACTIVE');assert.equal(unknown.updated[0]!.freshness,'STALE');assert.throws(()=>acknowledge(unknown.updated[0]!,options.now),/SOURCE_CONFLICT/);
 assert.throws(()=>acknowledge(first[0]!,options.now+300001),/SOURCE_CONFLICT/);
});
