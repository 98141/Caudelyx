import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
// Reuse the accepted pure core only after validating its bytes. The historical
// CLI/fixture/runner is never imported or executed.
const url=new URL('./s10-verifier-core.mjs',import.meta.url);
if(createHash('sha256').update(readFileSync(url)).digest('hex')!=='7e89fcfad5ae38f5af1830e242ed3c28a88c01d8f50dab20c9185b77e95f6846')throw Error('READONLY_CORE_CHANGED');
const core=await import(url.href);
export const {VerificationError,digest,listFingerprint,buildFingerprint,parseUniqueJSON,FORMAT}=core;
export async function verifyCandidate(options){const result=await core.verifyCandidate(options);result.report={...result.report,tool:'S11-READONLY-VERIFIER-1',reusedCoreSHA256:'7e89fcfad5ae38f5af1830e242ed3c28a88c01d8f50dab20c9185b77e95f6846'};return result;}
export const writeSidecar=core.writeSidecar;
