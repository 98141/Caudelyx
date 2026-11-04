/* eslint-disable security/detect-object-injection -- Four fixed synthetic account profile keys, no HTTP-derived keys. */
import {randomUUID} from 'node:crypto';
import type {world} from './fixture.js';
import {today,day} from '../../src/modules/obligations/calendar.js';
import type {Intent,Profile} from '../../src/modules/lending/operations-models.js';
import type {Data} from '../../src/modules/simulation/models.js';
export async function nativeLoan(f:Awaited<ReturnType<typeof world>>,providedProfile?:Profile){
 const date=today(f.now()),lending=f.runtime.lending,info=(r:{data:unknown})=>r.data as Data;
 const borrower=await lending.mutate(f.a.issued.context,'createBorrower',f.org,{borrowerCode:'SYN_P04',profile:{displayName:'Persona sintética P04',schemaVersion:1,extras:{}}},randomUUID());
 const terms={borrowerId:info(borrower)['id'],plannedFundingAccountId:f.bank.id,principal:'500.00',effectiveDate:date,firstDueDate:day(date,7),installmentCount:1,method:'CONSTANT_PRINCIPAL',frequency:'WEEK',rate:{type:'EFFECTIVE',unit:'MONTH',value:'0.030000000000'},calendarConvention:'PERIODIC_FIXED',holidayAdjustment:'NO_SHIFT',policyVersion:'S04-LOCAL-CO-0.1',jurisdiction:'CO',usage:'LOCAL_SYNTHETIC'};
 const quote=await lending.mutate(f.a.issued.context,'createLoanQuote',f.org,{terms},randomUUID()),binding={quoteId:info(quote)['id'],quoteFingerprint:info(quote)['fingerprint']},draft=await lending.mutate(f.a.issued.context,'createLoanDraft',f.org,binding,randomUUID()),loanId=String(info(draft)['id']),loan=await lending.mutate(f.a.issued.context,'confirmLoanTerms',f.org,{...binding,termsVersion:1},randomUUID(),loanId,draft.etag);
 const principal=await f.account('P04_PRINCIPAL'),interest=await f.account('P04_INTEREST'),income=await f.account('P04_INCOME','INCOME'),credit=await f.account('P04_CREDIT','LIABILITY'),profile:Profile=providedProfile??{principalAccountId:principal.id,interestReceivableAccountId:interest.id,interestIncomeAccountId:income.id,borrowerCreditAccountId:credit.id},versions={} as Profile;
 for(const k of Object.keys(profile) as (keyof Profile)[])versions[k]=(await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,profile[k])).etag!;
 const request:Intent={kind:'DISBURSE',loanId,loanETag:loan.etag!,fundingAccountETag:(await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,f.bank.id)).etag!,accountProfile:profile,accountVersions:versions,effectiveDate:date,supportReference:'SYN-P04'},book=await f.runtime.operations.read(f.a.issued.context,'getLoanOperationsBook',f.org),key=randomUUID(),preview=await f.runtime.operations.preview(f.a.issued.context,f.org,{executionKey:key,expectedBookETag:book.etag!,request});
 await f.runtime.operations.mutate(f.a.issued.context,'disburseLoan',f.org,{previewToken:info(preview)['previewToken'],request},key,book.etag!);await f.restore.flush();
 return{loanId,sourceKey:'loan:'+loanId+':1:1:P',dueDate:day(date,7)};
}
