/* eslint-disable security/detect-object-injection -- Scanner offsets are bounded numeric string indices; object keys are closed schema fields or validated ComponentKind values. No dynamic execution/prototype assignment. */
import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {backupLimits as limits,componentKinds,fail,type BackupPayload,type Component,type ComponentKind,type WrappingKey} from './models.js';
const magic=Buffer.from('CAUDELYX-S13-BACKUP\n'),uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,sha=/^[a-f0-9]{64}$/;
export const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
function object(v:unknown,keys:string[]):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||Object.keys(v).some(k=>!keys.includes(k)))return fail();return v as Record<string,unknown>;}
const text=(v:unknown)=>{if(typeof v!=='string'||!v||v.length>1024)return fail();return v;};
const integer=(v:unknown)=>{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)return fail();return v;};
const hash=(v:unknown)=>{if(!sha.test(text(v)))fail();};
/** Reject duplicate JSON keys and ambiguous UTF8 before the ordinary parser. */
export function strictDocument(bytes:Buffer,signal?:AbortSignal):unknown{
 if(bytes.length>limits.clear)fail('BACKUP_LIMIT');let t:string;try{t=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return fail();}let i=0;
 const ws=()=>{while(i<t.length&&/[\t\n\r ]/.test(t[i]!))i++;};
 const str=():string=>{const start=i;if(t[i++]!=='"')return fail();while(i<t.length){if((i&1048575)===0)signal?.throwIfAborted();const c=t[i++];if(c==='"'){try{return JSON.parse(t.slice(start,i)) as string;}catch{return fail();}}if(c==='\\')i++;}return fail();};
 const value=(depth:number):void=>{signal?.throwIfAborted();ws();if(depth>64)fail();const c=t[i];if(c==='{'){i++;ws();const seen=new Set<string>();if(t[i]==='}'){i++;return;}while(i<t.length){ws();const key=str();if(seen.has(key))fail();seen.add(key);ws();if(t[i++]!==':')fail();value(depth+1);ws();if(t[i]==='}'){i++;return;}if(t[i++]!==',')fail();}fail();}else if(c==='['){i++;ws();if(t[i]===']'){i++;return;}while(i<t.length){value(depth+1);ws();if(t[i]===']'){i++;return;}if(t[i++]!==',')fail();}fail();}else if(c==='"')str();else{
 // eslint-disable-next-line security/detect-unsafe-regex -- Anchored JSON primitive, bounded total bytes and depth.
 const m=/^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(t.slice(i));if(!m)fail();i+=m![0].length;}};
 try{value(0);ws();if(i!==t.length)fail();return JSON.parse(t) as unknown;}catch(e){if(signal?.aborted)signal.throwIfAborted();void e;return fail();}
}
export function safeRelative(value:string):string{
 if(!value||value.length>180||value.normalize('NFC')!==value||/[^A-Za-z0-9_.\-/]/.test(value)||value.startsWith('/')||value.includes('\\')||value.split('/').some(s=>!s||s==='.'||s==='..'||/[ .]$/.test(s)||/~[0-9]/.test(s)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)))fail('BACKUP_PATH');return value;
}
export function component(kind:ComponentKind,relativePath:string,bytes:Buffer):Component{
 if(bytes.length>limits.component)fail('BACKUP_LIMIT');return{id:randomUUID(),kind,relativePath:safeRelative(relativePath),bytes:bytes.length,sha256:digest(bytes),dataBase64:bytes.toString('base64')};
}
function names(v:unknown):string[]{if(!Array.isArray(v)||v.length!==3||typeof v[0]!=='string'||!/^caudelyx_s08_p02_[a-f0-9]{24}$/.test(v[0])||v[1]!==v[0]+'_external_mail'||v[2]!==v[0]+'_external_security')return fail();return v as string[];}
export function validatePayload(raw:unknown,signal?:AbortSignal):BackupPayload{
 const p=object(raw,['formatVersion','runId','source','destination','cut','candidate','components']);if(p['formatVersion']!==1||!uuid.test(text(p['runId'])))fail();
 const src=names(object(p['source'],['databaseNames'])['databaseNames']),dst=names(object(p['destination'],['databaseNames'])['databaseNames']);if(src.some(n=>dst.includes(n)))fail('BACKUP_OWNERSHIP');
 const cut=object(p['cut'],['economicAsOf','capturedAtUTC','T0','T1','securitySignatureAtT0','securitySignatureAtT1']);if(!/^\d{4}-\d{2}-\d{2}$/.test(text(cut['economicAsOf']))||!Number.isFinite(Date.parse(text(cut['capturedAtUTC'])))||integer(cut['T0'])>integer(cut['T1']))fail('BACKUP_CUT');
 for(const key of ['securitySignatureAtT0','securitySignatureAtT1'])if(cut[key]!==''&&!sha.test(text(cut[key])))fail('BACKUP_CUT');
 const c=object(p['candidate'],['id','manifestSHA256','sourceFingerprint','contractsSHA256','configurationSHA256','keyPolicyVersion']);text(c['id']);for(const key of ['manifestSHA256','sourceFingerprint','contractsSHA256','configurationSHA256'])hash(c[key]);if(![1,2].includes(Number(c['keyPolicyVersion']))||typeof c['keyPolicyVersion']!=='number')fail();
 if(!Array.isArray(p['components'])||!p['components'].length)fail();const ids=new Set<string>(),paths=new Set<string>(),counts=new Map<string,number>();
 for(const rawComponent of p['components'] as unknown[]){signal?.throwIfAborted();const item=object(rawComponent,['id','kind','relativePath','bytes','sha256','dataBase64']),id=text(item['id']),kind=text(item['kind']),relative=safeRelative(text(item['relativePath'])),n=integer(item['bytes']);if(!uuid.test(id)||ids.has(id)||paths.has(relative.toLowerCase())||!componentKinds.some(k=>k===kind))fail();ids.add(id);paths.add(relative.toLowerCase());counts.set(kind,(counts.get(kind)??0)+1);if(n>limits.component||typeof item['dataBase64']!=='string'||item['dataBase64'].length>Math.ceil(limits.component/3)*4)fail('BACKUP_LIMIT');hash(item['sha256']);const bytes=Buffer.from(item['dataBase64'] as string,'base64');if(bytes.length!==n||bytes.toString('base64')!==item['dataBase64']||digest(bytes)!==item['sha256'])fail();
  const fixed:Partial<Record<ComponentKind,string>>={SIGNED_PRINCIPAL_SNAPSHOT:'snapshot/principal.ejson',EXTERNAL_MAIL_DATA:'external/mail.ejson',EXTERNAL_SECURITY_DATA:'external/security.ejson',EXTERNAL_JOURNAL:'controls/gate.json.journal.jsonl',PRODUCT_KEYRING:'keys/product.json',CONFIGURATION:'config/configuration.json'};
  if(fixed[kind as ComponentKind]&&fixed[kind as ComponentKind]!==relative)fail('BACKUP_PATH');if(kind==='EXTERNAL_CONTROL'&&!['controls/gate.json','controls/gate.json.journal.jsonl.receipts.json','controls/cert.pem','controls/key.pem'].includes(relative))fail('BACKUP_PATH');if(kind==='PRIVATE_FILE'&&!/^private\/[a-f0-9-]{36}$/.test(relative))fail('BACKUP_PATH');
 }
 for(const k of componentKinds.filter(k=>!['PRIVATE_FILE','EXTERNAL_CONTROL'].includes(k)))if(counts.get(k)!==1)fail();if(!counts.get('EXTERNAL_CONTROL'))fail();
 const configuration=(p['components'] as Component[]).find(c=>c.kind==='CONFIGURATION')!;if(configuration.sha256!==c['configurationSHA256'])fail();
 return raw as BackupPayload;
}
export function sealContainer(payload:BackupPayload,signal?:AbortSignal):{bytes:Buffer;key:WrappingKey}{
 signal?.throwIfAborted();validatePayload(payload,signal);const clear=Buffer.from(JSON.stringify(payload));if(clear.length>limits.clear)fail('BACKUP_LIMIT');const key= randomBytes(32),iv=randomBytes(12),keyId=randomUUID(),header=Buffer.from(JSON.stringify({formatVersion:1,algorithm:'AES-256-GCM',keyId,iv:iv.toString('base64url'),ciphertextBytes:clear.length})),length=Buffer.alloc(4);length.writeUInt32BE(header.length);const aad=Buffer.concat([magic,length,header]),cipher=createCipheriv('aes-256-gcm',key,iv,{authTagLength:16});
 try{cipher.setAAD(aad);const encrypted=Buffer.concat([cipher.update(clear),cipher.final()]),bytes=Buffer.concat([aad,encrypted,cipher.getAuthTag()]);if(bytes.length>limits.cipher)fail('BACKUP_LIMIT');return{bytes,key:{formatVersion:1,keyId,containerSHA256:digest(bytes),keyBase64:key.toString('base64')}};}finally{key.fill(0);clear.fill(0);}
}
export function openContainer(bytes:Buffer,record:WrappingKey,signal?:AbortSignal):BackupPayload{
 signal?.throwIfAborted();if(bytes.length>limits.cipher)fail('BACKUP_LIMIT');if(bytes.length<magic.length+4+16||!bytes.subarray(0,magic.length).equals(magic))fail();const keyRecord=object(record,['formatVersion','keyId','containerSHA256','keyBase64']);if(keyRecord['formatVersion']!==1||keyRecord['containerSHA256']!==digest(bytes)||typeof keyRecord['keyBase64']!=='string')fail();const n=bytes.readUInt32BE(magic.length);if(!n||n>limits.header||magic.length+4+n+16>bytes.length)fail();const end=magic.length+4+n,header=object(strictDocument(bytes.subarray(magic.length+4,end),signal),['formatVersion','algorithm','keyId','iv','ciphertextBytes']);
 if(header['formatVersion']!==1||header['algorithm']!=='AES-256-GCM'||header['keyId']!==keyRecord['keyId']||!uuid.test(text(header['keyId']))||typeof header['iv']!=='string'||integer(header['ciphertextBytes'])!==bytes.length-end-16||integer(header['ciphertextBytes'])>limits.clear)fail();const key=Buffer.from(keyRecord['keyBase64'] as string,'base64'),iv=Buffer.from(header['iv'] as string,'base64url');if(key.length!==32||key.toString('base64')!==keyRecord['keyBase64']||iv.length!==12||iv.toString('base64url')!==header['iv']){key.fill(0);fail();}let clear:Buffer|undefined;
 try{const decipher=createDecipheriv('aes-256-gcm',key,iv,{authTagLength:16});decipher.setAAD(bytes.subarray(0,end));decipher.setAuthTag(bytes.subarray(-16));clear=Buffer.concat([decipher.update(bytes.subarray(end,-16)),decipher.final()]);return validatePayload(strictDocument(clear,signal),signal);}catch(e){if(signal?.aborted)signal.throwIfAborted();void e;return fail();}finally{key.fill(0);clear?.fill(0);}
}
