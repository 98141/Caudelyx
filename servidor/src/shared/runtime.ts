import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import { FactorLifecycle } from '../modules/factors/service.js';
import { WebAuthnService } from '../modules/webauthn/service.js';
import { TotpService } from '../modules/totp/service.js';
import { RecoveryService } from '../modules/recovery/service.js';
import { OrganizationsService } from '../modules/organizations/service.js';
import type { IdentityService } from '../modules/identity/service.js';
import type { Context } from '../modules/identity/models.js';
import type { SyntheticKeys } from './keys.js';
import type { Config } from './config.js';
import { emailVerified } from '../modules/identity/onboarding.js';
import { AppError } from './errors.js';
import { FinanceService } from '../modules/finance/service.js';
import { isFinancial } from '../modules/finance/contract.js';
import {OpeningService} from '../modules/opening/service.js';
import {isOpening} from '../modules/opening/contract.js';
import {LendingService} from '../modules/lending/service.js';
import {isLending} from '../modules/lending/contract.js';

export async function attachRuntime(identity: IdentityService, keys: SyntheticKeys, config: Config) {
  const lifecycle = new FactorLifecycle(identity), totp = new TotpService(lifecycle, keys.totp);
  const webauthn = new WebAuthnService(lifecycle, { TENANT: config.tenantOrigin, PLATFORM: config.platformOrigin });
  const recovery = new RecoveryService(identity, lifecycle), organizations = new OrganizationsService(identity, keys.cursor);
  await recovery.initialize();
  await organizations.initialize();
  const finance=new FinanceService(identity,keys.cursor);await finance.initialize();identity.finance=finance;
  const opening=new OpeningService(identity,keys.cursor);await opening.initialize();identity.opening=opening;
  const lending=new LendingService(identity,keys.cursor);await lending.initialize();identity.lending=lending;
  const previousResolver=identity.sessions.snapshotResolver;
  identity.sessions.snapshotResolver=async(purpose,id,actor,session,command)=>isLending(purpose)?await lending.snapshot(purpose,id,actor,session,command):isOpening(purpose)?await opening.snapshot(purpose,id,actor,session,command):isFinancial(purpose)
    ?await finance.snapshot(purpose,id,actor,session,command)
    :await previousResolver!(purpose,id,actor,session,command);
  identity.beforeRequest = async () => { await recovery.expire(); await identity.onboarding.expire(); };
  const selfData = async (context: Context) => {
    const subject = await identity.identities.findOne({ _id: context.subjectId ?? '', realm: context.realm });
    if (!subject) throw new AppError(401,'AUTH_INVALID');
    return { authState: subject.organizationId ? 'ACTIVE' : 'AUTHENTICATED_NO_ORG', userId: subject._id,
      ...(context.realm==='TENANT'?{profile:identity.ownProfile(subject)}:{}),
      ...(subject.organizationId ? {organizationId: subject.organizationId} : {}) };
  };
  identity.extension = async (id, context, input, resourceId, ifMatch, source, query,idempotencyKey) => {
    await identity.requireOpen(context.realm);
    const body = input as Record<string, unknown>;
    switch(id) {
      case 'A07': {
        if(context.kind==='B'){
          const current=await identity.database.transaction(async session=>await identity.freshContext(context,session));
          const subject=await identity.identities.findOne({_id:current.subjectId??'',realm:current.realm});
          if(!subject)throw new AppError(401,'AUTH_INVALID');
          return{data:{sessionContext:'B',authState:emailVerified(subject)?'MFA_ENROLLMENT':'PENDING_EMAIL',nextAction:emailVerified(subject)?'ENROLL_FIRST_FACTOR':'VERIFY_EMAIL',profile:identity.ownProfile(subject)}};
        }
        if(context.kind==='P'){
          throw new AppError(401,'AUTH_INVALID');
        }
        if(context.kind==='S') {
          await identity.database.transaction(async s=>{await identity.sessions.requireStrong(context,s);});
          return {data: await selfData(context)};
        }
        if(context.kind==='E_RECOVERY') {
          const flow=await identity.database.transaction(async s=>await recovery.guard(context,s));
          return {data:{authState:'RECOVERY_RESTRICTED',expiresAt:new Date(flow.expiresAt).toISOString()}};
        }
        const subject=await identity.identities.findOne({_id:context.subjectId??'',realm:context.realm});
        if(!subject||subject.state==='PENDING_EMAIL')throw new AppError(401,'AUTH_INVALID');
        const state=context.kind==='E_INITIAL'?'MFA_ENROLLMENT':subject.state==='RECOVERY_RESTRICTED'?'RECOVERY_RESTRICTED':subject.factorCount?'MFA_REQUIRED':await identity.eligible(subject)?'MFA_ENROLLMENT':'FACTOR_LOSS_BLOCKED';
        if(state==='RECOVERY_RESTRICTED') {
          const flow=await recovery.flows.findOne({subjectId:subject._id,status:'ACTIVE'});
          if(!flow)throw new AppError(401,'AUTH_INVALID');
          return {data:{authState:state,expiresAt:new Date(flow.expiresAt).toISOString()}};
        }
        return {data:{authState:state,...(context.kind==='E_INITIAL'?{nextAction:'ENROLL_FIRST_FACTOR'}:{}),
          ...(context.realm==='TENANT'?{profile:identity.ownProfile(subject)}:{})}};
      }
      case 'A20': await identity.changePassword(context,body as {currentPassword:string;newPassword:string});return {status:204,clearCookies:true};
      case 'A21':{
        if(context.kind==='B'){
          await identity.database.transaction(async session=>await identity.freshContext(context,session));
          const rows=await identity.sessions.factors.find({subjectId:context.subjectId??'',realm:context.realm,state:'ACTIVE'}).toArray();
          return{data:{items:rows.map(f=>({id:f._id,type:f.type,label:f.label,createdAt:new Date(f.createdAt).toISOString(),lastUsedAt:f.lastUsedAt===null?null:new Date(f.lastUsedAt).toISOString(),version:f.version})),nextCursor:null}};
        }return {data:await recovery.methods(context)};
      }
      case 'A22':return {status:201,data:await totp.enroll(context,body['label'] as string,body['password'] as string|undefined)};
      case 'A23':{
        const result=await totp.confirm(context,resourceId??'',body['code'] as string);return{...result,...(result.data.nextAction==='LOGIN'?{clearCookies:true}:{})};
      }
      case 'A24':return {data:await webauthn.enroll(context,body['label'] as string,body['password'] as string|undefined)};
      case 'A25':{
        const result=await webauthn.confirm(context,body['ceremonyId'] as string,body['credential'] as RegistrationResponseJSON);return{status:201,...result,...(result.data.nextAction==='LOGIN'?{clearCookies:true}:{})};
      }
      case 'A26':return {data:await webauthn.options(context,body['purpose'] as string,(isFinancial(body['purpose'])||isOpening(body['purpose'])||isLending(body['purpose']))?(body['resourceId'] as string|undefined)?.toLowerCase()??null:body['resourceId'] as string|undefined??null)};
      case 'A27':{
        const purpose=body['purpose'] as string, target=(isFinancial(purpose)||isOpening(purpose)||isLending(purpose))?(body['resourceId'] as string|undefined)?.toLowerCase()??null:body['resourceId'] as string|undefined??null;
        const result=body['method']==='TOTP'?await totp.authenticate(context,body['code'] as string,purpose,target):
          await webauthn.authenticate(context,body['ceremonyId'] as string,body['credential'] as AuthenticationResponseJSON,purpose,target);
        return {...result,data:purpose==='LOGIN'?await selfData(result.issued.context):{nextAction:'READY'}};
      }
      case 'A28':await recovery.remove(context,resourceId??'',ifMatch);return {status:204};
      case 'A29':return {data:await recovery.regenerate(context)};
      case 'A30':return await recovery.start(context,body['recoveryCode'] as string,source);
      case 'A31':return {data:await recovery.complete(context,body['newMethodId'] as string,body['retireMethodIds'] as string[]),clearCookies:true};
      case 'A32':return {data:await identity.reauthenticate(context,body as {password:string;purpose:string;resourceId?:string;command?:Record<string,unknown>})};
      case 'A33':return {data:await identity.listSessions(context)};
      case 'A34':await identity.revokeSessions(context,resourceId);return {status:204,...(resourceId===context.managementId?{clearCookies:true}:{})};
      case 'A35':await identity.revokeSessions(context);return {status:204,clearCookies:true};
      case 'A09':return await organizations.read(context);
      case 'A08':return {status:201,...await organizations.create(context,body,idempotencyKey)};
      case 'A10':return await organizations.edit(context,body,ifMatch);
      case 'A12':return {status:202,data:await organizations.invite(context,body)};
      case 'A15':return await organizations.accept(context,body,source);
      case 'A16':return await organizations.roles(context,resourceId??'',body,ifMatch);
      case 'A11':return {data:await organizations.members(context,query['limit']===undefined?20:Number(query['limit']),query['cursor'] as string|undefined)};
      case 'A13':return {data:await organizations.listInvitations(context,query['limit']===undefined?20:Number(query['limit']),query['cursor'] as string|undefined)};
      case 'A14':await organizations.revokeInvitation(context,resourceId??'',ifMatch);return {status:204};
      case 'A17':return await organizations.memberCommand(context,resourceId??'','SUSPEND',ifMatch);
      case 'A36':return await organizations.memberCommand(context,resourceId??'','REACTIVATE',ifMatch);
      case 'A37':return await organizations.memberCommand(context,resourceId??'','REVOKE',ifMatch);
      case 'A38':return {data:await organizations.revokeOrganization(context,ifMatch),clearCookies:true};
      default:throw new AppError(503,'SERVICE_UNAVAILABLE');
    }
  };
  return {lifecycle,totp,webauthn,recovery,organizations,finance,opening,lending};
}
