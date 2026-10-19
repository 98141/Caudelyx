import { FrozenContract } from './contract.js';
import { AppError } from './errors.js';
import type { Realm } from '../modules/identity/models.js';
export type Command = Record<string, unknown>;
let contract: FrozenContract | undefined;
export function validateCommand(operation: string, input: unknown): void { (contract??=new FrozenContract()).validate(operation,input); }
export const payloadPurposes=['ORGANIZATION_CREATE','ORGANIZATION_EDIT','MEMBER_INVITE','MEMBER_ROLE_CHANGE','MFA_ENROLL'];
export function authorizePurpose(realm: Realm,purpose: string,command?: Command): void {
  const tenant=['ORGANIZATION_CREATE','ORGANIZATION_EDIT','MEMBER_INVITE','INVITATION_REVOKE','MEMBER_ROLE_CHANGE','MEMBER_SUSPEND','MEMBER_REACTIVATE','MEMBER_SESSIONS_REVOKE','ORGANIZATION_SESSIONS_REVOKE'];
  if(realm==='PLATFORM'&&(tenant.includes(purpose)||purpose==='MFA_ENROLL'&&command?.['methodType']==='TOTP'))throw new AppError(403,'ACCESS_DENIED');
}
export function normalizeCommand(purpose:string,input:Command|undefined,email:(s:string)=>string):Command|null{
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
