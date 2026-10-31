import path from 'node:path';
import {verifyCandidate,writeSidecar,VerificationError} from './s11-verifier-core.mjs';
const flags=new Map();
try{
 const allowed=new Set(['--root','--manifest','--sha256','--snapshot','--source-fingerprint','--build-state','--sidecar','--sidecar-root']),argv=process.argv.slice(2);
 for(let i=0;i<argv.length;i+=2){if(!allowed.has(argv.at(i))||flags.has(argv.at(i))||!argv.at(i+1)||argv.at(i+1).startsWith('--'))throw new VerificationError('INVALID_ARGUMENTS');flags.set(argv.at(i),argv.at(i+1));}
 if(Boolean(flags.get('--sidecar'))!==Boolean(flags.get('--sidecar-root')))throw new VerificationError('EXPLICIT_SIDECAR_ROOT_REQUIRED');
 const started=performance.now(),verified=await verifyCandidate({root:flags.get('--root')?path.resolve(flags.get('--root')):undefined,manifest:flags.get('--manifest'),expectedManifestSHA256:flags.get('--sha256'),snapshot:flags.get('--snapshot'),expectedSourceFingerprint:flags.get('--source-fingerprint'),buildState:flags.get('--build-state')});
 if(flags.has('--sidecar')){await writeSidecar(verified,{sidecar:flags.get('--sidecar'),sidecarRoot:flags.get('--sidecar-root')});verified.report={...verified.report,readOnly:false,sidecarExplicitlyRequested:true};}
 process.stdout.write(JSON.stringify({...verified.report,durationMs:performance.now()-started})+'\n');
}catch(error){process.stdout.write(JSON.stringify({tool:'S11-READONLY-VERIFIER-1',result:'FAIL',error:error instanceof VerificationError?error.code:['EEXIST','EACCES','EPERM'].includes(error.code)?error.code:'VERIFICATION_FAILED',readOnly:!flags.has('--sidecar')})+'\n');process.exitCode=1;}
