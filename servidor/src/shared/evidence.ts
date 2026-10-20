import type { ClientSession } from 'mongodb';
import type { Database } from './database.js';
import type { Identity, Factor } from '../modules/identity/models.js';
import type { Organization, Invitation } from '../modules/organizations/service.js';
import { digest } from './crypto.js';

export async function captureSecurityState(database: Database, session: ClientSession) {
  const identities = await database.db.collection<Identity>('identities').find({}, { session }).sort({_id:1}).toArray();
  const factors = await database.db.collection<Factor>('factors').find({}, { session }).sort({_id:1}).toArray();
  const codes = await database.db.collection<{_id:string;subjectId:string;batch:string;consumed:boolean}>('recovery_codes').find({}, {session}).sort({_id:1}).toArray();
  const invitations = await database.db.collection<Invitation>('invitations').find({}, {session}).sort({_id:1}).toArray();
  const organizations = await database.db.collection<Organization>('organizations').find({}, {session}).sort({_id:1}).toArray();
  return {
    identities: identities.map(i=>({_id:i._id,realm:i.realm,emailHash:digest(`${i.realm}:${i.email}`),organizationId:i.organizationId,
      roles:i.roles,state:i.state,suspended:i.suspended,version:i.version,credentialVersion:i.credentialVersion,authEpoch:i.authEpoch,
      authzVersion:i.authzVersion,initialProofEpoch:i.initialProofEpoch,hasEverConfirmedFactor:i.hasEverConfirmedFactor,
      hasEverActive:i.hasEverActive,resetCompletedAt:i.resetCompletedAt,recoveryBatch:i.recoveryBatch??null,cooldownUntil:i.cooldownUntil??null})),
    factors:factors.map(f=>({_id:f._id,subjectId:f.subjectId,realm:f.realm,state:f.state,version:f.version,type:f.type,lastStep:f.lastStep??null,counter:f.counter??0})),
    codes:codes.map(c=>({_id:c._id,subjectId:c.subjectId,batch:c.batch,consumed:c.consumed})),
    invitations:invitations.map(i=>({_id:i._id,organizationId:i.organizationId,status:i.status,roleIds:i.roleIds,version:i.version,inviterAuthzVersion:i.inviterAuthzVersion})),
    organizations:organizations.map(o=>({_id:o._id,status:o.status,name:o.name,version:o.version,authEpoch:o.authEpoch})),
  };
}
export type SecurityState = Awaited<ReturnType<typeof captureSecurityState>>;
