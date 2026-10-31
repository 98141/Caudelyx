import path from 'node:path';
import {verifyCandidate,writeSidecar,VerificationError} from './s11-verifier-core.mjs';
const flags=new Map();
try{
 const allowed=new Set(['--root','--manifest','--sha256','--snapshot','--source-fingerprint','--build-state','--sidecar','--sidecar-root','--client-build-state']),argv=process.argv.slice(2);
 for(let i=0;i<argv.length;i+=2){if(!allowed.has(argv.at(i))||flags.has(argv.at(i))||!argv.at(i+1)||argv.at(i+1).startsWith('--'))throw new VerificationError('INVALID_ARGUMENTS');flags.set(argv.at(i),argv.at(i+1));}
 if(Boolean(flags.get('--sidecar'))!==Boolean(flags.get('--sidecar-root')))throw new VerificationError('EXPLICIT_SIDECAR_ROOT_REQUIRED');
 const started=performance.now(),verified=await verifyCandidate({root:flags.get('--root')?path.resolve(flags.get('--root')):undefined,manifest:flags.get('--manifest'),expectedManifestSHA256:flags.get('--sha256'),snapshot:flags.get('--snapshot'),expectedSourceFingerprint:flags.get('--source-fingerprint'),buildState:flags.get('--build-state')});
 verified.report={...verified.report,tool:'S11-P04-READONLY-VERIFIER-1'};
 if(flags.has('--client-build-state')){
  // The accepted core checks one closed build tree per pass. The second pass
  // is necessary for the separately compiled client, with the same pinned identity.
  const client=await verifyCandidate({root:flags.get('--root')?path.resolve(flags.get('--root')):undefined,manifest:flags.get('--manifest'),expectedManifestSHA256:flags.get('--sha256'),snapshot:flags.get('--snapshot'),expectedSourceFingerprint:flags.get('--source-fingerprint'),buildState:flags.get('--client-build-state')});
  if(client.report.manifestSHA256!==verified.report.manifestSHA256||client.report.sourceFingerprint!==verified.report.sourceFingerprint)throw new VerificationError('CANDIDATE_CHANGED_BETWEEN_BUILDS');
  for(const p of client.protectedPaths)verified.protectedPaths.add(p);for(const p of client.protectedDirectories)verified.protectedDirectories.add(p);
  verified.report={...verified.report,compiledClientInputs:client.report.compiledInputs,compiledClientOutputs:client.report.compiledOutputs,bytesRead:verified.report.bytesRead+client.report.bytesRead,closedBuildPasses:2};
 }
 if(flags.has('--sidecar')){await writeSidecar(verified,{sidecar:flags.get('--sidecar'),sidecarRoot:flags.get('--sidecar-root')});verified.report={...verified.report,readOnly:false,sidecarExplicitlyRequested:true};}
 process.stdout.write(JSON.stringify({...verified.report,durationMs:performance.now()-started})+'\n');
}catch(error){process.stdout.write(JSON.stringify({tool:'S11-P04-READONLY-VERIFIER-1',result:'FAIL',error:error instanceof VerificationError?error.code:['EEXIST','EACCES','EPERM'].includes(error.code)?error.code:'VERIFICATION_FAILED',readOnly:!flags.has('--sidecar')})+'\n');process.exitCode=1;}
