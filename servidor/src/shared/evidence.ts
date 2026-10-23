import type { ClientSession } from 'mongodb';
import type { Database } from './database.js';
import type { Identity, Factor } from '../modules/identity/models.js';
import type { Organization, Invitation } from '../modules/organizations/service.js';
import { digest } from './crypto.js';
import type { FinanceEvidence } from '../modules/finance/integrity.js';

export async function captureSecurityState(database: Database, session: ClientSession) {
  const identities = await database.db.collection<Identity>('identities').find({}, { session }).sort({_id:1}).toArray();
  const factors = await database.db.collection<Factor>('factors').find({}, { session }).sort({_id:1}).toArray();
  const codes = await database.db.collection<{_id:string;subjectId:string;batch:string;consumed:boolean}>('recovery_codes').find({}, {session}).sort({_id:1}).toArray();
  const invitations = await database.db.collection<Invitation>('invitations').find({}, {session}).sort({_id:1}).toArray();
  const organizations = await database.db.collection<Organization>('organizations').find({}, {session}).sort({_id:1}).toArray();
  const financialHead=await database.db.collection<FinanceEvidence&{_id:string}>('financial_evidence_head').findOne({_id:'finance'},{session});
  return {
    ...(financialHead?{finance:{digest:financialHead.digest,revision:financialHead.revision,...(financialHead.format?{format:financialHead.format}:{})}}:{}),
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

export const securitySections = ['identities', 'factors', 'codes', 'invitations', 'organizations'] as const;
type Section = typeof securitySections[number];
export type SecurityEvidence = SecurityState & { format?: 'delta-v1'; reset?: true; removed?: Record<Section, string[]> };

// Projection is transactional primary metadata, never external proof. A missing/misaligned
// projection emits a checkpoint once; historical signed entries are never rewritten.
export async function captureSecurityDelta(database: Database, session: ClientSession, sequence: number): Promise<SecurityEvidence> {
  const state = await captureSecurityState(database, session);
  const projection = database.db.collection<{ _id: string; hash?: string; section?: Section; entityId?: string; sequence?: number }>('security_evidence_projection');
  const previous = await projection.find({}, { session }).toArray();
  const reset = previous.find(p => p._id === 'head')?.sequence !== sequence - 1;
  const hashes = new Map(previous.map(p => [p._id, p.hash]));
  const next: SecurityEvidence = { identities: [], factors: [], codes: [], invitations: [], organizations: [], format: 'delta-v1',
    ...(state.finance?{finance:state.finance}:{}),
    ...(reset ? { reset: true as const } : {}), removed: { identities: [], factors: [], codes: [], invitations: [], organizations: [] } };
  const seen = new Set<string>();
  for (const section of securitySections) {
    // eslint-disable-next-line security/detect-object-injection -- Closed internal section allowlist, not request data.
    for (const row of state[section]) {
      const id = digest(JSON.stringify([section, row._id])), hash = digest(JSON.stringify(row)); seen.add(id);
      if (reset || hashes.get(id) !== hash) {
        // eslint-disable-next-line security/detect-object-injection -- Same fixed section allowlist.
        (next[section] as { _id: string }[]).push(row);
        await projection.updateOne({ _id: id }, { $set: { hash, section, entityId: row._id } }, { session, upsert: true });
      }
    }
  }
  for (const prior of previous) if (prior._id !== 'head' && !seen.has(prior._id)) {
    if (prior.section && prior.entityId && next.removed) next.removed[prior.section].push(prior.entityId);
    await projection.deleteOne({ _id: prior._id }, { session });
  }
  await projection.updateOne({ _id: 'head' }, { $set: { sequence } }, { session, upsert: true });
  return next;
}

export function reconstructSecurityState(events: Iterable<{ state: SecurityEvidence }>): SecurityState {
  let finance:FinanceEvidence|undefined;
  const tables = new Map<Section, Map<string, { _id: string }>>(securitySections.map(section => [section, new Map()]));
  for (const { state } of events) {
    if(state.finance)finance=state.finance;
    if (!state.format || state.reset) for (const table of tables.values()) table.clear();
    for (const section of securitySections) {
      const table = tables.get(section); if (!table) throw new Error('Unknown evidence section');
      // eslint-disable-next-line security/detect-object-injection -- Closed internal section allowlist.
      for (const id of state.removed?.[section] ?? []) table.delete(id);
      // eslint-disable-next-line security/detect-object-injection -- Closed internal section allowlist.
      for (const row of state[section]) table.set(row._id, row);
    }
  }
  return {...Object.fromEntries(securitySections.map(section => [section, [...(tables.get(section)?.values() ?? [])]])),...(finance?{finance}:{})} as SecurityState;
}
