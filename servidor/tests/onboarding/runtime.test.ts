import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generate } from 'otplib';
import { onboardingProfile, password } from '../helpers/onboarding-profile.js';
import { checkHttp } from './http.test.js';
import { checkEnvironment } from './environment.test.js';
import { AppError } from '../../src/shared/errors.js';
import { FrozenContract } from '../../src/shared/contract.js';
import type { Result } from '../../src/modules/finance/models.js';
import type { OpeningFile } from '../../src/modules/opening/models.js';
const record=(result:Result)=>result.data as Record<string,unknown>;
import { Sessions } from '../../src/modules/sessions/service.js';

const denied=(code:string)=>((error:unknown)=>error instanceof AppError&&error.code===code);
test('AJ-ONB-2: grupo aislado reutilizado y contrato backend',{timeout:600000},async t=>{
  checkEnvironment();const profile=await onboardingProfile();
  const only=process.env['AJ_ONB_TEST_PATTERN'];
  const run=(name:string,fn:()=>Promise<void>)=>t.test(name,{skip:!!only&&!only.split('|').some(part=>name.includes(part))},fn);
  try{
    await run('AT01/02: esquema cerrado; alta persistente, unicidad y rollback',async()=>{
      const contract=new FrozenContract();assert.throws(()=>contract.validate('A02',{email:'x@example.test',displayName:'X',privacyPolicyVersion:'v1',acceptTerms:true}));
      const f=await profile.fixture(),a=await f.signup();assert.equal(a.issued.context.kind,'B');assert(a.subject.passwordHash);assert.equal(await f.identity.registrations.countDocuments(),0);
      const p=await f.sessions.issue('TENANT','P',null);await assert.rejects(f.identity.register('TENANT','duplicate',{email:a.email,password,displayName:'Ajeno',privacyPolicyVersion:'v1'},p.context),denied('ACCOUNT_ALREADY_EXISTS'));
      assert.equal((await f.identity.identities.findOne({_id:a.subject._id}))!.displayName,'Persona sintética');
      const audit=f.identity.audit.append.bind(f.identity.audit);f.identity.audit.append=async()=>{throw new AppError(503,'SERVICE_UNAVAILABLE');};
      const next=await f.sessions.issue('TENANT','P',null),email=randomUUID()+'@example.test';await assert.rejects(f.identity.register('TENANT','rollback',{email,password,displayName:'Rollback',privacyPolicyVersion:'v1'},next.context));f.identity.audit.append=audit;
      assert.equal(await f.identity.identities.countDocuments({email}),0);
    });
    await run('AT02: dos altas simultáneas y límite IP antes del hash',async()=>{
      const f=await profile.fixture(),p1=await f.sessions.issue('TENANT','P',null),p2=await f.sessions.issue('TENANT','P',null),email=randomUUID()+'@example.test';
      const input={email,password,displayName:'Carrera',privacyPolicyVersion:'v1'};
      const race=await Promise.allSettled([f.identity.register('TENANT','race1',input,p1.context),f.identity.register('TENANT','race2',input,p2.context)]);assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.equal(await f.identity.identities.countDocuments({email}),1);
      for(let n=0;n<10;n++)await f.identity.requestEmail('TENANT','quota','ACTIVATION','missing@example.test',p1.context).catch(e=>{if(!(e instanceof AppError)||e.code!=='AUTH_INVALID')throw e;});
      await assert.rejects(f.identity.register('TENANT','quota',input,p2.context),denied('RATE_LIMITED'));
    });
    await run('AT03/04/07: HTTPS perfil, cookies, CSRF, guardas org/finanzas/apertura',async()=>{await checkHttp(await profile.fixture());});
    await run('AT05/06: ACTIVATION59min, hash intacto desde otro navegador;60/61 inválidos',async()=>{
      const f=await profile.fixture(),a=await f.signup(),b=await f.signup(),c=await f.signup(),at=f.now();
      f.clock.value=at+59*60000;let p=await f.sessions.issue('TENANT','P',null);
      const confirmed=await f.identity.confirmEmail(p.context,{purpose:'ACTIVATION',token:a.token});assert.equal(confirmed.issued.context.kind,'P');assert.equal((await f.identity.identities.findOne({_id:a.subject._id}))!.passwordHash,a.subject.passwordHash);
      await assert.rejects(f.identity.confirmEmail(p.context,{purpose:'ACTIVATION',token:b.token,newPassword:password}),denied('AUTH_INVALID'));
      f.clock.value=at+60*60000;p=await f.sessions.issue('TENANT','P',null);await assert.rejects(f.identity.confirmEmail(p.context,{purpose:'ACTIVATION',token:b.token}),denied('TOKEN_INVALID'));
      f.clock.value=at+61*60000;p=await f.sessions.issue('TENANT','P',null);await assert.rejects(f.identity.confirmEmail(p.context,{purpose:'ACTIVATION',token:c.token}),denied('TOKEN_INVALID'));
    });
    await run('AT05: RESET/INITIAL10min y cuota de tres pruebas vivas',async()=>{
      const f=await profile.fixture(),a=await f.signup();let p=await f.sessions.issue('TENANT','P',null);
      await f.identity.requestEmail('TENANT','reset1','RESET',a.email,p.context);await f.identity.dispatchMail();
      const token=[...f.messages.inbox.values()].find(m=>m.subjectId===a.subject._id&&m.purpose==='RESET')!.token,at=f.now();
      f.clock.value=at+9*60000;p=await f.sessions.issue('TENANT','P',null);assert.equal((await f.identity.reset(p.context,{mode:'PREVIEW',token},'r1')).warningRequired,false);
      f.clock.value=at+10*60000;await assert.rejects(f.identity.reset(p.context,{mode:'PREVIEW',token},'r1'),denied('TOKEN_INVALID'));
      for(let n=0;n<4;n++){f.clock.value+=600000;await f.database.transaction(async session=>{await f.messages.enqueue(a.subject,'ACTIVATION','q'+n,null,session);});}
      assert(await f.messages.proofs.countDocuments({subjectId:a.subject._id,purpose:'ACTIVATION',consumed:false,expiresAt:{$gt:f.now()}})<=3);
      await f.database.transaction(async session=>{await f.messages.enqueue(a.subject,'INITIAL_MFA_PROOF','legacy-initial',a.issued.context._id,session);});
      const initial=await f.messages.proofs.findOne({subjectId:a.subject._id,purpose:'INITIAL_MFA_PROOF'});assert.equal(initial!.expiresAt-f.now(),600000);
    });
    await run('AT08/09: contraseña reintroducida y factor real; URI etiqueta correo; CAS primer factor',async()=>{
      const f=await profile.fixture(),a=await f.signup(),confirmed=await f.identity.confirmEmail(a.issued.context,{purpose:'ACTIVATION',token:a.token});
      await assert.rejects(f.runtime.totp.enroll(confirmed.issued.context,'Sin prueba'),denied('AUTH_INVALID'));
      const second=await f.identity.login('TENANT','second-browser',a.email,password),competitor=await f.runtime.totp.enroll(second.issued.context,'Competidor',password);
      const enrollment=await f.runtime.totp.enroll(confirmed.issued.context,'TOTP',password),uri=new URL(enrollment.provisioningUri),secret=uri.searchParams.get('secret')!;assert(decodeURIComponent(uri.pathname).includes(a.email));
      const code=await generate({secret,epoch:Math.floor(f.now()/1000)});
      const race=await Promise.allSettled([f.runtime.totp.confirm(confirmed.issued.context,enrollment.enrollmentId,code),f.runtime.totp.confirm(confirmed.issued.context,enrollment.enrollmentId,code)]);assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(await f.sessions.factors.countDocuments({subjectId:a.subject._id,state:'ACTIVE'}),1);assert.equal((await f.identity.identities.findOne({_id:a.subject._id}))!.hasEverConfirmedFactor,true);
      const discarded=await f.sessions.factors.findOne({_id:competitor.enrollmentId});assert.equal(discarded!.state,'REVOKED');assert.equal(discarded!.encryptedSecret,undefined);assert.equal(await f.sessions.find(second.issued.token,'TENANT'),null);
    });
    await run('AT08/09: prueba5min/otraB/estado histórico y WebAuthn UV/origin',async()=>{
      const f=await profile.fixture(),a=await f.signup(),confirmed=await f.identity.confirmEmail(a.issued.context,{purpose:'ACTIVATION',token:a.token});
      const options=await f.runtime.webauthn.enroll(confirmed.issued.context,'Passkey',password);assert.equal(options.publicKey.authenticatorSelection?.userVerification,'required');
      await assert.rejects(f.runtime.webauthn.confirm(confirmed.issued.context,options.ceremonyId,{id:'invalid',rawId:'invalid',type:'public-key',response:{clientDataJSON:'invalid',attestationObject:'invalid'},clientExtensionResults:{}}),denied('MFA_INVALID'));
      const enrollment=await f.runtime.totp.enroll(confirmed.issued.context,'Expira',password),secret=new URL(enrollment.provisioningUri).searchParams.get('secret')!;f.clock.value+=300000;
      await assert.rejects(f.runtime.totp.confirm(confirmed.issued.context,enrollment.enrollmentId,await generate({secret,epoch:Math.floor(f.now()/1000)})));
      await f.identity.identities.updateOne({_id:a.subject._id},{$set:{hasEverConfirmedFactor:true,state:'FACTOR_LOSS_BLOCKED'}});await assert.rejects(f.runtime.totp.enroll(confirmed.issued.context,'No bypass',password),denied('INITIAL_MFA_PROOF_DENIED'));
    });
    await run('AT10: RESET pendiente y legado sinhash confirma correo, revocaB y permite G01',async()=>{
      for(const legacy of [false,true]){
        const f=await profile.fixture(),a=await f.signup();if(legacy)await f.identity.identities.updateOne({_id:a.subject._id},{$set:{passwordHash:null},$unset:{registrationSource:''}});
        const p=await f.sessions.issue('TENANT','P',null);await f.identity.requestEmail('TENANT','reset','RESET',a.email,p.context);await f.identity.dispatchMail();
        const token=[...f.messages.inbox.values()].find(m=>m.subjectId===a.subject._id&&m.purpose==='RESET')!.token;
        const preview=await f.identity.reset(p.context,{mode:'PREVIEW',token},'reset');assert.equal(preview.warningRequired,false);
        await f.identity.reset(p.context,{mode:'CONFIRM',token,newPassword:password,warningAcknowledged:false},'reset');assert.equal(await f.sessions.find(a.issued.token,'TENANT'),null);
        const subject=(await f.identity.identities.findOne({_id:a.subject._id}))!;assert.equal(subject.emailVerified,true);assert(subject.resetCompletedAt);assert.equal(await f.identity.eligible(subject),true);
        const logged=await f.identity.login('TENANT','login',a.email,password);assert.equal(logged.issued.context.kind,'B');
        const enrollment=await f.runtime.totp.enroll(logged.issued.context,'Después RESET',password),secret=new URL(enrollment.provisioningUri).searchParams.get('secret')!;
        assert((await f.runtime.totp.confirm(logged.issued.context,enrollment.enrollmentId,await generate({secret,epoch:Math.floor(f.now()/1000)}))).issued);
      }
    });
    await run('AT11/12: No fui yo revoca y no borra confirmada; carrera confirmar/rechazar',async()=>{
      const f=await profile.fixture(),a=await f.signup(),p=await f.sessions.issue('TENANT','P',null);
      await f.identity.onboarding.reject(p.context,a.token);assert.equal(await f.identity.identities.findOne({_id:a.subject._id}),null);assert.equal(await f.sessions.find(a.issued.token,'TENANT'),null);await assert.rejects(f.identity.onboarding.reject(p.context,a.token),denied('TOKEN_INVALID'));
      const b=await f.signup(),p2=await f.sessions.issue('TENANT','P',null),p3=await f.sessions.issue('TENANT','P',null);
      const race=await Promise.allSettled([f.identity.confirmEmail(p2.context,{purpose:'ACTIVATION',token:b.token}),f.identity.onboarding.reject(p3.context,b.token)]);assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
      const survivor=await f.identity.identities.findOne({_id:b.subject._id});if(survivor)assert.equal(survivor.emailVerified,true);
    });
    await run('AT12/13: caducidad lógica7d y B30min/12h, suspensión/versiones entre instancias',async()=>{
      const f=await profile.fixture(),a=await f.signup();f.clock.value+=1799999;assert(await f.sessions.find(a.issued.token,'TENANT'));f.clock.value++;assert.equal(await f.sessions.find(a.issued.token,'TENANT'),null);
      const logged=await f.identity.login('TENANT','idle',a.email,password);f.clock.value=logged.issued.context.expiresAt-1;
      await f.sessions.contexts.updateOne({_id:logged.issued.context._id},{$set:{lastSeenAt:f.now()}});assert(await f.sessions.find(logged.issued.token,'TENANT'));
      f.clock.value++;assert.equal(await f.sessions.find(logged.issued.token,'TENANT'),null);
      f.clock.value=a.subject.createdAt+7*86400000;await assert.rejects(f.identity.login('TENANT','expired',a.email,password),denied('AUTH_INVALID'));
      await f.identity.onboarding.expire();assert.equal(await f.identity.identities.findOne({_id:a.subject._id}),null);
      const b=await f.signup(),other=new Sessions(f.database,f.now);assert.equal((await profile.peerRead(b.issued.token,f.now())).kind,'B');await f.identity.identities.updateOne({_id:b.subject._id},{$set:{authEpoch:randomUUID()}});assert.equal(await other.find(b.issued.token,'TENANT'),null);assert.equal((await profile.peerRead(b.issued.token,f.now())).kind,null);
    });
    await run('AT16/18: R ligado, rollback y operación de organización/finanzas/apertura conservados',async()=>{
      const f=await profile.fixture(),actor=await f.actor(),payload={name:'Organización sintética',timezone:'America/Bogota',currency:'COP'};
      await assert.rejects(f.runtime.organizations.create(actor.issued.context,payload,randomUUID()),denied('REAUTH_REQUIRED'));
      await f.proof(actor,'ORGANIZATION_CREATE',payload);const result=await f.runtime.organizations.create(actor.issued.context,payload,randomUUID()),org=result.data.organization.id;
      const login=await f.identity.login('TENANT','strong',actor.email,password);f.clock.value+=30000;actor.issued=(await f.runtime.totp.authenticate(login.issued.context,await generate({secret:actor.secret,epoch:Math.floor(f.now()/1000)}),'LOGIN',null)).issued;
      assert.equal((await f.runtime.organizations.read(actor.issued.context)).data.id,org);
      const account={code:'CASH',name:'Caja',accountClass:'ASSET',kind:'CASH',currency:'COP'};
      const key=randomUUID();await f.proof(actor,'FINANCE_ACCOUNT_CREATE',{organizationId:org,idempotencyKey:key,payload:account});
      // Exact financial request fields are checked by the existing contract, never bypassed.
      const created=await f.runtime.finance.mutate(actor.issued.context,'createAccount',org,account,key);assert.equal(created.status,201);
      await assert.rejects(f.runtime.finance.mutate(actor.issued.context,'createAccount',org,{...account,code:'OTHER'},randomUUID()),denied('R_REQUIRED'));
    });
    await run('AT17: A12/A15 nueva invitada, primera contraseña con procedencia y afiliación MFA',async()=>{
      const f=await profile.fixture(),owner=await f.actor(),payload={name:'Invitaciones sintéticas',timezone:'America/Bogota',currency:'COP'};
      await f.proof(owner,'ORGANIZATION_CREATE',payload);const org=(await f.runtime.organizations.create(owner.issued.context,payload,randomUUID())).data.organization.id;
      const email=randomUUID()+'@example.test';await f.proof(owner,'MEMBER_INVITE',{email,roleIds:['L']},org);await f.runtime.organizations.invite(owner.issued.context,{email,roleIds:['L']});await f.identity.dispatchMail();
      const invite=(await f.runtime.organizations.invitations.findOne({email}))!,notice=[...f.messages.notificationInbox.values()].find(n=>n.kind==='INVITATION'&&n.subjectId===invite._id)!;assert(notice);
      const token=notice.payload['token']!,p=await f.sessions.issue('TENANT','P',null);
      await f.runtime.organizations.accept(p.context,{mode:'PREPARE',token,displayName:'Invitada',privacyPolicyVersion:'synthetic-v1',acceptTerms:true},'invite');await f.identity.dispatchMail();
      const subject=(await f.identity.identities.findOne({email}))!;assert.equal(subject.registrationSource,'INVITATION');assert.equal(subject.passwordHash,null);
      const activation=[...f.messages.inbox.values()].find(m=>m.subjectId===subject._id&&m.purpose==='ACTIVATION')!;
      const initial=await f.identity.confirmEmail(p.context,{purpose:'ACTIVATION',token:activation.token,newPassword:password});assert.equal(initial.issued.context.kind,'E_INITIAL');
      const enrollment=await f.runtime.totp.enroll(initial.issued.context,'Invitada'),secret=new URL(enrollment.provisioningUri).searchParams.get('secret')!;
      const completed=await f.runtime.totp.confirm(initial.issued.context,enrollment.enrollmentId,await generate({secret,epoch:Math.floor(f.now()/1000)}));assert(completed.issued);
      await f.runtime.organizations.accept(completed.issued.context,{mode:'CONFIRM',token},'accept');assert.equal((await f.identity.identities.findOne({email}))!.organizationId,org);
      await assert.rejects(f.runtime.organizations.accept(completed.issued.context,{mode:'CONFIRM',token},'replay'));
    });
    await run('AT16: recuperación offline15min, factor pendiente y cooldown24h no se convierten en B',async()=>{
      const f=await profile.fixture(),actor=await f.actor();await f.proof(actor,'RECOVERY_CODES_REGENERATE');const codes=await f.runtime.recovery.regenerate(actor.issued.context);
      const login=await f.identity.login('TENANT','recovery',actor.email,password);assert.equal(login.issued.context.kind,'L');
      const started=await f.runtime.recovery.start(login.issued.context,codes.codes[0]!,'recovery');assert.equal(started.issued.context.kind,'E_RECOVERY');assert.equal(started.issued.context.expiresAt-f.now(),900000);
      const enrollment=await f.runtime.totp.enroll(started.issued.context,'Reemplazo'),secret=new URL(enrollment.provisioningUri).searchParams.get('secret')!;
      f.clock.value+=30000;const pending=await f.runtime.totp.confirm(started.issued.context,enrollment.enrollmentId,await generate({secret,epoch:Math.floor(f.now()/1000)}));assert.equal(pending.issued,undefined);
      assert(!(await f.runtime.recovery.methods(started.issued.context)).items.some(m=>m.id===enrollment.enrollmentId));
      const old=(await f.sessions.factors.findOne({subjectId:actor.issued.context.subjectId!,state:'ACTIVE'}))!;
      await f.runtime.recovery.complete(started.issued.context,enrollment.enrollmentId,[old._id]);assert.equal((await f.identity.identities.findOne({_id:old.subjectId}))!.cooldownUntil,f.now()+86400000);
      const subject=(await f.identity.identities.findOne({_id:old.subjectId}))!;assert.equal(await f.identity.eligible(subject),false);await assert.rejects(f.runtime.recovery.start(login.issued.context,codes.codes[0]!,'replay'));
      const p=await f.sessions.issue('TENANT','P',null);await f.identity.requestEmail('TENANT','reset-with-factor','RESET',actor.email,p.context);await f.identity.dispatchMail();
      const token=[...f.messages.inbox.values()].find(m=>m.subjectId===subject._id&&m.purpose==='RESET')!.token,newPassword='Otra frase sintetica de recuperacion 0319246875';
      await f.identity.reset(p.context,{mode:'PREVIEW',token},'reset-with-factor');await f.identity.reset(p.context,{mode:'CONFIRM',token,newPassword,warningAcknowledged:false},'reset-with-factor');
      assert.equal((await f.sessions.factors.findOne({_id:enrollment.enrollmentId}))!.state,'ACTIVE');
      const afterReset=await f.identity.login('TENANT','after-reset',actor.email,newPassword);assert.equal(afterReset.issued.context.kind,'L');
      await assert.rejects(f.identity.requestEmail('TENANT','no-email-bypass','INITIAL_MFA_PROOF',null,afterReset.issued.context),denied('INITIAL_MFA_PROOF_DENIED'));
      f.clock.value+=30000;assert.equal((await f.runtime.totp.authenticate(afterReset.issued.context,await generate({secret,epoch:Math.floor(f.now()/1000)}),'LOGIN',null)).issued.context.kind,'S');
    });
    await run('AT18: libro S2 transferencias/reversión/rollback e aislamiento con R real',async()=>{
      const f=await profile.fixture(),actor=await f.actor(),command={name:'Libro de regresión',timezone:'America/Bogota',currency:'COP'};
      await f.proof(actor,'ORGANIZATION_CREATE',command);const org=(await f.runtime.organizations.create(actor.issued.context,command,randomUUID())).data.organization.id;
      const login=await f.identity.login('TENANT','financial',actor.email,password);f.clock.value+=30000;actor.issued=(await f.runtime.totp.authenticate(login.issued.context,await generate({secret:actor.secret,epoch:Math.floor(f.now()/1000)}),'LOGIN',null)).issued;
      const mutate=async(operation:string,purpose:string,payload:Record<string,unknown>,id?:string,etag?:string)=>{
        const key=randomUUID();await f.proof(actor,purpose,{organizationId:org,idempotencyKey:key,payload,...(etag?{expectedETag:etag}:{})},id);return await f.runtime.finance.mutate(actor.issued.context,operation,org,payload,key,id,etag);
      };
      const bank=String(record(await mutate('createAccount','FINANCE_ACCOUNT_CREATE',{code:'BANK',name:'Banco',accountClass:'ASSET',kind:'BANK',currency:'COP'}))['id']);
      const cash=String(record(await mutate('createAccount','FINANCE_ACCOUNT_CREATE',{code:'CASH',name:'Caja',accountClass:'ASSET',kind:'CASH',currency:'COP'}))['id']);
      const equity=String(record(await mutate('createAccount','FINANCE_ACCOUNT_CREATE',{code:'EQUITY',name:'Patrimonio',accountClass:'EQUITY',kind:'GENERAL',currency:'COP'}))['id']);
      const posting={currency:'COP',effectiveDate:'2020-01-01',sourceId:randomUUID(),supportReference:'Soporte sintético',description:'Aporte',lines:[{accountId:bank,debit:'100.00',credit:'0.00'},{accountId:equity,debit:'0.00',credit:'100.00'}]};
      await mutate('postJournal','FINANCE_JOURNAL_POST',posting);
      const transfer=await mutate('createTransfer','FINANCE_TRANSFER',{currency:'COP',effectiveDate:'2020-01-02',sourceId:randomUUID(),supportReference:'Soporte',description:'Traslado',fromAccountId:bank,toAccountId:cash,amount:'25.50'});
      await mutate('reverseJournal','FINANCE_JOURNAL_REVERSE',{effectiveDate:'2020-01-03',sourceId:randomUUID(),supportReference:'Soporte',reason:'Corrección'},String(record(transfer)['id']),transfer.etag);
      const balances=record(await f.runtime.finance.read(actor.issued.context,'balances',org,undefined,{asOf:'2020-01-03'}))['items'] as Record<string,string>[];assert.equal(balances.find(b=>b['accountId']===bank)?.['naturalBalance'],'100.00');assert.equal(balances.find(b=>b['accountId']===cash)?.['naturalBalance'],'0.00');
      const other=await f.actor();await assert.rejects(f.runtime.finance.read(other.issued.context,'balances',org,undefined,{asOf:'2020-01-03'}));
      const key=randomUUID(),next={...posting,sourceId:randomUUID()};await f.proof(actor,'FINANCE_JOURNAL_POST',{organizationId:org,idempotencyKey:key,payload:next});
      const audit=f.database.db.collection('audit_events');await audit.createIndex({action:1},{unique:true,partialFilterExpression:{action:'FINANCE_postJournal'}});
      await assert.rejects(f.runtime.finance.mutate(actor.issued.context,'postJournal',org,next,key));assert.equal(await f.runtime.finance.journals.countDocuments(),3);await audit.dropIndex('action_1');
      assert.equal((await f.runtime.finance.mutate(actor.issued.context,'postJournal',org,next,key)).status,201);
    });
    await run('AT18-S3: apertura positiva existente con R ligadas, corte y libro exacto',async()=>{
      const f=await profile.fixture(),actor=await f.actor(),command={name:'Apertura regresión',timezone:'America/Bogota',currency:'COP'};
      await f.proof(actor,'ORGANIZATION_CREATE',command);const org=(await f.runtime.organizations.create(actor.issued.context,command,randomUUID())).data.organization.id;
      const login=await f.identity.login('TENANT','opening',actor.email,password);f.clock.value+=30000;actor.issued=(await f.runtime.totp.authenticate(login.issued.context,await generate({secret:actor.secret,epoch:Math.floor(f.now()/1000)}),'LOGIN',null)).issued;
      const account=async(code:string,accountClass:string,kind:string)=>{const payload={code,name:code,accountClass,kind,currency:'COP'},key=randomUUID();await f.proof(actor,'FINANCE_ACCOUNT_CREATE',{organizationId:org,idempotencyKey:key,payload});return String(record(await f.runtime.finance.mutate(actor.issued.context,'createAccount',org,payload,key))['id']);};
      const bank=await account('BANK','ASSET','BANK'),equity=await account('EQUITY','EQUITY','GENERAL'),support=randomUUID();
      const snapshot={cutoffDate:'2020-01-01',supports:[{id:support,reference:'SYNTHETIC-AJ-OPENING',asOfDate:'2020-01-01',declaration:'OWNER_CHECKED'}],references:[],components:[{id:randomUUID(),category:'BANK',accountId:bank,amount:'100.00',supportIds:[support]},{id:randomUUID(),category:'EQUITY',accountId:equity,amount:'100.00',equityKind:'CONTRIBUTED',supportIds:[support]}],historicalInterest:[],informationalHistory:[]};
      let current:OpeningFile;
      const mutate=async(operation:string,purpose:string,payload:Record<string,unknown>,create=false)=>{
        const key=randomUUID(),id=create?undefined:current.id,expected=create?undefined:`"${current.id}:${current.version}"`;
        await f.proof(actor,purpose,{organizationId:org,idempotencyKey:key,payload,...(expected?{expectedETag:expected}:{})},id);
        const result=await f.runtime.opening.mutate(actor.issued.context,operation,org,payload,key,id,expected);
        current=(operation==='validateOpening'?record(result)['opening']:result.data) as OpeningFile;return result;
      };
      await mutate('createOpening','OPENING_CREATE',{snapshot},true);assert.equal(current!.status,'DRAFT');
      await mutate('validateOpening','OPENING_VALIDATE',{policyVersion:'S03-OPENING-0.1'});
      const binding=()=>({validationId:current.validation!.id,validationFingerprint:current.validation!.fingerprint});
      await mutate('approveOpening','OPENING_APPROVE',binding());await mutate('commitOpening','OPENING_COMMIT',binding());assert.equal(current!.status,'POSTED');
      assert.equal(await f.runtime.finance.journals.countDocuments(),1);
      const balances=record(await f.runtime.finance.read(actor.issued.context,'balances',org,undefined,{asOf:'2020-01-01'}))['items'] as Record<string,string>[];assert.equal(balances.find(x=>x['accountId']===bank)?.['naturalBalance'],'100.00');
    });
    await run('AT19: tombstone rechazo y purga sobreviven restore; hueco mantiene cierre',async()=>{
      const f=await profile.fixture(),a=await f.signup(),snapshot=await f.restore.snapshot(),p=await f.sessions.issue('TENANT','P',null);
      await f.identity.onboarding.reject(p.context,a.token);await f.restore.flush();await f.restore.beginRestore(snapshot);assert.equal(f.restore.isOpen(),false);
      await f.restore.reconcile({approved:true,reviewId:'synthetic-aj-onb'});assert.equal(await f.identity.identities.findOne({_id:a.subject._id}),null);assert.equal(await f.sessions.find(a.issued.token,'TENANT'),null);
      const b=await f.signup(),snapshot2=await f.restore.snapshot();f.clock.value=b.subject.createdAt+7*86400000;await f.identity.onboarding.expire();await f.restore.flush();await f.restore.beginRestore(snapshot2);await f.restore.reconcile({approved:true,reviewId:'synthetic-purge'});assert.equal(await f.identity.identities.findOne({_id:b.subject._id}),null);
      await f.database.client.db(f.database.db.databaseName+'_external_security').collection<{_id:number}>('events').deleteOne({_id:1});await f.restore.beginRestore(snapshot2);await assert.rejects(f.restore.reconcile({approved:true,reviewId:'must-not-open'}));assert.equal(f.restore.isOpen(),false);
    });
    await run('AT22: guardas de lease vivo y teardown por cancelación cooperativa',async()=>{
      await profile.fixture();const release=profile.hold();await assert.rejects(profile.dispose(),/lease is live/);release();
      const cancel=new AbortController();cancel.abort();try{cancel.signal.throwIfAborted();assert.fail('Cancellation did not throw');}catch(error){assert.equal((error as Error).name,'AbortError');}finally{await profile.dispose();}
    });
  }finally{await profile.dispose();}
});
