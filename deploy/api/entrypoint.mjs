import fs from 'node:fs/promises';
import {X509Certificate,createPrivateKey} from 'node:crypto';
import {regularFile,sha256,verifyBundle} from './verify-contracts.mjs';
try{
 const [major,minor]=process.versions.node.split('.').map(Number);
 if(major!==24||minor<15||process.getuid?.()!==1000||process.cwd()!=='/srv/Caudelyx/servidor')throw Error('DEMO_RUNTIME_INVALID');
 if(process.env.CAUDELYX_RUNTIME_PROFILE!=='persistent-demo')throw Error('DEMO_PROFILE_REQUIRED');
 await verifyBundle('/srv','/srv/caudelyx-contracts.json',process.env.CAUDELYX_CONTRACTS_SHA256);
 if(sha256(await regularFile('src/modules/exchange/assets/DejaVuSans.ttf'))!=='7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954')throw Error('DEMO_PDF_FONT_INVALID');
 const keys=JSON.parse(await regularFile(process.env.KEYRING_FILE));
 if(keys.version!==2)throw Error('DEMO_KEYRING_INVALID');
 for(const name of ['priority','mail','totp','journal','cursor'])if(typeof keys[name]!=='string'||Buffer.from(keys[name],'base64url').length!==32)throw Error('DEMO_KEYRING_INVALID');
 const directory=process.env.TLS_DIRECTORY??'/run/tls',cert=new X509Certificate(await regularFile(directory+'/cert.pem'));
 if(!cert.checkHost('api')||!cert.checkPrivateKey(createPrivateKey(await regularFile(directory+'/key.pem')))||Date.parse(cert.validFrom)>Date.now()||Date.parse(cert.validTo)<=Date.now()+60000)throw Error('DEMO_API_TLS_INVALID');
 await fs.access(directory+'/ca.pem');
 await import('../dist-docker/src/server.js');
}catch(error){console.error(error instanceof Error&&/^DEMO_[A-Z0-9_]+$/.test(error.message)?error.message:'DEMO_PREFLIGHT_FAILED');process.exitCode=1;}
