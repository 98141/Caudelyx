import type {ClientSession} from 'mongodb';
import type {Database} from '../../shared/database.js';
import {AppError} from '../../shared/errors.js';
import {hash} from './contract.js';
import {calculate} from './calculator.js';
import type {Loan,Quote} from './models.js';
export const integrityFailure=():never=>{throw new AppError(503,'INTEGRITY_MISMATCH');};
export function quoteCalculation(q:Quote){return {schedule:q.schedule,totals:q.totals,periodicRate24:q.periodicRate24,basePayment:q.basePayment,finalPaymentAdjustment:q.finalPaymentAdjustment,policyVersion:q.policyVersion,mathVersion:q.mathVersion,calendarVersion:q.calendarVersion};}
export function verifyQuote(q:Quote){
  const {_id,fingerprint,...rest}=q;
  try{if(hash({id:_id,...rest})!==fingerprint||hash(calculate(q.terms))!==hash(quoteCalculation(q)))integrityFailure();}catch{integrityFailure();}
}
export async function verifyLoan(database:Database,l:Loan,session?:ClientSession){
  const opts=session?{session}:{};
  const q=await database.db.collection<Quote>('lending_quotes').findOne({_id:l.quoteId,organizationId:l.organizationId},opts);
  const v=await database.db.collection('lending_loan_versions').findOne({organizationId:l.organizationId,loanId:l._id,termsVersion:l.termsVersion},opts);
  if(!q||!v)integrityFailure();verifyQuote(q!);
  if(l.ownerId!==l.organizationId||l.borrowerId!==l.terms.borrowerId||l.quoteFingerprint!==q!.fingerprint||hash(l.terms)!==hash(q!.terms)||hash(l.calculation)!==hash(quoteCalculation(q!))||v!['quoteId']!==l.quoteId||v!['quoteFingerprint']!==l.quoteFingerprint||hash(v!['terms'])!==hash(l.terms)||hash(v!['calculation'])!==hash(l.calculation))integrityFailure();
  if(l.status==='TERMS_CONFIRMED'&&(!l.confirmation||l.confirmation.quoteId!==l.quoteId||l.confirmation.quoteFingerprint!==l.quoteFingerprint||l.confirmation.termsVersion!==l.termsVersion||l.confirmation.actorId!==q!.actorId||!Number.isFinite(Date.parse(l.confirmation.confirmedAt))))integrityFailure();
  if(l.status==='DRAFT'&&l.confirmation!==null)integrityFailure();
  return q!;
}
export async function verifyAllLoans(database:Database,session?:ClientSession){
  for await(const q of database.db.collection<Quote>('lending_quotes').find({},session?{session}:{}))verifyQuote(q);
  for await(const l of database.db.collection<Loan>('lending_loans').find({},session?{session}:{}))await verifyLoan(database,l,session);
}
