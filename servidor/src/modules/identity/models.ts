export type Realm = 'TENANT' | 'PLATFORM';
export type State = 'PENDING_EMAIL' | 'MFA_ENROLLMENT' | 'AUTHENTICATED_NO_ORG' | 'ACTIVE' | 'SUSPENDED' | 'FACTOR_LOSS_BLOCKED' | 'RECOVERY_RESTRICTED';
export interface Identity {
  _id: string; realm: Realm; email: string; displayName: string; passwordHash: string | null;
  state: State; organizationId: string | null; roles: string[]; version: string;
  credentialVersion: string; initialProofEpoch: string; authEpoch: string; authzVersion: string;
  hasEverConfirmedFactor: boolean; hasEverActive: boolean; resetCompletedAt: number | null;
  restoreBootstrapBlocked: boolean; suspended: boolean; createdAt: number; factorCount: number;
}
export type ContextKind = 'P' | 'L' | 'E_INITIAL' | 'E_RECOVERY' | 'S';
export interface Context {
  _id: string; managementId: string; realm: Realm; kind: ContextKind; subjectId: string | null;
  csrfHash: string; createdAt: number; lastSeenAt: number; expiresAt: number; revoked: boolean;
  credentialVersion: string | null; initialProofEpoch: string | null; authEpoch: string | null;
  authzVersion: string | null; passwordAt: number | null;
  preview: { proofHash: string; credentialVersion: string; initialProofEpoch: string; state: State; warning: boolean } | null;
}
export interface EmailProof {
  _id: string; realm: Realm; subjectId: string; purpose: 'ACTIVATION' | 'RESET' | 'INITIAL_MFA_PROOF';
  credentialVersion: string; initialProofEpoch: string; contextId: string | null;
  expiresAt: number; consumed: boolean;
}
export interface Quota {
  _id: string; subjectId: string; realm: Realm; purpose: EmailProof['purpose']; sentAt: number[]; sourceTimes: Record<string, number>;
  pending: { admittedAt: number; dueAt: number; source: string; contextId: string | null } | null;
}
export interface SyntheticMessage {
  _id: string; subjectId: string; realm: Realm; purpose: EmailProof['purpose'];
  encryptedToken: string; proofHash: string; expiresAt: number; warning: string | null;
  delivered: boolean;
}
