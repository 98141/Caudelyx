import {MongoNetworkError,MongoServerSelectionError} from 'mongodb';

// Closed technical vocabulary. Never emit message/stack/cause, Mongo payloads,
// paths, collection names, URI, credentials, tokens or signed control contents.
export const bootStages=[
  'BOOT','CONFIG','DATABASE_CLIENT','KEYRING','DEMO_ADMISSION','DEMO_PROFILE_READ',
  'DEMO_CONNECT','DEMO_TOPOLOGY','DEMO_IDENTITY','DEMO_LEASE','DATABASE_INDEXES',
  'RESTORE','RESTORE_EXTERNAL','RESTORE_JOURNAL','RESTORE_FINANCE','RESTORE_LENDING',
  'RESTORE_MANAGEMENT','RESTORE_SIMULATION','RESTORE_PRIORITY','RESTORE_OPEN',
  'IDENTITY','IDENTITY_INDEXES','IDENTITY_SESSIONS','IDENTITY_PASSWORD','RUNTIME',
  'RUNTIME_RECOVERY','RUNTIME_ORGANIZATIONS','RUNTIME_FINANCE','RUNTIME_OPENING',
  'RUNTIME_LENDING','RUNTIME_OPERATIONS','RUNTIME_PAYMENTS','RUNTIME_COLLECTIONS',
  'RUNTIME_REPORTING','RUNTIME_CONSTRUCTORS','PRIVATE_STORAGE','MODULES',
  'MODULE_MANAGEMENT_PREPARE','MODULE_WEALTH_PREPARE','MODULE_SIMULATION_PREPARE',
  'MODULE_CORE_PREPARE','MODULE_REPORTING_ACTIVATE','MODULE_MANAGEMENT_ACTIVATE',
  'MODULE_SIMULATION_ACTIVATE','MODULE_MONTHLY_ACTIVATE','MODULES_READY',
  'TLS_LOAD','TENANT_LISTEN','PLATFORM_LISTEN','READY','COMPLETE','CLEANUP',
  'CLEANUP_LISTENERS','CLEANUP_WORKERS','CLEANUP_LEASE','CLEANUP_DATABASE',
] as const;
export type BootStage=typeof bootStages[number];
const accepted=new Set<string>(bootStages);
const safeMessages=new Set([
  'DEMO_CONTROL_PATH_INVALID','DEMO_KEYRING_VERSION_INVALID','DEMO_KEYRING_INVALID',
  'DEMO_ADMISSION_REQUIRED','DEMO_PROFILE_REQUIRED','DEMO_PROFILE_BINDING_INVALID',
  'DEMO_AUTHENTICATED_TLS_REQUIRED','DEMO_AUTH_REQUIRED','DEMO_ACTUAL_CONNECTION_INVALID',
  'DEMO_TOPOLOGY_INVALID','DEMO_UNCLAIMED_DATA','DEMO_DATABASE_BINDING_INVALID',
  'DEMO_INITIALIZATION_STATE_INVALID','DEMO_LEASE_BUSY_OR_UNAVAILABLE','DEMO_LEASE_BUSY',
  'DEMO_LEASE_INVALID','DEMO_LEASE_UNAVAILABLE','DEMO_LEASE_OR_PROFILE_INVALID',
  'DEMO_CONTROL_CHANGED','DEMO_COMMIT_FENCE_REJECTED','DEMO_RUNTIME_CLOSED',
  'DEMO_IDENTITY_READY_REJECTED','DEMO_RESTORE_GATE_CLOSED','DEMO_MODULES_UNAVAILABLE',
]);
const safeCodes=new Set([
  'ENOENT','EACCES','EPERM','ENOTDIR','EISDIR','EEXIST','ELOOP','EROFS','ENOSPC',
  'EADDRINUSE','EADDRNOTAVAIL','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND',
  'CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN','DEPTH_ZERO_SELF_SIGNED_CERT',
  'INTEGRITY_MISMATCH','SERVICE_UNAVAILABLE','ACCESS_DENIED',
]);
const mongoCodes=new Map<number,string>([
  [13,'MONGO_UNAUTHORIZED'],[18,'MONGO_AUTHENTICATION_FAILED'],[26,'MONGO_NAMESPACE_NOT_FOUND'],
  [48,'MONGO_NAMESPACE_EXISTS'],[50,'MONGO_TIME_LIMIT'],[85,'MONGO_INDEX_OPTIONS_CONFLICT'],
  [86,'MONGO_INDEX_KEY_CONFLICT'],[91,'MONGO_SHUTDOWN'],[112,'MONGO_WRITE_CONFLICT'],
  [251,'MONGO_NO_SUCH_TRANSACTION'],[11000,'MONGO_DUPLICATE_KEY'],
]);
export function safeBootCode(error:unknown):string{
  let current=error;
  for(let depth=0;depth<4&&current&&typeof current==='object';depth++){
    const value=current as {code?:unknown;message?:unknown;cause?:unknown};
    if(typeof value.code==='string'&&safeCodes.has(value.code))return value.code;
    if(typeof value.code==='number'&&mongoCodes.has(value.code))return mongoCodes.get(value.code)!;
    if(typeof value.message==='string'&&safeMessages.has(value.message))return value.message;
    current=value.cause;
  }
  if(error instanceof MongoServerSelectionError)return 'MONGO_SERVER_SELECTION';
  if(error instanceof MongoNetworkError)return 'MONGO_NETWORK';
  return 'UNCLASSIFIED';
}
export class BootDiagnostics{
  private failed=false;
  constructor(private readonly log:(line:string)=>void=line=>console.error(line)){}
  mark(stage:BootStage,status:'START'|'OK'|'BLOCKED',code?:'INTEGRITY_MISMATCH'){
    if(!accepted.has(stage))throw Error('Invalid boot stage');
    this.log(JSON.stringify({event:'CAUDELYX_BOOT',stage,status,...(code?{code}:{} )}));
  }
  fail(stage:BootStage,error:unknown){
    if(!accepted.has(stage))throw Error('Invalid boot stage');
    if(this.failed&&!stage.startsWith('CLEANUP'))return;this.failed=true;
    this.log(JSON.stringify({event:'CAUDELYX_BOOT',stage,status:'FAIL',code:safeBootCode(error)}));
  }
  async run<T>(stage:BootStage,work:()=>T|Promise<T>):Promise<T>{
    this.mark(stage,'START');
    try{const result=await work();this.mark(stage,'OK');return result;}
    catch(error){this.fail(stage,error);throw error;}
  }
}
export async function bootStep<T>(boot:BootDiagnostics|undefined,stage:BootStage,work:()=>T|Promise<T>):Promise<T>{
  return boot?await boot.run(stage,work):await work();
}
