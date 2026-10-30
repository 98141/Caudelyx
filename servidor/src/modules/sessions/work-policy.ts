import {isWealthPurpose,wealthClasses,wealthContract} from '../wealth/contract.js';
import {collectionClasses,isCollectionPurpose} from '../collections/contract.js';
import {isManagementPurpose,managementClasses,managementContract} from '../obligations/contract.js';
/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection -- Hash-pinned contracts; purpose indexing follows own-property allowlist and command keys are fixed. */
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {parse} from 'yaml';
import {Ajv2020,type ValidateFunction} from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import {paymentClasses,isPaymentPurpose,paymentContract} from '../payments/contract.js';
import {AppError} from '../../shared/errors.js';
import type {Context,Identity} from '../identity/models.js';

export const WORK_POLICY='MEJ-v1';
export const IDLE_MS=3600000;
export const ABSOLUTE_MS=43200000;
export const BALANCE_PURPOSES=['FINANCE_JOURNAL_POST','FINANCE_TRANSFER','FINANCE_JOURNAL_REVERSE','OPENING_COMMIT','LOAN_DISBURSE','LOAN_ACCRUE','LOAN_RECEIPT_POST','LOAN_CREDIT_APPLY'] as const;
export const SECURITY_PURPOSES=['MEMBER_INVITE','MEMBER_ROLE_CHANGE','MEMBER_SUSPEND','MEMBER_REACTIVATE','MEMBER_SESSIONS_REVOKE','ORGANIZATION_SESSIONS_REVOKE','PASSWORD_CHANGE','MFA_ENROLL','MFA_REMOVE','RECOVERY_CODES_REGENERATE','SESSION_REVOKE_OTHER','SESSION_REVOKE_ALL'] as const;
export const WORK_PURPOSES=['ORGANIZATION_CREATE','ORGANIZATION_EDIT','INVITATION_REVOKE','FINANCE_ACCOUNT_CREATE','FINANCE_ACCOUNT_UPDATE','OPENING_CREATE','OPENING_REPLACE','OPENING_VALIDATE','OPENING_APPROVE','OPENING_CANCEL','BORROWER_SCHEMA_PUBLISH','BORROWER_CREATE','BORROWER_REPLACE','BORROWER_DEACTIVATE','BORROWER_REACTIVATE','LOAN_DRAFT_CREATE','LOAN_TERMS_REPLACE','LOAN_TERMS_CONFIRM','LOAN_CANCEL'] as const;
export const purposeClass=(purpose:string)=>isWealthPurpose(purpose)?wealthClasses[purpose]:isManagementPurpose(purpose)?managementClasses[purpose]:isCollectionPurpose(purpose)?collectionClasses[purpose]:isPaymentPurpose(purpose)?paymentClasses[purpose]:BALANCE_PURPOSES.some(p=>p===purpose)?'BALANCE_60M':SECURITY_PURPOSES.some(p=>p===purpose)?'SECURITY_ONE_SHOT':WORK_PURPOSES.some(p=>p===purpose)?'WORK_ONLY':null;
export function sessionMeta(context:Context,now:number){return {serverNow:new Date(now).toISOString(),idleExpiresAt:new Date(Math.min(context.expiresAt,context.lastSeenAt+IDLE_MS)).toISOString(),absoluteExpiresAt:new Date(context.expiresAt).toISOString(),balanceVerifiedUntil:context.balanceGrant&&context.balanceGrant.expiresAt>now&&context.expiresAt>now?new Date(Math.min(context.balanceGrant.expiresAt,context.expiresAt)).toISOString():null};}
export function workData(subject:Identity,context:Context,profile:unknown,now:number){return {sessionContext:'W',authState:subject.organizationId?'WORKING':'WORKING_NO_ORG',userId:subject._id,roleIds:subject.roles,profile,session:sessionMeta(context,now),...(subject.organizationId?{organizationId:subject.organizationId}:{})};}

type Node=Record<string,unknown>;
const pinned:Record<string,string>={
  'Construccion/docs/contratos/openapi-auth-v0.11-review.yaml':'6c9c6312393c38af51851f0183e8c9a710f10bf1303a528490172dc17f4f29e2',
  'Construccion/Sprints/S02/Contratos/openapi-finance-s02.yaml':'e94743580b8ba587814d882bf492f636979bf76b6e96f46d3fd8a5b5db5dc729',
  'Construccion/Sprints/S03/Contratos/openapi-opening-s03.json':'51978d457cf3d4f1a3aea91ae7a8c7a5b2e2782dc3dea7a7475f314067e4f016',
  'Construccion/Sprints/S05/Contratos/openapi-operations-s05.json':'dd7d7f1c634b4c1b7c9498f62f9a99d06425da2d43081c3898517c79fb654be0',
  'Construccion/Sprints/MEJ/Contratos/openapi-mej-v1.json':'5117dfff76e24c21bad69acc37f45e2d3d94b3b1b69d514f0713e9c4d2456800',
};
export class WorkContract {
  readonly url:string;
  readonly document:Node;
  private readonly documents=new Map<string,Node>();
  private readonly checks=new Map<string,ValidateFunction>();
  private readonly ajv=new Ajv2020({strict:false,validateFormats:true});
  constructor(){
    const root=resolve('../..'),files=new Map<string,Node>();
    for(const [path,hash] of Object.entries(pinned)){
      const filename=resolve(root,path),bytes=readFileSync(filename);
      // eslint-disable-next-line security/detect-possible-timing-attacks -- Public pinned document digest, not a credential.
      if(createHash('sha256').update(bytes).digest('hex')!==hash)throw Error('MEJ contract dependency changed');
      files.set(filename,parse(bytes.toString('utf8')) as Node);
    }
    for(const [filename,doc] of files){
      const url=pathToFileURL(filename).href,visited=new WeakSet<object>();
      const rewrite=(node:unknown):void=>{
        if(!node||typeof node!=='object'||visited.has(node))return;visited.add(node);
        if(Array.isArray(node)){for(const v of node)rewrite(v);return;}
        const value=node as Node;
        if(typeof value['$ref']==='string'){
          const [name,fragment]=value['$ref'].split('#');
          const target=name?resolve(dirname(filename),name):filename;
          if(!files.has(target))throw Error('Unpinned MEJ schema reference');
          value['$ref']=pathToFileURL(target).href+'#'+(fragment??'');
        }
        for(const v of Object.values(value))rewrite(v);
      };
      rewrite(doc);doc['$id']=url;this.documents.set(url,doc);
    }
    this.url=pathToFileURL(resolve(root,'Construccion/Sprints/MEJ/Contratos/openapi-mej-v1.json')).href;
    this.document=this.documents.get(this.url)!;
    formats.default(this.ajv);this.install(this.ajv);
  }
  install(ajv:Ajv2020){for(const [url,doc] of this.documents)if(!ajv.getSchema(url))ajv.addSchema(doc,url);}
  reference(name:string){return {$ref:this.url+'#/components/schemas/'+name};}
  validate(name:string,value:unknown,response=false){
    if(name==='StepUpPrepare'&&value&&typeof value==='object'&&(isManagementPurpose((value as Record<string,unknown>)['purpose'])||isWealthPurpose((value as Record<string,unknown>)['purpose']))){
      const p=value as Record<string,unknown>;if(Object.keys(p).some(k=>!['purpose','resourceId','command','method'].includes(k))||!['TOTP','WEBAUTHN'].includes(String(p['method'])))throw new AppError(422,'INPUT_INVALID');
      if(p['resourceId']!==undefined)managementContract().validate('Id',p['resourceId']);(isWealthPurpose(p['purpose'])?wealthContract():managementContract()).command(String(p['purpose']),p['command']);return;
    }
    if(name==='StepUpPrepare'&&value&&typeof value==='object'&&(isPaymentPurpose((value as Record<string,unknown>)['purpose'])||isCollectionPurpose((value as Record<string,unknown>)['purpose']))){
      const p=value as Record<string,unknown>,c=p['command'] as Record<string,unknown>|undefined;
      if(Object.keys(p).some(k=>!['purpose','resourceId','command','method'].includes(k))||!['TOTP','WEBAUTHN'].includes(String(p['method']))||!c||Object.keys(c).some(k=>!['organizationId','idempotencyKey','expectedETag','operationId','resourceId','payload'].includes(k)))throw new AppError(422,'INPUT_INVALID');
      for(const k of ['organizationId','idempotencyKey'])paymentContract().validate('Id',c[k]);paymentContract().validate('ETag',c['expectedETag']);paymentContract().validate(String(c['operationId']),c['payload']);if(paymentContract().purpose(String(c['operationId']),c['payload'] as Record<string,unknown>)!==p['purpose'])throw new AppError(422,'INPUT_INVALID');return;
    }
    let check=this.checks.get(name);if(!check){check=this.ajv.compile(this.reference(name));this.checks.set(name,check);}
    if(!check(value))throw new AppError(response?503:422,response?'SERVICE_UNAVAILABLE':'INPUT_INVALID');
  }
}
let contract:WorkContract|undefined;
export const workContract=()=>contract??=new WorkContract();
