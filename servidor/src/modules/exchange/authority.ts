import type {ClientSession} from 'mongodb';
import type {IdentityService} from '../identity/service.js';
import type {Context,Identity} from '../identity/models.js';
import {AppError} from '../../shared/errors.js';
import {personalActor,resolveScope,authorityBinding} from '../obligations/authority.js';
import {authorize} from '../reporting/sources.js';
import type {Authority} from '../reporting/models.js';
import {booksTable,declarations,type Book,type Row} from '../obligations/models.js';
import {hash} from './canonical.js';
import {today} from '../finance/service.js';
import type {Scope} from './models.js';
export interface AuthorityState {scope:Scope;actor:Identity;context:Context;binding:string;business:Authority|null;consolidated:boolean}
const assigned=new Set(['PORTFOLIO','PORTFOLIO_OVERDUE','AGEING','PAR30','INSTALLMENTS','INTEREST','PRINCIPAL','CONCENTRATION']);
export const businessReportAllowed=(a:Authority,kind:string)=>a.isT&&kind!=='PERSONAL_SUMMARY'&&kind!=='CONSOLIDATED_SUMMARY'||a.isC&&assigned.has(kind)||kind==='MOVEMENTS'&&(a.isC||a.isO||a.isP)||(kind==='CASH'||kind==='COLLECTORS')&&(a.isC||a.isO);
export const personalReports=['CASH','OBLIGATIONS','EXPENSES','SAVINGS','ASSETS','FUNDING_USES','NET_WORTH','NET_WORTH_EVOLUTION','PERSONAL_SUMMARY'];
export async function exchangeAuthority(identity:IdentityService,context:Context,params:Record<string,string>,s:ClientSession,options:{importing?:boolean;reportKind?:string;consolidated?:boolean}={}):Promise<AuthorityState>{
 const current=await personalActor(identity,context,s),org=params['organizationId'];let scope:Scope,book:Book|null,business:Authority|null=null,eligibility:unknown=null;
 if(org){
  business=await authorize(identity,context,org,s,performance.now());
  if(options.importing&&!business.isT)throw new AppError(403,'ACCESS_DENIED');
  if(options.reportKind&&!businessReportAllowed(business,options.reportKind))throw new AppError(403,'ACCESS_DENIED');
  scope={kind:'BUSINESS',bookId:org,ownerId:org,organizationId:org};book=await identity.database.db.collection<Book>(booksTable).findOne({_id:org,domainKind:'BUSINESS'},{session:s});
 }else{
  const r=await resolveScope(identity,context,'PERSONAL',params['bookId'],s);scope=r.scope;book=r.book;
  if(options.consolidated){
   if(!current.actor.organizationId||!current.actor.roles.includes('T'))throw new AppError(403,'ACCESS_DENIED');
   business=await authorize(identity,context,current.actor.organizationId,s,performance.now());
   const bscope:Scope={kind:'BUSINESS',bookId:current.actor.organizationId,ownerId:current.actor.organizationId,organizationId:current.actor.organizationId};const rows=await identity.obligations!.store.all<Row>(declarations,bscope,s);
   const latest=rows.filter(r=>r['subjectId']===current.actor._id&&String(r['validFrom'])<=today(identity.now())).sort((a,b)=>a.version-b.version).at(-1);
   eligibility=latest?.['right']==='FULL_OWNERSHIP'&&latest['percentage']==='100.00'?latest:null;
   if(!business.isT||!eligibility)throw new AppError(403,'ACCESS_DENIED');
   if(options.reportKind&&options.reportKind!=='CONSOLIDATED_SUMMARY')throw new AppError(403,'ACCESS_DENIED');
  }else if(options.reportKind&&!personalReports.includes(options.reportKind))throw new AppError(403,'ACCESS_DENIED');
 }
 return{scope,actor:current.actor,context:current.context,business,consolidated:options.consolidated===true,binding:hash({actor:authorityBinding(current.actor,current.context,book),business:business?.binding??null,eligibility,restore:identity.obligations?.store.restoreEpoch})};
}
