/* eslint-disable security/detect-non-literal-fs-filename -- Exact registered owned group marker path in synthetic fixtures. */
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {s09Profile} from './profile.js';
import {ProjectionRuntime} from '../../src/modules/reporting/projection/service.js';
import {managementContract} from '../../src/modules/obligations/contract.js';
import {today} from '../../src/modules/obligations/calendar.js';
import type {Data} from '../../src/modules/obligations/models.js';
export const code=(v:string)=>(e:unknown)=>e instanceof Error&&'code'in e&&e.code===v;
export async function world(group:Awaited<ReturnType<typeof s09Profile>>,clockValue=Date.parse('2026-10-28T12:00:00-05:00')){
 const setup=performance.now(),f=await group.fixture();await group.phase('setup',performance.now()-setup);const seed=performance.now();f.clock.value=clockValue;const a=await f.actor();
 const org=(await f.runtime.organizations.create(a.issued.context,{name:'Organización sintética S09',currency:'COP',timezone:'America/Bogota'},randomUUID())).data.organization.id;
 const account=async(code:string,accountClass='ASSET',kind='GENERAL')=>{const payload={code,name:'Cuenta sintética '+code,currency:'COP',accountClass,kind};return(await f.runtime.finance.mutate(a.issued.context,'createAccount',org,payload,randomUUID())).data as{id:string;version:number};};
 const bank=await account('BANK_S09','ASSET','BANK'),equity=await account('EQUITY_S09','EQUITY');
 const capital={currency:'COP',effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN-S09-CAPITAL',description:'Capital sintético S09',lines:[{accountId:bank.id,debit:'20000000.00',credit:'0.00'},{accountId:equity.id,debit:'0.00',credit:'20000000.00'}]},key=randomUUID();
 await f.proof(a,'FINANCE_JOURNAL_POST',{organizationId:org,idempotencyKey:key,payload:capital});await f.runtime.finance.mutate(a.issued.context,'postJournal',org,capital,key);await f.restore.flush();
 const owner=async()=>{const o=JSON.parse(await readFile(join(group.folder,'owner.json'),'utf8')) as{pid:number;runId:string;names:string[]};return o.pid===process.pid&&o.runId===group.runId&&o.names[0]===f.database.db.databaseName;};
 await group.phase('seed',performance.now()-seed);const verification=performance.now();const service=f.runtime.obligations;await service.prepareOwned(owner);const projection=await ProjectionRuntime.createOwned(f.identity,f.keys.cursor,owner);f.identity.reporting!.projection=projection;await service.activateOwned(owner);await group.phase('verification',performance.now()-verification);
 const mutate=async(operation:string,payload:Data,params:Record<string,string>={},expected?:string,key=randomUUID(),actor=a,proof=true)=>{
  const p=managementContract().operations.get(operation)!.definition['x-purpose']!,command={operationId:operation,idempotencyKey:key,...(params['organizationId']?{organizationId:params['organizationId']}:{}),...(params['bookId']?{bookId:params['bookId']}:{}),pathParameters:params,payload,...(expected?{expectedETag:expected}:{})};
  if(proof)await f.proof(actor,p,command,params['expenseId']??params['ruleId']??params['liabilityId']??params['relationshipId']);
  return await service.mutate(actor.issued.context,operation,payload,params,key,expected);
 };
 const book=(await mutate('createPersonalBook',{currency:'COP'})).data as{id:string};
 const personal=async(label:string,accountClass='ASSET',kind='GENERAL')=>(await mutate('createPersonalAccount',{code:label,name:'Personal sintética '+label,currency:'COP',accountClass,kind},{bookId:book.id})).data as{id:string;version:number};
 const read=async(operation:string,params:Record<string,string>={},query:Data={asOf:today(f.now())},actor=a)=>await service.read(actor.issued.context,operation,params,query);
 return{...f,owner,a,org,bank,equity,account,personal,book,service,projection,mutate,read,group};
}
export const rate={kind:'NONE_DECLARED',source:'SYNTHETIC_DECLARED',sourceReference:'SYN-ZERO-DECLARED',validFrom:'2026-10-01',observedOn:'2026-10-01',unit:'ANNUAL_FRACTION',convention:'ANNUAL_SIMPLE_ACT_365',decimalValue:'0.00',combine:'NONE'};
export const official=(principal:string,due='2026-10-28',interest='0.00',insurance='0.00')=>({kind:'OFFICIAL_DECLARED',validFrom:'2026-10-28',referenceDate:'2026-09-28',sourceReference:'SYN-OFFICIAL-DECLARATION',principalOpening:principal,rateVersionIds:[],installments:[{number:1,dueDate:due,principal,interest,insurance,fees:'0.00',total:(BigInt(principal.replace('.',''))+BigInt(interest.replace('.',''))+BigInt(insurance.replace('.','')))/100n+'.'+String((BigInt(principal.replace('.',''))+BigInt(interest.replace('.',''))+BigInt(insurance.replace('.','')))%100n).padStart(2,'0')}]});
