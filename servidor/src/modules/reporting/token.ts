import {createCipheriv,createDecipheriv,createHmac,randomBytes} from 'node:crypto';
import {AppError} from '../../shared/errors.js';
// AEAD hides tenant/subject/filters as well as authenticating them. Existing cursor
// key only, with purpose separation; no new persistent key or bearer privilege.
export class ReportTokens{
 private readonly key:Buffer;
 constructor(key:Buffer){this.key=createHmac('sha256',key).update('CAUDELYX:REPORTING:AEAD:v1').digest();}
 seal(value:unknown,purpose:'snapshot'|'cursor'){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(purpose));const bytes=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64url');}
 open<T>(token:unknown,purpose:'snapshot'|'cursor'):T{try{if(typeof token!=='string'||token.length>8192||!/^[A-Za-z0-9_-]+$/.test(token))throw Error();const b=Buffer.from(token,'base64url');if(b.length<29)throw Error();const cipher=createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12));cipher.setAAD(Buffer.from(purpose));cipher.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([cipher.update(b.subarray(28)),cipher.final()]).toString('utf8')) as T;}catch{throw new AppError(422,'INPUT_INVALID');}}
}
