// Terminal-only synthetic mailbox. No writes, HTTP exposure or token logging.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createDecipheriv,createHmac,timingSafeEqual} from 'node:crypto';
export async function messagesFor(email){
 if(process.env.CAUDELYX_MODE!=='local-synthetic'||process.env.CAUDELYX_RUNTIME_PROFILE!=='persistent-demo'||!/^[\x21-\x7e]+@example\.test$/i.test(email)||email.split('@').length!==2||email.length>254)throw Error('DEMO_MAILBOX_DENIED');
 const require=createRequire(path.join(process.cwd(),'package.json')),{MongoClient}=require('mongodb');
 const build=process.env.CAUDELYX_BUILD_DIR??'dist-docker',config=(await import(pathToFileURL(path.resolve(build,'src/shared/config.js')).href)).loadConfig(process.env);
 const keys=JSON.parse(await fs.readFile(process.env.KEYRING_FILE,'utf8')),profile=JSON.parse(await fs.readFile(config.profileFile,'utf8'));
 const signature=createHmac('sha256',Buffer.from(keys.journal,'base64url')).update('CAUDELYX:DEMO:PROFILE:v1:'+JSON.stringify(profile.payload)).digest('hex');
 if(!/^[a-f0-9]{64}$/.test(profile.signature)||!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(profile.signature,'hex'))||profile.payload.databaseName!==config.databaseName||profile.payload.mongoUri!==config.mongoUri||profile.payload.tenantOrigin!==config.tenantOrigin)throw Error('DEMO_MAILBOX_PROFILE_INVALID');
 const key=Buffer.from(keys.mail??'','base64url');if(key.length!==32)throw Error('DEMO_MAILBOX_KEY_INVALID');
 const unseal=text=>{const b=Buffer.from(text,'base64url'),d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8');};
 const client=new MongoClient(config.mongoUri,config.mongoOptions);
 try{
  await client.connect();const db=client.db(config.databaseName),now=Date.now(),items=[],identity=await db.collection('identities').findOne({email:email.toLowerCase(),realm:'TENANT'});
  if(identity)for(const m of await db.collection('synthetic_mail').find({subjectId:identity._id,realm:'TENANT',delivered:true,expiresAt:{$gt:now}}).toArray()){
   const proof=await db.collection('email_proofs').findOne({_id:m.proofHash,consumed:false,expiresAt:{$gt:now},credentialVersion:identity.credentialVersion});
   if(!proof||(proof.purpose==='INITIAL_MFA_PROOF'&&proof.initialProofEpoch!==identity.initialProofEpoch))continue;
   if(proof.contextId&&!await db.collection('contexts').findOne({_id:proof.contextId,revoked:false,kind:'L',expiresAt:{$gt:now}}))continue;
   const token=unseal(m.encryptedToken),activation=['ACTIVATION','INITIAL_MFA_PROOF'].includes(m.purpose),legacy=m.purpose==='ACTIVATION'&&identity.registrationSource==='INVITATION'&&!identity.passwordHash;
   const query=new URLSearchParams({purpose:m.purpose,token,...(legacy?{legacy:'1'}:{})});items.push({purpose:m.purpose,code:token,expiresAt:new Date(m.expiresAt).toISOString(),...(activation?{activationUrl:config.tenantOrigin+'/#/activar?'+query,requiresPasswordSetup:legacy}:{}),...(m.rejectionAction==='REJECT_UNCONFIRMED_ACCOUNT'?{rejectionUrl:config.tenantOrigin+'/#/rechazar?'+new URLSearchParams({purpose:'REJECT',token})}:{})});
  }
  for(const note of await db.collection('synthetic_notifications').find({realm:'TENANT',kind:'INVITATION',delivered:true,expiresAt:{$gt:now}}).toArray()){
   const value=JSON.parse(unseal(note.encryptedPayload));if(value.email!==email.toLowerCase())continue;
   if(value.token&&await db.collection('invitations').findOne({_id:note.subjectId,status:'PENDING',expiresAt:{$gt:now}}))items.push({purpose:'INVITATION',code:value.token,expiresAt:new Date(note.expiresAt).toISOString()});
  }
  return items;
 }finally{await client.close();}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{const [flag,email,...extra]=process.argv.slice(2);if(flag!=='--email'||extra.length)throw Error('DEMO_MAILBOX_USAGE');console.log(JSON.stringify({messages:await messagesFor(email)},null,2));}catch{console.error('DEMO_MAILBOX_DENIED');process.exitCode=1;}}
