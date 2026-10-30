import {cents,storedCents} from '../finance/money.js';
import {AppError} from '../../shared/errors.js';
import type {ClientSession,Decimal128} from 'mongodb';
import type {Identity} from '../identity/models.js';
import type {Context} from '../identity/models.js';
import type {Row,Scope,Data,CommandContext,Line} from '../obligations/models.js';
import type {WealthService} from './service.js';
export type {Row,Scope,Data,Line};
export const names=['funds','fund_events','assets','asset_versions','asset_events','asset_funding','asset_valuations','asset_flow_links','source_claims'] as const;
export type Name=typeof names[number];
export const wealthTable=(kind:Scope['kind'],name:Name)=>'s10_'+name+'_'+kind.toLowerCase();
export const wealthOriginals=names.flatMap(name=>[wealthTable('BUSINESS',name),wealthTable('PERSONAL',name)]);
export interface Fund extends Row {mode:'VIRTUAL'|'ACCOUNT_LINKED';label:string;purpose:string;backingAccountId:string;status:'ACTIVE'|'CLOSED'}
export interface Asset extends Row {assetClass:string;otherClassDescription:string|null;label:string;origin:string;legalOwnerReference:string;ownershipPercentage:string|null;grossCostDeclared:string|null;recognizedCost:string;assetAccountId:string;supportReferences:string[];locationGeneral:string|null;status:'DRAFT'|'ACTIVE'|'DISPOSED'|'CANCELLED';liabilityIds:string[];acquisitionEventId:string|null}
export interface Delta {fundId:string;accountId:string;delta:string}
export interface WealthEvent extends Row {entityId:string;kind:string;effectiveDate:string;unitKnownAt:string;amount:string;reversalOfId:string|null;journalIds:string[];ledgerEventIds:string[];deltas:Delta[];details:Data}
export interface Claim extends Row {assetId:string;sourceKind:string;sourceId:string;journalId:string;lineIndex:number;amount:string;status:'CLAIMED'|'RELEASED';sourceEventId:string}
export interface WealthContext {system:WealthService;scope:Scope;s:ClientSession;actor:Identity;auth:Context;payload:Data;params:Record<string,string>;unitId:string;eventKind:string;entityId:string;amount:string;deltas:Delta[];details:Data;reversalOfId:string|null;base:CommandContext;post:(kind:string,amount:string,lines:Line[],details?:Data)=>Promise<string>}
export const fields=(c:WealthContext)=>({bookId:c.scope.bookId,ownerId:c.scope.ownerId,domainKind:c.scope.kind});
export const body=(row:Row)=>{const{mac,recordedAt,...value}=row;void mac;void recordedAt;return value;};
export const data=(value:unknown)=>value as Data;

export function signedCents(value:string){if(value==='-0.00')throw new AppError(422,'INPUT_INVALID');return value.startsWith('-')?-cents(value.slice(1)):cents(value);}
// Per calculation only: repeated identical BSON amounts still use the exact
// established storedCents validator, without repeating Decimal128 formatting.
export function amountReader(){const values=new Map<string,bigint>();return(value:Decimal128)=>{const key=Buffer.from(value.bytes.buffer,value.bytes.byteOffset,value.bytes.byteLength).toString('hex');let amount=values.get(key);if(amount===undefined){amount=storedCents(value);values.set(key,amount);}return amount;};}
