import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {BSON} from 'mongodb';
import {generate} from 'otplib';
import {lendingProfile,assertOwnUri} from '../helpers/lending-profile.js';
import {setup,view,type Actor} from './fixture.js';
import {AppError} from '../../src/shared/errors.js';
import {lendingCollections,head,lendingEvidenceMatches} from '../../src/modules/lending/integrity.js';
import {RestoreController} from '../../src/shared/restore.js';
import {hash,lendingContract} from '../../src/modules/lending/contract.js';
import type {OpeningFile,Snapshot} from '../../src/modules/opening/models.js';
import {purposes as openingPurposes} from '../../src/modules/opening/contract.js';
const err=(code:string)=>(e:unknown)=>e instanceof AppError&&e.code===code;
type F=Awaited<ReturnType<typeof setup>>;
const binding=(q:{id:string;fingerprint:string})=>({quoteId:q.id,quoteFingerprint:q.fingerprint});
const financial=async(f:F)=>{
  const h=createHash('sha256');for(const name of ['financial_accounts','financial_books','financial_journals','financial_idempotency','financial_evidence_head','opening_files','opening_validations','opening_references','opening_idempotency']){
    h.update(name);h.update(BSON.EJSON.stringify(await f.database.db.collection(name).find().sort({_id:1}).toArray(),{relaxed:false}));
  }return h.digest('hex');
};
const lendingState=async(f:F)=>{
  const data=[];for(const name of [...lendingCollections,'security_sequence','audit_events','outbox','security_evidence_outbox'])data.push([name,await f.database.db.collection(name).find().sort({_id:1}).toArray()]);return BSON.EJSON.stringify(data,{relaxed:false});
};
async function prepare(f:F,a:Actor,op:string,payload:Record<string,unknown>,key:string,id?:string,etag?:string){
  const {purposes}=await import('../../src/modules/lending/contract.js');
  await f.proof(a,purposes.get(op)!,{organizationId:f.org,idempotencyKey:key,payload,...(etag?{expectedETag:etag}:{})},id);
}
test('S04 Mongo/HTTPS integration with one registered group',{timeout:300000},async t=>{
  const group=await lendingProfile();
  const cancel=async()=>await group.dispose();
  const onSignal=()=>{void cancel().catch(()=>{process.exitCode=1;});};process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);
  try{
    await t.test('AT16: protected URI, active lease and partial setup guards; same group reused',async()=>{
      for(const uri of ['mongodb://localhost:27017/?replicaSet=rs0','mongodb://127.0.0.1:27181/?replicaSet=caudelyx-manual','mongodb://remote.invalid:39001/?replicaSet=caudelyx-manual'])assert.throws(()=>assertOwnUri(uri));
      const release=group.hold();await assert.rejects(group.dispose(),/lease/);release();
      await assert.rejects(group.fixture({failSetup:true}),/Injected own partial setup/);
    });
    await t.test('AT01/13: profiles, catalogue, optional identity, duplicates, tenant isolation and history',async()=>{
      const f=await setup(group),before=await lendingState(f);await f.read('getLendingPolicy');const current=await f.read('getCurrentBorrowerSchema');assert.equal(await lendingState(f),before);assert.equal((current.data as {schemaVersion:number}).schemaVersion,1);
      const b1=await f.borrower('LOCAL_001',{displayName:'Ána sintética',schemaVersion:1,extras:{},document:{type:'CC',number:' 000-abc '}}),b=view(b1);
      assert.equal(b.profile.document?.number,'000-ABC');
      await assert.rejects(f.borrower('LOCAL_001'),err('BORROWER_CODE_CONFLICT'));
      await assert.rejects(f.borrower('LOCAL_002',{displayName:'Otra sintética',schemaVersion:1,extras:{},document:{type:'CC',number:'000-ABC'}}),err('BORROWER_DOCUMENT_CONFLICT'));
      const homonym=view(await f.borrower('LOCAL_003',{displayName:'  ÁNA   sintética  ',schemaVersion:1,extras:{}}));assert.equal(homonym.possibleDuplicate,true);assert.equal(homonym.duplicateCandidates.length,1);
      const foreign=await f.tenant(await f.newActor());
      await f.mutate('createBorrower',{borrowerCode:'LOCAL_001',profile:{displayName:'Otra organización sintética',schemaVersion:1,extras:{},document:{type:'CC',number:'000-ABC'}}},{actor:foreign.actor,org:foreign.org});
      await assert.rejects(f.runtime.lending.read(foreign.actor.issued.context,'getBorrower',foreign.org,b.id),err('RESOURCE_NOT_FOUND'));
      const fields=[{key:'flag',label:'Bandera',type:'BOOLEAN',deprecated:false},{key:'choice',label:'Opción',type:'ENUM',deprecated:false,options:[{code:'X',label:'X sintético'}]}];
      const schema=await f.mutate('publishBorrowerSchema',{fields,changeReason:'Catálogo sintético'},{etag:current.etag!});
      await assert.rejects(f.mutate('replaceBorrower',{profile:b.profile,changeReason:'Esquema obsoleto'},{id:b.id,etag:b1.etag!}),err('SCHEMA_EVOLUTION_CONFLICT'));
      const updated=await f.mutate('replaceBorrower',{profile:{displayName:'Nombre nuevo sintético',schemaVersion:2,extras:{flag:true,choice:'X'}},changeReason:'Cambio sintético'},{id:b.id,etag:b1.etag!});assert.equal(view(updated).profileVersion,2);
      const old=await f.read('getBorrowerVersion',b.id,{},'1');assert.equal((old.data as {profile:{displayName:string}}).profile.displayName,'Ána sintética');
      await assert.rejects(f.mutate('replaceBorrower',{profile:{displayName:'Nombre',schemaVersion:2,extras:{flag:'true'}},changeReason:'Inválido'},{id:b.id,etag:updated.etag!}),err('INPUT_INVALID'));
      await assert.rejects(f.mutate('publishBorrowerSchema',{fields:[{...fields[0],type:'TEXT'},fields[1]],changeReason:'No cambiar significado'},{etag:schema.etag!}),err('SCHEMA_EVOLUTION_CONFLICT'));
      const deprecated=fields.map(v=>v.key==='flag'?{...v,deprecated:true}:v);
      await f.mutate('publishBorrowerSchema',{fields:deprecated,changeReason:'Deprecar conservando historia'},{etag:schema.etag!});
      await assert.rejects(f.mutate('replaceBorrower',{profile:{displayName:'Nombre',schemaVersion:3,extras:{flag:true}},changeReason:'No usar deprecado'},{id:b.id,etag:updated.etag!}),err('INPUT_INVALID'));
      const inactive=await f.mutate('deactivateBorrower',{reason:'Pausa sintética'},{id:b.id,etag:updated.etag!});assert.equal(view(inactive).profileVersion,2);await assert.rejects(f.quote(b.id),err('INPUT_INVALID'));
      await assert.rejects(f.borrower('LOCAL_001',{displayName:'Duplicado inactivo',schemaVersion:3,extras:{}}),err('BORROWER_CODE_CONFLICT'));
      const active=await f.mutate('reactivateBorrower',{reason:'Retorno sintético'},{id:b.id,etag:inactive.etag!});assert.equal(view(active).status,'ACTIVE');
      const page=(await f.read('listBorrowers',undefined,{limit:1})).data as {items:{id:string}[];nextCursor:string};assert.ok(page.nextCursor);
      const next=(await f.read('listBorrowers',undefined,{limit:1,cursor:page.nextCursor})).data as {items:{id:string}[]};assert.notEqual(next.items[0]!.id,page.items[0]!.id);
      await assert.rejects(f.read('listBorrowers',undefined,{limit:2,cursor:page.nextCursor}),err('INVALID_CURSOR'));
      assert.equal(((await f.read('listBorrowers',undefined,{q:'.*'})).data as {items:unknown[]}).items.length,0);
    });
    await t.test('AT09/10/15: quote TTL, R/replay, versions/confirmation/cancel and zero economic effects',async()=>{
      const f=await setup(group),b=view(await f.borrower()),before=await financial(f),qResult=await f.quote(b.id),q=view(qResult),body=binding(q),key=randomUUID();
      const quoteObject=qResult.data as Record<string,unknown>,{fingerprint,...content}=quoteObject;assert.equal(fingerprint,hash(content));
      const draft=await f.mutate('createLoanDraft',body,{key}),l=view(draft);assert.equal(l.status,'DRAFT');
      await assert.rejects(f.mutate('createLoanDraft',body),err('QUOTE_ALREADY_USED'));
      const confirmed=await f.mutate('confirmLoanTerms',{...body,termsVersion:1},{id:l.id,etag:draft.etag!});assert.equal(view(confirmed).status,'TERMS_CONFIRMED');
      f.clock.value=Date.parse(q.expiresAt);
      await assert.rejects(f.mutate('createLoanDraft',body),err('QUOTE_EXPIRED'));
      const replay=await f.mutate('createLoanDraft',body,{key});assert.equal(replay.status,200);assert.equal(view(replay).status,'DRAFT');assert.equal(view(replay).id,l.id);
      assert.equal(view(await f.read('getLoan',l.id)).status,'TERMS_CONFIRMED');
      await assert.rejects(f.mutate('createLoanDraft',{...body,note:'Payload diferente'},{key}),err('IDEMPOTENCY_CONFLICT'));
      assert.equal(view(await f.read('getLoanQuote',q.id)).expiresAt,q.expiresAt);
      const q2=view(await f.quote(b.id,{principal:'1200.00'})),replacement=await f.mutate('replaceLoanTerms',{...binding(q2),changeReason:'Nueva versión'},{id:l.id,etag:confirmed.etag!});
      assert.equal(view(replacement).status,'DRAFT');assert.equal(view(replacement).confirmation,null);assert.equal(view(replacement).termsVersion,2);
      await assert.rejects(f.mutate('confirmLoanTerms',{...body,termsVersion:1},{id:l.id,etag:replacement.etag!}),err('QUOTE_BINDING_MISMATCH'));
      const c2=await f.mutate('confirmLoanTerms',{...binding(q2),termsVersion:2},{id:l.id,etag:replacement.etag!});
      const canceled=await f.mutate('cancelLoan',{reason:'Cierre sintético'},{id:l.id,etag:c2.etag!});assert.equal(view(canceled).status,'CANCELLED');
      await assert.rejects(f.mutate('replaceLoanTerms',{...binding(q2),changeReason:'No reabrir'},{id:l.id,etag:canceled.etag!}),err('STATE_CONFLICT'));
      const versions=(await f.read('listLoanVersions',l.id)).data as {items:{termsVersion:number}[]};assert.deepEqual(versions.items.map(v=>v.termsVersion),[1,2]);
      const first=(await f.read('getLoanVersion',l.id,{},'1')).data as {terms:{principal:string}};assert.equal(first.terms.principal,'1000.00');
      assert.equal(await financial(f),before);assert.equal(await lendingEvidenceMatches(f.database,(await head(f.database))!),true);
    });
    await t.test('AT07/09/14: profile/catalogue/account stale quotes and exact idempotency/CAS races',async()=>{
      const f=await setup(group),bResult=await f.borrower(),b=view(bResult),old=view(await f.quote(b.id));
      await f.mutate('replaceBorrower',{profile:{...b.profile,displayName:'Cambio que invalida'},changeReason:'Perfil cambiado'},{id:b.id,etag:bResult.etag!});
      await assert.rejects(f.mutate('createLoanDraft',binding(old)),err('QUOTE_STALE'));
      const q2=view(await f.quote(b.id)),sc=await f.read('getCurrentBorrowerSchema');await f.mutate('publishBorrowerSchema',{fields:[],changeReason:'Nueva versión vacía'},{etag:sc.etag!});await assert.rejects(f.mutate('createLoanDraft',binding(q2)),err('QUOTE_STALE'));
      const q3=view(await f.quote(b.id)),account=await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,f.account),rename={name:'Caja sintética renombrada'},rk=randomUUID();
      await f.proof(f.a,'FINANCE_ACCOUNT_UPDATE',{organizationId:f.org,idempotencyKey:rk,payload:rename,expectedETag:account.etag!},f.account);await f.runtime.finance.mutate(f.a.issued.context,'renameAccount',f.org,rename,rk,f.account,account.etag);
      await assert.rejects(f.mutate('createLoanDraft',binding(q3)),err('QUOTE_STALE'));
      const peer=await f.login(f.a),fresh=view(await f.quote(b.id)),keys=[randomUUID(),randomUUID()];
      await prepare(f,f.a,'createLoanDraft',binding(fresh),keys[0]!);await prepare(f,peer,'createLoanDraft',binding(fresh),keys[1]!);
      const race=await Promise.allSettled([f.runtime.lending.mutate(f.a.issued.context,'createLoanDraft',f.org,binding(fresh),keys[0]),f.runtime.lending.mutate(peer.issued.context,'createLoanDraft',f.org,binding(fresh),keys[1])]);
      assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.equal(race.filter(r=>r.status==='rejected'&&err('QUOTE_ALREADY_USED')(r.reason)).length,1);
      const once=view(await f.quote(b.id)),same=randomUUID();await prepare(f,f.a,'createLoanDraft',binding(once),same);await prepare(f,peer,'createLoanDraft',binding(once),same);
      const replays=await Promise.all([f.runtime.lending.mutate(f.a.issued.context,'createLoanDraft',f.org,binding(once),same),f.runtime.lending.mutate(peer.issued.context,'createLoanDraft',f.org,binding(once),same)]);assert.deepEqual(replays.map(r=>r.status).sort(),[200,201]);assert.equal(view(replays[0]!).id,view(replays[1]!).id);
      const l=view(replays[0]!),etag=replays[0]!.etag!,cb={...binding(once),termsVersion:1},cancel={reason:'Carrera sintética'},k1=randomUUID(),k2=randomUUID();
      await prepare(f,f.a,'confirmLoanTerms',cb,k1,l.id,etag);await prepare(f,peer,'cancelLoan',cancel,k2,l.id,etag);
      const transitions=await Promise.allSettled([f.runtime.lending.mutate(f.a.issued.context,'confirmLoanTerms',f.org,cb,k1,l.id,etag),f.runtime.lending.mutate(peer.issued.context,'cancelLoan',f.org,cancel,k2,l.id,etag)]);assert.equal(transitions.filter(r=>r.status==='fulfilled').length,1);assert.equal(transitions.filter(r=>r.status==='rejected'&&err('PRECONDITION_FAILED')(r.reason)).length,1);
      const duplicate={borrowerCode:'RACE_DUP',profile:{displayName:'Duplicado concurrente',schemaVersion:2,extras:{}}},d1=randomUUID(),d2=randomUUID();
      await prepare(f,f.a,'createBorrower',duplicate,d1);await prepare(f,peer,'createBorrower',duplicate,d2);
      const duplicates=await Promise.allSettled([f.runtime.lending.mutate(f.a.issued.context,'createBorrower',f.org,duplicate,d1),f.runtime.lending.mutate(peer.issued.context,'createBorrower',f.org,duplicate,d2)]);assert.equal(duplicates.filter(r=>r.status==='fulfilled').length,1);assert.equal(duplicates.filter(r=>r.status==='rejected'&&err('BORROWER_CODE_CONFLICT')(r.reason)).length,1);
    });
    await t.test('AT13/14/15: missing/bound/expired R, atomic audit/outbox rollback and authority denial',async()=>{
      const f=await setup(group),payload={borrowerCode:'ATOMIC',profile:{displayName:'Sintética atómica',schemaVersion:1,extras:{}}},key=randomUUID();
      await assert.rejects(f.runtime.lending.mutate(f.a.issued.context,'createBorrower',f.org,payload,key),err('R_REQUIRED'));
      await prepare(f,f.a,'createBorrower',payload,key);
      await assert.rejects(f.runtime.lending.mutate(f.a.issued.context,'createBorrower',f.org,{...payload,borrowerCode:'CHANGED'},key),err('R_REQUIRED'));
      assert.equal((await f.sessions.contexts.findOne({_id:f.a.issued.context._id}))?.reauth?.consumed,false);
      const before=await lendingState(f),append=f.identity.audit.append.bind(f.identity.audit);
      f.identity.audit.append=async()=>{throw Error('Injected audit/outbox failure');};
      try{await assert.rejects(f.runtime.lending.mutate(f.a.issued.context,'createBorrower',f.org,payload,key),/Injected audit/);}finally{f.identity.audit.append=append;}
      assert.equal(await lendingState(f),before);assert.equal((await f.sessions.contexts.findOne({_id:f.a.issued.context._id}))?.reauth?.consumed,false);
      f.identity.audit.append=async(event,s)=>{await append(event,s);throw Error('Injected after audit outbox evidence insertion');};
      try{await assert.rejects(f.runtime.lending.mutate(f.a.issued.context,'createBorrower',f.org,payload,key),/Injected after audit/);}finally{f.identity.audit.append=append;}
      assert.equal(await lendingState(f),before);assert.equal((await f.sessions.contexts.findOne({_id:f.a.issued.context._id}))?.reauth?.consumed,false);
      await f.runtime.lending.mutate(f.a.issued.context,'createBorrower',f.org,payload,key);
      const expiredKey=randomUUID();await prepare(f,f.a,'createBorrower',{...payload,borrowerCode:'EXPIRED'},expiredKey);f.clock.value+=300000;
      await assert.rejects(f.runtime.lending.mutate(f.a.issued.context,'createBorrower',f.org,{...payload,borrowerCode:'EXPIRED'},expiredKey),err('R_REQUIRED'));
      const actorId=f.a.issued.context.subjectId!;
      for(const roles of [['A'],['O'],['C'],['P'],['L'],['SA'],['T','SA']]){
        await f.database.transaction(async s=>{await f.identity.identities.updateOne({_id:actorId},{$set:{roles}},{session:s});});
        await assert.rejects(f.read('getLendingPolicy'),err('ACCESS_DENIED'));
      }
      await f.database.transaction(async s=>{await f.identity.identities.updateOne({_id:actorId},{$set:{roles:['T']}},{session:s});});
      const basic=await f.signup();await assert.rejects(f.runtime.lending.read(basic.issued.context,'getLendingPolicy',f.org),(e:unknown)=>e instanceof AppError&&[401,403].includes(e.status));
    });
    await t.test('AT11/15 and S3 dependency: real posted opening reference links once without duplicating debt',async()=>{
      const f=await setup(group),equity={code:'EQUITY_S04',name:'Patrimonio sintético',currency:'COP',accountClass:'EQUITY',kind:'GENERAL'},key=randomUUID();
      await f.proof(f.a,'FINANCE_ACCOUNT_CREATE',{organizationId:f.org,idempotencyKey:key,payload:equity});const eq=view(await f.runtime.finance.mutate(f.a.issued.context,'createAccount',f.org,equity,key)).id;
      const support=randomUUID(),referenceId=randomUUID(),snapshot:Snapshot={cutoffDate:'2020-01-01',supports:[{id:support,reference:'S04-SYNTHETIC',asOfDate:'2020-01-01',declaration:'OWNER_CHECKED'}],references:[{id:referenceId,type:'BORROWER',externalReference:'SYNTHETIC-BORROWER',displayName:'Persona de apertura sintética',supportIds:[support]}],components:[{id:randomUUID(),category:'CASH',accountId:f.account,amount:'100.00',supportIds:[support]},{id:randomUUID(),category:'EQUITY',accountId:eq,amount:'100.00',equityKind:'CONTRIBUTED',supportIds:[support]}],historicalInterest:[],informationalHistory:[]};
      let opening:OpeningFile;
      const run=async(op:string,payload:Record<string,unknown>)=>{
        const k=randomUUID(),id=op==='createOpening'?undefined:opening.id,expected=id?`"${id}:${opening.version}"`:undefined;
        await f.proof(f.a,openingPurposes.get(op)!,{organizationId:f.org,idempotencyKey:k,payload,...(expected?{expectedETag:expected}:{})},id);
        const r=await f.runtime.opening.mutate(f.a.issued.context,op,f.org,payload,k,id,expected);opening=(op==='validateOpening'?(r.data as {opening:OpeningFile}).opening:r.data) as OpeningFile;
      };
      await run('createOpening',{snapshot});await run('validateOpening',{policyVersion:'S03-OPENING-0.1'});
      const bind=()=>({validationId:opening.validation!.id,validationFingerprint:opening.validation!.fingerprint});await run('approveOpening',bind());await run('commitOpening',bind());
      const before=await financial(f),link={openingId:opening!.id,referenceId},b=view(await f.mutate('createBorrower',{borrowerCode:'LINKED',profile:{displayName:'Ficha nueva sintética',schemaVersion:1,extras:{}},openingBorrowerReference:link}));
      await assert.rejects(f.mutate('createBorrower',{borrowerCode:'LINK_DUP',profile:{displayName:'Duplicado enlace',schemaVersion:1,extras:{}},openingBorrowerReference:link}),err('OPENING_REFERENCE_CONFLICT'));
      await assert.rejects(f.mutate('createBorrower',{borrowerCode:'LINK_BAD',profile:{displayName:'Enlace inexistente',schemaVersion:1,extras:{}},openingBorrowerReference:{...link,referenceId:randomUUID()}}),err('RESOURCE_NOT_FOUND'));
      const q=view(await f.quote(b.id)),l=await f.mutate('createLoanDraft',binding(q));await f.mutate('confirmLoanTerms',{...binding(q),termsVersion:1},{id:view(l).id,etag:l.etag!});
      assert.equal(await financial(f),before);assert.equal(await f.runtime.finance.journals.countDocuments(),1);assert.equal(await f.runtime.lending.loans.countDocuments(),1);
    });
    await t.test('AT13: HTTPS/A32/TOTP path, CSRF/size/schema/transport and real-use rejection',async()=>{
      const f=await setup(group),server=await f.https(),client=server.client;client.cookies.set('__Host-caudelyx-session',f.a.issued.token);await client.refreshCsrf();
      const base=`/api/v1/organizations/${f.org}`,body={borrowerCode:'HTTP_S04',profile:{displayName:'Persona HTTP sintética',schemaVersion:1,extras:{}}},key=randomUUID();
      assert.equal((await client.call('POST',base+'/borrowers',body,{'Idempotency-Key':key})).body.error?.code,'R_REQUIRED');
      const proof={password:'Frase de prueba sintetica larga 9871236450',purpose:'BORROWER_CREATE',resourceId:null,command:{organizationId:f.org,idempotencyKey:key,payload:body}};
      const password=await client.call('POST','/api/v1/auth/reauthenticate',proof);assert.equal(password.status,200);
      f.clock.value+=30000;const mfa=await client.call('POST','/api/v1/auth/mfa/challenges/verify',{purpose:'BORROWER_CREATE',method:'TOTP',code:await generate({secret:f.a.secret,epoch:Math.floor(f.now()/1000)})});assert.equal(mfa.status,200);await client.refreshCsrf();
      const created=await client.call('POST',base+'/borrowers',body,{'Idempotency-Key':key});assert.equal(created.status,201);assert.ok(created.headers.etag);
      const id=String(created.body.data?.['id']),terms=f.terms(id),quote=await client.call('POST',base+'/loan-quotes',{terms},{'Idempotency-Key':randomUUID()});assert.equal(quote.status,201);
      for(const route of ['/borrower-field-schemas/current','/borrower-field-schemas/1','/borrowers/'+id+'/versions','/borrowers/'+id+'/versions/1'])assert.equal((await client.call('GET',base+route)).status,200,route);
      const draftKey=randomUUID(),draftBody={quoteId:String(quote.body.data?.['id']),quoteFingerprint:String(quote.body.data?.['fingerprint'])};
      assert.equal((await client.call('POST','/api/v1/auth/reauthenticate',{...proof,purpose:'LOAN_DRAFT_CREATE',command:{organizationId:f.org,idempotencyKey:draftKey,payload:draftBody}})).status,200);
      f.clock.value+=30000;assert.equal((await client.call('POST','/api/v1/auth/mfa/challenges/verify',{purpose:'LOAN_DRAFT_CREATE',method:'TOTP',code:await generate({secret:f.a.secret,epoch:Math.floor(f.now()/1000)})})).status,200);await client.refreshCsrf();
      const draft=await client.call('POST',base+'/loans',draftBody,{'Idempotency-Key':draftKey});assert.equal(draft.status,201);const loanId=String(draft.body.data?.['id']);
      for(const route of ['/loans','/loans/'+loanId,'/loans/'+loanId+'/versions','/loans/'+loanId+'/versions/1','/loan-quotes/'+String(quote.body.data?.['id'])])assert.equal((await client.call('GET',base+route)).status,200,route);
      for(const [payload,status,code] of [[{terms:{...terms,usage:'REAL'}},403,'REAL_USE_NOT_ALLOWED'],[{terms:{...terms,jurisdiction:'US'}},422,'POLICY_UNSUPPORTED'],[{terms:{...terms,graceDays:1}},422,'INPUT_INVALID']] as const){const r=await client.call('POST',base+'/loan-quotes',payload,{'Idempotency-Key':randomUUID()});assert.equal(r.status,status);assert.equal(r.body.error?.code,code);}
      const csrf=await client.call('POST',base+'/loan-quotes',{terms},{'Idempotency-Key':randomUUID(),'X-CSRF-Token':'bad'});assert.equal(csrf.status,400);
      const huge=await client.call('POST',base+'/loan-quotes',{terms,note:'x'.repeat(65536)},{'Idempotency-Key':randomUUID()});assert.equal(huge.status,413);assert.equal(huge.body.error?.code,'INPUT_TOO_LARGE');
      assert.equal((await client.call('GET',base+'/borrowers?offset=0')).status,422);
      assert.equal((await client.call('POST',base+'/lending-policy',{})).status,405);assert.equal((await client.call('GET',base+'/loans/no-such-route/activation')).status,404);
      const foreign=await client.call('GET',`/api/v1/organizations/${randomUUID()}/borrowers/${id}`);assert.equal(foreign.status,404);
      f.clock.open=false;assert.equal((await client.call('GET',base+'/lending-policy')).status,503);f.clock.open=true;
      const get=await client.call('GET',base+'/borrowers/'+id);assert.equal(get.status,200);lendingContract().result('getBorrower',200,get.body);
    });
    await t.test('AT14: confirmation races against org/session revocation and actor role epoch changes',async()=>{
      const f=await setup(group),b=view(await f.borrower()),q=view(await f.quote(b.id)),d=await f.mutate('createLoanDraft',binding(q)),l=view(d),peer=await f.login(f.a),key=randomUUID(),body={...binding(q),termsVersion:1};
      await prepare(f,f.a,'confirmLoanTerms',body,key,l.id,d.etag!);const org=await f.runtime.organizations.read(peer.issued.context);await f.proof(peer,'ORGANIZATION_SESSIONS_REVOKE',undefined,f.org);
      const result=await Promise.allSettled([f.runtime.lending.mutate(f.a.issued.context,'confirmLoanTerms',f.org,body,key,l.id,d.etag!),f.runtime.organizations.revokeOrganization(peer.issued.context,org.etag)]);
      assert.equal(result[1]!.status,'fulfilled');const stored=await f.runtime.lending.loans.findOne({_id:l.id});assert.equal(stored?.status,result[0]!.status==='fulfilled'?'TERMS_CONFIRMED':'DRAFT');
      if(result[0]!.status==='rejected')assert([401,403].includes((result[0] as PromiseRejectedResult).reason.status));
      await assert.rejects(f.read('getLendingPolicy'),(e:unknown)=>e instanceof AppError&&[401,403].includes(e.status));
      const g=await setup(group),gb=view(await g.borrower()),gq=view(await g.quote(gb.id)),gd=await g.mutate('createLoanDraft',binding(gq)),gkey=randomUUID(),gbody={...binding(gq),termsVersion:1};await prepare(g,g.a,'confirmLoanTerms',gbody,gkey,view(gd).id,gd.etag!);
      const revoked=await Promise.allSettled([g.database.transaction(async s=>{await g.identity.identities.updateOne({_id:g.a.issued.context.subjectId!},{$set:{roles:['O'],authzVersion:randomUUID()}},{session:s});await g.identity.audit.append({realm:'TENANT',actorId:g.a.issued.context.subjectId!,subjectId:g.a.issued.context.subjectId!,action:'S04_TEST_ROLE_REVOCATION',outcome:'SUCCESS'},s);}),g.runtime.lending.mutate(g.a.issued.context,'confirmLoanTerms',g.org,gbody,gkey,view(gd).id,gd.etag!)]);
      assert.equal(revoked[0]!.status,'fulfilled');assert.equal((await g.runtime.lending.loans.findOne({_id:view(gd).id}))?.status,revoked[1]!.status==='fulfilled'?'TERMS_CONFIRMED':'DRAFT');
    });
    await t.test('AT15: startup and restore reject loss in every new source, then preserve complete version history',async()=>{
      const f=await setup(group),schema=await f.read('getCurrentBorrowerSchema');await f.mutate('publishBorrowerSchema',{fields:[],changeReason:'Versión para restore'},{etag:schema.etag!});
      const b=view(await f.borrower('RESTORE',{displayName:'Sintética restore',schemaVersion:2,extras:{}})),q=view(await f.quote(b.id)),draft=await f.mutate('createLoanDraft',binding(q)),l=view(draft);
      await f.mutate('confirmLoanTerms',{...binding(q),termsVersion:1},{id:l.id,etag:draft.etag!});const snapshot=await f.restore.snapshot(),before=await financial(f);
      const evidence=await head(f.database);await f.runtime.lending.quotes.updateOne({_id:q.id},{$set:{'terms.principal':'9999.00'}});
      await assert.rejects(f.mutate('createLoanDraft',binding(q)),err('SERVICE_UNAVAILABLE'));assert.deepEqual(await head(f.database),evidence);
      const startup=new RestoreController(f.database,f.restore.gatePath,f.keys.journal);await startup.initialize();assert.equal(startup.isOpen(),false);
      await f.restore.beginRestore(snapshot);await f.restore.reconcile({approved:true,reviewId:'S04-SYNTHETIC-FIXTURE-ONLY'});
      for(const name of lendingCollections){
        await f.restore.beginRestore(snapshot);const removed=await f.database.db.collection(name).deleteOne({});assert.equal(removed.deletedCount,1,name);
        await assert.rejects(f.restore.reconcile({approved:true,reviewId:'S04-SYNTHETIC-NEGATIVE-'+name}),err('SERVICE_UNAVAILABLE'));assert.equal(f.restore.isOpen(),false);
      }
      await f.restore.beginRestore(snapshot);await f.database.db.collection<{_id:string}>('lending_domain_state').deleteOne({_id:'evidence'});await assert.rejects(f.restore.reconcile({approved:true,reviewId:'S04-SYNTHETIC-MISSING-HEAD'}),err('SERVICE_UNAVAILABLE'));
      await f.restore.beginRestore(snapshot);await f.restore.reconcile({approved:true,reviewId:'S04-SYNTHETIC-COMPLETE'});assert.equal(f.restore.isOpen(),true);assert.equal(await financial(f),before);
      f.a.issued=(await f.login(f.a)).issued;assert.equal(view(await f.read('getLoan',l.id)).status,'TERMS_CONFIRMED');assert.equal(((await f.read('listLoanVersions',l.id)).data as {items:unknown[]}).items.length,1);
    });
    await t.test('AT16: programmatic cancellation closes own consumers and cleans exact group',async()=>{
      const controller=new AbortController();let cleanup:Promise<void>|undefined;controller.signal.addEventListener('abort',()=>{cleanup=cancel();},{once:true});controller.abort();await cleanup;
    });
  }finally{process.removeListener('SIGINT',onSignal);process.removeListener('SIGTERM',onSignal);await group.dispose();}
});
