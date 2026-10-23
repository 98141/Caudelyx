import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {generate} from 'otplib';
import {financeFixture} from '../finance/fixture.js';
import {ApiClient} from '../helpers/client.js';
import {financialError} from '../../src/modules/finance/http.js';
import {AppError} from '../../src/shared/errors.js';
import type {OpeningFile,Snapshot} from '../../src/modules/opening/models.js';

test('AT-S03-12/13/14: real HTTPS/A32/A27 opening lifecycle, transport privacy and closed restore503',{timeout:180000},async()=>{
  const f=await financeFixture();try{
    const a=await f.actor(),org=await f.organization(a),accounts=[];
    for(const [code,accountClass,kind] of [['BANK','ASSET','BANK'],['EQUITY','EQUITY','GENERAL']])accounts.push((await f.mutate(a,org,'createAccount',{code,name:'SintÃ©tica',accountClass,kind,currency:'COP'})).data as {id:string});
    const support=randomUUID(),snapshot:Snapshot={cutoffDate:'2020-01-01',supports:[{id:support,reference:'SintÃ©tico',asOfDate:'2020-01-01',declaration:'DECLARED'}],references:[],components:[{id:randomUUID(),category:'BANK',accountId:accounts[0]!.id,amount:'100.00',supportIds:[support]},{id:randomUUID(),category:'EQUITY',equityKind:'CONTRIBUTED',accountId:accounts[1]!.id,amount:'100.00',supportIds:[support]}],historicalInterest:[],informationalHistory:[]};
    const {client,port,cert}=await f.https(a),base=`/api/v1/organizations/${org}/financial/opening-files`;
    const anon=new ApiClient(port,cert);await anon.refreshCsrf();assert.equal((await anon.call('GET',base)).status,401);
    const platform=new ApiClient(port,cert,'platform.localhost');assert.equal((await platform.call('GET',base)).status,403);
    assert.equal((await client.call('GET',`/api/v1/organizations/${randomUUID()}/financial/opening-files`)).status,404);
    assert.equal((await client.call('GET',base+'?scope=PERSONAL')).status,422);
    const missing=await client.call('GET','/api/v1/missing-synthetic-route');assert.equal(missing.status,404);assert.equal(missing.body.error?.code,'ROUTE_NOT_FOUND');
    for(const path of [base,`/api/v1/organizations/${randomUUID()}/financial/opening-files`]){
      const method=await anon.call('DELETE',path);assert.equal(method.status,405);assert.equal(method.headers.allow,'GET, POST');assert.equal(method.body.error?.code,'METHOD_NOT_ALLOWED');
    }
    for(const method of ['HEAD','OPTIONS'])assert.equal((await anon.call(method,base)).status,405);
    assert.equal((await client.call('POST',base,{snapshot},{'Idempotency-Key':randomUUID(),'X-CSRF-Token':'wrong'})).status,400);
    assert.equal((await client.call('POST',base,{snapshot,approved:true},{'Idempotency-Key':randomUUID()})).status,422);
    assert.equal((await client.call('POST',base,{snapshot},{'Idempotency-Key':randomUUID()})).status,403);
    assert.equal((await client.call('POST',base,{snapshot,oversized:'x'.repeat(66000)},{'Idempotency-Key':randomUUID()})).status,413);
    let current:OpeningFile|undefined;
    const mutate=async(purpose:string,method:string,tail:string,payload:Record<string,unknown>)=>{
      const key=randomUUID(),expected=current?`"${current.id}:${current.version}"`:undefined,resourceId=current?.id;
      const command={organizationId:org,idempotencyKey:key,payload,...(resourceId?{expectedETag:expected}:{})};
      const reauth=await client.call('POST','/api/v1/auth/reauthenticate',{purpose,password:f.password,command,...(resourceId?{resourceId}:{})});assert.equal(reauth.status,200,JSON.stringify(reauth.body));
      const passwordOnly=await client.call(method,base+tail,payload,{'Idempotency-Key':key,...(expected?{'If-Match':expected}:{})});assert.equal(passwordOnly.status,403,'Password phase alone cannot authorize opening');
      f.clock.value+=30000;
      const factor=await client.call('POST','/api/v1/auth/mfa/challenges/verify',{method:'TOTP',purpose,code:await generate({secret:a.secret,epoch:Math.floor(f.now()/1000)}),...(resourceId?{resourceId}:{})});assert.equal(factor.status,200,JSON.stringify(factor.body));await client.refreshCsrf();
      const result=await client.call(method,base+tail,payload,{'Idempotency-Key':key,...(expected?{'If-Match':expected}:{})});assert.ok([200,201].includes(result.status),JSON.stringify(result.body));assert.ok(result.headers.etag);
      current=(purpose==='OPENING_VALIDATE'?result.body.data?.['opening']:result.body.data) as OpeningFile;return result;
    };
    assert.equal((await mutate('OPENING_CREATE','POST','',{snapshot})).status,201);
    const id=current!.id;await mutate('OPENING_VALIDATE','POST',`/${id}/validations`,{policyVersion:'S03-OPENING-0.1'});assert.equal(current!.status,'VALIDATED');
    const binding={validationId:current!.validation!.id,validationFingerprint:current!.validation!.fingerprint};await mutate('OPENING_APPROVE','POST',`/${id}/approval`,binding);await mutate('OPENING_COMMIT','POST',`/${id}/commit`,binding);assert.equal(current!.status,'POSTED');
    const ledger=await client.call('GET',`/api/v1/organizations/${org}/financial/journal-entries`);assert.equal(ledger.status,200);assert.equal(((ledger.body.data?.['items'] as {source:{type:string}}[])[0]!).source.type,'OPENING');
    const journal=await client.call('GET',`/api/v1/organizations/${org}/financial/journal-entries/${current!.commit!.journalId}`);assert.equal(journal.status,200);
    for(const code of ['INPUT_INVALID','SOURCE_CONFLICT'])assert.equal(financialError(new AppError(409,code)).code,code);
    await f.database.db.collection<{_id:string;status:string}>('organizations').updateOne({_id:org},{$set:{status:'SUSPENDED'}});assert.ok([401,403].includes((await client.call('GET',base)).status));await f.database.db.collection<{_id:string;status:string}>('organizations').updateOne({_id:org},{$set:{status:'ACTIVE'}});
    const snapshotRestore=await f.restore.snapshot();await f.restore.beginRestore(snapshotRestore);assert.equal((await client.call('GET',base)).status,503);assert.equal((await client.call('GET','/api/v1/missing-synthetic-route')).status,503);assert.equal((await anon.call('DELETE',base)).status,503);
  }finally{await f.close();}
});
