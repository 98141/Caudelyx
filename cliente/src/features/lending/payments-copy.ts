import { formatCop } from '../../shared/money';

export const PAYMENT_STATUS: Record<string, string> = {
  PENDING: 'Pendiente',
  CONFIRMED: 'Confirmado',
  REJECTED: 'Rechazado',
  CANCELLED: 'Cancelado',
  REVERSAL_REQUESTED: 'Reverso solicitado',
  REVERSED: 'Compensado',
};
export const APPROVAL_STATUS: Record<string, string> = {
  NOT_REQUESTED: 'Sin solicitud',
  PENDING: 'Pendiente de decisión',
  DIRECT_AUTHORIZED: 'Autorizado en el registro',
  APPROVED: 'Aprobado',
  REJECTED: 'Rechazado',
  CANCELLED: 'Cancelado',
};
export const CUSTODY_STATUS: Record<string, string> = {
  NOT_APPLICABLE: 'No aplica',
  PROVISIONAL: 'Provisional',
  CONFIRMED_HELD: 'Confirmado y reservado',
  RETURN_REQUIRED: 'Retorno pendiente',
  RETURNED: 'Retorno declarado',
  HELD_UNALLOCATED: 'Retenido sin asignar',
};
export const RECONCILIATION_STATUS: Record<string, string> = {
  NOT_APPLICABLE: 'No aplica',
  PENDING: 'Pendiente de conciliar',
  RECONCILED: 'Conciliado',
  DISCREPANCY: 'Con diferencia',
  INVESTIGATION: 'En revisión',
};
export const CUSTODY_DELTA: Record<string, string> = {
  NONE: 'Sin cambio de custodia',
  PROVISIONAL: 'Custodia provisional, sin reducir la deuda',
  CONFIRM_PROVISIONAL: 'Pasa la custodia provisional a reservada',
  HELD_UNALLOCATED: 'Reserva fondos retenidos, sin devolver dinero',
};
export const PART: Record<string, string> = {
  INTEREST: 'Interés',
  DUE_PRINCIPAL: 'Capital vencido',
  EXTRA_PRINCIPAL: 'Abono a capital',
};
export const INSTALLMENT: Record<string, string> = { UNPAID: 'Sin cobro', PARTIAL: 'Parcial', PAID: 'Cobrada' };

export interface PaymentTarget {
  loanId: string;
  positionETag: string;
  amount: string;
  mode: 'REGULAR' | 'EXTRA_PRINCIPAL';
}
export interface PaymentIntent {
  method: 'CASH' | 'BANK';
  borrowerId: string;
  amount: string;
  currency: 'COP';
  destinationAccountId: string;
  destinationAccountETag: string;
  custodianId: string | null;
  bindingETag: string | null;
  observedDate: string;
  observedAt: string;
  receiptReference: string;
  supportReference: string;
  targets: PaymentTarget[];
  excessDisposition: 'CREDIT' | 'REJECT';
}
export interface PaymentRecord {
  id: string;
  registrarId: string;
  intent: PaymentIntent;
  approvalMode: string;
  status: string;
  approvalState: string;
  approvalOrigin: string;
  reconciliationState: string;
  custodyState: string;
  heldFundsState: string;
  decidedBy: string | null;
  eventId: string | null;
  reversalEventId: string | null;
  observedDate: string;
  effectiveDate: string | null;
  recordedAt: string;
  currentReconciliationLinkId: string | null;
  reversalRequestId: string | null;
}
export interface RegistrationContext {
  borrowerId: string;
  borrowerCode: string;
  borrowerName: string;
  loanId: string;
  loanReference: string;
  principalOutstanding: string;
  dueAmount: string;
  positionETag: string;
  permittedDestinationId: string;
  permittedBindingETag: string | null;
  permittedDestinationAccountETag: string;
  permittedDestinationLabel: string;
  permittedMethod: 'CASH' | 'BANK';
}
export interface PaymentFilters {
  borrower: string;
  loan: string;
  account: string;
  amount: string;
  date: string;
  paymentStatus: string;
  approvalState: string;
  custodyState: string;
  reconciliationState: string;
}

export function money(value: string): string {
  const shown = formatCop(value);
  return shown ? `${shown} COP` : value;
}

export function known(map: Record<string, string>, value: string): boolean {
  return Object.hasOwn(map, value);
}

export function label(map: Record<string, string>, value: string): string {
  return map[value] ?? 'Estado no reconocido';
}

export function roleSet(roleIds: string[] | undefined): Set<string> {
  return new Set(roleIds ?? []);
}

export function blockedRole(roles: Set<string>): boolean {
  return roles.has('SA') || roles.size === 0;
}

export function canRegister(roles: Set<string>): boolean {
  return !blockedRole(roles) && ['T', 'O', 'C'].some(role => roles.has(role));
}

export function canDirect(roles: Set<string>): boolean {
  return !blockedRole(roles) && roles.has('T');
}

export function canApprove(roles: Set<string>, registrarId: string, actorId: string): boolean {
  return !blockedRole(roles) && actorId !== registrarId && (roles.has('T') || roles.has('P'));
}

export function canCancel(roles: Set<string>, registrarId: string, actorId: string): boolean {
  return !blockedRole(roles) && (roles.has('T') || (actorId === registrarId && canRegister(roles)));
}

export function canReconcile(roles: Set<string>): boolean {
  return !blockedRole(roles) && roles.has('T');
}

export function canConfigure(roles: Set<string>): boolean {
  return canReconcile(roles);
}

export function paymentKnown(payment: PaymentRecord): boolean {
  return known(PAYMENT_STATUS, payment.status)
    && known(APPROVAL_STATUS, payment.approvalState)
    && known(CUSTODY_STATUS, payment.custodyState)
    && known(RECONCILIATION_STATUS, payment.reconciliationState)
    && known(CUSTODY_STATUS, payment.heldFundsState === 'NONE' ? 'NOT_APPLICABLE' : payment.heldFundsState)
    && (payment.heldFundsState === 'NONE' || payment.heldFundsState === 'HELD_UNALLOCATED');
}

export function contextFor(payment: PaymentRecord, contexts: RegistrationContext[]): RegistrationContext | undefined {
  const loanId = payment.intent.targets[0]?.loanId;
  return contexts.find(row => row.borrowerId === payment.intent.borrowerId && row.loanId === loanId && row.permittedDestinationId === payment.intent.destinationAccountId)
    ?? contexts.find(row => row.borrowerId === payment.intent.borrowerId && row.loanId === loanId)
    ?? contexts.find(row => row.borrowerId === payment.intent.borrowerId);
}

export function borrowerText(payment: PaymentRecord, contexts: RegistrationContext[]): string {
  const row = contextFor(payment, contexts);
  return row ? `${row.borrowerCode} · ${row.borrowerName}` : 'Prestatario fuera del contexto de registro';
}

export function loanText(payment: PaymentRecord, contexts: RegistrationContext[]): string {
  return payment.intent.targets.map(target => {
    const row = contexts.find(item => item.loanId === target.loanId && item.borrowerId === payment.intent.borrowerId);
    return row ? `${row.loanReference} · ${money(row.principalOutstanding)}` : 'Préstamo fuera del contexto';
  }).join('; ');
}

export function accountText(payment: PaymentRecord, contexts: RegistrationContext[]): string {
  const row = contexts.find(item => item.permittedDestinationId === payment.intent.destinationAccountId && item.borrowerId === payment.intent.borrowerId);
  return row?.permittedDestinationLabel ?? 'Cuenta fuera del contexto de registro';
}

export function rowName(payment: PaymentRecord, contexts: RegistrationContext[]): string {
  return `${borrowerText(payment, contexts)} · ${loanText(payment, contexts)} · ${money(payment.intent.amount)} · ${payment.observedDate} · ${payment.intent.receiptReference}`;
}

export function matches(payment: PaymentRecord, contexts: RegistrationContext[], filters: PaymentFilters): boolean {
  const borrower = filters.borrower.trim().toLocaleLowerCase('es-CO');
  const row = contextFor(payment, contexts);
  if (borrower) {
    const haystack = row ? `${row.borrowerCode} ${row.borrowerName}`.toLocaleLowerCase('es-CO') : '';
    if (!haystack.includes(borrower)) return false;
  }
  const loan = filters.loan.trim().toLocaleLowerCase('es-CO');
  if (loan) {
    const loans = payment.intent.targets.map(target => {
      const match = contexts.find(item => item.loanId === target.loanId);
      return `${target.loanId} ${match?.loanReference ?? ''}`.toLocaleLowerCase('es-CO');
    }).join(' ');
    if (!loans.includes(loan)) return false;
  }
  const account = filters.account.trim().toLocaleLowerCase('es-CO');
  if (account) {
    const labelText = accountText(payment, contexts).toLocaleLowerCase('es-CO');
    if (!labelText.includes(account) && !payment.intent.destinationAccountId.toLocaleLowerCase('es-CO').includes(account)) return false;
  }
  const amount = filters.amount.trim().toLocaleLowerCase('es-CO');
  if (amount && !money(payment.intent.amount).toLocaleLowerCase('es-CO').includes(amount) && !payment.intent.amount.includes(amount)) return false;
  if (filters.date && payment.observedDate !== filters.date) return false;
  if (filters.paymentStatus && payment.status !== filters.paymentStatus) return false;
  if (filters.approvalState && payment.approvalState !== filters.approvalState) return false;
  if (filters.custodyState && payment.custodyState !== filters.custodyState) return false;
  if (filters.reconciliationState && payment.reconciliationState !== filters.reconciliationState) return false;
  return true;
}

export function custodyExplanation(payment: PaymentRecord): string {
  if (payment.intent.method === 'BANK' || payment.custodyState === 'NOT_APPLICABLE') {
    return 'Transferencia. No crea custodia de cobrador ni concilia el banco por este registro.';
  }
  if (payment.custodyState === 'PROVISIONAL' || payment.status === 'PENDING') {
    return 'La deuda no está reducida. El efectivo sigue en custodia provisional del registrador. No es la caja propia de la organización ni una conciliación bancaria.';
  }
  if (payment.custodyState === 'RETURN_REQUIRED') {
    return 'El rechazo o la cancelación no hacen desaparecer el efectivo. Permanece hasta el retorno declarado. No se creó un asiento por ese hecho.';
  }
  if (payment.custodyState === 'RETURNED') {
    return 'El retorno quedó declarado. No se contabilizó un asiento nuevo por devolver ese efectivo.';
  }
  if (payment.custodyState === 'CONFIRMED_HELD') {
    return 'El efectivo confirmado queda reservado. No es la caja propia ni una conciliación bancaria.';
  }
  if (payment.custodyState === 'HELD_UNALLOCATED' || payment.heldFundsState === 'HELD_UNALLOCATED') {
    return 'Hay fondos retenidos. Este alcance no devuelve ese dinero.';
  }
  return 'Estado de custodia no reconocido. No hay acciones.';
}

export const EMPTY_FILTERS: PaymentFilters = {
  borrower: '', loan: '', account: '', amount: '', date: '', paymentStatus: '', approvalState: '', custodyState: '', reconciliationState: '',
};
