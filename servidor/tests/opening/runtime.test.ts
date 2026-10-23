import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {financeFixture} from '../finance/fixture.js';
import {purposes} from '../../src/modules/opening/contract.js';
import {etag} from '../../src/modules/finance/service.js';
import {RestoreController} from '../../src/shared/restore.js';
import type {OpeningFile,Snapshot} from '../../src/modules/opening/models.js';
import type {Result} from '../../src/modules/finance/models.js';

const error=(code:string)=>(e:unknown)=>e instanceof Error&&'code'in e&&e.code===code;
const data=(r:Result)=>r.data as Record<string,unknown>;
const setup=async(full=false)=>{
  const f=await financeFixture();try{
    const a=await f.actor(),org=await f.organization(a),support=randomUUID(),accounts=new Map<string,string>();
    for(const [code,accountClass,kind] of [['BANK','ASSET','BANK'],['EQUITY','EQUITY','GENERAL'],...(full?[['PRINCIPAL','ASSET','GENERAL'],['INTEREST','ASSET','GENERAL'],['ASSET','ASSET','GENERAL'],['INVESTMENT','ASSET','GENERAL'],['LIABILITY','LIABILITY','GENERAL'],['HISTORICAL','EQUITY','GENERAL']]:[])]){
      accounts.set(code!,String(data(await f.mutate(a,org,'createAccount',{code,name:`Cuenta ${code}`,accountClass,kind,currency:'COP'})).id));
    }
    const snapshot:Snapshot={cutoffDate:'2020-01-01',supports:[{id:support,reference:'SYNTHETIC-OPENING-001',asOfDate:'2020-01-01',declaration:'OWNER_CHECKED'}],references:[],components:[{id:randomUUID(),category:'BANK',accountId:accounts.get('BANK')!,amount:'100.00',supportIds:[support]},{id:randomUUID(),category:'EQUITY',accountId:accounts.get('EQUITY')!,amount:'100.00',equityKind:'CONTRIBUTED',supportIds:[support]}],historicalInterest:[],informationalHistory:[]};
    let current:OpeningFile|undefined;
    const mutate=async(operation:string,payload:Record<string,unknown>,options:{key?:string;id?:string;expected?:string}={})=>{
      const key=options.key??randomUUID(),id=operation==='createOpening'?undefined:options.id??current!.id,expected=options.expected??(id?`"${id}:${current!.version}"`:undefined);
      await f.proof(a,purposes.get(operation)!,{organizationId:org,idempotencyKey:key,payload,...(id?{expectedETag:expected}:{})},id);
      const result=await f.runtime.opening.mutate(a.issued.context,operation,org,payload,key,id,expected);
      current=(operation==='validateOpening'?(data(result).opening):result.data) as OpeningFile;return result;
    };
    const create=async(s=snapshot)=>{await mutate('createOpening',{snapshot:s});return current!;};
    const validate=async()=>{await mutate('validateOpening',{policyVersion:'S03-OPENING-0.1'});return current!;};
    const binding=()=>({validationId:current!.validation!.id,validationFingerprint:current!.validation!.fingerprint});
    const approve=async()=>{await mutate('approveOpening',binding());return current!;};
    const commit=async()=>{await mutate('commitOpening',binding());return current!;};
    return{f,a,org,accounts,support,snapshot,mutate,create,validate,approve,commit,binding,current:()=>current!};
  }catch(e){await f.close();throw e;}
};
const posting=(orgAccounts:Map<string,string>,date='2020-01-02')=>({currency:'COP',effectiveDate:date,sourceId:randomUUID(),supportReference:'SYNTHETIC',description:'OperaciÃƒÂ³n posterior',lines:[{accountId:orgAccounts.get('BANK')!,debit:'25.00',credit:'0.00'},{accountId:orgAccounts.get('EQUITY')!,debit:'0.00',credit:'25.00'}]});

test('AT-S03-01/02: versioned draft/ETag/cancellation/predecessor, no journal until commit',{timeout:120000},async()=>{
  const s=await setup(),{f,a,org}=s;try{
    let row=await s.create();assert.equal(row.status,'DRAFT');assert.equal(row.bookId,org);
    assert.equal(await f.runtime.finance.journals.countDocuments(),0);await assert.rejects(s.create(),error('OPENING_STATE_CONFLICT'));
    const read=await f.runtime.opening.read(a.issued.context,'readOpening',org,row.id);assert.equal(read.etag,`"${row.id}:1"`);
    await assert.rejects(f.runtime.opening.mutate(a.issued.context,'replaceOpening',org,{snapshot:s.snapshot,changeReason:'SintÃƒÂ©tico'},randomUUID(),row.id),error('ETAG_REQUIRED'));
    await assert.rejects(s.mutate('replaceOpening',{snapshot:s.snapshot,changeReason:'SintÃƒÂ©tico'},{expected:`"${row.id}:99"`}),error('PRECONDITION_FAILED'));
    await s.mutate('replaceOpening',{snapshot:s.snapshot,changeReason:'Se conserva soporte'});row=s.current();assert.equal(row.contentVersion,2);assert.equal(row.version,2);
    await s.validate();await s.approve();await s.mutate('replaceOpening',{snapshot:s.snapshot,changeReason:'Invalidar aprobaciÃƒÂ³n explÃƒÂ­citamente'});assert.equal(s.current().approval,null);assert.equal(s.current().status,'DRAFT');
    await s.mutate('cancelOpening',{reason:'CorrecciÃƒÂ³n antes de apertura'});row=s.current();assert.equal(row.status,'CANCELLED');assert.equal(row.cancellation?.reason,'CorrecciÃƒÂ³n antes de apertura');
    await assert.rejects(s.mutate('replaceOpening',{snapshot:s.snapshot,changeReason:'No reabrir cancelado'}),error('OPENING_STATE_CONFLICT'));
    await s.mutate('createOpening',{snapshot:s.snapshot,predecessorId:row.id});assert.notEqual(s.current().id,row.id);
    const page=data(await f.runtime.opening.read(a.issued.context,'listOpeningFiles',org,undefined,{limit:'1'}));assert.equal((page.items as unknown[]).length,1);assert.equal(typeof page.nextCursor,'string');
    await assert.rejects(f.runtime.opening.read(a.issued.context,'listOpeningFiles',org,undefined,{limit:'2',cursor:page.nextCursor}),error('INPUT_INVALID'));
    assert.equal(await f.runtime.finance.journals.countDocuments(),0);assert.equal(await f.runtime.opening.references.countDocuments(),0);
  }finally{await f.close();}
});
test('AT-S03-01/03/05: eligibility/date/difference/reference validation never manufactures balances',{timeout:120000},async()=>{
  const s=await setup(),{f}=s;try{
    await assert.rejects(s.create({...s.snapshot,cutoffDate:'2099-01-01'}),error('INPUT_INVALID'));
    await assert.rejects(f.runtime.opening.mutate(s.a.issued.context,'createOpening',s.org,undefined,randomUUID()),error('INPUT_INVALID'));
    const invalid=structuredClone(s.snapshot);invalid.components[1]!.amount='99.99';invalid.components[0]!.supportIds=[randomUUID()];await s.create(invalid);
    const result=data(await s.mutate('validateOpening',{policyVersion:'S03-OPENING-0.1'}));const report=result.report as {issues:{code:string}[];totals:{balanceDifference:string}};
    assert.equal(s.current().status,'DRAFT');assert.equal(s.current().validation,null);assert.equal(report.totals.balanceDifference,'0.01');assert.equal(((await f.runtime.opening.validations.findOne({openingId:s.current().id,operation:'validateOpening'}))!['report'] as {totals:{balanceDifference:string}}).totals.balanceDifference,'0.01');assert.ok(report.issues.some(i=>i.code==='SUPPORT_REQUIRED'));
    await assert.rejects(s.mutate('approveOpening',{validationId:randomUUID(),validationFingerprint:'a'.repeat(64)}),error('OPENING_STATE_CONFLICT'));
    assert.equal(await f.runtime.finance.journals.countDocuments(),0);
    await s.mutate('cancelOpening',{reason:'Cambiar fixture'});await f.mutate(s.a,s.org,'postJournal',posting(s.accounts,'2019-01-01'));
    const original=await f.runtime.finance.journals.findOne({organizationId:s.org});
    await f.mutate(s.a,s.org,'reverseJournal',{effectiveDate:'2019-01-01',sourceId:randomUUID(),supportReference:'SintÃƒÂ©tico',reason:'ReversiÃƒÂ³n previa'},{id:original!._id,etag:etag(original!)});
    await assert.rejects(s.create(),error('BOOK_NOT_ELIGIBLE'));assert.equal(await f.runtime.finance.journals.countDocuments(),2);
  }finally{await f.close();}
});
test('AT-S03-04/07/09: full historical position posts once, separate principal/interest/asset and cut reconstruction',{timeout:180000},async()=>{
  const s=await setup(true),{f,a,org,snapshot,accounts,support}=s;try{
    const borrower=randomUUID(),loan=randomUUID(),loan2=randomUUID(),obligation=randomUUID(),asset=randomUUID(),investment=randomUUID(),hist=randomUUID();
    snapshot.references.push({id:borrower,type:'BORROWER',externalReference:'BORROWER-1',displayName:'Persona sintÃƒÂ©tica',supportIds:[support]},{id:loan,type:'HISTORICAL_LOAN',externalReference:'LOAN-1',borrowerId:borrower,originationDate:'2019-01-01',supportIds:[support]},{id:obligation,type:'OBLIGATION',externalReference:'DEBT-1',counterpartyLabel:'Contraparte sintÃƒÂ©tica',incurredDate:'2019-01-01',supportIds:[support]},{id:asset,type:'BASIC_ASSET',externalReference:'ASSET-1',category:'VEHICLE',acquisitionDate:'2019-01-01',fundingReference:'Origen declarado sintÃƒÂ©tico',supportIds:[support]});
    snapshot.references.push({id:loan2,type:'HISTORICAL_LOAN',externalReference:'LOAN-2',borrowerId:borrower,originationDate:'2019-01-01',supportIds:[support]},{id:investment,type:'BASIC_INVESTMENT',externalReference:'INVESTMENT-1',category:'PARTICIPATION',acquisitionDate:'2019-01-01',supportIds:[support]});
    snapshot.components[1]!.amount='500.00';snapshot.components.push({id:randomUUID(),category:'PRINCIPAL_RECEIVABLE',referenceId:loan,accountId:accounts.get('PRINCIPAL')!,amount:'100.00',supportIds:[support]},{id:randomUUID(),category:'BASIC_ASSET',referenceId:asset,accountId:accounts.get('ASSET')!,amount:'300.00',supportIds:[support]},{id:randomUUID(),category:'LIABILITY',referenceId:obligation,accountId:accounts.get('LIABILITY')!,amount:'150.00',supportIds:[support]},{id:hist,category:'EQUITY',equityKind:'HISTORICAL_RESULTS',accountId:accounts.get('HISTORICAL')!,amount:'20.00',supportIds:[support]});
    snapshot.components.push({id:randomUUID(),category:'PRINCIPAL_RECEIVABLE',referenceId:loan2,accountId:accounts.get('PRINCIPAL')!,amount:'100.00',supportIds:[support]},{id:randomUUID(),category:'BASIC_INVESTMENT',referenceId:investment,accountId:accounts.get('INVESTMENT')!,amount:'50.00',supportIds:[support]});
    snapshot.historicalInterest.push({id:randomUUID(),loanReferenceId:loan2,amount:'30.00',treatment:'INFORMATIONAL',supportIds:[support]});
    snapshot.historicalInterest.push({id:randomUUID(),loanReferenceId:loan,amount:'20.00',treatment:'RECOGNIZED_OPENING',accountId:accounts.get('INTEREST')!,equityComponentId:hist,recognitionDeclaration:'Reconocimiento histÃƒÂ³rico declarado y sustentado sintÃƒÂ©tico',supportIds:[support]});
    snapshot.informationalHistory.push({id:randomUUID(),referenceId:loan,date:'2019-01-01',description:'Desembolso histÃƒÂ³rico, sin posting',supportIds:[support]});
    await s.create();let row=await s.validate();assert.deepEqual(row.validation?.report.issues,[]);assert.equal(row.validation?.report.totals.assets,'670.00');assert.equal(row.validation?.report.totals.principal,'200.00');assert.equal(row.validation?.report.totals.informationalInterest,'30.00');
    const fingerprint=row.validation!.fingerprint;await s.approve();assert.equal(s.current().validation!.fingerprint,fingerprint);row=await s.commit();assert.equal(row.status,'POSTED');assert.equal(row.validation!.fingerprint,fingerprint);
    const journals=await f.runtime.finance.journals.find({organizationId:org}).toArray();assert.equal(journals.length,1);assert.equal(journals[0]!.source.type,'OPENING');assert.equal(journals[0]!.source.id,row.id);assert.equal(journals[0]!.effectiveDate,snapshot.cutoffDate);
    assert.equal(journals[0]!.lines.find(l=>l.accountId===accounts.get('BANK'))!.debit.toString(),'100.00');
    assert.equal((await f.runtime.opening.references.findOne({referenceId:loan}))!['principalOutstanding'],'100.00');assert.equal(await f.runtime.opening.references.countDocuments(),6);assert.equal(row.commit!.ledgerLineMap.length,journals[0]!.lines.length);
    for(const [asOf,expected] of [['2019-12-31','0.00'],['2020-01-01','200.00'],['2020-01-02','200.00']]){
      const balances=data(await f.runtime.finance.read(a.issued.context,'balances',org,undefined,{asOf}));assert.equal((balances.items as Record<string,string>[]).find(b=>b.accountId===accounts.get('PRINCIPAL'))!.naturalBalance,expected);
    }
    const entry=await f.runtime.finance.read(a.issued.context,'readJournal',org,journals[0]!._id);assert.equal((data(entry).source as {type:string}).type,'OPENING');
    const before=data(await f.runtime.finance.read(a.issued.context,'balances',org,undefined,{asOf:'2020-01-01',recordedThrough:row.createdAt}));assert.ok((before.items as Record<string,string>[]).every(b=>b.naturalBalance==='0.00'));
    assert.equal((await f.database.db.collection<{_id:string;format?:string}>('financial_evidence_head').findOne({_id:'finance'}))!['format'],'opening-v1');await f.restore.flush();assert.ok((await f.restore.fileJournal.readVerified(true)).some(e=>e.state.finance?.format==='opening-v1'));
  }finally{await f.close();}
});
test('AT-S03-06: changing accounts invalidates validation; internal state/fence changes do not',{timeout:120000},async()=>{
  const s=await setup(),{f,a,org}=s;try{
    await s.create();await s.validate();const bank=s.accounts.get('BANK')!;
    await f.mutate(a,org,'renameAccount',{name:'Cambio posterior'},{id:bank,etag:`"${bank}:1"`});await assert.rejects(s.approve(),error('OPENING_VALIDATION_STALE'));
    await s.validate();await s.approve();await f.mutate(a,org,'renameAccount',{name:'Otro cambio posterior'},{id:bank,etag:`"${bank}:2"`});await assert.rejects(s.commit(),error('OPENING_VALIDATION_STALE'));
    await s.mutate('replaceOpening',{snapshot:s.snapshot,changeReason:'Revalidar snapshot actualizado'});await s.validate();await s.approve();assert.equal((await s.commit()).status,'POSTED');
    assert.ok(await f.runtime.opening.validations.countDocuments({openingId:s.current().id,operation:'approveOpening'})>=2);
  }finally{await f.close();}
});
test('AT-S03-07: real Mongo audit failure rolls back journal/references/marker/idempotency/R and permits same-command retry',{timeout:120000},async()=>{
  const s=await setup(),{f,a,org}=s;try{
    s.snapshot.references.push({id:randomUUID(),type:'BORROWER',externalReference:'ROLLBACK-BORROWER',displayName:'Sintético',supportIds:[s.support]});
    await s.create();await s.validate();const row=await s.approve(),payload=s.binding(),key=randomUUID(),expected=`"${row.id}:${row.version}"`;
    await f.proof(a,'OPENING_COMMIT',{organizationId:org,idempotencyKey:key,payload,expectedETag:expected},row.id);
    const names=['financial_journals','opening_references','opening_idempotency','opening_validations','audit_events','outbox'];
    const before=await Promise.all(names.map(n=>f.database.db.collection(n).countDocuments()));
    await f.database.db.command({collMod:'audit_events',validator:{$expr:{$ne:['$action','OPENING_commitOpening']}}});
    try{await assert.rejects(f.runtime.opening.mutate(a.issued.context,'commitOpening',org,payload,key,row.id,expected));}finally{await f.database.db.command({collMod:'audit_events',validator:{}});}
    assert.deepEqual(await Promise.all(names.map(n=>f.database.db.collection(n).countDocuments())),before);assert.equal((await f.context(a.issued.context)).reauth?.consumed,false);
    assert.equal((await f.runtime.opening.files.findOne({_id:row.id}))!.status,'APPROVED');assert.equal((await f.database.db.collection<{_id:string;openingId?:string;cutoffDate?:string}>('financial_books').findOne({_id:org}))!['openingId'],undefined);
    assert.equal((await f.runtime.opening.mutate(a.issued.context,'commitOpening',org,payload,key,row.id,expected)).status,201);
  }finally{await f.close();}
});
test('AT-S03-08: two valid R concurrent commit/replay, key conflict, source uniqueness and one-use proof',{timeout:120000},async()=>{
  const s=await setup(),{f,a,org}=s;try{
    await s.create();await s.validate();const row=await s.approve(),b=await f.login(a),payload=s.binding(),key=randomUUID(),expected=`"${row.id}:${row.version}"`,command={organizationId:org,idempotencyKey:key,payload,expectedETag:expected};
    await f.proof(a,'OPENING_COMMIT',command,row.id);await f.proof(b,'OPENING_COMMIT',command,row.id);
    const results=await Promise.all([a,b].map(actor=>f.runtime.opening.mutate(actor.issued.context,'commitOpening',org,payload,key,row.id,expected)));assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);assert.deepEqual(results[0]!.data,results[1]!.data);assert.equal(await f.runtime.finance.journals.countDocuments(),1);
    const changed={...payload,validationFingerprint:'0'.repeat(64)};await f.proof(a,'OPENING_COMMIT',{...command,payload:changed},row.id);await assert.rejects(f.runtime.opening.mutate(a.issued.context,'commitOpening',org,changed,key,row.id,expected),error('IDEMPOTENCY_CONFLICT'));
    await f.proof(a,'OPENING_COMMIT',command,row.id);const once=await Promise.allSettled([1,2].map(()=>f.runtime.opening.mutate(a.issued.context,'commitOpening',org,payload,key,row.id,expected)));assert.equal(once.filter(r=>r.status==='fulfilled').length,1);assert.equal(await f.runtime.finance.journals.countDocuments(),1);
  }finally{await f.close();}
});
test('AT-S03-10: posted opening immutable, no generic reversal/backdate/second opening; later S2 operations valid',{timeout:120000},async()=>{
  const s=await setup(),{f,a,org}=s;try{
    await s.create();await s.validate();await s.approve();const row=await s.commit();await assert.rejects(s.create(),error('OPENING_ALREADY_POSTED'));
    await assert.rejects(s.mutate('replaceOpening',{snapshot:s.snapshot,changeReason:'Prohibido'}),error('OPENING_IMMUTABLE'));
    const journal=(await f.runtime.finance.journals.findOne({_id:row.commit!.journalId}))!;
    await assert.rejects(f.mutate(a,org,'reverseJournal',{effectiveDate:'2020-01-02',sourceId:randomUUID(),supportReference:'SintÃƒÂ©tico',reason:'No revertir apertura'},{id:journal._id,etag:etag(journal)}),error('OPENING_IMMUTABLE'));
    for(const d of ['2019-12-31','2020-01-01'])await assert.rejects(f.mutate(a,org,'postJournal',posting(s.accounts,d)),error('OPENING_CUTOFF_CONFLICT'));
    await f.mutate(a,org,'postJournal',posting(s.accounts));assert.equal(await f.runtime.finance.journals.countDocuments(),2);
  }finally{await f.close();}
});
test('AT-S03-10: ordinary posting and opening commit share fence, cannot both establish conflicting initial position',{timeout:120000},async()=>{
  const s=await setup(),{f,a,org}=s;try{
    await s.create();await s.validate();const row=await s.approve(),b=await f.login(a),payload=s.binding(),key=randomUUID(),expected=`"${row.id}:${row.version}"`,ordinary=posting(s.accounts,'2020-01-01'),otherKey=randomUUID();
    await f.proof(a,'OPENING_COMMIT',{organizationId:org,idempotencyKey:key,payload,expectedETag:expected},row.id);await f.proof(b,'FINANCE_JOURNAL_POST',{organizationId:org,idempotencyKey:otherKey,payload:ordinary});
    const result=await Promise.allSettled([f.runtime.opening.mutate(a.issued.context,'commitOpening',org,payload,key,row.id,expected),f.runtime.finance.mutate(b.issued.context,'postJournal',org,ordinary,otherKey)]);
    assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(await f.runtime.finance.journals.countDocuments(),1);
  }finally{await f.close();}
});
test('AT-S03-13/14: two tenants/roles/SA/MFA/R, revocation during command and immutable declared ownership',{timeout:120000},async()=>{
  const s=await setup(),{f,a,org}=s;try{
    const other=await f.actor(),otherOrg=await f.organization(other);const row=await s.create();
    await assert.rejects(f.runtime.opening.read(other.issued.context,'readOpening',otherOrg,row.id),error('RESOURCE_NOT_FOUND'));
    await assert.rejects(f.runtime.opening.read(a.issued.context,'listOpeningFiles',otherOrg),error('RESOURCE_NOT_FOUND'));
    for(const roles of [['A'],['O'],['C'],['P'],['L'],['SA'],['SA','T']]){
      await f.identity.identities.updateOne({_id:a.issued.context.subjectId!},{$set:{roles}});await assert.rejects(f.runtime.opening.read(a.issued.context,'listOpeningFiles',org),error('ACCESS_DENIED'));
    }
    await f.identity.identities.updateOne({_id:a.issued.context.subjectId!},{$set:{roles:['T']}});
    const foreign={...s.snapshot,components:s.snapshot.components.map(c=>({...c,accountId:randomUUID()}))};await s.mutate('replaceOpening',{snapshot:foreign,changeReason:'Referencia ajena sintÃƒÂ©tica'});await s.validate();assert.ok(s.current().status==='DRAFT');assert.equal(await f.runtime.finance.journals.countDocuments(),0);
    await s.mutate('replaceOpening',{snapshot:s.snapshot,changeReason:'Restituir referencia propia'});await s.validate();const approved=await s.approve(),payload=s.binding(),key=randomUUID(),expected=`"${approved.id}:${approved.version}"`;
    await f.proof(a,'OPENING_COMMIT',{organizationId:org,idempotencyKey:key,payload,expectedETag:expected},row.id);
    const session=f.database.client.startSession();session.startTransaction();await f.database.db.collection<{_id:string;value:number}>('transaction_fence').updateOne({_id:'security'},{$inc:{value:1}},{session});
    const pending=f.runtime.opening.mutate(a.issued.context,'commitOpening',org,payload,key,row.id,expected),outcome=assert.rejects(pending,error('AUTH_INVALID'));
    await f.identity.identities.updateOne({_id:a.issued.context.subjectId!},{$set:{roles:['A'],authzVersion:randomUUID()}},{session});await session.commitTransaction();await session.endSession();await outcome;assert.equal(await f.runtime.finance.journals.countDocuments(),0);
  }finally{await f.close();}
});
test('AT-S03-14: full opening snapshot restores, loss of every S3 domain source/marker fails closed',{timeout:180000},async()=>{
  const s=await setup(),{f,org}=s;try{
    s.snapshot.references.push({id:randomUUID(),type:'BORROWER',externalReference:'RESTORE-BORROWER',displayName:'Sintético',supportIds:[s.support]});
    await s.create();await s.validate();await s.approve();await s.commit();const snapshot=await f.restore.snapshot();
    await f.restore.beginRestore(snapshot);await f.restore.reconcile({approved:true,reviewId:'synthetic-opening-complete'});assert.equal(f.restore.isOpen(),true);
    for(const name of ['opening_files','opening_validations','opening_references','opening_idempotency','financial_journals']){
      await f.database.db.collection(name).deleteMany({});const restarted=new RestoreController(f.database,f.restore.gatePath,f.keys.journal);await restarted.initialize();assert.equal(restarted.isOpen(),false,name);
      await assert.rejects(f.restore.reconcile({approved:true,reviewId:'synthetic-incomplete'}),error('SERVICE_UNAVAILABLE'));
      await f.restore.beginRestore(snapshot);await f.restore.reconcile({approved:true,reviewId:'synthetic-restored'});assert.equal(f.restore.isOpen(),true);
    }
    await f.database.db.collection<{_id:string;openingId?:string;cutoffDate?:string}>('financial_books').updateOne({_id:org},{$unset:{openingId:'',cutoffDate:''}});const restarted=new RestoreController(f.database,f.restore.gatePath,f.keys.journal);await restarted.initialize();assert.equal(restarted.isOpen(),false);
  }finally{await f.close();}
});
test('AT-S03-14: pre-opening security snapshot cannot manufacture a later approved financial opening',{timeout:120000},async()=>{
  const s=await setup(),{f}=s;try{
    const old=await f.restore.snapshot();await s.create();await s.validate();await s.approve();await s.commit();await f.restore.flush();await f.restore.beginRestore(old);
    await assert.rejects(f.restore.reconcile({approved:true,reviewId:'synthetic-old-cut'}),error('SERVICE_UNAVAILABLE'));assert.equal(await f.runtime.finance.journals.countDocuments(),0);assert.equal(f.restore.isOpen(),false);
  }finally{await f.close();}
});
test('AT-S03-14: opening R binding rejects altered payload/key/ETag, consumed proof and expiration',{timeout:120000},async()=>{
  const s=await setup(),{f,a,org}=s;try{
    await s.create();await s.validate();const row=await s.approve(),payload=s.binding(),key=randomUUID(),expected=`"${row.id}:${row.version}"`,command={organizationId:org,idempotencyKey:key,payload,expectedETag:expected};
    await f.proof(a,'OPENING_COMMIT',command,row.id);
    for(const variant of [{payload:{...payload,validationFingerprint:'f'.repeat(64)},key,expected},{payload,key:randomUUID(),expected},{payload,key,expected:`"${row.id}:99"`}])await assert.rejects(f.runtime.opening.mutate(a.issued.context,'commitOpening',org,variant.payload,variant.key,row.id,variant.expected),error('R_REQUIRED'));
    assert.equal(await f.runtime.finance.journals.countDocuments(),0);assert.equal((await f.context(a.issued.context)).reauth!.consumed,false);
    f.clock.value+=300001;await assert.rejects(f.runtime.opening.mutate(a.issued.context,'commitOpening',org,payload,key,row.id,expected),error('R_REQUIRED'));
    await f.proof(a,'OPENING_COMMIT',command,row.id);await f.runtime.opening.mutate(a.issued.context,'commitOpening',org,payload,key,row.id,expected);
    await assert.rejects(f.runtime.opening.mutate(a.issued.context,'commitOpening',org,payload,key,row.id,expected),error('R_REQUIRED'));assert.equal(await f.runtime.finance.journals.countDocuments(),1);
  }finally{await f.close();}
});
test('AT-S03-03/07: manual boundary100components99references fits64KiB and commits one aggregate journal',{timeout:180000},async()=>{
  const s=await setup(true),{f,snapshot,support,accounts}=s;try{
    const borrower=randomUUID();snapshot.references.push({id:borrower,type:'BORROWER',externalReference:'B-LIMIT',displayName:'Sintético',supportIds:[support]});snapshot.components[1]!.amount='198.00';
    for(let i=0;i<98;i++){
      const id=randomUUID();snapshot.references.push({id,type:'HISTORICAL_LOAN',externalReference:`L-LIMIT-${i}`,borrowerId:borrower,originationDate:'2019-01-01',supportIds:[support]});snapshot.components.push({id:randomUUID(),category:'PRINCIPAL_RECEIVABLE',accountId:accounts.get('PRINCIPAL')!,referenceId:id,amount:'1.00',supportIds:[support]});
    }
    const bytes=Buffer.byteLength(JSON.stringify({snapshot})),start=performance.now();assert.ok(bytes<=65536);assert.equal(snapshot.components.length,100);assert.equal(snapshot.references.length,99);
    await s.create();await s.validate();await s.approve();const row=await s.commit();assert.equal(row.status,'POSTED');assert.equal(row.validation!.report.totals.principal,'98.00');assert.equal(row.validation!.report.totals.assets,'198.00');assert.equal(row.commit!.ledgerLineMap.length,3);assert.equal(await f.runtime.opening.references.countDocuments(),99);assert.equal(await f.runtime.finance.journals.countDocuments(),1);
    console.log('S03_BOUNDARY '+JSON.stringify({components:100,references:99,requestUtf8Bytes:bytes,journals:1,lines:3,durationSeconds:(performance.now()-start)/1000,note:'Synthetic bounded case only, not a scale guarantee.'}));
  }finally{await f.close();}
});
test('AT-S03-08/12/16: two actual HTTPS backend processes commit once; bounded F03 diagnostic, no silent retry',{timeout:240000},async()=>{
  const s=await setup(),{f,a,org}=s,diagnostics:{counts:Record<string,number>;observations:number}[]=[];let summary:Record<string,unknown>={};
  try{
    await s.create();await s.validate();const row=await s.approve(),b=await f.login(a),payload=s.binding(),key=randomUUID(),expected=`"${row.id}:${row.version}"`,command={organizationId:org,idempotencyKey:key,payload,expectedETag:expected};
    await f.proof(a,'OPENING_COMMIT',command,row.id);await f.proof(b,'OPENING_COMMIT',command,row.id);await f.restore.flush();await f.https(a);
    const first=await f.native(a),second=await f.native(b);
    for(const child of [first.child,second.child])child.stderr?.on('data',bytes=>{for(const line of String(bytes).split('\n'))if(line.startsWith('S03_AUTH_DIAGNOSTIC '))diagnostics.push(JSON.parse(line.slice(20)) as {counts:Record<string,number>;observations:number});});
    const results=await Promise.all([first.client,second.client].map(c=>c.call('POST',`/api/v1/organizations/${org}/financial/opening-files/${row.id}/commit`,payload,{'Idempotency-Key':key,'If-Match':expected})));assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);assert.equal(await f.runtime.finance.journals.countDocuments(),1);
    const started=performance.now(),statuses=new Map<number,number>();let probes=0;
    while(probes<240&&performance.now()-started<180000){
      const client=probes%2===0?first.client:second.client;
      const response=await client.call('GET',`/api/v1/organizations/${org}/financial/accounts?limit=20`);statuses.set(response.status,(statuses.get(response.status)??0)+1);probes++;
    }
    summary={task:'S03-P02',finding:'F03',state:statuses.get(401)?'REPRODUCED_CAUSE_UNKNOWN':'OPEN_NOT_REPRODUCED',original:'1/199; later0/203 preserved',budget:{maxProbes:240,maxSeconds:180},probes,statuses:Object.fromEntries(statuses),durationSeconds:(performance.now()-started)/1000,retries:0,cause:null};
    assert.ok(probes>0&&probes<=240);assert.ok([...statuses.keys()].every(s=>[200,401].includes(s)));
  }finally{
    await f.close();
    await writeFile('../../Construccion/Sprints/S03/Evidencias/S03-P02-DIAGNOSTIC.json',JSON.stringify({...summary,internalSummaries:diagnostics,notes:'No public error changes; unknown remains unknown, zero401 does not prove correction.'},null,2)+'\n');
  }
});
