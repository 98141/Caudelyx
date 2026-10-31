import {isWealthPurpose,wealthContract} from '../modules/wealth/contract.js';
import {isExchangePurpose,exchangeContract} from '../modules/exchange/contract.js';
import {canonical as exchangeCanonical} from '../modules/exchange/canonical.js';
import {isCollectionPurpose} from '../modules/collections/contract.js';
import {isManagementPurpose,managementContract} from '../modules/obligations/contract.js';
import { FrozenContract } from './contract.js';
import { AppError } from './errors.js';
import type { Realm } from '../modules/identity/models.js';
import { canonical, isFinancial, financeContract } from '../modules/finance/contract.js';
import {isOpening,canonicalOpening,openingContract} from '../modules/opening/contract.js';
import {isLending,canonical as canonicalLending,lendingContract,purposes as lendingOperations} from '../modules/lending/contract.js';
import {isOperation,operationPurpose,operationsContract} from '../modules/lending/operations-contract.js';
import {isPaymentPurpose,paymentContract} from '../modules/payments/contract.js';
export type Command = Record<string, unknown>;
let contract: FrozenContract | undefined;
export function validateCommand(operation: string, input: unknown): void { (contract??=new FrozenContract()).validate(operation,input); }
export const payloadPurposes=['ORGANIZATION_CREATE','ORGANIZATION_EDIT','MEMBER_INVITE','MEMBER_ROLE_CHANGE','MFA_ENROLL'];
export function authorizePurpose(realm: Realm,purpose: string,command?: Command): void {
  if(realm==='PLATFORM'&&isExchangePurpose(purpose))throw new AppError(403,'ACCESS_DENIED');
  if(realm==='PLATFORM'&&(isManagementPurpose(purpose)||isWealthPurpose(purpose)))throw new AppError(403,'ACCESS_DENIED');
  if(realm==='PLATFORM'&&(isPaymentPurpose(purpose)||isCollectionPurpose(purpose)))throw new AppError(403,'ACCESS_DENIED');
  if(realm==='PLATFORM'&&isLending(purpose))throw new AppError(403,'ACCESS_DENIED');
  if(realm==='PLATFORM'&&isOperation(purpose))throw new AppError(403,'ACCESS_DENIED');
  if(realm==='PLATFORM'&&(isFinancial(purpose)||isOpening(purpose)))throw new AppError(403,'ACCESS_DENIED');
  const tenant=['ORGANIZATION_CREATE','ORGANIZATION_EDIT','MEMBER_INVITE','INVITATION_REVOKE','MEMBER_ROLE_CHANGE','MEMBER_SUSPEND','MEMBER_REACTIVATE','MEMBER_SESSIONS_REVOKE','ORGANIZATION_SESSIONS_REVOKE'];
  if(realm==='PLATFORM'&&(tenant.includes(purpose)||purpose==='MFA_ENROLL'&&command?.['methodType']==='TOTP'))throw new AppError(403,'ACCESS_DENIED');
}
export function normalizeCommand(purpose:string,input:Command|undefined,email:(s:string)=>string):Command|null{
  if(isExchangePurpose(purpose))return exchangeCanonical(exchangeContract().command(purpose,input)) as Command;
  if(isWealthPurpose(purpose))return wealthContract().command(purpose,input);
  if(isManagementPurpose(purpose))return managementContract().command(purpose,input);
  if(isPaymentPurpose(purpose)||isCollectionPurpose(purpose)){if(!input)throw new AppError(422,'INPUT_INVALID');const c=canonicalLending(input) as Command;paymentContract().validate(String(c['operationId']),c['payload']);if(paymentContract().purpose(String(c['operationId']),c['payload'] as Command)!==purpose)throw new AppError(422,'INPUT_INVALID');return c;}
  if(isOperation(purpose)){
    if(!input)throw new AppError(422,'INPUT_INVALID');const command=canonicalLending(input) as Command;
    const operation=[...operationPurpose].find(([,p])=>p===purpose)![0];operationsContract().validate(operation,command['payload']);return command;
  }
  if(isLending(purpose)){
    if(!input)throw new AppError(422,'INPUT_INVALID');
    const command=canonicalLending(input) as Command;
    const operation=[...lendingOperations].find(([,p])=>p===purpose)![0];lendingContract().validate(operation,command['payload']);
    return command;
  }
  if(isOpening(purpose)){
    if(!input)throw new AppError(422,'INPUT_INVALID');const command=canonicalOpening(input) as Command;
    const schema=new Map([['OPENING_CREATE','OpeningCreate'],['OPENING_REPLACE','OpeningReplace'],['OPENING_VALIDATE','ValidateCommand'],['OPENING_APPROVE','ValidationBinding'],['OPENING_CANCEL','CancelCommand'],['OPENING_COMMIT','ValidationBinding']]).get(purpose)!;
    openingContract().validate(purpose==='OPENING_COMMIT'?'commitOpening':schema,command['payload']);return command;
  }
  if(isFinancial(purpose)){
    if(!input)throw new AppError(422,'INPUT_INVALID');const command=canonical(input) as Command;
    const schema=new Map([['FINANCE_ACCOUNT_CREATE','AccountCreate'],['FINANCE_ACCOUNT_UPDATE','AccountRename'],['FINANCE_JOURNAL_POST','Posting'],['FINANCE_TRANSFER','Transfer'],['FINANCE_JOURNAL_REVERSE','Reversal']]).get(purpose)!;
    financeContract().validate(schema,command['payload']);return command;
  }
  if(!payloadPurposes.includes(purpose))return null;
  if(!input)throw new AppError(422,'INPUT_INVALID');
  switch(purpose){
    case 'ORGANIZATION_CREATE':return{name:(input['name'] as string).trim(),timezone:input['timezone'],currency:input['currency']};
    case 'ORGANIZATION_EDIT':return{name:(input['name'] as string).trim()};
    case 'MEMBER_INVITE':return{email:email(input['email'] as string),roleIds:[...input['roleIds'] as string[]].sort()};
    case 'MEMBER_ROLE_CHANGE':return{roleIds:[...input['roleIds'] as string[]].sort()};
    case 'MFA_ENROLL':return{methodType:input['methodType'],label:(input['label'] as string).trim()};
    default:throw new AppError(422,'INPUT_INVALID');
  }
}
