/* eslint-disable security/detect-object-injection -- Four fixed profile fields from the approved profile type. */
import { AppError } from '../../shared/errors.js';
import { isMonthlyLoan } from './ms-models.js';
import { accrueMonthly, applyMonthlyPayment, newMonthlyState, monthlyPosition, msCents, msMoney } from './ms-engine.js';
const fail = (code, status = 503) => { throw new AppError(status, code); };
const rowView = (r, date) => ({ loanId: r.loanId, scheduleVersion: r.scheduleVersion, number: r.number, dueDate: r.dueDate, principal: r.principal, interest: r.interest, payment: r.payment, principalPaid: r.principalPaid, interestPaid: r.interestPaid, status: r.interest === r.interestPaid ? 'PAID' : r.interestPaid === '0.00' ? 'UNPAID' : 'PARTIAL', dueState: r.dueDate < date ? 'OVERDUE' : r.dueDate === date ? 'DUE' : 'FUTURE' });
export const periodRows = (s, at) => s.periods.map(p => ({ _id: `${s.id}:${p.ordinal}:${p.ordinal}`, organizationId: s.organizationId, loanId: s.id, scheduleVersion: p.ordinal, number: p.ordinal, dueDate: p.dueDate, principal: '0.00', interest: p.interest, ...(p.openingRecognizedInterest ? { openingRecognizedInterest: p.openingRecognizedInterest } : {}), payment: p.interest, principalPaid: '0.00', interestPaid: '0.00', active: true, supersededByVersion: null, createdAt: at }));
export function monthlyEngineState(loan, at, eventId) {
    const ms = newMonthlyState(loan._id, loan.organizationId, loan.terms, loan.profile, at, eventId, loan.termsVersion);
    return { loan: { ...loan, status: 'MONTHLY_ACTIVE', version: loan.version + 1 }, position: { _id: loan._id, organizationId: loan.organizationId, loanId: loan._id, borrowerId: loan.borrowerId, version: 1, termsVersion: loan.termsVersion, scheduleVersion: 1, status: 'ACTIVE', originalPrincipal: loan.terms.principal, principalOutstanding: loan.terms.principal, fundingEventId: eventId, createdAt: at, monthlyState: ms }, rows: periodRows(ms, at), accruals: [], applications: [], accountProfile: loan.profile };
}
export function monthlyPublicPosition(state, borrower, date) {
    const ms = state.position.monthlyState;
    if (!ms || !isMonthlyLoan(state.loan))
        return fail('INTEGRITY_MISMATCH');
    const p = monthlyPosition(ms, date), future = ms.periods.filter(v => v.dueDate > date);
    return { loanId: ms.id, borrower, currency: 'COP', version: state.position.version, termsVersion: state.position.termsVersion, scheduleVersion: state.position.scheduleVersion, termsStatus: state.loan.status, origin: 'MONTHLY_OPEN_V1', status: state.position.status, statusLabel: state.position.status === 'ACTIVE' ? 'Activo' : 'Liquidado', originalPrincipal: state.position.originalPrincipal, principalOutstanding: p.principal, duePrincipal: '0.00', originalExpectedInterest: null, expectedFutureInterest: state.position.status === 'SETTLED' ? '0.00' : future.length ? msMoney(future.reduce((n, v) => n + msCents(v.interest), 0n)) : null, dueUnrecognizedInterest: p.interestDueUnrecognized, accruedInterestTotal: p.interestRecognized, collectedInterestTotal: msMoney(msCents(p.interestCashCollected) + msCents(p.interestSatisfiedByCredit)), accruedOutstandingInterest: p.interestReceivable };
}
export function monthlySchedule(state, version, eventId, at, original = false) {
    if (!isMonthlyLoan(state.loan))
        return fail('INTEGRITY_MISMATCH');
    return { loanId: state.loan._id, version, parentVersion: version === 1 ? null : version - 1, originTermsVersion: state.position.monthlyState.periods.find(p => p.ordinal === version).termsVersion, eventId, reason: original ? 'MONTHLY_ORIGINAL' : 'MONTHLY_PERIOD', createdAt: at, remainingPrincipal: state.position.principalOutstanding, futureInstallments: state.rows.filter(r => r.scheduleVersion === version).map(r => rowView(r, at.slice(0, 10))) };
}
function adoptMonthly(state, ms, eventId, at, borrower, date, creditBefore) {
    const next = structuredClone(state), loan = next.loan;
    if (!isMonthlyLoan(loan))
        return fail('INTEGRITY_MISMATCH');
    next.position.monthlyState = ms.state;
    next.position.version++;
    next.position.principalOutstanding = ms.principalOutstanding;
    next.position.status = ms.state.status;
    for (const r of periodRows(ms.state, at))
        if (!next.rows.some(v => v.number === r.number))
            next.rows.push(r);
    next.position.scheduleVersion = ms.state.periods.at(-1).ordinal;
    const accruals = [];
    for (const k of ms.newAccruals) {
        const row = next.rows.find(r => r.number === k);
        const a = { loanId: loan._id, scheduleVersion: row.scheduleVersion, installmentNumber: k, dueDate: row.dueDate, interest: msMoney(msCents(row.interest) - msCents(row.openingRecognizedInterest ?? '0.00')) };
        accruals.push(a);
        next.accruals.push({ ...a, _id: row._id, organizationId: loan.organizationId, eventId, createdAt: at });
    }
    const allocations = [];
    if (ms.fact) {
        for (const a of ms.fact.interest)
            allocations.push({ loanId: loan._id, scheduleVersion: a.ordinal, installmentNumber: a.ordinal, component: 'INTEREST', amount: a.amount });
        if (ms.fact.principal !== '0.00') {
            const row = next.rows.at(-1);
            allocations.push({ loanId: loan._id, scheduleVersion: row.scheduleVersion, installmentNumber: row.number, component: 'EXTRA_PRINCIPAL', amount: ms.fact.principal });
        }
        for (const a of allocations) {
            next.applications.push({ ...a, _id: eventId + ':' + loan._id + ':' + next.applications.length, organizationId: loan.organizationId, eventId, createdAt: at });
            if (a.component === 'INTEREST') {
                const row = next.rows.find(r => r.number === a.installmentNumber);
                row.interestPaid = msMoney(msCents(row.interestPaid) + msCents(a.amount));
            }
        }
    }
    const change = msCents(ms.creditAdded) - msCents(ms.creditUsed), creditChange = change === 0n ? null : { borrowerId: loan.borrowerId, before: creditBefore, added: ms.creditAdded, applied: ms.creditUsed, after: msMoney(msCents(creditBefore) + change) };
    const plan = { postings: ms.postings, allocations, accruals, scheduleRevisions: ms.newPeriods.map(k => monthlySchedule(next, k, eventId, at)), positions: [monthlyPublicPosition(next, borrower, date)], creditChange };
    return { plan, states: [next] };
}
export function operateMonthlyMixed(intent, states, profile, credit, borrowers, eventId, at, legacy) {
    if (intent.kind === 'DISBURSE')
        return fail('INVALID_STATE', 409);
    const single = (request, state, balance) => {
        if (!isMonthlyLoan(state.loan))
            return legacy(request, [state], profile, balance, borrowers, eventId, at);
        const original = state.position.monthlyState;
        if (!original)
            return fail('INTEGRITY_MISMATCH');
        let result;
        if (request.kind === 'ACCRUE') {
            result = accrueMonthly(original, request.throughDate, at);
            if (!result.newAccruals.length && !result.newPeriods.length)
                return fail('NO_ACCRUAL_DUE', 409);
        }
        else if (request.kind === 'RECEIPT' || request.kind === 'APPLY_CREDIT') {
            const target = request.targets[0];
            result = applyMonthlyPayment(original, { id: eventId, effectiveDate: request.effectiveDate, recordedAt: at, amount: request.kind === 'RECEIPT' ? request.receivedAmount : request.amount, cashAccountId: request.kind === 'RECEIPT' ? request.destinationAccountId : '', mode: target.mode, excess: request.kind === 'RECEIPT' ? request.excessDisposition : 'REJECT', source: request.kind === 'RECEIPT' ? 'CASH' : 'BORROWER_CREDIT', creditAvailable: balance, paymentId: null });
        }
        else
            return fail('INVALID_STATE', 409);
        // A due date is not an accounting date. Missing accrual recognized within a
        // receipt/manual accrual belongs to that actual event's economic date.
        for (const p of result.state.periods)
            if (result.newAccruals.includes(p.ordinal))
                p.recognitionDate = request.effectiveDate;
        if (result.catchupPending && request.kind !== 'ACCRUE')
            return fail('ACCRUAL_CATCHUP_REQUIRED', 409);
        return adoptMonthly(state, result, eventId, at, borrowers.get(state.loan.borrowerId), request.effectiveDate, balance);
    };
    if (intent.kind === 'ACCRUE')
        return single(intent, states[0], credit);
    if (intent.targets.length < 1 || intent.targets.length > 10 || new Set(intent.targets.map(t => t.loanId)).size !== intent.targets.length)
        return fail('INPUT_INVALID', 422);
    const gross = msCents(intent.kind === 'RECEIPT' ? intent.receivedAmount : intent.amount), budget = intent.targets.reduce((n, t) => n + msCents(t.amount), 0n);
    if (gross <= 0n || budget > gross || intent.kind === 'APPLY_CREDIT' && budget !== gross)
        return fail('INPUT_INVALID', 422);
    const plan = { postings: [], allocations: [], accruals: [], scheduleRevisions: [], positions: [], creditChange: null }, next = [];
    let balance = credit, added = 0n, applied = 0n;
    for (const target of intent.targets) {
        if (msCents(target.amount) <= 0n)
            return fail('INPUT_INVALID', 422);
        const state = states.find(s => s.loan._id === target.loanId);
        if (!state)
            return fail('RESOURCE_NOT_FOUND', 404);
        const request = intent.kind === 'RECEIPT' ? { ...intent, receivedAmount: target.amount, targets: [target] } : { ...intent, amount: target.amount, targets: [target] };
        const out = single(request, state, balance);
        next.push(...out.states);
        for (const key of ['postings', 'allocations', 'accruals', 'scheduleRevisions', 'positions'])
            plan[key].push(...out.plan[key]);
        if (out.plan.creditChange) {
            balance = out.plan.creditChange.after;
            added += msCents(out.plan.creditChange.added);
            applied += msCents(out.plan.creditChange.applied);
        }
    }
    const untargeted = gross - budget;
    if (untargeted) {
        if (intent.kind !== 'RECEIPT' || intent.excessDisposition === 'REJECT')
            return fail('EXCESS_NOT_ALLOWED', 409);
        plan.postings.push({ accountId: intent.destinationAccountId, debit: msMoney(untargeted), credit: '0.00' }, { accountId: profile.borrowerCreditAccountId, debit: '0.00', credit: msMoney(untargeted) });
        added += untargeted;
        balance = msMoney(msCents(balance) + untargeted);
    }
    const totals = new Map();
    for (const p of plan.postings)
        totals.set(p.accountId, (totals.get(p.accountId) ?? 0n) + msCents(p.debit) - msCents(p.credit));
    plan.postings = [...totals].filter(([, n]) => n !== 0n).sort(([a], [b]) => a.localeCompare(b)).map(([accountId, n]) => ({ accountId, debit: n > 0n ? msMoney(n) : '0.00', credit: n < 0n ? msMoney(-n) : '0.00' }));
    if (added || applied)
        plan.creditChange = { borrowerId: intent.borrowerId, before: credit, added: msMoney(added), applied: msMoney(applied), after: balance };
    return { plan, states: next };
}
//# sourceMappingURL=ms-adapter.js.map