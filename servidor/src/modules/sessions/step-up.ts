import {randomUUID} from 'node:crypto';
import type {ClientSession} from 'mongodb';
import type {AuthenticationResponseJSON} from '@simplewebauthn/server';
import type {IdentityService} from '../identity/service.js';
import type {Context,Identity} from '../identity/models.js';
import type {TotpService} from '../totp/service.js';
import type {WebAuthnService} from '../webauthn/service.js';
import {AppError} from '../../shared/errors.js';
import {normalizeCommand,authorizePurpose} from '../../shared/commands.js';
import {canonicalEmail} from '../identity/service.js';
import {purposeClass,sessionMeta,workContract} from './work-policy.js';
import {isPersonalManagementCommand} from '../obligations/contract.js';

export interface StepUpInput {purpose:string;resourceId?:string;command?:Record<string,unknown>;method:'TOTP'|'WEBAUTHN'}
export class StepUpService {
  constructor(readonly identity:IdentityService,readonly totp:TotpService,readonly webauthn:WebAuthnService){}
  async prepareInTransaction(context:Context,actor:Identity,input:StepUpInput,session:ClientSession,initial=false){
    workContract().validate('StepUpPrepare',input);
    if(context.kind!=='W'||!purposeClass(input.purpose)||purposeClass(input.purpose)==='WORK_ONLY')throw new AppError(403,'ACCESS_DENIED');
    authorizePurpose(context.realm,input.purpose,input.command);
    const command=normalizeCommand(input.purpose,input.command,canonicalEmail),enrollmentIntent=input.purpose==='MFA_ENROLL'?randomUUID():null;
    const resourceId=input.resourceId??null;
    const snapshotHash=await this.identity.sessions.snapshot(input.purpose,resourceId,actor,session,command,enrollmentIntent);
    if(!initial&&!await this.identity.sessions.factors.findOne({subjectId:actor._id,realm:'TENANT',state:'ACTIVE'},{session}))throw new AppError(403,'MFA_ENROLLMENT_REQUIRED');
    const reauth:NonNullable<Context['reauth']>={intentId:randomUUID(),preparedAt:this.identity.now(),method:input.method,purpose:input.purpose,resourceId,snapshotHash,passwordAt:context.passwordAt??context.createdAt,expiresAt:Math.min(this.identity.now()+300000,context.expiresAt),factorId:null,consumed:false,command,enrollmentIntent};
    await this.identity.sessions.contexts.updateOne({_id:context._id,revoked:false},{$set:{reauth}},{session});
    return reauth;
  }
  async prepare(context:Context,input:StepUpInput){
    await this.identity.requireOpen(context.realm);
    const proof=await this.identity.database.transaction(async session=>{
      const {context:fresh,identity}=isPersonalManagementCommand(input.purpose,input.command)?await this.identity.sessions.requirePersonalOperational(context,session):await this.identity.sessions.requireOperational(context,session);
      return this.prepareInTransaction(fresh,identity,input,session);
    });
    let publicKey:unknown;
    if(input.method==='WEBAUTHN'){
      const prepared=await this.webauthn.options(context,input.purpose,input.resourceId??null);publicKey=prepared.publicKey;
      await this.identity.sessions.contexts.updateOne({_id:context._id,'reauth.intentId':proof.intentId},{$set:{'reauth.ceremonyId':prepared.ceremonyId}});
    }
    return{intentId:proof.intentId!,expiresAt:new Date(proof.expiresAt).toISOString(),method:input.method,...(publicKey?{publicKey}:{})};
  }
  async verify(context:Context,input:{intentId:string;method:'TOTP'|'WEBAUTHN';code?:string;credential?:AuthenticationResponseJSON},sessionToken?:string){
    await this.identity.requireOpen(context.realm);workContract().validate('StepUpVerify',input);
    const current=await this.identity.database.transaction(async session=>{const fresh=await this.identity.sessions.findById(context,session);return isPersonalManagementCommand(fresh.reauth?.purpose,fresh.reauth?.command)?await this.identity.sessions.requirePersonalOperational(fresh,session):await this.identity.sessions.requireOperational(fresh,session);});
    const proof=current.context.reauth;
    if(!proof||proof.intentId!==input.intentId||proof.method!==input.method||proof.consumed||proof.expiresAt<=this.identity.now())throw new AppError(403,'REAUTH_REQUIRED');
    const result=input.method==='TOTP'?await this.totp.authenticate(context,input.code!,proof.purpose,proof.resourceId,input.intentId,sessionToken):await this.webauthn.authenticate(context,proof.ceremonyId??'',input.credential!,proof.purpose,proof.resourceId,input.intentId,sessionToken);
    const data=purposeClass(proof.purpose)==='BALANCE_60M'?{verifiedClass:'BALANCE_60M',session:sessionMeta(result.issued.context,this.identity.now())}:{verifiedClass:'SECURITY_ONE_SHOT',proofExpiresAt:new Date(proof.expiresAt).toISOString()};
    workContract().validate('StepUpVerified',{data,requestId:context.managementId},true);
    return {issued:result.issued,data};
  }
}
