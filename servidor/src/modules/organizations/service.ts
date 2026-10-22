import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import { canonicalEmail,type IdentityService } from '../identity/service.js';
import type { Context, Identity } from '../identity/models.js';
import { Authorization } from '../../shared/authorization.js';
import { AppError } from '../../shared/errors.js';
import { digest,opaque } from '../../shared/crypto.js';
import { normalizeCommand,validateCommand,type Command } from '../../shared/commands.js';

export interface Organization { _id: string; name: string; timezone: string; currency: string; status: string; version: string; authEpoch: string }
export interface Invitation { _id: string; organizationId: string; email: string; roleIds: string[]; status: 'PENDING'|'ACCEPTED'|'EXPIRED'|'REVOKED'; expiresAt: number; inviterId: string; inviterAuthzVersion: string; version: string; tokenHash: string }
export class OrganizationsService {
  readonly organizations;
  readonly invitations;
  readonly idempotency;
  constructor(readonly identity: IdentityService, readonly cursorKey: Buffer) {
    this.organizations = identity.database.db.collection<Organization>('organizations');
    this.invitations = identity.database.db.collection<Invitation>('invitations');
    identity.sessions.snapshotResolver = async (purpose, id, actor, session,command) => await this.snapshot(purpose, id, actor, session,command);
    this.idempotency=identity.database.db.collection<{_id:string;subjectId:string;hash:string;expiresAt:number;data:{organization:ReturnType<OrganizationsService['representation']>;userId:string;roleIds:string[]}}>('idempotency');
    identity.messaging.notificationAllowed=async note=>{
      if(!await identity.isRealmOpen(note.realm))return false;
      if(note.kind==='INVITATION')return await identity.database.transaction(async session=>!!await this.validInvitation(note.subjectId,session));
      return !!await identity.identities.findOne({_id:note.subjectId,realm:note.realm});
    };
  }
  async initialize(): Promise<void> {
    await this.invitations.createIndex({ tokenHash: 1 }, { unique: true });
    await this.invitations.createIndex({ organizationId: 1, email: 1 }, { unique: true, partialFilterExpression: { status: 'PENDING' } });
  }
  private async actor(context: Context, session: ClientSession, management = true) {
    await this.identity.requireOpen(context.realm);
    const result = await this.identity.sessions.requireStrong(context, session);
    if (result.identity.realm !== 'TENANT') throw new AppError(403, 'ACCESS_DENIED');
    if (!result.identity.organizationId) throw new AppError(409, 'ONBOARDING_REQUIRED');
    if (management) Authorization.manager(result.identity);
    const organization = await this.organizations.findOne({ _id: result.identity.organizationId, status: 'ACTIVE' }, { session });
    if (!organization) throw new AppError(403, 'ACCESS_DENIED');
    return { ...result, organization };
  }
  private version(actual: string, expected: string | undefined): void {
    if (!expected) throw new AppError(428, 'PRECONDITION_REQUIRED');
    if (actual !== expected) throw new AppError(412, 'PRECONDITION_FAILED');
  }
  private async member(actor: Identity, id: string, session: ClientSession) {
    const target = await this.identity.identities.findOne({ _id: id, organizationId: actor.organizationId, realm: 'TENANT' }, { session });
    if (!target) throw new AppError(404, 'NOT_FOUND');
    return target;
  }
  async snapshot(purpose: string, id: string | null, actor: Identity, session: ClientSession,command?:Command|null): Promise<string> {
    if(actor.realm!=='TENANT')throw new AppError(403,'ACCESS_DENIED');
    if(purpose==='ORGANIZATION_CREATE'){
      if(actor.organizationId)throw new AppError(409,'ORGANIZATION_ALREADY_ASSIGNED');
      if(!command)throw new AppError(422,'INPUT_INVALID');
      return digest(JSON.stringify([purpose,actor._id,command]));
    }
    Authorization.manager(actor);
    if(['ORGANIZATION_EDIT','MEMBER_INVITE'].includes(purpose)){
      if(id!==actor.organizationId)throw new AppError(404,'NOT_FOUND');
      const organization=await this.organizations.findOne({_id:id??'',status:'ACTIVE'},{session});
      if(!organization)throw new AppError(404,'NOT_FOUND');
      if(!command)throw new AppError(422,'INPUT_INVALID');
      if(purpose==='MEMBER_INVITE')Authorization.assign(actor,command['roleIds'] as string[]);
      return digest(JSON.stringify([purpose,id,command,...(purpose==='ORGANIZATION_EDIT'?[organization.version]:[])]));
    }
    if(purpose==='MEMBER_ROLE_CHANGE'){
      const target=await this.member(actor,id??'',session);Authorization.target(actor,target);
      if(!command)throw new AppError(422,'INPUT_INVALID');Authorization.assign(actor,command['roleIds'] as string[]);
      return digest(JSON.stringify([purpose,id,command,target.version]));
    }
    if (purpose === 'ORGANIZATION_SESSIONS_REVOKE') {
      if (!actor.roles.includes('T') || id !== actor.organizationId) throw new AppError(403, 'ACCESS_DENIED');
      const org = await this.organizations.findOne({ _id: actor.organizationId ?? '', status: 'ACTIVE' }, { session });
      if (!org) throw new AppError(404, 'NOT_FOUND');
      return digest(JSON.stringify([purpose,id,org.version]));
    }
    if (purpose === 'INVITATION_REVOKE') {
      const invitation = await this.invitations.findOne({ _id: id ?? '', organizationId: actor.organizationId ?? '' }, { session });
      if (!invitation) throw new AppError(404, 'NOT_FOUND');
      Authorization.assign(actor, invitation.roleIds);
      return digest(JSON.stringify([purpose,id,invitation.version]));
    }
    if (['MEMBER_SUSPEND','MEMBER_REACTIVATE','MEMBER_SESSIONS_REVOKE'].includes(purpose)) {
      const target = await this.member(actor, id ?? '', session); Authorization.target(actor, target);
      return digest(JSON.stringify([purpose,id,target.version]));
    }
    throw new AppError(403, 'ACCESS_DENIED');
  }
  private normalized(purpose:string,body:Command):Command{
    const operation=new Map([['ORGANIZATION_CREATE','A08'],['ORGANIZATION_EDIT','A10'],['MEMBER_INVITE','A12'],['MEMBER_ROLE_CHANGE','A16']]).get(purpose);
    if(!operation)throw new AppError(422,'INPUT_INVALID');validateCommand(operation,body);
    const value=normalizeCommand(purpose,body,canonicalEmail)!;validateCommand(operation,value);return value;
  }
  private async affiliate(context:Context,subject:Identity,organization:Organization,roles:string[],session:ClientSession):Promise<void>{
    const authzVersion=randomUUID();
    const updated=await this.identity.identities.updateOne({_id:subject._id,organizationId:null,authzVersion:subject.authzVersion},{$set:{organizationId:organization._id,roles,state:'ACTIVE',hasEverActive:true,authzVersion,version:`"${randomUUID()}"`}},{session});
    if(updated.modifiedCount!==1)throw new AppError(409,'ORGANIZATION_ALREADY_ASSIGNED');
    await this.identity.sessions.contexts.updateMany({subjectId:subject._id,_id:{$ne:context._id}},{$set:{revoked:true}},{session});
    await this.identity.sessions.contexts.updateOne({_id:context._id},{$set:{authzVersion,organizationEpoch:organization.authEpoch}},{session});
  }
  async create(context:Context,body:Command,key:string|undefined){
    const command=this.normalized('ORGANIZATION_CREATE',body);
    if(!key||key.length<16||key.length>128)throw new AppError(422,'INPUT_INVALID');
    return await this.identity.database.transaction(async session=>{
      const {identity}=await this.identity.sessions.requireStrong(context,session);
      if(identity.realm!=='TENANT')throw new AppError(403,'ACCESS_DENIED');
      const id=digest(JSON.stringify([identity._id,'A08',key])),hash=digest(JSON.stringify(command));
      const replay=await this.idempotency.findOne({_id:id,expiresAt:{$gt:this.identity.now()}},{session});
      if(replay){if(!timingSafeEqual(Buffer.from(replay.hash,'hex'),Buffer.from(hash,'hex')))throw new AppError(409,'IDEMPOTENCY_CONFLICT');return {data:replay.data,etag:replay.data.organization.version!};}
      if(identity.organizationId)throw new AppError(409,'ORGANIZATION_ALREADY_ASSIGNED');
      await this.identity.sessions.consumeProof(context,'ORGANIZATION_CREATE',null,session,command);
      const organization:Organization={_id:randomUUID(),name:command['name'] as string,timezone:'America/Bogota',currency:'COP',status:'ACTIVE',version:`"${randomUUID()}"`,authEpoch:randomUUID()};
      await this.organizations.insertOne(organization,{session});await this.affiliate(context,identity,organization,['T'],session);
      const data={organization:this.representation(organization,true),userId:identity._id,roleIds:['T']};
      await this.idempotency.replaceOne({_id:id},{subjectId:identity._id,hash,expiresAt:this.identity.now()+86400000,data},{session,upsert:true});
      await this.identity.audit.append({realm:'TENANT',action:'ORGANIZATION_CREATED',actorId:identity._id,subjectId:identity._id,outcome:'SUCCESS'},session);
      await this.identity.messaging.notify('TENANT',identity._id,'ORGANIZATION_CREATED',{},session);
      return{data,etag:organization.version};
    });
  }
  async edit(context:Context,body:Command,ifMatch:string|undefined){
    const command=this.normalized('ORGANIZATION_EDIT',body);
    return await this.identity.database.transaction(async session=>{
      const {identity,organization}=await this.actor(context,session);this.version(organization.version,ifMatch);
      await this.identity.sessions.consumeProof(context,'ORGANIZATION_EDIT',organization._id,session,command);
      const version=`"${randomUUID()}"`;await this.organizations.updateOne({_id:organization._id},{$set:{name:command['name'] as string,version}},{session});
      await this.identity.audit.append({realm:'TENANT',action:'ORGANIZATION_EDITED',actorId:identity._id,subjectId:identity._id,outcome:'SUCCESS'},session);
      return{data:this.representation({...organization,name:command['name'] as string,version},true),etag:version};
    });
  }
  async roles(context:Context,id:string,body:Command,ifMatch:string|undefined){
    const command=this.normalized('MEMBER_ROLE_CHANGE',body);
    return await this.identity.database.transaction(async session=>{
      const {identity}=await this.actor(context,session),target=await this.member(identity,id,session);Authorization.target(identity,target);Authorization.assign(identity,command['roleIds'] as string[]);this.version(target.version,ifMatch);
      if(!await this.identity.sessions.factors.countDocuments({subjectId:id,state:'ACTIVE'},{session}))throw new AppError(409,'MFA_ENROLLMENT_REQUIRED');
      await this.identity.sessions.consumeProof(context,'MEMBER_ROLE_CHANGE',id,session,command);
      const roles=command['roleIds'] as string[],version=`"${randomUUID()}"`,changed=JSON.stringify([...target.roles].sort())!==JSON.stringify(roles);
      const authzVersion = changed ? randomUUID() : target.authzVersion;
      await this.identity.identities.updateOne({_id:id},{$set:{roles,version,authzVersion}},{session});
      if (changed) await this.identity.sessions.contexts.updateMany({subjectId:id,kind:'E_RECOVERY',revoked:false,authzVersion:target.authzVersion},{$set:{authzVersion}},{session});
      if(changed){await this.identity.sessions.contexts.updateMany({subjectId:id,kind:'S'},{$set:{revoked:true}},{session});await this.invitations.updateMany({inviterId:id,status:'PENDING'},{$set:{status:'REVOKED'}},{session});}
      await this.identity.audit.append({realm:'TENANT',action:'MEMBER_ROLES_CHANGED',actorId:identity._id,subjectId:id,outcome:'SUCCESS'},session);
      await this.identity.messaging.notify('TENANT',id,'MEMBER_ROLES_CHANGED',{},session);
      return{data:{userId:id,roleIds:roles,version},etag:version};
    });
  }
  async invite(context:Context,body:Command){
    const command=this.normalized('MEMBER_INVITE',body);
    await this.identity.database.transaction(async session=>{
      const {identity}=await this.actor(context,session);Authorization.assign(identity,command['roleIds'] as string[]);
      await this.identity.sessions.consumeProof(context,'MEMBER_INVITE',identity.organizationId,session,command);
      const email=command['email'] as string;
      await this.invitations.updateMany({organizationId:identity.organizationId??'',email,status:'PENDING',expiresAt:{$lte:this.identity.now()}},{$set:{status:'EXPIRED',version:`"${randomUUID()}"`}},{session});
      const pending=await this.invitations.findOne({organizationId:identity.organizationId??'',email,status:'PENDING'},{session});
      if(pending)return; // Neutral, coalesced; never prolong existing authorization.
      const token=opaque(),id=randomUUID();
      await this.invitations.insertOne({_id:id,organizationId:identity.organizationId!,email,roleIds:command['roleIds'] as string[],status:'PENDING',expiresAt:this.identity.now()+86400000,inviterId:identity._id,inviterAuthzVersion:identity.authzVersion,version:`"${randomUUID()}"`,tokenHash:digest(token)},{session});
      await this.identity.messaging.notify('TENANT',id,'INVITATION',{email,token},session);
      await this.identity.audit.append({realm:'TENANT',action:'INVITATION_CREATED',actorId:identity._id,subjectId:id,outcome:'SUCCESS'},session);
    });return{code:'GENERIC_ACCOUNT_ACTION'};
  }
  private async validInvitation(id:string,session:ClientSession):Promise<Invitation|null>{
    const invitation=await this.invitations.findOne({_id:id,status:'PENDING',expiresAt:{$gt:this.identity.now()}},{session});if(!invitation)return null;
    const inviter=await this.identity.identities.findOne({_id:invitation.inviterId,realm:'TENANT',organizationId:invitation.organizationId,authzVersion:invitation.inviterAuthzVersion,suspended:false,state:'ACTIVE'},{session});
    const org=await this.organizations.findOne({_id:invitation.organizationId,status:'ACTIVE'},{session});
    if(!inviter||!org||!await this.identity.sessions.factors.countDocuments({subjectId:inviter._id,state:'ACTIVE'},{session}))return null;
    try{Authorization.assign(inviter,invitation.roleIds);}catch{return null;}return invitation;
  }
  async accept(context:Context,body:Command,source:string){
    await this.identity.requireOpen(context.realm);if(context.realm!=='TENANT')throw new AppError(403,'ACCESS_DENIED');validateCommand('A15',body);
    const tokenHash=digest(body['token'] as string);
    if(body['mode']==='PREPARE'){
      const invitation=await this.identity.database.transaction(async session=>{
        const fresh=await this.identity.freshContext(context,session);if(fresh.kind!=='P')throw new AppError(403,'ACCESS_DENIED');
        const row=await this.invitations.findOne({tokenHash},{session});return row?await this.validInvitation(row._id,session):null;
      });
      if(invitation)await this.identity.register('TENANT',source,{email:invitation.email,displayName:body['displayName'] as string??'Invitado',privacyPolicyVersion:body['privacyPolicyVersion'] as string});
      return{status:202,data:{code:'GENERIC_ACCOUNT_ACTION'}};
    }
    return await this.identity.database.transaction(async session=>{
      const {identity}=await this.identity.sessions.requireStrong(context,session);
      const row=await this.invitations.findOne({tokenHash,email:identity.email},{session});
      const invitation=row?await this.validInvitation(row._id,session):null;
      if(!invitation||identity.organizationId)throw new AppError(409,'INVALID_STATE');
      const organization=await this.organizations.findOne({_id:invitation.organizationId,status:'ACTIVE'},{session});if(!organization)throw new AppError(409,'INVALID_STATE');
      const authority=await this.identity.identities.updateOne({_id:invitation.inviterId,authzVersion:invitation.inviterAuthzVersion,suspended:false},{$inc:{sessionSerial:1}},{session});if(authority.matchedCount!==1)throw new AppError(409,'INVALID_STATE');
      const won=await this.invitations.updateOne({_id:invitation._id,status:'PENDING',expiresAt:{$gt:this.identity.now()}},{$set:{status:'ACCEPTED',version:`"${randomUUID()}"`}},{session});if(won.modifiedCount!==1)throw new AppError(409,'INVALID_STATE');
      await this.affiliate(context,identity,organization,invitation.roleIds,session);
      await this.identity.audit.append({realm:'TENANT',action:'INVITATION_ACCEPTED',actorId:identity._id,subjectId:identity._id,outcome:'SUCCESS'},session);
      await this.identity.messaging.notify('TENANT',identity._id,'AFFILIATION_CONFIRMED',{},session);
      return{status:200,data:{organizationId:organization._id,nextAction:'READY'}};
    });
  }
  private representation(org: Organization, management: boolean) {
    return { id: org._id, name: org.name, timezone: org.timezone, currency: org.currency, status: org.status,
      ...(management ? { version: org.version } : {}) };
  }
  async read(context: Context) {
    return await this.identity.database.transaction(async session => {
      const { identity, organization } = await this.actor(context, session, false);
      const management = identity.roles.some(role => ['T','A'].includes(role));
      return { data: {...this.representation(organization, management), actorRoleIds:[...identity.roles]}, ...(management ? { etag: organization.version } : {}) };
    });
  }
  private cursor(org: string, actor: string, last: string): string {
    const value = Buffer.from(JSON.stringify({ org, actor, last })).toString('base64url');
    return value+'.'+createHmac('sha256',this.cursorKey).update(value).digest('base64url');
  }
  private parseCursor(cursor: string | undefined, org: string, actor: string): string | null {
    if (!cursor) return null;
    if (cursor.length > 4096) throw new AppError(422,'INPUT_INVALID');
    const [value,signature] = cursor.split('.');
    if (!value || !signature) throw new AppError(422,'INPUT_INVALID');
    const expected = createHmac('sha256',this.cursorKey).update(value).digest(), received = Buffer.from(signature,'base64url');
    if (received.length !== expected.length || !timingSafeEqual(received,expected)) throw new AppError(422,'INPUT_INVALID');
    const data = JSON.parse(Buffer.from(value,'base64url').toString('utf8')) as {org:string;actor:string;last:string};
    if (data.org !== org || data.actor !== actor || typeof data.last !== 'string') throw new AppError(404,'NOT_FOUND');
    return data.last;
  }
  async members(context: Context, limit = 20, cursor?: string) {
    if (!Number.isInteger(limit) || limit<1 || limit>50) throw new AppError(422,'INPUT_INVALID');
    return await this.identity.database.transaction(async session => {
      const { identity } = await this.actor(context,session);
      const after = this.parseCursor(cursor,identity.organizationId!,identity._id);
      const rows = await this.identity.identities.find({ realm:'TENANT',organizationId:identity.organizationId ?? '',
        ...(after ? {_id:{$gt:after}} : {}) },{session}).sort({_id:1}).limit(limit+1).toArray();
      const page = rows.slice(0,limit), items=[];
      for(const row of page) {
        const flow = row.state==='RECOVERY_RESTRICTED' ? await this.identity.database.db.collection<{_id:string;subjectId:string;status:string;previousState:string}>('recoveries').findOne({subjectId:row._id,status:'ACTIVE'},{session}) : null;
        const status = row.suspended ? 'SUSPENDED' : row.state==='RECOVERY_RESTRICTED' ?
          flow?.previousState==='FACTOR_LOSS_BLOCKED' ? 'FACTOR_LOSS_BLOCKED':'ACTIVE' : row.state==='FACTOR_LOSS_BLOCKED' ? row.state:'ACTIVE';
        items.push({userId:row._id,displayName:row.displayName,email:row.email,roleIds:row.roles,status,version:row.version});
      }
      return {items,nextCursor:rows.length>limit ? this.cursor(identity.organizationId!,identity._id,page.at(-1)!._id):null};
    });
  }
  async listInvitations(context: Context, limit=20, cursor?:string) {
    if (!Number.isInteger(limit)||limit<1||limit>50) throw new AppError(422,'INPUT_INVALID');
    return await this.identity.database.transaction(async session=>{
      const {identity}=await this.actor(context,session);
      const after=this.parseCursor(cursor,identity.organizationId!,identity._id);
      const rows=await this.invitations.find({organizationId:identity.organizationId ?? '',...(after?{_id:{$gt:after}}:{})},{session}).sort({_id:1}).limit(limit+1).toArray();
      const page=rows.slice(0,limit);
      return {items:page.map(i=>({id:i._id,email:i.email,roleIds:i.roleIds,status:i.status==='PENDING'&&i.expiresAt<=this.identity.now()?'EXPIRED':i.status,
        expiresAt:new Date(i.expiresAt).toISOString(),version:i.version})),nextCursor:rows.length>limit?this.cursor(identity.organizationId!,identity._id,page.at(-1)!._id):null};
    });
  }
  async revokeInvitation(context:Context,id:string,ifMatch:string|undefined):Promise<void>{
    await this.identity.database.transaction(async session=>{
      const {identity}=await this.actor(context,session);
      const invite=await this.invitations.findOne({_id:id,organizationId:identity.organizationId ?? ''},{session});
      if(!invite)throw new AppError(404,'NOT_FOUND');Authorization.assign(identity,invite.roleIds);this.version(invite.version,ifMatch);
      if(invite.status!=='PENDING'||invite.expiresAt<=this.identity.now())throw new AppError(409,'INVALID_STATE');
      await this.identity.sessions.consumeProof(context,'INVITATION_REVOKE',id,session);
      await this.invitations.updateOne({_id:id},{$set:{status:'REVOKED',version:`"${randomUUID()}"`}},{session});
      await this.identity.audit.append({realm:'TENANT',action:'INVITATION_REVOKED',actorId:identity._id,subjectId:id,outcome:'SUCCESS'},session);
    });
  }
  async memberCommand(context:Context,id:string,command:'SUSPEND'|'REACTIVATE'|'REVOKE',ifMatch:string|undefined){
    return await this.identity.database.transaction(async session=>{
      const {identity}=await this.actor(context,session);const target=await this.member(identity,id,session);
      Authorization.target(identity,target);this.version(target.version,ifMatch);
      if(command==='SUSPEND'&&target.suspended||command==='REACTIVATE'&&!target.suspended)throw new AppError(409,'INVALID_STATE');
      const purpose=command==='SUSPEND'?'MEMBER_SUSPEND':command==='REACTIVATE'?'MEMBER_REACTIVATE':'MEMBER_SESSIONS_REVOKE';
      await this.identity.sessions.consumeProof(context,purpose,id,session);
      const count=await this.identity.sessions.operationalCount([id],session);
      const version=command==='REVOKE'?target.version:`"${randomUUID()}"`;
      if(command==='REVOKE') {
        const authEpoch = randomUUID();
        await this.identity.identities.updateOne({_id:id},{$set:{authEpoch}},{session});
        await this.identity.sessions.contexts.updateMany({subjectId:id,kind:'E_RECOVERY',revoked:false,authEpoch:target.authEpoch},{$set:{authEpoch}},{session});
      }
      else{
        if (command === 'SUSPEND') {
          const activeRecovery = await this.identity.database.db.collection('recoveries').findOne({subjectId:id,status:'ACTIVE'},{session});
          if (activeRecovery && !this.identity.suspendRecovery) throw new AppError(503,'SERVICE_UNAVAILABLE');
          await this.identity.suspendRecovery?.(target, session);
        }
        const factorCount=await this.identity.sessions.factors.countDocuments({subjectId:id,state:'ACTIVE'},{session});
        await this.identity.identities.updateOne({_id:id},{$set:{suspended:command==='SUSPEND',state:command==='SUSPEND'?'SUSPENDED':factorCount?'ACTIVE':'FACTOR_LOSS_BLOCKED',
          authzVersion:randomUUID(),version}},{session});
        await this.invitations.updateMany({inviterId:id,status:'PENDING'},{$set:{status:'REVOKED'}},{session});
      }
      await this.identity.sessions.contexts.updateMany({subjectId:id,kind:'S'},{$set:{revoked:true}},{session});
      await this.identity.audit.append({realm:'TENANT',action:`MEMBER_${command}`,actorId:identity._id,subjectId:id,outcome:'SUCCESS'},session);
      if(command==='REVOKE')return {data:{revokedCount:count,operationId:randomUUID()}};
      const fresh=await this.identity.identities.findOne({_id:id},{session});
      return {data:{status:fresh?.suspended?'SUSPENDED':fresh?.state==='FACTOR_LOSS_BLOCKED'?'FACTOR_LOSS_BLOCKED':'ACTIVE',version},etag:version};
    });
  }
  async revokeOrganization(context:Context,ifMatch:string|undefined){
    return await this.identity.database.transaction(async session=>{
      const {identity,organization}=await this.actor(context,session);
      if(!identity.roles.includes('T'))throw new AppError(403,'ACCESS_DENIED');this.version(organization.version,ifMatch);
      await this.identity.sessions.consumeProof(context,'ORGANIZATION_SESSIONS_REVOKE',organization._id,session);
      const members=await this.identity.identities.find({organizationId:organization._id,realm:'TENANT'},{session}).toArray();
      const ids=members.map(i=>i._id);
      const count=await this.identity.sessions.operationalCount(ids,session);
      await this.organizations.updateOne({_id:organization._id},{$set:{authEpoch:randomUUID()}},{session});
      await this.identity.sessions.contexts.updateMany({subjectId:{$in:ids},kind:'S'},{$set:{revoked:true}},{session});
      await this.identity.audit.append({realm:'TENANT',action:'ORGANIZATION_SESSIONS_REVOKED',actorId:identity._id,subjectId:organization._id,outcome:'SUCCESS'},session);
      return {revokedCount:count,operationId:randomUUID()};
    });
  }
}
