export const backupLimits=Object.freeze({clear:256*1024*1024,cipher:512*1024*1024,component:128*1024*1024,header:65536,documents:10000});
export const componentKinds=['SIGNED_PRINCIPAL_SNAPSHOT','EXTERNAL_MAIL_DATA','EXTERNAL_SECURITY_DATA','EXTERNAL_JOURNAL','EXTERNAL_CONTROL','PRIVATE_FILE','PRODUCT_KEYRING','CONFIGURATION'] as const;
export type ComponentKind=typeof componentKinds[number];
export interface Component {id:string;kind:ComponentKind;relativePath:string;bytes:number;sha256:string;dataBase64:string}
export interface BackupCandidate {id:string;manifestSHA256:string;sourceFingerprint:string;contractsSHA256:string;configurationSHA256:string;keyPolicyVersion:number}
export interface BackupPayload {formatVersion:1;runId:string;source:{databaseNames:string[]};destination:{databaseNames:string[]};cut:{economicAsOf:string;capturedAtUTC:string;T0:number;T1:number;securitySignatureAtT0:string;securitySignatureAtT1:string};candidate:BackupCandidate;components:Component[]}
export interface WrappingKey {formatVersion:1;keyId:string;containerSHA256:string;keyBase64:string}
export class BackupError extends Error {constructor(readonly code:'BACKUP_INVALID'|'BACKUP_LIMIT'|'BACKUP_PATH'|'BACKUP_OWNERSHIP'|'BACKUP_CUT'|'BACKUP_STATE',readonly phase?:'FILES'|'EXTERNAL'|'CATALOG'|'BEGIN_RESTORE'|'INITIALIZE'|'RECONCILE'){super(code+(phase?':'+phase:''));this.name='BackupError';}}
export const fail=(code:BackupError['code']='BACKUP_INVALID'):never=>{throw new BackupError(code);};
