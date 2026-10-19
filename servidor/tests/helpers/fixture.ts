import { randomBytes, randomUUID } from 'node:crypto';
import { Database } from '../../src/shared/database.js';
import { Sessions } from '../../src/modules/sessions/service.js';
import { SyntheticMessaging } from '../../src/modules/messaging/service.js';
import { IdentityService } from '../../src/modules/identity/service.js';
import { PasswordHasher } from '../../src/modules/identity/password.js';
import { FactorLifecycle } from '../../src/modules/factors/service.js';
import { TotpService } from '../../src/modules/totp/service.js';
import { generate } from 'otplib';
import { RestoreController } from '../../src/shared/restore.js';
import { resolve } from 'node:path';
import { startReplicaSet } from './replica-set.js';

export async function fixture(options: { controlledRestore?: boolean } = {}) {
  const replica = await startReplicaSet();
  const database = new Database(replica.uri, `caudelyx_${randomUUID().replaceAll('-', '')}`);
  await database.connect();
  const clock = { value: Math.floor(Date.now() / 30000) * 30000 + 1000, open: true };
  const now = () => clock.value;
  const sessions = new Sessions(database, now), mailKey = randomBytes(32), totpKey = randomBytes(32);
  const restore=options.controlledRestore?new RestoreController(database,resolve('.runtime',`gate-${database.db.databaseName}.json`),randomBytes(32)):null;
  await restore?.initialize();
  const messages = new SyntheticMessaging(database, mailKey, now);
  const identity = new IdentityService(database, sessions, messages, new PasswordHasher(), () => clock.open&&(!restore||restore.isOpen()), now);
  await identity.initialize();
  const lifecycle = new FactorLifecycle(identity), totp = new TotpService(lifecycle, totpKey);
  const password = 'synthetic long password 1357924680', email = `${randomUUID()}@example.test`;
  const anonymous = await sessions.issue('TENANT', 'P', null);
  await identity.register('TENANT', 'fixture', { email, displayName: 'Persona sintética', privacyPolicyVersion: 'synthetic-v1' });
  await identity.dispatchMail();
  const mail = [...messages.inbox.values()][0]; if (!mail) throw new Error('Fixture mail missing');
  const initial = await identity.confirmEmail(anonymous.context, { purpose: 'ACTIVATION', token: mail.token, newPassword: password });
  return { database, uri: replica.uri, clock, now, sessions, messages, identity, lifecycle, totp, password, email, initial: initial.issued,
    mailKey, totpKey, restore, close: async () => { await database.close(); await replica.stop(); } };
}

export async function totpActor(f: Awaited<ReturnType<typeof fixture>>) {
  const enrollment = await f.totp.enroll(f.initial.context, 'Factor sintético');
  const secret = new URL(enrollment.provisioningUri).searchParams.get('secret');
  if (!secret) throw new Error('No TOTP fixture secret');
  const code = await generate({ secret, epoch: Math.floor(f.now()/1000) });
  const result = await f.totp.confirm(f.initial.context, enrollment.enrollmentId, code);
  if (!result.issued) throw new Error('Real MFA did not produce S');
  return { issued: result.issued, secret, factorId: enrollment.enrollmentId };
}
export async function stepUp(f: Awaited<ReturnType<typeof fixture>>, context: import('../../src/modules/identity/models.js').Context,
  secret: string, purpose: string, resourceId?: string,command?:Record<string,unknown>) {
  await f.identity.reauthenticate(context,{password:f.password,purpose,...(resourceId?{resourceId}:{}),...(command?{command}:{})});
  f.clock.value += 30000;
  const code=await generate({secret,epoch:Math.floor(f.now()/1000)});
  return (await f.totp.authenticate(context,code,purpose,resourceId??null)).issued;
}

export async function additionalActor(f:Awaited<ReturnType<typeof fixture>>,email=`${randomUUID()}@example.test`){
  const anonymous=await f.sessions.issue('TENANT','P',null);
  await f.identity.register('TENANT',randomUUID(),{email,displayName:'Synthetic invitee',privacyPolicyVersion:'synthetic-v1'});
  await f.identity.dispatchMail();const subject=await f.identity.identities.findOne({email});if(!subject)throw Error('Synthetic subject not created');
  const mail=[...f.messages.inbox.values()].find(m=>m.subjectId===subject._id&&m.purpose==='ACTIVATION');if(!mail)throw Error('Synthetic activation missing');
  const initial=await f.identity.confirmEmail(anonymous.context,{purpose:'ACTIVATION',token:mail.token,newPassword:f.password});
  return{...await totpActor({...f,initial:initial.issued,email}),email};
}
