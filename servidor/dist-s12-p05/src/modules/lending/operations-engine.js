import { AppError } from '../../shared/errors.js';
import { cents, amount } from './decimal.js';
import { money } from '../finance/money.js';
import { recalculateFuture } from './calculator.js';
import { isHistorical } from './historical.js';
import { installmentFromRow } from './operations-models.js';
const fail = (code, status = 409) => { throw new AppError(status, code); };
const sum = (values) => values.reduce((s, v) => s + cents(v), 0n);
export function publicInstallment(r, date) {
    const p = cents(r.principalPaid), i = cents(r.interestPaid), full = p === cents(r.principal) && i === cents(r.interest);
    return { loanId: r.loanId, scheduleVersion: r.scheduleVersion, number: r.number, dueDate: r.dueDate, principal: r.principal, interest: r.interest, payment: r.payment, principalPaid: r.principalPaid, interestPaid: r.interestPaid, status: full ? 'PAID' : p + i > 0n ? 'PARTIAL' : 'UNPAID', dueState: r.dueDate > date ? 'FUTURE' : r.dueDate === date ? 'DUE' : 'OVERDUE' };
}
export function positionView(state, borrower, date) {
    const { loan, position: p } = state, active = state.rows.filter(r => r.active), opening = isHistorical(loan) ? cents(loan.recognizedInterest) : 0n, accrued = opening + sum(state.accruals.map(a => a.interest)), collected = sum(state.applications.filter(a => a.component === 'INTEREST').map(a => a.amount));
    return { loanId: loan._id, borrower, currency: 'COP', version: p.version, termsVersion: p.termsVersion, scheduleVersion: p.scheduleVersion, termsStatus: loan.status, ...(isHistorical(loan) ? { origin: 'HISTORICAL_S11', openingId: loan.openingId, recognizedOpeningInterest: loan.recognizedInterest } : {}), status: p.status, statusLabel: p.status === 'ACTIVE' ? 'Activo' : 'Liquidado', originalPrincipal: p.originalPrincipal, principalOutstanding: p.principalOutstanding, duePrincipal: money(sum(active.filter(r => r.dueDate <= date).map(r => amount(cents(r.principal) - cents(r.principalPaid))))), originalExpectedInterest: isHistorical(loan) ? money(sum(loan.installments.map(q => money(cents(q.recognizedInterestRemaining) + cents(q.unrecognizedInterestRemaining))))) : loan.calculation.totals.interest, expectedFutureInterest: money(sum(active.filter(r => r.dueDate > date).map(r => r.interest))), dueUnrecognizedInterest: money(sum(active.filter(r => r.dueDate <= date && !state.accruals.some(a => a.scheduleVersion === r.scheduleVersion && a.installmentNumber === r.number)).map(r => money(cents(r.interest) - cents(r.openingRecognizedInterest ?? '0.00'))))), accruedInterestTotal: money(accrued), collectedInterestTotal: money(collected), accruedOutstandingInterest: money(accrued - collected) };
}
export function operate(intent, inputs, profile, creditBefore, borrowers, eventId, at) {
    const states = structuredClone(inputs), postings = new Map();
    const plan = { postings: [], allocations: [], accruals: [], scheduleRevisions: [], positions: [], creditChange: null };
    const post = (id, d) => postings.set(id, (postings.get(id) ?? 0n) + d);
    const accrue = (state, through) => {
        const accounts = state.accountProfile ?? profile;
        for (const row of state.rows.filter(r => r.active && r.dueDate <= through).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.number - b.number)) {
            if (state.accruals.some(a => a.scheduleVersion === row.scheduleVersion && a.installmentNumber === row.number))
                continue;
            const interest = money(cents(row.interest) - cents(row.openingRecognizedInterest ?? '0.00'));
            if (isHistorical(state.loan) && interest === '0.00')
                continue;
            const a = { loanId: row.loanId, scheduleVersion: row.scheduleVersion, installmentNumber: row.number, dueDate: row.dueDate, interest };
            plan.accruals.push(a);
            state.accruals.push({ ...a, _id: row._id, organizationId: state.position.organizationId, eventId, createdAt: at });
            post(accounts.interestReceivableAccountId, cents(interest));
            post(accounts.interestIncomeAccountId, -cents(interest));
        }
    };
    if (intent.kind === 'DISBURSE')
        throw Error('Funding is planned by the service from immutable S4 terms');
    if (intent.kind === 'ACCRUE') {
        accrue(states[0], intent.throughDate);
        if (!plan.accruals.length)
            fail('NO_ACCRUAL_DUE');
    }
    else {
        if (intent.targets.length < 1 || intent.targets.length > 10)
            fail('INPUT_INVALID', 422);
        const gross = cents(intent.kind === 'RECEIPT' ? intent.receivedAmount : intent.amount), budgets = sum(intent.targets.map(t => t.amount));
        if (gross <= 0n || budgets > gross || intent.kind === 'APPLY_CREDIT' && budgets !== gross)
            fail('INPUT_INVALID', 422);
        if (intent.kind === 'APPLY_CREDIT' && gross > cents(creditBefore))
            fail('CREDIT_INSUFFICIENT');
        if (new Set(intent.targets.map(t => t.loanId)).size !== intent.targets.length)
            fail('INPUT_INVALID', 422);
        let applied = 0n;
        for (const target of intent.targets) {
            const state = states.find(s => s.loan._id === target.loanId);
            if (!state)
                fail('RESOURCE_NOT_FOUND', 404);
            const accounts = state.accountProfile ?? profile;
            if (isHistorical(state.loan) && target.mode === 'EXTRA_PRINCIPAL')
                fail('UNSUPPORTED_PAYMENT_VARIANT', 422);
            accrue(state, intent.effectiveDate);
            const due = state.rows.filter(r => r.active && r.dueDate <= intent.effectiveDate).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.number - b.number);
            let left = cents(target.amount);
            const allocate = (row, component, value) => {
                if (value <= 0n)
                    return;
                const a = { loanId: row.loanId, scheduleVersion: row.scheduleVersion, installmentNumber: row.number, component, amount: money(value) };
                plan.allocations.push(a);
                state.applications.push({ ...a, _id: eventId + ':' + plan.allocations.length, organizationId: state.position.organizationId, eventId, createdAt: at });
                if (component === 'INTEREST') {
                    row.interestPaid = money(cents(row.interestPaid) + value);
                    post(accounts.interestReceivableAccountId, -value);
                }
                else {
                    if (component === 'DUE_PRINCIPAL')
                        row.principalPaid = money(cents(row.principalPaid) + value);
                    post(accounts.principalAccountId, -value);
                    state.position.principalOutstanding = money(cents(state.position.principalOutstanding) - value);
                }
                left -= value;
                applied += value;
            };
            for (const row of due) {
                const needed = cents(row.interest) - cents(row.interestPaid);
                allocate(row, 'INTEREST', needed < left ? needed : left);
            }
            for (const row of due) {
                const needed = cents(row.principal) - cents(row.principalPaid);
                allocate(row, 'DUE_PRINCIPAL', needed < left ? needed : left);
            }
            if (target.mode === 'EXTRA_PRINCIPAL') {
                const anchor = due.find(r => r.dueDate === intent.effectiveDate);
                if (!anchor || due.some(r => r.principalPaid !== r.principal || r.interestPaid !== r.interest))
                    fail('UNSUPPORTED_PAYMENT_VARIANT', 422);
                const remaining = cents(state.position.principalOutstanding), extra = remaining < left ? remaining : left;
                if (extra > 0n) {
                    allocate(anchor, 'EXTRA_PRINCIPAL', extra);
                    const future = state.rows.filter(r => r.active && r.dueDate > intent.effectiveDate).sort((a, b) => a.number - b.number), version = state.position.scheduleVersion + 1, p = state.position.principalOutstanding;
                    if (!future.length)
                        throw Error('Principal without future contractual rows');
                    for (const row of future) {
                        row.active = false;
                        row.supersededByVersion = version;
                    }
                    const loan = state.loan;
                    if (isHistorical(loan))
                        fail('UNSUPPORTED_PAYMENT_VARIANT', 422);
                    const calculation = cents(p) > 0n ? recalculateFuture(loan.terms, p, future.map(r => r.dueDate)) : null;
                    const newRows = calculation?.schedule.map(r => installmentFromRow(r, state.loan._id, state.loan.organizationId, version, at, future[0].number - 1)) ?? [];
                    state.rows.push(...newRows);
                    state.position.scheduleVersion = version;
                    plan.scheduleRevisions.push({ loanId: loan._id, version, parentVersion: version - 1, originTermsVersion: loan.termsVersion, eventId, reason: cents(p) > 0n ? 'EXTRA_PRINCIPAL' : 'EARLY_SETTLEMENT', createdAt: at, remainingPrincipal: p, futureInstallments: newRows.map(r => publicInstallment(r, intent.effectiveDate)) });
                }
            }
        }
        const remainder = gross - applied;
        if (intent.kind === 'RECEIPT') {
            if (remainder > 0n && intent.excessDisposition === 'REJECT')
                fail('EXCESS_NOT_ALLOWED');
            post(intent.destinationAccountId, gross);
            post(profile.borrowerCreditAccountId, -remainder);
            if (remainder > 0n)
                plan.creditChange = { borrowerId: intent.borrowerId, before: creditBefore, added: money(remainder), applied: '0.00', after: money(cents(creditBefore) + remainder) };
        }
        else {
            if (remainder !== 0n)
                fail('EXCESS_NOT_ALLOWED');
            post(profile.borrowerCreditAccountId, gross);
            plan.creditChange = { borrowerId: intent.borrowerId, before: creditBefore, added: '0.00', applied: money(gross), after: money(cents(creditBefore) - gross) };
        }
    }
    for (const state of states) {
        state.position.version++;
        const view = positionView(state, borrowers.get(state.loan.borrowerId), intent.effectiveDate);
        if (view.principalOutstanding === '0.00' && view.accruedOutstandingInterest === '0.00' && view.dueUnrecognizedInterest === '0.00' && view.expectedFutureInterest === '0.00') {
            state.position.status = 'SETTLED';
            view.status = 'SETTLED';
            view.statusLabel = 'Liquidado';
        }
        plan.positions.push(view);
    }
    for (const [accountId, value] of postings)
        if (value !== 0n)
            plan.postings.push({ accountId, debit: value > 0n ? money(value) : '0.00', credit: value < 0n ? money(-value) : '0.00' });
    plan.postings.sort((a, b) => a.accountId.localeCompare(b.accountId));
    if (plan.postings.reduce((n, l) => n + cents(l.debit) - cents(l.credit), 0n) !== 0n)
        throw Error('Unbalanced operational plan');
    return { plan, states };
}
//# sourceMappingURL=operations-engine.js.map